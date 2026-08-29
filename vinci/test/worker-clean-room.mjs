// W1 clean room per attempt (vinci/worker/cleanroom.mjs, `vinci worker start --clean-room`).
// Real git throughout. Module-level checks first, then one daemon end-to-end run under the flag
// with FIVE planted secrets and a fake vinci that tries to push from inside the attempt.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import {
  CLEAN_ROOM_ENV_ALLOWLIST,
  cleanRoomEnv,
  cleanRoomPaths,
  ensureFreeSpace,
  prepareCleanRoom,
  pruneAttempts,
  publishFromCache,
} from "../worker/cleanroom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
const gitTry = (cwd, args, env = process.env) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
const writable = (path) => (statSync(path).mode & 0o222) !== 0;

const scratch = mkdtempSync(join(tmpdir(), "worker-clean-room-"));
function makeOrigin(org, name, marker) {
  const seed = join(scratch, `seed-${org}-${name}`);
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "doc.md"), `${marker}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  const origin = join(scratch, "origins", org);
  mkdirSync(origin, { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, join(origin, `${name}.git`)]);
  return join(origin, `${name}.git`);
}
const originA = makeOrigin("a", "repo", "org a");
const originB = makeOrigin("b", "repo", "org b");
process.env.VINCI_WORKER_GIT_BASE = join(scratch, "origins");
const state = join(scratch, "state");
mkdirSync(state, { recursive: true });
const noFloor = { diskFloorBytes: 0 };

// --- C1: two attempts of one task => two distinct dirs; the first is kept (sealed) ----------------
const t1a1 = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t1", attempt: 1, ...noFloor });
assert.equal(t1a1.attemptDir, join(state, "attempts", "a", "repo", "t1", "1"));
assert.equal(t1a1.cacheDir, join(state, "cache", "a", "repo.git"));
assert.equal(t1a1.cacheRef, "refs/remotes/origin/main");
assert.equal(t1a1.baseCommit, git(originA, "rev-parse", "main"));
assert.equal(git(t1a1.attemptDir, "symbolic-ref", "HEAD"), "refs/heads/worker/t1");
assert.equal(git(t1a1.attemptDir, "status", "--porcelain"), "", "a fresh worktree is clean");
writeFileSync(join(t1a1.attemptDir, "attempt1.txt"), "work of attempt 1\n");
git(t1a1.attemptDir, "add", "attempt1.txt");
git(t1a1.attemptDir, "commit", "-qm", "attempt 1 work"); // identity comes from the worktree config
const attempt1Head = git(t1a1.attemptDir, "rev-parse", "HEAD");

const t1a2 = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t1", attempt: 2, ...noFloor });
assert.notEqual(t1a2.attemptDir, t1a1.attemptDir, "every attempt gets its own dir");
assert.equal(t1a2.attemptDir, join(state, "attempts", "a", "repo", "t1", "2"));
assert.ok(existsSync(join(t1a1.attemptDir, "attempt1.txt")), "the first attempt's dir is KEPT");
assert.equal(writable(t1a1.attemptDir), false, "the first attempt's dir is sealed read-only");
assert.equal(writable(join(t1a1.attemptDir, "attempt1.txt")), false, "…including its files");
assert.equal(existsSync(join(t1a2.attemptDir, "attempt1.txt")), false, "attempt 2 starts from the base commit, not attempt 1's tree");
assert.equal(git(t1a2.attemptDir, "rev-parse", "HEAD"), t1a1.baseCommit);
assert.equal(git(t1a2.attemptDir, "symbolic-ref", "HEAD"), "refs/heads/worker/t1", "the task branch name is the same in attempt 2");
assert.match(t1a2.staleRef ?? "", /^stale\/worker\/t1-/, "attempt 1's branch was renamed aside, not deleted");
assert.equal(git(t1a1.cacheDir, "rev-parse", t1a2.staleRef), attempt1Head, "the stale ref still points at attempt 1's commit");
await assert.rejects(prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t1", attempt: 2, ...noFloor }), /never reused/);

// --- C1: two tasks on the same repo => no shared working tree ------------------------------------
const t2a1 = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t2", attempt: 1, ...noFloor });
assert.equal(t2a1.cacheDir, t1a2.cacheDir, "one cache per org/repo");
assert.notEqual(t2a1.attemptDir, t1a2.attemptDir);
writeFileSync(join(t2a1.attemptDir, "only-t2.txt"), "t2\n");
assert.equal(existsSync(join(t1a2.attemptDir, "only-t2.txt")), false, "a file written in t2's tree is invisible in t1's tree");
assert.equal(git(t2a1.attemptDir, "status", "--porcelain"), "?? only-t2.txt");
assert.equal(git(t1a2.attemptDir, "status", "--porcelain"), "");
assert.equal(existsSync(join(state, "repos")), false, "clean-room mode never creates the shared checkout");

// --- C1: org collision (a/repo vs b/repo) => distinct caches ---------------------------------------
const b1 = await prepareCleanRoom({ stateDir: state, repo: "b/repo", taskId: "t1", attempt: 1, ...noFloor });
assert.equal(b1.cacheDir, join(state, "cache", "b", "repo.git"));
assert.notEqual(b1.cacheDir, t1a1.cacheDir);
assert.equal(readFileSync(join(b1.attemptDir, "doc.md"), "utf8"), "org b\n");
assert.equal(readFileSync(join(t1a2.attemptDir, "doc.md"), "utf8"), "org a\n");
assert.equal(b1.attemptDir, join(state, "attempts", "b", "repo", "t1", "1"), "attempt dirs are keyed by org too");
assert.equal(git(b1.cacheDir, "config", "--get", "remote.origin.url"), originB);
assert.equal(git(t1a1.cacheDir, "config", "--get", "remote.origin.url"), originA);

// --- C2: env allowlist ------------------------------------------------------------------------------
const planted = {
  GH_TOKEN: "ghp_secret",
  VINCI_BUS_TOKEN: "bus-secret",
  VINCI_GOVERNOR_TOKEN: "gov-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  ANTHROPIC_API_KEY: "sk-ant-secret",
};
const base = { ...planted, PATH: "/usr/bin:/bin", HOME: "/home/daemon", LANG: "C.UTF-8", TMPDIR: "/daemon/tmp", OPENROUTER_API_KEY: "or-key", VINCI_API_KEY: "vinci-key", VINCI_ENV: "dev", VINCI_EVIDENCE_URI_PREFIX: "s3://x", AWS_ACCESS_KEY_ID: "AKIA" };
const childEnv = cleanRoomEnv({ base, provider: "openrouter", homeDir: t1a2.homeDir, tmpDir: t1a2.tmpDir });
for (const key of Object.keys(planted)) assert.equal(key in childEnv, false, `${key} must not reach the child`);
assert.equal("AWS_ACCESS_KEY_ID" in childEnv, false);
assert.equal("VINCI_EVIDENCE_URI_PREFIX" in childEnv, false);
assert.equal(childEnv.OPENROUTER_API_KEY, "or-key", "the envelope's provider key is kept");
assert.equal("VINCI_API_KEY" in childEnv, false, "another provider's key is dropped");
assert.equal(childEnv.HOME, t1a2.homeDir, "HOME is the per-attempt one");
assert.equal(childEnv.TMPDIR, t1a2.tmpDir, "TMPDIR is the per-attempt one");
assert.equal(childEnv.VINCI_HOME, "/home/daemon/.vinci-code", "the launcher's install root is passed explicitly (HOME no longer leads to it)");
assert.equal(childEnv.VINCI_UPDATE_DISABLED, "1");
assert.equal(childEnv.VINCI_ENV, "dev");
assert.equal(childEnv.PATH, base.PATH);
const vinciEnv = cleanRoomEnv({ base, provider: "vinci", homeDir: t1a2.homeDir, tmpDir: t1a2.tmpDir });
assert.equal(vinciEnv.VINCI_API_KEY, "vinci-key");
assert.equal("OPENROUTER_API_KEY" in vinciEnv, false);
assert.deepEqual(Object.keys(cleanRoomEnv({ base, provider: "unknown", homeDir: "h", tmpDir: "t" })).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "VINCI_ENV", "VINCI_HOME", "VINCI_UPDATE_DISABLED"]);
assert.ok(!CLEAN_ROOM_ENV_ALLOWLIST.includes("HOME") && !CLEAN_ROOM_ENV_ALLOWLIST.includes("TMPDIR"), "HOME/TMPDIR are set, never copied");

// --- C3: push from inside refused; the daemon's publisher lands the branch ------------------------
writeFileSync(join(t1a2.attemptDir, "result.txt"), "attempt 2 result\n");
git(t1a2.attemptDir, "add", "result.txt");
git(t1a2.attemptDir, "commit", "-qm", "attempt 2 result");
const attempt2Head = git(t1a2.attemptDir, "rev-parse", "HEAD");
const insidePush = gitTry(t1a2.attemptDir, ["push", "origin", "HEAD"]);
assert.notEqual(insidePush.status, 0, "git push origin from inside the attempt must fail");
const literalPush = gitTry(t1a2.attemptDir, ["push", originA, "HEAD:refs/heads/worker/t1"]);
assert.notEqual(literalPush.status, 0, "git push <literal url> from inside the attempt must fail (pre-push hook)");
assert.match(literalPush.stderr, /clean room: git push from inside an attempt worktree is refused/);
assert.equal(gitTry(originA, ["rev-parse", "--verify", "--quiet", "refs/heads/worker/t1"]).status, 1, "nothing reached origin from inside");

const fakeBin = join(scratch, "bin");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\necho https://github.com/a/repo/pull/7\n", { mode: 0o755 });
const savedPath = process.env.PATH;
process.env.PATH = `${fakeBin}:${savedPath}`;
const published = await publishFromCache({ envelope: { repo: "a/repo", evidence: "pr" }, cacheDir: t1a2.cacheDir, attemptDir: t1a2.attemptDir, branch: t1a2.branch, taskId: "t1", limitTripped: null });
process.env.PATH = savedPath;
assert.equal(published.publish, "pushed");
assert.equal(published.pr, "https://github.com/a/repo/pull/7");
assert.equal(git(originA, "rev-parse", "refs/heads/worker/t1"), attempt2Head, "the daemon's publish from the cache landed attempt 2's HEAD on origin");
assert.equal(gitTry(t1a2.attemptDir, ["push", "origin", "HEAD"]).status !== 0, true, "publishing did not hand the attempt a working push");

// --- C4: retention keeps the newest 3, never the protected (running) one --------------------------
for (const n of [1, 2, 3, 4, 5]) await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "ret", attempt: n, ...noFloor });
const retRoot = join(state, "attempts", "a", "repo", "ret");
assert.deepEqual(await pruneAttempts({ stateDir: state, repo: "a/repo", taskId: "ret", keep: 3, protect: 5 }), [1, 2]);
for (const n of [1, 2]) assert.equal(existsSync(join(retRoot, String(n))), false, `attempt ${n} pruned`);
for (const n of [3, 4, 5]) assert.ok(existsSync(join(retRoot, String(n))), `attempt ${n} kept`);
assert.equal(existsSync(join(retRoot, "1.home")), false, "the pruned attempt's HOME/TMPDIR/hooks go with it");
assert.deepEqual(await pruneAttempts({ stateDir: state, repo: "a/repo", taskId: "ret", keep: 1, protect: 3 }), [4], "never the newest (5), never the protected (3)");
const worktrees = git(t1a1.cacheDir, "worktree", "list", "--porcelain");
assert.ok(!worktrees.includes(join(retRoot, "1")) && !worktrees.includes(join(retRoot, "4")), "pruned worktrees are deregistered from the cache");
const ret6 = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "ret", attempt: 6, ...noFloor });
assert.ok(existsSync(join(ret6.attemptDir, "doc.md")), "a new attempt still works after pruning");

// --- C4: disk floor ---------------------------------------------------------------------------------
assert.throws(() => ensureFreeSpace(state, Number.MAX_SAFE_INTEGER), /below the .* MiB floor; refusing to start/);
ensureFreeSpace(state, 1);
await assert.rejects(prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "floor", attempt: 1, diskFloorBytes: Number.MAX_SAFE_INTEGER }), /refusing to start the attempt/);
assert.equal(existsSync(join(state, "attempts", "a", "repo", "floor")), false, "a refused attempt creates nothing");
assert.throws(() => cleanRoomPaths(state, "../x/repo", "t"), /org\/name form/);

// --- Daemon end-to-end under --clean-room: 5 planted secrets, a pushing fake vinci, real publish --
const fixture = new WorkerTestFixture("clean-room");
try {
  fixture.createRepo("test", "repo");
  fixture.linkTools(TOOLS);
  const record = join(fixture.tempDir, "child-observations.json");
  const ownTools = join(fixture.tempDir, "own-tools");
  mkdirSync(ownTools);
  // The fake vinci gets NOTHING from its environment beyond PATH: every path it needs is baked in.
  writeFileSync(join(ownTools, "vinci"), `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("0.0.0-fake\\n"); process.exit(0); }
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const sessionId = argv[argv.indexOf("--session-id") + 1];
mkdirSync(resolve(sessionDir, sessionId), { recursive: true });
const outcome = { type: "custom", customType: "vinci-task-outcome", data: { schemaVersion: 1, taskId: sessionId, state: "DONE", reason: "fake", changedFiles: [], verificationStatus: "passed", verificationCommand: "x", usage: { modelCalls: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.01, providers: ["fixture"], models: ["fixture/model"] }, recordedAt: new Date().toISOString() } };
writeFileSync(resolve(sessionDir, sessionId, "session.jsonl"), JSON.stringify({ type: "session", id: sessionId }) + "\\n" + JSON.stringify(outcome) + "\\n");
writeFileSync("agent-output.txt", "written by the agent\\n");
const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
git("add", "agent-output.txt");
const commit = git("commit", "-qm", "agent commit");
const push = git("push", "origin", "HEAD");
const url = git("config", "--get", "remote.origin.url").stdout.trim();
const literal = git("push", url, "HEAD:refs/heads/agent-escape");
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ env: process.env, cwd: process.cwd(), commit: commit.status, push: push.status, pushStderr: push.stderr, literal: literal.status, literalStderr: literal.stderr, head: git("rev-parse", "HEAD").stdout.trim() }));
process.exit(0);
`, { mode: 0o755 });
  chmodSync(join(ownTools, "vinci"), 0o755);
  await fixture.startBus([{
    message_id: "cr1",
    to_agent: "worker:w1",
    kind: "handoff",
    subject: "clean room",
    body: "repo: test/repo\nevidence: pr\nref: job_cr\n\nDo the task",
    ts: "2026-08-28T10:00:00Z",
    posted_by: "scheduler",
  }]);
  // The five planted secrets: the fixture's own bus token (the daemon needs it to talk to the
  // bus), plus four more the daemon carries on a real box. None may reach the child.
  const daemonEnv = fixture.getEnv({
    ...planted,
    VINCI_BUS_TOKEN: "test-token",
    OPENROUTER_API_KEY: "or-key-for-the-task",
    PATH: `${ownTools}:${fixture.toolsDir}:${process.env.PATH}`,
  });
  const child = spawn("node", [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir, "--clean-room", "--disk-floor-mb", "0"], { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  assert.equal(await new Promise((r) => child.once("close", r)), 0, `daemon exit: ${stderr}`);

  const seen = JSON.parse(readFileSync(record, "utf8"));
  for (const key of Object.keys(planted)) assert.equal(key in seen.env, false, `child must not see ${key}`);
  assert.equal(seen.env.OPENROUTER_API_KEY, "or-key-for-the-task", "the provider key the envelope needs is present");
  assert.equal(seen.env.VINCI_UPDATE_DISABLED, "1");
  assert.equal(seen.env.HOME, join(fixture.tempDir, "attempts", "test", "repo", "cr1", "1.home"));
  assert.equal(seen.env.TMPDIR, join(fixture.tempDir, "attempts", "test", "repo", "cr1", "1.tmp"));
  const attemptDir = join(fixture.tempDir, "attempts", "test", "repo", "cr1", "1");
  assert.equal(seen.cwd, realpathSync(attemptDir), "the child runs inside the attempt worktree"); // cwd() is symlink-resolved on macOS
  assert.equal(seen.commit, 0, "the agent can commit inside the attempt");
  assert.notEqual(seen.push, 0, "git push origin from inside the attempt is refused");
  assert.notEqual(seen.literal, 0, "git push <url> from inside the attempt is refused");
  assert.match(seen.literalStderr, /clean room: git push from inside an attempt worktree is refused/);

  const task = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", "cr1.json"), "utf8"));
  assert.equal(task.state, "COMPLETED", `state: ${JSON.stringify(task)}`);
  assert.equal(task.publish, "pushed");
  assert.equal(task.pr, "https://github.com/test/repo/pull/123");
  assert.equal(realpathSync(task.attempt_dir), seen.cwd);
  assert.equal(task.cache_ref, "refs/remotes/origin/main");
  assert.match(task.base_commit, /^[0-9a-f]{40}$/);
  assert.equal(task.head, seen.head);
  const origin = join(fixture.reposDir, "test", "repo.git");
  assert.equal(git(origin, "rev-parse", "refs/heads/worker/cr1"), seen.head, "the daemon's publisher landed the agent's commit on origin");
  assert.equal(gitTry(origin, ["rev-parse", "--verify", "--quiet", "refs/heads/agent-escape"]).status, 1, "the agent's own push never reached origin");
  assert.equal(writable(attemptDir), false, "the finished attempt's tree is sealed");
  assert.equal(existsSync(join(fixture.tempDir, "repos")), false, "no shared checkout was created");
  const ghCalls = readFileSync(join(fixture.tempDir, "gh-calls.txt"), "utf8");
  assert.match(ghCalls, /"-R","test\/repo"/, "gh is pointed at the repo explicitly, not at a working tree");
} finally {
  // Sealed attempt dirs are read-only by design; make them removable before the fixture's rm.
  spawnSync("chmod", ["-R", "u+w", fixture.tempDir]);
  await fixture.cleanup();
}
spawnSync("chmod", ["-R", "u+w", scratch]);
rmSync(scratch, { recursive: true, force: true });

console.log("PASS worker-clean-room");
