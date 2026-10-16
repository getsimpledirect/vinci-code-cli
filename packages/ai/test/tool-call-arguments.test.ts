import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import type { ToolCall } from "../src/types.ts";
import * as jsonParse from "../src/utils/json-parse.ts";

const provider = vi.hoisted(() => ({ arguments: "" }));

vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => {
					const chunks = {
						async *[Symbol.asyncIterator]() {
							for (const part of [provider.arguments.slice(0, 12), provider.arguments.slice(12)]) {
								yield {
									choices: [{ delta: { tool_calls: [{ index: 0, id: "call-write", type: "function", function: { name: "write", arguments: part } }] }, finish_reason: null }],
								};
							}
							yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
						},
					};
					return { withResponse: async () => ({ data: chunks, response: { status: 200, headers: new Headers() } }) };
				},
			},
		};
	},
}));

// Exercise the base's existing final-argument parser until the strict export is available.
// This lets base negatives reach argument assertions and keeps the same positive controls.
const parseToolCallArguments = (json: string): Pick<ToolCall, "arguments"> & { argumentsError?: string } => {
	const strict = Reflect.get(jsonParse, "parseToolCallArguments") as
		| ((text: string) => Pick<ToolCall, "arguments"> & { argumentsError?: string })
		| undefined;
	return strict ? strict(json) : { arguments: jsonParse.parseStreamingJson(json) };
};

describe("completed tool-call arguments", () => {
	it("T1 rejects a truncated object without keeping a prefix", () => {
		const raw = '{"a":1';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toContain("Received arguments");
		expect(result.argumentsError).toContain(raw);
	});

	it.each(["[1,2]", '"str"'])("T1 rejects non-object JSON %s", (raw) => {
		const result = parseToolCallArguments(raw);
		expect(result.argumentsError).toContain("must be a JSON object");
		expect(result.arguments).toEqual({});
	});

	it.each([
		['{"a":1}', { a: 1 }],
		["", {}],
	] as const)("T1 positive complete or empty arguments %s", (raw, args) => {
		expect(parseToolCallArguments(raw)).toEqual({ arguments: args });
	});

	it("T2 preserves an invalid Unicode escape as literal text", () => {
		const raw = String.raw`{"text":"\uZZZZ","after":"kept"}`;
		expect(jsonParse.parseStreamingJson(raw)).toEqual({ text: String.raw`\uZZZZ`, after: "kept" });
		expect(parseToolCallArguments(raw)).toEqual({ arguments: { text: String.raw`\uZZZZ`, after: "kept" } });
	});

	it("T2 positive decodes a valid Unicode escape", () => {
		const raw = String.raw`{"text":"\u00e9"}`;
		expect(jsonParse.parseStreamingJson(raw)).toEqual({ text: "é" });
		expect(parseToolCallArguments(raw)).toEqual({ arguments: { text: "é" } });
	});

	it.each([
		['{"path":"a.txt","content":"hel', true],
		['{"path":"a.txt","content":"hello"}', false],
	] as const)("T3 managed finalizer %s", async (raw, malformed) => {
		provider.arguments = raw;
		const response = await stream(
			{
				id: "offline", name: "offline", api: "openai-completions", provider: "vinci",
				baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
			},
			{ messages: [{ role: "user", content: "write", timestamp: 0 }] },
			{ apiKey: "offline-test" },
		).result();
		expect(response.stopReason).toBe("toolUse");
		const call = response.content.find((part) => part.type === "toolCall");
		expect(call?.arguments).toEqual(malformed ? {} : { path: "a.txt", content: "hello" });
		if (malformed) expect(Reflect.get(call ?? {}, "argumentsError")).toContain(raw);
		else expect(call).not.toHaveProperty("argumentsError");
		expect(call).not.toHaveProperty("partialArgs");
	});
});
