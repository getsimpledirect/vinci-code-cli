import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const verification = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), {
  default: false,
});
const outcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), {
  default: false,
});

const remoteVerdict = (status, overrides = {}) => ({
  schemaVersion: 1,
  jobId: "acceptance-job-1",
  snapshotDigest: "sha256:snapshot-1",
  status,
  summary: `Remote acceptance returned ${status}.`,
  reportUrl: "https://acceptance.example.invalid/jobs/acceptance-job-1",
  eventCursor: "events:42",
  recordedAtIso: "2026-08-02T12:00:00.000Z",
  staled: false,
  ...overrides,
});

function localState(status) {
  verification.resetVinciVerificationState();
  verification.recordVinciMutation();
  verification.recordVinciVerification("npm test", status === "passed", `Local check ${status}.`);
  return verification.getVinciVerificationState();
}

function storedVerdict(state) {
  const records = Object.values(state.remoteAcceptanceVerdicts ?? {});
  assert.equal(records.length, 1);
  return records[0];
}

const table = [
  ["VERIFIED_PASS", "DONE"],
  ["CONDITIONAL", "DONE_UNVERIFIED"],
  ["BLOCKED", "BLOCKED"],
  ["FAILED", "DONE_UNVERIFIED"],
];

for (const [remoteStatus, taskState] of table) {
  const state = verification.applyRemoteVerdict(localState("failed"), remoteVerdict(remoteStatus));
  assert.equal(outcome.remoteVerdictTaskState(storedVerdict(state)), taskState);
  assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], state).state, taskState);
}
assert.equal(outcome.remoteVerdictTaskState(undefined), undefined);
assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], localState("passed")).state, "DONE");

// A live verdict is authoritative whether it agrees with or conflicts with the local latch.
for (const localStatus of ["passed", "failed"]) {
  const passState = verification.applyRemoteVerdict(localState(localStatus), remoteVerdict("VERIFIED_PASS"));
  assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], passState).state, "DONE");
}
const conflictingBlock = verification.applyRemoteVerdict(localState("passed"), remoteVerdict("BLOCKED"));
assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], conflictingBlock).state, "BLOCKED");

// FAILED is Vinci-owned and cannot turn the service summary into user blame.
const failed = verification.applyRemoteVerdict(
  localState("passed"),
  remoteVerdict("FAILED", { summary: "The user supplied a bad change." }),
);
const failedOutcome = outcome.classifyVinciTaskState([], ["src/change.ts"], failed);
assert.equal(failedOutcome.state, "DONE_UNVERIFIED");
assert.match(failedOutcome.reason, /^Vinci /);
assert.doesNotMatch(failedOutcome.reason, /user supplied/i);

// Mutation preserves the verdict record, stales it, and resumes local-latch classification.
const accepted = verification.applyRemoteVerdict(localState("passed"), remoteVerdict("VERIFIED_PASS"));
verification.restoreVinciVerificationState(accepted);
verification.recordVinciMutation();
const mutated = verification.getVinciVerificationState();
const acceptedVerdict = storedVerdict(accepted);
const mutatedVerdict = storedVerdict(mutated);
assert.equal(mutatedVerdict.staled, true);
assert.equal(mutatedVerdict.jobId, acceptedVerdict.jobId);
assert.equal(mutatedVerdict.snapshotDigest, acceptedVerdict.snapshotDigest);
assert.equal(outcome.remoteVerdictTaskState(mutatedVerdict), undefined);
assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], mutated).state, "DONE_UNVERIFIED");

// The staled marker is durable across parser + store restart paths.
const restarted = verification.parseVinciVerificationState(JSON.parse(JSON.stringify(mutated)));
assert.equal(storedVerdict(restarted).staled, true);
verification.resetVinciVerificationState();
verification.restoreVinciVerificationState(restarted);
assert.equal(storedVerdict(verification.getVinciVerificationState()).staled, true);

// Schema-v1 snapshots written before the additive field still parse and round-trip unchanged.
const oldState = localState("passed");
assert.equal("remoteAcceptanceVerdicts" in oldState, false);
const oldRoundTrip = verification.parseVinciVerificationState(JSON.parse(JSON.stringify(oldState)));
assert.deepEqual(oldRoundTrip, oldState);

// CANCELLED is a no-op: it cannot erase or replace the prior verdict.
const prior = verification.applyRemoteVerdict(oldState, remoteVerdict("CONDITIONAL"));
const cancelled = verification.applyRemoteVerdict(
  prior,
  remoteVerdict("CANCELLED", { jobId: "acceptance-job-2", snapshotDigest: "sha256:snapshot-2" }),
);
assert.strictEqual(cancelled, prior);
assert.equal(outcome.remoteVerdictTaskState(remoteVerdict("CANCELLED")), undefined);

