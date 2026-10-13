import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "vinci/scripts/stage-runtime-dependencies.mjs");
const temporary = mkdtempSync(join(tmpdir(), "vinci-runtime-stage-test-"));
const fixture = join(temporary, "fixture");
const source = join(temporary, "dependency-source");
const lock = { packages: { "": { name: "fixture" } } };
function write(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, value);
}
function run(name, mode) {
	return spawnSync(process.execPath, [script, fixture, join(temporary, name), ...(mode ? [mode] : [])], { encoding: "utf8", timeout: 10000 });
}
try {
	for (const name of ["agent", "ai", "coding-agent", "orchestrator", "tui"]) {
		const path = `packages/${name}`;
		const manifest = { name: `@fixture/${name}`, version: "1.0.0", dependencies: name === "coding-agent" ? { "runtime-dep": "1.0.0", "@fixture/ai": "file:../ai" } : {} };
		write(join(fixture, path, "package.json"), JSON.stringify(manifest));
		lock.packages[path] = { version: "1.0.0" };
		mkdirSync(join(fixture, "node_modules/@fixture"), { recursive: true });
		symlinkSync(join(fixture, path), join(fixture, "node_modules/@fixture", name));
		lock.packages[`node_modules/@fixture/${name}`] = { resolved: path, link: true };
	}
	write(join(source, "package.json"), JSON.stringify({ name: "runtime-dep", version: "1.0.0" }));
	write(join(source, "index.js"), "export const result = 'locked runtime bytes';\n");
	write(join(source, "index.d.ts"), "export declare const result: string;\n");
	write(join(source, "LICENSE"), "MIT fixture license\n");
	write(join(source, "bin"), "#!/bin/sh\nprintf 'runtime fixture'\n");
	chmodSync(join(source, "bin"), 0o755);
	mkdirSync(join(fixture, "node_modules/@fixture"), { recursive: true });
	symlinkSync(source, join(fixture, "node_modules/runtime-dep"));
	lock.packages["node_modules/runtime-dep"] = { version: "1.0.0" };
	lock.packages["node_modules/@fixture/ai"] = { resolved: "packages/ai", link: true };
	write(join(fixture, "package-lock.json"), JSON.stringify(lock));
	const estimate = run("estimate", "--estimate");
	assert.equal(estimate.status, 0, estimate.stderr);
	assert.equal(existsSync(join(temporary, "estimate")), false, "An estimate must not stage files");
	const positive = run("positive");
	assert.equal(positive.status, 0, positive.stderr);
	const staged = join(temporary, "positive/node_modules/runtime-dep");
	assert.equal(readFileSync(join(staged, "index.js"), "utf8"), readFileSync(join(source, "index.js"), "utf8"));
	assert.equal(readFileSync(join(staged, "LICENSE"), "utf8"), "MIT fixture license\n");
	assert.equal(statSync(join(staged, "bin")).mode & 0o777, 0o755, "Runtime executable modes must survive staging");
	assert.equal(existsSync(join(staged, "index.d.ts")), false, "Dependency declarations remain development tooling");
	assert.equal(readlinkSync(join(temporary, "positive/node_modules/@fixture/ai")), "../../packages/ai", "Workspace links must resolve within the unpacked artifact");
	assert.equal(readlinkSync(join(temporary, "positive/node_modules/@fixture/orchestrator")), "../../packages/orchestrator", "Custom extensions must retain aliases for workspaces not imported by other packages");
	console.log("Runtime staging positive control preserved exact files, licenses, executable modes, and portable workspace links.");
	write(join(source, "package.json"), JSON.stringify({ name: "runtime-dep", version: "0.9.0" }));
	const mismatch = run("version-mismatch");
	assert.equal(mismatch.status, 1, mismatch.stdout);
	assert.match(mismatch.stderr, /expected locked "1\.0\.0"/);
	assert.equal(existsSync(join(temporary, "version-mismatch")), false, "Version refusal must happen before staging");
	write(join(source, "package.json"), JSON.stringify({ name: "runtime-dep", version: "1.0.0" }));
	symlinkSync(join(temporary, "outside.js"), join(source, "escape.js"));
	const escape = run("escape");
	assert.equal(escape.status, 1, escape.stdout);
	assert.match(escape.stderr, /escapes its package/);
	assert.equal(existsSync(join(temporary, "escape")), false, "Symlink refusal must happen before staging");
	console.log("Runtime staging negatives refused the wrong locked version and an escaping package link before copying any file.");
} finally {
	assert.equal(spawnSync("find", [temporary, "-mindepth", "1", "-delete"], { timeout: 10000 }).status, 0, "Remove the owned staging fixture before retrying.");
	rmdirSync(temporary);
}
