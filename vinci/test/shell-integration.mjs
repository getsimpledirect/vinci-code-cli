// The composer is Vinci's one animated surface. Keep its pulse and activity language semantic so a
// non-technical user can tell whether Vinci is thinking, inspecting, changing, or checking.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const source = fileURLToPath(new URL("../extensions/vinci-shell.ts", import.meta.url));
const stateSource = fileURLToPath(new URL("../extensions/lib/ui-state.ts", import.meta.url));
const launcherSource = fileURLToPath(new URL("../bin/vinci", import.meta.url));
const identitySource = fileURLToPath(new URL("../identity.json", import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const shell = await loader.import(source, { default: false });
const uiState = await loader.import(stateSource, { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

check("pulse grows and settles without changing width", shell.VINCI_PULSE_FRAMES.join(" ") === "· • ● •");
check("project reads look through the project", shell.vinciActivityForTool("read", {}) === "Looking through the project…");
check("web research looks for current information", shell.vinciActivityForTool("web_search", {}) === "Looking for current information…");
check("edits say a change is being made", shell.vinciActivityForTool("edit", {}) === "Making the change…");
check("test commands verify the change", shell.vinciActivityForTool("bash", { command: "npm run test" }) === "Verifying the change…");
check("rerun_check verifies the change", shell.vinciActivityForTool("rerun_check", {}) === "Verifying the change…");
check("recognized check commands enter Verifying", shell.vinciActivityStateForTool("bash", { command: "cargo test" }) === "verifying");
check("rerun_check enters Verifying", shell.vinciActivityStateForTool("rerun_check", {}) === "verifying");
check("non-check commands stay Working", shell.vinciActivityStateForTool("bash", { command: "git status" }) === "working");
check("git inspection reviews changes", shell.vinciActivityForTool("bash", { command: "git status --short" }) === "Reviewing the changes…");
check("database migrations name the consequential phase", shell.vinciActivityForTool("bash", { command: "npx prisma migrate dev" }) === "Updating the database…");
check("planning tools organize the plan", shell.vinciActivityForTool("present_plan", {}) === "Organizing the plan…");
check("council work considers another perspective", shell.vinciActivityForTool("convene_council", {}) === "Considering another perspective…");
check("unknown work keeps a calm generic label", shell.vinciActivityForTool("custom_tool", {}) === "Working through it…");
check("read results move into consideration", shell.vinciActivityAfterTool("read", false) === "Considering what I found…");
check("failed work visibly adjusts approach", shell.vinciActivityAfterTool("edit", true) === "Adjusting the approach…");

const launcher = await readFile(launcherSource, "utf8");
const identity = JSON.parse(await readFile(identitySource, "utf8"));
const launcherExtensions = [...launcher.matchAll(/--extension "\$\{VINCI\}\/extensions\/([^"]+)"/g)].map(
  (match) => match[1],
);
const launcherOrder = ["vinci-guard.ts", "vinci-loopbreak.ts", "vinci-shell.ts", "vinci-completion-receipt.ts"].map(
  (extension) => launcherExtensions.indexOf(extension),
);
const identityOrder = ["vinci-guard.ts", "vinci-loopbreak.ts", "vinci-shell.ts", "vinci-completion-receipt.ts"].map(
  (extension) => identity.extensions.indexOf(extension),
);
check(
  "blocking extensions load before shell and completion receipt remains last",
  launcherOrder.every((position) => position >= 0) &&
    launcherOrder.every((position, index) => index === 0 || launcherOrder[index - 1] < position) &&
    launcherExtensions.at(-1) === "vinci-completion-receipt.ts",
);
check(
  "identity extension order matches the launcher and blocker-before-shell lifecycle",
  JSON.stringify(identity.extensions) === JSON.stringify(launcherExtensions) &&
  identityOrder.every((position) => position >= 0) &&
    identityOrder.every((position, index) => index === 0 || identityOrder[index - 1] < position) &&
    identity.extensions.at(-1) === "vinci-completion-receipt.ts",
);

uiState.resetVinciUiState();
uiState.setVinciWorking(true);
uiState.setVinciActivity("verifying");
check("formal UI state records Verifying", uiState.getVinciUiState().activity === "verifying");
uiState.setVinciActivity("working");
check("formal UI state clears Verifying after a tool result", uiState.getVinciUiState().activity === "working");
uiState.setVinciWorking(false);
check("stopping work clears the activity state", uiState.getVinciUiState().activity === "idle");

const handlers = new Map();
shell.default({
  registerCommand() {},
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  on(eventName, handler) {
    handlers.set(eventName, handler);
  },
});
const emit = async (eventName, event, context) => {
  const handler = handlers.get(eventName);
  assert.equal(typeof handler, "function", `${eventName} handler must be registered`);
  await handler(event, context);
};

const shellContext = {
  cwd: process.cwd(),
  mode: "tui",
  ui: {
    setWorkingVisible() {},
    setFooter() {},
    setTitle() {},
    setEditorComponent() {},
  },
};

uiState.resetVinciUiState();
uiState.setVinciConnection("connected");
await emit("session_start", {}, shellContext);
check(
  "session_start preserves connection state published by earlier extensions",
  uiState.getVinciUiState().connection === "connected",
);

uiState.resetVinciUiState();
uiState.setVinciWorking(true);
const blockedLabels = [];
const unsubscribeBlocked = uiState.subscribeVinciUiState(() => {
  blockedLabels.push(uiState.getVinciUiState().workingLabel);
});
await emit("tool_execution_start", {
  toolCallId: "blocked-check",
  toolName: "bash",
  args: { command: "npm test" },
});
// An earlier extension blocks here under the real runner order, so shell's later tool_call handler
// is never invoked. The result/end events still arrive, but start must not expose Verifying.
await emit("tool_result", { toolCallId: "blocked-check", toolName: "bash", isError: true });
await emit("tool_execution_end", {
  toolCallId: "blocked-check",
  toolName: "bash",
  isError: true,
  result: { details: { vinciBlocked: true } },
});
unsubscribeBlocked();
check(
  "blocked checks never show Verifying under start-before-block event order",
  uiState.getVinciUiState().activity !== "verifying" &&
    blockedLabels.every((label) => label !== "Verifying the change…"),
);

uiState.resetVinciUiState();
uiState.setVinciWorking(true);
await emit("tool_execution_start", {
  toolCallId: "aborted-check",
  toolName: "bash",
  args: { command: "npm test" },
});
await emit("tool_call", { toolCallId: "aborted-check", toolName: "bash", input: { command: "npm test" } });
check(
  "executing checks show Verifying",
  uiState.getVinciUiState().activity === "verifying" &&
    uiState.getVinciUiState().workingLabel === "Verifying the change…",
);
await emit("tool_execution_end", {
  toolCallId: "aborted-check",
  toolName: "bash",
  isError: true,
  result: { details: { killed: true } },
});
check(
  "aborted checks clear Verifying",
  uiState.getVinciUiState().activity === "working" &&
    uiState.getVinciUiState().workingLabel !== "Verifying the change…",
);

uiState.resetVinciUiState();
uiState.setVinciWorking(true);
await emit("tool_execution_start", {
  toolCallId: "parallel-check",
  toolName: "rerun_check",
  args: {},
});
await emit("tool_call", { toolCallId: "parallel-check", toolName: "rerun_check", input: {} });
await emit("tool_execution_start", {
  toolCallId: "parallel-read",
  toolName: "read",
  args: { path: "package.json" },
});
await emit("tool_call", { toolCallId: "parallel-read", toolName: "read", input: { path: "package.json" } });
await emit("tool_execution_end", {
  toolCallId: "parallel-read",
  toolName: "read",
  isError: false,
  result: { content: [] },
});
await emit("tool_result", { toolCallId: "parallel-read", toolName: "read", isError: false });
check(
  "parallel reads cannot clobber Verifying",
  uiState.getVinciUiState().activity === "verifying" &&
    uiState.getVinciUiState().workingLabel === "Verifying the change…",
);
await emit("tool_execution_end", {
  toolCallId: "parallel-check",
  toolName: "rerun_check",
  isError: false,
  result: { content: [] },
});
check(
  "Verifying survives until its own call ends",
  uiState.getVinciUiState().activity === "working" &&
    uiState.getVinciUiState().workingLabel !== "Verifying the change…",
);

uiState.resetVinciUiState();
uiState.setVinciWorking(true);
await emit("tool_execution_start", {
  toolCallId: "concurrent-check-a",
  toolName: "rerun_check",
  args: {},
});
await emit("tool_call", { toolCallId: "concurrent-check-a", toolName: "rerun_check", input: {} });
await emit("tool_execution_start", {
  toolCallId: "concurrent-check-b",
  toolName: "bash",
  args: { command: "npm test" },
});
await emit("tool_call", { toolCallId: "concurrent-check-b", toolName: "bash", input: { command: "npm test" } });
await emit("tool_execution_end", {
  toolCallId: "concurrent-check-a",
  toolName: "rerun_check",
  isError: false,
  result: { content: [] },
});
check(
  "the first concurrent verification ending keeps Verifying active",
  uiState.getVinciUiState().activity === "verifying" &&
    uiState.getVinciUiState().workingLabel === "Verifying the change…",
);
await emit("tool_execution_end", {
  toolCallId: "concurrent-check-b",
  toolName: "bash",
  isError: false,
  result: { content: [] },
});
check(
  "the final concurrent verification ending clears Verifying",
  uiState.getVinciUiState().activity === "working" &&
    uiState.getVinciUiState().workingLabel !== "Verifying the change…",
);

uiState.resetVinciUiState();
uiState.setVinciWorking(true);
await emit("tool_execution_start", {
  toolCallId: "stale-check",
  toolName: "rerun_check",
  args: {},
});
await emit("tool_call", { toolCallId: "stale-check", toolName: "rerun_check", input: {} });
await emit("agent_start", {});
check(
  "agent_start clears stale Verifying state after a missing tool end",
  uiState.getVinciUiState().activity === "working" &&
    uiState.getVinciUiState().workingLabel === "Contemplating…",
);
await emit("tool_execution_end", {
  toolCallId: "stale-check",
  toolName: "rerun_check",
  isError: false,
  result: { content: [] },
});
check(
  "a late stale verification end cannot overwrite the reset UI state",
  uiState.getVinciUiState().activity === "working" &&
    uiState.getVinciUiState().workingLabel === "Contemplating…",
);
await emit("agent_end", {});

uiState.resetVinciUiState();
uiState.setVinciContinuationPending(true);
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const liveTimers = new Set();
globalThis.setTimeout = (callback) => {
  const timer = { callback };
  liveTimers.add(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  liveTimers.delete(timer);
};
globalThis.setInterval = (callback) => {
  const timer = { callback };
  liveTimers.add(timer);
  return timer;
};
globalThis.clearInterval = (timer) => {
  liveTimers.delete(timer);
};
try {
  await emit("agent_end", {});
  check("print-mode agent_end leaves no live continuation timers", liveTimers.size === 0);
  check(
    "print-mode agent_end clears continuation and working state immediately",
    !uiState.getVinciUiState().continuationPending && !uiState.getVinciUiState().working,
  );
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}

await emit("session_shutdown", {});

console.log(`\nshell-integration: ${pass}/${pass} checks passed (semantic activity and pulse)`);
