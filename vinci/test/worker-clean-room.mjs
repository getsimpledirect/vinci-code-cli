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
  evidenceMarkerPath,
  markEvidenceUploaded,
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
assert.deepEqual(Object.keys(cleanRoomEnv({ base, provider: "unknown", homeDir: "h", tmpDir: "t" })).sort(), ["HOME", "LANG", "PATH", "PI_CODING_AGENT_DIR", "TMPDIR", "VINCI_CODING_AGENT_DIR", "VINCI_ENV", "VINCI_HOME", "VINCI_UPDATE_DISABLED"]);
assert.ok(!CLEAN_ROOM_ENV_ALLOWLIST.includes("HOME") && !CLEAN_ROOM_ENV_ALLOWLIST.includes("TMPDIR"), "HOME/TMPDIR are set, never copied");

// --- F4: the daemon's agent slot never passes through; VINCI_WORKER_AUTH_FILE is the narrow opt-in --
assert.ok(!CLEAN_ROOM_ENV_ALLOWLIST.includes("VINCI_CODING_AGENT_DIR") && !CLEAN_ROOM_ENV_ALLOWLIST.includes("PI_CODING_AGENT_DIR"), "the daemon's agent slot is not on the allowlist");
const daemonSlot = join(scratch, "daemon-slot", "agent");
mkdirSync(join(daemonSlot, "sessions"), { recursive: true });
mkdirSync(join(daemonSlot, "bin"), { recursive: true });
writeFileSync(join(daemonSlot, "auth.json"), '{"openrouter":{"key":"daemon-login"},"anthropic":{"key":"other-provider"}}\n');
writeFileSync(join(daemonSlot, "sessions", "old.jsonl"), "prior session\n");
writeFileSync(join(daemonSlot, "bin", "tool"), "#!/bin/sh\n");
const slotEnv = cleanRoomEnv({ base: { ...base, VINCI_CODING_AGENT_DIR: daemonSlot, PI_CODING_AGENT_DIR: daemonSlot }, provider: "openrouter", homeDir: t1a2.homeDir, tmpDir: t1a2.tmpDir });
assert.equal(slotEnv.VINCI_CODING_AGENT_DIR, join(t1a2.homeDir, "agent"), "the child's slot is inside its fresh HOME, not the daemon's");
assert.equal(slotEnv.PI_CODING_AGENT_DIR, join(t1a2.homeDir, "agent"), "…in both spellings");
assert.equal(existsSync(join(t1a2.homeDir, "agent")), false, "without VINCI_WORKER_AUTH_FILE the fresh HOME has no slot at all");
const listTree = (dir) => { const out = []; const walk = (d) => { for (const e of execFileSync("ls", ["-A", d]).toString().split("\n").filter(Boolean)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push(p.slice(dir.length + 1)); } }; walk(dir); return out.sort(); };
const singleAuth = join(scratch, "one-auth.json");
writeFileSync(singleAuth, '{"openrouter":{"key":"just-this-one"}}\n');
const withAuth = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "auth", attempt: 1, authFile: singleAuth, ...noFloor });
assert.equal(withAuth.authJson, join(withAuth.homeDir, "agent", "auth.json"));
assert.deepEqual(listTree(withAuth.homeDir), ["agent/auth.json"], "the fresh HOME holds exactly ONE file: agent/auth.json — no sessions, no bin, nothing else from the daemon slot");
assert.equal(readFileSync(withAuth.authJson, "utf8"), '{"openrouter":{"key":"just-this-one"}}\n');
assert.equal(statSync(withAuth.authJson).mode & 0o777, 0o600, "auth.json is 0600");
assert.equal(cleanRoomEnv({ base, provider: "openrouter", homeDir: withAuth.homeDir, tmpDir: withAuth.tmpDir }).VINCI_CODING_AGENT_DIR, dirname(withAuth.authJson), "the child's agent dir is exactly where the file was placed");
const withoutAuth = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "auth", attempt: 2, authFile: undefined, ...noFloor });
assert.equal(withoutAuth.authJson, null);
assert.deepEqual(listTree(withoutAuth.homeDir), [], "no opt-in ⇒ an empty HOME");
await assert.rejects(prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "auth", attempt: 3, authFile: join(scratch, "missing.json"), ...noFloor }), /VINCI_WORKER_AUTH_FILE .* does not exist/, "a set-but-missing auth file fails the attempt loudly");

