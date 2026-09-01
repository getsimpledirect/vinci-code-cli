// The typed terminal contract, and the PR gate that stops the worker opening a review request
// for work that did not survive.
//
// Measured 2026-08-31 over six days in getsimpledirect/vinci-gpu-research: this worker opened
// 236 PRs of which 192 closed without ever merging -- a 9% merge rate against a human's 98% --
// and 235 of the 236 were titled `Worker task msg_<hex>`. Both are fixed here, and both are
// pinned by tests that can fail.

import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BusClient } from "../worker/bus.mjs";
import { prepareCleanRoom } from "../worker/cleanroom.mjs";
import { prTitle } from "../worker/publisher.mjs";
import { publish } from "../worker/run.mjs";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const bus = () => new BusClient("https://example.invalid", "t");

async function runWorker(fixture, id, extraArgs = []) {
  const child = spawn(
    "node",
    [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir, ...extraArgs],
    { env: fixture.getEnv(), stdio: "pipe" },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveClose) => child.once("close", resolveClose));
  assert.equal(code, 0, stderr);
  return JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${id}.json`), "utf8"));
}

test("a terminal record without a typed outcome is a hard error, never a default", async () => {
  // The consumer keys human attention on `outcome !== "COMPLETED"`. A terminal that posts with no
  // outcome would be invisible there -- an unclassified case that silently passes is the same
  // fail-open the typed outcome exists to remove.
  await assert.rejects(
    () => bus().postTerminal("status", "task t1 blocked", "body", { inReplyTo: "msg_1" }),
    /terminal record must carry a typed outcome/,
    "omitting the outcome must throw",
  );
  await assert.rejects(
    () => bus().postTerminal("status", "task t1 blocked", "body", { outcome: "" }),
    /terminal record must carry a typed outcome/,
    "an empty outcome is not a valid outcome",
  );
  await assert.rejects(
    () => bus().postTerminal("status", "task t1 blocked", "body", { outcome: "DONE" }),
    /terminal record must carry a typed outcome/,
    "an outcome outside the enum must throw, not be stored",
  );
});

test("an unrecognised outcome is refused on the ordinary post path too", async () => {
  await assert.rejects(
    () => bus().post("status", "s", "b", { outcome: "completed" }),
    /worker outcome must be one of/,
    "the enum is case-sensitive: a near-miss must not slip through",
  );
});

test("a PR title is never the bare task id, with or without an objective", () => {
  const withSpec = prTitle({
    taskId: "msg_9c8ffd81",
    objective: "Wire the branch lease into the push path. Then do other things.",
    outcome: "COMPLETED",
    head: "0123456789abcdef",
    ref: "job_abc",
  });
  assert.match(withSpec, /^COMPLETED: Wire the branch lease into the push path\./);
  assert.match(withSpec, /msg_9c8ffd81/, "the task id stays: it is the join key to branch and bus record");
  assert.match(withSpec, /@0123456/, "the head sha is carried");
  assert.match(withSpec, /job_abc/, "the ledger ref is carried");
  assert.doesNotMatch(withSpec, /^Worker task /);

  // Degenerate input is where the old title came from, so it is the case that must not regress.
  for (const objective of [null, "", "   ", undefined]) {
    const bare = prTitle({ taskId: "msg_deadbeef", objective, outcome: "COMPLETED", head: null, ref: null });
    assert.doesNotMatch(bare, /^Worker task /, `a ${JSON.stringify(objective)} objective must not fall back to the old title`);
    assert.match(bare, /COMPLETED/, "the outcome still carries information the bare id did not");
  }

  // A multi-paragraph spec must not become a multi-line PR title.
  const long = prTitle({ taskId: "t", objective: "a".repeat(400), outcome: "FAILED", head: null, ref: null });
  assert.ok(long.length < 140, `title must stay short, got ${long.length}`);
  assert.doesNotMatch(long, /\n/, "a title must never contain a newline");
});

test("an ineligible run pushes the branch and never opens a PR", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "typed-terminals-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const stubDir = join(tempDir, "stubs");
  mkdirSync(stubDir);
  const callsLog = join(tempDir, "calls.log");
  const pushedMarker = join(tempDir, "pushed");

  writeFileSync(join(stubDir, "git"), `#!/bin/sh
