import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Issues #5 and #6 — harness contradictions in unattended (`vinci -p`) runs, observed live on the
// worker box 2026-08-27:
//   #5 the no-progress latch told a run with no user to "wait for the user's next instruction",
//      then the outcome record said DONE over uncommitted work;
//   #6 the action reserve refused `git commit` six times — the deliverable itself — and exited 0.
// Pinned here: the latch reason names an unattended stop; EVERY harness refusal of a finalization
// step (reserve, ceiling, error streak, fixation, review pause, guard) is a hard stop that forces
// the outcome to BLOCKED in every mode and every state, whatever the closing message or a remote
// verdict claims; unattended, finalization-shaped git commands pass the reserve AND the ceiling
// while `git push`/network stay reserved; and the guard and the exemption parse git argv the same way.

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, {
  moduleCache: false,
  tryNative: false,
  alias: { "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/dist/index.js") },
});
const unattended = await loader.import(resolve(here, "../extensions/lib/unattended.ts"), { default: false });
const hardStop = await loader.import(resolve(here, "../extensions/lib/hard-stop.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
const verificationState = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const uiState = await loader.import(resolve(here, "../extensions/lib/ui-state.ts"), { default: false });
const todo = await loader.import(resolve(here, "../extensions/vinci-todo.ts"), { default: false });
const loopbreak = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });
const guard = await loader.import(resolve(here, "../extensions/vinci-guard.ts"), { default: false });
const receipt = await loader.import(resolve(here, "../extensions/vinci-receipt.ts"), { default: false });
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

// Pi semantics: the first handler that returns a result decides the call.
async function emit(handlers, name, event, context) {
  let result;
  for (const handler of handlers[name] ?? []) {
    const value = await handler(event, context);
    if (value !== undefined && result === undefined) result = value;
  }
  return result;
}

