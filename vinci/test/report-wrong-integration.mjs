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

  // Credentials in the note are masked before the report is stored. Built at runtime so no
  // credential-shaped literal sits in the source.
  const syntheticToken = `ghp_${"TESTONLY"}${"r".repeat(32)}`;
  const storedNote = (path) =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_FALSE_COMPLETION_ENTRY)
      .at(-1)?.data.note;

  // Positive control (W2): an ordinary note passes through the masking path unchanged. It runs
  // before W1, so it is GREEN at the base (no masking) and at the head (masking).
  const plainPath = writeSession(sessions, "plain-task", "DONE");
  const plainText =
    "fix didn't hold: see https://example.com/docs/page?x=1 — café ✓, commit 0123456789abcdef0123456789abcdef01234567 (still fails!)";
  const plain = run(home, sessions, "plain-task", plainText);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(storedNote(plainPath), plainText, "H07 W2: an ordinary note is stored unchanged");
  assert.ok(readFileSync(plainPath, "utf8").includes(JSON.stringify(plainText)), "H07 W2: the stored bytes are the note's own JSON");

  const secretPath = writeSession(sessions, "secret-task", "DONE");
  const secret = run(home, sessions, "secret-task", `the run was rejected with ${syntheticToken} again`);
  assert.equal(secret.status, 0, secret.stderr);
  const secretNote = storedNote(secretPath);
  assert.equal(secretNote.includes(syntheticToken), false, "H07 W1: a recognized credential in the note must not be stored");
  assert.equal(secretNote.includes("ghp_"), false, "H07 W1: no part of the credential is stored");
  assert.match(secretNote, /^the run was rejected with <vinci-secret> again$/, "H07 W1: the rest of the note is kept");

  // Masking happens before the 500-character limit: a cut must not leave an unrecognizable fragment.
  const longPath = writeSession(sessions, "long-task", "DONE");
  const filler = "the focused test still fails. ".repeat(16);
  const long = run(home, sessions, "long-task", `${filler}${syntheticToken}`);
  assert.equal(long.status, 0, long.stderr);
  const longNote = storedNote(longPath);
  assert.equal(longNote.includes("ghp_"), false, "H07 W3: a credential at the limit must not survive as a fragment");
  assert.ok(longNote.length <= 500, "H07 W3: the note stays within its limit");
  assert.ok(longNote.startsWith(filler.trim()), "H07 W3: the ordinary text before the credential is kept");

  // Fail closed: when the masker cannot load, the command exits non-zero and writes nothing.
  const closedRoot = join(temp, "masker-missing");
  mkdirSync(join(closedRoot, "vinci/scripts"), { recursive: true });
  const closedScript = join(closedRoot, "vinci/scripts/report-wrong.mjs");
  writeFileSync(closedScript, readFileSync(join(root, "vinci/scripts/report-wrong.mjs")));
  const closedPath = writeSession(sessions, "closed-task", "DONE");
  const closedBefore = readFileSync(closedPath, "utf8");
  const closed = spawnSync(process.execPath, [closedScript, "closed-task", `raw ${syntheticToken}`, "--session-dir", sessions], {
    cwd: temp,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.notEqual(closed.status, 0, "H07 W4: without the masker the command must fail");
  assert.equal(readFileSync(closedPath, "utf8"), closedBefore, "H07 W4: without the masker nothing is written");
  assert.doesNotMatch(closed.stdout, /Recorded/, "H07 W4: without the masker no report is claimed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("  report-wrong integration: false-completion reports are durable, local, and idempotent\n");
