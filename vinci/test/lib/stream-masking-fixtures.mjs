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

// ---------------------------------------------------------------------------------------------------
// Rows for review findings R221-01..05: values are obviously fake and built at runtime.
// ---------------------------------------------------------------------------------------------------

/** An obviously fake secret value. */
export function fakeSecret() {
	return ["leaked", "S3cret!"].join("");
}

/** `secret` (a raw value, not a window) appears nowhere in `text`; the message names the finding and the place. */
export function assertNoRawSecret(text, secret, where) {
	assert.ok(typeof text === "string", `${where}: fixture sanity: there is text to search`);
	assert.ok(!text.includes(secret), `${where}: the raw secret ${JSON.stringify(secret)} reached stdout`);
}

/**
 * R221-01: chunk sequences whose secret the masker finds only once a later chunk arrives (its assignment
 * value crosses a line break, or a code reference is continued on the next line). Each chunk is one delta.
 */
export function crossLineCases() {
	const secret = fakeSecret();
	return [
		{ label: "LF, an angle-bracket value", chunks: ["password=<\n", `${secret}\n`, ">\n"] },
		{ label: "CRLF, an angle-bracket value", chunks: ["password=<\r\n", `${secret}\r\n`, ">\r\n"] },
		{ label: "U+2028 before LF, an angle-bracket value", chunks: [`password=<\u2028${secret}\n`, ">\n"] },
		{ label: "a code reference continued on the next line", chunks: [`password=process.env['${secret}'];\n`, ".trim()\n"] },
	].map((entry) => ({ ...entry, secret }));
}

/** The secret value of the review probes, byte for byte ("uN1que!42"). */
export function probeSecret() {
	return ["uN1", "que!42"].join("");
}

/**
 * R221-05, as the review probe built it: a bash result whose two text parts join (with "\n", as the view joins
 * them) into an END-only key block, and cumulative updates whose first ends before the END line. `hidden`: the
 * body, which only the joined (or final) body masks. `details`: the probe's result details.
 */
export function splitKeyResult() {
	const body = ["abcdefgh", "ijklmnop", "qrstuvwx"].join("");
	const end = ["-----", "END PRIVATE", " KEY-----"].join("");
	return {
		parts: [body, end],
		hidden: body,
		cumulative: `${body}\n`,
		final: `${body}\n${end}\n`,
		details: { diff: `password=${probeSecret()}`, fullOutputPath: "/synthetic/output.log" },
	};
}

/** R221-02, as the review probe built it: an assignment split by a control sequence (or a carriage return). */
export function ansiSecretCases() {
	const secret = probeSecret();
	return {
		secret,
		ansiOutput: `password\u001b[31m=${secret}`,
		crOutput: `pass\rword=${secret}`,
		command: `password\u001b[31m=${secret}`,
		errorMessage: `unexpected provider failure: password\u001b[31m=${secret}`,
	};
}

/**
 * The review probe's event sequence for one bash result: update, end, the tool result message's start and end,
 * turn_end and agent_end, with the probe's minimal message shapes.
 */
export function probeToolResultEvents(content, details) {
	const result = { content, details };
	const toolResult = { role: "toolResult", toolName: "bash", toolCallId: "a", ...result };
	const done = { role: "assistant", content: [], stopReason: "stop" };
	return [
		{ type: "tool_execution_update", toolName: "bash", toolCallId: "a", args: { command: "printf" }, partialResult: result },
		{ type: "tool_execution_end", toolName: "bash", toolCallId: "a", result, isError: false },
		{ type: "message_start", message: toolResult },
		{ type: "message_end", message: toolResult },
		{ type: "turn_end", message: done, toolResults: [toolResult] },
		{ type: "agent_end", messages: [toolResult] },
	];
}

