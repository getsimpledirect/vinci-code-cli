import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

const temporary = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "release-preparation-"));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
delete env.GIT_INDEX_FILE;

function git(cwd, args) {
	return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
}

function remove(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) remove(path);
		else unlinkSync(path);
	}
	rmdirSync(directory);
}
after(() => remove(temporary));

function fixture(name, { hoistedVitest = false } = {}) {
	const root = join(temporary, name);
	mkdirSync(join(root, "vinci/scripts"), { recursive: true });
	mkdirSync(join(root, "vinci/test/ui/snapshots"), { recursive: true });
	mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
	const vitestPath = hoistedVitest ? "node_modules/vitest/dist/cli.js" : "packages/coding-agent/node_modules/vitest/dist/cli.js";
	mkdirSync(join(root, vitestPath, ".."), { recursive: true });
	copyFileSync(new URL("./prepare-release.mjs", import.meta.url), join(root, "vinci/scripts/prepare-release.mjs"));
	writeFileSync(join(root, "vinci/identity.json"), '{"version":"1.0.0","productName":"Vinci Code"}\n');
	writeFileSync(join(root, "package.json"), '{"version":"0.0.3"}\n');
	writeFileSync(join(root, "packages/coding-agent/package.json"), '{"version":"9.0.0"}\n');
	writeFileSync(join(root, "vinci/test/ui/snapshots/screen.txt"), "Vinci 1.0.0\n");
	// This fixture checks dispatch and partial-diff behavior, not UI rendering. The real script
	// must invoke the unchanged Vitest entrypoint with the exact scenario path and update flag.
	writeFileSync(join(root, vitestPath), `
const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.deepEqual(process.argv.slice(2), ["--root", process.cwd(), "--run",
"--exclude", "**/node_modules/**", "--exclude", "**/dist/**", "--exclude", "**/.claude/**", "--exclude", "**/.*/**",
"--pool=forks", "--maxWorkers=1", "--no-file-parallelism", "--configLoader", "native", "--no-cache",
"vinci/test/ui/scenarios.test.mjs"]);
assert.equal(process.env.UPDATE_VINCI_UI_SNAPSHOTS, "1");
assert.ok(process.env.TMPDIR.startsWith(process.cwd()));
const identity = JSON.parse(fs.readFileSync("vinci/identity.json", "utf8"));
fs.writeFileSync("vinci/test/ui/snapshots/screen.txt", "Vinci " + identity.version + "\\n");
if (process.env.FIXTURE_UNRELATED_CHANGE === "1") fs.writeFileSync("unexpected.txt", "Keep this evidence.\\n");
if (process.env.FIXTURE_SNAPSHOT_FAIL === "1") process.exit(7);
`);
	git(root, ["init", "-q", "-b", "release/vinci-v1.0.1"]);
	git(root, ["config", "user.name", "Release Preparation Fixture"]);
	git(root, ["config", "user.email", "release-fixture@example.invalid"]);
	git(root, ["add", "vinci/scripts/prepare-release.mjs", "vinci/identity.json", "package.json", "packages/coding-agent/package.json", "vinci/test/ui/snapshots/screen.txt", vitestPath]);
	git(root, ["commit", "-qm", "test: initialize release fixture"]);
	const origin = join(temporary, `${name}-origin`);
	mkdirSync(origin);
	git(origin, ["init", "--bare", "-q"]);
	git(origin, ["fetch", "-q", root, "HEAD:refs/heads/main"]);
	git(root, ["remote", "add", "origin", origin]);
	const notes = join(temporary, `${name}-notes.md`);
	writeFileSync(notes, "Copying is easier in this release.\n");
	return {
		root, origin, notes,
		run: (args = [], overrides = {}) => spawnSync(process.execPath, ["vinci/scripts/prepare-release.mjs", "1.0.1", "--notes-file", notes, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10000 }),
	};
}

test("release preparation dry-run validates but invokes no snapshot command and writes no files", () => {
	const f = fixture("dry-run");
	const result = f.run(["--dry-run"], { FIXTURE_SNAPSHOT_FAIL: "1" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /dry run completed after validation/);
	assert.equal(git(f.root, ["status", "--porcelain"]), "");
	assert.equal(existsSync(join(f.root, "vinci/release-notes/1.0.1.md")), false);
});

test("release preparation updates product identity, copies notes and uses the hoisted snapshot runner", () => {
	const f = fixture("success", { hoistedVitest: true });
	const head = git(f.root, ["rev-parse", "HEAD"]);
	const notes = readFileSync(f.notes, "utf8");
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(join(f.root, "vinci/identity.json"), "utf8")).version, "1.0.1");
	assert.equal(readFileSync(join(f.root, "vinci/release-notes/1.0.1.md"), "utf8"), notes);
	assert.equal(readFileSync(f.notes, "utf8"), notes, "the supplied maintained notes are not edited in place");
	assert.equal(readFileSync(join(f.root, "vinci/test/ui/snapshots/screen.txt"), "utf8"), "Vinci 1.0.1\n");
	assert.equal(JSON.parse(readFileSync(join(f.root, "package.json"), "utf8")).version, "0.0.3");
	assert.equal(JSON.parse(readFileSync(join(f.root, "packages/coding-agent/package.json"), "utf8")).version, "9.0.0");
	assert.equal(git(f.root, ["rev-parse", "HEAD"]), head, "preparation must not commit");
	assert.equal(git(f.root, ["tag", "--list"]), "", "preparation must not create a release tag");
	assert.match(result.stdout, /open a release PR/);
	assert.equal(readdirSync(f.root).some((name) => name.startsWith(".vinci-release-")), false);
});

