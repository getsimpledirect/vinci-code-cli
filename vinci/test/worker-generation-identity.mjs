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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { readSessionState } = await import(join(ROOT, "vinci/worker/session-read.mjs"));
const { buildEconomicsSummary } = await import(join(ROOT, "vinci/worker/economics.mjs"));

const SESSION_ID = "sess-gen-identity";

// One persisted `vinci-task-usage` entry, in exactly the shape the accumulator writes:
// `models` is the COLLAPSED field that already existed (observed-or-resolved), while
// `observedModels` carries only what the provider reported and `resolvedModels` only what the
// resolver chose.
function usageEntry({ responseKey, provider, resolved, observed }) {
  const models = observed ? [observed] : resolved ? [resolved] : [];
  return {
    type: "custom",
    customType: "vinci-task-usage",
    data: {
      responseKey,
      usage: {
        modelCalls: 1,
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

console.log(results.join("\n"));
if (process.exitCode === 1) {
  console.error("worker-generation-identity: FAILURES above");
} else {
  console.log(`worker-generation-identity: ${results.length} checks passed`);
}
