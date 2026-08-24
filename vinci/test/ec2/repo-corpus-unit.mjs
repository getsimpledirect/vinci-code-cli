import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import {
  comparatorInvocation,
  normalizeClaudeTranscript,
  normalizeCodexTranscript,
} from "./comparator-adapters.mjs";
import { aggregateSummaries } from "./aggregate-corpus.mjs";
import {
  analyzeJsonTranscript,
  corpusSelectionNotice,
  corpusSummaryLine,
  corpusVinciEnvironment,
  runToFiles,
  sealFixtureHistory,
  selectCorpusScenarios,
  unexpectedChangedFiles,
  validateCorpus,
  validateCorpusModel,
  validateCorpusProvider,
} from "./run-repo-corpus.mjs";

// Product decision 2026-07-17: a self-authored *_test.* file the agent adds to verify its own fix is
// NOT an out-of-scope change (out-of-scope means unrelated PRODUCTION code). A real production file is.
{
  const coding = { fixture: { allowedChangedFiles: ["context.go"] } };
  assert.deepEqual(
    unexpectedChangedFiles(coding, ["context.go", "zz_copycheck_internal_test.go"]),
    [],
    "a self-authored Go test file is not out-of-scope",
  );
  assert.deepEqual(unexpectedChangedFiles(coding, ["context.go", "src/router.go"]), ["src/router.go"], "an unrelated production file IS out-of-scope");
  assert.deepEqual(unexpectedChangedFiles(coding, ["app.test.ts"]), [], "a self-authored TS test file is not out-of-scope");
  assert.deepEqual(unexpectedChangedFiles(coding, ["tests/test_helpers.py"]), [], "a self-authored Python test file is not out-of-scope");
  // Clean / read-only fixtures expect NO change at all — even a test file is unexpected there.
  assert.deepEqual(unexpectedChangedFiles({ fixture: { allowedChangedFiles: [] } }, ["foo_test.go"]), ["foo_test.go"], "in a clean fixture even a test file is unexpected");
}

// A `/**` entry allows a subsystem. Driven by two real campaign failures: the execa fix's helper
// landed in lib/stdio/input-option.js once and lib/utils/standard-stream.js the next time — both
// correct (hidden verification exit 0), both failed the zero-tolerance scope rule. A file list
// cannot anticipate which module a correct fix will choose; the guard must still hold everywhere else.
{
  const subsystem = { fixture: { allowedChangedFiles: ["lib/**"] } };
  assert.deepEqual(
    unexpectedChangedFiles(subsystem, ["lib/stdio/handle.js", "lib/stdio/input-option.js"]),
    [],
    "campaign 0728 rep 5's real factoring is in scope",
  );
  assert.deepEqual(
    unexpectedChangedFiles(subsystem, ["lib/stdio/handle.js", "lib/utils/standard-stream.js"]),
    [],
    "campaign gate3-0728-clean rep 4's real factoring is in scope",
  );
  // What the rule still exists to catch.
  assert.deepEqual(unexpectedChangedFiles(subsystem, ["README.md"]), ["README.md"], "docs are still out-of-scope");
  assert.deepEqual(
    unexpectedChangedFiles(subsystem, ["test/io/input-option.js"]),
    ["test/io/input-option.js"],
    "tampering with the tests the fixture verifies with is still out-of-scope",
  );
  assert.deepEqual(unexpectedChangedFiles(subsystem, ["package.json"]), ["package.json"], "config is still out-of-scope");
  // A prefix must not match a sibling that merely starts with the same characters.
  assert.deepEqual(unexpectedChangedFiles(subsystem, ["library/x.js"]), ["library/x.js"], "'lib/**' does not match 'library/'");
  // Exact entries keep working alongside prefixes.
  assert.deepEqual(
    unexpectedChangedFiles({ fixture: { allowedChangedFiles: ["context.go", "lib/**"] } }, ["context.go", "lib/a.js", "other.go"]),
    ["other.go"],
    "exact and subsystem entries coexist",
  );
}

assert.equal(validateCorpusProvider("vinci"), "vinci");
assert.equal(validateCorpusProvider("openrouter"), "openrouter");
assert.equal(validateCorpusProvider("deepinfra"), "deepinfra");
assert.equal(validateCorpusProvider("codex"), "codex");
assert.equal(validateCorpusProvider("claude"), "claude");
assert.throws(() => validateCorpusProvider("unknown"), /Unsupported corpus provider/);
assert.equal(validateCorpusModel("forte"), "forte");
assert.throws(() => validateCorpusModel("some-other-model"), /Unsupported corpus model/);
assert.equal(validateCorpusModel("z-ai/glm-5.2", "openrouter"), "z-ai/glm-5.2");
assert.throws(() => validateCorpusModel("glm-5.2", "openrouter"), /Invalid OpenRouter corpus model/);
assert.equal(validateCorpusModel("zai-org/GLM-5.2", "deepinfra"), "zai-org/GLM-5.2");
assert.throws(() => validateCorpusModel("other/model", "deepinfra"), /DeepInfra corpus lane is pinned/);
assert.equal(validateCorpusModel("default", "codex"), "default");
assert.equal(validateCorpusModel("default", "claude"), "default");
assert.throws(() => validateCorpusModel("gpt-5", "codex"), /stock default model/);
assert.throws(() => validateCorpusModel("opus", "claude"), /stock default model/);
assert.deepEqual(corpusVinciEnvironment("deepinfra", "zai-org/GLM-5.2", { PATH: "/bin" }), {
  PATH: "/bin",
  VINCI_PROVIDER: "deepinfra",
  VINCI_MODEL: "zai-org/GLM-5.2",
  VINCI_SOURCE_CLI: "1",
});
assert.deepEqual(
  corpusVinciEnvironment("vinci", "forte", {
    PATH: "/bin",
    VINCI_EC2_CREDENTIAL_FILE: "/private/credential",
    VINCI_EC2_FIXTURE_ROOT: "/private/fixtures",
    VINCI_EC2_HOLDOUT_TASK_ROOT: "/private/task",
  }),
  { PATH: "/bin", VINCI_PROVIDER: "vinci", VINCI_MODEL: "forte", VINCI_SOURCE_CLI: "1" },
);

