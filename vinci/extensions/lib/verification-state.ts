/** Shared, verifier-owned completion state across Vinci's isolated extension loaders. */

import { isAbsolute } from "node:path";

import {
  parseSharedVinciVerificationState,
  remoteAcceptanceVerdictKey,
  selectSharedVinciVerificationState,
  VINCI_TERMINAL_UNVERIFIABLE_MESSAGE,
  VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE,
  VINCI_VERIFICATION_SCHEMA_VERSION,
  type SharedVinciNormalVerificationState,
  type RemoteAcceptanceVerdict,
  type SharedVinciTerminalUnverifiableState,
  type SharedVinciVerificationClass,
  type SharedVinciVerificationState,
  type SharedVinciVerificationStatus,
} from "./verification-contract.ts";

export const VINCI_VERIFICATION_ENTRY = "vinci-verification-state";
export {
  VINCI_TERMINAL_UNVERIFIABLE_MESSAGE,
  VINCI_VERIFICATION_SCHEMA_VERSION,
};

export type VinciVerificationStatus = SharedVinciVerificationStatus;
export type VinciVerificationClass = SharedVinciVerificationClass;
export type VinciNormalVerificationState = SharedVinciNormalVerificationState;
export type VinciTerminalUnverifiableState = SharedVinciTerminalUnverifiableState;
export type VinciVerificationState = SharedVinciVerificationState;
export type { RemoteAcceptanceVerdict };

export type RemoteAcceptanceVerdictInput = Omit<
  RemoteAcceptanceVerdict,
  "schemaVersion" | "recordedAtIso" | "staled"
>;

const RESET_STORE_STATE = Symbol.for("vinci.verification-state.reset");
const SET_STORE_STATE = Symbol.for("vinci.verification-state.set-internal");
const HYDRATE_STORE_STATE = Symbol.for("vinci.verification-state.hydrate");

type VinciVerificationStore = Readonly<{
  getState(): VinciVerificationState;
  setState(state: unknown): boolean;
  [SET_STORE_STATE](state: VinciVerificationState): void;
  [HYDRATE_STORE_STATE](state: unknown): boolean;
  [RESET_STORE_STATE](): void;
}>;

type BranchEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

const STORE_KEY = "__vinciVerificationStateStore" as const;
const MUTATION_DIGEST_OBSERVATION_KEY = "__vinciMutationDigestObservation" as const;

export type VinciMutationDigestObservation = Readonly<{
  trackedBroadDisagreements: number;
}>;

type MutableVinciMutationDigestObservation = {
  trackedBroadDisagreements: number;
};

type VinciGlobal = typeof globalThis & {
  [STORE_KEY]?: VinciVerificationStore;
  [MUTATION_DIGEST_OBSERVATION_KEY]?: MutableVinciMutationDigestObservation;
};
const vinciGlobal = globalThis as VinciGlobal;

function freezeState<T extends VinciVerificationState>(state: T): T {
  const remoteAcceptanceVerdicts = state.remoteAcceptanceVerdicts
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(state.remoteAcceptanceVerdicts).map(([key, verdict]) => [
            key,
            Object.freeze({ ...verdict }),
          ]),
        ),
      )
    : undefined;
  return Object.freeze({
    ...state,
    ...(remoteAcceptanceVerdicts ? { remoteAcceptanceVerdicts } : {}),
  }) as T;
}

function initialState(): VinciNormalVerificationState {
  return freezeState({
    schemaVersion: VINCI_VERIFICATION_SCHEMA_VERSION,
    variant: "normal",
    status: "none",
    command: "",
    summary: "",
    requiredCommand: "",
    requiredSummary: "",
    mutationRevision: 0,
    verifiedRevision: -1,
    recoveryAttempts: 0,
    behavioralEvidenceRequired: false,
    behavioralEvidenceReason: "",
    behavioralVerifiedRevision: -1,
    diffInspectedRevision: -1,
    checkWarrantedRevision: -1,
    checkClass: "static",
    commandKey: "",
    requiredCommandKey: "",
    commandKeyCanonical: true,
    isReplayable: true,
    behavioralAttemptCommand: "",
    behavioralAttemptCommandKey: "",
    behavioralAttemptCommandKeyCanonical: true,
    behavioralAttemptCompleted: true,
  });
}

