/**
 * Hard-stop registry — issues #5 and #6.
 *
 * A machine stop that froze the agent's ability to finish (the no-progress latch in vinci-todo, or
 * the loopbreak action reserve refusing a finalization step such as `git commit`) is a FACT about
 * the session that outranks whatever the model says afterwards. Observed live 2026-08-27: the latch
 * locked every mutation, the model wrote "done", and the task-outcome record said DONE over a tree
 * of uncommitted work. The site that blocks records the stop here; `buildVinciTaskOutcome` reads it
 * and refuses to emit DONE / DONE_UNVERIFIED for that task — in every mode, not just unattended.
 *
 * Keyed by task (session) id and held on `globalThis`, like the automation-stop latch in
 * `control.ts`, because isolated extension loaders must all see the same registry. Cleared by the
 * next REAL user instruction (an extension steer or a mid-stream keystroke is not one) and on
 * session start — the same release rules as the automation stop.
 */

export type VinciHardStopSource = "latch" | "reserve";

export type VinciHardStop = {
  taskId: string;
  source: VinciHardStopSource;
  reason: string;
  recordedAt: string;
};

const HARD_STOP_STORE_KEY = "__vinciHardStopStore" as const;
type VinciHardStopGlobal = typeof globalThis & { [HARD_STOP_STORE_KEY]?: { stops: Map<string, VinciHardStop> } };
const hardStopGlobal = globalThis as VinciHardStopGlobal;
const hardStopStore = hardStopGlobal[HARD_STOP_STORE_KEY] ?? { stops: new Map<string, VinciHardStop>() };
if (!(hardStopStore.stops instanceof Map)) hardStopStore.stops = new Map();
hardStopGlobal[HARD_STOP_STORE_KEY] = hardStopStore;

function cleanReason(reason: string): string {
  return reason.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Record a hard stop for a task. The FIRST stop wins: a later, vaguer refusal never overwrites the cause. */
export function recordVinciHardStop(taskId: string, source: VinciHardStopSource, reason: string): void {
  if (hardStopStore.stops.has(taskId)) return;
  hardStopStore.stops.set(taskId, { taskId, source, reason: cleanReason(reason), recordedAt: new Date().toISOString() });
}

export function getVinciHardStop(taskId: string): Readonly<VinciHardStop> | undefined {
  return hardStopStore.stops.get(taskId);
}

/** Clear one task's stop, or every stop when no id is given (session start / a new user instruction). */
export function clearVinciHardStop(taskId?: string): void {
  if (taskId === undefined) hardStopStore.stops.clear();
  else hardStopStore.stops.delete(taskId);
}

/** The task id an extension context is running under; "" when the harness has no session manager. */
export function vinciTaskIdOf(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}
