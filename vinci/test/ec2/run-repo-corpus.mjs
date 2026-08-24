import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  COMPARATOR_PROVIDERS,
  comparatorInvocation,
  normalizeComparatorTranscript,
} from "./comparator-adapters.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_MANIFEST = join(ROOT, "vinci", "test", "ec2", "repos", "scenarios.json");
const FIXTURE_ROOT = resolve(
  process.env.VINCI_EC2_FIXTURE_ROOT ?? join(ROOT, "vinci", "test", "ec2", "repos", "fixtures"),
);
const PUBLIC_GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const PUBLIC_GITHUB_WORK_ITEM = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const PASSIVE_HANDOFF = /\b(?:want me to|would you like me to|what else (?:are you looking|should i|do you want)|should i (?:continue|keep|look|check)|tell me which|say (?:continue|which one))\b/i;
const COMPLETION_RECEIPT =
  /\b(?:fixed|changed|updated|implemented|completed|done|the\s+(?:fix|change))\b|(?:^|\n)\s*(?:[-*]\s+)?(?:#{1,6}\s*)?\**(?:fix|changes?|final state)\b/im;
const VERIFICATION_RECEIPT =
  /\b(?:verified|tests? (?:pass|passes|passed|passing)|checks? (?:pass|passes|passed|passing)|verification(?: command)? (?:passes|passed|succeeded))\b|\b\d+\s+(?:tests?\s+)?pass(?:ed|ing)?\b|\ball\s+\d+\s+tests?\b[^.\n]{0,80}\bpass(?:ed|ing)?\b|\b\d+\s*\/\s*\d+\s+(?:tests?\s+)?pass(?:ed)?\b/i;
const VERIFICATION_DISCLAIMER =
  /\bdone\s+—\s+please check it\b|\btest suite couldn.t be run\b|^\s*(?:WAITING|BLOCKED|Verification blocked)\s*[:—]|\bcouldn.t (?:run|confirm)\b|\bdon.t treat this as done\b/im;
const CHECK_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build)\b|(?:^|\s)(?:(?:\.\/)?node_modules\/\.bin\/(?:ava|eslint|jest|mocha|tsc|tsd|vitest|xo)|node\s+--test|pytest|cargo\s+test|go\s+test|make\s+(?:test|check))\b/i;
const FIXTURE_RUNTIME_COMMANDS = {
  node: new Set(["npm", "pnpm"]),
  python: new Set(["uv"]),
  go: new Set(["go"]),
};
const CORPUS_PROVIDERS = new Set(["vinci", "openrouter", "deepinfra", ...COMPARATOR_PROVIDERS]);
const CORPUS_MODELS = new Set(["forte"]);
const OPENROUTER_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const DEEPINFRA_MODEL = "zai-org/GLM-5.2";
const MAX_REPEATED_FAILED_TOOL_SIGNATURE = 1;
const FINAL_MESSAGE_TEXT_MAX_BYTES = 3_072;
const FINAL_MESSAGE_TEXT_TRUNCATION_MARKER =
  `\n[TRUNCATED: final assistant message exceeded ${FINAL_MESSAGE_TEXT_MAX_BYTES} bytes]`;
const MUTATION_DIGEST_DISAGREEMENT_MARKER = "[vinci-mutation-tracking-disagreement]";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `Missing value for ${name}`);
  return value;
}

export function validateCorpusProvider(provider) {
  assert.ok(CORPUS_PROVIDERS.has(provider), `Unsupported corpus provider: ${provider}`);
  return provider;
}

export function validateCorpusModel(model, provider = "vinci") {
  if (provider === "vinci") assert.ok(CORPUS_MODELS.has(model), `Unsupported corpus model: ${model}`);
  else if (COMPARATOR_PROVIDERS.has(provider)) {
    assert.equal(model, "default", `${provider} corpus runs use the stock default model`);
  }
  else if (provider === "openrouter") {
    assert.match(model, OPENROUTER_MODEL, `Invalid OpenRouter corpus model: ${model}`);
  } else {
    assert.equal(provider, "deepinfra", `Unsupported corpus provider: ${provider}`);
    assert.equal(model, DEEPINFRA_MODEL, `The DeepInfra corpus lane is pinned to ${DEEPINFRA_MODEL}`);
  }
  return model;
}

export function selectCorpusScenarios(scenarios, rawLimit) {
  assert.ok(
    rawLimit === undefined || (typeof rawLimit === "string" && /^(?:[1-9]|1[0-9]|20)$/.test(rawLimit)),
    "--limit must be an integer from 1 to 20",
  );
  const manifestScenarioCount = scenarios.length;
  const selectedScenarios = rawLimit === undefined ? scenarios : scenarios.slice(0, Number(rawLimit));
  const selectedScenarioCount = selectedScenarios.length;
  return {
    selectedScenarios,
    manifestScenarioCount,
    selectedScenarioCount,
    limited: rawLimit !== undefined && selectedScenarioCount < manifestScenarioCount,
  };
}

export function corpusSelectionNotice(selection) {
  if (selection.limited) {
    return `repository corpus selection: LIMITED to ${selection.selectedScenarioCount} of ${selection.manifestScenarioCount} scenarios by --limit`;
  }
  return `repository corpus selection: all ${selection.manifestScenarioCount} manifest scenarios`;
}

export function corpusSummaryLine(summary) {
  const suffix = summary.limited
    ? ` (LIMITED to ${summary.selectedScenarioCount} of ${summary.manifestScenarioCount} scenarios by --limit)`
    : "";
  return `repository corpus: ${summary.passed}/${summary.scenarios} ${summary.mode === "live" ? "passed" : "prepared"}${suffix}`;
}

export function classifyCorpusProcessExit(status, signal) {
  if (status === 0) return { classification: "completed_final", transportFailure: false };
  if (status === 3) return { classification: "completed_non_final", transportFailure: false };
  return {
    classification: "transport_failure",
    transportFailure: true,
    description: status === null ? `terminated by ${signal}` : `exited with ${status}`,
  };
}

