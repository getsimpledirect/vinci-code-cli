import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });

const forte = {
  id: "forte",
  name: "Vinci Forte (GLM 5.2)",
  api: "openai-completions",
  provider: "vinci",
  baseUrl: "https://example.invalid/api/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 900000,
  maxTokens: 32768,
  compat: { supportsDeveloperRole: false, sendSessionAffinityHeaders: true },
};

const fixedModel = {
  ...forte,
  id: "fixed-model",
  name: "Fixed Model",
  reasoning: false,
  contextWindow: 65536,
  maxTokens: 16384,
};

function runtime(existingEntries = []) {
  const entries = [...existingEntries];
  const handlers = {};
  const commands = {};
  const notifications = [];
  const pi = {
    appendEntry(customType, data) {
      entries.push({
        type: "custom",
        customType,
        data,
        id: `entry-${entries.length + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
      });
    },
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand(name, options) {
      commands[name] = options;
    },
  };
  provenance.default(pi);
  return { entries, handlers, commands, notifications };
}

function context(state, model) {
  return {
    model,
    sessionManager: {
      getBranch() {
        return state.entries;
      },
    },
    ui: {
      notify(message, type) {
        state.notifications.push({ message, type });
      },
    },
  };
}

async function emit(state, name, event, ctx) {
  for (const handler of state.handlers[name] ?? []) await handler(event, ctx);
}

function records(state, event) {
  return state.entries
    .filter((entry) => entry.customType === "vinci-model-provenance" && entry.data?.event === event)
    .map((entry) => entry.data);
}

const state = runtime();
const ctx = context(state, forte);
await emit(state, "session_start", { type: "session_start", reason: "startup" }, ctx);

const selected = records(state, "selected");
assert.equal(selected.length, 1);
assert.deepEqual(selected[0].requested, { provider: "vinci", model: "forte" });
assert.equal(selected[0].clientCapabilities.reasoning, true);
assert.match(selected[0].clientCapabilityFingerprint, /^[a-f0-9]{16}$/);

const firstHeaders = {};
await emit(state, "before_provider_headers", { type: "before_provider_headers", headers: firstHeaders }, ctx);
assert.equal(firstHeaders["x-vinci-requested-tier"], "forte");
assert.equal(firstHeaders["x-vinci-client-capability-fingerprint"], selected[0].clientCapabilityFingerprint);
assert.equal(firstHeaders["x-vinci-resolution-token"], undefined);
assert.equal(firstHeaders["x-vinci-platform"], "code");

await emit(
  state,
  "after_provider_response",
  {
    type: "after_provider_response",
    status: 200,
    headers: {
      "X-Vinci-Resolved-Model": "z-ai/glm-5.2",
      "X-Vinci-Model-Version": "2026-07-12",
      "X-Vinci-Capability-Fingerprint": "glm52-cap-v1",
      "X-Vinci-Resolution-Token": "opaque-route-pin",
    },
  },
  ctx,
);
await emit(
  state,
  "message_end",
  {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "vinci",
      model: "forte",
      responseModel: "z-ai/glm-5.2",
      stopReason: "stop",
    },
  },
  ctx,
);

const resolved = records(state, "resolved");
assert.equal(resolved.length, 1);
assert.equal(resolved[0].resolved.model, "z-ai/glm-5.2");
assert.equal(resolved[0].resolved.version, "2026-07-12");
assert.equal(resolved[0].resolved.capabilityFingerprint, "glm52-cap-v1");
assert.equal(resolved[0].resolved.resolutionToken, "opaque-route-pin");
assert.equal(resolved[0].resolved.evidence, "gateway-header");

const pinnedHeaders = {};
await emit(state, "before_provider_headers", { type: "before_provider_headers", headers: pinnedHeaders }, ctx);
assert.equal(pinnedHeaders["x-vinci-resolution-token"], "opaque-route-pin");

await state.commands["model-info"].handler("", ctx);
const stableInfo = state.notifications.at(-1);
assert.equal(stableInfo.type, "info");
assert.match(stableInfo.message, /Requested: vinci\/forte/);
assert.match(stableInfo.message, /Resolved: z-ai\/glm-5\.2 \(2026-07-12\)/);
assert.match(stableInfo.message, /Session pin: active/);
assert.doesNotMatch(stableInfo.message, /opaque-route-pin/);

const resumableEntries = state.entries.map((entry) => structuredClone(entry));
for (const reason of ["resume", "fork"]) {
  const restored = runtime(resumableEntries);
  const restoredCtx = context(restored, forte);
  const restoredCount = restored.entries.length;
  await emit(restored, "session_start", { type: "session_start", reason }, restoredCtx);
  assert.equal(
    restored.entries.length,
    restoredCount,
    `${reason} must restore provenance without duplicating selection entries`,
  );
  const restoredHeaders = {};
  await emit(
    restored,
    "before_provider_headers",
    { type: "before_provider_headers", headers: restoredHeaders },
    restoredCtx,
  );
  assert.equal(restoredHeaders["x-vinci-resolution-token"], "opaque-route-pin");
}

await emit(
  state,
  "after_provider_response",
  {
    type: "after_provider_response",
    status: 200,
    headers: {
      "x-vinci-resolved-model": "z-ai/glm-5.2",
      "x-vinci-model-version": "2026-07-13",
      "x-vinci-capability-fingerprint": "glm52-cap-v2",
      "x-vinci-resolution-token": "replacement-pin",
    },
  },
  ctx,
);
await emit(
  state,
  "message_end",
  {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "vinci",
      model: "forte",
      stopReason: "stop",
    },
  },
  ctx,
);

const drift = records(state, "drift");
assert.equal(drift.length, 1);
assert.equal(drift[0].pinned.version, "2026-07-12");
assert.equal(drift[0].observed.version, "2026-07-13");
assert.equal("resolutionToken" in drift[0].pinned, false, "drift evidence must not render or duplicate route pins");
assert.equal(state.notifications.at(-1).type, "error");
assert.match(state.notifications.at(-1).message, /model drift detected/i);

const afterDriftHeaders = {};
await emit(state, "before_provider_headers", { type: "before_provider_headers", headers: afterDriftHeaders }, ctx);
assert.equal(afterDriftHeaders["x-vinci-resolution-token"], "opaque-route-pin", "drift must not replace the session pin");

const direct = runtime();
const directCtx = context(direct, fixedModel);
await emit(direct, "session_start", { type: "session_start", reason: "new" }, directCtx);
await emit(direct, "after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, directCtx);
await emit(
  direct,
  "message_end",
  {
    type: "message_end",
    message: { role: "assistant", provider: "vinci", model: "fixed-model", stopReason: "stop" },
  },
  directCtx,
);
assert.equal(records(direct, "resolved").at(-1).resolved.evidence, "requested-model");

await emit(direct, "after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, directCtx);
await emit(
  direct,
  "message_end",
  {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "vinci",
      model: "fixed-model",
      responseModel: "provider/fixed-model-v1",
      stopReason: "stop",
    },
  },
  directCtx,
);
assert.equal(records(direct, "drift").length, 0, "stronger route evidence must enrich an alias, not report false drift");
assert.equal(records(direct, "resolved").at(-1).resolved.model, "provider/fixed-model-v1");
assert.equal(records(direct, "resolved").at(-1).resolved.evidence, "response-stream");

const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });
let providerConfig;
provider.default({
  registerProvider(_name, config) {
    providerConfig = config;
  },
  on() {},
});
assert.ok(providerConfig.models.length > 0);
for (const model of providerConfig.models) {
  assert.equal(model.compat?.sendSessionAffinityHeaders, true, `${model.id} must send session affinity headers`);
}


// Attribution must never reach a third-party provider: the hook is scoped to
// provider === "vinci", so a non-Vinci model must come back with no headers at all.
{
  const thirdParty = { ...forte, id: "some-other-model", provider: "anthropic" };
  const otherState = runtime();
  const otherCtx = context(otherState, thirdParty);
  await emit(otherState, "session_start", { type: "session_start", reason: "startup" }, otherCtx);
  const leaked = {};
  await emit(otherState, "before_provider_headers", { type: "before_provider_headers", headers: leaked }, otherCtx);
  assert.equal(leaked["x-vinci-platform"], undefined, "attribution leaked to a non-Vinci provider");
  assert.deepEqual(Object.keys(leaked), [], "no Vinci headers may be set for a third-party provider");
}

process.stdout.write("  model provenance: requested/resolved identity, resume pin, capabilities, and drift are durable\n");