echo "git $@" >> ${callsLog}
case "$3" in
  push) : > ${pushedMarker}; exit 0 ;;
  rev-parse) echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;
  ls-remote) if [ -f ${pushedMarker} ]; then echo "0123456789abcdef0123456789abcdef01234567	$5"; fi; exit 0 ;;
  remote) echo https://github.com/test/repo.git; exit 0 ;;
  cat-file) exit 1 ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(join(stubDir, "gh"), `#!/bin/sh
echo "gh $@" >> ${callsLog}
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/test/repo/pull/999"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":999,"url":"https://github.com/test/repo/pull/999","headRefOid":"0123456789abcdef0123456789abcdef01234567"}'; exit 0; fi
exit 0
`);
  execSync(`chmod +x ${join(stubDir, "git")} ${join(stubDir, "gh")}`);

  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir);
  execSync("git init -q", { cwd: repoDir });
  execSync("git config user.email t@e.com && git config user.name T", { cwd: repoDir });
  writeFileSync(join(repoDir, "f.txt"), "x");
  execSync('git add f.txt && git commit -qm initial', { cwd: repoDir });
  execSync("git remote add origin https://github.com/test/repo.git", { cwd: repoDir });

  const savedPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });

  // A run that did not succeed: the branch must still be pushed, because losing evidence is a W0
  // cohort failure condition. What must NOT happen is a review request for work that failed.
  writeFileSync(callsLog, "");
  rmSync(pushedMarker, { force: true });
  const blocked = await publish({
    envelope: { evidence: "pr" }, repoDir, branch: "worker/msg_a", taskId: "msg_a",
    prEligible: false, objective: "do a thing", outcome: null,
  });
  const blockedCalls = readFileSync(callsLog, "utf8");
  assert.equal(blocked.publish, "pushed", "evidence must not be lost: the branch is still pushed");
  assert.equal(blocked.pr, null, "a run that did not succeed must not open a PR");
  assert.match(blockedCalls, /git .*push/, "git push must still be called");
  assert.doesNotMatch(blockedCalls, /gh pr create/, "gh pr create must NOT be reached");

  // A run that succeeded: the PR opens, and its title is human-readable.
  writeFileSync(callsLog, "");
  rmSync(pushedMarker, { force: true });
  const completed = await publish({
    envelope: { evidence: "pr" }, repoDir, branch: "worker/msg_b", taskId: "msg_b",
    prEligible: true, objective: "Wire the branch lease into the push path", outcome: "COMPLETED",
    ref: "job_zz",
  });
  const okCalls = readFileSync(callsLog, "utf8");
  assert.equal(completed.pr, "https://github.com/test/repo/pull/999", "a completed run still opens its PR");
  assert.match(okCalls, /gh pr create/, "gh pr create must be reached for a completed run");
  assert.match(okCalls, /COMPLETED: Wire the branch lease into the push path/, "the PR title must be readable");
  assert.doesNotMatch(okCalls, /--title Worker task/, "the opaque title must never be emitted again");
});

