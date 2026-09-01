// CONTAINMENT: an execution spec may ask for no more than its work order grants.
//
// Binding (task.mjs step 3) proves WHICH order a spec was compiled from. That is identity, not
// containment — and before step 3.5 existed a correctly-bound spec could name a DIFFERENT
// repository, `targetBranch: main`, `promotion: pull_request`, tools nobody granted and a
// deadline past the order's expiry, and the worker ran it to COMPLETED and pushed. This suite
// pins the vendored upstream check (vinci/worker/contracts/within-order.mjs, ported from
// vinci-contracts packages/work-orders/src/within-order.ts) at the materializeEnvelope boundary:
// every refusal reason, one dimension at a time, plus the whole exceeds-everything spec.
//
// It also pins the `path:` GRANT grammar (vinci/worker/contracts/path-grant.mjs): a grant whose
// write scope nobody can read makes the ORDER invalid instead of passing as opaque prose. The
// grammar's own case-by-case agreement with upstream lives in worker-contract-vectors.mjs, which
// reads the shared vectors file byte for byte; here we prove the grammar is actually WIRED into
// validateWorkOrder and therefore into the handoff path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { executionSpecDigest, workOrderDigest, validateWorkOrder } from "../worker/contracts/digest.mjs";
import { checkValidatedExecutionSpecWithinOrder } from "../worker/contracts/within-order.mjs";
import { materializeEnvelope } from "../worker/task.mjs";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "fixtures/contract-vectors");
const workOrder = JSON.parse(readFileSync(join(VECTORS, "work-order-1-minimal", "input.json"), "utf8"));
const baseSpec = JSON.parse(readFileSync(join(VECTORS, "execution-spec-1-minimal", "input.json"), "utf8"));

// The golden order expires 2026-08-24; every spec below carries the vector's own deadline
// (2026-08-23T14:00), which is inside it. Only the deadline case moves.
const orderWith = (overrides = {}) => ({ ...JSON.parse(JSON.stringify(workOrder)), ...overrides });
const specFor = (order, overrides = {}) => ({
  ...JSON.parse(JSON.stringify(baseSpec)),
  workOrderId: order.id,
  workOrderDigest: workOrderDigest(order),
  requiredCapabilities: [], // the worker advertises none; unrelated to containment
  ...overrides,
});
// The registry answer for a (order, spec) pair, and the triple that names it.
const materialize = (order, spec) =>
  materializeEnvelope(
    { work_order_id: order.id, contract_digest: workOrderDigest(order), execution_spec_digest: executionSpecDigest(spec) },
    { work_order: order, execution_spec: spec },
    { modelClasses: { forte: { provider: "vinci", model: "forte" } }, modelClassesConfigured: true },
  );
