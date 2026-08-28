// Test (W0.3): TaskLifecycle enforces the transition table. Every illegal edge throws;
// the legal PENDING -> RUNNING -> terminal sequence succeeds; a terminal record is immutable.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertTransition, LIFECYCLE_STATES, TaskLifecycle } from "../worker/task.mjs";

const TERMINALS = ["COMPLETED", "UNVERIFIED", "BLOCKED", "FAILED"];
const ENVELOPE = { evidence: "pr", provider: "openrouter", model: "glm" };
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function fresh(taskId, fn) {
  const dir = mkdtempSync(join(tmpdir(), "worker-lifecycle-table-"));
  try {
    const lifecycle = new TaskLifecycle(dir, taskId);
    lifecycle.startAttempt({ id: taskId, envelope: ENVELOPE }, "test");
    return fn(lifecycle, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function illegal(from, to) {
  return { message: `illegal transition ${from} → ${to}` };
}

test("the table exposes exactly PENDING, RUNNING and the four terminals", () => {
  assert.deepEqual([...LIFECYCLE_STATES].sort(), ["PENDING", "RUNNING", ...TERMINALS].sort());
});

test("legal sequence PENDING -> RUNNING -> COMPLETED succeeds and is persisted", () => {
  fresh("legal", (lifecycle, dir) => {
    assert.equal(lifecycle.snapshot().state, "PENDING");
    lifecycle.transition("RUNNING");
    assert.equal(lifecycle.snapshot().state, "RUNNING");
    assert.equal(lifecycle.isTerminal(), false, "RUNNING is non-terminal so a crashed run resumes");
    lifecycle.transition("COMPLETED", { pr: "https://example.invalid/pr/1" });
    const onDisk = JSON.parse(readFileSync(join(dir, "tasks", "legal.json"), "utf8"));
    assert.equal(onDisk.state, "COMPLETED");
    assert.equal(onDisk.terminal, true);
    assert.equal(typeof onDisk.finished_at, "string");
    assert.equal(onDisk.pr, "https://example.invalid/pr/1");
  });
});

test("RUNNING may reach every terminal state", () => {
  for (const terminal of TERMINALS) {
    fresh(`run-${terminal}`, (lifecycle) => {
      lifecycle.transition("RUNNING");
      lifecycle.transition(terminal);
      assert.equal(lifecycle.snapshot().state, terminal);
      assert.equal(lifecycle.isTerminal(), true);
    });
  }
});

test("PENDING may fail fast to BLOCKED or FAILED, but never to COMPLETED/UNVERIFIED", () => {
  for (const state of ["BLOCKED", "FAILED"]) {
    fresh(`fast-${state}`, (lifecycle) => {
      lifecycle.transition(state, { outcome: { reason: "deadline is in the past" } });
      assert.equal(lifecycle.snapshot().state, state);
    });
  }
  for (const state of ["COMPLETED", "UNVERIFIED"]) {
    fresh(`skip-${state}`, (lifecycle) => {
      assert.throws(() => lifecycle.transition(state), illegal("PENDING", state));
      assert.equal(lifecycle.snapshot().state, "PENDING", "a rejected transition must not mutate state");
    });
  }
});

test("every terminal -> anything (including itself and RUNNING/PENDING) throws", () => {
  for (const terminal of TERMINALS) {
    fresh(`term-${terminal}`, (lifecycle, dir) => {
      lifecycle.transition("RUNNING");
      lifecycle.transition(terminal);
      const before = readFileSync(join(dir, "tasks", `term-${terminal}.json`), "utf8");
      for (const next of ["PENDING", "RUNNING", ...TERMINALS]) {
        assert.throws(() => lifecycle.transition(next), illegal(terminal, next));
      }
      assert.throws(() => lifecycle.record({ pr: "late" }), /illegal update of terminal state/);
      assert.equal(readFileSync(join(dir, "tasks", `term-${terminal}.json`), "utf8"), before, "terminal file is immutable");
    });
  }
});

test("self-transitions and RUNNING -> PENDING are illegal", () => {
  fresh("self", (lifecycle) => {
    assert.throws(() => lifecycle.transition("PENDING"), illegal("PENDING", "PENDING"));
    lifecycle.transition("RUNNING");
    assert.throws(() => lifecycle.transition("RUNNING"), illegal("RUNNING", "RUNNING"));
    assert.throws(() => lifecycle.transition("PENDING"), illegal("RUNNING", "PENDING"));
  });
});

test("unknown state names throw (target and source)", () => {
  fresh("unknown", (lifecycle) => {
    for (const bogus of ["CLAIMED", "EVIDENCE_PENDING", "DONE", "", "completed"]) {
      assert.throws(() => lifecycle.transition(bogus), { message: `unknown lifecycle state: ${bogus}` });
    }
  });
  assert.throws(() => assertTransition("NOPE", "RUNNING"), { message: "unknown lifecycle state: NOPE" });
  assert.throws(() => assertTransition("PENDING", undefined), /unknown lifecycle state/);
});

test("plan() previews the terminal snapshot without writing it", () => {
  fresh("plan", (lifecycle, dir) => {
    lifecycle.transition("RUNNING");
    const planned = lifecycle.plan("COMPLETED", { pr: "x" });
    assert.equal(planned.state, "COMPLETED");
    assert.equal(planned.terminal, true);
    assert.equal(typeof planned.finished_at, "string");
    const onDisk = JSON.parse(readFileSync(join(dir, "tasks", "plan.json"), "utf8"));
    assert.equal(onDisk.state, "RUNNING", "plan() must not persist");
    assert.equal(lifecycle.snapshot().state, "RUNNING");
    assert.throws(() => lifecycle.plan("PENDING"), illegal("RUNNING", "PENDING"));
    lifecycle.transition("COMPLETED", planned);
    assert.equal(lifecycle.snapshot().finished_at, planned.finished_at, "committed snapshot equals the planned one");
  });
});

test("record() updates fields in place and keeps the state", () => {
  fresh("record", (lifecycle) => {
    lifecycle.record({ lease: { ttl: 5 } });
    assert.equal(lifecycle.snapshot().state, "PENDING");
    assert.equal(lifecycle.snapshot().lease.ttl, 5);
    lifecycle.transition("RUNNING");
    lifecycle.record({ head: "abc", state: "COMPLETED" });
    assert.equal(lifecycle.snapshot().state, "RUNNING", "record() must not smuggle a state change");
    assert.equal(lifecycle.snapshot().head, "abc");
  });
});

test("a RUNNING record reloaded from disk is non-terminal and resumes into a new attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-lifecycle-table-"));
  try {
    const first = new TaskLifecycle(dir, "resume");
    first.startAttempt({ id: "resume", envelope: ENVELOPE }, "test");
    first.transition("RUNNING");
    const reloaded = new TaskLifecycle(dir, "resume");
    assert.equal(reloaded.isTerminal(), false);
    const attempt = reloaded.startAttempt({ id: "resume", envelope: ENVELOPE }, "test");
    assert.equal(attempt.attempt, 2);
    assert.equal(attempt.firstAttempt, false);
    assert.equal(reloaded.snapshot().state, "PENDING");
    reloaded.transition("RUNNING");
    reloaded.transition("COMPLETED");
    const done = new TaskLifecycle(dir, "resume");
    assert.equal(done.isTerminal(), true);
    assert.throws(
      () => done.startAttempt({ id: "resume", envelope: ENVELOPE }, "test"),
      { message: "cannot start an attempt on terminal state COMPLETED" },
      "startAttempt guards terminal records itself",
    );
    assert.equal(done.snapshot().attempt, 2, "a refused attempt must not bump the counter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nWorker lifecycle table: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
