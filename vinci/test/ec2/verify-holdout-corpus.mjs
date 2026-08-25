import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
const ALLOWED_COMMANDS = new Set(["node", "npm", "pnpm", "uv", "go", "cargo", "make"]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `Missing value for ${name}`);
  return value;
}

export function validateHoldoutVerification(raw) {
  assert.equal(raw?.version, 1, "Holdout verification manifest version must be 1");
  assert.ok(Array.isArray(raw.scenarios) && raw.scenarios.length > 0, "Holdout verification needs scenarios");
  const ids = new Set();
  return raw.scenarios.map((scenario) => {
    assert.match(scenario.id ?? "", SAFE_ID, "Holdout scenario id must be a stable slug");
    assert.ok(!ids.has(scenario.id), `Duplicate holdout scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(
      Array.isArray(scenario.allowedChangedFiles) && scenario.allowedChangedFiles.length >= 1 && scenario.allowedChangedFiles.length <= 12,
      `${scenario.id}: allowedChangedFiles must contain 1-12 paths`,
    );
    assert.ok(
      scenario.allowedChangedFiles.every((path) => typeof path === "string" && SAFE_PATH.test(path)),
      `${scenario.id}: allowedChangedFiles contains an unsafe path`,
    );
    assert.ok(Array.isArray(scenario.commands) && scenario.commands.length >= 1 && scenario.commands.length <= 4, `${scenario.id}: commands must contain 1-4 commands`);
    for (const command of scenario.commands) {
      assert.ok(Array.isArray(command) && command.length >= 1 && command.length <= 20, `${scenario.id}: command must be an argument array`);
      assert.ok(command.every((token) => typeof token === "string" && token.length > 0 && token.length <= 300), `${scenario.id}: command has an invalid argument`);
      assert.ok(ALLOWED_COMMANDS.has(command[0]), `${scenario.id}: command executable is not allowlisted`);
    }
    return scenario;
  });
}

function run(command, checkout, verifierRoot, timeoutSeconds) {
  const args = command.slice(1).map((token) => token.replaceAll("$VERIFIER_ROOT", verifierRoot));
  return spawnSync(command[0], args, {
    cwd: checkout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", VINCI_HOLDOUT_REPOSITORY: checkout },
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
    timeout: timeoutSeconds * 1_000,
  });
}

function changedFiles(checkout) {
  const tracked = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: checkout, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: checkout, encoding: "utf8" });
  assert.equal(untracked.status, 0, untracked.stderr);
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean))].sort();
}

export function verifyHoldoutScenario(scenario, checkout, verifierRoot, output) {
  const files = changedFiles(checkout);
  const allowed = new Set(scenario.allowedChangedFiles);
  const unexpectedChangedFiles = files.filter((file) => !allowed.has(file));
  const commandResults = scenario.commands.map((command, index) => {
    const result = run(command, checkout, verifierRoot, scenario.timeoutSeconds ?? 600);
    writeFileSync(join(output, `hidden-verification-${index + 1}.stdout.log`), result.stdout ?? "");
    writeFileSync(join(output, `hidden-verification-${index + 1}.stderr.log`), result.stderr ?? "");
    return {
      command: [command[0], ...command.slice(1).map((token) => token.includes("$VERIFIER_ROOT") ? "<hidden-verifier>" : token)],
      exitCode: result.status,
      signal: result.signal,
      processError: result.error instanceof Error ? result.error.message : null,
      passed: result.status === 0,
    };
  });
  const failures = [
    ...unexpectedChangedFiles.map((file) => `Changed file outside allowed scope: ${file}`),
    ...commandResults.filter(({ passed }) => !passed).map((_, index) => `Hidden verification command ${index + 1} failed`),
  ];
  return {
    id: scenario.id,
    passed: failures.length === 0,
    changedFiles: files,
    unexpectedChangedFiles,
    commandResults,
    failures,
  };
}

function main() {
  const input = resolve(option("--input", "vinci-test-artifacts/holdout"));
  const manifestPath = resolve(option("--manifest", "holdout-verification.json"));
  const verifierRoot = resolve(option("--verifier-root", dirname(manifestPath)));
  const output = resolve(option("--output", join(input, "hidden-verification.json")));
  const scenarios = validateHoldoutVerification(JSON.parse(readFileSync(manifestPath, "utf8")));
  const results = scenarios.map((scenario) => {
    const scenarioOutput = join(input, scenario.id);
    mkdirSync(scenarioOutput, { recursive: true });
    return verifyHoldoutScenario(scenario, join(input, "work", scenario.id), verifierRoot, scenarioOutput);
  });
  const report = {
    version: 1,
    scenarios: results.length,
    passed: results.filter(({ passed }) => passed).length,
    failed: results.filter(({ passed }) => !passed).length,
    results,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`holdout hidden verification: ${report.passed}/${report.scenarios} passed\n`);
  if (report.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
