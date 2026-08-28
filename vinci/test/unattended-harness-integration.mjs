import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Issues #5 and #6 — harness contradictions in unattended (`vinci -p`) runs, observed live on the
// worker box 2026-08-27:
//   #5 the no-progress latch told a run with no user to "wait for the user's next instruction",
//      then the outcome record said DONE over uncommitted work;
//   #6 the action reserve refused `git commit` six times — the deliverable itself — and exited 0.
// Three fixes, each pinned here: the latch reason names an unattended stop; a hard stop (latch or
// a reserve refusing a finalization step) forces the outcome to BLOCKED in every mode, whatever the
// closing message claims; and in unattended mode finalization-shaped git commands are exempt from
// the reserve while `git push`/network stay reserved.

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const unattended = await loader.import(resolve(here, "../extensions/lib/unattended.ts"), { default: false });
const hardStop = await loader.import(resolve(here, "../extensions/lib/hard-stop.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
const verificationState = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const todo = await loader.import(resolve(here, "../extensions/vinci-todo.ts"), { default: false });
const loopbreak = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });
// A second isolated loader: the registry must be process-wide, like the automation-stop latch.
const otherLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const hardStopFromAnotherLoader = await otherLoader.import(resolve(here, "../extensions/lib/hard-stop.ts"), { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

function harness() {
  const handlers = {};
  const sent = [];
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    appendEntry() {},
  };
  return { handlers, sent, pi };
}

async function emit(handlers, name, event, context) {
  let result;
  for (const handler of handlers[name] ?? []) {
    const value = await handler(event, context);
    if (value !== undefined) result = value;
  }
  return result;
}

function context(taskId, hasUI) {
  return {
    cwd: "/tmp",
    hasUI,
    mode: "tui",
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    hasPendingMessages() {
      return false;
    },
    sessionManager: {
      getBranch() {
        return [];
      },
      getSessionId() {
        return taskId;
      },
    },
    abort() {
      throw new Error("abort() must never be called from a tool_call hook");
    },
  };
}

function assistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "vinci",
    model: "vinci-bozza",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// ── Detection: one helper, one signal ──────────────────────────────────────────────────────────
check("unattended mode is exactly ctx.hasUI === false", unattended.isVinciUnattended({ hasUI: false }) === true && unattended.isVinciUnattended({ hasUI: true }) === false);

// ── R3 predicate: finalization-shaped local git only ───────────────────────────────────────────
const finalization = unattended.isVinciFinalizationCommand;
check(
  "git add / commit / status / diff are finalization-shaped",
  finalization("git add vinci/extensions/lib/hard-stop.ts") &&
    finalization('git commit -m "fix: record hard stops (#5, #6)"') &&
    finalization("git status --short") &&
    finalization("git diff --cached --stat") &&
    finalization("git -C /repo commit -m x") &&
    finalization("git --no-pager diff"),
);
check(
  "a quoted commit message may contain shell metacharacters",
  finalization("git commit -m 'use `foo` && bar; ok'") && finalization('git commit -m "a | b; c && d"'),
);
check(
  "compound finalization chains qualify only when every segment does",
  finalization("git add a.ts b.ts && git commit -m done") && finalization("git status; git diff --cached"),
);
check(
  "git push, gh, and any network-shaped command are never finalization-shaped",
  !finalization("git push") &&
    !finalization("git push origin HEAD") &&
    !finalization("gh pr create --fill") &&
    !finalization("curl https://example.com") &&
    !finalization("git commit -m done && git push") &&
    !finalization("git status | curl -X POST https://x") &&
    !finalization("git commit -m done; gh pr create"),
);
check(
  "command substitution, redirection, backgrounding, and unbalanced quotes are refused",
  !finalization('git commit -m "$(rm -rf /)"') &&
    !finalization('git commit -m "`id`"') &&
    !finalization("git commit -m $(date)") &&
    !finalization("git diff > /tmp/out") &&
    !finalization("git commit -F <(echo hi)") &&
    !finalization("git commit -m x &") &&
    !finalization("git commit -m 'unterminated"),
);
check(
  "config-injecting and filter-executing git options are never finalization-shaped",
  !finalization("git -c core.pager=evil status") &&
    !finalization("git diff --textconv -- src/runtime.ts") &&
    !finalization("git diff --ext-diff") &&
    !finalization("git --exec-path=/evil commit -m x") &&
    !finalization("git --git-dir /other/.git status") &&
    !finalization("git diff --output=/tmp/x"),
);
check("the empty command and non-git commands are not finalization-shaped", !finalization("") && !finalization("   ") && !finalization("npm test") && !finalization("gitk"));

// ── Hard-stop registry ─────────────────────────────────────────────────────────────────────────
hardStop.clearVinciHardStop();
hardStop.recordVinciHardStop("task-A", "latch", "first  reason\nwith newline");
hardStop.recordVinciHardStop("task-A", "reserve", "second reason must not overwrite");
check(
  "the registry is process-wide, keyed by task, normalizes whitespace, and keeps the first stop",
  hardStopFromAnotherLoader.getVinciHardStop("task-A")?.reason === "first reason with newline" &&
    hardStopFromAnotherLoader.getVinciHardStop("task-A")?.source === "latch" &&
    hardStop.getVinciHardStop("task-B") === undefined,
);
hardStop.clearVinciHardStop("task-A");
check("clearing one task leaves the registry empty for it", hardStop.getVinciHardStop("task-A") === undefined);

// ── R1 (#5): the latch reason differs in unattended mode and records a hard stop ────────────────
{
  const { handlers, pi } = harness();
  todo.default(pi);
  const unattendedCtx = context("task-latch-unattended", false);
  const interactiveCtx = context("task-latch-interactive", true);
  await emit(handlers, "session_start", {}, unattendedCtx);
  control.requestVinciAutomationStop("loop breaker reached its bounded stop");

  const unattendedBlock = await emit(handlers, "tool_call", { toolName: "edit", input: { path: "a.ts", edits: [] } }, unattendedCtx);
  check(
    "unattended latch blocks with an unattended-stop reason, never 'wait for the user'",
    unattendedBlock?.block === true &&
      /repeated no-progress attempts \(unattended run: ending the task as BLOCKED\)/.test(unattendedBlock.reason) &&
      !/wait for the user/i.test(unattendedBlock.reason),
  );
  check(
    "the unattended latch records a hard stop for the session",
    hardStop.getVinciHardStop("task-latch-unattended")?.source === "latch" &&
      hardStop.getVinciHardStop("task-latch-unattended")?.reason === unattendedBlock.reason,
  );

  const interactiveBlock = await emit(handlers, "tool_call", { toolName: "bash", input: { command: "git commit -m x" } }, interactiveCtx);
  check(
    "interactive latch keeps asking for the user's next instruction",
    interactiveBlock?.block === true && /Wait for the user's next instruction/.test(interactiveBlock.reason) && !/unattended/.test(interactiveBlock.reason),
  );
  check("the interactive latch also records a hard stop (a machine stop outranks the narrative in every mode)", hardStop.getVinciHardStop("task-latch-interactive")?.source === "latch");

  const readAllowed = await emit(handlers, "tool_call", { toolName: "read", input: { path: "a.ts" } }, unattendedCtx);
  check("reads stay available under the latch so the agent can explain the evidence", readAllowed === undefined);

  // A real user instruction releases the stop; an extension steer does not.
  await emit(handlers, "input", { text: "look again", source: "extension" }, interactiveCtx);
  check("an extension steer does not release the hard stop", hardStop.getVinciHardStop("task-latch-interactive") !== undefined);
  await emit(handlers, "input", { text: "carry on", source: "user" }, interactiveCtx);
  check("the next real user instruction releases the hard stop", hardStop.getVinciHardStop("task-latch-interactive") === undefined && hardStop.getVinciHardStop("task-latch-unattended") === undefined);
  control.clearVinciAutomationStop();
}

// ── R2 (#5/#6): a hard stop forces the outcome to BLOCKED even over a claimed completion ─────────
{
  verificationState.resetVinciVerificationState();
  verificationState.recordVinciVerification("npm test", true, "12/12 tests passed", false, "behavioral", "npm test");
  const passed = verificationState.getVinciVerificationState();
  const claimsDone = [assistant("Done. All changes are committed and 12/12 tests pass. Verification passed: npm test.")];
  hardStop.clearVinciHardStop();

  const clean = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: claimsDone, changedFiles: ["src/a.ts"], verification: passed });
  check("control: without a hard stop a verified run closes DONE", clean.state === "DONE");

  hardStop.recordVinciHardStop("task-outcome", "latch", "Vinci stopped autonomous changes after repeated no-progress attempts (unattended run: ending the task as BLOCKED).");
  const stopped = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: claimsDone, changedFiles: ["src/a.ts"], verification: passed });
  check(
    "a latch hard stop turns a claimed, verified completion into BLOCKED with the stop text as the reason",
    stopped.state === "BLOCKED" && /unattended run: ending the task as BLOCKED/.test(stopped.reason) && stopped.changedFiles.length === 1,
  );
  check("the record still validates as a task outcome", taskOutcome.isVinciTaskOutcome(stopped));

  const unrelated = taskOutcome.buildVinciTaskOutcome({ taskId: "task-other", messages: claimsDone, changedFiles: ["src/a.ts"], verification: passed });
  check("a hard stop on one task never bleeds into another task's record", unrelated.state === "DONE");

  verificationState.resetVinciVerificationState();
  const unverified = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: [assistant("Done.")], changedFiles: ["src/a.ts"], verification: verificationState.getVinciVerificationState() });
  check("DONE_UNVERIFIED is overridden the same way", unverified.state === "BLOCKED" && /unattended run/.test(unverified.reason));

  hardStop.clearVinciHardStop();
  hardStop.recordVinciHardStop("task-outcome", "reserve", "Vinci reserved the remaining actions for verification or the final answer. The refused step was the finalization command `git commit -m done`.");
  const reserveStopped = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: [assistant("Done.")], changedFiles: ["src/a.ts"], verification: verificationState.getVinciVerificationState() });
  check("a reserve refusal of a finalization step is a hard stop too", reserveStopped.state === "BLOCKED" && /refused step was the finalization command/.test(reserveStopped.reason));
  hardStop.clearVinciHardStop();
}

