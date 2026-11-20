import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  // W5: src masker present but throwing, with a loadable built masker.
  const brokenRoot = join(temp, "masker-throwing");
  const brokenScript = join(brokenRoot, "vinci/scripts/report-wrong.mjs");
  const brokenSource = join(brokenRoot, "packages/coding-agent/src/core/vinci-mask-secrets.ts");
  const builtFallback = join(brokenRoot, "packages/coding-agent/dist/core/vinci-mask-secrets.js");
  mkdirSync(dirname(brokenScript), { recursive: true });
  mkdirSync(dirname(brokenSource), { recursive: true });
  mkdirSync(dirname(builtFallback), { recursive: true });
  writeFileSync(brokenScript, readFileSync(join(root, "vinci/scripts/report-wrong.mjs")));
  writeFileSync(join(brokenRoot, "packages/coding-agent/package.json"), '{"type":"module"}\n');
  writeFileSync(brokenSource, 'throw new Error("masker broken");\n');
  writeFileSync(builtFallback, "export function vinciMaskSecrets(text) { return `[dist-stub] ${text}`; }\n");
  const brokenPath = writeSession(sessions, "broken-task", "DONE");
  const brokenBefore = readFileSync(brokenPath);
  const broken = spawnSync(process.execPath, [brokenScript, "broken-task", `raw ${syntheticToken}`, "--session-dir", sessions], {
    cwd: temp,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(broken.status, 1, "W5: a throwing source masker must make the command fail");
  assert.deepEqual(readFileSync(brokenPath), brokenBefore, "W5: a throwing source masker leaves the session unchanged");
  assert.doesNotMatch(broken.stdout, /Recorded/, "W5: a throwing source masker must not claim a report");

  // Node resolves the CLI entry point through symlinks before resolving its imports.
  const fixtureRoot = realpathSync(temp);
  const fixtureOptions = {
    cwd: temp,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  };

  function probeSourceImport(source) {
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `try {
          await import(process.argv[1]);
        } catch ({ code, url, message }) {
          console.log(JSON.stringify({ code, url, message }));
        }`,
        pathToFileURL(source).href,
      ],
      fixtureOptions,
    );
  }

  function assertMissingImport(probe, missingPath, message) {
    assert.equal(probe.status, 0, probe.error?.message || probe.stderr || message);
    assert.ok(probe.stdout, message);
    const error = JSON.parse(probe.stdout);
    assert.equal(error.code, "ERR_MODULE_NOT_FOUND", message);
    if (error.url !== undefined) {
      assert.equal(error.url, pathToFileURL(missingPath).href, message);
    } else {
      assert.equal(/^Cannot find module '([^']+)'/.exec(error.message)?.[1], missingPath, message);
    }
  }

  // W5b: a missing dependency of the source masker must not trigger the built fallback.
  const missingImportRoot = join(fixtureRoot, "masker-missing-import");
  cpSync(brokenRoot, missingImportRoot, { recursive: true });
  const missingImportScript = join(missingImportRoot, "vinci/scripts/report-wrong.mjs");
  const missingImportSource = join(missingImportRoot, "packages/coding-agent/src/core/vinci-mask-secrets.ts");
  writeFileSync(
    missingImportSource,
    'import "./missing-sibling.ts";\nexport function vinciMaskSecrets(text) { return text; }\n',
  );
  assertMissingImport(
    probeSourceImport(missingImportSource),
    join(dirname(missingImportSource), "missing-sibling.ts"),
    "W5b: fixture import must fail with ERR_MODULE_NOT_FOUND for the missing sibling",
  );
  const missingImportPath = writeSession(sessions, "missing-import-task", "DONE");
  const missingImportBefore = readFileSync(missingImportPath);
  const missingImport = spawnSync(
    process.execPath,
    [missingImportScript, "missing-import-task", `raw ${syntheticToken}`, "--session-dir", sessions],
    fixtureOptions,
  );
  assert.equal(missingImport.status, 1, "W5b: a missing dependency of the source masker must make the command exit 1");
  assert.match(missingImport.stderr, /secret masker "vinciMaskSecrets" could not load/, "W5b: the failure must name the masker");
  assert.deepEqual(readFileSync(missingImportPath), missingImportBefore, "W5b: the failed command leaves the session unchanged");
  assert.doesNotMatch(missingImport.stdout, /Recorded/, "W5b: the failed command must not claim a report");

  // W5d: the built masker loads when the source masker is absent.
  const fallbackRoot = join(fixtureRoot, "masker-built-only");
  cpSync(brokenRoot, fallbackRoot, { recursive: true, filter: (source) => source !== brokenSource });
  const fallbackScript = join(fallbackRoot, "vinci/scripts/report-wrong.mjs");
  const fallbackPath = writeSession(sessions, "built-only-task", "DONE");
  const fallbackNote = "focused test still fails";
  const fallback = spawnSync(
    process.execPath,
    [fallbackScript, "built-only-task", fallbackNote, "--session-dir", sessions],
    fixtureOptions,
  );
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /Recorded/, "W5d: the built masker must let the command record a report");
  assert.equal(storedNote(fallbackPath), `[dist-stub] ${fallbackNote}`, "W5d: the built masker must mark the stored note");

  // W5c: deny traversal to an otherwise loadable source masker.
  if (process.platform === "win32" || process.getuid?.() === 0) {
    process.stdout.write("  SKIP W5c: directory permission checks require a non-root POSIX user\n");
  } else {
    const fallbackSource = join(fallbackRoot, "packages/coding-agent/src/core/vinci-mask-secrets.ts");
    cpSync(builtFallback, fallbackSource);
    const sourceDir = dirname(fallbackSource);
    const sourceDirMode = lstatSync(sourceDir).mode & 0o7777;
    let sourceImport;
    let inaccessible;
    try {
      chmodSync(sourceDir, 0o000);
      assert.throws(() => lstatSync(fallbackSource), { code: "EACCES" }, "W5c: the source masker must be inaccessible");
      sourceImport = probeSourceImport(fallbackSource);
      inaccessible = spawnSync(
        process.execPath,
        [fallbackScript, "broken-task", `raw ${syntheticToken}`, "--session-dir", sessions],
        fixtureOptions,
      );
    } finally {
      chmodSync(sourceDir, sourceDirMode);
    }
    assertMissingImport(
      sourceImport,
      fallbackSource,
      "W5c: fixture import must fail with ERR_MODULE_NOT_FOUND for the source masker",
    );
    assert.equal(inaccessible.status, 1, "W5c: an inaccessible source masker must make the command exit 1");
    assert.match(inaccessible.stderr, /secret masker "vinciMaskSecrets" could not load/, "W5c: the failure must name the masker");
    assert.deepEqual(readFileSync(brokenPath), brokenBefore, "W5c: the failed command leaves the session unchanged");
    assert.doesNotMatch(inaccessible.stdout, /Recorded/, "W5c: the failed command must not claim a report");
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("  report-wrong integration: false-completion reports are durable, local, and idempotent\n");
