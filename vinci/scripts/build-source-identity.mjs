#!/usr/bin/env node
// Bind build inputs to a commit and actual working bytes; dirty development input is explicit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isFirstPartyTestPath } from "./first-party-test-paths.mjs";

const [mode, rootArgument, snapshotPath, outputPath] = process.argv.slice(2);
if (!["snapshot", "verify", "check"].includes(mode) || !rootArgument || !snapshotPath) {
	console.error("Usage: build-source-identity.mjs <snapshot|verify|check> <source-root> <snapshot-or-identity-file> [output-file]; select the owned source and build evidence before retrying.");
	process.exit(2);
}
const root = realpathSync(resolve(rootArgument));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { timeout: 30000 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function currentIdentity() {
	const sourceCommit = git("rev-parse", "HEAD^{commit}").toString("utf8").trim();
	const sourceTree = git("rev-parse", "HEAD^{tree}").toString("utf8").trim();
	const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
	const paths = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean))].sort();
	const inputs = [];
	for (const path of paths) {
		if (isFirstPartyTestPath(path) || path.split("/").includes("graphify-out") || !(path.startsWith("packages/") && /\/(?:src|vendor)(?:\/|$)/.test(path) || /^packages\/[^/]+\/(?:package\.json|tsconfig[^/]*\.json)$/.test(path) || /^vinci\/(?:extensions|assets|themes|bin|scripts|worker|updater)(?:\/|$)/.test(path) || /^(?:LICENSE|package(?:-lock)?\.json|tsconfig[^/]*\.json|vinci\/identity\.json|vinci\/NOTICE|vinci\/(?:build|package)\.sh|vinci\/tsconfig[^/]*\.json)$/.test(path))) continue;
		let details;
		try { details = lstatSync(resolve(root, path)); }
		catch { throw new Error(`Selected build input "${path}" is missing. Restore the exact source before rebuilding.`); }
		if (!details.isFile() && !details.isSymbolicLink()) continue;
		const bytes = details.isSymbolicLink() ? Buffer.from(readlinkSync(resolve(root, path))) : readFileSync(resolve(root, path));
		const input = { path, mode: details.isSymbolicLink() ? "120000" : details.mode & 0o111 ? "100755" : "100644", sha256: digest(bytes) };
		if (details.isSymbolicLink()) {
			let target;
			try { target = realpathSync(resolve(root, path)); }
			catch { throw new Error(`Selected source link "${path}" is dangling. Restore its owned regular-file target before rebuilding.`); }
			const targetPath = relative(root, target);
			if (isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith(`..${sep}`)) throw new Error(`Selected source link "${path}" escapes the source root. Materialize its reviewed bytes inside the owned source before rebuilding.`);
			if (!statSync(target).isFile()) throw new Error(`Selected source link "${path}" targets a directory or special file. Materialize its reviewed source files before rebuilding.`);
			input.targetPath = targetPath;
			input.targetSha256 = digest(readFileSync(target));
		}
		inputs.push(input);
	}
	return { schemaVersion: 1, sourceCommit, sourceTree, dirty: status.length > 0, gitStatusSha256: digest(status), inputSha256: digest(Buffer.from(JSON.stringify(inputs))), inputs };
}

if (mode === "snapshot") {
	const identity = currentIdentity();
	mkdirSync(dirname(resolve(snapshotPath)), { recursive: true });
	writeFileSync(snapshotPath, `${JSON.stringify(identity, null, 2)}\n`);
	console.log(`Build source snapshot: commit ${identity.sourceCommit}, dirty ${identity.dirty}, ${identity.inputs.length} hashed runtime/build inputs.`);
} else {
	const before = JSON.parse(readFileSync(snapshotPath, "utf8"));
	const after = currentIdentity();
	assert.equal(after.sourceCommit, before.sourceCommit, "Source HEAD changed during or after the build. Rebuild the selected commit before packaging.");
	assert.equal(after.inputSha256, before.inputSha256, "Runtime/build source bytes changed during or after the build. Rebuild those exact inputs before packaging.");
	if (process.env.VINCI_PACKAGE_REQUIRE_CLEAN_SOURCE === "1") {
		assert.equal(before.dirty, false, "The selected release build was dirty. Commit and review the exact source before packaging.");
		assert.equal(after.dirty, false, "The release source is now dirty. Restore the reviewed source before packaging.");
	}
	if (process.env.VINCI_EXPECTED_SOURCE_SHA) {
		assert.match(process.env.VINCI_EXPECTED_SOURCE_SHA, /^[0-9a-f]{40}$/, "Expected source SHA must be a full commit ID. Resolve the selected event SHA before packaging.");
		assert.equal(before.sourceCommit, process.env.VINCI_EXPECTED_SOURCE_SHA, "Build source differs from the selected release commit. Rebuild that exact commit before packaging.");
	}
	if (mode === "verify") {
		assert.ok(outputPath, "Select the generated build identity output before retrying.");
		mkdirSync(dirname(resolve(outputPath)), { recursive: true });
		writeFileSync(outputPath, `${JSON.stringify(before, null, 2)}\n`);
	}
	console.log(`Build source verified: commit ${before.sourceCommit}, dirty ${before.dirty}, runtime/build input SHA-256 ${before.inputSha256}.`);
}
