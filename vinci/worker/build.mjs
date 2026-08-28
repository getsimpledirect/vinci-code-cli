// W0.5 exact build identity: which build of the worker produced a record, and which build of
// the server it talked to. Both are computed ONCE at daemon start and stamped on every task
// record, on the `online` bus post and on the final bus post, so a soak cohort can be proven to
// have run on one exact build set (build skew between the two worker boxes, and between worker
// and server, has already caused live failures).
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;

// The one PATH resolver for every executable the worker spawns (run.mjs imports it from here).
// It lives in this file so that vinciBinaryVersion() resolves `vinci` EXACTLY the way runVinci
// does, and so that build.mjs stays standalone (it is copied alone into bare temp dirs by tests).
export function resolveBin(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Executable not found on PATH: ${name}`);
}

// `git` is used ONLY for `dirty` (best-effort). `commit` never depends on it: the daemon runs
// as an unprivileged user on a root-owned checkout, where git refuses with "dubious ownership"
// (#17), so the commit is read from the checkout's own files instead. The checkout root is
// passed as `safe.directory` command-line config (which git treats as protected, like the
// system config) so that `dirty` still answers on such a checkout; an exact path is accepted
// by every git that has `safe.directory` at all (the `*` wildcard needs >= 2.35.3). When git
// is missing or still refuses, the caller records `null` (unknown), never `false`.
function git(args, cwd, safeDirectory) {
  try {
    const result = spawnSync("git", ["-c", `safe.directory=${safeDirectory}`, "-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

function readVersion(dir) {
  try {
    return JSON.parse(readFileSync(`${dir}/../identity.json`, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// The daemon's own package root: this file is `<root>/vinci/worker/build.mjs` and the version
// is `<root>/vinci/identity.json`, so the root is two levels above the worker dir.
export function packageRoot(dir = dirname(fileURLToPath(import.meta.url))) {
  return resolve(dir, "../..");
}

// The `.git` entry (of ANY kind) at `root` ONLY — never a parent's. A packaged daemon installed
// under some unrelated repository (say `/opt/.git` above `/opt/vinci/…`) must not report that
// repository's commit as its own build, so discovery does not walk up: a `.git` anywhere
// above the package root is treated as ABSENT (a packaged install, bare version). Returns
// null when there is no entry at `root`; otherwise `{ root, entry, kind }` — even when the
// entry turns out to be unusable, because "a `.git` is here but cannot be read" is an
// unresolved checkout, not a packaged install.
export function findGitEntry(root) {
  const dir = resolve(root);
  const entry = join(dir, ".git");
  try {
    const stat = statSync(entry);
    return { root: dir, entry, kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other" };
  } catch {
    return null;
  }
}

// `{ gitDir, commonDir }` for a `.git` entry. A directory is the repository itself; a FILE is a
// `gitdir: <path>` pointer (a linked worktree or a submodule), in which case `gitDir` is the
// per-worktree dir (HEAD lives there) and `commonDir` the main repository (`refs/heads/*` and
// `packed-refs` live there; git records it in `<gitDir>/commondir`). Returns null when the
// entry is unusable: an unreadable or malformed pointer file, or a pointer whose target is not
// a directory.
export function resolveGitDirs({ root, entry, kind }) {
  if (kind === "dir") return { gitDir: entry, commonDir: entry };
  if (kind !== "file") return null;
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(entry) ?? "");
  if (!pointer) return null;
  const gitDir = resolve(root, pointer[1]);
  try {
    if (!statSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const common = readText(join(gitDir, "commondir"))?.trim();
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

// Entry lookup + pointer resolution in one step (null when either fails). `root` is the
// directory holding `.git`, never a descendant of it.
export function findGitDir(root) {
  const found = findGitEntry(root);
  return found ? resolveGitDirs(found) : null;
}

function readPackedRef(commonDir, ref) {
  const packed = readText(join(commonDir, "packed-refs"));
  if (!packed) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref) return sha ?? null;
  }
  return null;
}

// A ref name we are willing to open as a file: `refs/` followed by non-empty segments of safe
// characters, where no segment is `.` or `..` (a hostile ref cannot name a path outside the
// git dir). Checked BEFORE any filesystem access.
const REF_SEGMENT = /^[\w@-][\w.@-]*$/;
function isSafeRefName(ref) {
  const segments = ref.split("/");
  if (segments.length < 2 || segments[0] !== "refs") return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && REF_SEGMENT.test(segment));
}
const MAX_REF_HOPS = 8;

// The text of the loose ref `ref` under `baseDir`, or null when there is none — or when the
// file the name leads to does not actually live under `baseDir` (a symlink or any other route
// out of the git dir): fail closed, never read a file outside the checkout's own git dir.
function readContainedRef(baseDir, ref) {
  let base;
  let target;
  try {
    base = realpathSync(baseDir);
    target = realpathSync(join(baseDir, ref));
  } catch {
    return null;
  }
  if (!target.startsWith(base + sep)) return null;
  return readText(target);
}

// Resolve one ref VALUE (the text of HEAD or of a ref file) to a 40-hex sha. A detached value
// is the sha itself; `ref: <name>` is followed — loose file (per-worktree dir first, then the
// common dir), then `packed-refs` — recursively, since a branch may itself be symbolic
// (`HEAD -> refs/heads/x -> refs/heads/y`). A cycle, a chain deeper than MAX_REF_HOPS, an
// unsafe name, or a value that is neither a sha nor a ref yields null.
function resolveRefValue({ gitDir, commonDir }, value, visited = new Set()) {
  const text = (value ?? "").trim();
  if (FULL_SHA.test(text)) return text;
  const symbolic = /^ref:\s*(\S+)$/.exec(text);
  if (!symbolic) return null;
  const ref = symbolic[1];
  if (!isSafeRefName(ref) || visited.has(ref) || visited.size >= MAX_REF_HOPS) return null;
  visited.add(ref);
  const next = readContainedRef(gitDir, ref) ?? readContainedRef(commonDir, ref) ?? readPackedRef(commonDir, ref);
  if (next === null) return null;
  return resolveRefValue({ gitDir, commonDir }, next, visited);
}

// HEAD of the checkout at `gitDir` as a 40-hex sha, reading the checkout's files directly (no
// git exec, so no ownership check). Returns null when HEAD cannot be resolved to a full sha —
// an unborn branch, an unreadable or truncated file, a symbolic-ref cycle, or a shape this
// reader does not understand.
export function readHeadCommit(dirs) {
  const head = readText(join(dirs.gitDir, "HEAD"));
  if (head === null) return null;
  return resolveRefValue(dirs, head);
}

// `{ version, commit, dirty, source, unresolved }` for the checkout THIS file runs from. Never
// throws.
//   version:    identity.json version (the existing `vinci_version`)
//   commit:     full 40-hex HEAD sha read from the `.git` at the package root (`<root>/vinci/
//               worker/build.mjs` => `<root>/.git`; never via git exec, never a parent's
//               `.git`), or null when this is not a git checkout or HEAD could not be resolved
//   dirty:      true when `git status --porcelain --untracked-files=no` is non-empty, false
//               when clean, null when unknown (git missing or refusing — best-effort only).
//               Untracked files are ignored on purpose: the default state dir
//               (`.vinci-worker-state`) may sit inside the checkout and must not make every
//               build read as dirty.
//   source:     "git" when the commit was resolved, otherwise "package"
//   unresolved: true when a `.git` entry EXISTS but `commit` could not be resolved from it —
//               unborn branch, unreadable HEAD, malformed or dangling `gitdir:` pointer,
//               symbolic-ref cycle. A checkout whose identity is unknown is NOT a packaged
//               install and is announced as such (`<version>-UNRESOLVED`, see
//               formatWorkerBuild). Only a checkout with NO `.git` entry at all is a package.
export function buildIdentity(dir = dirname(fileURLToPath(import.meta.url))) {
  const version = readVersion(dir);
  let found = null;
  try {
    found = findGitEntry(packageRoot(dir));
  } catch {
    found = null;
  }
  // ABSENT: no `.git` entry at the package root — a packaged install, nothing to resolve. (A
  // `.git` further up belongs to some other repository and is ignored on purpose.)
  if (!found) return { version, commit: null, dirty: null, source: "package", unresolved: false };
  // PRESENT: from here on, a null commit is an unresolved checkout, never a packaged install.
  let commit = null;
  try {
    const dirs = resolveGitDirs(found);
    commit = dirs ? readHeadCommit(dirs) : null;
  } catch {
    commit = null;
  }
  const status = git(["status", "--porcelain", "--untracked-files=no"], dir, found.root);
  const dirty = status === null ? null : status.trim().length > 0;
  if (!commit) return { version, commit: null, dirty, source: "package", unresolved: true };
  return { version, commit, dirty, source: "git", unresolved: false };
}

// The short human form used on the bus: `<commit>[-dirty]` for a resolved checkout, `<version>`
// for a packaged install, and `<version>-UNRESOLVED[-dirty]` for a checkout whose HEAD could
// not be read — explicit, so an unresolved identity can never be mistaken for a resolved one.
export function formatWorkerBuild(build) {
  const base = build.commit ?? (build.unresolved ? `${build.version}-UNRESOLVED` : build.version);
  return build.dirty ? `${base}-dirty` : base;
}

// The server's commit as reported by `GET /v1/version` (vinci-gpu-control publishes `git_sha`;
// `commit` is accepted for fixtures/other servers). Returns `unknown: <error>` when the fetch
// failed, or `unknown` when the payload carried no sha.
export function formatServerBuild(serverBuild) {
  if (!serverBuild || typeof serverBuild !== "object") return "unknown";
  if (serverBuild.error) return `unknown: ${serverBuild.error}`;
  const sha = serverBuild.git_sha ?? serverBuild.commit ?? null;
  if (!sha) return "unknown";
  return serverBuild.dirty ? `${sha}-dirty` : sha;
}

// GET <server>/v1/version. Unauthenticated by contract (the server exposes it so that a drifted
// client can learn it is drifted before auth fails). Never throws: any failure (unreachable,
// timeout, non-2xx, non-JSON) returns `{ error, attempts }` and the daemon still starts — build
// identity is a record, not a gate.
//
// ONLY a fetch failure (timeout or network error) is retried, ONCE after `retryDelayMs` (#17:
// the first request after a cold start timed out and the very next one answered in 43 ms —
// cold TLS/DNS). Anything the server actually answered — non-2xx, a body that is not JSON or
// not an object — is recorded on the first attempt and not retried. Worst case is
// `attempts * timeoutMs + retryDelayMs` = 2 * 2000 + 1000 = 5 s, under the 6 s bound that keeps
// a hung server from delaying the first poll.
export const SERVER_BUILD_TIMEOUT_MS = 2000;
export const SERVER_BUILD_RETRY_DELAY_MS = 1000;
export const SERVER_BUILD_ATTEMPTS = 2;

export async function fetchServerBuild(
  serverUrl,
  { timeoutMs = SERVER_BUILD_TIMEOUT_MS, retryDelayMs = SERVER_BUILD_RETRY_DELAY_MS, attempts = SERVER_BUILD_ATTEMPTS } = {},
) {
  const url = `${String(serverUrl).replace(/\/$/, "")}/v1/version`;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const detail = error?.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : error?.cause?.code ?? error?.message ?? String(error);
      if (attempt >= attempts) return { error: `GET ${url} failed: ${detail}`, attempts: attempt };
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      continue;
    }
    if (!response.ok) return { error: `GET ${url} failed: ${response.status}`, attempts: attempt };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { error: `GET ${url} returned a non-JSON body`, attempts: attempt };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { error: `GET ${url} returned a non-object body`, attempts: attempt };
    }
    return payload;
  }
}

// #18: the version of the `vinci` BINARY the daemon will spawn, which is NOT the same thing as
// buildIdentity(): the daemon runs from a checkout (identity.json + git), while `vinci` on PATH
// is the installed launcher, whose payload self-updates independently. The 0.0.51 incident was
// exactly this: task records said `vinci_version: 0.0.51` (the checkout) while the launcher that
// actually ran was 0.0.52. So ask the binary itself, resolved the same way runVinci resolves it.
// Never throws; never mutates the install: `VINCI_UPDATE_DISABLED=1` stops the launcher from
// self-updating while it answers, so a version probe can never be the thing that changes the
// version. Returns `{ version, path }` or `{ error }`.
//
// The probe runs under a MINIMAL env (probeEnv), never the daemon's: the daemon's environment
// carries the bus token, the Governor token, provider keys, GitHub and AWS credentials, and a
// `--version` answer needs none of them. Only PATH (so the launcher finds node/bash), HOME
// (its install root), TMPDIR and LANG cross over, plus VINCI_UPDATE_DISABLED=1.
const PROBE_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG"];
export function probeEnv(base = process.env) {
  const env = {};
  for (const key of PROBE_ENV_ALLOWLIST) if (base[key] !== undefined) env[key] = base[key];
  env.VINCI_UPDATE_DISABLED = "1";
  return env;
}

// A version is one token: `<major>.<minor>.<patch>[-<prerelease>]`. Anything else (a banner, a
// help text, a shell error printed to stdout) is not a version and is recorded as an error, so
// a task record can never carry prose where a comparable version belongs.
const VERSION_TOKEN = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;

export function vinciBinaryVersion({ timeoutMs = 10_000, name = "vinci" } = {}) {
  let path;
  try {
    path = resolveBin(name);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: probeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      const detail = result.error.code === "ETIMEDOUT" ? `timeout after ${timeoutMs}ms` : result.error.message;
      return { error: `${path} --version failed: ${detail}` };
    }
    if (result.status !== 0) {
      const tail = (result.stderr || result.stdout || "").trim().split("\n").pop() ?? "";
      return { error: `${path} --version exited ${result.status ?? `signal ${result.signal}`}${tail ? `: ${tail}` : ""}` };
    }
    const version = (result.stdout ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    if (!version) return { error: `${path} --version printed nothing` };
    if (!VERSION_TOKEN.test(version)) return { error: `unparseable version: ${version.slice(0, 40)}` };
    return { version, path };
  } catch (error) {
    return { error: `${path} --version failed: ${error?.message ?? String(error)}` };
  }
}

// The bus form of vinciBinaryVersion(): `<version>` or `unknown: <error>`.
export function formatVinciBinary(binary) {
  if (!binary || typeof binary !== "object") return "unknown";
  if (binary.error) return `unknown: ${binary.error}`;
  return binary.version ?? "unknown";
}
