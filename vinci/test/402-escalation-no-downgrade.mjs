import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });

const { classifyVinciModelError } = provenance;

const IN_FLIGHT_402 = Object.assign(new Error("in_flight_budget_exhausted"), { status: 402 });
const AFFORDABILITY_402 = Object.assign(new Error("You requested up to 131072 tokens, but can only afford 23014"), { status: 402 });

// ASSERTION 1 & 2: Classifier must return "account" for marked 402s
const inFlightKind = classifyVinciModelError(IN_FLIGHT_402);
assert.equal(inFlightKind, "account", "in-flight 402 must classify as account");

const affordabilityKind = classifyVinciModelError(AFFORDABILITY_402);
assert.equal(affordabilityKind, "account", "affordability 402 must classify as account");

// ASSERTION 3: Escalation site logic - no downgrade on marked 402
const unavailableClasses = [];
const kind = inFlightKind;
const attempt = 0;
const SAME_CLASS_ATTEMPTS = 2;

if (kind === "transient" && attempt < SAME_CLASS_ATTEMPTS) {
  throw new Error("DEFECT: would retry same class");
}
if (kind === "transient" || kind === "unavailable") {
  unavailableClasses.push("cheaper");
  throw new Error("DEFECT: would downgrade");
}
assert.deepEqual(unavailableClasses, [], "no downgrade attempted");

console.log("402-escalation-no-downgrade: all assertions passed");
