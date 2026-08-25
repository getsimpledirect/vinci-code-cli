/**
 * [vinci] Per-tool-result context budget (GAP_ANALYSIS #53 / ROADMAP Tier 1).
 *
 * Vinci runs a 9B with a ~64k operating window (compaction fires ~49k). Upstream truncates tool
 * output at a generous 2000 lines / 50KB — but a single 50KB `read` or `grep` is ~13k tokens, so a
 * few verbose results dominate the window and trigger the compaction/thrash we've fought. This
 * tightens the per-result cap so no ONE result floods the context; the model narrows with
 * offset/limit/pattern (and now the footers steer it to grep a big file rather than page it).
 *
 * Applied to read / grep / find via their existing `truncateHead` calls — same machinery, smaller
 * budget under VINCI_CODE. Numbers are env-tunable so ops can adjust without a rebuild. Opt out with
 * VINCI_NO_RESULT_BUDGET=1 (falls back to upstream 2000/50KB). Gated by VINCI_CODE; upstream untouched.
 */

// Half the upstream line cap and ~half the byte cap: tight enough that one result can't dominate a
// 64k window, loose enough that the vast majority of real source files still come back whole.
const DEFAULT_MAX_LINES = 1200;
const DEFAULT_MAX_BYTES = 24 * 1024; // 24KB ≈ ~6k tokens

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Whether the tighter Vinci result budget is active (VINCI_CODE on, not opted out). */
export function vinciResultBudgetEnabled(): boolean {
	return process.env.VINCI_CODE === "1" && process.env.VINCI_NO_RESULT_BUDGET !== "1";
}

/** The tuned {maxLines, maxBytes} for a single tool result — env-overridable for ops tuning. */
export function vinciResultBudget(): { maxLines: number; maxBytes: number } {
	return {
		maxLines: envInt("VINCI_RESULT_MAX_LINES", DEFAULT_MAX_LINES),
		maxBytes: envInt("VINCI_RESULT_MAX_BYTES", DEFAULT_MAX_BYTES),
	};
}
