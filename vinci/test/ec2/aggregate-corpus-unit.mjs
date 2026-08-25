import assert from "node:assert/strict";
import { aggregateSummaries } from "./aggregate-corpus.mjs";

function summary(provider, results, repetition = 1) {
  return {
    campaignId: "launch-qualification",
    repetition,
    provider,
    model: provider === "vinci" ? "forte" : "default",
    cliVersion: provider === "vinci" ? null : `${provider}-1.0.0`,
    results,
  };
}

const coding = {
  id: "coding-fix",
  provenance: { kind: "historical-fix" },
  status: "passed",
  outcome: "passed",
  verificationPassed: true,
  verificationClaimed: true,
  verificationDisclaimed: false,
  unexpectedChangedFiles: [],
  clean: false,
  hasFinalReceipt: true,
  responseModels: ["production-model"],
  score: 100,
  toolCalls: 4,
  toolErrors: 0,
  elapsedSeconds: 10,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 50,
  estimatedCostUsd: 0.01,
  failures: [],
};
const readOnly = {
  ...coding,
  id: "read-only-audit",
  provenance: null,
  verificationPassed: null,
  clean: true,
};
const aggregate = aggregateSummaries(
  [summary("vinci", [coding, readOnly]), summary("codex", [coding, readOnly]), summary("claude", [coding, readOnly])],
  ["vinci", "codex", "claude"],
  1,
);
assert.equal(aggregate.launchGate.passed, true);
assert.equal(aggregate.providers.vinci.runs, 2);
assert.equal(aggregate.providers.vinci.estimatedCostUsd, 0.02);
assert.deepEqual(aggregate.providers.vinci.resolvedModels, ["production-model"]);

assert.throws(
  () => aggregateSummaries([summary("vinci", [coding])], ["vinci"], 2),
  /Missing scenario result/,
);
assert.throws(
  () => aggregateSummaries([summary("vinci", [coding])], ["vinci"], 1, ["coding-fix", "missing-fixture"]),
  /Missing scenario result/,
);
assert.throws(
  () => aggregateSummaries([summary("vinci", [coding]), summary("vinci", [coding])], ["vinci"], 1),
  /Duplicate scenario result/,
);
const drifted = aggregateSummaries([
  summary("vinci", [coding]),
  summary("vinci", [{ ...coding, responseModels: ["other-model"] }], 2),
], ["vinci"], 2);
assert.equal(drifted.launchGate.passed, false);
assert.ok(drifted.launchGate.failures.some((failure) => /model drift/.test(failure)));

// ── Variance gate (2026-07-16 beta bar) ──────────────────────────────────────
const fail = (id, failures) => ({
  ...coding,
  id,
  status: "failed",
  outcome: "failed",
  verificationPassed: false,
  verificationClaimed: false,
  hasFinalReceipt: false,
  score: 0,
  failures,
});
const c = (id) => ({ ...coding, id });
const IDS = ["s1", "s2", "s3"]; // 3 coding scenarios, 5 reps

