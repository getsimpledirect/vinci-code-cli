import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const controlPath = resolve(here, "../extensions/lib/control.ts");
const todoPath = resolve(here, "../extensions/vinci-todo.ts");
const verificationPath = resolve(here, "../extensions/vinci-verification.ts");
const uiStatePath = resolve(here, "../extensions/lib/ui-state.ts");
const controlLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const extensionLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const control = await controlLoader.import(controlPath, { default: false });
const controlFromAnotherLoader = await extensionLoader.import(controlPath, { default: false });
const todo = await extensionLoader.import(todoPath, { default: false });
const verification = await extensionLoader.import(verificationPath, { default: false });
const uiState = await extensionLoader.import(uiStatePath, { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

control.clearVinciAutomationStop();
control.requestVinciAutomationStop("repeated invalid edit");
check(
  "isolated extension loaders share one automation stop state",
  controlFromAnotherLoader.getVinciAutomationStop().stopped &&
    controlFromAnotherLoader.getVinciAutomationStop().reason === "repeated invalid edit",
);
controlFromAnotherLoader.clearVinciAutomationStop();
check("clearing the shared stop is visible to every loader", !control.getVinciAutomationStop().stopped);

function harness() {
  const handlers = {};
  const tools = new Map();
  const sent = [];
  const entries = [];
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
  return { handlers, tools, sent, entries, pi };
}

async function emit(handlers, name, event, context) {
  const results = [];
  for (const handler of handlers[name] ?? []) results.push(await handler(event, context));
  return results;
}

const context = {
  cwd: process.cwd(),
  hasUI: true,
  hasPendingMessages() {
    return false;
  },
  sessionManager: {
    getBranch() {
      return [];
    },
    getSessionId() {
      return "task-automation-stop";
    },
  },
  ui: {
    setWidget() {},
    notify() {},
  },
};

const todoHarness = harness();
todo.default(todoHarness.pi, async () => ({ verdict: "pass", summary: "No review needed." }));
uiState.setVinciMode("auto");
await emit(todoHarness.handlers, "session_start", { type: "session_start" }, context);
await todoHarness.tools.get("todo").execute(
  "plan-1",
  { steps: [{ title: "Fix the query parser", status: "doing" }] },
  undefined,
  undefined,
  context,
);

control.requestVinciAutomationStop("loop breaker reached its bounded stop");
const mutationBlocks = await emit(
  todoHarness.handlers,
  "tool_call",
  { toolName: "edit", input: { path: "lib/query.js", edits: [] } },
  context,
);
check("a shared stop freezes autonomous mutations", mutationBlocks.some((result) => result?.block === true));

const plainTurn = {
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "I will keep working on the current step." }],
  },
};
await emit(todoHarness.handlers, "turn_end", plainTurn, context);
check("an unfinished plan cannot restart itself after a shared stop", todoHarness.sent.length === 0);

control.clearVinciAutomationStop();
await emit(todoHarness.handlers, "turn_end", plainTurn, context);
check("normal plan auto-continuation still works when no stop is active", todoHarness.sent.length === 1);

const verificationHarness = harness();
verification.default(verificationHarness.pi);
await emit(verificationHarness.handlers, "session_start", { type: "session_start" }, context);
await emit(
  verificationHarness.handlers,
  "tool_result",
  {
    toolName: "edit",
    input: { path: "lib/query.js" },
    content: [{ type: "text", text: "Applied changes" }],
    isError: false,
  },
  context,
);
await emit(verificationHarness.handlers, "message_end", plainTurn, context);
control.requestVinciAutomationStop("loop breaker stopped verification recovery");
await emit(verificationHarness.handlers, "turn_end", plainTurn, context);
check("verification recovery cannot restart a stopped turn", verificationHarness.sent.length === 0);

await emit(
  verificationHarness.handlers,
  "input",
  {
    type: "input",
    text: "Search the official installation documentation instead",
    source: "interactive",
    streamingBehavior: "followUp",
  },
  context,
);
check("a user follow-up submitted during streaming releases the bounded stop immediately", !control.getVinciAutomationStop().stopped);

control.requestVinciAutomationStop("loop breaker stopped the next turn");
await emit(
  verificationHarness.handlers,
  "input",
  { type: "input", text: "Try a different project-level fix", source: "interactive" },
  context,
);
check("a real user instruction releases the bounded stop", !control.getVinciAutomationStop().stopped);

console.log(`\nautomation-stop-integration: ${pass}/${pass} checks passed (shared bounded-stop ownership)`);
