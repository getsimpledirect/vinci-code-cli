import { type Context, createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../../ai/src/api/openai-completions.ts";
import { parseStreamingJson } from "../../ai/src/utils/json-parse.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentTool, StreamFn } from "../src/types.ts";

const provider = vi.hoisted(() => ({ name: "write", arguments: "" }));

vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => {
					const chunks = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: provider.name, arguments: provider.arguments } }] }, finish_reason: null }] };
							yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
						},
					};
					return { withResponse: async () => ({ data: chunks, response: { status: 200, headers: new Headers() } }) };
				},
			},
		};
	},
}));

const model = {
	id: "offline", name: "offline", api: "openai-completions" as const, provider: "vinci",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
} satisfies AgentLoopConfig["model"];

const edits = [{ oldText: "before", newText: "after" }];

// Faithful write/edit schemas from coding-agent/core/tools; spies replace filesystem operations.
const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
const editSchema = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, {})) }, {});

async function runCall(name: "write" | "edit", raw: string, options: {
	call?: ToolCall;
	prepareArguments?: AgentTool["prepareArguments"];
	mode?: "parallel" | "sequential";
} = {}) {
	provider.name = name;
	provider.arguments = raw;
	const execute = vi.fn(async (_id: string, _args: unknown) => ({ content: [{ type: "text" as const, text: "executed" }], details: undefined }));
	const beforeToolCall = vi.fn(async () => undefined);
	const tool: AgentTool = {
		name, label: name, description: name, parameters: name === "write" ? writeSchema : editSchema,
		execute, prepareArguments: options.prepareArguments,
	};
	const contexts: Context[] = [];
	const streamFn: StreamFn = (_model, context) => {
		contexts.push({ ...context, messages: structuredClone(context.messages) });
		if (contexts.length === 1 && !options.call) return streamCompletions(model, context, { apiKey: "offline-test" });
		const result = createAssistantMessageEventStream();
		const message = {
			role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
			content: contexts.length === 1 && options.call ? [options.call] : [{ type: "text" as const, text: "done" }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: contexts.length === 1 && options.call ? "toolUse" as const : "stop" as const, timestamp: 0,
		};
		result.push({ type: "done", reason: message.stopReason, message });
		result.end(message);
		return result;
	};
	const events: AgentEvent[] = [];
	await runAgentLoop(
		[{ role: "user", content: "perform the operation", timestamp: 0 }],
		{ systemPrompt: "", messages: [], tools: [tool] },
		{ model, convertToLlm: (messages) => messages as Context["messages"], beforeToolCall, toolExecution: options.mode },
		(event) => { events.push(event); }, undefined, streamFn,
	);
	const returned = contexts[1]?.messages.find((message) => message.role === "toolResult");
	return { execute, beforeToolCall, returned, events };
}

function expectRefused(result: Awaited<ReturnType<typeof runCall>>) {
	expect(result.execute).toHaveBeenCalledTimes(0);
	expect(result.beforeToolCall).toHaveBeenCalledTimes(0);
	expect(result.returned).toMatchObject({ role: "toolResult", isError: true, content: [{ type: "text", text: expect.stringContaining("Invalid arguments") }] });
}

describe("agent completed tool-call argument validation", () => {
	beforeEach(() => { vi.stubEnv("VINCI_CODE", "1"); });
	afterEach(() => { vi.unstubAllEnvs(); });

	it.each(["parallel", "sequential"] as const)("T4 managed malformed write executes zero times (%s)", async (mode) => {
		expectRefused(await runCall("write", '{"path":"a.txt","content":"hel', { mode }));
	});

	it("T4 managed malformed edit executes zero times", async () => {
		expectRefused(await runCall("edit", '{"path":"a.txt","edits":[{"oldText":"before","newText":"aft'));
	});

	it("T4 positive managed well-formed write executes once", async () => {
		const result = await runCall("write", '{"path":"a.txt","content":"hello"}');
		expect(result.execute).toHaveBeenCalledTimes(1);
		expect(result.execute.mock.calls[0]?.[1]).toEqual({ path: "a.txt", content: "hello" });
		expect(result.beforeToolCall).toHaveBeenCalledTimes(1);
		expect(result.returned).toMatchObject({ isError: false });
	});

	it("T4 refuses a provider parse error even when argument preparation supplies valid fields", async () => {
		const result = await runCall("write", "", {
			call: { type: "toolCall", id: "call-1", name: "write", arguments: {}, argumentsError: "Malformed outer JSON" } as ToolCall,
			prepareArguments: () => ({ path: "a.txt", content: "default" }),
		});
		expectRefused(result);
	});

	it("T5 positive repairs a stringified nested array in a valid outer object", async () => {
		const raw = JSON.stringify({ path: "a.txt", edits: JSON.stringify(edits) });
		const result = await runCall("edit", raw);
		expect(result.execute).toHaveBeenCalledTimes(1);
		expect(result.execute.mock.calls[0]?.[1]).toEqual({ path: "a.txt", edits });
		expect(result.beforeToolCall).toHaveBeenCalledTimes(1);
		expect(result.returned).toMatchObject({ isError: false });
	});

	it("T5 malformed outer object with stringified array executes zero times", async () => {
		const raw = `${JSON.stringify({ path: "a.txt", edits: JSON.stringify(edits) }).slice(0, -1)},"tail":"cut`;
		expectRefused(await runCall("edit", raw));
	});

	it("T5 preserves a provider parse error when repairing a retained nested-array prefix", async () => {
		const raw = `${JSON.stringify({ path: "a.txt", edits: JSON.stringify(edits) }).slice(0, -1)},"tail":"cut`;
		// External/faux providers may retain a streamed prefix together with the final parse error.
		// Repairing that prefix must never make the failed outer call executable.
		const call = { type: "toolCall", id: "call-1", name: "edit", arguments: parseStreamingJson(raw), argumentsError: `Malformed outer JSON\n\nReceived arguments:\n${raw}` } as ToolCall;
		expectRefused(await runCall("edit", raw, { call }));
	});
});
