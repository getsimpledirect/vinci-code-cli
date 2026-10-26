import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const launcher = resolve(root, "vinci/bin/vinci");
const { VINCI_SHOW_OTHER_PROVIDERS: _ignored, ...inheritedEnv } = process.env;
const baseEnv = {
	...inheritedEnv, VINCI_SOURCE_CLI: "1", VINCI_NO_BOOTSTRAP_HEAL: "1",
	VINCI_TOOL_BOOTSTRAP: "0", VINCI_UPDATE_DISABLED: "1", PI_OFFLINE: "1",
};

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

// Each case is an independent launcher spawn, so they run CONCURRENTLY. Sequentially this was 24
// Node startups back to back: ~23s locally but ~54s on a CI runner, against this harness's 300s
// group ceiling. A contended runner ate the remaining headroom and the group was killed at 302s —
// on a tree byte-identical to one that had passed minutes earlier. Slow-but-passing is how a test
// arrives at flaky; the fix is to stop paying for the serialisation, not to raise the ceiling.
function run(args, value) {
	const env = value === undefined ? baseEnv : { ...baseEnv, VINCI_SHOW_OTHER_PROVIDERS: value };
	return new Promise((resolveRun) => {
		execFile(
			"bash",
			[launcher, ...args, "--version"],
			{ cwd: root, encoding: "utf8", env, timeout: 60_000 },
			(error, stdout, stderr) => {
				resolveRun({ status: error ? (error.code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
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
for (const value of process.argv.includes("--forte-only") ? [undefined] : [undefined, "0"]) {
	for (const args of process.argv.includes("--forte-only") ? accepted.slice(0, 1) : accepted) {
		const result = await run(args, value);
		assert.equal(result.status, 0, `vinci ${args.join(" ")} accepted`);
		assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/, "accepted Vinci flags must reach normal dispatch");
	}
}
if (process.argv.includes("--forte-only")) {
	process.stdout.write("byok-launcher-integration: vinci --model forte accepted\n");
	process.exit(0);
}

// T8: catch the launcher default before dispatching an external runtime.
assert.match(readFileSync(launcher, "utf8"), /\$\{VINCI_SHOW_OTHER_PROVIDERS:-0\}/, "T8 launcher defaults to managed-only");

// A fresh launch keeps the managed account boundary until the user opts in.
const defaultResults = await runAll(undefined);
for (const [i, args] of flagCases.entries()) {
	const result = defaultResults[i];
	assert.equal(result.status, 2, `default must reject ${args[0]}`);
	assert.match(result.stderr, /Other providers are off/);
}

// Explicit opt-in still reaches the other providers.
const optInResults = await runAll("1");
for (const [i, args] of flagCases.entries()) {
	const result = optInResults[i];
	assert.equal(result.status, 0, `VINCI_SHOW_OTHER_PROVIDERS=1 must allow ${args[0]}: ${result.stderr}`);
	assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
}

// Explicit opt-out restores the managed-only boundary, so a managed user cannot accidentally
// bypass the class their account resolved.
const optOutResults = await runAll("0");
for (const [i, args] of flagCases.entries()) {
	const result = optOutResults[i];
	assert.equal(result.status, 2, `VINCI_SHOW_OTHER_PROVIDERS=0 must reject ${args[0]}`);
	assert.match(result.stderr, /Other providers are off/);
}

process.stdout.write(
	`byok-launcher-integration: ${accepted.length * 2} managed flag cases accepted; default and explicit opt-out reject all ${flagCases.length} other-provider flags; explicit opt-in accepts them\n`,
);