// Recording and staling are display-only: local latch/job identity remain intact; no job is created.
assert.equal(prior.status, oldState.status);
assert.equal(mutatedVerdict.jobId, "acceptance-job-1");
assert.equal(mutatedVerdict.staled, true);
assert.deepEqual(
  Object.keys(mutated).filter((key) => /submit|dispatch|queue/i.test(key)),
  [],
);

// The verification-state recording API owns the persisted envelope fields.
verification.resetVinciVerificationState();
const recordedAfter = new Date().toISOString();
assert.equal(
  verification.recordRemoteAcceptanceVerdict({
    status: "CONDITIONAL",
    summary: "Recorded by verification state",
    snapshotDigest: "sha256:state-api",
    jobId: "acceptance-state-job",
    eventCursor: "events:99",
  }),
  true,
);
const stateApiRecord = Object.values(verification.getVinciVerificationState().remoteAcceptanceVerdicts ?? {})[0];
assert.equal(stateApiRecord.schemaVersion, 1);
assert.equal(stateApiRecord.staled, false);
assert(stateApiRecord.recordedAtIso >= recordedAfter);
assert.equal(stateApiRecord.eventCursor, "events:99");

// The real accept-tool control path validates, stores, persists, and survives restoration.
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
verification.resetVinciVerificationState();
let persisted = 0;
control.setVinciPersistVerification(() => persisted++);
assert.equal(
  control.recordRemoteAcceptanceVerdict({
    status: "VERIFIED_PASS",
    summary: "Recorded through control",
    snapshotDigest: "sha256:control-path",
    jobId: "acceptance-control-job",
    reportUrl: "https://acceptance.example.invalid/jobs/acceptance-control-job",
  }),
  true,
);
const controlState = verification.getVinciVerificationState();
const controlRecord = Object.values(controlState.remoteAcceptanceVerdicts ?? {})[0];
assert.equal(controlRecord.schemaVersion, 1);
assert.equal(controlRecord.staled, false);
assert.match(controlRecord.recordedAtIso, /^\d{4}-\d{2}-\d{2}T/);
assert.equal(persisted, 1, "successful remote verdict recording must persist state");
const controlRoundTrip = verification.parseVinciVerificationState(JSON.parse(JSON.stringify(controlState)));
verification.resetVinciVerificationState();
verification.restoreVinciVerificationState(controlRoundTrip);
assert.deepEqual(verification.getVinciVerificationState(), controlState);
assert.equal(
  verification.recordRemoteAcceptanceVerdict({
    status: "VERIFIED_PASS",
    summary: "invalid runtime input",
    snapshotDigest: undefined,
    jobId: "invalid-job",
  }),
  false,
);
control.setVinciPersistVerification(null);

console.log("remote-verdict-integration: passed");

// #171 split precedence: the RECEIPT shows the remote verdict, but local evidence decides the
// headless exit code. A remote pass must never report success on a run whose own check failed.
{
  const failedLocallyRemotePass = verification.applyRemoteVerdict(localState("failed"), remoteVerdict("VERIFIED_PASS"));
  assert.equal(
    outcome.classifyVinciTaskState([], ["src/change.ts"], failedLocallyRemotePass).state,
    "DONE",
    "display still follows the live remote verdict",
  );
  assert.equal(
    outcome.classifyVinciLocalTaskState([], ["src/change.ts"], failedLocallyRemotePass).state,
    "BLOCKED",
    "local evidence still says blocked — this is what the exit code follows",
  );

  // The inverse must not regress: a remote block on locally-clean work still blocks.
  const passedLocallyRemoteBlock = verification.applyRemoteVerdict(localState("passed"), remoteVerdict("BLOCKED"));
  assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], passedLocallyRemoteBlock).state, "BLOCKED");

  // And a clean run stays clean on both axes.
  const cleanBoth = verification.applyRemoteVerdict(localState("passed"), remoteVerdict("VERIFIED_PASS"));
  assert.equal(outcome.classifyVinciTaskState([], ["src/change.ts"], cleanBoth).state, "DONE");
  assert.equal(outcome.classifyVinciLocalTaskState([], ["src/change.ts"], cleanBoth).state, "DONE");
}
console.log("remote-verdict-integration: split precedence (display vs exit code) is binding");
