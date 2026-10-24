import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("Vinci AgentSession completion review scope", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_NO_VERIFY", "0");
		// This lane exercises the completion gate and real tools, independently of OS sandbox support.
		vi.stubEnv("VINCI_NO_SANDBOX", "1");
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
	});

	async function fixture(): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit", "write"],
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		execFileSync("git", ["init", "--quiet"], { cwd: harness.tempDir, timeout: 5000 });
		writeFileSync(join(harness.tempDir, "value.txt"), "pre-existing work\n");
		return harness;
	}

	it.each([false, true])("does not grade pre-existing work after a read-only turn (read tool: %s)", async (read) => {
		const harness = await fixture();
		const responses: FauxResponseStep[] = [];
		if (read) {
			responses.push(fauxAssistantMessage(fauxToolCall("read", { path: "value.txt" }), { stopReason: "toolUse" }));
		}
		responses.push(fauxAssistantMessage("All done. The explanation is complete."));
		responses.push(fauxAssistantMessage("## Verdict risky, because this review must remain unrequested."));
		harness.setResponses(responses);

		await harness.session.prompt("Explain the existing work without changing any files.");

		expect(readFileSync(join(harness.tempDir, "value.txt"), "utf8")).toBe("pre-existing work\n");
		expect(harness.faux.state.callCount).toBe(read ? 2 : 1);
		expect(harness.getPendingResponseCount(), "an unrelated diff must not consume an independent review").toBe(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("All done. The explanation is complete.");
		if (read) {
			expect(harness.eventsOfType("tool_execution_end")).toMatchObject([{ toolName: "read", isError: false }]);
		}
	});

	it.each(["edit", "write"] as const)(
		"grades a current-turn %s, then excludes it from a later read-only turn",
		async (toolName) => {
			const harness = await fixture();
			const reviewRequests: string[] = [];
			const args =
				toolName === "edit"
					? { path: "value.txt", edits: [{ oldText: "pre-existing work", newText: "updated work" }] }
					: { path: "value.txt", content: "updated work\n" };
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" }),
				fauxAssistantMessage("All done. The requested change is complete."),
				(context) => {
					reviewRequests.push(context.messages.map(getMessageText).join("\n"));
					return fauxAssistantMessage("## Verdict ships, because the selected change matches the task.");
				},
			]);

			await harness.session.prompt("Update value.txt to say updated work.");

			expect(readFileSync(join(harness.tempDir, "value.txt"), "utf8")).toBe("updated work\n");
			expect(harness.eventsOfType("tool_execution_end")).toMatchObject([{ toolName, isError: false }]);
			expect(reviewRequests).toHaveLength(1);
			expect(reviewRequests[0]).toContain("TASK:\nUpdate value.txt to say updated work.");
			expect(reviewRequests[0]).toContain("DIFF:");
			expect(reviewRequests[0]).toContain("+updated work");
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.getPendingResponseCount()).toBe(0);

			harness.setResponses([
				fauxAssistantMessage("All done. The explanation is complete."),
				fauxAssistantMessage("## Verdict risky, because an earlier turn must not trigger this review."),
			]);
			await harness.session.prompt("Explain that change without changing any files.");

			expect(readFileSync(join(harness.tempDir, "value.txt"), "utf8")).toBe("updated work\n");
			expect(harness.faux.state.callCount).toBe(4);
			expect(harness.getPendingResponseCount(), "the latest real user message bounds review authorship").toBe(1);
			expect(getMessageText(harness.session.messages.at(-1))).toBe("All done. The explanation is complete.");
		},
	);
});
