/**
 * Cross-extension crew status — the honest answer to "is background agent work unresolved?".
 *
 * vinci-crew publishes a snapshot whenever helper state changes; vinci-receipt consults it when it
 * classifies the task outcome, so a one-shot run whose helpers are still working, parked awaiting
 * approval, or were stopped unfinished can never be stamped DONE "read-only" (#194 — observed live:
 * three helpers spawned, outcome DONE "completed without project changes", exit 0, helpers stopped
 * two minutes later having changed nothing).
 *
 * IMPORT-FREE ON PURPOSE, and shared via globalThis: extensions load under isolated module loaders
 * (jiti), so module state alone would give each loader its own copy — the same resolution that
 * created lib/verification-control.ts. Keep this file dependency-free.
 */

export interface VinciCrewStatus {
  /** Helpers currently running or queued to run. */
  active: number;
  /** Names of helpers whose finished work sits unapplied, awaiting approval. */
  parkedWaiting: string[];
  /** Names of helpers the session stopped before they produced any patch. */
  stoppedUnfinished: string[];
}

const STORE_KEY = Symbol.for("vinci.crew.status");

type StatusStore = { status: VinciCrewStatus | undefined };

function store(): StatusStore {
  const holder = globalThis as { [STORE_KEY]?: StatusStore };
  holder[STORE_KEY] ??= { status: undefined };
  return holder[STORE_KEY];
}

export function setVinciCrewStatus(status: VinciCrewStatus): void {
  store().status = {
    active: status.active,
    parkedWaiting: status.parkedWaiting.slice(),
    stoppedUnfinished: status.stoppedUnfinished.slice(),
  };
}

export function getVinciCrewStatus(): VinciCrewStatus | undefined {
  const status = store().status;
  return status
    ? { active: status.active, parkedWaiting: status.parkedWaiting.slice(), stoppedUnfinished: status.stoppedUnfinished.slice() }
    : undefined;
}

/** True when background agent work is unresolved: still running, parked, or stopped unfinished. */
export function vinciCrewWorkUnresolved(): boolean {
  const status = store().status;
  return Boolean(status && (status.active > 0 || status.parkedWaiting.length > 0 || status.stoppedUnfinished.length > 0));
}

export function resetVinciCrewStatus(): void {
  store().status = undefined;
}
