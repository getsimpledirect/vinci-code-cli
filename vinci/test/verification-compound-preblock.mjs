// Compound-check stop: a non-faithful compound verification of one narrow, faithfully representable
// shape is stopped before it runs, and the agent is told the equivalent direct command.
//
// Every case runs the real verification and loopbreak extensions through the real ExtensionRunner in
// the shipped load order (verification before loopbreak, bin/vinci). "spy" counts executions of the
// call: 0 means a tool_call handler stopped it before it ran. The shape cases assert the spy first,
// then the reason text, then state, so an earlier stop cannot answer for the one under test; the
// dispatch, undo, fail-open and grader-window cases (T8*, T9, T12, N12) say their own order. No model call.
//
// Run one case alone: VINCI_COMPOUND_CASE=T2b node vinci/test/verification-compound-preblock.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false });
const verificationPath = resolve(here, "../extensions/vinci-verification.ts");
const loopbreakPath = resolve(here, "../extensions/vinci-loopbreak.ts");
const verification = await loader.import(verificationPath, { default: false });
const loopbreak = await loader.import(loopbreakPath, { default: false });
const stateModule = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const contract = await loader.import(resolve(here, "../extensions/lib/verification-contract.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
const grader = await loader.import(resolve(here, "../../packages/coding-agent/src/core/vinci-grader.ts"), { default: false });
const { ExtensionRunner } = await loader.import(resolve(here, "../../packages/coding-agent/src/core/extensions/runner.ts"), { default: false });
const { runAgentLoop } = await loader.import(resolve(here, "../../packages/agent/src/agent-loop.ts"), { default: false });
// The seam exists only at the repaired head; the old-head control runs this file without it.
const seam = loopbreak.vinciCompoundCheckTestSeam ?? {};

const COMPOUND_SUMMARY = "A piped or compound check cannot prove success because later commands can hide its exit code.";
const RED = "FAIL src/money.test.js\nTests: 1 failed, 3 passed";
const GREEN = "PASS src/money.test.js\nTests: 12 passed";
const D_PREFIX = "Run the check as one direct command: ";

function makeExtension(path, factory, entries, controls) {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    sendMessage(message, options) { controls.push({ message, options }); },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)), id: `e${entries.length + 1}` });
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    addTool() {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    events: { on() {}, emit() {} },
  };
  factory(pi);
  return { path, handlers };
}

async function fixture({ withVerification = true, between } = {}) {
  stateModule.resetVinciVerificationState();
  control.clearVinciAutomationStop?.();
  const cwd = mkdtempSync(join(tmpdir(), "vinci-compound-"));
  const entries = [];
  const controls = [];
  const extensions = [];
  if (withVerification) extensions.push(makeExtension(verificationPath, verification.default, entries, controls));
  if (between) extensions.push({ path: "<between>", handlers: new Map([["tool_call", [between]]]) });
  extensions.push(makeExtension(loopbreakPath, loopbreak.default, entries, controls));
  let toolResults = 0;
  extensions.push({ path: "<probe>", handlers: new Map([["tool_result", [async () => { toolResults++; }]]]) });
  let sessionId = "compound-preblock";
  const sessionManager = {
    getSessionId: () => sessionId,
    getBranch: () => entries,
    getEntries: () => entries,
    getSessionDir: () => cwd,
    getCwd: () => cwd,
  };
  const runner = new ExtensionRunner(extensions, { pendingProviderRegistrations: [] }, cwd, sessionManager, {});
  runner.bindCore({}, { getModel: () => undefined, getSignal: () => undefined });
  const each = async (name, event) => {
    const ctx = runner.createContext();
    for (const extension of extensions) {
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
    }
  };
  let id = 0;
  const f = {
    cwd,
    extensions,
    entries,
    controls,
    runner,
    get toolResults() { return toolResults; },
    setSessionId(value) { sessionId = value; },
    async start(text = "Fix the rounding bug in money.js", source = "interactive") {
      await each("input", { type: "input", text, source });
      await each("agent_start", { type: "agent_start" });
    },
    async input(event) {
      await each("input", { type: "input", ...event });
      await each("agent_start", { type: "agent_start" });
    },
    async call(toolName, input, { output, isError = false } = {}) {
      const toolCallId = `call-${++id}`;
      const event = { type: "tool_call", toolName, toolCallId, input };
      const result = await runner.emitToolCall(event);
      if (result?.block) return { spy: 0, reason: result.reason ?? null, toolCallId };
      if (output !== undefined) {
        await runner.emitToolResult({
          type: "tool_result",
          toolName,
          toolCallId,
          input,
          content: [{ type: "text", text: output }],
          details: undefined,
          isError,
        });
      }
      return { spy: 1, reason: null, toolCallId };
    },
    bash(command, options) {
      return f.call("bash", { command }, options);
    },
    async mutate(path = "money.js") {
      return f.call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }, { output: "Successfully replaced text in money.js." });
    },
    actionCalls() {
      return seam.actionCalls?.();
    },
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
  return f;
}

