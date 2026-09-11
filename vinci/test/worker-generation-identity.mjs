// S03 generation identity: prove that "what we asked for", "what the resolver chose" and "what the
// provider says actually served the call" survive as THREE separate values all the way to the
// economics summary on disk, and that an unobservable identity is never back-filled from either of
// the other two.
//
// This drives the REAL producer->consumer path for everything downstream of the provider: a real
// session JSONL on disk -> the real `readSessionState` parser -> the real `buildEconomicsSummary`.
// The provider itself is the one thing fixtured, because observing a disagreement requires a
// provider that reports a model different from the one requested.
//
// Filename note: `vinci/test/worker-*.mjs` is glob-discovered by run.sh:283; this name is chosen not
// to collide with `worker-input-artifacts.mjs` (PR #72).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
// Same loader the other extension tests use, so these cases execute the REAL TypeScript module
// rather than a re-implementation of it.
const loader = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-agent-core": resolve(here, "../../packages/agent/src/index.ts") },
  moduleCache: false,
  tryNative: false,
});
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
const { readSessionState } = await import(join(ROOT, "vinci/worker/session-read.mjs"));
const { buildEconomicsSummary } = await import(join(ROOT, "vinci/worker/economics.mjs"));

const SESSION_ID = "sess-gen-identity";

// One persisted `vinci-task-usage` entry, in exactly the shape the accumulator writes:
// `models` is the COLLAPSED field that already existed (observed-or-resolved), while
// `observedModels` carries only what the provider reported and `resolvedModels` only what the
// resolver chose.
function usageEntry({ responseKey, provider, resolved, observed, modelCalls = 1 }) {
  const models = observed ? [observed] : resolved ? [resolved] : [];
  return {
    type: "custom",
    customType: "vinci-task-usage",
    data: {
      responseKey,
      usage: {
        modelCalls,
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: 0.001,
        providers: provider ? [provider] : [],
        models,
        observedModels: observed ? [observed] : [],
        resolvedModels: resolved ? [resolved] : [],
        observedModelCalls: observed ? 1 : 0,
      },
    },
  };
}

