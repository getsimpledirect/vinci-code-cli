/**
 * VINCI_CODE — OS-level filesystem sandbox for the bash tool.
 *
 * Vinci runs an autonomous 4B for non-programmers. The permission guards (vinci-guard/scope) are one
 * layer, but they depend on the USER noticing a confirm — and Claude Code's own data shows users
 * approve ~93% of prompts. So we add an INDEPENDENT layer that doesn't depend on attention: run every
 * local bash/write/edit operation inside an OS sandbox that denies ungranted filesystem writes.
 * Explicit directory/file exceptions and independent protected-path rules are listed below.
 *
 *  - WRITES allowed: a project directory, explicitly approved additional directories, narrow build
 *    caches, a private process temp directory, and the backend's writable /dev. HOME, /Volumes and
 *    sibling projects are not implicit grants. Launching in HOME requires explicit authorization.
 *  - Credential and startup paths are write-protected independently of directory scope. An explicit
 *    file grant can authorize a deliberate file edit; granting its parent does not authorize it.
 *  - Cloud CLI configuration has no implicit write grant. A signed invocation or explicit directory
 *    approval can grant operational writes; credential and startup protections still apply.
 *  - Sandboxed commands cannot read locked token stores or use external NETWORK without an exact
 *    invocation grant. Project .env files and operational CLI credentials remain readable.
 *  - Destruction INSIDE a writable root is NOT this layer's job — that is the
 *    guard's confirm tiers + /undo + git. This layer stops writes to places outside the root set.
 *
 * macOS uses the built-in `sandbox-exec` (seatbelt); Linux uses `bwrap` (bubblewrap) if installed.
 * If neither is available, local bash/write/edit fail closed. VINCI_NO_SANDBOX=1 remains an explicit developer
 * bypass. Gated by VINCI_CODE; upstream Pi is untouched.
 */

import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { waitForChildProcess } from "../utils/child-process.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { getShellConfig, killProcessTree } from "../utils/shell.ts";

export function vinciSandboxEnabled(): boolean {
	return process.env.VINCI_CODE === "1" && process.env.VINCI_NO_SANDBOX !== "1";
}

const SECURITY_GRANT = /^# vinci-security-grant:([a-f0-9]{32}):([a-z,]+):([a-f0-9]{64})\n/;
const consumedSecurityGrants = new Set<string>();
const directoryGrants = new Map<string, Set<string>>();
const fileGrants = new Map<string, Set<string>>();
const configuredPathCache = new Map<string, string[]>();
let privateTemp: string | undefined;

function unwrapSecurityGrant(
	command: string,
	cwd: string,
): { command: string; networkAllowed: boolean; sensitiveReadAllowed: boolean; toolConfigRoots: string[] } {
	const match = command.match(SECURITY_GRANT);
	if (!match) return { command, networkAllowed: false, sensitiveReadAllowed: false, toolConfigRoots: [] };
	const nonce = process.env.VINCI_SECURITY_NONCE;
	const bare = command.slice(match[0].length);
	if (!nonce) return { command: bare, networkAllowed: false, sensitiveReadAllowed: false, toolConfigRoots: [] };
	const grantId = match[1];
	const scopes = match[2].split(",").sort().join(",");
	const expected = createHmac("sha256", nonce).update(`${cwd}\0${grantId}\0${scopes}\0${bare}`).digest("hex");
	const supplied = Buffer.from(match[3], "hex");
	const valid =
		!consumedSecurityGrants.has(grantId) &&
		supplied.length === expected.length / 2 &&
		timingSafeEqual(supplied, Buffer.from(expected, "hex"));
	if (valid) consumedSecurityGrants.add(grantId);
	return {
		command: bare,
		networkAllowed: valid && scopes.split(",").includes("network"),
		sensitiveReadAllowed: valid && scopes.split(",").includes("read"),
		toolConfigRoots: valid
			? scopes.split(",").flatMap((scope) => {
					const relativePath = TOOL_CONFIG_SCOPES[scope];
					return relativePath ? [join(realOrSelf(homedir()), relativePath)] : [];
				})
			: [],
	};
}

