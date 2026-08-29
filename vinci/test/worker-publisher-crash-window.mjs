// Wave 1 publisher: idempotent PR adoption, remote-sha discipline (never force), fence hook,
// and the crash windows between push and PR record. Real git against a bare file:// origin;
// gh is a recording shim driven by env (FAKE_GH_LIST_JSON, FAKE_GH_CREATE_EXIT).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publish } from "../worker/publisher.mjs";
import { publish as runPublish } from "../worker/run.mjs";

const scratch = mkdtempSync(join(tmpdir(), "worker-publisher-"));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
const ghCalls = join(scratch, "gh-calls.txt");
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  `#!/bin/bash
args="$*"; printf '%s\\n' "\${args//$'\\n'/ }" >> "${ghCalls}"
if [ "$1 $2" = "pr list" ]; then echo "\${FAKE_GH_LIST_JSON:-[]}"; exit 0; fi
if [ "$1 $2" = "pr create" ]; then
  if [ -n "$FAKE_GH_CREATE_EXIT" ]; then echo "gh: create failed (forced)" >&2; exit "$FAKE_GH_CREATE_EXIT"; fi
  echo "https://github.com/test/repo/pull/123"; exit 0
fi
exit 1
`,
);
chmodSync(join(bin, "gh"), 0o755);
const OLD_PATH = process.env.PATH;
process.env.PATH = `${bin}:${OLD_PATH}`;

