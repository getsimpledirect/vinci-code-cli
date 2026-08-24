// Integration check: drive the REAL vinci-loopbreak extension's tool_call hook via a mock `pi`,
// proving the shipped module (not a reimplementation) blocks a genuine no-progress loop. Node 23
// strips the type-only import at load, so we can import the .ts directly.
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const ext = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });
const verification = await loader.import(resolve(here, "../extensions/vinci-verification.ts"), { default: false });
const ownership = await loader.import(resolve(here, "../extensions/lib/source-ownership-state.ts"), { default: false });
const verificationState = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });

// Minimal mock of the ExtensionAPI: capture the handlers the extension registers.
const handlers = {};
const handlerLists = {};
const controls = [];
const pi = {
  on: (name, fn) => {
    handlers[name] = fn;
    (handlerLists[name] ??= []).push(fn);
  },
  sendMessage: (message, options) => { controls.push({ message, options }); },
  // Stubs must keep pace with what the extension registers, or loading it throws (#10 added
  // /verify; the same class of gap as the print-mode stub in #153).
  registerCommand: () => {},
  registerTool: () => {},
  appendEntry: () => {},
};
ext.default(pi);
assert.ok(handlers.tool_call, "extension must register a tool_call handler");
assert.ok(handlers.agent_start, "extension must register an agent_start handler");
assert.ok(handlers.input, "extension must register an input handler (captures the task)");
assert.ok(handlers.tool_result, "extension must register a tool_result handler (captures context)");

// No ctx.model/modelRegistry → escalation can't reach a stronger tier and degrades to stop-and-report.
// ctx.abort spy: the hard-stop must ACTUALLY end the turn (not just block one call).
// abort() from a tool_call hook HANGS both TUI and print (verified) — so it must NEVER be called.
// This spy asserts that: `aborted` must stay 0 across every scenario.
let aborted = 0;
const ctx = { hasUI: false, ui: { notify() {} }, cwd: "/tmp", mode: "tui", abort: () => { aborted++; } };
const call = (toolName, input) => handlers.tool_call({ toolName, input }, ctx);
const newTurn = () => handlers.agent_start({}, ctx);
const emit = async (name, event) => {
  for (const handler of handlerLists[name] ?? []) await handler(event, ctx);
};

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

// 1. Three identical no-progress calls: 1st & 2nd allowed, 3rd blocked.
await newTurn();
const same = { command: "node -e \"console.log('café'.replace(/x/,''))\"" };
const r1 = await call("bash", same);
const r2 = await call("bash", same);
const r3 = await call("bash", same);
check("1st identical call allowed", r1 === undefined);
check("2nd identical call allowed", r2 === undefined);
check("3rd identical call BLOCKED (steer)", r3 && r3.block === true && /paused a repeated action/i.test(r3.reason));
// 4th identical repeat = 2nd intervention → escalate; with no stronger tier it degrades to stop-and-report.
const r4 = await call("bash", same);
check("4th identical call escalates → stop-and-report when no stronger tier", r4 && r4.block === true && /paused a repeated action/i.test(r4.reason));
// 5th identical repeat = 3rd intervention → firm stop-and-report block (never abort — it hangs).
const r5 = await call("bash", same);
check("5th identical call → firm stop-and-report block, never abort", r5 && r5.block === true && /stopped a repeated action/i.test(r5.reason) && aborted === 0);

// 1b. P2-5: the stuck notify must describe the path actually taken. With no stronger tier reachable
// (no ctx.model here → getUnstuck returns null → reframe/failure path), the user must NOT be told a
// "stronger teammate" was asked — it wasn't.
await newTurn();
const stuckNotices = [];
ctx.hasUI = true;
ctx.ui.notify = (message, level) => stuckNotices.push({ message, level });
const stuckCall = { command: "node stuck-notify.js" };
await call("bash", stuckCall);
await call("bash", stuckCall);
await call("bash", stuckCall); // intervention 1: reframe nudge
await call("bash", stuckCall); // intervention 2: getUnstuck resolves (null) → fresh-look wording
check(
  "the stuck notify says 'fresh look' (never 'stronger teammate') when no escalation happened",
  stuckNotices.some((n) => /taking a fresh look at where it went wrong/i.test(n.message)) &&
    !stuckNotices.some((n) => /stronger teammate/i.test(n.message)),
);
ctx.hasUI = false;
ctx.ui.notify = () => {};

// 1c. P2-5: the escalation path (a genuinely stronger model answering) needs a live completion and
// isn't harness-reachable — assert by source inspection that the teammate notify only fires AFTER
// getUnstuck resolves and only on the escalated path.
const loopbreakSource = await readFile(resolve(here, "../extensions/vinci-loopbreak.ts"), "utf8");
check(
  "the stronger-teammate notify fires after getUnstuck resolves, gated on an actual escalation",
  loopbreakSource.indexOf("await getUnstuck(") < loopbreakSource.indexOf("stronger teammate for a hand") &&
    /help\?\.escalated\s*\?\s*"Vinci's stuck — asking a stronger teammate for a hand\."/.test(loopbreakSource) &&
    /:\s*"Vinci's stuck — taking a fresh look at where it went wrong\."/.test(loopbreakSource),
);

