import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = dirname(fileURLToPath(import.meta.url));
const checker = resolve(testRoot, "../scripts/check-canonical-verdicts.mjs");
const fixtures = resolve(testRoot, "fixtures/canonical-sweep");

const flagged = [
	"comparison-chain.ts",
	"switch.ts",
	"array-gate.ts",
	"set-gate.ts",
	"includes.ts",
	"launcher-regex-copy.mjs",
];
const allowed = ["type-union.ts", "display-string.ts", "marker.ts"];

function run(fixture) {
	return spawnSync(process.execPath, [checker, resolve(fixtures, fixture)], { encoding: "utf8" });
}

for (const fixture of flagged) {
	const result = run(fixture);
	assert.equal(result.status, 1, `${fixture} was not flagged:\n${result.stdout}${result.stderr}`);
	assert.match(`${result.stdout}${result.stderr}`, new RegExp(`${fixture}:\\d+`));
	console.log(`  ✓ flags ${fixture}`);
}

for (const fixture of allowed) {
	const result = run(fixture);
	assert.equal(result.status, 0, `${fixture} was rejected:\n${result.stdout}${result.stderr}`);
	console.log(`  ✓ allows ${fixture}`);
}

console.log(`\ncanonical-sweep: ${flagged.length + allowed.length}/${flagged.length + allowed.length} fixtures passed`);