test("the clean-room path is gated too: an ineligible run pushes and opens no PR", async (t) => {
  // The standard publisher and the clean-room publisher are SEPARATE code paths to a PR, and
  // gating only the first leaves the second open. An earlier version of publishFromCache
  // relied on its blocker and limitTripped checks plus a comment calling them "this path's
  // equivalent of the eligibility gate" -- they are not: finalState also refuses COMPLETED on
  // a harness stop, on outcome.state !== DONE, and on no_commit. A clean-room run that
  // stopped at the instrument would have opened a PR titled COMPLETED.
  const tempDir = mkdtempSync(join(tmpdir(), "typed-terminals-cr-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const stubDir = join(tempDir, "stubs");
  mkdirSync(stubDir);
  const callsLog = join(tempDir, "calls.log");

  writeFileSync(join(stubDir, "git"), `#!/bin/sh
echo "git $@" >> ${callsLog}
case "$3" in
  config) echo https://github.com/test/repo.git; exit 0 ;;
  push) exit 0 ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(join(stubDir, "gh"), `#!/bin/sh
echo "gh $@" >> ${callsLog}
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/test/repo/pull/777"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
exit 0
`);
  execSync(`chmod +x ${join(stubDir, "git")} ${join(stubDir, "gh")}`);

  const cacheDir = join(tempDir, "cache");
  const attemptDir = join(tempDir, "attempt");
  mkdirSync(cacheDir); mkdirSync(attemptDir);

  const savedPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });

  const { publishFromCache } = await import("../worker/cleanroom.mjs");

  writeFileSync(callsLog, "");
  const blocked = await publishFromCache({
    envelope: { evidence: "pr", repo: "test/repo", spec: "do a thing" },
    cacheDir, attemptDir, branch: "worker/msg_cr", taskId: "msg_cr",
    limitTripped: null, prEligible: false,
  });
  const blockedCalls = readFileSync(callsLog, "utf8");
  assert.equal(blocked.publish, "pushed", "evidence must not be lost: the branch is still pushed");
  assert.equal(blocked.pr, null, "an ineligible clean-room run must not open a PR");
  assert.doesNotMatch(blockedCalls, /gh pr create/, "gh pr create must NOT be reached");

  writeFileSync(callsLog, "");
  const ok = await publishFromCache({
    envelope: { evidence: "pr", repo: "test/repo", spec: "Wire the lease into the push path" },
    cacheDir, attemptDir, branch: "worker/msg_cr2", taskId: "msg_cr2",
    limitTripped: null, prEligible: true,
  });
  const okCalls = readFileSync(callsLog, "utf8");
  assert.equal(ok.pr, "https://github.com/test/repo/pull/777", "an eligible clean-room run still opens its PR");
  assert.match(okCalls, /COMPLETED: Wire the lease into the push path/, "title must be readable");
  assert.doesNotMatch(okCalls, /--title Worker task/, "the opaque title must never be emitted");
});

test("UNVERIFIED is a terminal and carries a type like any other", async () => {
  // finalState's DEFAULT is UNVERIFIED -- "anything else, incl. evidence: none, exit 0 alone".
  // So this is the most common non-success terminal, not an edge case. It used to post through
  // the untyped `bus.post`, which meant the commonest way for a run to end badly produced a
  // record with a NULL outcome -- invisible to a consumer keying on `outcome !== "COMPLETED"`.
  //
  // The bus has no server here, so a VALID outcome gets past validation and then fails on the
  // network. That difference is the assertion: valid values must fail LATER than invalid ones.
  await assert.rejects(
    () => bus().postTerminal("status", "task t", "b", { outcome: "UNVERIFIED" }),
    (err) => !/terminal record must carry a typed outcome/.test(err.message),
    "UNVERIFIED must pass validation and fail only at the network",
  );
  await assert.rejects(
    () => bus().postTerminal("status", "task t", "b", { outcome: "PRODUCED" }),
    /terminal record must carry a typed outcome/,
    "the enum stays closed: a plausible-sounding value is still refused before any I/O",
  );
});

test("clean-room rejects invalid and missing pinned base_ref before creating a worktree", async (t) => {
  const fixture = new WorkerTestFixture("typed-base-validation");
  t.after(() => fixture.cleanup());
  fixture.createRepo("test", "repo");
  const savedGitBase = process.env.VINCI_WORKER_GIT_BASE;
  process.env.VINCI_WORKER_GIT_BASE = `file://${fixture.reposDir}/`;
  t.after(() => {
    if (savedGitBase === undefined) delete process.env.VINCI_WORKER_GIT_BASE;
    else process.env.VINCI_WORKER_GIT_BASE = savedGitBase;
  });

  const invalidState = join(fixture.tempDir, "invalid-state");
  await assert.rejects(
    prepareCleanRoom({
      stateDir: invalidState,
      repo: "test/repo",
      taskId: "invalid-base",
      attempt: 1,
      baseRef: "-release",
      diskFloorBytes: 0,
    }),
    /base_ref .*plain git branch name/,
  );
  assert.equal(existsSync(invalidState), false, "syntax validation must happen before repository state is created");

  const missingState = join(fixture.tempDir, "missing-state");
  await assert.rejects(
    prepareCleanRoom({
      stateDir: missingState,
      repo: "test/repo",
      taskId: "missing-base",
      attempt: 1,
      baseRef: "release/missing",
      diskFloorBytes: 0,
    }),
    /base_ref release\/missing not found on origin/,
  );
  assert.equal(existsSync(join(missingState, "attempts")), false, "a missing pinned base must not create an attempt worktree");
});

test("clean-room checks out and opens the PR against a non-main base_ref", async (t) => {
  const fixture = new WorkerTestFixture("typed-base-ref");
  t.after(async () => {
    execFileSync("chmod", ["-R", "u+w", fixture.tempDir]);
    await fixture.cleanup();
  });
  const { origin } = fixture.createRepo("test", "repo");
  const seed = join(fixture.tempDir, "release-seed");
  execFileSync("git", ["clone", "--quiet", origin, seed]);
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: seed });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: seed });
  execFileSync("git", ["checkout", "--quiet", "-b", "release/2026-08"], { cwd: seed });
  writeFileSync(join(seed, "BASE_MARKER"), "release base\n");
  execFileSync("git", ["add", "BASE_MARKER"], { cwd: seed });
  execFileSync("git", ["commit", "--quiet", "-m", "release base"], { cwd: seed });
  execFileSync("git", ["push", "--quiet", "origin", "release/2026-08"], { cwd: seed });
  const releaseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" }).trim();

  fixture.linkTools(TOOLS);
  await fixture.startBus([{
    message_id: "typed-base",
    to_agent: "worker:w1",
    kind: "handoff",
    subject: "typed base",
    body: "repo: test/repo\nevidence: pr\nbase_ref: release/2026-08\n\nImplement from the release branch.",
    ts: "2026-08-31T12:00:00Z",
    posted_by: "scheduler",
  }]);

  const state = await runWorker(fixture, "typed-base", ["--clean-room", "--disk-floor-mb", "0"]);
  assert.equal(state.state, "COMPLETED");
  assert.equal(state.base_commit, releaseHead, "the attempt must fork from the pinned base_ref");
  const ghCalls = readFileSync(join(fixture.tempDir, "gh-calls.txt"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const create = ghCalls.find(({ argv }) => argv[0] === "pr" && argv[1] === "create");
  assert.ok(create, "the eligible run must create a PR");
  assert.equal(create.argv[create.argv.indexOf("--base") + 1], "release/2026-08");
});

test("the real finalState fall-through posts status with outcome UNVERIFIED", async (t) => {
  const fixture = new WorkerTestFixture("typed-unverified-terminal");
  t.after(() => fixture.cleanup());
  fixture.createRepo("test", "repo");
  fixture.linkTools(TOOLS);
  await fixture.startBus([{
    message_id: "typed-unverified",
    to_agent: "worker:w1",
    kind: "handoff",
    subject: "typed unverified",
    body: "repo: test/repo\nevidence: none\n\nProduce work without a PR assessment.",
    ts: "2026-08-31T12:00:00Z",
    posted_by: "scheduler",
  }]);

  const state = await runWorker(fixture, "typed-unverified");
  assert.equal(state.state, "UNVERIFIED", "DONE with no PR must take finalState's default fall-through");
  const posted = fixture.getPostedMessages().at(-1);
  assert.equal(posted.kind, "status");
  assert.equal(posted.outcome, "UNVERIFIED");
});
