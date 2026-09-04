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
// Publish design (C3). The DEFAULT publish path is dead from inside the attempt: the cache's own
// config sets `remote.origin.pushurl=/dev/null` and `core.hooksPath` to a pre-push hook that exits
// 1, and every attempt worktree carries the same two settings in its worktree-scoped config. So
// `git push`, `git push origin`, `git push --no-verify origin` and `git -C <cache> push origin`
// (the cache is the git-common-dir every worktree can name) all fail before any transport, and
// `git push <literal url>` trips the hook. The daemon publishes `refs/heads/<branch>` FROM THE
// CACHE under its own env after the run, going around both settings on its own command line (a
// push to the LITERAL origin URL with `--no-verify`); nothing is unset or re-set anywhere to
// publish, and the child never holds a working push at any point.
//
// This is a guardrail, not a security boundary — say exactly what it stops. It removes the
// AMBIENT credentials (env allowlist, C2) and the default publish path. It does NOT stop a child
// that runs as the daemon's uid and supplies its own path: `git push --no-verify <literal url>`
// and `git remote add x <url> && git push --no-verify x` reach origin whenever the transport needs
// no credential the child lacks (a local/file origin, an SSH agent socket, an instance profile).
// The credential boundary is HOME-keyed, not uid-keyed: GH_CONFIG_DIR / GIT_CONFIG_GLOBAL pointed
// at the daemon's HOME reach the daemon's logins, and on macOS Apple git's SYSTEM gitconfig sets
// credential.helper=osxkeychain regardless of HOME, so the boundary is absent there.
// worker-clean-room.mjs asserts each bypass's status (refused/open) so a change flips a test
// deliberately.
//
// What is still NOT isolated (say it plainly): no container or VM, no user separation (child and
// daemon share a uid and can read each other's files), no network allowlist (the child can reach
// anything the box can), no CPU/memory limits; VINCI_HOME (the launcher's install root, versions/
// and updater/) is writable by the child. See README "Clean room".
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { classifyDivergedLocal, command, readHeadBlocker, renameBranchAside } from "./run.mjs";
import { prTitle } from "./publisher.mjs";
import { isPlainRefName } from "./task.mjs";

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
//   (NOT VINCI_CODING_AGENT_DIR / PI_CODING_AGENT_DIR: passing the daemon's slot through hands the
//   child auth.json for EVERY provider, every prior session and bin/. The child's slot is the
//   fresh HOME's <home>/agent, set below; a single credential file reaches it only through the
//   narrow opt-in VINCI_WORKER_AUTH_FILE, copied 0600 by prepareCleanRoom.)
//   VINCI_NO_BOOTSTRAP_HEAL    launcher: skip the bootstrap self-heal (tests set it)
//   VINCI_TOOL_BOOTSTRAP       launcher: fd/ripgrep first-run fetch on/off
//   VINCI_SHOW_OTHER_PROVIDERS launcher: BYOK boundary
//   VINCI_SOURCE_CLI           launcher: run from source (dev)
//
// Set by the daemon, never copied: HOME (per attempt), TMPDIR (per attempt), VINCI_HOME (the
// launcher's install root — the shim derives it from HOME, which is now the empty per-attempt one,
// so it is passed explicitly from the daemon's VINCI_HOME or <daemon HOME>/.vinci-code),
// VINCI_CODING_AGENT_DIR + PI_CODING_AGENT_DIR (= <attempt HOME>/agent, both spellings, so neither
// the branded build nor the global-pi fallback lane derives a slot from anywhere else),
// VINCI_UPDATE_DISABLED=1 (#18: a task never runs under a self-updating launcher).
export const CLEAN_ROOM_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "VINCI_ENV",
  "VINCI_BASE_URL",
  "VINCI_PLATFORM_URL",
  "VINCI_NO_BOOTSTRAP_HEAL",
  "VINCI_TOOL_BOOTSTRAP",
  "VINCI_SHOW_OTHER_PROVIDERS",
  "VINCI_SOURCE_CLI",
]);