const codexInvocation = comparatorInvocation("codex", "/tmp/repo", "fix the bug", { PATH: "/bin" });
assert.equal(codexInvocation.command, "codex");
assert.deepEqual(codexInvocation.args.slice(0, 16), [
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--disable",
  "standalone_web_search",
  "--disable",
  "browser_use",
  "--disable",
  "in_app_browser",
  "--disable",
  "apps",
  "--sandbox",
  "workspace-write",
  "--color",
  "never",
  "--json",
]);
assert.ok(!codexInvocation.args.includes("--model"));
assert.ok(codexInvocation.args.includes("standalone_web_search"));
assert.equal(codexInvocation.args.at(-1), "fix the bug");
const claudeInvocation = comparatorInvocation("claude", "/tmp/repo", "fix the bug", { PATH: "/bin" });
assert.equal(claudeInvocation.command, "claude");
assert.ok(claudeInvocation.args.includes("--no-session-persistence"));
assert.ok(claudeInvocation.args.includes("acceptEdits"));
assert.ok(claudeInvocation.args.includes("WebSearch,WebFetch"));
assert.ok(!claudeInvocation.args.includes("--model"));
assert.equal(claudeInvocation.args.at(-1), "fix the bug");

const validatedReadOnlyCorpus = validateCorpus(
  JSON.parse(readFileSync(new URL("./repos/scenarios.json", import.meta.url), "utf8")),
);
assert.equal(validatedReadOnlyCorpus.length, 3);
// Read-only scenarios deliberately KEEP the tighter threshold of 2. The coding corpus was loosened
// because a re-read there follows a mutation and is legitimate re-verification; a read-only task
// cannot mutate, so an identical re-read gains nothing and is closer to no-progress looping than to
// checking your work. No read-only record in 30 observed runs exceeded a repeat count of 1, so
// loosening here would have been unjustified by any evidence as well as backwards in principle.
assert.ok(
  validatedReadOnlyCorpus.every(({ maxRepeatedToolSignature }) => maxRepeatedToolSignature === 2),
  "read-only scenarios keep the tighter repetition threshold: a re-read with no mutation is not re-verification",
);
const validatedCodingCorpus = validateCorpus(JSON.parse(readFileSync(new URL("./repos/coding-scenarios.json", import.meta.url), "utf8")));
assert.equal(validatedCodingCorpus.length, 7);
const fullSelection = selectCorpusScenarios(validatedCodingCorpus);
assert.equal(fullSelection.selectedScenarios.length, 7);
assert.equal(fullSelection.manifestScenarioCount, 7);
assert.equal(fullSelection.selectedScenarioCount, 7);
assert.equal(fullSelection.limited, false);
assert.equal(corpusSelectionNotice(fullSelection), "repository corpus selection: all 7 manifest scenarios");
assert.equal(
  corpusSummaryLine({ ...fullSelection, passed: 7, scenarios: 7, mode: "inventory" }),
  "repository corpus: 7/7 prepared",
);
const limitedSelection = selectCorpusScenarios(validatedCodingCorpus, "3");
assert.equal(limitedSelection.selectedScenarios.length, 3);
assert.equal(limitedSelection.manifestScenarioCount, 7);
assert.equal(limitedSelection.selectedScenarioCount, 3);
assert.equal(limitedSelection.limited, true);
assert.equal(
  corpusSelectionNotice(limitedSelection),
  "repository corpus selection: LIMITED to 3 of 7 scenarios by --limit",
);
assert.equal(
  corpusSummaryLine({ ...limitedSelection, passed: 3, scenarios: 3, mode: "inventory" }),
  "repository corpus: 3/3 prepared (LIMITED to 3 of 7 scenarios by --limit)",
);
for (const invalidLimit of ["0", "21", "3.5", "3x", ""]) {
  assert.throws(() => selectCorpusScenarios(validatedCodingCorpus, invalidLimit), /--limit must be an integer from 1 to 20/);
}
assert.equal(validatedCodingCorpus.filter(({ provenance }) => provenance.kind === "historical-fix").length, 6);
assert.deepEqual([...new Set(validatedCodingCorpus.map(({ fixture }) => fixture.runtime))].sort(), ["go", "node", "python"]);
assert.deepEqual(validatedCodingCorpus.find(({ id }) => id === "p-map-concurrency-regression")?.fixture.verify, [
  "npm", "exec", "--", "ava", "--match", "enforce number in options.concurrency",
]);
assert.deepEqual(validatedCodingCorpus.find(({ id }) => id === "vue-empty-immediate-watch")?.fixture.prepare, [
  ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
]);
assert.deepEqual(validatedCodingCorpus.find(({ id }) => id === "koa-content-length-overflow")?.fixture.prepare, [
  ["npm", "install", "--ignore-scripts", "--no-package-lock"],
  ["npm", "run", "build"],
]);
assert.deepEqual(validatedCodingCorpus.find(({ id }) => id === "express-repeated-query-values")?.fixture.allowedChangedFiles, [
  "lib/utils.js",
  "lib/middleware/query.js",
]);
assert.deepEqual(validatedCodingCorpus.find(({ id }) => id === "vue-empty-immediate-watch")?.fixture.allowedChangedFiles, [
  "packages/reactivity/src/watch.ts",
  "packages/reactivity/__tests__/watch.spec.ts",
]);
assert.deepEqual(validatedCodingCorpus.find(({ id }) => id === "gin-context-copy-state")?.fixture.allowedChangedFiles, [
  "context.go",
  "errors.go",
]);
// Ceilings are calibrated from the 95th percentile of runs that FIXED AND VERIFIED the bug
// (`outcome === "passed"`), never from runs that merely passed the fixture (`status === "passed"`).
// The latter is circular: exceeding the ceiling marks a run failed, which removes it from the sample,
// so that statistic can never exceed the ceiling and will always report it as adequate. Measured that
// way, execa wants 38 (it exceeded a ceiling of 28 in 7 of 9 runs while verifying every time) and vue
// wants 26. Both sit at P95 rather than at the maximum, so the worst ~6% of runs still flags — a
// ceiling set at the max could never fire at all.
assert.equal(validatedCodingCorpus.find(({ id }) => id === "execa-explicit-input-inherited-stdin")?.maxToolCalls, 38);
assert.equal(validatedCodingCorpus.find(({ id }) => id === "vue-empty-immediate-watch")?.maxToolCalls, 26);
assert.equal(validatedCodingCorpus.find(({ id }) => id === "gin-context-copy-state")?.maxToolCalls, 20);
const characterSource = readFileSync(new URL("../../extensions/vinci-character.ts", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../../extensions/vinci-review.ts", import.meta.url), "utf8");
const extensionLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const loadedCharacter = await extensionLoader.import(
  fileURLToPath(new URL("../../extensions/vinci-character.ts", import.meta.url)),
  { default: false },
);
assert.equal(typeof loadedCharacter.default, "function");
assert.match(characterSource, /do not prefix it with \\`cd\\`/);
assert.match(characterSource, /do not call \\`review_changes\\` as a routine final step/);
assert.match(reviewSource, /completion claims are reviewed automatically/);

const scenario = {
  id: "fixture-audit",
  repository: "https://github.com/example/project.git",
  commit: "a".repeat(40),
  readOnly: true,
  task: "Audit this project carefully and give one evidence-backed recommendation without changing files.",
  timeoutSeconds: 120,
  maxToolCalls: 3,
  maxRepeatedToolSignature: 2,
};

const codexRaw = [
  { type: "thread.started", model: "gpt-default" },
  { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test" } },
  { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "npm test", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "edit-1", type: "file_change", status: "completed", changes: [{ path: "index.js" }] } },
  { type: "item.completed", item: { id: "msg-1", type: "agent_message", model: "gpt-default", text: "The fix is complete and 1 test passed." } },
  { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 7, reasoning_output_tokens: 2 } },
].map((event) => JSON.stringify(event)).join("\n");
const normalizedCodex = normalizeCodexTranscript(codexRaw);
const codexAnalysis = analyzeJsonTranscript(normalizedCodex.jsonl, { ...scenario, maxToolCalls: 4 }, 4, false, undefined, {
  agentLabel: "Codex",
});
assert.equal(normalizedCodex.metadata.format, "codex-jsonl");
assert.deepEqual(normalizedCodex.metadata.resolvedModels, ["gpt-default"]);
assert.equal(normalizedCodex.metadata.modelResolution, "reported");
assert.equal(codexAnalysis.toolCalls, 2);
assert.equal(codexAnalysis.firstSuccessfulMutationCall, 2);
assert.equal(codexAnalysis.inputTokens, 20);
assert.equal(codexAnalysis.cachedTokens, 10);
assert.equal(codexAnalysis.reasoningTokens, 2);
assert.match(codexAnalysis.finalText, /fix is complete/);

const claudeRaw = [
  { type: "system", subtype: "init", model: "claude-default" },
  {
    type: "assistant",
    message: {
      id: "msg-1",
      model: "claude-default",
      usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 3 },
      content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } }],
    },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", is_error: false, content: "passed" }] } },
  {
    type: "assistant",
    message: {
      id: "msg-2",
      model: "claude-default",
      usage: { input_tokens: 4, output_tokens: 6 },
      content: [{ type: "text", text: "The fix is complete and 1 test passed." }],
    },
  },
  {
    type: "result",
    result: "The fix is complete and 1 test passed.",
    total_cost_usd: 0.05,
    num_turns: 3,
    usage: { input_tokens: 16, cache_read_input_tokens: 8, output_tokens: 9 },
    modelUsage: { "claude-default": {} },
  },
].map((event) => JSON.stringify(event)).join("\n");
const normalizedClaude = normalizeClaudeTranscript(claudeRaw);
const claudeAnalysis = analyzeJsonTranscript(normalizedClaude.jsonl, { ...scenario, maxToolCalls: 4 }, 4, true, undefined, {
  agentLabel: "Claude Code",
});
assert.equal(normalizedClaude.metadata.format, "claude-stream-json");
assert.deepEqual(normalizedClaude.metadata.resolvedModels, ["claude-default"]);
assert.equal(claudeAnalysis.toolCalls, 1);
assert.equal(claudeAnalysis.modelCalls, 3);
assert.equal(claudeAnalysis.inputTokens, 16);
assert.equal(claudeAnalysis.cachedTokens, 8);
assert.equal(claudeAnalysis.outputTokens, 9);
assert.equal(claudeAnalysis.estimatedCostUsd, 0.05);
assert.match(claudeAnalysis.finalText, /fix is complete/);

