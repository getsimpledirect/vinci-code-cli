import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usage = "Usage: node vinci/test/report-wrong-packaged.mjs <unpacked-root> [--deny-source <dir>]...";
const [rootArgument, ...options] = process.argv.slice(2);
assert.ok(rootArgument, usage);
const root = realpathSync(rootArgument);
const sourceRoots = [];
for (let index = 0; index < options.length; index += 2) {
	assert.ok(options[index] === "--deny-source" && options[index + 1], usage);
	sourceRoots.push(realpathSync(options[index + 1]));
}
assert.ok(
	sourceRoots.length === 0 || (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")),
	"Source exclusion requires macOS sandbox-exec. Use a separate installed-artifact filesystem before retrying.",
);

function writeSession(sessionDir, taskId, cwd) {
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `${taskId}.jsonl`);
	const recordedAt = "2026-07-12T12:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: taskId, timestamp: "2026-07-12T11:59:00.000Z", cwd },
		{
			type: "message",
			id: "message1",
			parentId: null,
			timestamp: "2026-07-12T11:59:30.000Z",
			message: { role: "assistant", content: [], timestamp: 1 },
		},
		{
			type: "custom",
			customType: "vinci-task-outcome",
			data: {
				schemaVersion: 1,
				taskId,
				state: "DONE",
				reason: "Direct check passed.",
				changedFiles: ["index.js"],
				verificationStatus: "passed",
				verificationCommand: "node --test",
				activeDurationMs: 12_000,
				usage: {
					modelCalls: 4,
					inputTokens: 100,
					outputTokens: 20,
					cachedTokens: 300,
					cacheWriteTokens: 0,
					reasoningTokens: 10,
					estimatedCostUsd: 0.025,
					providers: ["test-provider"],
					models: ["test-model"],
				},
				recordedAt,
			},
			id: "outcome1",
			parentId: "message1",
			timestamp: recordedAt,
		},
	];
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

function runReport(treeRoot, home, sessions, taskId, note) {
	let profile;
	if (sourceRoots.length) {
		const permittedTree = `(require-not (subpath ${JSON.stringify(realpathSync(treeRoot))}))`;
		const permittedHome = `(require-not (subpath ${JSON.stringify(realpathSync(home))}))`;
		// Keep path metadata available for Node realpath while denying source file contents.
		profile = [
			"(version 1)",
			"(allow default)",
			...sourceRoots.map(
				(source) => `(deny file-read-data (require-all (subpath ${JSON.stringify(source)}) ${permittedTree} ${permittedHome}))`,
			),
			...sourceRoots.map(
				(source) => `(deny file-write* (require-all (subpath ${JSON.stringify(source)}) ${permittedHome}))`,
			),
		].join("\n");
	}
	const command = profile ? "/usr/bin/sandbox-exec" : "bash";
	const args = [
		...(profile ? ["-p", profile, "bash"] : []),
		join(treeRoot, "vinci/bin/vinci"),
		"report-wrong",
		taskId,
		note,
		"--session-dir",
		sessions,
	];
	return spawnSync(command, args, {
		cwd: home,
		env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, VINCI_NO_BOOTSTRAP_HEAL: "1" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 90_000,
	});
}

assert.ok(
	lstatSync(join(root, "packages/coding-agent/src"), { throwIfNoEntry: false }) === undefined,
	"P1: the archive ships no packages/coding-agent/src entry",
);
assert.ok(existsSync(join(root, "vinci/bin/vinci")), "P2: the unpacked root must contain vinci/bin/vinci");

const home = mkdtempSync(join(tmpdir(), "vinci-report-wrong-packaged-"));
try {
	const taskId = "packaged-report-task";
	const syntheticToken = `ghp_${"TESTONLY"}${"r".repeat(32)}`;
	const note = `the run was rejected with ${syntheticToken} again`;
	const sessions = join(home, "sessions");
	const sessionPath = writeSession(sessions, taskId, home);
	const positive = runReport(root, home, sessions, taskId, note);
	assert.equal(
		positive.status,
		0,
		`P2: the packaged launcher must succeed. ${positive.error?.message ?? positive.stderr}`,
	);
	const stored = readFileSync(sessionPath, "utf8");
	assert.equal(stored.includes("ghp_"), false, "P2: the packaged report must leave no part of the credential in the session");
	const report = stored.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
	assert.equal(report?.customType, "vinci-false-completion-report", "P2: the packaged launcher must append a report");
	assert.match(report?.data?.note ?? "", /^the run was rejected with <vinci-secret> again$/, "P2: the rest of the note is kept");

	const copy = join(home, "relocated");
	cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
	const copiedCore = join(realpathSync(copy), "packages/coding-agent/dist/core");
	assert.equal(realpathSync(copiedCore), copiedCore, "P3: the built masker directory must be inside the copy");
	const copySessions = join(home, "relocated-sessions");
	const copyPath = writeSession(copySessions, taskId, home);
	const copyPositive = runReport(copy, home, copySessions, taskId, note);
	assert.equal(
		copyPositive.status,
		0,
		`P3: the intact relocated launcher must succeed. ${copyPositive.error?.message ?? copyPositive.stderr}`,
	);
	const copyStored = readFileSync(copyPath, "utf8");
	assert.doesNotMatch(copyStored, /ghp_/, "P3: the relocated report must leave no credential prefix in the session");
	const copyReport = copyStored.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
	assert.equal(copyReport?.customType, "vinci-false-completion-report", "P3: the intact copy must append a report");
	assert.match(
		copyReport?.data?.note ?? "",
		/^the run was rejected with <vinci-secret> again$/,
		"P3: the intact copy must store a masked note",
	);
	assert.match(copyPositive.stdout, /Recorded/, "P3: the intact copy must confirm the report");

	unlinkSync(join(copiedCore, "vinci-mask-secrets.js"));
	const negativeSessions = join(home, "negative-sessions");
	const negativePath = writeSession(negativeSessions, taskId, home);
	const before = readFileSync(negativePath);
	const negative = runReport(copy, home, negativeSessions, taskId, note);
	assert.ok(
		negative.status !== null && negative.status !== 0,
		"P3: the packaged launcher must exit nonzero without the built masker",
	);
	assert.match(negative.stderr, /secret masker "vinciMaskSecrets" could not load/, "P3: the failure names the missing masker");
	assert.deepEqual(readFileSync(negativePath), before, "P3: the failed launch leaves the session unchanged");
	assert.doesNotMatch(negative.stdout, /Recorded/, "P3: the failed launch must not claim a report");
} finally {
	rmSync(home, { recursive: true, force: true });
}

console.log("report-wrong-packaged: 3/3 passed");
