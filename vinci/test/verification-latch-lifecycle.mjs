// The verification latch lifecycle: RECORD -> COACH -> CLEAR.
//
// Written BEFORE the implementation as the acceptance criteria for #66, so the goal was stated in
// executable form rather than discovered afterwards. It reported 16 violated guarantees against the
// shipped build; it is wired into run.sh in the same change that makes it pass.
//
// See vinci/docs/VERIFICATION_LATCH_DESIGN.md. Three patch rounds on #56/#66 each fixed the symptom
// in front of them and broke or missed another operation, because the three were never specified
// together. The defect this file exists to prevent is guarantee 8:
//
//     Every latch that can be created can be CLEARED by running what it names.
//
// Two rounds shipped a latch that formed correctly and could never resolve, because every test
// asserted that the latch FORMS and none asserted that it RESOLVES. So every shape here is driven
// fail -> exact rerun -> clear.
//
// Shapes are taken from a measurement over 1,283 recorded sessions (406 verification commands):
// 47.3% direct, 41.1% filtered, 4.2% multi-segment compounds, 7.4% unreplayable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const verification = await loader.import(resolve(here, "../extensions/vinci-verification.ts"), { default: false });
const stateModule = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });

const handlers = {};
const pi = {
  on(name, handler) {
    (handlers[name] ||= []).push(handler);
  },
  addTool() {},
  registerTool() {},
  registerCommand() {},
  sendMessage() {},
  appendEntry() {},
  exec() {
    return { stdout: "", stderr: "", code: 0, killed: false };
  },
};
verification.default(pi);

const RED = "--- FAIL: TestAllocate (0.01s)\nFAIL\nTests: 1 failed, 3 passed";
const GREEN = "ok  \texample/money\t1.2s\nPASS\nTests: 12 passed";

function context(cwd) {
  return {
    cwd,
    hasUI: true,
    hasPendingMessages: () => false,
    ui: { setWidget() {}, notify() {} },
    sessionManager: { getSessionId: () => "latch-lifecycle", getBranch: () => [], getSessionDir: () => cwd },
  };
}
async function emit(name, event, cwd) {
  for (const handler of handlers[name] ?? []) await handler(event, context(cwd));
}
function toolResult(command, output, isError = false) {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: `bash-${Math.abs(command.length)}`,
    input: { command },
    content: [{ type: "text", text: output }],
    isError,
  };
}
async function freshMutation(cwd) {
  stateModule.resetVinciVerificationState();
  await emit("session_start", { type: "session_start" }, cwd);
  await emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "runtime.go" },
      content: [{ type: "text", text: "Applied changes" }],
      isError: false,
    },
    cwd,
  );
}

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

// Display-only filters are removed from identity; anything else is not display-only.
const stripDisplayFilter = (command) => verification.stripPipeFilteredSuffix(command);

// ── Shapes that MUST latch and MUST clear on an exact rerun ────────────────────────────────────
const LATCHING = [
  ["single direct verifier", (d) => `cd ${d} && go test ./...`],
  ["filtered direct verifier (#56)", (d) => `cd ${d} && go test ./... 2>&1 | head -50`],
  ["vet then test (corpus)", (d) => `cd ${d} && go vet ./... && go test ./...`],
  ["clean then test (corpus)", (d) => `cd ${d} && rm -rf build && make test`],
  ["probe tool then test (corpus)", (d) => `cd ${d} && ls node_modules/.bin/mocha && node_modules/.bin/mocha t.js`],
  ["informational prefix (#56's own report)", (d) => `cd ${d} && go version && go test ./... 2>&1 | head -50`],
  // Trailing `; echo` markers are display-only decoration. Models add them to read the exit code;
  // this exact command came from a live drive that ended BLOCKED on correct code.
  ["chain with exit-code marker (live)", (d) => `cd ${d} && go vet ./... && go test ./... 2>&1; echo "---EXIT $?---"`],
  ["direct with exit-code marker", (d) => `cd ${d} && go test ./... 2>&1; echo "---EXIT $?---"`],
];

