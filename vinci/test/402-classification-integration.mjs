import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });
const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });
const retry = await loader.import(resolve(here, "../../packages/ai/src/utils/retry.ts"), { default: false });
const { ExtensionRunner } = await loader.import(resolve(here, "../../packages/coding-agent/src/core/extensions/runner.ts"), { default: false });
const { runAgentLoop } = await loader.import(resolve(here, "../../packages/agent/src/agent-loop.ts"), { default: false });
const completions = await loader.import(resolve(here, "../../packages/ai/src/api/openai-completions.ts"), { default: false });

const IN_FLIGHT_BODY = JSON.stringify({
  message:
    "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.",
  code: 402,
  metadata: {
    reason: "in_flight_budget_exhausted",
    limit_source: "openrouter_in_flight_budget",
    remedy_hint: "Retry after your in-flight requests settle (see the Retry-After header). ...",
    headers: { "Retry-After": "120" },
  },
});
const AFFORDABILITY_BODY = JSON.stringify({
  message:
    "This request requires more credits, or fewer max_tokens.\nYou requested up to 131072 tokens, but can only afford 23014. ...",
});
const OUT_OF_CREDIT_BODY = JSON.stringify({
  error: { code: "balance_exhausted", message: "Vinci credits are exhausted." },
});

const with402 = (body) => Object.assign(new Error(body), { status: 402 });

export function assert402Classifications(classify) {
  assert.equal(classify(with402(IN_FLIGHT_BODY)), "account", "in-flight 402 must not permit escalation fallback");
  assert.equal(classify(with402(AFFORDABILITY_BODY)), "account", "affordability 402 must not permit escalation fallback");
  assert.equal(classify(with402(OUT_OF_CREDIT_BODY)), "account", "true out-of-credit 402 must stay terminal");
}

export const parseAffordableTokenCount = provider.vinciAffordableTokenLimit;

// The requested classifier mutation failed against the initial transient-classifier revision and
// was restored from the external backup. Review then deliberately made all 402s account-classified
// to prevent escalation fallback; the provider retry and clamping assertions below now pin recovery.
assert402Classifications(provenance.classifyVinciModelError);

assert.equal(parseAffordableTokenCount(AFFORDABILITY_BODY), 23014);
assert.equal(
  parseAffordableTokenCount("You requested up to 131,072 tokens, but can only afford 23,014"),
  23014,
  "thousands separators must be stripped from both numbers",
);
assert.equal(
  parseAffordableTokenCount("402 and 7: You requested up to 131072 tokens, but can only afford 23014; retry in 5"),
  23014,
  "unrelated numbers must not affect the canonical match",
);
assert.equal(parseAffordableTokenCount("You requested up to 10 tokens, but can only afford 0"), undefined);
assert.equal(parseAffordableTokenCount("You requested up to -10 tokens, but can only afford 5"), undefined);
assert.equal(parseAffordableTokenCount("You requested up to 10 tokens, but can only afford -5"), undefined);
assert.equal(parseAffordableTokenCount("can afford 19 tokens"), 19);
assert.equal(parseAffordableTokenCount("You requested up to 10 tokens, but can afford 5"), undefined);
assert.equal(parseAffordableTokenCount("You requested up to 1,00 tokens, but can only afford 5"), undefined);
assert.equal(
  parseAffordableTokenCount("You requested up to 9007199254740992 tokens, but can only afford 5"),
  undefined,
);
assert.equal(parseAffordableTokenCount("credits exhausted"), undefined);
assert.equal(typeof provider.isInFlightBudgetExhausted, "function");

assert.equal(
  provider.vinciBudgetBlockedMessage(IN_FLIGHT_BODY, "retryable-402"),
  undefined,
  "in-flight 402 must not be rewritten as terminal",
);
assert.equal(
  provider.vinciBudgetBlockedMessage(AFFORDABILITY_BODY, "retryable-402"),
  undefined,
  "affordability 402 must not be rewritten as terminal",
);
assert.equal(
  provider.vinciBudgetBlockedMessage(OUT_OF_CREDIT_BODY, "retryable-402"),
  "BLOCKED: budget — Vinci credits are exhausted. Review or restore credits at https://platform.getsimpledirect.com/billing?source=code.",
  "true out-of-credit messaging must remain unchanged",
);

