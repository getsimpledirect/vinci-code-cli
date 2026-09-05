// TOOL ALLOWLIST: an execution spec may name only tools this worker advertises.
//
// `spec.tools` becomes the `--tools` CSV handed to the unattended `vinci -p` agent
// (run.mjs:1210). It was validated for SHAPE ONLY — a list of non-empty strings — so any string
// passed, and the launcher (vinci/bin/vinci) unconditionally registers ~30 extension tools
// (advisor, convene_council, orchestrate, spawn_helper, …) that a spec could therefore have
// named. task.mjs now holds SUPPORTED_TOOLS — exactly the eleven tools run.mjs already falls
// back to — and refuses anything else as `tool_unsupported`, the same fail-closed posture the
// adjacent `requiredCapabilities` field has had against SUPPORTED_CAPABILITIES.
//
// 🔴 THE ALLOWLIST GREW, SO THE NEGATIVE FIXTURES MOVED. The four network tools (`web_search`,
// `web_fetch`, `web_answer`, `library_docs`) were added to BOTH lists together, on the repo
// owner's authorization. Every negative case in this file used to be spelled `web_fetch`; each
// one would now be VACUOUS — asserting a refusal for a tool that is admitted — so they are all
// re-pointed at `orchestrate` and `spawn_helper`, which the launcher registers and which this
// worker still does NOT advertise. The membership probes at the bottom of §5 assert both
// directions (a newly-admitted tool is in, the refused example is out) so that a future
// widening cannot quietly hollow these cases out the same way again.
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
// order that grants `tool:orchestrate` must still not get orchestrate out of this worker. Every
// assertion below pins the EXACT reason code, and the ordering control proves which guard
// answered.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { executionSpecDigest, workOrderDigest } from "../worker/contracts/digest.mjs";
import { runVinci } from "../worker/run.mjs";
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

// --- 0. the allowlist IS the run.mjs default, neither more nor less -------------------------
// This restricts what a spec may REQUEST down to what run.mjs already grants by default; it must
// not enable anything beyond that default. This is the LOCKSTEP pin, and it is what fails if the
// four network tools are added to one list and not the other.
//
// 🔴 HOW THIS PIN USED TO BE VACUOUS. It was carried by a source-TEXT check:
//     assert.ok(runSource.includes(`"${DEFAULT_CSV}"`), …)
// `includes` is satisfied by the literal appearing ANYWHERE in run.mjs — a comment included.
// Executed mutation, 2026-09-04: reverting the LIVE fallback expression at run.mjs:1210 to the
// old seven-tool CSV while leaving the correct eleven-tool literal in a comment above `runVinci`
// left this suite printing PASS. The assertion pinned a string in a file, not the value the
// worker hands to the agent. It is replaced below by a BEHAVIOURAL pin.
//
// Why the value matters at all: run.mjs's fallback is what the deployed fleet actually passes to
// `--tools`, because the prose-envelope form carries no `tools` field (HEADER_KEYS has none), so
// the fallback branch is the one production takes on every prose task.
const DEFAULT_CSV = "read,grep,find,ls,bash,edit,write,web_search,web_fetch,web_answer,library_docs";
{
  assert.deepEqual([...SUPPORTED_TOOLS], DEFAULT_CSV.split(","), "SUPPORTED_TOOLS is exactly run.mjs's default --tools set");
  assert.equal(SUPPORTED_TOOLS.length, 11, "eleven tools, nothing more");
  assert.ok(Object.isFrozen(SUPPORTED_TOOLS), "the allowlist is frozen");
}

