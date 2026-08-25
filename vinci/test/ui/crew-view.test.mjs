import "./env.mjs";
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";

const rpcFixture = vi.hoisted(() => {
	const instances = [];

	class FakeRpcClient {
		constructor() {
			this.listeners = [];
			this.steered = [];
			this.finishOnNextState = false;
			instances.push(this);
		}

		async start() {}

		onEvent(listener) {
			this.listeners.push(listener);
			return () => {
				this.listeners = this.listeners.filter((candidate) => candidate !== listener);
			};
		}

		async setSessionName() {}

		async getState() {
			if (this.finishOnNextState) {
				this.finishOnNextState = false;
				for (const listener of this.listeners) listener({ type: "agent_end", messages: [] });
				return { isStreaming: false, sessionFile: "<fake-agent-session>" };
			}
			return { isStreaming: true, sessionFile: "<fake-agent-session>" };
		}

		async promptAndWait() {
			for (const listener of this.listeners) {
				listener({ type: "agent_start" });
				listener({
					type: "message_update",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "LIVE AGENT TRANSCRIPT SENTINEL" }],
					},
					assistantMessageEvent: { type: "text_delta", delta: "LIVE AGENT TRANSCRIPT SENTINEL" },
				});
			}
			return new Promise(() => {});
		}

		async getMessages() {
			return [];
		}

		async getEntries() {
			return { entries: [] };
		}

		async getSessionStats() {
			return { tokens: { total: 0 } };
		}

		async getLastAssistantText() {
			return undefined;
		}

		async steer(message) {
			this.steered.push(message);
		}

		async stop() {}
	}

	return { FakeRpcClient, instances };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal()),
	RpcClient: rpcFixture.FakeRpcClient,
}));

import vinciCrew, * as crew from "../../extensions/vinci-crew.ts";
import { createVinciUiHarness, expectSnapshot } from "./harness.mjs";

const NOW = 2_000_000_000_000;
const openHarnesses = [];
let previousCapacity;

afterEach(async () => {
	while (openHarnesses.length > 0) {
		const ui = openHarnesses.pop();
		await ui.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await ui.close();
	}
	vi.restoreAllMocks();
	if (previousCapacity === undefined) delete process.env.VINCI_CREW_CAPACITY;
	else process.env.VINCI_CREW_CAPACITY = previousCapacity;
	previousCapacity = undefined;
	rpcFixture.instances.length = 0;
});

function seedCrew(entries) {
	return (pi) => {
		pi.on("session_start", async () => {
			for (const entry of entries) pi.appendEntry("vinci-crew-helper", entry);
		});
	};
}

// [vinci] Exercise terminal-input arbitration while an extension-owned modal has focus.
function modalPromptExtension(pi) {
	pi.registerCommand("crew-modal-test", {
		description: "Open a modal prompt for crew navigation testing",
		handler: async (_args, ctx) => {
			await ctx.ui.select("Allow build tools?", ["Keep blocked", "Allow build tools"]);
		},
	});
}

async function createCrewUi(entries = [], options = {}) {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const ui = await createVinciUiHarness({
		connected: true,
		...options,
		extensions: [
			{
				factory: seedCrew(entries),
				path: "vinci/test/ui/crew-seed-extension.ts",
			},
			{
				factory: vinciCrew,
				path: "vinci/extensions/vinci-crew.ts",
			},
			...(options.extensions ?? []),
		],
	});
	openHarnesses.push(ui);
	return ui;
}

async function spawnAgent(ui, name, task) {
	const runner = ui.session.extensionRunner;
	const tool = runner.getToolDefinition("spawn_helper");
	assert.ok(tool, "crew must register spawn_helper");
	await tool.execute(
		`spawn-${name}`,
		{ name, task },
		new AbortController().signal,
		() => {},
		runner.createContext(),
	);
	await ui.settle();
}