const handlers = new Map();
provider.default({
  registerProvider() {},
  on(event, handler) {
    handlers.set(event, handler);
  },
});

const afterProviderResponse = handlers.get("after_provider_response");
const beforeProviderRequest = handlers.get("before_provider_request");
const messageEnd = handlers.get("message_end");
assert.equal(typeof afterProviderResponse, "function");
assert.equal(typeof beforeProviderRequest, "function");
assert.equal(typeof messageEnd, "function");

const context = {
  model: { provider: "vinci", id: "fortissimo" },
  sessionManager: { getSessionId: () => "retryable-402" },
};
const inFlightError = {
  role: "assistant",
  stopReason: "error",
  provider: "vinci",
  model: "fortissimo",
  errorMessage: IN_FLIGHT_BODY,
};
const affordabilityError = {
  role: "assistant",
  stopReason: "error",
  provider: "vinci",
  model: "fortissimo",
  errorMessage: AFFORDABILITY_BODY,
};

assert.equal(provider.vinciRetryAfterMs(IN_FLIGHT_BODY, "120"), 120_000);
await afterProviderResponse({ status: 402, headers: { "retry-after": "120" } }, context);
const inFlightRetry = await messageEnd({ message: inFlightError }, context);
assert.match(inFlightRetry?.message.errorMessage ?? "", /please retry/i, "in-flight 402 must signal a retry");
assert.equal(retry.isRetryableAssistantError(inFlightRetry.message), true, "the core retry handler must consume it");
assert.equal(inFlightRetry?.message.model, "fortissimo", "in-flight retry must not downgrade the model");
await afterProviderResponse({ status: 200, headers: {} }, context);

await afterProviderResponse({ status: 402, headers: {} }, context);
const retryResult = await messageEnd({ message: affordabilityError }, context);
assert.match(retryResult?.message.errorMessage ?? "", /please retry/i, "affordability must signal a retry");
assert.equal(retry.isRetryableAssistantError(retryResult.message), true, "the core retry handler must consume it");

const retriedPayload = await beforeProviderRequest(
  { payload: { model: "fortissimo", max_tokens: 131072, messages: [] } },
  context,
);
assert.deepEqual(
  retriedPayload,
  { model: "forte", max_tokens: 23014, messages: [] },
  "the one affordability retry must clamp max_tokens and resolve the Fortissimo alias to Forte",
);

await afterProviderResponse({ status: 402, headers: {} }, context);
const secondFailure = await messageEnd({ message: affordabilityError }, context);
assert.doesNotMatch(
  secondFailure?.message.errorMessage ?? "",
  /please retry/i,
  "a second affordability failure must become terminal",
);
assert.equal(secondFailure?.message.model, "fortissimo", "terminal handling must not downgrade the model");
assert.deepEqual(context.model, { provider: "vinci", id: "fortissimo" }, "the active model must remain unchanged");

await afterProviderResponse({ status: 200, headers: {} }, context);
for (let retryNumber = 3; retryNumber <= 10; retryNumber++) {
  await afterProviderResponse({ status: 402, headers: {} }, context);
  const boundedRetry = await messageEnd({ message: affordabilityError }, context);
  assert.match(boundedRetry?.message.errorMessage ?? "", /please retry/i, `402 retry ${retryNumber} must be allowed`);
  await afterProviderResponse({ status: 200, headers: {} }, context);
}
await afterProviderResponse({ status: 402, headers: {} }, context);
const retryCapResult = await messageEnd({ message: affordabilityError }, context);
assert.doesNotMatch(retryCapResult?.message.errorMessage ?? "", /please retry/i, "the 11th 402 retry must be rejected");

