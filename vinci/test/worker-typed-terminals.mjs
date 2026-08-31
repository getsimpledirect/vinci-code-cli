// The typed terminal contract, and the PR gate that stops the worker opening a review request
// for work that did not survive.
//
// Measured 2026-08-31 over six days in getsimpledirect/vinci-gpu-research: this worker opened
// 236 PRs of which 192 closed without ever merging -- a 9% merge rate against a human's 98% --
// and 235 of the 236 were titled `Worker task msg_<hex>`. Both are fixed here, and both are
// pinned by tests that can fail.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BusClient } from "../worker/bus.mjs";
import { prTitle } from "../worker/publisher.mjs";
import { publish } from "../worker/run.mjs";

const bus = () => new BusClient("https://example.invalid", "t");

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
