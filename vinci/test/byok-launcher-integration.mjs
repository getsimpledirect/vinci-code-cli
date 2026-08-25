import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const launcher = resolve(root, "vinci/bin/vinci");
const { VINCI_SHOW_OTHER_PROVIDERS: _ignored, ...inheritedEnv } = process.env;
const baseEnv = { ...inheritedEnv, VINCI_SOURCE_CLI: "1" };

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

function run(args, value) {
	const env = value === undefined ? baseEnv : { ...baseEnv, VINCI_SHOW_OTHER_PROVIDERS: value };
	return spawnSync("bash", [launcher, ...args, "--version"], { cwd: root, encoding: "utf8", env });
}

// 🔴 DEFAULT (nothing set) MUST ACCEPT. Vinci Code is an open-source client: someone who clones it
// and has their own provider key must be able to work immediately, with no Vinci account. This case
// is the whole point — it previously asserted the opposite, and nothing caught that, because this
// file was not wired into vinci/test/run.sh at all.
for (const args of flagCases) {
	const result = run(args, undefined);
	assert.equal(result.status, 0, `default must ACCEPT ${args[0]} — no account required: ${result.stderr}`);
	assert.doesNotMatch(
		result.stderr,
		/managed Vinci model class/,
		`default must not tell a BYOK user ${args[0]} is unsupported`,
	);
	assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/, `${args[0]} must reach normal dispatch`);
}

// Explicit opt-in behaves the same as the default.
for (const args of flagCases) {
	const result = run(args, "1");
	assert.equal(result.status, 0, `VINCI_SHOW_OTHER_PROVIDERS=1 must allow ${args[0]}: ${result.stderr}`);
	assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
}

// Explicit opt-out restores the managed-only boundary, so a managed user cannot accidentally
// bypass the class their account resolved.
for (const args of flagCases) {
	const result = run(args, "0");
	assert.equal(result.status, 2, `VINCI_SHOW_OTHER_PROVIDERS=0 must reject ${args[0]}`);
	assert.match(result.stderr, /managed Vinci model class/);
}

process.stdout.write(
	`byok-launcher-integration: default and =1 ACCEPT all ${flagCases.length} provider flags (no account required); =0 restores the managed-only boundary\n`,
);
