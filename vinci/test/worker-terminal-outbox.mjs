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
import {
  DEFAULT_OUTBOX_DIR,
  DUPLICATE_DELIVERY,
  listPending,
  recordPending,
  replayPending,
} from "../worker/outbox.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "vinci-outbox-"));
}

// A bus that cannot reach anything: 127.0.0.1:9 is the discard port.
function unreachableBus(dir) {
  return new BusClient("http://127.0.0.1:9/nope", "t", 100, dir, "worker:test");
}

function recordTerminal(dir, subject, outcome, inReplyTo = null) {
  return recordPending({
    kind: "status",
    subject,
    body: "body",
    options: { outcome, ...(inReplyTo === null ? {} : { inReplyTo }) },
    expected_posted_by: "worker:test",
  }, dir);
}

test("a terminal post without authenticated server provenance writes nothing", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  await assert.rejects(
    () => bus.postTerminal("status", "task X failed", "body", { outcome: "FAILED" }),
    /authenticated worker posting-principal binding/,
  );
  assert.equal(listPending(dir).length, 0, "a client-configured worker id is not authenticated provenance");
});

test("a pending terminal record carries the authenticated principal binding", () => {
  const dir = join(scratch(), "outbox");
  recordTerminal(dir, "task Y done", "COMPLETED");
  const [pending] = listPending(dir);
  assert.equal(pending.entry.expected_posted_by, "worker:test");
  assert.equal(pending.entry.options.outcome, "COMPLETED");
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
  recordTerminal(dir, "s1", "BLOCKED");
  recordTerminal(dir, "s2", "UNVERIFIED");
  assert.equal(listPending(dir).length, 2);

  const delivered = [];
  const good = {
    findTerminalDeliveries: async () => [],
    post: async (k, s, b, o) => { delivered.push([s, o.outcome]); },
  };
  const summary = await replayPending(good, dir, { warn() {}, error() {} });

  assert.equal(summary.delivered, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(delivered.map((d) => d[1]).sort(), ["BLOCKED", "UNVERIFIED"]);
  assert.equal(listPending(dir).length, 0, "delivered records must be cleared");
});

test("replay that STILL fails keeps the record rather than dropping it", async () => {
  const dir = join(scratch(), "outbox");
  recordTerminal(dir, "s", "FAILED");

  const stillBroken = {
    findTerminalDeliveries: async () => [],
    post: async () => { throw new Error("bus down"); },
  };
  const summary = await replayPending(stillBroken, dir, { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(listPending(dir).length, 1, "a failed replay must NOT discard the record");
});

test("a corrupt record is reported, never silently dropped", async () => {
  // A record we cannot read is still evidence that something terminal went
  // unannounced. Deleting it would destroy the only trace.
  const dir = join(scratch(), "outbox");
  recordTerminal(dir, "s", "FAILED");
  const [name] = readdirSync(dir);
  writeFileSync(join(dir, name), "{ this is not json");

  const errors = [];
  const summary = await replayPending(
    { findTerminalDeliveries: async () => [], post: async () => {} },
    dir,
    { warn() {}, error: (m) => errors.push(m) },
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
  recordTerminal(bus.outboxDir, "s", "FAILED");
  assert.equal(bus.outboxDir, dir);
  assert.equal(listPending(dir).length, 1);
  assert.notEqual(dir, DEFAULT_OUTBOX_DIR);
});

test("one exact committed row reconciles ACK loss without a second POST", async () => {
  const dir = join(scratch(), "outbox");
  recordTerminal(dir, "task exact done", "COMPLETED", "msg_exact");

  let posts = 0;
  const summary = await replayPending({
    findTerminalDeliveries: async () => ["msg_terminal_1"],
    post: async () => { posts += 1; },
  }, dir, { warn() {}, error() {} });

  assert.equal(summary.reconciled, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.duplicate, 0);
  assert.equal(posts, 0, "an observed exact terminal effect must not be posted again");
  assert.equal(listPending(dir).length, 0);
});

test("two exact committed rows preserve a typed duplicate condition and post no third row", async () => {
  const dir = join(scratch(), "outbox");
  recordTerminal(dir, "task duplicate done", "COMPLETED", "msg_duplicate");

  let posts = 0;
  const errors = [];
  const summary = await replayPending({
    findTerminalDeliveries: async () => ["msg_terminal_1", "msg_terminal_2"],
    post: async () => { posts += 1; },
  }, dir, { warn() {}, error: (message) => errors.push(message) });

  assert.equal(summary.duplicate, 1);
  assert.equal(summary.reconciled, 0);
  assert.equal(summary.delivered, 0);
  assert.equal(posts, 0, "an existing duplicate must never grow to three rows");
  assert.equal(summary.conditions[0].type, DUPLICATE_DELIVERY);
  assert.equal(summary.conditions[0].exact_match_count, 2);
  assert.match(errors.join("\n"), /DUPLICATE_DELIVERY/);
  const [pending] = listPending(dir);
  assert.equal(pending.entry.delivery_condition.type, DUPLICATE_DELIVERY);
  assert.deepEqual(pending.entry.delivery_condition.message_ids, ["msg_terminal_1", "msg_terminal_2"]);
});

test("reconciliation failure retains the entry and posts nothing", async () => {
  const dir = join(scratch(), "outbox");
  recordTerminal(dir, "task uncertain", "FAILED", "msg_uncertain");

  let posts = 0;
  const summary = await replayPending({
    findTerminalDeliveries: async () => { throw new Error("pagination incomplete"); },
    post: async () => { posts += 1; },
  }, dir, { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(posts, 0, "an incomplete observation is not proof of absence");
  assert.equal(listPending(dir).length, 1);
});

test("a legacy pending record without authenticated provenance is retained, never adopted", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  recordTerminal(dir, "legacy", "FAILED", "msg_legacy");
  const [pending] = listPending(dir);
  delete pending.entry.expected_posted_by;
  writeFileSync(pending.path, JSON.stringify(pending.entry));

  let posts = 0;
  const summary = await replayPending(bus, dir, { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(posts, 0);
  assert.equal(listPending(dir).length, 1);
});

test("a pending record bound to another worker principal is retained", async () => {
  const dir = join(scratch(), "outbox");
  const bus = unreachableBus(dir);
  recordTerminal(dir, "other worker", "FAILED", "msg_other");
  const [pending] = listPending(dir);
  pending.entry.expected_posted_by = "worker:somebody-else";
  writeFileSync(pending.path, JSON.stringify(pending.entry));

  const summary = await replayPending(bus, dir, { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(listPending(dir).length, 1);
});