// 1d. P2-6: TRY_DIFFERENT prescribes advisor/convene_council — after a fixation intervention the
// FIRST such call must pass the per-turn ceiling (one-shot), the second is blocked again.
await newTurn();
const fixated = { command: "node fixated.js" };
await call("bash", fixated);
await call("bash", fixated);
const fixatedBlock = await call("bash", fixated); // intervention 1 → TRY_DIFFERENT prescribes advisor
check("the fixation intervention still blocks the repeated call", fixatedBlock?.block === true);
// Spend exactly the rest of the budget (3 bash calls already made) so the NEXT call sits at the
// ceiling. Derived from the exported constant so tuning the ceiling can't silently void this test.
for (let i = 0; i < ext.TURN_CALL_CEILING - 3; i++) await call("edit", { path: `fixation-budget-${i}.js`, edits: [] });
const advisorAtCeiling = await call("advisor", { question: "How do I get unstuck here?" });
const secondAdvisorAtCeiling = await call("convene_council", { question: "Still stuck — other ideas?" });
check("the first prescribed advisor call is exempt from the per-turn ceiling", advisorAtCeiling === undefined);
check("the advisor ceiling exemption is single-use", secondAdvisorAtCeiling?.block === true);

// Without a fixation intervention this turn, advisor gets no ceiling exemption at all.
await newTurn();
for (let i = 0; i < ext.TURN_CALL_CEILING + 1; i++) await call("edit", { path: `no-fixation-${i}.js`, edits: [] });
check(
  "advisor past the ceiling stays blocked when no fixation intervention armed the exemption",
  (await call("advisor", { question: "help?" }))?.block === true,
);

// Reported speech excludes a passing-test phrase only when a reporting verb governs that claim.
// An incidental verb in an earlier clause must not preserve Vinci's own contradictory success claim.
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification("npm run check", true, "Static check passed.", false, "static");
verificationState.recordVinciVerificationAttempt("npm test", "behavioral");
for (const [message, replaced] of [
  ["As I mentioned earlier, all 32/32 tests passed after the fix.", true],
  ["The user said: all specs succeeded.", false],
  ["CI reported that all tests passed.", false],
  ["I checked; all tests passed.", true],
]) {
  const receipt = verification.groundedCompletionReceipt(message);
  check(
    `${JSON.stringify(message)} is ${replaced ? "replaced" : "excluded as reported speech"}`,
    replaced
      ? !receipt.includes(message) && /Done — please check it:/i.test(receipt)
      : receipt.includes(message) && /Done — please check it:/i.test(receipt),
  );
}

// P3-9: invalid-call coaching state belongs to one task. Three invalid calls in one turn must not
// make the first invalid call in an unrelated turn look like the fourth consecutive failure.
await newTurn();
const invalidResult = {
  message: {
    role: "toolResult",
    toolName: "edit",
    isError: true,
    content: [{ type: "text", text: "Validation failed for tool edit: must have required property 'edits'" }],
  },
};
await emit("message_end", invalidResult);
await emit("message_end", invalidResult);
await emit("message_end", invalidResult);
const invalidControlsBeforeNewTurn = controls.filter(({ message }) => message.customType === "vinci-invalid-tool").length;
await emit("input", { text: "Start an unrelated task", source: "interactive" });
await newTurn();
await emit("message_end", invalidResult);
check(
  "a non-continuation turn resets the invalid-call counter",
  controls.filter(({ message }) => message.customType === "vinci-invalid-tool").length === invalidControlsBeforeNewTurn,
);

// 2. An edit between repeats resets the counter (legit edit -> re-run the test, forever).
await newTurn();
const test = { command: "node test.mjs" };
await call("bash", test);
await call("bash", test);
await call("edit", { path: "x", edits: [] }); // world changed -> reset
const afterEdit = await call("bash", test);
check("edit resets the loop counter (re-run allowed)", afterEdit === undefined);

// 3. Whitespace-only variation does NOT dodge the detector.
await newTurn();
await call("bash", { command: "node  a" });
await call("bash", { command: "node a" });
const wsDodge = await call("bash", { command: "node   a" });
check("whitespace-only variation still blocked", wsDodge && wsDodge.block === true);

// 4. Genuinely different calls are never blocked.
await newTurn();
let anyBlocked = false;
for (const c of ["ls", "cat a", "grep x .", "node t", "ls -la", "cat b"]) {
  const r = await call("bash", { command: c });
  if (r && r.block) anyBlocked = true;
}
check("varied calls never blocked", anyBlocked === false);

await newTurn();
for (let i = 0; i < 12; i++) await call("bash", { command: `grep foo file${i}` });
const resetEdit = { path: "x", edits: [{ oldText: "before", newText: "after" }] };
await call("edit", resetEdit);
await emit("tool_result", {
  toolName: "edit",
  input: resetEdit,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
});
check("an edit resets the exploration streak", (await call("bash", { command: "grep foo again" })) === undefined);

// Once code has changed, source navigation remains available to locate exact edit/check regions.
// Non-navigation investigation remains bounded, and verification/direct repairs stay available.
await newTurn();
const postMutationEdit = { path: "owner.js", edits: [{ oldText: "before", newText: "after" }] };
await call("edit", postMutationEdit);
await emit("tool_result", {
  toolName: "edit",
  input: postMutationEdit,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
});
for (let i = 0; i < 3; i++) assert.equal(await call("read", { path: `test-${i}.js` }), undefined);
const postMutationWidening = await call("read", { path: "another-test.js" });
const postMutationVerifier = await call("bash", { command: "npm test -- --grep focused" });
check("post-mutation source navigation remains available", postMutationWidening === undefined);
check("focused verification remains available after post-mutation reads", postMutationVerifier === undefined);

