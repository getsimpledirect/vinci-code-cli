/**
 * [vinci] De-groove the LLM-visible context — the root fix for the "sees the issue, does it anyway"
 * pathology on small models.
 *
 * A language model continues its context; it does not act on its narration. After a few identical
 * (failed tool call → error) rounds, the transcript ITSELF becomes the strongest pattern in view:
 * observed live, bozza wrote "I keep forgetting the edits array. Let me do this properly:" and then
 * emitted the exact same broken call — nine times — because six in-context examples of the wrong
 * call (and zero of the right one) outweigh any instruction. Coaching text can't win against that;
 * removing the repetition can.
 *
 * This pass collapses CONSECUTIVE, IDENTICAL no-progress rounds in the context the model reads —
 * failed rounds (the invalid-edit loop) AND successful-but-identical rounds (the todo loop: same
 * call → same "Plan 10/10 done", nine times). The first round is kept (it carries the information),
 * the repeats are dropped, and a hidden note takes their place ("you repeated this N more times — do
 * something different"). Because this runs on EVERY request, a RESUMED session's history is cleaned
 * the same way — old loops never re-poison a fresh start. Display, session persistence, and /undo
 * are untouched — only the model's view changes. Compaction summaries also flow through this, so
 * summaries stop memorializing loops.
 *
 * CONSERVATIVE BY DESIGN: rounds must repeat at least 3 times in a row with nothing in between;
 * call ARGUMENTS and assistant text must match exactly; only RESULT text is digit-normalized (so
 * the loop-breaker's own attempt counters — "Blocked repeat #4…" — can't camouflage a groove).
 * Anything varied or interleaved is left byte-for-byte alone. No-op unless VINCI_CODE=1.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const MIN_RUN = 3; // collapse only from the 3rd identical round — twice is retrying, thrice is a groove

type Unit = { start: number; length: number; signature: string; failed: boolean };

function sigOf(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Digit-normalize RESULT text for matching: the loop-breaker's own steers vary only by attempt
 *  counters ("Blocked repeat #4…"), which must not camouflage a groove — especially in a RESUMED
 *  session whose history already contains counter-varied rounds. Call ARGUMENTS stay exact-match. */
function normalizeResult(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((c) =>
		c && typeof c === "object" && (c as { type?: string }).type === "text"
			? { type: "text", text: String((c as { text?: unknown }).text ?? "").replace(/\d+/g, "#") }
			: c,
	);
}

/** A "round" = one assistant message with tool calls, plus all their results, back to back.
 *  Both FAILED rounds (the invalid-edit loop) and SUCCESSFUL no-progress rounds (the todo loop:
 *  identical call → identical "Plan 10/10 done", nine times) are grooves worth collapsing. */
function readUnit(messages: AgentMessage[], i: number): Unit | null {
	const m = messages[i] as { role?: string; content?: Array<{ type: string; [k: string]: unknown }> };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return null;
	const callIds = m.content.filter((c) => c.type === "toolCall").map((c) => (c as { id?: string }).id);
	if (callIds.length === 0) return null;
	// The following messages must be exactly the results for those calls, in order.
	const parts: unknown[] = [m.content];
	let j = i + 1;
	let failed = true;
	for (const id of callIds) {
		const r = messages[j] as { role?: string; toolCallId?: string; isError?: boolean; content?: unknown };
		if (r?.role !== "toolResult" || r.toolCallId !== id) return null;
		if (!r.isError) failed = false;
		parts.push({ isError: !!r.isError, content: normalizeResult(r.content) });
		j++;
	}
	// Signature deliberately EXCLUDES toolCallIds/timestamps: same words, same call args, same result.
	const content = m.content.map((c) =>
		c.type === "toolCall" ? { type: c.type, name: c.name, arguments: c.arguments } : c,
	);
	parts[0] = content;
	return { start: i, length: j - i, signature: sigOf(parts), failed };
}

export function vinciDegroove(messages: AgentMessage[]): AgentMessage[] {
	if (process.env.VINCI_CODE !== "1") return messages;

	const out: AgentMessage[] = [];
	let i = 0;
	while (i < messages.length) {
		const first = readUnit(messages, i);
		if (!first) {
			out.push(messages[i]);
			i++;
			continue;
		}
		// Count consecutive identical rounds.
		let runEnd = first.start + first.length;
		let count = 1;
		while (runEnd < messages.length) {
			const next = readUnit(messages, runEnd);
			if (!next || next.signature !== first.signature) break;
			runEnd = next.start + next.length;
			count++;
		}
		if (count < MIN_RUN) {
			// Not a groove — emit untouched (all rounds, then continue after them).
			for (let k = i; k < runEnd; k++) out.push(messages[k]);
			i = runEnd;
			continue;
		}
		// Groove: keep the FIRST round, drop the repeats, and end with a hidden corrective note —
		// positioned where the repeats were, i.e. closest to the generation point.
		for (let k = first.start; k < first.start + first.length; k++) out.push(messages[k]);
		const lastTs = (messages[runEnd - 1] as { timestamp?: number }).timestamp ?? Date.now();
		const repeats = `${count - 1} more time${count === 2 ? "" : "s"}`;
		out.push({
			role: "custom",
			customType: "vinci-degroove",
			display: false,
			content: first.failed
				? `(You then repeated that exact same failed call ${repeats} — every attempt failed the same way, ` +
					`and the repeats have been removed from this conversation. Do NOT send that call again. Do ` +
					`something genuinely different: re-read the file, make a much smaller change, or ask the user ` +
					`with ask_user.)`
				: `(You then repeated that exact same call ${repeats} and got the same result every time — the ` +
					`repeats have been removed from this conversation. Repeating it will not change anything. ` +
					`Move FORWARD: take the next step of the task, or ask the user with ask_user.)`,
			timestamp: lastTs,
		} as AgentMessage);
		i = runEnd;
	}
	return out;
}
