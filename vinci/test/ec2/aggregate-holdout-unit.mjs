import assert from "node:assert/strict";
import { aggregateHoldoutRuns } from "./aggregate-holdout.mjs";

function run(repetition, passes = [true, true]) {
  const ids = ["scenario-a", "scenario-b"];
  return {
    summary: {
      campaignId: "launch-holdout-v1",
      repetition,
      provider: "vinci",
      results: ids.map((id, index) => ({
        id,
        status: passes[index] ? "passed" : "failed",
        outcome: passes[index] ? "passed" : "failed",
        hasFinalReceipt: passes[index],
        toolCalls: 5,
        elapsedSeconds: 10,
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 50,
        estimatedCostUsd: 0.01,
        failures: [],
      })),
    },
    verification: {
      results: ids.map((id, index) => ({
        id,
        passed: passes[index],
        unexpectedChangedFiles: [],
        failures: [],
      })),
    },
  };
}

const aggregate = aggregateHoldoutRuns([run(1), run(2, [true, false]), run(3)], 3);
assert.equal(aggregate.launchGate.passed, true);
assert.equal(aggregate.firstAttemptPassRate, 1);
assert.equal(aggregate.behaviorPassRate, 0.8333);
assert.equal(aggregate.strictPassRate, 0.8333);
assert.equal(aggregate.passedEveryAttempt, 1);
assert.equal(aggregate.passedAtLeastOnce, 2);
assert.equal(aggregate.estimatedCostUsd, 0.06);
assert.equal(aggregate.scenarios.find(({ id }) => id === "scenario-b")?.behaviorPasses, 2);

const unreliable = aggregateHoldoutRuns([run(1, [true, false]), run(2, [true, false]), run(3)], 3);
assert.equal(unreliable.launchGate.passed, false);
assert.match(unreliable.launchGate.failures[0], /scenario-b passed 1\/3/);

const scoped = run(1);
scoped.verification.results[0].unexpectedChangedFiles = ["README.md"];
assert.equal(aggregateHoldoutRuns([scoped], 1).launchGate.passed, false);
assert.throws(() => aggregateHoldoutRuns([run(1), run(1), run(3)], 3), /Duplicate holdout repetition/);
assert.throws(() => aggregateHoldoutRuns([run(1), run(3)], 3), /Expected 3 holdout runs/);

process.stdout.write("aggregate-holdout-unit: reliability, cost, and scope gates passed\n");
