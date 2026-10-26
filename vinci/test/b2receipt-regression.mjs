import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Source aliases keep these offline rendering tests independent of a workspace build.
// No CLI launch, provider, git subprocess, socket, or tsx is used.
const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": resolve(root, "packages/tui/src/index.ts") },
  moduleCache: false,
  tryNative: false,
});
const receipt = await loader.import(resolve(root, "vinci/extensions/vinci-receipt.ts"), { default: false });
const accept = await loader.import(resolve(root, "vinci/extensions/vinci-accept.ts"), { default: false });
const outcome = await loader.import(resolve(root, "vinci/extensions/lib/task-outcome.ts"), { default: false });
const accumulator = await loader.import(resolve(root, "vinci/extensions/lib/usage-accumulator.ts"), { default: false });
const tui = await loader.import(resolve(root, "packages/tui/src/utils.ts"), { default: false });

const calls = [];
const theme = {
  fg(color, text) {
    calls.push({ color, text });
    return text;
  },
  bold: (text) => text,
};
const verification = { status: "none", command: "", summary: "", mutationRevision: 0, verifiedRevision: -1, recoveryAttempts: 0 };
const message = (overrides = {}) => ({
  role: "assistant", provider: "vinci", model: "forte", responseModel: "zai-org/GLM-5.3",
  responseId: "b2-response", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "Done." }],
  usage: { input: 100, output: 20, cacheRead: 100, cacheWrite: 0, reasoning: 0, totalTokens: 220, cost: { total: 0.0465 } },
  ...overrides,
});

function harness(messages = [], taskId = "b2-rendering") {
  const handlers = {};
  const commands = {};
  const notifications = [];
  let widget;
  const saved = outcome.buildVinciTaskOutcome({ taskId, messages, changedFiles: ["parser.ts"], verification });
  const branch = [
    { type: "custom", customType: "vinci-session-baseline", data: { root, files: [] } },
    ...messages.map((message) => ({ type: "message", message })),
    { type: "custom", customType: outcome.VINCI_TASK_OUTCOME_ENTRY, data: saved },
  ];
  receipt.default({
    on(name, handler) { (handlers[name] ??= []).push(handler); },
    registerCommand(name, command) { commands[name] = command; },
    appendEntry() { assert.fail("render-only fixture must not persist or inspect git"); },
  });
  outcome.setVinciTaskOutcome(saved);
  const ctx = {
    hasUI: true, cwd: root,
    model: { name: "Vinci Forte", id: "forte", provider: "vinci" },
    sessionManager: { getBranch: () => branch, getSessionId: () => taskId },
    ui: { theme, notify: (text) => notifications.push(text), setWidget: (_name, value) => { widget = value; } },
  };
  return { handlers, commands, notifications, ctx, branch, saved, widget: () => widget };
}

