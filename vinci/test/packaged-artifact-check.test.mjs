import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runtimePackageExcludes } from "../scripts/runtime-package-closure.mjs";

const checker = process.env.VINCI_PACKAGED_CHECKER
	?? fileURLToPath(new URL("./packaged-artifact-check.mjs", import.meta.url));
const resolverSource = readFileSync(new URL("../scripts/resolve-dispatch.mjs", import.meta.url), "utf8");
const reaperSource = readFileSync(new URL("../scripts/reap-heal-temp.mjs", import.meta.url), "utf8");
const fixtureRoots = [];
const authorityRoots = new Map();

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
if [ "\${1:-}" = "--version" ]; then
  echo "0.0.51"
  exit 0
fi
case "\${1:-}" in
  report-wrong | worker)
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
  *) exit "\${_vinci_dispatch_status}" ;;
esac
    ;;
esac
if [ "\${1:-}" = "verify" ]; then
  shift
  exec "\${_vinci_vac_cli}" "$@"
fi
printf 'pi reached: <%s>\n' "$*"
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
	const authorityRoot = mkdtempSync(join(tmpdir(), "vinci-packaged-authority-"));
	fixtureRoots.push(authorityRoot);
	cpSync(root, authorityRoot, { recursive: true });
	authorityRoots.set(root, authorityRoot);
	return root;
}

function nestedFixture() {
	const originalRoot = fixture();
	const outer = mkdtempSync(join(tmpdir(), "vinci-packaged-parent-"));
	fixtureRoots.push(outer);
	const root = join(outer, "payload");
	cpSync(originalRoot, root, { recursive: true });
	authorityRoots.set(root, authorityRoots.get(originalRoot));
	return { outer, root };
}

function authorize(root, relativePath) {
	const authorityRoot = authorityRoots.get(root);
	assert.ok(authorityRoot);
	const source = join(root, relativePath);
	const target = join(authorityRoot, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true });
}

function run(root, cwd = tmpdir()) {
	return spawnSync(process.execPath, [checker, root], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, VINCI_PACKAGED_AUTHORITY_ROOT: authorityRoots.get(root) },
		timeout: 10_000,
	});
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

const shellDispatchFailure = /unmanifested executable dispatch|unreviewed (?:Node|shell|path)|exactly one reviewed|gate manifest resolution/;

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

test("ordinary prompt, bare, and version paths never depend on the dispatch manifest", () => {
	for (const manifestState of ["missing", "malformed"]) {
		const root = fixture();
		const manifestPath = join(root, "vinci", "dispatch-manifest.json");
		if (manifestState === "missing") rmSync(manifestPath);
		else write(manifestPath, "{");

		const prompt = runLauncher(root, ["explain", "this"]);
		assert.equal(prompt.status, 0, prompt.stderr);
		assert.match(prompt.stdout, /pi reached: <explain this>/);

		const bare = runLauncher(root, []);
		assert.equal(bare.status, 0, bare.stderr);
		assert.match(bare.stdout, /pi reached: <>/);

		const version = runLauncher(root, ["--version"]);
		assert.equal(version.status, 0, version.stderr);
		assert.equal(version.stdout.trim(), "0.0.51");

		for (const command of ["report-wrong", "worker"]) {
			const packaged = runLauncher(root, [command]);
			assert.equal(packaged.status, 65, packaged.stdout + packaged.stderr);
			assert.match(packaged.stderr, /invalid dispatch manifest/);
		}
	}
});

test("the launcher and manifest expose exactly the same reviewed packaged commands", () => {
	const broadenedRoot = fixture();
	write(
		join(broadenedRoot, "vinci", "bin", "vinci"),
		launcher.replace("report-wrong | worker)", "report-wrong | worker | hidden)"),
	);
	expectFailure(run(broadenedRoot), /gate manifest resolution on exactly the reviewed packaged commands/);

	const manifestRoot = fixture();
	const broadenedManifest = structuredClone(manifest);
	broadenedManifest.dispatches.push({ command: "hidden", target: "worker/worker.mjs" });
	write(join(manifestRoot, "vinci", "dispatch-manifest.json"), JSON.stringify(broadenedManifest));
	expectFailure(run(manifestRoot), /command set differs from the reviewed launcher gate/);
});

