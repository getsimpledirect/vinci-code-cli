/**
 * Extension-side grader wrappers for the verification system (see vinci/docs/verification.md).
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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
	gatherDiff,
	type GraderCompleteOpts,
	type GraderVerdict,
	parseGraderVerdict,
	runReview,
	taskFromBranch,
	verificationEvidenceFromBranch,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordVinciTaskCall } from "./usage-accumulator.ts";
import { vinciVerificationDisabled } from "./verification-control.ts";

// Re-export the primitives under the names the tools already import (stable API for this layer).
export { GRADER_SYSTEM, gatherDiff, parseGraderVerdict, runReview } from "@earendil-works/pi-coding-agent";
export type CompleteOpts = GraderCompleteOpts;
export type Verdict = GraderVerdict;

type ReviewSnapshot = { root: string; head: string; digest: string; paths: number };
type ReviewBaselines = WeakMap<object, { event: object; snapshot: ReviewSnapshot | null }>;
const reviewGlobal = globalThis as typeof globalThis & { __vinciReviewRequestBaselines?: ReviewBaselines };
const requestBaselines = reviewGlobal.__vinciReviewRequestBaselines ??= new WeakMap();
const SNAPSHOT_TIMEOUT_MS = 5000;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const SNAPSHOT_MAX_PATHS = 2000;

// Metadata only: captures staged/unstaged/untracked status without reading credentials or file
// contents. Unknown/overflow captures never establish that the request left the tree unchanged.
function reviewSnapshot(cwd: string): ReviewSnapshot | null {
	try {
		const git = (args: string[]) => {
			const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
				cwd, encoding: "utf8", timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_BYTES,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error("Git capture unavailable");
			return result.stdout;
		};
		const root = git(["rev-parse", "--show-toplevel"]).trim();
		const head = git(["rev-parse", "HEAD"]).trim();
		const records = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
		const signatures = [];
		for (let index = 0; index < records.length; index++) {
			const record = records[index];
			if (!record) continue;
			if (signatures.length >= SNAPSHOT_MAX_PATHS) return null;
			const status = record.slice(0, 2);
			const path = record.slice(3);
			let signature = "missing";
			try {
				const stat = lstatSync(resolve(root, path), { bigint: true });
				signature = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			signatures.push(`${record}:${signature}`);
			if (status.includes("R") || status.includes("C")) signatures.push(`source:${records[++index] ?? ""}`);
			if (signatures.length > SNAPSHOT_MAX_PATHS) return null;
		}
		return { root, head, paths: signatures.length, digest: createHash("sha256").update(JSON.stringify(signatures.sort())).digest("hex") };
	} catch {
		return null;
	}
}

export function captureReviewRequest(ctx: ExtensionContext, event: object): void {
	if (requestBaselines.get(ctx.sessionManager)?.event === event) return;
	requestBaselines.set(ctx.sessionManager, { event, snapshot: reviewSnapshot(ctx.cwd) });
}

export function gatherReviewEvidence(ctx: ExtensionContext): string {
	const baseline = requestBaselines.get(ctx.sessionManager)?.snapshot;
	const current = reviewSnapshot(ctx.cwd);
	const sameRoot = baseline && current && baseline.root === current.root;
	const scope = !sameRoot
		? "Current-request Git scope is unknown because a baseline/current capture was unavailable or the repository changed. The diff alone cannot establish when changes occurred."
		: baseline.head === current.head && baseline.digest === current.digest
			? `The Git HEAD and metadata-visible staged, unstaged and untracked state are unchanged since this request began (${baseline.paths} status records). The current diff was already present at request start; do not attribute it to this request.`
			: "Git HEAD or metadata-visible staged, unstaged or untracked state changed after this request began. Do not treat the entire working-tree diff as newly authored; inspect the change and task scope.";
	const branch = ctx.sessionManager.getBranch();
	const verification = verificationEvidenceFromBranch(branch);
	return [
		`REQUEST SCOPE EVIDENCE (captured before model work, not author prose):\n${scope}\nThis capture does not cover ignored files, transient changes, or paths outside the repository, and does not prove patch correctness.`,
		verification,
	].filter(Boolean).join("\n\n");
}

/** The most recent real user request on the branch — what the change is meant to accomplish. */
export function gatherTask(ctx: ExtensionContext): string {
	return taskFromBranch(ctx.sessionManager.getBranch() as ReadonlyArray<{ type?: string; message?: { role?: string; content?: unknown } }>);
}

/** Explicit current-user constraint only; a plan, reviewer, quote or earlier request cannot set it. */
export function currentRequestForbidsEdits(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const prose = text
			.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
			.replace(/^\s*>.*$/gm, " ")
			.replace(/`[^`\n]*(?:`|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’/g, " ");
		// These explicit declarations are supported, not a general natural-language intent classifier.
		return /(?:^|[.!?;]\s+)This is a read-only (?:verification|review|assessment) request\s*[:,.]/i.test(prose) &&
			/\b(?:do|must) not edit(?:, write, stage, commit, restore, or remove)? any project files?\b/i.test(prose);
	}
	return false;
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
		gatherReviewEvidence(ctx),
	);
	// runReview returns "" on error/empty content — propagate as null failure signal
	if (!text) return null;
	return { text, verdict: parseGraderVerdict(text) };
}