const json = (value) => JSON.stringify(value);
function snapshot(f) {
  const lastEntry = [...f.entries].reverse().find((entry) => entry.customType === stateModule.VINCI_VERIFICATION_ENTRY);
  return {
    state: json(stateModule.getVinciVerificationState()),
    selected: json(contract.selectSharedVinciVerificationState(f.entries) ?? null),
    lastEntry: json(lastEntry?.data ?? null),
    evidence: grader.verificationEvidenceFromBranch(f.entries),
  };
}
function assertSnapshotEqual(label, before, after) {
  assert.equal(after.state, before.state, `${label}: in-memory verification state byte-equal`);
  assert.equal(after.lastEntry, before.lastEntry, `${label}: last persisted verification entry deep-equal`);
  assert.equal(after.selected, before.selected, `${label}: selectSharedVinciVerificationState equal`);
  assert.equal(after.evidence, before.evidence, `${label}: grader verificationEvidenceFromBranch equal`);
}
function assertNoCompoundReason(label, observation) {
  assert.ok(!String(observation.reason ?? "").startsWith(D_PREFIX), `${label}: no compound-check reason`);
}
function assertStopped(label, observation, direct, post) {
  assert.equal(observation.spy, 0, `${label}: spy 0 (stopped before execution)`);
  const dSentence = `${D_PREFIX}${direct}.`;
  assert.ok(String(observation.reason).startsWith(dSentence), `${label}: reason names D verbatim: ${dSentence}`);
  assert.ok(!/\bfirst\b/i.test(observation.reason), `${label}: "first" absent`);
  const rest = observation.reason.slice(dSentence.length);
  assert.equal(rest, post ? ` Run ${post} separately after the check if you still need it.` : "", `${label}: POST sentence`);
}

const only = process.env.VINCI_COMPOUND_CASE;
let failures = 0;
let ran = 0;
async function measure(id, run) {
  if (only && only !== id) return;
  ran++;
  let f;
  try {
    await run((options) => (f = fixture(options)).then((value) => (f = value)));
    console.log(`  PASS ${id}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${id}: "${String(error.message).split("\n")[0]}"`);
  } finally {
    seam.fault = undefined;
    seam.onReservationDecision = undefined;
    if (f && typeof f.cleanup === "function") f.cleanup();
  }
}

// ── T1, T2b: the shape is stopped and the agent is told the direct form ──────────────────────────
await measure("T1", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  const before = snapshot(f);
  const stopped = await f.bash("npm test; echo done");
  assertStopped("T1", stopped, "npm test", "echo done");
  assertSnapshotEqual("T1", before, snapshot(f));
});
// The same withdrawal over a cwd-bound red latch (the parser places commandCwd in its own order).
await measure("T1-cwd", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  assert.equal((await f.bash("npm test", { output: RED, isError: true })).spy, 1, "T1-cwd: red run");
  const before = snapshot(f);
  const live = stateModule.getVinciVerificationState();
  const stopped = await f.bash("npm test; echo done");
  assertStopped("T1-cwd", stopped, "npm test", "echo done");
  assert.ok(isDeepStrictEqual({ ...stateModule.getVinciVerificationState() }, { ...live }), "T1-cwd: in-memory state deep-equal");
  const after = snapshot(f);
  const deep = (a, b) => isDeepStrictEqual(JSON.parse(a), JSON.parse(b));
  assert.ok(deep(after.lastEntry, before.lastEntry), "T1-cwd: last persisted verification entry deep-equal");
  assert.ok(deep(after.selected, before.selected), "T1-cwd: selectSharedVinciVerificationState deep-equal");
  assert.equal(after.evidence, before.evidence, "T1-cwd: grader verificationEvidenceFromBranch equal");
  console.log(`  T1-cwd measured: in-memory byte-equal ${after.state === before.state}, last entry byte-equal ${after.lastEntry === before.lastEntry}`);
});
await measure("T2b", async (make) => {
  const f = await make();
  await f.start();
  const stopped = await f.bash("npm test; git status");
  assertStopped("T2b", stopped, "npm test", "git status");
});

// ── T3: faithful chains and other no-stop shapes ─────────────────────────────────────────────────
await measure("T3", async (make) => {
  const f = await make();
  await f.start();
  for (const command of ["cd pkg && npm test", "go clean -testcache && go test ./..."]) {
    const observation = await f.bash(command);
    assert.equal(observation.spy, 1, `T3 ${command}: spy 1`);
    assertNoCompoundReason(`T3 ${command}`, observation);
  }
});
await measure("T3b", async (make) => {
  const f = await make();
  await f.start();
  for (const command of ["cd pkg; npm test", "export CI=1; npm test"]) {
    const observation = await f.bash(command);
    assert.equal(observation.spy, 1, `T3b ${command}: spy 1`);
    assertNoCompoundReason(`T3b ${command}`, observation);
  }
  assertStopped("T3b cd-prefix", await f.bash("cd pkg && npm test; echo done"), "cd pkg && npm test", "echo done");
});
await measure("T3c", async (make) => {
  const f = await make();
  await f.start();
  for (const command of ["npm test && npm run build", "cd pkg && npm test; cd .. && npm test"]) {
    const observation = await f.bash(command);
    assert.equal(observation.spy, 1, `T3c ${command}: spy 1`);
    assertNoCompoundReason(`T3c ${command}`, observation);
  }
});
await measure("T3d", async (make) => {
  const f = await make();
  await f.start();
  for (const command of ["git stash && npm test", "cd pkg; git stash; npm test", "export X=1; ./prepare; npm test"]) {
    const observation = await f.bash(command);
    assert.equal(observation.spy, 1, `T3d ${command}: spy 1`);
    assertNoCompoundReason(`T3d ${command}`, observation);
  }
});
await measure("T3e", async (make) => {
  const f = await make();
  await f.start();
  const observation = await f.bash("cd missing; npm test; echo x");
  assert.equal(observation.spy, 1, "T3e cd missing; npm test; echo x: spy 1");
  assertNoCompoundReason("T3e", observation);
});
await measure("T3f", async (make) => {
  const f = await make();
  await f.start();
  assertStopped("T3f", await f.bash("cd pkg&&npm test; echo x"), "cd pkg&&npm test", "echo x");
});

