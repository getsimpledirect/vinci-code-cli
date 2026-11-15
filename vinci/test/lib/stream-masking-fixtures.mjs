// Shared fixtures for the stream-masking rows: synthetic secret runs (built at runtime, never usable
// credentials) and assistant stream events, one completed line per update.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 * tool-call block carries the parsed partial `arguments` and the raw partial text (`field`), as a
 * provider streams them. `before`: content blocks ahead of the tool call (index 0..n-1), already
 * streamed. `ending`: "end" (toolcall_end, then message_end), "message_end" (message_end only, as an
 * abort, an error or a cut stream writes it, with the best-effort parse of the text so far), or "none".
 * `partialOnEnd`: the message_end block keeps its partial text field. `nameFrom`: the block's name is ""
 * until the `nameFrom`-th partial block (toolcall_start is the 0th); `name: undefined` leaves the name out
 * everywhere. `index`: "string" sends each event's content index as a numeric string, "missing" leaves it out,
 * and a number sends that number whatever the call's position. `after`: content blocks behind the tool call.
 * `finals`: message_end is followed by turn_end and agent_end carrying the same message. `keepPartialOnEnd`:
 * the completed call (the toolcall_end call, its partial and the final message) keeps its raw text field.
 */
export function toolCallEvents(
	name,
	fragments,
	{
		id = "call-1",
		before = [],
		after = [],
		start = true,
		ending = "end",
		stopReason,
		field = "partialJson",
		partialOnEnd = false,
		nameFrom = 0,
		index: indexForm = "number",
		finals = false,
		keepPartialOnEnd = false,
	} = {},
) {
	const index = before.length;
	const at =
		typeof indexForm === "number"
			? { contentIndex: indexForm }
			: indexForm === "string"
				? { contentIndex: String(index) }
				: indexForm === "missing"
					? {}
					: { contentIndex: index };
	const events = start ? [{ type: "message_start", message: assistant([]) }] : [];
	let step = 0;
	const named = () => (name === undefined ? {} : { name: step >= nameFrom ? name : "" });
	const call = (json, done) =>
		done
			? { type: "toolCall", id, ...named(), arguments: JSON.parse(json), ...(keepPartialOnEnd ? { [field]: json } : {}) }
			: { type: "toolCall", id, ...named(), arguments: partialArguments(json), [field]: json };
	const message = (json, done, reason) => assistant([...before, call(json, done), ...after], reason ?? (done ? "toolUse" : "stop"));
	let json = "";
	const first = message(json, false);
	events.push({ type: "message_update", message: first, assistantMessageEvent: { type: "toolcall_start", ...at, partial: first } });
	for (const fragment of fragments) {
		json += fragment;
		step++;
		const partial = message(json, false);
		events.push({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", ...at, delta: fragment, partial },
		});
	}
	step = Number.POSITIVE_INFINITY;
	let final;
	if (ending === "end") {
		final = message(json, true, stopReason);
		events.push({
			type: "message_update",
			message: final,
			assistantMessageEvent: { type: "toolcall_end", ...at, toolCall: final.content[index], partial: final },
		});
		events.push({ type: "message_end", message: final });
	} else if (ending === "message_end") {
		final = message(json, false, stopReason ?? "aborted");
		if (!partialOnEnd) delete final.content[index][field];
		events.push({ type: "message_end", message: final });
	}
	if (final && finals) {
		events.push({ type: "turn_end", message: final, toolResults: [] });
		events.push({ type: "agent_end", messages: [final] });
	}
	return { events, json, final };
}

/** The final events that carry a call's message: message_end, turn_end and agent_end. */
export function finalEventsOf(events) {
	return events.filter((event) => event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end");
}

/**
 * Cut points inside the secret run of `json`: within its first line, mid-run, inside its last line, just
 * after it, twice inside the line after it (where a key body's END line is cut short, on a dash), and three
 * characters before the argument text's end.
 */
export function cutPoints(json, secret) {
	const start = json.indexOf(secret[0]);
	const last = json.indexOf(secret.at(-1));
	assert.ok(start >= 0 && last >= start, "fixture sanity: the secret run is in the argument text");
	const end = last + secret.at(-1).length;
	return [...new Set([start + 16, Math.floor((start + end) / 2), last + 3, end, end + 7, end + 30, json.length - 3])];
}

/**
 * The 8-character windows of the raw argument text the stream held for the secret run: from its first
 * line to the cut (at most to the end of its last line). None of them may reach a final event.
 */
export function heldWindows(json, secret, cut) {
	const start = json.indexOf(secret[0]);
	const end = Math.min(cut, json.indexOf(secret.at(-1)) + secret.at(-1).length);
	const windows = [];
	for (let at = start; at + 8 <= end; at++) windows.push(json.slice(at, at + 8));
	return windows;
}

/** `text` cut into fragments of `size` characters. */
export function fragmentsOf(text, size) {
	const parts = [];
	for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
	return parts;
}

/** Built-in tool calls whose arguments carry `lines` as multi-line text: a file write and a shell command. */
export function multiLineToolCalls(lines) {
	const text = lines.join("\n");
	return {
		write: { path: "notes/out.txt", content: `Saved notes:\n${text}\nend of notes.\n` },
		bash: { command: `cat > out.txt <<'EOF'\n${text}\nEOF\nwc -l out.txt` },
	};
}

/** Every partial argument text (`partialJson` / `partialArgs`) anywhere in `events`. */
export function partialArgumentTexts(events) {
	const found = [];
	const walk = (value) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			for (const [key, entry] of Object.entries(value)) {
				if ((key === "partialJson" || key === "partialArgs") && typeof entry === "string") found.push(entry);
				else walk(entry);
			}
		}
	};
	walk(events);
	return found;
}

