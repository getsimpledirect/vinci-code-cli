import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");

async function waitFor(predicate, description) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

const fixture = new WorkerTestFixture("lock");
try {
  fixture.createRepo("test", "repo");
  fixture.linkTools(TOOLS);
  await fixture.startBus([]);
  const args = [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "locked", "--server", fixture.busUrl(), "--state-dir", fixture.tempDir];
  const first = spawn("node", [...args, "--poll-seconds", "60"], { env: fixture.getEnv(), stdio: "pipe" });
  await waitFor(() => existsSync(join(fixture.tempDir, "daemon.lock")) && fixture.getRequests.length === 1, "first daemon lock and poll");
  const getsBeforeSecond = fixture.getRequests.length;
  const second = spawn("node", [...args, "--once"], { env: fixture.getEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let secondStderr = "";
  second.stderr.setEncoding("utf8");
  second.stderr.on("data", (chunk) => { secondStderr += chunk; });
  const secondCode = await new Promise((resolveClose) => second.once("close", resolveClose));
  assert.equal(secondCode, 75);
  assert.match(secondStderr, /daemon lock.*live pid/i);
  assert.equal(fixture.getRequests.length, getsBeforeSecond, "refused daemon must never touch the bus");

  first.kill("SIGTERM");
  await new Promise((resolveClose) => first.once("close", resolveClose));
  assert.equal(existsSync(join(fixture.tempDir, "daemon.lock")), false, "SIGTERM must remove daemon lock");

  fixture.busMessages = [{
    message_id: "11",
    to_agent: "locked",
    kind: "handoff",
    subject: "claimed elsewhere",
    body: "repo: test/repo\nevidence: none\nref: bk_11\n\nTask",
    ts: "2026-08-26T11:00:00Z",
    posted_by: "scheduler",
  }];
  const claim = join(fixture.tempDir, "tasks", "11.claim");
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "pid"), `${process.pid}\n`);
  const liveClaimRun = spawn("node", [...args, "--once"], { env: fixture.getEnv(), stdio: "pipe" });
  assert.equal(await new Promise((resolveClose) => liveClaimRun.once("close", resolveClose)), 0);
  assert.equal(fixture.getVinciCalls().length, 0);
  assert.equal(fixture.getPostedMessages().length, 0, "live task owner must suppress duplicate claim posts");

  writeFileSync(join(claim, "pid"), "99999999\n");
  const deadClaimRun = spawn("node", [...args, "--once"], { env: fixture.getEnv(), stdio: "pipe" });
  assert.equal(await new Promise((resolveClose) => deadClaimRun.once("close", resolveClose)), 0);
  assert.equal(fixture.getVinciCalls().length, 1, "dead task owner must be replaced and task resumed");
  assert.equal(fixture.getPostedMessages().filter((post) => post.subject === "task 11 claimed").length, 1);
} finally {
  await fixture.cleanup();
}

process.stdout.write("✓ worker-daemon-lock-and-task-claim\n");
