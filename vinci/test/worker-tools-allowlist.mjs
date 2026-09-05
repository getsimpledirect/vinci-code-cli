// TOOL ALLOWLIST: an execution spec may name only tools this worker advertises.
//
// `spec.tools` becomes the `--tools` CSV handed to the unattended `vinci -p` agent
// (run.mjs:1210). It was validated for SHAPE ONLY — a list of non-empty strings — so any string
// passed, and the launcher (vinci/bin/vinci) unconditionally registers ~30 extension tools
// (web_search, web_fetch, web_answer, library_docs, advisor, convene_council, orchestrate,
// spawn_helper, …) that a spec could therefore have named. task.mjs now holds SUPPORTED_TOOLS —
// exactly the seven tools run.mjs already falls back to — and refuses anything else as
// `tool_unsupported`, the same fail-closed posture the adjacent `requiredCapabilities` field has
// had against SUPPORTED_CAPABILITIES.
//
// This is hardening of a path not yet in service, not the closure of a live hole: `spec.tools`
// is populated ONLY by the digest handoff form, the prose envelope form has no `tools` header
// (HEADER_KEYS), and the digest path needs a contract registry that production does not set. The
// suite is written so it keeps its meaning when that registry IS enabled.
//
// `tool_unsupported` is deliberately NOT `tool_not_granted`. The latter belongs to containment
// (within-order.mjs, vendored from vinci-gpu-control's `check_within_order`) and means "this
// work order did not grant it"; this one means "this worker does not support it, whatever was
// granted". The ordering control below turns that distinction into an executed assertion.
//
// ORDERING IS THE WHOLE DIFFICULTY HERE. `spec.tools` is validated LAST, in step 4 of
// materializeEnvelope. Four separate guards answer before it, and a fixture that trips any of
// them tests that guard instead of this one:
//   1. digest.mjs validateExecutionSpec  — unknown fields, malformed/duplicate tool entries
//   2. binding (step 3)                  — workOrderId / workOrderDigest
//   3. containment (step 3.5)            — `tool_not_granted`: the ORDER must grant tool:<name>
//   4. step 4's earlier fields           — repository, modelClass, branches, bounds, output,
//                                          promotion, evidence
// Guard 3 is the sharp one and is NOT optional to clear: to reach this allowlist at all, the
// work order must GRANT the very tool we then refuse. That is the real threat model — a work
// order that grants `tool:web_fetch` must still not get web_fetch out of this worker. Every
// assertion below pins the EXACT reason code, and the ordering control proves which guard
// answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { executionSpecDigest, workOrderDigest } from "../worker/contracts/digest.mjs";
import { materializeEnvelope, SUPPORTED_TOOLS } from "../worker/task.mjs";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "fixtures/contract-vectors");
const workOrder = JSON.parse(readFileSync(join(VECTORS, "work-order-1-minimal", "input.json"), "utf8"));
const baseSpec = JSON.parse(readFileSync(join(VECTORS, "execution-spec-1-minimal", "input.json"), "utf8"));

// The non-tool grants the golden order carries. Every order below keeps these and varies ONLY
// the tool: grants, so containment can never refuse for a reason this suite is not about.
const NON_TOOL_GRANTS = workOrder.grantedAuthority.filter((g) => !g.startsWith("tool:"));

// An order identical to the golden one except that it grants exactly `tools`. Granting the tool
// is what clears containment (guard 3) and lets execution reach the allowlist.
const orderGranting = (tools, overrides = {}) => ({
  ...JSON.parse(JSON.stringify(workOrder)),
  grantedAuthority: [...NON_TOOL_GRANTS, ...tools.map((t) => `tool:${t}`)],
  ...overrides,
});
// A spec bound to `order`. `requiredCapabilities: []` because the golden vector asks for two the
// worker does not advertise, and `capability_unsupported` is the guard immediately AFTER this
// one — leaving the vector's value in place would let it mask a missing refusal here.
const specFor = (order, overrides = {}) => ({
  ...JSON.parse(JSON.stringify(baseSpec)),
  workOrderId: order.id,
  workOrderDigest: workOrderDigest(order),
  requiredCapabilities: [],
  ...overrides,
});
const materialize = (order, spec) =>
  materializeEnvelope(
    { work_order_id: order.id, contract_digest: workOrderDigest(order), execution_spec_digest: executionSpecDigest(spec) },
    { work_order: order, execution_spec: spec },
    { modelClasses: { forte: { provider: "vinci", model: "forte" } }, modelClassesConfigured: true },
  );