// Issue #8: check strength is a ratchet. A piped behavioral suite always gets to run after a static
// pass, while same/lower replacement checks remain blocked.
await newTurn();
verificationState.resetVinciVerificationState();
const ratchetEdit = { path: "runtime.js", edits: [{ oldText: "before", newText: "after" }] };
await call("edit", ratchetEdit);
await emit("tool_result", {
  toolName: "edit",
  input: ratchetEdit,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
});
verificationState.recordVinciVerification("pnpm typecheck", true, "types pass", false, "static", "pnpm typecheck");
const behavioralUpgrade = await call("bash", {
  command: "pnpm test:nodejs --no-coverage 2>&1 | tail -40",
});
const staticReplacement = await call("bash", { command: "pnpm lint" });
check("a higher-class behavioral check is never reserved after a static pass", behavioralUpgrade === undefined);
check("a same-class replacement remains blocked after a static pass", staticReplacement?.block === true);

// Read-only shell commands do not consume the post-mutation inspection allowance and cannot receive
// either reservation message.
await newTurn();
const readOnlyEdit = { path: "readonly.js", edits: [{ oldText: "before", newText: "after" }] };
await call("edit", readOnlyEdit);
await emit("tool_result", {
  toolName: "edit",
  input: readOnlyEdit,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
});
for (let i = 0; i < 4; i++) await call("bash", { command: `inspect-after-mutation-${i}` });
check("git status is never reserved after the post-mutation allowance", (await call("bash", { command: "git status" })) === undefined);
check(
  "git diff is never reserved after the post-mutation allowance",
  (await call("bash", { command: "git diff -- src/runtime.ts" })) === undefined,
);
check(
  "git global -C is parsed before the read-only status subcommand",
  (await call("bash", { command: "git -C . status" })) === undefined,
);
check(
  "safe valueless git globals preserve read-only classification",
  (await call("bash", { command: "git --no-pager status" })) === undefined &&
    (await call("bash", { command: "git --git-dir .git --work-tree . diff" })) === undefined,
);
// -c can point config at executing helpers (core.pager, diff.external), and textconv/ext-diff run
// arbitrary filters — none of these classify read-only anymore (round-12 security ruling).
check(
  "config-injecting and filter-executing git options are never read-only",
  (await call("bash", { command: "git -c color.ui=false --no-pager status" })) !== undefined &&
    (await call("bash", { command: "git diff --textconv -- src/runtime.ts" })) !== undefined,
);
check(
  "an unrecognized git global option is conservatively not read-only",
  (await call("bash", { command: "git --bare status" }))?.block === true,
);
const priorCwd = ctx.cwd;
ctx.cwd = resolve(here, "../..");
check(
  "reading a tracked file is never reserved after the post-mutation allowance",
  (await call("bash", { command: "head -20 package.json" })) === undefined,
);
check(
  "tracked-path lookup is cached per cwd and bounded",
  /trackedPathCache/.test(loopbreakSource) &&
    /timeout:\s*TRACKED_PATH_LOOKUP_TIMEOUT_MS/.test(loopbreakSource) &&
    /trackedPathCache\.(?:delete|clear)/.test(loopbreakSource),
);
ctx.cwd = priorCwd;

await newTurn();
for (let i = 0; i < 11; i++) await call("bash", { command: `inspect-before-readonly-${i}` });
check(
  "a read-only git-status chain is never blocked by the pre-mutation reservation",
  (await call("bash", { command: "git status && echo inspection-complete" })) === undefined,
);
check(
  "a redirected git status is conservatively not classified as read-only",
  (await call("bash", { command: "git status > status.txt" }))?.block === true,
);
check(
  "a git-status chain with a mutating segment is not classified as read-only",
  (await call("bash", { command: "git status && touch marker" }))?.block === true,
);

// Read-only shell reservation exemptions must not bypass the existing identical-call detector.
await newTurn();
const repeatedStatus = { command: "git status" };
const firstStatus = await call("bash", repeatedStatus);
await emit("tool_result", {
  toolName: "bash",
  input: repeatedStatus,
  content: [{ type: "text", text: "On branch main\nnothing to commit, working tree clean" }],
  isError: false,
});
const secondStatus = await call("bash", repeatedStatus);
await emit("tool_result", {
  toolName: "bash",
  input: repeatedStatus,
  content: [{ type: "text", text: "On branch main\nnothing to commit, working tree clean" }],
  isError: false,
});
const thirdStatus = await call("bash", repeatedStatus);
check(
  "the third identical git status is blocked by no-progress detection",
  firstStatus === undefined && secondStatus === undefined && thirdStatus?.block === true &&
    /paused a repeated action/i.test(thirdStatus.reason),
);

// A verifier is the convergence point of an investigation, not one more exploratory read. The live
// Express fixture reached the exploration limit immediately before `npm test`; blocking the test
// made the model retry command variants instead of learning from the failure and editing the code.
await newTurn();
const verifierMutation = { path: "verifier-anchor.js", edits: [{ oldText: "before", newText: "after" }] };
await call("edit", verifierMutation);
await emit("tool_result", {
  toolName: "edit",
  input: verifierMutation,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
});
for (let i = 0; i < 13; i++) await call("bash", { command: `grep signal file${i}` });
const verifierAtLimit = await call("bash", { command: "npm test -- --grep regression" });
const readAfterVerifier = await call("bash", { command: "grep focused next-file" });
check("verification runs after inspection is bounded", verifierAtLimit === undefined);
check("verification does not reopen post-mutation exploration", readAfterVerifier?.block === true);