function addChalkDependency(root) {
	write(
		join(root, "node_modules", "chalk", "package.json"),
		JSON.stringify({ name: "chalk", version: "1.0.0", type: "module", exports: "./index.js" }),
	);
	write(join(root, "node_modules", "chalk", "index.js"), "export default (value) => value;\n");
	write(
		join(root, "vinci", "worker", "worker.mjs"),
		'import chalk from "chalk";\nconsole.log(chalk(`worker with chalk reached: ${process.argv[2]}`));\n',
	);
	authorize(root, "node_modules/chalk/package.json");
	authorize(root, "node_modules/chalk/index.js");
	authorize(root, "vinci/worker/worker.mjs");
}

test("a declared packaged dependency remains certifiable and reachable", () => {
	const root = fixture();
	addChalkDependency(root);
	const checked = run(root);
	assert.equal(checked.status, 0, checked.stderr);
	const reached = runLauncher(root, ["worker", "canonical"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /worker with chalk reached: canonical/);
});

test("a missing dependency cannot resolve from a malicious parent directory", () => {
	const { outer, root } = nestedFixture();
	addChalkDependency(root);
	mkdirSync(join(outer, "node_modules"), { recursive: true });
	renameSync(join(root, "node_modules", "chalk"), join(outer, "node_modules", "chalk"));
	write(
		join(outer, "node_modules", "chalk", "index.js"),
		'console.log("malicious parent chalk reached");\nexport default (value) => value;\n',
	);
	const reached = runLauncher(root, ["worker", "parent"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /malicious parent chalk reached/);
	assert.match(reached.stdout, /worker with chalk reached: parent/);
	expectFailure(run(root), /required by the trusted package layout is missing/);
});

test("dependency closure is package-name agnostic", () => {
	const root = fixture();
	write(join(root, "node_modules", "other-runtime", "index.js"), "export const value = true;\n");
	authorize(root, "node_modules/other-runtime/index.js");
	rmSync(join(root, "node_modules", "other-runtime"), { recursive: true });
	expectFailure(run(root), /node_modules\/other-runtime\/index\.js required by the trusted package layout is missing/);
});

test("package selection keeps the runtime graph and excludes whole development graphs", () => {
	const root = mkdtempSync(join(tmpdir(), "vinci-runtime-package-closure-"));
	fixtureRoots.push(root);
	const workspaces = [
		["agent", "@earendil-works/pi-agent-core", {}],
		["ai", "@earendil-works/pi-ai", {}],
		["coding-agent", "@earendil-works/pi-coding-agent", { runtime: "1.0.0" }],
		["orchestrator", "@earendil-works/pi-orchestrator", {}],
		["tui", "@earendil-works/pi-tui", {}],
	];
	for (const [directory, name, dependencies] of workspaces) {
		const workspaceRoot = join(root, "packages", directory);
		write(join(workspaceRoot, "package.json"), JSON.stringify({ name, dependencies }));
		const linkedRoot = join(root, "node_modules", ...name.split("/"));
		mkdirSync(dirname(linkedRoot), { recursive: true });
		symlinkSync(workspaceRoot, linkedRoot);
	}
	write(join(root, "node_modules", "runtime", "package.json"), JSON.stringify({ name: "runtime", dependencies: { transitive: "1.0.0" } }));
	write(join(root, "node_modules", "transitive", "package.json"), JSON.stringify({ name: "transitive" }));
	write(join(root, "node_modules", "tsx", "package.json"), JSON.stringify({ name: "tsx", dependencies: { esbuild: "1.0.0" } }));
	write(join(root, "node_modules", "esbuild", "package.json"), JSON.stringify({ name: "esbuild" }));

	const excluded = new Set(runtimePackageExcludes(root));
	assert.equal(excluded.has("node_modules/runtime"), false);
	assert.equal(excluded.has("node_modules/transitive"), false);
	assert.equal(excluded.has("node_modules/tsx"), true);
	assert.equal(excluded.has("node_modules/esbuild"), true);
	for (const [, name] of workspaces) assert.equal(excluded.has(`node_modules/${name}`), false);
});

test("the reviewed maintenance helper is packaged, traversed, and fault-restorable", () => {
	const root = fixture();
	const helperPath = join(root, "vinci", "scripts", "reap-heal-temp.mjs");
	write(helperPath, reaperSource);
	write(
		join(root, "vinci", "bin", "vinci"),
		launcher.replace(
			"set +e",
			() => '_vinci_home="${ROOT}"\nnode "${VINCI}/scripts/reap-heal-temp.mjs" "${_vinci_home}/updater" "$$" 2>/dev/null || true\nset +e',
		),
	);
	authorize(root, "vinci/bin/vinci");
	authorize(root, "vinci/scripts/reap-heal-temp.mjs");
	const checked = run(root);
	assert.equal(checked.status, 0, checked.stderr);
	assert.match(checked.stdout, /8 dispatch files\/4 imports/);
	rmSync(helperPath);
	expectFailure(run(root), /launcher maintenance helper has wrong case or is missing/);
	write(helperPath, reaperSource);
	assert.equal(run(root).status, 0);
});

test("an extensionless manifest target is verified and reachable", () => {
	const root = fixture();
	const changed = structuredClone(manifest);
	changed.dispatches[1].target = "worker/run-worker";
	write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(changed));
	write(join(root, "vinci", "worker", "run-worker"), 'console.log(`extensionless reached: ${process.argv[2]}`);\n');
	authorize(root, "vinci/dispatch-manifest.json");
	authorize(root, "vinci/worker/run-worker");
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
		expectFailure(run(root), shellDispatchFailure);
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
		expectFailure(run(root), shellDispatchFailure);
	}
});

