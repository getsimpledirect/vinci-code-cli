/**
 * Hard-stop registry — issues #5 and #6.
 *
 * A machine stop that froze the agent's ability to finish (the no-progress latch in vinci-todo, or
 * any harness refusal of a finalization step such as `git commit`) is a FACT about the session that
 * outranks whatever the model says afterwards. Observed live 2026-08-27: the latch locked every
 * mutation, the model wrote "done", and the task-outcome record said DONE over a tree of
 * uncommitted work. The site that blocks records the stop here; `buildVinciTaskOutcome` reads it
 * and refuses to close that task as anything but BLOCKED — in every mode, not just unattended.
 *
 * Keyed by task (session) id and held on `globalThis`, like the automation-stop latch in
 * `control.ts`, because isolated extension loaders must all see the same registry. Cleared for the
 * CURRENT task only (never the whole registry) by the next REAL user instruction — an extension
 * steer or a mid-stream keystroke is not one — and on session start, the same release rules as the
 * automation stop. A refusal-class stop is also RESOLVED by a later successful finalization command
 * (the model retried without the refused option, and the commit landed): the stop was a fact about
 * one attempt, not about the session's end state. The latch is never resolved this way — it freezes
 * every mutation, so nothing can land under it.
 */
import { isVinciFinalizationCommand } from "./unattended.ts";

export type VinciHardStopSource =
  | "latch" // vinci-todo: the no-progress automation stop froze mutations
  | "reserve" // vinci-loopbreak: an action reserve refused a finalization step
  | "ceiling" // vinci-loopbreak: the per-turn action ceiling refused a finalization step
  | "error-streak" // vinci-loopbreak: the consecutive-failure stop refused a finalization step
  | "fixation" // vinci-loopbreak: an identical-repeat block refused a finalization step
  | "review-pause" // vinci-todo: the failed-review pause refused a finalization step
  | "guard"; // vinci-guard: the safety guard refused a finalization step

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

/** Clear ONE task's stop. Every caller passes the task it is running under (WARN-2: a session start
 *  or user instruction in one task must not erase another task's recorded stop). */
export function clearVinciHardStop(taskId: string): void {
  hardStopStore.stops.delete(taskId);
}

/** The task id an extension context is running under; "" when the harness has no session manager. */
export function vinciTaskIdOf(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

type StopContext = { sessionManager?: { getSessionId?: () => string } } | undefined;

/**
 * The ONE place every refusal path reports through (review BLOCK-3). If `command` is a
 * finalization-shaped bash command, the refusal is a hard stop for the task and is recorded with
 * the refusing site's reason and the command it refused; otherwise nothing is recorded. Returns
 * whether a stop was recorded, so a site can keep its own block shape.
 */
export function recordFinalizationRefusal(ctx: StopContext, source: VinciHardStopSource, command: string, reason: string): boolean {
  if (!isVinciFinalizationCommand(command)) return false;
  recordVinciHardStop(vinciTaskIdOf(ctx), source, `${reason} The refused step was the finalization command \`${command.slice(0, 80)}\`.`);
  return true;
}

/** `recordFinalizationRefusal` plus the block result itself — for sites whose refusal is a plain block. */
export function refuseFinalization(
  ctx: StopContext,
  source: VinciHardStopSource,
  command: string,
  reason: string,
): { block: true; reason: string } {
  recordFinalizationRefusal(ctx, source, command, reason);
  return { block: true, reason };
}

/**
 * A finalization command SUCCEEDED for this task after a refusal-class stop: the refusal was one
 * attempt's fact, not the session's end state (a `git add -A` refused for breadth, then
 * `git add file && git commit` landed). Resolve the stop so the record can close on the real
 * outcome. The latch is never resolved here — nothing can land under it.
 */
export function resolveVinciHardStopByFinalization(ctx: StopContext, command: string): boolean {
  const taskId = vinciTaskIdOf(ctx);
  const stop = hardStopStore.stops.get(taskId);
  if (!stop || stop.source === "latch") return false;
  // Only a landed stage/commit resolves it — a successful `git status` proves nothing landed.
  if (!isVinciFinalizationCommand(command) || !/\bgit(?:\s+--no-pager)?\s+(?:add|commit)\b/.test(command)) return false;
  hardStopStore.stops.delete(taskId);
  return true;
}