// Installing dependencies is the runway TO a check, not exploration. Live deadlock: Vinci removed
// node_modules, then every `npm install` was refused with "the remaining tool budget is reserved for
// completing the task" — so it could never rebuild to prove its own work, in any turn.
const installAtLimit = await call("bash", { command: "npm install" });
check("dependency install stays available once investigation is exhausted", installAtLimit === undefined);
const ciAtLimit = await call("bash", { command: "npm ci" });
check("npm ci stays available too", ciAtLimit === undefined);

// Varied read-only commands never trip repeat detection, so a cumulative navigation ceiling must
// terminate them — a confused model cycling distinct git diff/show/cat reads is a paid loop.
{
  await newTurn();
  let variedBlocked;
  for (let i = 0; i < 200; i++) {
    const r = await call("bash", { command: `git diff HEAD~${i + 1} -- file-${i}.ts` });
    if (r?.block === true) {
      variedBlocked = { at: i + 1, r };
      break;
    }
  }
  check(
    "endlessly varied read-only commands hit a finite navigation ceiling",
    variedBlocked !== undefined && variedBlocked.at === 121,
  );
  check(
    "the navigation block uses the standard firm-stop contract",
    variedBlocked?.r?.block === true && /stopped a repeated action/i.test(variedBlocked?.r?.reason ?? ""),
  );
}

// A recovery-sourced input mid-navigation must not reset the budget (carry detection sees the
// navigation counter even though read-only calls never touch `calls`).
{
  await newTurn();
  for (let i = 0; i < 60; i++) await call("bash", { command: `git show HEAD~${i} -- carry-${i}.ts` });
  await emit("input", { type: "input", text: "continuing the recovery", source: "extension" });
  let carriedBlocked;
  for (let i = 0; i < 100; i++) {
    const r = await call("bash", { command: `git log -1 HEAD~${i} -- after-${i}.ts` });
    if (r?.block === true) {
      carriedBlocked = i + 1;
      break;
    }
  }
  check(
    "an extension recovery input does not re-grant the navigation budget",
    carriedBlocked !== undefined && carriedBlocked <= 62,
  );
}

// Structured navigation tools share the same cumulative budget as read-only shell calls.
{
  await newTurn();
  let structuredBlocked;
  for (let i = 0; i < 200; i++) {
    const r = await call("read", { path: `src/file-${i}.ts` });
    if (r?.block === true) {
      structuredBlocked = i + 1;
      break;
    }
  }
  check(
    "endlessly varied structured reads hit the same finite ceiling",
    structuredBlocked !== undefined && structuredBlocked <= 150,
  );
}
await newTurn();
await newTurn();

// Narration can keep resetting the consecutive exploration streak while the model still consumes
// nearly the full turn without committing to an owning source location. The checkpoint gives two
// grace calls, then blocks more investigation so edit + proof still have runway.
await newTurn();
const ownershipControlsBefore = controls.filter(({ message }) => message.customType === "vinci-source-ownership").length;
const runwayControlsBefore = controls.filter(({ message }) => message.customType === "vinci-mutation-runway").length;
let firstOwnershipBlock = -1;
for (let i = 0; i < 20; i++) {
  const result = await call("bash", { command: `inspect-owner-${i}` });
  if (result?.block) {
    firstOwnershipBlock = i;
    break;
  }
  await emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `I found another relevant ownership clue and am narrowing the source location. ${"detail ".repeat(30)}` }],
    },
  });
}
const ownershipControlsAfter = controls.filter(({ message }) => message.customType === "vinci-source-ownership").length;
const runwayControlsAfter = controls.filter(({ message }) => message.customType === "vinci-mutation-runway").length;
check(
  "pre-mutation checkpoint gives two grace calls, then preserves implementation runway",
  firstOwnershipBlock === 10 &&
    ownershipControlsAfter - ownershipControlsBefore === 1 &&
    runwayControlsAfter - runwayControlsBefore === 1,
);
check(
  "the runway block still permits the owning edit",
  (await call("edit", { path: "owner.js", edits: [{ oldText: "wrong", newText: "right" }] })) === undefined,
);

await newTurn();
for (let i = 0; i < 10; i++) {
  await call("bash", { command: `inspect-before-verifier-${i}` });
  await emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `I am narrowing the implementation before the first edit. ${"detail ".repeat(30)}` }],
    },
  });
}
const focusedPreMutationCheck = await call("bash", { command: "npm test -- --grep ownership" });
const investigationAfterFocusedCheck = await call("read", { path: "another-owner.js" });
check(
  "one focused verifier can be followed by a targeted source read",
  focusedPreMutationCheck === undefined && investigationAfterFocusedCheck === undefined,
);

await newTurn();
ownership.resetVinciSourceOwnership();
ownership.addVinciSourceOwnershipCandidates(["lib/runtime-owner.js"]);
for (let i = 0; i < 10; i++) {
  await call("bash", { command: `inspect-before-required-owner-${i}` });
  await emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `I am narrowing the implementation before the first edit. ${"detail ".repeat(30)}` }],
    },
  });
}
const requiredOwnershipRead = await call("read", { path: "lib/runtime-owner.js" });
ownership.recordVinciSourceInspection("lib/runtime-owner.js");
const redundantOwnershipRead = await call("read", { path: "lib/runtime-owner.js" });
check(
  "the mutation runway does not block a repeated dependency ownership read",
  requiredOwnershipRead === undefined && redundantOwnershipRead === undefined,
);
ownership.resetVinciSourceOwnership();

