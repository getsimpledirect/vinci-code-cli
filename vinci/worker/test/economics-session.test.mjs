// Lane B (CCM-v0) fix-round tests: the summary must be driven by what the SESSION recorded —
// per-call usage entries, the vinci-task-outcome receipt, and crew helper entries — not by
// worker-side guesses. Each test pairs a positive with the negative it discriminates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionState } from "../session-read.mjs";
import { buildEconomicsSummary } from "../economics.mjs";

const SESSION_ID = "sess-econ-test";

function usageEntry({ id, responseKey, provider, model, calls = 1, input = 100, output = 10, cost = 0.01 }) {
  return {
    type: "custom",
    customType: "vinci-task-usage",
    data: {
      schemaVersion: 1,
      taskId: SESSION_ID,
      id,
      source: "provider",
      ...(responseKey ? { responseKey } : {}),
      usage: { modelCalls: calls, inputTokens: input, outputTokens: output, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: cost, providers: [provider], models: [model] },
      recordedAt: "2026-09-02T20:00:00.000Z",
    },
  };
}
const receiptEntry = {
  type: "custom",
  customType: "vinci-task-outcome",
  data: { schemaVersion: 1, taskId: SESSION_ID, state: "DONE", changedFiles: ["a.ts"], verificationStatus: "passed", verificationCommand: "npm test", usage: { modelCalls: 3, estimatedCostUsd: 0.03 } },
};
const crewEntry = { type: "custom", customType: "vinci-crew-helper", data: { agentId: "helper-1", task: "x" } };

function withSession(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), "econ-session-"));
  try {
    const header = { type: "session", id: SESSION_ID };
    writeFileSync(join(dir, "session.jsonl"), [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return fn(readSessionState(dir, SESSION_ID));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const base = (state, extra = {}) => ({
  task: { id: "bk_test", envelope: { ref: "bk_test" }, attempt: 1 },
  attemptLabel: "bk_test/1",
  lease: { lease_id: "lease_1", fencing_generation: 2 },
  sessionState: state,
  usageEntries: state.usageEntries,
  receipt: state.outcome ?? null,
  crewRan: state.crewRan === true,
  run: { exit_code: 0, limit_tripped: null, harness_stops: [] },
  taskState: "DONE",
  ...extra,
});

test("session-read: usage entries are mapped and a duplicated responseKey is one call", () => {
  withSession(
    [
      usageEntry({ id: "c1", responseKey: "anthropic\0r1", provider: "anthropic", model: "m-a", input: 100 }),
      usageEntry({ id: "c2", responseKey: "anthropic\0r1", provider: "anthropic", model: "m-a", input: 100 }),
      usageEntry({ id: "c3", provider: "openai", model: "m-b", input: 7 }),
      receiptEntry,
    ],
    (state) => {
      assert.equal(state.usageEntries.length, 3, "every persisted entry is surfaced; dedup happens in the rollup");
      assert.equal(state.source, "outcome");
      const summary = buildEconomicsSummary(base(state));
      const a = summary.usage.find((u) => u.model === "m-a");
      const b = summary.usage.find((u) => u.model === "m-b");
      assert.equal(a.model_calls, 1, "same responseKey twice must count once");
      assert.equal(b.model_calls, 1);
      assert.equal(b.input_tokens, 7);
      assert.equal(a.cost_microusd, 10000);
      assert.equal(summary.cost_reconstruction, "outcome");
    },
  );
});

test("receipt present: verification_state comes from the receipt and killed_before_outcome is absent", () => {
  withSession([usageEntry({ id: "c1", provider: "anthropic", model: "m-a" }), receiptEntry], (state) => {
    const summary = buildEconomicsSummary(base(state));
    assert.equal(summary.local_result.verification_state, "passed");
    assert.ok(!(summary.incomplete ?? []).includes("killed_before_outcome"));
    assert.ok(!(summary.incomplete ?? []).includes("crew_unattributed"), "no crew entry -> no crew flag");
  });
});

test("receipt absent (killed session): killed_before_outcome, null verification_state, non-outcome reconstruction", () => {
  withSession([usageEntry({ id: "c1", provider: "anthropic", model: "m-a" })], (state) => {
    assert.equal(state.outcome, undefined);
    const summary = buildEconomicsSummary(base(state, { taskState: "BLOCKED" }));
    assert.ok(summary.incomplete.includes("killed_before_outcome"));
    assert.equal(summary.local_result.verification_state, null);
    assert.notEqual(summary.cost_reconstruction, "outcome");
    assert.equal(summary.cost_reconstruction, "usage_entries");
  });
});

test("receipt is the discriminator, not the worker-side run outcome", () => {
  const state = { usageEntries: [], outcome: undefined, crewRan: false, source: "message_fallback", path: "/s/x.jsonl" };
  const withRunOutcome = buildEconomicsSummary(base(state, { taskOutcome: { head_sha: "abc" }, receipt: null }));
  assert.ok(withRunOutcome.incomplete.includes("killed_before_outcome"), "a run outcome without a receipt is still killed_before_outcome");
});

test("crew helper entry in the session sets crew_unattributed", () => {
  withSession([usageEntry({ id: "c1", provider: "anthropic", model: "m-a" }), crewEntry, receiptEntry], (state) => {
    assert.equal(state.crewRan, true);
    const summary = buildEconomicsSummary(base(state));
    assert.ok(summary.incomplete.includes("crew_unattributed"));
  });
});

test("crew-result entry alone also sets the flag; unrelated custom entries do not", () => {
  withSession([{ type: "custom", customType: "vinci-crew-result", data: {} }, receiptEntry], (state) => assert.equal(state.crewRan, true));
  withSession([{ type: "custom", customType: "vinci-something-else", data: {} }, receiptEntry], (state) => assert.equal(state.crewRan, false));
});

// ---------------------------------------------------------------------------
// Governed (CONTRACT envelope) path. task.mjs hard-codes `ref: undefined` for a
// contract envelope and carries the real id in contract.work_order_id, so an
// emitter that reads only envelope.ref emits work_order_id: null on exactly the
// field the ledger keys acceptance on — while every prose-envelope test passes.
// Found by projects-11 (bus msg_9438fe86), reproduced here against this tree.
// ---------------------------------------------------------------------------

test("governed handoff: work_order_id comes from the contract, not envelope.ref", () => {
  const governed = buildEconomicsSummary({
    task: { id: "msg_abc", envelope: { ref: undefined }, attempt: 1 },
    workOrderId: "bk_9f2c1d",
    sessionState: { path: "/s/x.jsonl", source: "outcome" },
    receipt: { verificationStatus: "passed" },
    taskState: "COMPLETED",
  });
  assert.equal(governed.work_order_id, "bk_9f2c1d");
  assert.equal(governed.lineage.backlog_row_id, "bk_9f2c1d");
  assert.ok(!governed.incomplete.includes("missing"), JSON.stringify(governed.incomplete));

  // Negative control: neither source present -> still "missing", never a fabricated id.
  const neither = buildEconomicsSummary({
    task: { id: "msg_abc", envelope: { ref: undefined }, attempt: 1 },
    sessionState: { path: "/s/x.jsonl", source: "outcome" },
    receipt: {},
  });
  assert.equal(neither.work_order_id, null);
  assert.ok(neither.incomplete.includes("missing"));

  // Prose path is unchanged.
  const prose = buildEconomicsSummary({
    task: { id: "msg_abc", envelope: { ref: "bk_prose1" }, attempt: 1 },
    sessionState: { path: "/s/x.jsonl", source: "outcome" },
    receipt: {},
  });
  assert.equal(prose.work_order_id, "bk_prose1");
});
