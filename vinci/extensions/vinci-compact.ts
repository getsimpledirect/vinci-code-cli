/**
 * Vinci compaction experience — piccolo's context window is small (32k), so long sessions
 * WILL compact. Pi handles the mechanics (and, with the keepRecent core patch, recovers from
 * overflow instead of crashing) — this extension makes it a calm, clear experience for a
 * non-technical user instead of a scary "Compacting…" bar that appears out of nowhere:
 *
 *   • when it starts  → a gentle, reassuring reframe (not an error)
 *   • when it finishes → "picked up where we left off — here's what I kept" + the files touched
 *
 * The ACTUAL compaction is left entirely to Pi's core (threshold + overflow recovery, now with the
 * keepRecent window-scaling patch) — we don't trigger it ourselves. An earlier proactive
 * ctx.compact() at turn boundaries was removed: it fired on already-small sessions and threw
 * "Nothing to compact (session too small)" as a scary error, and it was redundant with the core
 * threshold check anyway. All additive — no core edits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const base = (p: string) => (p.split("/").pop() || p).trim();

/** A short, human summary of what compaction preserved (files read / edited). */
function keptSummary(entry: unknown): string {
  const details = (entry as { details?: { readFiles?: string[]; modifiedFiles?: string[] } })?.details;
  const read = details?.readFiles ?? [];
  const edited = details?.modifiedFiles ?? [];
  const parts: string[] = [];
  if (edited.length) {
    const names = edited.slice(0, 3).map(base).join(", ");
    parts.push(`edited ${names}${edited.length > 3 ? ` +${edited.length - 3} more` : ""}`);
  }
  if (read.length) parts.push(`read ${read.length} file${read.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
  // ── Starting: reframe the auto-compaction so it reads as housekeeping, not a failure. ──
  pi.on("session_before_compact", async (event, ctx) => {
    if (!ctx.hasUI) return;
    // Manual /compact already gives its own feedback; only narrate the automatic ones.
    if (event.reason === "manual") return;
    ctx.ui.notify(
      "Our conversation's grown long — I'm condensing it so I stay quick and keep the thread. One moment…",
      "info",
    );
    return; // don't override the compaction itself — let Pi's (window-scaled) default run.
  });

  // ── Finished: a simple, warm "we're good, continuing" with what was preserved. ──
  pi.on("session_compact", async (event, ctx) => {
    if (!ctx.hasUI) return;
    const kept = keptSummary(event.compactionEntry);
    // willRetry=true → overflow recovery auto-continues the turn; false → threshold compaction ended
    // the turn (Pi waits for the user), so give a clear, non-scary next step instead of a dead stop.
    const tail = event.willRetry
      ? " Picking up right where we left off…"
      : " Say “continue” and I'll keep going from here.";
    ctx.ui.notify(`✓ Caught up — I kept the important context${kept ? ` (${kept})` : ""}.${tail}`, "info");
  });
}
