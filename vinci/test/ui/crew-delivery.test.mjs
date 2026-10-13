import "./env.mjs";
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { convertToLlm } from "../../../packages/coding-agent/src/core/messages.ts";
import { createHarnessWithExtensions } from "../../../packages/coding-agent/test/test-harness.ts";
import vinciCrew from "../../extensions/vinci-crew.ts";
import { createVinciUiHarness } from "./harness.mjs";

const rpcFixture = vi.hoisted(() => {
	const instances = [];
	class FakeRpcClient {
		constructor() {
			this.listeners = [];
			this.streaming = false;
			instances.push(this);
		}
		async start() {}
		onEvent(listener) {
			this.listeners.push(listener);
			return () => { this.listeners = this.listeners.filter((entry) => entry !== listener); };
		}
		async setSessionName() {}
		async getState() { return { isStreaming: this.streaming }; }
		async promptAndWait() {
			this.streaming = true;
			for (const listener of this.listeners) listener({ type: "agent_start" });
			await new Promise((resolve) => { this.finishPrompt = resolve; });
		}
		complete() {
			this.streaming = false;
			for (const listener of this.listeners) listener({ type: "agent_end", messages: [] });
			this.finishPrompt?.();
		}
		async getMessages() {
			return [{ role: "assistant", provider: "faux", model: "crew-fixture", stopReason: "stop", timestamp: Date.now(),
				content: [{ type: "text", text: 'Finished.\n```vinci-handoff\n{"deviations":[],"deferred":[]}\n```' }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }];
		}
		async getEntries() { return { entries: [] }; }
		async getLastAssistantText() { return (await this.getMessages())[0].content[0].text; }
		async getSessionStats() { return { tokens: { total: 2 } }; }
		async stop() { this.finishPrompt?.(); }
	}
	return { instances, FakeRpcClient };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal()), RpcClient: rpcFixture.FakeRpcClient,
}));

const openHarnesses = [];
const openCoreHarnesses = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (openCoreHarnesses.length) {
		const core = openCoreHarnesses.pop();
		core.agent.clearAllQueues();
		await core.session.abort();
		await core.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		core.cleanup();
	}
	while (openHarnesses.length) {
		const ui = openHarnesses.pop();
		ui.core.agent.clearAllQueues();
		await ui.session.abort();
		await ui.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await ui.close();
	}
	rpcFixture.instances.length = 0;
});

function finishedHelper(overrides = {}) {
	return {
		id: 12,
		name: "delivery regression",
		task: "Report the bounded check",
		status: "done",
		summary: "The bounded check passed.",
		finishedAt: Date.now(),
		attestation: "attested",
		deviations: [],
		deferred: [],
		omitted: { deviations: 0, deferred: 0 },
		...overrides,
	};
}

function seedJournal(entries) {
	return (pi) => {
		pi.on("session_start", () => {
			for (const entry of entries) {
				if (entry.type === "custom_message") {
					pi.sendMessage(entry, { triggerTurn: false });
				} else {
					pi.appendEntry(entry.customType, entry.data);
				}
			}
		});
	};
}

async function createUi(entries = [], options = {}) {
	const ui = await createVinciUiHarness({
		connected: true,
		...options,
		extensions: [
			{ factory: seedJournal(entries), path: "vinci/test/ui/crew-seed-extension.ts" },
			{ factory: vinciCrew, path: "vinci/extensions/vinci-crew.ts" },
		],
	});
	// Match the shipped coding-agent's custom-message conversion; the generic UI harness uses
	// Agent's default converter, which intentionally omits extension messages from faux contexts.
	ui.core.agent.convertToLlm = convertToLlm;
	openHarnesses.push(ui);
	return ui;
}

async function restoreFinished(ui, helper = finishedHelper()) {
	ui.session.sessionManager.appendCustomEntry("vinci-crew-helper", helper);
	await ui.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
	await ui.settle();
}

function resultEntries(ui) {
	return ui.session.sessionManager.getBranch().filter(
		(entry) => entry.type === "custom_message" && entry.customType === "vinci-crew-result",
	);
}

function latestHelper(ui, helperId = 12) {
	return ui.session.sessionManager.getBranch().filter(
		(entry) => entry.type === "custom" && entry.customType === "vinci-crew-helper" && entry.data.id === helperId,
	).at(-1)?.data;
}

async function waitUntil(predicate, description, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`Timed out waiting for ${description}`);
}

async function closeUi(ui) {
	ui.core.agent.clearAllQueues();
	await ui.session.abort();
	await ui.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await ui.close();
	openHarnesses.splice(openHarnesses.indexOf(ui), 1);
}