test("F-05 acceptance only renders success for an issued pass", async () => {
  let tool;
  accept.default({ registerTool(value) { tool = value; } });
  assert.equal(typeof tool.renderResult, "function", "Acceptance Verification needs a neutral renderer for checks that did not run");
  assert.equal(tool.renderShell, "self", "neutral results cannot inherit a successful tool panel");
  const render = (text, details, options = {}, context = {}) => {
    calls.length = 0;
    return tool.renderResult({ content: [{ type: "text", text }], details }, { expanded: false, isPartial: false, ...options }, theme, context).render(56).join("\n");
  };
  const missing = render("Verification isn't set up yet.", { exitCode: 127, latchRecorded: false });
  assert.match(missing, /not set up|isn't set up/);
  assert.doesNotMatch(missing, /✓/);
  assert.equal(calls.some(({ color }) => color === "success"), false);
  const savedVac = process.env.VAC_CLI_PATH;
  try {
    process.env.VAC_CLI_PATH = resolve(root, "vinci/test/does-not-exist-vac");
    const result = await tool.execute("b2-no-vac", { action: "verify" }, undefined);
    const rendered = render(result.content[0].text, result.details);
    assert.match(rendered, /isn't set up yet/);
    assert.doesNotMatch(rendered, /✓/);
  } finally {
    if (savedVac === undefined) delete process.env.VAC_CLI_PATH;
    else process.env.VAC_CLI_PATH = savedVac;
  }
  for (const [text, details, options, context] of [
    ["unsafe argument", { validationError: "unsafe argument", latchRecorded: false }],
    ['{"status":"RUNNING"}', { exitCode: 0, latchRecorded: true }],
    ['{"status":"CANCELLED"}', { exitCode: 0, latchRecorded: true }],
    ['{"status":"CONDITIONAL"}', { exitCode: 0, latchRecorded: true }],
    ['{"status":"FAILED"}', { exitCode: 0, latchRecorded: true }],
    ['{"status":"VERIFIED_PASS"}', { exitCode: 0, latchRecorded: false }],
    ['{"status":"VERIFIED_PASS"}', { exitCode: 1, latchRecorded: true }],
    ['{"status":"VERIFIED_PASS"}', { exitCode: 0, latchRecorded: true }, { isPartial: true }],
    ['{"status":"VERIFIED_PASS"}', { exitCode: 0, latchRecorded: true }, {}, { isError: true }],
    ["", undefined],
  ]) {
    assert.doesNotMatch(render(text, details, options, context), /✓/);
    assert.equal(calls.some(({ color }) => color === "success"), false);
  }
  assert.match(render('{"status":"VERIFIED_PASS"}', { exitCode: 0, latchRecorded: true }), /✓/);
  assert.equal(calls.some(({ color }) => color === "success"), true);
});

test("F-06 receipt preserves complete cost and check at 56, 60 and 80 columns", async () => {
  const h = harness([message()]);
  const command = "node vinci/test/a-very-long-regression-command-with-no-breaks.mjs --run parser-preservation";
  Object.assign(h.saved, { state: "DONE", verificationStatus: "passed", verificationCommand: command });
  for (const handler of h.handlers.session_start) await handler({ reason: "resume" }, h.ctx);
  for (const width of [56, 60, 80]) {
    const lines = h.widget()({}, theme).render(width);
    assert(lines.every((line) => tui.visibleWidth(line) <= width), `receipt fits ${width} columns`);
    assert.doesNotMatch(lines.join("\n"), /…/, `receipt wraps at ${width} columns`);
    assert.match(lines.join("\n"), /~\$0\.0465\s+estimated/, `full cost at ${width} columns`);
    const compact = lines.join("").replace(/\s/g, "");
    assert(compact.includes(`check: ${command}`.replace(/\s/g, "")), `full check at ${width} columns`);
    assert(compact.includes(outcome.formatVinciTaskUsage(h.saved.usage).replace(/\s/g, "")), `full usage at ${width} columns`);
  }
});

test("F-11 usage separates empty, missing telemetry and cumulative session usage", async () => {
  const empty = harness([], "b2-empty");
  await empty.commands.usage.handler("", empty.ctx);
  let text = empty.notifications.at(-1);
  assert.match(text, /^This session\n/);
  assert.match(text, /Model: Vinci Forte \(selected; no calls yet\)/);
  assert.match(text, /No model calls in this session yet\./);
  assert.doesNotMatch(text, /0 model calls|\$0\.0000|Provider: unavailable|Model: unavailable/);
  assert.match(text, /Account balance: not available in the CLI yet/);
  empty.ctx.model = undefined;
  await empty.commands.usage.handler("", empty.ctx);
  assert.match(empty.notifications.at(-1), /Model: No model selected/);
  const missing = harness([message({ usage: undefined })], "b2-missing");
  await missing.commands.usage.handler("", missing.ctx);
  text = missing.notifications.at(-1);
  assert.match(text, /Usage unavailable/);
  assert.doesNotMatch(text, /0 in|0 out|0%|\$0\.0000/);
  for (const usage of [{ input: 3 }, { ...message().usage, input: Number.NaN }]) {
    const partial = harness([message({ usage })], "b2-partial");
    await partial.commands.usage.handler("", partial.ctx);
    assert.match(partial.notifications.at(-1), /Usage unavailable/);
  }
  const live = harness([message()], "b2-cumulative");
  live.branch.push({ type: "message", message: message({ responseId: "b2-follow-up", timestamp: 2 }) });
  await live.commands.usage.handler("", live.ctx);
  text = live.notifications.at(-1);
  assert.match(text, /2 model calls/);
  assert.match(text, /400 in \/ 40 out/);
  assert.match(text, /50% cached/);
  assert.match(text, /~\$0\.0930 estimated/);
  const zero = harness([message({ content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } })], "b2-real-zero");
  await zero.commands.usage.handler("", zero.ctx);
  assert.match(zero.notifications.at(-1), /~\$0\.0000 estimated/, "measured zero differs from missing telemetry");
  assert.doesNotMatch(zero.notifications.at(-1), /Usage unavailable/);
  accumulator.recordVinciTaskCall("b2-cumulative", { responseId: "b2-supplemental", provider: "vinci", model: "forte" }, "test");
  await live.commands.usage.handler("", live.ctx);
  assert.match(live.notifications.at(-1), /Usage unavailable/, "missing supplemental telemetry cannot become zero usage");
  const snapshot = JSON.parse(JSON.stringify(accumulator.getVinciTaskUsageSnapshot("b2-cumulative")));
  assert(accumulator.isVinciUsageSnapshot(snapshot));
  accumulator.resetVinciTaskUsage("b2-cumulative");
  accumulator.hydrateVinciTaskUsage("b2-cumulative", snapshot);
  await live.commands.usage.handler("", live.ctx);
  assert.match(live.notifications.at(-1), /Usage unavailable/, "resuming preserves missing-telemetry status");
});

test("F1 content or tool calls with all-zero usage report unavailable telemetry", async () => {
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  for (const [kind, content] of [
    ["text", [{ type: "text", text: "Done." }]],
    ["tool", [{ type: "toolCall", id: "b2-tool", name: "read", arguments: { path: "parser.ts" } }]],
    ["string", "Done."],
  ]) {
    // This is the completed message shape when the stream never carries a usage chunk.
    const missing = harness([message({ content, usage: zeroUsage })], `b2-zero-${kind}`);
    await missing.commands.usage.handler("", missing.ctx);
    const text = missing.notifications.at(-1);
    assert.match(text, /1 model call · Usage unavailable/, `${kind} without telemetry`);
    assert.doesNotMatch(text, /0 in \/ 0 out|0% cached|\$0\.0000/);
    assert.equal(missing.saved.usage.telemetryUnavailable, true);
    assert.equal(accumulator.vinciUsageFromResponse(message({ content, usage: zeroUsage })).telemetryUnavailable, true);
  }

  const mixed = harness([message(), message({ responseId: "b2-zero-mixed", usage: zeroUsage })], "b2-zero-mixed");
  await mixed.commands.usage.handler("", mixed.ctx);
  assert.match(mixed.notifications.at(-1), /2 model calls · Usage unavailable/);
  assert.doesNotMatch(mixed.notifications.at(-1), /200 in \/ 20 out|\$0\.0465/);

  // Each real field independently prevents the all-zero check; totalTokens is not required.
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"]) {
    const usage = { ...zeroUsage, [field]: field === "cost" ? { total: 0.01 } : 1 };
    const measured = harness([message({ usage })], `b2-nonzero-${field}`);
    await measured.commands.usage.handler("", measured.ctx);
    assert.doesNotMatch(measured.notifications.at(-1), /Usage unavailable/, `${field} is non-zero`);
    assert.notEqual(accumulator.vinciUsageFromResponse(message({ usage })).telemetryUnavailable, true);
  }

  const supplemental = harness([message()], "b2-zero-supplemental");
  accumulator.recordVinciTaskCall("b2-zero-supplemental", message({ responseId: "b2-zero-extra", usage: zeroUsage }), "test");
  await supplemental.commands.usage.handler("", supplemental.ctx);
  assert.match(supplemental.notifications.at(-1), /2 model calls · Usage unavailable/);
  const snapshot = JSON.parse(JSON.stringify(accumulator.getVinciTaskUsageSnapshot("b2-zero-supplemental")));
  assert(accumulator.isVinciUsageSnapshot(snapshot));
  accumulator.resetVinciTaskUsage("b2-zero-supplemental");
  accumulator.hydrateVinciTaskUsage("b2-zero-supplemental", snapshot);
  await supplemental.commands.usage.handler("", supplemental.ctx);
  assert.match(supplemental.notifications.at(-1), /2 model calls · Usage unavailable/, "resuming preserves all-zero telemetry status");
});

