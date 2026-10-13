import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	getVinciVerificationState,
	resetVinciVerificationState,
} from "../../../vinci/extensions/lib/verification-state.ts";
import registerVerification from "../../../vinci/extensions/vinci-verification.ts";
import { type BashToolOptions, createBashTool } from "../src/core/tools/bash.ts";
import { VINCI_VERIFICATION_ENTRY, verificationEvidenceFromBranch } from "../src/core/vinci-grader.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const active: Harness[] = [];
const diffCommand = "git diff --check -- value.mjs";
const nativeSandboxAvailable =
	(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) ||
	(process.platform === "linux" && ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync));
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
	vi.unstubAllEnvs();
});

async function fixture(valid = true, whitespace = false) {
	resetVinciVerificationState();
	const harness = await createHarness({
		extensionFactories: [registerVerification],
		initialActiveToolNames: ["bash"],
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	active.push(harness);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: harness.tempDir, stdio: "ignore", timeout: 5000 });
	git("init", "--quiet");
	git("config", "user.name", "Vinci receipt fixture");
	git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(harness.tempDir, "value.mjs"), "export const value = 0;\n");
	git("add", "--", "value.mjs");
	git("commit", "--quiet", "-m", "fixture baseline");
	writeFileSync(
		join(harness.tempDir, "value.mjs"),
		`export const value = ${valid ? 1 : 2};${whitespace ? " " : ""}\n`,
	);
	writeFileSync(
		join(harness.tempDir, "review.test.mjs"),
		"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\ntest('selected value is correct', () => assert.equal(value, 1));\n",
	);
	await harness.session.bindExtensions({ mode: "json" });
	return harness;
}

async function checks(harness: Harness, command = diffCommand) {
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", { command: "node --test --test-reporter=spec review.test.mjs", timeout: 10 }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("bash", { command, timeout: 10 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "The fixture ends after observing both actual check results.",
		}),
	]);
	await harness.session.prompt(
		"Run the existing named verifier and the scoped Git formatting check without changing source.",
	);
	expect(harness.getPendingResponseCount()).toBe(0);
	return harness.sessionManager.getBranch();
}

describe("observed Bash completion metadata", () => {
	test.skipIf(!nativeSandboxAvailable)(
		"normal native-sandbox local Bash records an empty exit-zero result without command or environment",
		async () => {
			const harness = await fixture();
			vi.stubEnv("VINCI_CODE", "1");
			vi.stubEnv("VINCI_NO_SANDBOX", "0");
			const result = await createBashTool(harness.tempDir).execute("local-empty", {
				command: diffCommand,
				timeout: 10,
			});
			expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
			expect(result.details?.execution).toEqual({ exitCode: 0, cwd: harness.tempDir, originalCommand: true });
			expect(Object.keys(result.details?.execution ?? {}).sort()).toEqual(["cwd", "exitCode", "originalCommand"]);
		},
	);

	test("an actual nonzero whitespace check preserves the existing error result", async () => {
		const harness = await fixture(true, true);
		await expect(
			createBashTool(harness.tempDir).execute("whitespace", { command: diffCommand, timeout: 10 }),
		).rejects.toThrow("Command exited with code 2");
	});

	test("signal termination remains numerically distinct from exit zero", async () => {
		const harness = await fixture();
		vi.stubEnv("VINCI_CODE", "0");
		const result = await createBashTool(harness.tempDir).execute("signal", { command: "kill -TERM $$", timeout: 10 });
		expect(result.details?.execution).toEqual({ exitCode: null, cwd: harness.tempDir, originalCommand: true });
	});

	for (const [name, options] of [
		["command prefix", { commandPrefix: "true" }],
		["spawn hook", { spawnHook: (context) => ({ ...context, command: "true" }) }],
		["custom shell", { shellPath: "/bin/bash" }],
		["substituted backend", { operations: { exec: async () => ({ exitCode: 0 }) } }],
	] satisfies Array<[string, BashToolOptions]>) {
		test(`${name} cannot attest to the paired original command`, async () => {
			const harness = await fixture();
			const result = await createBashTool(harness.tempDir, options).execute(name, {
				command: diffCommand,
				timeout: 10,
			});
			expect(result.details?.execution).toEqual({ exitCode: 0, cwd: harness.tempDir, originalCommand: false });
		});
	}

	test("a hook records its actual cwd even when it changes the submitted context", async () => {
		const harness = await fixture();
		const child = join(harness.tempDir, "child");
		mkdirSync(child);
		const result = await createBashTool(harness.tempDir, {
			spawnHook: (context) => ({ ...context, cwd: child }),
		}).execute("cwd", { command: "pwd", timeout: 10 });
		expect(result.details?.execution).toEqual({ exitCode: 0, cwd: child, originalCommand: false });
	});
});