// --- 0b. BEHAVIOURAL PIN: what `runVinci` actually puts on the command line -------------------
// `resolveBin("vinci")` (worker/build.mjs:16) is a bare PATH scan performed at spawn time, so a
// stub `vinci` placed first on PATH IS the executable the real `runVinci` launches. The stub
// records its own argv; every assertion below reads that recording. Nothing here inspects source
// text, so a comment cannot satisfy it and only the expression that survives to the spawn can.
//
// This block also gives `runVinci` its first test of any kind: it is imported by zero other tests
// repo-wide, so the `envelope.tools` parameterisation path had no coverage at all.
{
  const RUN_BOUND_MS = 20_000;
  const savedPath = process.env.PATH;
  const root = mkdtempSync(join(tmpdir(), "worker-tools-argv-"));
  try {
    const binDir = join(root, "bin");
    const repoDir = join(root, "repo");
    const stateDir = join(root, "state");
    const argvFile = join(root, "argv.json");
    for (const directory of [binDir, repoDir, stateDir]) mkdirSync(directory, { recursive: true });

    // Shebanged with this interpreter's absolute path, so the stub does not itself depend on what
    // PATH resolves — the only PATH lookup under test is the one `resolveBin` performs for
    // "vinci". No extension ⇒ CommonJS, hence `require`.
    const stub = join(binDir, "vinci");
    writeFileSync(
      stub,
      `#!${process.execPath}\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n` +
        `process.exit(0);\n`,
    );
    chmodSync(stub, 0o755);
    process.env.PATH = binDir + delimiter + savedPath;

    // Bounded: `runVinci` polls on a timer and resolves on the child's `close`. If the stub were
    // never spawned the promise would sit forever, and a hung suite reads as neither pass nor
    // fail — so the wait is capped and the cap is itself an assertion failure.
    const launch = async (envelope, label) => {
      rmSync(argvFile, { force: true });
      const bound = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label}: runVinci did not settle within ${RUN_BOUND_MS}ms`)), RUN_BOUND_MS).unref(),
      );
      const run = await Promise.race([
        runVinci({
          envelope: { provider: "vinci", model: "forte", spec: "stub task", max_runtime_s: 300, budget_usd: 100, ...envelope },
          repoDir,
          stateDir,
          taskId: `argv-${label}`,
          sessionId: `argv-${label}`,
        }),
        bound,
      ]);
      assert.equal(run.exit_code, 0, `${label}: the stub ran and exited cleanly`);
      assert.equal(run.limit_tripped, null, `${label}: no limit tripped, so the argv below is a real launch`);
      const argv = JSON.parse(readFileSync(argvFile, "utf8"));
      const flags = argv.filter((a) => a === "--tools");
      assert.equal(flags.length, 1, `${label}: exactly one --tools flag on the command line: ${JSON.stringify(argv)}`);
      const at = argv.indexOf("--tools");
      assert.ok(at + 1 < argv.length, `${label}: --tools is followed by a value: ${JSON.stringify(argv)}`);
      return { argv, tools: argv[at + 1] };
    };

    // (A) FALLBACK — the production path. No `tools` on the envelope, exactly as a prose handoff
    // arrives, so run.mjs's default branch is the one taken. The expected value is the LITERAL
    // eleven-tool CSV; it is then split and compared to SUPPORTED_TOOLS, which is what makes the
    // two lists lockstep through the value the worker really uses.
    {
      const { tools, argv } = await launch({}, "fallback");
      assert.equal(
        tools,
        "read,grep,find,ls,bash,edit,write,web_search,web_fetch,web_answer,library_docs",
        `an envelope with no tools launches the eleven-tool default: ${JSON.stringify(argv)}`,
      );
      assert.deepEqual(tools.split(","), [...SUPPORTED_TOOLS], "the CSV the worker actually launches with IS the allowlist, element for element");
      assert.equal(tools, DEFAULT_CSV, "…and is the literal this file pins");
    }

    // (B) NARROWING — the parameterised path, previously untested. Its value is DIFFERENT from
    // (A)'s, which is also this instrument's positive control: it proves the recording tracks the
    // envelope rather than echoing a constant, so (A)'s match is evidence and not an artefact.
    {
      const { tools, argv } = await launch({ tools: ["read", "bash"] }, "narrowed");
      assert.equal(tools, "read,bash", `an envelope naming two tools launches exactly those two: ${JSON.stringify(argv)}`);
      assert.notEqual(tools, DEFAULT_CSV, "the narrowed launch is not the default, so the recording is envelope-sensitive");
    }

    // (C) A single tool, and the full set spelled out — a one-element join must not gain a
    // separator, and an envelope that names the whole default must reach the agent unchanged.
    {
      const { tools } = await launch({ tools: ["read"] }, "single");
      assert.equal(tools, "read", "one tool joins to itself, with no trailing separator");
    }
    {
      const { tools } = await launch({ tools: [...SUPPORTED_TOOLS] }, "explicit-full");
      assert.equal(tools, DEFAULT_CSV, "an envelope naming the whole allowlist launches the same CSV as the fallback");
    }

    // (D) EDGE INPUTS on the fallback condition itself. run.mjs takes the default unless `tools`
    // is a NON-EMPTY ARRAY, so each of these must land on the eleven-tool CSV rather than on ""
    // or "undefined" — an agent launched with `--tools ""` would be a silent capability change.
    for (const [label, tools] of [
      ["empty-array", []],
      ["null", null],
      ["undefined", undefined],
      ["string", "read,bash"],
      ["object", { read: true }],
    ]) {
      const launched = await launch({ tools }, `degenerate-${label}`);
      assert.equal(launched.tools, DEFAULT_CSV, `a ${label} tools field falls back to the eleven-tool default, not to an empty or malformed CSV`);
    }
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 0c. SECONDARY SMOKE (not the guarantee) --------------------------------------------------
// Anchored on `const tools =` so a comment cannot satisfy it, unlike the `includes` check this
// replaced. It is kept only to name run.mjs:1210 as the site under test and to fail loudly if
// that expression is restructured; §0b is what actually pins the value, and this check would be
// removable without weakening the guard.
{
  const runSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../worker/run.mjs"), "utf8");
  const live = runSource.match(/^\s*const tools = .*$/m);
  assert.ok(live, "run.mjs still computes the --tools CSV in a `const tools =` expression");
  assert.ok(
    live[0].includes(`"${DEFAULT_CSV}"`),
    `the LIVE fallback expression — not a comment — carries the eleven-tool default: ${live[0]}`,
  );
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
// Valid in every other field. The order GRANTS tool:orchestrate, so containment is satisfied and
// the worker's own allowlist is the only thing standing between this spec and an unattended
// agent that can spawn further agents. materializeEnvelope is the pre-clone boundary: worker.mjs
// binds its result at :791 and only then reaches prepareRepository (:1208) and runVinci (:1293),
// so a throw here means nothing was cloned and nothing was spawned.
//
// `orchestrate` replaced `web_fetch` here when the four network tools were admitted. The
// expected-substring list below spells the FULL eleven-name supported set that the refusal
// message prints, so this case also fails if the message stops reflecting the real list.
{
  const order = orderGranting(["orchestrate"]);
  const spec = specFor(order, { tools: ["orchestrate"] });
  const supportedNames = "read, grep, find, ls, bash, edit, write, web_search, web_fetch, web_answer, library_docs";
  const thrown = refuses(order, spec, "tool_unsupported", ['"orchestrate"', supportedNames], "orchestrate alone");
  assert.match(thrown.message, /^tool_unsupported: tool "orchestrate" is not supported by this worker \(supported: /);
}

// Every extension tool the launcher registers that this worker still does NOT advertise. The
// four network tools that used to head this list were moved to §3's positive cases when they
// were admitted; leaving them here would have asserted a refusal that no longer happens.
for (const tool of ["advisor", "convene_council", "orchestrate", "spawn_helper"]) {
  const order = orderGranting([tool]);
  refuses(order, specFor(order, { tools: [tool] }), "tool_unsupported", [JSON.stringify(tool)], `extension tool ${tool}`);
}
// …and no tool named in that loop may be one the allowlist now admits. Without this, a future
// widening would turn each case above into a green assertion about nothing — exactly the way
// the `web_fetch` fixtures went vacuous.
for (const tool of ["advisor", "convene_council", "orchestrate", "spawn_helper"]) {
  assert.equal(SUPPORTED_TOOLS.includes(tool), false, `${tool} is still outside the allowlist, so the negative case above is not vacuous`);
}

// --- 2. ORDERING CONTROL: prove WHICH guard answered ----------------------------------------
// (a) Without the tool: grant, containment (guard 3) answers FIRST and the allowlist is never
// reached. This is the hazard made visible — a fixture written without the grant would have
// gone green on `execution_exceeds_contract` and proved nothing about this change.
{
  const order = orderGranting(["read"]); // deliberately does NOT grant tool:orchestrate
  refuses(order, specFor(order, { tools: ["orchestrate"] }), "execution_exceeds_contract", ["tool_not_granted", "/tools/0"], "ungranted orchestrate");
}
// (b) With the grant, the SAME spec gets a different code. The pair is the discriminator: the
// only thing that changed is the order's grant, and the answering guard moved from containment
// to the allowlist. Nothing but the new check can produce `tool_unsupported`.
{
  const granted = orderGranting(["orchestrate"]);
  const thrown = refuses(granted, specFor(granted, { tools: ["orchestrate"] }), "tool_unsupported", ["orchestrate"], "granted orchestrate");
  for (const earlier of ["unknown_field", "invalid_spec_field", "no_tools", "capability_unsupported", "execution_exceeds_contract", "binding_mismatch"]) {
    assert.notEqual(thrown.code, earlier, `an earlier guard must not be what answered (${earlier})`);
  }
}
// (c) The same discriminator run on `spawn_helper`, so the pair is not a property of one name.
{
  const ungranted = orderGranting(["read"]);
  refuses(ungranted, specFor(ungranted, { tools: ["spawn_helper"] }), "execution_exceeds_contract", ["tool_not_granted"], "ungranted spawn_helper");
  const granted = orderGranting(["spawn_helper"]);
  refuses(granted, specFor(granted, { tools: ["spawn_helper"] }), "tool_unsupported", ['"spawn_helper"'], "granted spawn_helper");
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
  // The full default set — the exact eleven run.mjs would have used anyway. Behaviour for a spec
  // using the default MUST match run.mjs's fallback exactly. The expected value is a LITERAL,
  // not `[...SUPPORTED_TOOLS]`: comparing the list against itself would pass under any edit.
  const order = orderGranting([...SUPPORTED_TOOLS]);
  const materialized = materialize(order, specFor(order, { tools: [...SUPPORTED_TOOLS] }));
  assert.deepEqual(
    materialized.envelope.tools,
    ["read", "grep", "find", "ls", "bash", "edit", "write", "web_search", "web_fetch", "web_answer", "library_docs"],
    "the whole default set materializes",
  );
}
// …and each of the eleven on its own, so a typo in the list cannot hide behind its neighbours.
for (const tool of SUPPORTED_TOOLS) {
  const order = orderGranting([tool]);
  const materialized = materialize(order, specFor(order, { tools: [tool] }));
  assert.deepEqual(materialized.envelope.tools, [tool], `${tool} alone is admitted`);
}

// --- 3b. POSITIVE REACHABILITY FOR THE FOUR NEWLY-ADMITTED NETWORK TOOLS ---------------------
// The names are LITERALS, deliberately not derived from SUPPORTED_TOOLS: a case that iterates
// the list under test can only ever agree with it, and would stay green if the four were
// removed again. Spelled out, these fail the moment the allowlist stops carrying them — which
// is what makes them the positive control for this change rather than decoration.
const NETWORK_TOOLS = ["web_search", "web_fetch", "web_answer", "library_docs"];
for (const tool of NETWORK_TOOLS) {
  assert.equal(SUPPORTED_TOOLS.includes(tool), true, `${tool} is advertised by this worker`);
  const order = orderGranting([tool]);
  const materialized = materialize(order, specFor(order, { tools: [tool] }));
  assert.deepEqual(materialized.envelope.tools, [tool], `${tool} alone is ADMITTED and carried through to the envelope`);
}
// All four together, and mixed with the original seven's members, through the same entry point.
{
  const order = orderGranting(NETWORK_TOOLS);
  const materialized = materialize(order, specFor(order, { tools: [...NETWORK_TOOLS] }));
  assert.deepEqual(materialized.envelope.tools, ["web_search", "web_fetch", "web_answer", "library_docs"], "all four network tools materialize together");
}
{
  const mixed = ["read", "web_fetch", "bash", "library_docs"];
  const order = orderGranting(mixed);
  const materialized = materialize(order, specFor(order, { tools: [...mixed] }));
  assert.deepEqual(materialized.envelope.tools, ["read", "web_fetch", "bash", "library_docs"], "network tools mix with the original set");
}

// --- 4. MIXED: one disallowed entry poisons the list ----------------------------------------
// The refusal must name the OFFENDING entry, not the first entry, and must not quietly drop it
// and run with the rest.
{
  const order = orderGranting(["read", "orchestrate"]);
  const thrown = refuses(order, specFor(order, { tools: ["read", "orchestrate"] }), "tool_unsupported", ['"orchestrate"'], "read + orchestrate");
  assert.ok(!thrown.message.includes('tool "read"'), `the reason names the offending entry, not the admitted one: ${thrown.message}`);
}
{
  // …and in the other order, so the check is a scan and not a look at tools[tools.length - 1].
  const order = orderGranting(["orchestrate", "read"]);
  refuses(order, specFor(order, { tools: ["orchestrate", "read"] }), "tool_unsupported", ['"orchestrate"'], "orchestrate + read");
}
{
  // …and a NEWLY-ADMITTED tool beside a refused one: the widening must not have turned the scan
  // into "the list contains something allowed, ship it". web_fetch is admitted, orchestrate is
  // not, and the pair must still refuse and still name orchestrate.
  const order = orderGranting(["web_fetch", "orchestrate"]);
  const thrown = refuses(order, specFor(order, { tools: ["web_fetch", "orchestrate"] }), "tool_unsupported", ['"orchestrate"'], "web_fetch + orchestrate");
  assert.ok(!thrown.message.includes('tool "web_fetch"'), `the admitted network tool is not the one named: ${thrown.message}`);
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
  assert.equal(SUPPORTED_TOOLS.includes("web_fetch"), true); // admitted by this change
  assert.equal(SUPPORTED_TOOLS.includes("orchestrate"), false); // and this is the refused example
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
