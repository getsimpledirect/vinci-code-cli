/**
 * A terminal agent_end handler runs while the run is still streaming (#171): a follow-up request
 * must be queued with streamingBehavior "followUp" (or sendUserMessage with deliverAs "followUp").
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

type Delivery = "plain" | "followUp";

async function runWithTerminalFollowUp(
	responses: Parameters<typeof createHarnessWithExtensions>[0]["responses"],
	delivery: Delivery,
	retry = { enabled: false, maxRetries: 0, baseDelayMs: 1 },
) {
	const outcomes: string[] = [];
	let harness!: Harness;
	harness = await createHarnessWithExtensions({
		responses,
		settings: { retry },
		extensionFactories: [
			(pi) => {
				pi.on("agent_end", async (event) => {
					if (event.willRetry || outcomes.length > 0) return;
					try {
						await harness.session.prompt(
							"follow-up",
							delivery === "followUp" ? { streamingBehavior: "followUp" } : undefined,
						);
						outcomes.push("queued");
					} catch (error) {
						outcomes.push(error instanceof Error ? error.message : String(error));
					}
				});
			},
		],
	});
	await harness.session.prompt("first");
	await harness.session.agent.waitForIdle();
	return { harness, outcomes };
}

describe("follow-up request from a terminal agent_end handler (#171)", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("a plain prompt() is refused while the run is still streaming", async () => {
		const run = await runWithTerminalFollowUp(["done"], "plain");
		harness = run.harness;
		expect(run.outcomes).toHaveLength(1);
		expect(run.outcomes[0]).toMatch(/already processing.*followUp/);
		expect(harness.faux.callCount).toBe(1);
	});

	it("a followUp prompt runs once the run ends", async () => {
		const run = await runWithTerminalFollowUp(["done", "follow-up done"], "followUp");
		harness = run.harness;
		expect(run.outcomes).toEqual(["queued"]);
		expect(harness.faux.callCount).toBe(2);
		expect(
			harness.session.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("follow-up")),
		).toBe(true);
	});

	it("a followUp prompt runs after retries are exhausted", async () => {
		const run = await runWithTerminalFollowUp(
			[{ error: "Connection error." }, { error: "Connection error." }, "follow-up done"],
			"followUp",
			{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
		);
		harness = run.harness;
		expect(run.outcomes).toEqual(["queued"]);
		expect(harness.faux.callCount).toBe(3);
	});
});
