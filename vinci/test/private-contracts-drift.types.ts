// Included ONLY by tsconfig.private-contracts-drift.json, never by a public check.
import type {
  RunState as ContractRunState,
  VerdictStatus as ContractVerdictStatus,
  VerificationOutcome as ContractVerificationOutcome,
} from "@getsimpledirect/vinci-contracts";
import type { ResolutionEvidence as ContractResolutionEvidence } from "@getsimpledirect/vinci-model-classes";
import type {
  CanonicalAttemptStatus,
  RunState,
  VerdictStatus,
  VerificationOutcome,
} from "../extensions/lib/canonical-verdicts.ts";
import type { ResolutionEvidence } from "../extensions/vinci-model-provenance.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2) ? true : false
    : false;
type Assert<Matches extends true> = Matches;

export type RunStatePin = Assert<Equal<RunState, ContractRunState>>;
export type VerdictStatusPin = Assert<Equal<VerdictStatus, ContractVerdictStatus>>;
export type AttemptStatusPin = Assert<Equal<CanonicalAttemptStatus, Extract<ContractVerificationOutcome, { kind: "not-issued" }>["reason"]>>;
export type VerificationOutcomePin = Assert<Equal<VerificationOutcome, ContractVerificationOutcome>>;
export type ResolutionEvidencePin = Assert<Equal<ResolutionEvidence, ContractResolutionEvidence>>;