test("multiline command substitutions and backticks cannot hide a dispatch", () => {
	for (const addition of [
		'target="${VINCI}/missing.mjs"\nresult="$(\n  node "$target"\n)"',
		'target="${VINCI}/missing.mjs"\nresult="`\n  node "$target"\n`"',
	]) {
		const root = fixture();
		write(join(root, "vinci", "bin", "vinci"), `${launcher}\n${addition}\n`);
		expectFailure(run(root), shellDispatchFailure);
	}
});

test("a variable-indirected Vinci target cannot hide a dispatch", () => {
	const root = fixture();
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\ntarget="${"${VINCI}"}/missing.mjs"\nnode "$target"\n`,
	);
	expectFailure(run(root), shellDispatchFailure);
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
		expectFailure(run(root), shellDispatchFailure);
	});
}

test("a relative target after an artifact-root cd cannot bypass the manifest", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("relative hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  cd "\${VINCI}"\n  node "./hidden.mjs" "$@"\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /relative hidden target reached/);
	expectFailure(run(root), /unreviewed Node execution form/);
});

test("a direct relative executable after an artifact-root cd cannot bypass the manifest", () => {
	const root = fixture();
	const hiddenPath = join(root, "vinci", "hidden.sh");
	write(hiddenPath, '#!/usr/bin/env bash\necho "direct relative hidden target reached"\n');
	chmodSync(hiddenPath, 0o755);
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  cd "\${VINCI}"\n  ./hidden.sh "$@"\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /direct relative hidden target reached/);
	expectFailure(run(root), /unreviewed path executable/);
});

test("shell eval cannot defer an artifact-root expansion past verification", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("eval hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  payload='node "\${VINCI}/hidden.mjs" "$@"'\n  eval "$payload"\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /eval hidden target reached/);
	expectFailure(run(root), /unreviewed shell eval form/);
});

test("the reviewed profile eval variable cannot be repurposed as a dispatch", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("profile eval hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  VINCI_PROFILE_EXPORTS='node "\${VINCI}/hidden.mjs" "$@"'\n  eval "$VINCI_PROFILE_EXPORTS"\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /profile eval hidden target reached/);
	expectFailure(run(root), /repurposes the reviewed profile eval payload/);
});

test("a variable-indirected Node command cannot execute after entering the artifact root", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("variable Node hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  cd "\${VINCI}"\n  runtime="node"\n  "\${runtime}" ./hidden.mjs\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /variable Node hidden target reached/);
	expectFailure(run(root), /executable authority|unmanifested executable dispatch/);
});

test("xargs cannot turn artifact data into a Node execution", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("xargs hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  printf '%s\\n' "\${VINCI}/hidden.mjs" | xargs node\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /xargs hidden target reached/);
	expectFailure(run(root), /executable authority|unreviewed shell execution form/);
});

test("an artifact-controlled PATH cannot replace the reviewed Node executable", () => {
	const root = fixture();
	const fakeNode = join(root, "vinci", "tool-bin", "node");
	write(
		fakeNode,
		`#!/usr/bin/env bash\necho "PATH hidden executable reached" >&2\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
	);
	chmodSync(fakeNode, 0o755);
	write(
		join(root, "vinci", "bin", "vinci"),
		launcher.replace("set +e", 'PATH="${VINCI}/tool-bin:${PATH}"\nexport PATH\nset +e'),
	);
	const reached = runLauncher(root, ["worker", "path"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stderr, /PATH hidden executable reached/);
	assert.match(reached.stdout, /worker reached: path true/);
	expectFailure(run(root), /executable authority|execution-control variable/);
});

