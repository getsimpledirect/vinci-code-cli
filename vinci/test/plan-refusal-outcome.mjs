import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = resolve(process.env.VINCI_REGRESSION_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const loader = createJiti(import.meta.url, { moduleCache: true, fsCache: false, tryNative: false });
const built = process.env.VINCI_REGRESSION_PAYLOAD === "built";
const modulePath = (name) => resolve(root, `vinci/${built ? "dist/extensions" : "extensions"}/${name}.${built ? "js" : "ts"}`);
const outcome = await loader.import(modulePath("lib/task-outcome"), { default: false });
const verification = await loader.import(modulePath("lib/verification-state"), { default: false });
const measureOnly = process.env.VINCI_PLAN_MEASURE_ONLY === "1";
const operations = existsSync(modulePath("lib/required-operations"))
  ? await loader.import(modulePath("lib/required-operations"), { default: false }) : undefined;
const reasons = [
  "Plan mode keeps plans in Vinci instead of writing project files.",
  "Plan mode kept the project unchanged; no approval UI is available.",
  "Plan mode kept the project unchanged.",
];
const savedReason = "No files changed: the attempted change did not go through.";
const askReason = "The final reply asks for your go-ahead — the work is holding for your answer.";
const cwd = process.cwd();
const call = (id = "change", tool = "write", args = tool === "bash" ? { command: "touch requested.txt" } : { path: "requested.txt", content: "requested" }) => ({
  role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: args }],
});
const result = (id = "change", text = reasons[1], details = { vinciBlocked: true }, tool = "write", isError = true) => ({
  role: "toolResult", toolCallId: id, toolName: tool, isError, details, content: [{ type: "text", text }],
});
const final = (ask = false) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: ask ? "Please confirm and I'll apply it." : savedReason }] });
const pending = (messages, prior = []) => operations.vinciRequiredOperations(messages, prior, cwd);
const saved = (messages, changedFiles = []) => {
  verification.resetVinciVerificationState();
  return outcome.buildVinciTaskOutcome({ taskId: "plan-refusal-outcome", messages, changedFiles, cwd, verification: verification.getVinciVerificationState() });
};
const check = (name, run) => {
  if (!process.env.VINCI_PLAN_CASE || name.includes(process.env.VINCI_PLAN_CASE)) test(name, run);
};
for (const ask of [false, true]) {
  check(`saved plan refusal ${ask ? "with a closing ask" : "without an ask"} preserves its outcome`, () => {
    const value = saved([call(), result(), final(ask)]);
    console.log(`Saved plan refusal ${ask ? "ask" : "no-ask"} measurement: ${JSON.stringify({ state: value.state, reason: value.reason })}`);
    if (!measureOnly) assert.deepEqual([value.state, value.reason], ask ? ["WAITING", askReason] : ["DONE", savedReason], "A saved plan refusal must preserve its measured state and reason.");
  });
}

