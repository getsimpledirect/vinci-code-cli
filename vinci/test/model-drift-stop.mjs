import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const forte = {
  id: "forte",
  api: "openai-completions",
  provider: "vinci",
  reasoning: true,
  input: ["text"],
  contextWindow: 900000,
  maxTokens: 32768,
};
const fireworks = "accounts/fireworks/models/glm-5p3";
const deepinfra = "zai-org/GLM-5.3";

async function runtime({ requested = "forte", entries = [], notifyOnly = false } = {}) {
  const previousSwitch = process.env.VINCI_NO_DRIFT_STOP;
  if (notifyOnly) process.env.VINCI_NO_DRIFT_STOP = "1";
  else delete process.env.VINCI_NO_DRIFT_STOP;
  const extension = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });
  const state = {
    entries: structuredClone(entries),
    handlers: {},
    commands: {},
    notifications: [],
    timers: [],
    aborts: 0,
  };
  extension.default({
    appendEntry(customType, data) {
      state.entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    on(name, handler) {
      state.handlers[name] ??= [];
      state.handlers[name].push(handler);
    },
    registerCommand(name, command) {
      state.commands[name] = command;
    },
  });
  const ctx = {
    model: { ...forte, id: requested },
    sessionManager: { getBranch: () => state.entries },
    ui: { notify: (message, type) => state.notifications.push({ message, type }) },
    abort() {
      state.aborts++;
    },
  };
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => {
    state.timers.push(() => callback(...args));
    return state.timers.length;
  };
  state.restore = () => {
    globalThis.setTimeout = originalTimeout;
    if (previousSwitch === undefined) delete process.env.VINCI_NO_DRIFT_STOP;
    else process.env.VINCI_NO_DRIFT_STOP = previousSwitch;
  };
  state.emit = async (name, event) => {
    for (const handler of state.handlers[name] ?? []) await handler({ type: name, ...event }, ctx);
  };
  state.turn = async (responseModel = deepinfra, headers = {}, stopReason = "stop") => {
    await state.emit("before_provider_headers", { headers: {} });
    await state.emit("after_provider_response", { status: 200, headers });
    await state.emit("message_end", {
      message: { role: "assistant", provider: "vinci", model: requested, responseModel, stopReason },
    });
  };
  state.records = (event) => state.entries.filter((entry) => entry.data.event === event).map((entry) => entry.data);
  state.errors = () => state.notifications.filter((entry) => entry.type === "error");
  state.info = async () => {
    await state.commands["model-info"].handler("", ctx);
    return state.notifications.at(-1).message;
  };
  state.flushTimers = () => {
    for (const callback of state.timers.splice(0)) callback();
  };
  await state.emit("session_start", { reason: entries.length ? "resume" : "startup" });
  return state;
}

function assertDeferredAbort(state) {
  assert.equal(state.aborts, 0, "abort must not run synchronously inside a hook");
  state.flushTimers();
  assert.equal(state.aborts, 1, "real drift must defer an abort until after the hook returns");
  assert.equal(state.records("drift").length, 1, "real drift must be recorded");
  assert.match(
    state.errors().at(-1).message,
    /Vinci stopped this turn: the model changed from .+ to .+\. This session stays stopped; start a new session \(\/new\) to continue with .+\./,
  );
  assert.doesNotMatch(state.errors().at(-1).message, /re-run/, "a re-run in the same session is stopped again; never offer it");
}

