// Wave 1 publisher: idempotent PR adoption (owner/base/task-checked), remote-sha discipline
// (lease against the sampled sha, never force, read back), PR head verification, fence hook, and
// the crash windows between push and PR record. Real git against a bare file:// origin; gh is the
// STATEFUL fake (fixtures/gh-stateful.mjs) so PR cardinality across retries is observable; git is
// a recording shim in front of the real binary so push ATTEMPTS are countable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { publish } from "../worker/publisher.mjs";
import { publish as runPublish } from "../worker/run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
const scratch = mkdtempSync(join(tmpdir(), "worker-publisher-"));
const git = (cwd, ...a) => execFileSync(REAL_GIT, ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
const ghCalls = join(scratch, "gh-calls.txt");
const gitCalls = join(scratch, "git-calls.txt");
const ghState = join(scratch, "gh-state.json");
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/bin/bash\nexec node "${join(HERE, "fixtures/gh-stateful.mjs")}" "$@"\n`);
writeFileSync(join(bin, "git"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${gitCalls}"\nexec "${REAL_GIT}" "$@"\n`);
chmodSync(join(bin, "gh"), 0o755);
chmodSync(join(bin, "git"), 0o755);
const OLD_PATH = process.env.PATH;
process.env.PATH = `${bin}:${OLD_PATH}`;
process.env.FAKE_GH_STATE = ghState;
process.env.FAKE_GH_RECORD = ghCalls;
process.env.FAKE_GH_OWNER = "test";