const workspace = mkdtempSync(join(tmpdir(), "vinci-unattended-it-"));
function context(taskId, hasUI, extra = {}) {
  return {
    cwd: workspace,
    hasUI,
    mode: "tui",
    ui: {
      notify() {},
      setWidget() {},
      setStatus() {},
      async select() {
        return "No, don't";
      },
    },
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
    ...extra,
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

const bash = (command) => ({ toolName: "bash", input: { command } });
const okResult = (command) => ({ toolName: "bash", input: { command }, content: [{ type: "text", text: "ok" }], isError: false });
const failedResult = (toolName, input, text = "could not find the exact text") => ({ toolName, input, content: [{ type: "text", text }], isError: true });

try {
  // ── Detection: one helper, one signal ────────────────────────────────────────────────────────
  check("unattended mode is exactly ctx.hasUI === false", unattended.isVinciUnattended({ hasUI: false }) === true && unattended.isVinciUnattended({ hasUI: true }) === false);

  // ── Shared git argv parser (BLOCK-1) ─────────────────────────────────────────────────────────
  const parse = unattended.parseLocalGitSegment;
  check(
    "the parser separates globals, subcommand, and args",
    JSON.stringify(parse("git -C .. --no-pager commit -m 'a b'")) === JSON.stringify({ subcommand: "commit", globals: ["-C ..", "--no-pager"], args: ["-m", "a b"] }) &&
      JSON.stringify(parse("git -c core.pager=x status")) === JSON.stringify({ subcommand: "status", globals: ["-c core.pager=x"], args: [] }) &&
      JSON.stringify(parse("git --git-dir=/o/.git diff")) === JSON.stringify({ subcommand: "diff", globals: ["--git-dir=/o/.git"], args: [] }) &&
      parse("sudo git commit") === null &&
      parse("git") === null &&
      parse("git -C") === null &&
      parse("gitk") === null,
  );
  const finalization = unattended.isVinciFinalizationCommand;
  // The two review repro strings: the guard's checkpoint gate and the exemption must agree that
  // each IS a commit — the guard gates it, and the exemption refuses it (a `-C` path is another
  // repository's finalization, not this task's).
  for (const repro of ["git -C .. commit -m x", "git --no-pager commit -m x"]) {
    check(
      `guard and exemption agree on \`${repro}\`: the guard sees a stage/commit`,
      guard.isGitStageOrCommit(repro) === true,
    );
  }
  check("`git -C .. commit` is never exempt (any -C is rejected)", !finalization("git -C .. commit -m x") && !finalization("git -C /repo commit -m x") && !finalization("git -C. status"));
  check("`git --no-pager commit` is exempt — the only global a finalization step may carry", finalization("git --no-pager commit -m x") && finalization("git --no-pager diff"));
  check(
    "the guard's checkpoint gate now sees globals-prefixed commits the old regex missed",
    guard.isGitStageOrCommit("git -c core.pager=x add file") && guard.isGitStageOrCommit("git --git-dir=/x/.git commit -m y") && !guard.isGitStageOrCommit("git status") && !guard.isGitStageOrCommit("git push"),
  );

  // ── R3 predicate: finalization-shaped local git only ─────────────────────────────────────────
  check(
    "git add / commit / status / diff are finalization-shaped",
    finalization("git add vinci/extensions/lib/hard-stop.ts") &&
      finalization('git commit -m "fix: record hard stops (#5, #6)"') &&
      finalization("git status --short") &&
      finalization("git diff --cached --stat") &&
      finalization("git commit --no-edit -m x") &&
      finalization("git commit -F msg.txt"),
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
    "config-injecting and repointing git globals are never finalization-shaped",
    !finalization("git -c core.pager=evil status") &&
      !finalization("git --exec-path=/evil commit -m x") &&
      !finalization("git --git-dir /other/.git status") &&
      !finalization("git --work-tree=/o status") &&
      !finalization("git --config-env=core.pager=X status"),
  );
  // WARN-1: options that open an editor, an interactive prompt, or an external program.
  check(
    "add: -p/-i/-e and their long forms are refused",
    !finalization("git add -p file") && !finalization("git add --patch file") && !finalization("git add -i") && !finalization("git add --interactive") && !finalization("git add -e file") && !finalization("git add --edit file") && !finalization("git add --pathspec-from-file=list"),
  );
  check(
    "commit: -e/--edit, -t/--template, -c (re-edit), -p, -i, --fixup/--squash are refused",
    !finalization("git commit -e -m x") &&
      !finalization("git commit --edit -m x") &&
      !finalization("git commit -t tmpl") &&
      !finalization("git commit --template=tmpl") &&
      !finalization("git commit -c HEAD") &&
      !finalization("git commit --reedit-message=HEAD") &&
      !finalization("git commit -p -m x") &&
      !finalization("git commit --interactive") &&
      !finalization("git commit --fixup HEAD") &&
      !finalization("git commit --squash HEAD"),
  );
  check("a denied letter inside a combined short cluster is still refused", !finalization("git commit -pm x") && !finalization("git add -pA") && !finalization("git commit -me x"));
  // PR #15 review note: a landed commit resolves a refusal-class hard stop, so trivial, empty,
  // rewriting, or hook-skipping commits must never be finalization-shaped — and never resolve one.
  const trivialCommits = [
    "git commit --allow-empty -m x",
    "git commit --allow-empty-message -m ''",
    "git commit --amend -m x",
    "git commit --amend --no-edit",
    "git commit --no-verify -m x",
    "git commit -n -m x",
    "git commit -nm x",
    "git commit -C HEAD",
    "git commit -C HEAD --no-edit",
    "git commit --reuse-message=HEAD",
    "git commit -c HEAD",
    "git commit --reedit-message HEAD",
    "git add -n file",
    "git add --dry-run file",
  ];
  for (const command of trivialCommits) {
    hardStop.clearVinciHardStop("task-trivial");
    hardStop.recordVinciHardStop("task-trivial", "reserve", "refused");
    const resolved = hardStop.resolveVinciHardStopByFinalization(context("task-trivial", false), command);
    check(`\`${command}\` is refused and does not resolve a hard stop`, !finalization(command) && resolved === false && hardStop.getVinciHardStop("task-trivial")?.source === "reserve");
  }
  hardStop.clearVinciHardStop("task-trivial");
  hardStop.recordVinciHardStop("task-trivial", "reserve", "refused");
  check("control: a real commit still resolves the stop", hardStop.resolveVinciHardStopByFinalization(context("task-trivial", false), "git commit --no-edit -m x") === true && hardStop.getVinciHardStop("task-trivial") === undefined);
  check(
    "diff: --textconv, --ext-diff, --output, --no-index are refused",
    !finalization("git diff --textconv -- src/runtime.ts") && !finalization("git diff --ext-diff") && !finalization("git diff --output=/tmp/x") && !finalization("git diff --no-index a b"),
  );
  check("options after `--` are pathspecs, not options", finalization("git add -- -p") && finalization("git diff -- --textconv"));
  check("the empty command and non-git commands are not finalization-shaped", !finalization("") && !finalization("   ") && !finalization("npm test") && !finalization("gitk") && !finalization("FOO=1 git commit -m x"));

  // ── Hard-stop registry ───────────────────────────────────────────────────────────────────────
  hardStop.clearVinciHardStop("task-A");
  hardStop.clearVinciHardStop("task-B");
  hardStop.recordVinciHardStop("task-A", "latch", "first  reason\nwith newline");
  hardStop.recordVinciHardStop("task-A", "reserve", "second reason must not overwrite");
  hardStop.recordVinciHardStop("task-B", "reserve", "task B stop");
  check(
    "the registry is process-wide, keyed by task, normalizes whitespace, and keeps the first stop",
    hardStopFromAnotherLoader.getVinciHardStop("task-A")?.reason === "first reason with newline" &&
      hardStopFromAnotherLoader.getVinciHardStop("task-A")?.source === "latch" &&
      hardStop.getVinciHardStop("task-B")?.reason === "task B stop",
  );
  hardStop.clearVinciHardStop("task-A");
  check("WARN-2: clearing one task leaves the other task's stop in place", hardStop.getVinciHardStop("task-A") === undefined && hardStop.getVinciHardStop("task-B")?.reason === "task B stop");
  hardStop.clearVinciHardStop("task-B");
  check("the refusal helper records only for finalization-shaped commands", hardStop.recordFinalizationRefusal(context("task-C", false), "guard", "npm test", "x") === false && hardStop.getVinciHardStop("task-C") === undefined);
  const refused = hardStop.refuseFinalization(context("task-C", false), "guard", "git commit -m x", "Blocked by the guard.");
  check(
    "the refusal helper returns the block and records the stop naming the command",
    refused.block === true && refused.reason === "Blocked by the guard." && hardStop.getVinciHardStop("task-C")?.source === "guard" && /finalization command `git commit -m x`/.test(hardStop.getVinciHardStop("task-C").reason),
  );
  check("a landed `git status` does not resolve a refusal stop; a landed commit does", hardStop.resolveVinciHardStopByFinalization(context("task-C", false), "git status") === false && hardStop.getVinciHardStop("task-C") !== undefined && hardStop.resolveVinciHardStopByFinalization(context("task-C", false), "git add a && git commit -m x") === true && hardStop.getVinciHardStop("task-C") === undefined);
  hardStop.recordVinciHardStop("task-C", "latch", "latched");
  check("the latch is never resolved by a finalization", hardStop.resolveVinciHardStopByFinalization(context("task-C", false), "git commit -m x") === false && hardStop.getVinciHardStop("task-C")?.source === "latch");
  hardStop.clearVinciHardStop("task-C");

  // ── R1 (#5): the latch reason differs in unattended mode and records a hard stop ─────────────
  {
    const { handlers, pi } = harness();
    todo.default(pi);
    const unattendedCtx = context("task-latch-unattended", false);
    const interactiveCtx = context("task-latch-interactive", true);
    await emit(handlers, "session_start", {}, unattendedCtx);
    await emit(handlers, "session_start", {}, interactiveCtx);
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

    const interactiveBlock = await emit(handlers, "tool_call", bash("git commit -m x"), interactiveCtx);
    check(
      "interactive latch keeps asking for the user's next instruction",
      interactiveBlock?.block === true && /Wait for the user's next instruction/.test(interactiveBlock.reason) && !/unattended/.test(interactiveBlock.reason),
    );
    check("the interactive latch also records a hard stop (a machine stop outranks the narrative in every mode)", hardStop.getVinciHardStop("task-latch-interactive")?.source === "latch");

    const readAllowed = await emit(handlers, "tool_call", { toolName: "read", input: { path: "a.ts" } }, unattendedCtx);
    check("reads stay available under the latch so the agent can explain the evidence", readAllowed === undefined);

    // A real user instruction releases the stop for ITS task; an extension steer does not.
    await emit(handlers, "input", { text: "look again", source: "extension" }, interactiveCtx);
    check("an extension steer does not release the hard stop", hardStop.getVinciHardStop("task-latch-interactive") !== undefined);
    await emit(handlers, "input", { text: "carry on", source: "user" }, interactiveCtx);
    check(
      "WARN-2: the next real user instruction releases only its own task's hard stop",
      hardStop.getVinciHardStop("task-latch-interactive") === undefined && hardStop.getVinciHardStop("task-latch-unattended")?.source === "latch",
    );
    await emit(handlers, "session_start", {}, unattendedCtx);
    check("WARN-2: session start clears only the starting task", hardStop.getVinciHardStop("task-latch-unattended") === undefined);
    control.clearVinciAutomationStop();
  }

  // ── R2 (#5/#6): a hard stop forces the outcome to BLOCKED in every state ─────────────────────
  {
    verificationState.resetVinciVerificationState();
    verificationState.recordVinciVerification("npm test", true, "12/12 tests passed", false, "behavioral", "npm test");
    const passed = verificationState.getVinciVerificationState();
    const claimsDone = [assistant("Done. All changes are committed and 12/12 tests pass. Verification passed: npm test.")];
    hardStop.clearVinciHardStop("task-outcome");

    const clean = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: claimsDone, changedFiles: ["src/a.ts"], verification: passed });
    check("control: without a hard stop a verified run closes DONE and carries no hardStop field", clean.state === "DONE" && clean.hardStop === undefined);

    hardStop.recordVinciHardStop("task-outcome", "latch", "Vinci stopped autonomous changes after repeated no-progress attempts (unattended run: ending the task as BLOCKED).");
    const stopped = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: claimsDone, changedFiles: ["src/a.ts"], verification: passed });
    check(
      "a latch hard stop turns a claimed, verified completion into BLOCKED with the stop text as the reason",
      stopped.state === "BLOCKED" && /unattended run: ending the task as BLOCKED/.test(stopped.reason) && stopped.changedFiles.length === 1,
    );
    check("the record carries the hard stop and still validates as a task outcome", stopped.hardStop?.source === "latch" && taskOutcome.isVinciTaskOutcome(stopped));

    const unrelated = taskOutcome.buildVinciTaskOutcome({ taskId: "task-other", messages: claimsDone, changedFiles: ["src/a.ts"], verification: passed });
    check("a hard stop on one task never bleeds into another task's record", unrelated.state === "DONE");

    verificationState.resetVinciVerificationState();
    const unverified = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: [assistant("Done.")], changedFiles: ["src/a.ts"], verification: verificationState.getVinciVerificationState() });
    check("DONE_UNVERIFIED is overridden the same way", unverified.state === "BLOCKED" && /unattended run/.test(unverified.reason));

    // BLOCK-4: WAITING too — a closing question does not soften a machine stop.
    const asks = [assistant("The fix is ready. Shall I commit it now?")];
    hardStop.clearVinciHardStop("task-outcome");
    const waiting = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: asks, changedFiles: ["src/a.ts"], verification: verificationState.getVinciVerificationState() });
    check("control: a closing ask over unverified changes is WAITING without a hard stop", waiting.state === "WAITING");
    hardStop.recordVinciHardStop("task-outcome", "reserve", "Vinci reserved the remaining actions for verification or the final answer. The refused step was the finalization command `git commit -m done`.");
    const waitingStopped = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: asks, changedFiles: ["src/a.ts"], verification: verificationState.getVinciVerificationState() });
    check("BLOCK-4: a hard stop forces WAITING to BLOCKED as well", waitingStopped.state === "BLOCKED" && /refused step was the finalization command/.test(waitingStopped.reason));

    // BLOCK-5: a current remote VERIFIED_PASS never remaps a hard-stop BLOCKED back to DONE.
    verificationState.resetVinciVerificationState();
    assert.equal(
      verificationState.recordRemoteAcceptanceVerdict({ status: "VERIFIED_PASS", summary: "Acceptance passed", snapshotDigest: "sha256:unattended-test", jobId: "unattended-job" }),
      true,
    );
    const withVerdict = verificationState.getVinciVerificationState();
    const remote = taskOutcome.currentRemoteVerdict(withVerdict);
    assert.ok(remote && remote.status === "VERIFIED_PASS" && !remote.staled, "a current VERIFIED_PASS remote verdict is recorded");
    hardStop.clearVinciHardStop("task-outcome");
    const remoteClean = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: claimsDone, changedFiles: ["src/a.ts"], verification: withVerdict });
    check("control: a current VERIFIED_PASS closes DONE and displays DONE without a hard stop", remoteClean.state === "DONE" && receipt.remoteVerdictDisplay(remoteClean, remote).state === "DONE");
    hardStop.recordVinciHardStop("task-outcome", "guard", "Blocked (save a git checkpoint) — no UI to confirm this. The refused step was the finalization command `git commit -m x`.");
    const remoteStopped = taskOutcome.buildVinciTaskOutcome({ taskId: "task-outcome", messages: claimsDone, changedFiles: ["src/a.ts"], verification: withVerdict });
    const display = receipt.remoteVerdictDisplay(remoteStopped, remote);
    check(
      "BLOCK-5: the record is BLOCKED over a VERIFIED_PASS, and the receipt display stays BLOCKED (verdict noted alongside)",
      remoteStopped.state === "BLOCKED" && remoteStopped.hardStop?.source === "guard" && display.state === "BLOCKED" && /Remote verification reported: Acceptance passed/.test(display.reason),
    );
    check("BLOCK-5: a persisted record without the registry still displays BLOCKED (the stop rides on the record)", receipt.remoteVerdictDisplay({ state: "BLOCKED", reason: "stopped", hardStop: { source: "reserve", reason: "stopped" } }, remote).state === "BLOCKED");
    check("a plain BLOCKED without a hard stop is still remapped by the verdict (unchanged display rule)", receipt.remoteVerdictDisplay({ state: "BLOCKED", reason: "x" }, remote).state === "DONE");
    hardStop.clearVinciHardStop("task-outcome");
    verificationState.resetVinciVerificationState();
  }

  // ── R3 (#6): the reserve exempts finalization in unattended mode, never git push ─────────────
  async function loopbreakScenario(hasUI, taskId) {
    const { handlers, pi } = harness();
    loopbreak.default(pi);
    const ctx = context(taskId, hasUI);
    await emit(handlers, "session_start", {}, ctx);
    await emit(handlers, "agent_start", {}, ctx);
    return { handlers, ctx, call: (command) => emit(handlers, "tool_call", bash(command), ctx), emitTo: (name, event) => emit(handlers, name, event, ctx) };
  }
  async function postMutationScenario(hasUI, taskId) {
    const scenario = await loopbreakScenario(hasUI, taskId);
    const edit = { path: "owner.js", edits: [{ oldText: "before", newText: "after" }] };
    await scenario.emitTo("tool_call", { toolName: "edit", input: edit });
    await scenario.emitTo("tool_result", { toolName: "edit", input: edit, content: [{ type: "text", text: "Successfully replaced 1 block(s)" }], isError: false });
    for (let i = 0; i < 4; i++) await scenario.call(`inspect-after-mutation-${i}`);
    return scenario;
  }

  {
    const { call } = await postMutationScenario(false, "task-reserve-unattended");
    const probe = await call("inspect-after-mutation-probe");
    check("control: the post-mutation reserve is armed (a further inspection is refused)", probe?.block === true && /reserved the remaining actions/.test(probe.reason));
    check("unattended: git add is exempt from the reserve", (await call("git add owner.js")) === undefined);
    check("unattended: git commit is exempt from the reserve", (await call('git commit -m "fix owner"')) === undefined);
    const push = await call("git push origin HEAD");
    check("unattended: git push is still reserved", push?.block === true && /reserved the remaining actions/.test(push.reason));
    check("unattended: gh is still reserved", (await call("gh pr create --fill"))?.block === true);
    check("unattended: a commit chained to a push is reserved as a whole", (await call("git commit -m done && git push"))?.block === true);
    check("unattended: `git -C .. commit` is not exempt", (await call("git -C .. commit -m x"))?.block === true);
    check("an exempt finalization command never records a hard stop", hardStop.getVinciHardStop("task-reserve-unattended") === undefined);
  }

  {
    const { call, emitTo } = await postMutationScenario(true, "task-reserve-interactive");
    const commit = await call('git commit -m "fix owner"');
    check("interactive: the reserve is unchanged — git commit is still refused", commit?.block === true && /reserved the remaining actions for verification or the final answer/.test(commit.reason));
    const recorded = hardStop.getVinciHardStop("task-reserve-interactive");
    check(
      "interactive: refusing the finalization step records a reserve hard stop naming the command",
      recorded?.source === "reserve" && /refused step was the finalization command `git commit -m "fix owner"`/.test(recorded.reason),
    );
    // A later LANDED commit resolves the refusal-class stop (the refusal was one attempt's fact).
    await emitTo("tool_result", okResult("git status"));
    check("a landed `git status` does not resolve the stop", hardStop.getVinciHardStop("task-reserve-interactive") !== undefined);
    await emitTo("tool_result", okResult('git commit -m "fix owner"'));
    check("a landed commit resolves the reserve stop", hardStop.getVinciHardStop("task-reserve-interactive") === undefined);
    const inspection = await call("inspect-after-mutation-again");
    check("a reserve refusal of ordinary investigation is a steer, not a hard stop", inspection?.block === true && hardStop.getVinciHardStop("task-reserve-interactive") === undefined);
  }

  // Pre-mutation runway reserve (loopbreak site 1): same exemption, same mode split.
  async function preMutationScenario(hasUI, taskId) {
    const scenario = await loopbreakScenario(hasUI, taskId);
    for (let i = 0; i < 11; i++) await scenario.call(`inspect-before-mutation-${i}`);
    return scenario;
  }
  {
    const { call } = await preMutationScenario(false, "task-runway-unattended");
    const probe = await call("inspect-before-mutation-probe");
    check("control: the pre-mutation runway reserve is armed", probe?.block === true && /reserved the remaining actions for implementation/.test(probe.reason));
    check("unattended: git commit passes the pre-mutation runway reserve", (await call("git commit -m 'doc-only change'")) === undefined);
    check("unattended: git push does not", (await call("git push"))?.block === true);
    const interactive = await preMutationScenario(true, "task-runway-interactive");
    check("interactive: the pre-mutation runway reserve still refuses git commit", (await interactive.call("git commit -m x"))?.block === true);
    check("interactive: that refusal is a recorded hard stop", hardStop.getVinciHardStop("task-runway-interactive")?.source === "reserve");
    hardStop.clearVinciHardStop("task-runway-interactive");
  }

  // ── BLOCK-2 / WARN-3: the per-turn action ceiling ────────────────────────────────────────────
  async function ceilingScenario(hasUI, taskId) {
    const scenario = await loopbreakScenario(hasUI, taskId);
    for (let i = 0; i < loopbreak.TURN_CALL_CEILING + 1; i++) await scenario.call(`action-${i}`);
    return scenario;
  }
  {
    const { call } = await ceilingScenario(false, "task-ceiling-unattended");
    const probe = await call("action-probe");
    check("control: after 26 actions the ceiling refuses ordinary actions", probe?.block === true && /stopped a repeated action before it could run again/.test(probe.reason));
    check("BLOCK-2: unattended, git commit passes the ceiling", (await call('git add a.ts && git commit -m "land it"')) === undefined);
    check("BLOCK-2: unattended, git push does not pass the ceiling", (await call("git push"))?.block === true);
    check("BLOCK-2: the exempt commit never records a hard stop", hardStop.getVinciHardStop("task-ceiling-unattended") === undefined);
    const interactive = await ceilingScenario(true, "task-ceiling-interactive");
    const commit = await interactive.call('git commit -m "land it"');
    check("interactive: the ceiling still refuses git commit and records a ceiling hard stop", commit?.block === true && hardStop.getVinciHardStop("task-ceiling-interactive")?.source === "ceiling");
    hardStop.clearVinciHardStop("task-ceiling-interactive");
  }

  // ── BLOCK-3: every other refusal path of a finalization command records a hard stop ───────────
  {
    // error streak: four failed mutations in a row, then the commit is refused.
    const { call, emitTo } = await loopbreakScenario(false, "task-error-streak");
    for (let i = 0; i < 4; i++) {
      const input = { path: `f${i}.ts`, edits: [{ oldText: "a", newText: "b" }] };
      await emitTo("tool_result", failedResult("edit", input));
    }
    const commit = await call("git commit -m x");
    check("error streak: the refusal of a finalization command is a recorded hard stop", commit?.block === true && /several failed actions/.test(commit.reason) && hardStop.getVinciHardStop("task-error-streak")?.source === "error-streak");
    hardStop.clearVinciHardStop("task-error-streak");
  }
  {
    // fixation: the identical failing commit repeated three times.
    const { call, emitTo } = await loopbreakScenario(false, "task-fixation");
    const command = "git commit -m 'same'";
    for (let i = 0; i < 2; i++) {
      assert.equal(await call(command), undefined, `identical commit ${i + 1} allowed`);
      await emitTo("tool_result", { toolName: "bash", input: { command }, content: [{ type: "text", text: "nothing to commit" }], isError: true });
    }
    const third = await call(command);
    check("fixation: the third identical refused commit is a recorded hard stop", third?.block === true && hardStop.getVinciHardStop("task-fixation")?.source === "fixation");
    hardStop.clearVinciHardStop("task-fixation");
  }
  {
    // review pause: a risky independent review pauses mutations; the commit is refused.
    const { handlers, tools, pi } = harness();
    todo.default(pi, async () => ({ text: "Risky: the migration drops a column.", verdict: "risky" }));
    const ctx = context("task-review-pause", false);
    uiState.setVinciMode("auto");
    await emit(handlers, "session_start", {}, ctx);
    await tools.get("todo").execute("plan-1", { steps: [{ title: "Change the schema", status: "doing" }] }, undefined, undefined, ctx);
    await tools.get("todo").execute("plan-2", { steps: [{ title: "Change the schema", status: "done" }] }, undefined, undefined, ctx);
    const commit = await emit(handlers, "tool_call", bash("git commit -m x"), ctx);
    check("review pause: the refusal of a finalization command is a recorded hard stop", commit?.block === true && /independent review still found/.test(commit.reason) && hardStop.getVinciHardStop("task-review-pause")?.source === "review-pause");
    hardStop.clearVinciHardStop("task-review-pause");
  }
  {
    // guard: checkpoint gate (headless, no user ask), broad staging, secret staging.
    const { handlers, pi } = harness();
    guard.default(pi);
    const ctx = context("task-guard", false);
    await emit(handlers, "input", { type: "input", text: "Fix the failing test", source: "interactive" }, ctx);
    const unrequested = await emit(handlers, "tool_call", bash("git commit -m x"), ctx);
    check("guard: an unrequested headless checkpoint refusal is a recorded hard stop", unrequested?.block === true && /no UI to confirm/.test(unrequested.reason) && hardStop.getVinciHardStop("task-guard")?.source === "guard");
    hardStop.clearVinciHardStop("task-guard");
    await emit(handlers, "input", { type: "input", text: "Fix the failing test and commit it", source: "interactive" }, ctx);
    const broad = await emit(handlers, "tool_call", bash("git add -A"), ctx);
    check("guard: a broad-staging refusal is a recorded hard stop", broad?.block === true && /broad git staging/.test(broad.reason) && hardStop.getVinciHardStop("task-guard")?.source === "guard");
    hardStop.clearVinciHardStop("task-guard");
    writeFileSync(join(workspace, ".env"), "SECRET=1\n");
    const secret = await emit(handlers, "tool_call", bash("git add .env"), ctx);
    check("guard: a secret-staging refusal is a recorded hard stop", secret?.block === true && /secret/.test(secret.reason) && hardStop.getVinciHardStop("task-guard")?.source === "guard");
    hardStop.clearVinciHardStop("task-guard");
    const interactiveCtx = context("task-guard-interactive", true);
    await emit(handlers, "input", { type: "input", text: "Fix the failing test", source: "interactive" }, interactiveCtx);
    const declined = await emit(handlers, "tool_call", bash("git commit -m x"), interactiveCtx);
    check("guard: a user-declined checkpoint is a recorded hard stop too", declined?.block === true && hardStop.getVinciHardStop("task-guard-interactive")?.source === "guard");
    hardStop.clearVinciHardStop("task-guard-interactive");
    const okCtx = context("task-guard-ok", false);
    await emit(handlers, "input", { type: "input", text: "Fix the failing test and commit it", source: "interactive" }, okCtx);
    const requested = await emit(handlers, "tool_call", bash("git add a.ts && git commit -m x"), okCtx);
    check("guard: a requested explicit commit passes headless without a stop", requested === undefined && hardStop.getVinciHardStop("task-guard-ok") === undefined);
  }

  // ── WARN-3: the full extension stack (guard + loopbreak + todo) in production order ───────────
  async function fullStack(taskId, hasUI) {
    const { handlers, pi } = harness();
    guard.default(pi);
    loopbreak.default(pi);
    todo.default(pi);
    const ctx = context(taskId, hasUI);
    await emit(handlers, "session_start", {}, ctx);
    const input = (text) => emit(handlers, "input", { type: "input", text, source: "interactive" }, ctx);
    const call = (event) => emit(handlers, "tool_call", event, ctx);
    const result = (event) => emit(handlers, "tool_result", event, ctx);
    return { ctx, input, call, result, agentStart: () => emit(handlers, "agent_start", {}, ctx) };
  }
  {
    // Happy path: asked to commit, edits, 26 actions, then the finalization lands through all three.
    verificationState.resetVinciVerificationState();
    const stack = await fullStack("task-stack-ok", false);
    await stack.input("Fix the bug in owner.js and commit it");
    await stack.agentStart();
    const edit = { path: "owner.js", edits: [{ oldText: "before", newText: "after" }] };
    await stack.call({ toolName: "edit", input: edit });
    await stack.result({ toolName: "edit", input: edit, content: [{ type: "text", text: "Successfully replaced 1 block(s)" }], isError: false });
    for (let i = 0; i < loopbreak.TURN_CALL_CEILING + 1; i++) await stack.call(bash(`node check-${i}.js`));
    assert.ok((await stack.call(bash("node check-probe.js")))?.block === true, "the stack is over the ceiling");
    const landed = await stack.call(bash('git add owner.js && git commit -m "fix owner"'));
    check("full stack, unattended: the requested commit passes guard, ceiling, reserve, and todo", landed === undefined);
    await stack.result(okResult('git add owner.js && git commit -m "fix owner"'));
    const outcome = taskOutcome.buildVinciTaskOutcome({ taskId: "task-stack-ok", messages: [assistant("Done: committed the fix.")], changedFiles: ["owner.js"], verification: verificationState.getVinciVerificationState() });
    check("full stack, unattended: no hard stop was recorded and the record is not BLOCKED", hardStop.getVinciHardStop("task-stack-ok") === undefined && outcome.state !== "BLOCKED");
  }
  {
    // Refusal path: the user never asked for a commit; the guard refuses it headless; the record
    // closes BLOCKED although the model narrates completion.
    const stack = await fullStack("task-stack-refused", false);
    await stack.input("Fix the bug in owner.js");
    await stack.agentStart();
    const refusedCommit = await stack.call(bash('git commit -m "fix owner"'));
    const outcome = taskOutcome.buildVinciTaskOutcome({ taskId: "task-stack-refused", messages: [assistant("Done: committed the fix.")], changedFiles: ["owner.js"], verification: verificationState.getVinciVerificationState() });
    check("full stack, unattended: a guard-refused commit closes the record BLOCKED over a 'done' narrative", refusedCommit?.block === true && outcome.state === "BLOCKED" && outcome.hardStop?.source === "guard");
    hardStop.clearVinciHardStop("task-stack-refused");
  }
  {
    // Latch path through the full stack: the automation stop froze mutations; the commit is refused
    // with the unattended wording and the record is BLOCKED.
    const stack = await fullStack("task-stack-latched", false);
    await stack.input("Fix the bug in owner.js and commit it");
    await stack.agentStart();
    control.requestVinciAutomationStop("loop breaker reached its bounded stop");
    const latchedEdit = await stack.call({ toolName: "edit", input: { path: "owner.js", edits: [{ oldText: "a", newText: "b" }] } });
    const latchedCommit = await stack.call(bash('git commit -m "fix owner"'));
    const latchedPush = await stack.call(bash("git push"));
    const outcome = taskOutcome.buildVinciTaskOutcome({ taskId: "task-stack-latched", messages: [assistant("Done: committed the fix.")], changedFiles: ["owner.js"], verification: verificationState.getVinciVerificationState() });
    check(
      "full stack, unattended: the latch refuses further edits with the unattended wording and the record is BLOCKED",
      latchedEdit?.block === true && /unattended run: ending the task as BLOCKED/.test(latchedEdit.reason) && outcome.state === "BLOCKED" && outcome.hardStop?.source === "latch",
    );
    check("full stack, unattended: under the latch the work already made may still be committed locally, never pushed", latchedCommit === undefined && latchedPush?.block === true);
    // Interactively the latch is unchanged: the commit waits for the user's next instruction.
    const interactiveStack = await fullStack("task-stack-latched-tui", true);
    await interactiveStack.input("Fix the bug in owner.js and commit it");
    await interactiveStack.agentStart();
    control.requestVinciAutomationStop("loop breaker reached its bounded stop"); // the user input above released the previous stop
    const tuiCommit = await interactiveStack.call(bash('git commit -m "fix owner"'));
    check("full stack, interactive: the latch still refuses the commit and asks for the next instruction", tuiCommit?.block === true && /Wait for the user's next instruction/.test(tuiCommit.reason));
    hardStop.clearVinciHardStop("task-stack-latched-tui");
    control.clearVinciAutomationStop();
    hardStop.clearVinciHardStop("task-stack-latched");
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\nunattended-harness-integration: ${pass}/${pass} checks passed (no contradictions in vinci -p)`);