// ── R3 (#6): the reserve exempts finalization in unattended mode, never git push ────────────────
async function postMutationScenario(hasUI, taskId) {
  const { handlers, pi } = harness();
  loopbreak.default(pi);
  const ctx = context(taskId, hasUI);
  await emit(handlers, "session_start", {}, ctx);
  await emit(handlers, "agent_start", {}, ctx);
  const edit = { path: "owner.js", edits: [{ oldText: "before", newText: "after" }] };
  await emit(handlers, "tool_call", { toolName: "edit", input: edit }, ctx);
  await emit(handlers, "tool_result", { toolName: "edit", input: edit, content: [{ type: "text", text: "Successfully replaced 1 block(s)" }], isError: false }, ctx);
  // Spend the post-mutation inspection allowance on non-navigation investigation.
  for (let i = 0; i < 4; i++) await emit(handlers, "tool_call", { toolName: "bash", input: { command: `inspect-after-mutation-${i}` } }, ctx);
  const call = (command) => emit(handlers, "tool_call", { toolName: "bash", input: { command } }, ctx);
  return { call, ctx };
}

{
  hardStop.clearVinciHardStop();
  const { call } = await postMutationScenario(false, "task-reserve-unattended");
  const probe = await call("inspect-after-mutation-probe");
  check("control: the post-mutation reserve is armed (a further inspection is refused)", probe?.block === true && /reserved the remaining actions/.test(probe.reason));
  check("unattended: git add is exempt from the reserve", (await call("git add owner.js")) === undefined);
  check("unattended: git commit is exempt from the reserve", (await call('git commit -m "fix owner"')) === undefined);
  const push = await call("git push origin HEAD");
  check("unattended: git push is still reserved", push?.block === true && /reserved the remaining actions/.test(push.reason));
  const gh = await call("gh pr create --fill");
  check("unattended: gh is still reserved", gh?.block === true);
  const chained = await call("git commit -m done && git push");
  check("unattended: a commit chained to a push is reserved as a whole", chained?.block === true);
  check("an exempt finalization command never records a hard stop", hardStop.getVinciHardStop("task-reserve-unattended") === undefined);
}