ownership.addVinciSourceOwnershipCandidates(["lib/truncated-owner.js"]);
ownership.recordVinciSourceShellInspection("cat lib/truncated-owner.js | head -5");
const truncatedOwnerRead = await call("bash", { command: "cat lib/truncated-owner.js" });
ownership.recordVinciSourceShellInspection("cat lib/truncated-owner.js");
const completedOwnerRead = await call("bash", { command: "cat lib/truncated-owner.js" });
check(
  "truncated shell reads do not satisfy or consume the required ownership inspection",
  truncatedOwnerRead === undefined && completedOwnerRead?.block === true,
);
ownership.resetVinciSourceOwnership();

await newTurn();
for (let i = 0; i < 7; i++) {
  await call("bash", { command: `inspect-before-edit-${i}` });
  await emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `I am narrowing the implementation before the first edit. ${"detail ".repeat(30)}` }],
    },
  });
}
const ownershipControlsBeforeMutation = controls.filter(({ message }) => message.customType === "vinci-source-ownership").length;
const successfulEdit = { path: "owner.js", edits: [{ oldText: "wrong", newText: "right" }] };
await call("edit", successfulEdit);
await emit("tool_result", {
  toolName: "edit",
  input: successfulEdit,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
});
await call("bash", { command: "inspect-after-edit" });
check(
  "a successful mutation suppresses the pre-mutation ownership checkpoint",
  controls.filter(({ message }) => message.customType === "vinci-source-ownership").length === ownershipControlsBeforeMutation,
);

// A failing test is diagnostic evidence, not a malformed tool call. Different focused test commands
// must not arm the edit/write error-thrashing stop; identical calls remain covered by fixation.
await newTurn();
for (let i = 0; i < 4; i++) {
  const input = { command: `npm test -- --grep regression-${i}` };
  await call("bash", input);
  await emit("tool_result", {
    toolName: "bash",
    input,
    content: [{ type: "text", text: "1 test failing" }],
    isError: true,
  });
}
check(
  "failing verification does not trigger the malformed-action error stop",
  (await call("edit", { path: "fix.js", edits: [{ oldText: "bad", newText: "good" }] })) === undefined,
);

// 5c. Error thrashing — several failing tool results in a row → stop-and-report (the 2.3M-token
// botched-rewrite runaway). Failures include plain-text "could not find the exact text" (not isError).
await newTurn();
const failResult = (text) => handlers.tool_result({ toolName: "edit", input: {}, content: [{ type: "text", text }], isError: false }, ctx);
for (let i = 0; i < 4; i++) await failResult("Could not find the exact text in file.ts");
check("error thrashing → stops after 4 consecutive failures", (r => r && r.block && /failed/i.test(r.reason))(await call("edit", { path: "x", edits: [] })));
// a successful tool resets the streak
await newTurn();
for (let i = 0; i < 3; i++) await failResult("Could not find the exact text");
await failResult("Successfully replaced 1 block(s)");
check("a successful tool resets the error streak", (await call("edit", { path: "x", edits: [] })) === undefined);

// A byte-identical failed mutation is not a useful second attempt. Block it immediately instead of
// waiting for the general third-repeat threshold; the model must reread or change the edit arguments.
await newTurn();
const failedEdit = { path: "index.js", edits: [{ oldText: "wrong indentation", newText: "fixed" }] };
await call("edit", failedEdit);
await emit("tool_result", {
  toolName: "edit",
  input: failedEdit,
  content: [{ type: "text", text: "Could not find the exact text in index.js" }],
  isError: true,
});
const repeatedFailedEdit = await call("edit", failedEdit);
check("a byte-identical failed edit is blocked on its second attempt", repeatedFailedEdit?.block === true);

// Once the mutation runway is active, a failed exact-text edit must permit enough targeted rereads to
// recover the exact region. A third byte-identical read is still a true no-progress fixation and must
// redirect the model to a different offset or search rather than tell it to abandon the task.
await newTurn();
for (let i = 0; i < 10; i++) {
  await call("bash", { command: `inspect-before-failed-edit-${i}` });
  await emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `I am narrowing the source before editing. ${"detail ".repeat(30)}` }],
    },
  });
}
const runwayFailedEdit = { path: "owner.js", edits: [{ oldText: "wrong indentation", newText: "fixed" }] };
await call("edit", runwayFailedEdit);
await emit("tool_result", {
  toolName: "edit",
  input: runwayFailedEdit,
  content: [{ type: "text", text: "Could not find the exact text in owner.js" }],
  isError: true,
});
const recoveryRead = await call("read", { path: "owner.js", offset: 10, limit: 20 });
const secondRecoveryRead = await call("read", { path: "owner.js", offset: 10, limit: 20 });
const thirdRecoveryRead = await call("read", { path: "owner.js", offset: 10, limit: 20 });
check(
  "a failed mutation permits rereads and gives an actionable recovery on an identical fixation",
  recoveryRead === undefined &&
    secondRecoveryRead === undefined &&
    thirdRecoveryRead?.block === true &&
    /whole file|offset|different pattern/i.test(thirdRecoveryRead.reason),
);

// Execa regression: the first focused verifier can reveal the bug only after the investigation
// runway is exhausted. Permit targeted structured reads to interpret that failure, then make the
// owning edit without reopening shell exploration.
await newTurn();
verificationState.resetVinciVerificationState();
for (let i = 0; i < 10; i++) await call("bash", { command: `inspect-before-focused-check-${i}` });
await call("bash", { command: "npm test -- --grep focused-regression" });
verificationState.recordVinciVerification("npm test -- --grep focused-regression", false, "8 tests failed");
const failedVerifierShellRead = await call("bash", { command: "cat src/owner.js" });
const failedVerifierSourceRead = await call("read", { path: "src/owner.js", offset: 1, limit: 80 });
const repeatedFailedVerifierRead = await call("read", { path: "src/sibling.js", offset: 1, limit: 80 });
const failedVerifierEdit = await call("edit", { path: "src/owner.js", edits: [{ oldText: "before", newText: "after" }] });
check("a failed focused verifier does not reopen shell exploration", failedVerifierShellRead?.block === true);
check("a failed focused verifier permits one targeted source read", failedVerifierSourceRead === undefined);
check("a failed verifier permits another distinct source read", repeatedFailedVerifierRead === undefined);
check("the owning edit remains available after interpreting the failure", failedVerifierEdit === undefined);

