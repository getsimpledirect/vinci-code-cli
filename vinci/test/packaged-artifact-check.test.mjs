import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = process.env.VINCI_PACKAGED_CHECKER
	?? fileURLToPath(new URL("./packaged-artifact-check.mjs", import.meta.url));
const resolverSource = readFileSync(new URL("../scripts/resolve-dispatch.mjs", import.meta.url), "utf8");
const fixtureRoots = [];

const manifest = {
	schema: "vinci.node-dispatches/v1",
	dispatches: [
		{ command: "report-wrong", target: "scripts/report-wrong.mjs" },
		{ command: "worker", target: "worker/worker.mjs" },
	],
};

const launcher = `#!/usr/bin/env bash
set -euo pipefail
SELF="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "\${SELF}/../.." && pwd)"
VINCI="\${ROOT}/vinci"
set +e
_vinci_dispatch_target="$(
  node "\${VINCI}/scripts/resolve-dispatch.mjs" \\
    "\${VINCI}/dispatch-manifest.json" "$1"
)"
_vinci_dispatch_status=$?
set -e
case "\${_vinci_dispatch_status}" in
  0)
    shift
    exec node "\${VINCI}/\${_vinci_dispatch_target}" "$@"
    ;;
  3) ;;
  *) exit "\${_vinci_dispatch_status}" ;;
esac
unset _vinci_dispatch_target _vinci_dispatch_status
if [ "\${1:-}" = "verify" ]; then
  shift
  exec "\${_vinci_vac_cli}" "$@"
fi
`;

function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "vinci-packaged-check-"));
	fixtureRoots.push(root);
	write(join(root, "package.json"), JSON.stringify({ type: "module" }));
	write(join(root, "vinci", "identity.json"), JSON.stringify({ productName: "Vinci Code", command: "vinci" }));
	write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(manifest));
	write(join(root, "vinci", "bin", "vinci"), launcher);
	write(join(root, "vinci", "scripts", "resolve-dispatch.mjs"), resolverSource);
	write(
		join(root, "vinci", "scripts", "report-wrong.mjs"),
		'import "./report-helper.mjs";\nconsole.log(`report-wrong reached: ${process.argv[2]}`);\n',
	);
	write(join(root, "vinci", "scripts", "report-helper.mjs"), "export const ready = true;\n");
	write(
		join(root, "vinci", "worker", "worker.mjs"),
		'import { run } from "./run.mjs";\nconsole.log(`worker reached: ${process.argv[2]} ${run}`);\n',
	);
	write(join(root, "vinci", "worker", "run.mjs"), 'import{ready}from"./contracts/load.cjs";\nexport const run = ready;\n');
	write(
		join(root, "vinci", "worker", "contracts", "load.cjs"),
		'const digest = require("./digest.cjs");\nmodule.exports = { ready: digest.ready };\n',
	);
	write(join(root, "vinci", "worker", "contracts", "digest.cjs"), "module.exports = { ready: true };\n");
	write(join(root, "vinci", "extensions", "entry.ts"), 'import "./side-effect.js";\n');
	write(join(root, "vinci", "extensions", "side-effect.js"), "export {};\n");
	return root;
}

function run(root, cwd = tmpdir()) {
	return spawnSync(process.execPath, [checker, root], { cwd, encoding: "utf8", timeout: 10_000 });
}

function runLauncher(root, args) {
	return spawnSync("bash", [join(root, "vinci", "bin", "vinci"), ...args], {
		cwd: tmpdir(),
		encoding: "utf8",
		timeout: 10_000,
	});
}

function expectFailure(result, pattern) {
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, pattern);
}

