import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSessionState } from "../worker/session-read.mjs";

const directory = mkdtempSync(join(tmpdir(), "worker-session-cost-killed-"));

function messageEntry(taskId, cost, role = "assistant") {
  return JSON.stringify({
    type: "message",
    message: {
      role,
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

function usageEntry(taskId, id, costUsd) {
  return JSON.stringify({
    type: "custom",
    customType: "vinci-task-usage",
    data: {
      schemaVersion: 1,
      taskId,
      id,
      source: "chat",
      usage: {
        modelCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: costUsd,
        providers: ["vinci"],
        models: ["redacted/model"],
      },
      recordedAt: "2026-07-21T04:56:00.000Z",
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
  // Test case (a): Killed session with ONLY assistant message entries
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
    "killed-path cost must be the sum of ASSISTANT message usage.cost.total",
  );
  assert.equal(killed.outcome, undefined);

  // Test case (b): Non-assistant messages are EXCLUDED (fail-first for role filter)
  const nonAssiId = "non-assistant-messages";
  const nonAssiLines = [
    `{"type":"session","id":"${nonAssiId}"}`,
    messageEntry(nonAssiId, 0.001, "assistant"),
    messageEntry(nonAssiId, 0.002, "user"),  // user role should be SKIPPED
    messageEntry(nonAssiId, 0.003, "tool"),  // tool role should be SKIPPED
  ];
  const nonAssiDir = join(directory, "non-assi");
  mkdirSync(nonAssiDir, { recursive: true });
  writeFileSync(join(nonAssiDir, "session.jsonl"), nonAssiLines.join("\n") + "\n");
  const nonAssi = readSessionState(nonAssiDir, nonAssiId);
  assert.equal(
    nonAssi.costUsd,
    0.001,
    "only ASSISTANT role messages count; user/tool roles ignored",
  );

  // Test case (c): Outcome entry (cost 0) wins over message sums
  const zeroOutcomeId = "zero-outcome";
  const zeroOutcomeLines = [
    `{"type":"session","id":"${zeroOutcomeId}"}`,
    messageEntry(zeroOutcomeId, 0.001),
    messageEntry(zeroOutcomeId, 0.002),
    outcomeEntry(zeroOutcomeId, 0),  // outcome with cost 0 wins
  ];
  const zeroOutcomeDir = join(directory, "zero-outcome");
  mkdirSync(zeroOutcomeDir, { recursive: true });
  writeFileSync(join(zeroOutcomeDir, "session.jsonl"), zeroOutcomeLines.join("\n") + "\n");
  const zeroOutcome = readSessionState(zeroOutcomeDir, zeroOutcomeId);
  assert.equal(
    zeroOutcome.costUsd,
    0,
    "outcome entry (even with cost 0) wins over message sum",
  );
  assert.equal(zeroOutcome.outcome.state, "DONE");

  // Test case (d): vinci-task-usage entries present but zero, with message costs
  const usageZeroId = "usage-zero-message-present";
  const usageZeroLines = [
    `{"type":"session","id":"${usageZeroId}"}`,
    messageEntry(usageZeroId, 0.001),
    messageEntry(usageZeroId, 0.002),
    usageEntry(usageZeroId, "call:1", 0),
    usageEntry(usageZeroId, "call:2", 0),
  ];
  const usageZeroDir = join(directory, "usage-zero");
  mkdirSync(usageZeroDir, { recursive: true });
  writeFileSync(join(usageZeroDir, "session.jsonl"), usageZeroLines.join("\n") + "\n");
  const usageZero = readSessionState(usageZeroDir, usageZeroId);
  assert.equal(
    usageZero.costUsd,
    0,
    "when vinci-task-usage entries exist (even if zero), they win precedence over message costs",
  );

  // Test case (e): Message entries with missing/null usage.cost fields are skipped
  const messageMissingCostId = "message-missing-cost";
  const messageMissingCostEntry = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 1000,
        output: 100,
        // cost field missing entirely
      },
      model: "test/model",
    },
  });
  const messageMissingCostLines = [
    `{"type":"session","id":"${messageMissingCostId}"}`,
    messageMissingCostEntry,
    messageEntry(messageMissingCostId, 0.001),  // this one has cost
  ];
  const messageMissingCostDir = join(directory, "message-missing-cost");
  mkdirSync(messageMissingCostDir, { recursive: true });
  writeFileSync(join(messageMissingCostDir, "session.jsonl"), messageMissingCostLines.join("\n") + "\n");
  const messageMissingCost = readSessionState(messageMissingCostDir, messageMissingCostId);
  assert.equal(
    messageMissingCost.costUsd,
    0.001,
    "messages with missing cost fields are skipped (no NaN or errors)",
  );

  // Test case (f): Normal completion with outcome and message fallback
  const completedId = "completed-with-outcome";
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
    "completion-path cost must be the outcome value, not message sum",
  );
  assert.equal(completed.outcome.state, "DONE");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write("✓ worker-session-cost-killed-real-message-fallback\n");