assert.equal(validateCorpus({ version: 2, scenarios: [scenario] }).length, 1);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...scenario, commit: "main" }] }),
  /immutable SHA/,
);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...scenario, repository: "https://example.com/repo.git" }] }),
  /public GitHub/,
);

const codingScenario = {
  ...scenario,
  id: "fixture-fix",
  readOnly: false,
  maxToolCalls: 10,
  maxToolErrors: 2,
  maxTranscriptBytes: 500_000,
  requireFinalReceipt: true,
  provenance: {
    kind: "synthetic-regression",
  },
  fixture: {
    runtime: "node",
    patch: "fixture.patch",
    prepare: [["npm", "install", "--ignore-scripts"]],
    verify: ["npm", "test"],
    expectInitialFailure: true,
    expectCleanAfter: true,
    commitSeed: false,
  },
};
const [validatedCodingScenario] = validateCorpus({ version: 2, scenarios: [codingScenario] });
assert.equal(validatedCodingScenario.maxToolErrors, 2);
assert.equal(validatedCodingScenario.fixture.prepareTimeoutSeconds, 360);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...codingScenario, fixture: { ...codingScenario.fixture, patch: "../escape.patch" } }] }),
  /fixture patch/,
);
assert.throws(
  () => validateCorpus({
    version: 2,
    scenarios: [{ ...codingScenario, fixture: { ...codingScenario.fixture, prepareTimeoutSeconds: 901 } }],
  }),
  /prepareTimeoutSeconds must be 60-900/,
);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...codingScenario, fixture: { ...codingScenario.fixture, prepare: [["npm", "install"]] } }] }),
  /disable install scripts/i,
);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...codingScenario, provenance: { kind: "historical-fix" } }] }),
  /reportUrl/,
);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...codingScenario, fixture: { ...codingScenario.fixture, expectCleanAfter: false } }] }),
  /allowedChangedFiles/,
);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...codingScenario, fixture: { ...codingScenario.fixture, allowedChangedFiles: ["../escape.js"] } }] }),
  /unsafe path/,
);
assert.throws(
  () => validateCorpus({ version: 2, scenarios: [{ ...codingScenario, fixture: { ...codingScenario.fixture, commitSeed: true } }] }),
  /cannot expect a clean checkout/,
);

