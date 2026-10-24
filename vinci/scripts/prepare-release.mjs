#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let step = "validation";

function git(args, trim = true) {
	const output = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
	return trim ? output.trim() : output;
}

function versionParts(value) {
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
		throw new Error("Choose a product version in X.Y.Z form without leading zeros.");
	}
	const parts = value.split(".").map(Number);
	if (!parts.every(Number.isSafeInteger)) throw new Error("Choose a product version with safe integer components.");
	return parts;
}

function removeTemporaryDirectory(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) removeTemporaryDirectory(path);
		else unlinkSync(path);
	}
	rmdirSync(directory);
}

try {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log("Usage: node vinci/scripts/prepare-release.mjs <version> --notes-file <maintained-notes.md> [--dry-run]");
	} else {
		const version = args.shift();
		const next = versionParts(version);
		let notesFile;
		let dryRun = false;
		while (args.length > 0) {
			const option = args.shift();
			if (option === "--notes-file" && !notesFile && args[0] && !args[0].startsWith("--")) notesFile = resolve(args.shift());
			else if (option === "--dry-run" && !dryRun) dryRun = true;
			else throw new Error(`Unrecognized or repeated option "${option}". Run --help and pass the documented arguments.`);
		}
		if (!notesFile) throw new Error("Pass --notes-file with maintained user-facing release notes.");
		if (!readFileSync(notesFile, "utf8").trim()) throw new Error("Write nonempty maintained release notes before preparing the release.");
		const identityPath = join(root, "vinci/identity.json");
		const identity = JSON.parse(readFileSync(identityPath, "utf8"));
		const current = versionParts(identity.version);
		const changed = next.findIndex((value, index) => value !== current[index]);
		if (changed < 0 || next[changed] < current[changed]) throw new Error("Choose a version newer than the current product identity.");
		const branch = `release/vinci-v${version}`;
		if (git(["branch", "--show-current"]) !== branch) throw new Error(`Create and select "${branch}" from current main before preparing the release.`);
		// A clean branch protects unrelated work from snapshot regeneration.
		if (git(["status", "--porcelain"])) throw new Error("Commit or relocate unrelated changes before preparing the release on its own clean branch.");
		const tag = `refs/tags/vinci-v${version}`;
		if (git(["tag", "--list", `vinci-v${version}`])) throw new Error(`Version "${version}" already has an immutable local tag. Choose an unused version.`);
		// Bind preparation to live main, and reject unfetched immutable tags in the same bounded read.
		const remoteRefs = git(["ls-remote", "origin", "refs/heads/main", tag]).split("\n").map((line) => line.split("\t"));
		if (remoteRefs.some(([, ref]) => ref === tag)) throw new Error(`Version "${version}" already has an immutable remote tag. Choose an unused version.`);
		const mainSha = remoteRefs.find(([, ref]) => ref === "refs/heads/main")?.[0];
		if (!mainSha || git(["rev-parse", "HEAD"]) !== mainSha) throw new Error("Recreate the clean release branch from the current live origin/main before preparing the release.");
		const notesPath = join(root, "vinci/release-notes", `${version}.md`);
		if (existsSync(notesPath)) throw new Error(`Release notes for "${version}" already exist. Review that preparation before retrying.`);
		const snapshots = ["node_modules/vitest/dist/cli.js", "packages/coding-agent/node_modules/vitest/dist/cli.js"]
			.map((path) => join(root, path)).find((path) => existsSync(path));
		if (!snapshots) throw new Error("Install the repository dependencies before running release preparation.");
		const allowedPaths = new Set([
			"vinci/identity.json", `vinci/release-notes/${version}.md`,
			...git(["ls-files", "-z", "--", "vinci/test/ui/snapshots"], false).split("\0").filter(Boolean),
		]);
		console.log(`Release preparation ${dryRun ? "would update" : "will update"} the Vinci product version from ${identity.version} to ${version} on ${branch}.`);
		console.log(`Release preparation ${dryRun ? "would copy" : "will copy"} maintained notes to vinci/release-notes/${version}.md and regenerate the existing UI scenarios.`);
		if (dryRun) {
			console.log("Release preparation dry run completed after validation.");
		} else {
			step = "product identity update";
			writeFileSync(identityPath, `${JSON.stringify({ ...identity, version }, null, 2)}\n`);
			step = "maintained notes copy";
			mkdirSync(dirname(notesPath), { recursive: true });
			copyFileSync(notesFile, notesPath, constants.COPYFILE_EXCL);
			step = "UI snapshot regeneration";
			const temporary = mkdtempSync(join(root, ".vinci-release-"));
			let snapshotError;
			try {
				const result = spawnSync(process.execPath, [snapshots, "--root", root, "--run",
					"--exclude", "**/node_modules/**", "--exclude", "**/dist/**", "--exclude", "**/.claude/**", "--exclude", "**/.*/**",
					"--pool=forks", "--maxWorkers=1", "--no-file-parallelism", "--configLoader", "native", "--no-cache",
					"vinci/test/ui/scenarios.test.mjs"], {
					cwd: root,
					env: { ...process.env, UPDATE_VINCI_UI_SNAPSHOTS: "1", TMPDIR: temporary },
					stdio: "inherit",
					timeout: 180000,
				});
				if (result.error) snapshotError = result.error;
				else if (result.status !== 0) snapshotError = new Error(`Snapshot regeneration exited ${result.status ?? "without a status"}.`);
			} finally {
				removeTemporaryDirectory(temporary);
			}
			const changedPaths = new Set([
				...git(["diff", "--name-only", "-z", "HEAD"], false).split("\0").filter(Boolean),
				...git(["ls-files", "--others", "--exclude-standard", "-z"], false).split("\0").filter(Boolean),
			]);
			const unrelated = [...changedPaths].filter((path) => !allowedPaths.has(path));
			if (snapshotError) throw new Error(`${snapshotError.message}${unrelated.length > 0 ? ` Unexpected changed paths ${JSON.stringify(unrelated)} were preserved for review.` : ""}`);
			step = "prepared diff validation";
			if (unrelated.length > 0) throw new Error(`Unexpected changed paths ${JSON.stringify(unrelated)}. Preserve and review those changes separately.`);
			console.log(`Release preparation completed for ${version}; review identity, every changed UI frame, and maintained notes in git diff.`);
			console.log("Run the documented local checks and open a release PR; after merge and explicit release authorization, tag the reviewed public commit through the protected release process.");
		}
	}
} catch (error) {
	console.error(`Release preparation failed during ${step}: ${error.message} Review git diff and repair that step before retrying.`);
	process.exitCode = 1;
}