export function vinciSensitiveNoRead(cwd: string): string[] {
	const home = realOrSelf(homedir());
	const paths = [
		...LOCKED_HOME_SECRETS.map((entry) => `${home}/${entry}`),
		// Project credential-token STORES (npm / pypi / netrc auth) stay unreadable — a runaway command
		// shouldn't be able to slurp a raw token out of them.
		...[".npmrc", ".pypirc", ".netrc"].map((entry) => `${cwd}/${entry}`),
	];
	// NOTE: .env / .env.* / .envrc / *.tfvars are deliberately NOT deny-read. A project's own commands
	// (dotenv, direnv, terraform, vite, next, jest…) MUST read their config to run — blocking that broke
	// "just run my project" in Auto mode (dotenv → EPERM on .env). Redaction covers recognized formats
	// on supported tool/model boundaries; it is not a guarantee for every value or persistence path.
	// External network stays denied by default, subject to the local IPC caveat in seatbeltProfile.
	return [...new Set(paths.map(realOrSelf).filter((entry) => existsSync(entry)))];
}

function realOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function canonicalWritePath(path: string, protectedPath = false, links = 0): string | undefined {
	let candidate = resolve(path);
	const missing: string[] = [];
	for (let depth = 0; depth < 256; depth++) {
		try {
			lstatSync(candidate);
			return resolve(realpathSync(candidate), ...missing.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			try {
				if (lstatSync(candidate).isSymbolicLink()) {
					// Grants reject dangling links. Protection must also cover their future physical
					// destination, otherwise creating that destination would lose the default deny.
					if (!protectedPath || links >= 32) return undefined;
					const target = canonicalWritePath(resolve(dirname(candidate), readlinkSync(candidate)), true, links + 1);
					return target ? resolve(target, ...missing.reverse()) : undefined;
				}
			} catch {
				/* missing component */
			}
			const parent = dirname(candidate);
			if (parent === candidate) return undefined;
			missing.push(basename(candidate));
			candidate = parent;
		}
	}
	return undefined;
}

function configuredPaths(name: string): string[] {
	const value = process.env[name];
	if (!value) return [];
	if (value.length > 65536) throw new Error(`${name} exceeds the configuration size limit. Choose fewer paths.`);
	const key = `${name}\0${homedir()}\0${value}`;
	const previous = configuredPathCache.get(key);
	if (previous) return previous;
	let paths: unknown;
	try {
		paths = JSON.parse(value);
	} catch {
		throw new Error(`${name} must be a JSON array of absolute paths. Correct the launch configuration.`);
	}
	if (
		!Array.isArray(paths) ||
		paths.length > 32 ||
		paths.some((path) => typeof path !== "string" || !isAbsolute(normalizePath(path)))
	) {
		throw new Error(`${name} must contain at most 32 absolute paths. Correct the launch configuration.`);
	}
	const canonicalPaths = paths.map((path: string) => {
		const canonical = canonicalWritePath(normalizePath(path));
		if (!canonical || canonical === sep)
			throw new Error(
				`${name} cannot authorize an unresolved path or the filesystem root. Choose a narrower directory.`,
			);
		if (
			existsSync(canonical) &&
			(name.endsWith("FILES") ? !statSync(canonical).isFile() : !statSync(canonical).isDirectory())
		) {
			throw new Error(
				`${name} contains the wrong filesystem object type. Configure regular files or directories as appropriate.`,
			);
		}
		return canonical;
	});
	configuredPathCache.set(key, canonicalPaths);
	return canonicalPaths;
}

function scopedPaths(cwd: string, files = false): string[] {
	const project = realOrSelf(resolve(cwd));
	const grants = (files ? fileGrants : directoryGrants).get(project) ?? [];
	// Pin approvals to physical destinations. Retargeting a granted path does not widen its grant.
	return [
		...new Set([...grants, ...configuredPaths(files ? "VINCI_SANDBOX_WRITE_FILES" : "VINCI_SANDBOX_WRITE_ROOTS")]),
	].filter((path) => canonicalWritePath(path) === path);
}

function implicitProjectAllowed(project: string): boolean {
	return ![
		sep,
		realOrSelf(homedir()),
		realOrSelf("/Volumes"),
		realOrSelf(tmpdir()),
		realOrSelf("/tmp"),
		realOrSelf("/private/tmp"),
	].includes(project);
}

export function vinciGrantWriteDirectory(cwd: string, path: string): string {
	const canonical = canonicalWritePath(resolvePath(path, cwd));
	if (!canonical || canonical === sep)
		throw new Error(
			"Vinci cannot authorize the filesystem root or an unresolved directory. Choose a narrower directory.",
		);
	if (existsSync(canonical) && !statSync(canonical).isDirectory())
		throw new Error("The write grant requires a directory. Use /allow-file for one file.");
	const project = realOrSelf(resolve(cwd));
	const grants = directoryGrants.get(project) ?? new Set<string>();
	grants.add(canonical);
	directoryGrants.set(project, grants);
	return canonical;
}

export function vinciGrantWriteFile(cwd: string, path: string): string {
	const canonical = canonicalWritePath(resolvePath(path, cwd));
	if (!canonical || canonical === sep || (existsSync(canonical) && !statSync(canonical).isFile())) {
		throw new Error("The write grant requires a resolvable file path. Choose a regular file.");
	}
	const project = realOrSelf(resolve(cwd));
	const grants = fileGrants.get(project) ?? new Set<string>();
	grants.add(canonical);
	fileGrants.set(project, grants);
	return canonical;
}

export function vinciResetSandboxPermissions(): void {
	directoryGrants.clear();
	fileGrants.clear();
	consumedSecurityGrants.clear();
	configuredPathCache.clear();
	process.env.VINCI_SECURITY_NONCE = randomBytes(32).toString("hex");
}

export function vinciSandboxWriteGranted(cwd: string, path: string): boolean {
	const target = canonicalWritePath(path);
	if (!target) return false;
	const project = realOrSelf(resolve(cwd));
	const directories = scopedPaths(cwd);
	if (implicitProjectAllowed(project)) directories.push(project);
	return (
		scopedPaths(cwd, true).includes(target) ||
		directories.some((root) => target === root || target.startsWith(root + sep))
	);
}

function processTemp(): string {
	if (!privateTemp) {
		privateTemp = realOrSelf(mkdtempSync(join(tmpdir(), "vinci-shell-")));
		const owned = privateTemp;
		process.once("exit", () => {
			rmSync(owned, { recursive: true, force: true });
		});
	}
	return privateTemp;
}

const BUILD_CACHES = [
	".npm/_cacache",
	".npm/_logs",
	".cache/pip",
	".cache/uv",
	".cache/go-build",
	".yarn/berry/cache",
	".pnpm-store",
	".bun/install/cache",
	".cargo/registry",
];

/** No implicit HOME, sibling-parent, external-drive or shared-temp-container write authority. */
export function vinciWritableRoots(cwd: string): string[] {
	const home = realOrSelf(homedir());
	const project = realOrSelf(resolve(cwd));
	const roots = new Set(scopedPaths(cwd));
	if (implicitProjectAllowed(project)) roots.add(project);
	roots.add(processTemp());
	for (const cache of BUILD_CACHES) {
		const path = join(home, cache);
		// Cache symlinks cannot turn a default exception into a different writable directory.
		if (canonicalWritePath(path) === path) roots.add(path);
	}
	return [...roots];
}

// Default credential read/write protection is independent of directory grants. Deliberate writes
// require an exact file grant; reads require a signed invocation.
const LOCKED_HOME_SECRETS = [".ssh", ".gnupg", ".netrc", ".npmrc", ".pypirc"];

// Operational cloud configuration may need writes even for inspection (locks, active contexts,
// token caches). A signed one-command tool scope preserves that workflow without a default grant.
const TOOL_CONFIG_SCOPES: Record<string, string> = {
	gcloud: ".config/gcloud",
	aws: ".aws",
	kube: ".kube",
	docker: ".docker",
};

// Tool-directory grants leave the main credential/context files read-only by default.
const TOOL_CONFIG_PROTECTED_WRITES = [
	".aws/credentials",
	".aws/config",
	".kube/config",
	".docker/config.json",
	".config/gcloud/application_default_credentials.json",
	".config/gcloud/credentials.db",
];
const STARTUP_PATHS = [
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_logout",
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".zlogout",
	".profile",
	".gitconfig",
	".inputrc",
	".config/fish",
	".config/autostart",
	".config/systemd/user",
	".local/share/systemd/user",
	"Library/LaunchAgents",
];

export function vinciSensitiveNoWrite(_cwd: string): string[] {
	const home = realOrSelf(homedir());
	return [
		...new Set(
			[...LOCKED_HOME_SECRETS, ...TOOL_CONFIG_PROTECTED_WRITES, ...STARTUP_PATHS].flatMap((entry) => {
				const path = join(home, entry);
				return [path, canonicalWritePath(path, true) ?? path];
			}),
		),
	];
}

const SEATBELT = "/usr/bin/sandbox-exec";

/** Single-line seatbelt profile: allow everything, deny all writes, then re-allow writes to the roots. */
function seatbeltProfile(
	cwd: string,
	networkAllowed: boolean,
	sensitiveReadAllowed: boolean,
	toolConfigRoots: string[],
): string {
	const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const roots = [...vinciWritableRoots(cwd), ...toolConfigRoots].map((r) => `(subpath "${esc(r)}")`).join(" ");
	// Re-deny the credential dirs LAST so they win even if a writable root (e.g. $HOME as cwd) covers them.
	const sensitive = vinciSensitiveNoWrite(cwd)
		.map((r) => `(subpath "${esc(r)}")`)
		.join(" ");
	const sensitiveReads = vinciSensitiveNoRead(cwd)
		.map((r) => `(subpath "${esc(r)}")`)
		.join(" ");
	const files = scopedPaths(cwd, true)
		.map((path) => `(literal "${esc(path)}")`)
		.join(" ");
	return [
		"(version 1)",
		"(allow default)", // reads, exec, network stay allowed
		// Block the internet (outbound to a real remote host) but ALLOW local IPC — unix-domain sockets
		// (tsx's ESM loader, vitest workers, many dev tools) and loopback. A blanket `(deny network*)`
		// broke commands opening local sockets (observed live: tsx → EPERM on listen). Local services
		// can themselves relay data, so this is not a complete exfiltration
		// boundary. Full network is restored only under a signed one-command grant.
		networkAllowed
			? ""
			: '(deny network*) (allow network-bind (local ip)) (allow network-inbound (local ip)) (allow network-outbound (remote ip "localhost:*")) (allow network-outbound (remote unix-socket)) (allow network-bind (local unix-socket))',
		"(deny file-write*)",
		`(allow file-write* ${roots})`,
		'(allow file-write* (subpath "/dev"))', // /dev/null, /dev/tty, ptys
		sensitive ? `(deny file-write* ${sensitive})` : "", // crown jewels stay read-only (last match wins)
		files ? `(allow file-write* ${files})` : "", // explicit file authority does not unlock its parent
		!sensitiveReadAllowed && sensitiveReads ? `(deny file-read* ${sensitiveReads})` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** Single-quote a string for safe embedding in a `/bin/bash -c '…'` wrapper. */
function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellInvocation(command: string, shellPath?: string): string {
	const shell = getShellConfig(shellPath);
	const args = /(?:^|\/)bash$/.test(shell.shell) ? ["--noprofile", "--norc", "-p", ...shell.args] : shell.args;
	return [shell.shell, ...args, command].map(sq).join(" ");
}

function bwrapPath(): string | undefined {
	return ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((p) => existsSync(p));
}

/** Linux (requires bubblewrap): whole FS read-only, writable roots bound rw, network isolated by default. */
function bwrapWrap(
	bwrap: string,
	command: string,
	cwd: string,
	networkAllowed: boolean,
	sensitiveReadAllowed: boolean,
	toolConfigRoots: string[],
	shellPath?: string,
): string {
	const roots = [...vinciWritableRoots(cwd), ...toolConfigRoots];
	// Bubblewrap mounts cannot deny the creation of a missing child while its parent is writable.
	// Refuse that broad scope instead of silently losing independent startup/credential protection.
	const missingProtection = vinciSensitiveNoWrite(cwd).find(
		(path) => !existsSync(path) && roots.some((root) => path === root || path.startsWith(root + sep)),
	);
	if (missingProtection)
		throw new Error(
			`Bubblewrap cannot protect the absent sensitive path "${missingProtection}" under this write scope. Grant a narrower directory instead.`,
		);
	const files = scopedPaths(cwd, true);
	const missingFile = files.find((path) => !existsSync(path));
	if (missingFile)
		throw new Error(
			`Bubblewrap cannot bind a new explicit file grant "${missingFile}". Create the file yourself first, or grant an unprotected parent directory.`,
		);
	const binds = roots
		.filter((r) => existsSync(r))
		.map((r) => `--bind ${sq(r)} ${sq(r)}`)
		.join(" ");
	// Re-bind the credential dirs READ-ONLY after the rw binds (later binds win) so ~/.ssh etc. stay
	// unwritable even when a writable root (e.g. $HOME as cwd) covers them.
	const roBinds = vinciSensitiveNoWrite(cwd)
		.filter((r) => existsSync(r))
		.map((r) => `--ro-bind ${sq(r)} ${sq(r)}`)
		.join(" ");
	const hiddenReads = sensitiveReadAllowed
		? ""
		: vinciSensitiveNoRead(cwd)
				.map((path) => {
					try {
						return statSync(path).isDirectory()
							? `--tmpfs ${sq(path)} --remount-ro ${sq(path)}`
							: `--ro-bind /dev/null ${sq(path)}`;
					} catch {
						return "";
					}
				})
				.filter(Boolean)
				.join(" ");
	const network = networkAllowed ? "" : "--unshare-net";
	const fileBinds = files.map((path) => `--bind ${sq(path)} ${sq(path)}`).join(" ");
	// A write-only file grant must not disclose a read-locked credential. The read masks remain last.
	return `${bwrap} ${network} --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp ${binds} ${roBinds} ${fileBinds} ${hiddenReads} --chdir ${sq(cwd)} ${shellInvocation(command, shellPath)}`;
}

/**
 * Wrap a shell command so its filesystem writes stay inside the writable-root set (see the module
 * header and vinciWritableRoots): scoped project/directory grants, private temp, build caches and
 * the backend's writable /dev, with credential/startup paths independently protected.
 *
 * Returns the command UNCHANGED only when the sandbox is switched OFF — either this is not Vinci
 * (VINCI_CODE unset) or the VINCI_NO_SANDBOX=1 developer bypass is set.
 *
 * When the sandbox is ON but no enforceable backend exists — no seatbelt on darwin, no bwrap on
 * linux, or any other platform — this THROWS and the bash tool is dead for the session. That is
 * FAIL CLOSED, deliberately: running unconfined is the exact outcome this layer exists to prevent,
 * and the permission guard cannot cover for it because it depends on the user reading a prompt.
 *
 * The cost of failing closed is a user whose bash silently stops working, so `vinci/install.sh`
 * warns at install time when bubblewrap is missing, checking the same paths bwrapPath() accepts.
 */
export function vinciSandboxWrap(command: string, cwd: string, shellPath?: string): string {
	if (!vinciSandboxEnabled()) return command;
	const granted = unwrapSecurityGrant(command, cwd);
	const toolConfigRoots = granted.toolConfigRoots.filter((path) => canonicalWritePath(path) === path);

	if (process.platform === "darwin" && existsSync(SEATBELT)) {
		return `${SEATBELT} -p ${sq(seatbeltProfile(cwd, granted.networkAllowed, granted.sensitiveReadAllowed, toolConfigRoots))} ${shellInvocation(granted.command, shellPath)}`;
	}
	if (process.platform === "linux") {
		const bwrap = bwrapPath();
		if (bwrap)
			return bwrapWrap(
				bwrap,
				granted.command,
				cwd,
				granted.networkAllowed,
				granted.sensitiveReadAllowed,
				toolConfigRoots,
				shellPath,
			);
	}
	throw new Error(
		"Vinci disabled bash because no enforceable OS sandbox is available. Install bubblewrap or set VINCI_NO_SANDBOX=1 as an explicit developer bypass.",
	);
}

/** Remove ambient execution hooks and grant-control material before any local child starts. */
export function vinciSandboxChildEnv(environment: NodeJS.ProcessEnv, stripAmbientSecrets = true): NodeJS.ProcessEnv {
	const env = { ...environment };
	if (process.env.VINCI_CODE !== "1") return env;
	for (const key of Object.keys(env)) {
		if (
			(stripAmbientSecrets &&
				/(?:^|_)(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|AUTH)(?:$|_)/i.test(
					key,
				)) ||
			/^(?:VINCI_SECURITY_|VINCI_SANDBOX_|BASH_FUNC_|LD_|DYLD_)/.test(key) ||
			["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(key)
		)
			delete env[key];
	}
	if (vinciSandboxEnabled()) env.TMPDIR = processTemp();
	if (vinciSandboxEnabled()) {
		// First-run caches must not need a writable HOME just to create their parent directories.
		env.XDG_CACHE_HOME ??= join(processTemp(), "cache");
		if (env.NPM_CONFIG_CACHE === undefined && env.npm_config_cache === undefined)
			env.npm_config_cache = join(processTemp(), "npm");
	}
	return env;
}

/** Default local structured mutations use the same native policy as bash, including filesystem
 * resolution at the actual write. Extension-supplied operations remain a trusted extension surface. */
export async function vinciSandboxWriteFile(
	path: string,
	content: string,
	cwd: string,
	createParents: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const script = `${createParents ? `/bin/mkdir -p -- ${sq(dirname(path))} && ` : ""}/bin/cat > ${sq(path)}`;
	let authorizedScript = script;
	const target = canonicalWritePath(path);
	if (
		target &&
		scopedPaths(cwd, true).includes(target) &&
		vinciSensitiveNoRead(cwd).some((root) => target === root || target.startsWith(root + sep))
	) {
		// This fixed writer receives new bytes on stdin and never reads the existing file. Its exact
		// file authority must work without making arbitrary Bash code able to read a locked store.
		process.env.VINCI_SECURITY_NONCE ??= randomBytes(32).toString("hex");
		const id = randomBytes(16).toString("hex");
		const signature = createHmac("sha256", process.env.VINCI_SECURITY_NONCE)
			.update(`${cwd}\0${id}\0read\0${script}`)
			.digest("hex");
		authorizedScript = `# vinci-security-grant:${id}:read:${signature}\n${script}`;
	}
	const command = vinciSandboxWrap(authorizedScript, cwd);
	const shell = getShellConfig();
	const child = spawn(shell.shell, ["--noprofile", "--norc", "-p", ...shell.args, command], {
		cwd,
		env: vinciSandboxChildEnv(process.env),
		detached: true,
		stdio: ["pipe", "ignore", "pipe"],
	});
	let diagnostic = "";
	child.stderr.on("data", (chunk: Buffer) => {
		diagnostic = (diagnostic + chunk.toString()).slice(0, 65536);
	});
	child.stdin.on("error", () => {});
	const stop = () => {
		if (child.pid) killProcessTree(child.pid);
	};
	const timer = setTimeout(stop, 30_000);
	signal?.addEventListener("abort", stop, { once: true });
	try {
		if (signal?.aborted) stop();
		child.stdin.end(content);
		const exitCode = await waitForChildProcess(child);
		if (signal?.aborted) throw new Error("Operation aborted");
		if (exitCode !== 0)
			throw new Error(
				`Vinci could not write "${path}" inside its scoped sandbox: ${diagnostic.trim() || "writer did not complete"}. Use /allow-directory or /allow-file for deliberate additional scope, or inspect sandbox prerequisites.`,
			);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}
