import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });
const taskId = "billing-codes-test";

// The concrete billing destination (Phase 1): refusals say WHERE, not just what. Pinned as a
// literal so a drifted vinci-links.ts URL fails here instead of shipping.
const billingUrl = "https://platform.getsimpledirect.com/billing?source=code";

const cases = [
  [
    "balance_exhausted",
    `BLOCKED: budget — Vinci credits are exhausted. Review or restore credits at ${billingUrl}.`,
  ],
  [
    "payment_failed",
    `BLOCKED: payment — Update your payment method at ${billingUrl} to restore access.`,
  ],
  [
    "free_daily_cap",
    `BLOCKED: daily limit — Your daily free allowance is exhausted. Try again after midnight UTC, or add credits or a plan at ${billingUrl}.`,
  ],
  ["request_too_large", "This request exceeds the per-request cost ceiling. Try a smaller request."],
  ["capacity", "Vinci is at capacity right now. Your checkpoint is saved. Try again in a moment."],
];

for (const [code, expected] of cases) {
  const body = JSON.stringify({ error: { code, message: `Gateway refusal: ${code}` } });
  assert.equal(provider.vinciBudgetBlockedMessage(body, taskId), expected, code);
}

const legacy = provider.vinciBudgetBlockedMessage("Request failed: budget_exhausted", taskId);
assert.match(legacy, /^BLOCKED: budget — Vinci usage credits are unavailable for this request\./);
assert.match(legacy, /vinci resume billing-codes-test/);

assert.equal(provider.vinciBudgetBlockedMessage("429: Slow down", taskId), undefined);

// A billing refusal must not move the user off their class. This is the no-downgrade promise
// applied to the codes specifically: the CLI may stop, but it may never quietly continue on
// something cheaper because the account hit a limit. Ported from a duplicate no-downgrade file
// that was recreated against a stale base; the classifier and escalation-site checks live in
// vinci/test/no-downgrade-integration.mjs and are not repeated here.
let messageEnd;
const registrations = [];
provider.default({
  registerProvider(name, config) { registrations.push({ name, config }); },
  on(event, handler) { if (event === "message_end") messageEnd = handler; },
});

assert.deepEqual(
  registrations[0].config.models.map(({ id }) => id),
  ["auto", "forte", "fortissimo"],
);
assert.equal(typeof messageEnd, "function");

for (const [code] of cases) {
  const original = {
    role: "assistant",
    stopReason: "error",
    provider: "vinci",
    model: "fortissimo",
    errorMessage: JSON.stringify({ error: { code, message: code } }),
  };
  const contextModel = { provider: "vinci", id: "fortissimo" };
  const result = messageEnd(
    { message: original },
    { model: contextModel, sessionManager: { getSessionId: () => "billing-codes-test" } },
  );
  const effective = result?.message ?? original;
  assert.equal(effective.model, "fortissimo", `${code} changed the assistant model`);
  assert.deepEqual(contextModel, { provider: "vinci", id: "fortissimo" }, `${code} changed the active model`);
}

console.log("billing-codes-integration: model unchanged for all 5 codes");

console.log("billing-codes-integration: all checks passed");
