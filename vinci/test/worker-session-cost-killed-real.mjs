import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSessionState } from "../worker/session-read.mjs";

const directory = mkdtempSync(join(tmpdir(), "worker-session-cost-killed-"));

function messageEntry(taskId, cost) {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 10000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 75,
        totalTokens: 10275,
        cost: {
          input: 0.0001,
          output: 0.00001,
          cacheRead: 0,
          cacheWrite: 0,
          total: cost,
        },
      },
      model: "deepseek/deepseek-v4-flash-0731",
    },
  });
}

function outcomeEntry(taskId, costUsd) {
  return JSON.stringify({
    type: "custom",
    customType: "vinci-task-outcome",
    data: {
      schemaVersion: 1,
      taskId,
      state: "DONE",
      reason: "done",
      changedFiles: [],
      verificationStatus: "passed",
      activeDurationMs: 1000,
      usage: {
        modelCalls: 3,
        inputTokens: 10,
        outputTokens: 10,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: costUsd,
        providers: ["vinci"],
        models: ["redacted/model"],
      },
      recordedAt: "2026-07-21T04:56:03.000Z",
    },
  });
}

try {
  // Test case (a): Killed session with NO vinci-task-usage entries, NO outcome entry, ONLY message entries
  // This matches the real killed-session structure from the worker box (msg_a62917f5).
  const killedId = "killed-session-real";
  const killedLines = [
    `{"type":"session","id":"${killedId}"}`,
    messageEntry(killedId, 0.001),
    messageEntry(killedId, 0.002),
    messageEntry(killedId, 0.001),
  ];
  const killedDir = join(directory, "killed");
  mkdirSync(killedDir, { recursive: true });
  writeFileSync(join(killedDir, "session.jsonl"), killedLines.join("\n") + "\n");
  const killed = readSessionState(killedDir, killedId);
  assert.equal(
    killed.costUsd,
    0.001 + 0.002 + 0.001,
    "killed-path cost must be the sum of message usage.cost.total when no outcome and no vinci-task-usage exist",
  );
  assert.equal(killed.outcome, undefined, "killed path must have no outcome");

  // Test case (b): Normal-completion path: the final outcome value must win over message usage sum.
  const completedId = "completed-session-with-outcome";
  const completedLines = [
    `{"type":"session","id":"${completedId}"}`,
    messageEntry(completedId, 0.001),
    messageEntry(completedId, 0.002),
    outcomeEntry(completedId, 9.99),
  ];
  const completedDir = join(directory, "completed");
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(join(completedDir, "session.jsonl"), completedLines.join("\n") + "\n");
  const completed = readSessionState(completedDir, completedId);
  assert.equal(
    completed.costUsd,
    9.99,
    "completion-path cost must be the outcome value, not the sum of message usage entries",
  );
  assert.equal(completed.outcome.state, "DONE");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write("✓ worker-session-cost-killed-real-message-fallback\n");
