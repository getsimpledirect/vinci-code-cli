// Verification-ENABLED lane for the model-graded completion gate (#10 Slice D).
//
// The deterministic verification orchestration (record/rerun/anti-laundering/receipt) is covered by
// verification-state-integration.mjs with VINCI_NO_VERIFY unset. What had NO offline coverage is the
// PHASE-2 behavioral review — the independent grader that runs on the "all steps done" transition in
// vinci-todo.ts. It normally calls the MODEL, so it was only exercised in the credit-gated smoke/EC2
// lanes. vinci-todo's default export injects the grader (`function (pi, gradePlan = gradeChanges)`), so
// we stub it with scripted verdicts and assert the gate HONORS them AND that the pause actually takes
// effect (a paused review blocks a mutating tool — not just a label on the return value).
//
// VINCI_NO_VERIFY is deliberately NOT set here — the completion gate runs live.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const stateModule = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const todoModule = await loader.import(resolve(here, "../extensions/vinci-todo.ts"), { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

// ── Stubbed independent grader (no model, no credits) ─────────────────────────
let gradeCalls = 0;
let nextGrade = null; // GradeResult | (() => GradeResult) that may throw
const gradePlan = async (_ctx) => {
  gradeCalls++;
  return typeof nextGrade === "function" ? nextGrade() : nextGrade;
};

// ── pi + ctx mocks (capture registered handlers so we can drive tool_call/turn_end) ──
const handlers = {};
const sent = [];
const notifications = [];
const pi = {
  on(name, fn) {
    (handlers[name] ??= []).push(fn);
  },
  registerCommand() {},
  registerTool(tool) {
    if (tool.name === "todo") pi._todo = tool;
  },
  sendMessage(message, options) {
    sent.push({ message, options });
  },
};
todoModule.default(pi, gradePlan);
const todo = pi._todo;
assert.ok(todo && typeof todo.execute === "function", "todo tool registered");

const ctx = {
  hasUI: true,
  hasPendingMessages: () => false,
  cwd: "/tmp/verification-review-test",
  ui: {
    notify: (m, level) => notifications.push({ m, level }),
    setWidget: () => {},
  },
  sessionManager: { getBranch: () => [] },
};