for (const [label, source, hiddenName, hiddenSource, marker] of [
	[
		"Reflect-derived Function",
		'const make = Reflect.get(globalThis, ["Fun", "ction"].join(""));\nawait make(\'return import("./hidden.mjs")\')();\n',
		"hidden.mjs",
		'console.log("Reflect Function hidden target reached");\n',
		/Reflect Function hidden target reached/,
	],
	[
		"Reflect-derived module loader",
		'const getBuiltin = Reflect.get(process, ["getBuiltin", "Module"].join(""));\nconst Module = getBuiltin("node:module");\nconst load = Reflect.get(Module, ["_", "load"].join(""));\nload(new URL("./hidden.cjs", import.meta.url).pathname);\n',
		"hidden.cjs",
		'console.log("Reflect module hidden target reached");\n',
		/Reflect module hidden target reached/,
	],
	[
		"node:vm",
		'import { readFileSync } from "node:fs";\nimport { runInThisContext } from "node:vm";\nrunInThisContext(readFileSync(new URL("./hidden.cjs", import.meta.url), "utf8"));\n',
		"hidden.cjs",
		'console.log("vm hidden target reached");\n',
		/vm hidden target reached/,
	],
	[
		"worker_threads",
		'import { Worker } from "node:worker_threads";\nconst worker = new Worker(new URL("./hidden.mjs", import.meta.url));\nawait new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });\n',
		"hidden.mjs",
		'console.log("worker thread hidden target reached");\n',
		/worker thread hidden target reached/,
	],
	[
		"child_process.fork",
		'import { fork } from "node:child_process";\nconst child = fork(new URL("./hidden.cjs", import.meta.url), { stdio: "inherit" });\nawait new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });\n',
		"hidden.cjs",
		'console.log("fork hidden target reached");\n',
		/fork hidden target reached/,
	],
]) {
	test(`${label} cannot execute an unreviewed module`, () => {
		const root = fixture();
		write(join(root, "vinci", "worker", "worker.mjs"), source);
		write(join(root, "vinci", "worker", hiddenName), hiddenSource);
		const reached = runLauncher(root, ["worker"]);
		assert.equal(reached.status, 0, reached.stderr);
		assert.match(reached.stdout, marker);
		expectFailure(run(root), /executable authority|unverifiable dependency edge/);
	});
}

test("an alternate variable-built command cannot execute a relative artifact target", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("built command hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  cd "\${VINCI}"\n  printf -v runtime '%s' node\n  "\${runtime}" ./hidden.mjs\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /built command hidden target reached/);
	expectFailure(run(root), /closed executable authority/);
});

test("an alternate command composer cannot execute an artifact target", () => {
	const root = fixture();
	write(join(root, "vinci", "hidden.mjs"), 'console.log("find hidden target reached");\n');
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  cd "\${VINCI}"\n  find . -name hidden.mjs -exec node {} \\;\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /find hidden target reached/);
	expectFailure(run(root), /closed executable authority/);
});