// ── T4: false positives and unrepresentable forms ────────────────────────────────────────────────
// Each command gets a fresh turn, so loopbreak's other per-turn guards (identical-call ladder,
// pre-mutation runway) cannot answer for a later case.
async function noStop(label, commands) {
  for (const command of commands) {
    const f = await fixtureFor();
    try {
      const observation = await f.bash(command);
      assert.equal(observation.spy, 1, `${label} ${JSON.stringify(command)}: spy 1 (reason: ${observation.reason})`);
      assertNoCompoundReason(`${label} ${JSON.stringify(command)}`, observation);
    } finally {
      f.cleanup();
    }
  }
}
async function fixtureFor() {
  const f = await fixture();
  await f.start();
  return f;
}
await measure("T4", async () => noStop("T4", [
  'echo "npm test" > notes.txt',
  'grep -r "npm test" docs',
  "cat <<EOF > run.sh\nnpm test\nEOF",
  'bash -c "npm test; echo x"',
  "(npm test); echo x",
  "echo $(npm test)",
  "npm test\necho done",
  "",
  "   ",
]));
await measure("T4b", async () => noStop("T4b", [
  "cd missing || npm test",
  "cd pkg & npm test",
  "npm test | tail -20; echo x",
  "npm test || echo x",
  "npm test & echo x",
]));
await measure("T4c", async () => noStop("T4c", [
  "cd pkg # comment && npm test; echo x",
  "cd pkg # comment; npm test",
  "npm test &&",
  "; npm test; echo done",
  "npm test;; echo x",
  "npm test # comment; echo x",
  "npm test ); echo x",
  "npm test }; echo x",
  "npm test *.js; echo x",
]));
await measure("T4d", async () => noStop("T4d", [
  "npm test >; echo x",
  "npm test <; echo x",
  "npm test 2>; echo x",
  "npm test 1>; echo x",
  "npm test 3>; echo x",
  "npm test 2>>; echo x",
  "npm test <>; echo x",
  "npm test &>>; echo x",
  "npm test 12>&; echo x",
  "npm test arg>; echo x",
  "npm test > >out; echo x",
  'npm test "arg">; echo x',
  "npm test>; echo x",
  "npm test > out.txt; echo x",
  "npm test < in.txt; echo x",
  "npm test 2>&1; echo x",
]));
await measure("T4e", async () => noStop("T4e", [
  "npm test ; echo x",
  "npm test﻿; echo x",
  "npm test ; echo x",
  "npm test　; echo x",
]));
// A leading NBSP, BOM or CR is part of the first word for bash, so the original names a different
// program than D would: the character test runs before any trim, and these fall open.
await measure("T4g", async () => noStop("T4g", [
  " npm test; echo done",
  "﻿npm test; echo done",
  "\rnpm test; echo done",
]));
// Positive control: leading and trailing ASCII space and tab are still trimmed, and the shape is stopped.
await measure("T4g-control", async (make) => {
  const f = await make();
  await f.start();
  assertStopped("T4g-control", await f.bash(" \tnpm test; echo done\t "), "npm test", "echo done");
});
// Non-string commands become String(command ?? "") at loopbreak's read, as at the base: no stop.
await measure("T4f", async (make) => {
  const f = await make();
  await f.start();
  for (const command of [null, 42, { npm: "test" }]) {
    const observation = await f.call("bash", { command });
    assert.equal(observation.spy, 1, `T4f ${JSON.stringify(command)}: spy 1 (as the base)`);
    assertNoCompoundReason(`T4f ${JSON.stringify(command)}`, observation);
  }
});

// ── T5: a pipe-filtered direct verifier keeps #22's non-latching path ───────────────────────────
await measure("T5", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  const observation = await f.bash("npm test | tail -20", { output: GREEN });
  assert.equal(observation.spy, 1, "T5: spy 1");
  assertNoCompoundReason("T5", observation);
  const state = stateModule.getVinciVerificationState();
  assert.notEqual(state.status, "passed", "T5: a filtered passing run does not latch passed");
  assert.equal(state.behavioralAttemptCommand, "npm test | tail -20", "T5: recorded as a behavioural attempt");
});

