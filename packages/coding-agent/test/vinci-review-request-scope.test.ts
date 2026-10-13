import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { captureReviewRequest, gatherReviewEvidence } from "../../../vinci/extensions/lib/grader.ts";
import {
	getVinciVerificationState,
	resetVinciVerificationState,
} from "../../../vinci/extensions/lib/verification-state.ts";
import registerReview from "../../../vinci/extensions/vinci-review.ts";
import registerTodo from "../../../vinci/extensions/vinci-todo.ts";
import registerVerification from "../../../vinci/extensions/vinci-verification.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const active: Harness[] = [];
afterEach(() => {
	for (const harness of active.splice(0)) {
		harness.session.dispose();
		harness.faux.unregister();
		if (existsSync(harness.tempDir)) {
			execFileSync("find", [harness.tempDir, "-mindepth", "1", "-delete"]);
			rmdirSync(harness.tempDir);
		}
	}
	resetVinciVerificationState();
});

function text(context: Context): string {
	return context.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
		)
		.join("\n");
}

async function fixture(valid = true, observer?: (pi: ExtensionAPI) => void): Promise<Harness> {
	resetVinciVerificationState();
	const harness = await createHarness({
		extensionFactories: [registerTodo, registerReview, registerVerification, ...(observer ? [observer] : [])],
		initialActiveToolNames: ["bash", "todo", "review_changes"],
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	active.push(harness);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: harness.tempDir, stdio: "ignore", timeout: 5000 });
	git("init", "--quiet");
	git("config", "user.name", "Vinci review fixture");
	git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(harness.tempDir, "value.mjs"), "export const value = 0;\n");
	git("add", "--", "value.mjs");
	git("commit", "--quiet", "-m", "fixture baseline");
	// The selected patch and its named verifier are present before the actual request starts.
	writeFileSync(join(harness.tempDir, "value.mjs"), `export const value = ${valid ? 1 : 2};\n`);
	writeFileSync(
		join(harness.tempDir, "review.test.mjs"),
		"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\ntest('the selected value meets the request', () => assert.equal(value, 1));\n",
	);
	await harness.session.bindExtensions({ mode: "json" });
	return harness;
}

function reviewResponse(context: Context, requests: string[], failed = false) {
	const request = text(context);
	requests.push(request);
	const grounded =
		request.includes("REQUEST SCOPE EVIDENCE") &&
		request.includes("already present at request start") &&
		request.includes("node --test review.test.mjs");
	const evidence = failed
		? request.includes("recorded direct check failed")
		: request.includes("Direct check passed after the latest mutation");
	return fauxAssistantMessage(
		grounded && evidence
			? failed
				? "The named check demonstrates the incorrect value.\n## Verdict needs work, because the behavioral check failed."
				: "The pre-existing patch satisfies its named check without changes in this request.\n## Verdict ships, because the recorded check passed."
			: "The review request omitted mechanically captured scope or check evidence.\n## Verdict needs work, because the review is not grounded.",
	);
}

