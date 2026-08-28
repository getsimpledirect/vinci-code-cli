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
// PATH shims: git push succeeds; gh pr create fails "already exists"; gh pr list returns the PR.
const bin = join(scratch, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "git"), `#!/bin/bash\nif [ "$1" = "-C" ] && [ "$3" = "push" ]; then exit 0; fi\nexec /usr/bin/git "$@"\n`);
writeFileSync(join(bin, "gh"), `#!/bin/bash\nif [ "$1 $2" = "pr create" ]; then echo "a pull request for branch already exists" >&2; exit 1; fi\nif [ "$1 $2" = "pr list" ]; then echo '[{"url":"https://github.com/test/repo/pull/777"}]'; exit 0; fi\nexit 1\n`);
chmodSync(join(bin, "git"), 0o755); chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = bin + ":" + process.env.PATH;

const result = await publish({ envelope: { evidence: "pr" }, repoDir, branch: "worker/msg_x", taskId: "msg_x" });
assert.equal(result.publish, "pushed");
assert.equal(result.pr, "https://github.com/test/repo/pull/777", "an existing PR must be discovered and count as evidence");
console.log("PASS worker-publish-existing-pr");
