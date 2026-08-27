import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BusClient } from "../worker/bus.mjs";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const timestamp = "2026-08-26T10:00:00Z";

const fixture = new WorkerTestFixture("bus");
try {
  fixture.createRepo("test", "repo");
  fixture.linkTools(TOOLS);
  await fixture.startBus([
    { message_id: "1", to_agent: "w1", kind: "handoff", subject: "direct", body: "repo: test/repo\nevidence: none\nref: job_1\n\nTask one", ts: timestamp, posted_by: "scheduler" },
    { message_id: "2", to_agent: null, kind: "handoff", subject: "broadcast", body: "repo: test/repo\nevidence: none\nref: exp_2\n\nTask two", ts: timestamp, posted_by: "scheduler" },
    { message_id: "3", to_agent: "other", kind: "handoff", subject: "other", body: "repo: test/repo\nevidence: none\nref: bk_3\n\nIgnore", ts: timestamp, posted_by: "scheduler" },
  ]);

  const bus = new BusClient(fixture.busUrl(), "test-token", 2);
  const first = await bus.poll("w1", null);
  assert.deepEqual(first.map((message) => message.message_id), ["1"], "broadcast handoff 2 must NOT be selected for w1");
  assert.deepEqual(fixture.getRequests.map(({ offset }) => offset), [0, 2], "poll must page with limit/offset");

  fixture.getRequests = [];
  const reread = await bus.poll("w1", { ts: timestamp, message_ids: ["1"] });
  assert.deepEqual(reread, [], "inclusive equal-ts reread must dedupe by message_id");
  assert.deepEqual(fixture.getRequests.map(({ offset }) => offset), [0, 2]);

  const child = spawn(
    "node",
    [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
    { env: fixture.getEnv(), stdio: "pipe" },
  );
  const code = await new Promise((resolveClose) => child.once("close", resolveClose));
  assert.equal(code, 0);
  assert.equal(fixture.getVinciCalls().length, 1, "only the handoff ADDRESSED to this worker runs; broadcast and other-target handoffs must not");
  assert.deepEqual(
    fixture.getPostedMessages().filter((post) => post.kind === "finding").map((post) => post.refs),
    [["job_1"]],
  );
  const cursor = JSON.parse(readFileSync(join(fixture.tempDir, "cursor.json"), "utf8")).w1;
  assert.equal(cursor.ts, timestamp);
  assert.deepEqual(cursor.message_ids.sort(), ["1"]);
} finally {
  await fixture.cleanup();
}

process.stdout.write("✓ worker-bus-shape-targeting-paging-cursor\n");