test.after(() => {
	for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

test("positive control validates every manifest target and recursive dependency", () => {
	const root = fixture();
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /2 manifest-driven launcher dispatches/);
	assert.match(result.stdout, /7 dispatch files\/4 imports/);
});

test("positive reachability control executes every manifest command through the launcher", () => {
	const root = fixture();
	const report = runLauncher(root, ["report-wrong", "alpha"]);
	assert.equal(report.status, 0, report.stderr);
	assert.match(report.stdout, /report-wrong reached: alpha/);
	const worker = runLauncher(root, ["worker", "beta"]);
	assert.equal(worker.status, 0, worker.stderr);
	assert.match(worker.stdout, /worker reached: beta true/);
});

test("an extensionless manifest target is verified and reachable", () => {
	const root = fixture();
	const changed = structuredClone(manifest);
	changed.dispatches[1].target = "worker/run-worker";
	write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(changed));
	write(join(root, "vinci", "worker", "run-worker"), 'console.log(`extensionless reached: ${process.argv[2]}`);\n');
	const checked = run(root);
	assert.equal(checked.status, 0, checked.stderr);
	const reached = runLauncher(root, ["worker", "gamma"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /extensionless reached: gamma/);
});

test("old package behavior fails when the worker target is absent", () => {
	const root = fixture();
	rmSync(join(root, "vinci", "worker"), { recursive: true });
	expectFailure(run(root), /dispatch target worker has wrong case or is missing/);
});

test("fault restoration fails when a transitive side-effect dependency is absent", () => {
	const root = fixture();
	rmSync(join(root, "vinci", "worker", "contracts", "digest.cjs"));
	expectFailure(run(root), /worker\/contracts\/load\.cjs -> \.\/digest\.cjs/);
});

test("zero-target discovery is a refusal", () => {
	const root = fixture();
	write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify({ ...manifest, dispatches: [] }));
	expectFailure(run(root), /wrong schema or no dispatches/);
});

test("the manifest resolver and exec are each mandatory and unique", () => {
	for (const changedLauncher of [
		launcher.replace("node \"\${VINCI}/scripts/resolve-dispatch.mjs\"", "node \"\${VINCI}/scripts/other.mjs\""),
		launcher.replace("exec node \"\${VINCI}/\${_vinci_dispatch_target}\" \"$@\"", "node \"\${VINCI}/\${_vinci_dispatch_target}\" \"$@\""),
		`${launcher}\nexec node "\${VINCI}/\${_vinci_dispatch_target}" "$@"\n`,
	]) {
		const root = fixture();
		write(join(root, "vinci", "bin", "vinci"), changedLauncher);
		expectFailure(run(root), /unmanifested executable dispatch|exactly one reviewed/);
	}
});

test("quote-split, direct, alternate, and extensionless dispatches are rejected", () => {
	for (const addition of [
		'e""xec node "${VINCI}/missing.mjs" "$@"',
		'node "${VINCI}/missing.mjs"',
		'env node "${VINCI}/missing.mjs"',
		'bash "${VINCI}/missing.sh"',
		'node "${VINCI}/missing"',
	]) {
		const root = fixture();
		write(join(root, "vinci", "bin", "vinci"), `${launcher}\n${addition}\n`);
		expectFailure(run(root), /unmanifested executable dispatch/);
	}
});

test("multiline command substitutions and backticks cannot hide a dispatch", () => {
	for (const addition of [
		'target="${VINCI}/missing.mjs"\nresult="$(\n  node "$target"\n)"',
		'target="${VINCI}/missing.mjs"\nresult="`\n  node "$target"\n`"',
	]) {
		const root = fixture();
		write(join(root, "vinci", "bin", "vinci"), `${launcher}\n${addition}\n`);
		expectFailure(run(root), /unmanifested executable dispatch/);
	}
});