const bashFailure = (id, text, details = {}) => result(id, text, details, "bash", true);
const bashSuccess = (id, execution = {}) => result(id, "completed", { execution: { exitCode: 0, cwd, originalCommand: true, ...execution } }, "bash", false);
const bashCase = (name, messages, expected, pin = true) => check(name, () => {
  const value = saved(messages);
  console.log(`Bash outcome measurement: ${JSON.stringify({ name, state: value.state, reason: value.reason })}`);
  if (!measureOnly && pin) assert.equal(value.state, expected, `${name} must save ${expected}.`);
});
for (const [name, execution, expected] of [
  ["command prefix", { originalCommand: false, nonOriginalReasons: ["commandPrefix"] }, "DONE"],
  ["shell path", { originalCommand: false, nonOriginalReasons: ["shellPath"] }, "DONE"],
  ["prefix and shell path", { originalCommand: false, nonOriginalReasons: ["commandPrefix", "shellPath"] }, "DONE"],
  ["operations", { originalCommand: false, nonOriginalReasons: ["operations"] }, "BLOCKED"],
  ["spawn hook", { originalCommand: false, nonOriginalReasons: ["spawnHook"] }, "BLOCKED"],
  ["prefix and spawn hook", { originalCommand: false, nonOriginalReasons: ["commandPrefix", "spawnHook"] }, "BLOCKED"],
  ["shell path and operations", { originalCommand: false, nonOriginalReasons: ["shellPath", "operations"] }, "BLOCKED"],
  ["empty reasons", { originalCommand: false, nonOriginalReasons: [] }, "BLOCKED"],
  ["missing reasons", { originalCommand: false }, "BLOCKED"],
  ["unknown reason", { originalCommand: false, nonOriginalReasons: ["unknown"] }, "BLOCKED"],
  ["string reasons", { originalCommand: false, nonOriginalReasons: "commandPrefix" }, "BLOCKED"],
  ["null reasons", { originalCommand: false, nonOriginalReasons: null }, "BLOCKED"],
  ["string original flag", { originalCommand: "true", nonOriginalReasons: [] }, "BLOCKED"],
]) bashCase(`bash retry with ${name}`, [
  call("failed", "bash"), bashFailure("failed", "Required command refused.", { vinciBlocked: true }),
  call("retry", "bash"), bashSuccess("retry", execution), final(),
], expected);

const denied = "/bin/bash: requested.txt: Operation not permitted";
const exited = (text, code = 1) => `${text}\n\nCommand exited with code ${code}`;
for (const [name, text, expected] of [
  ["grep no match", exited(""), "DONE"],
  ["sandbox startup failure", exited("sandbox-exec: sandbox_apply: Operation not permitted", 71), "BLOCKED"],
  ["sandbox denied write synthetic", exited(`COMMAND_REACHED\n${denied}`), "BLOCKED"],
  ["custom bash denial", exited("/opt/homebrew/bin/bash: requested.txt: Operation not permitted"), "BLOCKED"],
  ["bare bash denial boundary", exited("bash: requested.txt: Operation not permitted"), "DONE"],
  ["denial with leading text", exited(`prefix ${denied}`), "DONE"],
  ["denial with trailing text", exited(`${denied} suffix`), "DONE"],
  ["spawn failure", "spawn /missing/shell ENOENT", "BLOCKED"],
]) bashCase(`bash ${name}`, [call("bash", "bash"), bashFailure("bash", text), final()], expected);
bashCase("bash flagged refusal", [call("bash", "bash"), bashFailure("bash", exited("refused"), { vinciBlocked: true }), final()], "BLOCKED");
bashCase("bash successful synthetic identical retry", [
  call("failed", "bash"), bashFailure("failed", exited(`COMMAND_REACHED\n${denied}`)),
  call("retry", "bash"), bashSuccess("retry"), final(),
], "DONE");
bashCase("bash printed denial exit zero", [call("bash", "bash"), { ...bashSuccess("bash"), content: [{ type: "text", text: denied }] }, final()], "DONE");
// text match, spoofable by command output (case 6b); measured without pinning this residual.
bashCase("bash printed denial exit one residual", [call("bash", "bash"), bashFailure("bash", exited(denied)), final()], "BLOCKED", false);

