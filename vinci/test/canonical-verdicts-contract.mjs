// Public regression checks for the local vocabulary. Private package equality is enforced by
// private-contracts-drift.mjs and its separate tsgo pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const libRoot = resolve(here, "../extensions/lib");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const local = await loader.import(resolve(libRoot, "canonical-verdicts.ts"), { default: false });
const verdicts = ["VERIFIED_PASS", "CONDITIONAL", "BLOCKED"];
const attempts = ["FAILED", "CANCELLED"];

assert.deepEqual([...local.VERDICT_STATUSES], verdicts, "Local verdict vocabulary must preserve its values and order");
assert.deepEqual([...local.ATTEMPT_STATUSES], attempts, "Local attempt vocabulary must preserve its values and order");
assert.deepEqual([...local.ACCEPTED_WIRE_STATUSES], [...verdicts, ...attempts]);
assert.ok(Object.isFrozen(local.VERDICT_STATUSES) && Object.isFrozen(local.ATTEMPT_STATUSES) && Object.isFrozen(local.ACCEPTED_WIRE_STATUSES));
console.log("ok (1) local VERDICT/ATTEMPT/ACCEPTED_WIRE vocabularies preserve their values, order, and freezing");

const probes = [
  ...verdicts, ...attempts, "CREATED", "PLANNING", "RUNNING", "WAITING_FOR_APPROVAL",
  "WAITING_FOR_USER", "PAUSED", "VERIFYING", "DONE", "DONE_UNVERIFIED",
  "verified_pass", "DONE ", "", 42, null, undefined, {},
];
for (const probe of probes) {
  assert.equal(local.isVerdictStatus(probe), verdicts.includes(probe), `isVerdictStatus(${JSON.stringify(probe)})`);
  assert.equal(local.isAttemptStatus(probe), attempts.includes(probe), `isAttemptStatus(${JSON.stringify(probe)})`);
  assert.equal(local.isAcceptedWireStatus(probe), verdicts.includes(probe) || attempts.includes(probe), `isAcceptedWireStatus(${JSON.stringify(probe)})`);
}
console.log(`ok (2) local membership wrappers classify ${probes.length} probes`);

// Shipped source must not need private packages even for typechecking.
for (const file of ["canonical-verdicts.ts", "verification-contract.ts", "verification-state.ts", "../vinci-model-provenance.ts"]) {
  const source = readFileSync(resolve(libRoot, file), "utf8");
  assert.doesNotMatch(source, /@getsimpledirect\//, `${file} must be independent of private packages`);
}
console.log("ok (3) shipped verification and provenance sources have no private package references");

console.log("✓ canonical-verdicts-contract.mjs: all tests passed");
