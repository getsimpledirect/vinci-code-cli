import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareRepository } from "../worker/run.mjs";

const scratch = mkdtempSync(join(tmpdir(), "worker-branch-override-"));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

// A local "origin": a bare repo with main and one pre-existing task branch.
const seed = join(scratch, "seed");
mkdirSync(seed);
execFileSync("git", ["init", "-q", "-b", "main", seed]);
git(seed, "config", "user.email", "t@t"); git(seed, "config", "user.name", "t");
writeFileSync(join(seed, "a.txt"), "base\n"); git(seed, "add", "."); git(seed, "commit", "-qm", "base");
git(seed, "checkout", "-qb", "worker/msg_existing");
writeFileSync(join(seed, "b.txt"), "held work\n"); git(seed, "add", "."); git(seed, "commit", "-qm", "held work");
const heldTip = git(seed, "rev-parse", "HEAD");
git(seed, "checkout", "-q", "main");
const origin = join(scratch, "acme"); mkdirSync(origin);
execFileSync("git", ["clone", "-q", "--bare", seed, join(origin, "repo.git")]);
process.env.VINCI_WORKER_GIT_BASE = scratch;

// (1) default: no override → worker/<taskId> off origin/main, unchanged behavior
const s1 = join(scratch, "state1"); mkdirSync(s1);
const d1 = await prepareRepository(s1, "acme/repo", "msg_new");
assert.equal(d1.branch, "worker/msg_new");

// (2) override to the existing remote branch → that branch, at its remote tip
const s2 = join(scratch, "state2"); mkdirSync(s2);
const d2 = await prepareRepository(s2, "acme/repo", "msg_other", "worker/msg_existing");
assert.equal(d2.branch, "worker/msg_existing", "envelope branch must be honored, not worker/<taskId>");
assert.equal(git(d2.repoDir, "rev-parse", "HEAD"), heldTip, "checkout must land on the remote tip of the override branch");

// (3) override naming a branch origin does not have → loud error, not silent fallback
const s3 = join(scratch, "state3"); mkdirSync(s3);
await assert.rejects(
  () => prepareRepository(s3, "acme/repo", "msg_x", "worker/does-not-exist"),
  /not found on origin/,
  "a missing override branch must fail loudly",
);

console.log("✓ worker-branch-override");