// Reliability regression: locating several edit regions in one file is legitimate progress. Different
// offsets/patterns must survive the exploration threshold and must not spend the action ceiling, so the
// final edit remains possible. Only the third byte-identical lookup is redirected, with a recovery hint.
await newTurn();
for (let i = 0; i < 24; i++) {
  assert.equal(await call("read", { path: "src/review.ts", offset: i * 40, limit: 40 }), undefined);
  assert.equal(await call("grep", { path: "src/review.ts", pattern: `edit-region-${i}` }), undefined);
}
const navigationEdit = await call("edit", {
  path: "src/review.ts",
  edits: [{ oldText: "before", newText: "after" }],
});
check("different read offsets and grep patterns never consume the edit budget", navigationEdit === undefined);

await newTurn();
const identicalRead = { path: "src/review.ts", offset: 120, limit: 40 };
await call("read", identicalRead);
await call("read", identicalRead);
const identicalReadBlock = await call("read", identicalRead);
const recoveryControls = controls.filter(({ message }) => message.customType === "vinci-read-recovery");
check(
  "an identical read fixation is redirected with recovery guidance instead of stop-and-report",
  identicalReadBlock?.block === true &&
    /whole file|offset|different pattern/i.test(identicalReadBlock.reason) &&
    recoveryControls.some(({ message }) => /do not abandon|whole file|offset|different nearby pattern/i.test(message.content)),
);

await newTurn();
for (let i = 0; i < 4; i++) {
  const failedRead = { path: `missing-${i}.ts`, offset: i * 20, limit: 20 };
  await call("read", failedRead);
  await emit("tool_result", {
    toolName: "read",
    input: failedRead,
    content: [{ type: "text", text: `File not found: missing-${i}.ts` }],
    isError: true,
  });
}
check(
  "failed source navigation does not poison a subsequent scoped edit",
  (await call("edit", { path: "src/review.ts", edits: [{ oldText: "before", newText: "after" }] })) === undefined,
);

// 5. Per-turn ceiling backstops a runaway that keeps "making progress" — an edit between shell calls
//    resets the explore/identical guards, so only the non-navigation action ceiling catches it. There it
//    HARD-STOPS (abort), not just steers.
await newTurn();
let ceilingHit = false;
for (let i = 0; i < 60; i++) {
  await call("edit", { path: "f" + i, edits: [] }); // resets explore + identical streaks each round
  const r = await call("bash", { command: "distinct-" + i }); // distinct → dodges identical too
  if (r && r.block && /stopped a repeated action/i.test(r.reason)) { ceilingHit = true; break; }
}
check("per-turn ceiling firmly blocks a varied edit+read runaway (no abort)", ceilingHit === true && aborted === 0);

// Once the absolute budget is spent, a higher-class piped check still runs. After its result becomes
// the behavioral verifier, the ordinary one-shot direct-rerun escape remains bounded.
await newTurn();
verificationState.resetVinciVerificationState();
verificationState.recordVinciVerification("pnpm typecheck", true, "types pass", false, "static", "pnpm typecheck");
for (let i = 0; i < ext.TURN_CALL_CEILING + 7; i++) await call("edit", { path: `budget-${i}.js`, edits: [] });
const pipedPastCeiling = await call("bash", { command: "npm test | tail -20" });
verificationState.recordVinciVerification("npm test", false, "1 test failed", true, "behavioral", "npm test");
const directPastCeiling = await call("bash", { command: "npm test" });
const secondDirectPastCeiling = await call("bash", { command: "npm test -- --grep another" });
const readPastCeiling = await call("read", { path: "src/review.ts", offset: 200, limit: 40 });
check("a higher-class piped verifier runs after the tool budget", pipedPastCeiling === undefined);
check("one direct verifier can close the task after the tool budget", directPastCeiling === undefined);
check("the post-budget verification escape hatch is single-use", secondDirectPastCeiling?.block === true);
check("source navigation remains available after the non-navigation action ceiling", readPastCeiling === undefined);

// Higher-class attempts spend the ordinary action budget. Only two incomplete attempts against the
// same recorded verifier may bypass the exhausted ceiling; the third receives normal pacing.
await newTurn();
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification("pnpm typecheck", true, "types pass", false, "static", "pnpm typecheck");
for (let i = 0; i < ext.TURN_CALL_CEILING; i++) await call("edit", { path: `upgrade-budget-${i}.js`, edits: [] });
await call("rerun_check", {}); // consume the ordinary one-shot post-ceiling verification escape
const incompleteUpgradeOne = await call("bash", { command: "pnpm build --mode first" });
const incompleteUpgradeTwo = await call("bash", { command: "pnpm build --mode second" });
verificationState.recordVinciVerification("pnpm build", true, "build passes", false, "build", "pnpm build");
const resetUpgradeOne = await call("bash", { command: "pnpm --filter app test -- --grep first" });
const resetUpgradeTwo = await call("bash", { command: "pnpm --filter app test -- --grep second" });
const incompleteUpgradeThree = await call("bash", { command: "pnpm --filter app test -- --grep third" });
check("the first two incomplete higher-class attempts get the bounded upgrade allowance",
  incompleteUpgradeOne === undefined && incompleteUpgradeTwo === undefined);
