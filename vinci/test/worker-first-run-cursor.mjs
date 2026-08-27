// A fresh state dir (no cursor.json) must NOT replay bus history: the first live start on
// 2026-08-27 claimed 56 historical broadcast handoffs. The first run writes a cursor at NOW
// and runs nothing that predates it; a handoff posted after that cursor does run, once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = join(ROOT, "vinci/bin/vinci");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
process.env.VINCI_TEST_NO_CURSOR_SEED = "1";
const historical = { message_id: "old1", to_agent: "w1", kind: "handoff", subject: "old", body: "repo: test/repo\nevidence: none\n\nold task", ts: "2026-08-26T10:00:00Z", posted_by: "x" };
const f = new WorkerTestFixture("first-run-cursor");
// async spawn: the fixture's fake bus lives in THIS event loop; a spawnSync would block it and
// the daemon would see ECONNRESET (learned the hard way writing this test).
const run = () => new Promise((resolve) => {
  const child = spawn("bash", [LAUNCHER, "worker", "start", "--id", "w1", "--server", f.busUrl(), "--once", "--state-dir", f.tempDir], { env: f.getEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  child.on("exit", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
});
try {
  rmSync(join(f.tempDir, "cursor.json"), { force: true });
  f.linkTools(TOOLS); f.createRepo("test", "repo"); await f.startBus([historical]);
  const before = new Date().toISOString();
  let r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.getVinciCalls().length, 0, "historical handoff must not run on a fresh state dir");
  assert.ok(existsSync(join(f.tempDir, "cursor.json")), "first run must persist a cursor");
  const cursor = JSON.parse(readFileSync(join(f.tempDir, "cursor.json"), "utf8")).w1;
  assert.ok(cursor.ts >= before, `cursor must start at now, got ${cursor.ts}`);

  // A handoff posted AFTER the cursor, on the same live bus: runs exactly once.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  f.busMessages.push({ ...historical, message_id: "new1", subject: "new", ts: new Date().toISOString() });
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.getVinciCalls().length, 1, "a handoff after the cursor must run exactly once");
  r = await run();
  assert.equal(f.getVinciCalls().length, 1, "a terminal task must never run twice");
  console.log("PASS worker-first-run-cursor");
} finally {
  await f.cleanup();
}
