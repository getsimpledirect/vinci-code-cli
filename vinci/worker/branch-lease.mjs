// Branch leases (vinci-gpu-control CONTRACT §36): one writer per (repo, branch).
//
// WHAT THIS CLOSES. §36.5 says plainly: "No push path, merge tool, scheduler,
// planner, or background loop consults a branch lease... There is no git hook,
// no server-side wrapper around a push, and no client that calls acquire /
// check before writing." This is that client, and publisher.mjs is that push
// path.
//
// NOT the §29 work-lease in lease.mjs. That one governs whether an ATTEMPT may
// keep working (POST /v1/governor/leases). This one governs whether a BRANCH
// may be written (POST/GET/DELETE /v1/branch-leases). A worker holding a valid
// work-lease can still clobber a branch another lane owns, which is exactly the
// gap §36 exists for. The two are deliberately separate and neither implies the
// other.
//
// Endpoints (server: _admin_or_collector_principal, so a Bearer token):
//   POST   /v1/branch-leases       {repo,branch,session_id,attempt_id,head_sha,ttl?}
//                                  => 200 {ok,reason,lease} | 409 {ok:false,reason}
//   GET    /v1/branch-leases?repo=&branch=&fencing_generation=
//                                  => 200 {valid,reason,lease}
//   DELETE /v1/branch-leases?repo=&branch=&fencing_generation=
//                                  => 200 {ok,reason} | 409 {ok:false,reason}
//
// holder_principal is SERVER-DERIVED. Sending it is a 422 by design ("a client
// that gets to name the holder gets to name somebody else"), so this client
// never sends it.

export const BRANCH_LEASE_TIMEOUT_MS = 10_000;
export const BRANCH_LEASE_TOKEN_MISSING = "branch lease token missing (VINCI_BUS_TOKEN)";
export const BRANCH_LEASE_DEFAULT_TTL_S = 3600;

// A check that cannot reach the server is NOT a pass. checkFence() in
// publisher.mjs already treats a thrown check as fenced_out, and this client
// keeps that property by throwing rather than returning a verdict it did not
// receive. The failure mode this avoids is the one §36 is about: a lane that
// believes it holds a branch, cannot confirm it, and pushes anyway.
function fail(reason) {
  const error = new Error(reason);
  error.branchLease = true;
  return error;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class BranchLeaseClient {
  constructor(serverUrl, token, { timeoutMs = BRANCH_LEASE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server must use http or https");
    if (url.username || url.password) throw new Error("server URL must not contain credentials");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");
    this.serverUrl = url.href.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async #send(method, path, { body = null, query = null } = {}) {
    if (!this.token) throw fail(BRANCH_LEASE_TOKEN_MISSING);
    const url = new URL(`${this.serverUrl}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const controller = new AbortController();
    // Without this a hung server hangs the push instead of refusing it, and a
    // hung push is indistinguishable from a slow one to everything upstream.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw fail(`branch lease ${method} ${path} failed: ${error.name === "AbortError" ? `no answer within ${this.timeoutMs} ms` : error.message}`);
    } finally {
      clearTimeout(timer);
    }
    const payload = await readJson(response);
    // 409 is a real answer (refused), not a transport failure: the server says
    // somebody else holds it. Anything else non-2xx is unusable.
    if (!response.ok && response.status !== 409) {
      throw fail(`branch lease ${method} ${path} failed: ${response.status} ${JSON.stringify(payload)?.slice(0, 200) ?? ""}`);
    }
    if (payload === null || typeof payload !== "object") {
      throw fail(`branch lease ${method} ${path} returned an unreadable body`);
    }
    return payload;
  }

  async acquire({ repo, branch, sessionId, attemptId, headSha, ttl = BRANCH_LEASE_DEFAULT_TTL_S }) {
    for (const [name, value] of [["repo", repo], ["branch", branch], ["sessionId", sessionId], ["attemptId", attemptId]]) {
      if (typeof value !== "string" || value === "") throw fail(`branch lease acquire needs a non-empty ${name}`);
    }
    // head_sha is REQUIRED by the server and is what makes the detector work:
    // the lease remembers the head its holder last knew, so a later observation
    // of a different head while the lease is live is a foreign write. An empty
    // string is the honest value for a branch that does not exist yet.
    const payload = await this.#send("POST", "/v1/branch-leases", {
      body: { repo, branch, session_id: sessionId, attempt_id: attemptId, head_sha: headSha ?? "", ttl },
    });
    return { ok: payload.ok === true, reason: payload.reason ?? "", lease: payload.lease ?? null };
  }

  async check({ repo, branch, fencingGeneration }) {
    if (!Number.isInteger(fencingGeneration)) throw fail("branch lease check needs an integer fencingGeneration");
    const payload = await this.#send("GET", "/v1/branch-leases", {
      query: { repo, branch, fencing_generation: fencingGeneration },
    });
    // Only an explicit true is a pass. A body missing `valid` is not a quiet
    // yes -- that is the fail-open shape this whole module exists to remove.
    return { valid: payload.valid === true, reason: payload.reason ?? "no reason given" };
  }

  async release({ repo, branch, fencingGeneration }) {
    if (!Number.isInteger(fencingGeneration)) throw fail("branch lease release needs an integer fencingGeneration");
    const payload = await this.#send("DELETE", "/v1/branch-leases", {
      query: { repo, branch, fencing_generation: fencingGeneration },
    });
    return { ok: payload.ok === true, reason: payload.reason ?? "" };
  }
}

// Adapter to publisher.mjs's existing gate. checkFence() wants
// `{ generation?, check() -> {valid, reason} }`, and the server's check route
// already returns exactly that shape -- so the seam needed no new contract.
export function branchLeaseFence(client, { repo, branch, fencingGeneration }) {
  return {
    generation: fencingGeneration,
    branchLease: true,
    check: async () => client.check({ repo, branch, fencingGeneration }),
  };
}
