import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(process.env.VINCI_REGRESSION_ROOT || resolve(here, "../..")));
const payload = process.env.VINCI_REGRESSION_PAYLOAD || "source";
assert.ok(["source", "built"].includes(payload), "Select the source or built payload.");
const extensionRoot = resolve(root, payload === "built" ? "vinci/dist/extensions" : "vinci/extensions");
const suffix = payload === "built" ? ".js" : ".ts";
const packages = Object.fromEntries([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
].map((name) => {
  const packageRoot = realpathSync(resolve(root, "node_modules", name));
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const entrypoint = manifest.exports?.["."]?.import ?? manifest.main;
  assert.equal(typeof entrypoint, "string", `${name} must declare its runtime import entrypoint.`);
  const path = realpathSync(resolve(packageRoot, entrypoint));
  assert.ok(!relative(root, path).startsWith(".."), `${name} must resolve inside the selected root.`);
  assert.ok(path.includes("/dist/"), `${name} must use its selected built entrypoint.`);
  console.log(`Resolved package ${name}: ${path}`);
  return [name, path];
}));
const loader = createJiti(import.meta.url, { moduleCache: true, fsCache: false, tryNative: false });
if (payload === "built") {
  const identityPath = resolve(root, "vinci/dist/source-identity.json");
  const sourceRoot = realpathSync(resolve(process.env.VINCI_REGRESSION_SOURCE_ROOT || root));
  assert.ok(existsSync(identityPath), "The selected runtime needs its source identity.");
  process.stdout.write(execFileSync(process.execPath, [
    resolve(sourceRoot, "vinci/scripts/build-source-identity.mjs"), "check", sourceRoot, identityPath,
  ], { encoding: "utf8" }));
}
async function module(name) {
  const path = realpathSync(resolve(extensionRoot, `${name}${suffix}`));
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  console.log(`Resolved ${payload} module ${name}: ${path}; SHA-256 ${digest}`);
  return loader.import(path, { default: false });
}
const outcome = await module("lib/task-outcome");
const operations = await module("lib/required-operations");
const verification = await module("lib/verification-state");
const control = await module("lib/control");
const verificationControl = await module("lib/verification-control");
const hardStop = await module("lib/hard-stop");
const crew = await module("lib/crew-status");
const usage = await module("lib/usage-accumulator");
const uiState = await module("lib/ui-state");
const vero = await module("lib/vero-state");
const receipt = await module("vinci-receipt");
const shell = await module("vinci-shell");
const themeModule = await loader.import(resolve(root, "packages/coding-agent/dist/modes/interactive/theme/theme.js"), { default: false });
const keybindingsPath = realpathSync(resolve(root, "packages/coding-agent/dist/core/keybindings.js"));
console.log(`Resolved keybindings module: ${keybindingsPath}`);
const { KeybindingsManager } = await loader.import(keybindingsPath, { default: false });
const printMode = await loader.import(resolve(root, "packages/coding-agent/dist/modes/print-mode.js"), { default: false });
const assistantMessagePath = realpathSync(resolve(root, "packages/coding-agent/dist/modes/interactive/components/assistant-message.js"));
console.log(`Resolved assistant message component: ${assistantMessagePath}`);
const { AssistantMessageComponent } = await loader.import(assistantMessagePath, { default: false });
themeModule.initTheme("dark", false);
const theme = themeModule.theme;
const plain = (text) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const scratch = mkdtempSync(resolve(process.env.VINCI_REGRESSION_TMP || tmpdir(), "vinci-required-operations-"));
const cwd = resolve(scratch, "project");
mkdirSync(cwd);
const sandboxError = "bwrap: Failed to create NETLINK_ROUTE socket: Operation not permitted";
let sequence = 0;
function assistant(text, content = [{ type: "text", text }], overrides = {}) {
  return {
    role: "assistant", provider: "vinci", model: "vinci-fort", stopReason: "stop", timestamp: ++sequence,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.001 } },
    content, ...overrides,
  };
}
const call = (id, name = "write", args = { path: "output.ts", content: "export const ready = true;" }) =>
  assistant("", [{ type: "toolCall", id, name, arguments: args }]);
