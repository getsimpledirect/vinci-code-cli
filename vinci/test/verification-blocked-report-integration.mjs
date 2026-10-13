import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
after(() => { execFileSync("find", [project, "-mindepth", "1", "-delete"]); rmdirSync(project); });

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
let branch = [];
const context = {
  cwd: project,
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => branch, getSessionId: () => "blocked-report-test" },
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
  context.cwd = project;
  branch = [];
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
  "No checks passed because none could run.",
  "Zero tests passed because none could run.",
  "No verification succeeded because the sandbox could not start.",
  "0 tests passed because none could run.",
  "No specs are passing because none could run.",
  "Zero checks passed; no verification command succeeded.",
  "I have not verified the change.",
  "I haven't verified the change.",
]) {
  test(`honest negative verification stays blocked: ${negative}`, async () => {
    await start();
    await shell(failures[0]);
    const message = assistant(`**Blocked:** the sandbox could not start shell commands. ${negative}`);
    assert.equal(await emit("message_end", { message }), undefined);
    assert.equal(state.getVinciVerificationState().recoveryAttempts, 0);
    assert.notEqual(state.getVinciVerificationState().status, "passed");
    assert.equal(verification.groundedCompletionReceipt(message.content[0].text), message.content[0].text);
    await emit("turn_end");
    assert.equal(sent.length, 0);
    assert.equal(control.getVinciAutomationStop().stopped, true);
    await emit("receipt:agent_end", { messages: [message] });
    assert.equal(outcomes.at(-1).state, "BLOCKED");
    assert.equal(exitHint, 3);
  });
}

