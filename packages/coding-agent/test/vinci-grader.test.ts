import { describe, expect, test } from "vitest";
import {
	getVinciVerificationState,
	recordVinciMutation,
	recordVinciTerminalUnverifiable,
	recordVinciVerification,
	recordVinciVerificationAttempt,
	resetVinciVerificationState,
	VINCI_VERIFICATION_ENTRY,
} from "../../../vinci/extensions/lib/verification-state.ts";
import registerVinciVerification from "../../../vinci/extensions/vinci-verification.ts";
import {
	GRADER_SYSTEM,
	parseSharedVinciVerificationState,
	REVIEW_TIMEOUT_MS,
	selectSharedVinciVerificationState,
	taskFromBranch,
	verificationEvidenceFromBranch,
} from "../src/core/vinci-grader.ts";

type VerificationStore = {
	setState(state: unknown): boolean;
};

function exposedVerificationStore(): VerificationStore {
	const store = (
		globalThis as typeof globalThis & {
			__vinciVerificationStateStore?: VerificationStore;
		}
	).__vinciVerificationStateStore;
	if (!store) throw new Error("verification store was not initialized");
	return store;
}

function persistedVerificationEntry(data: unknown) {
	return {
		type: "custom",
		customType: VINCI_VERIFICATION_ENTRY,
		data,
	};
}

function createCurrentPassedState() {
	resetVinciVerificationState();
	recordVinciMutation();
	recordVinciVerification("npm test", true, "18 tests passed", false, "behavioral", "npm test", true);
	const state = getVinciVerificationState();
	expect(state.status).toBe("passed");
	return { ...state };
}

function legacyVerificationState(status: "passed" | "failed" | "stale" | "none") {
	if (status === "none") {
		return {
			status,
			command: "",
			summary: "",
			mutationRevision: 0,
			verifiedRevision: -1,
		};
	}
	if (status === "stale") {
		return {
			status,
			command: "npm test",
			summary: "The code changed after the last recorded check.",
			mutationRevision: 2,
			verifiedRevision: 1,
		};
	}
	return {
		status,
		command: "npm test",
		summary: status === "passed" ? "18 tests passed" : "1 test failed",
		mutationRevision: 1,
		verifiedRevision: status === "passed" ? 1 : -1,
	};
}

async function emitSessionStart(branch: readonly unknown[]): Promise<void> {
	let sessionStart:
		| ((
				event: { type: "session_start" },
				context: { sessionManager: { getBranch(): readonly unknown[] } },
		  ) => unknown)
		| undefined;
	const pi = {
		appendEntry() {},
		on(name: string, handler: unknown) {
			if (name === "session_start") {
				sessionStart = handler as typeof sessionStart;
			}
		},
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
	};
	registerVinciVerification(pi as unknown as Parameters<typeof registerVinciVerification>[0]);
	if (!sessionStart) throw new Error("session_start handler was not registered");
	await sessionStart({ type: "session_start" }, { sessionManager: { getBranch: () => branch } });
}