function createStore(state: VinciVerificationState): VinciVerificationStore {
  let current = freezeState(state);
  const ingest = (candidate: unknown): boolean => {
    const parsed = parseSharedVinciVerificationState(candidate);
    if (parsed === undefined) {
      return false;
    }
    // In-process forgery is explicitly out of scope. Any code in this process can call the recording
    // functions directly, so guarding this store against hostile in-process callers buys nothing.
    // This state defends against crash/resume loss and corrupt persisted history.
    current = freezeState(parsed);
    return true;
  };
  return Object.freeze({
    getState: () => current,
    setState(candidate: unknown): boolean {
      return ingest(candidate);
    },
    [SET_STORE_STATE](nextState: VinciVerificationState): void {
      current = freezeState(nextState);
    },
    [HYDRATE_STORE_STATE](candidate: unknown): boolean {
      return ingest(candidate);
    },
    [RESET_STORE_STATE](): void {
      current = initialState();
    },
  });
}

const store = vinciGlobal[STORE_KEY] ?? createStore(initialState());
if (!vinciGlobal[STORE_KEY]) {
  Object.defineProperty(vinciGlobal, STORE_KEY, {
    value: store,
    writable: false,
    configurable: false,
  });
}
const mutationDigestObservation =
  vinciGlobal[MUTATION_DIGEST_OBSERVATION_KEY] ??
  Object.seal({ trackedBroadDisagreements: 0 });
if (!vinciGlobal[MUTATION_DIGEST_OBSERVATION_KEY]) {
  Object.defineProperty(vinciGlobal, MUTATION_DIGEST_OBSERVATION_KEY, {
    value: mutationDigestObservation,
    writable: false,
    configurable: false,
  });
}

function currentState(): VinciVerificationState {
  return store.getState();
}

export function getVinciVerificationState(): Readonly<VinciVerificationState> {
  return freezeState(currentState());
}

function setState(state: VinciVerificationState): void {
  store[SET_STORE_STATE](state);
}

export function resetVinciVerificationState(): void {
  store[RESET_STORE_STATE]();
}

export function getVinciMutationDigestObservation(): VinciMutationDigestObservation {
  return Object.freeze({ ...mutationDigestObservation });
}

export function recordVinciMutationDigestDisagreement(): void {
  mutationDigestObservation.trackedBroadDisagreements++;
}

export function resetVinciMutationDigestObservation(): void {
  mutationDigestObservation.trackedBroadDisagreements = 0;
}

export function parseVinciVerificationState(data: unknown): VinciVerificationState | undefined {
  return parseSharedVinciVerificationState(data);
}

/** Validates and normalizes a session-persisted snapshot before it is trusted. */
export function isVinciVerificationState(data: unknown): boolean {
  return parseVinciVerificationState(data) !== undefined;
}

/** One shared newest-valid selection rule for verification, crew, and grader readers. */
export function scanVinciVerificationStateBranch(
  branch: readonly BranchEntry[],
): VinciVerificationState | undefined {
  return selectSharedVinciVerificationState(branch);
}

export function restoreVinciVerificationState(state: unknown): void {
  store.setState(state);
}

/** Hydrates one scanner-validated snapshot after session_start has established a fresh local state. */
export function hydrateVinciVerificationState(state: unknown): void {
  store[HYDRATE_STORE_STATE](state);
}

function normalState(): VinciNormalVerificationState | undefined {
  const state = currentState();
  return state.variant === "normal" ? state : undefined;
}

export function vinciVerificationCommand(
  state: Readonly<VinciVerificationState> = currentState(),
): string {
  return state.variant === "normal" ? state.command : "";
}