// ── T6: the bounds ───────────────────────────────────────────────────────────────────────────────
await measure("T6a", async (make) => {
  const f = await make();
  await f.start();
  const k = "npm test; echo done";
  assert.equal((await f.bash(k)).spy, 0, "T6a: 1st stopped");
  assert.equal((await f.bash(k)).spy, 0, "T6a: 2nd stopped");
  assert.equal((await f.bash(k)).spy, 1, "T6a: 3rd runs");
});
await measure("T6b", async (make) => {
  const f = await make();
  await f.start();
  const start = f.actionCalls();
  for (const suffix of ["a", "b", "c"]) {
    assert.equal((await f.bash(`npm test; echo ${suffix}`)).spy, 0, `T6b: ${suffix} stopped`);
    assert.equal(f.actionCalls(), start, `T6b: ${suffix} actionCalls unchanged`);
  }
  assertStopped("T6b d", await f.bash("npm test; echo d"), "npm test", "echo d");
  assert.equal(f.actionCalls(), start + 1, "T6b: 4th counted (actionCalls +1)");
});
await measure("T6b-ceiling", async (make) => {
  const f = await make();
  await f.start();
  for (let n = 1; n <= 25; n++) assert.equal((await f.call("edit", { path: `f${n}.ts`, edits: [] })).spy, 1, `T6b-ceiling: edit ${n}`);
  for (const suffix of ["a", "b", "c"]) assert.equal((await f.bash(`npm test; echo ${suffix}`)).spy, 0, `T6b-ceiling: ${suffix} stopped`);
  const controlsBefore = f.controls.length;
  const fourth = await f.bash("npm test; echo d");
  assert.equal(fourth.spy, 0, "T6b-ceiling: 4th spy 0");
  assert.equal(fourth.reason, "Vinci stopped a repeated action before it could run again.", "T6b-ceiling: returned reason (:765)");
  const message = f.controls.slice(controlsBefore).find((entry) => entry.message.customType === "vinci-loop-stop")?.message.content ?? "";
  assert.ok(message.includes("(Action 26 this turn — over the limit. Write your answer as plain text now; further non-navigation calls will also be blocked.)"), "T6b-ceiling: control message (:1029)");
  assert.equal(control.getVinciAutomationStop().reason, "Vinci reached the limit of 25 actions allowed in one turn before finishing.", "T6b-ceiling: humanReason (:1030)");
  await delay(250);
});
await measure("T6c", async (make) => {
  const f = await make();
  await f.start();
  const k = "npm test; echo k";
  assert.equal((await f.bash("npm test; echo a")).spy, 0, "T6c: a stopped");
  assert.equal((await f.bash(k)).spy, 0, "T6c: k stopped");
  assert.equal((await f.bash(k)).spy, 0, "T6c: k stopped again (streak 2, 3rd free stop)");
  await f.start("continue", "interactive");
  const start = f.actionCalls();
  assert.equal((await f.bash(k)).spy, 0, "T6c: after a typed continue k is stopped again (streak reset)");
  assert.equal(f.actionCalls(), start, "T6c: after a typed continue the stop is free again (count reset)");
});
await measure("T6d", async (make) => {
  const f = await make();
  await f.start();
  assert.equal((await f.call("edit", { path: "seed.ts", edits: [] })).spy, 1, "T6d: seed call (calls > 0)");
  const k = "npm test; echo k";
  const k2 = "npm test; echo k2";
  assert.equal((await f.bash(k2)).spy, 0, "T6d: k2 stopped (free 1)");
  assert.equal((await f.bash(k)).spy, 0, "T6d: k stopped (free 2, streak 1)");
  await f.input({ text: "continue", source: "extension" });
  const start = f.actionCalls();
  assert.equal((await f.bash(k)).spy, 0, "T6d: k stopped after the carried recovery input");
  assert.equal(f.actionCalls(), start, "T6d: k is the 3rd free stop (actionCalls unchanged)");
  assert.equal((await f.bash(k2)).spy, 0, "T6d: k2 stopped");
  assert.equal(f.actionCalls(), start + 1, "T6d: k2 is the 4th stop, counted (actionCalls +1)");
});
await measure("T6e", async (make) => {
  const f = await make();
  await f.start();
  const k = "npm test; echo k";
  assert.equal((await f.bash(k)).spy, 0, "T6e: 1st k stopped");
  assert.equal((await f.call("read", { path: "money.js" })).spy, 1, "T6e: read runs");
  assert.equal((await f.bash(k)).spy, 0, "T6e: 2nd k stopped (streak kept across a non-bash call)");
  assert.equal((await f.bash(k)).spy, 1, "T6e: 3rd k runs");
});
await measure("T6f", async (make) => {
  const f = await make();
  await f.start();
  const k = "npm test; echo k";
  assert.equal((await f.bash(k)).spy, 0, "T6f: 1st k stopped");
  assert.equal((await f.bash("ls")).spy, 1, "T6f: ls runs");
  assert.equal((await f.bash(k)).spy, 0, "T6f: k stopped (new streak 1)");
  assert.equal((await f.bash(k)).spy, 0, "T6f: k blocks again (new streak 2)");
});
await measure("T6g", async (make) => {
  const f = await make();
  await f.start();
  const k = "npm test; echo k";
  const a = f.actionCalls();
  const steps = [[0, a], [0, a], [1, a + 1], [0, a + 1], [0, a + 2], [1, a + 3]];
  for (const [index, [spy, actions]] of steps.entries()) {
    assert.equal((await f.bash(k)).spy, spy, `T6g step ${index + 1}: spy ${spy}`);
    assert.equal(f.actionCalls(), actions, `T6g step ${index + 1}: actionCalls ${actions}`);
  }
});
await measure("T6h", async (make) => {
  const f = await make();
  await f.start();
  assert.equal((await f.bash("  npm test; echo done  ")).spy, 0, "T6h: padded stopped");
  assert.equal((await f.bash("npm test; echo done")).spy, 0, "T6h: trimmed shares the streak (2nd stop)");
  assert.equal((await f.bash("  npm test; echo done")).spy, 1, "T6h: 3rd of the shared streak runs");
  await f.start("Another task");
  assert.equal((await f.bash("npm test; echo done")).spy, 0, "T6h: stopped (streak 1)");
  assert.equal((await f.bash("npm test; echo done")).spy, 0, "T6h: stopped (streak 2)");
  assert.equal((await f.bash("npm test;  echo done")).spy, 0, "T6h: inner whitespace is a different key (new streak)");
});

