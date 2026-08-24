/**
 * [vinci] Shared grader core for the verification system (vinci/docs/VERIFICATION_SYSTEM.md).
 *
 * These are the PURE primitives — no ExtensionContext, no session dependency — so they can be used
 * by BOTH the core turn-end enforcement (agent-session.ts §8 "Phase 2") AND the extension layer
 * (vinci/extensions/lib/grader.ts, which re-exports these and adds ctx-flavored wrappers). "Trust the
 * check, not the claim" only works if there's ONE check; this file is that single source of truth.
 *
 * Two flaws are fixed here vs. a naive `git diff HEAD` grader:
 *  - #1 gatherDiff includes UNTRACKED files (a fresh .github/workflows/deploy.yml is invisible to
 *    `git diff`, so a naive grader graded an unrelated README change and missed the real work).
 *  - #2 GRADER_SYSTEM treats UNVERIFIED factual/currency claims as suspect — the exact overclaim
 *    pattern ("all actions are up to date", where two were majors stale) instead of rubber-stamping.
 *
 * Kept dependency-light on purpose: only node built-ins + `complete` from pi-ai/compat, both of which
 * core already imports. Loaded only on VINCI_CODE paths.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	classifyCompletionResult,
	complete,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";

export type GraderCompleteOpts = {
	apiKey: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	onUsage?: (response: AssistantMessage) => void;
};
export type GraderVerdict = "ships" | "needs-work" | "risky" | "none";

export const VINCI_VERIFICATION_ENTRY = "vinci-verification-state";

// The vinci layer OWNS this contract: vinci/ is shipped in the release tarball and
// packages/*/src is not. Imported here at BUILD time and re-exported so existing consumers
// (session-manager, tests) are unchanged.
import {
	parseSharedVinciVerificationState,
	type SharedVinciNormalVerificationState,
	type SharedVinciTerminalUnverifiableState,
	type SharedVinciVerificationClass,
	type SharedVinciVerificationState,
	type SharedVinciVerificationStatus,
	selectSharedVinciVerificationState,
	VINCI_CORRUPTED_VERIFICATION_MESSAGE,
	VINCI_TERMINAL_UNVERIFIABLE_MESSAGE,
	VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE,
	VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE,
	VINCI_VERIFICATION_SCHEMA_VERSION,
} from "../../../../vinci/extensions/lib/verification-contract.ts";

export {
	VINCI_VERIFICATION_SCHEMA_VERSION,
	VINCI_CORRUPTED_VERIFICATION_MESSAGE,
	VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE,
	VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE,
	VINCI_TERMINAL_UNVERIFIABLE_MESSAGE,
	parseSharedVinciVerificationState,
	selectSharedVinciVerificationState,
	type SharedVinciVerificationStatus,
	type SharedVinciVerificationClass,
	type SharedVinciNormalVerificationState,
	type SharedVinciTerminalUnverifiableState,
	type SharedVinciVerificationState,
};

export const REVIEW_TIMEOUT_MS = 60_000;