export function vinciRequiredVerificationCommand(
  state: Readonly<VinciVerificationState> = currentState(),
): string {
  return state.variant === "normal" ? state.requiredCommand : "";
}

export function vinciVerificationCheckClass(
  state: Readonly<VinciVerificationState> = currentState(),
): VinciVerificationClass {
  return state.variant === "terminal-unverifiable" ? "behavioral" : state.checkClass;
}

export function vinciVerificationMutationRevision(
  state: Readonly<VinciVerificationState> = currentState(),
): number {
  return state.mutationRevision;
}

export function applyRemoteVerdict(
  state: VinciVerificationState,
  verdict: RemoteAcceptanceVerdict,
): VinciVerificationState {
  // D10 CANCELLED is deliberately a no-op: it does not erase or supersede the prior record.
  if (verdict.status === "CANCELLED") return state;
  const key = remoteAcceptanceVerdictKey(verdict);
  return freezeState({
    ...state,
    remoteAcceptanceVerdicts: {
      ...state.remoteAcceptanceVerdicts,
      [key]: { ...verdict },
    },
  });
}

/** Builds, validates, and records a remote verdict in the live verification store. */
export function recordRemoteAcceptanceVerdict(verdict: RemoteAcceptanceVerdictInput): boolean {
  const completeVerdict: RemoteAcceptanceVerdict = {
    ...verdict,
    schemaVersion: VINCI_VERIFICATION_SCHEMA_VERSION,
    recordedAtIso: new Date().toISOString(),
    staled: false,
  };
  const key = remoteAcceptanceVerdictKey(completeVerdict);
  const state = currentState();
  const parsedState = parseSharedVinciVerificationState({
    ...state,
    remoteAcceptanceVerdicts: {
      ...state.remoteAcceptanceVerdicts,
      [key]: completeVerdict,
    },
  });
  const parsedVerdict = parsedState?.remoteAcceptanceVerdicts?.[key];
  if (!parsedVerdict) return false;
  setState(applyRemoteVerdict(state, parsedVerdict));
  return true;
}

function staleRemoteAcceptanceVerdicts(
  state: Readonly<VinciVerificationState>,
): VinciVerificationState["remoteAcceptanceVerdicts"] {
  if (!state.remoteAcceptanceVerdicts) return undefined;
  return Object.fromEntries(
    Object.entries(state.remoteAcceptanceVerdicts).map(([key, verdict]) => [
      key,
      verdict.staled ? verdict : { ...verdict, staled: true },
    ]),
  );
}

/**
 * Does a change to this path warrant a project check? The lane's doc-exclusion rule, shared so
 * every mutation recorder can answer for the paths IT knows (#187). One heuristic, one place.
 */
export function vinciCheckWarrantedPath(path: string): boolean {
  return !/\.(?:md|mdx|txt|rst)$/i.test(path.trim());
}

/**
 * `checkWarranted` is the explicit "#187 fact": true means the caller KNOWS this mutation touched
 * something check-worthy; false means it doesn't know or knows it didn't. mutationRevision itself
 * is a shared staleness counter — undo bumps it for any revert, the bash digest path bumps it for
 * tracked doc edits — so it must never be read as "a check was warranted" (that mistake shipped
 * once and was caught in review producing affirmatively false receipts on doc-only sessions).
 */
export function recordVinciMutation(behavioralEvidenceReason = "", checkWarranted = false): void {
  const current = currentState();
  const remoteAcceptanceVerdicts = staleRemoteAcceptanceVerdicts(current);
  if (current.variant === "terminal-unverifiable") {
    if (remoteAcceptanceVerdicts) setState({ ...current, remoteAcceptanceVerdicts });
    return;
  }
  const state = current;
  const mutationRevision = state.mutationRevision + 1;
  setState({
    ...state,
    status: "stale",
    command: state.requiredCommand || state.command,
    commandKey: state.requiredCommandKey || state.commandKey,
    commandKeyCanonical: state.requiredCommand
      ? state.commandKeyCanonical
      : state.commandKeyCanonical,
    summary: state.requiredCommand
      ? `The code changed after a failed required check. Rerun ${state.requiredCommand}.`
      : state.command
        ? "The code changed after the last recorded check."
        : "The latest code change has not been verified.",
    mutationRevision,
    checkWarrantedRevision: checkWarranted ? mutationRevision : state.checkWarrantedRevision,
    behavioralEvidenceRequired: state.behavioralEvidenceRequired || Boolean(behavioralEvidenceReason),
    behavioralEvidenceReason: behavioralEvidenceReason || state.behavioralEvidenceReason,
    ...(remoteAcceptanceVerdicts ? { remoteAcceptanceVerdicts } : {}),
  });
}

