import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti/static";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(root, "vinci/bin/vinci");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const taskOutcome = await loader.import(resolve(root, "vinci/extensions/lib/task-outcome.ts"), { default: false });
const sessionModule = await loader.import(resolve(root, "packages/coding-agent/src/core/session-manager.ts"), {
  default: false,
});

function outcome(taskId, state = "DONE") {
  return {
    schemaVersion: 1,
    taskId,
    state,
    reason: "Direct check passed.",
    changedFiles: ["index.js"],
    verificationStatus: "passed",
    verificationCommand: "node --test",
    activeDurationMs: 12_000,
    usage: {
      modelCalls: 4,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 300,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
      estimatedCostUsd: 0.025,
      providers: ["deepinfra"],
      models: ["zai-org/GLM-5.2"],
    },
    recordedAt: "2026-07-12T12:00:00.000Z",
  };
}

function writeSession(sessionDir, taskId, state) {
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, `${taskId}.jsonl`);
  const entries = [
    { type: "session", version: 3, id: taskId, timestamp: "2026-07-12T11:59:00.000Z", cwd: root },
    {
      type: "message",
      id: "message1",
      parentId: null,
      timestamp: "2026-07-12T11:59:30.000Z",
      message: { role: "assistant", content: [], timestamp: 1 },
    },
    {
      type: "custom",
      customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
      data: outcome(taskId, state),
      id: "outcome1",
      parentId: "message1",
      timestamp: "2026-07-12T12:00:00.000Z",
    },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

function run(home, sessionDir, ...args) {
  return spawnSync("bash", [launcher, "report-wrong", ...args, "--session-dir", sessionDir], {
    cwd: root,
    env: { ...process.env, HOME: home, VINCI_INTERNAL_DEEPINFRA_API_KEY: "" },
    encoding: "utf8",
  });
}

const temp = mkdtempSync(join(tmpdir(), "vinci-report-wrong-"));
try {
  const home = join(temp, "home");
  const sessions = join(temp, "sessions");
  const taskId = "wrong-task";
  const sessionPath = writeSession(sessions, taskId, "DONE");

  const first = run(home, sessions, taskId, "focused test still fails");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Recorded false-completion report/);
  assert.doesNotMatch(first.stdout + first.stderr, /API|provider|model call/i);

  const entries = readFileSync(sessionPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reports = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_FALSE_COMPLETION_ENTRY,
  );
  assert.equal(reports.length, 1);
  assert.equal(taskOutcome.isVinciFalseCompletionReport(reports[0].data), true);
  assert.equal(reports[0].data.taskId, taskId);
  assert.equal(reports[0].data.claimedState, "DONE");
  assert.equal(reports[0].data.note, "focused test still fails");
  assert.deepEqual(reports[0].data.models, ["zai-org/GLM-5.2"]);
  const reopened = sessionModule.SessionManager.open(sessionPath, sessions);
  assert.equal(reopened.getBranch().at(-1).customType, taskOutcome.VINCI_FALSE_COMPLETION_ENTRY);
  assert.equal(reopened.getSessionId(), taskId);

  const duplicate = run(home, sessions, taskId);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.match(duplicate.stdout, /already recorded/);
  assert.equal(
    readFileSync(sessionPath, "utf8").split(`\"customType\":\"${taskOutcome.VINCI_FALSE_COMPLETION_ENTRY}\"`).length - 1,
    1,
  );

  writeSession(sessions, "blocked-task", "BLOCKED");
  const blocked = run(home, sessions, "blocked-task");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /ended BLOCKED; it did not claim completion/);

  const missing = run(home, sessions, "missing-task");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No task found/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("  report-wrong integration: false-completion reports are durable, local, and idempotent\n");