/** The review probe's cumulative bash updates: the body alone, then the body with its END line, then the end. */
export function probeCumulativeEvents(cumulative, final) {
	const first = { content: [{ type: "text", text: cumulative }] };
	const last = { content: [{ type: "text", text: final }] };
	return [
		{ type: "tool_execution_update", toolName: "bash", toolCallId: "a", args: { command: "printf" }, partialResult: first },
		{ type: "tool_execution_update", toolName: "bash", toolCallId: "a", args: { command: "printf" }, partialResult: last },
		{ type: "tool_execution_end", toolName: "bash", toolCallId: "a", result: last, isError: false },
	];
}

/** The review probe's streamed bash call: toolcall_start, one toolcall_delta of the whole argument JSON, completion. */
export function probeBashCallEvents(command) {
	const args = { command };
	const call = { type: "toolCall", id: "a", name: "bash", arguments: args };
	const message = { role: "assistant", content: [call], stopReason: "toolUse" };
	const partial = { ...message, content: [{ ...call, arguments: {} }] };
	return [
		{ type: "message_start", message: { ...message, content: [] } },
		{ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } },
		{ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message } },
		{ type: "message_update", message, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message } },
		{ type: "message_end", message },
		{ type: "turn_end", message, toolResults: [] },
		{ type: "agent_end", messages: [message] },
	];
}

// ---------------------------------------------------------------------------------------------------
// 206s: inputs of the review probes for findings B01..B08, byte for byte; values are fake and built at runtime.
// ---------------------------------------------------------------------------------------------------

/**
 * 206s (B01): a bash command whose value spans lines (crossLineCases()[0] joined, its final line break removed): the
 * view masks it whole. `cut`: its argument text cut in a later field, as a stream that ended there leaves it.
 */
export function cutCommandCase() {
	const { chunks, secret } = crossLineCases()[0];
	const command = chunks.join("").trimEnd();
	return { command, secret, cut: `${JSON.stringify({ command }).slice(0, -1)},"timeout":` };
}

/** 206s (B01): the probe's interrupted call: the cut argument text kept on a call in a message that ended aborted. */
export function interruptedCutEvents() {
	const { command, secret, cut } = cutCommandCase();
	const call = { type: "toolCall", id: "cut-a", name: "bash", arguments: { command }, partialJson: cut };
	const message = assistant([call], "aborted");
	const events = [
		{ type: "message_start", message: assistant([]) },
		{ type: "message_end", message },
		{ type: "agent_end", messages: [message] },
	];
	return { events, message, command, secret };
}

/**
 * 206s (B01): a call that completed (its toolcall_end carries the parsed arguments) while its streamed text stopped in a
 * later field: the call, its final message, turn_end and agent_end keep that cut text as partialJson.
 */
export function retainedCutEvents() {
	const { command, secret, cut } = cutCommandCase();
	const call = { type: "toolCall", id: "cut-b", name: "bash", arguments: { command }, partialJson: cut };
	const message = assistant([call], "toolUse");
	const streaming = assistant([{ type: "toolCall", id: "cut-b", name: "bash", arguments: {}, partialJson: "" }]);
	const delta = assistant([{ type: "toolCall", id: "cut-b", name: "bash", arguments: {}, partialJson: cut }]);
	const events = [
		{ type: "message_start", message: assistant([]) },
		{ type: "message_update", message: streaming, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: streaming } },
		{ type: "message_update", message: delta, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: cut, partial: delta } },
		{ type: "message_update", message, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message } },
		{ type: "message_end", message },
		{ type: "turn_end", message, toolResults: [] },
		{ type: "agent_end", messages: [message] },
	];
	return { events, message, command, secret };
}

/**
 * 206s (B02): the probe's reasoning item: an END-only private-key body, one line per `field` entry ("summary" or
 * "content", the provider's fallback), the END line in the last; the thinking block is the provider's join of them.
 */
