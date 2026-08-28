// A prior run's uncommitted leavings (tracked mods + untracked files) must be preserved to
// <state>/debris/<task> and the tree handed to the next task clean — never discarded silently.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const second = await prepareRepository(state, "acme/repo", "msg_second");
assert.equal(git(second.repoDir, "status", "--porcelain"), "", "the next task must receive a CLEAN tree");
const debris = join(state, "debris", "msg_second");
assert.ok(existsSync(join(debris, "tracked.patch")), "tracked modifications must be preserved as a patch");
assert.match(readFileSync(join(debris, "tracked.patch"), "utf8"), /half-finished correction/, "the patch must contain the actual lost work");
assert.equal(readFileSync(join(debris, "untracked", "notes.txt"), "utf8"), "only copy of this work\n", "untracked files must be moved byte-intact, not deleted");
assert.equal(readFileSync(join(debris, "untracked", "spaced name.txt"), "utf8"), "special-char survivor\n", "a filename with spaces must survive quarantine (porcelain quoting)");
const stagedPatch = readFileSync(join(debris, "staged.patch"), "utf8") + readFileSync(join(debris, "tracked.patch"), "utf8");
assert.match(stagedPatch, /half-finished correction/, "staged-then-uncommitted content must be captured in a patch");
console.log("PASS worker-tree-quarantine");
