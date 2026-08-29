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
