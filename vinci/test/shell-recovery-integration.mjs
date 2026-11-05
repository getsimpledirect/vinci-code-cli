// Source fixture: actual registered shell consumer, explicit Jiti src/index alias, no provider calls.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { TUI } from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";

const sourceIndex = fileURLToPath(new URL("../../packages/coding-agent/src/index.ts", import.meta.url));
const loader = createJiti(import.meta.url, {
  moduleCache: false, fsCache: false, tryNative: false,
  alias: { "@earendil-works/pi-coding-agent": sourceIndex },
});
const shell = await loader.import(fileURLToPath(new URL("../extensions/vinci-shell.ts", import.meta.url)));
const state = await loader.import(fileURLToPath(new URL("../extensions/lib/ui-state.ts", import.meta.url)));
const handlers = new Map();
shell.default({
  registerCommand() {},
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  on: (name, handler) => handlers.set(name, handler),
});
const context = {
  cwd: process.cwd(), model: { provider: "faux" },
  ui: { setWorkingVisible() {}, setFooter() {}, setTitle() {}, setEditorComponent() {} },
};
let passed = 0;
let toolSequence = 0;
const toolCallId = () => `shell-tool-${++toolSequence}`;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`  ✓ ${name}`); };
const emit = async (name, event) => { await handlers.get(name)(event, context); };
const start = async () => { state.resetVinciUiState(); await emit("session_start", {}); };
const message = (stopReason, errorMessage, provider = "faux") => ({ message: { role: "assistant", provider, stopReason, errorMessage } });

