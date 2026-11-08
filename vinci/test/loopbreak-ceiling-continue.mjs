// Measure the real loopbreak hook across interactive turns without a model or executed tools.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
const ext = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });
assert.equal(ext.TURN_CALL_CEILING, 25, "this measurement targets the 25-action ceiling");
assert.notEqual(process.env.VINCI_NO_TURNSTOP, "1", "measure with TURNSTOP enabled");

function fixture(id) {
  const handlers = {};
  const handlerLists = {};
  const controls = [];
  const aborts = [];
  let turn = 0;
  let turnCall = 0;
  let currentCall;
  const ctx = {
    hasUI: false,
    ui: { notify() {} },
    cwd: resolve(here, "../.."),
    mode: "tui",
    abort() { aborts.push({ ...currentCall }); },
  };
  // The same minimal ExtensionAPI fixture as loopbreak-integration.mjs; no model/modelRegistry.
  ext.default({
    on(name, fn) {
      handlers[name] = fn;
      (handlerLists[name] ??= []).push(fn);
    },
    sendMessage(message, options) { controls.push({ message, options }); },
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
  });
  assert.ok(handlers.tool_call);
  assert.ok(handlers.input);
  assert.ok(handlers.agent_start);
  return {
    controls,
    async start(text) {
      for (const fn of handlerLists.input) await fn({ text, source: "interactive" }, ctx);
      for (const fn of handlerLists.agent_start) await fn({}, ctx);
      turn++;
      turnCall = 0;
    },
    async call(toolName, input) {
      currentCall = { turn, call: ++turnCall, toolName, input };
      const before = controls.length;
      const result = await handlers.tool_call({ toolName, input }, ctx);
      const entries = controls.slice(before);
      return {
        ...currentCall,
        allowed: result === undefined,
        block: result?.block ?? null,
        reason: result?.reason ?? null,
        controls: entries,
        actionInControl: entries.map(({ message }) => /\(Action (\d+) this turn/.exec(message.content)?.[1] ?? null),
      };
    },
    async finish(observations) {
      // firmBlock defers abort by 200 ms. Observe it before the next isolated case starts.
      await delay(250);
      console.log(JSON.stringify({ case: id, observations, aborted: aborts.length > 0, aborts }));
      assert.deepEqual(aborts, [], `${id}: TURNSTOP must not abort these one/two-block scenarios`);
      console.log(`  PASS ${id}`);
    },
  };
}

function checkControls(observation, action, label) {
  assert.equal(observation.controls.length, action === null ? 0 : 1, `${label}: controls[] entry count`);
  if (action !== null) {
    assert.equal(observation.block, true, `${label}: refusal sets block === true`);
    const { message, options } = observation.controls[0];
    assert.ok(message.content.includes(`(Action ${action} this turn — over the limit`), `${label}: controls[] exact action ${action}`);
    assert.equal(message.customType, "vinci-loop-stop", `${label}: ceiling control type`);
    assert.equal(message.display, false);
    assert.deepEqual(options, { triggerTurn: false, deliverAs: "steer" });
  }
}

async function spend(f, id) {
  const calls = [];
  for (let action = 1; action <= 25; action++) {
    const observation = await f.call("edit", { path: `${id}-initial-${action}.ts`, edits: [] });
    assert.equal(observation.allowed, true, `${id}: action ${action} is reachable`);
    checkControls(observation, null, `${id} action ${action}`);
    calls.push(observation);
  }
  return calls;
}

async function exhaust(f, id) {
  await f.start(`Measure distinct changes for ${id}`);
  await spend(f, id);
  const refused = await f.call("edit", { path: `${id}-initial-26.ts`, edits: [] });
  checkControls(refused, 26, `${id} setup`);
  assert.equal(refused.allowed, false, `${id}: setup refuses action 26`);
  return refused;
}

// Keep independent failures visible in old-head controls, including both C5 spellings.
let failures = 0;
async function measure(id, run) {
  try {
    await run();
  } catch (error) {
    failures++;
    console.error(`FAIL ${id}: "${error.message.split("\n")[0]}"; inspect this assertion before retrying.`);
  }
}

// Each case owns a fresh extension instance; input precedes agent_start on every turn.
await measure("C1", async () => {
  const f = fixture("C1");
  await f.start("Measure 25 distinct changes for C1");
  const calls = await spend(f, "C1");
  assert.equal(f.controls.length, 0, "C1: all 25 calls pass without controls[] entries");
  await f.finish(calls);
});
await measure("C2", async () => {
  const f = fixture("C2");
  const refused = await exhaust(f, "C2");
  assert.equal(f.controls.length, 1, "C2: exactly one new control after action 26");
  await f.finish([refused]);
});
await measure("C3", async () => {
  const f = fixture("C3");
  const refused = await exhaust(f, "C3");
  await f.start("continue");
  const continued = await f.call("edit", { path: "C3-continued-1.ts", edits: [] });
  assert.equal(continued.allowed, true, "C3: typed continue grants action 1");
  checkControls(continued, null, "C3 continue");
  await f.finish([refused, continued]);
});
await measure("C4", async () => {
  const f = fixture("C4");
  const refused = await exhaust(f, "C4");
  await f.start("Start an unrelated implementation task");
  const fresh = await f.call("edit", { path: "C4-fresh-1.ts", edits: [] });
  assert.equal(fresh.allowed, true, "C4: a new non-continue prompt resets the action budget");
  checkControls(fresh, null, "C4 new prompt");
  await f.finish([refused, fresh]);
});
for (const [id, text] of [["C5-keep-going", "keep going"], ["C5-Continue", "Continue."]]) {
  await measure(id, async () => {
    const f = fixture(id);
    const refused = await exhaust(f, id);
    await f.start(text);
    const continued = await f.call("edit", { path: `${id}-continued-1.ts`, edits: [] });
    assert.equal(continued.allowed, true, `${id}: typed continuation grants action 1 as C3`);
    checkControls(continued, null, `${id} ${text}`);
    await f.finish([refused, continued]);
  });
}
await measure("C6", async () => {
  const f = fixture("C6");
  const refused = await exhaust(f, "C6");
  const read = await f.call("read", { path: "C6-navigation-read.ts" });
  assert.equal(read.allowed, true, "C6: READ_ONLY_TOOLS read remains available after action 26");
  const bash = await f.call("bash", { command: "git diff -- C6-navigation-bash.ts" });
  assert.equal(bash.allowed, true, "C6: read-only bash remains available after action 26");
  await f.finish([refused, read, bash]);
});

console.log(`loopbreak-ceiling-continue: ${failures} failed (C5 has two isolated inputs; C3 grants)`);
process.exitCode = failures === 0 ? 0 : 1;