describe("Crew result delivery through the real extension runtime", () => {
	for (const trial of [1, 2, 3]) {
		test(`headless resume admits its initial prompt together with restored results (trial ${trial})`, { timeout: 15_000 }, async () => {
			const helper = finishedHelper();
			const core = await createHarnessWithExtensions({
				responses: [{ text: "Initial task accepted.", delayMs: 100 }],
				extensionFactories: [
					{ factory: seedJournal([{ type: "custom", customType: "vinci-crew-helper", data: helper }]), path: "vinci/test/ui/crew-seed-extension.ts" },
					{ factory: vinciCrew, path: "vinci/extensions/vinci-crew.ts" },
				],
			});
			openCoreHarnesses.push(core);
			core.agent.convertToLlm = convertToLlm;
			// Match runPrintMode's real ordering: bind startup extensions, then admit the initial
			// stdin/user prompt through session.prompt. Startup must not own a competing model turn.
			await core.session.bindExtensions({ mode: "json" });
			const initialPrompt = `Continue the original task for resume trial ${trial}.`;
			await core.session.prompt(initialPrompt);
			await waitUntil(() => resultEntries(core).length === 1 && latestHelper(core)?.deliveredAt, "restored result acknowledgement");
			assert.equal(core.faux.callCount, 1, "restored results must share the initial prompt's model turn");
			const context = JSON.stringify(core.faux.contexts[0].messages);
			assert.ok(context.includes(initialPrompt) && context.includes("[Agent result]"));
		});
	}

	test("a live helper finishing after startup still triggers one automatic result turn", { timeout: 15_000 }, async () => {
		const ui = await createUi();
		const runner = ui.session.extensionRunner;
		const spawn = runner.getToolDefinition("spawn_helper");
		assert.ok(spawn, "Crew must register its real spawn_helper entry point");
		await spawn.execute("delivery-positive", { name: "delivery positive", task: "Report the bounded fixture" },
			new AbortController().signal, () => {}, runner.createContext());
		await waitUntil(() => rpcFixture.instances.at(-1)?.finishPrompt, "mocked RPC prompt admission");
		const helperId = ui.session.sessionManager.getBranch().filter(
			(entry) => entry.type === "custom" && entry.customType === "vinci-crew-helper",
		).at(-1).data.id;
		rpcFixture.instances.at(-1).complete();
		await waitUntil(() => resultEntries(ui).length === 1 && !ui.session.isStreaming, "automatic result turn");
		assert.equal(ui.core.faux.callCount, 1);
		await waitUntil(() => latestHelper(ui, helperId)?.deliveredAt, "live result acknowledgement");
		assert.equal(typeof latestHelper(ui, helperId).deliveredAt, "number");
	});

	test("an idle draft keeps its text and delivers the result with the user's next turn", { timeout: 15_000 }, async () => {
		const ui = await createUi();
		const draft = "Wait until I finish this correction";
		ui.sendKeys(draft);
		await ui.settle();
		await restoreFinished(ui);
		assert.equal(ui.core.faux.callCount, 0, "a result must not start a turn over unsent user input");
		assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), draft);
		const submitted = ui.mode.getUserInput();
		ui.sendKeys("\r");
		assert.equal(await submitted, draft);
		await ui.session.prompt(draft);
		await waitUntil(() => resultEntries(ui).length === 1, "result in the submitted user turn");
		assert.equal(ui.core.faux.callCount, 1);
		const context = JSON.stringify(ui.core.faux.contexts.at(-1).messages);
		assert.ok(context.includes("[Agent result]") && context.includes(draft));
	});

	test("restart after result append but before helper checkpoint does not redeliver", { timeout: 15_000 }, async () => {
		const ui = await createUi();
		const append = ui.session.sessionManager.appendCustomEntry.bind(ui.session.sessionManager);
		vi.spyOn(ui.session.sessionManager, "appendCustomEntry").mockImplementation((type, data) => {
			// Emulate the lost helper checkpoint at the crash boundary; result journal writes use
			// appendCustomMessageEntry and still pass through the actual runtime unchanged.
			if (type === "vinci-crew-helper" && data?.deliveredAt) return "lost-checkpoint";
			return append(type, data);
		});
		await restoreFinished(ui);
		assert.equal(ui.core.faux.callCount, 0, "startup must wait for the resumed task's input");
		await ui.prompt("Continue the original task before the simulated crash");
		await waitUntil(() => resultEntries(ui).length === 1 && !ui.session.isStreaming, "persisted result before crash");
		const records = structuredClone(ui.session.sessionManager.getBranch().filter(
			(entry) => entry.customType === "vinci-crew-helper" || entry.customType === "vinci-crew-result",
		));
		assert.equal(latestHelper(ui).deliveredAt, undefined);
		assert.equal(typeof latestHelper(ui).deliveryId, "string");
		assert.equal(latestHelper(ui).deliveryId, resultEntries(ui)[0].details.deliveryId);
		await closeUi(ui);
		vi.restoreAllMocks();
		const restored = await createUi(records);
		await restored.settle();
		assert.equal(restored.core.faux.callCount, 0, "the recorded result must not trigger another model turn");
		assert.equal(resultEntries(restored).length, 1);
		assert.equal(typeof latestHelper(restored).deliveredAt, "number");
	});

	test("a queued result lost before append is delivered once after restart", { timeout: 15_000 }, async () => {
		const ui = await createUi([], { responses: [{ text: "parent response", delayMs: 500 }] });
		const { completion } = await ui.startPrompt("Continue the parent task");
		await waitUntil(() => ui.session.isStreaming, "active parent stream");
		await restoreFinished(ui);
		assert.equal(resultEntries(ui).length, 0, "the follow-up is queued, not journaled yet");
		const pending = structuredClone(latestHelper(ui));
		assert.equal(pending.deliveredAt, undefined, "queue acceptance must not claim persisted delivery");
		ui.core.agent.clearAllQueues();
		await ui.session.abort();
		await completion;
		await closeUi(ui);
		const restored = await createUi([{ type: "custom", customType: "vinci-crew-helper", data: pending }]);
		assert.equal(restored.core.faux.callCount, 0, "restart must wait for the resumed task's input");
		await restored.prompt("Continue the resumed task");
		await waitUntil(() => resultEntries(restored).length === 1 && !restored.session.isStreaming, "recovered queued result");
		assert.equal(restored.core.faux.callCount, 1);
	});

	test("a draft during streaming postpones the result until the user submits", { timeout: 15_000 }, async () => {
		const ui = await createUi([], { responses: [{ text: "parent response", delayMs: 200 }, "correction response"] });
		const { completion } = await ui.startPrompt("Continue the parent task");
		await waitUntil(() => ui.session.isStreaming, "active parent stream");
		ui.sendKeys("Use the corrected requirement");
		await restoreFinished(ui);
		await completion;
		await ui.settle();
		assert.equal(ui.core.faux.callCount, 1, "the helper result must not create a second turn while typing");
		assert.equal(latestHelper(ui).deliveredAt, undefined);
		const submitted = ui.mode.getUserInput();
		ui.sendKeys("\r");
		const correction = await submitted;
		assert.equal(correction, "Use the corrected requirement");
		await ui.session.prompt(correction);
		await waitUntil(() => resultEntries(ui).length === 1, "result with submitted correction");
		assert.equal(ui.core.faux.callCount, 2);
	});

	test("a receipt for another attempt cannot suppress the current result", { timeout: 15_000 }, async () => {
		const helper = finishedHelper({ deliveryId: "current-attempt" });
		const ui = await createUi([
			{ type: "custom", customType: "vinci-crew-helper", data: helper },
			{
				type: "custom_message", customType: "vinci-crew-result", display: false,
				content: "Earlier result", details: { agentId: helper.id, name: helper.name, task: helper.task, deliveryId: "earlier-attempt" },
			},
		]);
		assert.equal(ui.core.faux.callCount, 0, "an unacknowledged result must wait for resumed input");
		await ui.prompt("Continue the current attempt");
		await waitUntil(() => resultEntries(ui).length === 2 && !ui.session.isStreaming, "current attempt result");
		assert.equal(ui.core.faux.callCount, 1);
		assert.equal(resultEntries(ui).at(-1).details.deliveryId, "current-attempt");
	});

	test("a legacy journaled result is acknowledged without replaying its turn", { timeout: 15_000 }, async () => {
		const helper = finishedHelper({ notifiedAt: Date.now() });
		const ui = await createUi([
			{ type: "custom", customType: "vinci-crew-helper", data: helper },
			{
				type: "custom_message", customType: "vinci-crew-result", display: false,
				content: "Legacy result", details: { agentId: helper.id, name: helper.name, task: helper.task },
			},
		]);
		await ui.settle();
		assert.equal(ui.core.faux.callCount, 0);
		assert.equal(resultEntries(ui).length, 1);
		assert.equal(typeof latestHelper(ui).deliveredAt, "number");
	});
});