// --- C3: push from inside refused; the daemon's publisher lands the branch ------------------------
writeFileSync(join(t1a2.attemptDir, "result.txt"), "attempt 2 result\n");
git(t1a2.attemptDir, "add", "result.txt");
git(t1a2.attemptDir, "commit", "-qm", "attempt 2 result");
const attempt2Head = git(t1a2.attemptDir, "rev-parse", "HEAD");
const insidePush = gitTry(t1a2.attemptDir, ["push", "origin", "HEAD"]);
assert.notEqual(insidePush.status, 0, "git push origin from inside the attempt must fail");
assert.equal(gitTry(t1a2.attemptDir, ["config", "--get", "remote.origin.pushurl"]).stdout.trim(), "/dev/null", "origin's push URL is dead inside the attempt");
assert.equal(gitTry(t1a1.cacheDir, ["config", "--get", "remote.origin.pushurl"]).stdout.trim(), "/dev/null", "…and in the cache too (F1: the cache is the git-common-dir every worktree can name)");
assert.equal(gitTry(t1a1.cacheDir, ["config", "--get", "core.hooksPath"]).stdout.trim(), join(t1a1.cacheDir, "hooks"), "the cache carries the refusing hook as well");
const noVerifyPush = gitTry(t1a2.attemptDir, ["push", "--no-verify", "origin", "HEAD"]);
assert.notEqual(noVerifyPush.status, 0, "git push --no-verify origin (hook bypassed) still fails: the pushurl is what stops it");
assert.match(noVerifyPush.stderr, /\/dev\/null/);
const literalPush = gitTry(t1a2.attemptDir, ["push", originA, "HEAD:refs/heads/worker/t1"]);
assert.notEqual(literalPush.status, 0, "git push <literal url> from inside the attempt must fail (pre-push hook)");
assert.match(literalPush.stderr, /clean room: git push from inside an attempt worktree is refused/);
assert.equal(gitTry(originA, ["rev-parse", "--verify", "--quiet", "refs/heads/worker/t1"]).status, 1, "nothing reached origin from inside");