let counter = 0;
function makeRepo() {
  const id = String(++counter);
  const origin = join(scratch, `origin-${id}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repoDir = join(scratch, `repo-${id}`);
  execFileSync("git", ["clone", "-q", `file://${origin}`, repoDir], { stdio: "pipe" });
  git(repoDir, "config", "user.email", "t@t");
  git(repoDir, "config", "user.name", "t");
  writeFileSync(join(repoDir, "a.txt"), "base\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-qm", "base");
  git(repoDir, "push", "-q", "origin", "main");
  const branch = `worker/msg_${id}`;
  git(repoDir, "checkout", "-qb", branch);
  writeFileSync(join(repoDir, "work.txt"), "work\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-qm", "work");
  return { repoDir, origin, branch, head: git(repoDir, "rev-parse", branch) };
}
function calls() {
  return existsSync(ghCalls) ? readFileSync(ghCalls, "utf8").trim().split("\n").filter(Boolean) : [];
}
function resetCalls() {
  rmSync(ghCalls, { force: true });
}
function remoteSha(repoDir, branch) {
  const out = git(repoDir, "ls-remote", "origin", `refs/heads/${branch}`);
  return out ? out.split(/\s+/)[0] : null;
}
const isCreate = (line) => line.startsWith("pr create");
const isList = (line) => line.startsWith("pr list");

try {
  // (a) push ok, gh pr create fails -> record holds pushed_sha, pr null; a second publish adopts
  //     the PR that appeared out-of-band (or creates exactly one) without re-pushing.
  {
    const r = makeRepo();
    resetCalls();
    process.env.FAKE_GH_CREATE_EXIT = "1";
    const first = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_a", attempt: 1, baseRef: "main", promotion: "pr" });
    delete process.env.FAKE_GH_CREATE_EXIT;
    assert.equal(first.publish, "pushed");
    assert.equal(first.pushed_sha, r.head, "(a) the exact pushed sha is recorded even when the PR step fails");
    assert.equal(first.remote_sha_before, null, "(a) branch did not exist on origin before the push");
    assert.equal(first.pr, null);
    assert.equal(remoteSha(r.repoDir, r.branch), r.head, "(a) the push landed on origin");
    assert.equal(calls().filter(isCreate).length, 1);

    // second call: the PR now exists out-of-band -> adopted, no create, no re-push
    resetCalls();
    process.env.FAKE_GH_LIST_JSON = JSON.stringify([{ number: 7, url: "https://github.com/test/repo/pull/7", headRefOid: r.head }]);
    const second = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_a", attempt: 2, baseRef: "main", promotion: "pr" });
    delete process.env.FAKE_GH_LIST_JSON;
    assert.equal(second.publish, "pushed");
    assert.equal(second.push_skipped, "remote_at_head", "(a) retry does not re-push a sha origin already holds");
    assert.equal(second.pushed_sha, r.head);
    assert.equal(second.remote_sha_before, r.head);
    assert.equal(second.pr, "https://github.com/test/repo/pull/7");
    assert.equal(second.pr_adopted, true);
    assert.equal(calls().filter(isCreate).length, 0, "(a) no create when one already exists");

    // or: still no PR out-of-band -> exactly one create
    resetCalls();
    const third = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_a", attempt: 3, baseRef: "main", promotion: "pr" });
    assert.equal(third.pr, "https://github.com/test/repo/pull/123");
    assert.equal(third.pr_adopted, false);
    assert.equal(calls().filter(isCreate).length, 1, "(a) exactly one create when none exists");
    const createLine = calls().find(isCreate);
    assert.match(createLine, /--base main/);
    assert.match(createLine, new RegExp(`vinci-worker: task=msg_a attempt=3 head=${r.head} base=main`), "(a) PR body footer");
    console.log("PASS (a) crash window between push and PR record");
  }

  // (b) PR already exists -> adopted, no create call
  {
    const r = makeRepo();
    resetCalls();
    process.env.FAKE_GH_LIST_JSON = JSON.stringify([{ number: 9, url: "https://github.com/test/repo/pull/9", headRefOid: "deadbeef" }]);
    const result = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_b", attempt: 1, baseRef: "main", promotion: "pr" });
    delete process.env.FAKE_GH_LIST_JSON;
    assert.equal(result.publish, "pushed");
    assert.equal(result.pr, "https://github.com/test/repo/pull/9");
    assert.equal(result.pr_adopted, true);
    assert.equal(result.pr_head, "deadbeef");
    assert.ok(calls().some(isList), "(b) the open PR was looked up");
    assert.equal(calls().filter(isCreate).length, 0, "(b) never two PRs for one branch: no create when one is open");
    console.log("PASS (b) existing PR adopted");
  }

  // (c) remote moved (non-ancestor commit on origin) -> refused, nothing pushed, no gh call
  {
    const r = makeRepo();
    resetCalls();
    // someone else pushed a divergent commit to the same branch name
    const other = join(scratch, `other-${counter}`);
    execFileSync("git", ["clone", "-q", `file://${r.origin}`, other], { stdio: "pipe" });
    git(other, "config", "user.email", "o@o");
    git(other, "config", "user.name", "o");
    git(other, "checkout", "-qb", r.branch);
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "-qm", "theirs");
    git(other, "push", "-q", "origin", r.branch);
    const theirs = git(other, "rev-parse", r.branch);

    const result = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_c", attempt: 1, baseRef: "main", promotion: "pr" });
    assert.equal(result.publish, "remote_moved", "(c) a moved remote refuses the push");
    assert.equal(result.remote_sha_before, theirs);
    assert.equal(result.pushed_sha, null);
    assert.equal(result.pr, null);
    assert.equal(remoteSha(r.repoDir, r.branch), theirs, "(c) origin untouched: never force");
    assert.equal(calls().length, 0, "(c) no gh call after a refused push");

    // control: an ancestor on origin (our own earlier push) is fast-forwardable and allowed
    const r2 = makeRepo();
    git(r2.repoDir, "push", "-q", "origin", `${r2.branch}~0:refs/heads/${r2.branch}`);
    writeFileSync(join(r2.repoDir, "more.txt"), "more\n");
    git(r2.repoDir, "add", ".");
    git(r2.repoDir, "commit", "-qm", "more");
    const ok = await publish({ repoDir: r2.repoDir, branch: r2.branch, taskId: "msg_c2", attempt: 1, baseRef: "main", promotion: "none" });
    assert.equal(ok.publish, "pushed");
    assert.equal(ok.remote_sha_before, r2.head);
    assert.equal(ok.pushed_sha, git(r2.repoDir, "rev-parse", r2.branch));
    console.log("PASS (c) remote moved refused; ancestor fast-forward allowed");
  }

  // (d) limitTripped -> push yes, PR no
  {
    const r = makeRepo();
    resetCalls();
    const result = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_d", attempt: 1, baseRef: "main", promotion: "pr", limitTripped: "budget_usd" });
    assert.equal(result.publish, "pushed");
    assert.equal(result.pushed_sha, r.head);
    assert.equal(result.pr, null);
    assert.equal(calls().length, 0, "(d) no gh call when a limit tripped");
    console.log("PASS (d) limitTripped pushes without a PR");
  }

  // (e) promotion=none -> no PR ever (also via run.mjs's wrapper with evidence: none)
  {
    const r = makeRepo();
    resetCalls();
    const result = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_e", attempt: 1, baseRef: "main", promotion: "none" });
    assert.equal(result.publish, "pushed");
    assert.equal(result.pr, null);
    assert.equal(calls().length, 0, "(e) promotion none never touches gh");
    const r2 = makeRepo();
    const viaRun = await runPublish({ envelope: { evidence: "none" }, repoDir: r2.repoDir, branch: r2.branch, taskId: "msg_e2", attempt: 1 });
    assert.equal(viaRun.publish, "pushed");
    assert.equal(viaRun.pr, null);
    assert.equal(viaRun.base_ref, "main", "(e) base defaults to main only when the envelope carries none");
    assert.equal(calls().length, 0);
    console.log("PASS (e) promotion none");
  }

  // (f) fence invalid before push -> no push, no PR; fence invalid only before PR -> push, no PR
  {
    const r = makeRepo();
    resetCalls();
    const stages = [];
    const fence = { generation: 4, check: async ({ stage }) => { stages.push(stage); return { valid: false, reason: "lease lost" }; } };
    const result = await publish({ repoDir: r.repoDir, branch: r.branch, taskId: "msg_f", attempt: 1, baseRef: "main", promotion: "pr", fence });
    assert.equal(result.publish, "fenced_out");
    assert.equal(result.fenced_out, "lease lost");
    assert.equal(result.pushed_sha, null);
    assert.equal(result.pr, null);
    assert.equal(remoteSha(r.repoDir, r.branch), null, "(f) nothing reached origin");
    assert.equal(calls().length, 0, "(f) no gh call");
    assert.deepEqual(stages, ["push"]);

    const r2 = makeRepo();
    resetCalls();
    const stages2 = [];
    const fence2 = { generation: 5, check: async ({ stage }) => { stages2.push(stage); return stage === "push" ? { valid: true } : { valid: false, reason: "generation advanced" }; } };
    const result2 = await publish({ repoDir: r2.repoDir, branch: r2.branch, taskId: "msg_f2", attempt: 1, baseRef: "main", promotion: "pr", fence: fence2 });
    assert.equal(result2.publish, "pushed");
    assert.equal(result2.pushed_sha, r2.head);
    assert.equal(result2.pr, null);
    assert.equal(result2.fenced_out, "generation advanced");
    assert.deepEqual(stages2, ["push", "pr"], "(f) the fence is consulted immediately before each effect");
    assert.equal(calls().filter(isCreate).length, 0, "(f) fence invalid before PR: no create");

    // valid fence: footer carries the generation and the PR base comes from the caller
    const r3 = makeRepo();
    resetCalls();
    const fence3 = { generation: 6, check: async () => ({ valid: true }) };
    const result3 = await publish({ repoDir: r3.repoDir, branch: r3.branch, taskId: "msg_f3", attempt: 2, baseRef: "release/2026-08", promotion: "pr", fence: fence3 });
    assert.equal(result3.pr, "https://github.com/test/repo/pull/123");
    assert.equal(result3.base_ref, "release/2026-08");
    const create = calls().find(isCreate);
    assert.match(create, /--base release\/2026-08/, "(f/P3) PR base is the caller's baseRef");
    assert.match(create, new RegExp(`task=msg_f3 attempt=2 head=${r3.head} base=release/2026-08 fence=6`));
    console.log("PASS (f) fence before push and before PR");
  }
} finally {
  process.env.PATH = OLD_PATH;
  delete process.env.FAKE_GH_LIST_JSON;
  delete process.env.FAKE_GH_CREATE_EXIT;
  rmSync(scratch, { recursive: true, force: true });
}
console.log("PASS worker-publisher-crash-window");
