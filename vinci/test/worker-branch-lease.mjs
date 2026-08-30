// §36 branch leases in the push path. The properties here are the ones whose
// absence made §36.5 read "no client calls acquire / check before writing".
import assert from "node:assert/strict";
import { BranchLeaseClient, branchLeaseFence } from "../worker/branch-lease.mjs";
import { checkFence, composeFences } from "../worker/publisher.mjs";

let failures = 0;
const ok = (name, cond) => {
  if (cond) { console.log(`ok - ${name}`); return; }
  failures += 1; console.log(`NOT OK - ${name}`);
};
const stub = (handler) => async (url, init) => handler(new URL(url), init ?? {});
const client = (handler) => new BranchLeaseClient("https://server.test", "tok", { fetchImpl: stub(handler) });

// ---- composeFences -------------------------------------------------------
// Composing NOTHING must not manufacture a pass. If this returned an
// always-valid fence, "no gates configured" would silently become "all gates
// passed" -- the fail-open shape this work exists to remove.
ok("composing no fences yields null, not a valid fence", composeFences(null, undefined) === null);

const yes = { check: async () => ({ valid: true }) };
ok("a single fence passes through unwrapped", composeFences(null, yes) === yes);

const no = { check: async () => ({ valid: false, reason: "branch held by other" }) };
const both = composeFences(yes, no);
const verdict = await both.check({ stage: "push" });
ok("a composed fence fails when ANY member fails", verdict.valid === false);
ok("the refusal names the fence that refused", verdict.reason === "branch held by other");

// Order matters: the FIRST invalid short-circuits, so the reason is the one
// that actually refused rather than whichever answered last.
const no2 = { check: async () => ({ valid: false, reason: "second" }) };
ok("first refusal wins", (await composeFences(no, no2).check({ stage: "push" })).reason === "branch held by other");

// A member that returns a malformed verdict is not a pass.
const junk = { check: async () => ({ ok: true }) };
ok("a verdict without valid:true is a refusal", (await composeFences(yes, junk).check({})).valid === false);

// ---- check: only an explicit true is a pass ------------------------------
ok("check passes on {valid:true}",
   (await client(() => new Response(JSON.stringify({ valid: true, reason: "held" }), { status: 200 })).check({ repo: "o/r", branch: "b", fencingGeneration: 3 })).valid === true);
ok("check refuses on {valid:false}",
   (await client(() => new Response(JSON.stringify({ valid: false, reason: "stale generation" }), { status: 200 })).check({ repo: "o/r", branch: "b", fencingGeneration: 3 })).valid === false);
ok("a body with no `valid` key is a refusal, not a quiet yes",
   (await client(() => new Response(JSON.stringify({ reason: "?" }), { status: 200 })).check({ repo: "o/r", branch: "b", fencingGeneration: 3 })).valid === false);
ok("truthy-but-not-true is a refusal",
   (await client(() => new Response(JSON.stringify({ valid: "yes" }), { status: 200 })).check({ repo: "o/r", branch: "b", fencingGeneration: 3 })).valid === false);

// ---- unreachable server is NOT permission to write -----------------------
let threw = false;
try {
  await client(() => { throw new Error("ECONNREFUSED"); }).check({ repo: "o/r", branch: "b", fencingGeneration: 1 });
} catch { threw = true; }
ok("an unreachable server throws rather than returning valid", threw);

// ...and publisher.mjs turns that throw into a refusal at the gate.
const throwing = branchLeaseFence(client(() => { throw new Error("ECONNREFUSED"); }), { repo: "o/r", branch: "b", fencingGeneration: 1 });
ok("a throwing branch fence fences the push out", (await checkFence(throwing, "push")).valid === false);

// A 5xx is not a verdict either.
let threw5xx = false;
try {
  await client(() => new Response("boom", { status: 500 })).check({ repo: "o/r", branch: "b", fencingGeneration: 1 });
} catch { threw5xx = true; }
ok("a 500 is not read as a pass", threw5xx);

// ---- acquire -------------------------------------------------------------
const acq = await client(() => new Response(JSON.stringify({ ok: true, reason: "acquired", lease: { fencing_generation: 7, repo: "o/r", branch: "b" } }), { status: 200 }))
  .acquire({ repo: "o/r", branch: "b", sessionId: "s", attemptId: "1", headSha: "abc" });
ok("acquire returns the lease and its generation", acq.ok === true && acq.lease.fencing_generation === 7);

// 409 is a real answer (someone else holds it), not a transport error.
const refused = await client(() => new Response(JSON.stringify({ ok: false, reason: "held by another session" }), { status: 409 }))
  .acquire({ repo: "o/r", branch: "b", sessionId: "s", attemptId: "1", headSha: "abc" });
ok("a 409 is a refusal, not an exception", refused.ok === false && refused.reason === "held by another session");

// holder_principal is server-derived; sending it is a 422 by design, so the
// client must never put it on the wire.
let sentBody = null;
await client((_u, init) => { sentBody = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true, reason: "", lease: {} }), { status: 200 }); })
  .acquire({ repo: "o/r", branch: "b", sessionId: "s", attemptId: "1", headSha: "abc" });
ok("acquire never sends holder_principal", sentBody !== null && !("holder_principal" in sentBody));
ok("acquire sends head_sha (the detector depends on it)", sentBody.head_sha === "abc");

// ---- release -------------------------------------------------------------
let releasedUrl = null;
await client((u) => { releasedUrl = u; return new Response(JSON.stringify({ ok: true, reason: "released" }), { status: 200 }); })
  .release({ repo: "o/r", branch: "b", fencingGeneration: 7 });
ok("release passes the fencing generation", releasedUrl?.searchParams.get("fencing_generation") === "7");

console.log(failures === 0 ? "\nall branch-lease checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
