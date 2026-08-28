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
    return {
      success: true,
      claimed_at: new Date().toISOString(),
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
