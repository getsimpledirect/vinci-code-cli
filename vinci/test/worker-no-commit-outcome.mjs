import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");

async function runNoCommitScenario({ id, evidence, exitCode, skipOutcome }) {
  const fixture = new WorkerTestFixture(`no-commit-${id}`);
  try {
    const { origin } = fixture.createRepo("test", "repo");
    const baseCommit = execFileSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).trim();
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: id,
      to_agent: "worker:w1",
      kind: "handoff",
      subject: `no commit ${id}`,
      body: `repo: test/repo\nevidence: ${evidence}\n\nDo the task`,
      ts: "2026-08-29T20:00:00Z",
      posted_by: "scheduler",
    }]);
    const child = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      {
        env: fixture.getEnv({
          FAKE_GH_OUTPUT: "",
          FAKE_VINCI_EXIT: String(exitCode),
          FAKE_VINCI_NO_COMMIT: "1",
          ...(skipOutcome ? { FAKE_VINCI_SKIP_OUTCOME: "1" } : {}),
        }),
        stdio: "pipe",
      },
    );
    assert.equal(await new Promise((resolveClose) => child.once("close", resolveClose)), 0);
    const state = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${id}.json`), "utf8"));
    return { baseCommit, finalPost: fixture.getPostedMessages().at(-1), state };
  } finally {
    await fixture.cleanup();
  }
}

function expectedReason(baseCommit) {
  return `no_commit: HEAD is unchanged from base_commit ${baseCommit}; the run produced no commit`;
}

test("Variant 1: evidence=pr and exit 0 records no_commit without changing UNVERIFIED", async () => {
  const { baseCommit, finalPost, state } = await runNoCommitScenario({
    id: "28-v1",
    evidence: "pr",
    exitCode: 0,
    skipOutcome: false,
  });
  assert.equal(state.head, baseCommit, "fixture must leave HEAD at the starting commit");
  assert.equal(state.base_commit, baseCommit);
  assert.equal(state.state, "UNVERIFIED");
  assert.equal(state.pr, null);
  assert.equal(state.publish, "pushed", "publish remains an action result; outcome distinguishes no work");
  assert.equal(state.harness_stop, null);
  assert.equal(state.limit_tripped, null);
  assert.equal(state.outcome?.no_commit, true, "outcome should have no_commit boolean");
  assert.equal(state.outcome?.reason, expectedReason(baseCommit), "reason should contain full explanation");
  assert.match(finalPost.body, /reason=no_commit: HEAD is unchanged from base_commit/);
});

test("Variant 2: evidence=none and exit 1 creates an outcome when the run outcome is null", async () => {
  const { baseCommit, finalPost, state } = await runNoCommitScenario({
    id: "28-v2",
    evidence: "none",
    exitCode: 1,
    skipOutcome: true,
  });
  assert.equal(state.head, baseCommit, "fixture must leave HEAD at the starting commit");
  assert.equal(state.base_commit, baseCommit);
  assert.equal(state.state, "FAILED");
  assert.equal(state.publish, "pushed", "publish remains an action result; outcome distinguishes no work");
  assert.equal(state.harness_stop, null);
  assert.equal(state.limit_tripped, null);
  assert.equal(state.outcome?.no_commit, true, "outcome should have no_commit boolean");
  assert.equal(state.outcome?.reason, expectedReason(baseCommit), "reason should contain full explanation");
  assert.match(finalPost.body, /reason=no_commit: HEAD is unchanged from base_commit/);
});


test("Change 1: no-commit with evidence=pr and exit 0, outcome DONE must refuse COMPLETED state", async () => {
  const { baseCommit, state } = await runNoCommitScenario({
    id: "28-change1",
    evidence: "pr",
    exitCode: 0,
    skipOutcome: false,
  });
  assert.equal(state.head, baseCommit);
  assert.equal(state.base_commit, baseCommit);
  // CRITICAL FIX: no-commit run that would have been COMPLETED is now UNVERIFIED
  assert.notEqual(state.state, "COMPLETED", "no-commit run must NOT be COMPLETED even with pr evidence");
  assert.equal(state.state, "UNVERIFIED", "no-commit without commit must be UNVERIFIED (work did not land)");
  assert.equal(state.outcome?.no_commit, true);
});

test("Change 2: no-commit run that hits a blocker preserves no_commit flag", async () => {
  // Simulate a run that produces no commit AND has a blocker condition.
  // This tests that noCommitOutcome is applied AFTER blocker/fence outcomes.
  const { baseCommit, state } = await runNoCommitScenario({
    id: "28-change2-blocker",
    evidence: "none",
    exitCode: 1,
    skipOutcome: false,
  });
  assert.equal(state.head, baseCommit, "head unchanged means no commit");
  // Both conditions present: no_commit from the run + blocker from exit code
  // no_commit must survive and mark the outcome
  assert.equal(state.outcome?.no_commit, true, "no_commit flag must persist even with blocker/error conditions");
});


test("Regression: restart with commits on both attempts must NOT be no_commit", async () => {
  // This tests the fix for: base_commit being re-captured per-attempt caused false positives on restart.
  // When attempt 1 commits (normal behavior) and attempt 2 restarts (also making commits),
  // the no-commit detection would incorrectly fire because it compared against attempt 2's baseCommit
  // (which was the current HEAD after attempt 1's commit) instead of the original task base.
  const fixture = new WorkerTestFixture("restart-no-commit");
  try {
    const { origin } = fixture.createRepo("test", "repo");
    const originalBase = execFileSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).trim();
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: "restart-nc",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "restart with commits",
      body: "repo: test/repo\nevidence: pr\n\nTask that will restart",
      ts: "2026-08-29T20:00:00Z",
      posted_by: "scheduler",
    }]);

    // Attempt 1: start and kill mid-run
    const child1 = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      {
        env: fixture.getEnv({ FAKE_VINCI_SLEEP: "500" }),
        stdio: "pipe",
      },
    );
    while (fixture.getVinciCalls().length === 0) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 100));
    child1.kill("SIGTERM");
    await new Promise(r => { child1.once("close", r); });

    // Attempt 2: restart and complete successfully
    const child2 = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      {
        env: fixture.getEnv(),
        stdio: "pipe",
      },
    );
    assert.equal(await new Promise(resolveClose => child2.once("close", resolveClose)), 0);

    const state = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", "restart-nc.json"), "utf8"));
    
    // Verify both attempts exist
    assert.equal(state.attempt, 2, "should have executed attempt 2");
    // Verify head is different from original base (commits were made)
    assert.notEqual(state.head, originalBase, "commits were made, so HEAD should advance");
    // Verify NO false positive no_commit flag
    assert.notEqual(state.outcome?.no_commit, true, "restart with commits must NOT be flagged no_commit");
    // Verify successful state despite having restarted
    assert.equal(state.state, "COMPLETED", "restart attempt with commits should complete successfully");
  } finally {
    await fixture.cleanup();
  }
});

