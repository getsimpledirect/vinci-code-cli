/**
 * VINCI_CODE — OS-level filesystem sandbox for the bash tool.
 *
 * Vinci runs an autonomous 4B for non-programmers. The permission guards (vinci-guard/scope) are one
 * layer, but they depend on the USER noticing a confirm — and Claude Code's own data shows users
 * approve ~93% of prompts. So we add an INDEPENDENT layer that doesn't depend on attention: run every
 * bash command inside an OS sandbox that confines FILESYSTEM WRITES to the workspace, so a runaway
 * command physically cannot `rm -rf ~/Documents`, overwrite `~/.ssh/authorized_keys`, or scribble on
 * `/etc` — regardless of whether a guard caught it.
 *
 * Scope of the policy (deliberately not paranoid, so it doesn't break real work):
 *  - WRITES allowed: the project (cwd), its workspace PARENT (so sibling projects the user edits still
 *    work — e.g. run Vinci in vinci-code, edit ../French-learning-tool), temp dirs, and package caches
 *    (~/.npm, ~/.cache, …). Everything else on disk is read-only.
 *  - Credential reads and NETWORK are denied unless the guard signs one exact invocation.
 *  - In-workspace destruction (rm -rf inside the project) is NOT this layer's job — that's the guard +
 *    /undo + git. This layer stops ESCAPE from the workspace.
 *
 * macOS uses the built-in `sandbox-exec` (seatbelt); Linux uses `bwrap` (bubblewrap) if installed.
 * If neither is available, bash fails closed. VINCI_NO_SANDBOX=1 remains an explicit developer
 * bypass. Gated by VINCI_CODE; upstream Pi is untouched.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";

export function vinciSandboxEnabled(): boolean {
	return process.env.VINCI_CODE === "1" && process.env.VINCI_NO_SANDBOX !== "1";
}

const SECURITY_GRANT = /^# vinci-security-grant:([a-f0-9]{32}):([a-z,]+):([a-f0-9]{64})\n/;
const consumedSecurityGrants = new Set<string>();

function unwrapSecurityGrant(
	command: string,
	cwd: string,
): { command: string; networkAllowed: boolean; sensitiveReadAllowed: boolean } {
	const match = command.match(SECURITY_GRANT);
	if (!match) return { command, networkAllowed: false, sensitiveReadAllowed: false };
	const nonce = process.env.VINCI_SECURITY_NONCE;
	const bare = command.slice(match[0].length);
	if (!nonce) return { command: bare, networkAllowed: false, sensitiveReadAllowed: false };
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
	// "just run my project" in Auto mode (dotenv → EPERM on .env). The real protection is intact: the
	// model-channel redaction masks every secret VALUE in tool output before it reaches the model, the
	// display masker hides it on screen, and exfil still needs the network grant. This only restores the
	// OS-level read that legitimate project processes depend on — the model still never sees raw values.
	return [...new Set(paths.map(realOrSelf).filter((entry) => existsSync(entry)))];
}

function realOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Directories the agent may WRITE to. Exported for tests. The rest of the filesystem is read-only.
 */
export function vinciWritableRoots(cwd: string): string[] {
	const home = realOrSelf(homedir());
	const roots = new Set<string>();

	const project = realOrSelf(cwd);
	// Writes are deliberately NOT confined to the launch cwd. Confining them meant Vinci could write
	// source files into a folder (e.g. ~/Desktop/Test Folder) that shell commands could then never
	// build in — npm install got EPERM on mkdir node_modules, and the model only discovered the
	// boundary through a string of failures. Claude Code and Codex both reach anywhere the user can,
	// so we match that: $HOME covers everywhere a person actually keeps work.
	//
	// What this does NOT relax, and must not: "/" is still never a root (that would void the sandbox
	// entirely), and the credential stores below (~/.ssh, ~/.gnupg, ~/.netrc, ~/.npmrc, ~/.pypirc plus
	// ~/.aws/credentials) are re-denied as the LAST rule, so they stay locked even though $HOME is
	// writable. Catastrophic commands (rm -rf /, mkfs, …) remain hard-blocked in vinci-guard.
	if (project !== "/") roots.add(project);
	if (home !== "/") roots.add(home);
	roots.add("/Volumes"); // a project on an external drive should work too

	// The workspace parent (e.g. ~/Documents/GitHub) so sibling projects work — but ONLY when it's a
	// strict subdirectory of $HOME. Never widen to $HOME itself or "/" (that would defeat the sandbox).
	const parent = realOrSelf(dirname(project));
	if (parent !== project && parent !== home && parent.startsWith(`${home}/`)) {
		roots.add(parent);
	}

	// Temp.
	roots.add(realOrSelf(tmpdir()));
	for (const t of ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]) roots.add(t);

	// Package/build caches that live under $HOME.
	for (const c of [".npm", ".cache", ".yarn", ".pnpm-store", ".bun", ".cargo/registry", "Library/Caches"]) {
		roots.add(`${home}/${c}`);
	}

	// CLI tool config dirs — writable so gcloud/aws/kubectl/docker can update their own lock files,
	// active config, and token caches. Without this they can't run at all. The bwrap path filters
	// non-existent roots; the seatbelt path tolerates them. Sensitive files inside (~/.aws/credentials)
	// are re-denied write via vinciSensitiveNoWrite (last match wins).
	for (const d of TOOL_CONFIG_DIRS) {
		roots.add(realOrSelf(`${home}/${d}`));
	}

	return [...roots];
}

// Static credential stores under $HOME with NO legitimate reason for a tool to WRITE (or for the agent
// to READ) during a task — fully locked, no read and no write. These are static secret files, not
// tool-operational config: a runaway command must never append to ~/.ssh/authorized_keys or read a
// private key. Applied as the LAST rule (last match wins).
const LOCKED_HOME_SECRETS = [".ssh", ".gnupg", ".netrc", ".npmrc", ".pypirc"];