if (built && !measureOnly) {
  const runtime = (name) => loader.import(resolve(root, `packages/coding-agent/dist/core/${name}.js`), { default: false });
  const { Agent } = await loader.import(resolve(root, "packages/agent/dist/agent.js"), { default: false });
  const { AgentSession } = await runtime("agent-session");
  const { AuthStorage } = await runtime("auth-storage");
  const { ModelRegistry } = await runtime("model-registry");
  const { SessionManager } = await runtime("session-manager");
  const { SettingsManager } = await runtime("settings-manager");
  const { createExtensionRuntime } = await runtime("extensions/loader");
  for (const [name, settings, expected] of [
    ["command prefix", { shellCommandPrefix: "true" }, ["commandPrefix"]],
    ["shell path", { shellPath: "/bin/bash" }, ["shellPath"]],
  ]) check(`built configured bash ${name}`, async () => {
    assert.notEqual(process.env.VINCI_CODE, "1", "Run the local shell fixture through the upstream execution path.");
    const agent = new Agent();
    const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
    const session = new AgentSession({
      agent, cwd, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(settings),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()), initialActiveToolNames: ["bash"],
      resourceLoader: {
        getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined,
        getAppendSystemPrompt: () => [], extendResources() {}, async reload() {},
      },
    });
    try {
      const tool = agent.state.tools.find((tool) => tool.name === "bash");
      assert.ok(tool, "The configured session must activate its built bash tool.");
      const completed = await tool.execute("retry", { command: "true" });
      assert.deepEqual(completed.details?.execution?.nonOriginalReasons, expected, "Configured shell settings must emit their non-original reasons.");
      const value = saved([
        call("failed", "bash", { command: "true" }), bashFailure("failed", "Required command refused.", { vinciBlocked: true }),
        call("retry", "bash", { command: "true" }), { role: "toolResult", toolCallId: "retry", toolName: "bash", isError: false, ...completed }, final(),
      ]);
      console.log(`Configured bash measurement: ${JSON.stringify({ name, execution: completed.details?.execution, state: value.state, reason: value.reason })}`);
      assert.equal(value.state, "DONE", "Configured shell settings must clear the successful identical retry.");
    } finally { session.dispose(); }
  });
}
if (!measureOnly) {
  check("plan refusals do not create required operations", () => {
    for (const reason of reasons) for (const tool of ["write", "edit", "bash"]) {
      assert.deepEqual(pending([call("change", tool), result("change", reason, { vinciBlocked: true }, tool)]), [], "A plan-mode refusal must not create a required operation.");
    }
  });
  check("exact plan text without its flag remains pending", () => {
    assert.equal(pending([call(), result("change", reasons[1], {})]).length, 1, "Exact plan text without the flag must remain pending.");
  });
  check("embedded plan text with its flag remains pending", () => {
    assert.equal(pending([call(), result("change", `Other failure: ${reasons[1]}`, { vinciBlocked: true })]).length, 1, "An embedded plan reason must remain pending.");
  });
  check("plan refusal preserves prior work and its reason", () => {
    const prior = pending([call(), result("change", "Earlier failure.")]);
    assert.deepEqual(pending([call(), result()], prior), prior, "Plan refusal must preserve prior pending work and its reason.");
  });
  check("plan refusal preserves a failed attempt in the same run", () => {
    const first = [call("first"), result("first", "Earlier failure.")];
    assert.deepEqual(pending([...first, call("retry"), result("retry")]), pending(first), "Plan refusal must preserve a same-run failed attempt and its reason.");
  });
  check("conflicting plan results remain pending", () => {
    assert.match(pending([call(), result("change", "Earlier failure."), result()])[0].reason, /conflicting tool results/, "Conflicting results must precede the plan-refusal exception.");
  });
  for (const tool of ["write", "edit", "bash"]) check(`saved refused ${tool} retains the attempted-change reason`, () => {
    const value = saved([call("change", tool), result("change", reasons[1], { vinciBlocked: true }, tool), final()]);
    assert.deepEqual([value.state, value.reason], ["DONE", savedReason], `A saved refused ${tool} must retain its attempted-change reason.`);
  });
  check("another extension's refusal still blocks", () => {
    const value = saved([call(), result("change", "Another extension refused this write."), final()]);
    assert.equal(value.state, "BLOCKED", "Another extension's refusal must remain blocked.");
  });
  check("approved writes still record real failures", async () => {
    const plan = await loader.import(modulePath("vinci-plan"), { default: false });
    const handlers = {};
    plan.default({ registerTool() {}, registerShortcut() {}, on(name, handler) { handlers[name] = handler; } });
    const context = { hasUI: true, ui: { confirm: async () => true, setStatus() {}, notify() {}, theme: { fg: (_color, text) => text, bold: (text) => text } } };
    await handlers.session_start({}, context);
    await handlers.input({ text: "Plan the requested change." }, context);
    assert.equal(await handlers.tool_call({ toolName: "write", input: { path: "requested.txt" } }, context), undefined, "An approved write must remain reachable.");
    assert.equal(pending([call(), result("change", "The approved write failed.", {})]).length, 1, "A real failure after plan approval must remain pending.");
  });
  const longTarget = `/${"t".repeat(148)}\n${"t".repeat(150)}`;
  const longFailure = `\n${"f".repeat(150)}\t${"f".repeat(149)}\nSecond failure must stay in the tool row.`;
  for (const [form, fixedLength, maximum, results] of [
    ["no completed tool result", 56, 261, () => []],
    ["conflicting tool results", 56, 261, (tool) => [result("bound", "First failure.", {}, tool), result("bound", "Different failure.", {}, tool)]],
    ["failed", 35, 440, (tool) => [result("bound", longFailure, {}, tool)]],
  ]) check(`bounded ${form} reason reaches its exact maximum`, () => {
    assert.equal(longTarget.length, 300, "The multiline target control must contain 300 characters.");
    assert.equal(longFailure.split(/\r?\n/).find((line) => line.trim()).length, 300, "The first non-empty failure line must contain exactly 300 characters.");
    for (const tool of ["read", "write", "edit", "bash"]) {
      const args = tool === "bash" ? { command: longTarget } : { path: longTarget, content: "requested" };
      const messages = [call("bound", tool, args), ...results(tool)];
      const [value] = pending(messages);
      const target = longTarget.replace(/\s+/g, " ").trim().slice(0, 200);
      const failure = longFailure.split(/\r?\n/).find((line) => line.trim()).replace(/\s+/g, " ").trim().slice(0, 200);
      assert.equal(target.length, 200, "The target control must reach its part bound.");
      assert.equal(failure.length, 200, "The failure control must reach its part bound.");
      assert.ok(!/\s/.test(target.at(-1) + failure.at(-1)), "The controls must have no whitespace at the display cut.");
      const expected = form === "failed" ? `Required ${tool} operation for "${target}" failed: ${failure}` : `Required ${tool} operation for "${target}" has ${form}.`;
      assert.ok(value.reason.length <= maximum && !/[\r\n]|\s{2}/.test(value.reason), `The ${form} reason must stay within its per-form maximum on one line.`);
      assert.equal(value.reason, expected, `The ${form} reason must retain the bounded parts and full fixed wording.`);
      if (tool.length === 5) assert.equal(value.reason.length, maximum, `The ${form} control must reach its exact maximum.`);
      assert.equal(value.target, longTarget, "The operation target must remain raw.");
      assert.equal(value.key, pending([call("bound", tool, args)])[0].key, "Display bounds must preserve operation identity.");
      console.log(`Reason bound measurement: ${JSON.stringify({ form, tool, length: value.reason.length, maximum, fixedLength: value.reason.length - tool.length - target.length - (form === "failed" ? failure.length : 0) })}`);
      assert.equal(value.reason.length - tool.length - target.length - (form === "failed" ? failure.length : 0), fixedLength, "The fixed wording count must match the measured form.");
      if (form === "failed") {
        assert.equal(messages[1].content[0].text, longFailure, "The full tool error must remain unchanged.");
        assert.match(saved([...messages, call("other", "bash", { command: "another required command" })]).reason, /1 other required operation remains unresolved\.$/, "The count must remain visible after a reason at the bound.");
      }
    }
  });
  check("150-char target keeps the full 68-char sandbox diagnostic", () => {
    const target = "t".repeat(150);
    const diagnostic = "bwrap: Failed to create NETLINK_ROUTE socket: Operation not permitted";
    assert.equal(diagnostic.length, 69, "The diagnostic control must retain all 69 fixture characters.");
    console.log(`Full diagnostic measurement: ${JSON.stringify({ targetLength: target.length, diagnosticLength: diagnostic.length })}`);
    const value = saved([call("long", "bash", { command: target }), bashFailure("long", diagnostic), final()]);
    assert.equal(value.state, "BLOCKED", "The required failed command must remain blocked.");
    assert.ok(value.reason.includes(target) && value.reason.includes(diagnostic), "A 150-char target must keep the full 68-char sandbox diagnostic.");
  });
  const longDenied = `/${"long/".repeat(50)}bash: requested.txt: Operation not permitted`;
  for (const [name, messages, expected] of [
    ["exit one", [call("long", "bash"), bashFailure("long", exited(longDenied))], "BLOCKED"],
    ["exit zero", [call("long", "bash"), { ...bashSuccess("long"), content: [{ type: "text", text: exited(longDenied, 0) }] }], "DONE"],
    ["successful identical retry", [call("long", "bash"), bashFailure("long", exited(longDenied)), call("retry", "bash"), bashSuccess("retry")], "DONE"],
  ]) check(`long sandbox denial uses raw text with ${name}`, () => {
    assert.ok(longDenied.length > 200 && !longDenied.slice(0, 200).includes("Operation not permitted"), "The denial control must put its classifier suffix beyond the display cut.");
    const value = saved([...messages, final()]);
    console.log(`Long denial measurement: ${JSON.stringify({ name, state: value.state, reason: value.reason })}`);
    assert.equal(value.state, expected, `A long sandbox denial with ${name} must save ${expected} from raw tool text.`);
    assert.ok(messages[1].content[0].text.includes(longDenied), "The raw tool diagnostic must remain complete.");
  });
}