console.log("402-classification-integration: all checks passed");

// Advance the real handler's timers deterministically. 200 ms of virtual time is well below
// the 5000 ms retry, so an ignored abort fails an assertion without a wall-clock timeout.
function retryClock() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  let id = 0;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const timer = ++id;
    timers.set(timer, { at: now + delay, callback: () => callback(...args) });
    return timer;
  };
  globalThis.clearTimeout = (timer) => timers.delete(timer);
  return {
    timers,
    async advance(ms) {
      const target = now + ms;
      for (let count = 0; count < 100; count++) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) {
          now = target;
          await nextTurn();
          return;
        }
        const [timerId, timer] = next;
        now = timer.at;
        timers.delete(timerId);
        timer.callback();
        await nextTurn();
      }
      assert.fail("retry clock must settle within 100 timer callbacks");
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

async function retryFixture(signal, delayMs = 5000) {
  const handlers = new Map();
  provider.default({
    registerProvider() {},
    on(event, handler) { handlers.set(event, handler); },
  });
  const ctx = { ...context, signal };
  await handlers.get("after_provider_response")({ status: 402, headers: { "retry-after": String(delayMs / 1000) } }, ctx);
  await handlers.get("message_end")({ message: inFlightError }, ctx);
  const payload = { model: "fortissimo", max_tokens: 100, messages: [] };
  return { handlers, ctx, payload, run: () => handlers.get("before_provider_request")({ payload }, ctx) };
}

test("A1 abort during retry settles within 200 ms", async () => {
  const controller = new AbortController();
  const fixture = await retryFixture(controller.signal);
  const clock = retryClock();
  const wait = fixture.run();
  let settled = false;
  void wait.then(() => { settled = true; });
  try {
    await clock.advance(25);
    assert.equal(settled, false, "A1 must enter the retry wait before abort");
    controller.abort();
    await clock.advance(200);
    assert.equal(settled, true, "A1 handler must settle within 200 ms of abort");
  } finally {
    await clock.advance(5000);
    await wait;
    clock.restore();
  }
});

test("A2 pre-aborted signal skips retry timer", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = await retryFixture(controller.signal);
  const clock = retryClock();
  const wait = fixture.run();
  let settled = false;
  void wait.then(() => { settled = true; });
  try {
    await clock.advance(0);
    assert.equal(settled, true, "A2 pre-aborted handler must settle without advancing time");
    assert.equal(clock.timers.size, 0, "A2 pre-aborted handler must leave no retry timer");
  } finally {
    await clock.advance(5000);
    await wait;
    clock.restore();
  }
});

