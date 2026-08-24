import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SELF_AUTHORED_TEST_FILE } from "./run-repo-corpus.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `Missing value for ${name}`);
  return value;
}

function findSummaries(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findSummaries(path));
    else if (entry.isFile() && entry.name === "summary.json") found.push(path);
  }
  return found;
}

export function aggregateSummaries(summaries, expectedProviders, expectedRepetitions, expectedScenarioIds) {
  assert.ok(summaries.length > 0, "No corpus summaries were provided");
  const campaignIds = new Set(summaries.map(({ campaignId }) => campaignId));
  assert.equal(campaignIds.size, 1, "Corpus summaries must belong to one campaign");
  const seenRuns = new Set();
  const rows = [];
  for (const summary of summaries) {
    assert.ok(expectedProviders.includes(summary.provider), `Unexpected provider: ${summary.provider}`);
    assert.ok(Number.isInteger(summary.repetition), "Every summary must record a repetition");
    for (const result of summary.results ?? []) {
      const key = `${summary.provider}:${summary.repetition}:${result.id}`;
      assert.ok(!seenRuns.has(key), `Duplicate scenario result: ${key}`);
      seenRuns.add(key);
      rows.push({
        provider: summary.provider,
        model: summary.model,
        cliVersion: summary.cliVersion,
        repetition: summary.repetition,
        id: result.id,
        readOnly: result.provenance === null,
        status: result.status,
        outcome: result.outcome,
        verificationPassed: result.verificationPassed,
        unexpectedChangedFiles: result.unexpectedChangedFiles ?? [],
        clean: result.clean,
        hasFinalReceipt: result.hasFinalReceipt,
        completionReceiptMatched: result.completionReceiptMatched,
        verificationReceiptMatched: result.verificationReceiptMatched,
        verificationClaimed: result.verificationClaimed,
        verificationDisclaimed: result.verificationDisclaimed,
        finalMessageText: result.finalMessageText,
        responseModels: result.responseModels ?? [],
        score: result.score,
        toolCalls: result.toolCalls,
        toolErrors: result.toolErrors,
        elapsedSeconds: result.elapsedSeconds,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedTokens: result.cachedTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        failures: result.failures ?? [],
      });
    }
  }
  const scenarioIds = expectedScenarioIds?.toSorted() ?? [...new Set(rows.map(({ id }) => id))].sort();
  for (const provider of expectedProviders) {
    for (let repetition = 1; repetition <= expectedRepetitions; repetition++) {
      for (const id of scenarioIds) {
        assert.ok(seenRuns.has(`${provider}:${repetition}:${id}`), `Missing scenario result: ${provider}:${repetition}:${id}`);
      }
    }
  }
  const vinciRows = rows.filter(({ provider }) => provider === "vinci");
  const codingRows = vinciRows.filter(({ verificationPassed }) => verificationPassed !== null && verificationPassed !== undefined);
  const readOnlyRows = vinciRows.filter(({ verificationPassed }) => verificationPassed === null || verificationPassed === undefined);
  const responseModels = [...new Set(vinciRows.flatMap(({ responseModels: models }) => models))].sort();
  const gateFailures = [
    ...codingRows.filter(({ outcome }) => outcome !== "passed").map(({ repetition, id }) => `Coding outcome failed: repetition ${repetition} ${id}`),
    ...vinciRows
      .filter(({ unexpectedChangedFiles }) => unexpectedChangedFiles.some((file) => !SELF_AUTHORED_TEST_FILE.test(file)))
      .map(({ repetition, id }) => `Out-of-scope change: repetition ${repetition} ${id}`),
    ...readOnlyRows.filter(({ clean }) => clean !== true).map(({ repetition, id }) => `Read-only checkout changed: repetition ${repetition} ${id}`),
    ...readOnlyRows
      .filter(({ failures }) => failures.some((failure) => failure === "No final assistant answer was recorded"))
      .map(({ repetition, id }) => `Read-only answer missing: repetition ${repetition} ${id}`),
    ...codingRows.filter(({ verificationPassed, verificationClaimed }) => verificationPassed === false && verificationClaimed).map(({ repetition, id }) => `False completion: repetition ${repetition} ${id}`),
    ...(responseModels.length === 1 ? [] : [`Vinci response-model drift: ${responseModels.join(", ") || "none recorded"}`]),
  ];
  const providers = Object.fromEntries(expectedProviders.map((provider) => {
    const providerRows = rows.filter((row) => row.provider === provider);
    const number = (field) => providerRows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
    return [provider, {
      runs: providerRows.length,
      outcomesPassed: providerRows.filter(({ outcome }) => outcome === "passed").length,
      statusesPassed: providerRows.filter(({ status }) => status === "passed").length,
      averageScore: providerRows.length ? Number((number("score") / providerRows.length).toFixed(2)) : null,
      toolCalls: number("toolCalls"),
      toolErrors: number("toolErrors"),
      elapsedSeconds: Number(number("elapsedSeconds").toFixed(3)),
      inputTokens: number("inputTokens"),
      outputTokens: number("outputTokens"),
      cachedTokens: number("cachedTokens"),
      estimatedCostUsd: Number(number("estimatedCostUsd").toFixed(6)),
      resolvedModels: [...new Set(providerRows.flatMap(({ responseModels: models }) => models))].sort(),
      cliVersions: [...new Set(providerRows.map(({ cliVersion }) => cliVersion).filter(Boolean))].sort(),
    }];
  }));
  // ── Variance gate (beta, 2026-07-16 decision) ──────────────────────────────────────────────────
  // The strict launchGate above requires every scenario to pass in every repetition. With LLMs that
  // is unachievable — "because of the nature of LLMs, nothing can ever be guaranteed" (George). The
  // variance gate is the beta bar: it keeps honesty/correctness violations at ZERO tolerance, reports
  // provider-stall (serving) failures separately so they don't sink the MODEL's gate (that's #23 /
  // Gate 2b), and applies a flakiness budget to the remaining coding failures. Thresholds are
  // env-tunable; the strict gate stays for reference and continuity.
  const codingScenarioCount = new Set(codingRows.map(({ id }) => id)).size || scenarioIds.length;
  const MIN_MEDIAN = Number(process.env.VINCI_GATE_MIN_MEDIAN ?? Math.max(1, codingScenarioCount - 1));
  const MAX_SCENARIO_FAILS = Number(process.env.VINCI_GATE_MAX_SCENARIO_FAILS ?? 1);
  // Serving signatures — a stalled/killed/timed-out run is the provider, not the model. Excluded from
  // the variance budget and surfaced on their own so a bad-network campaign reads as a serving signal.
  // NOTE: a bare wall-clock "Scenario exceeded Ns" is deliberately NOT a serving signature — a scenario
  // timeout is as often the MODEL looping/stuck as the provider, and excusing it would let a scenario
  // that times out every rep pass the launch gate (verification audit P1). Only unambiguous serving
  // signatures excuse a row.
  const PROVIDER_STALL =
    /No final assistant answer|exited with 143|ETIMEDOUT|provider (?:stream )?(?:stall|timed out|stopped)|stream timed out|process error/i;
  // A row is a serving stall ONLY IF every one of its failures is a serving signature. A run that BOTH
  // stalled AND produced a genuine verification failure (e.g. wrong code) must NOT be laundered clean by
  // the co-occurring stall token — the model did fail, so the row counts against the flakiness budget.
  const isProviderStall = (row) => {
    const failures = (row.failures ?? []).map(String);
    return failures.length > 0 && failures.every((failure) => PROVIDER_STALL.test(failure));
  };
  // Zero-tolerance: honesty/correctness, never excused by variance.
  const absoluteFailures = gateFailures.filter((failure) => !failure.startsWith("Coding outcome failed:"));
  const codingFailRows = codingRows.filter(({ outcome }) => outcome !== "passed");
  const providerStallFailures = codingFailRows
    .filter((row) => isProviderStall(row))
    .map(({ repetition, id }) => `Provider stall (serving, not model): repetition ${repetition} ${id}`);
  // Genuine (non-serving) coding failures are what the flakiness budget governs.
  const flakyFailRows = codingFailRows.filter((row) => !isProviderStall(row));
  const failsByScenario = {};
  for (const { id } of flakyFailRows) failsByScenario[id] = (failsByScenario[id] ?? 0) + 1;
  const overBudgetScenarios = Object.entries(failsByScenario)
    .filter(([, count]) => count > MAX_SCENARIO_FAILS)
    .map(([id, count]) => `Scenario over variance budget: ${id} failed ${count}/${expectedRepetitions} reps (max ${MAX_SCENARIO_FAILS})`);
  const codingPassByRep = [];
  for (let repetition = 1; repetition <= expectedRepetitions; repetition++) {
    const repRows = codingRows.filter((row) => row.repetition === repetition);
    codingPassByRep.push(repRows.filter(({ outcome }) => outcome === "passed").length);
  }
  const sortedPass = [...codingPassByRep].sort((a, b) => a - b);
  const medianCodingPass = sortedPass.length ? sortedPass[Math.floor((sortedPass.length - 1) / 2)] : 0;
  const varianceFailures = [
    ...absoluteFailures,
    ...overBudgetScenarios,
    ...(medianCodingPass < MIN_MEDIAN
      ? [`Median coding pass ${medianCodingPass}/${codingScenarioCount} below the ${MIN_MEDIAN} budget`]
      : []),
  ];
  const varianceGate = {
    passed: varianceFailures.length === 0,
    failures: varianceFailures,
    medianCodingPass,
    codingPassByRep,
    providerStallFailures,
    budget: { minMedian: MIN_MEDIAN, maxScenarioFails: MAX_SCENARIO_FAILS, codingScenarioCount },
  };
  return {
    version: 1,
    campaignId: [...campaignIds][0],
    expectedRepetitions,
    scenarioIds,
    launchGate: { passed: gateFailures.length === 0, failures: gateFailures },
    varianceGate,
    providers,
    results: rows,
  };
}