// ── T7: the reservation decides whether the direct command may run ───────────────────────────────
await measure("T7a", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  stateModule.recordVinciVerification("npm test; echo done", false, COMPOUND_SUMMARY, false, "behavioral", undefined, false, f.cwd);
  assertStopped("T7a", await f.bash("npm test; echo done"), "npm test", "echo done");
  const before = json(stateModule.getVinciVerificationState());
  const direct = await f.bash("npm test", { output: GREEN });
  assert.equal(direct.spy, 1, "T7a: D runs (spy 1)");
  assert.equal(direct.reason, null, "T7a: D not refused");
  assert.notEqual(json(stateModule.getVinciVerificationState()), before, "T7a: D reached a verification result (latch updated)");
});
for (const [id, recorded, cwdOf] of [
  ["T7b", "git stash && npm test", (f) => f.cwd],
  ["T7b-cwd", "npm test; echo done", () => "/elsewhere/project"],
]) {
  await measure(id, async (make) => {
    const f = await make();
    await f.start();
    await f.mutate();
    stateModule.recordVinciVerification(recorded, false, COMPOUND_SUMMARY, false, "behavioral", undefined, false, cwdOf(f));
    const observation = await f.bash("npm test; echo done");
    assert.equal(observation.spy, 0, `${id}: spy 0 (loopbreak's reservation refuses)`);
    assertNoCompoundReason(id, observation);
    assert.equal(observation.reason, "Vinci kept the passing focused verification as the completion evidence.", `${id}: loopbreak's first reason (:1054)`);
  });
}
await measure("T7c", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  stateModule.recordVinciVerification("tsc; echo done", false, COMPOUND_SUMMARY, false, "static", undefined, false, f.cwd);
  assert.equal((await f.bash("npm test -- --grep a")).spy, 1, "T7c: upgrade attempt 1 runs");
  assert.equal((await f.bash("npm test -- --grep b")).spy, 1, "T7c: upgrade attempt 2 runs");
  const observation = await f.bash("npm test; echo x");
  assert.equal(observation.spy, 0, "T7c: spy 0");
  assertNoCompoundReason("T7c", observation);
  assert.equal(observation.reason, "Vinci reserved verification for the recorded direct rerun.", "T7c: loopbreak's :1067 reason");
});
async function higherClassFixture(make, spend) {
  const f = await make();
  await f.start();
  for (let n = 1; n <= spend; n++) await f.call("edit", { path: `f${n}.ts`, edits: [] });
  stateModule.recordVinciVerification("tsc", true, "The check passed.", false, "static", undefined, true, f.cwd);
  const seen = [];
  seam.onReservationDecision = (purpose, input) => { if (purpose === "call") seen.push(input.incompleteUpgradeAttempts); };
  return { f, seen };
}
async function nextCallUpgradeAttempts(f, seen) {
  seen.length = 0;
  await f.call("edit", { path: "probe.ts", edits: [] });
  return seen[0];
}
await measure("T7d-iii", async (make) => {
  const { f, seen } = await higherClassFixture(make, 0);
  assert.equal((await f.bash("npm test; echo 1")).spy, 0, "T7d (iii): free 1st stop spy 0");
  assert.equal(await nextCallUpgradeAttempts(f, seen), 0, "T7d (iii): incompleteUpgradeAttempts unchanged");
});
await measure("T7d-i", async (make) => {
  const { f, seen } = await higherClassFixture(make, 0);
  for (const n of [1, 2, 3]) assert.equal((await f.bash(`npm test; echo ${n}`)).spy, 0, `T7d (i): free stop ${n}`);
  const start = f.actionCalls();
  assert.equal((await f.bash("npm test; echo 4")).spy, 0, "T7d (i): 4th stop spy 0");
  assert.equal(f.actionCalls(), start + 1, "T7d (i): 4th counted");
  assert.equal(await nextCallUpgradeAttempts(f, seen), 0, "T7d (i): incompleteUpgradeAttempts unchanged");
});
await measure("T7d-ii", async (make) => {
  const { f, seen } = await higherClassFixture(make, 25);
  for (const n of [1, 2, 3]) assert.equal((await f.bash(`npm test; echo ${n}`)).spy, 0, `T7d (ii): free stop ${n}`);
  const fourth = await f.bash("npm test; echo 4");
  assert.equal(fourth.spy, 0, "T7d (ii): 4th spy 0");
  assert.equal(fourth.reason, "Vinci stopped a repeated action before it could run again.", "T7d (ii): the ceiling's own reason");
  assert.equal(await nextCallUpgradeAttempts(f, seen), 0, "T7d (ii): incompleteUpgradeAttempts unchanged");
  await delay(250);
});
await measure("T7e", async (make) => {
  const f = await make();
  await f.start();
  await f.bash("npm test", { output: RED, isError: true });
  stateModule.recordVinciTerminalUnverifiable();
  const state = stateModule.getVinciVerificationState();
  assert.equal(state.variant, "terminal-unverifiable", "T7e: seeded terminal-unverifiable");
  const observation = await f.bash("npm test; echo x");
  assert.equal(observation.spy, 0, "T7e: spy 0");
  assertNoCompoundReason("T7e", observation);
  assert.equal(observation.reason, state.summary, "T7e: :997 returns the state summary");
});

