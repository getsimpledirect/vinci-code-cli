import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { executionSpecDigest, workOrderDigest } from "../worker/contracts/digest.mjs";
import { DEFAULT_MODEL_CLASSES, materializeEnvelope } from "../worker/task.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });
const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });
const forte = {
  id: "forte", name: "Vinci Forte", provider: "vinci", api: "openai-completions",
  reasoning: true, input: ["text"], contextWindow: 900000, maxTokens: 32768,
  cost: { input: 0.93, output: 3, cacheRead: 0.18, cacheWrite: 0.93 },
};

function runtime(model) {
  const handlers = {};
  const entries = [];
  const notifications = [];
  const commands = {};
  provenance.default({
    on(name, handler) { (handlers[name] ??= []).push(handler); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    registerCommand(name, command) { commands[name] = command; },
  });
  const ctx = { model, sessionManager: { getBranch: () => entries }, ui: {
    notify(message) { notifications.push(message); },
  } };
  const emit = async (name, event) => {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  };
  return { entries, notifications, commands, ctx, emit };
}

function registration() {
  let config;
  const handlers = {};
  provider.default({
    registerProvider(name, value) { if (name === "vinci") config = value; },
    on(name, handler) { (handlers[name] ??= []).push(handler); },
  });
  return { config, handlers };
}

for (const [requested, served, expected] of [
  ["fortissimo", "forte", false],
  ["forte", "mezzo", true],
  ["vinci/fortissimo", "vinci/mezzo", true],
  [" VINCI/FORTISSIMO ", " VINCI/FORTE ", false],
  ["fortissimo", "GLM 5.3", false],
]) {
  test(`T2 provenance ${requested}/${served} downgrade is ${expected}`, () => {
    assert.equal(provenance.isCheaperVinciClass(requested, served), expected,
      `isCheaperVinciClass(${JSON.stringify(requested)}, ${JSON.stringify(served)}) === ${expected}`);
  });
}

test("T4 legacy selection uses Forte prices", () => {
  const { config } = registration();
  const effective = config.models.find((model) => model.id === "forte");
  const legacy = provider.vinciClassModel
    ? provider.vinciClassModel("fortissimo", "Vinci Fortissimo")
    : config.models.find((model) => model.id === "fortissimo");
  assert.deepEqual(legacy?.cost, effective.cost, "Fortissimo cost must equal Forte cost");
});

test("T4 no registered model has Kimi rates", () => {
  const { config } = registration();
  for (const model of config.models) {
    assert.notDeepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
      "No registered model may retain the Kimi cost block");
  }
});

test("T4 deleted legacy Kimi metadata stays absent", () => {
  const source = readFileSync(resolve(here, "../extensions/vinci-provider.ts"), "utf8");
  assert.equal(/fortissimo:\s*\{\s*input:\s*3,\s*output:\s*15,\s*cacheRead:\s*0\.3,\s*cacheWrite:\s*3\s*\}/.test(source), false,
    "The obsolete Fortissimo Kimi price block must be deleted");
});

test("T5 picker offers auto, Mezzo and Forte only", () => {
  const { config } = registration();
  assert.deepEqual(config.models.map(({ id, name }) => [id, name]),
    [["auto", "Vinci Auto"], ["mezzo", "Vinci Mezzo"], ["forte", "Vinci Forte"]], "The Vinci picker must contain only auto, Mezzo and Forte");
});

test("T7 receipt preserves requested alias and effective Forte", async () => {
  const state = runtime({ ...forte, id: "fortissimo", name: "Vinci Fortissimo" });
  await state.emit("session_start", { reason: "startup" });
  const selection = state.entries.find(({ data }) => data.event === "selected").data;
  assert.equal(selection.requested.model, "fortissimo", "Receipt must preserve the requested alias fortissimo");
  assert.equal(selection.requested.alias, true, "Receipt must mark fortissimo as an alias");
  assert.equal(selection.effectiveClass, "forte", "Receipt must record the effective class forte");
  await state.emit("after_provider_response", { status: 200, headers: { "x-vinci-resolved-model": "GLM 5.3" } });
  await state.emit("message_end", { message: { role: "assistant", provider: "vinci", model: "forte", stopReason: "stop" } });
  const resolved = state.entries.find(({ data }) => data.event === "resolved")?.data;
  assert.equal(resolved?.requested.model, "fortissimo", "Resolved receipt must retain the original alias");
  assert.equal(resolved?.effectiveClass, "forte", "Resolved receipt must retain effective Forte");
  assert.equal(resolved?.resolved.model, "GLM 5.3", "Resolved receipt must retain the actual occupant");
});

