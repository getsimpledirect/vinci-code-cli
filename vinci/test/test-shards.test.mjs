import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { checkTestShards } from "../scripts/check-test-shards.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const harness = readFileSync(resolve(root, "vinci/test/run.sh"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/vinci-tests.yml"), "utf8");
const expected = "alpha\nbeta\ngamma\ndelta\n";
const shards = ["alpha\ndelta\n", "beta\n", "gamma\n"];
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function shell(text, environment = {}) {
	const result = spawnSync("bash", ["-c", text], {
		cwd: root,
		env: { ...process.env, ...environment },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	return result;
}

function checkMatrices(source) {
	const expressions = [...source.matchAll(/^        node: \$\{\{ (.+) \}\}$/gm)];
	assert.equal(expressions.length, 2, "both shard and gate matrices must be checked");
	for (const [, expression] of expressions) {
		for (const [eventName, draft, nodes] of [
			["pull_request", true, ["24"]],
			["pull_request", false, ["22", "24"]],
			["push", true, ["22", "24"]],
			["merge_group", false, ["22", "24"]],
		]) {
			const value = runInNewContext(
				`(${expression})`,
				{ fromJSON: JSON.parse, github: { event_name: eventName, event: { pull_request: { draft } } } },
				{ timeout: 1_000 },
			);
			assert.deepEqual(value, nodes, `draft=${draft}, event=${eventName} must yield only ${nodes.join(",")}`);
		}
	}
}

test("partition fixture passes; dropping or duplicating a group fails the same proof", () => {
	assert.equal(checkTestShards(expected, shards), 4);
	assert.throws(() => checkTestShards(expected, ["delta\n", ...shards.slice(1)]), /missing groups: "alpha"/);
	assert.throws(() => checkTestShards(expected, [shards[0], "beta\nalpha\n", shards[2]]), /duplicate groups: "alpha"/);
	assert.throws(() => checkTestShards(expected, [shards[0], shards[1], "gamma\nextra\n"]), /unexpected groups: "extra"/);
	assert.throws(() => checkTestShards(expected, shards.slice(1)), /expected "3" shard lists/);
	assert.throws(() => checkTestShards(expected, [shards[0], "", shards[2]]), /invalid or empty group list/);
	assert.throws(() => checkTestShards(`${expected}alpha\n`, shards), /duplicate labels in "expected"/);
});

test("real CLI path rejects mutations and missing artifacts, while the noop stays reachable", () => {
	const directory = mkdtempSync(join(tmpdir(), "test-shards-"));
	try {
		const expectedPath = join(directory, "expected.txt");
		writeFileSync(expectedPath, expected);
		const artifactDir = join(directory, "artifacts");
		assert.equal(shell(`mkdir ${quote(artifactDir)}`).status, 0);
		const invoke = () => spawnSync(process.execPath, [resolve(root, "vinci/scripts/check-test-shards.mjs"), expectedPath, artifactDir], {
			encoding: "utf8", timeout: 30_000,
		});
		for (const [index, text] of shards.entries()) writeFileSync(join(artifactDir, `groups-${index + 1}.txt`), text);
		assert.equal(invoke().status, 0);
		writeFileSync(join(artifactDir, "groups-1.txt"), "delta\n");
		assert.match(invoke().stderr, /missing groups: "alpha"/);
		assert.equal(invoke().status, 1);
		writeFileSync(join(artifactDir, "groups-1.txt"), shards[0]);
		writeFileSync(join(artifactDir, "groups-2.txt"), "beta\nalpha\n");
		assert.match(invoke().stderr, /duplicate groups: "alpha"/);
		assert.equal(invoke().status, 1);
		writeFileSync(join(artifactDir, "groups-2.txt"), shards[1]);
		assert.equal(invoke().status, 0);
		assert.equal(shell(`mv ${quote(join(artifactDir, "groups-3.txt"))} ${quote(join(artifactDir, "missing.txt"))}`).status, 0);
		assert.match(invoke().stderr, /invalid shard artifacts/);
		assert.equal(invoke().status, 1);
	} finally {
		assert.equal(shell(`find ${quote(directory)} -mindepth 1 -delete && rmdir ${quote(directory)}`).status, 0);
	}
});

test("both real matrix expressions keep drafts at 24; unconditional matrix mutation fails", () => {
	checkMatrices(workflow);
	const mutant = workflow.replaceAll(/^        node: .+$/gm, `        node: \u0024{{ fromJSON('["22","24"]') }}`);
	assert.throws(() => checkMatrices(mutant), /draft=true, event=pull_request must yield only 24/);
});

test("the gate's real shell step rejects failed, skipped and cancelled dependencies", () => {
	const step = workflow.match(/      - name: Require all offline shards to succeed\n[\s\S]+?        run: \|\n([\s\S]+?)(?=      - uses:)/);
	assert.ok(step, "the gate must explicitly check its dependency result");
	const script = step[1].replace(/^          /gm, "");
	for (const result of ["success", "failure", "skipped", "cancelled"]) {
		const run = shell(script, { SHARD_RESULT: result });
		assert.equal(run.status, result === "success" ? 0 : 1);
		if (result !== "success") assert.ok(run.stdout.includes(`Offline shards returned "${result}"`));
	}
});

test("run_group uses round-robin selection, times passing groups and preserves named failures", () => {
	const helpers = harness.slice(harness.indexOf("GROUP_INDEX=0"), harness.indexOf("run_cli_supervised()"));
	const calls = 'for label in alpha beta gamma delta epsilon; do run_group "$label" true; done';
	const executed = [];
	for (let shard = 1; shard <= 3; shard++) {
		const result = shell(`set -uo pipefail\nfails=0\n${helpers}\nsupervise_group() { printf 'EXEC %s\\n' "$2"; }\n${calls}`, {
			VINCI_TEST_SHARD: `${shard}/3`, VINCI_TEST_LIST_GROUPS: "0", VINCI_TEST_GROUPS_FILE: "",
		});
		assert.equal(result.status, 0, result.stderr);
		const passed = [...result.stdout.matchAll(/✓ ([a-z]+): passed after \d+s/g)].map((match) => match[1]);
		assert.deepEqual(passed, ["alpha", "beta", "gamma", "delta", "epsilon"].filter((_, index) => index % 3 === shard - 1));
		executed.push(...passed);
	}
	assert.equal(new Set(executed).size, 5);
	for (const [status, message] of [[9, "FAILED (exit 9)"], [124, "TIMED OUT"]]) {
		const result = shell(`set -uo pipefail\nfails=0\n${helpers}\nsupervise_group() { return ${status}; }\nrun_group alpha true\nprintf 'fails=%s\\n' "$fails"`, {
			VINCI_TEST_SHARD: "", VINCI_TEST_LIST_GROUPS: "0", VINCI_TEST_GROUPS_FILE: "",
		});
		assert.ok(result.stdout.includes(`alpha: ${message}`));
		assert.ok(result.stdout.includes("fails=1"));
	}
	for (const shard of ["0/3", "4/3", "1/0", "bad", "01/3", "999999999999999999999/3"]) {
		const result = shell(helpers, { VINCI_TEST_SHARD: shard });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /invalid shard/);
	}
});

test("list mode traverses the real harness before any build, package, PTY or smoke preflight", () => {
	const result = spawnSync("bash", [resolve(root, "vinci/test/run.sh")], {
		cwd: root,
		env: { ...process.env, VINCI_TEST_LIST_GROUPS: "1", VINCI_TEST_SHARD: "", VINCI_TEST_GROUPS_FILE: "/unwritable/list" },
		encoding: "utf8", timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.trim().split("\n");
	assert.ok(lines.includes("canonical-sweep"));
	assert.ok(lines.includes("packaged-tarball"));
	assert.ok(lines.includes("packaged-artifact-imports"));
	assert.ok(lines.includes("ui-crew-status"));
	assert.ok(lines.every((line) => /^[a-z0-9][a-z0-9-]*$/.test(line)));
	assert.equal(lines.length, new Set(lines).size);
});