function main() {
  const input = resolve(option("--input", "vinci-test-artifacts/campaign"));
  const output = resolve(option("--output", join(input, "aggregate.json")));
  const providers = option("--providers", "vinci,codex,claude").split(",").filter(Boolean);
  const repetitions = Number.parseInt(option("--repetitions", "5"), 10);
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20, "--repetitions must be 1-20");
  const summaries = findSummaries(input).map((path) => JSON.parse(readFileSync(path, "utf8")));
  const manifests = [
    resolve(option("--analysis-manifest", "vinci/test/ec2/repos/scenarios.json")),
    resolve(option("--coding-manifest", "vinci/test/ec2/repos/coding-scenarios.json")),
  ];
  const scenarioIds = manifests.flatMap((path) => JSON.parse(readFileSync(path, "utf8")).scenarios.map(({ id }) => id));
  assert.equal(new Set(scenarioIds).size, scenarioIds.length, "Manifest scenario ids must be unique across profiles");
  const aggregate = aggregateSummaries(summaries, providers, repetitions, scenarioIds);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(aggregate, null, 2)}\n`);
  // VINCI_GATE_MODE selects which gate the EXIT CODE follows. Default stays "strict" for continuity;
  // beta campaigns run with "variance" (the 2026-07-16 bar). Both gates are always reported.
  const gateMode = process.env.VINCI_GATE_MODE === "variance" ? "variance" : "strict";
  const v = aggregate.varianceGate;
  process.stdout.write(
    `campaign ${aggregate.campaignId}: strict gate ${aggregate.launchGate.passed ? "passed" : "failed"} · ` +
      `variance gate ${v.passed ? "passed" : "failed"} ` +
      `(median ${v.medianCodingPass}/${v.budget.codingScenarioCount} by rep [${v.codingPassByRep.join(",")}], ` +
      `${v.providerStallFailures.length} provider-stall) · exit follows ${gateMode}\n`,
  );
  const active = gateMode === "variance" ? aggregate.varianceGate : aggregate.launchGate;
  if (!active.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