// A completed checkpoint refuses replay while its paired required operation completes.
{
const checkpoint = await loader.import(modulePath("vinci-checkpoint"), { default: false });
const printMode = await loader.import(resolve(root, "packages/coding-agent/dist/modes/print-mode.js"), { default: false });
const control = await loader.import(modulePath("lib/control"), { default: false });
const verificationControl = await loader.import(modulePath("lib/verification-control"), { default: false });
const hardStop = await loader.import(modulePath("lib/hard-stop"), { default: false });
const crew = await loader.import(modulePath("lib/crew-status"), { default: false });
const usage = await loader.import(modulePath("lib/usage-accumulator"), { default: false });
const uiState = await loader.import(modulePath("lib/ui-state"), { default: false });
const receipt = await loader.import(modulePath("vinci-receipt"), { default: false });
let sequence = 0;
const assistant = (text, content = [{ type: "text", text }]) => ({
  role: "assistant", provider: "vinci", model: "vinci-fort", stopReason: "stop", timestamp: ++sequence,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.001 } }, content,
});
const call = (id, name, args) => assistant("", [{ type: "toolCall", id, name, arguments: args }]);
const failure = (id, name = "write", text = "The required write failed.") => ({
  role: "toolResult", toolCallId: id, toolName: name, isError: true,
  content: [{ type: "text", text }], details: { vinciBlocked: true }, timestamp: ++sequence,
});
const complete = () => assistant("The requested task is complete.");
function resetRecovery() {
  verification.resetVinciVerificationState();
  verificationControl.setVinciVerificationDisabledForSession(false);
  control.clearVinciAutomationStop();
  crew.resetVinciCrewStatus();
  hardStop.clearVinciHardStop("checkpoint-receipt");
  usage.resetVinciTaskUsage("checkpoint-receipt");
  uiState.resetVinciUiState();
  outcome.setVinciTaskOutcome(undefined);
}
function build(messages, options = {}) {
  return outcome.buildVinciTaskOutcome({ taskId: "checkpoint-receipt", messages, changedFiles: [], cwd,
    verification: verification.getVinciVerificationState(), ...options });
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
function contextFor(host, taskId) {
  let exitHint;
  return {
    context: { cwd, hasUI: false, mode: "print", getContextUsage: () => ({ percent: 0, tokens: 0 }),
      declareHeadlessExitHint(value) { exitHint = value; },
      sessionManager: { getBranch: () => host.branch, getSessionId: () => taskId },
      ui: { setStatus() {}, notify() {}, setWidget() {}, setTitle() {}, setFooter() {}, setWorkingVisible() {} },
    },
    get exitHint() { return exitHint; },
  };
}
async function checkpointRefusal(tool, args, recovered = true) {
  const host = registered(checkpoint.default);
  const state = contextFor(host, "checkpoint-recovery", false);
  await emit(host, "session_start", {}, state.context);
  host.branch.push({ type: "message", message: call("interrupted", tool, args) });
  const event = { type: "tool_call", toolCallId: "interrupted", toolName: tool, input: args };
  const handler = host.handlers.get("tool_call")[0];
  assert.equal(await handler(event, state.context), undefined, "The original checkpointed operation must remain reachable.");
  if (recovered) {
    await emit(host, "tool_execution_end", {
      toolCallId: "interrupted", toolName: tool, isError: false,
      result: { content: [{ type: "text", text: "Successfully completed." }] },
    }, state.context);
  }
  await emit(host, "session_start", {}, state.context);
  const refusal = await handler({ ...event, toolCallId: "replay" }, state.context);
  assert.equal(refusal?.block, true, "The restored checkpoint must refuse the exact replay.");
  assert.ok(host.branch.some((entry) => entry.data?.event === (recovered ? "recovered" : "uncertain")), "The intended recovery branch must be reached.");
  return refusal.reason;
}
async function checkpointReceipt(messages) {
  const host = registered(receipt.default);
  const state = contextFor(host, "checkpoint-receipt", false);
  await emit(host, "session_start", {}, state.context);
  await emit(host, "before_agent_start", { prompt: "Finish the requested operation." }, state.context);
  await emit(host, "agent_start", {}, state.context);
  await emit(host, "agent_end", { messages }, state.context);
  const saved = outcome.getVinciTaskOutcome();
  const exit = printMode.printModeExitCode({ mode: "text", lastMessage: messages.at(-1), submitted: ["Finish the requested operation."], headlessExitHint: state.exitHint }).exitCode;
  return { saved, exit };
}
check("checkpoint-recovered-write", async () => {
  for (const [tool, args] of [
    ["write", { path: "recovered.txt", content: "ready" }],
    ["edit", { path: "recovered.txt", oldText: "before", newText: "after" }],
    ["write", { path: "  padded.txt  ", content: "ready" }],
    ["write", { file_path: "  alias.txt  ", content: "ready" }],
    ["write", { path: `  ${"p".repeat(1001)}  `, content: "ready" }],
  ]) {
    resetRecovery();
    const text = await checkpointRefusal(tool, args);
    assert.equal(text, operations.vinciRecoveredMutationRefusal(tool, args), "The refusal and reader must share their path rule and text builder.");
    const messages = [call("replay", tool, args), failure("replay", tool, text), complete()];
    const { saved, exit } = await checkpointReceipt(messages);
    assert.equal(saved.state, "DONE", "a recovered write/edit replay must complete its required operation.");
    assert.deepEqual(saved.requiredOperations ?? [], [], "the paired recovered operation must be cleared.");
    assert.equal(exit, 0, "recovered completion must exit zero.");
    assert.equal(messages[1].isError, true, "The checkpoint refusal must retain its error flag.");
    assert.match(text, /already completed/, "The checkpoint refusal must retain its recovery guidance.");
  }
});
check("checkpoint-prior-recovered-write", async () => {
  resetRecovery();
  const args = { path: "prior-recovered.txt", content: "ready" };
  const prior = build([call("original", "write", args), failure("original"), complete()]);
  assert.equal(prior.requiredOperations.length, 1, "the same operation must already be pending in prior.");
  const text = await checkpointRefusal("write", args);
  const saved = build([call("replay", "write", args), failure("replay", "write", text), complete()], { priorOperations: prior.requiredOperations });
  assert.equal(saved.state, "DONE", "a prior-carried recovered operation must be deleted, never restored.");
  assert.deepEqual(saved.requiredOperations ?? [], [], "prior must not retain the paired recovered key.");
});
check("checkpoint-uncertain-write", async () => {
  resetRecovery();
  const args = { path: "uncertain-recovery.txt", content: "ready" };
  const text = await checkpointRefusal("write", args, false);
  assert.match(text, /interrupted.*Read the current target file/, "The test must reach the uncertain refusal.");
  const { saved, exit } = await checkpointReceipt([call("replay", "write", args), failure("replay", "write", text), complete()]);
  assert.equal(saved.state, "BLOCKED", "an uncertain replay must remain BLOCKED.");
  assert.equal(exit, 3, "an uncertain replay must exit nonzero.");
});
check("checkpoint-other-operation", async () => {
  for (const samePath of [true, false]) {
    resetRecovery();
    const first = { path: "other-operation.txt", content: "first content" };
    const replay = { path: samePath ? first.path : "different-operation.txt", content: "different content" };
    const text = await checkpointRefusal("write", replay);
    const messages = [call("pending", "write", first), call("replay", "write", replay), failure("replay", "write", text), complete()];
    const saved = build(messages);
    assert.equal(saved.state, "BLOCKED", "refusing another operation must retain the pending operation, including the same path with different content.");
    assert.deepEqual(saved.requiredOperations.map((operation) => operation.key), operations.vinciRequiredOperations([call("pending", "write", first)], [], cwd).map((operation) => operation.key), "only the refused replay's full-argument key may be cleared.");
  }
});
check("checkpoint-unmarked-text", async () => {
  resetRecovery();
  const args = { path: "unmarked-recovery.txt", content: "ready" };
  const text = await checkpointRefusal("write", args);
  const unmarked = failure("replay", "write", text);
  delete unmarked.details;
  assert.equal(build([call("replay", "write", args), unmarked, complete()]).state, "BLOCKED", "matching tool output without the structured signal must remain BLOCKED.");
});
check("checkpoint-malformed-signal", async () => {
  resetRecovery();
  const args = { path: "malformed-recovery.txt", content: "ready" };
  const text = await checkpointRefusal("write", args);
  for (const details of [undefined, null, {}, [], "blocked", { vinciBlocked: null }, { vinciBlocked: "true" }, { vinciBlocked: 1 }, { vinciBlocked: false }]) {
    const refused = { ...failure("replay", "write", text), details };
    assert.equal(build([call("replay", "write", args), refused, complete()]).state, "BLOCKED", "missing, null and wrong-type signals must remain BLOCKED.");
  }
  for (const wrongText of [text + " ", operations.vinciRecoveredMutationRefusal("edit", args), operations.vinciRecoveredMutationRefusal("write", { ...args, path: "another.txt" })]) {
    assert.equal(build([call("replay", "write", args), failure("replay", "write", wrongText), complete()]).state, "BLOCKED", "the paired tool, raw path and complete refusal text must match exactly.");
  }
});
check("checkpoint-recovered-bash", async () => {
  resetRecovery();
  const args = { command: "printf ready" };
  const text = await checkpointRefusal("bash", args);
  assert.match(text, /shell command.*already completed/, "The test must reach the recovered bash refusal.");
  const { saved, exit } = await checkpointReceipt([call("replay", "bash", args), failure("replay", "bash", text), complete()]);
  assert.equal(saved.state, "BLOCKED", "a recovered bash refusal without exit and cwd facts must remain BLOCKED.");
  assert.equal(exit, 3, "a recovered bash refusal must exit nonzero.");
});

}
