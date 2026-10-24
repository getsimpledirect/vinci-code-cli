import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Mistral } from "@mistralai/mistralai";
import { responseFormatFromZodObject } from "@mistralai/mistralai/extra/structChat.js";
import { type Fetcher, HTTPClient } from "@mistralai/mistralai/lib/http.js";
import { CompletionChunk$inboundSchema } from "@mistralai/mistralai/models/components/completionchunk.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";

const choice = { index: 0, delta: { role: "assistant", content: "Local fixture" }, finish_reason: "stop" };
const chunk = { id: "offline-fixture", model: "offline-fixture", choices: [choice] };

describe("Mistral's selected Zod security fix", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("Use the injected offline transport for this test.");
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("selects the patched Zod from the actual SDK's resolution context", () => {
		const sdkRequire = createRequire(import.meta.resolve("@mistralai/mistralai"));
		const manifest = JSON.parse(readFileSync(sdkRequire.resolve("zod/package.json"), "utf8"));
		expect(manifest.version).toBe("4.6.6");
	});

	// The SDK's choices array has no upper bound. Add one only to verify the selected
	// parser's upstream fix; this does not impose a production response-size limit.
	it.each(["max", "length"] as const)("rejects an oversized %s before walking invalid choices", (bound) => {
		if (!(CompletionChunk$inboundSchema instanceof z4.ZodObject)) {
			throw new Error("Expected the SDK chunk schema to use the selected Zod object parser.");
		}
		const schema = CompletionChunk$inboundSchema.extend({
			choices: CompletionChunk$inboundSchema.shape.choices[bound](1),
		});
		expect(schema.safeParse(chunk).success).toBe(true);
		const result = schema.safeParse({ ...chunk, choices: Array(2048).fill(0) });
		expect(result.success).toBe(false);
		if (result.success) throw new Error("Expected the bounded parser to refuse oversized input.");
		expect(result.error.issues).toHaveLength(1);
		expect(result.error.issues[0]).toMatchObject({ code: "too_big", path: ["choices"] });
	});

	it("preserves request serialization and valid SSE parsing through the real SDK", async () => {
		const fetcher = vi.fn<Fetcher>(async (input, init) => {
			const request = new Request(input, init);
			expect(request.url).toBe("https://zod-fixture.invalid/v1/chat/completions");
			expect(request.method).toBe("POST");
			expect(await request.json()).toMatchObject({
				model: "offline-fixture",
				stream: true,
				messages: [{ role: "user", content: "Local parser fixture" }],
				tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
			});
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const client = new Mistral({
			apiKey: "offline-synthetic-fixture",
			serverURL: "https://zod-fixture.invalid",
			httpClient: new HTTPClient({ fetcher }),
		});
		const stream = await client.chat.stream({
			model: "offline-fixture",
			messages: [{ role: "user", content: "Local parser fixture" }],
			tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
		});
		const events = [];
		for await (const event of stream) events.push(event.data);
		expect(events).toEqual([{ ...chunk, choices: [{ index: 0, delta: choice.delta, finishReason: "stop" }] }]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("still rejects invalid unbounded SSE choices through the real SDK", async () => {
		const fetcher = vi.fn(async () => {
			return new Response(`data: ${JSON.stringify({ ...chunk, choices: [0] })}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const client = new Mistral({
			apiKey: "offline-synthetic-fixture",
			serverURL: "https://zod-fixture.invalid",
			httpClient: new HTTPClient({ fetcher }),
		});
		const consume = async () => {
			const stream = await client.chat.stream({
				model: "offline-fixture",
				messages: [{ role: "user", content: "Local parser fixture" }],
			});
			for await (const _event of stream) throw new Error("Expected invalid choices to refuse parsing.");
		};
		await expect(consume()).rejects.toMatchObject({
			issues: [expect.objectContaining({ code: "invalid_type", path: ["data", "choices", 0] })],
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("preserves structured-output conversion with v4 schemas", () => {
		const format = responseFormatFromZodObject(z4.object({ answer: z4.string(), note: z4.string().optional() }));
		expect(format).toMatchObject({
			type: "json_schema",
			jsonSchema: {
				strict: true,
				schemaDefinition: {
					type: "object",
					properties: { answer: { type: "string" }, note: { type: ["string", "null"] } },
					required: ["answer", "note"],
					additionalProperties: false,
				},
			},
		});
	});

	it("preserves structured-output conversion with the embedded v3 compatibility API", () => {
		// The SDK signature names its default Zod generation; its runtime also has
		// an explicit v3 conversion branch, exercised here through the public helper.
		const format = Reflect.apply(responseFormatFromZodObject, undefined, [z3.object({ answer: z3.string() })]);
		expect(format).toMatchObject({
			type: "json_schema",
			jsonSchema: {
				strict: true,
				schemaDefinition: {
					type: "object",
					properties: { answer: { type: "string" } },
					required: ["answer"],
					additionalProperties: false,
				},
			},
		});
	});
});
