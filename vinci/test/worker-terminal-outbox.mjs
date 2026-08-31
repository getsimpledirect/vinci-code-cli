// An undelivered terminal record is a failure that became invisible.
//
// The worker transitions its lifecycle to a terminal state and THEN announces it
// on the bus. Those steps are not atomic and nothing caught a throw between
// them, so a transient bus failure left the task terminal and unannounced -- and
// a restart skipped it precisely BECAUSE it was already terminal. The record was
// lost permanently. Typed terminal outcomes exist so a failure stays VISIBLE
// without becoming an open decision; undelivered, it is neither.
//
// Found by an adversarial review of PR #44, reproduced before being fixed.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BusClient } from "../worker/bus.mjs";
import { DEFAULT_OUTBOX_DIR, listPending, replayPending } from "../worker/outbox.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "vinci-outbox-"));
}

// A bus that cannot reach anything: 127.0.0.1:9 is the discard port.
function unreachableBus(dir) {
  return new BusClient("http://127.0.0.1:9/nope", "t", 100, dir);
}

test("a terminal post that FAILS leaves a durable record", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(
    () => bus.postTerminal("status", "task X failed", "body", { outcome: "FAILED" }),
  );
  const pending = listPending(dir);
  assert.equal(pending.length, 1, "the undelivered terminal must be on disk");
  assert.equal(pending[0].entry.options.outcome, "FAILED");
  assert.equal(pending[0].entry.subject, "task X failed");
  assert.equal(pending[0].entry.kind, "status");
});

test("a terminal post that SUCCEEDS leaves nothing behind", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  // Replace the transport, keeping postTerminal's own logic under test.
  bus.post = async () => ({ ok: true });
  await bus.postTerminal("status", "task Y done", "body", { outcome: "COMPLETED" });
  assert.equal(listPending(dir).length, 0, "a delivered record must not linger");
});

test("an invalid outcome is refused BEFORE anything is written", async () => {
  // Otherwise the outbox accumulates records that can never be replayed
  // validly, and the enum guard would be weaker than it looks.
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(
    () => bus.postTerminal("status", "s", "b", { outcome: "NOT_A_REAL_OUTCOME" }),
    /typed outcome/,
  );
  assert.equal(listPending(dir).length, 0, "a refused post must write nothing");
});

test("replay delivers what was undelivered, then clears it", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(() => bus.postTerminal("status", "s1", "b", { outcome: "BLOCKED" }));
  await assert.rejects(() => bus.postTerminal("status", "s2", "b", { outcome: "UNVERIFIED" }));
  assert.equal(listPending(dir).length, 2);

  const delivered = [];
  const good = { post: async (k, s, b, o) => { delivered.push([s, o.outcome]); } };
  const summary = await replayPending(good, dir, { warn() {}, error() {} });

  assert.equal(summary.delivered, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(delivered.map((d) => d[1]).sort(), ["BLOCKED", "UNVERIFIED"]);
  assert.equal(listPending(dir).length, 0, "delivered records must be cleared");
});

test("replay that STILL fails keeps the record rather than dropping it", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(() => bus.postTerminal("status", "s", "b", { outcome: "FAILED" }));

  const stillBroken = { post: async () => { throw new Error("bus down"); } };
  const summary = await replayPending(stillBroken, dir, { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(listPending(dir).length, 1, "a failed replay must NOT discard the record");
});

test("a corrupt record is reported, never silently dropped", async () => {
  // A record we cannot read is still evidence that something terminal went
  // unannounced. Deleting it would destroy the only trace.
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(() => bus.postTerminal("status", "s", "b", { outcome: "FAILED" }));
  const [name] = readdirSync(dir);
  writeFileSync(join(dir, name), "{ this is not json");

  const errors = [];
  const summary = await replayPending(
    { post: async () => {} }, dir, { warn() {}, error: (m) => errors.push(m) },
  );
  assert.equal(summary.corrupt, 1);
  assert.equal(summary.delivered, 0);
  assert.match(errors.join("\n"), /UNREADABLE/);
  assert.equal(listPending(dir).length, 1, "a corrupt record must be kept");
});

test("the bus records into ITS OWN directory, not the process cwd", async () => {
  // The first version of this fix wrote to a cwd-based default while the
  // worker replayed from --state-dir/outbox: records parked in one place and
  // replayed from another is an inert fix that looks like a working one.
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(() => bus.postTerminal("status", "s", "b", { outcome: "FAILED" }));
  assert.equal(bus.outboxDir, dir);
  assert.equal(listPending(dir).length, 1);
  assert.notEqual(dir, DEFAULT_OUTBOX_DIR);
});
