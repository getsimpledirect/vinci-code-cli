// IR-02 Lane B — embedded runtime adapter: run-event translation + sink controls.
//
// Offline. Drives ONE scripted agent turn through the real coding-agent SDK (the same built
// `packages/coding-agent/dist` that `vinci/bin/vinci` launches as dist/cli.js) using the SDK's own
// faux provider (`registerFauxProvider` from @earendil-works/pi-ai/compat — the idiom every
// packages/coding-agent/test/*.test.ts session test uses), so no model/provider call can ever leave
// the process. The scripted model calls `ls` once, then finishes.
//
// Asserts the run-event contract end to end on the durable JSONL sink:
//   * ordered types  [run.started, context.loaded, agent.turn_started, tool.started,
//                     tool.completed, agent.turn_finished]
//   * sequence is 1..N contiguous, assigned by the sink
//   * every payload value is kinded {kind, value} with kind in the six kinds
//   * every string value is <=128 chars or exactly 64 lowercase hex; none carries the prompt text
//     or the tool output (content-free by construction)
//   * that scan REACHES capability.refused, whose capabilityId is the only MODEL-CHOSEN string on
//     the stream. It used to never see one: nothing in this file made the model call an ungranted
//     tool, so an unbounded free-text name passed a scan that had no such event to scan. Three
//     ungranted calls are scripted here — a 419-character name, a 44-character name carrying
//     credential-shaped text (inside the length cap, so ONLY the identifier pattern catches it,
//     and a pattern that accepts anything survives every other assertion), and `bash` — and the
//     event is asserted to carry the name verbatim only in the last case, with capabilityIdForm
//     saying which form was emitted and the digest form pinned to sha256 of the name
//   * run.started payload keys are exactly ["attemptId"] (the registry allowlist refuses more)
//   * context.loaded.entryCount is the contextManifestEntryCount passed in, not a constant
//   * idempotencyKey is per-event IDENTITY, not type+payload: two manual interrupts in one run are
//     two run.paused lines with two keys, while re-appending one of them dedupes to its sequence
//   * sink idempotency: same key+payload -> same sequence, no new line; same key, different
//     payload -> throws code "idempotency_conflict"; reopen + replay() -> lastSequence === N
//   * SINK INTEGRITY, on purpose-built fixture files (a real truncated file, not a mock of one):
//     a TORN FINAL LINE is discarded and the sink continues at the right sequence (with the
//     complete-file positive control beside it); a MALFORMED INTERIOR line refuses with code
//     run_events_corrupt; a GAPPED file (1 then 900) refuses with code run_events_sequence_gap
//     naming 2 as the first missing sequence, where the old reader took the maximum and continued
//     at 901; two sink objects on one path are shown to COLLIDE on one sequence (the single-writer
//     requirement, made visible rather than locked away), and the log they leave is refused by the
//     next open
//   * the DOCUMENTED idempotency exception: tool.completed's durationMs is a wall-clock
//     measurement, so a re-append of the same logical completion conflicts instead of deduping
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJsonlSink } from "../worker/run-events-sink.mjs";
import { createRunSession } from "../worker/runtime-adapter.mjs";

const KINDS = new Set(["id", "enum", "count", "digest", "at", "flag"]);
const HEX64 = /^[0-9a-f]{64}$/;
const EXPECTED_TYPES = [
  "run.started",
  "context.loaded",
  "agent.turn_started",
  "capability.refused",
  "capability.refused",
  "capability.refused",
  "tool.started",
  "tool.completed",
  "agent.turn_finished",
  "run.paused",
  "run.paused",
];
const CONTEXT_MANIFEST_ENTRY_COUNT = 3;