check("a completed recorded upgrade resets the bounded allowance",
  resetUpgradeOne === undefined && resetUpgradeTwo === undefined);
check("the third incomplete higher-class attempt returns to normal pacing", incompleteUpgradeThree?.block === true);

// Status-only transitions do not represent a new verifier or mutation and must not replenish the
// bounded higher-class allowance.
await newTurn();
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification("pnpm typecheck", true, "types pass", false, "static", "pnpm typecheck");
for (let i = 0; i < ext.TURN_CALL_CEILING; i++) {
  await call("edit", { path: `status-budget-${i}.js`, edits: [] });
}
await call("rerun_check", {});
const statusUpgradeOne = await call("bash", { command: "pnpm build --mode first" });
const statusUpgradeTwo = await call("bash", { command: "pnpm build --mode second" });
verificationState.recordVinciEvidenceGap("Diff inspection is still pending.");
const statusOnlyGap = verificationState.getVinciVerificationState();
check(
  "an evidence gap after a pass produces a valid stale state",
  statusOnlyGap.status === "stale" &&
    verificationState.parseVinciVerificationState(statusOnlyGap) !== undefined,
);
const statusUpgradeThree = await call("bash", { command: "pnpm build --mode third" });
check(
  "a status-only verifier transition does not reset the bounded upgrade allowance",
  statusUpgradeOne === undefined && statusUpgradeTwo === undefined && statusUpgradeThree?.block === true,
);

// Guarantee 2: the verifier fingerprint includes commandCwd. Identical command text in a different
// directory is a distinct proof budget, while replaying the same bound state does not replenish it.
await newTurn();
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification(
  "pnpm typecheck",
  true,
  "types pass",
  false,
  "static",
  "pnpm typecheck",
  true,
  "/tmp/vinci-fingerprint-a",
);
for (let i = 0; i < ext.TURN_CALL_CEILING; i++) {
  await call("edit", { path: `cwd-fingerprint-budget-${i}.js`, edits: [] });
}
await call("rerun_check", {});
const cwdAUpgradeOne = await call("bash", { command: "pnpm build --mode cwd-a-one" });
const cwdAUpgradeTwo = await call("bash", { command: "pnpm build --mode cwd-a-two" });
const cwdAState = verificationState.getVinciVerificationState();
verificationState.hydrateVinciVerificationState({ ...cwdAState, commandCwd: "/tmp/vinci-fingerprint-b" });
const cwdBUpgradeOne = await call("bash", { command: "pnpm build --mode cwd-b-one" });
const cwdBUpgradeTwo = await call("bash", { command: "pnpm build --mode cwd-b-two" });
verificationState.hydrateVinciVerificationState({ ...verificationState.getVinciVerificationState() });
const cwdBUpgradeThree = await call("bash", { command: "pnpm build --mode cwd-b-three" });
check(
  "same verifier text in two commandCwds produces distinct fingerprints",
  cwdAUpgradeOne === undefined && cwdAUpgradeTwo === undefined && cwdBUpgradeOne === undefined && cwdBUpgradeTwo === undefined,
);
check(
  "an exact replay of the recorded commandCwd dedups to one fingerprint",
  cwdBUpgradeThree?.block === true,
);

// A contextual verifier failure is resolved by rerunning the exact full command. Loopbreak must
// compare contextual identities on both sides so the prescribed bash resolution path is never
// mistaken for a different same-class check.
const verificationHandlers = {};
const verificationPi = {
  on(name, handler) {
    (verificationHandlers[name] ??= []).push(handler);
  },
  registerTool() {},
  appendEntry() {},
  sendMessage() {},
  registerCommand() {},
  registerTool() {},
  async exec() {
    throw new Error("unexpected verifier replay");
  },
};
verification.default(verificationPi);
const emitVerification = async (name, event) => {
  for (const handler of verificationHandlers[name] ?? []) await handler(event, ctx);
};

await newTurn();
verificationState.resetVinciVerificationState();
const contextualEdit = {
  path: "contextual-runtime.js",
  edits: [{ oldText: "before", newText: "after" }],
};
await call("edit", contextualEdit);
const contextualEditResult = {
  toolName: "edit",
  input: contextualEdit,
  content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
  isError: false,
};
await emit("tool_result", contextualEditResult);
await emitVerification("tool_result", contextualEditResult);
const contextualCheck = { command: "export NODE_ENV=test && npm test" };
await emitVerification("tool_call", { toolName: "bash", input: contextualCheck });
await emitVerification("tool_result", {
  toolName: "bash",
  input: contextualCheck,
  content: [{ type: "text", text: "1 test failed" }],
  isError: true,
});
assert.equal(verificationState.getVinciVerificationState().status, "failed");
// Reach the rerun on action 7: contextual identity must not depend on an early-turn grace period.
for (let i = 0; i < 5; i++) {
  await call("edit", { path: `contextual-round-${i}.js`, edits: [] });
}
const contextualRerun = await call("bash", contextualCheck);
if (contextualRerun === undefined) {
  await emitVerification("tool_call", { toolName: "bash", input: contextualCheck });
  const contextualPassResult = {
    toolName: "bash",
    input: contextualCheck,
    content: [{ type: "text", text: "1 test passed" }],
    isError: false,
  };
  await emit("tool_result", contextualPassResult);
  await emitVerification("tool_result", contextualPassResult);
}
const contextualResolved = verificationState.getVinciVerificationState();
const contextualRepeat = await call("bash", contextualCheck);
if (contextualRepeat === undefined) {
  await emit("tool_result", {
    toolName: "bash",
    input: contextualCheck,
    content: [{ type: "text", text: "1 test passed" }],
    isError: false,
  });
}
const contextualThirdRepeat = await call("bash", contextualCheck);
check(
  "an exact contextual bash rerun after failure is permitted and resolves it",
  contextualRerun === undefined &&
    contextualResolved.status === "passed" &&
    contextualResolved.verifiedRevision === contextualResolved.mutationRevision,
);
check(
  "the third identical contextual rerun without progress is blocked",
  contextualRepeat === undefined &&
    contextualThirdRepeat?.block === true &&
    /paused a repeated action/i.test(contextualThirdRepeat.reason),
);

