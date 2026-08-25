import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `Missing value for ${name}`);
  return value;
}

function findRunDirectories(directory) {
  const found = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some(({ isFile, name }) => isFile() && name === "summary.json") &&
      entries.some(({ isFile, name }) => isFile() && name === "hidden-verification.json")) {
    found.push(directory);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...findRunDirectories(join(directory, entry.name)));
  }
  return found;
}

export function aggregateHoldoutRuns(runs, expectedRepetitions) {
  assert.ok(Number.isInteger(expectedRepetitions) && expectedRepetitions >= 1, "Expected repetitions must be positive");
  assert.equal(runs.length, expectedRepetitions, `Expected ${expectedRepetitions} holdout runs`);
  const campaignIds = new Set(runs.map(({ summary }) => summary.campaignId));
  const providers = new Set(runs.map(({ summary }) => summary.provider));
  assert.equal(campaignIds.size, 1, "Holdout runs must belong to one campaign");
  assert.equal(providers.size, 1, "Holdout runs must use one provider");

  const repetitions = new Set();
  let expectedIds;
  const rows = [];
  for (const { summary, verification } of runs) {
    assert.ok(Number.isInteger(summary.repetition), "Every holdout summary must record a repetition");
    assert.ok(!repetitions.has(summary.repetition), `Duplicate holdout repetition: ${summary.repetition}`);
    repetitions.add(summary.repetition);
    const metrics = new Map((summary.results ?? []).map((result) => [result.id, result]));
    const checks = new Map((verification.results ?? []).map((result) => [result.id, result]));
    const ids = [...metrics.keys()].sort();
    assert.deepEqual([...checks.keys()].sort(), ids, `Repetition ${summary.repetition} scenario mismatch`);
    expectedIds ??= ids;
    assert.deepEqual(ids, expectedIds, `Repetition ${summary.repetition} changed the holdout corpus`);
    for (const id of ids) {
      const metric = metrics.get(id);
      const check = checks.get(id);
      rows.push({
        repetition: summary.repetition,
        id,
        strictPassed: metric.status === "passed" && check.passed === true,
        behaviorPassed: check.passed === true,
        scopePassed: (check.unexpectedChangedFiles ?? []).length === 0,
        status: metric.status,
        outcome: metric.outcome,
        hasFinalReceipt: metric.hasFinalReceipt,
        toolCalls: metric.toolCalls,
        elapsedSeconds: metric.elapsedSeconds,
        inputTokens: metric.inputTokens,
        outputTokens: metric.outputTokens,
        cachedTokens: metric.cachedTokens,
        estimatedCostUsd: metric.estimatedCostUsd,
        failures: [...(metric.failures ?? []), ...(check.failures ?? [])],
      });
    }
  }
  for (let repetition = 1; repetition <= expectedRepetitions; repetition++) {
    assert.ok(repetitions.has(repetition), `Missing holdout repetition: ${repetition}`);
  }

  const scenarioIds = expectedIds ?? [];
  const scenarios = scenarioIds.map((id) => {
    const attempts = rows.filter((row) => row.id === id).toSorted((left, right) => left.repetition - right.repetition);
    return {
      id,
      behaviorPasses: attempts.filter(({ behaviorPassed }) => behaviorPassed).length,
      strictPasses: attempts.filter(({ strictPassed }) => strictPassed).length,
      passedFirstAttempt: attempts[0]?.behaviorPassed ?? false,
      passedAtLeastOnce: attempts.some(({ behaviorPassed }) => behaviorPassed),
      passedEveryAttempt: attempts.every(({ behaviorPassed }) => behaviorPassed),
      attempts,
    };
  });
  const number = (field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  const minimumReliablePasses = Math.ceil(expectedRepetitions * 2 / 3);
  const gateFailures = [
    ...scenarios
      .filter(({ behaviorPasses }) => behaviorPasses < minimumReliablePasses)
      .map(({ id, behaviorPasses }) => `${id} passed ${behaviorPasses}/${expectedRepetitions} hidden verifications`),
    ...rows
      .filter(({ scopePassed }) => !scopePassed)
      .map(({ id, repetition }) => `${id} repetition ${repetition} changed files outside scope`),
  ];
  const firstAttempts = rows.filter(({ repetition }) => repetition === 1);
  return {
    version: 1,
    campaignId: [...campaignIds][0],
    provider: [...providers][0],
    expectedRepetitions,
    scenarioIds,
    launchGate: { passed: gateFailures.length === 0, failures: gateFailures },
    firstAttemptPassRate: firstAttempts.length
      ? Number((firstAttempts.filter(({ behaviorPassed }) => behaviorPassed).length / firstAttempts.length).toFixed(4))
      : null,
    behaviorPassRate: rows.length
      ? Number((rows.filter(({ behaviorPassed }) => behaviorPassed).length / rows.length).toFixed(4))
      : null,
    strictPassRate: rows.length
      ? Number((rows.filter(({ strictPassed }) => strictPassed).length / rows.length).toFixed(4))
      : null,
    passedEveryAttempt: scenarios.filter(({ passedEveryAttempt }) => passedEveryAttempt).length,
    passedAtLeastOnce: scenarios.filter(({ passedAtLeastOnce }) => passedAtLeastOnce).length,
    scopeViolations: rows.filter(({ scopePassed }) => !scopePassed).length,
    elapsedSeconds: Number(number("elapsedSeconds").toFixed(3)),
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    cachedTokens: number("cachedTokens"),
    estimatedCostUsd: Number(number("estimatedCostUsd").toFixed(6)),
    scenarios,
  };
}

function main() {
  const input = resolve(option("--input", "vinci-test-artifacts/holdout-campaign"));
  const output = resolve(option("--output", join(input, "aggregate.json")));
  const repetitions = Number.parseInt(option("--repetitions", "3"), 10);
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20, "--repetitions must be 1-20");
  const runs = findRunDirectories(input).map((directory) => ({
    summary: JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")),
    verification: JSON.parse(readFileSync(join(directory, "hidden-verification.json"), "utf8")),
  }));
  const aggregate = aggregateHoldoutRuns(runs, repetitions);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  process.stdout.write(`holdout ${aggregate.campaignId}: ${aggregate.launchGate.passed ? "passed" : "failed"}, behavior ${(aggregate.behaviorPassRate * 100).toFixed(1)}%\n`);
  if (!aggregate.launchGate.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