export function splitReasoningMessage(field) {
	const run = secretRuns()["an END-only private-key body"];
	const item = {
		id: "rs_fixture",
		type: "reasoning",
		[field]: run.lines.map((text) => ({ type: field === "summary" ? "summary_text" : "reasoning_text", text })),
	};
	const thinking = run.lines.join("\n\n");
	const message = { role: "assistant", content: [{ type: "thinking", thinking, thinkingSignature: JSON.stringify(item) }], stopReason: "stop" };
	return { message, run, item, events: [{ type: "message_end", message }, { type: "agent_end", messages: [message] }] };
}

/** 206s (B03): the probe's assistant error: a DCS string inside an assignment's key. */
export function controlStringError() {
	const secret = probeSecret();
	const errorMessage = `password\x1bP harmless text;\x1b\\=${secret}`;
	const message = { ...assistant([], "error"), errorMessage };
	return { secret, errorMessage, message, events: [{ type: "message_end", message }, { type: "agent_end", messages: [message] }] };
}

/** 206s (B04): the probe's ordinary tool progress, and the error-only end that follows it in the second probe. */
export function progressEvents() {
	const text = "ordinary progress worth retaining.";
	const update = {
		type: "tool_execution_update",
		toolName: "custom",
		toolCallId: "partial-only",
		partialResult: { content: [{ type: "text", text }], details: { progress: 17 } },
	};
	const errorUpdate = { type: "tool_execution_update", toolName: "custom", toolCallId: "a", partialResult: { content: [{ type: "text", text }] } };
	const errorEnd = {
		type: "tool_execution_end",
		toolName: "custom",
		toolCallId: "a",
		result: { content: [{ type: "text", text: "operation aborted." }] },
		isError: true,
	};
	return { text, update, errorUpdate, errorEnd };
}

/**
 * 206s (B04): a tool's progress that is a key body cut before its END line (splitKeyResult's first cumulative update:
 * alone it is not masked, and it cannot be masked whole). `final`: the same body with its END line, which is masked.
 */
export function keyBlockProgress() {
	const { cumulative, final, hidden } = splitKeyResult();
	const update = {
		type: "tool_execution_update",
		toolName: "custom",
		toolCallId: "key-progress",
		partialResult: { content: [{ type: "text", text: cumulative }], details: { note: cumulative } },
	};
	return { body: cumulative, final, hidden, update };
}

/**
 * 206s follow-up (B04, B05): a body cut inside an angle value whose closing `>` has not arrived. Every line of it is
 * complete and ends in punctuation, so the hold-back would release it whole, yet alone it is not masked, while with
 * its `>` line it is.
 * `update` / `errorEnd`: that body as a tool's progress, then an error-only end; `lines`: the same body as text
 * lines, then the closing line and more (a text block cut at a byte bound of `cutBytes`).
 */
export function angleCutCase() {
	const secret = probeSecret();
	const body = `password=<\n${secret}!\n`;
	const update = {
		type: "tool_execution_update",
		toolName: "custom",
		toolCallId: "angle-cut",
		partialResult: { content: [{ type: "text", text: body }], details: { note: body } },
	};
	const errorEnd = {
		type: "tool_execution_end",
		toolName: "custom",
		toolCallId: "angle-cut",
		result: { content: [{ type: "text", text: "operation aborted." }] },
		isError: true,
	};
	return { secret, body, update, errorEnd, lines: ["password=<", `${secret}!`, ">", "That is all."], cutBytes: body.length - 1 };
}

/** The tool_execution_update events of `events` whose partial result carries text. */
export function releasedUpdates(events) {
	return events.filter(
		(event) =>
			event?.type === "tool_execution_update" &&
			Array.isArray(event.partialResult?.content) &&
			event.partialResult.content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text !== ""),
	);
}

/** 206s (B07): details with an own `__proto__` key (as JSON.parse makes it), at two levels. */
export function ownProtoDetails() {
	return JSON.parse('{"__proto__":{"note":"plain preserved data","inner":{"__proto__":{"deep":"kept too"}}},"count":7}');
}

