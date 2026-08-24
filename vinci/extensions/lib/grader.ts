/**
 * Extension-side grader wrappers for the verification system (see vinci/docs/VERIFICATION_SYSTEM.md).
 *
 * The PRIMITIVES (untracked-aware diff, skeptical grader prompt, review call, verdict parsing) now
 * live in the coding-agent CORE (`core/vinci-grader.ts`, re-exported from the package) so that ONE
 * check is shared by the core turn-end enforcement AND the extensions — "trust the check, not the
 * claim" only works if there's a single implementation. This file adds the thin, ExtensionContext-
 * flavored wrappers the tools need (task from the session branch; one-call grade for the auto-run).
 *
 * Used by `vinci-review.ts` (the review_changes tool + /review) AND `vinci-todo.ts` (auto-run on
 * "all steps done"). Additive — no core edits beyond the shared primitive file.
 */
import {
	gatherDiff,
	type GraderCompleteOpts,
	type GraderVerdict,
	parseGraderVerdict,
	runReview,
	taskFromBranch,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordVinciTaskCall } from "./usage-accumulator.ts";
import { vinciVerificationDisabled } from "./verification-control.ts";

// Re-export the primitives under the names the tools already import (stable API for this layer).
export { GRADER_SYSTEM, gatherDiff, parseGraderVerdict, runReview } from "@earendil-works/pi-coding-agent";
export type CompleteOpts = GraderCompleteOpts;
export type Verdict = GraderVerdict;

/** The most recent real user request on the branch — what the change is meant to accomplish. */
export function gatherTask(ctx: ExtensionContext): string {
	return taskFromBranch(ctx.sessionManager.getBranch() as ReadonlyArray<{ type?: string; message?: { role?: string; content?: unknown } }>);
}

/** One-call grade for the auto-run path: gather the real state, grade it, return text + verdict. */
export async function gradeChanges(ctx: ExtensionContext, taskOverride?: string): Promise<{ text: string; verdict: Verdict } | null> {
	if (vinciVerificationDisabled()) return null;
	if (!ctx.model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) return null;
	const diff = gatherDiff(ctx.cwd);
	if (!diff) return { text: "No uncommitted changes to review.", verdict: "none" };
	const task = taskOverride?.trim() || gatherTask(ctx);
	const taskId = ctx.sessionManager.getSessionId();
	const text = await runReview(
		ctx.model,
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal: ctx.signal,
			onUsage: (response) => recordVinciTaskCall(taskId, response, "grader"),
		},
		task,
		diff,
	);
	// runReview returns "" on error/empty content — propagate as null failure signal
	if (!text) return null;
	return { text, verdict: parseGraderVerdict(text) };
}
