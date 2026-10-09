import assert from "node:assert/strict";
import {
  RUN_STATES,
  VERDICT_STATUSES,
  terminalStateOfVerification,
} from "@getsimpledirect/vinci-contracts";

const ACCEPTED_ATTEMPT_STATUSES = RUN_STATES.filter(
  (status) => status === "FAILED" || status === "CANCELLED",
);

const result = (status, overrides = {}) => ({
  schemaVersion: 1,
  status,
  summary: `Remote verification returned ${status}`,
  snapshotDigest: "digest-contract-vocabulary",
  jobId: "job-contract-vocabulary",
  recordedAtIso: "2026-08-27T12:00:00.000Z",
  staled: false,
  ...overrides,
});

export function runVocabularyAssertions(
  { acceptModule, outcomeModule, receiptModule, sourceModules, stateModule },
  suiteName,
) {
  assert.deepEqual(
    stateModule.VERDICT_STATUSES,
    VERDICT_STATUSES,
    "Exposed VERDICT_STATUSES must match the installed contract",
  );
  assert.deepEqual(
    stateModule.ATTEMPT_STATUSES,
    ACCEPTED_ATTEMPT_STATUSES,
    "Exposed ATTEMPT_STATUSES must match the accepted canonical attempts",
  );
  console.log("ok (1) exposed verdict and attempt sets match the installed contract");

  for (const [index, status] of VERDICT_STATUSES.entries()) {
    stateModule.resetVinciVerificationState();
    assert.equal(
      stateModule.recordRemoteAcceptanceVerdict({
        status,
        summary: `Canonical verdict ${status}`,
        snapshotDigest: `digest-verdict-${index}`,
        jobId: `job-verdict-${index}`,
      }),
      true,
      `${status} must be accepted on the wire`,
    );
    assert.equal(
      stateModule.currentRemoteVerdict(stateModule.getVinciVerificationState())?.status,
      status,
      `${status} must become the current remote verdict`,
    );
    assert.equal(
      acceptModule.isTerminalVerdictStatus(status),
      true,
      `vinci-accept gate must accept canonical wire status ${status}`,
    );
    const expectedState = terminalStateOfVerification({ kind: "issued", status, staled: false });
    assert.equal(
      outcomeModule.remoteVerdictTaskState({ status, staled: false }),
      expectedState,
      `task-outcome must classify canonical verdict ${status} through the contract`,
    );
    assert.equal(
      receiptModule.remoteVerdictDisplay(
        { state: "WAITING", reason: "Local outcome" },
        { status, staled: false, summary: "Remote outcome" },
      ).state,
      expectedState,
      `vinci-receipt must classify canonical verdict ${status} through task-outcome`,
    );
  }
  console.log(`ok (2) all ${VERDICT_STATUSES.length} canonical verdict statuses cross every production gate`);

  for (const [index, status] of ACCEPTED_ATTEMPT_STATUSES.entries()) {
    assert.equal(
      stateModule.isAttemptStatus(status),
      true,
      `${status} must remain a canonical attempt in ${suiteName}`,
    );
    assert.equal(
      acceptModule.isTerminalVerdictStatus(status),
      true,
      `vinci-accept gate must accept canonical wire status ${status}`,
    );
    assert.equal(
      outcomeModule.remoteVerdictTaskState({ status, staled: false }),
      undefined,
      `${status} attempt must not classify as a verdict task outcome`,
    );
    stateModule.resetVinciVerificationState();
    assert.equal(
      stateModule.recordRemoteAcceptanceVerdict({
        status: "CONDITIONAL",
        summary: "Issued conditional verdict",
        snapshotDigest: `digest-attempt-${index}`,
        jobId: `job-attempt-${index}`,
      }),
      true,
    );
    const afterAttempt = stateModule.applyRemoteVerdict(
      stateModule.getVinciVerificationState(),
      result(status, {
        snapshotDigest: `digest-attempt-${index}`,
        jobId: `job-attempt-${index}`,
        recordedAtIso: "2026-08-27T12:01:00.000Z",
      }),
    );
    assert.equal(
      stateModule.currentRemoteVerdict(afterAttempt)?.status,
      "CONDITIONAL",
      `${status} attempt must not overwrite the issued CONDITIONAL verdict`,
    );
    assert.equal(
      Object.values(afterAttempt.remoteAcceptanceVerdicts ?? {}).some((verdict) => verdict.status === status),
      false,
      `${status} attempt must never become an issued verdict`,
    );
  }
  console.log("ok (3) FAILED and CANCELLED remain attempts across accept and outcome layers");

  for (const status of RUN_STATES) {
    assert.equal(
      acceptModule.isTerminalVerdictStatus(status),
      VERDICT_STATUSES.includes(status) || ACCEPTED_ATTEMPT_STATUSES.includes(status),
      `vinci-accept gate must derive RUN_STATE ${status} from canonical sets`,
    );
  }

  const canonicalCandidates = [...new Set([...VERDICT_STATUSES, ...RUN_STATES])];
  const codeAcceptedStatuses = canonicalCandidates.filter((status, index) => {
    stateModule.resetVinciVerificationState();
    return stateModule.recordRemoteAcceptanceVerdict({
      status,
      summary: `Wire probe for ${status}`,
      snapshotDigest: `digest-wire-probe-${index}`,
      jobId: `job-wire-probe-${index}`,
    });
  });
  const expectedWireStatuses = [...VERDICT_STATUSES, ...ACCEPTED_ATTEMPT_STATUSES];
  assert.deepEqual(
    new Set(codeAcceptedStatuses),
    new Set(expectedWireStatuses),
    "Code's wire statuses must equal canonical VERDICT_STATUSES plus FAILED and CANCELLED attempts",
  );
  console.log(`ok (4) wire vocabulary matches ${expectedWireStatuses.length} canonical verdict/attempt statuses`);

  if (sourceModules) {
    assert.match(
      sourceModules.accept,
      /isAcceptedWireStatus\(status\)/,
      "vinci-accept gate must call the canonical accepted-wire predicate",
    );
    assert.doesNotMatch(
      sourceModules.accept,
      /["'](?:VERIFIED_PASS|CONDITIONAL|BLOCKED|FAILED|CANCELLED)["']/,
      "vinci-accept gate must not carry a literal status list",
    );
    assert.match(
      sourceModules.outcome,
      /isAttemptStatus\(record\.status\).*isVerdictStatus\(record\.status\)/s,
      "task-outcome must gate its mapping with canonical attempt and verdict predicates",
    );
    assert.doesNotMatch(
      sourceModules.outcome,
      /switch\s*\(record\.status\)/,
      "task-outcome must not restore a hand-written verdict switch",
    );
    assert.match(
      sourceModules.receipt,
      /remoteVerdictTaskState\(remoteVerdict\)/,
      "vinci-receipt must reuse the canonical task-outcome mapping",
    );
    assert.doesNotMatch(
      sourceModules.receipt,
      /case\s+["'](?:VERIFIED_PASS|CONDITIONAL|BLOCKED)["']/,
      "vinci-receipt must not restore a hand-written verdict switch",
    );
    console.log("ok (5) accept, task-outcome, and receipt carry no independent status classifiers");
  }
  console.log(`✓ ${suiteName}: all tests passed`);
}
