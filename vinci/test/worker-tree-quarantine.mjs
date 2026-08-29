// A prior run's uncommitted leavings (tracked mods + untracked files) must be preserved in an
// immutable content-addressed generation and the tree handed to the next task clean. Reusing a
// task id must never replace an earlier generation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRepository } from "../worker/run.mjs";

const scratch = mkdtempSync(join(tmpdir(), "worker-quarantine-"));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
const seed = join(scratch, "seed"); mkdirSync(seed);
execFileSync("git", ["init", "-q", "-b", "main", seed]);
git(seed, "config", "user.email", "t@t"); git(seed, "config", "user.name", "t");
writeFileSync(join(seed, "doc.md"), "original\n"); git(seed, "add", "."); git(seed, "commit", "-qm", "base");
const origin = join(scratch, "acme"); mkdirSync(origin);
execFileSync("git", ["clone", "-q", "--bare", seed, join(origin, "repo.git")]);
process.env.VINCI_WORKER_GIT_BASE = scratch;

const state = join(scratch, "state"); mkdirSync(state);
const first = await prepareRepository(state, "acme/repo", "msg_first");
// Simulate an honest-UNVERIFIED run's leavings: a tracked modification and an untracked file.
writeFileSync(join(first.repoDir, "doc.md"), "half-finished correction\n");
writeFileSync(join(first.repoDir, "notes.txt"), "only copy of this work\n");
writeFileSync(join(first.repoDir, "spaced name.txt"), "special-char survivor\n");
git(first.repoDir, "add", "doc.md"); // staged-but-uncommitted must also be preserved

const second = await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 1);
assert.equal(git(second.repoDir, "status", "--porcelain"), "", "the next task must receive a CLEAN tree");
const ledger = join(state, "debris", "msg_retry", "ledger-v1");
const firstReceipt = JSON.parse(readFileSync(join(ledger, "current.json"), "utf8"));
const firstGeneration = join(ledger, "generations", firstReceipt.generation);
assert.ok(existsSync(join(firstGeneration, "COMMITTED")), "the first generation has a durable commit marker");
assert.match(readFileSync(join(firstGeneration, "tracked.patch"), "utf8"), /half-finished correction/, "the patch must contain the actual lost work");
assert.equal(readFileSync(join(firstGeneration, "untracked", "notes.txt"), "utf8"), "only copy of this work\n", "untracked files must be copied byte-intact before clean");
assert.equal(readFileSync(join(firstGeneration, "untracked", "spaced name.txt"), "utf8"), "special-char survivor\n", "a filename with spaces must survive quarantine");
const stagedPatch = readFileSync(join(firstGeneration, "staged.patch"), "utf8") + readFileSync(join(firstGeneration, "tracked.patch"), "utf8");
assert.match(stagedPatch, /half-finished correction/, "staged-then-uncommitted content must be captured in a patch");

const digestTree = (directory) => {
  const listing = execFileSync("find", [directory, "-type", "f", "-print0"]);
  const paths = listing.toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path.slice(directory.length)).update("\0").update(readFileSync(path));
  return hash.digest("hex");
};
const firstDigest = digestTree(firstGeneration);

// The same task id retries with different debris on the same paths. Generation one must remain
// byte-identical and addressable after generation two commits.
writeFileSync(join(second.repoDir, "doc.md"), "second correction\n");
writeFileSync(join(second.repoDir, "notes.txt"), "second only copy\n");
git(second.repoDir, "add", "doc.md");
const third = await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 2);
assert.equal(git(third.repoDir, "status", "--porcelain"), "", "the retry also receives a clean tree");
const secondReceipt = JSON.parse(readFileSync(join(ledger, "current.json"), "utf8"));
assert.notEqual(secondReceipt.generation, firstReceipt.generation, "different debris gets a distinct immutable generation");
assert.equal(digestTree(firstGeneration), firstDigest, "generation one remains byte-identical after the retry");
assert.equal(readFileSync(join(firstGeneration, "untracked", "notes.txt"), "utf8"), "only copy of this work\n");
const secondGeneration = join(ledger, "generations", secondReceipt.generation);
assert.match(readFileSync(join(secondGeneration, "tracked.patch"), "utf8"), /second correction/);
assert.equal(readFileSync(join(secondGeneration, "untracked", "notes.txt"), "utf8"), "second only copy\n");
const index = JSON.parse(readFileSync(join(ledger, "index.json"), "utf8"));
assert.equal(index.generations.length, 2, "the atomic index retains both generations");
assert.deepEqual(new Set(index.generations.map((entry) => entry.generation)), new Set([firstReceipt.generation, secondReceipt.generation]));