describe("actual Vinci reviewer request provenance", () => {
	for (let trial = 1; trial <= 3; trial++) {
		test(`automatic todo review keeps a pre-existing patch read-only and includes actual verifier evidence (${trial}/3)`, async () => {
			const harness = await fixture();
			const requests: string[] = [];
			const before = readFileSync(join(harness.tempDir, "value.mjs"));
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("todo", {
						steps: [
							{ title: "Run tests", status: "doing" },
							{ title: "Assess the selected patch", status: "todo" },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("bash", { command: "node --test review.test.mjs", timeout: 10 }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("todo", {
						steps: [
							{ title: "Run tests", status: "done" },
							{ title: "Assess the selected patch", status: "done" },
						],
					}),
					{ stopReason: "toolUse" },
				),
				(context) => reviewResponse(context, requests),
				fauxAssistantMessage(
					"Completed the read-only verification. The named test passed; no source files changed.",
				),
			]);
			await harness.session.prompt(
				"Review the already selected value patch read-only. Run node --test review.test.mjs and assess it. Do not edit source or tests.",
			);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("diff --git a/value.mjs b/value.mjs");
			expect(requests[0]).toContain("+++ NEW FILE: review.test.mjs");
			expect(requests[0]).toContain("the selected value meets the request");
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && /vinci-plan-review(?:-stop)?$/.test(message.customType),
				),
			).toBe(false);
			expect(readFileSync(join(harness.tempDir, "value.mjs"))).toEqual(before);
			expect(harness.getPendingResponseCount()).toBe(0);
		}, 20_000);
	}

	test("explicit review receives the same captured scope and actual named-check result", async () => {
		const harness = await fixture();
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "node --test review.test.mjs", timeout: 10 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("review_changes", {}), { stopReason: "toolUse" }),
			(context) => reviewResponse(context, requests),
			fauxAssistantMessage("The explicit independent review passed; the current request did not change source."),
		]);
		await harness.session.prompt(
			"Run the named check and explicitly request a separate review of the selected patch. Keep this request read-only.",
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("diff --git a/value.mjs b/value.mjs");
		expect(requests[0]).toContain("already present at request start");
		expect(requests[0]).toContain("Direct check passed after the latest mutation");
		expect(harness.getPendingResponseCount()).toBe(0);
	}, 20_000);

	test("a pre-existing defective patch carries its actual failed check into review", async () => {
		const harness = await fixture(false);
		const requests: string[] = [];
		const before = readFileSync(join(harness.tempDir, "value.mjs"));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "node --test review.test.mjs", timeout: 10 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("review_changes", {}), { stopReason: "toolUse" }),
			(context) => reviewResponse(context, requests, true),
			fauxAssistantMessage(
				"Blocked: the named check demonstrates the incorrect selected value. No source changes were made.",
			),
		]);
		await harness.session.prompt(
			"Inspect the selected patch read-only, run its named check, and explicitly request a separate review. Report a failed check faithfully; do not edit files.",
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("diff --git a/value.mjs b/value.mjs");
		expect(requests[0]).toContain("recorded direct check failed");
		expect(requests[0]).toContain("node --test review.test.mjs");
		expect(requests[0]).not.toContain("Direct check passed");
		expect(readFileSync(join(harness.tempDir, "value.mjs"))).toEqual(before);
		expect(harness.getPendingResponseCount()).toBe(0);
	}, 20_000);

	test("automatic todo review reopens after the actual named check fails on a pre-existing defect", async () => {
		const harness = await fixture(false);
		const requests: string[] = [];
		const before = readFileSync(join(harness.tempDir, "value.mjs"));
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("todo", {
					steps: [
						{ title: "Run tests", status: "doing" },
						{ title: "Assess the selected patch", status: "todo" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: "node --test review.test.mjs", timeout: 10 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("todo", {
					steps: [
						{ title: "Run tests", status: "done" },
						{ title: "Assess the selected patch", status: "done" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => reviewResponse(context, requests, true),
			// This bounded faux stream ends after measuring the real tool/result and review consumer.
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "The fixture ends after the reviewer refusal is captured.",
			}),
		]);
		await harness.session.prompt(
			"Assess the existing defective patch read-only using its named test. Report failures faithfully and do not repair files.",
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("already present at request start");
		expect(requests[0]).toContain("recorded direct check failed");
		expect(requests[0]).not.toContain("Direct check passed");
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "vinci-plan-review",
			),
		).toBe(true);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.toolName === "todo" &&
					(message.details as { reviewed?: boolean } | undefined)?.reviewed,
			),
		).toBe(true);
		expect(readFileSync(join(harness.tempDir, "value.mjs"))).toEqual(before);
		expect(harness.getPendingResponseCount()).toBe(0);
	}, 20_000);

	test("a new real request refreshes the baseline instead of inheriting the previous turn's scope", async () => {
		const scopes: string[] = [];
		const harness = await fixture(true, (pi) =>
			pi.on("agent_start", (_event, ctx) => {
				scopes.push(gatherReviewEvidence(ctx));
			}),
		);
		harness.setResponses([
			fauxAssistantMessage("Observed the selected patch."),
			fauxAssistantMessage("Observed the newly selected patch."),
		]);
		await harness.session.prompt("Inspect the selected patch read-only.");
		writeFileSync(join(harness.tempDir, "value.mjs"), "export const value = 2;\n");
		await harness.session.prompt("Inspect this newly selected patch read-only.");
		expect(scopes).toHaveLength(2);
		for (const scope of scopes) expect(scope).toContain("already present at request start");
		expect(harness.getPendingResponseCount()).toBe(0);
	}, 20_000);

	test("shared agent-start capture does not replace the baseline twice for the same event", async () => {
		let scope = "";
		const harness = await fixture(true, (pi) =>
			pi.on("agent_start", (event, ctx) => {
				writeFileSync(join(ctx.cwd, "value.mjs"), "export const value = 2;\n");
				captureReviewRequest(ctx, event);
				scope = gatherReviewEvidence(ctx);
			}),
		);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "The fixture ends after the request-scope measurement.",
			}),
		]);
		await harness.session.prompt("Capture the request scope before model work.");
		expect(scope).toContain("changed after this request began");
		expect(scope).not.toContain("already present at request start");
	}, 20_000);

	test("an unavailable current Git capture stays uncertain and a fresh positive control still works", async () => {
		let context: ExtensionContext | undefined;
		const harness = await fixture(true, (pi) =>
			pi.on("agent_start", (_event, ctx) => {
				context = ctx;
			}),
		);
		harness.setResponses([fauxAssistantMessage("Observed the selected patch.")]);
		await harness.session.prompt("Inspect the selected patch read-only.");
		expect(context).toBeDefined();
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: harness.tempDir,
			encoding: "utf8",
			timeout: 5000,
		}).trim();
		execFileSync("git", ["update-ref", "-d", "HEAD"], { cwd: harness.tempDir, timeout: 5000 });
		expect(gatherReviewEvidence(context!)).toContain("Current-request Git scope is unknown");
		expect(gatherReviewEvidence(context!)).not.toContain("already present at request start");
		execFileSync("git", ["update-ref", "HEAD", head], { cwd: harness.tempDir, timeout: 5000 });
		expect(gatherReviewEvidence(context!)).toContain("already present at request start");
	}, 20_000);
});

