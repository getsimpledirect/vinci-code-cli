import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "1" }), false);
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1" }), false);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "1" }),
	true,
);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "true", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "true" }),
	true,
);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "0" }),
	false,
);

process.stdout.write("  tool bootstrap: Vinci can provision fd/rg without enabling update or telemetry traffic\n");

// ── Pinned-release integrity (audit 2026-10-11) ────────────────────────────────────────────────
// The bootstrap used to resolve "latest" over the network and chmod+execute whatever arrived. Now
// every platform pins the exact release asset and its SHA-256; the digest is verified before any
// extraction or chmod; a missing pin refuses. The download is MOCKED here — this never touches the
// network, and the served "release" is a real tar.gz built in a temp dir (extraction is real).
const binDir = join(agentRoot, "bin");

// A REAL tar.gz nested like a real fd release: fd-v9.9.9-aarch64-apple-darwin/fd.
function buildArchive(payload) {
	const staging = mkdtempSync(join(tmpdir(), "vinci-archive-"));
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
try {
	// Digest match → the install proceeds (fetch used, binary placed, executable). The override
	// pins the test release for THIS platform (the mock serves the bytes; tar extraction is real).
	process.env.VINCI_TOOL_PIN_FD = `9.9.9:${cleanSha}`;
	const thisPin = tools.resolvePinnedAsset("fd");
	assert.ok(thisPin, "the override pin must resolve for this platform");
	const expectedUrl = `https://github.com/sharkdp/fd/releases/download/v${thisPin.version}/${thisPin.assetName}`;
	const fetchedUrls = [];
	globalThis.fetch = async (url) => {
		fetchedUrls.push(String(url));
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
	rmSync(binDir, { recursive: true, force: true });

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
	delete process.env.VINCI_TOOL_PIN_FD;
	rmSync(agentRoot, { recursive: true, force: true });
}

for (const name of checks) process.stdout.write(`  ✓ ${name}\n`);
process.stdout.write(
	`  tool bootstrap: ${checks.length}/${checks.length} pinned-release integrity checks passed (digest match installs, mismatch refuses, no pin fails closed)\n`,
);