// --- F1: the three same-uid bypasses, each asserted with its CURRENT status. The origin here is a
// local path, i.e. a transport that needs no credential — exactly the case the clean room does
// not cover (an SSH agent socket, an instance profile, osxkeychain on macOS). An OPEN bypass is
// asserted open on purpose: a later change that closes it must flip the assertion deliberately.
const commonDir = gitTry(t1a2.attemptDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
assert.equal(realpathSync(commonDir), realpathSync(t1a2.cacheDir), "the child can name the cache: it is the worktree's git-common-dir");
// Bypass 2 — CLOSED by F1: push from the common dir (the daemon's own publish path).
const commonPush = gitTry(commonDir, ["push", "origin", "refs/heads/worker/t1:refs/heads/worker/t1"]);
assert.notEqual(commonPush.status, 0, "git -C <common-dir> push origin is refused (cache-level pushurl)");
assert.match(commonPush.stderr, /\/dev\/null/);
const commonNoVerify = gitTry(commonDir, ["push", "--no-verify", "origin", "refs/heads/worker/t1:refs/heads/worker/t1"]);
assert.notEqual(commonNoVerify.status, 0, "…and with --no-verify (the pushurl, not the hook, is what refuses)");
const commonHooked = gitTry(commonDir, ["push", originA, "refs/heads/worker/t1:refs/heads/bypass-common"]);
assert.notEqual(commonHooked.status, 0, "git -C <common-dir> push <literal url> trips the cache's hook");
assert.match(commonHooked.stderr, /clean room: git push from inside an attempt worktree is refused/);
assert.equal(gitTry(originA, ["rev-parse", "--verify", "--quiet", "refs/heads/worker/t1"]).status, 1, "nothing reached origin via the common dir");
// Bypass 1 — OPEN (documented): --no-verify + a literal URL skips both the pushurl and the hook.
const bypassLiteral = gitTry(t1a2.attemptDir, ["push", "--no-verify", originA, "HEAD:refs/heads/bypass-literal"]);
assert.equal(bypassLiteral.status, 0, "OPEN: git push --no-verify <literal url> from inside the attempt reaches a credential-free origin (same uid; documented in README)");
assert.equal(git(originA, "rev-parse", "refs/heads/bypass-literal"), attempt2Head);
git(originA, "update-ref", "-d", "refs/heads/bypass-literal");
// Bypass 3 — OPEN (documented): a remote the child adds itself has no pushurl; --no-verify skips the hook.
assert.equal(gitTry(t1a2.attemptDir, ["remote", "add", "x", originA]).status, 0);
const bypassRemote = gitTry(t1a2.attemptDir, ["push", "--no-verify", "x", "HEAD:refs/heads/bypass-remote"]);
assert.equal(bypassRemote.status, 0, "OPEN: git remote add x <url> && git push --no-verify x reaches a credential-free origin (same uid; documented in README)");
assert.equal(git(originA, "rev-parse", "refs/heads/bypass-remote"), attempt2Head);
git(originA, "update-ref", "-d", "refs/heads/bypass-remote");
git(t1a2.attemptDir, "remote", "remove", "x"); // remote config is shared with the cache; put it back
assert.equal(gitTry(t1a2.attemptDir, ["push", "x", "HEAD"]).status !== 0, true);

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
assert.equal(gitTry(t1a2.cacheDir, ["config", "--get", "remote.origin.pushurl"]).stdout.trim(), "/dev/null", "publishing did not rewrite the cache's refusal either (the override was command-line only)");
assert.equal(gitTry(t1a2.cacheDir, ["push", "origin", "refs/heads/worker/t1:refs/heads/worker/t1"]).status !== 0, true, "a plain push from the cache is still refused after the daemon published");

// --- F3: attempt N+1 continues at origin/worker/<task> once attempt N has published ------------
const t1a3 = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t1", attempt: 3, ...noFloor });
assert.equal(t1a3.cacheRef, "refs/remotes/origin/worker/t1", "the task branch exists on origin, so attempt 3 bases on it");
assert.equal(t1a3.baseCommit, attempt2Head, "…at the commit attempt 2 published");
assert.equal(git(t1a3.attemptDir, "rev-parse", "HEAD"), attempt2Head);
assert.ok(existsSync(join(t1a3.attemptDir, "result.txt")), "attempt 2's published work is in attempt 3's tree");
assert.match(t1a3.staleRef ?? "", /^stale\/worker\/t1-/, "attempt 2's local branch (equal to origin) was still renamed aside, not deleted");
writeFileSync(join(t1a3.attemptDir, "more.txt"), "attempt 3 continues\n");
git(t1a3.attemptDir, "add", "more.txt");
git(t1a3.attemptDir, "commit", "-qm", "attempt 3 continues");
const attempt3Head = git(t1a3.attemptDir, "rev-parse", "HEAD");
process.env.PATH = `${fakeBin}:${savedPath}`;
const published3 = await publishFromCache({ envelope: { repo: "a/repo", evidence: "pr" }, cacheDir: t1a3.cacheDir, attemptDir: t1a3.attemptDir, branch: t1a3.branch, taskId: "t1", limitTripped: null });
process.env.PATH = savedPath;
assert.equal(published3.publish, "pushed", "attempt 3's publish is a fast-forward, not a rejected non-fast-forward");
assert.equal(git(originA, "rev-parse", "refs/heads/worker/t1"), attempt3Head);
// Divergence: attempt 3 commits again after publishing and crashes. Attempt 4 finds a local
// branch ahead of origin/worker/t1 ⇒ PR #22's rules: never-pushed residue renamed aside, the
// attempt refused with the reason on record, and attempt 5 continues at origin/worker/t1.
writeFileSync(join(t1a3.attemptDir, "unpushed.txt"), "never pushed\n");
git(t1a3.attemptDir, "add", "unpushed.txt");
git(t1a3.attemptDir, "commit", "-qm", "never pushed");
const unpushedHead = git(t1a3.attemptDir, "rev-parse", "HEAD");
await assert.rejects(prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t1", attempt: 4, ...noFloor }), (error) => {
  assert.match(error.message, /has commits not on origin\/worker\/t1 .*refusing to reset \(divergence\); never-pushed residue renamed aside to stale\/worker\/t1-.* — retry continues at origin\/worker\/t1/);
  return true;
});
assert.equal(git(originA, "rev-parse", "refs/heads/worker/t1"), attempt3Head, "nothing was forced onto origin");
const staleRefs = git(t1a3.cacheDir, "for-each-ref", "--format=%(objectname)", "refs/heads/stale/worker/");
assert.ok(staleRefs.split("\n").includes(unpushedHead), "the never-pushed commit survives under stale/");
const t1a5 = await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "t1", attempt: 5, ...noFloor });
assert.equal(t1a5.baseCommit, attempt3Head, "the retry continues at origin/worker/t1");
assert.equal(t1a5.staleRef, null, "nothing left to rename: attempt 4 already moved the residue aside");

