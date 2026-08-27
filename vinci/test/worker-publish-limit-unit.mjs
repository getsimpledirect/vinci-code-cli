import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock command function for testing
let commandCalls = [];
async function mockCommand(name, args, options = {}) {
  commandCalls.push({ name, args });
  if (name === "git" && args[2] === "push") {
    return { status: 0, stdout: "pushed", stderr: "" };
  }
  if (name === "git" && args[2] === "cat-file") {
    return { status: 1, stdout: "", stderr: "" };  // BLOCKER.md does not exist
  }
  if (name === "gh") {
    // gh pr create
    return { status: 0, stdout: "notice\nhttps://github.com/test/repo/pull/999\ntrailing", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
}

// ORIGINAL CODE (without limitTripped check) - simulates the bug
async function publishWithoutFix({ envelope, repoDir, branch, taskId, limitTripped, command }) {
  const blockerReason = null;
  const push = await command("git", ["-C", repoDir, "push", "--set-upstream", "origin", branch], {
    allowFailure: true,
  });
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (blockerReason) return { ...result, publish: push.status === 0 ? "blocked" : "push_failed", blocker_reason: blockerReason };
  // BUG: no check for limitTripped here - PR gets created even when limit is tripped!
  if (push.status !== 0 || envelope.evidence !== "pr") return result;

  const created = await command("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `Worker task ${taskId}`, "--body", `Unattended Vinci worker result for task ${taskId}.`], { cwd: repoDir, allowFailure: true });
  if (created.status === 0) result.pr = created.stdout.split("\n").find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(line)) ?? null;
  return result;
}

// FIXED CODE (with limitTripped check)
async function publishWithFix({ envelope, repoDir, branch, taskId, limitTripped, command }) {
  const blockerReason = null;
  const push = await command("git", ["-C", repoDir, "push", "--set-upstream", "origin", branch], {
    allowFailure: true,
  });
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (blockerReason) return { ...result, publish: push.status === 0 ? "blocked" : "push_failed", blocker_reason: blockerReason };
  if (limitTripped) return result;  // FIX: suppress PR when limitTripped
  if (push.status !== 0 || envelope.evidence !== "pr") return result;

  const created = await command("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `Worker task ${taskId}`, "--body", `Unattended Vinci worker result for task ${taskId}.`], { cwd: repoDir, allowFailure: true });
  if (created.status === 0) result.pr = created.stdout.split("\n").find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(line)) ?? null;
  return result;
}

const tempDir = mkdtempSync(join(tmpdir(), "worker-publish-limit-unit-"));
try {
  // FAIL-FIRST: Test (a) with original code - PR created despite limitTripped
  console.log("Testing ORIGINAL CODE (without fix)...");
  commandCalls = [];
  const result1old = await publishWithoutFix({
    envelope: { evidence: "pr" },
    repoDir: tempDir,
    branch: "worker/task1",
    taskId: "task1",
    limitTripped: "budget_usd",
    command: mockCommand,
  });
  assert.equal(result1old.publish, "pushed", "branch pushed (original)");
  // BUG: PR is created even though limit was tripped!
  assert.equal(result1old.pr, "https://github.com/test/repo/pull/999", "BUG: PR created despite limitTripped");
  assert.ok(commandCalls.some(c => c.name === "gh"), "BUG: gh pr create was called");
  console.log("✗ Original code creates PR when limitTripped (this is the bug)");

  // FIXED CODE: Test (a) - PR NOT created when limitTripped
  console.log("\nTesting FIXED CODE (with limitTripped check)...");
  commandCalls = [];
  const result1fixed = await publishWithFix({
    envelope: { evidence: "pr" },
    repoDir: tempDir,
    branch: "worker/task1",
    taskId: "task1",
    limitTripped: "budget_usd",
    command: mockCommand,
  });
  assert.equal(result1fixed.publish, "pushed", "branch must be pushed");
  assert.equal(result1fixed.pr, null, "PR must NOT be created when limitTripped");
  assert.deepEqual(commandCalls.filter(c => c.name === "gh"), [], "gh pr create must NOT be called when limitTripped");
  assert.ok(commandCalls.some(c => c.name === "git" && c.args[2] === "push"), "git push must still be called");
  console.log("✓ Fixed code suppresses PR when limitTripped");

  // Test (b): limitTripped null → PR created normally
  console.log("\nTesting FIXED CODE with no limit tripped...");
  commandCalls = [];
  const result2 = await publishWithFix({
    envelope: { evidence: "pr" },
    repoDir: tempDir,
    branch: "worker/task2",
    taskId: "task2",
    limitTripped: null,
    command: mockCommand,
  });
  assert.equal(result2.publish, "pushed", "branch pushed");
  assert.equal(result2.pr, "https://github.com/test/repo/pull/999", "PR created on normal completion");
  assert.ok(commandCalls.some(c => c.name === "gh"), "gh pr create must be called when limitTripped is null");
  console.log("✓ Fixed code creates PR when no limit tripped");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.stdout.write("\n✓ worker-publish-limit-tripped-unit\n");