test("T7 canonical model retains alias metadata and requested-tier header", async () => {
  const state = runtime({ ...forte, vinciRequestedClass: "fortissimo" });
  await state.emit("session_start", { reason: "startup" });
  const headers = {};
  await state.emit("before_provider_headers", { headers });
  assert.equal(headers["x-vinci-requested-tier"], "fortissimo", "The existing requested-tier header must preserve the alias");
  assert.equal(state.entries[0].data.requested.model, "fortissimo", "Effective model metadata must preserve the original selection");
});

test("T7 wire sends forte without relying on a server alias", async () => {
  const { handlers } = registration();
  let payload = { model: "vinci/fortissimo", messages: [] };
  for (const handler of handlers.before_provider_request ?? []) {
    payload = await handler({ payload }, { model: { ...forte, id: "fortissimo" } }) ?? payload;
  }
  assert.equal(payload.model, "forte", "The wire model must be forte");
});

function materialize(modelClass) {
  const vector = (name) => JSON.parse(readFileSync(resolve(here, `fixtures/contract-vectors/${name}/input.json`), "utf8"));
  const order = vector("work-order-1-minimal");
  const spec = vector("execution-spec-1-minimal");
  spec.workOrderDigest = workOrderDigest(order);
  spec.modelClass = modelClass;
  spec.requiredCapabilities = [];
  const triple = { work_order_id: order.id, contract_digest: spec.workOrderDigest, execution_spec_digest: executionSpecDigest(spec) };
  return materializeEnvelope(triple, { work_order: order, execution_spec: spec });
}

test("T8 worker materializes fortissimo to vinci/forte", () => {
  assert.deepEqual(DEFAULT_MODEL_CLASSES.fortissimo, { provider: "vinci", model: "forte" },
    "DEFAULT_MODEL_CLASSES.fortissimo must point to vinci/forte");
  const result = materialize("fortissimo");
  assert.equal(result.envelope.model, "forte", "The legacy contract must materialize to forte");
  assert.equal(result.contract.model_class, "fortissimo", "The contract selection must remain fortissimo");
});

test("T8 unknown worker class still refuses as unknown_model_class", () => {
  assert.throws(() => materialize("doesnotexist"), { code: "unknown_model_class" });
});

test("T9 alias note appears once across two turns", async () => {
  const state = runtime({ ...forte, id: "fortissimo" });
  await state.emit("session_start", { reason: "startup" });
  for (let turn = 0; turn < 2; turn++) {
    await state.emit("before_provider_headers", { headers: {} });
    await state.emit("message_end", { message: { role: "assistant", provider: "vinci", model: "forte", stopReason: "stop" } });
  }
  assert.equal(state.notifications.filter((message) => message === "Vinci Fortissimo now uses Vinci Forte").length, 1,
    "The Fortissimo alias note must appear exactly once per session");
});

test("T9 Forte never displays the alias note", async () => {
  const state = runtime(forte);
  await state.emit("session_start", { reason: "startup" });
  await state.emit("before_provider_headers", { headers: {} });
  assert.equal(state.notifications.length, 0, "Forte must not display an alias note");
});

test("T9 resolved alias displays the note once even when the model is Forte", async () => {
  const state = runtime({ ...forte, vinciRequestedClass: "fortissimo" });
  await state.emit("session_start", { reason: "startup" });
  await state.emit("model_select", { model: state.ctx.model, source: "restore" });
  await state.emit("before_provider_headers", { headers: {} });
  assert.equal(state.notifications.filter((message) => message === "Vinci Fortissimo now uses Vinci Forte").length, 1,
    "Resolved aliases must display the note exactly once");
});