describe("actual Node runner outcomes through Vinci verification", () => {
	for (const trial of [
		{
			name: "named assertion pass",
			valid: true,
			command: "node --test review.test.mjs",
			completed: true,
			failed: false,
		},
		{
			name: "named assertion failure",
			valid: false,
			command: "node --test review.test.mjs",
			completed: true,
			failed: true,
		},
		{
			name: "spec named assertion pass",
			valid: true,
			command: "node --test --test-reporter=spec review.test.mjs",
			completed: true,
			failed: false,
		},
		{
			name: "spec named assertion failure",
			valid: false,
			command: "node --test --test-reporter=spec review.test.mjs",
			completed: true,
			failed: true,
		},
		{
			name: "zero matching test files",
			valid: true,
			command: "node --test --test-reporter=spec 'no-match-*.test.mjs'",
			completed: false,
			failed: false,
		},
		{
			name: "loader startup failure with a file-level failed count",
			valid: true,
			command: "node --test --test-reporter=spec --import=./missing-loader.mjs review.test.mjs",
			completed: false,
			failed: false,
		},
		{
			name: "reporter startup crash without test counts",
			valid: true,
			command: "node --test --test-reporter=missing-reporter review.test.mjs",
			completed: false,
			failed: false,
		},
	]) {
		test(trial.name, async () => {
			const harness = await fixture(trial.valid);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: trial.command, timeout: 10 }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "The fixture ends after the actual runner result is captured.",
				}),
			]);
			await harness.session.prompt(
				`Measure ${trial.name} with the existing named verifier; do not edit source or tests.`,
			);
			const state = getVinciVerificationState();
			expect(state.variant).toBe("normal");
			if (state.variant !== "normal") throw new Error("Inspect the verifier's unexpected terminal state.");
			expect(state.behavioralAttemptCompleted).toBe(trial.completed);
			expect(state.status === "failed").toBe(trial.failed);
			if (trial.completed) {
				expect(state.status).toBe(trial.failed ? "failed" : "passed");
				expect(state.command).toBe(trial.command);
			} else {
				expect(state.status).not.toBe("passed");
				expect(state.requiredCommand).toBe("");
			}
			expect(harness.getPendingResponseCount()).toBe(0);
		}, 20_000);
	}
});