/**
 * The scope phrase for behavioral-evidence messages, grounded in what the risk classifier actually
 * matched ("timeout", "authentication/retry"). Reasons written by older builds (or free-form
 * callers) don't parse — those keep the generic phrase rather than inventing specifics (#156).
 */
export function vinciBehavioralEvidenceScope(): string {
  const state = normalState();
  const parsed = /^The change affects (.+) behavior\.$/.exec(state?.behavioralEvidenceReason ?? "");
  return parsed ? parsed[1] : "routing/auth/retry/fallback";
}

export function vinciVerificationEvidenceGaps(): string[] {
  const state = normalState();
  if (!state || !state.behavioralEvidenceRequired || state.mutationRevision === 0) return [];
  const gaps: string[] = [];
  if (state.behavioralVerifiedRevision !== state.mutationRevision) {
    gaps.push(`a focused behavioral test covering the changed ${vinciBehavioralEvidenceScope()} behavior`);
  }
  if (state.diffInspectedRevision !== state.mutationRevision) {
    gaps.push("inspection of the actual current git diff after the latest change");
  }
  return gaps;
}

function evidenceIsComplete(state: VinciNormalVerificationState): boolean {
  return (
    !state.behavioralEvidenceRequired ||
    (state.behavioralVerifiedRevision === state.mutationRevision &&
      state.diffInspectedRevision === state.mutationRevision)
  );
}

function reconcileEvidence(state: VinciNormalVerificationState): VinciNormalVerificationState {
  if (
    state.status !== "failed" &&
    state.verifiedRevision === state.mutationRevision
  ) {
    return {
      ...state,
      status: evidenceIsComplete(state) ? "passed" : "stale",
      recoveryAttempts: 0,
    };
  }
  return state;
}

export function recordVinciBehavioralVerification(): void {
  const state = normalState();
  if (!state) return;
  setState(reconcileEvidence({ ...state, behavioralVerifiedRevision: state.mutationRevision }));
}

export function recordVinciDiffInspection(): void {
  const state = normalState();
  if (!state) return;
  setState(reconcileEvidence({ ...state, diffInspectedRevision: state.mutationRevision }));
}

export function recordVinciEvidenceGap(summary: string): void {
  const state = normalState();
  if (!state) return;
  const cleanSummary = summary.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  setState({
    ...state,
    status: "stale",
    summary: cleanSummary || "Required completion evidence is missing.",
    verifiedRevision:
      state.verifiedRevision === state.mutationRevision && evidenceIsComplete(state)
        ? Math.max(-1, state.mutationRevision - 1)
        : state.verifiedRevision,
  });
}

export function recordVinciMutationFailure(summary: string): void {
  const state = currentState();
  if (state.variant !== "normal") return;
  const cleanSummary = summary.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const { commandCwd: _commandCwd, ...unboundState } = state;
  setState({
    ...unboundState,
    status: "failed",
    command: "",
    commandKey: "",
    commandKeyCanonical: false,
    requiredCommand: "",
    requiredCommandKey: "",
    requiredSummary: "",
    verifiedRevision: -1,
    summary: cleanSummary || "The attempted project change did not apply.",
  });
}