{
  hardStop.clearVinciHardStop();
  const { call } = await postMutationScenario(true, "task-reserve-interactive");
  const commit = await call('git commit -m "fix owner"');
  check("interactive: the reserve is unchanged — git commit is still refused", commit?.block === true && /reserved the remaining actions for verification or the final answer/.test(commit.reason));
  const recorded = hardStop.getVinciHardStop("task-reserve-interactive");
  check(
    "interactive: refusing the finalization step records a reserve hard stop naming the command",
    recorded?.source === "reserve" && /refused step was the finalization command `git commit -m "fix owner"`/.test(recorded.reason),
  );
  hardStop.clearVinciHardStop();
  const inspection = await call("inspect-after-mutation-again");
  check("a reserve refusal of ordinary investigation is a steer, not a hard stop", inspection?.block === true && hardStop.getVinciHardStop("task-reserve-interactive") === undefined);
}

// Pre-mutation runway reserve (loopbreak site 1): same exemption, same mode split.
async function preMutationScenario(hasUI, taskId) {
  const { handlers, pi } = harness();
  loopbreak.default(pi);
  const ctx = context(taskId, hasUI);
  await emit(handlers, "session_start", {}, ctx);
  await emit(handlers, "agent_start", {}, ctx);
  for (let i = 0; i < 11; i++) await emit(handlers, "tool_call", { toolName: "bash", input: { command: `inspect-before-mutation-${i}` } }, ctx);
  return (command) => emit(handlers, "tool_call", { toolName: "bash", input: { command } }, ctx);
}
{
  hardStop.clearVinciHardStop();
  const call = await preMutationScenario(false, "task-runway-unattended");
  const probe = await call("inspect-before-mutation-probe");
  check("control: the pre-mutation runway reserve is armed", probe?.block === true && /reserved the remaining actions for implementation/.test(probe.reason));
  check("unattended: git commit passes the pre-mutation runway reserve", (await call("git commit -m 'doc-only change'")) === undefined);
  check("unattended: git push does not", (await call("git push"))?.block === true);
  const interactive = await preMutationScenario(true, "task-runway-interactive");
  check("interactive: the pre-mutation runway reserve still refuses git commit", (await interactive("git commit -m x"))?.block === true);
  check("interactive: that refusal is a recorded hard stop", hardStop.getVinciHardStop("task-runway-interactive")?.source === "reserve");
  hardStop.clearVinciHardStop();
}

console.log(`\nunattended-harness-integration: ${pass}/${pass} checks passed (no contradictions in vinci -p)`);