// Materializing must throw a HandoffRefusal whose `.code` is EXACTLY `code` and whose message
// contains every string in `names`. Asserting the code (not merely "it threw") is what makes
// these tests reach the mechanism instead of an earlier guard.
function refuses(order, spec, code, names, label) {
  let thrown = null;
  try {
    materialize(order, spec);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${label}: expected a refusal (${code}), got an envelope`);
  assert.equal(thrown.code, code, `${label}: refusal code (message was: ${thrown.message})`);
  for (const name of names) {
    assert.ok(thrown.message.includes(name), `${label}: the reason names ${JSON.stringify(name)}: ${thrown.message}`);
  }
  return thrown;
}

// --- the allowlist IS the run.mjs default, neither more nor less ----------------------------
// This change restricts what a spec may REQUEST down to what run.mjs already grants by default;
// it must not enable anything. Pinned against the literal fallback string in run.mjs:1210 so the
// two cannot drift apart silently in either direction.
{
  const DEFAULT_CSV = "read,grep,find,ls,bash,edit,write";
  assert.deepEqual([...SUPPORTED_TOOLS], DEFAULT_CSV.split(","), "SUPPORTED_TOOLS is exactly run.mjs's default --tools set");
  assert.equal(SUPPORTED_TOOLS.length, 7, "seven tools, nothing more");
  assert.ok(Object.isFrozen(SUPPORTED_TOOLS), "the allowlist is frozen");
  const runSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../worker/run.mjs"), "utf8");
  assert.ok(runSource.includes(`"${DEFAULT_CSV}"`), "run.mjs still carries the default this list mirrors, unchanged");
}

// --- precondition: the fixture materializes when the tool IS advertised ---------------------
// Every refusal below must be caused by the one thing that case changes, not by a fixture that
// never passed in the first place.
{
  const order = orderGranting(["read", "edit", "bash"]);
  const materialized = materialize(order, specFor(order));
  assert.equal(materialized.envelope.branch, "feat/vector-1", "the golden pair still materializes");
  assert.deepEqual(materialized.envelope.tools, ["read", "edit", "bash"], "and carries its tools through");
}

// --- 1. NEGATIVE: an extension tool is refused ----------------------------------------------
// Valid in every other field. The order GRANTS tool:web_fetch, so containment is satisfied and
// the worker's own allowlist is the only thing standing between this spec and an unattended
// agent with network fetch. materializeEnvelope is the pre-clone boundary: worker.mjs binds its
// result at :791 and only then reaches prepareRepository (:1208) and runVinci (:1293), so a
// throw here means nothing was cloned and nothing was spawned.
{
  const order = orderGranting(["web_fetch"]);
  const spec = specFor(order, { tools: ["web_fetch"] });
  const thrown = refuses(order, spec, "tool_unsupported", ['"web_fetch"', "read, grep, find, ls, bash, edit, write"], "web_fetch alone");
  assert.match(thrown.message, /^tool_unsupported: tool "web_fetch" is not supported by this worker \(supported: /);
}

// Every extension tool the launcher registers, not just the one in the headline case.
for (const tool of ["web_search", "web_fetch", "web_answer", "library_docs", "advisor", "convene_council", "orchestrate", "spawn_helper"]) {
  const order = orderGranting([tool]);
  refuses(order, specFor(order, { tools: [tool] }), "tool_unsupported", [JSON.stringify(tool)], `extension tool ${tool}`);
}

// --- 2. ORDERING CONTROL: prove WHICH guard answered ----------------------------------------
// (a) Without the tool: grant, containment (guard 3) answers FIRST and the allowlist is never
// reached. This is the hazard made visible — a fixture written without the grant would have
// gone green on `execution_exceeds_contract` and proved nothing about this change.
{
  const order = orderGranting(["read"]); // deliberately does NOT grant tool:web_fetch
  refuses(order, specFor(order, { tools: ["web_fetch"] }), "execution_exceeds_contract", ["tool_not_granted", "/tools/0"], "ungranted web_fetch");
}
// (b) With the grant, the SAME spec gets a different code. The pair is the discriminator: the
// only thing that changed is the order's grant, and the answering guard moved from containment
// to the allowlist. Nothing but the new check can produce `tool_unsupported`.
{
  const granted = orderGranting(["web_fetch"]);
  const thrown = refuses(granted, specFor(granted, { tools: ["web_fetch"] }), "tool_unsupported", ["web_fetch"], "granted web_fetch");
  for (const earlier of ["unknown_field", "invalid_spec_field", "no_tools", "capability_unsupported", "execution_exceeds_contract", "binding_mismatch"]) {
    assert.notEqual(thrown.code, earlier, `an earlier guard must not be what answered (${earlier})`);
  }
}

// --- 3. POSITIVE REACHABILITY: the guarded operation still works -----------------------------
// Same entry point, same fixture shape. If these fail, the guard is refusing work it must admit
// and the negative cases above prove nothing.
{
  const order = orderGranting(["read", "bash"]);
  const materialized = materialize(order, specFor(order, { tools: ["read", "bash"] }));
  assert.deepEqual(materialized.envelope.tools, ["read", "bash"], "a narrowed subset materializes");
}
{
  // The full default set — the exact seven run.mjs would have used anyway. Behaviour for a spec
  // using the default MUST be unchanged by this commit.
  const order = orderGranting([...SUPPORTED_TOOLS]);
  const materialized = materialize(order, specFor(order, { tools: [...SUPPORTED_TOOLS] }));
  assert.deepEqual(materialized.envelope.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"], "the whole default set materializes");
}
// …and each of the seven on its own, so a typo in the list cannot hide behind its neighbours.
for (const tool of SUPPORTED_TOOLS) {
  const order = orderGranting([tool]);
  const materialized = materialize(order, specFor(order, { tools: [tool] }));
  assert.deepEqual(materialized.envelope.tools, [tool], `${tool} alone is admitted`);
}

// --- 4. MIXED: one disallowed entry poisons the list ----------------------------------------
// The refusal must name the OFFENDING entry, not the first entry, and must not quietly drop it
// and run with the rest.
{
  const order = orderGranting(["read", "web_fetch"]);
  const thrown = refuses(order, specFor(order, { tools: ["read", "web_fetch"] }), "tool_unsupported", ['"web_fetch"'], "read + web_fetch");
  assert.ok(!thrown.message.includes('tool "read"'), `the reason names the offending entry, not the admitted one: ${thrown.message}`);
}
{
  // …and in the other order, so the check is a scan and not a look at tools[tools.length - 1].
  const order = orderGranting(["web_fetch", "read"]);
  refuses(order, specFor(order, { tools: ["web_fetch", "read"] }), "tool_unsupported", ['"web_fetch"'], "web_fetch + read");
}

// --- 5. EDGE INPUTS ---------------------------------------------------------------------------
// Each case records WHICH layer answers. Several are answered by digest.mjs's
// validateExecutionSpec before materializeEnvelope ever selects the spec — that is correct
// fail-closed behaviour, but it means those inputs do NOT exercise the new allowlist, and this
// suite says so rather than letting a green tick imply otherwise.

// [] — unchanged: the empty list keeps its own reason code. The allowlist has nothing to reject
// (the loop body never runs), so `no_tools` must still be what answers.
{
  const order = orderGranting(["read"]);
  refuses(order, specFor(order, { tools: [] }), "no_tools", ["tools is empty"], "empty tools");
}

// Non-array, empty-string entry, numeric entry, null entry — refused by digest.mjs one layer
// earlier, so a spec carrying them can never be selected and never reaches step 4. Asserted at
// that layer, where they actually happen.
for (const [label, tools, pattern] of [
  ["non-array", "read", /\/tools invalid_type/],
  ["empty-string entry", [""], /\/tools\/0 invalid_tool/],
  ["numeric entry", [42], /\/tools\/0 invalid_tool/],
  ["null entry", [null], /\/tools\/0 invalid_tool/],
  ["boolean entry", [true], /\/tools\/0 invalid_tool/],
  ["nested-array entry", [["read"]], /\/tools\/0 invalid_tool/],
  ["whitespace-only entry", ["   "], /\/tools\/0 invalid_tool/],
]) {
  const order = orderGranting(["read"]);
  const spec = { ...specFor(order), tools };
  assert.throws(() => executionSpecDigest(spec), pattern, `${label}: refused by validateExecutionSpec, before the allowlist`);
}
// …and the same malformed spec is refused as `invalid_execution_spec` through the real entry
// point too, so this is not merely a property of the digest helper called in isolation.
{
  const order = orderGranting(["read"]);
  const good = specFor(order);
  const bad = { ...good, tools: [42] };
  let thrown = null;
  try {
    materializeEnvelope(
      { work_order_id: order.id, contract_digest: workOrderDigest(order), execution_spec_digest: executionSpecDigest(good) },
      { work_order: order, execution_spec: bad },
      { modelClasses: { forte: { provider: "vinci", model: "forte" } }, modelClassesConfigured: true },
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a malformed tools entry refuses through materializeEnvelope");
  assert.equal(thrown.code, "invalid_execution_spec", `malformed entries are refused at spec validation: ${thrown.message}`);
}

// DUPLICATES — ["read","read"]. DELIBERATE CHOICE: the allowlist does NOT add a uniqueness rule.
// digest.mjs's validateStringList already refuses a repeated entry as `duplicate_entry` before a
// spec is ever selected, so a uniqueness check in task.mjs could never fire through the handoff
// path — it would be an unreachable guard, and unreachable guards read as coverage while
// protecting nothing. The allowlist is a pure membership test: it answers "may this worker run
// this tool", and asking it twice has the same answer. Pinned at the layer that does decide.
{
  const order = orderGranting(["read"]);
  const spec = { ...specFor(order), tools: ["read", "read"] };
  assert.throws(() => executionSpecDigest(spec), /\/tools\/1 duplicate_entry/, "duplicates are refused one layer earlier, as duplicate_entry");
}
// The membership test itself is duplicate-blind, which is the property the choice above rests
// on: if that upstream rule were ever relaxed, a repeated ADMITTED tool would still be admitted
// and a repeated REFUSED tool would still be refused.
{
  assert.equal(SUPPORTED_TOOLS.includes("read"), true);
  assert.equal(SUPPORTED_TOOLS.includes("web_fetch"), false);
}

// CASE — ["READ"]. DELIBERATE CHOICE: matching is EXACT and case-sensitive, so "READ" is
// refused. Two reasons. (1) The `tool:<name>` grant grammar in within-order.mjs is documented
// case-sensitive, and a lenient allowlist beside a strict grant check would mean the two layers
// disagree about what a tool name is. (2) `--tools` receives the spec's spelling verbatim
// (run.mjs joins the list unchanged); admitting "READ" here would forward a name that the agent
// resolves by its own rules — the allowlist would have approved a string it did not check.
// Refusing is the fail-closed reading, and it can only ever reject work, never enable any.
{
  const order = orderGranting(["READ"]); // granted, so containment is not what answers
  refuses(order, specFor(order, { tools: ["READ"] }), "tool_unsupported", ['"READ"'], "uppercase READ");
}
for (const variant of ["Read", "rEaD", "WRITE", "Bash"]) {
  const order = orderGranting([variant]);
  refuses(order, specFor(order, { tools: [variant] }), "tool_unsupported", [JSON.stringify(variant)], `case variant ${variant}`);
}
// Near-misses that are not case: padding and separators are not normalised away either.
for (const variant of [" read", "read ", "read,bash", "read/../bash"]) {
  const order = orderGranting([variant]);
  refuses(order, specFor(order, { tools: [variant] }), "tool_unsupported", [JSON.stringify(variant)], `near-miss ${variant}`);
}

console.log("PASS worker-tools-allowlist");