test("F-14 usage puts plain model, billing and readable key lines before diagnostics", async () => {
  const h = harness([message()], "b2-details");
  calls.length = 0;
  await h.commands.usage.handler("", h.ctx);
  const text = h.notifications.at(-1);
  const session = text.indexOf("This session");
  const account = text.indexOf("Your Vinci account");
  const details = text.indexOf("Details");
  assert(session === 0 && account > session && details > account, "customer sections precede Details");
  assert.match(text.slice(session, account), /Model: Vinci Forte/);
  assert.doesNotMatch(text.slice(session, account), /zai-org|Task:|Provider:/);
  assert.match(text.slice(account, details), /Open billing: https:\/\/platform\.getsimpledirect\.com\/billing\?source=code/);
  assert.match(text.slice(details), /Task: b2-details/);
  assert.match(text.slice(details), /Provider: vinci/);
  assert.match(text.slice(details), /Model IDs: zai-org\/GLM-5\.3/);
  assert.match(text.slice(details), /Cache read: 100 tokens/);
  assert.match(text.slice(details), /Cache write: 0 tokens/);
  assert.match(text.slice(details), /Report wrong: vinci report-wrong b2-details/);
  assert(calls.some(({ color, text }) => color === "text" && text.includes("Open billing:") && text.includes("estimated")), "key lines use the normal foreground");
});
