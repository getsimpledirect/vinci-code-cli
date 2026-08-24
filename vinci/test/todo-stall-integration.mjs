import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Regression: a plan step the user explicitly cancelled kept the plan open forever — every
// keep-working reminder produced another text-only reply, every user answer reset the continue
// cap, and the loop burned paid model calls until the user hit escape (observed live 2026-07-14).
// The stall latch pauses auto-continuation after repeated no-progress replies, sends exactly one
// reconciliation nudge, and stays paused across user input until the plan actually changes.

const here = dirname(fileURLToPath(import.meta.url));
const todoPath = resolve(here, "../extensions/vinci-todo.ts");
const planPath = resolve(here, "../extensions/vinci-plan.ts");
const uiStatePath = resolve(here, "../extensions/lib/ui-state.ts");
const controlPath = resolve(here, "../extensions/lib/control.ts");
const verificationStatePath = resolve(here, "../extensions/lib/verification-state.ts");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const todo = await loader.import(todoPath, { default: false });
const planModule = await loader.import(planPath, { default: false });
const uiState = await loader.import(uiStatePath, { default: false });
const control = await loader.import(controlPath, { default: false });
const verificationState = await loader.import(verificationStatePath, { default: false });

let pass = 0;
const widgets = new Map();
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

function harness() {
  const handlers = {};
  const tools = new Map();
  const sent = [];
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
    appendEntry() {},
  };
  return { handlers, tools, sent, pi };
}

async function emit(handlers, name, event, context) {
  for (const handler of handlers[name] ?? []) await handler(event, context);
}

const notices = [];
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
      return "task-todo-stall";
    },
  },
  ui: {
    setWidget(name, widget) {
      widgets.set(name, widget);
    },
    notify(text) {
      notices.push(text);
    },
  },
};

const textOnlyTurn = {
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Understood — leaving it unpushed. No action taken." }],
  },
};
const toolCallTurn = {
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
  },
};

const { handlers, tools, sent, pi } = harness();
todo.default(pi, async () => ({ text: "No review needed.", verdict: "none" }));
uiState.setVinciMode("auto");
await emit(handlers, "session_start", { type: "session_start" }, context);
await tools.get("todo").execute(
  "plan-1",
  {
    steps: [
      { title: "Delete the folders and commit", status: "done" },
      { title: "Push to origin/master (internal mirror)", status: "doing" },
    ],
  },
  undefined,
  undefined,
  context,
);
sent.length = 0;

const continues = () => sent.filter((s) => s.message.customType === "vinci-plan-auto-continue").length;
const stalls = () => sent.filter((s) => s.message.customType === "vinci-plan-stalled").length;

await emit(handlers, "turn_end", textOnlyTurn, context);
await emit(handlers, "turn_end", textOnlyTurn, context);
await emit(handlers, "turn_end", textOnlyTurn, context);
check("bounded keep-working reminders still fire for a quiet open plan", continues() === 3);

await emit(handlers, "turn_end", textOnlyTurn, context);
check("repeated no-progress replies stop producing keep-working reminders", continues() === 3);
check("the stall sends exactly one reconciliation nudge", stalls() === 1);
check("the stall is announced to the user", notices.some((text) => text.includes("stalled")));

await emit(handlers, "turn_end", textOnlyTurn, context);
check("a stalled plan stays silent instead of nudging again", continues() === 3 && stalls() === 1);

// The live failure mode: user answers ("stop, leave it unpushed"), the input handler resets the
// continue cap, and the loop re-arms. The stall latch must survive user input.
await emit(handlers, "input", { type: "input", text: "Stop - do not push. We're done.", source: "interactive" }, context);
await emit(handlers, "turn_end", textOnlyTurn, context);
check("user input does not re-arm a stalled plan", continues() === 3 && stalls() === 1);

// Reconciling the plan (the model marks the cancelled step done) re-arms continuation for real
// future work — and a completed plan sends nothing at all.
await tools.get("todo").execute(
  "plan-2",
  {
    steps: [
      { title: "Delete the folders and commit", status: "done" },
      { title: "Push to origin/master (internal mirror)", status: "done" },
    ],
  },
  undefined,
  undefined,
  context,
);
await emit(handlers, "turn_end", textOnlyTurn, context);
check("a reconciled (complete) plan sends no further reminders", continues() === 3 && stalls() === 1);

await tools.get("todo").execute(
  "plan-3",
  {
    steps: [
      { title: "Update the changelog", status: "doing" },
      { title: "Run the focused tests", status: "todo" },
    ],
  },
  undefined,
  undefined,
  context,
);
await emit(handlers, "turn_end", textOnlyTurn, context);
check("a genuinely new plan re-arms keep-working reminders", continues() === 4);

