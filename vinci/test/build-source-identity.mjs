#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helper = join(root, "vinci/scripts/build-source-identity.mjs");
const temporary = mkdtempSync(join(tmpdir(), "vinci-build-identity-test-"));
const fixture = join(temporary, "source");
const snapshot = join(temporary, "snapshot.json");
const identity = join(temporary, "identity.json");
const env = { ...process.env, VINCI_EXPECTED_SOURCE_SHA: "", VINCI_PACKAGE_REQUIRE_CLEAN_SOURCE: "0" };
function run(mode, extraEnv = {}) {
	return spawnSync(process.execPath, [helper, mode, fixture, mode === "check" ? identity : snapshot, ...(mode === "verify" ? [identity] : [])], { encoding: "utf8", timeout: 10000, env: { ...env, ...extraEnv } });
}
function git(...args) {
	const result = spawnSync("git", ["-C", fixture, "-c", "user.name=Provenance fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
const entry = join(fixture, "vinci/extensions/entry.mjs");
const original = "export const value = 'reviewed source';\n";
try {
	mkdirSync(dirname(entry), { recursive: true });
	writeFileSync(entry, original);
	git("init", "--quiet");
	git("add", "vinci/extensions/entry.mjs");
	git("commit", "--quiet", "-m", "test: establish owned provenance fixture");
	const expectedCommit = git("rev-parse", "HEAD^{commit}");
	assert.equal(run("snapshot").status, 0);
	const recorded = JSON.parse(readFileSync(snapshot, "utf8"));
	assert.equal(recorded.sourceCommit, expectedCommit);
	assert.equal(recorded.dirty, false);
	assert.equal(recorded.inputs[0].sha256, createHash("sha256").update(original).digest("hex"), "Bind independently hashed actual source bytes");
	const positive = run("verify", { VINCI_EXPECTED_SOURCE_SHA: expectedCommit, VINCI_PACKAGE_REQUIRE_CLEAN_SOURCE: "1" });
	assert.equal(positive.status, 0, positive.stderr);
	assert.equal(run("check").status, 0);
	writeFileSync(entry, "export const value = 'changed runtime bytes';\n");
	const changed = run("check");
	assert.equal(changed.status, 1);
	assert.match(changed.stderr, /Runtime\/build source bytes changed/);
	assert.equal(run("snapshot").status, 0);
	const dirty = run("verify", { VINCI_PACKAGE_REQUIRE_CLEAN_SOURCE: "1" });
	assert.equal(dirty.status, 1);
	assert.match(dirty.stderr, /selected release build was dirty/);
	writeFileSync(entry, original);
	assert.equal(run("snapshot").status, 0);
	const wrongCommit = run("verify", { VINCI_EXPECTED_SOURCE_SHA: "0".repeat(40) });
	assert.equal(wrongCommit.status, 1);
	assert.match(wrongCommit.stderr, /selected release commit/);
	chmodSync(entry, 0o755);
	const modeChanged = run("verify");
	assert.equal(modeChanged.status, 1);
	assert.match(modeChanged.stderr, /Runtime\/build source bytes changed/);
	chmodSync(entry, 0o644);
	const linked = join(dirname(entry), "linked.mjs");
	const target = join(fixture, "storage/source.mjs");
	mkdirSync(dirname(target));
	writeFileSync(target, original);
	symlinkSync("../../storage/source.mjs", linked);
	assert.equal(run("snapshot").status, 0);
	const linkedSnapshot = JSON.parse(readFileSync(snapshot, "utf8"));
	const linkedIdentity = linkedSnapshot.inputs.find((input) => input.path.endsWith("linked.mjs"));
	assert.equal(linkedSnapshot.inputs.some((input) => input.path === "storage/source.mjs"), false, "The control target must be reached only through consumer link semantics");
	assert.equal(linkedIdentity.targetPath, "storage/source.mjs");
	assert.equal(linkedIdentity.targetSha256, createHash("sha256").update(original).digest("hex"));
	writeFileSync(target, "export const value = 'changed target';\n");
	assert.equal(run("verify").status, 1, "The consumer follows the link; changing its target must invalidate provenance");
	writeFileSync(target, original);
	unlinkSync(linked);
	symlinkSync(join(temporary, "outside.mjs"), linked);
	writeFileSync(join(temporary, "outside.mjs"), original);
	const escape = run("snapshot");
	assert.equal(escape.status, 1);
	assert.match(escape.stderr, /escapes the source root/);
	unlinkSync(linked);
	symlinkSync("absent.mjs", linked);
	const dangling = run("snapshot");
	assert.equal(dangling.status, 1);
	assert.match(dangling.stderr, /is dangling/);
	unlinkSync(linked);
	symlinkSync(".", linked);
	const directory = run("snapshot");
	assert.equal(directory.status, 1);
	assert.match(directory.stderr, /targets a directory/);
	console.log("Source provenance passed its actual Git/byte positive control and refused changed runtime bytes, executable modes, dirty release source, wrong commit, changed link targets, and escaping/dangling/directory links.");
} finally {
	assert.equal(spawnSync("find", [temporary, "-mindepth", "1", "-delete"], { timeout: 10000 }).status, 0, "Remove the owned provenance fixture before retrying.");
	rmdirSync(temporary);
}
