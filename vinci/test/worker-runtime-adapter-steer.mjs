// IR-02 Lane B — embedded runtime adapter: steer + interrupt.
//
// Offline; same faux-provider idiom as worker-runtime-adapter-events.mjs. One scripted
// multi-step turn (ls, ls, finish):
//
//   * while the FIRST ls executes, steer("switch to the second file") is issued: the sink gets
//     steer.received{instructionDigest = sha256(text), issuedByPrincipalId = control}, and the
//     scripted model's SECOND request (recorded by the faux factory) carries that exact text as a
//     new user message that its FIRST request did not;
//   * when the SECOND ls completes, interrupt("manual") is issued: run.paused{reasonCode: manual}
//     is appended, the turn stops (the test observes agent_end and an aborted assistant message),
//     and no agent.turn_* event follows the pause;
//   * NEGATIVE: an interrupt reason outside the enum rejects with code invalid_pause_reason before
//     anything is appended.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJsonlSink } from "../worker/run-events-sink.mjs";
import { createRunSession } from "../worker/runtime-adapter.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const STEER_TEXT = "switch to the second file";
const STEER_DIGEST = createHash("sha256").update(STEER_TEXT, "utf8").digest("hex");
const PROMPT = "Inspect the first file. ir02-steer-prompt-marker-c41d";

const root = mkdtempSync(join(tmpdir(), "vinci-ir02-steer-"));
const cwd = join(root, "cwd");
const sessionDir = join(root, "sessions");
const sinkPath = join(root, "state", "run-events.jsonl");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(cwd, "first.txt"), "first\n", "utf8");
writeFileSync(join(cwd, "second.txt"), "second\n", "utf8");

const faux = registerFauxProvider();
const model = faux.getModel();
const recordedContexts = [];
function scripted(message) {
  return (context) => {
    recordedContexts.push(JSON.parse(JSON.stringify(context.messages)));
    return message;
  };
}
faux.setResponses([
  scripted(fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "call_ls_1" })], { stopReason: "toolUse" })),
  scripted(fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "call_ls_2" })], { stopReason: "toolUse" })),
  scripted(fauxAssistantMessage("Finished.")),
]);
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "faux-key");