test("local and unfetched remote immutable tags refuse preparation before any write", () => {
	for (const target of ["local", "remote"]) {
		const f = fixture(`tag-${target}`);
		git(target === "local" ? f.root : f.origin, ["tag", "vinci-v1.0.1", target === "local" ? "HEAD" : "refs/heads/main"]);
		const result = f.run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, target === "local" ? /immutable local tag/ : /immutable remote tag/);
		assert.equal(git(f.root, ["status", "--porcelain"]), "");
	}
});

test("wrong branch and unrelated changes refuse preparation before writes", () => {
	const branch = fixture("wrong-branch");
	git(branch.root, ["branch", "-m", "feature"]);
	assert.match(branch.run().stderr, /Create and select/);
	assert.equal(git(branch.root, ["status", "--porcelain"]), "");
	const dirty = fixture("dirty");
	writeFileSync(join(dirty.root, "unrelated.txt"), "Keep this work.\n");
	assert.match(dirty.run().stderr, /own clean branch/);
	assert.equal(readFileSync(join(dirty.root, "vinci/identity.json"), "utf8"), '{"version":"1.0.0","productName":"Vinci Code"}\n');
});

test("a failed snapshot command preserves a reviewable partial diff and names the failed step", () => {
	const f = fixture("failed-snapshot");
	const result = f.run([], { FIXTURE_SNAPSHOT_FAIL: "1" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /failed during UI snapshot regeneration/);
	assert.match(result.stderr, /Snapshot regeneration exited 7/);
	assert.match(result.stderr, /Review git diff and repair that step before retrying/);
	assert.equal(JSON.parse(readFileSync(join(f.root, "vinci/identity.json"), "utf8")).version, "1.0.1");
	assert.ok(existsSync(join(f.root, "vinci/release-notes/1.0.1.md")));
	assert.match(git(f.root, ["diff", "--name-only"]), /vinci\/identity\.json/);
	assert.equal(readdirSync(f.root).some((name) => name.startsWith(".vinci-release-")), false);
});

test("a clean release branch on an older commit refuses the live main mismatch", () => {
	const f = fixture("stale-main");
	git(f.root, ["commit", "--allow-empty", "-qm", "test: advance fixture main"]);
	git(f.origin, ["fetch", "-q", f.root, "HEAD:refs/heads/main"]);
	const newer = git(f.root, ["rev-parse", "HEAD"]);
	// Select the original commit only within this isolated fixture; the real worktree is untouched.
	git(f.root, ["update-ref", "refs/heads/release/vinci-v1.0.1", `${newer}^`]);
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /current live origin\/main/);
	assert.equal(git(f.root, ["status", "--porcelain"]), "");
});

test("unexpected snapshot-side changes are reported and preserved", () => {
	const f = fixture("unexpected-diff");
	const result = f.run([], { FIXTURE_UNRELATED_CHANGE: "1" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /failed during prepared diff validation/);
	assert.match(result.stderr, /unexpected\.txt/);
	assert.equal(readFileSync(join(f.root, "unexpected.txt"), "utf8"), "Keep this evidence.\n");
	assert.ok(existsSync(join(f.root, "vinci/release-notes/1.0.1.md")));
	const failed = fixture("unexpected-failed-diff");
	const failure = failed.run([], { FIXTURE_UNRELATED_CHANGE: "1", FIXTURE_SNAPSHOT_FAIL: "1" });
	assert.equal(failure.status, 1);
	assert.match(failure.stderr, /failed during UI snapshot regeneration/);
	assert.match(failure.stderr, /unexpected\.txt/);
	assert.equal(readFileSync(join(failed.root, "unexpected.txt"), "utf8"), "Keep this evidence.\n");
});

test("invalid versions and empty maintained notes refuse preparation before writes", () => {
	const f = fixture("invalid-input");
	for (const version of ["1.0.0", "0.9.9", "01.0.1", "1.0.1-beta", "1.0.1/other"]) {
		const result = spawnSync(process.execPath, ["vinci/scripts/prepare-release.mjs", version, "--notes-file", f.notes], {
			cwd: f.root, env, encoding: "utf8", timeout: 10000,
		});
		assert.equal(result.status, 1, version);
		assert.equal(git(f.root, ["status", "--porcelain"]), "", version);
	}
	writeFileSync(f.notes, "\n");
	assert.match(f.run().stderr, /nonempty maintained release notes/);
	assert.equal(git(f.root, ["status", "--porcelain"]), "");
});