for (const [label, build] of LATCHING) {
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-"));
  try {
    const command = build(dir);
    await freshMutation(dir);
    await emit("tool_result", toolResult(command, RED, true), dir);

    const latched = stateModule.getVinciVerificationState();
    check(latched.variant === "normal", `${label}: RECORD must latch, got ${latched.variant}`);
    check(latched.status === "failed", `${label}: RECORD must be failed, got ${latched.status}`);
    check(
      !("commandCwd" in latched),
      `${label}: a leading-cd verifier must keep its textual identity without commandCwd`,
    );

    // COACH must name something runnable, and never a narrower segment.
    const named = latched.requiredCommand || latched.command;
    check(Boolean(named), `${label}: COACH must name a command (anti-trap invariant)`);
    check(named.includes(dir), `${label}: COACH must carry the working directory`);

    // DONE stays blocked while red.
    const blocked = taskOutcome.classifyVinciTaskState(
      [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] }],
      ["runtime.go"],
      latched,
    );
    check(blocked.state === "BLOCKED", `${label}: a red latch must block DONE`);

    // CLEAR: running exactly what was named, passing, must resolve it. THIS is guarantee 8.
    await emit("tool_result", toolResult(stripDisplayFilter(named), GREEN, false), dir);
    const cleared = stateModule.getVinciVerificationState();
    check(
      cleared.status === "passed",
      `${label}: CLEAR — the exact named command passing must clear the latch, got ${cleared.variant}/${cleared.status}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── GUARANTEE 2 for a command that does NOT name its own directory ─────────────────────────────
// `npm run lint && npm test` is a real corpus shape. It carries no `cd`, so identity must come from
// the session cwd — otherwise the same text passing in another repository clears this latch.
{
  const dirA = mkdtempSync(join(tmpdir(), "vinci-nocd-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "vinci-nocd-b-"));
  const command = "npm run lint && npm test";
  try {
    await freshMutation(dirA);
    await emit("tool_result", toolResult(command, RED, true), dirA);
    const latched = stateModule.getVinciVerificationState();
    check(latched.status === "failed", `no-cd chain: RECORD must latch, got ${latched.variant}/${latched.status}`);
    check(latched.commandCwd === dirA, `no-cd chain: RECORD must bind the latch to cwd A`);

    // Same text, different directory: MUST NOT clear.
    await emit("tool_result", toolResult(command, GREEN, false), dirB);
    const afterOther = stateModule.getVinciVerificationState();
    check(
      afterOther.status !== "passed" && afterOther.commandCwd === dirA,
      `no-cd chain: CLEAR must reject the same command in cwd B (got ${afterOther.variant}/${afterOther.status})`,
    );

    // Same text, same directory: MUST clear.
    await emit("tool_result", toolResult(command, GREEN, false), dirA);
    const afterSame = stateModule.getVinciVerificationState();
    check(
      afterSame.status === "passed",
      `no-cd chain: CLEAR — same command in the same directory must clear, got ${afterSame.variant}/${afterSame.status}`,
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

// ── A higher-class pass is still directory-bound ──────────────────────────────────────────────
// Guarantee 4 supersedes a lower-class latch only within the directory covered by Guarantee 2.
{
  const dirA = mkdtempSync(join(tmpdir(), "vinci-nocd-direct-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "vinci-nocd-direct-b-"));
  try {
    await freshMutation(dirA);
    await emit("tool_result", toolResult("npm test", RED, true), dirA);
    await emit("tool_result", toolResult("npm test", GREEN, false), dirB);
    const afterOther = stateModule.getVinciVerificationState();
    check(
      afterOther.status !== "passed" && afterOther.commandCwd === dirA,
      "same-class cwd: direct pass in cwd B must not clear cwd A's behavioral latch",
    );
    await emit("tool_result", toolResult("npm test", GREEN, false), dirA);
    check(stateModule.getVinciVerificationState().status === "passed", "same-class cwd: direct pass in cwd A clears");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

{
  const dirA = mkdtempSync(join(tmpdir(), "vinci-nocd-class-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "vinci-nocd-class-b-"));
  try {
    await freshMutation(dirA);
    await emit("tool_result", toolResult("npm run lint", RED, true), dirA);
    const latched = stateModule.getVinciVerificationState();
    check(latched.status === "failed" && latched.commandCwd === dirA, "higher-class cwd: static failure binds to cwd A");

    await emit("tool_result", toolResult("npm test", GREEN, false), dirB);
    const afterOther = stateModule.getVinciVerificationState();
    check(
      afterOther.status !== "passed" && afterOther.commandCwd === dirA,
      "higher-class cwd: behavioral pass in cwd B must not clear cwd A's static latch",
    );

    await emit("tool_result", toolResult("npm test", GREEN, false), dirA);
    const afterSame = stateModule.getVinciVerificationState();
    check(afterSame.status === "passed", "higher-class cwd: behavioral pass in cwd A clears by Guarantee 4");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

// ── A pass in a DIFFERENT directory must never clear ───────────────────────────────────────────
{
  const first = mkdtempSync(join(tmpdir(), "vinci-latch-a-"));
  const second = mkdtempSync(join(tmpdir(), "vinci-latch-b-"));
  try {
    await freshMutation(first);
    await emit("tool_result", toolResult(`cd ${first} && go vet ./... && go test ./...`, RED, true), first);
    await emit("tool_result", toolResult(`cd ${second} && go vet ./... && go test ./...`, GREEN, false), second);
    const state = stateModule.getVinciVerificationState();
    check(state.status !== "passed", "directory binding: a pass elsewhere must not clear the latch");
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
}

// ── A NARROWER segment passing must never clear ────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-narrow-"));
  try {
    await freshMutation(dir);
    await emit("tool_result", toolResult(`cd ${dir} && go vet ./... && go test ./...`, RED, true), dir);
    await emit("tool_result", toolResult(`cd ${dir} && go test ./...`, GREEN, false), dir);
    const state = stateModule.getVinciVerificationState();
    check(state.status !== "passed", "no narrowing: one segment passing must not clear a chain latch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── #146 laundering guard: zero collection is only an attempt and never clears a real latch ───
{
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-zero-collection-"));
  try {
    const failedCommand = `cd ${dir} && go test ./...`;
    await freshMutation(dir);
    await emit("tool_result", toolResult(failedCommand, RED, true), dir);
    const latched = stateModule.getVinciVerificationState();
    check(latched.status === "failed", "#146 zero collection: the attributable failure must latch first");
    check(latched.requiredCommand === failedCommand, "#146 zero collection: the original failure owns the latch");

    await emit(
      "tool_result",
      toolResult("pytest -k does_not_exist tests/", "collected 0 items\nno tests ran in 0.01s", true),
      dir,
    );
    const afterZeroCollection = stateModule.getVinciVerificationState();
    check(afterZeroCollection.status === "failed", "#146 zero collection: a zero-test attempt cannot soften failed to stale");
    check(
      afterZeroCollection.requiredCommand === failedCommand,
      "#146 zero collection: fail → zero-test attempt keeps the exact attributable rerun latched",
    );
    check(
      afterZeroCollection.behavioralAttemptCompleted === false,
      "#146 zero collection: the later zero-test command is recorded only as an incomplete attempt",
    );
    const outcome = taskOutcome.classifyVinciTaskState(
      [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] }],
      ["runtime.go"],
      afterZeroCollection,
    );
    check(outcome.state === "BLOCKED", "#146 zero collection: a latched failure remains BLOCKED with no DONE_UNVERIFIED upgrade");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Shapes that must stay honestly terminal ────────────────────────────────────────────────────
// RED output through a surviving non-display pipe is real failure evidence, but a surviving pipe
// means no identity can be formed through it — so it stays terminal, exactly as before #69. Only
// the green / no-red-evidence case changes (see the #69 block below).
const TERMINAL = [
  ["non-display pipe (red)", (d) => `cd ${d} && npm test | tee out.log`],
  ["command substitution", () => "cd $(git rev-parse --show-toplevel) && npm test"],
  ["|| joiner", () => "npm test || echo failed"],
];
for (const [label, build] of TERMINAL) {
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-t-"));
  try {
    await freshMutation(dir);
    await emit("tool_result", toolResult(build(dir), RED, true), dir);
    const state = stateModule.getVinciVerificationState();
    // Assert the terminal variant OUTRIGHT. The former `|| state.status !== "failed"` escape
    // contradicted this block's own heading — these shapes must stay honestly terminal — and it
    // accepted any non-failed state, so downgrading the production call to an evidence gap left
    // this suite green. Verified: replacing recordVinciTerminalUnverifiable() with
    // recordVinciEvidenceGap(summary) passed here.
    //
    // The red-pipe row is separately pinned by the #69 regression in
    // verification-state-integration.mjs, so what was missing here was LOCAL coverage rather than
    // any coverage. The command-substitution and `||` rows had none anywhere.
    check(
      state.variant === "terminal-unverifiable",
      `${label}: an unformable identity must stay terminal (got ${state.variant}/${state.status})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A pipeline exit with no red output must not latch a passing suite ──────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-pipe-"));
  try {
    await freshMutation(dir);
    await emit("tool_result", toolResult(`cd ${dir} && go test ./... 2>&1 | head -50`, GREEN, true), dir);
    const state = stateModule.getVinciVerificationState();
    check(state.status !== "failed", "attribution: a filter's exit status must not latch a passing suite as failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Issue #69: a surviving pipeline with GREEN output records an ATTEMPT, not a failure ──────────
// `npm test | tee out.log` is a non-display pipe (tee writes a file), so its exit status belongs to
// tee, not the verifier. A nonzero tool result with green output is NOT attributable failure
// evidence: per VERIFICATION_LATCH_DESIGN.md RECORD, "a pipeline exit with no red output records an
// attempt, not a failure." Before #69 this terminalized on green — a hard BLOCKED on a passed suite.
{
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-surviving-"));
  try {
    await freshMutation(dir);
    // tee's nonzero exit (or a pipe-closed-early signal) with a passing suite in the output.
    await emit("tool_result", toolResult(`cd ${dir} && npm test | tee out.log`, GREEN, true), dir);
    const state = stateModule.getVinciVerificationState();
    check(
      state.variant !== "terminal-unverifiable",
      `#69 green surviving pipe: must NOT terminalize on green output (got ${state.variant}/${state.status})`,
    );
    check(
      state.status !== "failed",
      `#69 green surviving pipe: must NOT latch a completed failure on green output (got ${state.variant}/${state.status})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── #69 laundering guard: a green surviving pipe must NOT clear a latched direct failure ──────
// Guarantee 3 / #22: a passing run whose exit status is unattributable can never clear a latch
// recorded by a DIRECT verifier. The fix must not let the new attribution exemption launder red.
{
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-launder-"));
  try {
    await freshMutation(dir);
    // A clean direct verifier fails and latches.
    await emit("tool_result", toolResult(`cd ${dir} && go test ./...`, RED, true), dir);
    let state = stateModule.getVinciVerificationState();
    check(state.variant === "normal" && state.status === "failed", `#69 launder: DIRECT verifier must latch (got ${state.variant}/${state.status})`);
    // A green `npm test | tee out.log` shares the verifier but the exit status is unattributable;
    // it must NOT clear the latch.
    await emit("tool_result", toolResult(`cd ${dir} && npm test | tee out.log`, GREEN, false), dir);
    state = stateModule.getVinciVerificationState();
    check(state.status !== "passed", `#69 launder: a green surviving pipe must not clear a latched direct failure (got ${state.variant}/${state.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── #69 pin: a pure display-filter pipe still yields normal/stale (the correct baseline) ───────
// `| grep -c PASS` is an allowlisted pure filter, so it is exempted as output-filtering. This must
// not change under #69: grep IS on the allowlist, so pipeFiltered is true and the run is not a
// completed failure.
{
  const dir = mkdtempSync(join(tmpdir(), "vinci-latch-grep-"));
  try {
    await freshMutation(dir);
    await emit("tool_result", toolResult(`cd ${dir} && go test ./... | grep -c PASS`, "1", true), dir);
    const state = stateModule.getVinciVerificationState();
    check(state.status !== "failed", `#69 pin grep -c PASS: must not latch a completed failure (got ${state.variant}/${state.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`verification latch lifecycle: ${failures.length} guarantee(s) violated`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("  verification latch lifecycle: record → coach → clear holds for every measured shape");
