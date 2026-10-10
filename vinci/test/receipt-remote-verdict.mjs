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

const remoteResult = (status, overrides = {}) => ({
  schemaVersion: 1,
  status,
  summary: `Remote verification returned ${status}`,
  snapshotDigest: "digest-1",
  jobId: "job-1",
  recordedAtIso: "2026-08-02T10:00:00.000Z",
  staled: false,
  ...overrides,
});

function freshState() {
  stateModule.resetVinciVerificationState();
  return stateModule.getVinciVerificationState();
}

// A failed attempt for the same snapshot and job never displaces an issued conditional verdict.
{
  const conditional = stateModule.applyRemoteVerdict(freshState(), remoteResult("CONDITIONAL"));
  const afterFailed = stateModule.applyRemoteVerdict(
    conditional,
    remoteResult("FAILED", { recordedAtIso: "2026-08-02T11:00:00.000Z" }),
  );
  assert.equal(
    stateModule.currentRemoteVerdict(afterFailed)?.status,
    "CONDITIONAL",
    "FAILED attempt must not overwrite the issued CONDITIONAL verdict",
  );
  assert.deepEqual(afterFailed.remoteVerificationAttempts?.map(({ outcome }) => outcome), ["FAILED"]);
  assert.deepEqual(Object.values(afterFailed.remoteAcceptanceVerdicts ?? {}).map(({ status }) => status), ["CONDITIONAL"]);
  console.log("ok (1) CONDITIONAL survives FAILED for the same snapshot and job");
}

// A cancelled attempt is retained as history without displacing a verified pass.
{
  const passed = stateModule.applyRemoteVerdict(freshState(), remoteResult("VERIFIED_PASS"));
  const afterCancelled = stateModule.applyRemoteVerdict(
    passed,
    remoteResult("CANCELLED", { recordedAtIso: "2026-08-02T11:00:00.000Z" }),
  );
  assert.equal(stateModule.currentRemoteVerdict(afterCancelled)?.status, "VERIFIED_PASS");
  assert.deepEqual(afterCancelled.remoteVerificationAttempts?.map(({ outcome }) => outcome), ["CANCELLED"]);
  console.log("ok (2) VERIFIED_PASS survives CANCELLED for the same snapshot and job");
}

// An attempt can precede the first issued verdict without becoming one itself.
{
  const failed = stateModule.applyRemoteVerdict(freshState(), remoteResult("FAILED"));
  assert.equal(stateModule.currentRemoteVerdict(failed), undefined);
  const conditional = stateModule.applyRemoteVerdict(
    failed,
    remoteResult("CONDITIONAL", { recordedAtIso: "2026-08-02T11:00:00.000Z" }),
  );
  assert.equal(stateModule.currentRemoteVerdict(conditional)?.status, "CONDITIONAL");
  assert.deepEqual(conditional.remoteVerificationAttempts?.map(({ outcome }) => outcome), ["FAILED"]);
  console.log("ok (3) FAILED history survives the first issued CONDITIONAL verdict");
}

// Mutations stale issued verdicts but leave attempt history byte-for-byte unchanged.
{
  const issued = stateModule.applyRemoteVerdict(freshState(), remoteResult("BLOCKED"));
  const withAttempt = stateModule.applyRemoteVerdict(
    issued,
    remoteResult("FAILED", { jobId: "job-2", recordedAtIso: "2026-08-02T11:00:00.000Z" }),
  );
  const attemptsBefore = JSON.parse(JSON.stringify(withAttempt.remoteVerificationAttempts));
  stateModule.restoreVinciVerificationState(withAttempt);
  stateModule.recordVinciMutation();
  const staled = stateModule.getVinciVerificationState();
  assert.equal(stateModule.currentRemoteVerdict(staled), undefined);
  assert(Object.values(staled.remoteAcceptanceVerdicts ?? {}).every(({ staled }) => staled));
  assert.deepEqual(staled.remoteVerificationAttempts, attemptsBefore);
  console.log("ok (4) staling leaves remote verification attempts untouched");
}

// Schema-v1 state written before the split migrates failed pseudo-verdicts into attempt history.
{
  const oldState = JSON.parse(JSON.stringify(freshState()));
  const legacyFailed = remoteResult("FAILED", { reportUrl: "https://example.invalid/job-1" });
  oldState.remoteAcceptanceVerdicts = {
    [JSON.stringify([legacyFailed.snapshotDigest, legacyFailed.jobId])]: legacyFailed,
  };
  const parsed = stateModule.parseVinciVerificationState(oldState);
  assert(parsed, "legacy state containing FAILED should parse");
  assert.equal(stateModule.currentRemoteVerdict(parsed), undefined);
  assert.deepEqual(parsed.remoteVerificationAttempts, [{
    jobId: "job-1",
    snapshotDigest: "digest-1",
    outcome: "FAILED",
    summary: "Remote verification returned FAILED",
    reportUrl: "https://example.invalid/job-1",
    recordedAtIso: "2026-08-02T10:00:00.000Z",
  }]);
  assert.deepEqual(parsed.remoteAcceptanceVerdicts, {});
  console.log("ok (5) legacy FAILED pseudo-verdict migrates into attempt history");
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
  const d = display({ state: "BLOCKED", reason: "Local gate open" }, { status: "VERIFIED_PASS", staled: true, summary: "All criteria verified" });
  assert.equal(d.state, "BLOCKED", "staled verdict never overrides local state");
  assert(d.reason.includes("A verification from before your latest changes found: All criteria verified"), "staled context line present");
  console.log("ok (display) staled verdict adds context, local outcome wins");
}
console.log("receipt-remote-verdict: passed");
