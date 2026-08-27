import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const fixture = new WorkerTestFixture("exit-recheck");
try {
  fixture.createRepo("test", "repo");
  fixture.linkTools(TOOLS);
  await fixture.startBus([{
    message_id: "12",
    to_agent: "worker:exit-worker",
    kind: "handoff",
    subject: "exit budget",
    body: "repo: test/repo\nevidence: none\nbudget_usd: 1\n\nTask",
    ts: "2026-08-26T12:00:00Z",
    posted_by: "scheduler",
  }]);
  const started = Date.now();
  const child = spawn(
    "node",
    [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "exit-worker", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
    { env: fixture.getEnv({ FAKE_VINCI_USAGE_AT_EXIT: "1", VINCI_WORKER_LIMIT_POLL_MS: "15000" }), stdio: "pipe" },
  );
  assert.equal(await new Promise((resolveClose) => child.once("close", resolveClose)), 0);
  assert.ok(Date.now() - started < 15_000, "fixture must exit before the periodic budget poll");
  const state = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", "12.json"), "utf8"));
  assert.equal(state.state, "FAILED");
  assert.equal(state.limit_tripped, "budget_usd");
} finally {
  await fixture.cleanup();
}

process.stdout.write("✓ worker-exit-budget-recheck\n");