/** 206s (B08): String, Number and Boolean objects, at top level and nested in an array (no secret). */
export function boxedDetails() {
	return {
		message: new String("ordinary boxed message"),
		count: new Number(7),
		flag: new Boolean(true),
		list: [new String("listed text"), new Number(3), new Boolean(false)],
	};
}

// ---------------------------------------------------------------------------------------------------
// 206t: inputs of the review probes for findings D01..D05, byte for byte; values are fake and built at runtime.
// ---------------------------------------------------------------------------------------------------

/**
 * 206t (D01): the probe's token cut below the pattern's minimum length (alone the mask leaves it as it is), and the
 * whole token (masked to its 4-character head). `tail`: the cut token past that head; no window of it may reach stdout.
 */
export function tokenPrefixCase() {
	const prefix = `${["sk", "ant", "A1b2C3d4E5f6G7h"].join("-")}-`;
	const full = `${prefix}${["J8k9L0m1N2", "p3Q4r5S6t7"].join("")}`;
	return { prefix, full, tail: prefix.slice(4) };
}

/** No 6-character window of `tail` appears in `text`. */
export function assertNoPrefixBytes(text, tail, where) {
	assert.ok(typeof text === "string", `${where}: fixture sanity: there is text to search`);
	for (let at = 0; at + 6 <= tail.length; at++) {
		const window = tail.slice(at, at + 6);
		assert.ok(!text.includes(window), `${where}: cut token bytes ${JSON.stringify(window)} reached stdout`);
	}
}

/** 206t (D01): the probe's tool progress that is the cut token (no tool name, as the probe sent it). */
export function tokenPrefixUpdate(toolCallId = "token-prefix") {
	const { prefix } = tokenPrefixCase();
	return { type: "tool_execution_update", toolCallId, partialResult: { content: [{ type: "text", text: prefix }] } };
}

/** 206t: a tool end for `toolCallId` with `text` as its only output; `isError` as given. */
export function toolEnd(toolCallId, text, { isError = false, details, toolName } = {}) {
	const result = { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
	return { type: "tool_execution_end", ...(toolName === undefined ? {} : { toolName }), toolCallId, result, isError };
}

/** 206t (D01, D03): the probe's minimal assistant message with one text block. */
export function probeTextMessage(text) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

/** 206t (D01, D03): the probe's text_delta update of block 0 of `message`. */
export function probeTextUpdate(message, delta) {
	return { type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message } };
}

/**
 * 206t (D02): the UTF-8 bytes of every string value a masker instance still holds (Maps, Sets, arrays and objects
 * walked; weak references and functions not counted): what it retains of the bodies it held.
 * 206u (E02): include keys, container overhead, binary storage and scalar values too.
 */
export function retainedStringBytes(root) {
	const seen = new Set();
	const stack = [root];
	let total = 0;
	while (stack.length > 0) {
		const value = stack.pop();
		if (typeof value === "string") {
			total += 2 + Buffer.byteLength(value, "utf8");
			continue;
		}
		if (typeof value === "number" || typeof value === "bigint") total += 8;
		else if (value === null || typeof value === "boolean") total += 5;
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		if (value instanceof WeakSet || value instanceof WeakMap || value instanceof WeakRef) continue;
		total += 2;
		if (ArrayBuffer.isView(value)) total += value.byteLength;
		else if (value instanceof Map) {
			for (const [key, entry] of value) stack.push(key, entry);
		} else if (value instanceof Set) {
			for (const entry of value) stack.push(entry);
		} else if (Array.isArray(value)) {
			for (const entry of value) stack.push(entry);
		} else {
			for (const key of Object.keys(value)) stack.push(key, value[key]);
		}
	}
	return total;
}