test("a variable-indirected Vinci target cannot hide a dispatch", () => {
	const root = fixture();
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\ntarget="${"${VINCI}"}/missing.mjs"\nnode "$target"\n`,
	);
	expectFailure(run(root), /unmanifested executable dispatch/);
});

for (const [label, dispatch] of [
	["ROOT alias", 'node "${ROOT}/vinci/hidden.mjs" "$@"'],
	["SELF alias", 'node "${SELF}/../hidden.mjs" "$@"'],
	["nested default", 'node "${_vinci_absent:-${VINCI}/hidden.mjs}" "$@"'],
]) {
	test(`${label} cannot hide an executable artifact path`, () => {
		const root = fixture();
		write(join(root, "vinci", "hidden.mjs"), 'console.log(`hidden shell target reached: ${process.argv.slice(2).join(" ")}`);\n');
		write(
			join(root, "vinci", "bin", "vinci"),
			`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  ${dispatch}\nfi\n`,
		);
		const reached = runLauncher(root, ["hidden", "delta"]);
		assert.equal(reached.status, 0, reached.stderr);
		assert.match(reached.stdout, /hidden shell target reached: hidden delta/);
		expectFailure(run(root), /unmanifested executable dispatch/);
	});
}

test("missing, malformed, null, and wrong-type manifests refuse", () => {
	const cases = [
		{ value: null, pattern: /wrong schema or no dispatches/ },
		{ value: { schema: manifest.schema, dispatches: "worker" }, pattern: /wrong schema or no dispatches/ },
		{ value: { ...manifest, extra: true }, pattern: /wrong schema or no dispatches/ },
	];
	for (const candidate of cases) {
		const root = fixture();
		write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(candidate.value));
		expectFailure(run(root), candidate.pattern);
	}
	const malformedRoot = fixture();
	write(join(malformedRoot, "vinci", "dispatch-manifest.json"), "{");
	expectFailure(run(malformedRoot), /malformed JSON/);
	const missingRoot = fixture();
	rmSync(join(missingRoot, "vinci", "dispatch-manifest.json"));
	expectFailure(run(missingRoot), /wrong case or is missing/);
});

test("unsafe, empty, and wrong-type target paths refuse", () => {
	for (const target of ["", "../worker.mjs", "/tmp/worker.mjs", null]) {
		const root = fixture();
		const changed = structuredClone(manifest);
		changed.dispatches[1].target = target;
		write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(changed));
		expectFailure(run(root), /target must be a normalized relative path/);
	}
});

test("case-only target mismatches fail even on a case-insensitive host", () => {
	const root = fixture();
	const changed = structuredClone(manifest);
	changed.dispatches[1].target = "Worker/worker.mjs";
	write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(changed));
	expectFailure(run(root), /wrong case or is missing/);
});

test("symlink targets and symlinked dependency edges refuse", () => {
	const targetRoot = fixture();
	rmSync(join(targetRoot, "vinci", "worker", "worker.mjs"));
	symlinkSync(join(targetRoot, "vinci", "scripts", "report-helper.mjs"), join(targetRoot, "vinci", "worker", "worker.mjs"));
	expectFailure(run(targetRoot), /must not traverse a symlink/);

	const dependencyRoot = fixture();
	rmSync(join(dependencyRoot, "vinci", "worker", "contracts", "digest.cjs"));
	symlinkSync(
		join(dependencyRoot, "vinci", "scripts", "report-helper.mjs"),
		join(dependencyRoot, "vinci", "worker", "contracts", "digest.cjs"),
	);
	expectFailure(run(dependencyRoot), /must not traverse a symlink/);
});

test("dynamic and aliased runtime loaders are explicitly rejected", () => {
	for (const source of [
		'await import("./run.mjs");\n',
		'require("./" + process.env.MODULE);\n',
		'const load = require; load("./missing.cjs");\n',
		'const load = module.require; load("./missing.cjs");\n',
		'eval(\'require("./missing.cjs")\');\n',
	]) {
		const root = fixture();
		write(join(root, "vinci", "worker", "worker.mjs"), source);
		expectFailure(run(root), /dynamic\/runtime module loading|dynamic code loader|runtime module loader|runtime access|CommonJS loader/);
	}
});

for (const [label, source] of [
	["aliased eval", 'const load = eval; await load(\'import("./hidden.mjs")\');\n'],
	["property eval", 'const load = globalThis.eval; await load(\'import("./hidden.mjs")\');\n'],
	["eval.call", 'await eval.call(undefined, \'import("./hidden.mjs")\');\n'],
	["Function.call", 'await Function.call(undefined, \'return import("./hidden.mjs")\')();\n'],
]) {
	test(`${label} cannot execute a hidden module through a manifest entry`, () => {
		const root = fixture();
		write(join(root, "vinci", "worker", "worker.mjs"), source);
		write(join(root, "vinci", "worker", "hidden.mjs"), 'console.log("hidden module reached");\n');
		const reached = runLauncher(root, ["worker"]);
		assert.equal(reached.status, 0, reached.stderr);
		assert.match(reached.stdout, /hidden module reached/);
		expectFailure(run(root), /dynamic code loader/);
	});
}

test("the dynamic-loader policy also covers extension entry points", () => {
	const root = fixture();
	write(join(root, "vinci", "extensions", "entry.ts"), "const load = eval; void load('1');\n");
	expectFailure(run(root), /shipped extension graph.*unverifiable dependency edge|dynamic code loader/s);
});

test("restoring a rejected loader mutation restores certifiability", () => {
	const root = fixture();
	const workerPath = join(root, "vinci", "worker", "worker.mjs");
	const original = readFileSync(workerPath, "utf8");
	write(workerPath, "const load = eval; load('1');\n");
	expectFailure(run(root), /dynamic code loader/);
	write(workerPath, original);
	const restored = run(root);
	assert.equal(restored.status, 0, restored.stderr);
});

test("computed CommonJS loader access is rejected", () => {
	const root = fixture();
	write(
		join(root, "vinci", "worker", "contracts", "load.cjs"),
		'const load = module["requ" + "ire"];\nmodule.exports = load("./missing.cjs");\n',
	);
	expectFailure(run(root), /runtime module loader|computed runtime access/);
});

test("ESM syntax in a .cjs file is rejected", () => {
	for (const source of [
		'import "./digest.cjs";\nmodule.exports = {};\n',
		'export { ready } from "./digest.cjs";\n',
	]) {
		const root = fixture();
		write(join(root, "vinci", "worker", "contracts", "load.cjs"), source);
		expectFailure(run(root), /ESM import\/export syntax|ESM export syntax/);
	}
});

test("compact static imports and recursively traversed CommonJS imports fail on the missing edge", () => {
	const esmRoot = fixture();
	write(join(esmRoot, "vinci", "worker", "worker.mjs"), 'import{missing}from"./absent.mjs";\n');
	expectFailure(run(esmRoot), /worker\/worker\.mjs -> \.\/absent\.mjs/);

	const cjsRoot = fixture();
	rmSync(join(cjsRoot, "vinci", "worker", "contracts", "digest.cjs"));
	expectFailure(run(cjsRoot), /worker\/contracts\/load\.cjs -> \.\/digest\.cjs/);
});

test("malformed executable module and launcher syntax refuse", () => {
	const moduleRoot = fixture();
	write(join(moduleRoot, "vinci", "worker", "worker.mjs"), 'import { from "./missing.mjs";\n');
	expectFailure(run(moduleRoot), /malformed executable module syntax/);
	const launcherRoot = fixture();
	write(join(launcherRoot, "vinci", "bin", "vinci"), `${launcher}\nif then\n`);
	expectFailure(run(launcherRoot), /malformed or unverifiable Bash syntax/);
});

test("verification never executes packaged target code", () => {
	const root = fixture();
	const marker = join(root, "executed-marker");
	write(
		join(root, "vinci", "worker", "worker.mjs"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
	);
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(marker), false);
});

test("artifact identity prevents a wrong repository from certifying", () => {
	const root = fixture();
	write(join(root, "vinci", "identity.json"), JSON.stringify({ productName: "Other", command: "vinci" }));
	expectFailure(run(root), /artifact identity is not Vinci Code/);
});

test("artifact resolution is independent of the caller working directory", () => {
	const root = fixture();
	const unrelated = mkdtempSync(join(tmpdir(), "vinci-unrelated-cwd-"));
	fixtureRoots.push(unrelated);
	write(join(unrelated, "vinci", "worker", "worker.mjs"), "throw new Error('wrong tree');\n");
	const result = run(root, unrelated);
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(join(root, "vinci", "worker", "worker.mjs"), "utf8"), /run\.mjs/);
});