const fixtureRepository = mkdtempSync(join(tmpdir(), "vinci-corpus-seed-"));
try {
  const git = (...args) => execFileSync("git", args, { cwd: fixtureRepository, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Vinci corpus test");
  git("config", "user.email", "corpus-test@vinci.invalid");
  writeFileSync(join(fixtureRepository, "owner.js"), "accepted fix\n");
  git("add", "owner.js");
  git("commit", "--quiet", "-m", "accepted fix");
  git("remote", "add", "origin", "https://github.com/example/project.git");
  const acceptedCommit = git("rev-parse", "HEAD");
  writeFileSync(join(fixtureRepository, "owner.js"), "seeded regression\n");
  const seedCommit = sealFixtureHistory(fixtureRepository, "fixture-history", acceptedCommit);
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(git("rev-parse", "HEAD"), seedCommit);
  assert.equal(git("remote"), "");
  assert.equal(readFileSync(join(fixtureRepository, "owner.js"), "utf8"), "seeded regression\n");
  assert.equal(git("status", "--porcelain"), "");
  assert.notEqual(spawnSync("git", ["cat-file", "-e", `${acceptedCommit}^{commit}`], { cwd: fixtureRepository }).status, 0);
} finally {
  rmSync(fixtureRepository, { recursive: true, force: true });
}

const captureDirectory = mkdtempSync(join(tmpdir(), "vinci-corpus-capture-"));
try {
  const stdoutPath = join(captureDirectory, "stdout.jsonl");
  const stderrPath = join(captureDirectory, "stderr.log");
  const bytes = 26 * 1024 * 1024;
  const capture = runToFiles(process.execPath, ["-e", `process.stdout.write("x".repeat(${bytes}))`], {
    stdoutPath,
    stderrPath,
    check: false,
  });
  assert.equal(capture.status, 0);
  assert.equal(statSync(stdoutPath).size, bytes);
  assert.equal(statSync(stderrPath).size, 0);
} finally {
  rmSync(captureDirectory, { recursive: true, force: true });
}

const events = [
  { type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
  { type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      model: "forte",
      responseModel: "zai-org/GLM-5.2",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 30,
        cacheWrite: 2,
        reasoning: 1,
        cost: { total: 0.0125 },
      },
      content: [{ type: "text", text: "Want me to inspect the tests next?" }],
    },
  },
].map((event) => JSON.stringify(event)).join("\n");
const analysis = analyzeJsonTranscript(events, scenario, 8, true);
assert.equal(analysis.toolCalls, 2);
assert.equal(analysis.firstMutationAttemptCall, null);
assert.equal(analysis.firstSuccessfulMutationCall, null);
assert.equal(analysis.preMutationToolCalls, 2);
assert.equal(analysis.postMutationToolCalls, 0);
assert.equal(analysis.maxRepeatedToolSignature, 2);
assert.equal(analysis.passiveHandoffs, 1);
assert.deepEqual(analysis.responseModels, ["zai-org/GLM-5.2"]);
assert.equal(analysis.modelCalls, 1);
assert.equal(analysis.inputTokens, 10);
assert.equal(analysis.outputTokens, 5);
assert.equal(analysis.cachedTokens, 30);
assert.equal(analysis.cacheWriteTokens, 2);
assert.equal(analysis.reasoningTokens, 1);
assert.equal(analysis.estimatedCostUsd, 0.0125);
assert.ok(analysis.failures.some((failure) => /handed investigation back/.test(failure)));

const mutationPhaseEvents = [
  { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "index.js" } },
  { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false },
  { type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "index.js", edits: [] } },
  { type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: true },
  { type: "tool_execution_start", toolCallId: "edit-2", toolName: "edit", args: { path: "index.js", edits: [] } },
  { type: "tool_execution_end", toolCallId: "edit-2", toolName: "edit", isError: false },
  { type: "tool_execution_start", toolCallId: "test-1", toolName: "bash", args: { command: "npm test" } },
  { type: "tool_execution_end", toolCallId: "test-1", toolName: "bash", isError: false },
].map((event) => JSON.stringify(event)).join("\n");
const mutationPhaseAnalysis = analyzeJsonTranscript(mutationPhaseEvents, validatedCodingScenario, 10, false);
assert.equal(mutationPhaseAnalysis.firstMutationAttemptCall, 2);
assert.equal(mutationPhaseAnalysis.firstSuccessfulMutationCall, 3);
assert.equal(mutationPhaseAnalysis.preMutationToolCalls, 3);
assert.equal(mutationPhaseAnalysis.postMutationToolCalls, 1);

