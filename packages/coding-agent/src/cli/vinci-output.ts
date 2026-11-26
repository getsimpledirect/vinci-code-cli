import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { stripVinciColor } from "../../../../vinci/extensions/lib/cli-presentation.ts";

/** Longest unfinished escape sequence held back; anything longer is written as it is. */
const MAX_HELD_ESCAPE = 4096;

/**
 * A trailing escape sequence that has not reached its final byte yet: a lone ESC, an unfinished
 * CSI (`ESC [` parameters or intermediates without the final byte), an unterminated OSC/DCS/APC/PM/SOS
 * string, or ESC followed only by intermediate bytes.
 */
const PARTIAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|[\]P^_X][^\x07\x1b]*\x1b?|[ -/]*)$/;

function splitPartialEscape(text: string): [complete: string, held: string] {
	const match = PARTIAL_ESCAPE.exec(text);
	if (!match || text.length - match.index > MAX_HELD_ESCAPE) return [text, ""];
	return [text.slice(0, match.index), text.slice(match.index)];
}

export function filterVinciOutput(plain: boolean): () => void {
	const filter = (text: string) =>
		plain ? stripVTControlCharacters(text).replaceAll("\x1b", "") : stripVinciColor(text);
	const streams = [process.stdout, process.stderr].map((stream) => {
		const original = stream.write;
		const decoder = new StringDecoder("utf8");
		// A sequence split across write() calls is held here and completed by the next chunk.
		let held = "";
		stream.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			if (chunk === "") return original.call(stream, chunk, undefined, done);
			const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
			if (typeof chunk === "string" && !/^utf-?8$/i.test(encoding)) chunk = Buffer.from(chunk, encoding);
			const text = held + (typeof chunk === "string" ? decoder.end() + chunk : decoder.write(chunk));
			const [complete, rest] = splitPartialEscape(text);
			held = rest;
			return original.call(stream, filter(complete), undefined, done);
		}) as typeof stream.write;
		const flush = () => {
			const rest = held + decoder.end();
			held = "";
			if (rest) original.call(stream, filter(rest));
		};
		return { stream, original, flush };
	});
	const flushAll = () => {
		for (const { flush } of streams) flush();
	};
	// process.exit() skips main()'s finally; the exit hook still writes a held tail.
	process.once("exit", flushAll);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		process.off("exit", flushAll);
		flushAll();
		for (const { stream, original } of streams) stream.write = original;
	};
}
