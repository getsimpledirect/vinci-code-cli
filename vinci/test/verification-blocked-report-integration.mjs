import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti/static";

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const verification = await loader.import("../extensions/vinci-verification.ts");
const state = await loader.import("../extensions/lib/verification-state.ts");
const control = await loader.import("../extensions/lib/control.ts");
const outcome = await loader.import("../extensions/lib/task-outcome.ts");
const blockedStatus = await loader.import("../extensions/lib/blocked-status.ts");
const receipt = await loader.import("../extensions/vinci-receipt.ts");
const handlers = new Map();
const sent = [];
const outcomes = [];
let exitHint;
const project = mkdtempSync(join(tmpdir(), "vinci-blocked-report-"));
writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
after(() => rmSync(project, { recursive: true, force: true }));

verification.default({
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  sendMessage(message) { sent.push(message); },
  appendEntry() {},
  registerTool(tool) { handlers.set(`tool:${tool.name}`, [tool.execute]); },
  registerCommand() {},
  async exec(command) {
    assert.equal(command, "git", "the regression never launches a shell or a model");
    return { stdout: "", stderr: "", code: 0, killed: false };
  },
});
receipt.default({
  on(name, handler) { handlers.set(`receipt:${name}`, [handler]); },
  appendEntry(_type, entry) { outcomes.push(entry); },
  registerCommand() {},
});
const context = {
  cwd: project,
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => [], getSessionId: () => "blocked-report-test" },
  declareHeadlessExitHint(hint) { exitHint = hint; },
};
async function emit(name, event = {}) {
  let result;
  for (const handler of handlers.get(name) ?? []) {
    const next = await handler(event, context);
    if (next !== undefined) result = next;
  }
  return result;
}
function assistant(text) {
  return {
    role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  };
}
async function shell(output, isError = true, command = "node --test sum.test.mjs") {
  await emit("tool_call", { toolName: "bash", input: { command } });
  await emit("tool_result", {
    toolName: "bash", input: { command }, isError, content: [{ type: "text", text: output }],
  });
}
async function start() {
  sent.length = 0;
  outcomes.length = 0;
  exitHint = undefined;
  await emit("session_start");
  assert.equal(verification.vinciVerificationDisabled(), false);
  await emit("input", {
    source: "interactive",
    text: "Fix sum.mjs. Run the test once; if the sandbox cannot start, stop and report the blocker.",
  });
  await emit("tool_result", {
    toolName: "edit", input: { path: "sum.mjs" }, isError: false,
    content: [{ type: "text", text: "Applied changes" }],
  });
}
const reports = [
  "Completed: Fixed `sum.mjs` to add its inputs.\n\nVerification: Blocked—the requested test command could not start because the sandbox denied access. As requested, I stopped without trying a workaround.",
  "**Completed:** `sum.mjs` now adds its inputs.\n**Blocked:** I couldn’t inspect the current diff or run the existing check because the sandbox could not start shell commands (network-namespace setup was denied). I stopped without disabling the sandbox or trying a workaround.",
  "Blocked: the sandbox cannot start even a read-only shell command; it fails while creating a network socket. I can’t inspect the diff or run the test under this restriction. No workaround was attempted. Please restore command execution in the sandbox, then I can inspect the change and run the narrowest check.",
];
const failures = [
  "bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted\n\nCommand exited with code 1",
  "bwrap: Creating new namespace failed: Operation not permitted",
  "bwrap: Can't create network socket: Permission denied",
];

for (const [reportIndex, report] of reports.entries()) {
  for (const [failureIndex, failure] of failures.entries()) {
    test(`preserves observed blocked report ${reportIndex + 1}, startup failure ${failureIndex + 1}`, async () => {
      await start();
      await shell(failure);
      const message = assistant(report);
      assert.equal(await emit("message_end", { message }), undefined, "the honest final answer is preserved");
      assert.equal(state.getVinciVerificationState().recoveryAttempts, 0);
      assert.notEqual(state.getVinciVerificationState().status, "passed");
      assert.equal(control.getVinciAutomationStop().stopped, true);
      assert.equal(control.getVinciAutomationStop().source, "verification");
      const classified = outcome.classifyVinciLocalTaskState([message], ["sum.mjs"], state.getVinciVerificationState());
      assert.equal(classified.state, "BLOCKED", "the final receipt retains the blocker over stale verification");
      assert.match(classified.reason, /^Blocked: /);
      assert.equal(verification.groundedCompletionReceipt(report), report);
      await emit("turn_end");
      assert.equal(sent.length, 0, "a blocked check must not queue an extra model turn");
      await emit("receipt:agent_end", { messages: [message] });
      assert.equal(outcomes.at(-1).state, "BLOCKED");
      assert.equal(exitHint, 3, "the real receipt hook declares the blocked headless exit");
    });
  }
}

