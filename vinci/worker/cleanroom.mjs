// Clean room per attempt (W1, `--clean-room`; default OFF this wave).
//
// Shared-checkout mode (prepareRepository in run.mjs) keeps ONE working tree per repo NAME under
// <state-dir>/repos/<name>, reused across attempts, tasks and orgs, and spawns `vinci -p` with the
// daemon's whole environment. Soak cohort 2 measured what that costs: stale local branches from an
// earlier attempt blocked a real continuation (rows 11/11b), the quarantine (PR #10) copies residue
// aside but the tree is still shared, and the child inherited the bus token, the Governor token,
// GH_TOKEN, provider keys and AWS credentials — enough to push from inside the sandbox.
//
// Clean-room mode replaces the three shared things with per-attempt ones and keeps everything else:
//
//   <state-dir>/cache/<org>/<repo>.git                       one bare cache per ORG/REPO (fetched
//                                                            before every attempt; never a tree)
//   <state-dir>/attempts/<org>/<repo>/<task>/<attempt>/      a fresh `git worktree add --detach`
//                                                            from that cache for EVERY attempt
//   <state-dir>/attempts/<org>/<repo>/<task>/<attempt>.home  the child's HOME  (beside the tree,
//   <state-dir>/attempts/<org>/<repo>/<task>/<attempt>.tmp   the child's TMPDIR  never inside it)
//   <state-dir>/attempts/<org>/<repo>/<task>/<attempt>.hooks the refusing pre-push hook
//
// An attempt dir is never reused: a crashed attempt's dir is sealed read-only for evidence when the
// next attempt starts, and the resume of a RUNNING task is attempt N+1 in a new dir. The task
// branch is created in the attempt worktree; the cache is where the daemon PUBLISHES from.
//
// Publish design (C3). The attempt worktree cannot push: its worktree-scoped config sets
// `remote.origin.pushurl=/dev/null` (so `git push`/`git push origin` fail before any transport) and
// `core.hooksPath` to a pre-push hook that exits 1 (so `git push <literal url>` fails too). Both are
// worktree-scoped (`git config --worktree`), so the bare cache — which shares the branch refs with
// its worktrees — is untouched, and the daemon pushes `refs/heads/<branch>` FROM THE CACHE under
// its own env after the run. The child never holds a working push at any point; nothing is
// unset or re-set in the attempt dir to publish. This is a guardrail, not a security boundary:
// a child with `git config` and the daemon's uid can undo both settings. The credentials it
// would need to push with are what the env allowlist (C2) keeps out of its reach.
//
// What is still NOT isolated (say it plainly): no container or VM, no user separation (child and
// daemon share a uid and can read each other's files), no network allowlist (the child can reach
// anything the box can), no CPU/memory limits. See README "Clean room".
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { command, readHeadBlocker, renameBranchAside } from "./run.mjs";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{40}$/;

export const DEFAULT_KEEP_ATTEMPTS = 3;
export const DEFAULT_DISK_FLOOR_MB = 2048;