/**
 * 206t (D02): the probe's bounded inputs. `largeDetails`: ordinary text with 4096 bytes of details; `detailsOnly`: no
 * text, the same details; `controls`: 4096 NUL bytes before ordinary text (normalisation removes them); `payload`: the
 * details string. `callDeltas`: the probe's two argument deltas of one call (268 bytes, then 4096 more).
 */
export function boundedInputs() {
	const payload = "x".repeat(4096);
	const update = (toolCallId, partialResult) => ({ type: "tool_execution_update", toolCallId, toolName: "bash", partialResult });
	return {
		payload,
		largeDetails: update("details", { content: [{ type: "text", text: "ordinary." }], details: { payload } }),
		detailsOnly: update("details-only", { content: [], details: { payload } }),
		controls: update("controls", { content: [{ type: "text", text: `${"\0".repeat(4096)}ordinary.` }] }),
		callDeltas: [`{"command":"${"x".repeat(256)}`, "x".repeat(4096)],
	};
}

/** 206t (D02): the probe's streamed call: message_start, then one toolcall_delta per entry of `deltas` (no end). */
export function probeCallEvents(deltas) {
	const message = (partialJson) => ({
		role: "assistant",
		content: [{ type: "toolCall", id: "bounded-call", name: "bash", arguments: {}, partialJson }],
		stopReason: "stop",
	});
	const events = [{ type: "message_start", message: message("") }];
	let raw = "";
	for (const delta of deltas) {
		raw += delta;
		const m = message(raw);
		events.push({ type: "message_update", message: m, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta, partial: m } });
	}
	return events;
}

/**
 * 206t (D02): a text block whose multi-byte body arrives with no delta of its own (in its text_start): 600 UTF-16 units,
 * 1200 UTF-8 bytes. Then its text_end and message_end.
 */
export function multiByteStartEvents() {
	const body = "é".repeat(600);
	const message = assistant([block("text", body)]);
	return {
		body,
		events: [
			{ type: "message_start", message: assistant([]) },
			{ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message } },
			{ type: "message_update", message, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: body, partial: message } },
			{ type: "message_end", message },
		],
	};
}

/** 206t (D04): the probe's details-only checkpoint update. */
export function checkpointUpdate() {
	return {
		type: "tool_execution_update",
		toolCallId: "details-only",
		toolName: "bash",
		partialResult: { content: [], details: { checkpoint: "ordinary checkpoint data" } },
	};
}

/** 206t (D05): String, Number and Boolean objects made in another realm (node:vm), as the probe made them. */
export function crossRealmBoxed(vm) {
	return vm.runInNewContext('({message:new String("ordinary boxed message"),count:new Number(7),flag:new Boolean(true)})');
}

/**
 * 206t (D05): boxed values whose own methods JSON.stringify does not call: a Boolean whose valueOf is overridden (the
 * probe's), and a String whose valueOf is overridden (its toString is read). `throwing`: the same with throwing
 * overrides, and a Number whose toString throws (its valueOf is read).
 */
export function overriddenBoxed({ throwing = false } = {}) {
	const fail = () => {
		throw new Error("an own method was called");
	};
	const flag = new Boolean(true);
	flag.valueOf = throwing ? fail : () => false;
	const message = new String("ordinary boxed message");
	message.valueOf = throwing ? fail : () => "other text";
	const details = { flag, message };
	if (throwing) {
		const count = new Number(7);
		count.toString = fail;
		details.count = count;
	}
	return details;
}

/**
 * 206t (D01): text blocks cut by an error, an abort or the length limit. Each ends in the cut token (below its
 * minimum length) as its unfinished last line. `head`: the complete lines the stream keeps, before masking (the
 * released text is their mask, then the placeholder); `startsWith`: when only the kept text's start is pinned;
 * `forbidden`: text no byte of stdout may carry (a key marker, key lines, a secret inside the open construct).
 */