for (const claim of [
  "Checks passed.",
  "Tests passed.",
  "Verification succeeded.",
  "No checks passed, but tests passed.",
  "Zero tests passed; verification succeeded.",
  "No verification succeeded. All checks passed.",
  "No checks passed because none could run. The implementation is complete.",
]) {
  test(`positive or mixed verification claims still require recovery: ${claim}`, async () => {
    await start();
    await shell(failures[0]);
    const report = `**Blocked:** the sandbox could not start shell commands. ${claim}`;
    assert.equal(verification.isHonestVerificationBlocker(report, failures[0]), false);
    assert.ok((await emit("message_end", { message: assistant(report) }))?.message);
    await emit("turn_end");
    assert.equal(sent.length, 1);
    assert.equal(control.getVinciAutomationStop().stopped, false);
    assert.notEqual(state.getVinciVerificationState().status, "passed");
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

const readOnlyRequest = "This is a read-only verification request: you must not edit, write, stage, commit, restore, or remove any project file. Run the existing named check and report its result.";
const nestedProject = join(project, "nested-check-project");
const staticProject = join(project, "static-project");
mkdirSync(join(nestedProject, "vinci", "extensions"), { recursive: true });
mkdirSync(join(nestedProject, "vinci", "test"), { recursive: true });
mkdirSync(staticProject);
const actualHeader = fileURLToPath(new URL("../extensions/vinci-header.ts", import.meta.url));
const headerCopy = join(nestedProject, "vinci", "extensions", "vinci-header.ts");
const actualHeaderText = readFileSync(actualHeader, "utf8").replace(
  /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
  (_match, prefix, path, suffix) => `${prefix}${resolve(dirname(actualHeader), path)}${suffix}`,
);
const correctPredicate = "home && (p === home || p.startsWith(home + sep))";
assert.equal(actualHeaderText.split(correctPredicate).length, 2, "mutate exactly the selected actual HOME predicate");
writeFileSync(join(nestedProject, "vinci", "test", "header-path-boundary.mjs"), readFileSync(new URL("header-path-boundary.mjs", import.meta.url)));
const nestedCommand = "node --test --test-reporter=spec vinci/test/header-path-boundary.mjs";
const installedModules = fileURLToPath(new URL("../../node_modules/", import.meta.url));
const nestedModules = join(nestedProject, "node_modules");
const selectedDependencies = [
  ["jiti", "jiti/static"],
  ["@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent"],
  ["@earendil-works/pi-tui", "@earendil-works/pi-tui"],
];
const selectedEntries = {};
for (const [name, specifier] of selectedDependencies) {
  const local = join(nestedModules, name);
  const selected = join(installedModules, name);
  mkdirSync(dirname(local), { recursive: true });
  symlinkSync(selected, local, "dir");
  assert.equal(existsSync(join(local, "package.json")), true, `bind the nested fixture's selected ${name} dependency`);
  assert.equal(realpathSync(local), realpathSync(selected));
  selectedEntries[specifier] = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
}
// Bind this source fixture explicitly; a TMPDIR inside the checkout must not hide missing links.
const dependencyProbe = join(nestedProject, "resolve-dependencies.mjs");
writeFileSync(dependencyProbe, `import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
for (const [specifier, selected] of Object.entries(JSON.parse(process.argv[2]))) {
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve(specifier))), selected);
}
`);
const resolvedDependencies = spawnSync(process.execPath, [dependencyProbe, JSON.stringify(selectedEntries)], {
  cwd: nestedProject, encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024,
});
assert.equal(resolvedDependencies.error, undefined, "run the actual Node dependency resolver within its bound");
assert.equal(resolvedDependencies.status, 0, resolvedDependencies.stdout + resolvedDependencies.stderr);

function runNamedHeaderCheck() {
  // This is an external CLI consumer, not recursive test-runner discovery in the parent worker.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", "--test-reporter=spec", "vinci/test/header-path-boundary.mjs"], {
    cwd: nestedProject, encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, env: childEnv,
  });
}

async function nestedCheck(valid, edited = false, request = readOnlyRequest) {
  sent.length = 0;
  outcomes.length = 0;
  exitHint = undefined;
  context.cwd = nestedProject;
  branch = [{ type: "message", message: { role: "user", content: request } }];
  await emit("session_start");
  await emit("input", { source: "interactive", text: request });
  writeFileSync(headerCopy, valid ? actualHeaderText : actualHeaderText.replace(correctPredicate, "home && p.startsWith(home)"));
  if (edited) await emit("tool_result", {
    toolName: "edit", input: { path: "vinci/extensions/vinci-header.ts" }, isError: false,
    content: [{ type: "text", text: "Applied changes" }],
  });
  const result = runNamedHeaderCheck();
  assert.equal(result.error, undefined, "the actual named verifier must start and exit within its bound");
  assert.equal(result.status, valid ? 0 : 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /ℹ tests 8/);
  assert.match(output, valid ? /ℹ pass 8/ : /ℹ pass 7/);
  if (!valid) assert.match(output, /✖ shortPath rejects an unrelated same-prefix sibling/);
  await shell(output, !valid, nestedCommand);
}

test("read-only nested real spec failure preserves assessment and closes blocked without a repair", async () => {
  await nestedCheck(false);
  const report = "Completed: read-only verification only; no files changed.\nAssessment: needs-work.\nCounts: 8 tests, 7 pass, 1 fail. The existing sibling check failed.";
  const result = await emit("message_end", { message: assistant(report) });
  const text = result?.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /Assessment: needs-work/);
  assert.match(text, /7 pass, 1 fail/);
  assert.match(text, /Blocked:/);
  assert.doesNotMatch(text, /I made the change|no automated test|run it yourself/);
  const verificationState = state.getVinciVerificationState();
  assert.equal(verificationState.variant, "normal");
  assert.equal(verificationState.status, "failed");
  assert.equal(verificationState.behavioralAttemptCompleted, true);
  assert.equal(verificationState.mutationRevision, 0);
  assert.equal(verificationState.recoveryAttempts, 0);
  await emit("turn_end");
  assert.equal(sent.length, 0, "the constrained assessment cannot queue a repair");
  await emit("receipt:agent_end", { messages: [result.message] });
  assert.equal(outcomes.at(-1).state, "BLOCKED");
  assert.equal(exitHint, 3);
});