/** No 12-byte window of any secret line appears in `text` (the placeholder need not). */
export function assertNoSecretBytes(text, secret, where) {
	for (const line of secret) {
		for (let start = 0; start + 12 <= line.length; start += 4) {
			const window = line.slice(start, start + 12);
			assert.ok(!text.includes(window), `${where}: secret bytes ${JSON.stringify(window)} reached the stream`);
		}
	}
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

/**
 * The tool-name synonyms the agent loop folds onto a tool name, read from its table so that every entry
 * is covered: `[synonym, tool]` pairs.
 */
export function toolNameSynonyms() {
	const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/agent/src/agent-loop.ts"), "utf8");
	const table = source.match(/const VINCI_TOOL_SYNONYMS: Record<string, string> = \{([\s\S]*?)\n\};/);
	assert.ok(table, "fixture sanity: the synonym table is found");
	const pairs = [...table[1].matchAll(/^\s*([a-z_]+): "([a-z]+)",/gm)].map((match) => [match[1], match[2]]);
	const entries = table[1].split("\n").filter((line) => /^\s*[^\s/]/.test(line));
	assert.equal(pairs.length, entries.length, "fixture sanity: every entry of the synonym table is read");
	assert.ok(pairs.length > 0, "fixture sanity: the synonym table has entries");
	return pairs;
}

/** Arguments for a call of the built-in `tool` that carry `lines` as multi-line text. */
export function multiLineArguments(tool, lines) {
	const text = lines.join("\n");
	if (tool === "write" || tool === "bash") return multiLineToolCalls(lines)[tool];
	if (tool === "edit") return { path: "notes/out.txt", oldText: "old block", newText: `Updated block:\n${text}\nend of block.` };
	return { path: `notes/\n${text}\nend` };
}

/**
 * Each built-in call of multiLineToolCalls, for every secret shape, cut inside its secret value (five
 * characters into the run's middle line): `{ label, tool, json, secret }`, `json` the cut argument text.
 */
export function cutToolCalls() {
	return Object.values(secretRuns()).flatMap((run, n) =>
		Object.entries(multiLineToolCalls(run.lines)).map(([tool, args]) => {
			const json = JSON.stringify(args);
			const cut = json.indexOf(run.secret[Math.floor(run.secret.length / 2)]) + 5;
			return { label: `${tool}, case ${n + 1}`, tool, json: json.slice(0, cut), secret: run.secret };
		}),
	);
}

/** `events` with a stream-ending source event (`done` or `error`) that carries `final`, just before message_end. */
export function withSourceEnd(events, kind, final) {
	const at = events.findIndex((event) => event.type === "message_end");
	assert.ok(at >= 0, "fixture sanity: message_end is there");
	const source = kind === "done" ? { type: "done", reason: "stop", message: final } : { type: "error", reason: "aborted", error: final };
	return [...events.slice(0, at), { type: "message_update", message: final, assistantMessageEvent: source }, ...events.slice(at)];
}

/**
 * Tool-call streams whose events name no call (an out-of-range content index and no usable id), so the
 * fallback picks the call. Each case returns its events and the secret lines no stdout byte may carry:
 * 1. text taken into a nameless call is ended by another call's `toolcall_end`, then a `done` event names
 *    the call a tool the view does not mask;
 * 2. a built-in call that never gets state of its own (the fallback picks a nameless call) ends cut;
 * 3. a cut call's later fragment (a password value) is taken into a later call and parses alone;
 * 4. a later call's `toolcall_end` ends the streaming cut call, which keeps its incomplete partial text;
 * 5. tool-call deltas arrive while the message holds no tool call;
 * 6. a cut built-in call reaches the final events with no events of its own and nothing else streamed.
 */
export function fallbackCases() {
	const at = { contentIndex: 99 };
	const update = (content, event, stopReason = "stop") => {
		const message = assistant(content, stopReason);
		return { type: "message_update", message, assistantMessageEvent: { ...event, partial: message } };
	};
	const ends = (final) => [
		{ type: "message_end", message: final },
		{ type: "turn_end", message: final, toolResults: [] },
		{ type: "agent_end", messages: [final] },
	];
	const cut = secretRuns()["a multi-line hex secret"].lines[0];
	const token = inlineToken();
	const password = ["Zq8vLm3N", "pR7tWx2K"].join("");
	const cases = {};
	{
		const json = JSON.stringify({ command: `TOKEN=${token} true` });
		const a = { type: "toolCall", id: "", name: "bash", arguments: {} };
		const b = (text) => ({ type: "toolCall", id: "", name: "", arguments: {}, partialJson: text });
		const events = [{ type: "message_start", message: assistant([]) }, update([a, b("")], { type: "toolcall_start", ...at })];
		let text = "";
		for (const fragment of fragmentsOf(json, 9)) {
			text += fragment;
			events.push(update([a, b(text)], { type: "toolcall_delta", ...at, delta: fragment }));
		}
		const done = { ...a, arguments: JSON.parse(json) };
		events.push(update([done, b(text)], { type: "toolcall_end", ...at, toolCall: done }));
		const final = assistant([done, { type: "toolCall", id: "", name: "extension_tool", arguments: {}, partialJson: "" }], "toolUse");
		events.push({ type: "message_update", message: final, assistantMessageEvent: { type: "done", reason: "toolUse", message: final } });
		events.push(...ends(final));
		cases["another call's end, then a done event naming the call a tool the view does not mask"] = { events, secret: [token] };
	}
	{
		const a = (args) => ({ type: "toolCall", id: "a", name: "bash", arguments: args });
		const b = { type: "toolCall", id: "b", name: "", arguments: {} };
		const fragment = `{"command":"${cut}`;
		const events = [
			{ type: "message_start", message: assistant([]) },
			update([a({}), b], { type: "toolcall_start", ...at }),
			update([a({ command: cut }), b], { type: "toolcall_delta", ...at, delta: fragment }),
		];
		events.push(...ends(assistant([a({ command: cut }), b], "stop")));
		cases["a built-in call with no state of its own, cut"] = { events, secret: [cut] };
	}
	{
		const first = '{"command":"true","password":';
		const second = `"${password}"`;
		const a = (text, args) => ({ type: "toolCall", id: "", name: "bash", arguments: args, partialJson: text });
		const b = { type: "toolCall", id: "", name: "read", arguments: {}, partialJson: "" };
		const events = [
			{ type: "message_start", message: assistant([]) },
			update([a("", {})], { type: "toolcall_start", ...at }),
			update([a(first, { command: "true" })], { type: "toolcall_delta", ...at, delta: first }),
			update([a(first, { command: "true" }), b], { type: "toolcall_start", ...at }),
			update([a(first + second, { command: "true", password }), b], { type: "toolcall_delta", ...at, delta: second }),
		];
		events.push(...ends(assistant([a(first + second, { command: "true", password }), b], "aborted")));
		cases["a cut call's fragment taken into a later call"] = { events, secret: [password] };
	}
	{
		const text = `{"command":"${cut}`;
		const a = (partial) => ({ type: "toolCall", id: "", name: "bash", arguments: { command: cut }, partialJson: partial });
		const b = (args) => ({ type: "toolCall", id: "", name: "read", arguments: args });
		const events = [
			{ type: "message_start", message: assistant([]) },
			update([a(""), b({})], { type: "toolcall_start", ...at }),
			update([a(text), b({})], { type: "toolcall_delta", ...at, delta: text }),
		];
		const done = b({ path: "ok" });
		events.push(update([a(text), done], { type: "toolcall_end", ...at, toolCall: done }));
		events.push(...ends(assistant([a(text), done], "stop")));
		cases["another call's end taken by a streaming cut call"] = { events, secret: [cut] };
	}
	{
		const text = [block("text", "Working on it.")];
		const half = token.length / 2;
		const events = [
			{ type: "message_start", message: assistant([]) },
			update(text, { type: "toolcall_delta", contentIndex: 0, delta: `{"command":"${token.slice(0, half)}` }),
			update(text, { type: "toolcall_delta", contentIndex: 0, delta: `${token.slice(half)}"}` }),
		];
		events.push(...ends(assistant(text, "stop")));
		cases["tool-call deltas while the message holds no tool call"] = { events, secret: [token] };
	}
	for (const stopReason of ["stop", "aborted"]) {
		const final = assistant([{ type: "toolCall", id: "x", name: "bash", arguments: { command: cut } }], stopReason);
		const events = [{ type: "message_start", message: assistant([]) }, ...ends(final)];
		cases[`a built-in call with no events of its own and nothing streamed, in a message that ended ${stopReason}`] = { events, secret: [cut] };
	}
	return cases;
}