// Exercise the source runner, agent loop, provider adapter and installed OpenAI SDK.
// Only the HTTP transport is replaced; its positive control must actually be called.
for (const abort of [true, false]) {
  test(abort ? "A3 aborted run ends promptly with zero provider requests" : "A3 control reaches provider through the same runner", async () => {
    const controller = new AbortController();
    const fixture = await retryFixture(controller.signal, abort ? 5000 : 50);
    const runner = new ExtensionRunner(
      [{ path: resolve(here, "../extensions/vinci-provider.ts"), handlers: new Map([...fixture.handlers].map(([name, handler]) => [name, [handler]])) }],
      { pendingProviderRegistrations: [] }, process.cwd(), fixture.ctx.sessionManager, {},
    );
    runner.bindCore({}, { getModel: () => context.model, getSignal: () => controller.signal });
    const errors = [];
    runner.onError((error) => errors.push(error));
    const model = { ...provider.vinciClassModel("fortissimo", "Vinci Fortissimo"), id: "fortissimo", provider: "vinci", api: "openai-completions", baseUrl: "https://offline.invalid/v1" };
    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    globalThis.fetch = async () => {
      providerRequests++;
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    };
    const clock = retryClock();
    const events = [];
    let messages;
    const run = runAgentLoop(
      [{ role: "user", content: "offline cancellation check", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [] },
      { model, convertToLlm: (messages) => messages, apiKey: "offline-test", onPayload: (payload) => runner.emitBeforeProviderRequest(payload) },
      (event) => { events.push(event); }, controller.signal, completions.stream,
    ).then((result) => { messages = result; });
    try {
      await nextTurn();
      assert.ok([...clock.timers.values()].some((timer) => timer.at === (abort ? 5000 : 50)), "A3 must reach the real retry timer");
      await clock.advance(25);
      assert.equal(providerRequests, 0, "A3 must enter the retry wait before transport");
      if (abort) controller.abort();
      await clock.advance(abort ? 200 : 25);
      assert.deepEqual(
        { stopReason: messages?.at(-1)?.stopReason ?? "pending", providerRequests },
        { stopReason: abort ? "aborted" : "stop", providerRequests: abort ? 0 : 1 },
        abort ? "A3 run must end aborted within 200 ms with zero provider requests" : "A3 control must complete one provider request",
      );
      assert.equal(events.filter((event) => event.type === "agent_end").length, 1, "A3 run must emit agent_end once");
      assert.deepEqual(errors, [], "A3 cancellation must not log an extension failure");
      assert.equal(retry.isRetryableAssistantError(messages.at(-1)), false, "A3 cancellation must not trigger auto-retry");
    } finally {
      await clock.advance(5000);
      await run;
      clock.restore();
      globalThis.fetch = originalFetch;
    }
  });
}

for (const withSignal of [true, false]) {
  test(withSignal ? "A4 live signal waits the full delay and returns payload" : "A5 undefined signal waits the full delay and returns payload", async () => {
    const fixture = await retryFixture(withSignal ? new AbortController().signal : undefined, 50);
    const clock = retryClock();
    let payload;
    const wait = fixture.run().then((result) => { payload = result; });
    try {
      await clock.advance(49);
      assert.equal(payload, undefined, "retry handler must not return before 50 ms");
      await clock.advance(1);
      assert.deepEqual(payload, { ...fixture.payload, model: "forte" }, "retry handler must return the canonical payload after 50 ms");
    } finally {
      await clock.advance(50);
      await wait;
      clock.restore();
    }
  });
}

for (const abort of [true, false]) {
  test(`A6 ${abort ? "aborted" : "completed"} wait releases timer and abort listener`, async () => {
    const controller = new AbortController();
    const fixture = await retryFixture(controller.signal, 50);
    const baseline = getEventListeners(controller.signal, "abort").length;
    const clock = retryClock();
    const wait = fixture.run();
    try {
      await clock.advance(25);
      if (abort) controller.abort();
      await clock.advance(abort ? 0 : 25);
      assert.equal(clock.timers.size, 0, "A6 settled wait must leave zero pending timers");
      assert.equal(getEventListeners(controller.signal, "abort").length, baseline, "A6 settled wait must restore abort listener count to baseline");
      await wait;
      // The cancelled delay must not survive into the next turn, even with a fresh signal.
      const nextWait = fixture.handlers.get("before_provider_request")({ payload: fixture.payload }, { ...fixture.ctx, signal: new AbortController().signal });
      assert.equal(clock.timers.size, 0, "A6 consumed retry delay must not be replayed on the next turn");
      await nextWait;
    } finally {
      await clock.advance(50);
      await wait;
      clock.restore();
    }
  });
}

function managedRetryFixture() {
  const handlers = new Map();
  provider.default({
    registerProvider() {},
    on(event, handler) { handlers.set(event, handler); },
  });
  const ctx = { ...context, model: { ...context.model } };
  const payload = { model: "fortissimo", max_tokens: 32768, messages: [] };
  return {
    ctx,
    payload,
    after: (status, headers = {}) => handlers.get("after_provider_response")({ status, headers }, ctx),
    end: (errorMessage, message = {}) => handlers.get("message_end")({ message: { ...inFlightError, errorMessage, ...message } }, ctx),
    before: (requestContext = ctx) => handlers.get("before_provider_request")({ payload }, requestContext),
  };
}

async function managedSdkResponse({ status = 402, body = "Payment Required", headers = {}, providerId = "vinci", callbackFailure, signal, transportFailure } = {}) {
  const handlers = new Map();
  provider.default({ registerProvider() {}, on(event, handler) { handlers.set(event, handler); } });
  const model = { ...provider.vinciClassModel("forte", "Vinci Forte"), provider: providerId, api: "openai-completions", baseUrl: "https://offline.invalid/v1" };
  const ctx = { ...context, model: { provider: providerId, id: model.id }, signal };
  const observed = [];
  const requests = [];
  const originalFetch = globalThis.fetch;
  let deadline;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input?.url ?? input), "https://offline.invalid/v1/chat/completions", "the SDK must use only the replaced offline transport");
      requests.push(JSON.parse(init.body));
      if (transportFailure) throw new Error("402: can only afford 19 tokens");
      return status === 200
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream", ...headers } })
        : new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    };
    const events = [];
    const stream = completions.stream(model, {
      messages: [{ role: "user", content: "offline SDK response check", timestamp: 0 }], tools: [],
    }, {
      apiKey: "offline-only", maxRetries: 0, maxTokens: 32768, signal,
      onPayload: (payload) => handlers.get("before_provider_request")({ payload }, ctx),
      onResponse: (response) => {
        observed.push(response);
        if (callbackFailure === "sync") throw new Error("response observer failed");
        if (callbackFailure === "async") return Promise.reject(new Error("response observer failed"));
        return handlers.get("after_provider_response")({ status: response.status, headers: response.headers }, ctx);
      },
    });
    const result = await Promise.race([
      (async () => { for await (const event of stream) events.push(event); return stream.result(); })(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("The real SDK error stream did not settle; inspect its response callback.")), 2000); }),
    ]);
    const replacement = await handlers.get("message_end")({ message: result }, ctx);
    return {
      result, replacement, observed, requests, events, model, ctx,
      before: () => handlers.get("before_provider_request")({ payload: { model: model.id, max_tokens: 32768, messages: [] } }, ctx),
    };
  } finally {
    clearTimeout(deadline);
    globalThis.fetch = originalFetch;
  }
}