// Materializing must throw a HandoffRefusal whose `.code` is `code` and whose message names
// every string in `names`.
function refuses(order, spec, code, names) {
  let thrown = null;
  try {
    materialize(order, spec);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected a refusal (${code}), got an envelope`);
  assert.equal(thrown.code, code, `refusal code: ${thrown.message}`);
  for (const name of names) assert.match(thrown.message, new RegExp(name), `the reason names ${name}: ${thrown.message}`);
  return thrown;
}

// --- precondition: the golden pair IS within its order, so every refusal below is caused by the
// one thing that case changes and not by a fixture that never passed. ---
{
  const spec = specFor(workOrder);
  assert.deepEqual(checkValidatedExecutionSpecWithinOrder(spec, workOrder), { ok: true, issues: [] }, "the golden vectors are a within-order pair");
  const materialized = materialize(workOrder, spec);
  assert.equal(materialized.envelope.branch, "feat/vector-1", "the golden pair materializes");
  assert.equal(materialized.contract.work_order_id, "wo-vec-1");
}

// --- BLOCK-1: one refusal reason per dimension ---------------------------------------------
// The golden order grants: tool:read, tool:edit, tool:bash,
// repo:github.com/getsimpledirect/vinci-contracts, branch:feat/*, promotion:pull_request
// (plus two prose grants, which cover nothing here).

// tool_not_granted — a tool the order never named. "edit files under src/api" is PROSE: it does
// not grant tool:write, however much it reads like it does.
refuses(workOrder, specFor(workOrder, { tools: ["read", "write"] }), "execution_exceeds_contract", [
  "tool_not_granted", "/tools/1",
]);

// repository_not_granted — bound to the right order, pointed at somebody else's repository.
refuses(workOrder, specFor(workOrder, { repository: { host: "github.com", owner: "getsimpledirect", name: "vinci-code-cli" } }), "execution_exceeds_contract", [
  "repository_not_granted", "/repository",
]);

// branch_not_granted — branch:feat/* covers feat/anything and NOTHING else. `main` is the case
// that matters: a spec that lands on the default branch of a repo whose order granted a feature
// prefix.
refuses(workOrder, specFor(workOrder, { targetBranch: "main" }), "execution_exceeds_contract", [
  "branch_not_granted", "/targetBranch",
]);
// The wildcard is a PREFIX match on "feat/", not a substring: "feature/x" and "feat" are out,
// "feat/a/b" is in.
for (const branch of ["feature/x", "feat", "xfeat/x"]) {
  refuses(workOrder, specFor(workOrder, { targetBranch: branch }), "execution_exceeds_contract", ["branch_not_granted"]);
}
assert.ok(checkValidatedExecutionSpecWithinOrder(specFor(workOrder, { targetBranch: "feat/a/b" }), workOrder).ok, "branch:feat/* covers a nested feature branch");

// promotion_not_granted — opening a pull request is PROMOTION and needs its own grant.
{
  const order = orderWith({ grantedAuthority: workOrder.grantedAuthority.filter((g) => g !== "promotion:pull_request") });
  refuses(order, specFor(order), "execution_exceeds_contract", ["promotion_not_granted", "/promotion"]);
  // …and the same order with promotion: none is fine: the refusal is about the promotion, not
  // about the order being short one grant.
  assert.ok(materialize(order, specFor(order, { promotion: "none" })).envelope, "promotion: none needs no promotion grant");
}

// deadline_exceeds_contract — a run that may continue past the grant's expiry is running without
// one. The order expires 2026-08-24T12:00:00.000Z.
refuses(workOrder, specFor(workOrder, { resourceBounds: { ...baseSpec.resourceBounds, deadline: "2026-08-24T12:00:00.001Z" } }), "execution_exceeds_contract", [
  "deadline_exceeds_contract", "/resourceBounds/deadline",
]);
// Exactly AT expiresAt is inside it (strictly-after is the rule).
assert.ok(
  checkValidatedExecutionSpecWithinOrder(specFor(workOrder, { resourceBounds: { ...baseSpec.resourceBounds, deadline: workOrder.expiresAt } }), workOrder).ok,
  "a deadline exactly at expiresAt is within the order",
);

// grant_wildcard_unbounded — "branch:*" is not a scope, it is the absence of one, and it is an
// error on the ORDER side even when the spec's branch would have been granted anyway.
for (const wildcard of ["branch:*", "branch:/*"]) {
  const order = orderWith({ grantedAuthority: [...workOrder.grantedAuthority, wildcard] });
  refuses(order, specFor(order), "execution_exceeds_contract", ["grant_wildcard_unbounded", "/order/grantedAuthority/"]);
}

// --- BLOCK-1, the proven consequence -------------------------------------------------------
// The exact spec the review demonstrated running to COMPLETED and pushing: an order granting
// only prose, and a spec naming a different repository, main, a pull request, three ungranted
// tools and a 500 USD budget. It must refuse BEFORE anything is materialized, and the reason
// must name every dimension, not just the first.
{
  const order = orderWith({ id: "wo-prose-only", grantedAuthority: ["edit files under src/api"] });
  const spec = specFor(order, {
    repository: { host: "github.com", owner: "someone-else", name: "production" },
    targetBranch: "main",
    promotion: "pull_request",
    tools: ["bash", "write", "edit"],
    resourceBounds: { ...baseSpec.resourceBounds, budgetMicrousd: 500000000 },
  });
  const thrown = refuses(order, spec, "execution_exceeds_contract", [
    "tool_not_granted", "repository_not_granted", "branch_not_granted", "promotion_not_granted",
  ]);
  const issues = checkValidatedExecutionSpecWithinOrder(spec, order).issues;
  assert.equal(issues.length, 6, `every dimension is reported, not just the first: ${JSON.stringify(issues.map((i) => i.code))}`);
  assert.match(thrown.message, /^execution_exceeds_contract: execution spec asks for more than the work order grants: /);
}

// --- BLOCK-1: containment runs AFTER binding, never instead of it --------------------------
// A spec that both exceeds its order AND names the wrong order must still refuse as
// binding_mismatch: step 3.5 does not get to reclassify an identity failure.
{
  const order = orderWith({ id: "wo-binding" });
  const spec = specFor(order, { targetBranch: "main", workOrderId: "wo-somewhere-else" });
  refuses(order, spec, "binding_mismatch", ["wo-somewhere-else"]);
}

// --- BLOCK-2: the `path:` grant grammar is wired into validateWorkOrder ---------------------
// Before this, grantedAuthority was a list of opaque non-blank strings and every one of these
// validated. They are write scopes nobody can read; the ORDER carrying one is malformed.
for (const [grant, code] of [
  ["path:../../etc/passwd", "path_grant_dotdot_segment"],
  ["path:/etc/shadow", "path_grant_absolute"],
  ["path:.", "path_grant_root_scope"],
  ["path:", "path_grant_empty"],
  ["path:./src/", "path_grant_dot_segment"],
  ["path:src//x.ts", "path_grant_empty_segment"],
  ["path:src\\x.ts", "path_grant_backslash"],
  ["path:src/\0x", "path_grant_nul"],
  [`path:${"a".repeat(1025)}`, "path_grant_too_long"],
]) {
  const order = orderWith({ id: "wo-badpath", grantedAuthority: [...workOrder.grantedAuthority, grant] });
  const result = validateWorkOrder(order);
  assert.equal(result.ok, false, `${grant}: the order must be invalid`);
  const found = result.issues.find((i) => i.code === code);
  assert.ok(found, `${grant}: expected ${code}, got ${JSON.stringify(result.issues.map((i) => i.code))}`);
  assert.equal(found.path, `/grantedAuthority/${order.grantedAuthority.length - 1}`, `${grant}: the issue points at the grant`);
  // …and the handoff carrying it never reaches a digest: an invalid order is not hashed.
  assert.throws(() => workOrderDigest(order), /cannot digest an invalid work order/, `${grant}: not hashed`);
}
// Well-formed path: grants are accepted (they simply cover nothing the worker checks yet), and
// PROSE grants keep working exactly as before — an unknown prefix is not this grammar's business.
for (const grant of ["path:src/", "path:src/api/handler.ts", "path:a..b/", "bogus:whatever", "restart the staging box"]) {
  const order = orderWith({ id: "wo-okgrant", grantedAuthority: [...workOrder.grantedAuthority, grant] });
  assert.equal(validateWorkOrder(order).ok, true, `${grant}: must still validate: ${JSON.stringify(validateWorkOrder(order).issues)}`);
}

// --- BLOCK-2: a spec carrying the newer `paths` field is refused, fail-closed ---------------
// vinci-contracts @ feat/path-grants added an optional `paths` array (the run's enumerated write
// scope). The worker does NOT vendor spec-side path scopes, so it must refuse the field rather
// than ignore it — ignoring it would run with root write scope while the contract said
// otherwise. THIS ASSERTION MUST BE UPDATED DELIBERATELY, and only together with the vendored
// `path_not_granted` check and an enforcement path that actually confines writes. Until then a
// green assertion here is the guarantee that the field cannot be silently dropped on the floor.
{
  const order = orderWith({ id: "wo-paths", grantedAuthority: [...workOrder.grantedAuthority, "path:src/"] });
  const spec = { ...specFor(order), paths: ["src/"] };
  const result = validateWorkOrder(order);
  assert.equal(result.ok, true, "the order granting path:src/ is valid");
  assert.throws(() => executionSpecDigest(spec), /\/paths unknown_field/, "a spec carrying `paths` is refused as unknown_field");
}

console.log("PASS worker-within-order");
