/**
 * The verdict/attempt vocabulary Code accepts on the wire, as LOCAL runtime values.
 *
 * The private contracts package (vinci-contracts) remains the single source of these semantics.
 * This module defines its types and runtime values locally so the public tree needs no private
 * dependency, even for typechecking. vinci/test/private-contracts-drift.mjs compares the local
 * arrays and membership wrappers with the package's runtime exports; its private-only tsgo pin
 * checks the types. vinci/test/canonical-verdicts-contract.mjs tests the local values independently.
 *
 * WHY NO VALUE IMPORT. The package is a private GitHub Packages dependency that the public tarball
 * deliberately excludes (vinci/package.sh, check-no-contracts-at-runtime.sh). 0.0.51 imported
 * `RUN_STATES` and `VERDICT_STATUSES` from it here, at runtime, and failed on EVERY launch with
 * `ERR_MODULE_NOT_FOUND: Cannot find package` naming that private scope. The guard now treats the
 * scope's name ANYWHERE in a shipped file as a violation, so this comment does not spell it either.
 *
 * The "build-time inlining" doctrine (vinci/docs/verification.md) was true only for the esbuild
 * bundles under vinci/dist/extensions. This file is ALSO reached on a second path that nothing
 * inlines: packages/coding-agent/src/core/vinci-grader.ts imports
 * `../../../../vinci/extensions/lib/verification-contract.ts`, so the coding-agent tsgo build emits
 * plain, un-bundled `vinci/extensions/lib/{verification-contract,canonical-verdicts}.js` beside the
 * sources (see vinci/extensions/lib/.gitignore), package.sh ships `vinci/extensions` whole, and the
 * core's `dist/core/vinci-grader.js` loads THOSE copies — bare import intact. A runtime value import
 * anywhere in this file therefore ships to users no matter what the bundler does, which is why
 * private package dependencies must stay in the private-only drift checks.
 */

type RunState =
  | "CREATED"
  | "PLANNING"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_USER"
  | "PAUSED"
  | "VERIFYING"
  | "DONE"
  | "DONE_UNVERIFIED"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";
type VerdictStatus = (typeof VERDICT_STATUS_VALUES)[number];
type CanonicalAttemptStatus = (typeof ATTEMPT_STATUS_VALUES)[number];
type VerificationOutcome =
  | { readonly kind: "issued"; readonly status: VerdictStatus; readonly staled: boolean }
  | { readonly kind: "not-issued"; readonly reason: CanonicalAttemptStatus };

/**
 * What a verifier can actually issue (contracts `VERDICT_STATUSES`). Order matters: consumers and
 * tests compare this array to the package's with deepEqual, not as a set.
 */
const VERDICT_STATUS_VALUES = ["VERIFIED_PASS", "CONDITIONAL", "BLOCKED"] as const;
export const VERDICT_STATUSES: readonly VerdictStatus[] = Object.freeze([...VERDICT_STATUS_VALUES]);

/**
 * The verification JOB's own terminal states (contracts `VerificationOutcome["reason"]`): says
 * nothing about the work. Kept in `RUN_STATES` order (FAILED before CANCELLED), which is the order
 * the previous `RUN_STATES.filter(...)` derivation produced.
 */
const ATTEMPT_STATUS_VALUES = ["FAILED", "CANCELLED"] as const;
export const ATTEMPT_STATUSES: readonly CanonicalAttemptStatus[] = Object.freeze([...ATTEMPT_STATUS_VALUES]);

export const ACCEPTED_WIRE_STATUSES: readonly (VerdictStatus | CanonicalAttemptStatus)[] = Object.freeze([
  ...VERDICT_STATUSES,
  ...ATTEMPT_STATUSES,
]);

export function isVerdictStatus(value: unknown): value is VerdictStatus {
  return typeof value === "string" && VERDICT_STATUSES.some((status) => status === value);
}

export function isAttemptStatus(value: unknown): value is CanonicalAttemptStatus {
  return typeof value === "string" && ATTEMPT_STATUSES.some((status) => status === value);
}

export function isAcceptedWireStatus(
  value: unknown,
): value is (typeof ACCEPTED_WIRE_STATUSES)[number] {
  return ACCEPTED_WIRE_STATUSES.some((status) => status === value);
}

// Local consistency checks. Equality with the package is pinned only by the private drift check.
type AttemptStatusIsCanonicalRunState = CanonicalAttemptStatus extends RunState ? true : false;
const _attemptStatusIsCanonicalRunState: AttemptStatusIsCanonicalRunState = true;
void _attemptStatusIsCanonicalRunState;

// Keep the local unions complete; private-contracts-drift.types.ts pins them to the package unions.
type LocalVerdictStatus = (typeof VERDICT_STATUS_VALUES)[number];
type LocalAttemptStatus = (typeof ATTEMPT_STATUS_VALUES)[number];
type VerdictVocabularyIsComplete = [VerdictStatus] extends [LocalVerdictStatus] ? true : false;
type AttemptVocabularyIsComplete = [CanonicalAttemptStatus] extends [LocalAttemptStatus] ? true : false;
const _verdictVocabularyIsComplete: VerdictVocabularyIsComplete = true;
const _attemptVocabularyIsComplete: AttemptVocabularyIsComplete = true;
void _verdictVocabularyIsComplete;
void _attemptVocabularyIsComplete;

export type { CanonicalAttemptStatus, RunState, VerdictStatus, VerificationOutcome };