// ---------------------------------------------------------------------------------------------
// C2: the child's environment. An ALLOWLIST — every variable not named here is dropped, which is
// what keeps VINCI_BUS_TOKEN, VINCI_GOVERNOR_TOKEN, GH_TOKEN, AWS_* and every provider key the
// envelope did not ask for out of the sandbox. Values are copied from the daemon's env verbatim.
//
//   PATH                       so the launcher finds node/bash/git (and the tests' fake tools)
//   LANG                       locale
//   VINCI_ENV                  prod/dev backend switch (vinci/bin/vinci); the dev URLs derive from it
//   VINCI_BASE_URL             explicit gateway override (dev boxes)
//   VINCI_PLATFORM_URL         explicit platform override (dev boxes)
//   VINCI_CODING_AGENT_DIR     the launcher's auth/settings slot; with a fresh HOME the default
//   PI_CODING_AGENT_DIR        slot is empty, so an explicit one is the only way to reach a login
//   VINCI_NO_BOOTSTRAP_HEAL    launcher: skip the bootstrap self-heal (tests set it)
//   VINCI_TOOL_BOOTSTRAP       launcher: fd/ripgrep first-run fetch on/off
//   VINCI_SHOW_OTHER_PROVIDERS launcher: BYOK boundary
//   VINCI_SOURCE_CLI           launcher: run from source (dev)
//
// Set by the daemon, never copied: HOME (per attempt), TMPDIR (per attempt), VINCI_HOME (the
// launcher's install root — the shim derives it from HOME, which is now the empty per-attempt one,
// so it is passed explicitly from the daemon's VINCI_HOME or <daemon HOME>/.vinci-code),
// VINCI_UPDATE_DISABLED=1 (#18: a task never runs under a self-updating launcher).
export const CLEAN_ROOM_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "VINCI_ENV",
  "VINCI_BASE_URL",
  "VINCI_PLATFORM_URL",
  "VINCI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "VINCI_NO_BOOTSTRAP_HEAL",
  "VINCI_TOOL_BOOTSTRAP",
  "VINCI_SHOW_OTHER_PROVIDERS",
  "VINCI_SOURCE_CLI",
]);

// ONLY the key the envelope's provider authenticates with (vinci/bin/vinci reads exactly these).
// An unknown provider gets no key at all and the launcher refuses it, as it does today.
export const PROVIDER_KEY_ENV = Object.freeze({
  openrouter: ["OPENROUTER_API_KEY"],
  vinci: ["VINCI_API_KEY"],
  deepinfra: ["VINCI_INTERNAL_DEEPINFRA_API_KEY"],
});

export function cleanRoomEnv({ base = process.env, provider, homeDir, tmpDir }) {
  if (!homeDir || !tmpDir) throw new Error("cleanRoomEnv needs a per-attempt homeDir and tmpDir");
  const env = {};
  for (const key of CLEAN_ROOM_ENV_ALLOWLIST) if (base[key] !== undefined) env[key] = base[key];
  for (const key of PROVIDER_KEY_ENV[provider] ?? []) if (base[key] !== undefined) env[key] = base[key];
  const vinciHome = base.VINCI_HOME ?? (base.HOME ? join(base.HOME, ".vinci-code") : undefined);
  if (vinciHome !== undefined) env.VINCI_HOME = vinciHome;
  env.HOME = homeDir;
  env.TMPDIR = tmpDir;
  env.VINCI_UPDATE_DISABLED = "1";
  return env;
}

// ---------------------------------------------------------------------------------------------
// Paths. Every segment is validated before it becomes a path component.
export function cleanRoomPaths(stateDir, repo, taskId) {
  if (!REPO.test(repo)) throw new Error("repo must be in org/name form");
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  const [org, name] = repo.split("/");
  if (org === "." || org === ".." || name === "." || name === "..") throw new Error(`unsafe repo path: ${repo}`);
  return {
    cacheDir: join(stateDir, "cache", org, `${name}.git`),
    attemptsRoot: join(stateDir, "attempts", org, name, taskId),
  };
}