// ONLY the authentication and provider-routing environment selected by the envelope. An unknown
// provider gets none and the launcher refuses it, as it does today. Qwen receives references and
// non-secret pins/settings here; the resolved bearer value is never a worker config value.
export const PROVIDER_KEY_ENV = Object.freeze({
  openrouter: ["OPENROUTER_API_KEY"],
  vinci: ["VINCI_API_KEY"],
  deepinfra: ["VINCI_INTERNAL_DEEPINFRA_API_KEY"],
  "qwen-h200": [
    "VINCI_QWEN_BASE_URL",
    "VINCI_QWEN_SECRET_REF",
    "VINCI_QWEN_QUALIFICATION_FILE",
    "VINCI_QWEN_QUALIFICATION_SHA256",
    "VINCI_QWEN_CIRCUIT_THRESHOLD",
    "VINCI_QWEN_CIRCUIT_OPEN_MS",
  ],
});

// Every provider credential and authentication-routing value the bundled coding agent knows how
// to resolve from the environment, plus Vinci's managed/internal keys. This inventory is
// intentionally broader than PROVIDER_KEY_ENV: the latter names what an envelope may KEEP, while
// this list names what must be REMOVED. Keeping only the three envelope keys in the removal
// inventory was fail-open — an OpenRouter child still received Anthropic, OpenAI and public
// DeepInfra credentials.
export const PROVIDER_CREDENTIAL_ENV = Object.freeze([
  "VINCI_QWEN_BASE_URL",
  "VINCI_QWEN_SECRET_REF",
  "VINCI_QWEN_QUALIFICATION_FILE",
  "VINCI_QWEN_QUALIFICATION_SHA256",
  "VINCI_QWEN_CIRCUIT_THRESHOLD",
  "VINCI_QWEN_CIRCUIT_OPEN_MS",
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPINFRA_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "VINCI_API_KEY",
  "VINCI_INTERNAL_DEEPINFRA_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]);

const QWEN_ENV_SECRET_REFERENCE = /^env:([A-Z][A-Z0-9_]{0,127})$/;

function qwenSecretEnvName(base) {
  const match = typeof base.VINCI_QWEN_SECRET_REF === "string"
    ? base.VINCI_QWEN_SECRET_REF.match(QWEN_ENV_SECRET_REFERENCE)
    : null;
  return match?.[1];
}

// The provider boundary for the NORMAL (non-clean-room) path.
//
// PROVIDER_KEY_ENV above promises a child gets ONLY the key its envelope's provider
// authenticates with. That promise was kept exclusively inside cleanRoomEnv, and the normal path
// passed `env: undefined` to the child -- meaning INHERIT EVERYTHING, every provider key the
// daemon holds. Clean-room mode is additionally refused under a Governor, so in the governed
// configuration the boundary never executed at all: it was a guard that existed, was correct,
// and sat on a path that does not run where it matters. What actually kept a child off another
// provider was which keys happened to be ABSENT from the box, which is an accident, not a
// boundary.
//
// This is deliberately SUBTRACTIVE rather than an allowlist rebuild. cleanRoomEnv also rewrites
// HOME, TMPDIR and the agent slot, which is right for a clean room and would be a far larger
// behaviour change than this defect warrants on the normal path. So: inherit as before, then
// remove every provider key that is not this envelope's.
//
// Fails closed on an unknown provider: `keep` is empty, so ALL provider keys are stripped and
// the launcher refuses for want of a credential, exactly as it does today for an unknown
// provider in a clean room.
export function providerScopedEnv({ base = process.env, provider, agentDir }) {
  if (!agentDir) throw new Error("providerScopedEnv needs an isolated agentDir");
  // Object.hasOwn, not a bare lookup: PROVIDER_KEY_ENV["__proto__"] resolves through the
  // prototype chain and returns Object.prototype, so `?? []` never fires and the Set
  // constructor throws on a non-iterable. Found by the unknown-provider test below.
  const keep = new Set(Object.hasOwn(PROVIDER_KEY_ENV, provider) ? PROVIDER_KEY_ENV[provider] : []);
  const env = { ...base };
  for (const key of PROVIDER_CREDENTIAL_ENV) if (!keep.has(key)) delete env[key];
  const referencedQwenSecret = qwenSecretEnvName(base);
  if (provider !== "qwen-h200" && referencedQwenSecret) delete env[referencedQwenSecret];
  // Do not let normal mode's provider selection be bypassed by the daemon's shared auth.json.
  // This is a resolution boundary, not uid isolation: a same-uid child can still deliberately
  // read the daemon's files. Both launchers resolve stored credentials from this isolated slot.
  env.VINCI_CODING_AGENT_DIR = agentDir;
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

// The single decision about what environment a child gets, on EITHER path.
//
// This exists as a named function rather than a ternary at the call site because the first
// version of this fix was tested past the seam: the unit tests covered providerScopedEnv and
// reverting the CALL SITE to `env: undefined` -- the exact original fail-open -- left every one
// of them green. Testing the helper while leaving the wiring untested means the wiring is the
// only part that can silently regress, and the wiring is what was broken in the first place.
export function childEnv({ base = process.env, cleanRoom, provider, homeDir, tmpDir, agentDir }) {
  return cleanRoom
    ? cleanRoomEnv({ base, provider, homeDir, tmpDir })
    : providerScopedEnv({ base, provider, agentDir });
}

// The child's agent slot (auth.json, sessions, settings): a dir inside the per-attempt HOME.
export function attemptAgentDir(homeDir) {
  return join(homeDir, "agent");
}

export function cleanRoomEnv({ base = process.env, provider, homeDir, tmpDir }) {
  if (!homeDir || !tmpDir) throw new Error("cleanRoomEnv needs a per-attempt homeDir and tmpDir");
  const env = {};
  for (const key of CLEAN_ROOM_ENV_ALLOWLIST) if (base[key] !== undefined) env[key] = base[key];
  // Same prototype-chain hazard as providerScopedEnv below.
  const providerKeys = Object.hasOwn(PROVIDER_KEY_ENV, provider) ? PROVIDER_KEY_ENV[provider] : [];
  for (const key of providerKeys) if (base[key] !== undefined) env[key] = base[key];
  const referencedQwenSecret = qwenSecretEnvName(base);
  if (provider === "qwen-h200" && referencedQwenSecret && base[referencedQwenSecret] !== undefined) {
    env[referencedQwenSecret] = base[referencedQwenSecret];
  }
  const vinciHome = base.VINCI_HOME ?? (base.HOME ? join(base.HOME, ".vinci-code") : undefined);
  if (vinciHome !== undefined) env.VINCI_HOME = vinciHome;
  env.HOME = homeDir;
  env.TMPDIR = tmpDir;
  env.VINCI_CODING_AGENT_DIR = attemptAgentDir(homeDir);
  env.PI_CODING_AGENT_DIR = attemptAgentDir(homeDir);
  env.VINCI_UPDATE_DISABLED = "1";
  return env;
}

// F4 narrow opt-in: VINCI_WORKER_AUTH_FILE=<path> names ONE credential file the daemon wants the
// child to have. It is copied (0600) to <attempt HOME>/agent/auth.json — one file, no sessions,
// no bin/, nothing else from the daemon's slot. A set-but-missing path is a misconfiguration and
// fails the attempt loudly rather than running it logged out.
export function installAuthFile(homeDir, authFile) {
  if (!authFile) return null;
  if (!existsSync(authFile)) throw new Error(`clean room: VINCI_WORKER_AUTH_FILE ${authFile} does not exist`);
  const agentDir = attemptAgentDir(homeDir);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const target = join(agentDir, "auth.json");
  copyFileSync(authFile, target);
  chmodSync(target, 0o600);
  return target;
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
    evidenceMarker: join(attemptsRoot, `${attempt}.evidence_uploaded`),
  };
}

// F6: the evidence marker. Written by the daemon ONLY after the attempt's evidence bundle landed
// (uploadEvidence success). It lives beside the sealed tree (the tree is read-only by then), and
// it is what makes an attempt dir prunable: a sealed dir without it is the only copy of that
// attempt's evidence and is never pruned by count.
export function evidenceMarkerPath({ stateDir, repo, taskId, attempt }) {
  const { attemptsRoot } = cleanRoomPaths(stateDir, repo, taskId);
  return attemptPaths(attemptsRoot, attempt).evidenceMarker;
}

export function markEvidenceUploaded({ stateDir, repo, taskId, attempt, uri = null, sha256 = null }) {
  const marker = evidenceMarkerPath({ stateDir, repo, taskId, attempt });
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ attempt, uri, sha256, uploaded_at: new Date().toISOString() })}\n`);
  return marker;
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
// never `protect` (the RUNNING attempt), and NEVER a dir without its evidence marker (F6: a
// crashed attempt's sealed dir was never uploaded, so it is the only evidence there is; a
// count-based rule would have dropped it at N+keep). The count applies to MARKED dirs only.
// Sealed dirs are unsealed first (rm needs write on the parent). The cache's worktree
// registration is pruned afterwards so the next `worktree add` does not trip over a
// registered-but-missing tree.
export async function pruneAttempts({ stateDir, repo, taskId, keep = DEFAULT_KEEP_ATTEMPTS, protect = null }) {
  const { cacheDir, attemptsRoot } = cleanRoomPaths(stateDir, repo, taskId);
  const attempts = listAttempts(attemptsRoot);
  if (attempts.length === 0) return [];
  const newest = attempts[attempts.length - 1];
  const keepCount = Math.max(1, Number.isInteger(keep) ? keep : DEFAULT_KEEP_ATTEMPTS);
  const marked = attempts.filter((n) => existsSync(attemptPaths(attemptsRoot, n).evidenceMarker));
  const victims = marked.slice(0, Math.max(0, marked.length - keepCount)).filter((n) => n !== newest && n !== protect);
  for (const n of victims) {
    const paths = attemptPaths(attemptsRoot, n);
    for (const dir of [paths.attemptDir, paths.homeDir, paths.tmpDir, paths.hooksDir]) {
      unseal(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(paths.evidenceMarker, { force: true });
  }
  if (victims.length > 0 && existsSync(cacheDir)) await command("git", ["-C", cacheDir, "worktree", "prune"], { allowFailure: true });
  return victims;
}

// ---------------------------------------------------------------------------------------------
// The cache: one bare repository per org/repo. `git init --bare` + an origin remote with the full
// heads refspec (NOT `clone --mirror`: a mirror's push refspec is `+refs/*:refs/*`, which would
// push every attempt's branch on the first publish). Its origin URL is checked on every reuse so
// `a/repo` and `b/repo` can never share a cache by accident.
//
// The cache is also the git-common-dir every attempt worktree can name (`git rev-parse
// --git-common-dir`), i.e. the daemon's own publish path. So the same two refusals the worktrees
// carry are set at CACHE level too, on every reuse (a cache created before this rule gets them):
// `remote.origin.pushurl=/dev/null` and `core.hooksPath=<cache>/hooks` (the refusing pre-push
// hook). The daemon's publishFromCache goes around both on its command line (literal URL, --no-verify).
export function cacheHooksDir(cacheDir) {
  return join(cacheDir, "hooks");
}

async function refuseCachePush(cacheDir) {
  const hooksDir = writePrePushHook(cacheHooksDir(cacheDir));
  await command("git", ["-C", cacheDir, "config", "remote.origin.pushurl", "/dev/null"]);
  await command("git", ["-C", cacheDir, "config", "core.hooksPath", hooksDir]);
}

async function ensureCache(cacheDir, cloneUrl) {
  if (existsSync(cacheDir)) {
    const url = await command("git", ["-C", cacheDir, "config", "--get", "remote.origin.url"], { allowFailure: true });
    if (url.status !== 0 || url.stdout !== cloneUrl) {
      throw new Error(`clean room: cache ${cacheDir} has origin ${url.stdout || "(none)"}, expected ${cloneUrl}; refusing to reuse it`);
    }
    await refuseCachePush(cacheDir);
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
  await refuseCachePush(cacheDir);
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
  return hooksDir;
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
export async function prepareCleanRoom({ stateDir, repo, taskId, attempt, branchOverride, baseRef, pinnedBaseCommit, diskFloorBytes = DEFAULT_DISK_FLOOR_MB * 1048576, authFile = process.env.VINCI_WORKER_AUTH_FILE }) {
  if (baseRef !== undefined && !isPlainRefName(baseRef)) {
    throw new Error(`base_ref ${baseRef} must be a plain git branch name`);
  }
  // A digest handoff signs BOTH halves of the pin: base_ref AND base_commit. Shared mode
  // (prepareRepository, run.mjs) validates both. This path took only the ref and resolved
  // origin/<base_ref> to its CURRENT TIP, so if the branch advanced after the contract was
  // issued the attempt silently forked from the new tip and the signed commit was never
  // checked. The composed guard in worker.mjs permits a non-main base when EITHER mechanism
  // can honour it; that is only true if this one honours the commit half too.
  //
  // Same validation and the same BLOCKED reasons as shared mode, deliberately: two paths
  // enforcing one contract must not disagree about what the contract means.
  if (pinnedBaseCommit !== undefined && pinnedBaseCommit !== null) {
    if (typeof pinnedBaseCommit !== "string" || !/^[0-9a-f]{40}$/.test(pinnedBaseCommit)) {
      throw new Error("base_commit must be a full 40-character lowercase hex SHA-1");
    }
    if (typeof baseRef !== "string" || baseRef === "") {
      throw new Error("base_ref_unavailable: a pinned base_commit requires a base_ref to be fetched from origin");
    }
  }
  const { cacheDir, attemptsRoot } = cleanRoomPaths(stateDir, repo, taskId);
  const paths = attemptPaths(attemptsRoot, attempt);
  const branch = branchOverride ?? `worker/${taskId}`;
  const checkoutBase = baseRef ?? "main";
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

  if (baseRef !== undefined) {
    // A pinned base is an authority boundary: ask origin live before fetching, so a stale cache
    // cannot make a deleted or misspelled base look valid and no attempt worktree is created from
    // an unintended fallback.
    const remoteBase = await command("git", ["-C", cacheDir, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${baseRef}`], { allowFailure: true });
    if (remoteBase.status !== 0) {
      if (remoteBase.status !== 2) throw new Error(`git ls-remote origin failed for base_ref ${baseRef}: ${remoteBase.stderr || remoteBase.status}`);
      throw new Error(`base_ref ${baseRef} not found on origin`);
    }
  }
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
  // F3: the base. A `branch:` envelope bases at origin/<branch> (its existence was asked of origin
  // above). Otherwise, when origin ALREADY HAS the task branch — attempt N published and then
  // crashed, or a resume on a new box — attempt N+1 continues at origin/worker/<task> with
  // fast-forward semantics (the same rule as shared mode, prepareRepository), so its publish is a
  // fast-forward rather than a rejected non-fast-forward. Only a task branch absent on origin
  // starts at the requested origin/<base_ref>, defaulting to origin/main.
  const taskBranchRef = `refs/remotes/origin/${branch}`;
  const baseBranchRef = `refs/remotes/origin/${checkoutBase}`;
  const onOrigin = await command("git", ["-C", cacheDir, "rev-parse", "--verify", "--quiet", taskBranchRef], { allowFailure: true });
  const cacheRef = branchOverride || onOrigin.status === 0 ? taskBranchRef : baseBranchRef;
  const resolved = await command("git", ["-C", cacheDir, "rev-parse", "--verify", "--quiet", cacheRef], { allowFailure: true });
  if (resolved.status !== 0 || !SHA.test(resolved.stdout)) throw new Error(`clean room: ${cacheRef} did not materialize in ${cacheDir} after fetch`);
  let baseCommit = resolved.stdout;

  // The signed commit half of the pin, checked AFTER the fetch so the cache actually has it.
  // Two refusals, both matching shared mode's reasons:
  //   base_ref_unavailable    -- origin/<base_ref> is not present after the fetch
  //   base_commit_unreachable -- the signed commit is not an ancestor of that ref
  // There is NO fallback to the tip: falling back is precisely the defect, because it converts
  // "the branch moved past what was signed" into a silent success.
  if (pinnedBaseCommit) {
    const baseResolved = await command("git", ["-C", cacheDir, "rev-parse", "--verify", "--quiet", baseBranchRef], { allowFailure: true });
    if (baseResolved.status !== 0 || !SHA.test(baseResolved.stdout)) {
      throw new Error(`base_ref_unavailable: origin/${checkoutBase} is not present in ${cacheDir} after fetch`);
    }
    const isAncestor = await command("git", ["-C", cacheDir, "merge-base", "--is-ancestor", pinnedBaseCommit, baseBranchRef], { allowFailure: true });
    if (isAncestor.status !== 0) {
      throw new Error(`base_commit_unreachable: base_commit ${pinnedBaseCommit.slice(0, 8)} is not an ancestor of origin/${checkoutBase} (as fetched)`);
    }
    // Start the attempt at the SIGNED commit, not at whatever the branch points to now.
    // Only when the task branch is not being continued: a resumed attempt continues at
    // origin/worker/<task> by the same fast-forward rule as shared mode.
    if (cacheRef === baseBranchRef) baseCommit = pinnedBaseCommit;
  }

  // Earlier attempts of this task: sealed (a crashed attempt never sealed itself), never entered.
  for (const previous of listAttempts(attemptsRoot)) sealAttemptDir(attemptPaths(attemptsRoot, previous).attemptDir);
  await command("git", ["-C", cacheDir, "worktree", "prune"], { allowFailure: true });

  // The branch lives in the cache's shared refs. A previous attempt's copy (its worktree still
  // holds it checked out, and it may carry never-pushed commits) is renamed aside under stale/…,
  // never deleted, so this attempt starts at the base commit with a fresh branch of the right name.
  //
  // F3, divergence: when origin has the task branch AND the previous attempt's local copy holds
  // commits that are not on it, this is exactly shared mode's divergence case and gets PR #22's
  // rules, not a force: never-pushed residue is renamed aside and THIS attempt is refused with
  // the reason on record (the retry continues at origin/<branch>); anything else is refused with
  // the divergence reason and nothing renamed.
  let staleRef = null;
  const existing = await command("git", ["-C", cacheDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  if (existing.status === 0 && cacheRef === taskBranchRef) {
    const localSha = existing.stdout;
    const anc = await command("git", ["-C", cacheDir, "merge-base", "--is-ancestor", `refs/heads/${branch}`, baseCommit], { allowFailure: true });
    if (anc.status === 1) {
      const reason = `local branch ${branch} at ${localSha} has commits not on origin/${branch} at ${baseCommit}; refusing to reset (divergence)`;
      const verdict = await classifyDivergedLocal(cacheDir, branch, localSha, baseCommit);
      if (verdict.residue) {
        const asideName = await renameBranchAside(cacheDir, branch);
        throw new Error(`${reason}; never-pushed residue renamed aside to ${asideName} — retry continues at origin/${branch}`);
      }
      throw new Error(verdict.note ? `${reason}; ${verdict.note}` : reason);
    }
    if (anc.status !== 0) throw new Error(`ancestry check failed for ${branch} (${localSha} vs origin/${branch} ${baseCommit}): ${anc.stderr || anc.status}`);
  }
  if (existing.status === 0) staleRef = await renameBranchAside(cacheDir, branch);

  mkdirSync(attemptsRoot, { recursive: true });
  await command("git", ["-C", cacheDir, "worktree", "add", "--quiet", "--detach", paths.attemptDir, baseCommit]);
  await command("git", ["-C", paths.attemptDir, "checkout", "--quiet", "-b", branch]);

  // C3 (worktree-scoped: the cache keeps a working push; see ensureCache for the extension).
  writePrePushHook(paths.hooksDir);
  const hook = join(paths.hooksDir, "pre-push");
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "remote.origin.pushurl", "/dev/null"]);
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "core.hooksPath", paths.hooksDir]);
  const identity = await commitIdentity();
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "user.name", identity.name]);
  await command("git", ["-C", paths.attemptDir, "config", "--worktree", "user.email", identity.email]);

  mkdirSync(paths.homeDir, { recursive: true });
  mkdirSync(paths.tmpDir, { recursive: true });
  const authJson = installAuthFile(paths.homeDir, authFile);

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
    authJson,
  };
}

// C3: the daemon's publisher. Pushes refs/heads/<branch> FROM THE BARE CACHE (the ref is shared
// with the attempt worktree, so nothing is fetched or copied) under the daemon's own env. The
// cache's own config refuses pushes (pushurl=/dev/null + the pre-push hook, see ensureCache), so
// the daemon goes around both for this one command: it pushes to the LITERAL remote.origin.url
// (a URL on the command line is not a remote, so no pushurl applies — `-c remote.origin.pushurl`
// would not do: pushurl is multi-valued, -c appends, and git still tries /dev/null first) with
// `--no-verify` to skip the hook. Nothing in the cache is rewritten. The attempt dir is only READ
// (HEAD:BLOCKER.md). `gh` is pointed at the repo with -R, so it never needs a working tree either.
export async function publishFromCache({ envelope, cacheDir, attemptDir, branch, taskId, limitTripped, prEligible = true, objective = null }) {
  const blockerReason = await readHeadBlocker(attemptDir);
  const originUrl = await command("git", ["-C", cacheDir, "config", "--get", "remote.origin.url"], { allowFailure: true });
  const push = originUrl.status === 0 && originUrl.stdout
    ? await command("git", ["-C", cacheDir, "push", "--no-verify", originUrl.stdout, `refs/heads/${branch}:refs/heads/${branch}`], { allowFailure: true })
    : { status: 1, stderr: `clean room: cache ${cacheDir} has no remote.origin.url to publish to` };
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (blockerReason) return { ...result, publish: push.status === 0 ? "blocked" : "push_failed", blocker_reason: blockerReason };
  if (limitTripped) return result;
  if (push.status !== 0 || envelope.evidence !== "pr") return result;
  // The PR gate, same as the standard publisher. An earlier version of this function relied on
  // the blocker and limitTripped checks above and a comment calling them "this path's
  // equivalent of the eligibility gate". They are not equivalent: finalState also refuses
  // COMPLETED on a harness stop, on outcome.state !== DONE, and on no_commit, none of which
  // are checked here. So a clean-room run that stopped at the instrument or produced no commit
  // would have opened a PR titled COMPLETED. The branch is already pushed above, so refusing
  // here loses no evidence -- it only withholds the review request.
  if (!prEligible) return result;

  const created = await command(
    "gh",
    ["pr", "create", "-R", envelope.repo, "--base", envelope.base_ref ?? "main", "--head", branch, "--title", prTitle({
       taskId,
       objective: objective ?? (typeof envelope.spec === "string" ? envelope.spec : null),
       // Reached only when prEligible, i.e. finalState would return COMPLETED but for the PR
       // itself. The gate is above; this is not asserting the outcome, it is reporting it.
       outcome: "COMPLETED",
       head: null,
       ref: envelope.ref ?? null,
     }), "--body", `Unattended Vinci worker result for task ${taskId}.`],
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