function summaryFor(entries, { requestedProvider, requestedModel }) {
  const dir = mkdtempSync(join(tmpdir(), "s03-gen-identity-"));
  try {
    const sessionDir = join(dir, "sessions", "task-1");
    mkdirSync(sessionDir, { recursive: true });
    const lines = [JSON.stringify({ type: "session", id: SESSION_ID }), ...entries.map((e) => JSON.stringify(e))];
    writeFileSync(join(sessionDir, `${SESSION_ID}.jsonl`), lines.join("\n") + "\n");

    const session = readSessionState(sessionDir, SESSION_ID);
    // Reachability: if the parser did not find our entries, every identity assertion below would
    // pass vacuously on an empty rollup. Fail loudly here instead.
    assert.equal(
      session.usageEntries.length,
      entries.length,
      `parser did not reach the usage entries (got ${session.usageEntries.length} of ${entries.length}) -- ` +
        "every assertion after this point would be vacuous",
    );

    return buildEconomicsSummary({
      task: { id: "task-1", envelope: { ref: "task-1" }, attempt: 1 },
      workOrderId: "task-1",
      attemptLabel: "task-1/1",
      sessionState: session,
      sessionId: SESSION_ID,
      usageEntries: session.usageEntries,
      requestedProvider,
      requestedModel,
      started: "2026-09-10T00:00:00Z",
      finished: "2026-09-10T00:01:00Z",
      taskState: "DONE",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

// ---------------------------------------------------------------------------------------------
// CASE 1 -- all three disagree. requested=A, resolved=B, observed=C. All three must survive.
// ---------------------------------------------------------------------------------------------
check("three-way disagreement keeps all three identities distinct", () => {
  const summary = summaryFor(
    [usageEntry({ responseKey: "r1", provider: "openrouter", resolved: "model-B", observed: "model-C" })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  assert.equal(summary.route.initial_model, "model-A", "requested id lost from route.initial_model");
  assert.equal(summary.route.initial_provider, "openrouter");
  assert.equal(gi.resolved_model, "model-B", "resolved id lost");
  assert.equal(gi.observed_model, "model-C", "observed id lost");
  assert.equal(gi.observation, "observed");
  assert.equal(gi.observation_source, "response-stream");
  assert.equal(gi.matches_requested, false, "observed != requested must report a mismatch");
  // The three are pairwise distinct in the artifact, not merely present.
  assert.equal(new Set([summary.route.initial_model, gi.resolved_model, gi.observed_model]).size, 3);
});

// ---------------------------------------------------------------------------------------------
// CASE 2 -- the load-bearing one. observed is UNKNOWN, and a plausible wrong answer (model-B) is
// sitting right there in the same record. Nothing may convert UNKNOWN into it, or into requested.
// ---------------------------------------------------------------------------------------------
check("unobserved identity is never back-filled from resolved or requested", () => {
  const summary = summaryFor(
    [usageEntry({ responseKey: "r1", provider: "openrouter", resolved: "model-B", observed: null })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  // Discriminator: the wrong answers were REACHABLE. resolved is present in the same object, and
  // requested is present in route. A back-filling implementation passes the null check below only
  // by not doing the substitution -- it cannot pass by having nothing to substitute.
  assert.equal(gi.resolved_model, "model-B", "control precondition: resolved must be present and copyable");
  assert.equal(summary.route.initial_model, "model-A", "control precondition: requested must be present and copyable");

  assert.equal(gi.observed_model, null, "UNKNOWN observed identity was back-filled");
  assert.notEqual(gi.observed_model, "model-B", "observed was taken from resolved");
  assert.notEqual(gi.observed_model, "model-A", "observed was taken from requested");
  assert.equal(gi.observation, "unavailable");
  assert.equal(gi.observation_source, null);
  // null, not false: we did not measure a mismatch, we failed to measure at all.
  assert.equal(gi.matches_requested, null, "unknown collapsed into a matched/mismatched boolean");
  assert.equal(gi.observed_model_calls, 0);
  assert.equal(gi.unobserved_model_calls, 1, "a call with no observation must be counted as unobserved");
});

// ---------------------------------------------------------------------------------------------
// CASE 3 -- positive control. Everything agrees and IS observed. Without this, the strictness above
// would be satisfiable by an implementation that reports "unavailable" unconditionally.
// ---------------------------------------------------------------------------------------------
check("agreement that was actually observed reports observed, not unknown", () => {
  const summary = summaryFor(
    [usageEntry({ responseKey: "r1", provider: "openrouter", resolved: "model-A", observed: "model-A" })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  assert.equal(gi.observed_model, "model-A");
  assert.equal(gi.observation, "observed", "an observed agreement must not read as unavailable");
  assert.equal(gi.matches_requested, true);
  assert.equal(gi.observed_model_calls, 1);
  assert.equal(gi.unobserved_model_calls, 0);
});

// ---------------------------------------------------------------------------------------------
// CASE 4 -- "observed" and "unavailable" must be distinguishable for the SAME final model id. This
// is the pair the old boolean collapsed: both runs end up serving model-A as far as any consumer
// reading `usage[].model` can tell.
// ---------------------------------------------------------------------------------------------
check("observed-agreement and could-not-tell are distinguishable at the same model id", () => {
  const observedRun = summaryFor(
    [usageEntry({ responseKey: "r1", provider: "openrouter", resolved: "model-A", observed: "model-A" })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const unknownRun = summaryFor(
    [usageEntry({ responseKey: "r1", provider: "openrouter", resolved: "model-A", observed: null })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  // The collapsed field cannot tell them apart -- this is the defect, asserted so it stays visible.
  assert.deepEqual(
    observedRun.usage.map((u) => u.model),
    unknownRun.usage.map((u) => u.model),
    "precondition: the pre-existing collapsed usage[].model is identical across both runs",
  );
  // The new field can.
  assert.notEqual(
    observedRun.generation_identity.observation,
    unknownRun.generation_identity.observation,
    "the two runs are indistinguishable -- the whole point of the field is lost",
  );
  assert.equal(observedRun.generation_identity.matches_requested, true);
  assert.equal(unknownRun.generation_identity.matches_requested, null);
});

// ---------------------------------------------------------------------------------------------
// CASE 5 -- two calls reporting DIFFERENT served models inside one attempt is a conflict, not a
// silent pick-the-first.
// ---------------------------------------------------------------------------------------------
check("conflicting observations within one attempt report conflict", () => {
  const summary = summaryFor(
    [
      usageEntry({ responseKey: "r1", provider: "openrouter", resolved: "model-A", observed: "model-C" }),
      usageEntry({ responseKey: "r2", provider: "openrouter", resolved: "model-A", observed: "model-D" }),
    ],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  assert.equal(gi.observation, "conflict");
  assert.equal(gi.observed_model, null, "a conflict must not resolve to one of the conflicting values");
  assert.deepEqual(gi.observed_models, ["model-C", "model-D"]);
  assert.equal(gi.matches_requested, false);
});

// ---------------------------------------------------------------------------------------------
// CASE 6 -- the SECOND consumer. `task-outcome.ts` rolls the same messages up independently for the
// receipt, and had its own copy of the `responseModel ?? message.model` collapse. A mutation that
// back-filled observed from resolved HERE survived every case above, so this control exists because
// the mutation battery found the gap, not because the shape looked untested.
// ---------------------------------------------------------------------------------------------
const assistantMessage = ({ model, responseModel, responseId }) => ({
  role: "assistant",
  provider: "openrouter",
  model,
  ...(responseModel ? { responseModel } : {}),
  responseId,
  stopReason: "stop",
  timestamp: 1,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.001 } },
});

check("task-outcome rollup keeps observed and resolved separate", () => {
  const drifted = taskOutcome.summarizeVinciTaskUsage([
    assistantMessage({ model: "model-B", responseModel: "model-C", responseId: "d1" }),
  ]);
  assert.deepEqual(drifted.observedModels, ["model-C"], "observed id lost in the receipt rollup");
  assert.deepEqual(drifted.resolvedModels, ["model-B"], "resolved id lost in the receipt rollup");
  assert.equal(drifted.observedModelCalls, 1);
});

check("task-outcome rollup does not back-fill an unobserved id", () => {
  const silent = taskOutcome.summarizeVinciTaskUsage([
    assistantMessage({ model: "model-B", responseModel: null, responseId: "s1" }),
  ]);
  // Control precondition: the wrong answer is present and copyable in the same rollup.
  assert.deepEqual(silent.resolvedModels, ["model-B"], "precondition: resolved must be present");
  assert.deepEqual(silent.models, ["model-B"], "precondition: the collapsed field still shows model-B");

  assert.deepEqual(silent.observedModels, [], "unobserved id was back-filled in the receipt rollup");
  assert.equal(silent.observedModelCalls, 0, "an unobserved call was counted as observed");
});

check("task-outcome and accumulator agree on a NaN-free count", () => {
  // The adder is called with objects assembled elsewhere; `undefined += n` silently yields NaN.
  const combined = taskOutcome.summarizeVinciTaskUsage(
    [assistantMessage({ model: "model-B", responseModel: "model-C", responseId: "n1" })],
    "task-nan-check",
  );
  assert.equal(Number.isFinite(combined.observedModelCalls), true, "observedModelCalls is not finite (NaN)");
  assert.equal(Number.isFinite(combined.modelCalls), true);
});

// ---------------------------------------------------------------------------------------------
// CASE 7 -- the adder's legacy-object guard. `addVinciAccumulatedUsage` is called with objects
// assembled by other modules; one of them predated these fields, and `undefined += n` yields NaN,
// which then travels as a plausible-looking number rather than failing.
//
// This control exists because a mutation restoring the `+=` form survived every other case: the
// reachable NaN had already been closed by giving VinciTaskUsage the field, leaving the guard
// itself unfalsifiable. Rather than keep an untested guard, exercise the exact shape it defends.
// ---------------------------------------------------------------------------------------------
const usageAccumulator = await loader.import(
  resolve(here, "../extensions/lib/usage-accumulator.ts"),
  { default: false },
);

check("adder tolerates a legacy target with no observed fields", () => {
  // A target shaped the way callers built it before these fields existed.
  const legacyTarget = {
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    providers: [],
    models: [],
  };
  const addition = {
    ...usageAccumulator.emptyVinciAccumulatedUsage(),
    modelCalls: 1,
    observedModels: ["model-C"],
    observedModelCalls: 1,
  };
  const merged = usageAccumulator.addVinciAccumulatedUsage(legacyTarget, addition);
  assert.equal(
    Number.isFinite(merged.observedModelCalls),
    true,
    `observedModelCalls is ${merged.observedModelCalls} -- a legacy target produced a non-finite count`,
  );
  assert.equal(merged.observedModelCalls, 1);
  assert.deepEqual(merged.observedModels, ["model-C"]);
});

// ---------------------------------------------------------------------------------------------
// CASE 8 (F3) -- ONE persisted entry carrying TWO distinct observed ids. Crew/helper rollups go
// through the same recordVinciTaskUsage path and legitimately produce this. Taking [0] reported a
// confident `observed` for what is actually a disagreement, and credited both calls to one id.
// Found by an independent reviewer against unmutated code, not by a mutation.
// ---------------------------------------------------------------------------------------------
check("two observed ids inside ONE entry is a conflict, not a silent pick-first", () => {
  const entry = usageEntry({ responseKey: "agg1", provider: "openrouter", resolved: "model-B", observed: "model-C" });
  // Exactly the aggregate shape: one entry, two sub-calls, two different served ids.
  entry.data.usage.observedModels = ["model-C", "model-D"];
  entry.data.usage.observedModelCalls = 2;
  entry.data.usage.modelCalls = 2;
  const summary = summaryFor([entry], { requestedProvider: "openrouter", requestedModel: "model-A" });
  const gi = summary.generation_identity;
  assert.equal(gi.observation, "conflict", `two served ids in one entry reported as ${gi.observation}`);
  assert.equal(gi.observed_model, null, "a conflict resolved to one of the conflicting values");
  assert.deepEqual(gi.observed_models, ["model-C", "model-D"], "the second observed id was dropped");
});

// ---------------------------------------------------------------------------------------------
// CASE 9 (F2) -- the WIRE BOUNDARY itself. Every case above hand-builds the already-split
// observedModels/resolvedModels fields, so none of them reaches `usageFromResponse`, which is the
// function that actually performs the split. A mutation reverting it to `responseModel || model`
// survived the whole suite. Drive the real function with a real response object instead.
// ---------------------------------------------------------------------------------------------
check("the wire boundary splits observed from resolved (usageFromResponse)", () => {
  const drift = usageAccumulator.vinciUsageFromResponse({
    provider: "openrouter",
    model: "model-B",
    responseModel: "model-C",
    responseId: "w1",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.001 } },
  });
  assert.deepEqual(drift.observedModels, ["model-C"], "wire boundary lost the observed id");
  assert.deepEqual(drift.resolvedModels, ["model-B"], "wire boundary lost the resolved id");
  assert.equal(drift.observedModelCalls, 1);

  const silent = usageAccumulator.vinciUsageFromResponse({
    provider: "openrouter",
    model: "model-B",
    // no responseModel: the provider reported nothing
    responseId: "w2",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.001 } },
  });
  // Control precondition: the wrong answer is present and copyable at this exact boundary.
  assert.deepEqual(silent.resolvedModels, ["model-B"], "precondition: resolved present at the boundary");
  assert.deepEqual(silent.models, ["model-B"], "precondition: the collapsed field still shows model-B");

  assert.deepEqual(silent.observedModels, [], "wire boundary back-filled observed from resolved");
  assert.equal(silent.observedModelCalls, 0, "an unobserved call was counted as observed at the boundary");
});

// ---------------------------------------------------------------------------------------------
// CASE 10 (F3) -- MORE THAN ONE generation in one attempt. An independent review found this branch
// had zero coverage: the whole `ids.length > 1` arm could be deleted and every test stayed green,
// because every fixture drove exactly one responseKey. That arm exists so a multi-generation
// attempt is never summarised by a single id standing for all of them -- the case the lineage was
// built for -- so it is the last place that should be dark.
// ---------------------------------------------------------------------------------------------
check("two generations in one attempt are both carried, never collapsed to one", () => {
  const summary = summaryFor(
    [
      usageEntry({ responseKey: "openrouter resp-1", provider: "openrouter", resolved: "model-B", observed: "model-C" }),
      usageEntry({ responseKey: "openrouter resp-2", provider: "openrouter", resolved: "model-B", observed: "model-C" }),
    ],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  assert.equal(gi.used_generation_ids.length, 2, "a second generation was dropped");
  assert.deepEqual(gi.used_generation_ids, ["openrouter resp-1", "openrouter resp-2"]);
  // 🔴 The load-bearing assertion: with more than one generation, the singular field must be null.
  // A non-null value here is one id silently standing for both.
  assert.equal(gi.used_generation_id, null,
    `used_generation_id is ${JSON.stringify(gi.used_generation_id)} for a 2-generation attempt -- ` +
      "one id is standing in for both");
  assert.equal(gi.observed_generation_ids.length, 2, "an observation lost its generation binding");
  // Both generations agreed on the served model, so this is still a clean observation, not a conflict.
  assert.equal(gi.observation, "observed");
  assert.equal(gi.observed_model, "model-C");
});

// ---------------------------------------------------------------------------------------------
// CASE 11 (F2) -- each arm of the `generationOccurred` disjunction, exercised ALONE.
//
// The gate is `(model_calls > 0) || (used_generation_ids.length > 0)`. A review deleted each arm
// independently and the suite stayed green both times, because every fixture produced the two
// together. These two cases separate them, so a silent break in either arm is visible.
// ---------------------------------------------------------------------------------------------
check("a generation id with no counted calls still counts as a generation", () => {
  // A partial/malformed usage record: the response key survived, the call count did not.
  const summary = summaryFor(
    [usageEntry({ responseKey: "openrouter resp-9", provider: "openrouter", resolved: "model-B", observed: null, modelCalls: 0 })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  assert.equal(gi.model_calls, 0, "precondition: this fixture must have NO counted calls");
  assert.deepEqual(gi.used_generation_ids, ["openrouter resp-9"],
    "precondition: but it DOES carry a generation id -- otherwise this arm is not isolated");
  // A generation happened; the count is simply missing. Identity must still be reportable.
  assert.equal(gi.used_generation_id, "openrouter resp-9");
});

check("counted calls with no generation id still count as a generation", () => {
  // The mirror: the call was counted but carried no response key to name it.
  const summary = summaryFor(
    [usageEntry({ responseKey: undefined, provider: "openrouter", resolved: "model-B", observed: null })],
    { requestedProvider: "openrouter", requestedModel: "model-A" },
  );
  const gi = summary.generation_identity;
  assert.equal(gi.model_calls, 1, "precondition: this fixture must have a counted call");
  assert.deepEqual(gi.used_generation_ids, [],
    "precondition: and NO generation id -- otherwise this arm is not isolated");
  // Spend happened with no id to bind it to: that is unknown identity, not absence of a generation.
  assert.equal(gi.used_generation_id, null);
  assert.equal(gi.observation, "unavailable");
});

console.log(results.join("\n"));
if (process.exitCode === 1) {
  console.error("worker-generation-identity: FAILURES above");
} else {
  console.log(`worker-generation-identity: ${results.length} checks passed`);
}
