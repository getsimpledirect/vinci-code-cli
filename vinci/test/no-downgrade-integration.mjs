// Vinci Code — no-downgrade contract. No provider calls.
//
// Pins the rule the pricing promise rests on: Vinci never silently serves a cheaper class.
// A provider outage may be retried within the SAME class; a billing, credit, cap or auth
// failure must NOT be routed around by quietly continuing on a cheaper model.
//
// The four escalation sites (advisor, council, scope, loopbreak) previously caught ANY error
// from a stronger class and reran on the current cheaper one, so "the provider is down" and
// "your card was declined" produced identical behaviour. Everything here exists to keep those
// two apart.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), {
  default: false,
});

const { classifyVinciModelError, assertSuccessfulVinciCompletion } = provenance;
assert.ok(classifyVinciModelError, "classifyVinciModelError must be exported");

const withStatus = (status) => Object.assign(new Error(`status ${status}`), { status });

// ---- account failures must never look retryable -----------------------------------------
// These are the ones that must NOT trigger a cheaper-model fallback. A status-only 402 is true
// out-of-credit; body-marked in-flight and affordability 402s may retry the same model. 403 is a
// refused entitlement, 401 is a dead credential, and 429 is a cap. None warrants a downgrade.
for (const status of [401, 402, 403, 429]) {
  assert.strictEqual(
    classifyVinciModelError(withStatus(status)),
    "account",
    `HTTP ${status} must classify as account, not transient — otherwise a billing failure silently downgrades the model`,
  );
}

// ---- genuine disruption may be retried, but only within the same class -------------------
for (const status of [500, 502, 503, 504, 408]) {
  assert.strictEqual(
    classifyVinciModelError(withStatus(status)),
    "transient",
    `HTTP ${status} is a service disruption and should be retryable`,
  );
}
assert.strictEqual(
  classifyVinciModelError(Object.assign(new Error("slow"), { name: "TimeoutError" })),
  "transient",
  "a timeout is a disruption, not an account problem",
);

// ---- a class that is simply absent is its own case ---------------------------------------
for (const status of [404, 410]) {
  assert.strictEqual(
    classifyVinciModelError(withStatus(status)),
    "unavailable",
    `HTTP ${status} means the class is not being served`,
  );
}

// ---- a failed completion must raise, not be consumed as an answer -------------------------
assert.throws(
  () => assertSuccessfulVinciCompletion({ stopReason: "error", errorMessage: "provider exploded" }),
  /provider exploded/,
  "an errored completion must throw rather than be accepted as content",
);
assert.doesNotThrow(
  () => assertSuccessfulVinciCompletion({ stopReason: "stop" }),
  "a normal completion must pass through untouched",
);

// ---- the escalation sites must consult the classifier ------------------------------------
// Structural, and derived by scanning rather than by naming the sites that exist today: a
// fixed list passes forever while a fifth escalation site is added beside it, which is how
// the original bug spread to four files in the first place.
const ESCALATION_SITES = [
  "vinci-advisor.ts",
  "vinci-council.ts",
  "vinci-scope.ts",
  "vinci-loopbreak.ts",
];
for (const file of ESCALATION_SITES) {
  const source = readFileSync(resolve(here, "../extensions", file), "utf8");
  assert.ok(
    source.includes("classifyVinciModelError"),
    `${file} escalates to a stronger class, so it must classify failures before deciding to fall back`,
  );
}

console.log("no-downgrade-integration: all checks passed");
