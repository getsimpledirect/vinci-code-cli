import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });
const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });

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
  assert.equal(classify(with402(IN_FLIGHT_BODY)), "transient", "in-flight 402 must be retryable");
  assert.equal(classify(with402(AFFORDABILITY_BODY)), "transient", "affordability 402 must be retryable");
  assert.equal(classify(with402(OUT_OF_CREDIT_BODY)), "account", "true out-of-credit 402 must stay terminal");
}

export const parseAffordableTokenCount = provider.vinciAffordableTokenLimit;

// Mutation procedure: copy the fixed classifier to the prompt-requested backup path, replace the
// classifier with the old unconditional status === 402 account branch, run this file and confirm
// assert402Classifications fails, then restore the fixed file from that external backup and rerun.
assert402Classifications(provenance.classifyVinciModelError);

assert.equal(parseAffordableTokenCount(AFFORDABILITY_BODY), 23014);
assert.equal(parseAffordableTokenCount("can afford 19 tokens"), 19);
assert.equal(parseAffordableTokenCount("credits exhausted"), undefined);

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
assert.equal(inFlightRetry?.message.model, "fortissimo", "in-flight retry must not downgrade the model");
await afterProviderResponse({ status: 200, headers: {} }, context);

await afterProviderResponse({ status: 402, headers: {} }, context);
const retryResult = await messageEnd({ message: affordabilityError }, context);
assert.match(retryResult?.message.errorMessage ?? "", /please retry/i, "affordability must signal a retry");

const retriedPayload = await beforeProviderRequest(
  { payload: { model: "fortissimo", max_tokens: 131072, messages: [] } },
  context,
);
assert.deepEqual(
  retriedPayload,
  { model: "fortissimo", max_tokens: 23014, messages: [] },
  "the one affordability retry must clamp max_tokens without changing models",
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

console.log("402-classification-integration: 20/20 checks passed");