test("real SDK header-only HTTP 402 reaches the managed response hook and same-model recovery", async () => {
  const response = await managedSdkResponse({ headers: { "ReTrY-AfTeR": "0" } });
  assert.equal(response.requests.length, 1);
  assert.deepEqual(response.observed.map(({ status }) => status), [402]);
  assert.equal(response.observed[0].headers["retry-after"], "0");
  assert.equal(response.result.stopReason, "error");
  assert.equal(retry.isRetryableAssistantError(response.replacement?.message ?? response.result), true);
  assert.equal(response.replacement.message.model, response.model.id);
  assert.deepEqual(await response.before(), { model: response.model.id, max_tokens: 32768, messages: [] });
});

test("real SDK affordability HTTP 402 clamps the next request without a model downgrade", async () => {
  const response = await managedSdkResponse({ body: { error: { message: "can only afford 19 tokens", type: "affordability" } } });
  assert.deepEqual(response.observed.map(({ status }) => status), [402]);
  assert.equal(retry.isRetryableAssistantError(response.replacement?.message ?? response.result), true);
  assert.equal(response.replacement.message.model, response.model.id);
  assert.deepEqual(await response.before(), { model: response.model.id, max_tokens: 19, messages: [] });
});

test("real SDK terminal billing codes override misleading affordability and in-flight wording", async (t) => {
  for (const [code, message, remedy] of [
    ["payment_failed", "can only afford 19 tokens", /^BLOCKED: payment/],
    ["free_daily_cap", "in_flight_budget_exhausted", /^BLOCKED: daily limit/],
    ["balance_exhausted", "can only afford 19 tokens", /^BLOCKED: budget/],
    ["request_too_large", "can only afford 19 tokens", /per-request cost ceiling/],
  ]) {
    await t.test(code, async () => {
      const response = await managedSdkResponse({ body: { error: { code, message } }, headers: { "Retry-After": "0" } });
      assert.match(response.replacement?.message.errorMessage ?? "", remedy);
      assert.equal(retry.isRetryableAssistantError(response.replacement.message), false);
      assert.deepEqual(await response.before(), { model: response.model.id, max_tokens: 32768, messages: [] });
    });
  }
});

