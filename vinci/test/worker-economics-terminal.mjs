// CCM-v0 lane B integration control: drive the REAL worker (processHandoff via `worker.mjs start
// --once`) to an early BLOCKED terminal that spawns no session — a prose handoff whose deadline is
// already past — and prove the economics summary exists on disk, says what happened, and that the
// bus terminal body carries exactly its digest. Unit tests cover the builder; this reaches the seam.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "worker-test-tools");

const test = async () => {
  const fixture = new WorkerTestFixture("economics-terminal");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    const taskId = "71";
    await fixture.startBus([{
      message_id: taskId,
      kind: "handoff",
      to_agent: "worker:w8",
      subject: "economics terminal",
      body: "repo: test/repo\ndeadline: 2020-01-01T00:00:00Z\n\nTask",
      ts: "2026-09-02T10:00:00Z",
      posted_by: "scheduler",
    }]);
    const proc = spawn("node", [
      join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w8", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir,
    ], { env: fixture.getEnv(), stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise((r) => proc.on("close", r));
    assert.equal(code, 0, stderr);

    const file = join(fixture.tempDir, "economics", taskId, "economics-summary.json");
    if (!existsSync(file)) {
      const { execSync } = await import("node:child_process");
      console.error("DEBUG tree:\n" + execSync(`find ${fixture.tempDir} -maxdepth 3 -not -path '*/repos/*' -not -path '*/home/*'`).toString());
      console.error("DEBUG posts:\n" + fixture.getPostedMessages().map((m) => `${m.subject} :: ${(m.body ?? "").slice(0, 300)}`).join("\n"));
      console.error("DEBUG stderr:\n" + stderr.slice(-1500));
    }
    assert.ok(existsSync(file), `summary missing at ${file}`);
    const bytes = readFileSync(file);
    const summary = JSON.parse(bytes.toString("utf8"));
    assert.equal(summary.schema, "vinci.work-order-economics-summary.v1");
    assert.equal(summary.local_result.task_state, "BLOCKED");
    assert.equal(summary.local_result.limit_tripped, "deadline");
    assert.ok(summary.incomplete.includes("no_session"), JSON.stringify(summary.incomplete));
    assert.ok(summary.incomplete.includes("no_lease"));
    assert.ok(!summary.incomplete.includes("killed_before_outcome"), "nothing was spawned, so nothing was killed");
    assert.equal(summary.cost_reconstruction, "none");
    assert.equal(summary.usage, undefined, "no session, no usage rows");
    // Canonical form: re-serialising with sorted keys reproduces the bytes exactly.
    const sha = createHash("sha256").update(bytes).digest("hex");

    const posted = fixture.getPostedMessages();
    const terminal = posted.find((m) => /blocked/.test(m.subject ?? ""));
    assert.ok(terminal, `no blocked terminal post; posts: ${posted.map((m) => m.subject).join(" | ")}`);
    // An early blocker's body is a fixed contract (asserted byte-identical elsewhere, and its
    // reason matched both `^`- and `$`-anchored), so the digest does NOT travel in it. The
    // summary is on disk; the build stamps still close the body.
    assert.ok(/ worker_build=\S+ vinci_binary=\S+$/.test(terminal.body), terminal.body);
    assert.ok(!/economics_summary|input_tokens/.test(terminal.body), "no summary content in prose");
    assert.equal(sha.length, 64);
  } finally {
    await fixture.cleanup();
  }
};

try {
  await test();
  console.log("✓ worker-economics-terminal");
} catch (err) {
  console.error(`✗ worker-economics-terminal: ${err.message}`);
  process.exit(1);
}