const result = (id, name = "write", overrides = {}) => ({
  role: "toolResult", toolCallId: id, toolName: name, isError: false,
  content: [{ type: "text", text: "Successfully completed the requested operation." }], timestamp: ++sequence,
  ...overrides,
});
const failure = (id, name = "write", text = sandboxError) => result(id, name, {
  isError: true, content: [{ type: "text", text }], details: { vinciBlocked: true },
});
const complete = () => assistant("The requested task is complete.");
const failedWrite = () => [call("write-failure"), failure("write-failure"), complete()];
function reset(taskId = "required-operation-test") {
  verification.resetVinciVerificationState();
  verificationControl.setVinciVerificationDisabledForSession(false);
  control.clearVinciAutomationStop();
  crew.resetVinciCrewStatus();
  hardStop.clearVinciHardStop(taskId);
  usage.resetVinciTaskUsage(taskId);
  uiState.resetVinciUiState();
  outcome.setVinciTaskOutcome(undefined);
}
function build(messages, options = {}) {
  return outcome.buildVinciTaskOutcome({
    taskId: "required-operation-test", messages, changedFiles: [], cwd,
    verification: verification.getVinciVerificationState(), ...options,
  });
}
function assertRequiredFailure(value, tool = "write", reason = sandboxError, target = "output.ts") {
  assert.equal(value.state, "BLOCKED", "An unresolved required operation must persist BLOCKED.");
  assert.match(value.reason, new RegExp(`Required ${tool} operation`), "The required operation must own the reason.");
  assert.ok(value.reason.includes(target), "The blocker must identify the requested target.");
  assert.ok(value.reason.includes(reason), "The blocker must retain the tool diagnostic.");
}
function registered(register) {
  const handlers = new Map();
  const commands = new Map();
  const branch = [];
  const api = {
    on(name, handler) { const entries = handlers.get(name) || []; entries.push(handler); handlers.set(name, entries); },
    registerCommand(name, definition) { commands.set(name, definition); },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }); },
    async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
  };
  register(api);
  return { handlers, commands, branch, api };
}
async function emit(host, name, event, context) {
  const handlers = host.handlers.get(name) || [];
  for (const handler of handlers) await handler({ type: name, ...event }, context);
}
function contextFor(host, taskId, hasUI = true) {
  const widgets = new Map();
  const notifications = [];
  let editor;
  let exitHint;
  const context = {
    cwd, hasUI, mode: hasUI ? "tui" : "print", model: { name: "Offline", provider: "vinci", id: "vinci-fort" },
    getContextUsage: () => ({ percent: 0, tokens: 0 }),
    declareHeadlessExitHint(value) { exitHint = value; },
    sessionManager: { getBranch: () => host.branch, getSessionId: () => taskId },
    ui: {
      theme, setWorkingVisible() {}, setFooter() {}, setTitle() {},
      notify(text, level) { notifications.push({ text, level }); },
      setWidget(name, value) { if (value) widgets.set(name, value); else widgets.delete(name); },
      setEditorComponent(factory) {
        editor = factory({ requestRender() {}, terminal: { rows: 40, columns: 140 } }, themeModule.getEditorTheme(), new KeybindingsManager());
      },
    },
  };
  return {
    context, notifications, widgets,
    get exitHint() { return exitHint; },
    renderReceipt() {
      const factory = widgets.get("vinci-receipt");
      assert.equal(typeof factory, "function", "The registered receipt must install its widget.");
      return plain(factory({}, theme).render(140).join("\n"));
    },
    renderEditor() { assert.ok(editor, "The shell must install its actual editor."); return plain(editor.render(140).join("\n")); },
  };
}
const cases = new Map();
const test = (name, body) => cases.set(name, body);

