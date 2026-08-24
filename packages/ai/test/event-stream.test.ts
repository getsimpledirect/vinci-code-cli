import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("rejects instead of hanging when the stream ends without a final result", async () => {
		const stream = new EventStream<string, string>(
			() => false,
			(event) => event,
		);
		const result = stream.result();

		stream.end();

		await expect(result).rejects.toThrow("Event stream ended without a final result");
	});

	it("still resolves an explicit final result", async () => {
		const stream = new EventStream<string, string>(
			() => false,
			(event) => event,
		);

		stream.end("complete");

		await expect(stream.result()).resolves.toBe("complete");
	});

	it("keeps a terminal event result when the producer subsequently closes", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "complete",
			(event) => event,
		);

		stream.push("complete");
		stream.end();

		await expect(stream.result()).resolves.toBe("complete");
	});
});