test("real SDK ambiguous HTTP 402 without a retry hint stays terminal", async () => {
  const response = await managedSdkResponse();
  assert.deepEqual(response.observed.map(({ status }) => status), [402]);
  assert.equal(retry.isRetryableAssistantError(response.replacement?.message ?? response.result), false);
  assert.deepEqual(await response.before(), { model: response.model.id, max_tokens: 32768, messages: [] });
});

test("real SDK error prose cannot masquerade as a structured terminal billing code", async () => {
  const response = await managedSdkResponse({ body: { error: { message: 'can only afford 19 tokens; quoted example {"code":"payment_failed"}' } } });
  assert.equal(retry.isRetryableAssistantError(response.replacement?.message ?? response.result), true);
  assert.deepEqual(await response.before(), { model: response.model.id, max_tokens: 19, messages: [] });
});

test("real SDK non-402 statuses retain their existing retry policy without affordability recovery", async (t) => {
  for (const status of [400, 401, 403, 429, 500]) {
    await t.test(String(status), async () => {
      const response = await managedSdkResponse({ status, body: { error: { message: "can only afford 19 tokens" } }, headers: { "Retry-After": "0" } });
      assert.deepEqual(response.observed.map(({ status }) => status), [status]);
      assert.equal(response.replacement, undefined);
      assert.equal(retry.isRetryableAssistantError(response.result), status === 429 || status === 500);
      assert.deepEqual(await response.before(), { model: response.model.id, max_tokens: 32768, messages: [] });
    });
  }
});

test("real SDK success, transport prose and aborted requests cannot invent HTTP 402 recovery", async () => {
  const success = await managedSdkResponse({ status: 200, body: "402: can only afford 19 tokens" });
  assert.equal(success.requests.length, 1);
  assert.deepEqual(success.observed.map(({ status }) => status), [200]);
  assert.equal(success.result.stopReason, "stop");
  assert.equal(success.replacement, undefined);
  assert.deepEqual(await success.before(), { model: success.model.id, max_tokens: 32768, messages: [] });
  const transport = await managedSdkResponse({ transportFailure: true });
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.observed, []);
  assert.equal(transport.replacement, undefined);
  assert.equal(transport.result.stopReason, "error");
  const controller = new AbortController();
  controller.abort();
  const aborted = await managedSdkResponse({ signal: controller.signal });
  assert.equal(aborted.requests.length, 0);
  assert.deepEqual(aborted.observed, []);
  assert.equal(aborted.result.stopReason, "aborted");
  assert.equal(aborted.replacement, undefined);
  assert.equal(retry.isRetryableAssistantError(aborted.result), false);
});

test("real SDK error response callbacks remain scoped to the managed Vinci provider", async () => {
  const response = await managedSdkResponse({ providerId: "openai", body: { error: { message: "can only afford 19 tokens" } }, headers: { "Retry-After": "0" } });
  assert.equal(response.requests.length, 1);
  assert.deepEqual(response.observed, []);
  assert.equal(response.result.stopReason, "error");
  assert.equal(response.replacement, undefined);
});

test("real SDK error streams settle with their original HTTP error when the new observer throws", async (t) => {
  for (const callbackFailure of ["sync", "async"]) {
    await t.test(callbackFailure, async () => {
      const response = await managedSdkResponse({ callbackFailure, body: { error: { message: "can only afford 19 tokens" } } });
      assert.deepEqual(response.observed.map(({ status }) => status), [402]);
      assert.equal(response.result.stopReason, "error");
      assert.match(response.result.errorMessage, /402/);
      assert.match(response.result.errorMessage, /can only afford 19 tokens/);
      assert.doesNotMatch(response.result.errorMessage, /response observer failed/);
      assert.equal(response.events.at(-1).type, "error");
      assert.equal(response.events.filter(({ type }) => type === "error").length, 1);
    });
  }
});