// ── T8: the real dispatch boundary (agent loop -> runner -> both extensions) ─────────────────────
async function agentLoopRun(f, command) {
  let executed = 0;
  const tool = {
    name: "bash",
    label: "bash",
    description: "run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async () => {
      executed++;
      return { content: [{ type: "text", text: GREEN }], details: undefined };
    },
  };
  let turn = 0;
  const streamFn = () => {
    turn++;
    const content = turn === 1
      ? [{ type: "toolCall", id: "loop-call-1", name: "bash", arguments: { command } }]
      : [{ type: "text", text: "Done." }];
    const message = {
      role: "assistant",
      content,
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: turn === 1 ? "toolUse" : "stop",
      timestamp: 0,
    };
    return {
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
      result: async () => message,
    };
  };
  const config = {
    model: { id: "test", provider: "test", api: "test" },
    convertToLlm: (messages) => messages,
    beforeToolCall: async ({ toolCall, args }) =>
      f.runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args }),
    afterToolCall: async ({ toolCall, args, result, isError }) => {
      await f.runner.emitToolResult({
        type: "tool_result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: args,
        content: result.content,
        details: result.details,
        isError,
      });
      return undefined;
    },
  };
  await runAgentLoop([{ role: "user", content: "check", timestamp: 0 }], { systemPrompt: "", messages: [], tools: [tool] }, config, () => {}, undefined, streamFn);
  return executed;
}
await measure("T8", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  const before = snapshot(f);
  const resultsBefore = f.toolResults;
  const executed = await agentLoopRun(f, "npm test; echo done");
  assert.equal(executed, 0, "T8: spy 0 (the blocked call never executed)");
  assert.equal(f.toolResults, resultsBefore, "T8: no tool_result record for the blocked call");
  const after = stateModule.getVinciVerificationState();
  assert.equal(json(after), before.state, "T8: no attempt (in-memory state byte-equal)");
  assertSnapshotEqual("T8", before, snapshot(f));
  const control = await agentLoopRun(f, "npm test");
  assert.equal(control, 1, "T8 positive control: the direct command executes through the same loop");
  assert.equal(f.toolResults, resultsBefore + 1, "T8 positive control: its tool_result reaches the extensions");
});
const parseable = () => {
  const state = stateModule.getVinciVerificationState();
  return isDeepStrictEqual(stateModule.parseVinciVerificationState(state), { ...state });
};
await measure("T8b", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  // A static latch carrying the compound summary; the persisted-state parser keeps it unchanged.
  stateModule.recordVinciVerification("tsc", false, COMPOUND_SUMMARY, false, "static", undefined, true, f.cwd);
  assert.ok(parseable(), "T8b: the seeded state round-trips through the persisted-state parser");
  await f.bash("npm test -- --grep a");
  await f.bash("npm test -- --grep b");
  const observation = await f.bash("npm test; echo x");
  assert.equal(observation.spy, 0, "T8b: spy 0 (loopbreak's :1067 refusal)");
  assert.equal(observation.reason, "Vinci reserved verification for the recorded direct rerun.", "T8b: :1067 reason");
  const state = stateModule.getVinciVerificationState();
  assert.equal(state.behavioralAttemptCommand, "npm test; echo x", "T8b: a non-compound-check stop keeps its attempt record");
  assert.equal(state.behavioralAttemptCompleted, false, "T8b: the kept record is an incomplete attempt, as at the base");
});
// A slot left by an earlier call that ran is never applied to a later stop (toolCallId match).
await measure("T8c", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  const k = "npm test; echo done";
  await f.bash(k);
  await f.bash(k);
  assert.equal((await f.bash(k)).spy, 1, "T8c: the 3rd identical call runs and records its attempt");
  const ran = json(stateModule.getVinciVerificationState());
  // The next identical call reaches loopbreak alone, so verification's slot still names call 3.
  const lone = f.extensions.find((extension) => extension.path === loopbreakPath) ?? null;
  const handler = lone?.handlers.get("tool_call")?.[0];
  assert.ok(handler, "T8c: loopbreak's tool_call handler is reachable");
  const result = await handler({ type: "tool_call", toolName: "bash", toolCallId: "call-stale", input: { command: k } }, f.runner.createContext());
  assert.equal(result?.block, true, "T8c: loopbreak stops the stale-slot call");
  assert.equal(json(stateModule.getVinciVerificationState()), ran, "T8c: the slot of the call that ran is not applied");
});
// The state changed between verification's record and loopbreak's stop: fail closed.
await measure("T8d", async (make) => {
  let interpose = false;
  const f = await make({
    between: async (event) => {
      if (interpose && event.toolName === "bash") stateModule.recordVinciMutation();
    },
  });
  await f.start();
  await f.mutate();
  interpose = true;
  const stopped = await f.bash("npm test; echo done");
  interpose = false;
  assert.equal(stopped.spy, 0, "T8d: spy 0");
  const state = stateModule.getVinciVerificationState();
  assert.equal(state.behavioralAttemptCommand, "npm test; echo done", "T8d: a state written in between keeps the record (fail closed)");
});
// The slot is bound to the session that wrote it: a stop seen under another session id withdraws
// nothing (the stop stands and the attempt record stays). T8 is the same-session positive control.
await measure("T8h", async (make) => {
  let switchSession = false;
  let f;
  f = await make({
    between: async (event) => {
      if (switchSession && event.toolName === "bash") f.setSessionId("another-session");
    },
  });
  await f.start();
  await f.mutate();
  switchSession = true;
  const stopped = await f.bash("npm test; echo done");
  switchSession = false;
  f.setSessionId("compound-preblock");
  assertStopped("T8h", stopped, "npm test", "echo done");
  const state = stateModule.getVinciVerificationState();
  assert.equal(state.behavioralAttemptCommand, "npm test; echo done", "T8h: a slot from another session id is not applied");
});
// A pre-call state the persisted-state parser would reject cannot be put back exactly: the stop
// stands, the attempt record stays, and nothing more is persisted (fail closed).
await measure("T8g", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  stateModule.recordVinciVerification("npm test; echo done", false, COMPOUND_SUMMARY, false, "behavioral", undefined, false, f.cwd);
  assert.ok(!parseable(), "T8g: the seeded state does not round-trip (precondition)");
  const entriesBefore = f.entries.length;
  assertStopped("T8g", await f.bash("npm test; echo done"), "npm test", "echo done");
  const state = stateModule.getVinciVerificationState();
  assert.equal(state.behavioralAttemptCompleted, false, "T8g: the attempt record stays");
  assert.equal(f.entries.length, entriesBefore + 1, "T8g: only verification's own attempt entry was appended (no re-persist)");
});
// Loopbreak loaded without verification: the undo has nothing to apply and the stop still works.
await measure("T8e", async (make) => {
  const f = await make({ withVerification: false });
  await f.start();
  const before = json(stateModule.getVinciVerificationState());
  assertStopped("T8e", await f.bash("npm test; echo done"), "npm test", "echo done");
  assert.equal(json(stateModule.getVinciVerificationState()), before, "T8e: no verification state written");
});

