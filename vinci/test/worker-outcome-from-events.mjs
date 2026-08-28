// W0.4 "outcome from events, not narrative": machine-observed harness stops outrank the model's
// own outcome entry, and exit code zero alone never yields COMPLETED (issues #5 and #6).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { finalState } from "../worker/run.mjs";
import { HARNESS_STOP_PATTERNS, readSessionState } from "../worker/session-read.mjs";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const FIXTURES = join(ROOT, "vinci/test/fixtures");
const HARNESS_STOP_FIXTURE = join(FIXTURES, "worker-session-harness-stop.jsonl");
const CLEAN_FIXTURE = join(FIXTURES, "worker-session.jsonl");

const RESERVE_REASON = "Vinci reserved the remaining actions for implementation or an answer.";
const LATCH_REASON =
  "Vinci stopped autonomous changes after repeated no-progress attempts. Wait for the user's next instruction.";

// --- session-read: the fixture is the REAL serialized shape of a blocked tool call -----------------

{
  const directory = mkdtempSync(join(tmpdir(), "worker-harness-stop-"));
  try {
    const sessionId = "harness-stop-session";
    const excerpt = readFileSync(HARNESS_STOP_FIXTURE, "utf8").replaceAll("SESSION_ID", sessionId);
    writeFileSync(join(directory, "session.jsonl"), excerpt);
    const state = readSessionState(directory, sessionId);
    assert.equal(state.outcome.state, "DONE", "the narrative in the fixture says DONE");
    assert.deepEqual(
      state.harnessStops,
      [
        { index: 1, reason: RESERVE_REASON },
        { index: 2, reason: RESERVE_REASON },
      ],
      "every blocked toolResult entry must surface as a harness stop with its entry index",
    );
    assert.deepEqual(
      [...HARNESS_STOP_PATTERNS],
      ["Wait for the user's next instruction", "Vinci reserved the remaining actions", "Vinci stopped autonomous changes"],
    );

    // A successful (non-error) tool result that merely echoes the string is NOT a stop.
    const echoed = excerpt.replaceAll('"isError":true', '"isError":false');
    writeFileSync(join(directory, "session.jsonl"), echoed);
    assert.deepEqual(readSessionState(directory, sessionId).harnessStops, [], "only error-flagged results count");

    // Mutation guard: changing the stop text removes the observation entirely.
    writeFileSync(join(directory, "session.jsonl"), excerpt.replaceAll("Vinci reserved", "Vinci observed"));
    assert.deepEqual(readSessionState(directory, sessionId).harnessStops, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// --- daemon end to end ---------------------------------------------------------------------------

async function runScenario(name, workerId, { evidence, env, sessionFixture }) {
  const fixture = new WorkerTestFixture(`outcome-${name}`);
  try {
    fixture.createRepo("test", "repo");
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: name,
      to_agent: `worker:${workerId}`,
      kind: "handoff",
      subject: name,
      // budget_usd 20: the clean fixture carries $9.99 of real usage, which must not trip the $5 default.
      body: `repo: test/repo\nevidence: ${evidence}\nbudget_usd: 20\nref: job_${name}\n\nTask`,
      ts: "2026-08-28T12:00:00Z",
      posted_by: "scheduler",
    }]);
    const child = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", workerId, "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      {
        env: fixture.getEnv({ FAKE_VINCI_USAGE: "1", FAKE_VINCI_SESSION_FIXTURE: sessionFixture, ...env }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolveClose) => child.once("close", resolveClose));
    assert.equal(code, 0, `worker exited ${code}\n${stderr}`);
    return {
      state: JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${name}.json`), "utf8")),
      posts: fixture.getPostedMessages(),
      tempDir: fixture.tempDir,
    };
  } finally {
    await fixture.cleanup();
  }
}

// T1: the vinci-todo no-progress latch (issue #5) fires once, then the narrative says DONE and a PR
// gets created. Derived from the real reserve entries by swapping in the latch reason (same shape).
{
  const scratch = mkdtempSync(join(tmpdir(), "worker-latch-fixture-"));
  try {
    const lines = readFileSync(HARNESS_STOP_FIXTURE, "utf8").split("\n").filter(Boolean);
    const latch = [lines[0], lines[1].replaceAll(RESERVE_REASON, LATCH_REASON), lines[3]].join("\n") + "\n";
    const latchFixture = join(scratch, "latch.jsonl");
    writeFileSync(latchFixture, latch);
    const t1 = await runScenario("t1", "w1", { evidence: "pr", sessionFixture: latchFixture });
    assert.equal(t1.state.state, "BLOCKED", "T1: a latch block outranks DONE + PR");
    assert.equal(t1.state.pr, "https://github.com/test/repo/pull/123", "T1: the PR still exists; it just does not complete the task");
    assert.deepEqual(t1.state.harness_stop, { count: 1, reason: LATCH_REASON }, "T1: harness_stop recorded on the task");
    assert.equal(t1.state.outcome.state, "DONE", "T1: the narrative stays on the record next to the stop");
    const final = t1.posts.at(-1);
    assert.equal(final.kind, "blocker");
    assert.equal(final.subject, "task t1 blocked");
    assert.match(final.body, /stop=instrument/, "T1: the blocker post must say it was an instrument stop");
    assert.match(final.body, /harness_stops=1/);
    assert.ok(final.body.includes(`instrument stop: ${LATCH_REASON}`), `T1: the stop reason must ride in the post: ${final.body}`);
    assert.equal(t1.posts.filter((post) => post.kind === "finding").length, 0, "T1: no finding for a blocked task");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// T2: reserve refusal x2 (issue #6: git commit refused), narrative DONE, no PR => BLOCKED, not UNVERIFIED.
{
  const t2 = await runScenario("t2", "w2", { evidence: "none", sessionFixture: HARNESS_STOP_FIXTURE });
  assert.equal(t2.state.state, "BLOCKED", "T2: two reserve refusals block even with evidence: none");
  assert.equal(t2.state.pr, null);
  assert.deepEqual(t2.state.harness_stop, { count: 2, reason: RESERVE_REASON });
  const final = t2.posts.at(-1);
  assert.equal(final.kind, "blocker");
  assert.match(final.body, /stop=instrument harness_stops=2 /);
  assert.ok(final.body.includes(`instrument stop: ${RESERVE_REASON}`));
}

// T3: clean session, DONE, PR => COMPLETED (and a finding for the ledger ref).
{
  const t3 = await runScenario("t3", "w3", { evidence: "pr", sessionFixture: CLEAN_FIXTURE });
  assert.equal(t3.state.state, "COMPLETED");
  assert.equal(t3.state.harness_stop, null);
  assert.equal(t3.posts.at(-1).kind, "finding");
}

// T4: clean session, DONE, no PR, evidence: none => UNVERIFIED (produced, unassessed), never COMPLETED.
{
  const t4 = await runScenario("t4", "w4", { evidence: "none", sessionFixture: CLEAN_FIXTURE });
  assert.equal(t4.state.state, "UNVERIFIED", "T4: evidence: none on exit 0 is not completion");
  assert.equal(t4.state.pr, null);
  assert.equal(t4.state.harness_stop, null);
  assert.equal(t4.posts.at(-1).kind, "status");
  assert.equal(t4.posts.filter((post) => post.kind === "finding").length, 0, "T4: no finding without evidence");
}

// T5: exit 1 + harness stop => FAILED (exit/limit outrank the stop).
{
  const t5 = await runScenario("t5", "w5", { evidence: "pr", sessionFixture: HARNESS_STOP_FIXTURE, env: { FAKE_VINCI_EXIT: "1" } });
  assert.equal(t5.state.state, "FAILED");
  assert.equal(t5.state.exit_code, 1);
  assert.equal(t5.state.harness_stop, null, "T5: harness_stop is recorded only when it decided the state");
  assert.equal(t5.posts.at(-1).kind, "blocker");
  assert.doesNotMatch(t5.posts.at(-1).body, /stop=instrument/);
}

// --- finalState precedence (pure) ----------------------------------------------------------------

const done = { state: "DONE" };
const stop = [{ index: 1, reason: LATCH_REASON }];
assert.equal(finalState({ exitCode: 1, limitTripped: null, outcome: done, blocker: false, pr: "x", harnessStops: stop }), "FAILED");
assert.equal(finalState({ exitCode: 0, limitTripped: "budget_usd", outcome: done, blocker: false, pr: "x", harnessStops: [] }), "FAILED");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: done, blocker: false, pr: "x", harnessStops: stop }), "BLOCKED", "a harness stop outranks DONE + PR");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: { state: "WAITING" }, blocker: false, pr: "x", harnessStops: [] }), "BLOCKED");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: done, blocker: true, pr: null, harnessStops: [] }), "BLOCKED");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: { state: "DONE_UNVERIFIED" }, blocker: false, pr: "x", harnessStops: [] }), "UNVERIFIED");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: done, blocker: false, pr: "x", harnessStops: [] }), "COMPLETED");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: done, blocker: false, pr: null, harnessStops: [] }), "UNVERIFIED", "DONE without a PR is produced, not assessed");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: undefined, blocker: false, pr: null, harnessStops: [] }), "UNVERIFIED", "exit 0 with no outcome entry means nothing");
assert.equal(finalState({ exitCode: 0, limitTripped: null, outcome: undefined, blocker: false, pr: null, harnessStops: undefined }), "UNVERIFIED", "missing harnessStops must not throw");

process.stdout.write("✓ worker-outcome-from-events\n");