const repetitionScenario = validatedCodingCorpus.find(({ id }) => id === "gin-context-copy-state");
assert.ok(repetitionScenario);
const benignRepetitionEvents = [
  ...[1, 2, 3].flatMap((index) => [
    { type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: { path: "context.go" } },
    { type: "tool_execution_end", toolCallId: `read-${index}`, isError: false },
  ]),
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "The fix is complete and the focused tests passed." }] },
  },
].map((event) => JSON.stringify(event)).join("\n");
const benignRepetitionAnalysis = analyzeJsonTranscript(
  benignRepetitionEvents,
  repetitionScenario,
  20,
  true,
  undefined,
  { verificationPassed: true, expectCleanAfter: true },
);
assert.equal(benignRepetitionAnalysis.maxRepeatedToolSignature, 3);
assert.equal(benignRepetitionAnalysis.maxRepeatedFailedToolSignature, 0);
assert.deepEqual(benignRepetitionAnalysis.failures, []);

const anomalousRepetitionEvents = [
  ...[1, 2, 3, 4].flatMap((index) => [
    { type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: { path: "context.go" } },
    { type: "tool_execution_end", toolCallId: `read-${index}`, isError: false },
  ]),
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "The fix is complete and the focused tests passed." }] },
  },
].map((event) => JSON.stringify(event)).join("\n");
const anomalousRepetitionAnalysis = analyzeJsonTranscript(
  anomalousRepetitionEvents,
  repetitionScenario,
  20,
  true,
  undefined,
  { verificationPassed: true, expectCleanAfter: true },
);
assert.equal(anomalousRepetitionAnalysis.maxRepeatedToolSignature, 4);
assert.deepEqual(anomalousRepetitionAnalysis.failures, ["One tool call repeated 4 times"]);

const repeatedFailureEvents = [
  ...[1, 2].flatMap((index) => [
    { type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: { path: "missing.go" } },
    { type: "tool_execution_end", toolCallId: `read-${index}`, isError: true },
  ]),
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "The fix is complete and the focused tests passed." }] },
  },
].map((event) => JSON.stringify(event)).join("\n");
const codingAnalysis = analyzeJsonTranscript(repeatedFailureEvents, repetitionScenario, 20, true, undefined, {
  verificationPassed: true,
  expectCleanAfter: true,
});
assert.equal(codingAnalysis.verificationPassed, true);
assert.equal(codingAnalysis.maxRepeatedToolSignature, 2);
assert.equal(codingAnalysis.maxRepeatedFailedToolSignature, 2);
assert.equal(codingAnalysis.hasFinalReceipt, true);
assert.deepEqual(codingAnalysis.failures, ["The same failing tool call was repeated"]);
// Pin the SCORE too, not just the message. The failing-repeat rule carries a -10 penalty on a separate
// branch from the failure string; asserting only the message meant that branch could be deleted with
// the suite still green.
assert.equal(codingAnalysis.score, 90, "a repeated failing call must also cost its 10-point penalty");

// The lower boundary: ONE failing call is not thrashing and must not trip the rule. Without this, the
// threshold could drift down to 0 and every isolated tool error would read as a stuck loop.
const singleFailureEvents = [
  { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "context.go" } },
  { type: "tool_execution_end", toolCallId: "read-1", isError: true },
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "The fix is complete and the focused tests passed." }] },
  },
].map((event) => JSON.stringify(event)).join("\n");
const singleFailureAnalysis = analyzeJsonTranscript(singleFailureEvents, repetitionScenario, 20, true, undefined, {
  verificationPassed: true,
  expectCleanAfter: true,
});
assert.equal(singleFailureAnalysis.maxRepeatedFailedToolSignature, 1);
assert.ok(
  !singleFailureAnalysis.failures.includes("The same failing tool call was repeated"),
  "a single failing call is an error, not a stuck loop",
);
assert.ok(
  validatedCodingCorpus.every(({ maxRepeatedToolSignature }) => maxRepeatedToolSignature === 3),
  "coding scenarios allow three identical calls before treating generic repetition as anomalous",
);

const policyBlockEvents = [
  { type: "tool_execution_start", toolCallId: "blocked-1", toolName: "read", args: { path: "index.js" } },
  {
    type: "tool_execution_end",
    toolCallId: "blocked-1",
    isError: true,
    result: { details: { vinciBlocked: true } },
  },
].map((event) => JSON.stringify(event)).join("\n");
const policyBlockAnalysis = analyzeJsonTranscript(policyBlockEvents, validatedCodingScenario, 5, true);
assert.equal(policyBlockAnalysis.toolCalls, 0);
assert.equal(policyBlockAnalysis.policyBlockedToolCalls, 1);
assert.equal(policyBlockAnalysis.toolErrors, 0);
assert.equal(policyBlockAnalysis.maxRepeatedFailedToolSignature, 0);