const cases = [
  [
    "D1 stream provider spelling is not drift",
    {},
    async (state) => {
      await state.turn(fireworks);
      await state.turn(deepinfra);
      assert.equal(state.records("drift").length, 0, "provider spellings must not create drift");
      assert.equal(state.errors().length, 0, "provider spellings must not notify an error");
      state.flushTimers();
      assert.equal(state.aborts, 0);
    },
  ],
  [
    "D2 a streamed Forte route reporting Mezzo stops",
    {},
    async (state) => {
      await state.turn(fireworks);
      await state.turn(deepinfra);
      await state.turn(deepinfra, { "x-vinci-resolved-class": "mezzo" });
      assertDeferredAbort(state);
      assert.equal(state.records("drift")[0].observed.resolvedClass, "mezzo");
    },
  ],
  [
    "D3 gateway model change stops",
    {},
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.3" });
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.4" });
      assert.equal(state.records("drift").length, 1);
      assert.equal(state.errors().length, 1);
      assertDeferredAbort(state);
    },
  ],
  [
    "D4 stable route over three turns",
    {},
    async (state) => {
      for (let turn = 0; turn < 3; turn++) await state.turn();
      assert.equal(state.records("drift").length, 0);
      assert.equal(state.errors().length, 0);
      state.flushTimers();
      assert.equal(state.aborts, 0);
      assert.match(await state.info(), /Status: stable$/m);
    },
  ],
  [
    "D5 kill switch retains notify-only drift",
    { notifyOnly: true },
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.3" });
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.4" });
      assert.equal(state.records("drift").length, 1);
      assert.equal(state.errors().length, 1);
      state.flushTimers();
      assert.equal(state.aborts, 0, "kill switch must disable aborts");
    },
  ],
  [
    "D6 CRITICAL cheaper-class response stops",
    {},
    async (state) => {
      await state.turn(deepinfra);
      await state.turn("mezzo");
      assert.match(state.errors().at(-1).message, /CRITICAL/);
      assertDeferredAbort(state);
    },
  ],
  [
    "D7 Auto accepts its first class and stays stable",
    { requested: "auto" },
    async (state) => {
      for (let turn = 0; turn < 3; turn++) await state.turn(deepinfra, { "x-vinci-resolved-class": "mezzo" });
      assert.equal(state.records("drift").length, 0, "Auto must accept the first observed class");
      assert.equal(state.errors().length, 0);
      state.flushTimers();
      assert.equal(state.aborts, 0);
    },
  ],
  [
    "D8 Fortissimo canonicalises to Forte",
    { requested: "fortissimo" },
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-class": "forte" });
      assert.equal(state.records("drift").length, 0, "Fortissimo served as Forte must not drift");
      assert.equal(state.errors().length, 0);
      state.flushTimers();
      assert.equal(state.aborts, 0);
    },
  ],
  [
    "D9 Auto class change stops",
    { requested: "auto" },
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-class": "mezzo" });
      await state.turn(deepinfra, { "x-vinci-resolved-class": "forte" });
      assertDeferredAbort(state);
    },
  ],
  [
    "D10 all stream IDs remain visible without drift",
    {},
    async (state) => {
      await state.turn(fireworks);
      await state.turn(deepinfra);
      await state.turn(deepinfra);
      const info = await state.info();
      assert.match(info, /Provider routes seen: accounts\/fireworks\/models\/glm-5p3, zai-org\/GLM-5\.3/i);
      assert.match(info, /Status: stable \(provider route changed 1 times; same model class\)/);
      assert.equal(state.records("drift").length, 0);
      state.flushTimers();
      assert.equal(state.aborts, 0);
    },
  ],
  [
    "class-only Auto resolution survives resume",
    { requested: "auto" },
    async (state) => {
      await state.turn(null, { "x-vinci-resolved-class": "mezzo" });
      const saved = structuredClone(state.entries);
      state.restore();
      const resumed = await runtime({ requested: "auto", entries: saved });
      try {
        await resumed.turn(deepinfra, { "x-vinci-resolved-class": "forte" });
        assertDeferredAbort(resumed);
        assert.equal(resumed.records("drift")[0].pinned.resolvedClass, "mezzo");
      } finally {
        resumed.restore();
      }
    },
  ],
  [
    "first concrete-class mismatch stops immediately",
    {},
    async (state) => {
      await state.turn(deepinfra, { "X-Vinci-Resolved-Class": "mezzo" });
      assertDeferredAbort(state);
    },
  ],
  [
    "stream evidence upgrades to gateway evidence",
    {},
    async (state) => {
      await state.turn(fireworks);
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.3" });
      assert.equal(state.records("drift").length, 0);
      assert.equal(state.records("resolved").at(-1).resolved.evidence, "gateway-header");
      assert.match(
        await state.info(),
        /Provider routes seen: accounts\/fireworks\/models\/glm-5p3, zai-org\/GLM-5\.3/i,
      );
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.4" });
      assertDeferredAbort(state);
    },
  ],
  [
    "gateway version and capability changes each stop",
    {},
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.3", "x-vinci-model-version": "v1" });
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.3", "x-vinci-model-version": "v2" });
      assertDeferredAbort(state);
      state.restore();
      const capability = await runtime();
      try {
        await capability.turn(deepinfra, {
          "x-vinci-resolved-model": "GLM 5.3",
          "x-vinci-capability-fingerprint": "cap1",
        });
        await capability.turn(deepinfra, {
          "x-vinci-resolved-model": "GLM 5.3",
          "x-vinci-capability-fingerprint": "cap2",
        });
        assertDeferredAbort(capability);
      } finally {
        capability.restore();
      }
    },
  ],
  [
    "provider route history survives resume and counts revisits",
    {},
    async (state) => {
      await state.turn(fireworks);
      await state.turn(deepinfra);
      const saved = structuredClone(state.entries);
      state.restore();
      const resumed = await runtime({ entries: saved });
      try {
        await resumed.turn(fireworks);
        assert.deepEqual(resumed.records("resolved").at(-1).resolved.streamModels, [fireworks, deepinfra]);
        assert.match(await resumed.info(), /provider route changed 2 times/);
        assert.equal(resumed.records("drift").length, 0);
        resumed.flushTimers();
        assert.equal(resumed.aborts, 0);
      } finally {
        resumed.restore();
      }
    },
  ],
  [
    "weaker stream evidence preserves the gateway pin",
    {},
    async (state) => {
      await state.turn(fireworks, { "x-vinci-resolved-model": "GLM 5.3" });
      await state.turn(deepinfra);
      assert.equal(state.records("drift").length, 0);
      assert.equal(state.records("resolved").at(-1).resolved.model, "GLM 5.3");
      assert.equal(state.records("resolved").at(-1).resolved.evidence, "gateway-header");
      assert.match(await state.info(), /zai-org\/GLM-5\.3/);
      state.flushTimers();
      assert.equal(state.aborts, 0);
    },
  ],
  [
    "missing class signals do not erase Auto's expectation",
    { requested: "auto" },
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-class": "mezzo" });
      await state.turn(fireworks);
      assert.equal(state.records("resolved").at(-1).resolved.expectedClass, "mezzo");
      await state.turn(fireworks, { "x-vinci-resolved-class": "forte" });
      assertDeferredAbort(state);
    },
  ],
  [
    "non-class requests learn the first observed class",
    { requested: "fixed-model" },
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-class": "mezzo" });
      assert.equal(state.records("drift").length, 0);
      await state.turn(deepinfra, { "x-vinci-resolved-class": "forte" });
      assertDeferredAbort(state);
    },
  ],
  [
    "a different streamed model remains visible without a class signal",
    {},
    async (state) => {
      await state.turn(deepinfra);
      await state.turn("provider/different-model");
      assert.equal(state.records("drift").length, 0);
      assert.match(await state.info(), /provider\/different-model/);
      state.flushTimers();
      assert.equal(state.aborts, 0);
    },
  ],
  [
    "repeated real drift still stops without duplicate drift records",
    {},
    async (state) => {
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.3" });
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.4" });
      assertDeferredAbort(state);
      await state.turn(deepinfra, { "x-vinci-resolved-model": "GLM 5.4" });
      state.flushTimers();
      assert.equal(state.aborts, 2);
      assert.equal(state.records("drift").length, 1);
    },
  ],
];

let failures = 0;
for (const [name, options, check] of cases) {
  if (process.argv[2] && name.split(" ")[0] !== process.argv[2]) continue;
  let state;
  try {
    state = await runtime(options);
    await check(state);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error.stack}`);
  } finally {
    state?.restore();
  }
}
process.exitCode = failures ? 1 : 0;
