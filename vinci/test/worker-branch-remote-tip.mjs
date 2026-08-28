// Issue #19: an envelope `branch:` that exists on origin must be materialized in the daemon's
// clone by an EXPLICIT refspec fetch before its tip is resolved, and the three outcomes must carry
// three different reasons (not found / fast-forward / divergence). Real temp remotes, real git.
//
// Reproduction of the production defect (soak cohort 2, 2026-08-28, both boxes): a repo cache
// whose remote.origin.fetch is narrowed to main (a --single-branch or --depth clone) never gets
// origin/<branch> from a plain `git fetch origin`; ls-remote still answers with the remote SHA,
// merge-base then fails with "Not a valid commit name", and the old code called that divergence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareRepository } from "../worker/run.mjs";

const scratch = mkdtempSync(join(tmpdir(), "worker-branch-remote-tip-"));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
const gitFails = (cwd, ...args) => {
  try {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
};

// Origin: a bare repo with main; a writable seed clone to push held branches from.
const origin = join(scratch, "acme");
mkdirSync(origin);
const bare = join(origin, "repo.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
const seed = join(scratch, "seed");
execFileSync("git", ["clone", "-q", bare, seed]);
git(seed, "config", "user.email", "t@t");
git(seed, "config", "user.name", "t");
writeFileSync(join(seed, "a.txt"), "base\n");
git(seed, "add", ".");
git(seed, "commit", "-qm", "base");
git(seed, "push", "-q", "origin", "main");
const mainTip = git(seed, "rev-parse", "HEAD");
// Builds on the branch if the seed already has it (a PR head moving ahead), else branches off main.
const pushHeld = (name, file) => {
  if (gitFails(seed, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) git(seed, "checkout", "-qb", name, "main");
  else git(seed, "checkout", "-q", name);
  writeFileSync(join(seed, file), `${file}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", `held ${file}`);
  git(seed, "push", "-qf", "origin", name);
  const tip = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-q", "main");
  return tip;
};
process.env.VINCI_WORKER_GIT_BASE = scratch;

// The production shape: the daemon's cache is a clone whose fetch refspec covers only main.
const seedNarrowCache = (stateDir) => {
  const repoDir = join(stateDir, "repos", "repo");
  mkdirSync(join(stateDir, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "main", bare, repoDir]);
  assert.equal(git(repoDir, "config", "--get-all", "remote.origin.fetch"), "+refs/heads/main:refs/remotes/origin/main");
  git(repoDir, "config", "user.email", "t@t");
  git(repoDir, "config", "user.name", "t");
  return repoDir;
};

// (1) remote has the branch, no local ⇒ checked out at the remote tip.
{
  const tip = pushHeld("worker/msg_fresh", "fresh.txt");
  const s = join(scratch, "s1"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t1", "worker/msg_fresh");
  assert.equal(git(d.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "worker/msg_fresh");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), tip, "no local branch: checkout lands on the remote tip");
  assert.equal(git(d.repoDir, "rev-parse", "refs/remotes/origin/worker/msg_fresh"), tip, "origin/<branch> must be materialized locally");
  console.log("✓ (1) remote branch, no local ⇒ remote tip");
}

// (2) remote has the branch, stale local ancestor ⇒ fast-forward (case b).
{
  const first = pushHeld("worker/msg_ff", "ff1.txt");
  const s = join(scratch, "s2"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t2", "worker/msg_ff");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), first);
  git(d.repoDir, "checkout", "-q", "main"); // leave the stale local branch behind at `first`
  const second = pushHeld("worker/msg_ff", "ff2.txt"); // origin moves ahead (PR head updated)
  const d2 = await prepareRepository(s, "acme/repo", "msg_t2b", "worker/msg_ff");
  assert.equal(git(d2.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "worker/msg_ff");
  assert.equal(git(d2.repoDir, "rev-parse", "HEAD"), second, "an ancestor local branch must fast-forward to the remote tip");
  assert.equal(git(d2.repoDir, "merge-base", "--is-ancestor", first, "HEAD"), "", "fast-forward keeps the old tip in history");
  console.log("✓ (2) stale local ancestor ⇒ fast-forward");
}

// (3) remote has the branch, local diverged ⇒ divergence naming BOTH SHAs (case c).
{
  const remoteTip = pushHeld("worker/msg_div", "div.txt");
  const s = join(scratch, "s3"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t3", "worker/msg_div");
  git(d.repoDir, "config", "user.email", "t@t"); git(d.repoDir, "config", "user.name", "t");
  writeFileSync(join(d.repoDir, "local-only.txt"), "unpushed\n");
  git(d.repoDir, "add", "."); git(d.repoDir, "commit", "-qm", "local-only work");
  const localTip = git(d.repoDir, "rev-parse", "HEAD");
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t3b", "worker/msg_div"),
    (error) => {
      assert.match(error.message, /refusing to reset \(divergence\)/);
      assert.match(error.message, new RegExp(localTip), "divergence reason must name the local SHA");
      assert.match(error.message, new RegExp(remoteTip), "divergence reason must name the remote tip SHA");
      assert.doesNotMatch(error.message, /not found on origin/);
      return true;
    },
  );
  assert.equal(git(d.repoDir, "rev-parse", "refs/heads/worker/msg_div"), localTip, "local-only commits must survive the refusal");
  console.log("✓ (3) local diverged ⇒ divergence with both SHAs");
}

// (4) remote LACKS the branch, stale local exists ⇒ not-found (case a) — never divergence — and
// the stale ref is renamed aside (stale/<branch>-<ts>), not deleted; the reason names it.
{
  const s = join(scratch, "s4"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t4"); // default path creates a clone
  const repoDir = d.repoDir;
  git(repoDir, "config", "user.email", "t@t"); git(repoDir, "config", "user.name", "t");
  // The Night-1 shape: a local worker/<id> created from origin/main with commits, never on origin.
  git(repoDir, "checkout", "-qb", "worker/msg_local_only", "origin/main");
  writeFileSync(join(repoDir, "night1.txt"), "attempt 1\n");
  git(repoDir, "add", "."); git(repoDir, "commit", "-qm", "night-1 attempt");
  const staleTip = git(repoDir, "rev-parse", "HEAD");
  assert.equal(gitFails(bare, "rev-parse", "--verify", "refs/heads/worker/msg_local_only"), true, "precondition: absent on origin");
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t4b", "worker/msg_local_only"),
    (error) => {
      assert.match(error.message, /envelope branch worker\/msg_local_only not found on origin/);
      assert.doesNotMatch(error.message, /diverg/i, "absent-on-origin must never read as divergence");
      assert.match(error.message, /stale local branch worker\/msg_local_only at [0-9a-f]{40} renamed aside to stale\/worker\/msg_local_only-\d{8}T\d{6}Z/);
      assert.match(error.message, new RegExp(staleTip), "the reason must name the stale ref's SHA");
      return true;
    },
  );
  assert.equal(gitFails(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/worker/msg_local_only"), true, "stale branch name must be vacated");
  const aside = git(repoDir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/stale/");
  assert.match(aside, new RegExp(`^stale/worker/msg_local_only-\\d{8}T\\d{6}Z ${staleTip}$`), `stale ref must be preserved at its tip, got: ${aside}`);
  // A second attempt after the rename: still not-found, no stale ref to cite, nothing lost.
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t4c", "worker/msg_local_only"),
    /^Error: envelope branch worker\/msg_local_only not found on origin$/,
  );
  assert.equal(git(repoDir, "for-each-ref", "--format=%(objectname)", "refs/heads/stale/"), staleTip);
  console.log("✓ (4) absent on origin + stale local ⇒ not-found, stale ref renamed aside");
}

// (5) The object-not-fetched case (the production defect). Cache = single-branch clone; the held
// branch is pushed AFTER the cache's last fetch. A plain `fetch origin` cannot bring it in
// (refspec covers only main); only the explicit per-branch fetch does.
{
  const s = join(scratch, "s5"); mkdirSync(s);
  const repoDir = seedNarrowCache(s);
  const tip = pushHeld("worker/msg_after", "after.txt"); // created after the clone's last fetch
  // Prove the premise with git itself: a general fetch does NOT materialize the ref in this cache.
  git(repoDir, "fetch", "-q", "origin");
  assert.equal(gitFails(repoDir, "rev-parse", "--verify", "origin/worker/msg_after"), true,
    "premise: `git fetch origin` in a single-branch cache must not materialize origin/<branch>");
  const d = await prepareRepository(s, "acme/repo", "msg_t5", "worker/msg_after");
  assert.equal(git(d.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "worker/msg_after");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), tip, "explicit branch fetch must pick up a branch created after the last fetch");
  assert.equal(git(d.repoDir, "rev-parse", "refs/remotes/origin/worker/msg_after"), tip);
  console.log("✓ (5a) narrow cache: branch created after last fetch ⇒ fetched explicitly");

  // Same cache, the exact production sequence: a stale local branch (Night-1 attempt, created from
  // main, 2 commits) + the PR head on origin diverged from it ⇒ must say divergence WITH both SHAs,
  // not "Not a valid commit name" dressed as divergence; and an ancestor local ⇒ fast-forward.
  git(repoDir, "checkout", "-q", "main");
  git(repoDir, "checkout", "-qb", "worker/msg_prod", "origin/main");
  writeFileSync(join(repoDir, "n1.txt"), "1\n"); git(repoDir, "add", "."); git(repoDir, "commit", "-qm", "night-1 a");
  writeFileSync(join(repoDir, "n2.txt"), "2\n"); git(repoDir, "add", "."); git(repoDir, "commit", "-qm", "night-1 b");
  const staleTip = git(repoDir, "rev-parse", "HEAD");
  git(repoDir, "checkout", "-q", "main");
  const prTip = pushHeld("worker/msg_prod", "pr.txt"); // PR head on origin, unrelated to the stale local
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t5b", "worker/msg_prod"),
    (error) => {
      assert.match(error.message, /refusing to reset \(divergence\)/);
      assert.match(error.message, new RegExp(staleTip));
      assert.match(error.message, new RegExp(prTip));
      return true;
    },
  );
  assert.equal(git(repoDir, "rev-parse", "refs/remotes/origin/worker/msg_prod"), prTip, "the remote tip must be resolvable locally after prepare");
  // Ancestor case in the narrow cache: local == an older remote tip ⇒ fast-forward.
  const older = pushHeld("worker/msg_prod_ff", "ff-a.txt");
  await prepareRepository(s, "acme/repo", "msg_t5c", "worker/msg_prod_ff");
  assert.equal(git(repoDir, "rev-parse", "HEAD"), older);
  git(repoDir, "checkout", "-q", "main");
  const newer = pushHeld("worker/msg_prod_ff", "ff-b.txt");
  await prepareRepository(s, "acme/repo", "msg_t5d", "worker/msg_prod_ff");
  assert.equal(git(repoDir, "rev-parse", "HEAD"), newer, "narrow cache: ancestor local must fast-forward to the new remote tip");
  console.log("✓ (5b) narrow cache: divergence names both SHAs; ancestor fast-forwards");
}

// (6) Plain clone, branch created after the last fetch ⇒ also picked up (no regression).
{
  const s = join(scratch, "s6"); mkdirSync(s);
  await prepareRepository(s, "acme/repo", "msg_t6"); // clone + default branch
  const tip = pushHeld("worker/msg_late", "late.txt");
  const d = await prepareRepository(s, "acme/repo", "msg_t6b", "worker/msg_late");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), tip);
  assert.notEqual(tip, mainTip);
  console.log("✓ (6) plain clone: late branch ⇒ remote tip");
}

console.log("✓ worker-branch-remote-tip");