// The mutating-bash flag verification sets at its tool_call is withdrawn with the record. Its only
// reader is the opt-in deviation audit, which appends a fixed "could not cross-check" note when a
// turn changed something and no diff is visible (the exec stub returns no diff).
const SKIPPED_NOTE = "Note: I could not cross-check this summary against the actual diff for this turn";
for (const [id, command, spy] of [["T8f-control", "rm -rf dist", 1], ["T8f", "npm test; rm -rf dist", 0]]) {
  await measure(id, async (make) => {
    const previous = process.env.VINCI_DEVIATION_CHECK;
    process.env.VINCI_DEVIATION_CHECK = "1";
    try {
      const f = await make();
      await f.start();
      assert.equal((await f.bash(command, { output: "" })).spy, spy, `${id}: spy ${spy}`);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Done. I fixed the rounding bug." }],
        stopReason: "stop",
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: 0,
      };
      let text = "";
      const ctx = f.runner.createContext();
      for (const handler of f.extensions[0].handlers.get("message_end") ?? []) {
        const result = await handler({ type: "message_end", message }, ctx);
        if (result?.message) text += JSON.stringify(result.message.content);
      }
      if (spy === 1) assert.ok(text.includes(SKIPPED_NOTE), `${id}: a mutating bash that ran arms the audit (positive control)`);
      else assert.ok(!text.includes(SKIPPED_NOTE), `${id}: a stopped mutating compound leaves the audit unarmed (flag withdrawn)`);
    } finally {
      if (previous === undefined) delete process.env.VINCI_DEVIATION_CHECK;
      else process.env.VINCI_DEVIATION_CHECK = previous;
    }
  });
}

// ── T9: fail-open ────────────────────────────────────────────────────────────────────────────────
for (const fault of ["evaluate", "derive"]) {
  await measure(`T9-${fault}`, async (make) => {
    const f = await make();
    await f.start();
    await f.mutate();
    seam.fault = fault;
    let observation;
    await assert.doesNotReject(async () => {
      observation = await f.bash("npm test; echo done", { output: GREEN });
    }, `T9 ${fault}: the hook does not reject`);
    assert.equal(observation.spy, 1, `T9 ${fault}: today's path (spy 1)`);
    assertNoCompoundReason(`T9 ${fault}`, observation);
    assert.notEqual(stateModule.getVinciVerificationState().status, "passed", `T9 ${fault}: an unreliable passing run does not latch passed`);
  });
}