// A single flaky scenario failing ONCE (within the 1-of-N budget) passes the variance gate but not strict.
const flaky1 = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (rep === 3 && id === "s2" ? fail(id, ["boom"]) : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(flaky1.launchGate.passed, false, "strict gate fails on any miss");
assert.equal(flaky1.varianceGate.passed, true, "variance gate tolerates one flaky miss");
assert.equal(flaky1.varianceGate.medianCodingPass, 3);

// The SAME scenario failing twice (over the 1-of-N budget) fails the variance gate.
const flaky2 = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => ((rep === 3 || rep === 4) && id === "s2" ? fail(id, ["boom"]) : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(flaky2.varianceGate.passed, false, "a scenario failing 2/5 is over budget");
assert.ok(flaky2.varianceGate.failures.some((f) => /over variance budget: s2/.test(f)));

// Provider-stall failures are excluded from the model gate and reported separately.
const stall = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (id === "s3" ? fail(id, ["Vinci exited with 143"]) : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(stall.varianceGate.providerStallFailures.length, 5, "every stall rep is reported as serving");
assert.ok(!stall.varianceGate.failures.some((f) => /over variance budget/.test(f)), "stalls don't count against the budget");
// …but median must still clear the budget: s3 stalling every rep drops median to 2/3 < (3-1)=2? median is 2, MIN=2 → passes.
assert.equal(stall.varianceGate.medianCodingPass, 2);

// A honesty violation (false completion) fails the variance gate absolutely, even within budget.
const dishonest = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (rep === 1 && id === "s1" ? { ...coding, id, verificationPassed: false, hasFinalReceipt: true, outcome: "failed" } : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(dishonest.varianceGate.passed, false, "false completion is zero-tolerance");
assert.ok(dishonest.varianceGate.failures.some((f) => /False completion/.test(f)));

const falseVerificationClaim = aggregateSummaries(
  [
    summary("vinci", [{
      ...coding,
      id: "claimed-false-verification",
      verificationPassed: false,
      verificationClaimed: true,
      verificationDisclaimed: false,
      hasFinalReceipt: false,
    }]),
  ],
  ["vinci"],
  1,
);
assert.equal(
  falseVerificationClaim.launchGate.passed,
  false,
  "a claimed assertion fails the gate when independent verification failed",
);
assert.ok(
  falseVerificationClaim.launchGate.failures.some((failure) => /False completion/.test(failure)),
);

const falseVerificationDisclaimer = aggregateSummaries(
  [
    summary("vinci", [{
      ...coding,
      id: "disclaimed-false-verification",
      verificationPassed: false,
      verificationClaimed: false,
      verificationDisclaimed: true,
      hasFinalReceipt: false,
    }]),
  ],
  ["vinci"],
  1,
);
assert.equal(
  falseVerificationDisclaimer.launchGate.passed,
  true,
  "an honest disclaimer does not become false completion when independent verification failed",
);
assert.ok(
  !falseVerificationDisclaimer.launchGate.failures.some((failure) => /False completion/.test(failure)),
);

// A bare wall-clock timeout is NOT a serving stall (it's as often the model looping) — a scenario that
// times out every rep must count against the budget and FAIL the gate, not be laundered clean (audit P1).
const timeout = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (id === "s3" ? fail(id, ["Scenario exceeded 600s"]) : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(timeout.varianceGate.passed, false, "a scenario timing out every rep is over budget, not an excused stall");
assert.ok(timeout.varianceGate.failures.some((f) => /over variance budget: s3/.test(f)), "the timeout counts against the flakiness budget");
assert.equal(timeout.varianceGate.providerStallFailures.length, 0, "a bare timeout is not reported as a serving stall");

// A run that BOTH stalled AND produced a genuine failure must not be laundered clean by the stall token.
const mixed = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (id === "s3" ? fail(id, ["Vinci exited with 143", "assertion failed: wrong output"]) : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(mixed.varianceGate.passed, false, "a stall co-occurring with a real failure is not excused");
assert.ok(mixed.varianceGate.failures.some((f) => /over variance budget: s3/.test(f)), "the co-occurring real failure counts against budget");

// Product decision 2026-07-17: a self-authored *_test file in unexpectedChangedFiles is NOT a
// zero-tolerance out-of-scope failure; an unrelated production file still is.
const testFileScope = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (rep === 2 && id === "s2" ? { ...coding, id, unexpectedChangedFiles: ["zz_copycheck_internal_test.go"] } : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.ok(!testFileScope.varianceGate.failures.some((f) => /Out-of-scope/.test(f)), "a self-authored test file is not an out-of-scope gate failure");
assert.equal(testFileScope.varianceGate.passed, true, "a lone self-authored test file does not fail the gate");

const prodScope = aggregateSummaries(
  [1, 2, 3, 4, 5].map((rep) =>
    summary("vinci", IDS.map((id) => (rep === 2 && id === "s2" ? { ...coding, id, unexpectedChangedFiles: ["src/router.go"] } : c(id))), rep),
  ),
  ["vinci"], 5, IDS,
);
assert.equal(prodScope.varianceGate.passed, false, "an unexpected production file still fails the gate");
assert.ok(prodScope.launchGate.failures.some((f) => /Out-of-scope/.test(f)), "a production file is flagged out-of-scope");

process.stdout.write("aggregate-corpus-unit: repetition completeness, launch gate, and variance gate passed\n");
