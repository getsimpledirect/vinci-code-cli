// IR-02 Lane B — embedded runtime adapter: resume across PROCESS REPLACEMENT.
//
// Offline (SDK faux provider only). The run is deliberately split across three processes:
//
//   1. a CHILD opens a persistent run session, runs one `ls`, writes a checkpoint marker once
//      tool.completed is durably in the sink, and hangs inside the turn;
//   2. the parent SIGKILLs that child — no dispose, no flush, no chance to tidy up;
//   3. a FRESH CHILD calls resumeRunSession() on the same sessionDir/sessionPath/sink, runs a
//      second `ls`, finishes the turn and appends run.completed{SUCCEEDED, NONE}.
//
// Asserts:
//   * run.resumed{attemptId} is present and is the first post-kill line;
//   * sequences are 1..N contiguous across the kill — no gap and NO REUSE;
//   * runId is unchanged on every event and attemptId is unchanged wherever a payload carries it;
//   * the sink holds both the pre-kill events and the post-resume events;
//   * the session transcript holds both pre-kill and post-resume entries (two `ls` tool results,
//     both prompts) — i.e. the resumed session continued the SAME file, it did not start a new one.
//
// Controls:
//   * NEGATIVE run identity: resuming with a different runId throws code run_identity_mismatch and
//     the sink line count is unchanged;
//   * UNIVERSALITY of that identity check: a session recording TWO vinci_run entries whose SECOND
//     names a different run is refused. Until this fixture existed, narrowing the check's loop to
//     its first entry passed the whole suite, because no session here had two identities that
//     disagreed. Paired with the positive control that two identities BOTH naming this run — a
//     legitimate second attempt — still resume;
//   * NEGATIVE missing sessionPath: code session_not_found, nothing appended;
//   * NEGATIVE corrupt sessionPath: code session_unreadable, nothing appended;
//   * POSITIVE replay control: a sink object whose in-memory counter is BEHIND the file (the file
//     grew out of band after the object was constructed) still continues at lastSequence+1, which
//     is the assertion `sink.replay()` inside resumeRunSession exists to keep true.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, SessionManager } from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJsonlSink } from "../worker/run-events-sink.mjs";
import { VINCI_RUN_ENTRY, resumeRunSession } from "../worker/runtime-adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "lib", "ir02-resume-child.mjs");

const PROMPT_PRE_KILL = "List the directory. ir02-resume-pre-kill-marker-3a71";
const PROMPT_POST_RESUME = "List it again. ir02-resume-post-resume-marker-9f24";
const LS_TARGET_FILE = "ir02-resume-target-2b5c.txt";

const root = mkdtempSync(join(tmpdir(), "vinci-ir02-resume-"));
const cwd = join(root, "cwd");
const sessionDir = join(root, "sessions");
const sinkPath = join(root, "state", "run-events.jsonl");
const markerPath = join(root, "checkpoint.marker");
const sessionPathFile = join(root, "session-path.txt");
const resultPath = join(root, "resume-result.json");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(cwd, LS_TARGET_FILE), "ir02-resume-target-content\n", "utf8");

const RUN_ID = "run_ir02_resume_0001";
const ATTEMPT_ID = "attempt_ir02_resume_0001";
const SESSION_ID = "ir02-resume-session-0001";
const GRANTED_TOOLS = ["read", "ls"];
const run = {
  runId: RUN_ID,
  workOrderId: "wo_ir02_resume_0001",
  workOrderDigest: "0".repeat(64),
  attemptId: ATTEMPT_ID,
  workspaceId: "ws_ir02_resume_0001",
  contextManifestDigest: null,
};

