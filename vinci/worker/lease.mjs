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
//     ⇒ 200 {lease_id, fencing_generation, expires_at, ttl_s}
//     | 409 {reason:"leased", holder_attempt_id, expires_at}
//   POST /v1/governor/leases/{id}/renew      {fencing_generation}
//     ⇒ 200 {expires_at, ttl_s} | 409 {reason: "stale_generation"|"expired"|"revoked"}
//   POST /v1/governor/leases/{id}/release    {fencing_generation, outcome}   ⇒ 200
//   POST /v1/governor/leases/{id}/check      {fencing_generation}            ⇒ 200 {valid, reason}
//
// Fail-closed throughout: the ONLY result that lets a task proceed is a 200 lease whose body
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

function validGeneration(value) {
  return (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length > 0);
}

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
    if (status === 200) {
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
    if (status === 409 && body.reason === "leased") {
      return {
        success: false,
        blocked: true,
        leased: true,
        holder_attempt_id: body.holder_attempt_id ?? null,
        expires_at: body.expires_at ?? null,
        reason: `leased_by ${body.holder_attempt_id ?? "unknown"} until ${body.expires_at ?? "unknown"}`,
      };
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
      if (result.status === 200 && result.body) {
        return { ok: true, expires_at: result.body.expires_at ?? lease.expires_at ?? null, ttl_s: validTtl(result.body.ttl_s) ? result.body.ttl_s : lease.ttl_s, epoch: result.body.epoch ?? null };
      }
      if (result.status === 409 && result.body) {
        const reason = typeof result.body.reason === "string" && result.body.reason ? result.body.reason : "refused";
        return { ok: false, lost: true, reason };
      }
      last = result.transport ?? result.malformed ?? `unexpected status ${result.status}`;
    }
    return { ok: false, lost: true, reason: "unreachable", detail: last };
  }

  // L4. Never throws; returns `{ ok }` and logs a failure.
  async release(lease, outcome) {
    if (!RELEASE_OUTCOMES.includes(outcome)) throw new Error(`invalid release outcome: ${outcome}`);
    try {
      const result = await this.post(`/v1/governor/leases/${encodeURIComponent(lease.lease_id)}/release`, { fencing_generation: lease.fencing_generation, outcome }, { authorization: `Session ${this.token}` });
      if (result.status === 200) return { ok: true, epoch: result.body?.epoch ?? null };
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
    if (result.status === 200 && result.body) {
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
