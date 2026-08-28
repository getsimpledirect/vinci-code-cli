// Issue #19 / PR #22: an envelope `branch:` is gated on origin (ls-remote) BEFORE any fetch or
// clone, materialized by an EXPLICIT refspec fetch, and resolved from the local origin/<branch>;
// the three outcomes carry three different reasons (not found / fast-forward / divergence), and
// never-pushed residue is renamed aside (never deleted) so the next attempt can proceed.
// Real temp remotes, real git; a PATH shim records git argv order for the ordering assertions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { prepareRepository, renameBranchAside } from "../worker/run.mjs";

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

// Recording git shim: every git invocation prepareRepository makes is appended (JSON argv per
// line) before being executed by the real git. Only prepareRepository sees this PATH — the test's
// own `git` helper resolves the real binary captured before the shim went on PATH.
const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
const shimDir = join(scratch, "shim");
mkdirSync(shimDir);
const recordFile = join(scratch, "git-argv.jsonl");
writeFileSync(join(shimDir, "git"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(process.env.GIT_SHIM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");
const r = spawnSync(process.env.GIT_SHIM_REAL, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
`);
chmodSync(join(shimDir, "git"), 0o755);
writeFileSync(join(shimDir, "package.json"), '{"type":"module"}\n');
process.env.GIT_SHIM_RECORD = recordFile;
process.env.GIT_SHIM_REAL = realGit;
process.env.PATH = `${shimDir}${delimiter}${process.env.PATH}`;
const recorded = () => readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const resetRecord = () => writeFileSync(recordFile, "");
// The git subcommand of a recorded argv, ignoring a leading `-C <dir>`.
const sub = (argv) => (argv[0] === "-C" ? argv[2] : argv[0]);
resetRecord();

// Origin: a bare repo with main; a writable seed clone to push held branches from.
const origin = join(scratch, "acme");
mkdirSync(origin);
const bare = join(origin, "repo.git");
execFileSync(realGit, ["init", "-q", "--bare", "-b", "main", bare]);
const seed = join(scratch, "seed");
execFileSync(realGit, ["clone", "-q", bare, seed]);
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
const commitLocal = (repoDir, file) => {
  git(repoDir, "config", "user.email", "t@t"); git(repoDir, "config", "user.name", "t");
  writeFileSync(join(repoDir, file), `${file}\n`);
  git(repoDir, "add", "."); git(repoDir, "commit", "-qm", `local ${file}`);
  return git(repoDir, "rev-parse", "HEAD");
};
const staleRefs = (repoDir) => git(repoDir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/stale/");
const STALE = "stale\\/[A-Za-z0-9_\\/-]+-\\d{8}T\\d{6}Z-[0-9a-f]{6}";
process.env.VINCI_WORKER_GIT_BASE = scratch;

// A cache whose fetch refspec covers only main (the shape that made a plain `fetch origin` insufficient).
const seedNarrowCache = (stateDir) => {
  const repoDir = join(stateDir, "repos", "repo");
  mkdirSync(join(stateDir, "repos"), { recursive: true });
  execFileSync(realGit, ["clone", "-q", "--single-branch", "--branch", "main", bare, repoDir]);
  assert.equal(git(repoDir, "config", "--get-all", "remote.origin.fetch"), "+refs/heads/main:refs/remotes/origin/main");
  git(repoDir, "config", "user.email", "t@t");
  git(repoDir, "config", "user.name", "t");
  return repoDir;
};

// (1) remote has the branch, no local ⇒ checked out at the remote tip; ls-remote precedes any transfer.
{
  const tip = pushHeld("worker/msg_fresh", "fresh.txt");
  const s = join(scratch, "s1"); mkdirSync(s);
  resetRecord();
  const d = await prepareRepository(s, "acme/repo", "msg_t1", "worker/msg_fresh");
  assert.equal(git(d.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "worker/msg_fresh");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), tip, "no local branch: checkout lands on the remote tip");
  assert.equal(git(d.repoDir, "rev-parse", "refs/remotes/origin/worker/msg_fresh"), tip, "origin/<branch> must be materialized locally");
  const subs = recorded().map(sub);
  const firstProbe = subs.indexOf("ls-remote");
  const firstTransfer = subs.findIndex((c) => c === "fetch" || c === "clone");
  assert.ok(firstProbe >= 0 && firstTransfer >= 0, `expected ls-remote and a transfer, got ${subs.join(",")}`);
  assert.ok(firstProbe < firstTransfer, `ls-remote must precede any fetch/clone: ${subs.join(",")}`);
  console.log("✓ (1) remote branch, no local ⇒ remote tip; ls-remote before clone");
}

// (2) remote has the branch, stale local ancestor ⇒ fast-forward (case b); on the cached path the
// ls-remote gate precedes the explicit branch fetch and no general `fetch origin` runs first.
{
  const first = pushHeld("worker/msg_ff", "ff1.txt");
  const s = join(scratch, "s2"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t2", "worker/msg_ff");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), first);
  git(d.repoDir, "checkout", "-q", "main"); // leave the stale local branch behind at `first`
  const second = pushHeld("worker/msg_ff", "ff2.txt"); // origin moves ahead (PR head updated)
  resetRecord();
  const d2 = await prepareRepository(s, "acme/repo", "msg_t2b", "worker/msg_ff");
  assert.equal(git(d2.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "worker/msg_ff");
  assert.equal(git(d2.repoDir, "rev-parse", "HEAD"), second, "an ancestor local branch must fast-forward to the remote tip");
  assert.equal(git(d2.repoDir, "merge-base", "--is-ancestor", first, "HEAD"), "", "fast-forward keeps the old tip in history");
  const argvs = recorded();
  const subs = argvs.map(sub);
  assert.ok(subs.indexOf("ls-remote") < subs.indexOf("fetch"), `cached path: ls-remote must precede the fetch: ${subs.join(",")}`);
  const fetches = argvs.filter((a) => sub(a) === "fetch");
  assert.deepEqual(fetches, [["-C", d2.repoDir, "fetch", "origin", "+refs/heads/worker/msg_ff:refs/remotes/origin/worker/msg_ff"]],
    "branch path: exactly one fetch, the explicit refspec — never a general `fetch origin` first");
  console.log("✓ (2) stale local ancestor ⇒ fast-forward; gate before the explicit fetch");
}

// (3) remote has the branch, local diverged and NEVER pushed (no upstream, on no origin head) ⇒
// refused with divergence naming BOTH SHAs AND the residue renamed aside (never deleted); the
// next attempt then continues at the remote tip.
{
  const remoteTip = pushHeld("worker/msg_div", "div.txt");
  const s = join(scratch, "s3"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t3", "worker/msg_div");
  const localTip = commitLocal(d.repoDir, "local-only.txt");
  assert.equal(gitFails(d.repoDir, "config", "--get", "branch.worker/msg_div.remote"), true, "precondition: no upstream configured");
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t3b", "worker/msg_div"),
    (error) => {
      assert.match(error.message, /refusing to reset \(divergence\)/);
      assert.match(error.message, new RegExp(localTip), "divergence reason must name the local SHA");
      assert.match(error.message, new RegExp(remoteTip), "divergence reason must name the remote tip SHA");
      assert.match(error.message, new RegExp(`never-pushed residue renamed aside to ${STALE}`), `reason must name the rename: ${error.message}`);
      assert.doesNotMatch(error.message, /not found on origin/);
      return true;
    },
  );
  assert.equal(gitFails(d.repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/worker/msg_div"), true, "residue name must be vacated");
  assert.match(staleRefs(d.repoDir), new RegExp(`^${STALE} ${localTip}$`), "residue must survive at its tip under stale/");
  const d2 = await prepareRepository(s, "acme/repo", "msg_t3c", "worker/msg_div");
  assert.equal(git(d2.repoDir, "rev-parse", "HEAD"), remoteTip, "the retry after the rename must continue at origin/<branch>");
  console.log("✓ (3) never-pushed residue ⇒ divergence with both SHAs + renamed aside; retry proceeds");
}

// (3b) local branch TRACKS origin/<b> and is ahead ⇒ refused, NOT renamed (predicate ii).
{
  const remoteTip = pushHeld("worker/msg_track", "track.txt");
  const s = join(scratch, "s3b"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t3d", "worker/msg_track");
  git(d.repoDir, "branch", "--set-upstream-to=origin/worker/msg_track", "worker/msg_track");
  const localTip = commitLocal(d.repoDir, "ahead.txt");
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t3e", "worker/msg_track"),
    (error) => {
      assert.match(error.message, new RegExp(`^local branch worker/msg_track at ${localTip} has commits not on origin/worker/msg_track at ${remoteTip}; refusing to reset \\(divergence\\)$`), error.message);
      return true;
    },
  );
  assert.equal(git(d.repoDir, "rev-parse", "refs/heads/worker/msg_track"), localTip, "a tracking branch must stay in place");
  assert.equal(staleRefs(d.repoDir), "", "a tracking branch must not be renamed aside");
  console.log("✓ (3b) tracking branch ahead ⇒ refused, not renamed");
}

// (3c) local branch's commits exist on ANOTHER origin head ⇒ refused, NOT renamed (predicate iii).
{
  const remoteTip = pushHeld("worker/msg_elsewhere", "elsewhere.txt");
  const s = join(scratch, "s3c"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t3f", "worker/msg_elsewhere");
  const localTip = commitLocal(d.repoDir, "moved.txt");
  git(d.repoDir, "push", "-q", "origin", "refs/heads/worker/msg_elsewhere:refs/heads/worker/msg_elsewhere-rescued"); // plain push: no upstream set
  git(d.repoDir, "update-ref", "-d", "refs/remotes/origin/worker/msg_elsewhere-rescued"); // forget it locally: the live probe must find it
  assert.equal(gitFails(d.repoDir, "config", "--get", "branch.worker/msg_elsewhere.remote"), true, "precondition: no upstream configured");
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t3g", "worker/msg_elsewhere"),
    (error) => {
      assert.match(error.message, new RegExp(`^local branch worker/msg_elsewhere at ${localTip} has commits not on origin/worker/msg_elsewhere at ${remoteTip}; refusing to reset \\(divergence\\)$`), error.message);
      return true;
    },
  );
  assert.equal(git(d.repoDir, "rev-parse", "refs/heads/worker/msg_elsewhere"), localTip);
  assert.equal(staleRefs(d.repoDir), "", "commits reachable from another origin head are not residue");
  console.log("✓ (3c) commits on another origin head ⇒ refused, not renamed");
}

// (4) remote LACKS the branch, stale local exists ⇒ not-found (case a) — never divergence — the
// stale ref renamed aside (stale/<branch>-<ts>-<nonce>), not deleted, named in the reason; and
// ZERO fetch/clone commands are issued on that path.
{
  const s = join(scratch, "s4"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t4"); // default path creates a clone
  const repoDir = d.repoDir;
  git(repoDir, "checkout", "-qb", "worker/msg_local_only", "origin/main");
  commitLocal(repoDir, "night1.txt");
  const staleTip = git(repoDir, "rev-parse", "HEAD");
  assert.equal(gitFails(bare, "rev-parse", "--verify", "refs/heads/worker/msg_local_only"), true, "precondition: absent on origin");
  resetRecord();
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t4b", "worker/msg_local_only"),
    (error) => {
      assert.match(error.message, /envelope branch worker\/msg_local_only not found on origin/);
      assert.doesNotMatch(error.message, /diverg/i, "absent-on-origin must never read as divergence");
      assert.match(error.message, new RegExp(`stale local branch worker/msg_local_only at ${staleTip} renamed aside to stale/worker/msg_local_only-\\d{8}T\\d{6}Z-[0-9a-f]{6}`), error.message);
      return true;
    },
  );
  const subs = recorded().map(sub);
  assert.ok(subs.includes("ls-remote"), `not-found path must probe origin: ${subs.join(",")}`);
  assert.equal(subs.filter((c) => c === "fetch" || c === "clone").length, 0, `not-found path must perform no fetch/clone: ${subs.join(",")}`);
  assert.equal(gitFails(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/worker/msg_local_only"), true, "stale branch name must be vacated");
  assert.match(staleRefs(repoDir), new RegExp(`^stale/worker/msg_local_only-\\d{8}T\\d{6}Z-[0-9a-f]{6} ${staleTip}$`), `stale ref must be preserved at its tip, got: ${staleRefs(repoDir)}`);
  // A second attempt after the rename: still not-found, no stale ref to cite, nothing lost.
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t4c", "worker/msg_local_only"),
    /^Error: envelope branch worker\/msg_local_only not found on origin$/,
  );
  assert.equal(git(repoDir, "for-each-ref", "--format=%(objectname)", "refs/heads/stale/"), staleTip);
  // Fresh state dir (no cache yet) + absent branch ⇒ not-found with NO clone at all.
  const s4f = join(scratch, "s4f"); mkdirSync(s4f);
  resetRecord();
  await assert.rejects(() => prepareRepository(s4f, "acme/repo", "msg_t4d", "worker/msg_local_only"), /^Error: envelope branch worker\/msg_local_only not found on origin$/);
  assert.equal(recorded().map(sub).filter((c) => c === "fetch" || c === "clone").length, 0, "no clone for a branch origin lacks");
  console.log("✓ (4) absent on origin + stale local ⇒ not-found, zero transfers, stale ref renamed aside");
}

// (4b) renameBranchAside: a pre-existing stale ref at the SAME stamp+nonce is never clobbered.
{
  const s = join(scratch, "s4b"); mkdirSync(s);
  const d = await prepareRepository(s, "acme/repo", "msg_t4e");
  git(d.repoDir, "branch", "victim", "HEAD");
  const victimTip = commitLocal(d.repoDir, "v.txt");
  git(d.repoDir, "checkout", "-q", "main");
  git(d.repoDir, "branch", "-f", "victim", victimTip);
  git(d.repoDir, "branch", "stale/victim-20260828T000000Z-abcdef", mainTip); // occupies the deterministic name
  const aside = await renameBranchAside(d.repoDir, "victim", { stamp: "20260828T000000Z", nonce: "abcdef" });
  assert.notEqual(aside, "stale/victim-20260828T000000Z-abcdef", "must not reuse an occupied stale name");
  assert.match(aside, /^stale\/victim-20260828T000000Z-[0-9a-f]{6}$/);
  assert.equal(git(d.repoDir, "rev-parse", "refs/heads/stale/victim-20260828T000000Z-abcdef"), mainTip, "the occupant must be untouched");
  assert.equal(git(d.repoDir, "rev-parse", `refs/heads/${aside}`), victimTip, "the renamed branch must keep its tip");
  assert.equal(gitFails(d.repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/victim"), true);
  console.log("✓ (4b) stale-name collision ⇒ fresh nonce, occupant untouched");
}

// (5) The object-not-fetched case. Cache = single-branch clone; the held branch is pushed AFTER
// the cache's last fetch. A plain `fetch origin` cannot bring it in; the explicit fetch does.
{
  const s = join(scratch, "s5"); mkdirSync(s);
  const repoDir = seedNarrowCache(s);
  const tip = pushHeld("worker/msg_after", "after.txt"); // created after the clone's last fetch
  git(repoDir, "fetch", "-q", "origin");
  assert.equal(gitFails(repoDir, "rev-parse", "--verify", "origin/worker/msg_after"), true,
    "premise: `git fetch origin` in a single-branch cache must not materialize origin/<branch>");
  const d = await prepareRepository(s, "acme/repo", "msg_t5", "worker/msg_after");
  assert.equal(git(d.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "worker/msg_after");
  assert.equal(git(d.repoDir, "rev-parse", "HEAD"), tip, "explicit branch fetch must pick up a branch created after the last fetch");
  console.log("✓ (5a) narrow cache: branch created after last fetch ⇒ fetched explicitly");

  // Production rows 11/11b: a Night-1 local branch (created from main, 2 commits, never pushed,
  // no upstream) vs origin's rebuilt PR head ⇒ divergence naming both SHAs + residue renamed.
  git(repoDir, "checkout", "-q", "main");
  git(repoDir, "checkout", "-qb", "worker/msg_prod", "origin/main");
  // The daemon's default path leaves the upstream at origin/MAIN (git's autoSetupMerge); that is
  // not evidence of a push and must not block the residue rename.
  assert.equal(git(repoDir, "config", "--get", "branch.worker/msg_prod.merge"), "refs/heads/main", "precondition: tracks origin/main, not origin/<b>");
  commitLocal(repoDir, "n1.txt");
  const staleTip = commitLocal(repoDir, "n2.txt");
  git(repoDir, "checkout", "-q", "main");
  const prTip = pushHeld("worker/msg_prod", "pr.txt");
  await assert.rejects(
    () => prepareRepository(s, "acme/repo", "msg_t5b", "worker/msg_prod"),
    (error) => {
      assert.match(error.message, /refusing to reset \(divergence\)/);
      assert.match(error.message, new RegExp(staleTip));
      assert.match(error.message, new RegExp(prTip));
      assert.match(error.message, /never-pushed residue renamed aside to stale\//);
      return true;
    },
  );
  assert.match(staleRefs(repoDir), new RegExp(`^${STALE} ${staleTip}$`));
  const dRetry = await prepareRepository(s, "acme/repo", "msg_t5c", "worker/msg_prod");
  assert.equal(git(dRetry.repoDir, "rev-parse", "HEAD"), prTip, "retry continues at the PR head");
  // Ancestor case in the narrow cache: local == an older remote tip ⇒ fast-forward.
  const older = pushHeld("worker/msg_prod_ff", "ff-a.txt");
  await prepareRepository(s, "acme/repo", "msg_t5d", "worker/msg_prod_ff");
  assert.equal(git(repoDir, "rev-parse", "HEAD"), older);
  git(repoDir, "checkout", "-q", "main");
  const newer = pushHeld("worker/msg_prod_ff", "ff-b.txt");
  await prepareRepository(s, "acme/repo", "msg_t5e", "worker/msg_prod_ff");
  assert.equal(git(repoDir, "rev-parse", "HEAD"), newer, "narrow cache: ancestor local must fast-forward to the new remote tip");
  console.log("✓ (5b) production sequence: divergence + residue renamed; retry proceeds; ancestor fast-forwards");
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