// ── T10: positive control (GUARANTEE 8) ──────────────────────────────────────────────────────────
await measure("T10", async (make) => {
  const f = await make();
  await f.start();
  await f.mutate();
  assert.equal((await f.bash("npm test", { output: RED, isError: true })).spy, 1, "T10: red run");
  assert.equal(stateModule.getVinciVerificationState().status, "failed", "T10: failed latch");
  assertStopped("T10", await f.bash("npm test; echo done"), "npm test", "echo done");
  assert.equal((await f.bash("npm test", { output: GREEN })).spy, 1, "T10: D runs");
  assert.equal(stateModule.getVinciVerificationState().status, "passed", "T10: running D clears the failed latch");
});

// ── T11: other classes ───────────────────────────────────────────────────────────────────────────
await measure("T11", async (make) => {
  const f = await make();
  await f.start();
  assertStopped("T11 build", await f.bash("npm run build; echo done"), "npm run build", "echo done");
  assertStopped("T11 static", await f.bash("tsc; echo done"), "tsc", "echo done");
});

// ── T12: the grader's 2000-entry request window (vinci-grader.ts:200) ────────────────────────────
// A stop leaves two extra session entries (verification's attempt + the undo's re-persist), so the
// window that carries the supplemental receipts closes up to two entries earlier per stop. The branch is
// seeded with a request start, a passed direct check and one scoped `git diff --check` receipt, then
// padded with inert entries so that branch.length - requestStart equals `distance` before the stop.
const SUPPLEMENTAL = "\n\nSupplemental current-request formatting checks";
async function graderEdge(make, distance) {
  const f = await make();
  await f.start();
  f.entries.push({ type: "message", id: "request", message: { role: "user", content: "Fix the rounding bug", timestamp: 0 } });
  const requestStart = f.entries.length - 1;
  await f.mutate();
  assert.equal((await f.bash("npm test", { output: GREEN })).spy, 1, "T12: green direct run");
  f.entries.push({
    type: "message",
    id: "diff-call",
    message: { role: "assistant", content: [{ type: "toolCall", id: "diff-1", name: "bash", arguments: { command: "git diff --check -- money.js" } }] },
  });
  f.entries.push({
    type: "message",
    id: "diff-result",
    message: { role: "toolResult", toolCallId: "diff-1", toolName: "bash", isError: false, content: [], details: { execution: { exitCode: 0, cwd: f.cwd, originalCommand: true } } },
  });
  while (f.entries.length - requestStart < distance) f.entries.push({ type: "custom", customType: "compound-preblock-filler", data: {}, id: `pad${f.entries.length}` });
  assert.equal(f.entries.length - requestStart, distance, "T12: seeded distance from the request start");
  return f;
}
for (const [id, distance, open] of [["T12", 1999, false], ["T12-control", 1998, true]]) {
  await measure(id, async (make) => {
    const f = await graderEdge(make, distance);
    const before = grader.verificationEvidenceFromBranch(f.entries);
    assert.ok(before.includes(SUPPLEMENTAL), `${id}: the receipt is in the grader evidence before the stop (precondition)`);
    const entriesBefore = f.entries.length;
    assertStopped(id, await f.bash("npm test; echo done"), "npm test", "echo done");
    assert.equal(f.entries.length - entriesBefore, 2, `${id}: the stop appended exactly two session entries`);
    const after = grader.verificationEvidenceFromBranch(f.entries);
    if (open) {
      assert.equal(after, before, `${id}: at distance ${distance + 2} the window is still open (evidence equal)`);
    } else {
      assert.equal(after, before.slice(0, before.indexOf(SUPPLEMENTAL)), `${id}: at distance ${distance + 2} the window is closed (only the receipt is dropped)`);
    }
  });
}
// Measurement only (no assertion beyond the run): how many session entries the same compound adds,
// and what the grader then reports, on whichever head this file runs against. At the base the
// compound runs and is discarded; at the change it is stopped.
for (const [id, seed] of [["N12-passed", "passed"], ["N12-none", "none"]]) {
  await measure(id, async (make) => {
    const f = await make();
    await f.start();
    f.entries.push({ type: "message", id: "request", message: { role: "user", content: "Fix the rounding bug", timestamp: 0 } });
    await f.mutate();
    if (seed === "passed") await f.bash("npm test", { output: GREEN });
    const entriesBefore = f.entries.length;
    const evidenceBefore = grader.verificationEvidenceFromBranch(f.entries);
    const observation = await f.bash("npm test; echo done", { output: GREEN });
    const evidenceAfter = grader.verificationEvidenceFromBranch(f.entries);
    console.log(`  ${id}: spy ${observation.spy}; entries added ${f.entries.length - entriesBefore}; grader evidence ${evidenceAfter === evidenceBefore ? "unchanged" : `changed (${JSON.stringify(evidenceBefore.split("\n")[0])} -> ${JSON.stringify(evidenceAfter.split("\n")[0])})`}`);
  });
}

console.log(`verification-compound-preblock: ${ran - failures}/${ran} passed`);
process.exitCode = failures === 0 && ran > 0 ? 0 : 1;