// CLI tool config dirs that MUST be readable+writable for the tool to function AT ALL — gcloud rewrites
// active_config + a lock file on nearly every command (even `gcloud config get-value`), kubectl updates
// its current-context, aws/docker read their creds to auth and write token/context caches. Locking
// these does NOT protect them; it BRICKS the tool and forces the exact manual-handoff-to-terminal that
// Vinci exists to avoid (observed live: a customer's gcloud task dead-ended on a blocked write to
// ~/.config/gcloud/active_config). We keep them out of the locked set so the tools run. The exposure is
// bounded: exfiltrating anything read here still needs NETWORK, which stays denied by default, and the
// dangerous *operations* (gcloud storage rm, aws s3 rm) are gated by the guard/confirmation layer — not
// this filesystem layer, whose job is to stop workspace ESCAPE.
const TOOL_CONFIG_DIRS = [".config/gcloud", ".aws", ".kube", ".docker"];

// The one integrity exception inside the tool dirs: ~/.aws/credentials holds long-lived keys the aws CLI
// only READS (it writes short-lived tokens to sso/cache + cli/cache, never here). Keep it write-denied so
// a runaway command can't rewrite/append to it, while the rest of ~/.aws stays writable so aws works.
const TOOL_CONFIG_PROTECTED_WRITES = [".aws/credentials"];

export function vinciSensitiveNoWrite(cwd: string): string[] {
	const home = realOrSelf(homedir());
	const writable = new Set(vinciWritableRoots(cwd));
	// Only worth denying the ones a writable root would otherwise expose — and never a path that IS
	// (or contains) the project itself, so a repo that happens to live at ~/.docker/foo still works.
	return [...LOCKED_HOME_SECRETS, ...TOOL_CONFIG_PROTECTED_WRITES]
		.map((s) => `${home}/${s}`)
		.filter((p) => ![...writable].some((w) => w === p || w.startsWith(`${p}/`)));
}

const SEATBELT = "/usr/bin/sandbox-exec";

/** Single-line seatbelt profile: allow everything, deny all writes, then re-allow writes to the roots. */
function seatbeltProfile(cwd: string, networkAllowed: boolean, sensitiveReadAllowed: boolean): string {
	const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const roots = vinciWritableRoots(cwd)
		.map((r) => `(subpath "${esc(r)}")`)
		.join(" ");
	// Re-deny the credential dirs LAST so they win even if a writable root (e.g. $HOME as cwd) covers them.
	const sensitive = vinciSensitiveNoWrite(cwd)
		.map((r) => `(subpath "${esc(r)}")`)
		.join(" ");
	const sensitiveReads = vinciSensitiveNoRead(cwd)
		.map((r) => `(subpath "${esc(r)}")`)
		.join(" ");
	return [
		"(version 1)",
		"(allow default)", // reads, exec, network stay allowed
		// Block the internet (outbound to a real remote host) but ALLOW local IPC — unix-domain sockets
		// (tsx's ESM loader, vitest workers, many dev tools) and loopback. A blanket `(deny network*)`
		// broke every command that opens a local socket (observed live: tsx → EPERM on listen). Secrets
		// still can't be exfiltrated: outbound to a remote IP stays denied; only localhost + unix sockets
		// are permitted. Full network is restored only under a signed one-command grant.
		networkAllowed
			? ""
			: '(deny network*) (allow network-bind (local ip)) (allow network-inbound (local ip)) (allow network-outbound (remote ip "localhost:*")) (allow network-outbound (remote unix-socket)) (allow network-bind (local unix-socket))',
		"(deny file-write*)",
		`(allow file-write* ${roots})`,
		'(allow file-write* (subpath "/dev"))', // /dev/null, /dev/tty, ptys
		sensitive ? `(deny file-write* ${sensitive})` : "", // crown jewels stay read-only (last match wins)
		!sensitiveReadAllowed && sensitiveReads ? `(deny file-read* ${sensitiveReads})` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** Single-quote a string for safe embedding in a `/bin/bash -c '…'` wrapper. */
function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
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
): string {
	const binds = vinciWritableRoots(cwd)
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
						return statSync(path).isDirectory() ? `--tmpfs ${sq(path)}` : `--ro-bind /dev/null ${sq(path)}`;
					} catch {
						return "";
					}
				})
				.filter(Boolean)
				.join(" ");
	const network = networkAllowed ? "" : "--unshare-net";
	return `${bwrap} ${network} --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp ${binds} ${roBinds} ${hiddenReads} --chdir ${sq(cwd)} /bin/bash -c ${sq(command)}`;
}

/**
 * Wrap a shell command so its filesystem writes are confined to the workspace.
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
export function vinciSandboxWrap(command: string, cwd: string): string {
	if (!vinciSandboxEnabled()) return command;
	const granted = unwrapSecurityGrant(command, cwd);

	if (process.platform === "darwin" && existsSync(SEATBELT)) {
		return `${SEATBELT} -p ${sq(seatbeltProfile(cwd, granted.networkAllowed, granted.sensitiveReadAllowed))} /bin/bash -c ${sq(granted.command)}`;
	}
	if (process.platform === "linux") {
		const bwrap = bwrapPath();
		if (bwrap) return bwrapWrap(bwrap, granted.command, cwd, granted.networkAllowed, granted.sensitiveReadAllowed);
	}
	throw new Error(
		"Vinci disabled bash because no enforceable OS sandbox is available. Install bubblewrap or set VINCI_NO_SANDBOX=1 as an explicit developer bypass.",
	);
}
