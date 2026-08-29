// Governor lease management for Stage 2.
//
// Fail-closed contract (W0.1): once a Governor URL is configured, the ONLY result that lets a
// task proceed is a 200 lease. Every other outcome — missing token, unreachable listener,
// network error, non-JSON body, unexpected status — is returned as `blocked: true` so the
// daemon transitions the task to BLOCKED before any clone or model spawn. `null` is returned
// only when no Governor URL is configured at all (Stage 1 behaviour).
export const GOVERNOR_TOKEN_MISSING = "governor token missing (VINCI_GOVERNOR_TOKEN)";

// Every non-success result is `blocked: true` and carries exactly one classification so the
// daemon (and the soak ledger reading its blocker posts) can tell a Governor DECISION from a
// Governor FAILURE:
//   refused: true  — the Governor answered 403/409/422 and refused the lease (its rule text rides
//                    verbatim in `reason`)
//   error: true    — no usable decision: missing token, unreachable, network error, non-JSON or
//                    malformed body, unexpected status, or a lease without a valid ttl
function refused(reason) {
  return { success: false, blocked: true, refused: true, error: false, reason };
}

function unavailable(reason) {
  return { success: false, blocked: true, refused: false, error: true, reason };
}

// A lease is a lease only with a finite, positive, numeric ttl. There is deliberately NO default:
// `0`, negative, NaN, a string, null, or a missing field all mean the response cannot bound the
// run, and an unbounded run is exactly what the Governor exists to prevent.
function validTtl(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function claimGovernorPaths({ governorUrl, token, paths, taskId, attempt }) {
  if (!governorUrl) return null;
  if (!token) return unavailable(GOVERNOR_TOKEN_MISSING);

  const url = `${governorUrl}/v1/governor/claim-paths`;
  const idempotencyKey = `${taskId}/${attempt}`;
  const body = { paths };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Session ${token}`,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return unavailable(`Governor connection failed: ${error?.cause?.code ?? error.message}`);
  }

  let responseBody;
  try {
    responseBody = await response.json();
  } catch (error) {
    return unavailable(`Governor returned invalid JSON (status ${response.status}): ${error.message}`);
  }
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    return unavailable(`Governor returned a malformed body (status ${response.status}): ${JSON.stringify(responseBody)}`);
  }

  if (response.status === 200) {
    if (!validTtl(responseBody.ttl)) {
      return unavailable(`Governor lease invalid: ttl=${JSON.stringify(responseBody.ttl)}`);
    }
    const claimedAt = new Date().toISOString();
    // The lease token the W2 unattended policy profile stamps into the child. It cannot be produced
    // on any path where the lease was refused, unavailable, or never requested. The `#expires=`
    // suffix is REQUIRED by the child-side parser and is pinned to the lease's own ttl, so the
    // relaxed guard can never outlive the lease that justified it — the runtime timer and the
    // profile expire together rather than the profile silently lasting for the life of the process.
    const expiresAt = new Date(Date.parse(claimedAt) + responseBody.ttl * 1000).toISOString();
    return {
      success: true,
      id: `${idempotencyKey}@${claimedAt}#expires=${expiresAt}`,
      expires_at: expiresAt,
      claimed_at: claimedAt,
      paths: responseBody.paths || paths,
      ttl: responseBody.ttl,
      budget_usd: responseBody.budget_usd,
      max_runtime_s: responseBody.max_runtime_s,
      deadline: responseBody.deadline,
    };
  }

  // Explicit refusal: the Governor's rule text rides verbatim into the blocker.
  if (response.status === 403 || response.status === 409 || response.status === 422) {
    return refused(responseBody.reason || `Lease refused (${response.status})`);
  }

  // Any other status is not a decision; never proceed on it.
  return unavailable(`Governor error: unexpected status ${response.status} ${responseBody.reason || "unknown"}`);
}

// ── W2: the `governed` unattended policy profile ───────────────────────────────────────────────
// The child agent's guard relaxes a small, explicitly classified set of CONFIRMATION-shaped gates
// only when BOTH of these are present in its environment (see vinci/extensions/lib/unattended-policy.ts
// and vinci/worker/README.md). This is the only producer of either variable in the codebase.
//
// The delete-on-no-lease half is the load-bearing half. `undefined` here means "remove this key from
// the child's environment", which is why the daemon's OWN environment cannot leak the profile into a
// run the Governor never leased: an operator who exports VINCI_UNATTENDED_POLICY=governed on the box
// still gets today's conservative gate on every ungoverned task, because this function strips it.
export const UNATTENDED_POLICY_ENV_KEYS = Object.freeze(["VINCI_UNATTENDED_POLICY", "VINCI_UNATTENDED_LEASE"]);

export function unattendedPolicyEnv(lease) {
  // A lease is a GRANTED lease and nothing else. `null` (no --governor configured at all), a
  // refusal, an unavailability, or a malformed object all mean no authority backs this run, and an
  // unattended run with no authority behind it keeps the conservative gate.
  const granted = lease && lease.success === true && typeof lease.id === "string" && lease.id.length > 0;
  if (!granted) return { VINCI_UNATTENDED_POLICY: undefined, VINCI_UNATTENDED_LEASE: undefined };
  return { VINCI_UNATTENDED_POLICY: "governed", VINCI_UNATTENDED_LEASE: lease.id };
}

function positiveSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function tightenEnvelopeLimits(envelope, governorOrder) {
  if (!governorOrder) return envelope;

  const tightened = { ...envelope };

  if (governorOrder.budget_usd && governorOrder.budget_usd < envelope.budget_usd) {
    tightened.budget_usd = governorOrder.budget_usd;
  }

  // The lease TTL is a hard runtime cap: a task must never outlive its lease. The effective
  // limit is the smallest of the envelope's max_runtime_s, the Governor's work-order
  // max_runtime_s, and the lease ttl (seconds; already validated finite-positive by
  // claimGovernorPaths, re-checked here so the function is safe standalone).
  const runtimeCaps = [governorOrder.max_runtime_s, governorOrder.ttl]
    .map(positiveSeconds)
    .filter((seconds) => seconds !== null && seconds < tightened.max_runtime_s);
  if (runtimeCaps.length > 0) {
    tightened.max_runtime_s = Math.min(...runtimeCaps);
  }

  if (governorOrder.deadline) {
    const govDeadline = Date.parse(governorOrder.deadline);
    const envDeadline = envelope.deadline ? Date.parse(envelope.deadline) : Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (govDeadline < envDeadline) {
      tightened.deadline = governorOrder.deadline;
    }
  }

  return tightened;
}
