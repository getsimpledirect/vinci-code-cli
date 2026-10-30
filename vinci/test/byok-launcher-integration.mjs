import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherDiagnostics, launcherEnvironment, launcherStatus } from "./launcher-diagnostics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const launcher = resolve(root, "vinci/bin/vinci");
const home = mkdtempSync(resolve(tmpdir(), "vinci-byok-version-"));
const baseEnv = launcherEnvironment(process.env.PATH ?? "/usr/bin:/bin", home);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const timeoutMs = 60_000;

const flagCases = [
	["--provider", "openai"],
	["--provider=openai"],
	["--model", "openai/gpt-4o-mini"],
	["--model=openai/gpt-4o-mini"],
	["--models", "openai/gpt-4o-mini"],
	["--models=openai/gpt-4o-mini"],
	["--api-key", "test-key"],
	["--api-key=test-key"],
];

// Each case is an independent launcher spawn; accepted cases now also run concurrently,
// bounded so a small runner is not oversubscribed.
function run(args, value) {
	const env = value === undefined ? baseEnv : { ...baseEnv, VINCI_SHOW_OTHER_PROVIDERS: value };
	const started = performance.now();
	return new Promise((resolveRun) => {
		execFile(
			"bash",
			[launcher, ...args, "--version"],
			{ cwd: root, encoding: "utf8", env, timeout: timeoutMs },
			(error, stdout, stderr) => {
				resolveRun({
					status: launcherStatus(error), stdout: stdout ?? "", stderr: stderr ?? "",
					diagnostic: launcherDiagnostics(error, stdout, stderr, performance.now() - started, timeoutMs),
				});
			},
		);
	});
}

// Resolve every (case, env) pair up front, then assert over the settled results.
async function runAll(value) {
	return Promise.all(flagCases.map((args) => run(args, value)));
}

// HOST-RUN: these accepted flags dispatch through tsx. The version path sends no prompt.
const accepted = [["--model", "forte"], ["--provider", "vinci"], ["--provider=VINCI"]];
for (const flag of ["--model", "--models"]) {
	for (const id of ["auto", "mezzo", "forte", "fortissimo"]) {
		for (const value of [id, `vinci/${id}`, `VINCI/${id.toUpperCase()}`]) {
			accepted.push([flag, value], [`${flag}=${value}`]);
		}
	}
}
const acceptedCases = [];
for (const value of process.argv.includes("--forte-only") ? [undefined] : [undefined, "0"]) {
	for (const args of process.argv.includes("--forte-only") ? accepted.slice(0, 1) : accepted) {
		acceptedCases.push({ args, value });
	}
}
const acceptedResults = new Array(acceptedCases.length);
let nextAcceptedCase = 0;
const concurrency = Math.max(1, Math.min(4, availableParallelism()));
await Promise.all(
	Array.from({ length: Math.min(concurrency, acceptedCases.length) }, async () => {
		while (nextAcceptedCase < acceptedCases.length) {
			const index = nextAcceptedCase++;
			const { args, value } = acceptedCases[index];
			acceptedResults[index] = await run(args, value);
		}
	}),
);
for (const [index] of acceptedCases.entries()) {
	const result = acceptedResults[index];
	const message = `managed launcher case ${index + 1}: ${result.diagnostic}`;
	assert.equal(result.status, 0, message);
	assert.equal(/^\d+\.\d+\.\d+$/.test(result.stdout.trim()), true, `${message}: must reach normal dispatch`);
}
if (process.argv.includes("--forte-only")) {
	process.stdout.write("byok-launcher-integration: vinci --model forte accepted\n");
	process.exit(0);
}

// T8: catch the launcher default before dispatching an external runtime.
assert.match(readFileSync(launcher, "utf8"), /\$\{VINCI_SHOW_OTHER_PROVIDERS:-0\}/, "T8 launcher defaults to managed-only");

// A fresh launch keeps the managed account boundary until the user opts in.
const defaultResults = await runAll(undefined);
for (const [i] of flagCases.entries()) {
	const result = defaultResults[i];
	assert.equal(result.status, 2, `default rejection case ${i + 1}: ${result.diagnostic}`);
	assert.equal(/Other providers are off/.test(result.stderr), true, `default boundary case ${i + 1}: ${result.diagnostic}`);
}

// Explicit opt-in still reaches the other providers.
const optInResults = await runAll("1");
for (const [i] of flagCases.entries()) {
	const result = optInResults[i];
	assert.equal(result.status, 0, `opt-in case ${i + 1}: ${result.diagnostic}`);
	assert.equal(/^\d+\.\d+\.\d+$/.test(result.stdout.trim()), true, `opt-in version case ${i + 1}: ${result.diagnostic}`);
}

// Explicit opt-out restores the managed-only boundary, so a managed user cannot accidentally
// bypass the class their account resolved.
const optOutResults = await runAll("0");
for (const [i] of flagCases.entries()) {
	const result = optOutResults[i];
	assert.equal(result.status, 2, `opt-out rejection case ${i + 1}: ${result.diagnostic}`);
	assert.equal(/Other providers are off/.test(result.stderr), true, `opt-out boundary case ${i + 1}: ${result.diagnostic}`);
}

process.stdout.write(
	`byok-launcher-integration: ${accepted.length * 2} managed flag cases accepted; default and explicit opt-out reject all ${flagCases.length} other-provider flags; explicit opt-in accepts them\n`,
);
