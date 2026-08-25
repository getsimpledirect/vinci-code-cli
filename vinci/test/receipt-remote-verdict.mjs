import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

const stateModule = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });

const receiptCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-remote-verdict-"));
writeFileSync(resolve(receiptCwd, "file.ts"), "export const value = 1;\n");

// Test 1: applyRemoteVerdict stores VERIFIED_PASS verdict
{
  const currentState = stateModule.getVinciVerificationState();
  const verdict = {
    status: "VERIFIED_PASS",
    summary: "All checks passed",
    snapshotDigest: "abc123",
    jobId: "job-123",
  };
  const nextState = stateModule.applyRemoteVerdict(currentState, verdict);
  assert(nextState.remoteAcceptanceVerdicts !== undefined, "remote verdicts should exist");
  const verdictKeys = Object.keys(nextState.remoteAcceptanceVerdicts);
  assert(verdictKeys.length > 0, "verdict should be stored");
  console.log("ok (1) VERIFIED_PASS verdict recorded");
}

// Test 2: applyRemoteVerdict handles CONDITIONAL verdict
{
  const currentState = stateModule.getVinciVerificationState();
  const verdict = {
    status: "CONDITIONAL",
    summary: "Some conditions not met",
    snapshotDigest: "def456",
    jobId: "job-124",
  };
  const nextState = stateModule.applyRemoteVerdict(currentState, verdict);
  assert(nextState.remoteAcceptanceVerdicts !== undefined, "remote verdicts should exist");
  console.log("ok (2) CONDITIONAL verdict recorded");
}

// Test 3: remoteAcceptanceVerdictKey generates consistent keys
{
  const verdict1 = {
    status: "VERIFIED_PASS",
    summary: "pass",
    snapshotDigest: "digest1",
    jobId: "job-1",
  };
  const verdict2 = {
    status: "VERIFIED_PASS",
    summary: "pass",
    snapshotDigest: "digest1",
    jobId: "job-1",
  };
  
  const state1 = stateModule.applyRemoteVerdict(stateModule.getVinciVerificationState(), verdict1);
  const state2 = stateModule.applyRemoteVerdict(state1, verdict2);
  
  // Same verdict should overwrite (same key), not add a duplicate
  const keys1 = Object.keys(state1.remoteAcceptanceVerdicts || {});
  const keys2 = Object.keys(state2.remoteAcceptanceVerdicts || {});
  assert.equal(keys1.length, keys2.length, "same verdict should overwrite, not duplicate");
  console.log("ok (3) verdictKey consistency verified");
}

// Test 4: CANCELLED verdict is skipped
{
  const currentState = stateModule.getVinciVerificationState();
  const countBefore = Object.keys(currentState.remoteAcceptanceVerdicts || {}).length;
  
  const cancelledVerdict = {
    status: "CANCELLED",
    summary: "job cancelled",
    snapshotDigest: "can123",
    jobId: "job-125",
  };
  const nextState = stateModule.applyRemoteVerdict(currentState, cancelledVerdict);
  const countAfter = Object.keys(nextState.remoteAcceptanceVerdicts || {}).length;
  
  // CANCELLED should not be recorded per Wave 5 decision
  assert.equal(countAfter, countBefore, "CANCELLED verdict should not be stored");
  console.log("ok (4) CANCELLED verdict skipped per design");
}

// Clean up
rmSync(receiptCwd, { recursive: true, force: true });
console.log("✓ receipt-remote-verdict.mjs: all tests passed");

// Receipt display decisions (the four D10 cases, through the real receipt code)
const receiptModule = await loader.import(resolve(here, "../extensions/vinci-receipt.ts"), { default: false });
const display = receiptModule.remoteVerdictDisplay;
const localOutcome = { state: "DONE", reason: "All local checks passed" };

{
  stateModule.resetVinciVerificationState();
  const oldVerdict = {
    schemaVersion: 1,
    status: "BLOCKED",
    summary: "Old blocker",
    snapshotDigest: "old-digest",
    jobId: "old-job",
    recordedAtIso: "2026-08-02T10:00:00.000Z",
    staled: false,
  };
  const newVerdict = {
    schemaVersion: 1,
    status: "VERIFIED_PASS",
    summary: "Newest pass",
    snapshotDigest: "new-digest",
    jobId: "new-job",
    recordedAtIso: "2026-08-02T11:00:00.000Z",
    staled: false,
  };
  const withOld = stateModule.applyRemoteVerdict(stateModule.getVinciVerificationState(), oldVerdict);
  stateModule.restoreVinciVerificationState(stateModule.applyRemoteVerdict(withOld, newVerdict));
  assert.equal(receiptModule.getLatestRemoteVerdict().jobId, "new-job", "receipt must use newest verdict");
  console.log("ok (display) newest recorded verdict selected");
}

{
  const d = display(localOutcome, { status: "VERIFIED_PASS", staled: false, summary: "All criteria verified" });
  assert.equal(d.state, "DONE");
  assert.equal(d.reason, "All criteria verified");
  console.log("ok (display) VERIFIED_PASS -> DONE with verdict summary");
}
{
  const d = display(localOutcome, { status: "CONDITIONAL", staled: false, summary: "Could not fully verify" });
  assert.equal(d.state, "DONE_UNVERIFIED", "remote CONDITIONAL beats local DONE");
  console.log("ok (display) CONDITIONAL overrides local -> DONE_UNVERIFIED");
}
{
  const d = display(localOutcome, { status: "FAILED", staled: false, summary: "runner exploded: user code is broken" });
  assert.equal(d.state, "DONE_UNVERIFIED");
  assert(!d.reason.includes("user code"), "FAILED copy is Vinci-owned, never blames user code");
  assert(!d.reason.includes("exploded"), "raw failure detail never surfaces in the receipt");
  console.log("ok (display) FAILED shows Vinci-owned copy");
}
{
  const d = display({ state: "BLOCKED", reason: "Local gate open" }, { status: "VERIFIED_PASS", staled: true, summary: "All criteria verified" });
  assert.equal(d.state, "BLOCKED", "staled verdict never overrides local state");
  assert(d.reason.includes("A verification from before your latest changes found: All criteria verified"), "staled context line present");
  console.log("ok (display) staled verdict adds context, local outcome wins");
}
console.log("receipt-remote-verdict: passed");