// Three ungranted tool names the model chooses, each a different shape for the capabilityId bound.
// OVERLONG is past the length cap; CREDENTIAL_SHAPED is short enough to clear the length cap
// and is caught only by the identifier pattern; SAFE is what a real ungranted tool name looks like
// and must still be emitted verbatim, so the digest branch cannot be "always digest".
const OVERLONG_TOOL_NAME = `${"X".repeat(400)}-LEAKED-PROMPT-TEXT`;
// 44 characters — comfortably INSIDE CAPABILITY_ID_MAX_LENGTH (64), so the length cap cannot be
// what catches it. Only the identifier pattern can: it carries spaces, "=" and "@".
const CREDENTIAL_SHAPED_TOOL_NAME = "AWS_KEY=AKIAEXFILTRATE0123 alice@example.com";
const SAFE_UNGRANTED_TOOL_NAME = "bash";

// Distinctive markers: the prompt text and the file the `ls` output will name. Neither may appear
// in any payload string.
const PROMPT_MARKER = "vinci-ir02-scripted-prompt-marker-7f3a9c";
const PROMPT = `List the files in this directory. ${PROMPT_MARKER}`;
const LS_TARGET_FILE = "ir02-ls-target-file-b81e2d.txt";
const LS_TARGET_CONTENT = "ir02-ls-target-content-4c0d17\n";

const root = mkdtempSync(join(tmpdir(), "vinci-ir02-events-"));
const cwd = join(root, "cwd");
const sessionDir = join(root, "sessions");
const sinkPath = join(root, "state", "run-events.jsonl");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(cwd, LS_TARGET_FILE), LS_TARGET_CONTENT, "utf8");

const faux = registerFauxProvider();
const model = faux.getModel();
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall(OVERLONG_TOOL_NAME, {}),
      fauxToolCall(CREDENTIAL_SHAPED_TOOL_NAME, {}),
      fauxToolCall(SAFE_UNGRANTED_TOOL_NAME, { command: "true" }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Listed the directory."),
]);
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "faux-key");

const contextManifestDigest = createHash("sha256").update("ir02-manifest", "utf8").digest("hex");
const run = {
  runId: "run_ir02_events_0001",
  workOrderId: "wo_ir02_0001",
  workOrderDigest: createHash("sha256").update("ir02-work-order", "utf8").digest("hex"),
  attemptId: "attempt_ir02_0001",
  workspaceId: "ws_ir02_0001",
  contextManifestDigest,
  contextManifestEntryCount: CONTEXT_MANIFEST_ENTRY_COUNT,
  provider: model.provider,
  model: model.id,
};