test("header-only 402 recovery reaches the core retry policy and honors bounded Retry-After", async (t) => {
  for (const [header, delay] of [["0.05", 50], ["900000", 300000], ["invalid", 5000], ["0", 0]]) {
    await t.test(`Retry-After ${header}`, async () => {
      const fixture = managedRetryFixture();
      await fixture.after(402, { "ReTrY-AfTeR": header });
      const result = await fixture.end("HTTP 402: Payment Required");
      assert.ok(result, "a real 402 response with only a retry header must schedule recovery");
      assert.equal(retry.isRetryableAssistantError(result.message), true, "the real core policy must consume the recovery message");
      assert.equal(result.message.model, fixture.ctx.model.id, "retry must retain the selected model");
      assert.match(result.message.errorMessage, /same model/);
      const clock = retryClock();
      let settled = false;
      const wait = fixture.before().then((payload) => { settled = true; return payload; });
      try {
        assert.equal(clock.timers.size, 1, "the real request handler must enter its retry timer");
        if (delay > 0) {
          await clock.advance(delay - 1);
          assert.equal(settled, false, "the retry must wait the full bounded delay");
          await clock.advance(1);
        } else {
          await clock.advance(0);
        }
        assert.deepEqual(await wait, { ...fixture.payload, model: "forte" }, "recovery keeps the same class and original token budget");
        assert.deepEqual(fixture.ctx.model, context.model, "the selected provider/model is unchanged");
        const next = fixture.before();
        assert.equal(clock.timers.size, 0, "the consumed delay must not survive into a later request");
        await next;
      } finally {
        await clock.advance(delay);
        await wait;
        clock.restore();
      }
    });
  }
});

test("header-only 402 recovery stops after three retries and preserves the session ceiling", async () => {
  const fixture = managedRetryFixture();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await fixture.after(402, { "Retry-After": "0" });
    const result = await fixture.end("HTTP 402: Payment Required");
    assert.equal(retry.isRetryableAssistantError(result.message), attempt <= 3, `bounded retry ${attempt}`);
    if (attempt === 4) assert.match(result.message.errorMessage, /did not clear after 3 retries/);
  }
  await fixture.after(200);
  for (let attempt = 4; attempt <= 10; attempt++) {
    await fixture.after(402, { "Retry-After": "0" });
    const result = await fixture.end("HTTP 402: Payment Required");
    assert.equal(retry.isRetryableAssistantError(result.message), true, `session retry ${attempt}`);
    await fixture.after(200);
  }
  await fixture.after(402, { "Retry-After": "0" });
  const exhausted = await fixture.end("HTTP 402: Payment Required");
  assert.equal(retry.isRetryableAssistantError(exhausted.message), false);
  assert.match(exhausted.message.errorMessage, /after 10 HTTP 402 retries in this session/);
  assert.equal(exhausted.message.model, fixture.ctx.model.id);
});

test("affordability recovery requires the current HTTP response to be 402", async (t) => {
  for (const status of [400, 401, 429, 500, 503, undefined]) {
    await t.test(`status ${status ?? "unobserved"}`, async () => {
      const fixture = managedRetryFixture();
      if (status !== undefined) await fixture.after(status, { "Retry-After": "0" });
      const original = { ...affordabilityError, errorMessage: `${status ?? 402}: ${AFFORDABILITY_BODY}` };
      const result = await fixture.end(original.errorMessage);
      assert.equal(result, undefined, "non-402 or unobserved status must retain its original error policy");
      assert.equal(retry.isRetryableAssistantError(original), status === 429 || status === 500 || status === 503);
      assert.deepEqual(await fixture.before(), { ...fixture.payload, model: "forte" }, "a non-402 must not clamp max_tokens");
    });
  }
  const eligible = managedRetryFixture();
  await eligible.after(402, { "Retry-After": "0" });
  const result = await eligible.end("402: can only afford 19 tokens");
  assert.equal(retry.isRetryableAssistantError(result.message), true);
  assert.deepEqual(await eligible.before(), { ...eligible.payload, model: "forte", max_tokens: 19 });
  await eligible.after(402);
  assert.equal(retry.isRetryableAssistantError((await eligible.end("402: can only afford 19 tokens")).message), false,
    "affordability retry remains limited to one before a successful response");
});

