import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

// The tools dir is a module-level constant resolved from the agent dir at import time, so the
// isolated dir must be in place BEFORE the module loads — a real download would otherwise write
// into the user's actual agent dir.
const agentRoot = mkdtempSync(join(tmpdir(), "vinci-tools-bootstrap-"));
process.env.VINCI_CODING_AGENT_DIR = agentRoot;

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const tools = await loader.import(resolve(here, "../../packages/coding-agent/src/utils/tools-manager.ts"), {
	default: false,
});

assert.equal(tools.shouldBootstrapTools({}), true);
assert.equal(tools.shouldBootstrapTools({ VINCI_TOOL_BOOTSTRAP: "0" }), false);
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "0", VINCI_TOOL_BOOTSTRAP: "true" }), true);
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "1" }), false);
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1" }), false);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "1" }),
	false,
);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "true", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "true" }),
	false,
);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "0" }),
	false,
);
for (const allowance of ["", "/synthetic/missing-policy.json"]) {
	for (const offline of [undefined, "1", "true", "yes"]) {
		assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: offline, VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "1", VINCI_QA_ALLOWANCE_FILE: allowance }), false);
	}
}

process.stdout.write("  tool bootstrap: offline and QA policy override every bootstrap opt-in\n");

// ── Pinned-release integrity (audit 2026-10-11) ────────────────────────────────────────────────
// The bootstrap used to resolve "latest" over the network and chmod+execute whatever arrived. Now
// every platform pins the exact release asset and its SHA-256; the digest is verified before any
// extraction or chmod; a missing pin refuses. The download is MOCKED here — this never touches the
// network, and the served "release" is a real tar.gz built in a temp dir (extraction is real).
const binDir = join(agentRoot, "bin");

// A REAL tar.gz nested like a real fd release: fd-v9.9.9-aarch64-apple-darwin/fd.
function buildArchive(payload) {
	const staging = mkdtempSync(join(agentRoot, "archive-"));
	const nested = join(staging, "fd-v9.9.9-aarch64-apple-darwin");
	execFileSync("mkdir", ["-p", nested]);
	writeFileSync(join(nested, "fd"), payload);
	chmodSync(join(nested, "fd"), 0o755);
	const archive = join(staging, "fd-v9.9.9-aarch64-apple-darwin.tar.gz");
	execFileSync("tar", ["-czf", archive, "-C", staging, "fd-v9.9.9-aarch64-apple-darwin"]);
	const data = readFileSync(archive);
	rmSync(staging, { recursive: true, force: true });
	return data;
}

const cleanArchive = buildArchive(Buffer.from("#!/bin/sh\nclean probe fd stub\n"));
const tamperedArchive = buildArchive(Buffer.from("#!/bin/sh\ntampered probe fd stub\n"));
assert.notEqual(cleanArchive.equals(tamperedArchive), true, "probe archives must differ");
const cleanSha = createHash("sha256").update(cleanArchive).digest("hex");
const wrongSha = createHash("sha256").update("not-the-archive").digest("hex");
assert.notEqual(cleanSha, wrongSha);

const checks = [];
function check(name, condition) {
	assert.ok(condition, name);
	checks.push(name);
}

// Pin resolution: exact versions and digests, per platform; no pin → null (fail closed).
const fdPin = tools.resolvePinnedAsset("fd", "darwin", "arm64");
check(
	"fd pins darwin/arm64 to the exact release asset with a 64-hex digest",
	fdPin?.version === "10.5.0" &&
		fdPin?.assetName === "fd-v10.5.0-aarch64-apple-darwin.tar.gz" &&
		/^[0-9a-f]{64}$/.test(fdPin?.digest ?? ""),
);
const rgPin = tools.resolvePinnedAsset("rg", "linux", "x64");
check(
	"rg pins linux/x64 to the musl asset with a digest",
	rgPin?.assetName === "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz" &&
		/^[0-9a-f]{64}$/.test(rgPin?.digest ?? ""),
);
check("a platform with no pin resolves to null (fails closed)", tools.resolvePinnedAsset("fd", "freebsd", "x64") === null);

