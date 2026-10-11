import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	chmodSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getBinDir } from "../config.ts";
import { vinciSandboxChildEnv } from "../core/vinci-sandbox.ts";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Vinci stays offline for update/telemetry traffic but may fetch its two required search binaries. */
export function shouldBootstrapTools(env: NodeJS.ProcessEnv = process.env): boolean {
	const offline = env.PI_OFFLINE;
	const offlineEnabled = offline === "1" || offline?.toLowerCase() === "true" || offline?.toLowerCase() === "yes";
	if (!offlineEnabled) return true;
	const bootstrap = env.VINCI_TOOL_BOOTSTRAP;
	return (
		env.VINCI_CODE === "1" &&
		(bootstrap === "1" || bootstrap?.toLowerCase() === "true" || bootstrap?.toLowerCase() === "yes")
	);
}

interface PinnedAsset {
	version: string;
	sha256: string;
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	// Exact-release pins per platform/arch. The bootstrap used to resolve "latest" at run time and
	// chmod+execute whatever arrived — a takeover of the release channel, or a tampered download,
	// executed arbitrary bytes with no version pin and no content check. Every supported platform
	// now pins the exact release asset and its SHA-256; the digest is verified after download and
	// BEFORE any extraction or chmod, and a platform without a pin is refused outright (fail closed).
	//
	// BUMP PATH: pick the target release; for EVERY key below download that asset and record
	// `shasum -a 256` (the GitHub release API's asset `digest` field carries the same value); update
	// version and digest together for every entry — either one alone fails closed at runtime, by
	// design. The 2026-10-11 pins were taken from the fd 10.5.0 / ripgrep 15.2.0 release assets and
	// the darwin/arm64 pair re-verified by downloading the bytes and hashing them locally.
	pins: Record<string, PinnedAsset>;
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		pins: {
			"darwin/arm64": {
				version: "10.5.0",
				sha256: "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
			},
			"darwin/x64": {
				version: "10.5.0",
				sha256: "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590",
			},
			"linux/arm64": {
				version: "10.5.0",
				sha256: "c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c",
			},
			"linux/x64": {
				version: "10.5.0",
				sha256: "a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95",
			},
			"win32/arm64": {
				version: "10.5.0",
				sha256: "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
			},
			"win32/x64": {
				version: "10.5.0",
				sha256: "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
			},
		},
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		pins: {
			"darwin/arm64": {
				version: "15.2.0",
				sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
			},
			"darwin/x64": {
				version: "15.2.0",
				sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
			},
			"linux/arm64": {
				version: "15.2.0",
				sha256: "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
			},
			"linux/x64": {
				version: "15.2.0",
				sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
			},
			"win32/arm64": {
				version: "15.2.0",
				sha256: "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
			},
			"win32/x64": {
				version: "15.2.0",
				sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
			},
		},
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

export interface ResolvedPinnedAsset {
	version: string;
	assetName: string;
	digest: string;
}

// Explicit per-tool override for an operator who must run a different release than the pin (e.g.
// holding a tool back while an upstream regression is investigated). The DIGEST CHECK STAYS
// MANDATORY: an override that does not carry BOTH a version and this asset's digest is REFUSED,
// not silently ignored — falling back to the default pin would install a release the operator
// never asked for, and skipping the digest would reintroduce "download and hope".
// Format: VINCI_TOOL_PIN_FD=10.5.0:<64-hex sha256 of the exact asset for THIS platform>.
/** The pinned release asset for a platform, or null when no pin exists — the caller must REFUSE
 *  (never fall back to "latest", which is the unpinned, unverified download this exists to end).
 *  Exported so the integrity decision is directly testable. */
export function resolvePinnedAsset(
	tool: "fd" | "rg",
	plat: string = platform(),
	architecture: string = arch(),
): ResolvedPinnedAsset | null {
	const config = TOOLS[tool];
	if (!config) return null;
	const overrideEnv = process.env[`VINCI_TOOL_PIN_${tool.toUpperCase()}`];
	let pin: PinnedAsset | undefined;
	if (overrideEnv !== undefined) {
		const separator = overrideEnv.indexOf(":");
		const version = separator === -1 ? "" : overrideEnv.slice(0, separator);
		const sha256 = separator === -1 ? "" : overrideEnv.slice(separator + 1);
		if (/^\d+\.\d+\.\d+$/.test(version) && /^[0-9a-f]{64}$/i.test(sha256)) {
			pin = { version, sha256: sha256.toLowerCase() };
		}
	} else {
		pin = config.pins[`${plat}/${architecture}`];
	}
	if (!pin) return null;
	const assetName = config.getAssetName(pin.version, plat, architecture);
	if (!assetName) return null;
	return { version: pin.version, assetName, digest: pin.sha256 };
}

/** SHA-256 of a file on disk, streamed (release archives are a few MB, not a problem, but never
 *  buffer what a digest can stream). */
async function sha256File(path: string): Promise<string> {
	const digest = createHash("sha256");
	await pipeline(createReadStream(path), digest);
	return digest.digest("hex");
}

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { env: vinciSandboxChildEnv(process.env), stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { env: vinciSandboxChildEnv(process.env), stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool from its PINNED release (see ToolConfig.pins for the bump path).
// Exported so the integrity decision is directly testable.
export async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// The pin decides the version and the expected digest. No pin → refuse: an unpinned download
	// is exactly the "latest and hope" this exists to end (an unsupported platform has no asset
	// name either, so both failures close here, before any fetch).
	const pin = resolvePinnedAsset(tool, plat, architecture);
	if (!pin) {
		throw new Error(
			`No pinned ${config.name} release for ${plat}/${architecture} — refusing to download an unpinned, unverified binary`,
		);
	}

	const assetName = pin.assetName;

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${pin.version}/${assetName}`;
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);
	// Keep both the download and extraction in a private, unique directory. A predictable archive
	// path can follow a preexisting symlink before its bytes are verified, and concurrent downloads
	// must not substitute each other's already-verified archive.
	const stagingDir = mkdtempSync(join(TOOLS_DIR, `download_${config.binaryName}_`));
	const archivePath = join(stagingDir, assetName);
	const extractDir = join(stagingDir, "extract");

	try {
		await downloadFile(downloadUrl, archivePath);
		// Verify before extraction/chmod. A failed or incomplete fetch is cleaned up by the same
		// finally path as an integrity refusal; no unverified archive survives for a later install.
		const actualDigest = await sha256File(archivePath);
		if (actualDigest !== pin.digest) {
			throw new Error(
				`${config.name} ${pin.version} failed its integrity check: expected sha256 ${pin.digest}, got ${actualDigest}. The download was discarded; nothing was extracted or executed. Retry only with the expected release asset.`,
			);
		}
		mkdirSync(extractDir);
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		rmSync(stagingDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or null if unavailable
export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled() && !shouldBootstrapTools()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return undefined;
	}

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return path;
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return undefined;
	}
}