let counter = 0;
function makeRepo() {
  const id = String(++counter);
  const origin = join(scratch, `origin-${id}.git`);
  execFileSync(REAL_GIT, ["init", "-q", "--bare", "-b", "main", origin]);
  const repoDir = join(scratch, `repo-${id}`);
  execFileSync(REAL_GIT, ["clone", "-q", `file://${origin}`, repoDir], { stdio: "pipe" });
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
  process.env.FAKE_GH_ORIGIN = origin;
  rmSync(ghState, { force: true });
  rmSync(ghCalls, { force: true });
  rmSync(gitCalls, { force: true });
  return { repoDir, origin, branch, head: git(repoDir, "rev-parse", branch) };
}
// A second clone that pushes a divergent commit to the same branch name (someone else's work).
function pushForeign(r, file = "theirs.txt") {
  const other = join(scratch, `other-${counter}-${file}`);
  execFileSync(REAL_GIT, ["clone", "-q", `file://${r.origin}`, other], { stdio: "pipe" });
  git(other, "config", "user.email", "o@o");
  git(other, "config", "user.name", "o");
  git(other, "checkout", "-qb", r.branch);
  writeFileSync(join(other, file), "theirs\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "theirs");
  git(other, "push", "-q", "origin", r.branch);
  return git(other, "rev-parse", r.branch);
}
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
const ghArgv = () => lines(ghCalls).map((line) => JSON.parse(line));
const ghCreates = () => ghArgv().filter((a) => a[0] === "pr" && a[1] === "create");
const gitPushes = () => lines(gitCalls).filter((line) => /(^|\s)push(\s|$)/.test(line));
const prs = () => (existsSync(ghState) ? JSON.parse(readFileSync(ghState, "utf8")).prs : []);
const openPrs = () => prs().filter((pr) => pr.state === "OPEN");
function seedPr(pr) {
  const state = existsSync(ghState) ? JSON.parse(readFileSync(ghState, "utf8")) : { next: 100, prs: [] };
  state.prs.push({ number: state.next++, url: `https://github.com/${pr.owner ?? "test"}/repo/pull/${state.next - 1}`, state: "OPEN", baseRefName: "main", owner: "test", body: "", ...pr });
  writeFileSync(ghState, JSON.stringify(state));
  return state.prs.at(-1);
}
const remoteSha = (r) => { const out = git(r.repoDir, "ls-remote", "origin", `refs/heads/${r.branch}`); return out ? out.split(/\s+/)[0] : null; };
const args = (r, extra = {}) => ({ repoDir: r.repoDir, branch: r.branch, taskId: `msg_${counter}`, attempt: 1, baseRef: "main", promotion: "pr", repoOwner: "test", ...extra });

try {
  // (a) push ok, gh pr create fails ⇒ pushed_sha recorded, pr null. Retry: origin already at our
  //     sha ⇒ NO push attempt; the PR created out-of-band is adopted, or exactly one is created.
  {
    const r = makeRepo();
    process.env.FAKE_GH_CREATE_EXIT = "1";
    const first = await publish(args(r, { taskId: "msg_a" }));
    delete process.env.FAKE_GH_CREATE_EXIT;
    assert.equal(first.publish, "pushed");
    assert.equal(first.pushed_sha, r.head, "(a) the exact pushed sha is recorded even when the PR step fails");
    assert.equal(first.remote_sha_before, null);
    assert.equal(first.remote_sha_after, r.head, "(a) read back after push");
    assert.equal(first.pr, null);
    assert.equal(remoteSha(r), r.head);
    assert.equal(gitPushes().length, 1);
    assert.match(gitPushes()[0], new RegExp(`push origin ${r.head}:refs/heads/${r.branch} --force-with-lease=refs/heads/${r.branch}:$`), "(a) the CAPTURED sha is pushed under a lease on the sampled (absent) remote");
    assert.equal(git(r.repoDir, "config", "--get", `branch.${r.branch}.merge`), `refs/heads/${r.branch}`, "(a) the branch tracks itself after the push (residue classifier input)");
    assert.equal(prs().length, 0);

    // retry 1: a PR appeared out-of-band (footer names this task) ⇒ adopted, no push, no create
    rmSync(gitCalls, { force: true });
    rmSync(ghCalls, { force: true });
    seedPr({ headRefName: r.branch, body: `hello\n\nvinci-worker: task=msg_a attempt=1 head=${r.head} base=main` });
    const second = await publish(args(r, { taskId: "msg_a", attempt: 2 }));
    assert.equal(second.publish, "pushed");
    assert.equal(second.push_skipped, "remote_at_head");
    assert.equal(gitPushes().length, 0, "(a) retry does not re-push a sha origin already holds");
    assert.equal(second.pr, prs()[0].url);
    assert.equal(second.pr_adopted, true);
    assert.equal(second.pr_adopted_via, "footer");
    assert.equal(second.pr_head, r.head, "(a/B5) the adopted PR is at the pushed sha");
    assert.equal(ghCreates().length, 0);
    assert.equal(openPrs().length, 1, "(a) cardinality: still one PR after the retry");

    // retry 2 on a fresh repo: still no PR ⇒ exactly one create, footer + base on the create call
    const r2 = makeRepo();
    const third = await publish(args(r2, { taskId: "msg_a2", attempt: 3 }));
    assert.equal(third.pr, prs()[0].url);
    assert.equal(third.pr_adopted, false);
    assert.equal(third.pr_head, r2.head);
    const fourth = await publish(args(r2, { taskId: "msg_a2", attempt: 4 }));
    assert.equal(fourth.pr, third.pr);
    assert.equal(fourth.pr_adopted, true);
    assert.equal(ghCreates().length, 1, "(a) exactly one create across two attempts");
    assert.equal(openPrs().length, 1, "(a) cardinality: one PR for the branch after retry");
    const create = ghCreates()[0];
    assert.equal(create[create.indexOf("--base") + 1], "main");
    assert.match(create[create.indexOf("--body") + 1], new RegExp(`vinci-worker: task=msg_a2 attempt=3 head=${r2.head} base=main$`), "(a) PR body footer");
    console.log("PASS (a) crash window between push and PR record");
  }

  // (b) PR already exists (ours) ⇒ adopted, no create; B1: a same-named FORK PR or a WRONG-TASK PR
  //     on the branch ⇒ pr_conflict, no push, no create; a held PR this task continues ⇒ adopted.
  {
    const r = makeRepo();
    seedPr({ headRefName: r.branch, body: `vinci-worker: task=msg_${counter} attempt=1 head=${r.head} base=main` });
    const ours = await publish(args(r));
    assert.equal(ours.publish, "pushed");
    assert.equal(ours.pr_adopted, true);
    assert.equal(ours.pr, prs()[0].url);
    assert.equal(ghCreates().length, 0, "(b) never two PRs for one branch: no create when ours is open");
    assert.equal(openPrs().length, 1);

    const fork = makeRepo();
    seedPr({ headRefName: fork.branch, owner: "someone-else", forkHead: "1111111111111111111111111111111111111111", body: `vinci-worker: task=msg_${counter} attempt=1 head=x base=main` });
    const forked = await publish(args(fork));
    assert.equal(forked.publish, "pr_conflict", "(b/B1) a same-named branch on a fork is not ours");
    assert.match(forked.refusal_reason, /fork/);
    assert.equal(gitPushes().length, 0, "(b/B1) conflict refuses the push too");
    assert.equal(forked.pr, null);
    assert.equal(ghCreates().length, 0);
    assert.equal(remoteSha(fork), null);

    const wrong = makeRepo();
    seedPr({ headRefName: wrong.branch, pinnedHead: "2222222222222222222222222222222222222222", body: `vinci-worker: task=msg_other attempt=1 head=2222222 base=main` });
    const wrongTask = await publish(args(wrong));
    assert.equal(wrongTask.publish, "pr_conflict", "(b/B1) another task's PR whose head is unrelated to ours");
    assert.match(wrongTask.refusal_reason, /task msg_other/);
    assert.equal(gitPushes().length, 0);
    assert.equal(ghCreates().length, 0);
    assert.equal(openPrs().length, 1, "(b/B1) no second PR created on the conflicted branch");

    const wrongBase = makeRepo();
    seedPr({ headRefName: wrongBase.branch, baseRefName: "release/1", body: `vinci-worker: task=msg_${counter} attempt=1 head=x base=release/1` });
    const based = await publish(args(wrongBase));
    assert.equal(based.publish, "pr_conflict", "(b/B1) same task, different base is not adoptable");
    assert.equal(gitPushes().length, 0);

    // continuation: a held PR (another task's, or legacy without a footer) whose head we built on
    const cont = makeRepo();
    git(cont.repoDir, "push", "-q", "origin", `${cont.branch}:refs/heads/${cont.branch}`);
    seedPr({ headRefName: cont.branch, body: "held PR, no footer" });
    writeFileSync(join(cont.repoDir, "more.txt"), "more\n");
    git(cont.repoDir, "add", ".");
    git(cont.repoDir, "commit", "-qm", "more");
    const newHead = git(cont.repoDir, "rev-parse", cont.branch);
    const continued = await publish(args(cont));
    assert.equal(continued.publish, "pushed");
    assert.equal(continued.remote_sha_before, cont.head);
    assert.equal(continued.pushed_sha, newHead);
    assert.equal(continued.pr_adopted, true);
    assert.equal(continued.pr_adopted_via, "ancestry");
    assert.equal(continued.pr_head, newHead, "(b/B5) the held PR now sits at the pushed sha");
    assert.equal(ghCreates().length, 0);
    console.log("PASS (b) existing PR adopted; fork / wrong-task / wrong-base PRs refused");
  }

  // (c) remote moved ⇒ refused, ZERO push attempts, no gh call; the lease catches a move between
  //     sample and push; a fetched (known) divergent remote is refused as well; ancestor allowed.
  {
    const r = makeRepo();
    const theirs = pushForeign(r);
    const result = await publish(args(r));
    assert.equal(result.publish, "remote_moved", "(c) a moved remote refuses the push");
    assert.equal(result.remote_sha_before, theirs);
    assert.equal(result.pushed_sha, null);
    assert.equal(result.pr, null);
    assert.equal(remoteSha(r), theirs, "(c) origin untouched: never force");
    assert.equal(gitPushes().length, 0, "(c) zero push ATTEMPTS");
    assert.equal(ghArgv().length, 0, "(c) no gh call after a refused push");

    // known-divergent: the foreign commit IS fetched locally (object known) and still refused
    const known = makeRepo();
    const theirsKnown = pushForeign(known);
    git(known.repoDir, "fetch", "-q", "origin", `+refs/heads/${known.branch}:refs/remotes/origin/${known.branch}`);
    assert.equal(git(known.repoDir, "cat-file", "-t", theirsKnown), "commit", "precondition: the divergent commit is in the local odb");
    const knownResult = await publish(args(known));
    assert.equal(knownResult.publish, "remote_moved", "(c) a fetched, divergent remote is refused");
    assert.equal(gitPushes().length, 0);

    // race (B4): origin moves AFTER the T0 sample and BEFORE the push (the fence hook is the
    // last thing that runs before the push, so it is where the move is injected)
    const raced = makeRepo();
    let movedTo = null;
    const fence = { check: async ({ stage }) => { if (stage === "push") movedTo = pushForeign(raced, "race.txt"); return { valid: true }; } };
    const raceResult = await publish(args(raced, { fence }));
    assert.equal(raceResult.publish, "remote_moved", "(c/B4) the lease rejects a push whose remote moved after sampling");
    assert.equal(raceResult.remote_sha_before, null, "(c/B4) sampled absent");
    assert.equal(raceResult.remote_sha_after, movedTo);
    assert.equal(raceResult.pushed_sha, null);
    assert.equal(remoteSha(raced), movedTo, "(c/B4) their commit survived: nothing forced");
    assert.equal(gitPushes().length, 1, "(c/B4) exactly one push attempt, rejected by the lease");
    assert.match(gitPushes()[0], /--force-with-lease=refs\/heads\/[^:]+:$/);
    assert.equal(ghCreates().length, 0);

    // race (B4, the case a plain push would ACCEPT): between sample (absent) and push, origin gains
    // the branch at an ANCESTOR of our head. A plain push fast-forwards over it silently; the lease
    // (expected: absent) rejects it, so the move is seen and recorded instead of overwritten.
    const ffRace = makeRepo();
    const parent = git(ffRace.repoDir, "rev-parse", `${ffRace.branch}~1`);
    const fenceFf = { check: async ({ stage }) => { if (stage === "push") git(ffRace.repoDir, "push", "-q", "origin", `${parent}:refs/heads/${ffRace.branch}`); return { valid: true }; } };
    const ffResult = await publish(args(ffRace, { fence: fenceFf }));
    assert.equal(ffResult.publish, "remote_moved", "(c/B4) an ancestor appearing after the sample is still a move: the lease rejects it");
    assert.equal(ffResult.remote_sha_before, null);
    assert.equal(ffResult.remote_sha_after, parent);
    assert.equal(ffResult.pushed_sha, null);
    assert.equal(remoteSha(ffRace), parent, "(c/B4) origin left at the sampled-after value, not fast-forwarded over");

    // control: an ancestor on origin (our own earlier push) is fast-forwardable and allowed
    const r2 = makeRepo();
    git(r2.repoDir, "push", "-q", "origin", `${r2.branch}:refs/heads/${r2.branch}`);
    writeFileSync(join(r2.repoDir, "more.txt"), "more\n");
    git(r2.repoDir, "add", ".");
    git(r2.repoDir, "commit", "-qm", "more");
    const ok = await publish(args(r2, { promotion: "none" }));
    assert.equal(ok.publish, "pushed");
    assert.equal(ok.remote_sha_before, r2.head);
    assert.equal(ok.pushed_sha, git(r2.repoDir, "rev-parse", r2.branch));
    assert.match(gitPushes()[0], new RegExp(`--force-with-lease=refs/heads/${r2.branch}:${r2.head}$`), "(c) the lease names the sampled sha");
    console.log("PASS (c) remote moved refused (pre-check, fetched-divergent, and sample-to-push race); ancestor allowed");
  }

  // (d) limitTripped ⇒ push yes, PR no
  {
    const r = makeRepo();
    const result = await publish(args(r, { limitTripped: "budget_usd" }));
    assert.equal(result.publish, "pushed");
    assert.equal(result.pushed_sha, r.head);
    assert.equal(result.pr, null);
    assert.equal(ghArgv().length, 0, "(d) no gh call when a limit tripped");
    console.log("PASS (d) limitTripped pushes without a PR");
  }

  // (e) promotion=none ⇒ no PR ever (also via run.mjs's wrapper with evidence: none)
  {
    const r = makeRepo();
    const result = await publish(args(r, { promotion: "none" }));
    assert.equal(result.publish, "pushed");
    assert.equal(result.pr, null);
    assert.equal(ghArgv().length, 0, "(e) promotion none never touches gh");
    const r2 = makeRepo();
    const viaRun = await runPublish({ envelope: { evidence: "none", repo: "test/repo" }, repoDir: r2.repoDir, branch: r2.branch, taskId: "msg_e2", attempt: 1 });
    assert.equal(viaRun.publish, "pushed");
    assert.equal(viaRun.pr, null);
    assert.equal(viaRun.base_ref, "main", "(e) base defaults to main only when the envelope carries none");
    assert.equal(ghArgv().length, 0);
    console.log("PASS (e) promotion none");
  }

  // (f) fence invalid before push ⇒ zero push attempts, no PR; invalid only before PR ⇒ push, no PR;
  //     a THROWING fence is invalid; a valid fence's generation lands in the footer, base from caller.
  {
    const r = makeRepo();
    const stages = [];
    const fence = { generation: 4, check: async ({ stage }) => { stages.push(stage); return { valid: false, reason: "lease lost" }; } };
    const result = await publish(args(r, { fence }));
    assert.equal(result.publish, "fenced_out");
    assert.equal(result.fenced_out, "lease lost");
    assert.equal(result.pushed_sha, null);
    assert.equal(result.pr, null);
    assert.equal(remoteSha(r), null, "(f) nothing reached origin");
    assert.equal(gitPushes().length, 0, "(f) zero push ATTEMPTS");
    assert.equal(ghCreates().length, 0);
    assert.deepEqual(stages, ["push"]);

    const r2 = makeRepo();
    const stages2 = [];
    const fence2 = { generation: 5, check: async ({ stage }) => { stages2.push(stage); return stage === "push" ? { valid: true } : { valid: false, reason: "generation advanced" }; } };
    const result2 = await publish(args(r2, { fence: fence2 }));
    assert.equal(result2.publish, "pushed");
    assert.equal(result2.pushed_sha, r2.head);
    assert.equal(result2.pr, null);
    assert.equal(result2.fenced_out, "generation advanced");
    assert.deepEqual(stages2, ["push", "pr"], "(f) the fence is consulted immediately before each effect");
    assert.equal(ghCreates().length, 0, "(f) fence invalid before PR: no create");
    assert.equal(openPrs().length, 0);

    const r3 = makeRepo();
    const throwing = { check: async () => { throw new Error("governor unreachable"); } };
    const thrown = await publish(args(r3, { fence: throwing }));
    assert.equal(thrown.publish, "fenced_out", "(f) a throwing fence is not a valid fence");
    assert.match(thrown.fenced_out, /governor unreachable/);
    assert.equal(gitPushes().length, 0);
    assert.equal(remoteSha(r3), null);

    const r4 = makeRepo();
    const fence4 = { generation: 6, check: async () => ({ valid: true }) };
    const result4 = await publish(args(r4, { attempt: 2, baseRef: "release/2026-08", fence: fence4 }));
    assert.equal(result4.pr, prs()[0].url);
    assert.equal(result4.base_ref, "release/2026-08");
    const create = ghCreates()[0];
    assert.equal(create[create.indexOf("--base") + 1], "release/2026-08", "(f/P3) PR base is the caller's baseRef");
    assert.match(create[create.indexOf("--body") + 1], new RegExp(`task=msg_${counter} attempt=2 head=${r4.head} base=release/2026-08 fence=6$`));
    console.log("PASS (f) fence before push / before PR / throwing");
  }

  // (g) B5: a PR whose head is not the pushed sha is never recorded; W1: a CLOSED PR on the branch
  //     refuses a second create (pr_closed); readback mismatch is its own state.
  {
    const r = makeRepo();
    seedPr({ headRefName: r.branch, pinnedHead: "3333333333333333333333333333333333333333", body: `vinci-worker: task=msg_${counter} attempt=1 head=3333333 base=main` });
    const stale = await publish(args(r));
    assert.equal(stale.publish, "pushed");
    assert.equal(stale.pr, null, "(g/B5) a PR not at the pushed sha is not evidence");
    assert.match(stale.pr_error, /pr_head_mismatch/);
    assert.equal(ghCreates().length, 0, "(g/B5) and no second PR is created either");

    const closed = makeRepo();
    seedPr({ headRefName: closed.branch, state: "CLOSED", body: `vinci-worker: task=msg_${counter} attempt=1 head=x base=main` });
    // the stateful gh only collides on OPEN PRs; force the collision path to exercise the all-state listing
    const closedResult = await publish(args(closed, {
      exec: async (name, a, options) => {
        if (name === "gh" && a[1] === "create") return { status: 1, stdout: "", stderr: `a pull request for branch "${closed.branch}" already exists` };
        const { command } = await import("../worker/exec.mjs");
        return command(name, a, { ...options, allowFailure: true });
      },
    }));
    assert.equal(closedResult.publish, "pr_closed", "(g/W1) a closed PR on the branch: never open a second");
    assert.equal(closedResult.pr, null);
    assert.equal(prs().length, 1);
    // B4 readback: a successful push whose read-back does not equal the pushed sha (another
    // writer landed in the window) is its own state — pushed_sha stays on the record, no PR.
    const rb = makeRepo();
    const bogus = "4444444444444444444444444444444444444444";
    let pushed = false;
    const rbResult = await publish(args(rb, {
      exec: async (name, a, options) => {
        const { command } = await import("../worker/exec.mjs");
        const result = await command(name, a, { ...options, allowFailure: true });
        if (name === "git" && a[2] === "push" && result.status === 0) pushed = true;
        if (name === "git" && a[2] === "ls-remote" && pushed) return { ...result, stdout: `${bogus}\trefs/heads/${rb.branch}` };
        return result;
      },
    }));
    assert.equal(rbResult.publish, "remote_readback_mismatch", "(g/B4) origin must read back the pushed sha");
    assert.equal(rbResult.pushed_sha, rb.head, "(g/B4) the sha we pushed stays on the record");
    assert.equal(rbResult.remote_sha_after, bogus);
    assert.equal(rbResult.pr, null);
    assert.equal(ghCreates().length, 0, "(g/B4) no PR on a branch whose tip is not ours");
    console.log("PASS (g) PR head verification, closed-PR refusal, readback mismatch");
  }
} finally {
  process.env.PATH = OLD_PATH;
  for (const key of ["FAKE_GH_STATE", "FAKE_GH_RECORD", "FAKE_GH_OWNER", "FAKE_GH_ORIGIN", "FAKE_GH_CREATE_EXIT"]) delete process.env[key];
  rmSync(scratch, { recursive: true, force: true });
}
console.log("PASS worker-publisher-crash-window");