const run = (steps) => todo.execute("call", { steps }, undefined, undefined, ctx);
const step = (title, status) => ({ title, status });
const control = (type) => [...sent].reverse().find((s) => s.message.customType === type)?.message.content ?? "";
const lastNotify = () => notifications.at(-1)?.m ?? "";
async function emit(name, event) {
  let result;
  for (const handler of handlers[name] ?? []) {
    const next = await handler(event, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}
// A mutating tool call — blocked by the tool_call handler iff a review pause is in effect.
const mutatingToolCall = () => emit("tool_call", { type: "tool_call", toolName: "write", input: { path: "src/x.ts" } });

// Drive a clean transition to all-done with a fresh plan shape. Unique titles per scenario force
// `!sameShape`, which resets reviewReopens/reviewPaused so scenarios don't leak. Resetting verification
// state clears any incomplete behavioral attempt that would downgrade all-done (todo.ts ~169-176).
// Returns the transition result AND the number of grader calls it caused (must be exactly 1).
async function toAllDone(titles) {
  stateModule.resetVinciVerificationState();
  await run(titles.map((t, i) => step(t, i === titles.length - 1 ? "doing" : "done")));
  sent.length = 0;
  notifications.length = 0;
  const before = gradeCalls;
  const result = await run(titles.map((t) => step(t, "done")));
  return { result, delta: gradeCalls - before };
}

// ── ships → accept (not reopened, not paused); a mutating tool is NOT blocked ──
nextGrade = { text: "Looks correct; no issues.", verdict: "ships" };
const ships = await toAllDone(["ships-a", "ships-b"]);
check("the gate consults the grader exactly once on the all-done transition", ships.delta === 1);
check("a 'ships' verdict is accepted (independent review passed)", /Independent review passed/.test(ships.result.content[0].text));
check("a 'ships' verdict does NOT reopen or pause the plan", !ships.result.details?.reviewed && !ships.result.details?.paused);
check("a 'ships' verdict steers to a real check via vinci-plan-verify", /Independent review passed/.test(control("vinci-plan-verify")));
check("a 'ships' verdict sends no reopen/stop control", !sent.some((s) => /vinci-plan-review(-stop)?$/.test(s.message.customType)));
const notBlockedWhenShipped = await mutatingToolCall();
check("a mutating tool is NOT blocked when the review passed (pause-effect contrast)", notBlockedWhenShipped === undefined);

// ── fires ONCE per transition (re-sending all-done does not re-grade) ──────────
const beforeResend = gradeCalls;
await run([step("ships-a", "done"), step("ships-b", "done")]);
check("re-sending an already-all-done plan does not re-run the grader", gradeCalls === beforeResend);

// ── needs-work → reopen (task is NOT done), findings handed to the model ───────
nextGrade = { text: "The null case is unhandled in parseInput().", verdict: "needs-work" };
const nw1 = await toAllDone(["nw-a", "nw-b"]);
check("a 'needs-work' verdict grades exactly once", nw1.delta === 1);
check("a 'needs-work' verdict REOPENS the last step (details.reviewed, not paused)", nw1.result.details?.reviewed === true && !nw1.result.details?.paused);
check("a 'needs-work' verdict reports the last step reopened", /last step reopened/i.test(nw1.result.content[0].text));
check("the reopen control carries the concrete findings and says the task is not done", /null case is unhandled/.test(control("vinci-plan-review")) && /task is not done/i.test(control("vinci-plan-review")));
check("a first needs-work reopens (not paused) and says so", /reopening the last step/i.test(lastNotify()));

// ── second needs-work on the SAME shape → bounded pause (MAX_REVIEW_REOPENS=1) ──
sent.length = 0;
notifications.length = 0;
const beforeBounded = gradeCalls;
nextGrade = { text: "Still unhandled after the repair pass.", verdict: "needs-work" };
const bounded = await run([step("nw-a", "done"), step("nw-b", "done")]); // reopened last step → done again → 2nd transition
check("the second needs-work also grades exactly once", gradeCalls === beforeBounded + 1);
check("a second consecutive needs-work PAUSES automation (bounded reopen)", bounded.details?.paused === true);
check("the bounded pause emits vinci-plan-review-stop with the findings", /still found unresolved issues/i.test(control("vinci-plan-review-stop")) && /Still unhandled/.test(control("vinci-plan-review-stop")));
check("the bounded pause notifies the user that automation paused", /automation paused/i.test(lastNotify()));
// PAUSE EFFECT (not just a label): reviewPaused is now set, so a mutating tool is blocked.
const blockedWhilePaused = await mutatingToolCall();
check("a paused review BLOCKS a mutating tool (reviewPaused actually took effect)", blockedWhilePaused?.block === true && /paused further changes/i.test(blockedWhilePaused?.reason ?? ""));

// ── risky → pause on the FIRST transition (before any reopen budget is spent) ──
sent.length = 0;
notifications.length = 0;
nextGrade = { text: "Deletes user data without a confirmation guard.", verdict: "risky" };
const risky = await toAllDone(["rk-a", "rk-b"]);
check("a 'risky' verdict grades exactly once", risky.delta === 1);
check("a 'risky' verdict pauses on the FIRST transition (no reopen budget spent)", risky.result.details?.paused === true);
check("a 'risky' pause emits vinci-plan-review-stop naming the risk", /Deletes user data/.test(control("vinci-plan-review-stop")));
check("a 'risky' pause notifies the user (scenario-local)", /automation paused/i.test(lastNotify()));
const blockedAfterRisky = await mutatingToolCall();
check("a risky pause also blocks a mutating tool", blockedAfterRisky?.block === true);

// ── grader returns null (timeout/unavailable) → fail-safe, plan stays CLOSED ───
// (The literal 30s Promise.race timeout mechanism isn't timed here — that would need fake timers — but
// its OUTCOME, a null grade degrading to the fail-safe note, is what matters and is asserted.)
sent.length = 0;
notifications.length = 0;
nextGrade = null;
const nullGrade = await toAllDone(["nl-a", "nl-b"]);
check("a null/unavailable grade is fail-safe (no reopen, no pause)", nullGrade.delta === 1 && !nullGrade.result.details?.reviewed && !nullGrade.result.details?.paused);
check("a null grade still requires a real check, not a false completion", /Verification still required/.test(nullGrade.result.content[0].text) && /completion still needs evidence/i.test(control("vinci-plan-verify")));
const beforeNullResend = gradeCalls;
await run([step("nl-a", "done"), step("nl-b", "done")]);
check("a null-graded plan stays CLOSED (no silent reopen → no re-grade on resend)", gradeCalls === beforeNullResend);
const notBlockedAfterNull = await mutatingToolCall();
check("a null grade does not pause (mutating tool still allowed)", notBlockedAfterNull === undefined);

// ── grader THROWS → caught, same fail-safe (never breaks the todo tool) ────────
sent.length = 0;
notifications.length = 0;
nextGrade = () => {
  throw new Error("grader network error");
};
let threw = false;
let errGrade;
try {
  errGrade = await toAllDone(["er-a", "er-b"]);
} catch {
  threw = true;
}
check("a grader that throws never breaks the todo tool", threw === false && !!errGrade);
check("a grader-throw transition still grades exactly once", errGrade.delta === 1);
check("a thrown grader degrades to the fail-safe note and does not pause", /Verification still required/.test(errGrade.result.content[0].text) && !errGrade.result.details?.paused);
const beforeThrowResend = gradeCalls;
nextGrade = null; // don't throw on the resend; it must simply not re-transition
await run([step("er-a", "done"), step("er-b", "done")]);
check("a thrown-grader plan stays CLOSED (no silent reopen → no re-grade on resend)", gradeCalls === beforeThrowResend);

console.log(`verification-review-integration: ${pass}/${pass} checks passed (model-graded completion gate honors ships/needs-work/risky/error, pause takes effect)`);
// Production's completion gate races the grader against an un-unref'd 30s setTimeout; each transition
// leaves one pending timer that would keep this short-lived test process alive ~30s. All assertions
// passed (assert throws → non-zero exit before here on any failure), so exit cleanly now.
process.exit(0);