/** Live qualification must execute the current source tree instead of an older local dist build. */
export function corpusVinciEnvironment(provider, model, environment = process.env) {
  const safeEnvironment = { ...environment };
  delete safeEnvironment.VINCI_EC2_CREDENTIAL_FILE;
  delete safeEnvironment.VINCI_EC2_FIXTURE_ROOT;
  delete safeEnvironment.VINCI_EC2_HOLDOUT_TASK_ROOT;
  return {
    ...safeEnvironment,
    VINCI_PROVIDER: provider,
    VINCI_MODEL: model,
    VINCI_SOURCE_CLI: "1",
  };
}

export function validateCorpus(raw) {
  assert.equal(raw?.version, 2, "Repository corpus version must be 2");
  assert.ok(Array.isArray(raw.scenarios) && raw.scenarios.length > 0, "Repository corpus needs scenarios");
  const ids = new Set();
  return raw.scenarios.map((scenario) => {
    assert.match(scenario.id ?? "", /^[a-z0-9][a-z0-9-]{2,60}$/, "Scenario id must be a stable slug");
    assert.ok(!ids.has(scenario.id), `Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.match(scenario.repository ?? "", PUBLIC_GITHUB_REPOSITORY, `${scenario.id}: only public GitHub HTTPS repositories are allowed`);
    assert.match(scenario.commit ?? "", FULL_COMMIT, `${scenario.id}: commit must be a full immutable SHA`);
    assert.equal(typeof scenario.readOnly, "boolean", `${scenario.id}: readOnly must be explicit`);
    assert.ok(typeof scenario.task === "string" && scenario.task.length >= 40, `${scenario.id}: task is too short`);
    assert.ok(Number.isInteger(scenario.timeoutSeconds) && scenario.timeoutSeconds >= 60 && scenario.timeoutSeconds <= 900, `${scenario.id}: timeoutSeconds must be 60-900`);
    assert.ok(Number.isInteger(scenario.maxToolCalls) && scenario.maxToolCalls >= 1 && scenario.maxToolCalls <= 40, `${scenario.id}: maxToolCalls must be 1-40`);
    assert.ok(Number.isInteger(scenario.maxRepeatedToolSignature) && scenario.maxRepeatedToolSignature >= 1 && scenario.maxRepeatedToolSignature <= 4, `${scenario.id}: maxRepeatedToolSignature must be 1-4`);
    const maxToolErrors = scenario.maxToolErrors ?? 4;
    const maxTranscriptBytes = scenario.maxTranscriptBytes ?? 1_000_000;
    const requireFinalReceipt = scenario.requireFinalReceipt ?? false;
    assert.ok(Number.isInteger(maxToolErrors) && maxToolErrors >= 0 && maxToolErrors <= 10, `${scenario.id}: maxToolErrors must be 0-10`);
    assert.ok(Number.isInteger(maxTranscriptBytes) && maxTranscriptBytes >= 10_000 && maxTranscriptBytes <= 10_000_000, `${scenario.id}: maxTranscriptBytes must be 10000-10000000`);
    assert.equal(typeof requireFinalReceipt, "boolean", `${scenario.id}: requireFinalReceipt must be boolean`);
    if (scenario.readOnly) {
      assert.equal(scenario.fixture, undefined, `${scenario.id}: read-only scenarios cannot define a coding fixture`);
    } else {
      const provenance = scenario.provenance;
      assert.ok(provenance && typeof provenance === "object", `${scenario.id}: coding scenarios require provenance`);
      assert.ok(
        provenance.kind === "synthetic-regression" || provenance.kind === "historical-fix",
        `${scenario.id}: provenance kind must be synthetic-regression or historical-fix`,
      );
      if (provenance.kind === "historical-fix") {
        assert.match(provenance.reportUrl ?? "", PUBLIC_GITHUB_WORK_ITEM, `${scenario.id}: reportUrl must reference a public GitHub issue or pull request`);
        assert.match(provenance.fixUrl ?? "", PUBLIC_GITHUB_WORK_ITEM, `${scenario.id}: fixUrl must reference a public GitHub issue or pull request`);
        assert.match(provenance.reportedBy ?? "", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, `${scenario.id}: reportedBy must be a GitHub login`);
        assert.match(provenance.fixedBy ?? "", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, `${scenario.id}: fixedBy must be a GitHub login`);
      }
      const fixture = scenario.fixture;
      assert.ok(fixture && typeof fixture === "object", `${scenario.id}: editable scenarios require a fixture`);
      assert.ok(
        Object.hasOwn(FIXTURE_RUNTIME_COMMANDS, fixture.runtime),
        `${scenario.id}: fixture runtime must be node, python, or go`,
      );
      assert.match(fixture.patch ?? "", /^[a-z0-9][a-z0-9.-]{2,80}\.patch$/, `${scenario.id}: fixture patch must be a filename`);
      assert.ok(Array.isArray(fixture.prepare) && fixture.prepare.length >= 1 && fixture.prepare.length <= 4, `${scenario.id}: fixture prepare must contain 1-4 commands`);
      for (const [label, commands] of [["prepare", fixture.prepare], ["verify", [fixture.verify]]]) {
        for (const command of commands) {
          assert.ok(Array.isArray(command) && command.length >= 2 && command.length <= 16, `${scenario.id}: fixture ${label} must use argument arrays`);
          assert.ok(command.every((token) => typeof token === "string" && token.length > 0 && token.length <= 160), `${scenario.id}: fixture ${label} has an invalid argument`);
          assert.ok(FIXTURE_RUNTIME_COMMANDS[fixture.runtime].has(command[0]), `${scenario.id}: fixture ${label} command is not allowlisted for ${fixture.runtime}`);
        }
      }
      if (fixture.runtime === "node") {
        assert.ok(
          fixture.prepare
            .filter((command) => /^(?:i|install|add|ci)$/i.test(command[1]))
            .every((command) => command.includes("--ignore-scripts")),
          `${scenario.id}: Node fixture preparation must disable install scripts`,
        );
      }
      assert.equal(typeof fixture.expectInitialFailure, "boolean", `${scenario.id}: expectInitialFailure must be boolean`);
      assert.equal(typeof fixture.expectCleanAfter, "boolean", `${scenario.id}: expectCleanAfter must be boolean`);
      assert.equal(typeof fixture.commitSeed, "boolean", `${scenario.id}: commitSeed must be boolean`);
      const prepareTimeoutSeconds = fixture.prepareTimeoutSeconds ?? 360;
      assert.ok(
        Number.isInteger(prepareTimeoutSeconds) && prepareTimeoutSeconds >= 60 && prepareTimeoutSeconds <= 900,
        `${scenario.id}: fixture prepareTimeoutSeconds must be 60-900`,
      );
      if (fixture.commitSeed) assert.equal(fixture.expectCleanAfter, false, `${scenario.id}: committed fixtures cannot expect a clean checkout after repair`);
      const allowedChangedFiles = fixture.allowedChangedFiles ?? [];
      assert.ok(Array.isArray(allowedChangedFiles) && allowedChangedFiles.length <= 12, `${scenario.id}: allowedChangedFiles must contain at most 12 paths`);
      // A trailing `/**` allows a subsystem; everything before it obeys the same safety rules as a
      // file path (relative, no `..`, no wildcards anywhere else) so the suffix cannot smuggle in a
      // broader match than intended. `**` alone is rejected — that would disable the rule entirely.
      assert.ok(
        allowedChangedFiles.every(
          (path) =>
            typeof path === "string" &&
            /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+(?:\/\*\*)?$/.test(path) &&
            path !== "/**",
        ),
        `${scenario.id}: allowedChangedFiles contains an unsafe path`,
      );
      if (!fixture.expectCleanAfter) assert.ok(allowedChangedFiles.length > 0, `${scenario.id}: non-clean fixtures require allowedChangedFiles`);
    }
    return {
      ...scenario,
      fixture: scenario.fixture
        ? { ...scenario.fixture, prepareTimeoutSeconds: scenario.fixture.prepareTimeoutSeconds ?? 360 }
        : undefined,
      maxToolErrors,
      maxTranscriptBytes,
      requireFinalReceipt,
    };
  });
}

function textFromMessage(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function truncateFinalMessageText(text) {
  const buffer = Buffer.from(text);
  if (buffer.length <= FINAL_MESSAGE_TEXT_MAX_BYTES) return text;
  let prefixBytes =
    FINAL_MESSAGE_TEXT_MAX_BYTES - Buffer.byteLength(FINAL_MESSAGE_TEXT_TRUNCATION_MARKER);
  while ((buffer[prefixBytes] & 0xc0) === 0x80) prefixBytes--;
  return buffer.subarray(0, prefixBytes).toString("utf8") + FINAL_MESSAGE_TEXT_TRUNCATION_MARKER;
}

export function analyzeJsonTranscript(jsonl, scenario, elapsedSeconds, clean, startedAtMs, outcome = {}) {
  const agentLabel = outcome.agentLabel ?? "Vinci";
  const maxToolErrors = scenario.maxToolErrors ?? 4;
  const maxTranscriptBytes = scenario.maxTranscriptBytes ?? 1_000_000;
  const events = [];
  let invalidJsonLines = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      invalidJsonLines++;
    }
  }
  const starts = events.filter((event) => event?.type === "tool_execution_start");
  const startsById = new Map(starts.map((event) => [event.toolCallId, event]));
  const endsById = new Map(
    events
      .filter((event) => event?.type === "tool_execution_end")
      .map((event) => [event.toolCallId, event]),
  );
  const isPolicyBlock = (event) => event?.result?.details?.vinciBlocked === true;
  const scoredStarts = starts.filter((event) => !isPolicyBlock(endsById.get(event.toolCallId)));
  const policyBlockedToolCalls = starts.length - scoredStarts.length;
  const signatures = new Map();
  for (const event of scoredStarts) {
    const signature = JSON.stringify([event.toolName, event.args]);
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  const maxRepeatedToolSignature = Math.max(0, ...signatures.values());
  const isMutation = (event) => event?.toolName === "edit" || event?.toolName === "write";
  const firstMutationAttemptIndex = scoredStarts.findIndex(isMutation);
  const firstSuccessfulMutationIndex = scoredStarts.findIndex(
    (event) => isMutation(event) && endsById.get(event.toolCallId)?.isError === false,
  );
  const firstMutationAttemptCall = firstMutationAttemptIndex < 0 ? null : firstMutationAttemptIndex + 1;
  const firstSuccessfulMutationCall = firstSuccessfulMutationIndex < 0 ? null : firstSuccessfulMutationIndex + 1;
  const preMutationToolCalls = firstSuccessfulMutationCall ?? scoredStarts.length;
  const postMutationToolCalls = firstSuccessfulMutationCall === null ? 0 : scoredStarts.length - firstSuccessfulMutationCall;
  const isExpectedCheckFailure = (event) => {
    const start = startsById.get(event.toolCallId);
    return start?.toolName === "bash" && CHECK_COMMAND.test(String(start.args?.command ?? ""));
  };
  const failedSignatures = new Map();
  for (const event of events.filter(
    (candidate) =>
      candidate?.type === "tool_execution_end" &&
      candidate.isError === true &&
      !isExpectedCheckFailure(candidate) &&
      !isPolicyBlock(candidate),
  )) {
    const start = startsById.get(event.toolCallId);
    if (!start) continue;
    const signature = JSON.stringify([start.toolName, start.args]);
    failedSignatures.set(signature, (failedSignatures.get(signature) ?? 0) + 1);
  }
  const maxRepeatedFailedToolSignature = Math.max(0, ...failedSignatures.values());
  const assistantResponseEvents = events.filter(
    (event) => event?.type === "message_end" && event.message?.role === "assistant",
  );
  const assistantEvents = assistantResponseEvents
    .filter((event) => event?.type === "message_end")
    .filter((event) => textFromMessage(event.message));
  const assistantMessages = assistantEvents.map((event) => textFromMessage(event.message));
  const responseModels = Array.from(
    new Set(
      assistantEvents
        .map((event) => event.message?.responseModel ?? event.message?.model)
        .filter((model) => typeof model === "string" && model.length > 0),
    ),
  );
  const usage = assistantResponseEvents.reduce(
    (total, event) => {
      const current = event.message?.usage;
      total.modelCalls++;
      total.inputTokens += Number.isFinite(current?.input) ? current.input : 0;
      total.outputTokens += Number.isFinite(current?.output) ? current.output : 0;
      total.cachedTokens += Number.isFinite(current?.cacheRead) ? current.cacheRead : 0;
      total.cacheWriteTokens += Number.isFinite(current?.cacheWrite) ? current.cacheWrite : 0;
      total.reasoningTokens += Number.isFinite(current?.reasoning) ? current.reasoning : 0;
      total.estimatedCostUsd += Number.isFinite(current?.cost?.total) ? current.cost.total : 0;
      return total;
    },
    {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    },
  );
  const finalText = assistantMessages.at(-1) ?? "";
  const finalMessageText = truncateFinalMessageText(finalText);
  const completionReceiptMatched = COMPLETION_RECEIPT.test(finalText);
  const verificationClaimed = VERIFICATION_RECEIPT.test(finalText);
  const verificationDisclaimed = VERIFICATION_DISCLAIMER.test(finalText);
  const verificationReceiptMatched = verificationClaimed;
  const passiveHandoffs = assistantMessages.filter((text) => PASSIVE_HANDOFF.test(text)).length;
  const firstToolMessage = events.find((event) =>
    event?.type === "message_end" &&
    event.message?.role === "assistant" &&
    Array.isArray(event.message.content) &&
    event.message.content.some((part) => part?.type === "toolCall"),
  );
  const firstToolTimestamp = firstToolMessage?.message?.timestamp;
  const timeToFirstActionSeconds =
    typeof startedAtMs === "number" && typeof firstToolTimestamp === "number"
      ? Number(Math.max(0, (firstToolTimestamp - startedAtMs) / 1000).toFixed(3))
      : null;
  const toolErrors = events.filter(
    (event) =>
      event?.type === "tool_execution_end" &&
      event.isError === true &&
      !isExpectedCheckFailure(event) &&
      !isPolicyBlock(event),
  ).length;
  const rawTranscriptBytes = Buffer.byteLength(jsonl);
  const transcriptBytes = Buffer.byteLength(compactTranscript(jsonl));
  const hasFinalReceipt = completionReceiptMatched && verificationClaimed;
  const finalReceiptSatisfied =
    completionReceiptMatched && (verificationClaimed || verificationDisclaimed);
  const failures = [];
  if (scenario.readOnly && !clean) failures.push(`${agentLabel} changed a read-only scenario repository`);
  if (outcome.expectCleanAfter && !clean) failures.push(`${agentLabel} did not return the seeded fixture to the expected clean state`);
  if (outcome.verificationPassed === false) failures.push(`Independent repository verification failed after ${agentLabel} finished`);
  if (outcome.unexpectedChangedFiles?.length > 0) failures.push(`${agentLabel} changed files outside the fixture scope: ${outcome.unexpectedChangedFiles.join(", ")}`);
  if (!finalText) failures.push("No final assistant answer was recorded");
  if (invalidJsonLines > 0) failures.push(`Transcript contained ${invalidJsonLines} invalid JSON line(s)`);
  if (scenario.requireFinalReceipt && !finalReceiptSatisfied) failures.push("The final answer did not report both completion and verification");
  if (passiveHandoffs > 0) failures.push("The transcript handed investigation back to the user");
  if (scoredStarts.length > scenario.maxToolCalls) failures.push(`Tool calls exceeded ${scenario.maxToolCalls}`);
  if (toolErrors > maxToolErrors) failures.push(`Tool errors exceeded ${maxToolErrors}`);
  if (maxRepeatedToolSignature > scenario.maxRepeatedToolSignature) {
    failures.push(`One tool call repeated ${maxRepeatedToolSignature} times`);
  }
  if (maxRepeatedFailedToolSignature > MAX_REPEATED_FAILED_TOOL_SIGNATURE) {
    failures.push("The same failing tool call was repeated");
  }
  if (transcriptBytes > maxTranscriptBytes) failures.push(`Transcript exceeded ${maxTranscriptBytes} bytes`);
  if (elapsedSeconds > scenario.timeoutSeconds) failures.push(`Scenario exceeded ${scenario.timeoutSeconds}s`);
  const score = Math.max(
    0,
    100 -
      (scenario.readOnly && !clean ? 30 : 0) -
      (outcome.expectCleanAfter && !clean ? 25 : 0) -
      (outcome.verificationPassed === false ? 40 : 0) -
      (outcome.unexpectedChangedFiles?.length > 0 ? 30 : 0) -
      (finalText ? 0 : 30) -
      (invalidJsonLines > 0 ? 20 : 0) -
      (scenario.requireFinalReceipt && !finalReceiptSatisfied ? 10 : 0) -
      (passiveHandoffs > 0 ? 20 : 0) -
      Math.max(0, scoredStarts.length - scenario.maxToolCalls) * 2 -
      Math.max(0, toolErrors - maxToolErrors) * 3 -
      Math.max(0, maxRepeatedToolSignature - scenario.maxRepeatedToolSignature) * 10 -
      (maxRepeatedFailedToolSignature > MAX_REPEATED_FAILED_TOOL_SIGNATURE ? 10 : 0) -
      (transcriptBytes > maxTranscriptBytes ? 10 : 0) -
      (elapsedSeconds > scenario.timeoutSeconds ? 20 : 0),
  );
  return {
    toolCalls: scoredStarts.length,
    policyBlockedToolCalls,
    firstMutationAttemptCall,
    firstSuccessfulMutationCall,
    preMutationToolCalls,
    postMutationToolCalls,
    maxRepeatedToolSignature,
    maxRepeatedFailedToolSignature,
    assistantMessages: assistantMessages.length,
    ...usage,
    responseModels,
    invalidJsonLines,
    finalText,
    finalMessageText,
    passiveHandoffs,
    timeToFirstActionSeconds,
    toolErrors,
    rawTranscriptBytes,
    transcriptBytes,
    hasFinalReceipt,
    completionReceiptMatched,
    verificationReceiptMatched,
    verificationClaimed,
    verificationDisclaimed,
    verificationPassed: outcome.verificationPassed ?? null,
    unexpectedChangedFiles: outcome.unexpectedChangedFiles ?? [],
    clean,
    elapsedSeconds,
    score,
    failures,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
    timeout: options.timeout,
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

export function runToFiles(command, args, options) {
  const stdout = openSync(options.stdoutPath, "w");
  const stderr = openSync(options.stderrPath, "w");
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", stdout, stderr],
      timeout: options.timeout,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  if (options.check !== false && result.status !== 0) {
    const error = readFileSync(options.stderrPath, "utf8") || readFileSync(options.stdoutPath, "utf8");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${error}`);
  }
  return result;
}

function clonePinned(scenario, directory) {
  mkdirSync(directory, { recursive: true });
  run("git", ["init", "--quiet"], { cwd: directory });
  run("git", ["remote", "add", "origin", scenario.repository], { cwd: directory });
  run("git", ["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", scenario.commit], {
    cwd: directory,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 180_000,
  });
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: directory });
  const actual = run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim();
  assert.equal(actual, scenario.commit, `${scenario.id}: fetched commit does not match the manifest`);
  run("git", ["remote", "remove", "origin"], { cwd: directory });
}

function inventory(directory) {
  const files = run("git", ["ls-files"], { cwd: directory }).stdout.trim().split("\n").filter(Boolean);
  const roots = Array.from(new Set(files.map((file) => file.split("/")[0]))).sort();
  return { trackedFiles: files.length, topLevelEntries: roots.slice(0, 80) };
}

function compactTranscript(jsonl) {
  const retained = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "message_update" || event?.type === "tool_execution_update") continue;
      retained.push(JSON.stringify(event));
    } catch {
      retained.push(line);
    }
  }
  return `${retained.join("\n")}\n`;
}

function mutationDigestTrackedBroadDisagreements(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.includes(MUTATION_DIGEST_DISAGREEMENT_MARKER))
    .length;
}

function writeCommandArtifacts(directory, name, result) {
  writeFileSync(join(directory, `${name}.stdout.log`), result.stdout ?? "");
  writeFileSync(join(directory, `${name}.stderr.log`), result.stderr ?? "");
}

function changedFiles(checkout) {
  const tracked = run("git", ["diff", "--name-only", "HEAD"], { cwd: checkout }).stdout.split("\n");
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: checkout }).stdout.split("\n");
  return Array.from(new Set([...tracked, ...untracked].filter(Boolean))).sort();
}

export function sealFixtureHistory(checkout, scenarioId, originalCommit) {
  rmSync(join(checkout, ".git"), { recursive: true, force: true });
  run("git", ["init", "--quiet"], { cwd: checkout });
  run("git", ["add", "--all"], { cwd: checkout });
  run(
    "git",
    [
      "-c",
      "user.name=Vinci benchmark",
      "-c",
      "user.email=benchmark@vinci.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      `Seed ${scenarioId} regression`,
    ],
    { cwd: checkout },
  );
  const seedCommit = run("git", ["rev-parse", "HEAD"], { cwd: checkout }).stdout.trim();
  const acceptedCommit = run("git", ["cat-file", "-e", `${originalCommit}^{commit}`], {
    cwd: checkout,
    check: false,
  });
  assert.notEqual(acceptedCommit.status, 0, `${scenarioId}: accepted fix commit remained inspectable after fixture seeding`);
  return seedCommit;
}

// A self-authored *_test.* file the agent adds to verify its OWN fix is diligence, not scope creep
// (product decision 2026-07-17): "out of scope" means touching unrelated PRODUCTION code, not adding a
// test that checks the change. Covers the corpus languages' test-file conventions. Kept deliberately
// narrow (must end in a recognized test suffix) so a real production file is never excused.
export const SELF_AUTHORED_TEST_FILE =
  /(?:^|\/)(?:[^/]*_test\.(?:go|py|rb|js|ts)|[^/]*_spec\.rb|test_[^/]*\.(?:py|rb)|[^/]*\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs))$/i;

// An entry ending in `/**` allows a SUBSYSTEM rather than a file. Needed because a file list assumes
// the fix has exactly one valid factoring, and some do not: the execa scenario's helper was placed in
// `lib/stdio/input-option.js` in one campaign and `lib/utils/standard-stream.js` in the next — both
// correct (hidden verification passed, 63 tests), both failed on scope, and no hand-maintained list
// can anticipate which module the next correct fix will pick. A subsystem prefix still catches
// everything the rule exists for: docs, config, unrelated trees, and — importantly — tampering with
// the tests the fixture verifies with, since those live outside the allowed subsystem.
function allowsChangedFile(allowed, file) {
  for (const entry of allowed) {
    if (entry === file) return true;
    if (entry.endsWith("/**") && file.startsWith(entry.slice(0, -2))) return true;
  }
  return false;
}

export function unexpectedChangedFiles(scenario, files) {
  const allowed = scenario.fixture?.allowedChangedFiles ?? [];
  // Clean / read-only fixtures expect NO change at all — any changed file (even a test) is unexpected.
  if (allowed.length === 0) return files;
  // Coding fixtures: files outside the allowed set, EXCEPT a self-authored test file verifying the fix.
  return files.filter((file) => !allowsChangedFile(allowed, file) && !SELF_AUTHORED_TEST_FILE.test(file));
}

function agentLabel(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  return "Vinci";
}

function comparatorCliVersion(provider) {
  if (!COMPARATOR_PROVIDERS.has(provider)) return null;
  const version = run(provider, ["--version"], { check: false });
  assert.equal(version.status, 0, `${provider} CLI is required for comparator runs`);
  return (version.stdout || version.stderr).trim();
}

function prepareCodingFixture(scenario, checkout, scenarioOutput, artifactPrefix = "fixture") {
  const fixture = scenario.fixture;
  const prepareExitCodes = [];
  for (const [index, command] of fixture.prepare.entries()) {
    const prepare = run(command[0], command.slice(1), {
      cwd: checkout,
      timeout: fixture.prepareTimeoutSeconds * 1_000,
      check: false,
    });
    writeCommandArtifacts(scenarioOutput, `${artifactPrefix}-prepare-${index + 1}`, prepare);
    if (prepare.status !== 0) {
      const cause = prepare.error instanceof Error ? prepare.error.message : (prepare.signal ?? prepare.status);
      throw new Error(`${scenario.id}: fixture preparation command ${index + 1} failed (${cause})`);
    }
    prepareExitCodes.push(prepare.status);
  }

  const patch = join(FIXTURE_ROOT, fixture.patch);
  run("git", ["apply", "--check", patch], { cwd: checkout });
  run("git", ["apply", patch], { cwd: checkout });
  if (process.env.VINCI_EC2_REMOVE_FIXTURE_AFTER_APPLY === "yes") {
    rmSync(patch, { force: true });
  }
  const baseline = run(fixture.verify[0], fixture.verify.slice(1), {
    cwd: checkout,
    timeout: 300_000,
    check: false,
  });
  writeCommandArtifacts(scenarioOutput, `${artifactPrefix}-baseline`, baseline);
  if (fixture.expectInitialFailure) {
    assert.notEqual(baseline.status, 0, `${scenario.id}: seeded fixture did not fail verification`);
  } else {
    assert.equal(baseline.status, 0, `${scenario.id}: seeded fixture did not pass verification`);
  }
  let seedCommit = null;
  if (fixture.commitSeed) {
    seedCommit = sealFixtureHistory(checkout, scenario.id, scenario.commit);
  }
  return { prepareExitCodes, baselineExitCode: baseline.status, seedCommit };
}

function runLiveUiScenario(scenario, scenarioOutput, outputRoot, provider, model) {
  const checkout = join(outputRoot, "work", `${scenario.id}-ui`);
  rmSync(checkout, { recursive: true, force: true });
  clonePinned(scenario, checkout);
  const fixture = prepareCodingFixture(scenario, checkout, scenarioOutput, "ui-fixture");
  const uiOutput = join(scenarioOutput, "terminal");
  const capture = run(process.execPath, [
    join(ROOT, "vinci", "test", "ec2", "capture-live-terminal.mjs"),
    "--output",
    uiOutput,
    "--project",
    checkout,
    "--prompt",
    scenario.task,
    "--name",
    scenario.id,
    "--columns",
    "100",
    "--rows",
    "32",
    "--timeout-seconds",
    String(scenario.timeoutSeconds),
  ], {
    cwd: ROOT,
    env: corpusVinciEnvironment(provider, model),
    timeout: (scenario.timeoutSeconds + 30) * 1_000,
    check: false,
  });
  writeCommandArtifacts(scenarioOutput, "ui-capture", capture);
  const report = run(process.execPath, [join(ROOT, "vinci", "test", "ec2", "visual-report.mjs"), "--directory", uiOutput], {
    cwd: ROOT,
    check: false,
  });
  writeCommandArtifacts(scenarioOutput, "ui-report", report);
  const reportExitCode = report.status;
  const verification = run(scenario.fixture.verify[0], scenario.fixture.verify.slice(1), {
    cwd: checkout,
    timeout: 300_000,
    check: false,
  });
  writeCommandArtifacts(scenarioOutput, "ui-verification", verification);
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: checkout }).stdout;
  const diff = run("git", ["diff", "--binary"], { cwd: checkout }).stdout;
  const files = changedFiles(checkout);
  const unexpectedFiles = unexpectedChangedFiles(scenario, files);
  writeFileSync(join(scenarioOutput, "ui-git-status.txt"), status);
  writeFileSync(join(scenarioOutput, "ui-changes.patch"), diff);
  rmSync(checkout, { recursive: true, force: true });
  return {
    fixture,
    captureExitCode: capture.status,
    reportExitCode,
    verificationExitCode: verification.status,
    verificationPassed: verification.status === 0,
    clean: status.trim() === "",
    changedFiles: files,
    unexpectedChangedFiles: unexpectedFiles,
  };
}

function runScenario(
  scenario,
  mode,
  outputRoot,
  allowRepoCode,
  captureUiScenario,
  provider,
  model,
  cliVersion,
  preserveWork,
) {
  const scenarioOutput = join(outputRoot, scenario.id);
  const checkout = join(outputRoot, "work", scenario.id);
  mkdirSync(scenarioOutput, { recursive: true });
  rmSync(checkout, { recursive: true, force: true });
  const cloneStarted = Date.now();
  clonePinned(scenario, checkout);
  const repoInventory = inventory(checkout);
  const base = {
    id: scenario.id,
    repository: scenario.repository,
    commit: scenario.commit,
    provenance: scenario.provenance ?? null,
    provider,
    model,
    cliVersion,
    mode,
    cloneSeconds: Number(((Date.now() - cloneStarted) / 1000).toFixed(3)),
    inventory: repoInventory,
    mutationDigestTrackedBroadDisagreements: 0,
  };
  writeFileSync(join(scenarioOutput, "task.txt"), `${scenario.task}\n`);

  if (mode === "inventory") {
    const fixturePatchApplies = scenario.fixture
      ? run("git", ["apply", "--check", join(FIXTURE_ROOT, scenario.fixture.patch)], { cwd: checkout }).status === 0
      : null;
    const metrics = { ...base, fixturePatchApplies, status: "prepared", failures: [] };
    writeFileSync(join(scenarioOutput, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
    if (!preserveWork) rmSync(checkout, { recursive: true, force: true });
    return metrics;
  }

  let fixtureMetrics = null;
  if (scenario.fixture) {
    assert.ok(allowRepoCode, `${scenario.id}: coding fixtures require --allow-repo-code yes`);
    fixtureMetrics = prepareCodingFixture(scenario, checkout, scenarioOutput);
  }

  const started = Date.now();
  const transcriptPath = join(scenarioOutput, "transcript.jsonl");
  const stderrPath = join(scenarioOutput, "stderr.log");
  let adapter = null;
  let result;
  if (COMPARATOR_PROVIDERS.has(provider)) {
    const rawTranscriptPath = join(scenarioOutput, "transcript.raw.jsonl");
    const invocation = comparatorInvocation(provider, checkout, scenario.task);
    result = runToFiles(invocation.command, invocation.args, {
      cwd: checkout,
      env: invocation.env,
      timeout: scenario.timeoutSeconds * 1000,
      check: false,
      stdoutPath: rawTranscriptPath,
      stderrPath,
    });
    const normalized = normalizeComparatorTranscript(provider, readFileSync(rawTranscriptPath, "utf8"));
    writeFileSync(transcriptPath, normalized.jsonl);
    adapter = {
      ...normalized.metadata,
      command: invocation.command,
      args: invocation.args.map((argument) => argument === scenario.task ? "<task>" : argument),
      configuration: invocation.configuration,
    };
    writeFileSync(join(scenarioOutput, "adapter.json"), `${JSON.stringify(adapter, null, 2)}\n`);
  } else {
    result = runToFiles("bash", [
      join(ROOT, "vinci", "bin", "vinci"),
      "--exclude-tools",
      "web_search,web_fetch,web_answer,library_docs",
      "--mode",
      "json",
      "-p",
      scenario.task,
    ], {
      cwd: checkout,
      env: {
        ...corpusVinciEnvironment(provider, model),
        GIT_TERMINAL_PROMPT: "0",
        VINCI_NO_RESUME: "1",
      },
      timeout: scenario.timeoutSeconds * 1000,
      check: false,
      stdoutPath: transcriptPath,
      stderrPath,
    });
  }
  const elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(3));
  const transcript = readFileSync(transcriptPath, "utf8");
  const mutationDigestDisagreements = mutationDigestTrackedBroadDisagreements(
    readFileSync(stderrPath, "utf8"),
  );
  writeFileSync(join(scenarioOutput, "transcript.compact.jsonl"), compactTranscript(transcript));
  let verificationPassed = null;
  let verificationExitCode = null;
  if (scenario.fixture) {
    const verification = run(scenario.fixture.verify[0], scenario.fixture.verify.slice(1), {
      cwd: checkout,
      timeout: 300_000,
      check: false,
    });
    writeCommandArtifacts(scenarioOutput, "verification", verification);
    verificationExitCode = verification.status;
    verificationPassed = verification.status === 0;
  }
  const ui = scenario.id === captureUiScenario ? runLiveUiScenario(scenario, scenarioOutput, outputRoot, provider, model) : null;
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: checkout }).stdout;
  const diff = run("git", ["diff", "--binary"], { cwd: checkout }).stdout;
  const files = changedFiles(checkout);
  const unexpectedFiles = unexpectedChangedFiles(scenario, files);
  writeFileSync(join(scenarioOutput, "git-status.txt"), status);
  writeFileSync(join(scenarioOutput, "changes.patch"), diff);
  const clean = status.trim() === "";
  const analysis = analyzeJsonTranscript(transcript, scenario, elapsedSeconds, clean, started, {
    verificationPassed,
    expectCleanAfter: scenario.fixture?.expectCleanAfter ?? false,
    unexpectedChangedFiles: unexpectedFiles,
    agentLabel: agentLabel(provider),
  });
  const processError = result.error instanceof Error ? result.error.message : null;
  const processExit = classifyCorpusProcessExit(result.status, result.signal);
  if (processError) analysis.failures.unshift(`${agentLabel(provider)} process error: ${processError}`);
  if (processExit.transportFailure) analysis.failures.unshift(`${agentLabel(provider)} ${processExit.description}`);
  if (ui?.captureExitCode !== undefined && ui.captureExitCode !== 0) analysis.failures.unshift(`Live UI capture exited with ${ui.captureExitCode}`);
  if (ui?.reportExitCode !== null && ui?.reportExitCode !== undefined && ui.reportExitCode !== 0) analysis.failures.unshift(`Live UI report exited with ${ui.reportExitCode}`);
  if (ui?.verificationPassed === false) analysis.failures.unshift("Independent verification failed after the live UI capture");
  if (ui && scenario.fixture.expectCleanAfter && !ui.clean) analysis.failures.unshift("Live UI capture did not restore the expected clean checkout");
  if (ui?.unexpectedChangedFiles.length) analysis.failures.unshift(`Live UI capture changed files outside the fixture scope: ${ui.unexpectedChangedFiles.join(", ")}`);
  const outcomePassed = scenario.fixture
    ? verificationPassed &&
      unexpectedFiles.length === 0 &&
      (!scenario.fixture.expectCleanAfter || clean) &&
      (!ui || (ui.verificationPassed && ui.unexpectedChangedFiles.length === 0 && (!scenario.fixture.expectCleanAfter || ui.clean)))
    : clean || !scenario.readOnly;
  const metrics = {
    ...base,
    status: analysis.failures.length === 0 ? "passed" : "failed",
    outcome: outcomePassed ? "passed" : "failed",
    exitCode: result.status,
    exitSignal: result.signal,
    exitClassification: processExit.classification,
    processError,
    adapter,
    fixture: fixtureMetrics,
    verificationExitCode,
    ui,
    changedFiles: files,
    mutationDigestTrackedBroadDisagreements: mutationDigestDisagreements,
    ...analysis,
  };
  writeFileSync(join(scenarioOutput, "final-answer.txt"), `${analysis.finalText}\n`);
  writeFileSync(join(scenarioOutput, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  if (!preserveWork) rmSync(checkout, { recursive: true, force: true });
  return metrics;
}

export function main() {
  const mode = option("--mode", "inventory");
  assert.ok(mode === "inventory" || mode === "live", "--mode must be inventory or live");
  const allowRepoCodeOption = option("--allow-repo-code", "no");
  assert.ok(allowRepoCodeOption === "yes" || allowRepoCodeOption === "no", "--allow-repo-code must be yes or no");
  const allowRepoCode = allowRepoCodeOption === "yes";
  const captureUiScenario = option("--capture-ui-scenario", "");
  assert.ok(captureUiScenario === "" || /^[a-z0-9][a-z0-9-]{2,60}$/.test(captureUiScenario), "--capture-ui-scenario must be a scenario id");
  const preserveWorkOption = option("--preserve-work", "no");
  assert.ok(preserveWorkOption === "yes" || preserveWorkOption === "no", "--preserve-work must be yes or no");
  const preserveWork = preserveWorkOption === "yes";
  const rawLimit = option("--limit");
  const manifestPath = resolve(option("--manifest", DEFAULT_MANIFEST));
  const outputRoot = resolve(option("--output", join(ROOT, "vinci-test-artifacts", "repositories")));
  const provider = validateCorpusProvider(option("--provider", "vinci"));
  const model = validateCorpusModel(option("--model", COMPARATOR_PROVIDERS.has(provider) ? "default" : "forte"), provider);
  const campaignId = option("--campaign-id", "ad-hoc");
  assert.match(campaignId, /^[a-z0-9][a-z0-9-]{2,60}$/, "--campaign-id must be a stable slug");
  const repetition = Number.parseInt(option("--repetition", "1"), 10);
  assert.ok(Number.isInteger(repetition) && repetition >= 1 && repetition <= 20, "--repetition must be 1-20");
  const selection = selectCorpusScenarios(
    validateCorpus(JSON.parse(readFileSync(manifestPath, "utf8"))),
    rawLimit,
  );
  const scenarios = selection.selectedScenarios;
  if (captureUiScenario) {
    assert.equal(mode, "live", "Live UI capture requires --mode live");
    assert.ok(!COMPARATOR_PROVIDERS.has(provider), "Live UI capture is available only for Vinci lanes");
    assert.ok(allowRepoCode, "Live UI capture requires --allow-repo-code yes");
    assert.ok(scenarios.some(({ id }) => id === captureUiScenario), `UI capture scenario is not in the selected corpus: ${captureUiScenario}`);
  }
  if (mode === "live") {
    if (provider === "vinci") {
      // VINCI_CODING_AGENT_DIR: the override name is derived from piConfig.name in
      // packages/coding-agent/src/config.ts, not the upstream "PI_" literal this used to read.
      const authPath = join(process.env.VINCI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "auth.json");
      assert.ok(readFileSync(authPath, "utf8").includes('"vinci"'), "Live Vinci repository scenarios require a dedicated test credential");
    } else if (provider === "openrouter") {
      assert.ok(process.env.OPENROUTER_API_KEY, "Live OpenRouter repository scenarios require OPENROUTER_API_KEY");
    } else if (provider === "deepinfra") {
      assert.ok(
        process.env.VINCI_INTERNAL_DEEPINFRA_API_KEY,
        "Live DeepInfra repository scenarios require VINCI_INTERNAL_DEEPINFRA_API_KEY",
      );
    }
    if (scenarios.some((scenario) => scenario.fixture)) {
      assert.ok(allowRepoCode, "Live coding scenarios require --allow-repo-code yes");
    }
  }
  process.stdout.write(`${corpusSelectionNotice(selection)}\n`);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const cliVersion = mode === "live" ? comparatorCliVersion(provider) : null;
  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`repository scenario: ${scenario.id} (${mode}, ${provider}/${model})\n`);
    try {
      results.push(
        runScenario(
          scenario,
          mode,
          outputRoot,
          allowRepoCode,
          captureUiScenario,
          provider,
          model,
          cliVersion,
          preserveWork,
        ),
      );
    } catch (error) {
      if (!preserveWork) {
        rmSync(join(outputRoot, "work", scenario.id), { recursive: true, force: true });
        rmSync(join(outputRoot, "work", `${scenario.id}-ui`), { recursive: true, force: true });
      }
      const failure = {
        id: scenario.id,
        repository: scenario.repository,
        commit: scenario.commit,
        mode,
        provider,
        model,
        cliVersion,
        mutationDigestTrackedBroadDisagreements: 0,
        status: "failed",
        failures: [error instanceof Error ? error.message : String(error)],
      };
      mkdirSync(join(outputRoot, scenario.id), { recursive: true });
      writeFileSync(join(outputRoot, scenario.id, "metrics.json"), `${JSON.stringify(failure, null, 2)}\n`);
      results.push(failure);
    }
  }
  const summary = {
    campaignId,
    repetition,
    mode,
    provider,
    model,
    cliVersion,
    manifestScenarioCount: selection.manifestScenarioCount,
    selectedScenarioCount: selection.selectedScenarioCount,
    limited: selection.limited,
    scenarios: results.length,
    passed: results.filter((result) => result.status === "passed" || result.status === "prepared").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
  writeFileSync(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${corpusSummaryLine(summary)}\n`);
  if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
