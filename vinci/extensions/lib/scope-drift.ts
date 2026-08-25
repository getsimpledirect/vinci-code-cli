/**
 * Headless scope drift — what the semantic scope judge saw when there was nobody to ask.
 *
 * Interactive runs pause and let the user decide. A headless run (`vinci -p`, `--mode json`, any host
 * that binds no UI context) has no one to pause for, so the judge runs ADVISORY there: it never blocks
 * and never changes what tools may run — it RECORDS the drift so the user still hears about it.
 *
 * Notes are kept in two places on purpose:
 *   • in memory, for the run that observed them (and for tests to read back);
 *   • as a session entry, so a note observed inside a crew helper's own child session survives the
 *     process boundary and can be scanned by the orchestrator — the same route the verification proof
 *     already takes.
 *
 * Shared through globalThis because Vinci's extensions can be loaded by isolated module loaders.
 */

/** Session entry type carrying one advisory drift note. */
export const VINCI_SCOPE_DRIFT_ENTRY = "vinci-scope-drift";

/**
 * Marker the crew sets on a helper's child process (#185).
 *
 * A crew helper is spawned as `vinci --mode rpc`, and RPC mode binds a real UI context — so
 * `ctx.hasUI` is TRUE inside a helper and the scope guard takes its interactive path. But nothing on
 * the crew side answers an `extension_ui_request`, so the pause is a question nobody hears and the
 * helper waits out its whole 10-minute ceiling. `ctx.hasUI` cannot tell a real terminal from a helper
 * — both are `true` — so the discriminator has to come from the side that KNOWS: the crew, which set
 * this variable when it spawned the child.
 */
export const VINCI_CREW_HELPER_ENV = "VINCI_CREW_HELPER";

/**
 * True when a UI prompt raised here would have no answerer: an RPC child the crew launched.
 *
 * Deliberately narrow. RPC mode alone is NOT enough — an RPC host that DOES answer dialogs exists
 * (the orchestrator's rpc-process forwards `extension_ui_request` to its own handler), and a real TUI
 * must never be degraded. Only the combination of "rpc mode" and "the crew spawned me" is honest.
 */
export function isUnanswerableVinciUI(mode: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return mode === "rpc" && env[VINCI_CREW_HELPER_ENV] === "1";
}

/** Same bound as MAX_SCOPE_CHECKS in vinci-scope: a turn cannot produce more judged files than this. */
const MAX_DRIFT_NOTES = 6;
const MAX_NOTE_LENGTH = 200;

type ScopeDriftStore = { notes: string[] };
const STORE_KEY = "__vinciScopeDriftStore" as const;
type VinciGlobal = typeof globalThis & { [STORE_KEY]?: ScopeDriftStore };
const vinciGlobal = globalThis as VinciGlobal;
const store: ScopeDriftStore = vinciGlobal[STORE_KEY] ?? { notes: [] };
vinciGlobal[STORE_KEY] = store;

function cleanNote(note: unknown): string {
  if (typeof note !== "string") return "";
  const text = note.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > MAX_NOTE_LENGTH ? `${text.slice(0, MAX_NOTE_LENGTH - 1)}…` : text;
}

/** Fresh task, fresh scope — drift notes belong to the request that was judged. */
export function resetVinciScopeDrift(): void {
  store.notes.length = 0;
}

/** Record one note. Returns false when it was empty, already recorded, or over the bound. */
export function recordVinciScopeDrift(note: string): boolean {
  const text = cleanNote(note);
  if (!text || store.notes.includes(text) || store.notes.length >= MAX_DRIFT_NOTES) return false;
  store.notes.push(text);
  return true;
}

/** The drift notes collected during this task, in the order they were observed. */
export function vinciScopeDriftNotes(): string[] {
  return store.notes.slice();
}

/**
 * Read drift notes out of a session's entries — how the orchestrator picks up what a helper's own
 * scope guard observed, without trusting the helper to have reported it.
 */
export function scanVinciScopeDriftEntries(entries: readonly unknown[]): string[] {
  const notes: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== VINCI_SCOPE_DRIFT_ENTRY) continue;
    const data = candidate.data as { note?: unknown } | null | undefined;
    const note = cleanNote(data?.note);
    if (note && !notes.includes(note)) notes.push(note);
    if (notes.length >= MAX_DRIFT_NOTES) break;
  }
  return notes;
}
