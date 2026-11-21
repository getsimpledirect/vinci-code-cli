// A focused check that passed while the required check stayed failed (or was not rerun after a
// change) is partial evidence. The receipt names the required check in a "Partially verified" line
// and the plan widget does not say "Plan complete". Drives the real receipt and todo extensions and
// the real verification state with scripted events; no model, no executed tools.
// Uses only APIs that exist before the change, so the same file runs against the old code too.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
const receipt = await loader.import(resolve(here, "../extensions/vinci-receipt.ts"), { default: false });
const todo = await loader.import(resolve(here, "../extensions/vinci-todo.ts"), { default: false });
const state = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });

const REQUIRED = "npm test";
const FOCUSED = "npm test -- money.test.js";
const PARTIAL = /Partially verified/;
const theme = {
  fg(_name, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};
const usage = (input, output, cost) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const messages = [
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-fort",
    responseId: "partial-1",
    stopReason: "toolUse",
    timestamp: 1,
    usage: usage(100, 10, 0.01),
    content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/auth.ts" } }],
  },
  {
    role: "toolResult",
    toolCallId: "edit-1",
    toolName: "edit",
    content: [{ type: "text", text: "Applied changes" }],
    isError: false,
    timestamp: 2,
  },
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-fort",
    responseId: "partial-2",
    stopReason: "stop",
    timestamp: 3,
    usage: usage(50, 5, 0.02),
    content: [{ type: "text", text: "The requested change is in place." }],
  },
];

