import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options?: { maxFrameBytes: number; onError: (error: Error) => void },
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let stopped = false;
	const fail = (message: string) => {
		stopped = true;
		buffer = "";
		options?.onError(new Error(message));
	};

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		if (stopped) return;
		const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
		let offset = 0;
		while (offset < text.length && !stopped) {
			const newline = text.indexOf("\n", offset);
			const part = text.slice(offset, newline === -1 ? undefined : newline);
			if (options && Buffer.byteLength(buffer) + Buffer.byteLength(part) > options.maxFrameBytes) {
				fail("RPC protocol frame exceeds byte limit");
				return;
			}
			buffer += part;
			if (newline === -1) return;
			emitLine(buffer);
			buffer = "";
			offset = newline + 1;
		}
	};

	const onEnd = () => {
		if (stopped) return;
		buffer += decoder.end();
		if (buffer.length > 0) {
			if (options) {
				fail("RPC protocol unterminated frame");
				return;
			}
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stopped = true;
		buffer = "";
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
