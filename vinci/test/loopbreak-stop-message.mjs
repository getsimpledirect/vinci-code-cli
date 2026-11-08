// The per-turn limit stop message names the limit it reached and, only in the interactive terminal,
// that a typed "continue" starts a fresh turn. Drives the real input -> agent_start -> tool_call
// hooks of the loopbreak extension; no model call, no tool executes.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
const ext = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
assert.notEqual(process.env.VINCI_NO_TURNSTOP, "1", "measure with TURNSTOP enabled");

// Built from the exported constants, never from the extension's own sentence helpers, so a change
// to the constant moves the expectation and a change to the wording fails the text assertion.
const ACTIONS = ext.TURN_CALL_CEILING;
const LOOKUPS = ext.READ_ONLY_NAVIGATION_CEILING;
assert.ok(Number.isInteger(ACTIONS) && ACTIONS > 0, "action ceiling is a positive integer");
assert.ok(Number.isInteger(LOOKUPS) && LOOKUPS > 0, "navigation ceiling is a positive integer");
const REMEDY = " Type continue to start a fresh turn on the same task.";
const ACTION_REASON = `Vinci reached the limit of ${ACTIONS} actions allowed in one turn before finishing.`;
const LOOKUP_REASON = `Vinci reached the limit of ${LOOKUPS} read-only lookups allowed in one turn before finishing.`;
const ACTION_NOTE = `Vinci reached the limit of ${ACTIONS} actions for this turn — telling it to stop and answer. Press Ctrl+C if you want to step in.`;
const LOOKUP_NOTE = `Vinci reached the limit of ${LOOKUPS} read-only lookups for this turn — telling it to stop and answer. Press Ctrl+C if you want to step in.`;

// The three run shapes. In rpc mode the host binds a UI context, so hasUI is true there too
// (rpc-mode.ts binds uiContext; runner.ts sets hasUI from it); rpc prompts arrive as "rpc". Print
// and json modes bind no UI and send prompts with no source, which agent-session.ts defaults to
// "interactive" — so the print shape's prompts carry source "interactive" although nobody types.
const SHAPES = {
  tui: { ctx: { hasUI: true, mode: "tui" }, source: "interactive", remedy: true },
  rpc: { ctx: { hasUI: true, mode: "rpc" }, source: "rpc", remedy: false },
  print: { ctx: { hasUI: false, mode: "print" }, source: "interactive", remedy: false },
  json: { ctx: { hasUI: false, mode: "json" }, source: "interactive", remedy: false },
  "missing-mode": { ctx: { hasUI: true }, source: "interactive", remedy: false },
  "unknown-mode": { ctx: { hasUI: true, mode: "terminal" }, source: "interactive", remedy: false },
};

function fixture(id, shape) {
  const handlers = {};
  const controls = [];
  const notes = [];
  const aborts = [];
  const ctx = {
    ...shape.ctx,
    ui: { notify(message, type) { notes.push({ message, type }); } },
    cwd: resolve(here, "../.."),
    abort() { aborts.push(id); },
  };
  ext.default({
    on(name, fn) { (handlers[name] ??= []).push(fn); },
    sendMessage(message, options) { controls.push({ message, options }); },
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
  });
  assert.equal(handlers.tool_call?.length, 1, `${id}: one registered loopbreak tool_call hook`);
  const emit = async (name, event) => {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  };
  let call = 0;
  return {
    notes,
    async start(text, source = shape.source) {
      await emit("input", { text, source });
      await emit("agent_start", {});
      call = 0;
    },
    async tool(toolName, input) {
      call++;
      const before = controls.length;
      const noteBefore = notes.length;
      const result = await handlers.tool_call[0]({ toolName, input }, ctx);
      return { result, call, controls: controls.slice(before), notes: notes.slice(noteBefore) };
    },
    async finish() {
      // firmBlock defers its abort; wait past it so a stray abort is seen.
      await delay(250);
      assert.deepEqual(aborts, [], `${id}: a single limit stop must not abort the turn`);
    },
  };
}

const KINDS = {
  action: {
    limit: ACTIONS,
    reason: ACTION_REASON,
    note: ACTION_NOTE,
    marker: (n) => `(Action ${n} this turn — over the limit`,
    call: (f, label, i) => f.tool("edit", { path: `${label}-${i}.ts`, edits: [] }),
  },
  // N1: read-only shell navigation (the bash branch of the navigation ceiling).
  "navigation-shell": {
    limit: LOOKUPS,
    reason: LOOKUP_REASON,
    note: LOOKUP_NOTE,
    marker: (n) => `(Read-only call ${n} this turn — over the navigation limit`,
    call: (f, label, i) => f.tool("bash", { command: `git diff HEAD~${i} -- ${label}-${i}.ts` }),
  },
  // N2: structured read-only tools (the read/grep/find branch of the navigation ceiling).
  "navigation-tool": {
    limit: LOOKUPS,
    reason: LOOKUP_REASON,
    note: LOOKUP_NOTE,
    marker: (n) => `(Read-only call ${n} this turn — over the navigation limit`,
    call: (f, label, i) => f.tool("read", { path: `${label}-${i}.ts` }),
  },
};