export function earlyCutCases() {
	const { prefix, full } = tokenPrefixCase();
	const secret = probeSecret();
	const { begin } = keyMarkers();
	const keyLines = Buffer.from("plain filler bytes for an open key block, test only. ".repeat(3))
		.toString("base64")
		.match(/.{1,64}/g);
	return [
		{ label: "a token cut below its minimum length", text: prefix, head: "", forbidden: [] },
		{
			label: "a full token on an earlier complete line, then the cut token",
			text: `Here it is:\nThe old token was ${full}.\n${prefix}`,
			head: `Here it is:\nThe old token was ${full}.\n`,
			forbidden: [],
		},
		{
			label: "a cut inside an open key block",
			text: `Here it is:\n${begin}\n${keyLines.join("\n")}\n${prefix}`,
			head: "Here it is:\n",
			forbidden: [begin, ...keyLines.map((line) => line.slice(0, 24))],
		},
		{ label: "a cut inside an open ${", text: `Here it is:\nvalue: ${"$"}{\n${secret}!\n${prefix}`, head: "Here it is:\n", forbidden: [secret] },
		{
			label: "a cut inside an open angle value",
			text: `Here it is:\npassword=<\n${secret}!\n${prefix}`,
			head: "Here it is:\n",
			forbidden: [secret],
		},
		{
			label: "a cut after key-body lines with no END marker yet",
			text: `Here it is:\n${keyLines.join("\n")}\n${prefix}`,
			head: "Here it is:\n",
			forbidden: keyLines.map((line) => line.slice(0, 24)),
		},
		{
			label: "a cut after the first line of an encoded run",
			text: `Here it is:\n${encodedRunLines().base64[0]}\n${prefix}`,
			head: "Here it is:\n",
			forbidden: [encodedRunLines().base64[0].slice(0, 16)],
		},
		{
			label: "a cut inside an open ${ too short to mask alone",
			text: `Here it is:\npassword=${"$"}{\n${prefix}`,
			head: "Here it is:\n",
			forbidden: [`password=${"$"}{`],
		},
		{
			label: "a cut after a value a chained call on the next line would extend",
			text: `Here it is:\npassword=q7;\n${prefix}`,
			head: "Here it is:\n",
			forbidden: ["password=q7"],
		},
		{
			label: "a cut after an environment lookup not yet closed",
			text: `Here it is:\npassword=getenv(\n${prefix}`,
			head: "Here it is:\n",
			forbidden: ["password=getenv("],
		},
	];
}

/**
 * 206t (D01): an encoded run split over two lines. Each line alone decodes to nothing the mask treats as a secret;
 * joined (base64: the mask's multi-line run; hex: its run across line breaks) they decode to a secret assignment.
 * The first part is 18 bytes, so its base64 ends on a whole group and the lines join as one encoding.
 */
export function encodedRunLines() {
	const first = Buffer.from(`padding pad\n${"TOK"}EN=`);
	const second = Buffer.from(["zq8v3k", "xw2p9m"].join(""));
	return {
		base64: [first.toString("base64"), second.toString("base64")],
		hex: [first.toString("hex"), second.toString("hex")],
	};
}

/**
 * 206t (D01): inputs for the cross-check of the cut block's hold against the mask, one group per construct of the mask
 * that lets later text change how earlier complete lines are masked. `opened`: complete lines as a cut leaves them;
 * `closed`: the same lines and what the construct could still take. `changes`: what the mask does (the masked closed
 * text does not start with the masked opened text, trailing white space aside); `release`: a control the hold must
 * release whole; `held`: the hold must keep back the text from this offset on (a construct the mask closes at the
 * text's end, which the hold keeps back anyway).
 */
