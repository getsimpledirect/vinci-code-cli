import { spawnSync } from "node:child_process";
import { createHash, verify as verifySignature } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const UPDATER_SCHEMA_VERSION = 1;
const DEFAULT_MANIFEST_URL =
	"https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/manifest-beta.json";
const DEFAULT_CHECK_INTERVAL_SECONDS = 15 * 60;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 3;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 5 * 60;
const LOCK_STALE_SECONDS = 10 * 60;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RETAINED_VERSIONS = 3;

function fail(message) {
	throw new Error(message);
}

function parseVersion(version) {
	if (!VERSION_PATTERN.test(version)) fail(`Invalid Vinci version: ${version}`);
	const parts = version.split(".").map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part))) fail(`Invalid Vinci version: ${version}`);
	return parts;
}

function compareVersions(left, right) {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	for (let index = 0; index < leftParts.length; index++) {
		if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
	}
	return 0;
}

async function pathExists(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function pathIsReachable(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.new-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

function integerEnvironment(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function updaterHome() {
	return resolve(process.env.VINCI_HOME ?? join(homedir(), ".vinci-code"));
}

function updaterBinDir() {
	return resolve(process.env.VINCI_BIN_DIR ?? join(homedir(), ".local", "bin"));
}

function manifestUrl() {
	return process.env.VINCI_UPDATE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
}

function publicKeyPath() {
	return resolve(process.env.VINCI_UPDATE_PUBLIC_KEY_PATH ?? join(SCRIPT_DIR, "public-key.pem"));
}

function validateLocation(location, label) {
	let parsed;
	try {
		parsed = new URL(location);
	} catch {
		fail(`${label} must be an absolute URL`);
	}
	if (parsed.protocol === "https:") return parsed;
	if (parsed.protocol === "file:" && process.env.VINCI_UPDATE_ALLOW_FILE_URLS === "1") return parsed;
	fail(`${label} must use HTTPS`);
}

function validateManifest(envelope) {
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("Invalid update manifest envelope");
	if (!envelope.signed || typeof envelope.signed !== "object" || Array.isArray(envelope.signed)) {
		fail("Update manifest is missing its signed payload");
	}
	if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)) {
		fail("Update manifest signature is invalid");
	}
	const signed = envelope.signed;
	if (signed.schemaVersion !== 1 || signed.updaterSchemaVersion !== UPDATER_SCHEMA_VERSION) {
		fail(`Unsupported update manifest schema: ${signed.schemaVersion}/${signed.updaterSchemaVersion}`);
	}
	if (!Number.isSafeInteger(signed.sequence) || signed.sequence < 1) fail("Update sequence must be a positive integer");
	if (signed.channel !== "beta" && signed.channel !== "stable") fail("Update channel must be beta or stable");
	parseVersion(signed.version);
	parseVersion(signed.minimumVersion);
	if (compareVersions(signed.version, signed.minimumVersion) < 0) {
		fail("Manifest target version cannot be below its minimum supported version");
	}
	if (typeof signed.mandatory !== "boolean") fail("Manifest mandatory flag must be boolean");
	if (typeof signed.publishedAt !== "string" || Number.isNaN(Date.parse(signed.publishedAt))) {
		fail("Manifest publishedAt must be an ISO timestamp");
	}
	if (!signed.artifact || typeof signed.artifact !== "object" || Array.isArray(signed.artifact)) {
		fail("Update manifest is missing its artifact");
	}
	validateLocation(signed.artifact.url, "Artifact URL");
	if (typeof signed.artifact.sha256 !== "string" || !SHA256_PATTERN.test(signed.artifact.sha256)) {
		fail("Artifact SHA-256 is invalid");
	}
	if (!Number.isSafeInteger(signed.artifact.size) || signed.artifact.size < 1) {
		fail("Artifact size must be a positive integer");
	}
	return envelope;
}

async function verifyManifestText(text, keyPath = publicKeyPath()) {
	if (Buffer.byteLength(text, "utf8") > 64 * 1024) fail("Update manifest is unexpectedly large");
	let envelope;
	try {
		envelope = validateManifest(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) fail("Update manifest is not valid JSON");
		throw error;
	}
	const publicKey = await readFile(keyPath, "utf8");
	const signature = Buffer.from(envelope.signature, "base64");
	if (signature.length !== 64) fail("Update manifest signature has the wrong length");
	const verified = verifySignature(null, Buffer.from(JSON.stringify(envelope.signed)), publicKey, signature);
	if (!verified) fail("Update manifest signature verification failed");
	return envelope;
}

async function readLocation(location) {
	const parsed = validateLocation(location, "Manifest URL");
	if (parsed.protocol === "file:") return readFile(fileURLToPath(parsed), "utf8");
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		integerEnvironment("VINCI_UPDATE_CHECK_TIMEOUT_SECONDS", DEFAULT_CHECK_TIMEOUT_SECONDS) * 1000,
	);
	try {
		const response = await fetch(parsed, {
			headers: { "user-agent": "Vinci-Code-Updater/1" },
			signal: controller.signal,
		});
		if (!response.ok) fail(`Update manifest request failed with status ${response.status}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

async function downloadLocation(location, destination, maximumSize) {
	const parsed = validateLocation(location, "Artifact URL");
	await mkdir(dirname(destination), { recursive: true });
	if (parsed.protocol === "file:") {
		await copyFile(fileURLToPath(parsed), destination);
		return;
	}
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		integerEnvironment("VINCI_UPDATE_DOWNLOAD_TIMEOUT_SECONDS", DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) * 1000,
	);
	try {
		const response = await fetch(parsed, {
			headers: { "user-agent": "Vinci-Code-Updater/1" },
			signal: controller.signal,
		});
		if (!response.ok || !response.body) fail(`Update download failed with status ${response.status}`);
		const declaredSize = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredSize) && declaredSize > maximumSize) {
			fail("Update download exceeds the signed artifact size");
		}
		let received = 0;
		const limiter = new Transform({
			transform(chunk, _encoding, callback) {
				received += chunk.length;
				if (received > maximumSize) {
					callback(new Error("Update download exceeds the signed artifact size"));
					return;
				}
				callback(null, chunk);
			},
		});
		await pipeline(response.body, limiter, createWriteStream(destination, { mode: 0o600 }));
	} finally {
		clearTimeout(timer);
	}
}

async function sha256File(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function statePath(home) {
	return join(home, "update-state.json");
}

async function readState(home) {
	try {
		const state = await readJson(statePath(home));
		return state && typeof state === "object" && !Array.isArray(state) ? state : {};
	} catch (error) {
		if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
		throw error;
	}
}

async function currentTarget(home, name = "current") {
	const link = join(home, name);
	try {
		const target = await readlink(link);
		return resolve(dirname(link), target);
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "EINVAL") return undefined;
		throw error;
	}
}

async function versionAt(path) {
	const identity = await readJson(join(path, "vinci", "identity.json"));
	if (typeof identity.version !== "string") fail(`Installed Vinci identity has no version: ${path}`);
	parseVersion(identity.version);
	return identity.version;
}

async function currentVersion(home) {
	const target = await currentTarget(home);
	return target ? versionAt(target) : undefined;
}

// Retention is defined by reachability plus a bounded window: `current` and `previous` are the
// only versions the updater itself can reach (rollback merely swaps those two links), and the
// RETAINED_VERSIONS most recent are kept on top so a long-running process launched from an older
// build does not have its payload deleted underneath it. Residual risk: a process older than that
// window can still lose its files. Everything else under versions/ is orphaned.
async function pruneVersions(home) {
	try {
		const versions = join(home, "versions");

		// Containment guard: refuse to prune unless versions/ is a real directory. readdir() and
		// rm() both follow symlinks, so a symlinked versions/ would reach outside the Vinci home.
		let versionsStat;
		try {
			versionsStat = await lstat(versions);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		if (!versionsStat.isDirectory()) return;

		// Resolve the live targets via realpath so symlink indirection cannot cause a retained
		// directory to be deleted. If `current` cannot be resolved (e.g. a dangling symlink),
		// prune nothing — a broken current must never authorise deletions.
		const currentResolved = await currentTarget(home);
		if (!currentResolved) return;
		let currentReal;
		try {
			currentReal = await realpath(currentResolved);
		} catch {
			return;
		}

		// `previous` failing to resolve must never silently shrink the retained set, so the
		// failure is isolated here: treat it as "no previous" and carry on.
		let previousReal;
		try {
			const previousResolved = await currentTarget(home, "previous");
			if (previousResolved) previousReal = await realpath(previousResolved);
		} catch {
			previousReal = undefined;
		}

		const retained = new Set([currentReal]);
		if (previousReal) retained.add(previousReal);

		let entries;
		try {
			entries = await readdir(versions);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}

		// Keep the RETAINED_VERSIONS most recent entries by semantic version order. Entries that
		// are not valid versions are ignored here, but remain prunable below.
		const namedVersions = entries.filter((entry) => VERSION_PATTERN.test(entry));
		namedVersions.sort(compareVersions);
		for (const entry of namedVersions.slice(-RETAINED_VERSIONS)) {
			try {
				retained.add(await realpath(join(versions, entry)));
			} catch {
				// Unresolvable: not retained by the count rule, though it may still be
				// retained as current/previous above.
			}
		}

		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const entryPath = join(versions, entry);
			let entryReal;
			try {
				entryReal = await realpath(entryPath);
			} catch {
				// Unreachable entry (e.g. a dangling symlink): prunable as a link-only removal.
				await rm(entryPath, { force: true });
				continue;
			}
			if (retained.has(entryReal)) continue;

			// Do not follow symlinks: if an entry is itself a symlink, remove the link only,
			// never its target.
			let entryStat;
			try {
				entryStat = await lstat(entryPath);
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
			if (entryStat.isSymbolicLink()) {
				await rm(entryPath, { force: true });
			} else {
				await rm(entryPath, { recursive: true, force: true });
			}
		}
	} catch (error) {
		console.error(`[vinci update] Pruning skipped: ${error.message}`);
	}
}

async function setLinkAtomic(link, target) {
	await mkdir(dirname(link), { recursive: true });
	const temporary = `${link}.new-${process.pid}-${Date.now()}`;
	await rm(temporary, { force: true });
	await symlink(target, temporary, "dir");
	await rename(temporary, link);
}

async function acquireLock(home) {
	await mkdir(home, { recursive: true });
	const lockPath = join(home, "update.lock");
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
			return { handle, lockPath };
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const details = await stat(lockPath);
				if (Date.now() - details.mtimeMs > LOCK_STALE_SECONDS * 1000) {
					await rm(lockPath, { force: true });
					continue;
				}
			} catch (statError) {
				if (statError?.code === "ENOENT") continue;
				throw statError;
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
		}
	}
	fail("Another Vinci update is still running");
}

async function withUpdateLock(home, operation) {
	const lock = await acquireLock(home);
	try {
		return await operation();
	} finally {
		await lock.handle.close();
		await rm(lock.lockPath, { force: true });
	}
}

function inspectArchive(archive) {
	const result = spawnSync("tar", ["-tzf", archive], {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.status !== 0) fail(`Could not inspect the Vinci archive: ${result.stderr.trim()}`);
	const entries = result.stdout.split("\n").filter(Boolean);
	if (entries.length === 0 || entries.length > 100_000) fail("Vinci archive has an invalid entry count");
	for (const entry of entries) {
		const normalized = posix.normalize(entry);
		if (entry.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
			fail(`Unsafe path in Vinci archive: ${entry}`);
		}
	}
}

function extractArchive(archive, destination) {
	inspectArchive(archive);
	const result = spawnSync("tar", ["-xzf", archive, "-C", destination], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: 120_000,
	});
	if (result.status !== 0) fail(`Could not extract the Vinci archive: ${result.stderr.trim()}`);
}

async function validatePayload(path, expectedVersion) {
	const version = await versionAt(path);
	if (version !== expectedVersion) fail(`Artifact version ${version} does not match manifest ${expectedVersion}`);
	const launcher = join(path, "vinci", "bin", "vinci");
	const updater = join(path, "vinci", "updater", "update.mjs");
	const shim = join(path, "vinci", "updater", "vinci");
	const key = join(path, "vinci", "updater", "public-key.pem");
	for (const required of [launcher, updater, shim, key]) {
		if (!(await pathExists(required))) fail(`Vinci artifact is incomplete: ${required}`);
	}
	return { launcher, updater, shim, key };
}

async function smokePayload(path) {
	const smokeHome = join(dirname(path), `.smoke-${process.pid}-${Date.now()}`);
	await mkdir(smokeHome, { recursive: true });
	try {
		const result = spawnSync("bash", [join(path, "vinci", "bin", "vinci"), "--version"], {
			cwd: path,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: smokeHome,
				VINCI_NO_RESUME: "1",
				VINCI_TOOL_BOOTSTRAP: "0",
				VINCI_UPDATE_DISABLED: "1",
			},
			timeout: 30_000,
		});
		if (result.status !== 0) fail(`Vinci update smoke check failed: ${(result.stderr || result.stdout).trim()}`);
	} finally {
		await rm(smokeHome, { recursive: true, force: true });
	}
}

async function installBootstrap(home, binDir, payload) {
	const updaterDir = join(home, "updater");
	const homeBin = join(home, "bin");
	await mkdir(updaterDir, { recursive: true });
	await mkdir(homeBin, { recursive: true });
	for (const [source, destination, mode] of [
		[payload.updater, join(updaterDir, "update.mjs"), 0o755],
		[payload.key, join(updaterDir, "public-key.pem"), 0o644],
		[payload.shim, join(homeBin, "vinci"), 0o755],
	]) {
		const temporary = `${destination}.new-${process.pid}`;
		await copyFile(source, temporary);
		await chmod(temporary, mode);
		await rename(temporary, destination);
	}
	await mkdir(binDir, { recursive: true });
	await setLinkAtomic(join(binDir, "vinci"), join(homeBin, "vinci"));
}

async function activateTarget(home, target, manifest, stateOverrides = {}) {
	const existing = await currentTarget(home);
	if (existing && existing !== target) await setLinkAtomic(join(home, "previous"), existing);
	await setLinkAtomic(join(home, "current"), target);
	const state = await readState(home);
	await writeJsonAtomic(statePath(home), {
		...state,
		lastSequence: manifest.signed.sequence,
		activeVersion: manifest.signed.version,
		lastUpdatedAt: new Date().toISOString(),
		...stateOverrides,
	});
}

async function installExtracted(home, binDir, source, manifest) {
	return withUpdateLock(home, async () => {
		const payload = await validatePayload(source, manifest.signed.version);
		await smokePayload(source);
		const versions = join(home, "versions");
		const target = join(versions, manifest.signed.version);
		await mkdir(versions, { recursive: true });
		if (await pathExists(target)) {
			await validatePayload(target, manifest.signed.version);
		} else {
			await rename(source, target);
		}
		const installedPayload = await validatePayload(target, manifest.signed.version);
		await installBootstrap(home, binDir, installedPayload);
		await activateTarget(home, target, manifest, { binDir, channel: manifest.signed.channel });
		await pruneVersions(home);
		return target;
	});
}

async function downloadAndInstall(home, manifest, forceSameSequence = false) {
	return withUpdateLock(home, async () => {
		const state = await readState(home);
		const lastSequence = Number.isSafeInteger(state.lastSequence) ? state.lastSequence : 0;
		if (manifest.signed.sequence < lastSequence) fail("Refusing a replayed Vinci update manifest");
		if (manifest.signed.sequence === lastSequence && !forceSameSequence) {
			const active = await currentTarget(home);
			if (!active) fail("Vinci Code has no active version. Re-run the installer.");
			return active;
		}
		const downloads = join(home, "downloads");
		const versions = join(home, "versions");
		await mkdir(downloads, { recursive: true });
		await mkdir(versions, { recursive: true });
		const artifact = join(downloads, `vinci-code-${manifest.signed.version}-${manifest.signed.sequence}.tgz`);
		const temporaryArtifact = `${artifact}.new-${process.pid}`;
		const stage = join(versions, `.staging-${manifest.signed.version}-${process.pid}-${Date.now()}`);
		try {
			console.error(`[vinci update] Downloading Vinci Code ${manifest.signed.version}...`);
			await downloadLocation(manifest.signed.artifact.url, temporaryArtifact, manifest.signed.artifact.size);
			const details = await stat(temporaryArtifact);
			if (details.size !== manifest.signed.artifact.size) fail("Downloaded Vinci artifact has the wrong size");
			const digest = await sha256File(temporaryArtifact);
			if (digest !== manifest.signed.artifact.sha256) fail("Downloaded Vinci artifact failed SHA-256 verification");
			await rename(temporaryArtifact, artifact);
			await mkdir(stage, { recursive: true });
			extractArchive(artifact, stage);
			await validatePayload(stage, manifest.signed.version);
			await smokePayload(stage);
			const target = join(versions, manifest.signed.version);
			if (await pathExists(target)) {
				await validatePayload(target, manifest.signed.version);
				await rm(stage, { recursive: true, force: true });
			} else {
				await rename(stage, target);
			}
			// Refresh the bootstrap updater and shim from the payload we just installed.
			//
			// Without this, the updater can never fix ITSELF. The launcher runs
			// $VINCI_HOME/updater/update.mjs — the bootstrap copy — and only installExtracted (the
			// installer path) refreshed it. Self-updates shipped new payloads while leaving the
			// executing updater frozen at whatever version the user last ran the installer with.
			//
			// Observed in the wild on 0.0.35: both the 0.0.34 and 0.0.35 payloads contained the
			// version-pruning logic, yet the running bootstrap was months older and had none of it,
			// so versions/ kept growing exactly as before the fix. Every future updater change —
			// including security-relevant ones — had the same delivery problem.
			//
			// Overwriting the running script is safe: Node has already read it into memory, and
			// installBootstrap writes via a temp file plus rename, so a reader never sees a partial
			// file. Failure here must not fail the update — the new payload is already installed and
			// activated, and a stale bootstrap is exactly the status quo we are improving on.
			try {
				const installedPayload = await validatePayload(target, manifest.signed.version);
				await installBootstrap(home, updaterBinDir(), installedPayload);
			} catch (error) {
				console.error(`[vinci update] Bootstrap refresh skipped: ${error.message}`);
			}
			await activateTarget(home, target, manifest, { channel: manifest.signed.channel });
			console.error(`[vinci update] Updated to Vinci Code ${manifest.signed.version}.`);
			await pruneVersions(home);
			return target;
		} finally {
			await rm(temporaryArtifact, { force: true });
			await rm(artifact, { force: true });
			await rm(stage, { recursive: true, force: true });
		}
	});
}

async function cachedManifest(home) {
	const path = join(home, "cache", "manifest.json");
	if (!(await pathExists(path))) return undefined;
	return verifyManifestText(await readFile(path, "utf8"));
}

async function resolveManifest(home, force) {
	const state = await readState(home);
	const interval = integerEnvironment("VINCI_UPDATE_INTERVAL_SECONDS", DEFAULT_CHECK_INTERVAL_SECONDS) * 1000;
	const lastChecked = typeof state.lastCheckedAt === "string" ? Date.parse(state.lastCheckedAt) : Number.NaN;
	if (!force && Number.isFinite(lastChecked) && Date.now() - lastChecked < interval) {
		const cached = await cachedManifest(home);
		if (cached) return cached;
	}
	try {
		const text = await readLocation(manifestUrl());
		const manifest = await verifyManifestText(text);
		await withUpdateLock(home, async () => {
			const latestState = await readState(home);
			const lastSequence = Number.isSafeInteger(latestState.lastSequence) ? latestState.lastSequence : 0;
			if (manifest.signed.sequence < lastSequence) fail("Refusing a replayed Vinci update manifest");
			const cachePath = join(home, "cache", "manifest.json");
			await mkdir(dirname(cachePath), { recursive: true });
			const temporary = `${cachePath}.new-${process.pid}`;
			await writeFile(temporary, text, { mode: 0o600 });
			await rename(temporary, cachePath);
			await writeJsonAtomic(statePath(home), { ...latestState, lastCheckedAt: new Date().toISOString() });
		});
		return manifest;
	} catch (error) {
		const cached = await cachedManifest(home);
		if (cached) return cached;
		throw error;
	}
}

function updateRequired(version, manifest) {
	return manifest.signed.mandatory || compareVersions(version, manifest.signed.minimumVersion) < 0;
}

async function beforeLaunch() {
	// VINCI_ENV=dev is the supported dev-backend mode (see vinci/bin/vinci): no dev update channel
	// exists, so a dev session must never auto-update or touch prod update state. The launcher also
	// exports VINCI_UPDATE_DISABLED=1 for dev, but the installed shim runs this updater BEFORE the
	// launcher — honoring VINCI_ENV here keeps the guarantee on that path too.
	if (process.env.VINCI_UPDATE_DISABLED === "1" || process.env.VINCI_ENV === "dev") return 0;
	const home = updaterHome();
	const version = await currentVersion(home);
	if (!version) fail("Vinci Code has no active version. Re-run the installer.");
	let manifest;
	try {
		manifest = await resolveManifest(home, false);
	} catch (error) {
		console.error(`[vinci update] Update check skipped: ${error.message}`);
		return 0;
	}
	const state = await readState(home);
	const lastSequence = Number.isSafeInteger(state.lastSequence) ? state.lastSequence : 0;
	if (manifest.signed.sequence <= lastSequence) return 0;
	if (manifest.signed.version === version) {
		await withUpdateLock(home, async () => {
			const latestState = await readState(home);
			await writeJsonAtomic(statePath(home), {
				...latestState,
				activeVersion: version,
				lastSequence: manifest.signed.sequence,
			});
		});
		return 0;
	}
	try {
		await downloadAndInstall(home, manifest);
		return 0;
	} catch (error) {
		if (updateRequired(version, manifest)) {
			console.error(`BLOCKED: update — Vinci Code ${manifest.signed.version} is required but could not be installed.`);
			console.error(`Reason: ${error.message}`);
			console.error("Your existing version and task checkpoints were left untouched. Run `vinci update` to retry.");
			return 75;
		}
		console.error(`[vinci update] Update deferred: ${error.message}`);
		return 0;
	}
}

async function updateNow() {
	const home = updaterHome();
	const version = await currentVersion(home);
	if (!version) fail("Vinci Code has no active version. Re-run the installer.");
	const manifest = await resolveManifest(home, true);
	if (manifest.signed.version === version) {
		await withUpdateLock(home, async () => {
			const state = await readState(home);
			const lastSequence = Number.isSafeInteger(state.lastSequence) ? state.lastSequence : 0;
			await writeJsonAtomic(statePath(home), {
				...state,
				activeVersion: version,
				lastSequence: Math.max(lastSequence, manifest.signed.sequence),
			});
		});
		console.log(`Vinci Code ${version} is current.`);
		return 0;
	}
	await downloadAndInstall(home, manifest, true);
	return 0;
}

async function checkNow() {
	const home = updaterHome();
	const version = await currentVersion(home);
	if (!version) fail("Vinci Code has no active version. Re-run the installer.");
	const manifest = await resolveManifest(home, true);
	const required = updateRequired(version, manifest);
	console.log(`Installed: ${version}`);
	console.log(`Available: ${manifest.signed.version} (${manifest.signed.channel})`);
	console.log(`Update: ${manifest.signed.version === version ? "current" : required ? "required" : "automatic"}`);
	return 0;
}

async function rollback() {
	const home = updaterHome();
	return withUpdateLock(home, async () => {
		const current = await currentTarget(home);
		const previous = await currentTarget(home, "previous");
		if (!current || !previous) fail("No previous Vinci Code version is available to roll back to");
		const previousVersion = await versionAt(previous);
		await setLinkAtomic(join(home, "previous"), current);
		await setLinkAtomic(join(home, "current"), previous);
		const state = await readState(home);
		await writeJsonAtomic(statePath(home), {
			...state,
			activeVersion: previousVersion,
			rolledBackAt: new Date().toISOString(),
		});
		console.log(`Rolled back to Vinci Code ${previousVersion}.`);
		return 0;
	});
}

// The effective environment, resolved with the same precedence as the launcher (vinci/bin/vinci):
// an explicitly set variable always wins; otherwise VINCI_ENV=dev supplies the dev-box defaults
// and anything else resolves to production. This bootstrap file stays dependency-free, so the
// endpoint literals are restated here rather than imported from vinci-links.ts.
function environmentReport() {
	const raw = process.env.VINCI_ENV || "prod";
	const dev = raw === "dev";
	// Match the launcher's contract: any value other than prod/dev is refused at launch, so a
	// diagnostic that printed it as if it were a real environment would be lying. Unknown values
	// resolve to the prod endpoints below (exactly what a non-dev value means to every consumer).
	const environment = dev || raw === "prod" ? raw : `${raw} (INVALID — the launcher will refuse to start; supported: prod, dev)`;
	return {
		environment,
		gateway:
			process.env.VINCI_BASE_URL ||
			(dev ? "https://3.98.156.231.sslip.io/api/v1" : "https://vinci.getsimpledirect.com/api/v1"),
		platform:
			process.env.VINCI_PLATFORM_URL ||
			(dev ? "https://platform.3.98.156.231.sslip.io" : "https://platform.getsimpledirect.com"),
		agentDir: process.env.VINCI_CODING_AGENT_DIR || join(homedir(), dev ? ".pi-dev" : ".pi", "agent"),
	};
}

async function doctor() {
	const home = updaterHome();
	const target = await currentTarget(home);
	if (!target) fail("No active Vinci Code version");
	const version = await versionAt(target);
	const checks = [
		join(home, "bin", "vinci"),
		join(home, "updater", "update.mjs"),
		join(home, "updater", "public-key.pem"),
		join(target, "vinci", "bin", "vinci"),
	];
	const state = await readState(home);
	if (typeof state.binDir === "string") checks.push(join(state.binDir, "vinci"));
	for (const path of checks) if (!(await pathIsReachable(path))) fail(`Missing installation component: ${path}`);
	const report = environmentReport();
	console.log(`Vinci Code ${version}`);
	console.log(`Active: ${target}`);
	console.log(`Environment: ${report.environment}`);
	console.log(`Gateway: ${report.gateway}`);
	console.log(`Platform: ${report.platform}`);
	console.log(`Agent config: ${report.agentDir}`);
	console.log("Updater: ready");
	console.log("Installation: healthy");
	return 0;
}

function option(args, name) {
	const index = args.indexOf(name);
	if (index === -1 || !args[index + 1] || args[index + 1].startsWith("--")) fail(`${name} requires a value`);
	return args[index + 1];
}

async function main(args) {
	const command = args[0] ?? "before-launch";
	if (command === "verify-manifest") {
		await verifyManifestText(await readFile(resolve(option(args, "--manifest")), "utf8"));
		return 0;
	}
	if (command === "install-extracted") {
		const home = resolve(option(args, "--home"));
		const binDir = resolve(option(args, "--bin-dir"));
		const source = resolve(option(args, "--source"));
		const manifest = await verifyManifestText(await readFile(resolve(option(args, "--manifest")), "utf8"));
		const target = await installExtracted(home, binDir, source, manifest);
		console.log(`Installed Vinci Code ${manifest.signed.version} to ${target}`);
		return 0;
	}
	// Internal. Both production prune call sites run activateTarget() first, which always
	// re-points `current` at a freshly installed version — so the "current is unresolvable"
	// guard is unreachable through any normal update path and cannot be exercised end to end.
	// This entry point invokes the prune directly so that guard stays pinned by a test.
	if (command === "prune-versions") {
		await pruneVersions(resolve(option(args, "--home")));
		return 0;
	}
	if (command === "before-launch") return beforeLaunch();
	if (command === "update") return updateNow();
	if (command === "check") return checkNow();
	if (command === "rollback") return rollback();
	if (command === "doctor") return doctor();
	fail(`Unknown Vinci updater command: ${command}`);
}

main(process.argv.slice(2))
	.then((status) => {
		process.exitCode = status;
	})
	.catch((error) => {
		console.error(`[vinci update] ${error.message}`);
		process.exitCode = 1;
	});

// payload-updater-version: 0.0.42