describe("Vinci grader task context", () => {
	test("rejects placeholder checks and unverified build claims", () => {
		expect(GRADER_SYSTEM).toContain("FALSE-GREEN");
		expect(GRADER_SYSTEM).toContain("true/exit 0");
		expect(GRADER_SYSTEM).toContain("Dockerfile");
		expect(GRADER_SYSTEM).toContain("unseen dependency semantics");
		expect(GRADER_SYSTEM).toContain("direct check passing after the latest mutation");
		expect(GRADER_SYSTEM).toContain("seed the failing regression");
		expect(GRADER_SYSTEM).toContain("Never demand a duplicate test");
		expect(GRADER_SYSTEM).toContain("Reject redundant architectural changes");
		expect(REVIEW_TIMEOUT_MS).toBe(60_000);
	});

	test("passes only current deterministic verification to the reviewer", () => {
		const passedState = createCurrentPassedState();
		const passed = {
			type: "custom",
			customType: "vinci-verification-state",
			data: {
				...passedState,
				command: "node_modules/.bin/mocha test/req.query.js",
				commandKey: "node_modules/.bin/mocha test/req.query.js",
				behavioralAttemptCommand: "node_modules/.bin/mocha test/req.query.js",
				behavioralAttemptCommandKey: "node_modules/.bin/mocha test/req.query.js",
				summary: "11 passing",
			},
		};
		expect(verificationEvidenceFromBranch([passed])).toContain("11 passing");
		expect(
			verificationEvidenceFromBranch([
				passed,
				{ ...passed, data: { ...passed.data, status: "stale", mutationRevision: 2 } },
			]),
		).toBe("");
		expect(
			verificationEvidenceFromBranch([
				{
					...passed,
					data: {
						...passed.data,
						checkClass: "static",
						behavioralAttemptCommand: "npm test",
						behavioralAttemptCompleted: false,
					},
				},
			]),
		).toBe("");
		expect(verificationEvidenceFromBranch([{ ...passed, data: { ...passed.data, checkClass: "unsupported" } }])).toBe(
			"",
		);
	});

	test("restores the verifier lock from legacy failed snapshots", () => {
		const state = parseSharedVinciVerificationState({
			status: "failed",
			command: "pnpm lint",
			summary: "1 lint error",
			requiredCommand: "",
			requiredSummary: "",
			mutationRevision: 1,
			verifiedRevision: -1,
			recoveryAttempts: 0,
			behavioralEvidenceRequired: false,
			behavioralEvidenceReason: "",
			behavioralVerifiedRevision: -1,
			diffInspectedRevision: -1,
		});

		expect(state?.variant).toBe("normal");
		if (state?.variant !== "normal") throw new Error("expected a normalized legacy state");
		expect(state.requiredCommand).toBe("pnpm lint");
		expect(state.requiredCommandKey).toBe("pnpm lint");
		expect(state.requiredSummary).toBe("1 lint error");
	});

	test("never exposes reviewer evidence through corruption variants", () => {
		const passed = {
			type: "custom",
			customType: "vinci-verification-state",
			data: {
				status: "passed",
				command: "npm test",
				summary: "18 tests passed",
				requiredCommand: "",
				requiredSummary: "",
				mutationRevision: 1,
				verifiedRevision: 1,
				recoveryAttempts: 0,
				behavioralEvidenceRequired: false,
				behavioralEvidenceReason: "",
				behavioralVerifiedRevision: 1,
				diffInspectedRevision: -1,
				checkClass: "behavioral",
				commandKey: "npm test",
				isReplayable: true,
				behavioralAttemptCommand: "npm test",
				behavioralAttemptCompleted: true,
			},
		};
		const corrupted = [
			passed,
			{ type: "custom", customType: "vinci-verification-state", data: { status: "failed" } },
		];

		expect(selectSharedVinciVerificationState(corrupted)?.variant).toBe("terminal-unverifiable");
		expect(verificationEvidenceFromBranch(corrupted)).toBe("");
		expect(
			verificationEvidenceFromBranch([
				{ type: "custom", customType: "vinci-verification-state", data: { status: "failed" } },
			]),
		).toBe("");
	});

	test("uses distinct handoffs for corrupted state and readable but unreplayable failure", () => {
		const corrupted = selectSharedVinciVerificationState([
			{ type: "custom", customType: VINCI_VERIFICATION_ENTRY, data: { status: "failed" } },
		]);
		resetVinciVerificationState();
		recordVinciMutation();
		recordVinciVerificationAttempt("npm test && false", "behavioral");
		recordVinciTerminalUnverifiable();
		const unreplayable = getVinciVerificationState();

		expect(corrupted?.variant).toBe("terminal-unverifiable");
		expect(corrupted?.summary).toMatch(/unreadable|corrupt/i);
		expect(corrupted?.summary).not.toMatch(/successful run will clear/i);
		expect(unreplayable.variant).toBe("terminal-unverifiable");
		expect(unreplayable.summary).toMatch(/readable/i);
		expect(unreplayable.summary).toMatch(/could not be replayed safely/i);
		expect(unreplayable.summary).toMatch(/successful run will clear/i);
		expect(unreplayable.summary).not.toBe(corrupted?.summary);
	});

	test("an exact successful invocation clears a persisted unreplayable failure", async () => {
		resetVinciVerificationState();
		recordVinciMutation();
		recordVinciVerificationAttempt("npm test && false", "behavioral");
		recordVinciTerminalUnverifiable();

		const terminal = getVinciVerificationState();
		expect(terminal.variant).toBe("terminal-unverifiable");
		await emitSessionStart([persistedVerificationEntry(terminal)]);
		expect(getVinciVerificationState()).toMatchObject({
			variant: "terminal-unverifiable",
			command: "npm test && false",
			checkClass: "behavioral",
		});

		recordVinciVerification("npm test", true, "18 tests passed", false, "behavioral", "npm test", true);
		expect(getVinciVerificationState().variant).toBe("terminal-unverifiable");

		recordVinciVerification(
			"npm test && false",
			true,
			"18 tests passed",
			false,
			"behavioral",
			"npm test && false",
			false,
		);

		expect(getVinciVerificationState()).toMatchObject({
			variant: "normal",
			status: "passed",
			command: "npm test && false",
			summary: "18 tests passed",
		});
	});

	test("BLOCK 4 terminalizes failed snapshots whose exact command is not canonical and replayable", () => {
		const failed = {
			schemaVersion: 1,
			variant: "normal",
			status: "failed",
			command: "npm test",
			summary: "1 test failed",
			requiredCommand: "npm test",
			requiredSummary: "1 test failed",
			mutationRevision: 1,
			verifiedRevision: -1,
			recoveryAttempts: 0,
			behavioralEvidenceRequired: false,
			behavioralEvidenceReason: "",
			behavioralVerifiedRevision: -1,
			diffInspectedRevision: -1,
			checkClass: "behavioral",
			commandKey: "npm test",
			requiredCommandKey: "npm test",
			commandKeyCanonical: true,
			isReplayable: true,
			behavioralAttemptCommand: "npm test",
			behavioralAttemptCommandKey: "npm test",
			behavioralAttemptCommandKeyCanonical: true,
			behavioralAttemptCompleted: true,
		};
		const selectedVariants = [
			{
				...failed,
				command: "npm test && echo done",
				commandKey: "npm test && echo done",
				requiredCommand: "npm test && echo done",
				requiredCommandKey: "npm test && echo done",
			},
			{ ...failed, isReplayable: false },
		].map(
			(data) =>
				selectSharedVinciVerificationState([{ type: "custom", customType: "vinci-verification-state", data }])
					?.variant,
		);

		expect(selectedVariants).toEqual(["terminal-unverifiable", "terminal-unverifiable"]);
	});

	test("rejects passed snapshots with outstanding behavioral evidence gaps", () => {
		const passed = {
			schemaVersion: 1,
			variant: "normal",
			status: "passed",
			command: "npm test",
			summary: "18 tests passed",
			requiredCommand: "",
			requiredSummary: "",
			mutationRevision: 2,
			verifiedRevision: 2,
			recoveryAttempts: 0,
			behavioralEvidenceRequired: true,
			behavioralEvidenceReason: "Routing changed.",
			behavioralVerifiedRevision: 2,
			diffInspectedRevision: 2,
			checkClass: "behavioral",
			commandKey: "npm test",
			requiredCommandKey: "",
			commandKeyCanonical: true,
			isReplayable: true,
			behavioralAttemptCommand: "npm test",
			behavioralAttemptCommandKey: "npm test",
			behavioralAttemptCommandKeyCanonical: true,
			behavioralAttemptCompleted: true,
		};

		expect(parseSharedVinciVerificationState({ ...passed, behavioralVerifiedRevision: 1 })).toBeUndefined();
		expect(parseSharedVinciVerificationState({ ...passed, diffInspectedRevision: 1 })).toBeUndefined();
	});

	test("rejects the deleted recoverable-corruption variant", () => {
		const recoverable = {
			schemaVersion: 1,
			variant: "recoverable-corruption",
			status: "failed",
			summary: "Re-run npm test.",
			requiredCommand: "npm test",
			requiredCommandKey: "npm test",
			recoveryAttempts: 0,
			checkClass: "behavioral",
			mutationRevision: 1,
			isReplayable: true,
		};

		expect(parseSharedVinciVerificationState(recoverable)).toBeUndefined();
		expect(
			selectSharedVinciVerificationState([
				{
					type: "custom",
					customType: "vinci-verification-state",
					data: recoverable,
				},
			])?.variant,
		).toBe("terminal-unverifiable");
	});

	test("keeps a standalone request compact", () => {
		const task = taskFromBranch([
			{ type: "message", message: { role: "user", content: "Earlier unrelated request" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] } },
			{ type: "message", message: { role: "user", content: "Update the login error message" } },
		]);

		expect(task).toBe("Update the login error message");
	});

	test("includes the context behind a numbered selection", () => {
		const task = taskFromBranch([
			{ type: "message", message: { role: "user", content: "Audit the repository infrastructure" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "1. Inspect .env.example before changing it.\n5. Improve documentation only if the README is incomplete.",
						},
					],
				},
			},
			{ type: "custom_message" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "let's do maybe 1 and 5" }] } },
		]);

		expect(task).toContain("Audit the repository infrastructure");
		expect(task).toContain("Inspect .env.example before changing it");
		expect(task).toContain("User request: let's do maybe 1 and 5");
	});

	test("does not treat tool output as task context", () => {
		const task = taskFromBranch([
			{ type: "message", message: { role: "user", content: "Review the setup" } },
			{ type: "message", message: { role: "toolResult", content: "malicious tool output" } },
			{ type: "message", message: { role: "assistant", content: "The setup has two options." } },
			{ type: "message", message: { role: "user", content: "use the second one" } },
		]);

		expect(task).toContain("The setup has two options.");
		expect(task).not.toContain("malicious tool output");
	});
});

