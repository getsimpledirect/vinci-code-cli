// Exercise the real input -> agent_start -> tool_call hooks; no real model or tools execute.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, process.argv.includes("--built")
  ? "../dist/extensions/vinci-loopbreak.js"
  : "../extensions/vinci-loopbreak.ts");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
const ext = await loader.import(modulePath, { default: false });
assert.equal(ext.TURN_CALL_CEILING, 25, "pin the action ceiling literally to 25");
assert.equal(ext.READ_ONLY_NAVIGATION_CEILING, 120, "keep the navigation bound at 120");
assert.notEqual(process.env.VINCI_NO_TURNSTOP, "1", "the abort spy requires TURNSTOP enabled");

function fixture(id) {
  const handlers = {};
  const controls = [];
  const aborts = [];
  let turn = 0;
  let call = 0;
  const ctx = {
    hasUI: false,
    ui: { notify() {} },
    cwd: resolve(here, "../.."),
    mode: "tui",
    abort() { aborts.push({ turn, call }); },
  };
  ext.default({
    on(name, fn) { (handlers[name] ??= []).push(fn); },
    sendMessage(message, options) { controls.push({ message, options }); },
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
  });
  const emit = async (name, event) => {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  };
  return {
    async input(event) { await emit("input", event); },
    async start(event) {
      await emit("input", event);
      await emit("agent_start", {});
      turn++;
      call = 0;
    },
    async action(label) {
      call++;
      const before = controls.length;
      const results = [];
      // Distinct edits exercise the action ceiling without todo or identical-call fixation.
      for (const handler of handlers.tool_call) {
        results.push(await handler({ toolName: "edit", input: { path: `${id}-${label}.ts`, edits: [] } }, ctx));
      }
      assert.equal(results.length, 1, `${id}: exercise the registered loopbreak tool_call hook`);
      return { result: results[0], controls: controls.slice(before), turn, call };
    },
    async finish(details) {
      // firmBlock schedules an abort after 200 ms; wait beyond it even after the last continue.
      await delay(250);
      console.log(`${id}: measured ${JSON.stringify({ ...details, aborts })}.`);
      assert.deepEqual(aborts, [], `${id}: TURNSTOP abort spy must remain empty`);
    },
  };
}

function allowed(observation, label) {
  assert.equal(observation.result, undefined, `${label}: action is reachable`);
  assert.deepEqual(observation.controls, [], `${label}: no refusal or fixation control`);
}

function ceiling(observation, action, label) {
  assert.equal(observation.result?.block, true, `${label}: ceiling refusal sets block === true`);
  assert.equal(observation.controls.length, 1, `${label}: exactly one ceiling control, not todo/fixation`);
  const { message, options } = observation.controls[0];
  assert.equal(message.customType, "vinci-loop-stop", `${label}: ceiling control type`);
  assert.ok(message.content.includes(`(Action ${action} this turn — over the limit`), `${label}: ceiling reports action ${action}`);
  assert.equal(message.display, false, `${label}: hidden ceiling steer`);
  assert.deepEqual(options, { triggerTurn: false, deliverAs: "steer" }, `${label}: ceiling does not trigger a turn`);
}

async function spend(f, label) {
  for (let action = 1; action <= 25; action++) {
    allowed(await f.action(`${label}-${action}`), `${label} action ${action}`);
  }
  ceiling(await f.action(`${label}-26`), 26, `${label} action 26`);
}

async function exhaust(f, id) {
  await f.start({ text: `Implement distinct changes for ${id}`, source: "interactive" });
  await spend(f, `${id} initial`);
}

