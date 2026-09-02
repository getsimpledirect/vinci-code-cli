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
//   * run.started payload keys are exactly ["attemptId"] (the registry allowlist refuses more)
//   * context.loaded.entryCount is the contextManifestEntryCount passed in, not a constant
//   * idempotencyKey is per-event IDENTITY, not type+payload: two manual interrupts in one run are
//     two run.paused lines with two keys, while re-appending one of them dedupes to its sequence
//   * sink idempotency: same key+payload -> same sequence, no new line; same key, different
//     payload -> throws code "idempotency_conflict"; reopen + replay() -> lastSequence === N
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
  "tool.started",
  "tool.completed",
  "agent.turn_finished",
  "run.paused",
  "run.paused",
];
const CONTEXT_MANIFEST_ENTRY_COUNT = 3;

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

  check(faux.getPendingResponseCount() === 0, "scripted model consumed both responses");
  check(faux.state.callCount === 2, `faux model called twice (tool turn + finish), got ${faux.state.callCount}`);

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

  // Every payload value is kinded and content-free.
  const lsOutputMarkers = [PROMPT_MARKER, PROMPT, LS_TARGET_FILE, LS_TARGET_CONTENT.trim()];
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
  const [started, loaded, turnStarted, toolStarted, toolCompleted, turnFinished, pausedA, pausedB] = events;
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
  assert.equal(toolResults.length, 1, "exactly one tool result in the session transcript");
  const toolResultText = JSON.stringify(toolResults[0].content);
  check(toolResultText.includes(LS_TARGET_FILE), "ls actually listed the temp cwd");
  check(toolResults[0].isError !== true, "ls succeeded");

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

  console.log(`worker-runtime-adapter-events: ${passed} checks passed (N=${N} events: ${types.join(" > ")})`);
} finally {
  clearTimeout(timer);
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