test("blocked-before-mutation", () => {
  reset();
  assertRequiredFailure(build(failedWrite()));
});
test("read-only", () => {
  reset();
  const messages = [call("read-1", "read", { path: "input.ts" }), result("read-1", "read"), complete()];
  assert.equal(build(messages).state, "DONE", "Completed read-only requests must remain DONE.");
  assert.equal(build([complete()]).state, "DONE", "A prose-only completed request must remain DONE.");
});
test("equivalent-retry", () => {
  reset();
  const messages = [...failedWrite().slice(0, -1), call("write-retry"), result("write-retry"), complete()];
  assert.equal(build(messages).state, "DONE", "An equivalent successful retry must clear its failed write.");
  for (const tool of ["edit", "read"]) {
    const args = tool === "edit" ? { path: "output.ts", oldText: "old", newText: "new" } : { path: "input.ts" };
    const retry = [call("first", tool, args), failure("first", tool), call("retry", tool, args), result("retry", tool), complete()];
    assert.equal(build(retry).state, "DONE", `An equivalent ${tool} retry must clear only that operation.`);
  }
});
test("correlation", () => {
  reset();
  const unrelated = [...failedWrite().slice(0, -1), call("other", "write", { path: "other.ts", content: "export const ready = true;" }), result("other"), complete()];
  const partial = build(unrelated, { changedFiles: ["other.ts"] });
  assertRequiredFailure(partial);
  assert.deepEqual(partial.changedFiles, ["other.ts"], "Partial success must retain its changed files.");
  const changedError = [...failedWrite().slice(0, -1), call("retry"), failure("retry", "write", "Disk quota exceeded"), complete()];
  assertRequiredFailure(build(changedError), "write", "Disk quota exceeded");
  assertRequiredFailure(build([call("write-1"), result("unrelated-id"), complete()]), "write", "no completed tool result");
  const args = { path: "output.ts", oldText: "old", newText: "new" };
  assertRequiredFailure(build([call("edit-1", "edit", args), failure("edit-1", "edit"), complete()]), "edit");
});
test("shell-write-redirect", () => {
  reset();
  const args = { command: "printf 'fixture bytes\\n' > requested.txt" };
  const refused = [call("shell-write", "bash", args), failure("shell-write", "bash")];
  const redirects = new Set(["shell-write"]);
  for (const tool of ["write", "edit"]) {
    const input = tool === "write" ? { path: "requested.txt", content: "fixture bytes\n" }
      : { path: "requested.txt", oldText: "old", newText: "fixture bytes\n" };
    const recovery = [call("structured-write", tool, input), result("structured-write", tool)];
    assert.deepEqual(operations.vinciRequiredOperations([...refused, ...recovery, complete()], [], cwd, undefined, redirects), [], "A later successful structured tool must resolve a recorded shell redirect.");
    assert.equal(operations.vinciRequiredOperations([...refused, complete()], [], cwd, undefined, redirects).length, 1, "A redirect without a structured recovery remains pending.");
    assert.equal(operations.vinciRequiredOperations([...refused, ...recovery, complete()], [], cwd).length, 1, "An unrelated bash refusal remains pending despite a successful write.");
    assert.equal(operations.vinciRequiredOperations([...recovery, ...refused, complete()], [], cwd, undefined, redirects).length, 1, "An earlier successful write cannot resolve a later shell redirect.");
    assert.equal(operations.vinciRequiredOperations([...refused, recovery[0], failure("structured-write", tool), complete()], [], cwd, undefined, redirects).length, 2, "A failed structured recovery leaves both operations pending.");
    assert.equal(operations.vinciRequiredOperations([...refused, recovery[0], result("structured-write", tool, { content: [{ type: "text", text: "No changes" }] }), complete()], [], cwd, undefined, redirects).length, 2, "A soft failure cannot resolve the redirect.");
    assert.equal(operations.vinciRequiredOperations([...refused, ...recovery, failure("structured-write", tool), complete()], [], cwd, undefined, redirects).length, 2, "Conflicting recovery results cannot attest a successful write.");
    assert.equal(operations.vinciRequiredOperations([refused[0], result("shell-write", "bash", { isError: true }), ...recovery, complete()], [], cwd, undefined, redirects).length, 1, "A recorded ID without vinciBlocked must retain the failed bash operation.");
    const prior = operations.vinciRequiredOperations([call("earlier-bash", "bash", args), failure("earlier-bash", "bash")], [], cwd);
    assert.deepEqual(operations.vinciRequiredOperations([...refused, ...recovery, complete()], prior, cwd, undefined, redirects), prior, "Resolving a redirect must restore any earlier pending operation with the same arguments.");
    const repeated = [...refused, call("shell-write-again", "bash", args), failure("shell-write-again", "bash"), ...recovery, complete()];
    assert.deepEqual(operations.vinciRequiredOperations(repeated, [], cwd, undefined, new Set([...redirects, "shell-write-again"])), [], "A successful structured recovery must resolve both recorded redirects.");
    assert.equal(operations.vinciRequiredOperations(repeated, [], cwd, undefined, redirects).length, 1, "A later unrecorded refusal with identical arguments must remain pending.");
    const conflicted = [refused[0], refused[1], failure("shell-write", "bash", "Vinci blocked a different shell-based file write."), ...recovery, complete()];
    assert.equal(operations.vinciRequiredOperations(conflicted, [], cwd, undefined, redirects).length, 1, "A redirect with conflicting tool results must remain pending despite a successful write.");
  }
});
test("shell-write-redirect-scope", () => {
  const taskId = "shell-write-redirect-scope";
  reset(taskId);
  outcome.clearVinciGitCheckpointDeclines(taskId);
  const messages = [call("shell-write", "bash", { command: "printf 'fixture bytes\\n' > requested.txt" }), failure("shell-write", "bash"), call("structured-write"), result("structured-write"), complete()];
  try {
    assert.equal(build(messages, { taskId }).state, "BLOCKED", "The ID must first be recorded by the guard.");
    outcome.recordVinciShellWriteRedirectToolCall(taskId, "shell-write");
    assert.equal(build(messages, { taskId }).state, "DONE", "Recorded redirects must reach the task classifier.");
    assert.equal(build(messages, { taskId: `${taskId}-other` }).state, "BLOCKED", "Redirect IDs must stay scoped to their task.");
    outcome.clearVinciGitCheckpointDeclines(taskId);
    assert.equal(build(messages, { taskId }).state, "BLOCKED", "A fresh request must clear redirect IDs with checkpoint-decline IDs.");
  } finally {
    outcome.clearVinciGitCheckpointDeclines(taskId);
  }
});
test("required-read", () => {
  reset();
  assertRequiredFailure(build([call("read-1", "read", { path: "input.ts" }), failure("read-1", "read", "File is unavailable"), complete()]), "read", "File is unavailable", "input.ts");
});
test("bash", () => {
  reset();
  const args = { command: "generate output.ts", timeout: 10 };
  const failed = [call("bash-1", "bash", args), failure("bash-1", "bash")];
  assertRequiredFailure(build([...failed, complete()]), "bash", sandboxError, args.command);
  const execution = { exitCode: 0, originalCommand: true, cwd };
  assert.equal(build([...failed, call("bash-2", "bash", { ...args, timeout: 60 }), result("bash-2", "bash", { details: { execution } }), complete()]).state, "DONE", "Bash retry timeouts do not change the required operation.");
  for (const changed of [{ exitCode: 1 }, { exitCode: "0" }, { originalCommand: "true" }, { originalCommand: false }, { cwd: `${cwd}/other` }]) {
    assert.equal(build([...failed, call("bash-2", "bash", args), result("bash-2", "bash", { details: { execution: { ...execution, ...changed } } }), complete()]).state, "BLOCKED", "Unattested bash execution must not clear a required command.");
  }
  assert.equal(build([...failed, call("bash-2", "bash", args), result("bash-2", "bash"), complete()]).state, "BLOCKED", "A bash result without execution evidence must not clear the operation.");
});
test("malformed", () => {
  reset();
  for (const id of [undefined, null, 0, ""]) {
    assert.equal(build([call(id), result(id), complete()]).state, "BLOCKED", "Missing or invalid call IDs cannot attest completion.");
  }
  for (const overrides of [{ toolCallId: undefined }, { toolCallId: null }, { toolCallId: 7 }, { toolName: "read" }, { content: null }, { content: "success" }, { content: [null] }, { content: [{ type: "text" }] }, { content: [{ type: "text", text: null }] }, { isError: "false" }, { isError: null }, { details: "success" }, { details: [] }, { details: { vinciBlocked: "false" } }]) {
    assert.equal(build([call("write-1"), result("write-1", "write", overrides), complete()]).state, "BLOCKED", "Malformed result evidence cannot attest completion.");
  }
  for (const args of [undefined, null, [], "output.ts", { path: null }, { path: 1 }]) {
    const malformedCall = call("write-1");
    malformedCall.content[0].arguments = args;
    assert.equal(build([malformedCall, result("write-1"), complete()]).state, "BLOCKED", "A missing requested target cannot be paired by ID alone.");
  }
  assert.equal(build([call("write-1"), complete()]).state, "BLOCKED", "An interrupted tool call remains unfinished.");
  assert.equal(build([call("same"), call("same", "write", { path: "other.ts" }), result("same"), complete()]).state, "BLOCKED", "Duplicate call IDs must not resolve different requests.");
  assert.equal(build([call("old"), failure("old"), call("new"), result("new"), failure("old"), complete()]).state, "DONE", "A late result for an older attempt cannot undo the successful equivalent retry.");
  assert.equal(build([call("old"), call("new"), failure("new"), result("old"), complete()]).state, "BLOCKED", "An older attempt success cannot erase the newer equivalent retry failure.");
  assert.equal(build([call("write-1"), failure("write-1"), result("write-1"), complete()]).state, "BLOCKED", "Conflicting duplicate results must not erase failure.");
  assert.equal(build([call("write-1"), result("write-1"), result("write-1"), complete()]).state, "DONE", "Identical duplicate success is idempotent.");
  assert.equal(build([null, undefined, 1, { role: "assistant", content: null }, complete()]).state, "DONE", "Unrelated malformed entries must not invent an operation.");
});
test("duplicate-calls", () => {
  reset();
  const first = { path: "first.ts", content: "first" };
  const second = { path: "second.ts", content: "second" };
  const messages = [
    call("duplicate", "write", first),
    call("duplicate", "write", second),
    result("duplicate"),
    call("second-retry", "write", second),
    result("second-retry"),
    complete(),
  ];
  const saved = build(messages);
  assert.equal(saved.state, "BLOCKED", "A duplicate call ID must retain the first operation after only the second operation recovers.");
  assert.match(saved.reason, /Required write operation.*first\.ts.*conflicting tool results/);
  assert.equal(saved.requiredOperations.length, 1, "Only the first operation remains unresolved after the second succeeds.");
  assert.equal(saved.requiredOperations[0].target, resolve(cwd, first.path));
});
test("soft-failures", () => {
  reset();
  for (const text of ["could not find the exact text", "validation failed", "No changes", "overlap", "must match exactly"]) {
    assertRequiredFailure(build([call("edit-1", "edit", { path: "output.ts", oldText: "old", newText: "new" }), result("edit-1", "edit", { isError: undefined, content: [{ type: "text", text }] }), complete()]), "edit", text);
  }
  for (const details of [undefined, null]) {
    assert.equal(build([call("write-1"), result("write-1", "write", { isError: undefined, details }), complete()]).state, "DONE", "Legacy unflagged successful results remain compatible.");
  }
  assert.equal(build([call("edit-1", "edit", { path: "overlap.ts", oldText: "old", newText: "new" }), result("edit-1", "edit", { content: [{ type: "text", text: "Successfully replaced 1 block(s) in overlap.ts." }] }), complete()]).state, "DONE", "Success text mentioning overlap is not a soft failure.");
});
test("heading", () => {
  reset();
  const actual = build([assistant("## Status: blocked by sandbox")]);
  assert.equal(actual.state, "BLOCKED", "A top-level Markdown status heading must be recognized.");
  assert.match(actual.reason, /blocked:? by sandbox/i);
  for (const text of ["> ## Status: blocked by sandbox", "`## Status: blocked by sandbox`", "    ## Status: blocked by sandbox", "```text\n## Status: blocked by sandbox\n```", "```text\n## Status: blocked by sandbox", "````text\n## Status: blocked by sandbox\n```", "~~~text\n## Status: blocked by sandbox\n~~"]) {
    assert.equal(build([assistant(`${text}\n\nThe explanation is complete.`)]).state, "DONE", "Quoted and code status examples must remain examples.");
  }
});
test("cancellation", () => {
  reset();
  assert.equal(build([assistant("", [], { stopReason: "aborted", errorMessage: "The request was cancelled." })]).state, "BLOCKED", "An interrupted request remains blocked.");
  verification.recordVinciMutation();
  verification.recordVinciVerification("npm test", true, "The direct check passed.");
  const interrupted = assistant("", [], { stopReason: "aborted", errorMessage: "The provider stopped." });
  assert.equal(build([interrupted], { changedFiles: ["verified.ts"] }).state, "DONE", "A verified completed mutation keeps the interrupted wrap-up exception.");
  assertRequiredFailure(build([...failedWrite().slice(0, -1), interrupted], { changedFiles: ["verified.ts"] }));
});
test("persistence-readers", async () => {
  const taskId = "required-operation-persistence";
  reset(taskId);
  const host = registered(receipt.default);
  const state = contextFor(host, taskId);
  await emit(host, "session_start", { reason: "startup" }, state.context);
  await emit(host, "before_agent_start", { prompt: "Create output.ts." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  const messages = failedWrite();
  messages.forEach((message) => host.branch.push({ type: "message", message }));
  await emit(host, "agent_end", { messages }, state.context);
  const saved = host.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
  assertRequiredFailure(saved);
  assert.equal(state.exitHint, 3, "The registered receipt must set the conservative process exit hint.");
  assert.equal(printMode.printModeExitCode({ mode: "text", lastMessage: messages.at(-1), submitted: ["Create output.ts."], headlessExitHint: state.exitHint }).exitCode, 3, "The actual print-mode exit reader must honor the receipt hint.");
  assert.match(state.renderReceipt(), /Stopped — needs you/);
  assert.ok(state.renderReceipt().replace(/\s+/g, " ").includes(sandboxError), "The actual receipt must retain the operation diagnostic.");
  await host.commands.get("usage").handler("", state.context);
  assert.match(state.notifications.at(-1).text, /State: Stopped — needs you/, "The registered usage reader must show the persisted state.");
  outcome.setVinciTaskOutcome(undefined);
  uiState.resetVinciUiState();
  const resumedHost = registered(receipt.default);
  resumedHost.branch.push(...JSON.parse(JSON.stringify(host.branch)));
  const resumed = contextFor(resumedHost, taskId);
  usage.installVinciUsageAccumulator(resumedHost.api);
  await emit(resumedHost, "session_start", { reason: "resume" }, resumed.context);
  assertRequiredFailure(outcome.getVinciTaskOutcome());
  assert.match(resumed.renderReceipt(), /Stopped — needs you/);
  assert.equal(vero.getVeroPresentation().label, "BLOCKED", "Vero must read the restored blocker without a live UI latch.");
  const shellHost = registered(shell.default);
  await emit(shellHost, "session_start", {}, resumed.context);
  assert.match(resumed.renderEditor(), /BLOCKED/, "The actual reopened shell editor must show the persisted blocker.");
  await emit(shellHost, "session_shutdown", {}, resumed.context);
  await resumedHost.commands.get("usage").handler("", resumed.context);
  assert.match(resumed.notifications.at(-1).text, /State: Stopped — needs you/, "Usage after restore must retain the blocker.");
  const beforeLateEntries = resumedHost.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).length;
  const beforeLateCalls = outcome.getVinciTaskOutcome().usage.modelCalls;
  assert.equal(usage.recordVinciTaskCall(taskId, assistant("Late metering response"), "late-metering"), true);
  assert.equal(resumedHost.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).length, beforeLateEntries + 1, "Late metering must append an actual replacement outcome.");
  assert.equal(outcome.getVinciTaskOutcome().usage.modelCalls, beforeLateCalls + 1, "Late metering must increase the saved call count.");
  assertRequiredFailure(outcome.getVinciTaskOutcome());
  const late = resumedHost.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
  assertRequiredFailure(late);
  assert.deepEqual(late.requiredOperations, saved.requiredOperations, "Late usage replacement must retain required-operation metadata.");
  await emit(resumedHost, "before_agent_start", { prompt: "Continue the unfinished request." }, resumed.context);
  await emit(resumedHost, "agent_start", {}, resumed.context);
  await emit(resumedHost, "agent_end", { messages: [complete()] }, resumed.context);
  assertRequiredFailure(outcome.getVinciTaskOutcome());
});
test("late-usage-continuation", async () => {
  const taskId = "required-operation-late-continuation";
  reset(taskId);
  const operation = {
    key: "unfinished-write", tool: "write", target: resolve(cwd, "output.ts"),
    reason: `Required write operation for "${resolve(cwd, "output.ts")}" failed: ${sandboxError}`,
  };
  const saved = { ...build([complete()], { taskId }), state: "BLOCKED", reason: operation.reason, requiredOperations: [operation] };
  const host = registered(receipt.default);
  host.branch.push({ type: "custom", customType: outcome.VINCI_TASK_OUTCOME_ENTRY, data: JSON.parse(JSON.stringify(saved)) });
  usage.installVinciUsageAccumulator(host.api);
  const state = contextFor(host, taskId, false);
  await emit(host, "session_start", { reason: "resume" }, state.context);
  const beforeCalls = outcome.getVinciTaskOutcome().usage.modelCalls;
  const beforeEntries = host.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).length;
  assert.equal(usage.recordVinciTaskCall(taskId, assistant("Late metering response"), "late-metering"), true);
  assert.equal(host.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).length, beforeEntries + 1, "Late usage must append a complete replacement outcome.");
  assert.equal(outcome.getVinciTaskOutcome().usage.modelCalls, beforeCalls + 1, "Late usage must increase the replacement's call count.");
  const late = host.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
  assert.deepEqual(late.requiredOperations, saved.requiredOperations, "Late usage replacement must retain required-operation metadata.");
  outcome.setVinciTaskOutcome(undefined);
  const resumedHost = registered(receipt.default);
  resumedHost.branch.push(...JSON.parse(JSON.stringify(host.branch)));
  const resumed = contextFor(resumedHost, taskId, false);
  await emit(resumedHost, "session_start", { reason: "resume" }, resumed.context);
  await emit(resumedHost, "before_agent_start", { prompt: "Continue the unfinished request." }, resumed.context);
  await emit(resumedHost, "agent_start", {}, resumed.context);
  await emit(resumedHost, "agent_end", { messages: [complete()] }, resumed.context);
  assert.equal(outcome.getVinciTaskOutcome().state, "BLOCKED", "Continuing after a late usage replacement must retain the unfinished required operation.");
  assertRequiredFailure(outcome.getVinciTaskOutcome());
});
test("live-equivalent-retry", async () => {
  const taskId = "required-operation-live-retry";
  reset(taskId);
  const host = registered((api) => { receipt.default(api); shell.default(api); });
  const state = contextFor(host, taskId);
  const args = { path: "recovery.txt", content: "ready" };
  const firstCall = call("relative-write", "write", args);
  const firstFailure = failure("relative-write");
  const retryCall = call("absolute-write", "write", { ...args, path: resolve(cwd, args.path) });
  const retrySuccess = result("absolute-write");
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create recovery.txt." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  try {
    await emit(host, "tool_result", { ...firstFailure, input: args }, state.context);
    assert.ok(uiState.getVinciUiState().blockingReason, "The failed write must publish its live blocker.");
    await emit(host, "agent_end", { messages: [firstCall, firstFailure, complete()] }, state.context);
    assert.match(state.renderEditor(), /BLOCKED/, "The live editor must display the structured write failure.");
    await emit(host, "before_agent_start", { prompt: "Continue the unfinished request." }, state.context);
    await emit(host, "agent_start", {}, state.context);
    writeFileSync(resolve(cwd, args.path), args.content);
    await emit(host, "tool_result", { ...retrySuccess, input: retryCall.content[0].arguments }, state.context);
    assert.ok(!uiState.getVinciUiState().blockingReason, "The live editor must clear a successful equivalent absolute-path retry.");
    const messages = [retryCall, retrySuccess, complete()];
    await emit(host, "agent_end", { messages }, state.context);
    assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "The equivalent live retry must persist DONE.");
    assert.deepEqual(outcome.getVinciTaskOutcome().changedFiles, ["recovery.txt"], "The receipt must retain the successful retry's changed file.");
    assert.match(state.renderEditor(), /DONE/, "The terminal editor must agree with persisted completion.");
    assert.match(state.renderReceipt(), /✓ Done/, "The actual receipt must agree with the terminal editor.");
  } finally {
    await emit(host, "session_shutdown", {}, state.context);
    rmSync(resolve(cwd, args.path), { force: true });
  }
});
test("remote-pass", async () => {
  const taskId = "required-operation-remote";
  reset(taskId);
  assert.equal(verification.recordRemoteAcceptanceVerdict({
    jobId: "snapshot-verification", snapshotDigest: "sha256:snapshot", status: "VERIFIED_PASS",
    summary: "Remote acceptance passed for the submitted snapshot.",
  }), true, "The remote positive control must record a current verdict.");
  const current = verification.getVinciVerificationState();
  const built = build(failedWrite(), { taskId, verification: current });
  assertRequiredFailure(built);
  const remote = verification.currentRemoteVerdict(current);
  assert.equal(remote.status, "VERIFIED_PASS", "The remote verdict remains available as separate evidence.");
  const shown = receipt.remoteVerdictDisplay(JSON.parse(JSON.stringify(built)), remote);
  assert.equal(shown.state, "BLOCKED", "The receipt display must retain the required-operation blocker beside a remote pass.");
  assertRequiredFailure(shown);
  assert.match(shown.reason, /Remote acceptance passed/, "The rendered reason must retain remote evidence alongside the blocker.");
  const host = registered(receipt.default);
  const state = contextFor(host, taskId, false);
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create output.ts." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  await emit(host, "agent_end", { messages: failedWrite() }, state.context);
  assert.equal(state.exitHint, 3, "Remote pass cannot launder a failed operation into a successful process result.");
  const resumed = contextFor(host, taskId);
  await emit(host, "session_start", { reason: "resume" }, resumed.context);
  assert.match(resumed.renderReceipt(), /Stopped — needs you/, "The actual resumed receipt must retain the local blocker alongside a remote pass.");
  assert.match(resumed.renderReceipt(), /Remote acceptance passed/, "The actual receipt retains remote evidence.");
});
test("plain-ask", async () => {
  const taskId = "plain-ask-completion";
  reset(taskId);
  const host = registered(receipt.default);
  const state = contextFor(host, taskId);
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Explain the next step." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  await emit(host, "agent_end", { messages: [assistant("This step is waiting on your go-ahead to proceed.")] }, state.context);
  assert.equal(outcome.getVinciTaskOutcome().state, "WAITING", "A closing ask without a required operation keeps the existing WAITING behavior.");
  assert.match(state.renderReceipt(), /Waiting for you/);
});
test("closing-ask", async () => {
  const taskId = "required-operation-closing-ask";
  reset(taskId);
  const host = registered((api) => { receipt.default(api); shell.default(api); });
  const state = contextFor(host, taskId);
  const args = { path: "approval.txt", content: "ready" };
  const closingAsk = "This step is waiting on your go-ahead to proceed with the requested change.";
  const final = assistant(closingAsk);
  const failed = failure("approval-write", "write", "outside the project folder");
  const messages = [call("approval-write", "write", args), failed, final];
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create approval.txt." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  try {
    await emit(host, "tool_result", { ...failed, input: args }, state.context);
    messages.forEach((message) => host.branch.push({ type: "message", message }));
    await emit(host, "agent_end", { messages }, state.context);
    const saved = host.branch.filter((entry) => entry.customType === outcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
    assert.equal(saved.state, "BLOCKED", "A refused required write with a closing ask must persist BLOCKED.");
    assert.match(saved.reason, /Required write operation.*approval\.txt.*outside the project folder/);
    assert.equal(saved.requiredOperations.length, 1);
    assert.match(state.renderEditor(), /BLOCKED/);
    const transcript = plain(new AssistantMessageComponent(final).render(140).join("\n"));
    const interactive = [transcript, state.renderReceipt(), state.renderEditor()].join("\n").replace(/\s+/g, " ");
    if (!interactive.includes(closingAsk)) {
      const error = new Error("The interactive terminal did not display the closing ask beside BLOCKED.");
      error.stop = true;
      throw error;
    }
    assert.match(interactive, /BLOCKED/, "The interactive ask must remain visible alongside the BLOCKED editor.");
    assert.equal(verification.recordRemoteAcceptanceVerdict({ jobId: "approval-snapshot", snapshotDigest: "sha256:approval-snapshot", status: "VERIFIED_PASS", summary: "Remote snapshot passed." }), true);
    await emit(host, "session_shutdown", {}, state.context);
    const resumedHost = registered((api) => { receipt.default(api); shell.default(api); });
    resumedHost.branch.push(...JSON.parse(JSON.stringify(host.branch)));
    const resumed = contextFor(resumedHost, taskId);
    await emit(resumedHost, "session_start", { reason: "resume" }, resumed.context);
    try {
      assert.equal(outcome.getVinciTaskOutcome().state, "BLOCKED", "A closing-ask blocker must survive persistence restore beside a remote pass.");
      assert.match(resumed.renderReceipt(), /Stopped — needs you/);
      assert.match(resumed.renderReceipt(), /Remote snapshot passed/);
      await resumedHost.commands.get("usage").handler("", resumed.context);
      assert.match(resumed.notifications.at(-1).text, /State: Stopped — needs you/);
      assert.match(resumed.renderEditor(), /BLOCKED/);
      const restoredFinal = resumedHost.branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1).message;
      const restoredTranscript = plain(new AssistantMessageComponent(restoredFinal).render(140).join("\n"));
      if (![restoredTranscript, resumed.renderReceipt(), resumed.renderEditor()].join(" ").replace(/\s+/g, " ").includes(closingAsk)) {
        const error = new Error("The restored interactive terminal did not display the closing ask beside BLOCKED.");
        error.stop = true;
        throw error;
      }
    } finally {
      await emit(resumedHost, "session_shutdown", {}, resumed.context);
    }
  } finally {
    await emit(host, "session_shutdown", {}, state.context);
  }
});
test("go-ahead-live", async () => {
  const taskId = "required-operation-live-approval";
  reset(taskId);
  // The live assertion cannot be satisfied by a persisted receipt fallback.
  const host = registered(shell.default);
  const state = contextFor(host, taskId);
  const args = { path: "output.ts", content: "ready" };
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create output.ts." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  try {
    await emit(host, "tool_result", { ...failure("live-approval"), input: args }, state.context);
    await emit(host, "agent_end", {}, state.context);
    await emit(host, "before_agent_start", { prompt: "go ahead" }, state.context);
    await emit(host, "agent_start", {}, state.context);
    await emit(host, "agent_end", {}, state.context);
    assert.match(state.renderEditor(), /BLOCKED/, "A go-ahead without retry must retain the live BLOCKED line.");
    assert.ok(uiState.getVinciUiState().blockingReason.includes("output.ts"), "The carried live blocker must name its required target.");
  } finally {
    await emit(host, "session_shutdown", {}, state.context);
  }
});
test("go-ahead-saved", async () => {
  for (const prompt of ["yes", "y", "yep", "ok", "okay", "sure", "go ahead", "proceed", "approved", "do it", "please do", "yes please", "please proceed", "yes go ahead", "yes, go ahead", " YES! ", "Go Ahead."]) {
    const taskId = "required-operation-saved-approval";
    reset(taskId);
    const host = registered(receipt.default);
    const state = contextFor(host, taskId, false);
    await emit(host, "session_start", {}, state.context);
    await emit(host, "before_agent_start", { prompt: "Create output.ts." }, state.context);
    await emit(host, "agent_start", {}, state.context);
    await emit(host, "agent_end", { messages: failedWrite() }, state.context);
    await emit(host, "before_agent_start", { prompt }, state.context);
    await emit(host, "agent_start", {}, state.context);
    await emit(host, "agent_end", { messages: [complete()] }, state.context);
    assert.equal(outcome.getVinciTaskOutcome().state, "BLOCKED", "A go-ahead without retry must retain the saved BLOCKED outcome.");
    assertRequiredFailure(outcome.getVinciTaskOutcome());
  }
});
test("go-ahead-retry", async () => {
  const taskId = "required-operation-approved-retry";
  reset(taskId);
  const host = registered((api) => { receipt.default(api); shell.default(api); });
  const state = contextFor(host, taskId);
  const args = { path: "approved.txt", content: "ready" };
  const failed = failure("approved-first");
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create approved.txt." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  try {
    await emit(host, "tool_result", { ...failed, input: args }, state.context);
    await emit(host, "agent_end", { messages: [call("approved-first", "write", args), failed, complete()] }, state.context);
    await emit(host, "before_agent_start", { prompt: "go ahead" }, state.context);
    await emit(host, "agent_start", {}, state.context);
    writeFileSync(resolve(cwd, args.path), args.content);
    const success = result("approved-retry");
    await emit(host, "tool_result", { ...success, input: args }, state.context);
    await emit(host, "agent_end", { messages: [call("approved-retry", "write", args), success, complete()] }, state.context);
    assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "A go-ahead followed by an equivalent successful retry must complete.");
    assert.deepEqual(outcome.getVinciTaskOutcome().changedFiles, ["approved.txt"]);
    assert.ok(!uiState.getVinciUiState().blockingReason, "An approved equivalent retry must clear its live blocker.");
    assert.match(state.renderEditor(), /DONE/);
  } finally {
    await emit(host, "session_shutdown", {}, state.context);
    rmSync(resolve(cwd, args.path), { force: true });
  }
});
test("unrelated-request", async () => {
  for (const prompt of ["Summarize the previous request.", "yes, and also explain configuration", "no"]) {
    const taskId = "required-operation-independent-request";
    reset(taskId);
    const host = registered((api) => { receipt.default(api); shell.default(api); });
    const state = contextFor(host, taskId);
    await emit(host, "session_start", {}, state.context);
    await emit(host, "before_agent_start", { prompt: "Create output.ts." }, state.context);
    await emit(host, "agent_start", {}, state.context);
    try {
      await emit(host, "tool_result", { ...failure("write-failure"), input: { path: "output.ts", content: "export const ready = true;" } }, state.context);
      await emit(host, "agent_end", { messages: failedWrite() }, state.context);
      await emit(host, "before_agent_start", { prompt }, state.context);
      await emit(host, "agent_start", {}, state.context);
      await emit(host, "agent_end", { messages: [complete()] }, state.context);
      assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "An unrelated request must not carry the previous operation into its saved outcome.");
      assert.ok(!uiState.getVinciUiState().blockingReason, "An unrelated request must not carry the previous operation into the live line.");
    } finally {
      await emit(host, "session_shutdown", {}, state.context);
    }
  }
});
test("yes-without-operation", async () => {
  const taskId = "approval-without-operation";
  reset(taskId);
  const host = registered((api) => { receipt.default(api); shell.default(api); });
  const state = contextFor(host, taskId);
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "yes" }, state.context);
  await emit(host, "agent_start", {}, state.context);
  try {
    await emit(host, "agent_end", { messages: [complete()] }, state.context);
    assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "A yes without an unresolved operation retains the existing completion behavior.");
    assert.ok(!uiState.getVinciUiState().blockingReason);
  } finally {
    await emit(host, "session_shutdown", {}, state.context);
  }
});
test("verified-partial-success", async () => {
  const taskId = "verified-partial-operation";
  reset(taskId);
  const host = registered(receipt.default);
  const state = contextFor(host, taskId, false);
  const successful = { path: "completed.ts", content: "export const ready = true;" };
  const pending = { path: "unfinished.ts", content: "export const ready = true;" };
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create both requested files." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  try {
    writeFileSync(resolve(cwd, successful.path), successful.content);
    verification.recordVinciMutation();
    verification.recordVinciVerification("npm test", true, "The direct check passed.");
    const messages = [call("completed", "write", successful), result("completed"), call("unfinished", "write", pending), failure("unfinished"), complete()];
    await emit(host, "agent_end", { messages }, state.context);
    const saved = outcome.getVinciTaskOutcome();
    assert.equal(saved.state, "BLOCKED", "A passed check and partial success cannot complete an unresolved required operation.");
    assert.deepEqual(saved.changedFiles, ["completed.ts"]);
    assert.equal(saved.verificationStatus, "passed");
    assert.ok(saved.reason.includes("unfinished.ts"));
  } finally {
    rmSync(resolve(cwd, successful.path), { force: true });
  }
});
test("multiple-operations", async () => {
  for (const count of [2, 3]) {
    const taskId = "multiple-required-operations";
    reset(taskId);
    const host = registered(receipt.default);
    const state = contextFor(host, taskId, false);
    await emit(host, "session_start", {}, state.context);
    await emit(host, "before_agent_start", { prompt: "Create the requested files." }, state.context);
    await emit(host, "agent_start", {}, state.context);
    const messages = [];
    for (let index = 0; index < count; index++) {
      messages.push(call(`pending-${index}`, "write", { path: `pending-${index}.ts`, content: "ready" }), failure(`pending-${index}`));
    }
    messages.push(complete());
    await emit(host, "agent_end", { messages }, state.context);
    const saved = outcome.getVinciTaskOutcome();
    assert.equal(saved.state, "BLOCKED");
    assert.ok(saved.reason.includes("pending-0.ts"), "The blocker must name the first unresolved operation without reordering it.");
    const additional = count - 1;
    assert.ok(saved.reason.includes(`${additional} other required operation${additional === 1 ? " remains" : "s remain"} unresolved.`), "The blocked reason must count the other required operations.");
    assert.equal(saved.requiredOperations.length, count);
  }
});
test("metadata", () => {
  reset();
  const historical = { ...build([complete()]), state: "DONE", reason: "No files changed: the attempted change did not go through." };
  delete historical.requiredOperations;
  assert.equal(outcome.isVinciTaskOutcome(historical), true, "Historical outcomes without required-operation metadata remain readable.");
  outcome.setVinciTaskOutcome(JSON.parse(JSON.stringify(historical)));
  assert.equal(outcome.getVinciTaskOutcome().reason, historical.reason, "Historical reason prose must remain unchanged.");
  assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "Historical false-DONE outcomes must not be migrated from prose.");
  assert.equal(outcome.isVinciTaskOutcome({ ...historical, requiredOperations: [] }), true, "An empty additive operation list remains valid.");
  const valid = { key: "operation", tool: "write", target: "output.ts", reason: "The required tool did not complete." };
  assert.equal(outcome.isVinciTaskOutcome({ ...historical, requiredOperations: [valid] }), true, "A complete additive operation record remains readable.");
  for (const requiredOperations of [null, {}, "operation", [null], [1], [{}], [{ ...valid, key: "" }], [{ ...valid, tool: null }], [{ ...valid, target: [] }], [{ ...valid, reason: undefined }]]) {
    assert.equal(outcome.isVinciTaskOutcome({ ...historical, requiredOperations }), false, "Malformed optional operation metadata must be rejected.");
  }
});
test("request-scope", async () => {
  const taskId = "required-operation-continuation";
  reset(taskId);
  const host = registered(receipt.default);
  const state = contextFor(host, taskId, false);
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Create output.ts." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  await emit(host, "agent_end", { messages: failedWrite() }, state.context);
  const restored = JSON.parse(JSON.stringify(host.branch));
  outcome.setVinciTaskOutcome(undefined);
  const resumedHost = registered(receipt.default);
  resumedHost.branch.push(...restored);
  const resumed = contextFor(resumedHost, taskId, false);
  await emit(resumedHost, "session_start", { reason: "resume" }, resumed.context);
  await emit(resumedHost, "before_agent_start", { prompt: "Continue the unfinished request." }, resumed.context);
  await emit(resumedHost, "agent_start", {}, resumed.context);
  await emit(resumedHost, "agent_end", { messages: [complete()] }, resumed.context);
  assertRequiredFailure(outcome.getVinciTaskOutcome());
  await emit(resumedHost, "before_agent_start", { prompt: "What was the previous request?" }, resumed.context);
  await emit(resumedHost, "agent_start", {}, resumed.context);
  await emit(resumedHost, "agent_end", { messages: [assistant("The previous request was to create output.ts.")] }, resumed.context);
  assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "An independent recall does not inherit the previous request's operation.");
  const historical = { ...build([complete()]), state: "DONE", reason: "No files changed: the attempted change did not go through." };
  delete historical.requiredOperations;
  assert.equal(outcome.isVinciTaskOutcome(historical), true, "Historical outcomes without additive metadata remain readable.");
  outcome.setVinciTaskOutcome(JSON.parse(JSON.stringify(historical)));
  assert.equal(outcome.getVinciTaskOutcome().state, "DONE", "Historical outcome reasons must not be migrated into new blockers.");
});

const selected = new Set((process.env.VINCI_REGRESSION_CASE || "").split(",").filter(Boolean));
for (const name of selected) assert.ok(cases.has(name), `Unknown regression case: ${name}`);
console.log("Earlier guards neutralized: verification reset; verification enabled; no hard stop, crew work, automation stop, or status prose in structured-failure fixtures.");
let passed = 0;
let failed = 0;
try {
  for (const [name, body] of cases) {
    if (selected.size && !selected.has(name)) continue;
    try {
      await body();
      passed++;
      console.log(`GREEN ${name}`);
    } catch (error) {
      failed++;
      console.log(`RED ${name}: ${error.message}`);
      console.log(error.stack);
      if (error.stop) { console.log(`STOP ${name}: ${error.message}`); break; }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`required-operations-integration: ${passed} passed, ${failed} failed; payload=${payload}`);
process.exitCode = failed || process.exitCode ? 1 : 0;