async function openAgentViewer(ui) {
	// Don't wait on the agent's own name here: callers spawn agents under different names,
	// and one deliberately uses a name full of escape sequences that never renders verbatim.
	// spawnAgent() already settled the frame, so the roster row is on screen by now.
	ui.sendKeys("\x1b[B"); // down arrow to enter nav mode
	await ui.waitForText("↑↓ move", 10000);
	ui.sendKeys("\r"); // enter to open agent
	// Anchor on the hint, not the compose line: the compose block is deliberately dropped on very
	// short terminals, but "Esc to close" must render at every size — that's the point of it.
	await ui.waitForText("Esc to close", 10000);
}

async function expectCrewSnapshot(name, ui) {
	await expectSnapshot(name, {
		async screen() {
			return (await ui.screen()).replace(/^ (?=● main|  [✓◐○!✗]|  ↓ browse)/gm, "");
		},
	});
}

function transcriptHelper() {
	return { status: "working", name: "kind-test", task: "test transcript kinds" };
}

function transcriptTheme() {
	return {
		fg(color, text) {
			return `<${color}>${text}</${color}>`;
		},
	};
}

function toolExecutionEnd(isError, text) {
	return {
		type: "tool_execution_end",
		toolCallId: `tool-${isError ? "error" : "result"}-${text}`,
		toolName: "read",
		result: { content: [{ type: "text", text }] },
		isError,
	};
}