describe("shared reviewer supplemental receipts from actual session branches", () => {
	test("a completed named pass and empty scoped Git check are both recorded without changing verifier state", async () => {
		const harness = await fixture();
		const branch = await checks(harness);
		const before = structuredClone(getVinciVerificationState());
		const evidence = verificationEvidenceFromBranch(branch);
		expect(evidence).toContain("Direct check passed after the latest mutation");
		expect(evidence).toContain("Supplemental current-request formatting checks (not behavioral test evidence)");
		expect(evidence).toContain(diffCommand);
		expect(evidence).toContain("observed exit code 0");
		expect(getVinciVerificationState()).toEqual(before);
	});

	test("a successful formatting check cannot clear an actual completed behavioral failure", async () => {
		const harness = await fixture(false);
		const source = readFileSync(join(harness.tempDir, "value.mjs"));
		const branch = await checks(harness);
		const before = structuredClone(getVinciVerificationState());
		const evidence = verificationEvidenceFromBranch(branch);
		expect(before).toMatchObject({
			variant: "normal",
			status: "failed",
			mutationRevision: 0,
			behavioralAttemptCompleted: true,
		});
		expect(evidence).toContain("recorded direct check failed");
		expect(evidence).toContain("observed exit code 0");
		expect(evidence).not.toContain("Direct check passed");
		expect(getVinciVerificationState()).toEqual(before);
		expect(readFileSync(join(harness.tempDir, "value.mjs"))).toEqual(source);
	});

	test("an actual whitespace failure never becomes a supplemental pass", async () => {
		const harness = await fixture(true, true);
		const branch = await checks(harness);
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "bash" && message.isError,
		);
		expect(result).toBeDefined();
		if (result?.role !== "toolResult") throw new Error("Inspect the actual failed Bash result.");
		expect(result.content).toEqual(
			expect.arrayContaining([{ type: "text", text: expect.stringContaining("Command exited with code 2") }]),
		);
		expect(verificationEvidenceFromBranch(branch)).toContain("Direct check passed");
		expect(verificationEvidenceFromBranch(branch)).not.toContain("Supplemental current-request");
	});

	test("a later actual failure of the same scoped command supersedes its earlier success", async () => {
		const harness = await fixture(true, true);
		// Only the owned Git fixture's whitespace policy changes; the tested source bytes stay fixed.
		execFileSync("git", ["config", "core.whitespace", "-blank-at-eol"], { cwd: harness.tempDir, timeout: 5000 });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "node --test --test-reporter=spec review.test.mjs", timeout: 10 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: diffCommand, timeout: 10 }), { stopReason: "toolUse" }),
			() => {
				execFileSync("git", ["config", "core.whitespace", "blank-at-eol"], { cwd: harness.tempDir, timeout: 5000 });
				return fauxAssistantMessage(fauxToolCall("bash", { command: diffCommand, timeout: 10 }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "The fixture ends after measuring the later formatting failure.",
			}),
		]);
		await harness.session.prompt(
			"Run the named verifier and repeat the same scoped formatting check; report its latest observed result.",
		);
		const results = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		);
		expect(results).toHaveLength(3);
		expect(results[1]).toMatchObject({ isError: false, details: { execution: { exitCode: 0 } } });
		expect(results[2]).toMatchObject({ isError: true });
		const failure = results[2];
		if (failure.role !== "toolResult") throw new Error("Inspect the later actual failed Bash result.");
		expect(failure.content).toEqual(
			expect.arrayContaining([{ type: "text", text: expect.stringContaining("Command exited with code 2") }]),
		);
		expect(getVinciVerificationState()).toMatchObject({ status: "passed", mutationRevision: 0 });
		const evidence = verificationEvidenceFromBranch(harness.sessionManager.getBranch());
		expect(evidence).toContain("Direct check passed");
		expect(evidence).not.toContain("Supplemental current-request");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	test("null, absent, substituted, wrong-cwd, duplicate and unmatched receipts are refused beside a fresh positive", async () => {
		const harness = await fixture();
		const original = await checks(harness);
		let resultIndex = -1;
		let callIndex = -1;
		for (let index = 0; index < original.length; index++) {
			const entry = original[index];
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult" && entry.message.toolName === "bash") resultIndex = index;
			if (entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall"))
				callIndex = index;
		}
		expect(resultIndex).toBeGreaterThan(callIndex);
		for (const defect of [
			"null",
			"absent",
			"substituted",
			"cwd",
			"duplicate result",
			"duplicate call",
			"unmatched",
		] as const) {
			const branch = structuredClone(original);
			const entry = branch[resultIndex];
			if (entry.type !== "message" || entry.message.role !== "toolResult")
				throw new Error("Inspect the fixture's canonical Git result.");
			const details = entry.message.details as {
				execution?: { exitCode: number | null; cwd: string; originalCommand: boolean };
			};
			if (defect === "null") details.execution!.exitCode = null;
			if (defect === "absent") delete details.execution;
			if (defect === "substituted") details.execution!.originalCommand = false;
			if (defect === "cwd") details.execution!.cwd = join(harness.tempDir, "other");
			if (defect === "duplicate result") branch.push(structuredClone(entry));
			if (defect === "duplicate call") branch.push(structuredClone(branch[callIndex]));
			if (defect === "unmatched") entry.message.toolCallId = "unmatched-fixture-result";
			expect(verificationEvidenceFromBranch(branch), defect).not.toContain("Supplemental current-request");
		}
		expect(verificationEvidenceFromBranch(original)).toContain("observed exit code 0");
	});

	test("earlier-request receipts and receipts preceding a mutation remain unqualified", async () => {
		const harness = await fixture();
		const original = await checks(harness);
		const priorRequest = structuredClone(original);
		const userEntry = priorRequest.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Inspect the fixture's real request boundary.");
		priorRequest.push(structuredClone(userEntry));
		expect(verificationEvidenceFromBranch(priorRequest)).not.toContain("Supplemental current-request");
		const mutation = structuredClone(original);
		const state = getVinciVerificationState();
		mutation.push({
			type: "custom",
			customType: VINCI_VERIFICATION_ENTRY,
			data: { ...state, status: "stale", mutationRevision: 1 },
		} as (typeof mutation)[number]);
		expect(verificationEvidenceFromBranch(mutation)).toBe("");
		mutation.push({
			type: "custom",
			customType: VINCI_VERIFICATION_ENTRY,
			data: { ...state, mutationRevision: 1, verifiedRevision: 1, behavioralVerifiedRevision: 1 },
		} as (typeof mutation)[number]);
		expect(verificationEvidenceFromBranch(mutation)).toContain("Direct check passed");
		expect(verificationEvidenceFromBranch(mutation)).not.toContain("Supplemental current-request");
		expect(verificationEvidenceFromBranch(original)).toContain("observed exit code 0");
	});

	for (const command of [
		`${diffCommand} && true`,
		`${diffCommand} | cat`,
		`${diffCommand}; true`,
		"git diff --check -- $(printf value.mjs)",
		"git diff --check -- '*.mjs'",
		"git -c core.whitespace= diff --check -- value.mjs",
	]) {
		test(`a scoped-looking command with setup or shell syntax is not direct evidence: ${command}`, async () => {
			const harness = await fixture();
			const branch = await checks(harness, command);
			expect(verificationEvidenceFromBranch(branch)).not.toContain("Supplemental current-request");
		});
	}
});