export function cutHoldCrossCheckInputs() {
	const { begin, end } = keyMarkers();
	const keyLines = Buffer.from("plain filler bytes for an open key block, test only. ".repeat(3))
		.toString("base64")
		.match(/.{1,64}/g);
	const { base64, hex } = encodedRunLines();
	const here = "Here it is:\n";
	return [
		{ construct: "BEGIN..END key block", opened: `${here}${begin}\n${keyLines[0]}\n`, closed: `${here}${begin}\n${keyLines[0]}\n${end}\n`, changes: false, held: here.length },
		{ construct: "END-only key run", opened: `${here}${keyLines.join("\n")}\n`, closed: `${here}${keyLines.join("\n")}\n${end}\n`, changes: true },
		{ construct: "END-only key run", opened: `${keyLines.join("\n")}\n`, closed: `${keyLines.join("\n")}\n${end}\n`, changes: true },
		{ construct: "END-only key run", opened: "Here it is: done.\n", closed: `Here it is: done.\n${end}\n`, changes: false, release: true },
		{ construct: "encoded run", opened: `${here}${base64[0]}\n`, closed: `${here}${base64[0]}\n${base64[1]}\n`, changes: true },
		{ construct: "encoded run", opened: `${here}${hex[0]}\n`, closed: `${here}${hex[0]}\n${hex[1]}\n`, changes: true },
		{ construct: "encoded run", opened: "Note: see the docs.\n", closed: `Note: see the docs.\n${base64[1]}\n`, changes: false, release: true },
		{ construct: "open ${", opened: `password=${"$"}{\n`, closed: `password=${"$"}{\nx}\n`, changes: true },
		{ construct: "open ${", opened: `${here}password=${"$"}{\n`, closed: `${here}password=${"$"}{\nx}\n`, changes: true },
		{ construct: "open ${", opened: `password=${"$"}{HOME}\n`, closed: `password=${"$"}{HOME}\nx}\n`, changes: false, release: true },
		{ construct: "chained call", opened: "password=q7;\n", closed: "password=q7;\n.x()\n", changes: true },
		{
			construct: "chained call",
			opened: `${here}export password=process.env.DB_PASS;\n`,
			closed: `${here}export password=process.env.DB_PASS;\n.split(':')[1]\n`,
			changes: true,
		},
		{ construct: "chained call", opened: "password=q7;\nnext line.\n", closed: "password=q7;\nnext line.\n.x()\n", changes: false, release: true },
		{ construct: "environment lookup", opened: "password=getenv(\n", closed: "password=getenv(\n9q-x)\n", changes: true },
		{ construct: "environment lookup", opened: `${here}password=os.environ[\n`, closed: `${here}password=os.environ[\n9q-x]\n`, changes: true },
		{
			construct: "environment lookup",
			opened: "password=getenv('HOME') # read once.\n",
			closed: "password=getenv('HOME') # read once.\n.x()\n",
			changes: false,
			release: true,
		},
	];
}

/**
 * 206t (D01): inputs for the cross-check of the cut block's open-angle rule against the mask: complete lines, opened
 * and closed, with and without a secret name, on one line and across lines. The check appends a value and its `>`.
 */
export function angleCrossCheckInputs() {
	return [
		{ text: "password=<\n", keyed: true },
		{ text: "password: <\n", keyed: true },
		{ text: "password=\n<\n", keyed: true },
		{ text: "api_key = <\n", keyed: true },
		{ text: "password=<closed-value>\n", keyed: true },
		{ text: "password=<a-value> token=<\n", keyed: true },
		{ text: "note=<\n", keyed: false },
		{ text: "a < b\n", keyed: false },
		{ text: "see <link>\n", keyed: false },
		{ text: "plain text\n", keyed: false },
		// 206u (E01): compare the unbounded opener with the actual whole-body mask.
		...[255, 256, 300, 5000].map((count) => ({ text: `password=${" ".repeat(count)}<\n`, keyed: true })),
		{ text: `password:${" \n\t".repeat(100)}<\n`, keyed: true },
		{ text: " \n\t<\n", keyed: false },
	];
}