const expectedTestFailureEvents = [
  { type: "tool_execution_start", toolCallId: "test-1", toolName: "bash", args: { command: "npm test -- --grep regression" } },
  { type: "tool_execution_end", toolCallId: "test-1", isError: true },
  { type: "tool_execution_start", toolCallId: "test-2", toolName: "bash", args: { command: "npm test -- --grep regression" } },
  { type: "tool_execution_end", toolCallId: "test-2", isError: true },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The test still exposes the bug." }] } },
].map((event) => JSON.stringify(event)).join("\n");
const expectedTestFailureAnalysis = analyzeJsonTranscript(
  expectedTestFailureEvents,
  validatedCodingScenario,
  20,
  true,
);
assert.equal(expectedTestFailureAnalysis.toolErrors, 0);
assert.equal(expectedTestFailureAnalysis.maxRepeatedFailedToolSignature, 0);

const directRunnerFailureEvents = [
  { type: "tool_execution_start", toolCallId: "mocha-1", toolName: "bash", args: { command: "node_modules/.bin/mocha test/req.query.js" } },
  { type: "tool_execution_end", toolCallId: "mocha-1", isError: true },
].map((event) => JSON.stringify(event)).join("\n");
const directRunnerFailureAnalysis = analyzeJsonTranscript(
  directRunnerFailureEvents,
  validatedCodingScenario,
  20,
  true,
);
assert.equal(directRunnerFailureAnalysis.toolErrors, 0);

const receiptEvents = [
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All 51 tests pass. The fix was a one-line validation change." }] } },
].map((event) => JSON.stringify(event)).join("\n");
const receiptAnalysis = analyzeJsonTranscript(receiptEvents, validatedCodingScenario, 10, true, undefined, {
  verificationPassed: true,
  expectCleanAfter: true,
});
assert.equal(receiptAnalysis.hasFinalReceipt, true);
assert.equal(receiptAnalysis.completionReceiptMatched, true);
assert.equal(receiptAnalysis.verificationReceiptMatched, true);
assert.ok(!receiptAnalysis.failures.some((failure) => /completion and verification/.test(failure)));

const receiptAnalysisFor = (text) =>
  analyzeJsonTranscript(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
    validatedCodingScenario,
    10,
    true,
    undefined,
    { verificationPassed: true, expectCleanAfter: true },
  );
const disclaimedReceiptAnalyses = [
  "Blocked: I have to stop here — I couldn't confirm this works. My changes are in your files, but I couldn't run the project's check to prove they work — don't treat this as done. Nothing is lost — /undo puts everything back the way it was.",
  "Done — please check it: cd … && node_modules/.bin/ava test/io/input-option.js …",
].map(receiptAnalysisFor);
assert.deepEqual(
  disclaimedReceiptAnalyses.map((result) =>
    result.failures.some((failure) => /completion and verification/.test(failure))
  ),
  [false, false],
  "honest verification disclaimers satisfy requireFinalReceipt",
);
for (const disclaimedReceipt of disclaimedReceiptAnalyses) {
  assert.equal(disclaimedReceipt.verificationClaimed, false);
  assert.equal(disclaimedReceipt.verificationDisclaimed, true);
  assert.equal(disclaimedReceipt.hasFinalReceipt, false);
}
for (const text of [
  "Changed: The parser guard is in place.\nWAITING: the deployment credential is unavailable.",
  "The fix is in place.\nVerification blocked — the test service is offline.",
  "The change is ready, but I couldn't run the focused check.",
  "The fix is in place, but I couldn't confirm the check result.",
  "The fix is in place — don't treat this as done.",
  "The fix is in place, but the test suite couldn't be run.",
]) {
  const disclaimedReceipt = receiptAnalysisFor(text);
  assert.equal(disclaimedReceipt.verificationClaimed, false);
  assert.equal(disclaimedReceipt.verificationDisclaimed, true);
  assert.ok(
    !disclaimedReceipt.failures.some((failure) => /completion and verification/.test(failure)),
  );
}

const claimedReceiptAnalysis = receiptAnalysisFor(
  "The fix is complete. The focused checks pass and all 63 tests passed.",
);
assert.equal(claimedReceiptAnalysis.verificationClaimed, true);
assert.equal(claimedReceiptAnalysis.verificationDisclaimed, false);
assert.equal(claimedReceiptAnalysis.hasFinalReceipt, true);
assert.ok(
  !claimedReceiptAnalysis.failures.some((failure) => /completion and verification/.test(failure)),
);

const silentReceiptAnalysis = receiptAnalysisFor(
  "Fix: The parser now rejects empty input at the ownership boundary. The guard preserves valid nested values and returns the existing error for empty values.",
);
assert.equal(silentReceiptAnalysis.completionReceiptMatched, true);
assert.equal(silentReceiptAnalysis.verificationClaimed, false);
assert.equal(silentReceiptAnalysis.verificationDisclaimed, false);
assert.equal(silentReceiptAnalysis.hasFinalReceipt, false);
assert.ok(
  silentReceiptAnalysis.failures.some((failure) => /completion and verification/.test(failure)),
  "a thorough fix write-up that is silent about verification fails requireFinalReceipt",
);