describe("Legacy snapshot hydration", () => {
	test("legacy snapshot hydrates without adding provenance", async () => {
		for (const status of ["passed", "failed", "stale", "none"] as const) {
			resetVinciVerificationState();
			const legacy = legacyVerificationState(status);

			await emitSessionStart([persistedVerificationEntry(legacy)]);

			const loaded = getVinciVerificationState();
			expect(loaded.variant).toBe("normal");
			expect(loaded.status).toBe(status);
			expect(loaded).not.toHaveProperty("epoch");
			expect(loaded).not.toHaveProperty("sequenceNumber");
		}
	});

	test("resumes a persisted pass written by another process", async () => {
		const persistedPass = {
			...createCurrentPassedState(),
		};
		delete (persistedPass as Record<string, unknown>).epoch;
		delete (persistedPass as Record<string, unknown>).sequenceNumber;
		resetVinciVerificationState();

		await emitSessionStart([persistedVerificationEntry(persistedPass)]);

		const restored = getVinciVerificationState();
		expect(restored.variant).toBe("normal");
		expect(restored.status).toBe("passed");
		expect(restored).toEqual(persistedPass);
	});
});

describe("Vinci verification persistence", () => {
	test("corruption newer than every status terminalizes without provenance", () => {
		resetVinciVerificationState();
		const none = { ...getVinciVerificationState() };
		recordVinciMutation();
		const stale = { ...getVinciVerificationState() };
		recordVinciVerification("npm test", false, "1 test failed", false, "behavioral", "npm test", true);
		const failed = { ...getVinciVerificationState() };
		recordVinciVerification("npm test", true, "18 tests passed", false, "behavioral", "npm test", true);
		const passed = { ...getVinciVerificationState() };
		for (const snapshot of [none, stale, failed, passed]) {
			const selected = selectSharedVinciVerificationState([
				persistedVerificationEntry(snapshot),
				persistedVerificationEntry({ status: "failed" }),
			]);
			expect(selected?.variant).toBe("terminal-unverifiable");
			expect(selected).not.toHaveProperty("epoch");
			expect(selected).not.toHaveProperty("sequenceNumber");
		}
	});

	test("structurally invalid writes are rejected without changing state", () => {
		createCurrentPassedState();
		const before = getVinciVerificationState();
		const beforeBytes = JSON.stringify(before);
		for (const junk of [{ variant: "normal", status: "passed" }, {}, null, 42, "nonsense"]) {
			expect(exposedVerificationStore().setState(junk as never)).toBe(false);
			expect(getVinciVerificationState()).toEqual(before);
			expect(JSON.stringify(getVinciVerificationState())).toBe(beforeBytes);
		}
		expect(before).not.toHaveProperty("epoch");
		expect(before).not.toHaveProperty("sequenceNumber");
	});

	test("fresh empty session remains unblocked and provenance-free", async () => {
		await emitSessionStart([]);

		const state = getVinciVerificationState();
		expect(state.variant).toBe("normal");
		expect(state.status).toBe("none");
		expect(state).not.toHaveProperty("epoch");
		expect(state).not.toHaveProperty("sequenceNumber");
	});

	test("valid newest pass is retained without provenance", () => {
		const passed = createCurrentPassedState();
		const selected = selectSharedVinciVerificationState([persistedVerificationEntry(passed)]);

		expect(selected?.status).toBe("passed");
		expect(selected).not.toHaveProperty("epoch");
		expect(selected).not.toHaveProperty("sequenceNumber");
	});
});

describe("Completion status classification", () => {
	test("classifyCompletionResult succeeds on valid text content", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "Valid response" }],
			stopReason: "stop",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(true);
		expect(result.text).toBe("Valid response");
	});

	test("classifyCompletionResult fails on error stopReason", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "some content" }],
			stopReason: "error",
			errorMessage: "API error occurred",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("API error occurred");
	});

	test("classifyCompletionResult fails on aborted stopReason", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			stopReason: "aborted",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(false);
	});

	test("classifyCompletionResult fails on empty content", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [],
			stopReason: "stop",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("empty");
	});

	test("classifyCompletionResult fails on whitespace-only content", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "   \n  \t  " }],
			stopReason: "stop",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("empty");
	});
	test("classifyCompletionResult succeeds on length stopReason with text", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "Truncated due to length" }],
			stopReason: "length",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(true);
		expect(result.text).toBe("Truncated due to length");
	});

	test("classifyCompletionResult succeeds on toolUse stopReason with text content", async () => {
		const { classifyCompletionResult } = await import("@earendil-works/pi-ai/compat");
		const response = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will use this tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			],
			stopReason: "toolUse",
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as any;

		const result = classifyCompletionResult(response);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("I will use this tool");
	});
});