/** 206u (E01): complete angle values with an unfinished closing line. */
export function angleWhitespaceCases() {
	const secret = ["qV7zL9mK", "2wR8pT4x", "N6bH3dF5!"].join("");
	return [
		...[0, 255, 256, 300, 5000].map((count) => ({ label: `${count} spaces`, whitespace: " ".repeat(count) })),
		{ label: "mixed spaces and line breaks", whitespace: " \n\t".repeat(100) },
	].map((entry) => ({ ...entry, secret }));
}

/** 206u (E01): one block, optionally streamed, followed by source and session final events. */
export function angleEndingEvents(text, kind, streamed, stopReason) {
	const final = assistant([block(kind, text)], stopReason);
	const events = [{ type: "message_start", message: assistant([]) }];
	if (streamed) {
		const partial = assistant([block(kind, text)]);
		events.push({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta: text, partial },
		});
	}
	const source =
		stopReason === "error"
			? { type: "error", reason: "error", error: final }
			: { type: "done", reason: stopReason, message: final };
	events.push(
		{ type: "message_update", message: final, assistantMessageEvent: source },
		{ type: "message_end", message: final },
		{ type: "turn_end", message: final, toolResults: [] },
		{ type: "agent_end", messages: [final] },
	);
	return { events, final };
}

/** 206u (E01, E03): every five-character window past the normal mask head is absent. */
export function assertNoFiveCharacterSecret(text, hidden, where) {
	assert.equal(typeof text, "string", `${where}: stdout is present`);
	for (let at = 0; at + 5 <= hidden.length; at++) {
		const window = hidden.slice(at, at + 5);
		assert.ok(!text.includes(window), `${where}: hidden bytes ${JSON.stringify(window)} reached stdout`);
	}
}

/** 206u (E02): each body has its own budget, independent of earlier shown bodies and neighboring metadata. */
export function isolatedBodyCases() {
	const { secret } = angleWhitespaceCases()[0];
	const answer = `Answer: password=${secret}\nDone.`;
	const cap = 1024;
	const cases = [
		{
			label: "a thinking bound leaves the following text answer intact",
			blocks: [
				{ kind: "thinking", text: "ordinary reasoning; ".repeat(80), cut: true },
				{ kind: "text", text: answer },
			],
		},
		{
			label: "an oversized signature cuts only the middle of three blocks",
			blocks: [
				{ kind: "text", text: "Before the signed block." },
				{
					kind: "thinking",
					text: "ordinary reasoning.",
					thinkingSignature: "ordinary opaque data; ".repeat(100),
					cut: true,
				},
				{ kind: "text", text: answer },
			],
		},
		{
			label: "completed text above the cap is not metered against the following held block",
			blocks: [
				{ kind: "text", text: "Completed prose. ".repeat(100), endOnly: true },
				{ kind: "text", text: answer },
			],
		},
	];
	return cases.map(({ label, blocks }) => {
		const events = [{ type: "message_start", message: assistant([]) }];
		const content = [];
		const push = (type, index, extra = {}) => {
			const message = assistant(content.map((part) => ({ ...part })));
			events.push({
				type: "message_update",
				message,
				assistantMessageEvent: { type, contentIndex: index, partial: message, ...extra },
			});
		};
		for (const [index, spec] of blocks.entries()) {
			content.push(block(spec.kind, ""));
			push(`${spec.kind}_start`, index);
			content[index][spec.kind] = spec.text;
			if (spec.thinkingSignature) content[index].thinkingSignature = spec.thinkingSignature;
			if (!spec.endOnly) push(`${spec.kind}_delta`, index, { delta: spec.text });
			if (!spec.cut) push(`${spec.kind}_end`, index, { content: spec.text });
		}
		const final = assistant(content.map((part) => ({ ...part })));
		events.push(
			{
				type: "message_update",
				message: final,
				assistantMessageEvent: { type: "done", reason: "stop", message: final },
			},
			{ type: "message_end", message: final },
			{ type: "agent_end", messages: [final] },
		);
		return { label, blocks, cap, events, final, secret };
	});
}