for (const prefix of ["Blocked:", "Verification blocked:", "Verification: Blocked—", "**Blocked:**", "__Verification blocked__:", "**Verification:** **Blocked**—"]) {
  test(`accepts status spelling ${prefix}`, () => {
    assert.equal(verification.isHonestVerificationBlocker(`${prefix} the sandbox could not start shell commands.`, failures[0]), true);
  });
}

for (const report of [
  "Blocked:",
  "Blocked: the parser test is failing because the code is wrong.",
  "Blocked: EPERM opening report.txt.",
  "Blocked: the sandbox assertion expected 4 but received 5.",
  "Blocked: the fixture is incompatible with the new return shape.",
  `${reports[0]} The implementation is complete.`,
  `${reports[0]} All tests passed.`,
]) {
  test(`rejects an unsupported blocker or success claim: ${report.slice(0, 64)}`, () => {
    assert.equal(verification.isHonestVerificationBlocker(report, failures[0]), false);
  });
}

for (const [label, output, isError] of [
  ["no observed error", "", true],
  ["unrelated permission error", "EPERM: open report.txt", true],
  ["successful output", failures[0], false],
]) {
  test(`sandbox prose does not replace evidence: ${label}`, async () => {
    await start();
    await shell(output, isError);
    const result = await emit("message_end", { message: assistant(reports[1]) });
    assert.ok(result?.message, "unsupported prose still triggers verification recovery");
    await emit("turn_end");
    assert.equal(sent.length, 1);
    assert.equal(control.getVinciAutomationStop().stopped, false);
  });
}

test("new user input and a fresh session discard earlier sandbox evidence", async () => {
  for (const boundary of ["input", "session_start"]) {
    await start();
    await shell(failures[0]);
    await emit(boundary, { source: "interactive", text: "Now make a separate change." });
    state.recordVinciMutation();
    assert.ok((await emit("message_end", { message: assistant(reports[0]) }))?.message);
    await emit("turn_end");
    assert.equal(sent.length, 1);
  }
});

test("a later shell result invalidates earlier sandbox evidence", async () => {
  await start();
  await shell(failures[0]);
  await shell("sum.mjs", false, "ls");
  assert.ok((await emit("message_end", { message: assistant(reports[0]) }))?.message);
  await emit("turn_end");
  assert.equal(sent.length, 1);
});

test("real failed checks still get bounded recovery and never become passed", async () => {
  await start();
  await shell("not ok 1 - adds positive inputs\n1 failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.ok((await emit("message_end", { message: assistant("Done.") }))?.message);
    await emit("turn_end");
  }
  assert.equal(sent.length, 2);
  assert.equal(state.getVinciVerificationState().recoveryAttempts, 2);
  assert.equal(state.getVinciVerificationState().status, "failed");
  assert.equal(control.getVinciAutomationStop().stopped, true);
});

test("existing external, runner, and confirmation blockers remain supported", () => {
  for (const report of [
    "Blocked: the required service endpoint is unavailable from this machine.",
    "Blocked: the test runner fails to start due to ERR_REQUIRE_ESM.",
    "Blocked: applying the migration needs your confirmation and there is no UI to confirm it.",
  ]) assert.equal(verification.isHonestVerificationBlocker(report), true);
});

test("quoted status examples and an empty label cannot become a blocked receipt", () => {
  for (const report of [
    "Blocked:",
    "> Blocked: the sandbox cannot start.",
    "Example:\n```text\nBlocked: the sandbox cannot start.\n```\nI have not attempted the check.",
    "Example:\n~~~\n**Blocked:** the sandbox cannot start.\n~~~",
    "    Blocked: an indented code example.",
  ]) assert.equal(blockedStatus.vinciBlockedStatusLine(report), undefined);
});

test("pre-edit startup failures cannot substantiate the current revision", async () => {
  await start();
  await shell(failures[0]);
  await emit("tool_result", {
    toolName: "edit", input: { path: "sum.mjs" }, isError: false,
    content: [{ type: "text", text: "Applied changes" }],
  });
  assert.ok((await emit("message_end", { message: assistant(reports[0]) }))?.message);
  await emit("turn_end");
  assert.equal(sent.length, 1);
});

