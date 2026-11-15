// Shared fixtures for the stream-masking rows: synthetic secret runs (built at runtime, never usable
// credentials) and assistant stream events, one completed line per update.
import assert from "node:assert/strict";

export const PLACEHOLDER = "‹redacted›";

export function secretRuns() {
	const wrap = (text, width) => text.match(new RegExp(`.{1,${width}}`, "g"));
	// A private-key body with no BEGIN line, masked back from its END line.
	const keyBody = wrap(Buffer.from("plain filler bytes for a test only body, ".repeat(5)).toString("base64"), 64);
	const keyEnd = ["-----", "END RSA PRIVATE", " KEY-----"].join("");
	// Multi-line base64 whose decoded whole holds an environment secret (no single line does).
	const encoded = Buffer.from(`Notes for the deploy step follow here.\nDB_${"PASS"}WORD=${"Zq8vLm3N"}${"pR7tWx2K"}\n`).toString(
		"base64",
	);
	// A hex run whose decoded whole is a token: it spans the line breaks.
	const hex = Buffer.from(`${"gh"}p_${"A1b2C3d4E5f6"}${"G7h8I9j0K1l2"}${"M3n4O5p6Q7r8"}`).toString("hex");
	return {
		"an END-only private-key body": { lines: [...keyBody, keyEnd], secret: keyBody },
		"a multi-line base64 secret": { lines: wrap(encoded, 40), secret: wrap(encoded, 40) },
		"a multi-line hex secret": { lines: wrap(hex, 24), secret: wrap(hex, 24) },
	};
}

/** A single-line token value, built at runtime. */
export function inlineToken() {
	return `${"gh"}p_${"Q1w2E3r4T5y6"}${"U7i8O9p0A1s2"}${"D3f4G5h6J7k8"}`;
}

/** No 12-byte window of any secret line appears in `text`, and the placeholder does. */
export function assertMasked(text, secret, where) {
	for (const line of secret) {
		for (let start = 0; start + 12 <= line.length; start += 4) {
			const window = line.slice(start, start + 12);
			assert.ok(!text.includes(window), `${where}: secret bytes ${JSON.stringify(window)} reached the stream`);
		}
	}
	assert.ok(text.includes(PLACEHOLDER), `${where}: the placeholder is written`);
}

export function block(kind, text) {
	return kind === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text };
}

export function assistant(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

/**
 * Assistant stream events for `lines`, one completed line per update. `end`: a block end event and
 * message_end; `withEnd` (when `end` is false): message_end only, as an abort or error writes it.
 */
export function streamEvents(lines, { kind = "text", end = true, withEnd = true, stopReason = "stop", eol = "\n" } = {}) {
	const events = [{ type: "message_start", message: assistant([]) }];
	const first = assistant([block(kind, "")]);
	events.push({
		type: "message_update",
		message: first,
		assistantMessageEvent: { type: `${kind}_start`, contentIndex: 0, partial: first },
	});
	let text = "";
	for (const line of lines) {
		text += `${line}${eol}`;
		const message = assistant([block(kind, text)]);
		events.push({
			type: "message_update",
			message,
			assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta: `${line}${eol}`, partial: message },
		});
	}
	if (end) {
		const message = assistant([block(kind, text)]);
		events.push({
			type: "message_update",
			message,
			assistantMessageEvent: { type: `${kind}_end`, contentIndex: 0, content: text, partial: message },
		});
	}
	if (end || withEnd) events.push({ type: "message_end", message: assistant([block(kind, text)], stopReason) });
	return { events, text };
}

/** Private-key BEGIN and END markers, built at runtime. */
export function keyMarkers() {
	const kind = ["RSA", "PRIVATE", "KEY"].join(" ");
	return { begin: `${"-----"}BEGIN ${kind}-----`, end: `${"-----"}END ${kind}-----` };
}

/** A best-effort parse of partial JSON argument text, as a provider fills `arguments` while streaming. */
function partialArguments(json) {
	for (const tail of ["", '"}', "}"]) {
		try {
			return JSON.parse(json + tail);
		} catch {
			// try the next closing
		}
	}
	return {};
}

/**
 * Assistant stream events for one tool call whose argument JSON arrives in `fragments`. Each partial
 * tool-call block carries the parsed partial `arguments` and the raw `partialJson`, as a provider
 * streams them. `before`: content blocks ahead of the tool call (index 0..n-1), already streamed.
 */
export function toolCallEvents(name, fragments, { id = "call-1", before = [], start = true } = {}) {
	const index = before.length;
	const events = start ? [{ type: "message_start", message: assistant([]) }] : [];
	const call = (json, done) =>
		done
			? { type: "toolCall", id, name, arguments: JSON.parse(json) }
			: { type: "toolCall", id, name, arguments: partialArguments(json), partialJson: json };
	const message = (json, done) => assistant([...before, call(json, done)], done ? "toolUse" : "stop");
	let json = "";
	const first = message(json, false);
	events.push({ type: "message_update", message: first, assistantMessageEvent: { type: "toolcall_start", contentIndex: index, partial: first } });
	for (const fragment of fragments) {
		json += fragment;
		const partial = message(json, false);
		events.push({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta: fragment, partial },
		});
	}
	const final = message(json, true);
	events.push({
		type: "message_update",
		message: final,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: final.content[index], partial: final },
	});
	events.push({ type: "message_end", message: final });
	return { events, json };
}

/** `json` cut into fragments so that `value` is split: at `value`'s 14th character, or every `step` characters across it. */
export function splitAcross(json, value, step) {
	const start = json.indexOf(value);
	assert.ok(start >= 0, "fixture sanity: the value is in the argument text");
	if (!step) return [json.slice(0, start + 14), json.slice(start + 14)];
	const cuts = [];
	for (let at = start + step; at < start + value.length; at += step) cuts.push(at);
	const parts = [];
	let from = 0;
	for (const at of cuts) {
		parts.push(json.slice(from, at));
		from = at;
	}
	parts.push(json.slice(from));
	return parts;
}

/** The deltas of one kind (and content block, when given), joined. */
export function deltasOf(events, kind = "text", index) {
	return events
		.filter(
			(event) =>
				event.type === "message_update" &&
				event.assistantMessageEvent?.type === `${kind}_delta` &&
				(index === undefined || event.assistantMessageEvent.contentIndex === index),
		)
		.map((event) => event.assistantMessageEvent.delta)
		.join("");
}

/** Every streamed text field is a prefix of the final one: released text is never rewritten later. */
export function assertNeverRewritten(events, finalText, index = 0, kind = "text") {
	for (const event of events) {
		if (event.type !== "message_update") continue;
		const shown = event.message?.content?.[index]?.[kind];
		if (typeof shown !== "string") continue;
		assert.ok(finalText.startsWith(shown), `released text ${JSON.stringify(shown.slice(-40))} is a prefix of the final text`);
	}
}
