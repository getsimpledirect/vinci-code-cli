// Wave 1B: the worker side of the Governor lease loop (acquire → heartbeat/renew → loss of
// authority → publisher fencing → release) and the worker capability declaration.
//
// Wire contract (fixed; the Governor lane builds the other side in parallel — field names are
// not ours to rename). Every call goes to `<governor>/v1/governor/leases…` with
// `Authorization: Session <VINCI_GOVERNOR_TOKEN>` except `check`, which the PUBLISHER calls with
// the bus token (`Authorization: Bearer <VINCI_BUS_TOKEN>`) before every consequential side
// effect. Every response carries `epoch`; the worker records it and never interprets it.
//
//   POST /v1/governor/leases                 {work_order_id, attempt_id, worker_build_digest,
//                                             adapter_version, capability_declaration_digest?}
//     ⇒ 2xx {lease_id, fencing_generation, expires_at, ttl_s}
//     | 409 {reason:"leased", holder_attempt_id, expires_at}   (older servers: 403
//       {reason:"leased_by_other_attempt"} — both are read as the same decision)
//     | 403/409 {reason:<anything>}  every other one ⇒ a REFUSAL decision, reason verbatim
//   POST /v1/governor/leases/{id}/renew      {fencing_generation}
//     ⇒ 2xx {expires_at, ttl_s} | 409 {reason: "stale_generation"|"expired"|"revoked"}
//       (older servers carry those same reasons on a 403)
//   POST /v1/governor/leases/{id}/release    {fencing_generation, outcome}   ⇒ 200
//   POST /v1/governor/leases/{id}/check      {fencing_generation}            ⇒ 200 {valid, reason}
//
// The two repos deploy independently, so this client assumes NEITHER the server's status codes
// nor its rollout state: any 2xx with a well-formed body is a success, and EVERY 403 or 409 on a
// lease route is a final decision (CONTRACT §29.1, as proposed in #201) — carried by the status, never by matching the
// reason text, which is payload.
//
// Fail-closed throughout: the ONLY result that lets a task proceed is a 2xx lease whose body
// can bound the run (a string lease_id, a fencing_generation, a ttl_s of at least 1 second). A
// renew that is refused, or unreachable after one retry, is LOSS OF AUTHORITY. A check that
// cannot be answered is `valid: false`. Release failures are logged and never change a task's
// state. Every request is bounded by LEASE_TIMEOUT_MS: a Governor that accepts the connection and
// never answers is `Governor connection failed: timeout after N ms`, the same class as a refused
// connection (a hang must not hold a heartbeat, a fence or a release open forever).
import { createHash } from "node:crypto";

import { canonicalize } from "./contracts/canonical.mjs";
import { recordDigest } from "./contracts/digest.mjs";

export const LEASE_TOKEN_MISSING = "governor token missing (VINCI_GOVERNOR_TOKEN)";
export const LEASE_TIMEOUT_MS = 10_000;
// A lease must be able to bound a run: ttl_s below one second (0, 0.3, negative, NaN, a string)
// is refused at acquire, and a renew that serves such a value keeps the previous ttl.
export const MIN_TTL_S = 1;
export const RELEASE_OUTCOMES = Object.freeze(["completed", "failed", "blocked", "unverified", "abandoned"]);

// The lease subject: what the Governor keys the lease on. Today the envelope's `ref` (a ledger
// job/experiment id) when present, else the bus task id. Digest handoffs will pass the real
// work-order id later; the daemon takes this as an injectable function so that change is one
// argument, not a rewrite.
export function leaseSubject(task) {
  return task?.envelope?.ref ?? task?.id ?? null;
}

function validTtl(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_TTL_S;
}