const run = {
  runId: "run_ir02_steer_0001",
  workOrderId: "wo_ir02_steer_0001",
  workOrderDigest: "0".repeat(64),
  attemptId: "attempt_ir02_steer_0001",
  workspaceId: "ws_ir02_steer_0001",
  contextManifestDigest: null,
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
function userTexts(messages) {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : [message.content]))
    .map((block) => (typeof block === "string" ? block : block && block.type === "text" ? block.text : ""))
    .filter(Boolean);
}

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const timer = setTimeout(() => {
  console.error("worker-runtime-adapter-steer: timed out after 60s");
  process.exit(1);
}, 60_000);

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

  const observed = [];
  let steerPromise = null;
  let interruptPromise = null;
  let sinkLinesWhenPaused = -1;
  const unsubscribe = handle.session.subscribe(async (event) => {
    observed.push(event.type);
    if (event.type === "tool_execution_start" && event.toolCallId === "call_ls_1") {
      // Steer while the first tool runs: the queue is drained before the next model request.
      steerPromise = handle.steer(STEER_TEXT);
      await steerPromise;
    }
    if (event.type === "tool_execution_end" && event.toolCallId === "call_ls_2") {
      // Interrupt once the second tool has completed. Not awaited here: session.abort() waits
      // for the agent to go idle, which cannot happen while this listener blocks the loop.
      interruptPromise = handle.interrupt("manual");
      sinkLinesWhenPaused = lineCount();
    }
  });

  await handle.prompt(PROMPT);
  check(steerPromise !== null, "steer was issued during the turn");
  check(interruptPromise !== null, "interrupt was issued during the turn");
  await interruptPromise;
  unsubscribe();

  // ---- steer.received --------------------------------------------------------------------------
  const events = readEvents();
  const types = events.map((event) => event.type);
  const steerEvents = events.filter((event) => event.type === "steer.received");
  assert.equal(steerEvents.length, 1, `exactly one steer.received, got ${JSON.stringify(types)}`);
  const steered = steerEvents[0];
  assert.deepEqual(
    Object.keys(steered.payload).sort(),
    ["instructionDigest", "issuedByPrincipalId", "steerId"],
    "steer.received payload keys",
  );
  assert.equal(steered.payload.instructionDigest.kind, "digest");
  assert.equal(steered.payload.instructionDigest.value, STEER_DIGEST, "instructionDigest is sha256 of exactly the steer text");
  assert.equal(steered.payload.issuedByPrincipalId.kind, "id");
  assert.equal(steered.payload.issuedByPrincipalId.value, "control", "issuedByPrincipalId is control");
  assert.equal(steered.payload.steerId.kind, "id");
  assert.match(steered.payload.instructionDigest.value, HEX64);
  passed += 7;
  check(!readFileSync(sinkPath, "utf8").includes(STEER_TEXT), "the sink never carries the steer text itself");

  // The model observed the steer as a new user message: absent from request 1, present in request 2.
  assert.equal(recordedContexts.length, 3, "the faux model recorded three request contexts");
  passed += 1;
  const request1Users = userTexts(recordedContexts[0]);
  const request2Users = userTexts(recordedContexts[1]);
  check(request1Users.includes(PROMPT), "request 1 carries the prompt");
  check(!request1Users.includes(STEER_TEXT), "request 1 (before the steer) does not carry the steer text");
  check(request2Users.includes(STEER_TEXT), `request 2 carries the steer text as a user message, got ${JSON.stringify(request2Users)}`);
  check(request2Users.at(-1) === STEER_TEXT, "the steer text is the newest user message the model saw in request 2");
  check(
    recordedContexts[1].some((message) => message.role === "toolResult" && message.toolCallId === "call_ls_1"),
    "request 2 also carries the first ls result (the steer was injected after the tool batch, mid-turn)",
  );

  // ---- run.paused ------------------------------------------------------------------------------
  const pausedIndex = events.findIndex((event) => event.type === "run.paused");
  check(pausedIndex !== -1, `run.paused was appended, got ${JSON.stringify(types)}`);
  const paused = events[pausedIndex];
  assert.deepEqual(paused.payload, { reasonCode: { kind: "enum", value: "manual" } }, "run.paused payload is reasonCode manual");
  passed += 1;
  check(paused.sequence > steered.sequence, "run.paused follows steer.received");
  check(sinkLinesWhenPaused === paused.sequence, "run.paused was on disk synchronously when interrupt() was called");
  const afterPause = events.slice(pausedIndex + 1).map((event) => event.type);
  check(!afterPause.some((type) => type.startsWith("agent.turn_")), `no agent.turn_* event after run.paused, got ${JSON.stringify(afterPause)}`);
  assert.deepEqual(afterPause, [], `run.paused is the last event of the interrupted turn, got ${JSON.stringify(afterPause)}`);
  passed += 1;
  const turnStarted = events.filter((event) => event.type === "agent.turn_started");
  const turnFinished = events.filter((event) => event.type === "agent.turn_finished");
  assert.equal(turnStarted.length, 1, "one agent.turn_started");
  assert.equal(turnFinished.length, 0, "the interrupted turn has no agent.turn_finished");
  passed += 2;
  check(
    events.filter((event) => event.type === "tool.completed").length === 2,
    "both granted ls calls completed before the pause",
  );

  // The turn really stopped: agent_end observed, the assistant's final message is the abort.
  check(observed.includes("agent_end"), `agent_end observed, got ${JSON.stringify(observed)}`);
  const assistantMessages = handle.session.messages.filter((message) => message.role === "assistant");
  const finalAssistant = assistantMessages.at(-1);
  check(finalAssistant && finalAssistant.stopReason === "aborted", `final assistant message is aborted, got ${finalAssistant && finalAssistant.stopReason}`);
  check(handle.session.isStreaming === false, "the session is idle after the interrupt");
  check(!observed.slice(observed.lastIndexOf("agent_end") + 1).includes("agent_start"), "no new turn started after agent_end");

  // ---- NEGATIVE: an out-of-enum reason rejects before anything is appended -------------------
  const linesBefore = lineCount();
  for (const bad of ["bogus", null, 42, "MANUAL"]) {
    await assert.rejects(
      () => handle.interrupt(bad),
      (error) => error && error.code === "invalid_pause_reason",
      `interrupt(${JSON.stringify(bad)}) rejects with code invalid_pause_reason`,
    );
    passed += 1;
  }
  assert.equal(lineCount(), linesBefore, "rejected interrupts append nothing");
  passed += 1;
  // Positive control through the same entry point: a valid reason still appends.
  await handle.interrupt("budget");
  assert.equal(lineCount(), linesBefore + 1, "a valid reason still appends run.paused");
  assert.equal(readEvents().at(-1).payload.reasonCode.value, "budget", "the appended pause carries the valid reason");
  passed += 2;

  await handle.dispose();
  console.log(`worker-runtime-adapter-steer: ${passed} checks passed (${types.join(" > ")})`);
} finally {
  clearTimeout(timer);
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
