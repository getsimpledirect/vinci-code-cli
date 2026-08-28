// W0.5 exact build identity: which build of the worker produced a record, and which build of
// the server it talked to. Both are computed ONCE at daemon start and stamped on every task
// record, on the `online` bus post and on the final bus post, so a soak cohort can be proven to
// have run on one exact build set (build skew between the two worker boxes, and between worker
// and server, has already caused live failures).
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;

// `git` is used ONLY for `dirty` (best-effort). `commit` never depends on it: the daemon runs
// as an unprivileged user on a root-owned checkout, where git refuses with "dubious ownership"
// (#17), so the commit is read from the checkout's own files instead. `safe.directory=*` is
// passed as command-line config (which git treats as protected, like the system config) so
// that `dirty` still answers on such a checkout; when git is missing or still refuses, the
// caller records `null` (unknown), never `false`.
function git(args, cwd) {
  try {
    const result = spawnSync("git", ["-c", "safe.directory=*", "-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
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

// Walk up from `start` to the nearest `.git`. A directory is the repository itself; a FILE is a
// `gitdir: <path>` pointer (a linked worktree or a submodule), in which case `gitDir` is the
// per-worktree dir (HEAD lives there) and `commonDir` the main repository (`refs/heads/*` and
// `packed-refs` live there; git records it in `<gitDir>/commondir`). Returns null when `start`
// is not inside any checkout.
export function findGitDir(start) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".git");
    let stat = null;
    try {
      stat = statSync(candidate);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return { gitDir: candidate, commonDir: candidate };
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(candidate) ?? "");
      if (!pointer) return null;
      const gitDir = resolve(dir, pointer[1]);
      const common = readText(join(gitDir, "commondir"))?.trim();
      return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

// HEAD of the checkout at `gitDir` as a 40-hex sha, reading the checkout's files directly (no
// git exec, so no ownership check): `HEAD` is either a detached sha or `ref: <ref>`; a ref is
// looked up as a loose file (per-worktree dir first, then the common dir) and then in
// `packed-refs`. Returns null when HEAD cannot be resolved to a full sha — an unborn branch,
// a truncated file, or a shape this reader does not understand.
export function readHeadCommit({ gitDir, commonDir }) {
  const head = readText(join(gitDir, "HEAD"))?.trim();
  if (!head) return null;
  let value = head;
  const symbolic = /^ref:\s*(\S+)/.exec(head);
  if (symbolic) {
    const ref = symbolic[1];
    value = readText(join(gitDir, ref))?.trim() ?? readText(join(commonDir, ref))?.trim() ?? readPackedRef(commonDir, ref) ?? "";
  }
  return FULL_SHA.test(value) ? value : null;
}

// `{ version, commit, dirty, source, unresolved }` for the checkout THIS file runs from. Never
// throws.
//   version:    identity.json version (the existing `vinci_version`)
//   commit:     full 40-hex HEAD sha read from the checkout's `.git` files (never via git exec),
//               or null when this is not a git checkout or HEAD could not be resolved
//   dirty:      true when `git status --porcelain --untracked-files=no` is non-empty, false
//               when clean, null when unknown (git missing or refusing — best-effort only).
//               Untracked files are ignored on purpose: the default state dir
//               (`.vinci-worker-state`) may sit inside the checkout and must not make every
//               build read as dirty.
//   source:     "git" when the commit was resolved, otherwise "package"
//   unresolved: true when a `.git` exists but `commit` could not be resolved from it — a
//               checkout whose identity is unknown, which is NOT the same as a packaged
//               install and is announced as such (`<version>-UNRESOLVED`, see formatWorkerBuild)
export function buildIdentity(dir = dirname(fileURLToPath(import.meta.url))) {
  const version = readVersion(dir);
  let gitDirs = null;
  try {
    gitDirs = findGitDir(dir);
  } catch {
    gitDirs = null;
  }
  if (!gitDirs) return { version, commit: null, dirty: null, source: "package", unresolved: false };
  let commit = null;
  try {
    commit = readHeadCommit(gitDirs);
  } catch {
    commit = null;
  }
  const status = git(["status", "--porcelain", "--untracked-files=no"], dir);
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
// A timeout or network error is retried ONCE after `retryDelayMs` (#17: the first request
// after a cold start timed out and the very next one answered in 43 ms — cold TLS/DNS); a
// non-2xx or non-JSON answer is a server answer and is not retried. Worst case is
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
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { error: `GET ${url} failed: ${response.status}`, attempts: attempt };
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { error: `GET ${url} returned a non-object body`, attempts: attempt };
      }
      return payload;
    } catch (error) {
      const detail = error?.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : error?.cause?.code ?? error?.message ?? String(error);
      if (attempt >= attempts) return { error: `GET ${url} failed: ${detail}`, attempts: attempt };
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
    }
  }
}