// D2 (#201 integration): the generation must be an integer >= 1. No string half, no widening.
//
// CHOSEN: narrow the string half, rather than keep it and treat a 400-on-renew as a decision.
// Both options were on the table; this one is right because the previous justification for the
// string half was self-refuting. It read: refusing a string "would turn a future server-side
// token change into a total, silent inadmissibility". But `app.py::_generation_from` requires
// `type is int and >= 1` and 400s otherwise, so accepting a string never avoided that outcome —
// it relocated it. Acquire succeeds, the clone runs, the child spawns, and THEN every renew 400s,
// is retried once, is filed `unreachable`, authority is declared lost and the child is SIGTERMed
// mid-flight. That is precisely the "moves the failure past the point of no return" outcome the
// paragraph directly above it gave as the reason to narrow the NUMBER half. The two halves argued
// against each other; the number half had it right.
//
// So the rule is one rule, in one direction: a generation this client cannot hand back
// successfully is refused AT ACQUIRE, where the task is BLOCKED cleanly, before a clone, before a
// spawn and before a single paid token. A loud failure with the offending value in the reason,
// at the cheapest possible moment, beats a silent one after the work is done.
//
// The rejected alternative is worth naming: handling a 400-on-renew as a decision would make the
// failure final rather than a mislabelled transport fault, but it would still be a failure DURING
// the run, with the clone and the model spend already sunk. It fixes the label, not the timing.
// (Independently of this: a 400 on a lease route is never transient, so retrying one is always
// wasted. Not fixed here — it is the other branch of the either/or, and folding both in would
// blur which change is load-bearing. Flagged for the server lane's §29 answer on whether the
// generation is permanently an integer; if it is, this narrowing is simply correct and the 400
// path is unreachable.)
//
// `ttl_s`, `lease_id` and now `fencing_generation` are all type-checked hard. Nothing in a lease
// response is merely carried any more.
function validGeneration(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// Any 2xx is a success (#201 review). The Governor's acquire is changing from 201 to 200 and the
// two repos deploy independently, so neither side may assume the other's version: a client pinned
// to `status === 200` refuses a lease it was actually granted (and, worse, leaves the Governor
// holding a lease nobody will renew or release). A status alone is never enough — every caller
// below still requires a well-formed body before it proceeds.
function isSuccess(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

// WARN-3 / D1 (#201 integration): what the Governor answers on a lease route when the request will
// not be reconsidered. These are DECISIONS — final, never retried.
//
// CLASSIFY ON THE STATUS, NOT ON A LIST OF REASON STRINGS. Per CONTRACT §29.1 (as proposed in
// gpu-control #201 — not yet on main) NONE of the 403 reasons is a transport fault: the request
// arrived, was understood, and was answered. That is what makes the status alone sufficient to
// decide RETRY, and 409 is reserved for lease state.
//
// The status decides RETRY. It does NOT decide FAULT, and this file must not conflate the two:
// §29.1 attributes only TWO of its enumerated 403 reasons to the caller ("lease not held by this
// session", "session does not hold this work order") and the rest to SERVER defects — conditions
// the caller neither caused nor can fix. A review of #201 has since found a further undocumented
// reason ("token refused"), so the enumeration is not closed either. Carry the reason verbatim and
// never infer blame — or completeness — from the status.
//
// This replaces a hand-maintained list of reason strings, and the list is why it is gone:
//   - first pass: written in snake_case (`unknown_lease`, `not_holder`) while the server emitted
//     prose. Zero matches. The whole list was inert and nothing it claimed to fix was fixed.
//   - second pass: rewritten with the strings read out of the server source. Still 1-of-15 live —
//     the real 403 set is larger than any list assembled by reading code, and the integration
//     caught `403 {"reason":"session does not hold this work order"}` being filed as a transport
//     fault, contradicting this file's own promise that "refusal and unavailability are never
//     conflated".
// A list of strings has now been wrong twice, in both directions, and would go stale again the
// next time the server adds a reason. The status is the contract; match on that.
const LEASE_DECISION_STATUSES = Object.freeze([403, 409]);

// Non-2xx ⇒ a decision reason, or null for "not a decision — fail closed on the caller's own
// path". Deliberately NOT a blanket 4xx: 408 and 429 are transient and must keep the retry, and
// nothing in the contract makes them refusals. Only the two statuses the contract names.
function leaseStateDecision(status, body) {
  if (isSuccess(status) || !LEASE_DECISION_STATUSES.includes(status)) return null;
  const reason = body && typeof body.reason === "string" && body.reason ? body.reason : null;
  return reason || "refused";
}

const LEASE_HELD_REASONS = Object.freeze(["leased", "leased_by_other_attempt", "lease not held by this session"]);

async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { error: `invalid JSON (status ${response.status}): ${error.message}` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: `malformed body (status ${response.status}): ${JSON.stringify(body)}` };
  }
  return { body };
}