// Real progress (a tool-calling turn) resets the stall count so long tasks never latch by accident.
await emit(handlers, "turn_end", textOnlyTurn, context);
await emit(handlers, "turn_end", textOnlyTurn, context);
check("stall counting approaches the latch again", continues() === 6);
await emit(handlers, "turn_end", toolCallTurn, context);
await emit(handlers, "turn_end", textOnlyTurn, context);
check("a tool-calling turn resets the stall count", continues() === 7);

// A lower-level static pass followed by a timed-out behavioral attempt is not plan completion.
// Todo must read the verifier-owned attempt marker instead of its private "a check ran" latch.
await emit(handlers, "session_start", { type: "session_start" }, context);
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification("npm run check", true, "Static check passed.", false, "static");
await tools.get("todo").execute(
  "plan-incomplete-behavioral",
  {
    steps: [
      { title: "Implement the fix", status: "done" },
      { title: "Run the tests", status: "doing" },
    ],
  },
  undefined,
  undefined,
  context,
);
await emit(
  handlers,
  "tool_result",
  { toolName: "bash", isError: false, input: { command: "npm run check" } },
  context,
);
verificationState.recordVinciVerificationAttempt("npm test", "behavioral");
await emit(
  handlers,
  "turn_end",
  { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. All tests passed." }] } },
  context,
);
check(
  "a static pass plus an incomplete behavioral attempt leaves the plan unfinished",
  uiState.getVinciUiState().plan.some((step) => step.status !== "done"),
);

// Terminal corruption can never let the visible plan become complete.
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification(
  "npm test",
  true,
  "1 test passed.",
  false,
  "behavioral",
  "npm test",
  true,
);
const terminalCorruption = verificationState.scanVinciVerificationStateBranch([
  {
    type: "custom",
    customType: verificationState.VINCI_VERIFICATION_ENTRY,
    data: { ...verificationState.getVinciVerificationState() },
  },
  {
    type: "custom",
    customType: verificationState.VINCI_VERIFICATION_ENTRY,
    data: { status: "failed" },
  },
]);
verificationState.restoreVinciVerificationState(terminalCorruption);
await tools.get("todo").execute(
  "plan-terminal-corruption",
  { steps: [{ title: "Run the focused tests", status: "done" }] },
  undefined,
  undefined,
  context,
);
check(
  "terminal verification corruption keeps the plan unfinished",
  uiState.getVinciUiState().plan[0]?.status === "doing",
);

// A current verification pass closes only check/test/verify-shaped steps. Unrelated implementation
// work remains open, so the plan widget must not claim the whole plan is complete.
await emit(handlers, "session_start", { type: "session_start" }, context);
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification("npm test", true, "1 test passed.", false, "behavioral");
await tools.get("todo").execute(
  "plan-verification-pass",
  {
    steps: [
      { title: "Document the release", status: "doing" },
      { title: "Run the focused tests", status: "todo" },
    ],
  },
  undefined,
  undefined,
  context,
);
await emit(
  handlers,
  "turn_end",
  { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. All tests passed." }] } },
  context,
);
const verificationPassPlan = uiState.getVinciUiState().plan;
const verificationPassWidget = widgets.get("vinci-plan");
const verificationPassLines = verificationPassWidget
  ? verificationPassWidget(
      null,
      {
        bold(text) {
          return text;
        },
        fg(_color, text) {
          return text;
        },
      },
    ).render(120).join("\n")
  : "";
check(
  "a verification pass closes only verifier-shaped steps and does not render Plan complete",
  verificationPassPlan[0]?.status === "doing" &&
    verificationPassPlan[1]?.status === "done" &&
    !verificationPassLines.includes("Plan complete"),
);

// A composite step naming a human action alongside the verifier vocabulary is not a pure
// verifier step — the pass must not close it.
await tools.get("todo").execute(
  "plan-composite-step",
  {
    steps: [{ title: "Run tests and verify the fix manually", status: "doing" }],
  },
  undefined,
  undefined,
  context,
);
await emit(
  handlers,
  "turn_end",
  { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. All tests passed." }] } },
  context,
);
check(
  "a composite human-action step never auto-closes on a verification pass",
  uiState.getVinciUiState().plan[0]?.status === "doing",
);

await tools.get("todo").execute(
  "plan-composite-conjunction",
  {
    steps: [{ title: "Run tests and update the changelog", status: "doing" }],
  },
  undefined,
  undefined,
  context,
);
await emit(
  handlers,
  "turn_end",
  { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. All tests passed." }] } },
  context,
);
check(
  "a conjunction-bearing composite step never auto-closes on a verification pass",
  uiState.getVinciUiState().plan[0]?.status === "doing",
);

await tools.get("todo").execute(
  "plan-restore-after-incomplete-behavioral",
  {
    steps: [
      { title: "Update the changelog", status: "doing" },
      { title: "Run the focused tests", status: "todo" },
    ],
  },
  undefined,
  undefined,
  context,
);

// P2-8 regression: loopbreak/verification latch the automation stop with an error/stop steer. The
// todo tool's keep-going steers (vinci-plan-step / vinci-plan-unchanged) in the same context were a
// direct contradiction — with the stop latched, ticking a step must send neither.
const planSteps = () => sent.filter((s) => s.message.customType === "vinci-plan-step").length;
const planUnchanged = () => sent.filter((s) => s.message.customType === "vinci-plan-unchanged").length;

sent.length = 0;
await tools.get("todo").execute(
  "plan-4",
  {
    steps: [
      { title: "Update the changelog", status: "done" },
      { title: "Run the focused tests", status: "doing" },
    ],
  },
  undefined,
  undefined,
  context,
);
check("ticking a step normally sends the keep-going plan-step steer", planSteps() === 1);

await tools.get("todo").execute(
  "plan-5",
  {
    steps: [
      { title: "Fix the verifier", status: "doing" },
      { title: "Re-run the checks", status: "todo" },
    ],
  },
  undefined,
  undefined,
  context,
);
control.requestVinciAutomationStop("Vinci hit its per-turn action limit before finishing.");
sent.length = 0;
await tools.get("todo").execute(
  "plan-6",
  {
    steps: [
      { title: "Fix the verifier", status: "done" },
      { title: "Re-run the checks", status: "doing" },
    ],
  },
  undefined,
  undefined,
  context,
);
check("a latched automation stop suppresses the plan-step steer", planSteps() === 0);
await tools.get("todo").execute(
  "plan-7",
  {
    steps: [
      { title: "Fix the verifier", status: "done" },
      { title: "Re-run the checks", status: "doing" },
    ],
  },
  undefined,
  undefined,
  context,
);
check("a latched automation stop suppresses the plan-unchanged steer", planUnchanged() === 0);

// P3-10: todo is bookkeeping, so the foreign automation-stop freeze must leave it available to
// reconcile the visible plan. Project mutations remain frozen.
const stoppedTodo = await handlers.tool_call[0]({ toolName: "todo", input: { steps: [] } }, context);
const stoppedEdit = await handlers.tool_call[0]({ toolName: "edit", input: { path: "src/app.ts", edits: [] } }, context);
check("a latched automation stop allows todo reconciliation", stoppedTodo === undefined);
check("a latched automation stop still blocks project edits", stoppedEdit?.block === true);
control.clearVinciAutomationStop();

// P2-7 regression (vinci-plan): the Auto→Plan auto-flip must require planning INTENT, not the mere
// word "plan" — and never flip on a mid-stream (streaming) input. Mode is probed behaviorally: in
// Plan mode a write is blocked, in Auto it passes.
function planHarness() {
  const planHandlers = {};
  const pi = {
    on(name, handler) {
      (planHandlers[name] ??= []).push(handler);
    },
    registerTool() {},
    registerShortcut() {},
    registerCommand() {},
    sendMessage() {},
  };
  return { planHandlers, pi };
}
const { planHandlers, pi: planPi } = planHarness();
planModule.default(planPi);
const planCtx = { hasUI: false, ui: {} };
const writeBlocked = async () => {
  let blocked = false;
  for (const handler of planHandlers.tool_call ?? []) {
    const result = await handler({ toolName: "write", input: { path: "src/app.ts", content: "x" } }, planCtx);
    if (result?.block) blocked = true;
  }
  return blocked;
};

await emit(planHandlers, "session_start", {}, planCtx); // mode = auto
await emit(planHandlers, "input", { type: "input", text: "keep going with the plan", source: "interactive" }, planCtx);
check("'keep going with the plan' in Auto mode stays in Auto", (await writeBlocked()) === false);

await emit(planHandlers, "input", { type: "input", text: "Plan out how we migrate the database first", source: "interactive" }, planCtx);
check("an imperative planning request flips Auto to Plan", (await writeBlocked()) === true);

await emit(planHandlers, "session_start", {}, planCtx); // back to auto
await emit(
  planHandlers,
  "input",
  { type: "input", text: "Plan the rollout for this migration", source: "interactive", streamingBehavior: "steer" },
  planCtx,
);
check("streaming input containing 'plan' never flips the mode", (await writeBlocked()) === false);
await emit(planHandlers, "session_start", {}, planCtx); // leave shared UI state in auto

console.log(`\ntodo-stall-integration: ${pass}/${pass} checks passed (stalled plans stop paying for reminders)`);