function readEvents(path = sinkPath) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
function lineCount(path = sinkPath) {
  return readEvents(path).length;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const timer = setTimeout(() => {
  console.error("worker-runtime-adapter-resume: timed out after 110s");
  process.exit(1);
}, 110_000);

let faux;
try {
  // ---- 1. pre-kill child ----------------------------------------------------------------------
  const createChild = spawn(
    process.execPath,
    [
      CHILD,
      JSON.stringify({
        mode: "create",
        cwd,
        sessionDir,
        sinkPath,
        markerPath,
        sessionPathFile,
        sessionId: SESSION_ID,
        prompt: PROMPT_PRE_KILL,
        run,
        grantedTools: GRANTED_TOOLS,
      }),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  let createExit = null;
  createChild.once("exit", (code, signal) => {
    createExit = { code, signal };
  });

  const deadline = Date.now() + 60_000;
  while (!existsSync(markerPath) && Date.now() < deadline) {
    if (createExit) {
      throw new Error(`pre-kill child exited before the checkpoint marker: ${JSON.stringify(createExit)}`);
    }
    await sleep(50);
  }
  check(existsSync(markerPath), "pre-kill child reached the checkpoint (tool.completed on disk)");

  const preKillEvents = readEvents();
  const preKillTypes = preKillEvents.map((event) => event.type);
  assert.deepEqual(
    preKillTypes,
    ["run.started", "agent.turn_started", "tool.started", "tool.completed"],
    `pre-kill event types, got ${JSON.stringify(preKillTypes)}`,
  );
  passed += 1;
  const preKillCount = preKillEvents.length;
  const preKillLastSequence = preKillEvents[preKillCount - 1].sequence;
  assert.equal(preKillLastSequence, preKillCount, "pre-kill sequences are 1..M");
  passed += 1;

  const sessionPath = readFileSync(sessionPathFile, "utf8").trim();
  check(existsSync(sessionPath), `pre-kill child persisted its session file at ${sessionPath}`);
  const preKillTranscript = readFileSync(sessionPath, "utf8");
  check(preKillTranscript.includes(PROMPT_PRE_KILL), "pre-kill transcript holds the pre-kill prompt");

  // (2) process replacement: SIGKILL, no chance to flush or tidy up.
  createChild.kill("SIGKILL");
  const killDeadline = Date.now() + 15_000;
  while (createExit === null && Date.now() < killDeadline) await sleep(50);
  assert.notEqual(createExit, null, "pre-kill child exited after SIGKILL");
  assert.equal(createExit.signal, "SIGKILL", `pre-kill child was killed, got ${JSON.stringify(createExit)}`);
  passed += 2;
  assert.equal(lineCount(), preKillCount, "SIGKILL added nothing to the sink");
  passed += 1;

  // ---- 3. resume in a FRESH process -----------------------------------------------------------
  const resumeChild = spawn(
    process.execPath,
    [
      CHILD,
      JSON.stringify({
        mode: "resume",
        cwd,
        sessionDir,
        sinkPath,
        sessionPath,
        resultPath,
        prompt: PROMPT_POST_RESUME,
        run,
        grantedTools: GRANTED_TOOLS,
      }),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const resumeExit = await new Promise((resolve) => resumeChild.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(resumeExit, { code: 0, signal: null }, `resume child exited cleanly, got ${JSON.stringify(resumeExit)}`);
  passed += 1;

  const resumeResult = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(resumeResult.sessionPath, sessionPath, "the resumed session is the SAME file, not a new one");
  assert.equal(
    resumeResult.resumedFromSequence,
    preKillLastSequence,
    "resumeRunSession replayed the sink to the last sequence the killed process durably wrote",
  );
  assert.equal(
    resumeResult.resumedAtSequence,
    preKillLastSequence + 1,
    "the first post-resume append is lastSequence+1",
  );
  passed += 3;

  // ---- assertions on the joined event log ------------------------------------------------------
  const events = readEvents();
  const types = events.map((event) => event.type);
  assert.deepEqual(
    types,
    [
      "run.started",
      "agent.turn_started",
      "tool.started",
      "tool.completed",
      "run.resumed",
      "agent.turn_started",
      "tool.started",
      "tool.completed",
      "agent.turn_finished",
      "run.completed",
    ],
    `joined event types, got ${JSON.stringify(types)}`,
  );
  passed += 1;

  // run.resumed{attemptId} is present and is exactly the first post-kill line.
  const resumed = events[preKillCount];
  assert.equal(resumed.type, "run.resumed", "run.resumed is the first line after the kill");
  assert.deepEqual(
    resumed.payload,
    { attemptId: { kind: "id", value: ATTEMPT_ID } },
    "run.resumed payload is exactly {attemptId}",
  );
  passed += 2;

  // Sequences continue with no gap and NO REUSE across the kill.
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: events.length }, (_, index) => index + 1),
    `sequences are 1..N contiguous across the process replacement, got ${JSON.stringify(sequences)}`,
  );
  assert.equal(new Set(sequences).size, sequences.length, "no sequence is reused across the kill");
  passed += 2;

  // Identity is unchanged on every event, before and after the kill.
  for (const event of events) {
    assert.equal(event.runId, RUN_ID, `${event.type}#${event.sequence}: runId unchanged`);
    assert.equal(event.workspaceId, run.workspaceId, `${event.type}#${event.sequence}: workspaceId unchanged`);
    if (event.payload && event.payload.attemptId) {
      assert.equal(event.payload.attemptId.value, ATTEMPT_ID, `${event.type}#${event.sequence}: attemptId unchanged`);
    }
  }
  passed += 1;
  assert.equal(new Set(events.map((event) => event.idempotencyKey)).size, events.length, "idempotencyKeys stay unique across the kill");
  passed += 1;
  // The two processes are two attaches: the traceId scoping is what keeps their per-attach identity
  // counters from colliding.
  assert.equal(new Set(events.map((event) => event.traceId)).size, 2, "one traceId per process attach");
  passed += 1;

  // The sink holds BOTH halves: the pre-kill lines are byte-identical and the post-resume lines are new.
  const preKillLines = readFileSync(sinkPath, "utf8").split("\n").filter((line) => line.trim()).slice(0, preKillCount);
  assert.deepEqual(
    preKillLines.map((line) => JSON.parse(line).eventId),
    preKillEvents.map((event) => event.eventId),
    "the pre-kill events survived the resume untouched",
  );
  passed += 1;
  const completed = events[events.length - 1];
  assert.deepEqual(
    completed.payload,
    { outcome: { kind: "enum", value: "SUCCEEDED" }, tierReached: { kind: "enum", value: "NONE" } },
    "the caller path appended run.completed{SUCCEEDED, NONE}",
  );
  passed += 1;

  // The session transcript continued: both prompts and BOTH tool results are in the one file.
  const transcript = readFileSync(sessionPath, "utf8");
  check(transcript.includes(PROMPT_PRE_KILL), "transcript holds the pre-kill prompt");
  check(transcript.includes(PROMPT_POST_RESUME), "transcript holds the post-resume prompt");
  const toolResults = transcript
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message" && entry.message && entry.message.role === "toolResult");
  assert.equal(toolResults.length, 2, `transcript holds both tool results, got ${toolResults.length}`);
  passed += 1;
  check(
    JSON.stringify(toolResults).includes(LS_TARGET_FILE),
    "the tool really ran in the temp cwd on both sides of the kill",
  );

  // ---- NEGATIVE controls ------------------------------------------------------------------------
  faux = registerFauxProvider();
  const fauxModel = faux.getModel();
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(fauxModel.provider, "faux-key");
  const N = events.length;

  async function refuses(label, overrides, expectedCode) {
    const sink = createJsonlSink(sinkPath);
    await assert.rejects(
      () =>
        resumeRunSession({
          run: { ...run, provider: fauxModel.provider, model: fauxModel.id },
          grantedTools: GRANTED_TOOLS,
          cwd,
          sessionDir,
          sessionPath,
          sink,
          authStorage,
          model: fauxModel,
          ...overrides,
        }),
      (error) => {
        assert.equal(error.code, expectedCode, `${label}: code ${expectedCode}, got ${error && error.code}`);
        return true;
      },
      label,
    );
    assert.equal(lineCount(), N, `${label}: nothing appended`);
    passed += 2;
  }

  // A different runId is refused BEFORE anything reaches the sink.
  await refuses(
    "resuming with a different runId",
    { run: { ...run, runId: "run_ir02_resume_WRONG", provider: fauxModel.provider, model: fauxModel.id } },
    "run_identity_mismatch",
  );

  // A missing session file: SessionManager.open() would silently start a NEW session at that path.
  await refuses("resuming a missing sessionPath", { sessionPath: join(root, "no-such-session.jsonl") }, "session_not_found");
  await refuses("resuming with no sessionPath at all", { sessionPath: undefined }, "session_not_found");

  // A corrupt session file.
  const corruptPath = join(root, "corrupt-session.jsonl");
  writeFileSync(corruptPath, "this is not a pi session\n{ still not\n", "utf8");
  await refuses("resuming a corrupt sessionPath", { sessionPath: corruptPath }, "session_unreadable");

  // A well-formed pi session that this adapter never opened (no vinci_run entry) is an identity
  // mismatch, not a silent adoption.
  const foreignPath = join(root, "foreign-session.jsonl");
  copyFileSync(sessionPath, foreignPath);
  writeFileSync(
    foreignPath,
    readFileSync(foreignPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.includes('"vinci_run"'))
      .join("\n") + "\n",
    "utf8",
  );
  await refuses("resuming a session with no recorded run identity", { sessionPath: foreignPath }, "run_identity_mismatch");

  // A session recording TWO run identities, the SECOND of which names a DIFFERENT run. The identity
  // check asserts that EVERY recorded identity names this run, and until this fixture existed that
  // universality was untested: no session in the suite had two vinci_run entries, so narrowing the
  // loop to identities[0] passed everything. The foreign entry is appended through the SDK's own
  // SessionManager — the same writer createRunSession uses — so the fixture is a real session file
  // and not a hand-forged line.
  const twoIdentityDir = join(root, "sessions-two-identities");
  mkdirSync(twoIdentityDir, { recursive: true });
  const twoIdentityPath = join(twoIdentityDir, "two-identities-session.jsonl");
  copyFileSync(sessionPath, twoIdentityPath);
  const foreignWriter = SessionManager.open(twoIdentityPath, twoIdentityDir, cwd);
  foreignWriter.appendCustomEntry(VINCI_RUN_ENTRY, {
    runId: "run_ir02_resume_SOMEONE_ELSE",
    attemptId: "attempt_ir02_resume_SOMEONE_ELSE",
  });
  const twoIdentityEntries = SessionManager.open(twoIdentityPath, twoIdentityDir, cwd)
    .getEntries()
    .filter((entry) => entry && entry.type === "custom" && entry.customType === VINCI_RUN_ENTRY);
  assert.equal(twoIdentityEntries.length, 2, `the fixture records two run identities, got ${twoIdentityEntries.length}`);
  assert.equal(twoIdentityEntries[0].data.runId, RUN_ID, "the FIRST recorded identity is this run (so a first-entry-only check would pass)");
  assert.equal(twoIdentityEntries[1].data.runId, "run_ir02_resume_SOMEONE_ELSE", "the SECOND names a different run");
  passed += 3;
  await refuses(
    "resuming a session whose SECOND recorded identity names a different run",
    { sessionPath: twoIdentityPath, sessionDir: twoIdentityDir },
    "run_identity_mismatch",
  );

  // POSITIVE CONTROL on the same universality, through the same entry point: two recorded
  // identities that BOTH name this run — a legitimate second attempt — must still resume. Without
  // it, a check that refused every multi-identity session would pass the negative above.
  const twoAttemptsDir = join(root, "sessions-two-attempts");
  mkdirSync(twoAttemptsDir, { recursive: true });
  const twoAttemptsPath = join(twoAttemptsDir, "two-attempts-session.jsonl");
  const twoAttemptsSinkPath = join(root, "state", "run-events-two-attempts.jsonl");
  copyFileSync(sessionPath, twoAttemptsPath);
  copyFileSync(sinkPath, twoAttemptsSinkPath);
  const attemptWriter = SessionManager.open(twoAttemptsPath, twoAttemptsDir, cwd);
  attemptWriter.appendCustomEntry(VINCI_RUN_ENTRY, { runId: RUN_ID, attemptId: "attempt_ir02_resume_0003" });
  const twoAttemptsHandle = await resumeRunSession({
    run: { ...run, attemptId: "attempt_ir02_resume_0004", provider: fauxModel.provider, model: fauxModel.id },
    grantedTools: GRANTED_TOOLS,
    cwd,
    sessionDir: twoAttemptsDir,
    sessionPath: twoAttemptsPath,
    sink: createJsonlSink(twoAttemptsSinkPath),
    authStorage,
    model: fauxModel,
  });
  check(
    twoAttemptsHandle.resumedAtSequence === N + 1,
    `a session with TWO identities that both name this run still resumes, at sequence ${twoAttemptsHandle.resumedAtSequence}`,
  );
  await twoAttemptsHandle.dispose();

  // ---- POSITIVE control: sink.replay() is load-bearing -----------------------------------------
  // A sink object constructed while the file was shorter, which then grew out of band. Without the
  // replay inside resumeRunSession its stale counter re-issues sequence numbers already on disk.
  const sinkPathB = join(root, "state", "run-events-desync.jsonl");
  const sessionDirB = join(root, "sessions-b");
  mkdirSync(sessionDirB, { recursive: true });
  const sessionPathB = join(sessionDirB, "desync-session.jsonl");
  copyFileSync(sinkPath, sinkPathB);
  copyFileSync(sessionPath, sessionPathB);

  const staleSink = createJsonlSink(sinkPathB); // in-memory lastSequence === N
  const outOfBand = createJsonlSink(sinkPathB); // a second writer moves the file on
  for (const suffix of ["one", "two"]) {
    outOfBand.append({
      eventId: `out-of-band-${suffix}`,
      runId: RUN_ID,
      organizationId: null,
      workspaceId: run.workspaceId,
      type: "run.paused",
      actor: "worker",
      occurredAt: new Date().toISOString(),
      idempotencyKey: `ir02-out-of-band-${suffix}`,
      traceId: "out-of-band-trace",
      payload: { reasonCode: { kind: "enum", value: "worker_lost" } },
    });
  }
  assert.equal(lineCount(sinkPathB), N + 2, "the file grew out of band under the stale sink object");
  passed += 1;

  const desyncHandle = await resumeRunSession({
    run: { ...run, attemptId: "attempt_ir02_resume_0002", provider: fauxModel.provider, model: fauxModel.id },
    grantedTools: GRANTED_TOOLS,
    cwd,
    sessionDir: sessionDirB,
    sessionPath: sessionPathB,
    sink: staleSink,
    authStorage,
    model: fauxModel,
  });
  assert.equal(desyncHandle.resumedFromSequence, N + 2, "replay() adopted the file's real last sequence");
  assert.equal(desyncHandle.resumedAtSequence, N + 3, "the stale sink continued at lastSequence+1");
  passed += 2;
  const desyncSequences = readEvents(sinkPathB).map((event) => event.sequence);
  assert.deepEqual(
    desyncSequences,
    Array.from({ length: N + 3 }, (_, index) => index + 1),
    `a desynced sink still produces contiguous, never-reused sequences, got ${JSON.stringify(desyncSequences)}`,
  );
  assert.equal(new Set(desyncSequences).size, desyncSequences.length, "a desynced sink reuses no sequence");
  passed += 2;
  await desyncHandle.dispose();

  console.log(
    `worker-runtime-adapter-resume: ${passed} checks passed (N=${N} events across a SIGKILL: ${types.join(" > ")})`,
  );
} finally {
  clearTimeout(timer);
  if (faux) faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
