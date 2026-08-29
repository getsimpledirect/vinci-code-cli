// An existing PR for the branch IS the evidence: when gh pr create fails because one exists,
// publish() must discover it via gh pr list instead of classifying the task UNVERIFIED.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish } from "../worker/run.mjs";

const scratch = mkdtempSync(join(tmpdir(), "worker-existing-pr-"));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
const repoDir = join(scratch, "repo"); mkdirSync(repoDir);
execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
git(repoDir, "config", "user.email", "t@t"); git(repoDir, "config", "user.name", "t");
writeFileSync(join(repoDir, "a.txt"), "x\n"); git(repoDir, "add", "."); git(repoDir, "commit", "-qm", "c");
// A real bare origin (the publisher samples and reads back origin for real). gh: `pr create` fails
// "already exists"; `pr list`/`pr view` answer with the PR at whatever origin holds for the branch.
const origin = join(scratch, "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
git(repoDir, "remote", "add", "origin", `file://${origin}`);
git(repoDir, "push", "-q", "origin", "main");
git(repoDir, "checkout", "-qb", "worker/msg_x");
writeFileSync(join(repoDir, "b.txt"), "y\n"); git(repoDir, "add", "."); git(repoDir, "commit", "-qm", "work");
const bin = join(scratch, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/bin/bash
if [ "$1 $2" = "pr create" ]; then echo "a pull request for branch already exists" >&2; exit 1; fi
head=$(git --git-dir="${origin}" rev-parse --verify --quiet refs/heads/worker/msg_x)
pr="$(printf '{"number":777,"url":"https://github.com/test/repo/pull/777","state":"OPEN","headRefName":"worker/msg_x","baseRefName":"main","headRepositoryOwner":{"login":"test"},"body":"","headRefOid":"%s"}' "$head")"
if [ "$1 $2" = "pr list" ]; then if [ -n "$head" ]; then echo "[$pr]"; else echo "[]"; fi; exit 0; fi
if [ "$1 $2" = "pr view" ]; then echo "$pr"; exit 0; fi
exit 1
`);
chmodSync(join(bin, "gh"), 0o755);
const OLD_PATH = process.env.PATH;
process.env.PATH = bin + ":" + OLD_PATH;

const result = await publish({ envelope: { evidence: "pr", repo: "test/repo" }, repoDir, branch: "worker/msg_x", taskId: "msg_x" });
assert.equal(result.publish, "pushed");
assert.equal(result.pr, "https://github.com/test/repo/pull/777", "an existing PR must be discovered and count as evidence");
assert.equal(result.pr_adopted, true);
process.env.PATH = OLD_PATH;
console.log("PASS worker-publish-existing-pr");
