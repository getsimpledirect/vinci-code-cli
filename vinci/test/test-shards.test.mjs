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

function parseWorkflow(source) {
	const result = spawnSync("python3", ["-I", "-c", "import json, sys, yaml; json.dump(yaml.safe_load(sys.stdin), sys.stdout)"], {
		input: source, encoding: "utf8", timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `isolated workflow YAML parse must succeed: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

function effectiveMatrix(matrix, eventName, draft) {
	const evaluate = (value) => typeof value === "string" && value.startsWith("${{")
		? runInNewContext(`(${value.slice(3, -2)})`, {
			fromJSON: JSON.parse, github: { event_name: eventName, event: { pull_request: { draft } } },
		}, { timeout: 1_000 }) : value;
	const axes = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude");
	let original = axes.length ? [{}] : [];
	for (const [key, expression] of axes) {
		const values = evaluate(expression);
		assert.ok(Array.isArray(values), `matrix axis ${key} must evaluate to an array`);
		original = original.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
	}
	const matches = (row, pattern) => Object.entries(pattern).every(([key, value]) => row[key] === value);
	const exclude = evaluate(matrix.exclude ?? []);
	const include = evaluate(matrix.include ?? []);
	assert.ok(Array.isArray(exclude) && Array.isArray(include), "matrix include/exclude must be arrays");
	original = original.filter((row) => !exclude.some((pattern) => matches(row, pattern)));
	const expanded = original.map((row) => ({ ...row }));
	const added = [];
	for (const entry of include) {
		let merged = false;
		for (const [index, row] of original.entries()) {
			if (Object.entries(entry).every(([key, value]) => !(key in row) || row[key] === value)) {
				Object.assign(expanded[index], entry);
				merged = true;
			}
		}
		if (!merged) added.push({ ...entry });
	}
	return [...expanded, ...added];
}

function checkMatrices(source) {
	const jobs = parseWorkflow(source).jobs;
	for (const name of ["offline-shard", "offline"]) {
		const matrix = jobs[name]?.strategy?.matrix;
		assert.ok(matrix, `the ${name} matrix must exist`);
		for (const [eventName, draft, nodes] of [
			["pull_request", true, ["24"]],
			["pull_request", false, ["22", "24"]],
			["push", true, ["22", "24"]],
			["merge_group", false, ["22", "24"]],
		]) {
			const rows = effectiveMatrix(matrix, eventName, draft);
			assert.deepEqual([...new Set(rows.map((row) => row.node))], nodes,
				`draft=${draft}, event=${eventName} must yield only ${nodes.join(",")}`);
			if (name === "offline") assert.deepEqual(rows.map((row) => `offline (${Object.values(row).join(", ")})`),
				nodes.map((node) => `offline (${node})`), "offline gate effective matrix must produce exactly its required check names");
		}
	}
}

function gateStep() {
	const gate = parseWorkflow(workflow).jobs.offline;
	assert.ok(gate, "the required offline gate job must exist");
	assert.deepEqual(gate.needs, ["offline-shard"], "offline gate must depend on all offline shards");
	assert.equal(gate.if, "always()", "offline gate must run even when a shard fails");
	assert.equal(gate.name, undefined, "offline gate must retain its automatic required-check names");
	const rows = effectiveMatrix(gate.strategy.matrix, "pull_request", false);
	assert.deepEqual(rows.map((row) => `offline (${Object.values(row).join(", ")})`), ["offline (22)", "offline (24)"],
		"offline gate effective matrix must produce exactly its required check names");
	const steps = gate.steps.filter((step) => step.name === "Require all offline shards to succeed");
	assert.equal(steps.length, 1, "the gate job must contain exactly one dependency-result step");
	const step = steps[0];
	assert.equal(step.env?.SHARD_RESULT, "${{ needs.offline-shard.result }}",
		"the gate step must bind SHARD_RESULT to its real dependency result");
	assert.equal(typeof step.run, "string", "the gate step must execute its dependency-result script");
	return step.run;
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
	const script = gateStep();
	for (const result of ["success", "failure", "skipped", "cancelled"]) {
		const run = shell(script, { SHARD_RESULT: result });
		assert.equal(run.status, result === "success" ? 0 : 1);
		if (result !== "success") assert.ok(run.stdout.includes(`Offline shards returned "${result}"`));
	}
});

for (const [label, value] of [["missing", undefined], ["empty", ""], ["malformed", "success failure"], ["unknown", "unknown"]]) {
	test(`the gate rejects ${label} dependency result`, () => {
		const script = gateStep();
		const run = value === undefined ? shell(`unset SHARD_RESULT\n${script}`) : shell(script, { SHARD_RESULT: value });
		assert.equal(run.status, 1, `gate must reject ${label} dependency result`);
		assert.ok(run.stdout.includes(`Offline shards returned "${value ?? ""}"`), `gate must diagnose ${label} dependency result`);
		assert.equal(shell(script, { SHARD_RESULT: "success" }).status, 0, "the same gate must accept success");
	});
}

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


test("record_group_pass writes only selected successful groups and reports artifact write errors", () => {
	const helpers = harness.slice(harness.indexOf("GROUP_INDEX=0"), harness.indexOf("run_cli_supervised()"));
	const directory = mkdtempSync(join(tmpdir(), "test-shard-records-"));
	try {
		const labels = ["alpha", "beta", "gamma", "delta", "epsilon"];
		for (let shard = 1; shard <= 3; shard++) {
			const artifact = join(directory, `groups-${shard}.txt`);
			writeFileSync(artifact, "");
			const result = shell(`set -uo pipefail
fails=0
${helpers}
supervise_group() { case "$3" in beta) return 9;; gamma) return 124;; esac; return 0; }
for label in alpha beta gamma delta epsilon; do run_group "$label" true "$label"; done
printf 'fails=%s\\n' "$fails"`, {
				VINCI_TEST_SHARD: `${shard}/3`, VINCI_TEST_LIST_GROUPS: "0", VINCI_TEST_GROUPS_FILE: artifact,
			});
			assert.equal(result.status, 0, result.stderr);
			const selected = labels.filter((_, index) => index % 3 === shard - 1);
			const successful = selected.filter((label) => label !== "beta" && label !== "gamma");
			assert.equal(readFileSync(artifact, "utf8"), successful.length ? `${successful.join("\n")}\n` : "",
				`shard ${shard} must record only its successful groups`);
			assert.ok(result.stdout.includes(`fails=${selected.length - successful.length}`),
				"failed and timed out groups must increment the failure count");
		}
		const error = shell(`set -uo pipefail
fails=0
${helpers}
supervise_group() { return 0; }
run_group alpha true
status=$?
printf 'group_status=%s\\nfails=%s\\n' "$status" "$fails"`, {
			VINCI_TEST_SHARD: "", VINCI_TEST_LIST_GROUPS: "0", VINCI_TEST_GROUPS_FILE: directory,
		});
		assert.equal(error.status, 0, error.stderr);
		assert.match(error.stdout, /^group_status=1$/m, "artifact write errors must fail run_group");
		assert.match(error.stdout, /^fails=1$/m, "artifact write errors must increment fails");
		assert.ok(error.stderr.includes('cannot record group "alpha"'), "artifact write errors must name the group");
		assert.ok(error.stderr.includes(`in "${directory}"`), "artifact write errors must name the artifact path");
	} finally {
		assert.equal(shell(`find ${quote(directory)} -mindepth 1 -delete && rmdir ${quote(directory)}`).status, 0);
	}
});

for (const missingParent of [true, false]) {
	test(`record_group_pass handles ${missingParent ? "a missing parent directory" : "an empty artifact path"}`, () => {
		const helpers = harness.slice(harness.indexOf("GROUP_INDEX=0"), harness.indexOf("run_cli_supervised()"));
		const directory = mkdtempSync(join(tmpdir(), "test-shard-path-"));
		try {
			const artifact = missingParent ? join(directory, "missing", "groups.txt") : "";
			const run = shell(`set -uo pipefail
fails=0
${helpers}
record_group_pass alpha
status=$?
printf 'record_status=%s\\nfails=%s\\n' "$status" "$fails"`, {
				VINCI_TEST_SHARD: "", VINCI_TEST_LIST_GROUPS: "0", VINCI_TEST_GROUPS_FILE: artifact,
			});
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, new RegExp(`^record_status=${missingParent ? 1 : 0}$`, "m"),
				missingParent ? "missing-parent artifact writes must fail" : "empty artifact path must disable recording successfully");
			assert.match(run.stdout, new RegExp(`^fails=${missingParent ? 1 : 0}$`, "m"));
			if (missingParent) {
				assert.ok(run.stderr.includes('cannot record group "alpha"'));
				assert.ok(run.stderr.includes(`in "${artifact}"`));
			} else assert.equal(run.stderr, "", "disabled recording must not attempt an empty-path write");
		} finally {
			assert.equal(shell(`find ${quote(directory)} -mindepth 1 -delete && rmdir ${quote(directory)}`).status, 0);
		}
	});
}