try {
  for (const [error, action, reconnect] of [
    ["401 Unauthorized: expired token", "/login", true],
    ["403 Forbidden", "Check access", false],
    ["402 balance_exhausted", "balance", false],
    ["No credits available", "balance", false],
    ["503 Service Unavailable", "Wait", false],
    ["The selected provider is unavailable", "Wait", false],
  ]) {
    await start();
    await emit("agent_start", {});
    const failed = message("error", error);
    await emit("message_end", failed);
    await emit("agent_end", {});
    check(`${error} retains the actual failure and its separate recovery action`, state.getVinciUiState().blockingReason.includes(error) && state.getVinciUiState().blockingReason.includes(action));
    check(`${error} changes connection only for observed authentication failure`, (state.getVinciUiState().connection === "reconnect") === reconnect);
    await emit("agent_start", {});
    await emit("message_end", message("aborted", "Request was aborted"));
    check(`${error} remains blocked across activity start and aborted output`, state.getVinciUiState().blockingReason.includes(error));
    await emit("message_end", message("stop", undefined, "different-faux-provider"));
    check(`${error} is not cleared by another provider's response`, state.getVinciUiState().blockingReason.includes(error));
    check(`${error} does not report the selected connection as recovered from another provider`, state.getVinciUiState().connection === (reconnect ? "reconnect" : "unknown"));
    await emit("message_end", message("stop"));
    check(`${error} clears only after a successful response from the same provider`, !state.getVinciUiState().blockingReason && state.getVinciUiState().connection === "connected");
    check(`${error} does not rewrite the canonical failure into a success`, failed.message.stopReason === "error" && failed.message.errorMessage === error);
  }

  await start();
  const blockedWrite = { toolCallId: toolCallId(), toolName: "write", input: { path: "owned.txt", content: "owned" }, isError: true, content: [{ type: "text", text: "Vinci could not write inside its scoped sandbox: denied path." }] };
  await emit("tool_result", blockedWrite);
  await emit("agent_start", {});
  await emit("message_end", message("stop"));
  check("a provider answer and new activity cannot clear a failed sandbox write", state.getVinciUiState().blockingReason.includes("scoped sandbox"));
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "write", input: { path: "other.txt", content: "owned" }, isError: false, content: [] });
  check("writing another target cannot clear the denied target", !!state.getVinciUiState().blockingReason);
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "read", input: { path: "owned.txt" }, isError: false, content: [] });
  check("reading the denied write target does not prove write remediation", !!state.getVinciUiState().blockingReason);
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "write", input: { path: "owned.txt", content: "owned" }, isError: false, content: [] });
  check("a successful write to the denied target clears its own blocker", !state.getVinciUiState().blockingReason);

  await start();
  await emit("tool_result", blockedWrite);
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "write", input: { path: "owned.txt", content: "different request" }, isError: false, content: [] });
  check("a different mutation of the same path cannot clear the required write", !!state.getVinciUiState().blockingReason);
  await emit("tool_result", { toolName: "write", input: { path: "owned.txt", content: "owned" }, isError: false, content: [] });
  check("a missing result ID cannot attest that the required write recovered", !!state.getVinciUiState().blockingReason);
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "write", input: { path: "owned.txt", content: "owned" }, content: [{ type: "text", text: "No changes: validation failed." }] });
  check("a soft write failure cannot clear the required mutation", !!state.getVinciUiState().blockingReason);
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "write", input: { path: resolve(context.cwd, "owned.txt"), content: "owned" }, isError: false, content: [] });
  check("an absolute-path equivalent retry clears a relative-path write failure", !state.getVinciUiState().blockingReason);


  await start();
  const repeatedId = toolCallId();
  await emit("tool_result", { toolCallId: repeatedId, toolName: "write", input: { path: "first.txt", content: "first" }, isError: false, content: [] });
  check("a valid first result is not blocked before an ID is reused", !state.getVinciUiState().blockingReason);
  await emit("tool_result", { toolCallId: repeatedId, toolName: "write", input: { path: "second.txt", content: "second" }, isError: false, content: [] });
  check("reusing a successful result ID for a different operation cannot attest its completion", !!state.getVinciUiState().blockingReason);

  await start();
  const input = { command: "printf bounded-fixture" };
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "bash", input, isError: true, content: [{ type: "text", text: "Sandbox backend refused the command." }] });
  for (const execution of [undefined, { exitCode: null, originalCommand: true, cwd: context.cwd }, { exitCode: 0, originalCommand: false, cwd: context.cwd }, { exitCode: 0, originalCommand: true }]) {
    await emit("tool_result", { toolCallId: toolCallId(), toolName: "bash", input, isError: false, content: [], details: { execution } });
    check("an unknown, signalled or substituted Bash result does not clear sandbox refusal", !!state.getVinciUiState().blockingReason);
  }
  await emit("tool_result", { toolCallId: toolCallId(), toolName: "bash", input, isError: false, content: [], details: { execution: { exitCode: 0, originalCommand: true, cwd: context.cwd } } });
  check("a measured original-command Bash exit zero clears its own sandbox refusal", !state.getVinciUiState().blockingReason);

  await start();
  await emit("message_end", message("error", "503 Service Unavailable"));
  state.setVinciBlocker("An independently published authority blocker.");
  await emit("message_end", message("stop"));
  check("successful provider remediation preserves another extension's current blocker", state.getVinciUiState().blockingReason === "An independently published authority blocker.");
  check("canonical tool failure remains failed with unchanged content", blockedWrite.isError && blockedWrite.content[0].text.includes("scoped sandbox"));

  const { initTheme, theme, getEditorTheme } = await loader.import(
    fileURLToPath(new URL("../../packages/coding-agent/src/modes/interactive/theme/theme.ts", import.meta.url)),
  );
  const { KeybindingsManager } = await loader.import(
    fileURLToPath(new URL("../../packages/coding-agent/src/core/keybindings.ts", import.meta.url)),
  );
  const { VirtualTerminal } = await loader.import(
    fileURLToPath(new URL("../../packages/tui/test/virtual-terminal.ts", import.meta.url)),
  );
  initTheme("dark", false);
  const terminal = new VirtualTerminal(120, 40);
  const tui = new TUI(terminal);
  let editor;
  const renderContext = {
    ...context,
    mode: "tui",
    getContextUsage: () => ({ percent: null, tokens: null }),
    ui: {
      ...context.ui,
      theme,
      setEditorComponent(factory) { editor = factory(tui, getEditorTheme(), new KeybindingsManager()); },
    },
  };
  state.resetVinciUiState();
  await handlers.get("session_start")({}, renderContext);
  const renderTool = async (event) => handlers.get("tool_result")(event, renderContext);
  const renderedEditor = () => stripVTControlCharacters(editor.render(120).join("\n"));
  await renderTool(blockedWrite);
  check("the actual live editor displays a structured required-operation failure", renderedEditor().includes("BLOCKED"));
  await renderTool({ toolCallId: toolCallId(), toolName: "write", input: { path: resolve(context.cwd, "owned.txt"), content: "owned" }, isError: false, content: [] });
  check("the actual live editor clears after an equivalent absolute-path retry", !renderedEditor().includes("BLOCKED"));
  for (const [connection, label] of [
    ["signed-in", "auth saved"],
    ["connected", "connected"],
    ["reconnect", "reconnect"],
    ["signed-out", "/login"],
    ["unknown", "checking"],
  ]) {
    state.setVinciConnection(connection);
    const rendered = stripVTControlCharacters(editor.render(120).join("\n"));
    check(`the registered composer gives ${connection} its distinct honest label`, rendered.includes(label));
    check(`the registered composer preserves Ask Vinci for ${connection}`, rendered.includes("Ask Vinci"));
    if (connection === "signed-in") {
      check("a saved credential neither claims a connected provider nor rewrites its internal enum", !rendered.includes("connected") && !rendered.includes("signed in") && state.getVinciUiState().connection === "signed-in");
    }
  }
} finally {
  await emit("session_shutdown", {});
  state.resetVinciUiState();
}
console.log(`shell-recovery-integration: ${passed}/${passed} source-fixture checks passed; provider and physical-terminal qualification require their own runs.`);