describe("Vinci crew agent full-screen view", { concurrency: false }, () => {
	test("tool-result line renders differently from agent narration", () => {
		assert.equal(typeof crew.transcriptLineKind, "function", "the transcript kind reader must be exported for verification");
		assert.equal(typeof crew.renderTranscriptLine, "function", "the production transcript renderer must be testable");
		const helper = transcriptHelper();
		crew.reduceHelperEvent(helper, toolExecutionEnd(false, "TOOL RESULT SENTINEL"));
		crew.reduceHelperEvent(helper, {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "AGENT NARRATION SENTINEL" }] },
			assistantMessageEvent: { type: "text_delta", delta: "AGENT NARRATION SENTINEL" },
		});

		const resultLine = helper.liveTranscript?.find((line) => line.includes("TOOL RESULT SENTINEL"));
		const narrationLine = crew.viewerTranscriptLines(helper).find((line) => line.includes("AGENT NARRATION SENTINEL"));
		assert.equal(crew.transcriptLineKind(resultLine), "toolResult");
		assert.equal(crew.transcriptLineKind(narrationLine), "narration");
		const resultRendered = crew.renderTranscriptLine(transcriptTheme(), resultLine, 80);
		const narrationRendered = crew.renderTranscriptLine(transcriptTheme(), narrationLine, 80);
		assert.match(resultRendered, /^<dim>/, "tool results must receive lower visual weight");
		assert.doesNotMatch(narrationRendered, /^</, "agent narration must remain the strongest, unstyled text");
		assert.notEqual(resultRendered, narrationRendered, "tool results and narration must render with different colors");

		const messageHelper = transcriptHelper();
		crew.reduceHelperEvent(messageHelper, {
			type: "message_end",
			message: {
				role: "toolResult",
				content: [{ type: "tool_result", isError: false, content: [{ type: "text", text: "STRUCTURED RESULT" }] }],
			},
		});
		assert.equal(
			crew.transcriptLineKind(messageHelper.liveTranscript?.find((line) => line.includes("STRUCTURED RESULT"))),
			"toolResult",
			"message_end must read tool_result kind from message.content",
		);

		const cappedHelper = transcriptHelper();
		crew.reduceHelperEvent(cappedHelper, toolExecutionEnd(false, `CAP START ${"x".repeat(30_010)} CAP END`));
		const cappedLine = crew.viewerTranscriptLines(cappedHelper)[0];
		assert.ok(cappedLine.length <= 30_000, "the existing character cap must still include marker overhead");
		assert.equal(crew.transcriptLineKind(cappedLine), "toolResult", "the kind marker must survive character slicing");
	});

	test("failed tool result renders differently from successful one based only on isError", () => {
		assert.equal(typeof crew.transcriptLineKind, "function", "the transcript kind reader must be exported for verification");
		assert.equal(typeof crew.renderTranscriptLine, "function", "the production transcript renderer must be testable");
		const helper = transcriptHelper();
		crew.reduceHelperEvent(helper, toolExecutionEnd(true, "Everything succeeded cleanly"));
		crew.reduceHelperEvent(helper, toolExecutionEnd(false, "This failed with an error"));

		const errorLine = helper.liveTranscript?.find((line) => line.includes("Everything succeeded cleanly"));
		const resultLine = helper.liveTranscript?.find((line) => line.includes("This failed with an error"));
		assert.equal(crew.transcriptLineKind(errorLine), "toolError", "isError=true must win over success-looking prose");
		assert.equal(crew.transcriptLineKind(resultLine), "toolResult", "isError=false must win over failure-looking prose");
		const errorRendered = crew.renderTranscriptLine(transcriptTheme(), errorLine, 80);
		const resultRendered = crew.renderTranscriptLine(transcriptTheme(), resultLine, 80);
		assert.match(errorRendered, /^<warning>/);
		assert.match(resultRendered, /^<dim>/);
		assert.notEqual(errorRendered, resultRendered, "failed and successful tool results must use different colors");
	});

	test("old transcript without markers still renders unstyled", () => {
		assert.equal(typeof crew.renderTranscriptLine, "function", "the production transcript renderer must be testable");
		const oldLines = ["you › hello", "  ⚙ read", "some agent narration", "13KB of results"];
		const restored = crew.viewerTranscriptLines({ transcript: oldLines });
		assert.deepEqual(restored, oldLines, "pre-change saved transcript text must remain intact");
		const rendered = restored.map((line) => crew.renderTranscriptLine(transcriptTheme(), line, 80));
		assert.deepEqual(rendered, oldLines, "unmarked saved lines must not be classified from their prose or prefixes");
		assert.doesNotMatch(rendered.join("\n"), /\uE000|<(?:toolResult|narration)>/, "internal marker text must never render");
	});

	test("long tool-result paths are shortened after secrets are masked", () => {
		assert.equal(typeof crew.renderTranscriptLine, "function", "the production transcript renderer must be testable");
		const helper = transcriptHelper();
		const longPath = "/private/var/folders/9c/xxx/vinci-helper-4-J8039b/src/pages/About.jsx";
		const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
		crew.reduceHelperEvent(helper, toolExecutionEnd(false, `${longPath} apiKey=${secret}`));

		const line = crew.viewerTranscriptLines(helper).find((candidate) => candidate.includes("About.jsx"));
		assert.equal(crew.transcriptLineKind(line), "toolResult", "masking and path shortening must preserve the kind marker");
		const rendered = crew.renderTranscriptLine(transcriptTheme(), line, 120);
		assert.doesNotMatch(rendered, new RegExp(longPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the long absolute path must not render in full");
		assert.match(rendered, /…\/.*About\.jsx/, "the shortened path must retain the filename unchanged");
		assert.match(rendered, /About\.jsx/, "the filename must remain visible");
		assert.doesNotMatch(rendered, /abcdefghijklmnopqrstuvwxyz1234567890/, "path shortening must not expose masked secret text");
	});

	// Only WAITING is actionable — it is the sole status `canApply` accepts. `blocked` looks like it
	// needs a decision but every path that sets it does so BECAUSE no patch survived, so there is
	// nothing to apply. Treating it as actionable left dead rows pinned on screen forever.
	test("only waiting work is protected from retiring", { timeout: 15000 }, async () => {
		const ui = await createCrewUi([
			{ id: 21, name: "waiting-old", task: "review work", status: "waiting", finishedAt: NOW - 90_000, notifiedAt: NOW - 89_000, deliveredAt: NOW - 89_000 },
			{ id: 22, name: "blocked-old", task: "no patch survived", status: "blocked", finishedAt: NOW - 90_000, notifiedAt: NOW - 89_000, deliveredAt: NOW - 89_000 },
			{ id: 23, name: "failed-old", task: "hide inert failure", status: "failed", finishedAt: NOW - 90_000, notifiedAt: NOW - 89_000, deliveredAt: NOW - 89_000 },
		]);

		const screen = await ui.screen();
		assert.match(screen, /waiting-old/, "work waiting to be applied must never disappear on a timer");
		assert.doesNotMatch(screen, /blocked-old/, "a blocked agent has no patch to apply, so it must retire");
		assert.doesNotMatch(screen, /failed-old/, "an inert failed row must expire");
	});

	test("the first agent stays selectable — up stops at the top", { timeout: 15000 }, async () => {
		const ui = await createCrewUi([
			{ id: 31, name: "first-agent", task: "top of the list", status: "waiting", finishedAt: NOW - 1000, notifiedAt: NOW - 900, deliveredAt: NOW - 900 },
			{ id: 32, name: "second-agent", task: "below it", status: "waiting", finishedAt: NOW - 1000, notifiedAt: NOW - 900, deliveredAt: NOW - 900 },
		]);

		ui.sendKeys("\x1b[B"); // arm nav on the first row
		await ui.waitForText("↑↓ move", 10000);
		ui.sendKeys("\x1b[B"); // move to the second
		await ui.settle();
		ui.sendKeys("\x1b[A"); // back to the first
		await ui.settle();
		ui.sendKeys("\x1b[A"); // and again — must NOT drop out of navigation
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /↑↓ move/, "pressing up at the top must keep navigation active, not exit it");
		assert.match(screen, /›[^\n]*first-agent/, "the cursor must rest on the first agent");
	});

	test("a dismissed agent leaves the strip but stays in /agents", { timeout: 15000 }, async () => {
		const ui = await createCrewUi([
			{ id: 24, name: "dismissed-one", task: "cleared by hand", status: "waiting", finishedAt: NOW - 1000, notifiedAt: NOW - 900, deliveredAt: NOW - 900, dismissedAt: NOW - 500 },
			{ id: 25, name: "kept-one", task: "still needs review", status: "waiting", finishedAt: NOW - 1000, notifiedAt: NOW - 900, deliveredAt: NOW - 900 },
		]);

		const screen = await ui.screen();
		assert.doesNotMatch(screen, /dismissed-one/, "a dismissed row must leave the strip even while waiting");
		assert.match(screen, /kept-one/, "other waiting rows are unaffected");

		const { completion } = await ui.startPrompt("/agents");
		await ui.waitForText("Your agents", 10000);
		assert.match(await ui.screen(), /dismissed-one/, "dismissing hides the row, it never discards the work");
		ui.sendKeys("\x1b");
		await completion;
	});

	test("failed rows disappear after 60 seconds but remain available through agents", { timeout: 15000 }, async () => {
		const nativeSetTimeout = globalThis.setTimeout;
		let expiryRepaint;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			if (delay === 5_000) {
				expiryRepaint = callback;
				return { unref() {} };
			}
			return nativeSetTimeout(callback, delay, ...args);
		});
		const ui = await createCrewUi([
			{ id: 24, name: "waiting-anchor", task: "keep roster active", status: "waiting", finishedAt: NOW - 90_000, notifiedAt: NOW - 89_000, deliveredAt: NOW - 89_000 },
			{ id: 25, name: "failed-expiring", task: "hide after one minute", status: "failed", finishedAt: NOW - 45_000, notifiedAt: NOW - 44_000, deliveredAt: NOW - 44_000 },
		]);

		assert.match(await ui.screen(), /failed-expiring/, "a 45-second-old failed row must still render");
		assert.equal(typeof expiryRepaint, "function", "the roster must schedule a one-shot repaint for the next failed-row transition");
		vi.mocked(Date.now).mockReturnValue(NOW + 20_000);
		expiryRepaint();
		await ui.settle();
		assert.doesNotMatch(await ui.screen(), /failed-expiring/, "a 65-second-old failed row must be hidden from the roster");

		const { completion } = await ui.startPrompt("/agents");
		await ui.waitForText("Your agents", 10000);
		assert.match(await ui.screen(), /failed-expiring/, "hidden failed helpers must remain available through /agents");
		ui.sendKeys("\x1b");
		await completion;
	});

	test("Tab switches to the next agent", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "agent-A", "TASK FOR AGENT A");
		await spawnAgent(ui, "agent-B", "TASK FOR AGENT B");

		await openAgentViewer(ui);
		ui.sendKeys("\t");
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /Agent · agent-B/, "Tab must show the next agent's name");
		assert.match(screen, /Task: TASK FOR AGENT B/, "Tab must show the next agent's task");
		assert.doesNotMatch(screen, /TASK FOR AGENT A/, "the previous agent's task must be gone");
	});

	test("Shift+Tab returns to the previous agent", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "agent-A", "TASK FOR AGENT A");
		await spawnAgent(ui, "agent-B", "TASK FOR AGENT B");

		await openAgentViewer(ui);
		ui.sendKeys("\t");
		await ui.settle();
		assert.match(await ui.screen(), /Agent · agent-B/, "Tab must reach agent B before testing Shift+Tab");
		ui.sendKeys("\x1b[Z");
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /Agent · agent-A/, "Shift+Tab must return to the previous agent");
		assert.match(screen, /Task: TASK FOR AGENT A/, "Shift+Tab must restore the previous agent's task");
		assert.doesNotMatch(screen, /TASK FOR AGENT B/, "the next agent's task must be gone");
	});

	test("Tab wraps from the last agent to the first", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "agent-A", "TASK FOR AGENT A");
		await spawnAgent(ui, "agent-B", "TASK FOR AGENT B");

		ui.sendKeys("\x1b[B");
		await ui.waitForText("↑↓ move", 10000);
		ui.sendKeys("\x1b[B");
		ui.sendKeys("\r");
		await ui.waitForText("Agent · agent-B", 10000);
		ui.sendKeys("\t");
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /Agent · agent-A/, "Tab must wrap from the last agent to the first");
		assert.match(screen, /Task: TASK FOR AGENT A/, "the wrapped viewer must show the first agent's task");
	});

	test("compose text is isolated when switching agents", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "agent-A", "TASK FOR AGENT A");
		await spawnAgent(ui, "agent-B", "TASK FOR AGENT B");

		await openAgentViewer(ui);
		ui.sendKeys("my message to A");
		ui.sendKeys("\t");
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /Agent · agent-B/, "Tab must switch to agent B");
		assert.doesNotMatch(screen, /my message to A/, "agent A's compose text must not appear in agent B's viewer");
	});

	test("submitting compose text steers the active RPC child with the trimmed payload", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "steered-agent", "Accept a live steering instruction");
		await openAgentViewer(ui);
		const rpc = rpcFixture.instances.at(-1);
		assert.ok(rpc, "spawn_helper must create an RPC client");

		ui.sendKeys("  cover the finishing race  ", "\r");
		await vi.waitFor(() => {
			assert.deepEqual(rpc.steered, ["cover the finishing race"]);
		});
	});

	test("submitting an empty compose line does not steer or notify", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "empty-compose", "Remain active while an empty message is submitted");
		await openAgentViewer(ui);
		const rpc = rpcFixture.instances.at(-1);
		assert.ok(rpc, "spawn_helper must create an RPC client");
		const notify = vi.spyOn(ui.session.extensionRunner.createContext().ui, "notify");

		ui.sendKeys("   ", "\r");
		await ui.settle();

		assert.deepEqual(rpc.steered, [], "whitespace-only input must not reach RpcClient.steer");
		assert.equal(notify.mock.calls.length, 0, "empty submit must be ignored without showing a rejection");
		assert.match(await ui.screen(), /Message this agent:/, "the live compose line must remain open");
	});

	test("submitting while the child finishes rejects the steer and makes compose read-only", { timeout: 15000 }, async () => {
		const ui = await createCrewUi();
		await spawnAgent(ui, "finishing-agent", "Finish at the compose submission boundary");
		await openAgentViewer(ui);
		const rpc = rpcFixture.instances.at(-1);
		assert.ok(rpc, "spawn_helper must create an RPC client");
		const notify = vi.spyOn(ui.session.extensionRunner.createContext().ui, "notify");
		rpc.finishOnNextState = true;

		ui.sendKeys("too late to steer", "\r");
		await vi.waitFor(() => {
			assert.ok(
				notify.mock.calls.some(
					([message, level]) =>
						message === "That agent isn't running — you can't message it right now" && level === "warning",
				),
			);
		});

		assert.deepEqual(rpc.steered, [], "an idle child must not receive the raced compose submission");
		assert.match(await ui.screen(), /\(read-only\)/, "agent_end must replace compose with the read-only state");
	});

	test("switching agents keeps the viewer full-screen", { timeout: 15000 }, async () => {
		const ui = await createCrewUi([], {
			responses: ["ORCHESTRATOR TRANSCRIPT SENTINEL"],
			columns: 80,
			rows: 24,
		});
		await ui.prompt("ORCHESTRATOR REQUEST SENTINEL");
		await spawnAgent(ui, "agent-A", "TASK FOR AGENT A");
		await spawnAgent(ui, "agent-B", "TASK FOR AGENT B");

		await openAgentViewer(ui);
		ui.sendKeys("\t");
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /Agent · agent-B/, "Tab must show agent B without closing the viewer");
		assert.doesNotMatch(
			screen,
			/ORCHESTRATOR REQUEST SENTINEL|ORCHESTRATOR TRANSCRIPT SENTINEL/,
			"switching agents must not reveal the orchestrator transcript",
		);
	});

	test("an active modal receives Down instead of arming roster navigation", { timeout: 15000 }, async () => {
		const ui = await createCrewUi([], {
			extensions: [{ factory: modalPromptExtension, path: "vinci/test/ui/crew-modal-extension.ts" }],
		});
		await spawnAgent(ui, "modal-agent", "Wait while the orchestrator answers a modal prompt");

		const { completion } = await ui.startPrompt("/crew-modal-test");
		await ui.waitForText("Allow build tools?", 10000);
		ui.sendKeys("\x1b[B");
		await ui.settle();

		const screen = await ui.screen();
		assert.match(screen, /→ Allow build tools/, "Down must move the modal selection to its second option");
		assert.doesNotMatch(screen, /↑↓ move · enter open · esc back/, "the roster must stay disarmed");
		ui.sendKeys("\r");
		await completion;
	});

	test(
		"CRUX: full-screen view at 80x24 hides orchestrator's chat transcript (must replace entire screen, not overlay)",
		{ timeout: 15000 },
		async () => {
			previousCapacity = process.env.VINCI_CREW_CAPACITY;
			process.env.VINCI_CREW_CAPACITY = "1";
			const ui = await createCrewUi([], {
				responses: ["ORCHESTRATOR TRANSCRIPT SENTINEL"],
				columns: 80,
				rows: 24,
			});
			await ui.prompt("ORCHESTRATOR REQUEST SENTINEL");
			await spawnAgent(ui, "viewer-agent", "Verify the full-screen transcript viewer");

			await openAgentViewer(ui);
			const screen = await ui.screen();

			// CRUX ASSERTION: Orchestrator's screen elements MUST NOT be visible.
			// This is what the user complained about: agent view currently does NOT replace the full screen.
			// The orchestrator's chat request/response are visible below the agent view, making it not full-screen.
			assert.doesNotMatch(
				screen,
				/ORCHESTRATOR REQUEST SENTINEL|ORCHESTRATOR TRANSCRIPT SENTINEL/,
				"CRITICAL: Agent view must be full-screen; orchestrator transcript must NOT be visible. " +
					"Current behavior shows agent overlaid on top of main screen. The agent view must completely " +
					"replace the visible area, like 'switching to a new Vinci Code instance'."
			);

			// SUPPORTING ASSERTIONS: Verify the agent view itself is rendered correctly
			assert.match(screen, /Message this agent:/, "Compose line must be present");
			assert.match(screen, /Esc to close/, "Footer hint must be present");
			assert.match(screen, /LIVE AGENT TRANSCRIPT SENTINEL/, "Agent transcript must be visible");
			assert.doesNotMatch(screen, /● main/, "Main orchestrator header marker must not be visible");

			await expectCrewSnapshot("crew-full-screen-80x24-crux", ui);
		},
	);

	test(
		"full-screen view at small terminal (60x14) must still hide orchestrator AND preserve compose+hint",
		{ timeout: 15000 },
		async () => {
			previousCapacity = process.env.VINCI_CREW_CAPACITY;
			process.env.VINCI_CREW_CAPACITY = "1";
			const ui = await createCrewUi([], {
				responses: ["ORCHESTRATOR"],
				columns: 60,
				rows: 14,
			});
			await ui.prompt("ORCHESTRATOR REQUEST");
			await spawnAgent(ui, "small-agent", "Test small terminal");

			await openAgentViewer(ui);
			const screen = await ui.screen();

			// ASSERTION: Orchestrator not visible (same crux requirement at any size)
			assert.doesNotMatch(
				screen,
				/ORCHESTRATOR REQUEST|ORCHESTRATOR TRANSCRIPT/,
				"Must be full-screen even at small terminal size"
			);

			// ASSERTION: Compose line MUST be present (not clipped off bottom)
			assert.match(screen, /Message this agent:/, "Compose line must not be clipped at 60x14");

			// ASSERTION: Hint line MUST be present (not clipped off bottom)
			assert.match(screen, /Esc to close/, "Hint line must not be clipped at 60x14");

			await expectCrewSnapshot("crew-full-screen-60x14", ui);
		},
	);

	// A terminal this short used to overflow the fixed 7-line chrome. Clipping takes from the bottom,
	// so the line that disappeared was "Esc to close" — the only on-screen way out.
	for (const rows of [8, 6, 4]) {
		test(
			`the way out stays visible on a ${rows}-row terminal`,
			{ timeout: 15000 },
			async () => {
				previousCapacity = process.env.VINCI_CREW_CAPACITY;
				process.env.VINCI_CREW_CAPACITY = "1";
				const ui = await createCrewUi([], { responses: ["ORCHESTRATOR"], columns: 60, rows });
				await ui.prompt("ORCHESTRATOR REQUEST");
				await spawnAgent(ui, `tiny-${rows}`, "Test tiny terminal");

				await openAgentViewer(ui);
				const screen = await ui.screen();

				assert.match(screen, /Esc to close/, `exit hint must survive at ${rows} rows`);
				assert.doesNotMatch(screen, /ORCHESTRATOR REQUEST/, "must still be full-screen");
				assert.ok(
					screen.split("\n").length <= rows,
					`rendered ${screen.split("\n").length} lines into a ${rows}-row terminal — content is being clipped`,
				);
			},
		);
	}

	test(
		"full-screen view neutralizes ANSI/OSC escape sequences in agent name, instruction, and transcript",
		{ timeout: 15000 },
		async () => {
			previousCapacity = process.env.VINCI_CREW_CAPACITY;
			process.env.VINCI_CREW_CAPACITY = "1";
			const ui = await createCrewUi([], {
				responses: ["ORCHESTRATOR"],
				columns: 80,
				rows: 24,
			});
			await ui.prompt("ORCHESTRATOR REQUEST");

			// Agent name contains malicious ANSI and OSC sequences
			const maliciousName = "agent\x1b[2J\x1b]0;pwned\x07name";
			await spawnAgent(ui, maliciousName, "Test escape handling");

			await openAgentViewer(ui);
			const screen = await ui.screen();

			// ASSERTION: No raw escape sequences in rendered output
			assert.doesNotMatch(screen, /\x1b\[2J/, "CSI clear screen must be neutralized");
			assert.doesNotMatch(screen, /\x1b\]0;/, "OSC sequence must be neutralized");
			assert.doesNotMatch(screen, /\x1b\[/, "ANSI escape codes must be stripped");
			assert.doesNotMatch(screen, /\x07/, "BEL character must be stripped");

			// ASSERTION: Crux still holds at this size
			assert.doesNotMatch(screen, /ORCHESTRATOR REQUEST/, "Must remain full-screen");

			await expectCrewSnapshot("crew-escape-sequence-neutralization", ui);
		},
	);
});