test("an alternate PATH shadow cannot replace an allowlisted utility", () => {
	const root = fixture();
	const fakeSed = join(root, "vinci", "tool-bin", "sed");
	write(fakeSed, '#!/usr/bin/env bash\necho "PATH utility hidden executable reached"\n');
	chmodSync(fakeSed, 0o755);
	write(
		join(root, "vinci", "bin", "vinci"),
		`${launcher}\nif [ "\${1:-}" = "hidden" ]; then\n  PATH="\${VINCI}/tool-bin:\${PATH}"\n  sed ignored\nfi\n`,
	);
	const reached = runLauncher(root, ["hidden"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /PATH utility hidden executable reached/);
	expectFailure(run(root), /closed executable authority/);
});

for (const [label, source, hiddenName, hiddenSource, marker] of [
	[
		"Reflect-derived AsyncFunction",
		'const make = Reflect.get(Object.getPrototypeOf(async () => {}), ["con", "structor"].join(""));\nawait make(\'return import("./hidden.mjs")\')();\n',
		"hidden.mjs",
		'console.log("Reflect AsyncFunction hidden target reached");\n',
		/Reflect AsyncFunction hidden target reached/,
	],
	[
		"node:vm Script",
		'import { readFileSync } from "node:fs";\nimport { Script } from "node:vm";\nnew Script(readFileSync(new URL("./hidden.cjs", import.meta.url), "utf8")).runInThisContext();\n',
		"hidden.cjs",
		'console.log("vm Script hidden target reached");\n',
		/vm Script hidden target reached/,
	],
	[
		"worker_threads eval",
		'import { Worker } from "node:worker_threads";\nconst worker = new Worker(\'console.log("worker code reached")\', { ["e" + "val"]: true });\nawait new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });\n',
		"unused.mjs",
		"export {};\n",
		/worker code reached/,
	],
	[
		"child_process.spawn",
		'import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [new URL("./hidden.cjs", import.meta.url).pathname], { stdio: "inherit" });\nawait new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });\n',
		"hidden.cjs",
		'console.log("spawn hidden target reached");\n',
		/spawn hidden target reached/,
	],
]) {
	test(`${label} alternate is refused by the closed authority`, () => {
		const root = fixture();
		write(join(root, "vinci", "worker", "worker.mjs"), source);
		write(join(root, "vinci", "worker", hiddenName), hiddenSource);
		const reached = runLauncher(root, ["worker"]);
		assert.equal(reached.status, 0, reached.stderr);
		assert.match(reached.stdout, marker);
		expectFailure(run(root), /closed executable authority/);
	});
}

test("an artifact-local file cannot extend the external executable authority", () => {
	const root = fixture();
	write(join(root, "vinci", "worker", "unreviewed.mjs"), "export const unreviewed = true;\n");
	expectFailure(run(root), /not present in the trusted executable authority/);
});

test("a packaged runtime dependency is byte-bound to the external authority", () => {
	const root = fixture();
	write(join(root, "node_modules", "runtime", "index.js"), "export const value = 1;\n");
	authorize(root, "node_modules/runtime/index.js");
	write(join(root, "node_modules", "runtime", "index.js"), "export const value = 2;\n");
	expectFailure(run(root), /node_modules\/runtime\/index\.js differs from the trusted executable authority/);
});

test("absolute and escaping package symlinks refuse even when authority link text matches", () => {
	const root = fixture();
	const authorityRoot = authorityRoots.get(root);
	assert.ok(authorityRoot);
	const external = mkdtempSync(join(tmpdir(), "vinci-external-package-"));
	fixtureRoots.push(external);
	write(join(external, "package.json"), JSON.stringify({ name: "external", main: "index.js" }));
	write(join(external, "index.js"), "export const external = true;\n");
	mkdirSync(join(root, "node_modules"), { recursive: true });
	mkdirSync(join(authorityRoot, "node_modules"), { recursive: true });
	symlinkSync(external, join(root, "node_modules", "linked-runtime"));
	symlinkSync(external, join(authorityRoot, "node_modules", "linked-runtime"));
	expectFailure(run(root), /linked-runtime .*symlink resolves outside its root/);

	rmSync(join(root, "node_modules", "linked-runtime"));
	rmSync(join(authorityRoot, "node_modules", "linked-runtime"));
	for (const base of [root, authorityRoot]) {
		write(join(base, "node_modules", "linked-runtime", "package.json"), JSON.stringify({ name: "linked-runtime", main: "index.js" }));
		write(join(base, "node_modules", "linked-runtime", "index.js"), "export const restored = true;\n");
	}
	assert.equal(run(root).status, 0);
});

test("hardlinked package files refuse and independent restoration certifies", () => {
	const root = fixture();
	const authorityRoot = authorityRoots.get(root);
	assert.ok(authorityRoot);
	const external = join(mkdtempSync(join(tmpdir(), "vinci-external-hardlink-")), "index.js");
	fixtureRoots.push(dirname(external));
	write(external, "export const linked = true;\n");
	for (const base of [root, authorityRoot]) {
		const target = join(base, "node_modules", "runtime", "index.js");
		mkdirSync(dirname(target), { recursive: true });
		linkSync(external, target);
	}
	expectFailure(run(root), /node_modules\/runtime\/index\.js differs from the trusted executable authority/);
	for (const base of [root, authorityRoot]) {
		const target = join(base, "node_modules", "runtime", "index.js");
		rmSync(target);
		write(target, "export const linked = true;\n");
	}
	assert.equal(run(root).status, 0);
});

test("all literal package main, bin, imports, and conditional exports targets must exist", () => {
	const root = fixture();
	const packageJson = {
		name: "runtime",
		main: "index.js",
		bin: { runtime: "bin.mjs" },
		imports: { "#internal": { default: "./index.js" } },
		exports: { ".": { default: "./index.js", "review-condition": "./missing.js" } },
	};
	write(join(root, "node_modules", "runtime", "package.json"), JSON.stringify(packageJson));
	write(join(root, "node_modules", "runtime", "index.js"), "export {};\n");
	write(join(root, "node_modules", "runtime", "bin.mjs"), "export {};\n");
	authorize(root, "node_modules/runtime");
	expectFailure(run(root), /exports.*review-condition target \.\/missing\.js is missing/);
	write(join(root, "node_modules", "runtime", "missing.js"), "export {};\n");
	authorize(root, "node_modules/runtime/missing.js");
	assert.equal(run(root).status, 0);
});

test("external package imports cannot resolve from a malicious parent node_modules", () => {
	const { outer, root } = nestedFixture();
	write(
		join(root, "node_modules", "chalk", "package.json"),
		JSON.stringify({
			name: "chalk",
			type: "module",
			imports: { "#review-external": "review-missing-package" },
			exports: "./source/index.js",
		}),
	);
	write(
		join(root, "node_modules", "chalk", "source", "index.js"),
		'import { marker } from "#review-external";\nconsole.log(marker);\n',
	);
	authorize(root, "node_modules/chalk");
	write(
		join(outer, "node_modules", "review-missing-package", "package.json"),
		JSON.stringify({ name: "review-missing-package", type: "module", exports: "./index.js" }),
	);
	write(
		join(outer, "node_modules", "review-missing-package", "index.js"),
		'export const marker = "PARENT_PACKAGE_EXECUTED";\n',
	);
	expectFailure(run(root), /imports.*external target review-missing-package resolves outside its root/);

	write(
		join(root, "node_modules", "review-missing-package", "package.json"),
		JSON.stringify({ name: "review-missing-package", type: "module", exports: "./index.js" }),
	);
	write(
		join(root, "node_modules", "review-missing-package", "index.js"),
		'export const marker = "PACKAGED_PACKAGE_EXECUTED";\n',
	);
	authorize(root, "node_modules/review-missing-package");
	assert.equal(run(root).status, 0);
	const reached = spawnSync(process.execPath, [join(root, "node_modules", "chalk", "source", "index.js")], {
		cwd: outer,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /PACKAGED_PACKAGE_EXECUTED/);
});

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

for (const [label, source] of [
	["Function constructor", 'const load = (() => {}).constructor; await load(\'return import("./hidden.mjs")\')();\n'],
	["AsyncFunction constructor", 'const load = (async () => {}).constructor; await new load(\'return import("./hidden.mjs")\')();\n'],
	["computed Function constructor", 'const key = "con" + "structor"; const load = (() => {})[key]; await load(\'return import("./hidden.mjs")\')();\n'],
]) {
	test(`${label} derivation cannot execute a hidden module`, () => {
		const root = fixture();
		write(join(root, "vinci", "worker", "worker.mjs"), source);
		write(join(root, "vinci", "worker", "hidden.mjs"), 'console.log("constructor hidden module reached");\n');
		const reached = runLauncher(root, ["worker"]);
		assert.equal(reached.status, 0, reached.stderr);
		assert.match(reached.stdout, /constructor hidden module reached/);
		expectFailure(run(root), /runtime module loader|dynamic code loader/);
	});
}

test("a computed Module._load key cannot execute a hidden module", () => {
	const root = fixture();
	write(
		join(root, "vinci", "worker", "worker.mjs"),
		'import Module from "node:module";\nconst key = ["_", "load"].join("");\nModule[key](new URL("./hidden.cjs", import.meta.url).pathname);\n',
	);
	write(join(root, "vinci", "worker", "hidden.cjs"), 'console.log("Module._load hidden module reached");\n');
	const reached = runLauncher(root, ["worker"]);
	assert.equal(reached.status, 0, reached.stderr);
	assert.match(reached.stdout, /Module\._load hidden module reached/);
	expectFailure(run(root), /module-loader authority|runtime module loader|runtime access/);
});

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
	authorize(root, "vinci/worker/worker.mjs");
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