// One session: the receipt and todo extensions on one host, a scratch project with the edited file.
function fixture(id) {
  const handlers = {};
  const tools = new Map();
  const widgets = new Map();
  const branch = [];
  const cwd = mkdtempSync(resolve(tmpdir(), "vinci-partial-label-"));
  mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src/auth.ts"), "export const auth = true;\n");
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      branch.push({ type: "custom", customType, data });
    },
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    sendMessage() {},
  };
  receipt.default(pi);
  todo.default(pi, async () => null);
  const context = {
    hasUI: true,
    cwd,
    hasPendingMessages() {
      return false;
    },
    sessionManager: {
      getBranch() {
        return [...branch];
      },
      getSessionId() {
        return `task-partial-${id}`;
      },
    },
    ui: {
      get theme() {
        return theme;
      },
      async select() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      async input() {
        return undefined;
      },
      setWidget(name, content) {
        widgets.set(name, content);
      },
      notify() {},
    },
  };
  const emit = async (name, event) => {
    for (const handler of handlers[name] ?? []) await handler(event, context);
  };
  return {
    branch,
    emit,
    async receipt() {
      widgets.delete("vinci-receipt");
      await emit("agent_end", { type: "agent_end", messages });
      return this.shownReceipt();
    },
    shownReceipt() {
      const widget = widgets.get("vinci-receipt");
      assert.equal(typeof widget, "function", `${id}: the receipt widget is shown`);
      return widget({}, theme).render(140).join("\n");
    },
    async plan(titles) {
      await tools.get("todo").execute(
        `plan-${id}`,
        { steps: titles.map((title) => ({ title, status: "done" })) },
        undefined,
        undefined,
        context,
      );
      const widget = widgets.get("vinci-plan");
      assert.equal(typeof widget, "function", `${id}: the plan widget is shown`);
      return widget(null, theme).render(120).join("\n");
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function head(text) {
  return text.split("\n").slice(0, 3).join(" | ");
}

// The required check fails, the code changes, a narrower check passes: the locked-pass path.
// Returns the plain-failure snapshot (before the narrower pass) and the locked snapshot (after it).
function lockedPass(id) {
  state.resetVinciVerificationState();
  taskOutcome.setVinciTaskOutcome(undefined);
  state.recordVinciMutation();
  state.recordVinciVerification(REQUIRED, false, "1 test failed");
  const plainFailure = clone(state.getVinciVerificationState());
  state.recordVinciMutation();
  state.recordVinciVerification(FOCUSED, true, "3 tests passed");
  const locked = clone(state.getVinciVerificationState());
  assert.equal(locked.status, "failed", `${id}: precondition, the required check still fails`);
  assert.equal(locked.requiredCommand, REQUIRED, `${id}: precondition, the required check is ${REQUIRED}`);
  assert.match(locked.summary, /required failing check is still unresolved/, `${id}: precondition, the locked-pass path was reached`);
  return { plainFailure, locked };
}

// What an outcome built now would carry as the narrower passing check, for a given state.
function passedFor(verification) {
  return taskOutcome.buildVinciTaskOutcome({
    taskId: "task-partial-memo",
    messages: [],
    changedFiles: ["src/auth.ts"],
    verification,
  }).requiredCheck?.passed;
}

test("V1: a narrower pass beside a failed required check is labeled partially verified", async () => {
  const f = fixture("V1");
  lockedPass("V1");
  const shown = await f.receipt();
  assert.ok(
    shown.includes("Partially verified: required check `npm test` failed"),
    `V1: the receipt names the failed required check (got: ${head(shown)})`,
  );
});

test("V1b: the plan widget does not say Plan complete after a partial verification", async () => {
  const f = fixture("V1b");
  lockedPass("V1b");
  await f.receipt();
  const plan = await f.plan(["Fix the rounding", "Run the focused test"]);
  assert.ok(!plan.includes("Plan complete"), `V1b: the plan widget does not claim completion (got: ${plan})`);
  assert.ok(plan.includes("Plan steps done — partially verified"), `V1b: the plan widget says partially verified (got: ${plan})`);
});

test("V3: a fully verified task keeps Done and Plan complete", async () => {
  const f = fixture("V3");
  state.resetVinciVerificationState();
  taskOutcome.setVinciTaskOutcome(undefined);
  state.recordVinciMutation();
  state.recordVinciVerification(REQUIRED, true, "18 tests passed", false, "behavioral", REQUIRED);
  const shown = await f.receipt();
  assert.ok(shown.includes("✓ Done"), `V3: the receipt says Done (got: ${head(shown)})`);
  assert.doesNotMatch(shown, PARTIAL, "V3: no partial line on a fully verified task");
  const plan = await f.plan(["Fix the rounding", "Run the tests"]);
  assert.ok(plan.includes("✓ Plan complete"), `V3: the plan widget says Plan complete (got: ${plan})`);
});

test("V4: a plain failure with no narrower pass has no partial line", async () => {
  const f = fixture("V4");
  state.resetVinciVerificationState();
  taskOutcome.setVinciTaskOutcome(undefined);
  state.recordVinciMutation();
  state.recordVinciVerification(REQUIRED, false, "1 test failed");
  const shown = await f.receipt();
  assert.doesNotMatch(shown, PARTIAL, `V4: no partial line without a narrower pass (got: ${head(shown)})`);
});

test("W4: a narrower pass then an edit says the required check was not run", async () => {
  const f = fixture("W4");
  lockedPass("W4");
  // A code change after the narrower pass: the state goes stale, the narrower pass is still remembered.
  state.recordVinciMutation();
  assert.equal(state.getVinciVerificationState().status, "stale", "W4: the edit made the state stale");
  const shown = await f.receipt();
  assert.ok(
    shown.includes("Partially verified: required check `npm test` not run"),
    `W4: the receipt says the required check was not run (got: ${head(shown)})`,
  );
});

test("V4b: a plain failure with no narrower pass keeps the plan widget wording", async () => {
  const f = fixture("V4b");
  state.resetVinciVerificationState();
  taskOutcome.setVinciTaskOutcome(undefined);
  state.recordVinciMutation();
  state.recordVinciVerification(REQUIRED, false, "1 test failed");
  await f.receipt();
  const plan = await f.plan(["Fix the rounding", "Run the focused test"]);
  assert.ok(plan.includes("✓ Plan complete"), `V4b: the plan widget is unchanged without a narrower pass (got: ${plan})`);
});

test("W2a: a historical outcome without requiredCheck restores and renders as before", async () => {
  state.resetVinciVerificationState();
  state.recordVinciMutation();
  state.recordVinciVerification(REQUIRED, false, "1 test failed");
  const built = taskOutcome.buildVinciTaskOutcome({
    taskId: "task-partial-W2a",
    messages,
    changedFiles: ["src/auth.ts"],
    verification: state.getVinciVerificationState(),
  });
  const { requiredCheck: _dropped, ...historical } = clone(built);
  const withCheck = { ...historical, requiredCheck: { command: REQUIRED, status: "failed", passed: FOCUSED } };
  assert.equal(taskOutcome.isVinciTaskOutcome(historical), true, "W2a: the historical record is accepted");
  const restore = async (record, id) => {
    const f = fixture(id);
    f.branch.push({ type: "custom", customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY, data: record });
    await f.emit("session_start", { type: "session_start", reason: "resume" });
    return f.shownReceipt();
  };
  const restoredHistorical = await restore(historical, "W2a-historical");
  const restoredWithCheck = await restore(withCheck, "W2a-with-check");
  assert.doesNotMatch(restoredHistorical, PARTIAL, `W2a: no partial line on a historical record (got: ${head(restoredHistorical)})`);
  // Positive control: the same restore path does show the line when the record carries it.
  assert.ok(
    restoredWithCheck.includes("Partially verified: required check `npm test` failed"),
    `W2a: the restored record with requiredCheck shows the partial line (got: ${head(restoredWithCheck)})`,
  );
  assert.equal(
    restoredHistorical,
    restoredWithCheck.split("\n").filter((line) => !PARTIAL.test(line)).join("\n"),
    "W2a: apart from the partial line, the historical record renders byte-identically",
  );
});

test("W2b: a malformed requiredCheck rejects the record and restore skips it", async () => {
  state.resetVinciVerificationState();
  state.recordVinciMutation();
  state.recordVinciVerification(REQUIRED, false, "1 test failed");
  const base = clone(taskOutcome.buildVinciTaskOutcome({
    taskId: "task-partial-W2b",
    messages,
    changedFiles: ["src/auth.ts"],
    verification: state.getVinciVerificationState(),
  }));
  delete base.requiredCheck;
  const wrongType = { ...base, requiredCheck: REQUIRED };
  const unknownStatus = { ...base, requiredCheck: { command: REQUIRED, status: "passed", passed: FOCUSED } };
  const emptyCommand = { ...base, requiredCheck: { command: "", status: "failed", passed: FOCUSED } };
  assert.equal(taskOutcome.isVinciTaskOutcome(wrongType), false, "W2b: a non-object requiredCheck is rejected");
  assert.equal(taskOutcome.isVinciTaskOutcome(unknownStatus), false, "W2b: an unknown requiredCheck status is rejected");
  assert.equal(taskOutcome.isVinciTaskOutcome(emptyCommand), false, "W2b: an empty requiredCheck command is rejected");
  const f = fixture("W2b");
  f.branch.push({ type: "custom", customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY, data: { ...base, taskId: "older-valid" } });
  f.branch.push({ type: "custom", customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY, data: { ...unknownStatus, taskId: "newer-malformed" } });
  await f.emit("session_start", { type: "session_start", reason: "resume" });
  assert.equal(taskOutcome.getVinciTaskOutcome()?.taskId, "older-valid", "W2b: restore skips the malformed newer record");
});

test("W3: a fresh required failure after a locked pass carries no earlier pass", async () => {
  const f = fixture("W3");
  lockedPass("W3");
  // A higher-class failure passes the lock and records a NEW required check.
  state.recordVinciVerification("npm run e2e", false, "2 tests failed", false, "behavioral");
  assert.equal(state.getVinciVerificationState().requiredCommand, "npm run e2e", "W3: precondition, a new required check");
  state.recordVinciMutation();
  const shown = await f.receipt();
  assert.doesNotMatch(shown, PARTIAL, `W3: the new required check names no earlier pass (got: ${head(shown)})`);
});

test("W3b: restoring a snapshot forgets the locked pass", async () => {
  const { plainFailure } = lockedPass("W3b");
  state.restoreVinciVerificationState(plainFailure);
  assert.equal(state.getVinciVerificationState().requiredCommand, REQUIRED, "W3b: precondition, the restored failure is required");
  assert.equal(passedFor(state.getVinciVerificationState()), undefined, "W3b: no narrower pass survives a restore");
});

test("W3c: hydrating a snapshot forgets the locked pass", async () => {
  const { plainFailure } = lockedPass("W3c");
  state.hydrateVinciVerificationState(plainFailure);
  assert.equal(state.getVinciVerificationState().requiredCommand, REQUIRED, "W3c: precondition, the hydrated failure is required");
  assert.equal(passedFor(state.getVinciVerificationState()), undefined, "W3c: no narrower pass survives a hydrate");
});

test("W3d: a reset forgets the locked pass", async () => {
  const { locked } = lockedPass("W3d");
  state.resetVinciVerificationState();
  assert.equal(passedFor(locked), undefined, "W3d: no narrower pass survives a reset");
});

test("W3e: a failed project change forgets the locked pass", async () => {
  const { locked } = lockedPass("W3e");
  state.recordVinciMutationFailure("The edit did not apply.");
  assert.equal(state.getVinciVerificationState().requiredCommand, "", "W3e: precondition, the required check is cleared");
  assert.equal(passedFor(locked), undefined, "W3e: no narrower pass survives a failed change");
});

test("W3f: a terminal-unverifiable state forgets the locked pass", async () => {
  const { locked } = lockedPass("W3f");
  state.recordVinciTerminalUnverifiable();
  assert.equal(state.getVinciVerificationState().variant, "terminal-unverifiable", "W3f: precondition, terminal state");
  assert.equal(passedFor(locked), undefined, "W3f: no narrower pass survives the terminal state");
  state.recordVinciVerification(state.getVinciVerificationState().command, true, "4 tests passed");
  assert.equal(state.getVinciVerificationState().variant, "normal", "W3f: precondition, the exact rerun leaves the terminal state");
  assert.equal(passedFor(locked), undefined, "W3f: no narrower pass after leaving the terminal state");
});

test("W3h: a zero-collection attempt forgets the locked pass", async () => {
  const { locked } = lockedPass("W3h");
  state.recordVinciMutation();
  state.recordVinciVerification("pytest -q", false, "", false, "behavioral", "pytest -q", true, undefined, true);
  assert.equal(state.getVinciVerificationState().requiredCommand, "", "W3h: precondition, the zero-collection record cleared the required check");
  assert.equal(passedFor(locked), undefined, "W3h: no narrower pass survives a zero-collection record");
});

test("W3i: passing the required check forgets the locked pass", async () => {
  const { locked } = lockedPass("W3i");
  state.recordVinciVerification(REQUIRED, true, "4 tests passed");
  assert.equal(state.getVinciVerificationState().requiredCommand, "", "W3i: precondition, the required check passed");
  assert.equal(passedFor(locked), undefined, "W3i: no narrower pass survives the required pass");
});

test("W3j: a narrower failure after a locked pass forgets the pass", async () => {
  const f = fixture("W3j");
  lockedPass("W3j");
  // The same narrower check now FAILS while the required check is still failed: the `!passed` path.
  state.recordVinciVerification(FOCUSED, false, "1 test failed");
  const after = clone(state.getVinciVerificationState());
  assert.equal(after.status, "failed", "W3j: precondition, the required check still fails");
  assert.equal(after.requiredCommand, REQUIRED, `W3j: precondition, the required check is ${REQUIRED}`);
  assert.equal(passedFor(after), undefined, "W3j: no narrower pass survives a narrower failure");
  const shown = await f.receipt();
  assert.doesNotMatch(shown, PARTIAL, `W3j: no partial line after the narrower failure (got: ${head(shown)})`);
});

test("X1: the locked pass adds no key to the persisted verification state", async () => {
  const { plainFailure, locked } = lockedPass("X1");
  const persisted = JSON.parse(JSON.stringify(state.getVinciVerificationState()));
  const parsed = state.parseVinciVerificationState(persisted);
  assert.notEqual(parsed, undefined, "X1: the persisted state is accepted");
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(locked).sort(), "X1: re-parse keeps the same keys");
  assert.deepEqual(Object.keys(locked).sort(), Object.keys(plainFailure).sort(), "X1: the locked pass adds no key");
  assert.ok(!JSON.stringify(persisted).includes("money.test.js"), "X1: the narrower check is not persisted");
});