export class LeaseClient {
  // `timeoutMs` bounds every request (connect + headers + body); injectable for tests.
  constructor({ governorUrl, token, busToken, fetch: fetchImpl = globalThis.fetch, log = (line) => process.stderr.write(`${line}\n`), timeoutMs = LEASE_TIMEOUT_MS }) {
    this.governorUrl = governorUrl ? String(governorUrl).replace(/\/+$/, "") : null;
    this.token = token ?? null;
    this.busToken = busToken ?? null;
    this.fetch = fetchImpl;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  async post(path, body, { authorization }) {
    const url = `${this.governorUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();
    try {
      let response;
      try {
        response = await this.fetch(url, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") return { transport: `Governor connection failed: timeout after ${this.timeoutMs} ms` };
        return { transport: `Governor connection failed: ${error?.cause?.code ?? error.message}` };
      }
      const parsed = await readJson(response);
      if (parsed.error) {
        if (controller.signal.aborted) return { transport: `Governor connection failed: timeout after ${this.timeoutMs} ms` };
        return { status: response.status, malformed: `Governor returned ${parsed.error}` };
      }
      return { status: response.status, body: parsed.body };
    } finally {
      clearTimeout(timer);
    }
  }

  // L1. Returns exactly one of:
  //   { success: true, lease: { lease_id, fencing_generation, expires_at, ttl_s, epoch, acquired_at } }
  //   { success: false, blocked: true, leased: true, holder_attempt_id, expires_at, reason }   (409 leased — not ours)
  //   { success: false, blocked: true, unavailable: true, reason }                              (everything else)
  async acquire({ workOrderId, attemptId, workerBuildDigest, adapterVersion, capabilityDeclarationDigest }) {
    if (!this.governorUrl) return unavailable("no Governor URL configured");
    if (!this.token) return unavailable(LEASE_TOKEN_MISSING);
    if (!workOrderId) return unavailable("lease subject is empty (no work_order_id)");
    const request = {
      work_order_id: workOrderId,
      attempt_id: attemptId,
      worker_build_digest: workerBuildDigest,
      adapter_version: adapterVersion,
    };
    if (capabilityDeclarationDigest) request.capability_declaration_digest = capabilityDeclarationDigest;
    const result = await this.post("/v1/governor/leases", request, { authorization: `Session ${this.token}` });
    if (result.transport) return unavailable(result.transport);
    if (result.malformed) return unavailable(result.malformed);
    const { status, body } = result;
    if (isSuccess(status)) {
      if (typeof body.lease_id !== "string" || !body.lease_id) return unavailable(`Governor lease invalid: lease_id=${JSON.stringify(body.lease_id)}`);
      if (!validGeneration(body.fencing_generation)) return unavailable(`Governor lease invalid: fencing_generation=${JSON.stringify(body.fencing_generation)}`);
      if (!validTtl(body.ttl_s)) return unavailable(`Governor lease invalid: ttl_s=${JSON.stringify(body.ttl_s)}`);
      return {
        success: true,
        lease: {
          lease_id: body.lease_id,
          fencing_generation: body.fencing_generation,
          expires_at: body.expires_at ?? null,
          ttl_s: body.ttl_s,
          epoch: body.epoch ?? null,
          acquired_at: new Date().toISOString(),
        },
      };
    }
    // Every lease-state answer at acquire is a Governor DECISION, not a failure — on the old 403
    // or the new 409 — and the daemon must file it as one. Two shapes:
    //   leased  : someone else holds this order (a holder and an expiry the operator can act on)
    //   refused : the order itself will not admit this attempt ("work order expired",
    //             "session not in a live state", "work order deadline rule: ...", revoked, ...).
    // Before this, everything but a 409 "leased" fell through to `unavailable`, so a Governor that
    // had DECIDED (409 work order expired) was recorded as a Governor that had FAILED — the exact
    // conflation the README promises never happens, and the one the path-claim path already
    // avoids.
    const decision = leaseStateDecision(status, body);
    if (decision) {
      if (LEASE_HELD_REASONS.includes(decision)) {
        return {
          success: false,
          blocked: true,
          leased: true,
          holder_attempt_id: body.holder_attempt_id ?? null,
          expires_at: body.expires_at ?? null,
          reason: `leased_by ${body.holder_attempt_id ?? "unknown"} until ${body.expires_at ?? "unknown"}`,
        };
      }
      return { success: false, blocked: true, refused: true, reason: decision };
    }
    return unavailable(`Governor error: unexpected status ${status} ${body.reason ?? "unknown"}`);
  }

  // L2 (one renew). `{ ok: true, expires_at, ttl_s }` or `{ ok: false, lost: true, reason }`. A
  // 409 is a decision (stale_generation | expired | revoked) and is final. Anything else (network,
  // malformed body, unexpected status) is retried ONCE; a second miss is `unreachable`.
  async renew(lease) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.post(`/v1/governor/leases/${encodeURIComponent(lease.lease_id)}/renew`, { fencing_generation: lease.fencing_generation }, { authorization: `Session ${this.token}` });
      if (isSuccess(result.status) && result.body) {
        return { ok: true, expires_at: result.body.expires_at ?? lease.expires_at ?? null, ttl_s: validTtl(result.body.ttl_s) ? result.body.ttl_s : lease.ttl_s, epoch: result.body.epoch ?? null };
      }
      // A lease-state answer is FINAL loss of authority — never retried — whether the server sends
      // it as the old 403 or the new 409.
      const decision = leaseStateDecision(result.status, result.body);
      if (decision) return { ok: false, lost: true, reason: decision };
      last = result.transport ?? result.malformed ?? `unexpected status ${result.status}`;
    }
    return { ok: false, lost: true, reason: "unreachable", detail: last };
  }

  // L4. Never throws; returns `{ ok }` and logs a failure.
  async release(lease, outcome) {
    if (!RELEASE_OUTCOMES.includes(outcome)) throw new Error(`invalid release outcome: ${outcome}`);
    try {
      const result = await this.post(`/v1/governor/leases/${encodeURIComponent(lease.lease_id)}/release`, { fencing_generation: lease.fencing_generation, outcome }, { authorization: `Session ${this.token}` });
      if (isSuccess(result.status)) return { ok: true, epoch: result.body?.epoch ?? null };
      this.log(`vinci worker: lease ${lease.lease_id} release (${outcome}) failed: ${result.transport ?? result.malformed ?? `status ${result.status} ${result.body?.reason ?? ""}`}`);
      return { ok: false };
    } catch (error) {
      this.log(`vinci worker: lease ${lease.lease_id} release (${outcome}) failed: ${error.message}`);
      return { ok: false };
    }
  }

  // L3. The publisher's fence, with the BUS token. `{ valid: true }` only on a 200 whose body says
  // `valid: true`; every other answer (including no answer) is `{ valid: false, reason }`.
  async check(lease) {
    if (!this.busToken) return { valid: false, reason: "bus token missing" };
    const result = await this.post(`/v1/governor/leases/${encodeURIComponent(lease.lease_id)}/check`, { fencing_generation: lease.fencing_generation }, { authorization: `Bearer ${this.busToken}` });
    if (isSuccess(result.status) && result.body) {
      if (result.body.valid === true) return { valid: true, reason: result.body.reason ?? null, epoch: result.body.epoch ?? null };
      return { valid: false, reason: typeof result.body.reason === "string" && result.body.reason ? result.body.reason : "invalid", epoch: result.body.epoch ?? null };
    }
    return { valid: false, reason: result.transport ?? result.malformed ?? `check unexpected status ${result.status} ${result.body?.reason ?? ""}`.trim() };
  }
}

function unavailable(reason) {
  return { success: false, blocked: true, unavailable: true, reason };
}

// L2. Renew every ttl_s/3 while `stop()` has not been called. Timers are unref'd so an idle
// daemon never stays alive for a lease. The FIRST renew failure (a 409 decision, or unreachable
// after one retry) calls `onLoss(reason)` exactly once and stops the loop; `lease` is mutated in
// place with each renewed expires_at/ttl_s so the caller's record stays current.
// `setTimer`/`clearTimer` are injectable for tests.
export function startHeartbeat({ client, lease, onLoss, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  let timer = null;
  let lost = false;
  let renewing = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimer(tick, Math.max(1, (lease.ttl_s / 3) * 1000));
    if (typeof timer?.unref === "function") timer.unref();
  };
  const tick = async () => {
    if (stopped) return;
    renewing = client.renew(lease);
    const result = await renewing;
    renewing = null;
    if (stopped) return;
    if (result.ok) {
      lease.expires_at = result.expires_at;
      lease.ttl_s = result.ttl_s;
      lease.renewed_at = new Date().toISOString();
      lease.renewals = (lease.renewals ?? 0) + 1;
      schedule();
      return;
    }
    lost = true;
    stopped = true;
    onLoss(result.reason, result.detail ?? null);
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
    get lost() {
      return lost;
    },
    // A renew in flight when stop() is called is awaited so a test can observe a settled state.
    async settled() {
      if (renewing) await renewing;
    },
  };
}

// D1 refresh cadence. The Governor EXPIRES a declaration at VGC_DECLARATION_MAX_AGE_S and then
// answers admission `eligible: false, reason: stale_declaration`, so a governed daemon must
// re-declare while it is alive. The interval is chosen against ROW RETENTION, not liveness
// (gpu-control §32): `worker_declarations` is append-only with a DELETE trigger and each refresh
// writes an audit row, so the volume cannot be pruned later. The default keeps
// REFRESH_HEADROOM_FACTOR refreshes inside the window — enough to absorb several consecutive
// failed re-posts — and no more.
export const GOVERNOR_DECLARATION_MAX_AGE_S = 86400;
export const REFRESH_HEADROOM_FACTOR = 4;
export const DECLARATION_REFRESH_DEFAULT_S = 21600;

// D1. What THIS daemon actually does — filled honestly against the matrix in
// vinci-contracts packages/worker-capabilities (WorkerDeclaration, schemaVersion 1):
//   activityStream         false  the bus sees claimed/terminal posts, not the run's activity
//   questions              false  `vinci -p` runs unattended; nobody can be asked
//   steering               false  no command can redirect a running task
//   approvals              "none" nothing in the run waits for a person
//   pause                  false  the only brake is termination
//   restrictToReadOnly     false  the tool set is fixed at spawn (read,grep,find,ls,bash,edit,write)
//   abort                  false  no bus command aborts a run: the daemon consumes only kind
//                                 "handoff" and has no abort handler. Limits, lease loss and the
//                                 daemon's own SIGTERM end a run, but none of those is a caller-
//                                 issued abort in the matrix's sense
//   filesystemEnforcement  false  the child runs in the shared checkout; nothing confines it
//   networkEnforcement     false  no network policy is applied to the child
//   structuredEvidence     CONFIG true only when VINCI_EVIDENCE_URI_PREFIX is set at startup: the
//                                 bundle (session.jsonl, git.diff, result.json, runner.log) is
//                                 uploaded only then; without it no evidence is produced at all
//   nativeReceipts         false  no receipt is emitted by the worker itself
//   safeResume             false  a daemon restart re-runs a RUNNING task as attempt N+1, but no
//                                 test proves a kill mid-write (task file, cursor, checkout, push)
//                                 resumes without loss or duplication; unproven ⇒ not claimed
//   independentVerification false verification happens inside the same run that did the work
// controlLevel is the DERIVED rung (activityStream false ⇒ "inventoried"); a higher claim is an
// overclaim the validator refuses. `buildDigest` is omitted: the matrix demands a SHA-256 and the
// daemon's build identity is a 40-hex git commit — that rides in the lease request's
// worker_build_digest instead, and the declaration's own digest names this record exactly.
//
// IR-02 (embedded runtime adapter) REVIEWED EVERY CANDIDATE FLAG AND FLIPPED NONE. The adapter
// adds real mechanisms — steer, interrupt, a durable per-run event stream, resume across a SIGKILL
// — but this matrix answers "what can a CALLER make this worker do", and no caller path reaches
// any of them. Each verdict below is MEASURED, not asserted, by
// vinci/test/worker-capability-declaration.mjs, which pins the flag to the measurement:
//   steering       false  worker-runtime-adapter-steer.mjs proves the adapter steers in-process
//                         (steer.received carries the instruction digest and the model observes
//                         the steer), but the daemon's inbox delivers ONLY kind "handoff": a bus
//                         "steer" addressed to this worker is dropped by BusClient.poll, so
//                         nothing a caller sends reaches handle.steer()
//   pause          false  the adapter appends run.paused and stops the turn (same test), and the
//                         embedded lane calls it on a tripped budget and on lease loss — neither
//                         is caller-issued, and no bus "pause" is delivered
//   abort          false  unchanged, and for the same reason: an abort command is not delivered
//   activityStream false  the embedded lane's run events are durable, but the sink is a LOCAL
//                         file under stateDir and the worker's bus client refuses every kind but
//                         status/finding/blocker — the run's activity has no transport, so the
//                         control plane still sees claimed/terminal posts only
//   safeResume     false  worker-runtime-adapter-resume.mjs proves the EMBEDDED adapter resumes
//                         across a SIGKILL with no sequence gap and no reuse. That is a different
//                         object from the one this flag names: it covers the adapter's session and
//                         event sink, not the task file, cursor, checkout or push, and it covers a
//                         lane a handoff does not select (`runtime` is absent on every envelope
//                         today, so the daemon takes the subprocess lane)
// A flag whose only evidence is "the code exists" stays false.
export const CAPABILITY_MATRIX = Object.freeze({
  activityStream: false,
  questions: false,
  steering: false,
  approvals: "none",
  pause: false,
  restrictToReadOnly: false,
  abort: false,
  filesystemEnforcement: false,
  networkEnforcement: false,
  structuredEvidence: false,
  nativeReceipts: false,
  safeResume: false,
  independentVerification: false,
});

// `structuredEvidence` is the one config-derived entry: the daemon passes
// Boolean(VINCI_EVIDENCE_URI_PREFIX) as read at startup. Everything else is the fixed matrix.
export function buildDeclaration({ workerId, workerVersion, adapterVersion, structuredEvidence = false }) {
  return {
    schemaVersion: 1,
    worker: { id: workerId, name: "Vinci Code worker", version: workerVersion },
    adapter: { id: "vinci-worker-daemon", version: adapterVersion },
    controlLevel: "inventoried",
    supports: { ...CAPABILITY_MATRIX, structuredEvidence: structuredEvidence === true },
  };
}

// sha256 over the canonical encoding (vendored contracts canonicalizer) — the same identity rule
// the Governor applies to work orders, so both sides name the declaration by the same string.
export function declarationDigest(declaration) {
  return recordDigest(declaration);
}

export function declarationBody(declaration) {
  return canonicalize(declaration);
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Release outcome for a terminal state. A task that lost or was fenced out of its authority
// is `abandoned` (the work stopped without a verdict on it); otherwise the state names the outcome.
export function releaseOutcome(state, { authorityLost = false } = {}) {
  if (authorityLost) return "abandoned";
  const outcome = String(state ?? "").toLowerCase();
  return RELEASE_OUTCOMES.includes(outcome) ? outcome : "failed";
}