export const GRADER_SYSTEM =
	"You are an INDEPENDENT senior engineer reviewing a change you did NOT write. You are given the " +
	"TASK the author was asked to do and the DIFF of what they changed (untracked new files are " +
	"included as '+++ NEW FILE' blocks). Judge it honestly: does it correctly and completely accomplish " +
	"the task? Name the top 1–3 CONCRETE problems — real bugs, missing cases, security or performance " +
	"risks, wrong approach, or ways it doesn't match the task — each a short specific bullet with the " +
	"file where visible. Use 'needs work' only for a defect concretely demonstrated by the TASK, DIFF, " +
	"or mechanically recorded VERIFICATION EVIDENCE. A concern that depends on unseen dependency " +
	"semantics, an untested hypothesis, or a possible edge case is 'risky', not 'needs work'; do not " +
	"force the author into a new investigation to disprove speculation. CRUCIAL: do NOT trust factual " +
	"or currency claims in the change that aren't " +
	"proven by the diff itself — a claim like 'X is the latest version', 'this is the recommended " +
	"approach', or 'all up to date' is UNVERIFIED unless the diff shows it was checked against the " +
	"source; call those out as needing verification rather than assuming they're right. A TODO, PLAN, " +
	"or IMPROVEMENT_PLAN file records intent, not proof that a product is a work in progress. Do not " +
	"accept FALSE-GREEN verification: a test script that only echoes 'no tests', runs true/exit 0, skips " +
	"the suite, or ignores failures is not a test. Likewise, a Dockerfile or deployment change is not " +
	"'working' merely because it looks plausible; require a recorded build/check or call the claim unverified. " +
	"When VERIFICATION EVIDENCE records a direct check passing after the latest mutation, accept that the " +
	"named command ran successfully; do not demand a test-file diff when the task asked to run an existing " +
	"regression rather than add a new one. Repositories and evaluation fixtures may seed the failing regression " +
	"before the author starts: a named existing test that failed before the fix and passes afterward is a real " +
	"reproduction even when the test file is absent from the diff. Never demand a duplicate test merely to make " +
	"the reproduction appear in the diff. Reject redundant architectural changes: if an owning mode-specific " +
	"function fixes the demonstrated path, the same option should not also be injected into a generic downstream " +
	"wrapper unless the task or verification evidence demonstrates that separate path also fails. Do not reward " +
	"gratuitous edits: when the selected item was already " +
	"correct, leaving it unchanged is better " +
	"than adding an unsupported status claim merely to produce a diff. If the change " +
	"is genuinely solid, say so plainly and do NOT invent nits. End with exactly one line: '## Verdict' " +
	"followed by 'ships', 'needs work', or 'risky', and a clause why. Be specific and honest.";

const DIFF_CAP = 14000;
const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_BYTES = 200_000; // skip a huge untracked file rather than blow the budget on one

/** A NUL byte in the first chunk is the reliable binary-file tell. */
export function isBinary(content: string): boolean {
	for (let i = 0; i < Math.min(content.length, 8000); i++) {
		if (content.charCodeAt(i) === 0) return true;
	}
	return false;
}

/** The uncommitted change set: tracked edits (staged + unstaged) PLUS untracked new files. */
export function gatherDiff(cwd: string): string {
	const tryGit = (args: string[]): string => {
		try {
			return execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	};
	let diff = tryGit(["diff", "HEAD"]) || tryGit(["diff"]);
	const staged = tryGit(["diff", "--cached"]);
	if (staged && !diff.includes(staged.slice(0, 40))) diff = `${staged}\n${diff}`.trim();

	// [flaw #1] Untracked files ARE part of the change — inline each as a synthetic new-file block so
	// the grader sees the real work, not just tracked edits. --exclude-standard respects .gitignore
	// (so node_modules etc. stay out). Per-file size cap + count cap keep it bounded.
	const untracked = tryGit(["ls-files", "--others", "--exclude-standard"])
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const f of untracked.slice(0, MAX_UNTRACKED_FILES)) {
		try {
			const full = join(cwd, f);
			const size = statSync(full).size;
			if (size > MAX_UNTRACKED_BYTES) {
				diff += `\n\n+++ NEW FILE: ${f} (too large to inline — ${Math.round(size / 1024)}KB)`;
				continue;
			}
			const content = readFileSync(full, "utf8");
			if (isBinary(content)) continue;
			diff += `\n\n+++ NEW FILE: ${f}\n${content
				.split("\n")
				.map((l) => `+${l}`)
				.join("\n")}`;
		} catch {
			/* unreadable — skip */
		}
	}
	diff = diff.trim();
	if (diff.length > DIFF_CAP) diff = `${diff.slice(0, DIFF_CAP)}\n… (diff truncated)`;
	return diff;
}

/** Branch entries are message/compaction/etc.; task context uses only real conversation messages. */
type BranchEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
};