// --- C4 + F6: retention counts only attempts whose evidence was uploaded; never the protected one --
for (const n of [1, 2, 3, 4, 5]) await prepareCleanRoom({ stateDir: state, repo: "a/repo", taskId: "ret", attempt: n, ...noFloor });
const retRoot = join(state, "attempts", "a", "repo", "ret");
assert.deepEqual(await pruneAttempts({ stateDir: state, repo: "a/repo", taskId: "ret", keep: 1, protect: 5 }), [], "F6: no attempt has an evidence marker ⇒ nothing is pruned, whatever the count");
for (const n of [1, 2, 3, 4, 5]) assert.ok(existsSync(join(retRoot, String(n))), `attempt ${n} kept without a marker`);
// Attempt 2 crashed and was never uploaded (no marker); 1, 3, 4, 5 were.
for (const n of [1, 3, 4, 5]) markEvidenceUploaded({ stateDir: state, repo: "a/repo", taskId: "ret", attempt: n, uri: `s3://x/${n}`, sha256: "0".repeat(64) });
assert.equal(evidenceMarkerPath({ stateDir: state, repo: "a/repo", taskId: "ret", attempt: 1 }), join(retRoot, "1.evidence_uploaded"), "the marker sits beside the sealed tree, not inside it");
assert.equal(JSON.parse(readFileSync(join(retRoot, "1.evidence_uploaded"), "utf8")).uri, "s3://x/1");
assert.deepEqual(await pruneAttempts({ stateDir: state, repo: "a/repo", taskId: "ret", keep: 3, protect: 5 }), [1], "keep 3 of the MARKED dirs (3, 4, 5): 1 goes, 2 (unmarked) is never a candidate");
assert.equal(existsSync(join(retRoot, "1")), false, "attempt 1 pruned");
assert.equal(existsSync(join(retRoot, "1.evidence_uploaded")), false, "…marker included");
assert.ok(existsSync(join(retRoot, "2")), "F6: the crashed, never-uploaded attempt 2 is kept although it is older than the keep window");
for (const n of [3, 4, 5]) assert.ok(existsSync(join(retRoot, String(n))), `attempt ${n} kept`);
assert.equal(existsSync(join(retRoot, "1.home")), false, "the pruned attempt's HOME/TMPDIR/hooks go with it");
assert.deepEqual(await pruneAttempts({ stateDir: state, repo: "a/repo", taskId: "ret", keep: 1, protect: 3 }), [4], "never the newest (5), never the protected (3), never the unmarked (2)");
assert.ok(existsSync(join(retRoot, "2")), "attempt 2 still kept");
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
  const daemonAuth = join(fixture.tempDir, "daemon-auth.json");
  writeFileSync(daemonAuth, '{"openrouter":{"key":"copied-in"}}\n');
  const daemonEnv = fixture.getEnv({
    ...planted,
    VINCI_BUS_TOKEN: "test-token",
    OPENROUTER_API_KEY: "or-key-for-the-task",
    VINCI_CODING_AGENT_DIR: join(fixture.tempDir, "daemon-slot"),
    PI_CODING_AGENT_DIR: join(fixture.tempDir, "daemon-slot"),
    VINCI_WORKER_AUTH_FILE: daemonAuth,
    VINCI_EVIDENCE_URI_PREFIX: "s3://evidence-bucket/vinci/",
    FAKE_AWS_RECORD: join(fixture.tempDir, "aws-calls.txt"),
    // F8: "0" through the env is an explicit disable, exactly like `--disk-floor-mb 0` (no flag here).
    VINCI_WORKER_DISK_FLOOR_MB: "0",
    PATH: `${ownTools}:${fixture.toolsDir}:${process.env.PATH}`,
  });
  const child = spawn("node", [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir, "--clean-room"], { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  assert.equal(await new Promise((r) => child.once("close", r)), 0, `daemon exit: ${stderr}`);
  assert.match(stderr, /clean room on \(disk floor 0 MiB, disabled, keep 3 attempts\)/, "F8: VINCI_WORKER_DISK_FLOOR_MB=0 is an explicit disable, not the default");

  const seen = JSON.parse(readFileSync(record, "utf8"));
  for (const key of Object.keys(planted)) assert.equal(key in seen.env, false, `child must not see ${key}`);
  assert.equal(seen.env.OPENROUTER_API_KEY, "or-key-for-the-task", "the provider key the envelope needs is present");
  assert.equal(seen.env.VINCI_UPDATE_DISABLED, "1");
  assert.equal(seen.env.HOME, join(fixture.tempDir, "attempts", "test", "repo", "cr1", "1.home"));
  assert.equal(seen.env.TMPDIR, join(fixture.tempDir, "attempts", "test", "repo", "cr1", "1.tmp"));
  assert.equal(seen.env.VINCI_CODING_AGENT_DIR, join(seen.env.HOME, "agent"), "F4: the child's slot is in its fresh HOME, not the daemon's");
  assert.equal(seen.env.PI_CODING_AGENT_DIR, join(seen.env.HOME, "agent"));
  assert.equal(readFileSync(join(seen.env.HOME, "agent", "auth.json"), "utf8"), '{"openrouter":{"key":"copied-in"}}\n', "F4: the one opted-in credential file was copied into the child's slot");
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
  assert.equal(task.evidence_error, null, `evidence landed: ${JSON.stringify(task)}`);
  const marker = JSON.parse(readFileSync(join(fixture.tempDir, "attempts", "test", "repo", "cr1", "1.evidence_uploaded"), "utf8"));
  assert.equal(marker.attempt, 1, "F6: the evidence marker is written beside the attempt after a successful upload");
  assert.match(marker.uri, /^s3:\/\/evidence-bucket\/vinci\/cr1\/[0-9a-f]{64}\.tgz$/);
  assert.equal(existsSync(join(fixture.tempDir, "repos")), false, "no shared checkout was created");
  const ghCalls = readFileSync(join(fixture.tempDir, "gh-calls.txt"), "utf8");
  assert.match(ghCalls, /"-R","test\/repo"/, "gh is pointed at the repo explicitly, not at a working tree");
} finally {
  // Sealed attempt dirs are read-only by design; make them removable before the fixture's rm.
  spawnSync("chmod", ["-R", "u+w", fixture.tempDir]);
  await fixture.cleanup();
}
// --- F8: env values are validated like their flags; F6: no evidence configured ⇒ no marker ---------
{
  const fx = new WorkerTestFixture("clean-room-f8");
  try {
    fx.createRepo("test", "repo");
    fx.linkTools(TOOLS);
    await fx.startBus([{ message_id: "cr2", to_agent: "worker:w1", kind: "handoff", subject: "x", body: "repo: test/repo\nevidence: pr\nref: job_cr2\n\nDo the task", ts: "2026-08-28T10:00:00Z", posted_by: "scheduler" }]);
    // Async, never spawnSync: the fixture's bus server lives in THIS process, so a blocking spawn
    // would deadlock the daemon against it.
    const run = (env, ...extra) => new Promise((done) => {
      const daemon = spawn("node", [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fx.busUrl(), "--once", "--state-dir", fx.tempDir, "--clean-room", ...extra], { env: fx.getEnv(env), stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      daemon.stderr.on("data", (c) => { err += c; });
      daemon.once("close", (status) => done({ status, stderr: err }));
    });
    const bad = await run({ VINCI_WORKER_DISK_FLOOR_MB: "abc" });
    assert.notEqual(bad.status, 0, "an unparsable VINCI_WORKER_DISK_FLOOR_MB is refused, not defaulted");
    assert.match(bad.stderr, /VINCI_WORKER_DISK_FLOOR_MB must be a non-negative number/);
    const negative = await run({ VINCI_WORKER_DISK_FLOOR_MB: "-1" });
    assert.notEqual(negative.status, 0);
    const badKeep = await run({ VINCI_WORKER_KEEP_ATTEMPTS: "0" });
    assert.notEqual(badKeep.status, 0, "VINCI_WORKER_KEEP_ATTEMPTS=0 is refused like --keep-attempts 0");
    assert.match(badKeep.stderr, /VINCI_WORKER_KEEP_ATTEMPTS must be a positive integer/);
    assert.equal(existsSync(join(fx.tempDir, "tasks", "cr2.json")), false, "a refused start processed nothing");
    // Unset env ⇒ the default floor; the fixture's disk is above 2048 MiB, so the run proceeds
    // with no evidence configured ⇒ the attempt completes without a marker (F6: not prunable).
    const ok = await run({ VINCI_EVIDENCE_URI_PREFIX: "" }, "--disk-floor-mb", "1");
    assert.equal(ok.status, 0, `daemon exit: ${ok.stderr}`);
    assert.match(ok.stderr, /clean room on \(disk floor 1 MiB, keep 3 attempts\)/);
    assert.equal(JSON.parse(readFileSync(join(fx.tempDir, "tasks", "cr2.json"), "utf8")).state, "COMPLETED");
    assert.equal(existsSync(join(fx.tempDir, "attempts", "test", "repo", "cr2", "1.evidence_uploaded")), false, "F6: no evidence upload ⇒ no marker ⇒ the sealed dir is never pruned by count");
  } finally {
    spawnSync("chmod", ["-R", "u+w", fx.tempDir]);
    await fx.cleanup();
  }
}

spawnSync("chmod", ["-R", "u+w", scratch]);
rmSync(scratch, { recursive: true, force: true });

console.log("PASS worker-clean-room");

// --- C-PIN: the SIGNED base_commit half of a digest pin ------------------------------------------
//
// 🔴 THE DEFECT THIS COVERS. A digest handoff signs BOTH base_ref and base_commit, and shared
// mode (prepareRepository) validates both. prepareCleanRoom took only base_ref and resolved
// origin/<base_ref> to its CURRENT TIP. So if the branch advanced after the contract was issued,
// the clean room forked from the NEW tip and the signed commit was never checked -- while the
// composed guard in worker.mjs permits a non-main base on the grounds that EITHER mechanism
// honours the pin. That was half true.
//
// The advancing-branch case is the one that matters and the one no existing test reached: a
// pin that is still the tip cannot distinguish "honours the commit" from "ignores it".
{
  const seed = join(scratch, "seed-pin");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "doc.md"), "signed\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "signed base");
  const signedSha = git(seed, "rev-parse", "HEAD");
  // The branch MOVES after the contract was signed.
  writeFileSync(join(seed, "doc.md"), "advanced\n");
  git(seed, "commit", "-qam", "advanced past the signed commit");
  const advancedSha = git(seed, "rev-parse", "HEAD");
  assert.notEqual(signedSha, advancedSha, "precondition: the branch must have advanced");

  const originDir = join(scratch, "origins", "pin");
  mkdirSync(originDir, { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, join(originDir, "repo.git")]);

  // Honours the SIGNED commit, not the current tip.
  const pinned = await prepareCleanRoom({
    stateDir: state, repo: "pin/repo", taskId: "t-pin", attempt: 1,
    baseRef: "main", pinnedBaseCommit: signedSha, ...noFloor,
  });
  assert.equal(pinned.baseCommit, signedSha,
    `clean room must start at the SIGNED base_commit ${signedSha.slice(0, 8)}, not the ` +
    `current tip ${advancedSha.slice(0, 8)}`);
  assert.equal(git(pinned.attemptDir, "rev-parse", "HEAD"), signedSha,
    "the attempt worktree itself must be checked out at the signed commit");

  // Without the pin, the old behaviour stands: the tip. This is the anti-vacuity case -- an
  // implementation that ALWAYS used some fixed commit would pass the assertion above.
  const unpinned = await prepareCleanRoom({
    stateDir: state, repo: "pin/repo", taskId: "t-pin-none", attempt: 1,
    baseRef: "main", ...noFloor,
  });
  assert.equal(unpinned.baseCommit, advancedSha,
    "with no pinned base_commit the clean room still bases at the current tip");

  // An unreachable commit is REFUSED, not silently replaced by the tip. Falling back is the
  // defect itself: it turns 'the branch moved past what was signed' into a silent success.
  const unreachable = "0".repeat(40);
  await assert.rejects(
    prepareCleanRoom({
      stateDir: state, repo: "pin/repo", taskId: "t-pin-bad", attempt: 1,
      baseRef: "main", pinnedBaseCommit: unreachable, ...noFloor,
    }),
    /base_commit_unreachable/,
    "an unreachable signed commit must refuse with base_commit_unreachable, never fall back",
  );

  // A malformed pin is refused before any git work.
  await assert.rejects(
    prepareCleanRoom({
      stateDir: state, repo: "pin/repo", taskId: "t-pin-malformed", attempt: 1,
      baseRef: "main", pinnedBaseCommit: "deadbeef", ...noFloor,
    }),
    /40-character lowercase hex/,
    "a short/malformed base_commit must be refused",
  );

  // A pin with no base_ref cannot be validated against anything, so it is refused rather than
  // accepted on trust -- the same reason shared mode raises base_ref_unavailable.
  await assert.rejects(
    prepareCleanRoom({
      stateDir: state, repo: "pin/repo", taskId: "t-pin-noref", attempt: 1,
      pinnedBaseCommit: signedSha, ...noFloor,
    }),
    /base_ref_unavailable/,
    "a pinned base_commit with no base_ref must be refused",
  );

  console.log("  \u2713 C-PIN: clean room honours the signed base_commit, refuses unreachable/malformed/ref-less pins");
}
