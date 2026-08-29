// A prior run's uncommitted leavings (tracked mods + untracked files) must be preserved in an
// immutable content-addressed generation and the tree handed to the next task clean. Reusing a
// task id must never replace an earlier generation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../worker/contracts/canonical.mjs";
import { describeDebrisRootAnchor, prepareRepository } from "../worker/run.mjs";

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
const debrisRoot = join(state, "debris");
mkdirSync(join(debrisRoot, ".task-identities-v1"), { recursive: true, mode: 0o700 });
const externalAnchor = join(scratch, "deployment-owned-debris-root.json");
writeFileSync(externalAnchor, `${canonicalize(describeDebrisRootAnchor(state, "1".repeat(64)))}\n`, { mode: 0o400 });
process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR = externalAnchor;
process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256 = createHash("sha256").update(readFileSync(externalAnchor)).digest("hex");
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
const indexAfterFirstBytes = readFileSync(join(ledger, "index.json"));

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

// Rolling the index back to valid older bytes cannot make an already committed generation
// disappear from authority. Reconciliation derives the complete index from generation bytes.
const currentIndexBytes = readFileSync(join(ledger, "index.json"));
writeFileSync(join(ledger, "index.json"), indexAfterFirstBytes);
writeFileSync(join(third.repoDir, "rollback.txt"), "must survive index rollback\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 20),
  /rollback omitted an indexed generation|committed-generation bijection mismatch/,
);
assert.equal(readFileSync(join(third.repoDir, "rollback.txt"), "utf8"), "must survive index rollback\n");
writeFileSync(join(ledger, "index.json"), currentIndexBytes);
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 20);

// The index is a closed, unique, canonically ordered authority record. Extra fields and duplicate
// generation rows are rejected even when their surrounding JSON is canonical.
const closedIndexBytes = readFileSync(join(ledger, "index.json"));
const extraIndex = JSON.parse(closedIndexBytes);
extraIndex.extra = true;
writeFileSync(join(ledger, "index.json"), `${canonicalize(extraIndex)}\n`);
writeFileSync(join(third.repoDir, "closed-index.txt"), "must survive non-closed index\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 21),
  /unexpected fields/,
);
writeFileSync(join(ledger, "index.json"), closedIndexBytes);
const duplicateIndex = JSON.parse(closedIndexBytes);
duplicateIndex.generations.push({ ...duplicateIndex.generations[0] });
duplicateIndex.generations.sort((a, b) => (a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0));
writeFileSync(join(ledger, "index.json"), `${canonicalize(duplicateIndex)}\n`);
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 21),
  /duplicate generation|canonical order/,
);
assert.equal(readFileSync(join(third.repoDir, "closed-index.txt"), "utf8"), "must survive non-closed index\n");
writeFileSync(join(ledger, "index.json"), closedIndexBytes);
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 21);
const generationCountBeforeResponseLoss = JSON.parse(readFileSync(join(ledger, "index.json"), "utf8")).generations.length;

// Simulate response loss after the immutable generation/index were published but before reset.
// An index lock makes the destructive reset fail; the same source remains in place and a retry
// must converge on the exact receipt instead of publishing another generation.
writeFileSync(join(third.repoDir, "doc.md"), "response-loss correction\n");
writeFileSync(join(third.repoDir, "response.txt"), "response-loss only copy\n");
git(third.repoDir, "add", "doc.md");
const indexBeforeResponseLoss = readFileSync(join(ledger, "index.json"));
const gitIndexLock = join(third.repoDir, ".git", "index.lock");
writeFileSync(gitIndexLock, "held\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 3),
  /reset failed after durable capture/,
);
const lostResponseReceipt = JSON.parse(readFileSync(join(ledger, "current.json"), "utf8"));
assert.equal(readFileSync(join(third.repoDir, "response.txt"), "utf8"), "response-loss only copy\n", "failed reset leaves source intact");
const responseLossGeneration = join(ledger, "generations", lostResponseReceipt.generation);
unlinkSync(join(responseLossGeneration, "INDEXED"));
writeFileSync(join(ledger, "index.json"), indexBeforeResponseLoss);
unlinkSync(gitIndexLock);
const replay = await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 3);
assert.equal(replay.debrisReceipt.generation, lostResponseReceipt.generation, "response-loss replay returns the same generation");
assert.equal(lostResponseReceipt.requested_attempt, 3, "the first response-loss receipt binds its requested attempt");
assert.equal(replay.debrisReceipt.requested_attempt, 3, "only the exact unfinished attempt can converge on its prior receipt");
assert.equal(replay.debrisReceipt.captured_by_attempt, 3, "the replay preserves the original capture identity separately");
assert.equal(replay.debrisReceipt.disposition, "CAPTURED");
assert.equal(replay.debrisReceipt.generation_receipt_sha256, lostResponseReceipt.generation_receipt_sha256, "response-loss replay converges on the same immutable generation receipt");
assert.equal(replay.debrisReceipt.attempt_receipt_sha256, createHash("sha256").update(readFileSync(join(ledger, "attempts", "3.json"))).digest("hex"), "the exact retry returns the same immutable attempt receipt");
assert.ok(existsSync(join(responseLossGeneration, "INDEXED")), "crash recovery re-establishes the durable indexed marker after restoring the complete index");
assert.equal(git(replay.repoDir, "status", "--porcelain"), "", "the convergent replay completes the clean");
assert.equal(JSON.parse(readFileSync(join(ledger, "index.json"), "utf8")).generations.length, generationCountBeforeResponseLoss + 1, "replay does not append a duplicate index row");