// Spend the whole budget, then assert the stop fires AT call limit + 1 and is the limit stop.
async function hitLimit(f, kind, label) {
  const k = KINDS[kind];
  for (let i = 1; i <= k.limit; i++) {
    const r = await k.call(f, label, i);
    assert.notEqual(r.result?.block, true, `${label}: call ${i} of ${k.limit} is not blocked`);
  }
  const stop = await k.call(f, label, k.limit + 1);
  assert.equal(stop.call, k.limit + 1, `${label}: the stop is observed at call ${k.limit + 1}`);
  assert.equal(stop.result?.block, true, `${label}: call ${k.limit + 1} is blocked`);
  const loopStops = stop.controls.filter((c) => c.message.customType === "vinci-loop-stop");
  assert.equal(loopStops.length, 1, `${label}: exactly one limit stop control`);
  assert.ok(loopStops[0].message.content.includes(k.marker(k.limit + 1)), `${label}: the model-facing steer reports call ${k.limit + 1}`);
  return stop;
}

function expectTexts(stop, kind, shape, label) {
  const k = KINDS[kind];
  const expectedReason = k.reason + (shape.remedy ? REMEDY : "");
  const recorded = control.getVinciAutomationStop();
  assert.equal(recorded.stopped, true, `${label}: the automation stop is latched`);
  assert.equal(recorded.reason, expectedReason, `${label}: the stop reason is the whole expected sentence`);
  const warnings = stop.notes.filter((n) => n.type === "warning");
  if (shape.ctx.hasUI) {
    assert.deepEqual(warnings.map((n) => n.message), [k.note], `${label}: the warning note is the whole expected sentence`);
  } else {
    assert.deepEqual(warnings, [], `${label}: no UI note without a UI`);
  }
}

// Every case runs and reports on its own, so one failing case does not hide the others.
const passed = [];
const failed = [];
async function runCase(label, body) {
  try {
    await body();
    passed.push(label);
    console.log(`PASS ${label}`);
  } catch (error) {
    failed.push(label);
    console.log(`FAIL ${label}: ${error?.message?.split("\n")[0] ?? error}`);
  }
}

for (const kind of Object.keys(KINDS)) {
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    const label = `${kind}/${shapeName}`;
    await runCase(label, async () => {
      const f = fixture(label, shape);
      await f.start(`Investigate and change ${label}`);
      const stop = await hitLimit(f, kind, label);
      expectTexts(stop, kind, shape, label);
      await f.finish();
    });
  }
}

// Tie: the remedy is shown exactly where the grant it names follows. In the interactive terminal a
// typed "continue" (source "interactive", not streaming) resets both per-turn budgets, so the next
// full budget is reachable and the limit fires again at limit + 1 (positive control). In the rpc
// shape a continue keeps the spent budget and the first call is refused.
assert.equal(ext.typedContinueGrantsFreshTurn({ source: "interactive" }), true, "the shared grant: typed interactive");
assert.equal(ext.typedContinueGrantsFreshTurn({ source: "interactive", streamingBehavior: "steer" }), false, "the shared grant: not while streaming");
assert.equal(ext.typedContinueGrantsFreshTurn({ source: "rpc" }), false, "the shared grant: not rpc");
assert.equal(ext.typedContinueGrantsFreshTurn({ source: "extension" }), false, "the shared grant: not extension");
assert.equal(ext.typedContinueGrantsFreshTurn({}), false, "the shared grant: not a missing source");
for (const kind of Object.keys(KINDS)) {
  await runCase(`tie/${kind}/tui`, async () => {
    const label = `tie/${kind}/tui`;
    const f = fixture(label, SHAPES.tui);
    await f.start(`Investigate and change ${label}`);
    await hitLimit(f, kind, `${label} first turn`);
    await f.start("continue", "interactive");
    assert.equal(control.getVinciAutomationStop().stopped, false, `${label}: the typed continue lifts the stop`);
    const again = await hitLimit(f, kind, `${label} after continue`);
    expectTexts(again, kind, SHAPES.tui, `${label} after continue`);
    await f.finish();
  });
  await runCase(`tie/${kind}/rpc`, async () => {
    const label = `tie/${kind}/rpc`;
    const f = fixture(label, SHAPES.rpc);
    await f.start(`Investigate and change ${label}`);
    await hitLimit(f, kind, `${label} first turn`);
    await f.start("continue", "rpc");
    const refused = await KINDS[kind].call(f, `${label}-after`, 1);
    assert.equal(refused.call, 1, `${label}: first call after the rpc continue`);
    assert.equal(refused.result?.block, true, `${label}: the rpc continue keeps the spent budget`);
    await f.finish();
  });
}

console.log(`loopbreak-stop-message: ${passed.length} passed, ${failed.length} failed (actions ${ACTIONS}, lookups ${LOOKUPS}).`);
assert.deepEqual(failed, [], "every stop-message case passes");