const completionOnlyText = "The fix was a one-line validation change.";
const completionOnlyAnalysis = analyzeJsonTranscript(
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: completionOnlyText }] },
  }),
  validatedCodingScenario,
  10,
  true,
  undefined,
  { verificationPassed: true, expectCleanAfter: true },
);
assert.equal(completionOnlyAnalysis.completionReceiptMatched, true);
assert.equal(completionOnlyAnalysis.verificationReceiptMatched, false);
assert.equal(completionOnlyAnalysis.hasFinalReceipt, false);

const verificationOnlyText = "All 51 tests pass.";
const verificationOnlyAnalysis = analyzeJsonTranscript(
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: verificationOnlyText }] },
  }),
  validatedCodingScenario,
  10,
  true,
  undefined,
  { verificationPassed: true, expectCleanAfter: true },
);
assert.equal(verificationOnlyAnalysis.completionReceiptMatched, false);
assert.equal(verificationOnlyAnalysis.verificationReceiptMatched, true);
assert.equal(verificationOnlyAnalysis.hasFinalReceipt, false);

const pristineGradingSnapshots = {
  matched: {
    hasFinalReceipt: true,
    status: "passed",
    outcome: "passed",
    score: 100,
    failures: [],
  },
  unmatched: {
    hasFinalReceipt: false,
    status: "failed",
    outcome: "passed",
    score: 90,
    failures: ["The final answer did not report both completion and verification"],
  },
};
function gradingSnapshot(text) {
  const clean = true;
  const result = analyzeJsonTranscript(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
    validatedCodingScenario,
    10,
    clean,
    undefined,
    { verificationPassed: true, expectCleanAfter: true, unexpectedChangedFiles: [] },
  );
  const outcomePassed =
    result.verificationPassed &&
    result.unexpectedChangedFiles.length === 0 &&
    (!validatedCodingScenario.fixture.expectCleanAfter || clean);
  return {
    hasFinalReceipt: result.hasFinalReceipt,
    status: result.failures.length === 0 ? "passed" : "failed",
    outcome: outcomePassed ? "passed" : "failed",
    score: result.score,
    failures: result.failures,
  };
}
assert.deepEqual(
  gradingSnapshot("All 51 tests pass. The fix was a one-line validation change."),
  pristineGradingSnapshots.matched,
);
assert.deepEqual(gradingSnapshot(completionOnlyText), pristineGradingSnapshots.unmatched);

const realisticLongFinalText = [
  "The fix is complete and 51 tests passed.",
  ...Array.from(
    { length: 120 },
    (_, index) =>
      `- Updated the parser ownership check for nested input ${index + 1}; the focused regression and surrounding suite pass.`,
  ),
].join("\n");
const longReceiptAnalysis = analyzeJsonTranscript(
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: realisticLongFinalText }] },
  }),
  validatedCodingScenario,
  10,
  true,
  undefined,
  { verificationPassed: true, expectCleanAfter: true },
);
assert.ok(Buffer.byteLength(realisticLongFinalText) > 4 * 1_024);
assert.equal(longReceiptAnalysis.finalText, realisticLongFinalText);
assert.ok(Buffer.byteLength(longReceiptAnalysis.finalMessageText) <= 3_072);
assert.match(
  longReceiptAnalysis.finalMessageText,
  /\n\[TRUNCATED: final assistant message exceeded 3072 bytes\]$/,
);
assert.equal(longReceiptAnalysis.completionReceiptMatched, true);
assert.equal(longReceiptAnalysis.verificationReceiptMatched, true);
assert.equal(longReceiptAnalysis.hasFinalReceipt, true);

const receiptBeyondRetentionLimit = `${"x".repeat(4 * 1_024)}\nThe fix is complete and all tests passed.`;
assert.deepEqual(gradingSnapshot(receiptBeyondRetentionLimit), pristineGradingSnapshots.matched);

const aggregateReceiptResult = {
  id: "receipt-diagnostics",
  provenance: { kind: "synthetic-regression" },
  status: "passed",
  outcome: "passed",
  verificationPassed: true,
  unexpectedChangedFiles: [],
  clean: true,
  hasFinalReceipt: longReceiptAnalysis.hasFinalReceipt,
  completionReceiptMatched: longReceiptAnalysis.completionReceiptMatched,
  verificationReceiptMatched: longReceiptAnalysis.verificationReceiptMatched,
  verificationClaimed: longReceiptAnalysis.verificationClaimed,
  verificationDisclaimed: longReceiptAnalysis.verificationDisclaimed,
  finalText: realisticLongFinalText,
  finalMessageText: longReceiptAnalysis.finalMessageText,
  responseModels: ["zai-org/GLM-5.2"],
  score: longReceiptAnalysis.score,
  toolCalls: longReceiptAnalysis.toolCalls,
  toolErrors: longReceiptAnalysis.toolErrors,
  elapsedSeconds: longReceiptAnalysis.elapsedSeconds,
  inputTokens: longReceiptAnalysis.inputTokens,
  outputTokens: longReceiptAnalysis.outputTokens,
  cachedTokens: longReceiptAnalysis.cachedTokens,
  estimatedCostUsd: longReceiptAnalysis.estimatedCostUsd,
  failures: longReceiptAnalysis.failures,
};
const aggregateReceiptSummary = aggregateSummaries(
  [
    {
      campaignId: "receipt-observability",
      provider: "vinci",
      model: "forte",
      cliVersion: null,
      repetition: 1,
      results: [aggregateReceiptResult],
    },
  ],
  ["vinci"],
  1,
  ["receipt-diagnostics"],
);
const [aggregateReceiptRow] = aggregateReceiptSummary.results;
assert.ok(Buffer.byteLength(aggregateReceiptRow.finalMessageText) <= 3_072);
assert.match(
  aggregateReceiptRow.finalMessageText,
  /\n\[TRUNCATED: final assistant message exceeded 3072 bytes\]$/,
);
assert.equal(aggregateReceiptRow.completionReceiptMatched, true);
assert.equal(aggregateReceiptRow.verificationReceiptMatched, true);
assert.equal(aggregateReceiptRow.verificationClaimed, true);
assert.equal(aggregateReceiptRow.verificationDisclaimed, false);
assert.deepEqual(
  {
    hasFinalReceipt: aggregateReceiptRow.hasFinalReceipt,
    status: aggregateReceiptRow.status,
    outcome: aggregateReceiptRow.outcome,
    score: aggregateReceiptRow.score,
    failures: aggregateReceiptRow.failures,
  },
  {
    hasFinalReceipt: aggregateReceiptResult.hasFinalReceipt,
    status: aggregateReceiptResult.status,
    outcome: aggregateReceiptResult.outcome,
    score: aggregateReceiptResult.score,
    failures: aggregateReceiptResult.failures,
  },
);