test("reordered sandbox claims still require observed evidence", async () => {
  await start();
  const report = "**Blocked:** network namespace permission was denied by bwrap.";
  assert.equal(verification.isHonestVerificationBlocker(report), false);
  assert.ok((await emit("message_end", { message: assistant(report) }))?.message);
  await emit("turn_end");
  assert.equal(sent.length, 1);
});

for (const negative of [
  "The change is in place but not verified.",
  "No tests passed because none could run.",
  "I have not verified the change.",
  "I haven't verified the change.",
]) {
  test(`honest negative verification stays blocked: ${negative}`, async () => {
    await start();
    await shell(failures[0]);
    const message = assistant(`**Blocked:** the sandbox could not start shell commands. ${negative}`);
    assert.equal(await emit("message_end", { message }), undefined);
    await emit("turn_end");
    assert.equal(sent.length, 0);
    assert.equal(control.getVinciAutomationStop().stopped, true);
  });
}

test("a prior static pass cannot turn a later blocked behavioral check into done", async () => {
  await start();
  await shell("Typecheck completed", false, "npm run check");
  assert.equal(state.getVinciVerificationState().status, "passed");
  await shell(failures[0]);
  assert.equal(state.getVinciVerificationState().status, "passed", "keep the genuine static evidence");
  assert.equal(state.hasIncompleteVinciBehavioralAttempt(state.getVinciVerificationState()), true);
  const report = "**Blocked:** the sandbox could not start shell commands. The change is not verified.";
  const message = assistant(report);
  assert.equal(await emit("message_end", { message }), undefined);
  assert.equal(verification.groundedCompletionReceipt(report), report);
  await emit("turn_end");
  assert.equal(sent.length, 0);
  assert.equal(control.getVinciAutomationStop().stopped, true);
  await emit("receipt:agent_end", { messages: [message] });
  assert.equal(outcomes.at(-1).state, "BLOCKED");
  assert.equal(exitHint, 3);
});

test("a blocked label cannot shield false success over an incomplete behavioral check", async () => {
  await start();
  await shell("Typecheck completed", false, "npm run check");
  await shell(failures[0]);
  const report = "**Blocked:** the sandbox could not start shell commands. All tests passed.";
  assert.equal(verification.isHonestVerificationBlocker(report, failures[0]), false);
  const result = await emit("message_end", { message: assistant(report) });
  assert.ok(result?.message);
  const text = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.doesNotMatch(text, /All tests passed/);
  assert.match(text, /test suite couldn.t be run/i);
});

for (const [label, command, output] of [
  ["failed file read", "cat README.md missing.txt", `${failures[0]}\ncat: missing.txt: No such file or directory`],
  ["real assertion failure", "node --test sum.test.mjs", `${failures[0]}\nnot ok 1 - expected 4 but received 5\n1 failed`],
]) {
  test(`${label} cannot lend diagnostic prose to a sandbox blocker`, async () => {
    await start();
    await shell(output, true, command);
    assert.ok((await emit("message_end", { message: assistant(reports[0]) }))?.message);
    await emit("turn_end");
    assert.equal(sent.length, 1);
  });
}

for (const command of ["git diff", "pwd"]) {
  test(`a diagnostic-only startup failure can block ${command}`, async () => {
    await start();
    await shell(failures[0], true, command);
    const message = assistant(reports[2]);
    assert.equal(await emit("message_end", { message }), undefined);
    await emit("turn_end");
    assert.equal(sent.length, 0);
    await emit("receipt:agent_end", { messages: [message] });
    assert.equal(outcomes.at(-1).state, "BLOCKED");
    assert.equal(exitHint, 3);
  });
}

test("separately appended guard guidance does not hide a raw startup failure", async () => {
  await start();
  await emit("tool_result", {
    toolName: "bash", input: { command: "git diff" }, isError: true,
    content: [
      { type: "text", text: failures[0] },
      { type: "text", text: "[Vinci safety note: do not blindly retry the same command.]" },
    ],
  });
  assert.equal(await emit("message_end", { message: assistant(reports[1]) }), undefined);
  await emit("turn_end");
  assert.equal(sent.length, 0);
});

test("a diagnostic mentioned only by appended guidance is not observed failure evidence", async () => {
  await start();
  await emit("tool_result", {
    toolName: "bash", input: { command: "cat missing.txt" }, isError: true,
    content: [
      { type: "text", text: "cat: missing.txt: No such file or directory" },
      { type: "text", text: failures[0] },
    ],
  });
  assert.ok((await emit("message_end", { message: assistant(reports[0]) }))?.message);
  await emit("turn_end");
  assert.equal(sent.length, 1);
});