function readEvents() {
  return readFileSync(sinkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function lineCount() {
  return readFileSync(sinkPath, "utf8").split("\n").filter((line) => line.trim()).length;
}

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const timer = setTimeout(() => {
  console.error("worker-runtime-adapter-events: timed out after 50s");
  process.exit(1);
}, 50_000);

try {
  const sink = createJsonlSink(sinkPath);
  const handle = await createRunSession({
    run,
    grantedTools: ["read", "ls"],
    cwd,
    sessionDir,
    sink,
    authStorage,
    model,
  });

  await handle.prompt(PROMPT);
  // Two identical logical pauses while idle: defect (a) collapsed these into one line because the
  // key was derived from type+payload.
  await handle.interrupt("manual");
  await handle.interrupt("manual");
  await handle.dispose();

  check(faux.getPendingResponseCount() === 0, "scripted model consumed all three responses");
  check(faux.state.callCount === 3, `faux model called three times (refused turn + tool turn + finish), got ${faux.state.callCount}`);

  const events = readEvents();
  const types = events.map((event) => event.type);
  assert.deepEqual(types, EXPECTED_TYPES, `ordered run-event types, got ${JSON.stringify(types)}`);
  passed += 1;

  // Sequence is 1..N contiguous, assigned by the sink.
  const N = events.length;
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: N }, (_, index) => index + 1),
    "sequence is 1..N contiguous",
  );
  passed += 1;

  // Envelope fields per the contract.
  const eventIds = new Set();
  const idempotencyKeys = new Set();
  for (const event of events) {
    check(typeof event.eventId === "string" && event.eventId.length > 0, `${event.type}: eventId`);
    eventIds.add(event.eventId);
    assert.equal(event.runId, run.runId, `${event.type}: runId`);
    assert.equal(event.organizationId, null, `${event.type}: organizationId is null`);
    assert.equal(event.workspaceId, run.workspaceId, `${event.type}: workspaceId`);
    assert.equal(event.actor, "worker", `${event.type}: actor`);
    check(
      typeof event.occurredAt === "string" && !Number.isNaN(Date.parse(event.occurredAt)),
      `${event.type}: occurredAt is an ISO timestamp`,
    );
    check(typeof event.idempotencyKey === "string" && event.idempotencyKey.length > 0, `${event.type}: idempotencyKey`);
    idempotencyKeys.add(event.idempotencyKey);
    check(typeof event.traceId === "string" && event.traceId.length > 0, `${event.type}: traceId`);
    check(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload), `${event.type}: payload object`);
  }
  assert.equal(eventIds.size, N, "eventIds are unique");
  assert.equal(idempotencyKeys.size, N, "idempotencyKeys are unique across the turn");
  assert.equal(new Set(events.map((event) => event.traceId)).size, 1, "one traceId for the whole run session");
  passed += 3;

  // Every payload value is kinded and content-free. The scan is only worth its green if it
  // actually reaches the model-chosen strings, so assert first that a capability.refused is in
  // the set it is about to walk — the scan passed for a year without ever seeing one.
  const lsOutputMarkers = [
    PROMPT_MARKER,
    PROMPT,
    LS_TARGET_FILE,
    LS_TARGET_CONTENT.trim(),
    OVERLONG_TOOL_NAME,
    CREDENTIAL_SHAPED_TOOL_NAME,
    "AKIAEXFILTRATE0123",
    "alice@example.com",
  ];
  const scannedTypes = new Set(events.map((event) => event.type));
  check(scannedTypes.has("capability.refused"), "the kind/length scan below covers a capability.refused event");
  for (const event of events) {
    for (const [field, value] of Object.entries(event.payload)) {
      const where = `${event.type}.${field}`;
      check(value && typeof value === "object" && !Array.isArray(value), `${where}: value is an object`);
      check(KINDS.has(value.kind), `${where}: kind ${JSON.stringify(value.kind)} is one of the six kinds`);
      check(Object.keys(value).length === 2 && "value" in value, `${where}: exactly {kind, value}`);
      const inner = value.value;
      if (typeof inner === "string") {
        check(inner.length <= 128 || HEX64.test(inner), `${where}: string is <=128 chars or 64-hex`);
        for (const marker of lsOutputMarkers) {
          check(!inner.includes(marker), `${where}: does not carry prompt text or ls output (${marker})`);
        }
      } else {
        check(typeof inner === "number" || typeof inner === "boolean", `${where}: non-string value is number/boolean`);
      }
      if (value.kind === "digest") check(HEX64.test(inner), `${where}: digest is 64 lowercase hex`);
      if (value.kind === "count") check(Number.isInteger(inner) && inner >= 0, `${where}: count is a non-negative integer`);
      if (value.kind === "flag") check(typeof inner === "boolean", `${where}: flag is boolean`);
    }
  }
  const serialized = JSON.stringify(events);
  for (const marker of lsOutputMarkers) {
    check(!serialized.includes(marker), `whole sink file is free of marker ${JSON.stringify(marker)}`);
  }

  // Per-type payload shape.
  const [started, loaded, turnStarted, refusedOverlong, refusedCredential, refusedSafe, toolStarted, toolCompleted, turnFinished, pausedA, pausedB] = events;

  // ---- capability.refused: a MODEL-CHOSEN name, bounded before it reaches the sink -------------
  // Digest form for the overlong name and for the credential-shaped one; verbatim for the safe
  // one. The digest is pinned to sha256 of the exact name, so "emit a digest" cannot degrade to
  // "emit any 64 hex characters".
  const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  assert.deepEqual(
    refusedOverlong.payload,
    {
      capabilityId: { kind: "digest", value: sha256(OVERLONG_TOOL_NAME) },
      capabilityIdForm: { kind: "enum", value: "digest" },
      reason: { kind: "enum", value: "not_attested" },
    },
    "a 419-character tool name is emitted as sha256 of the name, form=digest",
  );
  assert.deepEqual(
    refusedCredential.payload,
    {
      capabilityId: { kind: "digest", value: sha256(CREDENTIAL_SHAPED_TOOL_NAME) },
      capabilityIdForm: { kind: "enum", value: "digest" },
      reason: { kind: "enum", value: "not_attested" },
    },
    "a credential-shaped tool name SHORT ENOUGH to clear a length cap is still emitted as a digest",
  );
  assert.deepEqual(
    refusedSafe.payload,
    {
      capabilityId: { kind: "id", value: SAFE_UNGRANTED_TOOL_NAME },
      capabilityIdForm: { kind: "enum", value: "name" },
      reason: { kind: "enum", value: "not_attested" },
    },
    "a conservative identifier within the cap is still emitted VERBATIM, form=name",
  );
  passed += 3;
  check(
    refusedOverlong.payload.capabilityId.value !== refusedCredential.payload.capabilityId.value,
    "the two digests differ: the digest is of the name, not a constant",
  );
  // Not one of these three calls executed: no tool.started, tool.completed or tool.failed names
  // any of them, and none of them is `ls`.
  for (const name of [OVERLONG_TOOL_NAME, CREDENTIAL_SHAPED_TOOL_NAME, SAFE_UNGRANTED_TOOL_NAME]) {
    check(
      !events.some(
        (event) =>
          (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed")
          && event.payload.toolId
          && event.payload.toolId.value === name,
      ),
      `no tool.* event for the refused ${JSON.stringify(name.slice(0, 24))}`,
    );
  }
  // Positive reachability control through the SAME translator: the granted ls ran afterwards.
  check(toolStarted.sequence > refusedSafe.sequence, "the granted ls executed after all three refusals");
  assert.equal(started.payload.attemptId.value, run.attemptId, "run.started carries attemptId");
  assert.equal(started.payload.attemptId.kind, "id");
  // Defect (b): run.started carried an extra kinded runId; the registry allowlist is exactly {attemptId}.
  assert.deepEqual(Object.keys(started.payload), ["attemptId"], "run.started payload keys are exactly [attemptId]");
  assert.equal(
    loaded.payload.entryCount.value,
    CONTEXT_MANIFEST_ENTRY_COUNT,
    "context.loaded.entryCount reflects the manifest entry count passed in",
  );
  // Defect (a): two distinct pauses with identical payloads are two lines under two keys.
  assert.equal(pausedA.type, "run.paused");
  assert.equal(pausedB.type, "run.paused");
  assert.deepEqual(pausedA.payload, { reasonCode: { kind: "enum", value: "manual" } }, "run.paused payload");
  assert.deepEqual(pausedB.payload, pausedA.payload, "both pauses carry the identical payload");
  assert.notEqual(pausedA.idempotencyKey, pausedB.idempotencyKey, "two distinct pauses have two idempotencyKeys");
  assert.equal(pausedB.sequence, pausedA.sequence + 1, "second pause is its own line");
  passed += 4;
  assert.equal(loaded.payload.contextManifestDigest.value, contextManifestDigest, "context.loaded carries the digest passed");
  assert.equal(loaded.payload.contextManifestDigest.kind, "digest");
  assert.equal(loaded.payload.entryCount.kind, "count");
  assert.equal(turnStarted.payload.turnId.kind, "id");
  assert.equal(toolStarted.payload.toolId.value, "ls", "tool.started.toolId is ls");
  assert.equal(toolStarted.payload.toolCallId.kind, "id");
  assert.equal(toolCompleted.payload.toolId.value, "ls", "tool.completed.toolId is ls");
  assert.equal(toolCompleted.payload.toolCallId.value, toolStarted.payload.toolCallId.value, "same toolCallId start/end");
  assert.equal(toolCompleted.payload.durationMs.kind, "count");
  assert.match(toolCompleted.payload.outputDigest.value, HEX64, "outputDigest is 64-hex");
  assert.equal(turnFinished.payload.turnId.value, turnStarted.payload.turnId.value, "turn ids match");
  assert.equal(turnFinished.payload.modelId.kind, "id");
  assert.equal(turnFinished.payload.modelId.value, model.id, "modelId is the session model");
  for (const field of ["inputTokens", "outputTokens", "costMicrousd"]) {
    if (field in turnFinished.payload) {
      assert.equal(turnFinished.payload[field].kind, "count", `agent.turn_finished.${field} is a count`);
    }
  }
  check(
    !("costMicrousd" in turnFinished.payload) || turnFinished.payload.costMicrousd.value > 0,
    "costMicrousd is omitted when unavailable, never 0",
  );
  check(!("outputDigest" in toolStarted.payload), "tool.started has no output digest");
  passed += 1;

  // The tool really executed in the temp cwd: the ls result reached the session transcript, but
  // only its digest reached the sink (positive control for the content-free assertions above).
  const toolResults = handle.session.messages.filter((message) => message.role === "toolResult");
  assert.equal(toolResults.length, 4, "four tool results in the transcript: three refused calls plus ls");
  const succeeded = toolResults.filter((message) => message.isError !== true);
  assert.equal(succeeded.length, 1, "exactly ONE tool call succeeded — the granted ls");
  passed += 1;
  const toolResultText = JSON.stringify(succeeded[0].content);
  check(toolResultText.includes(LS_TARGET_FILE), "ls actually listed the temp cwd");
  check(succeeded[0].toolName === "ls", "the one successful tool result is ls");
  // The three ungranted calls were answered by the SDK's registry, which has no such tool.
  const refusedResults = toolResults.filter((message) => message.isError === true);
  assert.equal(refusedResults.length, 3, "the three ungranted calls all came back as errors");
  passed += 1;
  for (const message of refusedResults) {
    check(JSON.stringify(message.content).includes("not found"), "an ungranted call is answered 'Tool … not found'");
  }

  // ---- Sink idempotency controls -------------------------------------------------------------
  const linesBefore = lineCount();
  assert.equal(linesBefore, N, "sink holds exactly N lines before controls");
  const last = events[N - 1];
  const { sequence: _ignored, ...lastWithoutSequence } = last;

  // A true re-append of the FIRST pause (same identity key + same payload) dedupes to its own
  // sequence, so identity keys do not lose the sink's replay guarantee.
  const { sequence: pausedASequence, ...pausedAWithoutSequence } = pausedA;
  assert.equal(
    sink.append({ ...pausedAWithoutSequence, eventId: "replay-pause-a" }),
    pausedASequence,
    "re-appending the first run.paused returns its existing sequence",
  );
  assert.equal(lineCount(), N, "re-appending the first run.paused writes no new line");
  passed += 2;

  // Re-append the same key + same payload: same sequence, file untouched.
  const again = sink.append({ ...lastWithoutSequence, eventId: "replay-attempt-eventid" });
  assert.equal(again, N, "re-append of an existing key+payload returns the existing sequence");
  assert.equal(lineCount(), N, "re-append writes no new line");
  assert.equal(sink.replay().lastSequence, N, "replay() after a duplicate append still reports N");
  passed += 3;

  // Same key, conflicting payload: throws idempotency_conflict, nothing appended.
  assert.throws(
    () =>
      sink.append({
        ...lastWithoutSequence,
        payload: { ...last.payload, turnId: { kind: "id", value: "not-the-same-turn" } },
      }),
    (error) => error && error.code === "idempotency_conflict",
    "conflicting payload under an existing idempotencyKey throws code idempotency_conflict",
  );
  assert.equal(lineCount(), N, "conflict appends nothing");
  passed += 2;

  // A fresh open of the same file (process replacement) rebuilds the state from disk.
  sink.close();
  const reopened = createJsonlSink(sinkPath);
  const replayed = reopened.replay();
  assert.equal(replayed.lastSequence, N, "reopened sink replay().lastSequence === N");
  assert.equal(replayed.keys.length, N, "reopened sink knows every idempotencyKey");
  assert.equal(
    reopened.append({ ...lastWithoutSequence, eventId: "replay-attempt-eventid-2" }),
    N,
    "reopened sink dedupes an existing key from disk",
  );
  assert.equal(lineCount(), N, "reopened dedupe writes no new line");
  const next = reopened.append({
    ...lastWithoutSequence,
    eventId: "fresh-event",
    idempotencyKey: "fresh-key-after-reopen",
    type: "run.completed",
    payload: { outcome: { kind: "enum", value: "SUCCEEDED" }, tierReached: { kind: "enum", value: "NONE" } },
  });
  assert.equal(next, N + 1, "reopened sink continues at N+1 with no gap and no reuse");
  assert.equal(lineCount(), N + 1, "the continuation is durable");
  passed += 4;

  // ---- SINK INTEGRITY: a torn tail, a corrupt interior, a gap, and two writers -----------------
  // Four properties of loadFromDisk, each on its OWN fixture file so nothing here perturbs the run
  // above. The fixtures are written as bytes, so the truncated file is a real truncated file and
  // not a mock of one.
  const integrityDir = join(root, "integrity");
  mkdirSync(integrityDir, { recursive: true });
  function integrityLine(sequence, key) {
    return JSON.stringify({
      eventId: `integrity-event-${sequence}`,
      runId: "run_ir02_integrity",
      organizationId: null,
      workspaceId: "ws_ir02_integrity",
      type: "run.paused",
      actor: "worker",
      occurredAt: "2026-09-03T00:00:00.000Z",
      idempotencyKey: key ?? `integrity-key-${sequence}`,
      traceId: "integrity-trace",
      sequence,
      payload: { reasonCode: { kind: "enum", value: "manual" } },
    });
  }
  const COMPLETE_FILE = `${[integrityLine(1), integrityLine(2), integrityLine(3)].join("\n")}\n`;
  function freshEvent(key) {
    return {
      eventId: `integrity-fresh-${key}`,
      runId: "run_ir02_integrity",
      organizationId: null,
      workspaceId: "ws_ir02_integrity",
      type: "run.completed",
      actor: "worker",
      occurredAt: "2026-09-03T00:00:01.000Z",
      idempotencyKey: key,
      traceId: "integrity-trace",
      payload: { outcome: { kind: "enum", value: "SUCCEEDED" }, tierReached: { kind: "enum", value: "NONE" } },
    };
  }

  // (i) POSITIVE CONTROL — a COMPLETE file opens, reports its real last sequence, and continues at
  // lastSequence+1. Without this the torn-file assertion below could be satisfied by a sink that
  // simply ignores the file it was pointed at.
  const wholePath = join(integrityDir, "whole.jsonl");
  writeFileSync(wholePath, COMPLETE_FILE, "utf8");
  const wholeSink = createJsonlSink(wholePath);
  assert.equal(wholeSink.replay().lastSequence, 3, "a complete file opens at its real last sequence");
  assert.equal(wholeSink.append(freshEvent("integrity-whole-next")), 4, "a complete file continues at lastSequence+1");
  passed += 2;

  // (ii) A REAL TRUNCATED FILE — the shape a process killed mid-append leaves: every complete line,
  // then a PREFIX of one more record with no terminating newline. Before the fix, JSON.parse threw
  // out of createJsonlSink and the whole task died on a file that was merely incomplete.
  const tornPath = join(integrityDir, "torn.jsonl");
  const tornBytes = `${COMPLETE_FILE}${integrityLine(4).slice(0, 37)}`;
  writeFileSync(tornPath, tornBytes, "utf8");
  check(!tornBytes.endsWith("\n"), "the fixture's final line really is unterminated");
  check(readFileSync(tornPath, "utf8") === tornBytes, "the truncated fixture is on disk byte-for-byte");
  const tornSink = createJsonlSink(tornPath);
  assert.equal(tornSink.replay().lastSequence, 3, "a torn final line is DISCARDED: the last durable record is 3");
  assert.equal(tornSink.append(freshEvent("integrity-torn-next")), 4, "a torn file continues at the right sequence");
  passed += 2;
  const tornAfter = readFileSync(tornPath, "utf8").split("\n").filter((line) => line.trim());
  assert.equal(tornAfter.length, 4, `the repaired file holds 3 durable records plus the new one, got ${tornAfter.length}`);
  assert.deepEqual(
    tornAfter.map((line) => JSON.parse(line).sequence),
    [1, 2, 3, 4],
    "the repaired file is still 1..N contiguous, so it reopens cleanly",
  );
  assert.equal(createJsonlSink(tornPath).replay().lastSequence, 4, "the repaired file reopens without a second repair");
  passed += 3;

  // (ii-b) THE OTHER TORN SHAPE: the record itself landed whole and only its "\n" did not. Here the
  // record IS durable, so it must be KEPT (discarding it would let the next append reuse sequence 4
  // while the bytes stayed in the file — a duplicate that fails contiguity for good). The sink
  // completes the terminator instead, and the next append lands at 5.
  const unterminatedPath = join(integrityDir, "unterminated.jsonl");
  writeFileSync(unterminatedPath, `${COMPLETE_FILE}${integrityLine(4)}`, "utf8");
  check(!readFileSync(unterminatedPath, "utf8").endsWith("\n"), "the fixture's whole final record is unterminated");
  const unterminatedSink = createJsonlSink(unterminatedPath);
  assert.equal(unterminatedSink.replay().lastSequence, 4, "a complete-but-unterminated final record is KEPT");
  assert.equal(unterminatedSink.append(freshEvent("integrity-unterminated-next")), 5, "and the next append lands at 5");
  assert.deepEqual(
    readFileSync(unterminatedPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line).sequence),
    [1, 2, 3, 4, 5],
    "the terminator repair leaves a contiguous, reopenable file",
  );
  passed += 3;

  // (iii) A MALFORMED LINE THAT IS NOT THE LAST ONE is an integrity error, not a torn write:
  // records follow it, so something dropped or interleaved lines and continuing would hide it.
  const corruptPath = join(integrityDir, "corrupt-interior.jsonl");
  writeFileSync(corruptPath, `${integrityLine(1)}\n{ this is not json\n${integrityLine(3)}\n`, "utf8");
  assert.throws(
    () => createJsonlSink(corruptPath),
    (error) => error && error.code === "run_events_corrupt" && /line 2 of/.test(error.message),
    "a malformed line with records after it REFUSES with code run_events_corrupt, naming the line",
  );
  passed += 1;

  // (iv) A GAP is refused, naming the first missing sequence. The old reader took the MAXIMUM, so a
  // file holding 1 and 900 replayed as a run that had reached 900 and continued at 901.
  const gapPath = join(integrityDir, "gap.jsonl");
  writeFileSync(gapPath, `${integrityLine(1)}\n${integrityLine(900)}\n`, "utf8");
  assert.throws(
    () => createJsonlSink(gapPath),
    (error) =>
      error && error.code === "run_events_sequence_gap" && /first missing sequence is 2/.test(error.message),
    "a file holding 1 and 900 REFUSES with code run_events_sequence_gap, naming 2 as the first missing sequence",
  );
  passed += 1;
  // POSITIVE CONTROL on the same predicate: 1..3 with no gap is accepted by the very same reader.
  assert.equal(createJsonlSink(wholePath).replay().lastSequence, 4, "the contiguity rule accepts a contiguous file");
  passed += 1;

  // (v) SINGLE WRITER, DEMONSTRATED. The counter is per-object memory with no lock, so two sink
  // objects on one path assign the SAME sequence to two DIFFERENT events. Nothing here fixes that —
  // the design is single-writer and a lock would be a weaker claim than the requirement — so the
  // constraint is made VISIBLE instead of implied, and the corrupt log it produces is refused by
  // the next open rather than silently continued.
  const collisionPath = join(integrityDir, "collision.jsonl");
  const writerA = createJsonlSink(collisionPath);
  const writerB = createJsonlSink(collisionPath);
  const sequenceA = writerA.append(freshEvent("integrity-collide-a"));
  const sequenceB = writerB.append(freshEvent("integrity-collide-b"));
  assert.equal(sequenceA, 1, "the first writer assigns sequence 1");
  assert.equal(
    sequenceB,
    sequenceA,
    "TWO SINK OBJECTS ON ONE PATH COLLIDE: the second writer assigns the same sequence as the first",
  );
  passed += 2;
  const collided = readFileSync(collisionPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert.deepEqual(collided.map((event) => event.sequence), [1, 1], "the collided log really holds two lines at sequence 1");
  assert.equal(new Set(collided.map((event) => event.eventId)).size, 2, "they are two DIFFERENT events, not a dedupe");
  passed += 2;
  assert.throws(
    () => createJsonlSink(collisionPath),
    (error) => error && error.code === "run_events_sequence_gap",
    "the log two writers left behind is REFUSED by the next open (the single-writer rule is self-reporting)",
  );
  passed += 1;

  // (vi) THE DOCUMENTED IDEMPOTENCY EXCEPTION, pinned on the REAL tool.completed this run produced.
  // The sink's contract ("same key + same payload dedupes") holds only for events whose payload is
  // a function of their identity. tool.completed carries durationMs, a WALL-CLOCK measurement, so a
  // genuine re-append of the same logical completion conflicts. The field stays; the exception is
  // named in both module headers and pinned here so it cannot be quietly "fixed" by dropping the
  // measurement.
  const realToolCompleted = events.find((event) => event.type === "tool.completed");
  check(realToolCompleted !== undefined, "the run produced a real tool.completed to pin the exception on");
  check(
    realToolCompleted.payload.durationMs !== undefined && realToolCompleted.payload.durationMs.kind === "count",
    "tool.completed still carries durationMs (the wall-clock field the exception is about)",
  );
  const exceptionPath = join(integrityDir, "idempotency-exception.jsonl");
  const exceptionSink = createJsonlSink(exceptionPath);
  const replayedCompletion = { ...realToolCompleted };
  delete replayedCompletion.sequence;
  const firstCompletion = exceptionSink.append(replayedCompletion);
  assert.equal(firstCompletion, 1, "the real tool.completed appends at sequence 1");
  assert.equal(
    exceptionSink.append({ ...replayedCompletion, eventId: "second-attempt" }),
    firstCompletion,
    "IDENTITY-FUNCTION HALF: the same key with a byte-identical payload dedupes to the same sequence",
  );
  passed += 2;
  assert.throws(
    () =>
      exceptionSink.append({
        ...replayedCompletion,
        eventId: "third-attempt",
        payload: {
          ...replayedCompletion.payload,
          durationMs: { kind: "count", value: realToolCompleted.payload.durationMs.value + 7 },
        },
      }),
    (error) => error && error.code === "idempotency_conflict",
    "THE EXCEPTION: re-appending the same logical tool.completed with a second wall-clock duration conflicts",
  );
  assert.equal(
    readFileSync(exceptionPath, "utf8").split("\n").filter((line) => line.trim()).length,
    1,
    "the conflicting re-append wrote nothing",
  );
  passed += 2;

  console.log(`worker-runtime-adapter-events: ${passed} checks passed (N=${N} events: ${types.join(" > ")})`);
} finally {
  clearTimeout(timer);
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