// Recreating the exact same source after a successful clean is a distinct capture event, not
// response-loss recovery. Its later attempt is bound into a new immutable generation.
writeFileSync(join(replay.repoDir, "doc.md"), "response-loss correction\n");
writeFileSync(join(replay.repoDir, "response.txt"), "response-loss only copy\n");
git(replay.repoDir, "add", "doc.md");
const independent = await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 99);
assert.notEqual(independent.debrisReceipt.generation, lostResponseReceipt.generation, "a later independent capture gets a distinct generation");
assert.equal(independent.debrisReceipt.requested_attempt, 99);
assert.equal(independent.debrisReceipt.captured_by_attempt, 99);
assert.ok(existsSync(join(ledger, "attempts", "99.json")), "the independent attempt has its own receipt");
assert.equal(git(independent.repoDir, "status", "--porcelain"), "");
writeFileSync(join(replay.repoDir, "same-attempt-conflict.txt"), "one attempt cannot name another source\n");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 99),
  /attempt already bound to different source/,
);
assert.equal(readFileSync(join(replay.repoDir, "same-attempt-conflict.txt"), "utf8"), "one attempt cannot name another source\n");

// The current pointer and per-attempt receipts are reconstructible only from the complete,
// verified generation ledger. Deleting the latest attempt and rolling current back cannot make
// the old pointer authoritative or lose the newer capture.
unlinkSync(join(ledger, "attempts", "99.json"));
writeFileSync(join(ledger, "current.json"), readFileSync(join(ledger, "attempts", "3.json")));
writeFileSync(join(replay.repoDir, "current-recovery.txt"), "derive from the complete ledger\n");
const currentRecovery = await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 100);
assert.ok(existsSync(join(ledger, "attempts", "99.json")), "the deleted attempt receipt is reconstructed from its indexed generation");
assert.equal(currentRecovery.debrisReceipt.requested_attempt, 100);
assert.equal(JSON.parse(readFileSync(join(ledger, "current.json"), "utf8")).requested_attempt, 100, "current advances from verified generation and attempt bytes");
assert.equal(git(currentRecovery.repoDir, "status", "--porcelain"), "");

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

// The deployment anchor is authority only when it is outside replaceable worker state, explicitly
// admitted, and not group/world writable. Each refusal leaves the sole dirty source untouched.
const anchorBytes = readFileSync(externalAnchor);
writeFileSync(join(replay.repoDir, "anchor-policy.txt"), "must survive rejected anchors\n");
const inStateAnchor = join(state, "in-state-debris-root.json");
writeFileSync(inStateAnchor, anchorBytes, { mode: 0o400 });
process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR = inStateAnchor;
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 29),
  /outside the replaceable worker state directory/,
);
unlinkSync(inStateAnchor);
process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR = externalAnchor;
chmodSync(externalAnchor, 0o600);
const unadmitted = JSON.parse(anchorBytes);
unadmitted.authority_admitted = false;
writeFileSync(externalAnchor, `${canonicalize(unadmitted)}\n`);
chmodSync(externalAnchor, 0o400);
process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256 = createHash("sha256").update(readFileSync(externalAnchor)).digest("hex");
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 29),
  /authority is not admitted/,
);
chmodSync(externalAnchor, 0o600);
writeFileSync(externalAnchor, anchorBytes);
process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256 = createHash("sha256").update(anchorBytes).digest("hex");
chmodSync(externalAnchor, 0o622);
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 29),
  /unsafe external trust anchor/,
);
chmodSync(externalAnchor, 0o400);
assert.equal(readFileSync(join(replay.repoDir, "anchor-policy.txt"), "utf8"), "must survive rejected anchors\n");

// Ordinary worker code cannot bootstrap after the whole evidence root is replaced. Even deleting
// the external trust file makes the operation refuse; only deployment can provision that file.
writeFileSync(join(replay.repoDir, "root-loss.txt"), "must survive whole-root loss\n");
const savedDebrisRoot = `${debrisRoot}.saved`;
renameSync(debrisRoot, savedDebrisRoot);
mkdirSync(join(debrisRoot, ".task-identities-v1"), { recursive: true, mode: 0o700 });
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 30),
  /path replacement or rollback detected/,
);
chmodSync(externalAnchor, 0o600);
writeFileSync(externalAnchor, `${canonicalize(describeDebrisRootAnchor(state, "1".repeat(64)))}\n`);
chmodSync(externalAnchor, 0o400);
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 30),
  /provisioned anchor digest mismatch/,
);
chmodSync(externalAnchor, 0o600);
writeFileSync(externalAnchor, anchorBytes);
chmodSync(externalAnchor, 0o400);
unlinkSync(externalAnchor);
await assert.rejects(
  () => prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 30),
  /ENOENT|external trust anchor/,
);
assert.equal(readFileSync(join(replay.repoDir, "root-loss.txt"), "utf8"), "must survive whole-root loss\n");
rmSync(debrisRoot, { recursive: true });
renameSync(savedDebrisRoot, debrisRoot);
writeFileSync(externalAnchor, anchorBytes, { mode: 0o400 });
await prepareRepository(state, "acme/repo", "msg_retry", undefined, undefined, undefined, 30);
console.log("PASS worker-tree-quarantine");