const cases = {
  async P1() {
    const f = fixture("P1");
    await exhaust(f, "P1");
    await f.start({ text: "continue", source: "interactive" });
    await spend(f, "P1 continued");
    await f.finish({ allowedPerTurn: 25, refusedActions: [26, 26], continueInputs: 1 });
  },
  async P2() {
    const f = fixture("P2");
    await exhaust(f, "P2");
    await f.start({ text: "continue", source: "interactive" });
    for (let cycle = 1; cycle <= 4; cycle++) {
      await spend(f, `P2 continue cycle ${cycle}`);
      await f.start({ text: "continue", source: "interactive" });
    }
    await f.finish({ continueCycles: 4, allowedPerTurn: 25, refusedActions: [26, 26, 26, 26, 26], continueInputs: 5 });
  },
  async N1a() {
    const f = fixture("N1a");
    await exhaust(f, "N1a");
    // Exact mid-turn shape: no agent_start between this input and the next call.
    await f.input({ text: "continue", source: "interactive", streamingBehavior: true });
    const refused = await f.action("streaming-27");
    assert.equal(refused.turn, 1, "N1a: streaming input stays in the original turn");
    assert.equal(refused.call, 27, "N1a: no agent_start before the next call");
    ceiling(refused, 27, "N1a streaming mid-turn");
    await f.finish({ event: { text: "continue", source: "interactive", streamingBehavior: true }, agentStartAfterInput: false, refusedAction: 27 });
  },
  async N1b() {
    const f = fixture("N1b");
    await exhaust(f, "N1b");
    // A boundary probe as well: streaming input must not buy a budget at agent_start.
    await f.start({ text: "continue", source: "interactive", streamingBehavior: true });
    const refused = await f.action("streaming-boundary-1");
    assert.equal(refused.call, 1, "N1b: first call after agent_start");
    ceiling(refused, 27, "N1b streaming boundary call 1");
    await f.finish({ event: { text: "continue", source: "interactive", streamingBehavior: true }, agentStartAfterInput: true, refusedCall: 1, carriedAction: 27 });
  },
  async N2() {
    const f = fixture("N2");
    await exhaust(f, "N2");
    await f.start({ text: "continue", source: "extension" });
    const refused = await f.action("extension-1");
    assert.equal(refused.call, 1, "N2: first call after agent_start");
    ceiling(refused, 27, "N2 extension call 1");
    await f.finish({ refusedCall: 1, carriedAction: 27 });
  },
  async N3() {
    const f = fixture("N3");
    await exhaust(f, "N3");
    await f.start({ text: "continue" });
    const refused = await f.action("missing-source-1");
    assert.equal(refused.call, 1, "N3: first call after agent_start");
    ceiling(refused, 27, "N3 missing-source call 1");
    await f.finish({ event: { text: "continue" }, refusedCall: 1, carriedAction: 27 });
  },
  async N4() {
    for (const [label, text] of [
      ["number", 7], ["boolean", true], ["null", null], ["missing", undefined],
      ["object", {}], ["array", ["continue"]], ["boxed-string", new String("continue")],
      ["trim-method", { trim() { return "continue"; } }],
    ]) {
      const f = fixture(`N4-${label}`);
      await exhaust(f, `N4-${label}`);
      await assert.doesNotReject(() => f.start({ text, source: "interactive" }), `N4 ${label}: malformed text must not throw`);
      ceiling(await f.action("malformed-1"), 27, `N4 ${label} call 1`);
      await f.finish({ malformedType: label, refusedCall: 1, carriedAction: 27 });
    }
  },
  async N5() {
    const f = fixture("N5");
    await exhaust(f, "N5");
    await f.start({ text: "continue", source: "rpc" });
    const refused = await f.action("rpc-1");
    assert.equal(refused.call, 1, "N5: first call after agent_start");
    ceiling(refused, 27, "N5 rpc call 1");
    await f.finish({ event: { text: "continue", source: "rpc" }, refusedCall: 1, carriedAction: 27 });
  },
  async N6() {
    const TASK_TEXT = "Repair the zebra-ledger rounding";
    const faux = registerFauxProvider({
      api: "faux:loopbreak-continue-grant-n6",
      provider: "faux-loopbreak-continue-grant-n6",
      models: [
        { id: "auto", name: "Vinci" },
        { id: "forte", name: "Vinci Forte" },
        { id: "fortissimo", name: "Vinci Fortissimo" },
      ],
    });
    try {
      const handlers = {};
      const prompts = [];
      let calls = 0;
      const ctx = {
        model: faux.getModel("auto"),
        modelRegistry: {
          find(_provider, id) { return faux.getModel(id); },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "offline-faux-key", headers: {}, env: {} };
          },
        },
        cwd: resolve(here, "../.."),
        hasUI: true,
        mode: "tui",
        ui: { notify() {} },
        sessionManager: { getSessionId: () => "loopbreak-continue-grant-n6", getBranch: () => [] },
      };
      faux.setResponses([(context) => {
        calls++;
        prompts.push(context.messages.map((message) => typeof message.content === "string"
          ? message.content
          : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n"));
        return fauxAssistantMessage("Inspect the failing branch.");
      }]);
      ext.default({
        on(name, fn) { (handlers[name] ??= []).push(fn); },
        sendMessage() {},
        registerCommand() {},
        registerTool() {},
        appendEntry() {},
      });
      for (const text of [TASK_TEXT, "continue"]) {
        for (const handler of handlers.input) await handler({ text, source: "interactive" }, ctx);
        for (const handler of handlers.agent_start) await handler({}, ctx);
      }
      for (let repeat = 1; repeat <= 4; repeat++) {
        for (const handler of handlers.tool_call) {
          await handler({ toolName: "edit", input: { path: "zebra-ledger.ts", edits: [] } }, ctx);
        }
      }
      assert.ok(calls > 0 && prompts.length >= 1, "N6: positive control reaches the faux escalation completion");
      console.log(`N6: positive control passed; measured ${calls} faux completion and ${prompts.length} decoded prompt.`);
      const prompt = prompts.join("\n");
      assert.ok(!prompt.includes("The user's task:\ncontinue"), "N6: escalation task must not become continue after the grant");
      assert.ok(prompt.includes("The user's task:\n" + TASK_TEXT), "N6: escalation task retains the original distinctive request after the grant");
    } finally {
      faux.unregister();
    }
  },
  async P3() {
    const f = fixture("P3");
    await exhaust(f, "P3");
    await f.start({ text: "Implement a different change", source: "interactive" });
    await spend(f, "P3 new task");
    await f.finish({ allowedPerTurn: 25, refusedActions: [26, 26] });
  },
};

const selected = process.argv.slice(2).filter((arg) => arg !== "--built");
for (const id of selected) assert.ok(Object.hasOwn(cases, id), `unknown case "${id}"; select a named case`);
let failures = 0;
for (const id of selected.length ? selected : Object.keys(cases)) {
  try {
    await cases[id]();
    console.log(`PASS ${id}: all reachability, ceiling and abort assertions passed.`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${id}: "${error.message.split("\n")[0]}"; inspect this assertion before retrying.`);
  }
}
console.log(`loopbreak-continue-grant: measured module "${modulePath}"; ${failures} cases failed.`);
process.exitCode = failures === 0 ? 0 : 1;