// Contextual identity also cannot bypass the absolute action ceiling forever. The ordinary direct
// verifier escape is one-shot: once spent, another exact rerun is blocked like any other action.
await newTurn();
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
const ceilingContextualCheck = { command: "cd pkg && npm test -- --grep ceiling-context" };
verificationState.recordVinciVerification(
  ceilingContextualCheck.command,
  false,
  "1 test failed",
  false,
  "behavioral",
  verification.contextualVerificationKey(ceilingContextualCheck.command),
);
for (let i = 0; i < ext.TURN_CALL_CEILING; i++) {
  await call("edit", { path: `contextual-ceiling-${i}.js`, edits: [] });
}
const contextualCeilingEscape = await call("bash", ceilingContextualCheck);
const contextualAfterCeilingEscape = await call("bash", ceilingContextualCheck);
check(
  "exact contextual reruns past the ceiling consume only the one-shot verification escape",
  contextualCeilingEscape === undefined &&
    contextualAfterCeilingEscape?.block === true &&
    /stopped a repeated action/i.test(contextualAfterCeilingEscape.reason),
);

// Verification recovery is delivered as an extension-owned follow-up turn. It must retain the
// original task's spent budget, while still allowing the single purpose-built rerun_check escape.
await newTurn();
verificationState.resetVinciVerificationState();
for (let i = 0; i < ext.TURN_CALL_CEILING; i++) await call("edit", { path: `recovery-budget-${i}.js`, edits: [] });
await emit("input", { text: "Continue verification recovery", source: "extension" });
await newTurn();
const recoveryRerun = await call("rerun_check", {});
const recoveryAfterEscape = await call("bash", { command: "npm test" });
check("extension recovery turns retain the original tool budget", recoveryRerun === undefined);
check("rerun_check is the single post-budget verification escape", recoveryAfterEscape?.block === true);

await newTurn();
const warnings = [];
ctx.hasUI = true;
ctx.ui.notify = (message, level) => warnings.push({ message, level });
for (let i = 0; i < ext.TURN_CALL_CEILING + 7; i++) await call("edit", { path: `warning-${i}.js`, edits: [] });
await call("bash", { command: "echo over-budget-one" });
await call("bash", { command: "echo over-budget-two" });
check("repeated firm blocks produce one user-facing warning", warnings.filter(({ level }) => level === "warning").length === 1);
ctx.hasUI = false;
ctx.ui.notify = () => {};

// 5d. Talkative runaways are still runaways. Long narration may reset the consecutive-read streak,
// but it must never refund the absolute tool-call ceiling. The auth-migration loop narrated every
// attempt and therefore ran forever under the old refund behavior.
await newTurn();
let narratedCeilingHit = false;
for (let i = 0; i < 40; i++) {
  const r = await call("edit", { path: `narrated-${i}.txt`, edits: [{ oldText: `${i}`, newText: `${i + 1}` }] });
  await emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `I checked the last result and am explaining the next migration attempt clearly. ${"detail ".repeat(30)}` }],
    },
  });
  if (r && r.block && /stopped a repeated action/i.test(r.reason)) {
    narratedCeilingHit = true;
    break;
  }
}
check("narration never refunds the absolute per-turn call ceiling", narratedCeilingHit === true && aborted === 0);

// A corrupt snapshot above a valid pass is terminal and blocks every verifier.
verificationState.resetVinciVerificationState();
verificationState.recordVinciMutation();
verificationState.recordVinciVerification(
  "npm test",
  true,
  "1 test passed",
  false,
  "behavioral",
  "npm test",
  true,
);
const terminalCorruption = verificationState.scanVinciVerificationStateBranch([
  {
    type: "custom",
    customType: verificationState.VINCI_VERIFICATION_ENTRY,
    data: { ...verificationState.getVinciVerificationState() },
  },
  {
    type: "custom",
    customType: verificationState.VINCI_VERIFICATION_ENTRY,
    data: { status: "failed" },
  },
]);
verificationState.restoreVinciVerificationState(terminalCorruption);
await newTurn();
const terminalCorruptionCheck = await call("rerun_check", {});
check(
  "terminal corruption blocks verification instead of entering a completion path",
  terminalCorruptionCheck?.block === true &&
    /unreadable and could not be re-established/i.test(terminalCorruptionCheck.reason),
);

// 6. Regression guard: abort() must NEVER be called from the hook in ANY mode (it hangs — verified).
check("ctx.abort() was never called across all scenarios (it deadlocks the loop)", aborted === 0);
check("loop recovery guidance stays on the hidden control channel", controls.length > 0 && controls.every(({ message, options }) =>
  message.display === false && options?.triggerTurn === false && options?.deliverAs === "steer"));

console.log(`\nloopbreak-integration: ${pass}/${pass} checks passed (real extension module)`);