function attemptPaths(attemptsRoot, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be a positive integer, got ${attempt}`);
  return {
    attemptDir: join(attemptsRoot, String(attempt)),
    homeDir: join(attemptsRoot, `${attempt}.home`),
    tmpDir: join(attemptsRoot, `${attempt}.tmp`),
    hooksDir: join(attemptsRoot, `${attempt}.hooks`),
  };
}

// ---------------------------------------------------------------------------------------------
// C4: disk floor. Refuse to START an attempt when <state-dir> has less free space than the floor;
// an attempt that begins on a full disk fails late and confusingly (mid-clone, mid-commit).
export function freeBytes(dir) {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function ensureFreeSpace(stateDir, floorBytes) {
  if (!Number.isFinite(floorBytes) || floorBytes <= 0) return;
  const free = freeBytes(stateDir);
  if (free < floorBytes) {
    throw new Error(`clean room: ${stateDir} has ${Math.floor(free / 1048576)} MiB free, below the ${Math.floor(floorBytes / 1048576)} MiB floor; refusing to start the attempt`);
  }
}

// ---------------------------------------------------------------------------------------------
// Sealing: a finished or crashed attempt's tree is evidence. Read-only for every principal; git
// still reads it (its index and HEAD live under <cache>/worktrees/<id>, outside the sealed tree).
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, visit);
    visit(path, entry.isDirectory());
  }
}

export function sealAttemptDir(attemptDir) {
  if (!existsSync(attemptDir)) return false;
  walk(attemptDir, (path, isDir) => chmodSync(path, isDir ? 0o555 : 0o444));
  chmodSync(attemptDir, 0o555);
  return true;
}

function unseal(dir) {
  if (!existsSync(dir)) return;
  try { chmodSync(dir, 0o755); } catch {}
  walk(dir, (path, isDir) => { try { chmodSync(path, isDir ? 0o755 : 0o644); } catch {} });
}

function listAttempts(attemptsRoot) {
  if (!existsSync(attemptsRoot)) return [];
  return readdirSync(attemptsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
}

// C4: retention. Keep the newest `keep` attempt dirs per task; prune older ones — never the newest,
// never `protect` (the RUNNING attempt). Sealed dirs are unsealed first (rm needs write on the
// parent). The cache's worktree registration is pruned afterwards so the next `worktree add`
// does not trip over a registered-but-missing tree.
export async function pruneAttempts({ stateDir, repo, taskId, keep = DEFAULT_KEEP_ATTEMPTS, protect = null }) {
  const { cacheDir, attemptsRoot } = cleanRoomPaths(stateDir, repo, taskId);
  const attempts = listAttempts(attemptsRoot);
  if (attempts.length === 0) return [];
  const newest = attempts[attempts.length - 1];
  const keepCount = Math.max(1, Number.isInteger(keep) ? keep : DEFAULT_KEEP_ATTEMPTS);
  const victims = attempts.slice(0, Math.max(0, attempts.length - keepCount)).filter((n) => n !== newest && n !== protect);
  for (const n of victims) {
    const paths = attemptPaths(attemptsRoot, n);
    for (const dir of [paths.attemptDir, paths.homeDir, paths.tmpDir, paths.hooksDir]) {
      unseal(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (victims.length > 0 && existsSync(cacheDir)) await command("git", ["-C", cacheDir, "worktree", "prune"], { allowFailure: true });
  return victims;
}

// ---------------------------------------------------------------------------------------------
// The cache: one bare repository per org/repo. `git init --bare` + an origin remote with the full
// heads refspec (NOT `clone --mirror`: a mirror's push refspec is `+refs/*:refs/*`, which would
// push every attempt's branch on the first publish). Its origin URL is checked on every reuse so
// `a/repo` and `b/repo` can never share a cache by accident.
async function ensureCache(cacheDir, cloneUrl) {
  if (existsSync(cacheDir)) {
    const url = await command("git", ["-C", cacheDir, "config", "--get", "remote.origin.url"], { allowFailure: true });
    if (url.status !== 0 || url.stdout !== cloneUrl) {
      throw new Error(`clean room: cache ${cacheDir} has origin ${url.stdout || "(none)"}, expected ${cloneUrl}; refusing to reuse it`);
    }
    return;
  }
  mkdirSync(dirname(cacheDir), { recursive: true });
  await command("git", ["init", "--bare", "--quiet", cacheDir]);
  await command("git", ["-C", cacheDir, "remote", "add", "origin", cloneUrl]);
  await command("git", ["-C", cacheDir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  // Per-worktree config (C3 lives there): extensions.worktreeConfig, with core.bare MOVED from the
  // shared config into the cache's own config.worktree (git help worktree, CONFIGURATION FILE).
  // Left in the shared config, core.bare=true would make every linked worktree "bare" (no
  // commits possible); moved, the cache stays bare and each worktree carries its own
  // pushurl/hooks/identity without touching the shared config. Verified against git 2.50.
  await command("git", ["-C", cacheDir, "config", "extensions.worktreeConfig", "true"]);
  await command("git", ["-C", cacheDir, "config", "--unset", "core.bare"]);
  await command("git", ["config", "--file", join(cacheDir, "config.worktree"), "core.bare", "true"]);
}

const PRE_PUSH_HOOK = `#!/bin/sh
echo "vinci worker clean room: git push from inside an attempt worktree is refused." >&2
echo "The daemon publishes the task branch from its bare cache after the run; commit and stop." >&2
exit 1
`;

function writePrePushHook(hooksDir) {
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, "pre-push");
  writeFileSync(hook, PRE_PUSH_HOOK, { mode: 0o755 });
  chmodSync(hook, 0o755);
  return hook;
}

// The commit identity the child commits under. The child's HOME is empty (no ~/.gitconfig), so
// without this every `git commit` in the attempt fails with "Please tell me who you are". Taken
// from the daemon's effective config when present, else a fixed worker identity.
async function commitIdentity() {
  const name = await command("git", ["config", "--get", "user.name"], { allowFailure: true });
  const email = await command("git", ["config", "--get", "user.email"], { allowFailure: true });
  return {
    name: name.status === 0 && name.stdout ? name.stdout : "vinci-worker",
    email: email.status === 0 && email.stdout ? email.stdout : "worker@vinci.invalid",
  };
}

// C1: a fresh attempt worktree. Returns the same `{ branch, repoDir }` shape prepareRepository
// does (repoDir IS the attempt dir) plus the clean-room facts the task record carries.
export async function prepareCleanRoom({ stateDir, repo, taskId, attempt, branchOverride, diskFloorBytes = DEFAULT_DISK_FLOOR_MB * 1048576 }) {
  const { cacheDir, attemptsRoot } = cleanRoomPaths(stateDir, repo, taskId);
  const paths = attemptPaths(attemptsRoot, attempt);
  const branch = branchOverride ?? `worker/${taskId}`;
  const base = (process.env.VINCI_WORKER_GIT_BASE ?? "https://github.com/").replace(/\/+$/, "");
  const cloneUrl = `${base}/${repo}.git`;

  if (existsSync(paths.attemptDir)) {
    throw new Error(`clean room: attempt dir ${paths.attemptDir} already exists; an attempt dir is never reused`);
  }
  mkdirSync(stateDir, { recursive: true });
  ensureFreeSpace(stateDir, diskFloorBytes);

  if (branchOverride) {
    const legal = await command("git", ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (legal.status !== 0) throw new Error(`envelope branch ${branch} is not a valid git branch name`);
  }
  await ensureCache(cacheDir, cloneUrl);

  if (branchOverride) {
    // Same gate as shared mode (#19): existence is asked of origin LIVE, before any fetch, so a
    // branch absent on origin is "not found on origin" at cost 0 and never masked by a fetch error.
    const remote = await command("git", ["-C", cacheDir, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { allowFailure: true });
    if (remote.status !== 0) {
      if (remote.status !== 2) throw new Error(`git ls-remote origin failed for ${branch}: ${remote.stderr || remote.status}`);
      throw new Error(`envelope branch ${branch} not found on origin`);
    }
  }
  // Fetched per attempt, all heads, pruned: the cache is a mirror of origin's heads, nothing else.
  await command("git", ["-C", cacheDir, "fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  const cacheRef = `refs/remotes/origin/${branchOverride ?? "main"}`;
  const resolved = await command("git", ["-C", cacheDir, "rev-parse", "--verify", "--quiet", cacheRef], { allowFailure: true });
  if (resolved.status !== 0 || !SHA.test(resolved.stdout)) throw new Error(`clean room: ${cacheRef} did not materialize in ${cacheDir} after fetch`);
  const baseCommit = resolved.stdout;

  // Earlier attempts of this task: sealed (a crashed attempt never sealed itself), never entered.
  for (const previous of listAttempts(attemptsRoot)) sealAttemptDir(attemptPaths(attemptsRoot, previous).attemptDir);
  await command("git", ["-C", cacheDir, "worktree", "prune"], { allowFailure: true });

  // The branch lives in the cache's shared refs. A previous attempt's copy (its worktree still
  // holds it checked out, and it may carry never-pushed commits) is renamed aside under stale/…,
  // never deleted, so this attempt starts at the base commit with a fresh branch of the right name.
  let staleRef = null;
  const existing = await command("git", ["-C", cacheDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  if (existing.status === 0) staleRef = await renameBranchAside(cacheDir, branch);

  mkdirSync(attemptsRoot, { recursive: true });
  await command("git", ["-C", cacheDir, "worktree", "add", "--quiet", "--detach", paths.attemptDir, baseCommit]);
  await command("git", ["-C", paths.attemptDir, "checkout", "--quiet", "-b", branch]);

  // C3 (worktree-scoped: the cache keeps a working push; see ensureCache for the extension).
  const hook = writePrePushHook(paths.hooksDir);
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "remote.origin.pushurl", "/dev/null"]);
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "core.hooksPath", paths.hooksDir]);
  const identity = await commitIdentity();
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "user.name", identity.name]);
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "user.email", identity.email]);

  mkdirSync(paths.homeDir, { recursive: true });
  mkdirSync(paths.tmpDir, { recursive: true });

  return {
    branch,
    repoDir: paths.attemptDir,
    attemptDir: paths.attemptDir,
    homeDir: paths.homeDir,
    tmpDir: paths.tmpDir,
    hooksDir: paths.hooksDir,
    prePushHook: hook,
    cacheDir,
    cacheRef,
    baseCommit,
    staleRef,
  };
}

// C3: the daemon's publisher. Pushes refs/heads/<branch> FROM THE BARE CACHE (the ref is shared
// with the attempt worktree, so nothing is fetched or copied) under the daemon's own env. The
// attempt dir is only READ (HEAD:BLOCKER.md). `gh` is pointed at the repo with -R, so it never
// needs a working tree either.
export async function publishFromCache({ envelope, cacheDir, attemptDir, branch, taskId, limitTripped }) {
  const blockerReason = await readHeadBlocker(attemptDir);
  const push = await command("git", ["-C", cacheDir, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { allowFailure: true });
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (blockerReason) return { ...result, publish: push.status === 0 ? "blocked" : "push_failed", blocker_reason: blockerReason };
  if (limitTripped) return result;
  if (push.status !== 0 || envelope.evidence !== "pr") return result;

  const created = await command(
    "gh",
    ["pr", "create", "-R", envelope.repo, "--base", "main", "--head", branch, "--title", `Worker task ${taskId}`, "--body", `Unattended Vinci worker result for task ${taskId}.`],
    { cwd: cacheDir, allowFailure: true },
  );
  if (created.status === 0) result.pr = created.stdout.split("\n").find((line) => PR_URL.test(line)) ?? null;
  const createErr = `${created.stderr ?? ""}${created.stdout ?? ""}`;
  if (result.pr === null && (created.status === 0 || /already exists|already has|pull request for/i.test(createErr))) {
    const listed = await command("gh", ["pr", "list", "-R", envelope.repo, "--head", branch, "--state", "open", "--json", "url"], { cwd: cacheDir, allowFailure: true });
    try {
      const parsed = JSON.parse(listed.stdout ?? "[]");
      if (Array.isArray(parsed) && parsed[0]?.url) result.pr = parsed[0].url;
    } catch { /* no JSON, no PR */ }
  }
  return result;
}