const originalFetch = globalThis.fetch;
const environmentKeys = ["PI_OFFLINE", "VINCI_CODE", "VINCI_TOOL_BOOTSTRAP", "VINCI_QA_ALLOWANCE_FILE", "PATH"];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
try {
	// Refuse before fetch or filesystem staging, even if a caller invokes the exported
	// downloader directly. A missing/empty QA path cannot reopen bootstrap while startup
	// diagnoses an invalid allowance. The negative control's fetch is inert, never real.
	let blockedFetchCalls = 0;
	globalThis.fetch = async () => { blockedFetchCalls++; throw new Error("inert unexpected download attempt"); };
	process.env.PATH = join(agentRoot, "no-tools-on-path");
	process.env.VINCI_CODE = "1";
	process.env.VINCI_TOOL_BOOTSTRAP = "1";
	for (const offline of [undefined, "1", "true", "yes"]) {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
		for (const allowance of ["", join(agentRoot, "missing-policy.json")]) {
			process.env.VINCI_QA_ALLOWANCE_FILE = allowance;
			for (const tool of ["fd", "rg"]) {
				assert.equal(await tools.ensureTool(tool, true), undefined);
				await assert.rejects(tools.downloadTool(tool), /disabled by the offline or QA request policy/);
			}
		}
	}
	delete process.env.VINCI_QA_ALLOWANCE_FILE;
	process.env.PI_OFFLINE = "1";
	process.env.VINCI_TOOL_BOOTSTRAP = "0";
	for (const tool of ["fd", "rg"]) {
		assert.equal(await tools.ensureTool(tool, true), undefined);
		await assert.rejects(tools.downloadTool(tool), /disabled by the offline or QA request policy/);
	}
	check("offline/QA policy blocks ensure and direct download with zero fetch calls", blockedFetchCalls === 0);
	check("offline/QA refusal creates no tool directory or download stage", !existsSync(binDir));
	if (originalEnvironment.PATH === undefined) delete process.env.PATH;
	else process.env.PATH = originalEnvironment.PATH;
	process.env.PI_OFFLINE = "0";
	process.env.VINCI_CODE = "1";
	process.env.VINCI_TOOL_BOOTSTRAP = "1";
	// Digest match → the install proceeds (fetch used, binary placed, executable). The override
	// pins the test release for THIS platform (the mock serves the bytes; tar extraction is real).
	process.env.VINCI_TOOL_PIN_FD = `9.9.9:${cleanSha}`;
	const thisPin = tools.resolvePinnedAsset("fd");
	assert.ok(thisPin, "the override pin must resolve for this platform");
	const expectedUrl = `https://github.com/sharkdp/fd/releases/download/v${thisPin.version}/${thisPin.assetName}`;
	mkdirSync(binDir, { recursive: true });
	const untouched = join(agentRoot, "inert-neighbor");
	writeFileSync(untouched, "keep these fixture bytes");
	symlinkSync(untouched, join(binDir, thisPin.assetName));
	let privateStageObserved = false;
	const fetchedUrls = [];
	globalThis.fetch = async (url) => {
		fetchedUrls.push(String(url));
		const stages = readdirSync(binDir).filter((name) => name.startsWith("download_fd_"));
		privateStageObserved = stages.length === 1 && (statSync(join(binDir, stages[0])).mode & 0o777) === 0o700;
		return new Response(cleanArchive, { status: 200 });
	};
	const binaryPath = join(binDir, "fd");
	const installed = await tools.downloadTool("fd");
	check(
		"digest match: the pinned download installs (exact pinned URL, binary placed, executable)",
		installed === binaryPath &&
			fetchedUrls.length === 1 &&
			fetchedUrls[0] === expectedUrl &&
			existsSync(binaryPath) &&
			(statSync(binaryPath).mode & 0o111) !== 0,
	);
	check(
		"digest match: the installed binary is the archive's own payload",
		readFileSync(binaryPath, "utf8").includes("clean probe fd stub"),
	);
	check("private bootstrap staging ignores the old predictable archive link", readFileSync(untouched, "utf8") === "keep these fixture bytes");
	check("bootstrap staging is unique, private and cleaned after a successful install", privateStageObserved && !readdirSync(binDir).some((name) => name.startsWith("download_fd_")));
	rmSync(binDir, { recursive: true, force: true });

	// Digest mismatch → refuses with a clear error; nothing extracted, chmodded, or executed.
	process.env.VINCI_TOOL_PIN_FD = `9.9.9:${wrongSha}`;
	fetchedUrls.length = 0;
	globalThis.fetch = async () => {
		fetchedUrls.push("called");
		return new Response(tamperedArchive, { status: 200 });
	};
	let mismatchError = null;
	try {
		await tools.downloadTool("fd");
	} catch (error) {
		mismatchError = error;
	}
	check(
		"digest mismatch: the install refuses with an integrity error and never installs the bytes",
		mismatchError !== null &&
			/integrity check/i.test(String(mismatchError.message ?? mismatchError)) &&
			!existsSync(join(binDir, "fd")),
	);
	check("digest mismatch cleans private staging", !readdirSync(binDir).some((name) => name.startsWith("download_fd_")));
	rmSync(binDir, { recursive: true, force: true });
	process.env.VINCI_TOOL_PIN_FD = `9.9.9:${cleanSha}`;
	globalThis.fetch = async () => { throw new Error("inert interrupted download"); };
	await assert.rejects(tools.downloadTool("fd"), /inert interrupted download/);
	check("an interrupted download cleans staging before returning its error", !readdirSync(binDir).some((name) => name.startsWith("download_fd_")));

	// Missing digest (override without one) → fails closed BEFORE any download.
	process.env.VINCI_TOOL_PIN_FD = "9.9.9";
	fetchedUrls.length = 0;
	let noDigestError = null;
	try {
		await tools.downloadTool("fd");
	} catch (error) {
		noDigestError = error;
	}
	check(
		"a pin without a digest refuses before any download",
		noDigestError !== null &&
			/refus/i.test(String(noDigestError.message ?? noDigestError)) &&
			fetchedUrls.length === 0,
	);

	// A malformed override digest is refused the same way, not parsed hopefully.
	process.env.VINCI_TOOL_PIN_FD = "9.9.9:deadbeef";
	fetchedUrls.length = 0;
	let malformedError = null;
	try {
		await tools.downloadTool("fd");
	} catch (error) {
		malformedError = error;
	}
	check(
		"a malformed override digest refuses rather than skipping the check",
		malformedError !== null && /refus/i.test(String(malformedError.message ?? malformedError)) && fetchedUrls.length === 0,
	);
} finally {
	globalThis.fetch = originalFetch;
	for (const key of environmentKeys) {
		if (originalEnvironment[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnvironment[key];
	}
	delete process.env.VINCI_TOOL_PIN_FD;
	rmSync(agentRoot, { recursive: true, force: true });
}

for (const name of checks) process.stdout.write(`  ✓ ${name}\n`);
process.stdout.write(
	`  tool bootstrap: ${checks.length}/${checks.length} pinned-release integrity checks passed (digest match installs, mismatch refuses, no pin fails closed)\n`,
);