test("a passing read-only nested check stays passed through the same final hooks", async () => {
  await nestedCheck(true);
  const localJiti = join(nestedModules, "jiti");
  const incompleteJiti = join(project, "incomplete-jiti");
  mkdirSync(incompleteJiti);
  writeFileSync(join(incompleteJiti, "package.json"), JSON.stringify({
    name: "jiti", type: "module", exports: { "./static": "./missing-static.mjs" },
  }));
  unlinkSync(localJiti);
  symlinkSync(incompleteJiti, localJiti, "dir");
  try {
    const refused = runNamedHeaderCheck();
    assert.equal(refused.error, undefined, "the dependency-refusal control must exit within its bound");
    assert.equal(refused.status, 1);
    const output = refused.stdout + refused.stderr;
    assert.match(output, /ERR_MODULE_NOT_FOUND/);
    assert.match(output, /missing-static\.mjs/);
    assert.match(output, /ℹ tests 1/);
    assert.match(output, /ℹ pass 0/);
    assert.doesNotMatch(output, /shortPath rejects an unrelated same-prefix sibling/);
  } finally {
    unlinkSync(localJiti);
    symlinkSync(join(installedModules, "jiti"), localJiti, "dir");
  }
  assert.equal(realpathSync(localJiti), realpathSync(join(installedModules, "jiti")));
  await nestedCheck(true);
  const message = assistant("Completed: read-only assessment ships; all eight tests passed and no files changed.");
  assert.equal(await emit("message_end", { message }), undefined);
  assert.equal(state.getVinciVerificationState().status, "passed");
  await emit("turn_end");
  assert.equal(sent.length, 0);
  await emit("receipt:agent_end", { messages: [message] });
  assert.equal(outcomes.at(-1).state, "DONE");
  assert.equal(exitHint, undefined);
});

test("a false passing claim over the constrained failed check is replaced", async () => {
  await nestedCheck(false);
  const result = await emit("message_end", { message: assistant("All tests passed. The implementation is correct.") });
  const text = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /Blocked:/);
  assert.doesNotMatch(text, /All tests passed|implementation is correct|I made the change|no automated test/);
  assert.equal(state.getVinciVerificationState().status, "failed");
});

test("truthful partial counts cannot shield an additional false all-tests-passed claim", async () => {
  await nestedCheck(false);
  const result = await emit("message_end", { message: assistant("Counts: 7 passed, 1 failed; All tests passed.") });
  const text = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /Blocked:/);
  assert.doesNotMatch(text, /All tests passed/);
  assert.equal(state.getVinciVerificationState().status, "failed");
});

test("a completed failed nested check cannot become a static-project hedge after an edit", async () => {
  await nestedCheck(false, true, "Repair the HOME boundary defect and run its existing regression.");
  const result = await emit("message_end", { message: assistant("Done.") });
  const text = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.doesNotMatch(text, /no automated test|run it yourself/);
  assert.equal(state.getVinciVerificationState().status, "failed");
  assert.equal(state.getVinciVerificationState().behavioralAttemptCompleted, true);
  await emit("turn_end");
  assert.equal(sent.length, 1, "a repair-authorized failure retains normal recovery");
});

test("a genuine static edit without any attempted verifier keeps its honest manual-check note", async () => {
  sent.length = 0;
  context.cwd = staticProject;
  branch = [{ type: "message", message: { role: "user", content: "Update this standalone page." } }];
  await emit("session_start");
  await emit("input", { source: "interactive", text: "Update this standalone page." });
  writeFileSync(join(staticProject, "index.html"), "<p>Updated page</p>\n");
  await emit("tool_result", { toolName: "write", input: { path: "index.html", content: "<p>Updated page</p>" }, isError: false, content: [{ type: "text", text: "Wrote index.html" }] });
  const result = await emit("message_end", { message: assistant("Updated the page.") });
  const text = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /I made the change|no automated test|open it in your browser/);
  assert.equal(state.getVinciVerificationState().mutationRevision, 1);
  assert.equal(state.getVinciVerificationState().behavioralAttemptCommand, "");
  await emit("turn_end");
  assert.equal(sent.length, 0);
});