export function recordVinciTerminalUnverifiable(): void {
  const state = currentState();
  if (state.variant === "terminal-unverifiable") return;
  const command = state.behavioralAttemptCommand || state.command;
  const commandKey = state.behavioralAttemptCommand
    ? state.behavioralAttemptCommandKey
    : state.commandKey;
  setState({
    schemaVersion: VINCI_VERIFICATION_SCHEMA_VERSION,
    variant: "terminal-unverifiable",
    status: "failed",
    summary: command
      ? VINCI_TERMINAL_UNVERIFIABLE_MESSAGE
      : VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE,
    mutationRevision: Math.max(1, state.mutationRevision),
    command,
    commandKey,
    checkClass: state.behavioralAttemptCommand ? "behavioral" : state.checkClass,
  });
}

const VERIFICATION_CLASS_RANK: Readonly<Record<VinciVerificationClass, number>> = {
  static: 0,
  build: 1,
  behavioral: 2,
};

export function vinciVerificationClassRank(checkClass: VinciVerificationClass | undefined): number {
  return VERIFICATION_CLASS_RANK[checkClass ?? "static"];
}

export function hasIncompleteVinciBehavioralAttempt(
  state: Readonly<VinciVerificationState> = currentState(),
): boolean {
  return (
    state.variant === "normal" &&
    Boolean(state.behavioralAttemptCommand) &&
    state.behavioralAttemptCompleted === false
  );
}

const ZERO_COLLECTION_SUMMARY =
  /\b(?:collected 0 items|no tests ran|ran without executing (?:any )?tests)\b/i;

export function hasVinciZeroCollectionAttempt(
  state: Readonly<VinciVerificationState> = currentState(),
): boolean {
  return (
    state.variant === "normal" &&
    !state.requiredCommand &&
    Boolean(state.behavioralAttemptCommand || state.command) &&
    state.behavioralAttemptCompleted === false &&
    ZERO_COLLECTION_SUMMARY.test(state.summary)
  );
}

export function vinciIncompleteBehavioralAttemptSummary(
  state: Readonly<VinciVerificationState> = currentState(),
): string {
  if (!hasIncompleteVinciBehavioralAttempt(state) || state.variant !== "normal") return "";
  if (state.status !== "passed") return "The test suite couldn't be run to completion.";
  const lowerCheck = state.command ? `${state.command} passed` : "The lower-level check passed";
  return `${lowerCheck}, but the test suite couldn't be run to completion.`;
}

export function recordVinciVerificationAttempt(
  command: string,
  checkClass: VinciVerificationClass,
  commandKey?: string,
  isReplayable = false,
): void {
  const state = normalState();
  if (!state || checkClass !== "behavioral") return;
  const cleanCommand = command.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleanCommand) return;
  const cleanCommandKey = commandKey?.trim() || cleanCommand;
  setState({
    ...state,
    status: state.status === "none" ? "stale" : state.status,
    behavioralAttemptCommand: cleanCommand,
    behavioralAttemptCommandKey: cleanCommandKey,
    behavioralAttemptCommandKeyCanonical: commandKey !== undefined && isReplayable,
    behavioralAttemptCompleted: false,
  });
}