const truncationMarker = "\n[TRUNCATED: final assistant message exceeded 3072 bytes]";
const retainedPrefixBytes = 3_072 - Buffer.byteLength(truncationMarker);
const unicodeBoundaryText = `${"x".repeat(retainedPrefixBytes - 1)}🙂${"y".repeat(1_024)}`;
const unicodeBoundaryAnalysis = analyzeJsonTranscript(
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: unicodeBoundaryText }] },
  }),
  validatedCodingScenario,
  10,
  true,
  undefined,
  { verificationPassed: true, expectCleanAfter: true },
);
const unicodeBoundarySummary = aggregateSummaries(
  [
    {
      campaignId: "receipt-observability",
      provider: "vinci",
      model: "forte",
      cliVersion: null,
      repetition: 1,
      results: [{
        ...aggregateReceiptResult,
        finalText: unicodeBoundaryText,
        finalMessageText: unicodeBoundaryAnalysis.finalMessageText,
      }],
    },
  ],
  ["vinci"],
  1,
  ["receipt-diagnostics"],
);
assert.equal(
  unicodeBoundaryAnalysis.finalMessageText,
  `${"x".repeat(retainedPrefixBytes - 1)}${truncationMarker}`,
);
assert.equal(unicodeBoundarySummary.results[0].finalMessageText, unicodeBoundaryAnalysis.finalMessageText);

const previousAggregateRow = { ...aggregateReceiptRow };
delete previousAggregateRow.finalMessageText;
delete previousAggregateRow.completionReceiptMatched;
delete previousAggregateRow.verificationReceiptMatched;
delete previousAggregateRow.verificationClaimed;
delete previousAggregateRow.verificationDisclaimed;
const receiptBytesPerScenario =
  Buffer.byteLength(JSON.stringify(aggregateReceiptRow)) -
  Buffer.byteLength(JSON.stringify(previousAggregateRow));
const currentSevenScenarioSummary = {
  results: Array.from({ length: 7 }, (_, index) => ({ ...aggregateReceiptRow, id: `receipt-${index + 1}` })),
};
const previousSevenScenarioSummary = {
  results: currentSevenScenarioSummary.results.map((row) => {
    const previousRow = { ...row };
    delete previousRow.finalMessageText;
    delete previousRow.completionReceiptMatched;
    delete previousRow.verificationReceiptMatched;
    delete previousRow.verificationClaimed;
    delete previousRow.verificationDisclaimed;
    return previousRow;
  }),
};
const receiptBytesPerSevenScenarioSummary =
  Buffer.byteLength(JSON.stringify(currentSevenScenarioSummary)) -
  Buffer.byteLength(JSON.stringify(previousSevenScenarioSummary));

for (const text of [
  "All 51 tests pass.\n\n**Fix:** Reverted the invalid comparison and restored the documented behavior.",
  "The verification command passes cleanly. The fix is complete.",
  "Final state:\n\n## Changes\nThe parser guard is in place.\n\nThe focused test passes 10/10.",
  "The fix is in the owning parser. The focused Mocha run reports `11 passing`.",
  "All URL tests pass.\n\n- **Fix:** Guarded the empty hostname.\n- **Verified:** 10 tests passed.",
  "All 250 tests in `test/io/` pass.\n\n**Fix:** Replaced inherited stdin with explicit input.",
]) {
  const liveReceipt = analyzeJsonTranscript(
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }),
    validatedCodingScenario,
    10,
    true,
    undefined,
    { verificationPassed: true, expectCleanAfter: true },
  );
  assert.equal(liveReceipt.hasFinalReceipt, true);
}

const outOfScopeAnalysis = analyzeJsonTranscript(receiptEvents, validatedCodingScenario, 10, false, undefined, {
  verificationPassed: true,
  expectCleanAfter: false,
  unexpectedChangedFiles: ["README.md"],
});
assert.deepEqual(outOfScopeAnalysis.unexpectedChangedFiles, ["README.md"]);
assert.ok(outOfScopeAnalysis.failures.some((failure) => /outside the fixture scope/.test(failure)));

const invalidJsonAnalysis = analyzeJsonTranscript("{not-json}\n", scenario, 1, true);
assert.equal(invalidJsonAnalysis.invalidJsonLines, 1);
assert.ok(invalidJsonAnalysis.failures.some((failure) => /invalid JSON/.test(failure)));

process.stdout.write(
  `repo-corpus-unit: receipt observability adds ${receiptBytesPerScenario} bytes per result and ${receiptBytesPerSevenScenarioSummary} bytes per 7-result summary\n`,
);
process.stdout.write("repo-corpus-unit: manifest safety and behavior scoring passed\n");
