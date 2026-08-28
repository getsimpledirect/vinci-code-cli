// W0.5 exact build identity: which build of the worker produced a record, and which build of
// the server it talked to. Both are computed ONCE at daemon start and stamped on every task
// record, on the `online` bus post and on the final bus post, so a soak cohort can be proven to
// have run on one exact build set (build skew between the two worker boxes, and between worker
// and server, has already caused live failures).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;

function git(args, cwd) {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
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

// `{ version, commit, dirty, source }` for the checkout THIS file runs from. Never throws.
//   version: identity.json version (the existing `vinci_version`)
//   commit:  full 40-hex `git rev-parse HEAD`, or null when this is not a git checkout or git
//            is unavailable (a packaged install)
//   dirty:   true when `git status --porcelain --untracked-files=no` is non-empty, false when
//            clean, null when unknown (no git). Untracked files are ignored on purpose: the
//            default state dir (`.vinci-worker-state`) may sit inside the checkout and must not
//            make every build read as dirty.
//   source:  "git" when the commit came from git, otherwise "package"
export function buildIdentity(dir = dirname(fileURLToPath(import.meta.url))) {
  const version = readVersion(dir);
  const head = git(["rev-parse", "HEAD"], dir)?.trim() ?? null;
  if (!head || !FULL_SHA.test(head)) return { version, commit: null, dirty: null, source: "package" };
  const status = git(["status", "--porcelain", "--untracked-files=no"], dir);
  const dirty = status === null ? null : status.trim().length > 0;
  return { version, commit: head, dirty, source: "git" };
}

// The short human form used on the bus: `<commit or version>[-dirty]`.
export function formatWorkerBuild(build) {
  const base = build.commit ?? build.version;
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
// timeout, non-2xx, non-JSON) returns `{ error }` and the daemon still starts — build identity
// is a record, not a gate.
export async function fetchServerBuild(serverUrl, { timeoutMs = 3000 } = {}) {
  const url = `${String(serverUrl).replace(/\/$/, "")}/v1/version`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { error: `GET ${url} failed: ${response.status}` };
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { error: `GET ${url} returned a non-object body` };
    }
    return payload;
  } catch (error) {
    const detail = error?.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : error?.cause?.code ?? error?.message ?? String(error);
    return { error: `GET ${url} failed: ${detail}` };
  }
}
