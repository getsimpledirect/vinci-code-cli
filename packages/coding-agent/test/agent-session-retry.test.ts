import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.abortRetry();
			session.dispose();
		}
		vi.useRealTimers();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		delayAssistantMessageEndMs?: number;
		errorMessage?: string;
		responses?: AssistantMessage[];
		tools?: AgentTool[];
		defaultRetrySettings?: boolean;
	}) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const response = options?.responses?.[callCount - 1];
					if (response) {
						stream.push({ type: "start", partial: response });
						if (response.stopReason === "error" || response.stopReason === "aborted") {
							stream.push({ type: "error", reason: response.stopReason, error: response });
						} else {
							stream.push({ type: "done", reason: response.stopReason, message: response });
						}
						return;
					}
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: options?.errorMessage ?? "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		if (!options?.defaultRetrySettings) {
			settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1 } });
		}

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: Object.fromEntries((options?.tools ?? []).map((tool) => [tool.name, tool])),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it("retries an upstream gateway failure exactly once and succeeds", async () => {
		const created = createSession({ errorMessage: "Unable to forward upstream stream" });
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(session.messages.at(-1)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "Success" }],
		});
	});

	it.each(["overloaded_error", "Unable to forward upstream stream"])(
		"bounds persistent transient retries to the default 2/4/8 second schedule: %s",
		async (errorMessage) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const created = createSession({ errorMessage, failCount: 99, defaultRetrySettings: true });
			const starts: { attempt: number; maxAttempts: number; delayMs: number }[] = [];
			const ends: { success: boolean; attempt: number; finalError?: string }[] = [];
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") starts.push(event);
				if (event.type === "auto_retry_end") ends.push(event);
			});
			const prompt = session.prompt("Test");
			await vi.advanceTimersByTimeAsync(0);
			for (const [index, delayMs] of [2000, 4000, 8000].entries()) {
				expect(starts.map(({ delayMs: delay }) => delay)).toEqual([2000, 4000, 8000].slice(0, index + 1));
				await vi.advanceTimersByTimeAsync(delayMs - 1);
				expect(created.getCallCount()).toBe(index + 1);
				await vi.advanceTimersByTimeAsync(1);
				expect(created.getCallCount()).toBe(index + 2);
			}
			await prompt;
			expect(starts.map(({ attempt, maxAttempts }) => [attempt, maxAttempts])).toEqual([
				[1, 3],
				[2, 3],
				[3, 3],
			]);
			expect(ends).toEqual([{ type: "auto_retry_end", success: false, attempt: 3, finalError: errorMessage }]);
			expect(session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage });
			await vi.advanceTimersByTimeAsync(16000);
			expect(created.getCallCount()).toBe(4);
			expect(session.isRetrying).toBe(false);
		},
	);

	it.each(["overloaded_error", "Unable to forward upstream stream"])(
		"cancels the backoff without another provider call: %s",
		async (errorMessage) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const created = createSession({ errorMessage, failCount: 99, defaultRetrySettings: true });
			const finalErrors: (string | undefined)[] = [];
			session.subscribe((event) => {
				if (event.type === "auto_retry_end") finalErrors.push(event.finalError);
			});
			const prompt = session.prompt("Test");
			await vi.advanceTimersByTimeAsync(0);
			expect(session.isRetrying).toBe(true);
			await vi.advanceTimersByTimeAsync(1000);
			session.abortRetry();
			await prompt;
			expect(finalErrors).toEqual(["Retry cancelled"]);
			await vi.advanceTimersByTimeAsync(30000);
			expect(created.getCallCount()).toBe(1);
			expect(session.isRetrying).toBe(false);
		},
	);

	it.each(["overloaded_error", "The service is temporarily unavailable"])(
		"does not replay a completed write after a follow-up error: %s",
		async (errorMessage) => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "written" }],
				details: undefined,
			}));
			const created = createSession({
				tools: [
					{ name: "write", label: "Write", description: "Write a value", parameters: Type.Object({}), execute },
				],
				responses: [
					createAssistantMessage("", {
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "write_1", name: "write", arguments: {} }],
					}),
					createAssistantMessage("", { stopReason: "error", errorMessage }),
					createAssistantMessage("Success"),
				],
			});
			await session.prompt("Test");
			expect(created.getCallCount()).toBe(3);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
			expect(session.messages.at(-1)).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "Success" }],
			});
		},
	);

	it.each(["overloaded_error", "The service is temporarily unavailable"])(
		"does not execute a tool call from an errored response before retry: %s",
		async (errorMessage) => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "written" }],
				details: undefined,
			}));
			const created = createSession({
				tools: [
					{ name: "write", label: "Write", description: "Write a value", parameters: Type.Object({}), execute },
				],
				responses: [
					createAssistantMessage("", {
						stopReason: "error",
						errorMessage,
						content: [{ type: "toolCall", id: "uncertain_write", name: "write", arguments: {} }],
					}),
					createAssistantMessage("Success"),
				],
			});
			await session.prompt("Test");
			expect(execute).toHaveBeenCalledTimes(0);
			expect(created.getCallCount()).toBe(2);
			expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
			expect(session.messages.at(-1)).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "Success" }],
			});
		},
	);

	it.each([
		"401 Unauthorized: unable to forward upstream stream",
		"invalid_api_key: The service is temporarily unavailable",
		"402 payment_failed: service is temporarily unavailable",
		"402 Payment Required: unable to forward upstream stream",
		"refusal: unable to forward upstream stream",
	])("surfaces a terminal error without session retries: %s", async (errorMessage) => {
		const created = createSession({ errorMessage });
		const retries: number[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") retries.push(event.attempt);
		});
		await session.prompt("Test");
		expect(retries).toEqual([]);
		expect(created.getCallCount()).toBe(1);
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage });
	});

	it("retries after a transient error and succeeds", async () => {
		const created = createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});
});