export function recordVinciVerification(
  command: string,
  passed: boolean,
  summary: string,
  requireCommand = false,
  checkClass: VinciVerificationClass = "static",
  commandKey?: string,
  isReplayable = true,
  commandCwd?: string,
  zeroCollection = false,
): void {
  const hasExplicitCommandKey = commandKey !== undefined;
  const cleanCommand = hasExplicitCommandKey
    ? command.trim()
    : command.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const cleanCommandKey = hasExplicitCommandKey ? commandKey.trim() : cleanCommand;
  const cleanSummary = summary.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const cleanCommandCwd = commandCwd && isAbsolute(commandCwd) ? commandCwd : undefined;
  void requireCommand;

  const current = currentState();
  if (current.variant === "terminal-unverifiable") {
    if (
      !passed ||
      !current.command ||
      current.summary !== VINCI_TERMINAL_UNVERIFIABLE_MESSAGE ||
      cleanCommand !== current.command
    ) {
      return;
    }
    const mutationRevision = current.mutationRevision;
    const behavioralVerifiedRevision =
      checkClass === "behavioral" ? mutationRevision : -1;
    setState({
      ...initialState(),
      status: "passed",
      command: cleanCommand,
      commandKey: cleanCommandKey,
      commandKeyCanonical: hasExplicitCommandKey || isReplayable,
      summary: cleanSummary || "The check passed.",
      mutationRevision,
      verifiedRevision: mutationRevision,
      checkClass,
      isReplayable,
      behavioralAttemptCommand:
        checkClass === "behavioral" ? cleanCommand : "",
      behavioralAttemptCommandKey:
        checkClass === "behavioral" ? cleanCommandKey : "",
      behavioralAttemptCommandKeyCanonical:
        checkClass === "behavioral"
          ? hasExplicitCommandKey && isReplayable
          : true,
      behavioralAttemptCompleted: true,
      behavioralVerifiedRevision,
    });
    return;
  }
  const state = current;
  const clearsZeroCollection = passed && checkClass === "behavioral" && hasVinciZeroCollectionAttempt(state);
  if (zeroCollection) {
    // Preserve only REAL failure latches (#22): a requiredCommand from a prior PASS lock is not a
    // latch — the mutation already staled it, and a zero-collection attempt records over it
    // (blanking the stale lock; the attempt itself never creates one).
    if (state.status === "failed" && state.requiredCommand) return;
    const { commandCwd: _commandCwd, ...unboundState } = state;
    setState({
      ...unboundState,
      ...(cleanCommandCwd ? { commandCwd: cleanCommandCwd } : {}),
      status: "failed",
      command: cleanCommand,
      commandKey: cleanCommandKey,
      commandKeyCanonical: hasExplicitCommandKey || isReplayable,
      summary:
        cleanSummary ||
        `The attempted check (${cleanCommand}) ran without executing tests, so nothing was verified.`,
      requiredCommand: "",
      requiredCommandKey: "",
      requiredSummary: "",
      checkClass,
      isReplayable,
      behavioralAttemptCommand:
        checkClass === "behavioral" ? cleanCommand : state.behavioralAttemptCommand,
      behavioralAttemptCommandKey:
        checkClass === "behavioral" ? cleanCommandKey : state.behavioralAttemptCommandKey,
      behavioralAttemptCommandKeyCanonical:
        checkClass === "behavioral"
          ? hasExplicitCommandKey && isReplayable
          : state.behavioralAttemptCommandKeyCanonical,
      behavioralAttemptCompleted:
        checkClass === "behavioral" ? false : state.behavioralAttemptCompleted,
    });
    return;
  }
  const currentClass = state.checkClass;
  const lockedDirectoryMatches =
    state.commandCwd === undefined || state.commandCwd === cleanCommandCwd;
  const higherClass =
    Boolean(state.command) &&
    lockedDirectoryMatches &&
    vinciVerificationClassRank(checkClass) > vinciVerificationClassRank(currentClass);
  const lockedCommand = state.requiredCommand;
  const lockedCommandKey = state.requiredCommandKey || lockedCommand;
  const lockedSummary = state.requiredSummary;
  const sameLockedVerifier =
    Boolean(lockedCommand) &&
    lockedDirectoryMatches &&
    checkClass === currentClass &&
    cleanCommandKey === lockedCommandKey;
  if (lockedCommand && !higherClass && !sameLockedVerifier) {
    if (!passed) {
      if (checkClass === "behavioral") {
        setState({
          ...state,
          behavioralAttemptCommand: cleanCommand,
          behavioralAttemptCommandKey: cleanCommandKey,
          behavioralAttemptCommandKeyCanonical: hasExplicitCommandKey && isReplayable,
          behavioralAttemptCompleted: true,
        });
      }
      return;
    }
    setState({
      ...state,
      status: "failed",
      command: lockedCommand,
      commandKey: lockedCommandKey,
      summary:
        `${cleanSummary || "A different check passed."} ` +
        `The required failing check is still unresolved: ${lockedCommand}.`,
      requiredCommand: lockedCommand,
      requiredCommandKey: lockedCommandKey,
      requiredSummary: lockedSummary,
      behavioralAttemptCommand:
        checkClass === "behavioral" ? cleanCommand : state.behavioralAttemptCommand,
      behavioralAttemptCommandKey:
        checkClass === "behavioral" ? cleanCommandKey : state.behavioralAttemptCommandKey,
      behavioralAttemptCommandKeyCanonical:
        checkClass === "behavioral"
          ? hasExplicitCommandKey && isReplayable
          : state.behavioralAttemptCommandKeyCanonical,
      behavioralAttemptCompleted:
        checkClass === "behavioral" ? true : state.behavioralAttemptCompleted,
    });
    return;
  }
  const currentCommandKey = state.commandKey || state.command;
  const incomingFailureOutranksOrTies =
    !passed && vinciVerificationClassRank(checkClass) >= vinciVerificationClassRank(currentClass);
  const replacementLocked =
    !incomingFailureOutranksOrTies &&
    (state.status === "passed" || state.status === "stale");
  if (
    replacementLocked &&
    !higherClass &&
    Boolean(state.command) &&
    vinciVerificationClassRank(checkClass) <= vinciVerificationClassRank(currentClass) &&
    cleanCommandKey !== currentCommandKey
  ) {
    if (checkClass === "behavioral") {
      setState({
        ...state,
        behavioralAttemptCommand: cleanCommand,
        behavioralAttemptCommandKey: cleanCommandKey,
        behavioralAttemptCommandKeyCanonical: hasExplicitCommandKey && isReplayable,
        behavioralAttemptCompleted: true,
      });
    }
    return;
  }
  const behavioralVerifiedRevision =
    passed && checkClass === "behavioral"
      ? state.mutationRevision
      : state.behavioralVerifiedRevision;
  const { commandCwd: _commandCwd, ...unboundState } = state;
  const nextState: VinciNormalVerificationState = {
    ...unboundState,
    ...(cleanCommandCwd ? { commandCwd: cleanCommandCwd } : {}),
    status: passed ? "stale" : "failed",
    command: cleanCommand,
    commandKey: cleanCommandKey,
    commandKeyCanonical: hasExplicitCommandKey || isReplayable,
    summary: cleanSummary || (passed ? "The check passed." : "The check failed."),
    requiredCommand: passed ? "" : cleanCommand,
    requiredCommandKey: passed ? "" : cleanCommandKey,
    requiredSummary: passed ? "" : cleanSummary || "The check failed.",
    verifiedRevision: passed ? state.mutationRevision : state.verifiedRevision,
    recoveryAttempts: passed ? 0 : state.recoveryAttempts,
    checkClass,
    isReplayable,
    behavioralAttemptCommand:
      checkClass === "behavioral"
        ? cleanCommand
        : clearsZeroCollection
          ? ""
          : state.behavioralAttemptCommand,
    behavioralAttemptCommandKey:
      checkClass === "behavioral"
        ? cleanCommandKey
        : clearsZeroCollection
          ? ""
          : state.behavioralAttemptCommandKey,
    behavioralAttemptCommandKeyCanonical:
      checkClass === "behavioral"
        ? hasExplicitCommandKey && isReplayable
        : clearsZeroCollection
          ? true
          : state.behavioralAttemptCommandKeyCanonical,
    behavioralAttemptCompleted:
      checkClass === "behavioral"
        ? true
        : clearsZeroCollection
          ? true
          : state.behavioralAttemptCompleted,
    behavioralVerifiedRevision,
  };
  setState({
    ...nextState,
    status: passed && evidenceIsComplete(nextState) ? "passed" : nextState.status,
  });
}

export function recordVinciVerificationRecovery(): number {
  const state = currentState();
  if (state.variant === "terminal-unverifiable") return 0;
  const recoveryAttempts = state.recoveryAttempts + 1;
  setState({ ...state, recoveryAttempts });
  return recoveryAttempts;
}