/** Latest verifier-owned state, formatted as evidence for the independent reviewer. */
export function verificationEvidenceFromBranch(branch: readonly BranchEntry[]): string {
	const state = selectSharedVinciVerificationState(branch);
	if (!state) return "";
	if (state.variant === "terminal-unverifiable") return "";
	if (
		state.status !== "passed" ||
		state.verifiedRevision !== state.mutationRevision ||
		!state.command.trim() ||
		(Boolean(state.behavioralAttemptCommand) && state.behavioralAttemptCompleted === false)
	) {
		return "";
	}
	const command = state.command
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
	const summary = state.summary
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
	return `Direct check passed after the latest mutation.\nCommand: ${command}\nResult: ${summary || "The direct check passed."}`;
}

function branchMessageText(entry: BranchEntry): string {
	const content = entry.message?.content;
	return (
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(part): part is { type: "text"; text: string } =>
								!!part &&
								typeof part === "object" &&
								(part as { type?: unknown }).type === "text" &&
								typeof (part as { text?: unknown }).text === "string",
						)
						.map((part) => part.text)
						.join("\n")
				: ""
	).trim();
}

const REFERENTIAL_TASK =
	/^(?:yes|yep|yeah|sure|ok(?:ay)?|go ahead|do it|let'?s do|implement|apply|proceed|continue|keep going|use|choose|pick)\b|\b(?:this|that|these|those|it|them|above|former|latter|the plan|options?|items?|#?\d+|(?:first|second|third|fourth|last)\s+(?:one|option|item))\b/i;

/**
 * The task the change is meant to accomplish. A standalone request stays compact. Short approvals
 * and numbered selections also include the preceding assistant/user context that gives them meaning;
 * without it, a reviewer sees only "do 1 and 5" and cannot judge the resulting diff.
 */
export function taskFromBranch(branch: readonly BranchEntry[]): string {
	let latestUserIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "message" || e.message?.role !== "user") continue;
		if (branchMessageText(e)) {
			latestUserIndex = i;
			break;
		}
	}
	if (latestUserIndex < 0) return "(no explicit task found — review the diff for correctness and quality)";

	const latest = branchMessageText(branch[latestUserIndex]).slice(0, 2000);
	if (!REFERENTIAL_TASK.test(latest)) return latest;

	let previousUser = "";
	let previousAssistant = "";
	for (let i = latestUserIndex - 1; i >= 0 && (!previousUser || !previousAssistant); i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const text = branchMessageText(entry);
		if (!text) continue;
		if (!previousAssistant && entry.message?.role === "assistant") previousAssistant = text.slice(0, 3500);
		if (!previousUser && entry.message?.role === "user") previousUser = text.slice(0, 1200);
	}
	if (!previousUser && !previousAssistant) return latest;

	return [
		"Conversation defining the task (assistant text is context, not evidence):",
		previousUser ? `User: ${previousUser}` : "",
		previousAssistant ? `Assistant: ${previousAssistant}` : "",
		`User request: ${latest}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
	return resp.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

export async function runReview(
	model: Model<any>,
	opts: GraderCompleteOpts,
	task: string,
	diff: string,
	verificationEvidence = "",
): Promise<string> {
	if (!diff) return "";
	const evidence = verificationEvidence
		? `\n\nVERIFICATION EVIDENCE (recorded by the deterministic verifier, not author prose):\n${verificationEvidence}`
		: "";
	const timeoutSignal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
	const { onUsage, ...completeOpts } = opts;
	const r = await complete(
		model,
		{ systemPrompt: GRADER_SYSTEM, messages: [um(`TASK:\n${task}\n\nDIFF:\n${diff}${evidence}`)] },
		{ ...completeOpts, signal },
	);
	if (onUsage) {
		onUsage(r);
	} else {
		// The extension-side accumulator installs this global callback with the active durable session
		// UUID. Keeping the core hook optional preserves package independence while ensuring the
		// automatic completion grader is accounted even though it has no ExtensionContext.
		const reporter = (
			globalThis as typeof globalThis & {
				__vinciRecordTaskCall?: (response: AssistantMessage, source: string) => void;
			}
		).__vinciRecordTaskCall;
		reporter?.(r, "grader");
	}
	const status = classifyCompletionResult(r);
	if (!status.ok) return "";
	return textOf(r);
}

/** Read the grader's verdict from its output (the '## Verdict' line). */
export function parseGraderVerdict(text: string): GraderVerdict {
	if (!text.trim()) return "none";
	const after = (text.split(/##\s*verdict/i)[1] ?? "").toLowerCase();
	const lead = after.replace(/^[^a-z]+/i, "");
	// The LEAD token is the verdict the grader is told to put first — it wins over a later clause that
	// merely mentions "needs work" (e.g. "ships, though naming still needs work" is a SHIP).
	if (/^needs?\s*work/.test(lead)) return "needs-work";
	if (/^risky/.test(lead)) return "risky";
	if (/^(ships|solid|good)\b/.test(lead)) return "ships";
	// No clean lead token → fall back to scanning for a needs-work / risky signal.
	if (/\bneeds?\s*work\b/.test(after.slice(0, 80))) return "needs-work";
	if (/\bneeds?\s*work\b|\brisky\b/i.test(text)) return "needs-work";
	return "none";
}

/**
 * Does this assistant text read as a COMPLETION / CORRECTNESS claim? This is the trigger for Phase 2:
 * the model announcing it's done is exactly where a small model overclaims. It fires at TURN END on a
 * settled text message, and the gate ONLY grades when the turn actually made edits — so a broad match
 * is safe (it just means "grade the edits this turn produced," which is the whole point). It therefore
 * catches the terse completions a model really uses — "Done.", "Finished.", "Created greet.js." — not
 * just verbose "the task is complete" phrasings. The only real cost of a match is one grader call.
 */
export function looksLikeCompletionClaim(text: string): boolean {
	const t = text.toLowerCase().trim();
	if (!t) return false;
	// Strong done/correct/verified assertions. Word-boundaried so "incomplete" doesn't match "complete".
	const CLAIM =
		/\b(all (set|done|good)|you'?re all set|is (now )?(done|complete|finished|ready)|are (now )?(done|complete|finished|up to date|correct)|task (is )?complete|(work|change|changes|implementation|feature|fix) (is|are) (complete|done|finished|ready|correct)|everything (is|looks) (good|correct|done|complete|up to date)|up to date|verified and|fully (working|functional|implemented)|successfully (implemented|completed|deployed|created|added|updated|fixed)|i'?ve (completed|finished|verified|implemented)|has been (completed|implemented|verified|deployed))\b/;
	// Terse / leading completion words a model ends a turn with: "Done.", "Finished.", "Created greet.js".
	const LEAD =
		/^(all\s+)?(done|finished|complete|completed|ready|all set|created|built|implemented|wrote|written|made|set up|installed)\b/;
	// Reporting finished work: "I created the file", "the login page is fixed".
	const PAST =
		/\b(i'?ve|i have|i)\s+(created|added|fixed|updated|implemented|built|wrote|written|set up|made|removed|renamed|installed)\b|\b(the|a|your)\s+[\w.-]+\s+(is|are|has been|have been|was|were)\s+(created|added|fixed|updated|implemented|built|set up|ready|done|working)\b/;
	if (!(CLAIM.test(t) || LEAD.test(t) || PAST.test(t))) return false;
	// Don't fire on a clearly hedged "not done / couldn't / still needs / next step" line.
	if (
		/\b(not (yet )?(done|complete|finished)|couldn'?t|can'?t|unable to|still needs?|todo|to-do|remaining|i'?ll|i will|let me|going to|about to|next i|then i)\b/.test(
			t,
		)
	)
		return false;
	return true;
}
