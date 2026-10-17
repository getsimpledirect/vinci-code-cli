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