// Simulate response loss after the immutable generation/index were published but before reset.
// An index lock makes the destructive reset fail; the same source remains in place and a retry
// must converge on the exact receipt instead of publishing another generation.
writeFileSync(join(third.repoDir, "doc.md"), "response-loss correction\n");
writeFileSync(join(third.repoDir, "response.txt"), "response-loss only copy\n");
git(third.repoDir, "add", "doc.md");
const gitIndexLock = join(third.repoDir, ".git", "index.lock");
writeFileSync(gitIndexLock, "held\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 3),
  /reset failed after durable capture/,
);
const lostResponseReceipt = JSON.parse(readFileSync(join(ledger, "current.json"), "utf8"));
assert.equal(readFileSync(join(third.repoDir, "response.txt"), "utf8"), "response-loss only copy\n", "failed reset leaves source intact");
unlinkSync(gitIndexLock);
const replay = await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 4);
assert.equal(replay.debrisReceipt.generation, lostResponseReceipt.generation, "response-loss replay returns the same generation");
assert.equal(replay.debrisReceipt.receipt_sha256, lostResponseReceipt.receipt_sha256, "response-loss replay returns the same receipt bytes");
assert.equal(git(replay.repoDir, "status", "--porcelain"), "", "the convergent replay completes the clean");
assert.equal(JSON.parse(readFileSync(join(ledger, "index.json"), "utf8")).generations.length, 3, "replay does not append a duplicate index row");

// A competing/stale capture lock is a categorical refusal. No source byte is cleaned, and once
// the owner releases the lock the same capture can proceed normally.
writeFileSync(join(replay.repoDir, "locked.txt"), "must survive lock contention\n");
const captureLock = join(state, "debris", ".capture.lock");
writeFileSync(captureLock, "competing writer\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 5),
  /EEXIST/,
);
assert.equal(readFileSync(join(replay.repoDir, "locked.txt"), "utf8"), "must survive lock contention\n");
unlinkSync(captureLock);
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 5);
assert.equal(git(replay.repoDir, "status", "--porcelain"), "", "capture succeeds after explicit lock release");

// Replacing the task subtree cannot bootstrap a fresh evidence lineage: its separately anchored
// dev/inode identity is authoritative. The failed attempt must not clean the new source.
writeFileSync(join(replay.repoDir, "replacement.txt"), "must survive task-root replacement\n");
const taskOwnerRoot = join(state, "debris", "msg_retry");
const savedTaskOwnerRoot = `${taskOwnerRoot}.saved`;
renameSync(taskOwnerRoot, savedTaskOwnerRoot);
mkdirSync(taskOwnerRoot, { mode: 0o700 });
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 6),
  /path replacement or rollback detected/,
);
assert.equal(readFileSync(join(replay.repoDir, "replacement.txt"), "utf8"), "must survive task-root replacement\n");
rmSync(taskOwnerRoot, { recursive: true });
renameSync(savedTaskOwnerRoot, taskOwnerRoot);
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 6);

// A crash-created partial staging directory is never ignored or silently replaced. It requires
// explicit reconciliation, and the working source remains intact while the ledger is partial.
writeFileSync(join(replay.repoDir, "partial.txt"), "must survive partial publication\n");
const partial = join(taskOwnerRoot, "ledger-v1", "generations", ".capture-crash.tmp");
mkdirSync(partial, { mode: 0o700 });
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 7),
  /partial prior publication requires reconciliation/,
);
assert.equal(readFileSync(join(replay.repoDir, "partial.txt"), "utf8"), "must survive partial publication\n");
rmSync(partial, { recursive: true });
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 7);

// A divergent existing generation after response loss is a refusal, not a replacement. Restore
// the exact commit marker to model operator reconciliation, then the retry converges and cleans.
writeFileSync(join(replay.repoDir, "divergent.txt"), "must survive divergent generation\n");
writeFileSync(gitIndexLock, "held\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 8),
  /reset failed after durable capture/,
);
const divergentReceipt = JSON.parse(readFileSync(join(ledger, "current.json"), "utf8"));
const divergentGeneration = join(ledger, "generations", divergentReceipt.generation);
const receiptBytes = readFileSync(join(divergentGeneration, "receipt.json"));
writeFileSync(join(divergentGeneration, "COMMITTED"), "divergent\n");
unlinkSync(gitIndexLock);
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 9),
  /commit marker mismatch/,
);
assert.equal(readFileSync(join(replay.repoDir, "divergent.txt"), "utf8"), "must survive divergent generation\n");
writeFileSync(join(divergentGeneration, "COMMITTED"), `${createHash("sha256").update(receiptBytes).digest("hex")}\n`);
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 9);

// Two compliant writers cannot both publish or clean. The global exclusive capture lock gives
// exactly one success; the loser refuses, and the winner leaves one clean, durable generation.
writeFileSync(join(replay.repoDir, "concurrent.txt"), "one writer owns this capture\n");
const concurrent = await Promise.allSettled([
  prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 10),
  prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 11),
]);
assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "exactly one concurrent writer succeeds");
assert.equal(concurrent.filter((result) => result.status === "rejected" && /EEXIST/.test(result.reason?.message)).length, 1, "the competing writer refuses on the exclusive lock");
assert.equal(git(replay.repoDir, "status", "--porcelain"), "", "the sole successful writer leaves the checkout clean");
console.log("PASS worker-tree-quarantine");