test("a previous 402 status or header cannot classify a later response or transport error", async () => {
  for (const reset of ["request", "response", "message"]) {
    const fixture = managedRetryFixture();
    await fixture.after(402, { "Retry-After": "0" });
    if (reset === "request") await fixture.before();
    else if (reset === "response") await fixture.after(503);
    else await fixture.end(undefined, { stopReason: "stop" });
    assert.equal(await fixture.end("503: can only afford 19 tokens"), undefined, `${reset} must invalidate stale 402 state`);
    assert.deepEqual(await fixture.before(), { ...fixture.payload, model: "forte" });
  }
  const consumed = managedRetryFixture();
  await consumed.after(402);
  await consumed.end("402: can only afford 19 tokens");
  assert.equal(await consumed.end("503: can only afford 7 tokens"), undefined, "each response status is consumed only once");
  assert.deepEqual(await consumed.before(), { ...consumed.payload, model: "forte" }, "an unrelated terminal must clear an unconsumed clamp");
});

test("explicit exhausted-credit and billing refusals remain terminal even with retry hints", async () => {
  for (const body of [
    OUT_OF_CREDIT_BODY,
    "402: out of credits",
    JSON.stringify({ code: "payment_failed", message: "can only afford 19 tokens" }),
    JSON.stringify({ error: { code: "free_daily_cap", message: "in_flight_budget_exhausted" } }),
    JSON.stringify({ error: { code: "request_too_large", message: "can only afford 19 tokens" } }),
  ]) {
    const fixture = managedRetryFixture();
    await fixture.after(402, { "Retry-After": "0" });
    const result = await fixture.end(body);
    assert.ok(result, "a definite billing refusal must retain actionable terminal messaging");
    assert.equal(retry.isRetryableAssistantError(result.message), false, body);
    assert.equal(result.message.model, fixture.ctx.model.id);
    assert.deepEqual(await fixture.before(), { ...fixture.payload, model: "forte" }, "terminal billing errors must not schedule a token clamp");
  }
});

test("header-only 402 waiting remains cancelable and does not cross a provider switch", async () => {
  const controller = new AbortController();
  const fixture = managedRetryFixture();
  fixture.ctx.signal = controller.signal;
  await fixture.after(402, { "Retry-After": "120" });
  await fixture.end("HTTP 402: Payment Required");
  const clock = retryClock();
  let settled = false;
  const wait = fixture.before().then((result) => { settled = true; return result; });
  try {
    await clock.advance(25);
    assert.equal(settled, false);
    controller.abort();
    await clock.advance(0);
    assert.equal(await wait, undefined);
    assert.equal(settled, true);
    assert.equal(clock.timers.size, 0);
  } finally {
    await clock.advance(120000);
    await wait;
    clock.restore();
  }
  await fixture.after(402, { "Retry-After": "120" });
  await fixture.end("HTTP 402: Payment Required");
  assert.equal(await fixture.before({ ...fixture.ctx, model: { provider: "other", id: "other-model" } }), undefined);
  const switchedClock = retryClock();
  try {
    const next = fixture.before({ ...fixture.ctx, signal: new AbortController().signal });
    assert.equal(switchedClock.timers.size, 0, "a delay from another provider selection must not be replayed");
    assert.deepEqual(await next, { ...fixture.payload, model: "forte" });
  } finally {
    switchedClock.restore();
  }
});
