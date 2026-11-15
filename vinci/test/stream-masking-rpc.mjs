// Mask streamed output consistently: `--mode rpc` through the production runRpcMode, in process. The session
// is a stand-in whose listener the test drives; stdin is a stream the test ends (the exit path); every
// string written to stdout is recorded. Secret values are synthetic and built at runtime.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertMasked,
	assertNoSecretBytes,
	assistant,
	block,
	cutPoints,
	cutToolCalls,
	deltasOf,
	finalEventsOf,
	fragmentsOf,
	heldWindows,
	inlineToken,
	multiLineArguments,
	multiLineToolCalls,
	PLACEHOLDER,
	partialArgumentTexts,
	secretRuns,
	splitAcross,
	streamEvents,
	toolCallEvents,
	toolNameSynonyms,
	withSourceEnd,
} from "./lib/stream-masking-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../../packages");
const { runRpcMode } = await import(resolve(packages, "coding-agent/src/modes/rpc/rpc-mode.ts"));
const { serializeJsonLine } = await import(resolve(packages, "coding-agent/src/modes/rpc/jsonl.ts"));
const { vinciMaskJson, vinciMaskSecrets } = await import(resolve(packages, "coding-agent/src/core/vinci-mask-secrets.ts"));
const { waitForRawStdoutBackpressure } = await import(resolve(packages, "coding-agent/src/core/output-guard.ts"));
const { RpcProcessInstance } = await import(resolve(packages, "orchestrator/src/rpc-process.ts"));
const { vinciMaskViewEvent, vinciMaskViewMessage, vinciOverMaskHeldValue } = await import(resolve(packages, "coding-agent/src/core/vinci-stream-mask.ts"));

// One capturing writer for the whole file: the RPC mode binds its raw stdout writer to it on first use.
const realWrite = process.stdout.write;
let capture;
function capturingWrite(chunk, encodingOrCallback, callback) {
	if (typeof chunk !== "string" || !capture) return realWrite.call(process.stdout, chunk, encodingOrCallback, callback);
	capture.push(chunk);
	const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	done?.();
	return true;
}
process.stdout.write = capturingWrite;
const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");

const bounded = (promise, ms, what) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new assert.AssertionError({ message: `${what} within ${ms}ms` })), ms)),
	]);

/**
 * Run runRpcMode, feed `events` to the session listener, then run `during(ctx)` (with `ctx.stdout()`,
 * `ctx.rebind()` and `ctx.send(command)`, which resolves with the command's response), then end stdin (the
 * RPC exit path) and wait for process.exit. `signal`: deliver SIGTERM to the mode's handler instead of
 * ending stdin. `state` stands in for the session's messages and bash result. Returns every stdout line
 * and `atExit`, what had reached stdout when process.exit was called.
 */
async function runRpc(events, { masking = true, during, state = {}, signal = false } = {}) {
	const saved = process.env.VINCI_CODE;
	if (masking) process.env.VINCI_CODE = "1";
	else delete process.env.VINCI_CODE;
	const stdin = new PassThrough();
	Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
	const realExit = process.exit;
	let exitCode;
	let atExit;
	const exited = new Promise((resolveExit) => {
		process.exit = (code) => {
			exitCode = code ?? 0;
			atExit = capture?.join("");
			resolveExit();
		};
	});
	const signalHandlersBefore = process.listeners("SIGTERM");
	let listener;
	const session = {
		bindExtensions: async () => {},
		subscribe(fn) {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
		agent: { subscribe: () => () => {}, waitForIdle: async () => {} },
		get messages() {
			return state.messages ?? [];
		},
		getLastAssistantText: () => state.lastAssistantText,
		executeBash: async () => state.bash,
		get sessionManager() {
			return state.sessionManager;
		},
	};
	let rebind;
	const host = {
		session,
		setRebindSession(fn) {
			rebind = fn;
		},
		dispose: async () => {},
	};
	capture = [];
	try {
		void runRpcMode(host);
		// The mode replaced stdout.write with its redirect; its raw writer is bound to capturingWrite.
		process.stdout.write = capturingWrite;
		for (let i = 0; i < 1000 && !listener; i++) await new Promise((r) => setImmediate(r));
		assert.ok(listener, "the RPC mode subscribed to the session");
		for (const event of events) listener(event);
		if (during) {
			let nextId = 0;
			const send = async (command) => {
				const id = `q${++nextId}`;
				stdin.write(`${JSON.stringify({ ...command, id })}\n`);
				for (let i = 0; i < 1000; i++) {
					const line = capture
						.join("")
						.split("\n")
						.find((candidate) => candidate.includes(`"id":"${id}"`));
					if (line) return { line, response: JSON.parse(line) };
					await new Promise((r) => setImmediate(r));
				}
				throw new assert.AssertionError({ message: `a response to ${command.type} within 1000 turns` });
			};
			await during({ stdout: () => capture.join(""), rebind: () => rebind(), send });
		}
		if (signal) {
			const handler = process.listeners("SIGTERM").find((candidate) => !signalHandlersBefore.includes(candidate));
			assert.ok(handler, "the RPC mode registered its SIGTERM handler");
			handler();
		} else {
			stdin.end();
		}
		await bounded(exited, 5000, "the RPC mode exits");
		const stdout = capture.join("");
		return {
			stdout,
			exitCode,
			atExit,
			events: stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		};
	} finally {
		capture = undefined;
		process.stdout.write = capturingWrite;
		process.exit = realExit;
		Object.defineProperty(process, "stdin", stdinDescriptor);
		if (saved === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = saved;
	}
}

const parseLines = (stdout) =>
	stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

const fieldOf = (message, kind = "text") => message.content.find((part) => part.type === kind)?.[kind];

for (const [name, run] of Object.entries(secretRuns())) {
	test(`rpc: ${name}, streamed one line per update, never reaches stdout; the placeholder does`, async () => {
		const { events } = streamEvents(["Here it is:", ...run.lines, "That is all."]);
		const out = await runRpc(events);
		assertMasked(out.stdout, run.secret, name);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(deltasOf(out.events), fieldOf(end.message), "the deltas add up to the message_end text");
		assert.ok(fieldOf(end.message).includes(PLACEHOLDER), "message_end holds the placeholder");
	});
}

test("rpc: a thinking block holds back and masks the same way", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const { events } = streamEvents(["Thinking it over:", ...run.lines, "Done."], { kind: "thinking" });
	const out = await runRpc(events);
	assertMasked(out.stdout, run.secret, "thinking");
	const end = out.events.find((event) => event.type === "message_end");
	assert.equal(deltasOf(out.events, "thinking"), fieldOf(end.message, "thinking"));
});

test("rpc: an aborted answer (message_end, no text_end) flushes the held run masked", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, stopReason: "aborted" });
	const out = await runRpc(events);
	assertMasked(out.stdout, run.secret, "abort");
	const endIndex = out.events.findIndex((event) => event.type === "message_end");
	assert.ok(endIndex > 0, "message_end is written");
	assert.equal(deltasOf(out.events.slice(0, endIndex - 1)), "Here it is:", "the run is held while it may still change");
	const flushed = out.events[endIndex - 1];
	assert.equal(flushed.type, "message_update", "a flushed delta precedes message_end");
	assert.ok(flushed.assistantMessageEvent.delta.includes(PLACEHOLDER), "the flushed delta is masked");
	assert.equal(deltasOf(out.events), fieldOf(out.events[endIndex].message));
});

test("rpc: the exit path (stdin ends mid-answer) writes the held run masked before exit", async () => {
	// The base64 run ends in run characters, so it is still held when stdin ends.
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	const out = await runRpc(events);
	assert.equal(out.exitCode, 0);
	assertMasked(out.stdout, run.secret, "exit");
	const last = out.events.at(-1);
	assert.equal(last.type, "message_update", "the flushed delta is the last line written");
	assert.ok(last.assistantMessageEvent.delta.includes(PLACEHOLDER), "the flushed delta is masked");
	assert.equal(deltasOf(out.events), fieldOf(last.message), "the deltas add up to the released text");
});

test("rpc: built-in tool arguments and output are masked, as the view masks them", async () => {
	const token = inlineToken();
	const command = `curl -H "Authorization: Bearer ${token}" localhost`;
	const output = `TOKEN=${token}\nok.`;
	const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command } };
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp: 1,
	};
	const editResult = {
		content: [{ type: "text", text: "Edited." }],
		details: { diff: `+1 API_KEY=${token}` },
	};
	const events = [
		{ type: "message_start", message: assistant([]) },
		{ type: "message_end", message: assistant([call], "toolUse") },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command } },
		{
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command },
			partialResult: { content: [{ type: "text", text: output }] },
		},
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: toolResult.content }, isError: false },
		{ type: "message_start", message: toolResult },
		{ type: "message_end", message: toolResult },
		{ type: "tool_execution_end", toolCallId: "call-2", toolName: "edit", result: editResult, isError: false },
	];
	const out = await runRpc(events);
	assert.ok(!out.stdout.includes(token.slice(4)), "no tool argument or output carries the token");
	assert.equal(out.events.length, events.length, "one line per event");
	// Every line but the empty message_start carries a masked value.
	for (const event of out.events.slice(1)) {
		assert.ok(JSON.stringify(event).includes(PLACEHOLDER), `${event.type} holds the placeholder`);
	}
});

test("rpc: what the view leaves unmasked passes through unchanged (user text, other tools' output)", async () => {
	const token = inlineToken();
	const user = { role: "user", content: [{ type: "text", text: `my value is ${token}` }], timestamp: 1 };
	const events = [
		{ type: "message_start", message: user },
		{ type: "message_end", message: user },
		{
			type: "tool_execution_end",
			toolCallId: "call-3",
			toolName: "extension_tool",
			result: { content: [{ type: "text", text: `value ${token}` }] },
			isError: false,
		},
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: `failed for ${token}` },
	];
	const out = await runRpc(events);
	assert.equal(out.stdout, events.map((event) => serializeJsonLine(event)).join(""), "byte-identical");
});

test("rpc idempotence through outputEvent: already-masked text comes out unchanged", async () => {
	const values = Object.entries(secretRuns()).map(([name, run]) => [name, ["Here it is:", ...run.lines, "That is all."]]);
	values.push(["a single-line value", [`TOKEN=${inlineToken()}`]]);
	for (const [name, lines] of values) {
		const masked = vinciMaskSecrets(lines.map((line) => `${line}\n`).join(""));
		assert.ok(masked.includes(PLACEHOLDER), `${name}: fixture sanity: masked once`);
		const { events } = streamEvents(masked.split("\n").slice(0, -1));
		const out = await runRpc(events);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(fieldOf(end.message), masked, `${name}: message_end is unchanged`);
		assert.equal(deltasOf(out.events), masked, `${name}: the deltas are unchanged`);
	}
});

test("rpc positive control: the orchestrator client gets the child's non-secret text byte-identical", async () => {
	const lines = ["First line.", "Second line, with a comma;", "A line without an ending", "Last (really)."];
	const { events, text } = streamEvents(lines);
	const out = await runRpc(events);
	// Feed the recorded stdout through the orchestrator's RpcProcessInstance line reader.
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr = new EventEmitter();
	child.stderr.setEncoding = () => {};
	const client = Object.create(RpcProcessInstance.prototype);
	Object.assign(client, {
		process: child,
		exited: false,
		nextRequestId: 0,
		stdoutBuffer: "",
		stderrBuffer: "",
		pendingRequests: new Map(),
		eventListeners: new Set(),
		exitListeners: new Set(),
	});
	client.attachListeners();
	const received = [];
	client.onEvent((event) => received.push(event));
	for (let i = 0; i < out.stdout.length; i += 7) child.stdout.emit("data", out.stdout.slice(i, i + 7));
	assert.equal(received.length, out.events.length, "every line reached the client");
	assert.equal(deltasOf(received), text, "the deltas add up to the raw text");
	const end = received.find((event) => event.type === "message_end");
	assert.equal(fieldOf(end.message), text, "message_end carries the raw text");
	assert.ok(!out.stdout.includes(PLACEHOLDER));
});

test("rpc with masking off: the stream is byte-identical to the events", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines, "That is all."]);
	const out = await runRpc(events, { masking: false });
	assert.equal(out.stdout, events.map((event) => serializeJsonLine(event)).join(""));
});

test("rpc: a rebind writes the held run masked at once", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	let afterRebind;
	await runRpc(events, {
		during: async ({ stdout, rebind }) => {
			await waitForRawStdoutBackpressure();
			assert.ok(stdout().includes("Here it is:"), "the stream so far is written");
			assert.ok(!deltasOf(parseLines(stdout())).includes(PLACEHOLDER), "held before the rebind");
			await rebind();
			// Let the queued writes land; nothing else writes until the stream ends.
			await waitForRawStdoutBackpressure();
			afterRebind = stdout();
		},
	});
	assertMasked(afterRebind, run.secret, "rebind");
	assert.ok(deltasOf(parseLines(afterRebind)).includes(PLACEHOLDER), "the rebind flush wrote the held run, masked");
});

// Masking consistency for streamed tool arguments: the tools whose arguments the view masks.
for (const [label, step] of [
	["case 1", 0],
	["case 2", 9],
]) {
	test(`rpc: masking consistency for streamed tool arguments, single-line value (${label})`, async () => {
		const token = inlineToken();
		const json = JSON.stringify({ command: `echo ${token}` });
		const fragments = splitAcross(json, token, step);
		assert.ok(fragments.length >= (step ? 3 : 2), "fixture sanity: the value spans the fragments");
		const { events } = toolCallEvents("bash", fragments);
		const out = await runRpc(events);
		assertMasked(deltasOf(out.events, "toolcall"), [token], "concatenated deltas");
		assertMasked(out.stdout, [token], "whole stdout");
	});
}

test("rpc positive control: non-secret bash arguments arrive byte-identical once the deltas are joined", async () => {
	const json = JSON.stringify({ command: "ls -la src/components", timeout: 30 });
	const { events } = toolCallEvents("bash", [json.slice(0, 7), json.slice(7, 19), json.slice(19)]);
	const out = await runRpc(events);
	assert.equal(deltasOf(out.events, "toolcall"), json, "the joined deltas equal the raw argument text");
	const end = out.events.find((event) => event.type === "message_end");
	assert.deepEqual(end.message.content[0].arguments, JSON.parse(json));
});

test("rpc: a tool the view does not mask passes its argument deltas through unchanged, as the view does", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const { events } = toolCallEvents("extension_tool", splitAcross(json, token, 0));
	const out = await runRpc(events);
	assert.equal(out.stdout, events.map((event) => serializeJsonLine(event)).join(""), "byte-identical");
});

const toolFragment = 9;
const multiLineCases = () =>
	Object.values(secretRuns()).flatMap((run, n) =>
		Object.entries(multiLineToolCalls(run.lines)).map(([tool, args]) => ({ label: `${tool}, case ${n + 1}`, tool, args, secret: run.secret })),
	);

for (const { label, tool, args, secret } of multiLineCases()) {
	test(`rpc: masking consistency for streamed tool arguments, multi-line value (${label})`, async () => {
		const json = JSON.stringify(args);
		const { events } = toolCallEvents(tool, fragmentsOf(json, toolFragment));
		const out = await runRpc(events);
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, secret, "joined deltas");
		assertNoSecretBytes(partialArgumentTexts(out.events).join("\n"), secret, "partial argument text");
		assertMasked(out.stdout, secret, "whole stdout");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "the release is the masked JSON of the parsed arguments");
		const released = out.events.filter((event) => event.assistantMessageEvent?.type === "toolcall_delta" && event.assistantMessageEvent.delta);
		assert.equal(released.length, 1, "one release, at the call's end");
		for (const text of partialArgumentTexts(out.events)) assert.ok(text === "" || text === deltas, "partial argument text is empty or the released text");
		const end = out.events.find((event) => event.type === "message_end");
		assert.deepEqual(end.message.content[0].arguments, vinciMaskJson(args), "message_end arguments are masked as before");
	});
}

// A built-in tool call that ends without its toolcall_end, on every path: none of its held argument text.
function interruptedCall({ ending = "none", stopReason, partialOnEnd = false } = {}) {
	const run = secretRuns()["a multi-line base64 secret"];
	const args = multiLineToolCalls(run.lines).write;
	const json = JSON.stringify(args);
	const cut = json.indexOf(run.lines[Math.floor(run.lines.length / 2)]) + 5;
	const { events } = toolCallEvents("write", fragmentsOf(json.slice(0, cut), toolFragment), { ending, stopReason, partialOnEnd });
	return { events, secret: run.secret };
}

/** The interrupted call released only the placeholder, and no streamed event carries its argument bytes. */
function assertInterrupted(events, secret, where) {
	assert.equal(deltasOf(events, "toolcall"), PLACEHOLDER, `${where}: only the placeholder is released`);
	assertNoSecretBytes(partialArgumentTexts(events).join("\n"), secret, `${where}: partial argument text`);
	const streamed = events.filter((event) => event.type !== "message_end" && event.type !== "agent_end" && event.type !== "turn_end");
	assertNoSecretBytes(JSON.stringify(streamed), secret, `${where}: streamed events`);
}

for (const [label, stopReason, partialOnEnd] of [
	["an abort", "aborted", true],
	["an error", "error", false],
	["a stream that ends", "stop", false],
]) {
	test(`rpc: masking consistency for streamed tool arguments, a call cut by ${label} (message_end only)`, async () => {
		const { events, secret } = interruptedCall({ ending: "message_end", stopReason, partialOnEnd });
		const out = await runRpc(events);
		assertInterrupted(out.events, secret, label);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(end.message.stopReason, stopReason);
		assert.deepEqual(partialArgumentTexts([end]), partialOnEnd ? [PLACEHOLDER] : [], "message_end carries only the released text");
	});
}

test("rpc: masking consistency for streamed tool arguments, a call cut by agent_end", async () => {
	const { events, secret } = interruptedCall();
	events.push({ type: "agent_end", messages: [] });
	const out = await runRpc(events);
	assertInterrupted(out.events, secret, "agent_end");
	assertMasked(out.stdout, secret, "agent_end: whole stdout");
	const agentEnd = out.events.findIndex((event) => event.type === "agent_end");
	assert.equal(deltasOf(out.events.slice(0, agentEnd), "toolcall"), PLACEHOLDER, "released before agent_end");
});

test("rpc: masking consistency for streamed tool arguments, a call cut by the exit path", async () => {
	const { events, secret } = interruptedCall();
	const out = await runRpc(events);
	assert.equal(out.exitCode, 0);
	assertInterrupted(parseLines(out.atExit), secret, "exit");
	assertMasked(out.atExit, secret, "exit: written before exit");
});

test("rpc: masking consistency for streamed tool arguments, a call cut by SIGTERM", async () => {
	const { events, secret } = interruptedCall();
	const out = await runRpc(events, { signal: true });
	assert.equal(out.exitCode, 143);
	assertInterrupted(parseLines(out.atExit), secret, "SIGTERM");
	assertMasked(out.atExit, secret, "SIGTERM: written before exit");
});

test("rpc: masking consistency for streamed tool arguments, a call cut by a rebind", async () => {
	const { events, secret } = interruptedCall();
	let afterRebind;
	await runRpc(events, {
		during: async ({ stdout, rebind }) => {
			await rebind();
			await waitForRawStdoutBackpressure();
			afterRebind = stdout();
		},
	});
	assertInterrupted(parseLines(afterRebind), secret, "rebind");
	assertMasked(afterRebind, secret, "rebind: whole stdout");
});

test("rpc: masking consistency for streamed tool arguments, a call cut by the next message_start", async () => {
	const { events, secret } = interruptedCall();
	const next = streamEvents(["Next answer."]).events;
	const out = await runRpc([...events, ...next]);
	assertInterrupted(out.events, secret, "message_start");
	assertMasked(out.stdout, secret, "message_start: whole stdout");
	const starts = out.events.flatMap((event, index) => (event.type === "message_start" ? [index] : []));
	assert.equal(deltasOf(out.events.slice(0, starts[1]), "toolcall"), PLACEHOLDER, "released before the next message_start");
});

test("rpc: masking consistency for streamed tool arguments, a complete call with no toolcall_end releases its masked parse", async () => {
	const run = secretRuns()["an END-only private-key body"];
	const args = multiLineToolCalls(run.lines).bash;
	const json = JSON.stringify(args);
	const { events } = toolCallEvents("bash", fragmentsOf(json, toolFragment), { ending: "message_end", stopReason: "aborted" });
	const out = await runRpc(events);
	assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(args)));
	assertMasked(out.stdout, run.secret, "whole stdout");
});

test("rpc: SIGTERM mid-answer writes the held run masked and lets stdout drain before exit", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	const out = await runRpc(events, { signal: true });
	assert.equal(out.exitCode, 143);
	assertMasked(out.atExit, run.secret, "SIGTERM: written before exit");
	const last = parseLines(out.atExit).at(-1);
	assert.equal(last?.type, "message_update", "the flushed delta reached stdout before exit");
	assert.ok(last.assistantMessageEvent.delta.includes(PLACEHOLDER), "the flushed delta is masked");
});

// RPC command responses carry the text the event path masks: masked the same way.
function responseState() {
	const token = inlineToken();
	const run = secretRuns()["a multi-line base64 secret"];
	const text = ["Here it is:", ...run.lines, "That is all."].join("\n");
	const assistantMessage = assistant([
		block("text", text),
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: `echo ${token}` } },
	]);
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: `TOKEN=${token}\nok.` }],
		isError: false,
		timestamp: 1,
	};
	return { token, run, text, assistantMessage, toolResult };
}

test("rpc get_messages: assistant text, built-in tool arguments and results are masked, as the view masks them", async () => {
	const { token, run, assistantMessage, toolResult } = responseState();
	let line;
	await runRpc([], {
		state: { messages: [assistantMessage, toolResult] },
		during: async ({ send }) => {
			({ line } = await send({ type: "get_messages" }));
		},
	});
	assertMasked(line, run.secret, "get_messages");
	assertMasked(line, [token], "get_messages");
});

test("rpc get_last_assistant_text: the text is masked, as the view masks it", async () => {
	const { run, text } = responseState();
	let response;
	let line;
	await runRpc([], {
		state: { lastAssistantText: text },
		during: async ({ send }) => {
			({ line, response } = await send({ type: "get_last_assistant_text" }));
		},
	});
	assertMasked(line, run.secret, "get_last_assistant_text");
	assert.equal(response.data.text, vinciMaskSecrets(text));
});

test("rpc responses: what the view leaves unmasked stays raw (user text, user shell commands and their output)", async () => {
	const token = inlineToken();
	const user = { role: "user", content: [{ type: "text", text: `my value is ${token}` }], timestamp: 1 };
	const shell = { role: "bashExecution", command: `echo ${token}`, output: `${token}\n`, exitCode: 0, cancelled: false, truncated: false, timestamp: 1 };
	const bash = { output: `TOKEN=${token}\n`, exitCode: 0, cancelled: false, truncated: false };
	const got = {};
	await runRpc([], {
		state: { messages: [user, shell], bash },
		during: async ({ send }) => {
			got.messages = (await send({ type: "get_messages" })).response.data.messages;
			got.bash = (await send({ type: "bash", command: "true" })).response.data;
		},
	});
	assert.deepEqual(got.messages, [user, shell], "user messages and user shell commands are unchanged");
	assert.deepEqual(got.bash, bash, "the bash command response is unchanged");
});

test("rpc responses with masking off: byte-identical data", async () => {
	const { assistantMessage, toolResult, text } = responseState();
	const bash = { output: "plain\n", exitCode: 0, cancelled: false, truncated: false };
	const lines = [];
	await runRpc([], {
		masking: false,
		state: { messages: [assistantMessage, toolResult], lastAssistantText: text, bash },
		during: async ({ send }) => {
			for (const type of ["get_messages", "get_last_assistant_text", "bash"]) lines.push((await send({ type, command: "true" })).line);
		},
	});
	assert.equal(lines[0], serializeJsonLine({ id: "q1", type: "response", command: "get_messages", success: true, data: { messages: [assistantMessage, toolResult] } }).trimEnd());
	assert.equal(lines[1], serializeJsonLine({ id: "q2", type: "response", command: "get_last_assistant_text", success: true, data: { text } }).trimEnd());
	assert.equal(lines[2], serializeJsonLine({ id: "q3", type: "response", command: "bash", success: true, data: bash }).trimEnd());
});

test("rpc positive control: the orchestrator client gets a masked response's non-secret text byte-identical", async () => {
	const text = "First line.\nSecond line, with a comma;\nLast (really).\n";
	const message = assistant([block("text", text), { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls -la" } }]);
	let line;
	await runRpc([], {
		state: { messages: [message] },
		during: async ({ send }) => {
			({ line } = await send({ type: "get_messages" }));
		},
	});
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr = new EventEmitter();
	child.stderr.setEncoding = () => {};
	child.stdin = { write: (_line, done) => done?.() };
	const client = Object.create(RpcProcessInstance.prototype);
	Object.assign(client, {
		process: child,
		exited: false,
		nextRequestId: 0,
		stdoutBuffer: "",
		stderrBuffer: "",
		pendingRequests: new Map(),
		eventListeners: new Set(),
		exitListeners: new Set(),
	});
	client.attachListeners();
	const pending = client.send({ type: "get_messages", id: "q1" });
	child.stdout.emit("data", `${line}\n`);
	const response = await bounded(pending, 2000, "the orchestrator client resolves the response");
	assert.deepEqual(response.data.messages, [message], "byte-identical once parsed");
	assert.ok(!line.includes(PLACEHOLDER));
});

test("rpc: masking consistency for streamed tool arguments, multi-line argument text", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ command: `echo ${token}`, note: "x" }, null, 2);
	const fragments = json.split(/(?<=\n)/);
	assert.ok(fragments.length >= 3, "fixture sanity: several lines");
	const { events } = toolCallEvents("bash", fragments);
	const out = await runRpc(events);
	assertMasked(deltasOf(out.events, "toolcall"), [token], "concatenated deltas");
	assertMasked(out.stdout, [token], "whole stdout");
});

// get_entries and get_tree hand back the same session messages get_messages does: masked in the same scope,
// with ids, parent ids, timestamps, labels and the tree's shape unchanged.
function entriesState() {
	const { token, run, assistantMessage, toolResult } = responseState();
	const plain = assistant([block("text", "Plain answer, nothing to hide.\n")]);
	const user = { role: "user", content: [{ type: "text", text: `my value is ${token}` }], timestamp: 1 };
	const at = (n) => `2026-01-01T00:00:0${n}.000Z`;
	const entries = [
		{ type: "message", id: "e1", parentId: null, timestamp: at(1), message: user },
		{ type: "message", id: "e2", parentId: "e1", timestamp: at(2), message: assistantMessage },
		{ type: "message", id: "e3", parentId: "e2", timestamp: at(3), message: toolResult },
		{ type: "message", id: "e4", parentId: "e3", timestamp: at(4), message: plain },
		{ type: "compaction", id: "e5", parentId: "e4", timestamp: at(5), summary: `kept ${token}`, firstKeptEntryId: "e4", tokensBefore: 10 },
		{ type: "custom", id: "e6", parentId: "e5", timestamp: at(6), customType: "test-note", data: { note: `saw ${token}` } },
		{ type: "label", id: "e7", parentId: "e6", timestamp: at(7), targetId: "e2", label: "checkpoint" },
		{ type: "message", id: "e8", parentId: "e1", timestamp: at(8), message: assistantMessage },
	];
	const node = (index, children = [], extra = {}) => ({ entry: entries[index], children, ...extra });
	const tree = [
		node(0, [
			node(1, [node(2, [node(3, [node(4, [node(5, [node(6)])])])])], { label: "checkpoint", labelTimestamp: at(7) }),
			node(7),
		]),
	];
	const sessionManager = { getEntries: () => entries, getTree: () => tree, getLeafId: () => "e7" };
	// Entries the view masks (assistant text, built-in tool arguments and results) and those it leaves raw.
	return { token, run, entries, tree, sessionManager, masked: [1, 2, 7], raw: [0, 3, 4, 5, 6] };
}

const shapeOf = (entry) => ({ type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp });

function assertEntries(got, state, where) {
	assert.deepEqual(got.map(shapeOf), state.entries.map(shapeOf), `${where}: ids, parent ids and timestamps unchanged`);
	for (const index of state.masked) {
		const text = JSON.stringify(got[index]);
		assertMasked(text, [state.token], `${where}: entry ${state.entries[index].id}`);
		assert.deepEqual(Object.keys(got[index]), Object.keys(state.entries[index]), `${where}: entry keys unchanged`);
	}
	assertMasked(JSON.stringify(got[1]), state.run.secret, `${where}: assistant text`);
	for (const index of state.raw) {
		assert.deepEqual(got[index], state.entries[index], `${where}: entry ${state.entries[index].id} is unchanged`);
	}
}

test("rpc get_entries: message entries are masked like get_messages; ids, structure and the since cursor are unchanged", async () => {
	const state = entriesState();
	const got = {};
	await runRpc([], {
		state: { sessionManager: state.sessionManager },
		during: async ({ send }) => {
			got.all = await send({ type: "get_entries" });
			got.since = await send({ type: "get_entries", since: "e4" });
		},
	});
	assertMasked(got.all.line, state.run.secret, "get_entries");
	assertEntries(got.all.response.data.entries, state, "get_entries");
	assert.equal(got.all.response.data.leafId, "e7");
	assert.deepEqual(
		got.since.response.data.entries.map((entry) => entry.id),
		["e5", "e6", "e7", "e8"],
		"the since cursor works on the raw ids",
	);
	assertMasked(JSON.stringify(got.since.response.data.entries[3]), [state.token], "get_entries since: entry e8");
});

test("rpc get_tree: each node's entry is masked like get_messages; nodes, children and labels are unchanged", async () => {
	const state = entriesState();
	const before = JSON.stringify(state.tree);
	let line;
	let response;
	await runRpc([], {
		state: { sessionManager: state.sessionManager },
		during: async ({ send }) => {
			({ line, response } = await send({ type: "get_tree" }));
		},
	});
	assertMasked(line, state.run.secret, "get_tree");
	assert.equal(JSON.stringify(state.tree), before, "the session's own tree is not modified");
	const flat = [];
	const walk = (got, raw, path) => {
		assert.equal(got.length, raw.length, `get_tree ${path}: same number of children`);
		got.forEach((node, i) => {
			assert.deepEqual(Object.keys(node), Object.keys(raw[i]), `get_tree ${path}/${i}: node keys unchanged`);
			assert.equal(node.label, raw[i].label, `get_tree ${path}/${i}: label unchanged`);
			assert.equal(node.labelTimestamp, raw[i].labelTimestamp, `get_tree ${path}/${i}: label time unchanged`);
			flat.push(node.entry);
			walk(node.children, raw[i].children, `${path}/${i}`);
		});
	};
	walk(response.data.tree, state.tree, "root");
	const order = flat.map((entry) => entry.id);
	assert.deepEqual(order, ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"], "depth-first order unchanged");
	assertEntries(flat, state, "get_tree");
	assert.equal(response.data.leafId, "e7");
});

test("rpc get_entries and get_tree with masking off: byte-identical data", async () => {
	const state = entriesState();
	const lines = [];
	await runRpc([], {
		masking: false,
		state: { sessionManager: state.sessionManager },
		during: async ({ send }) => {
			lines.push((await send({ type: "get_entries" })).line);
			lines.push((await send({ type: "get_tree" })).line);
		},
	});
	const data = [
		{ entries: state.entries, leafId: "e7" },
		{ tree: state.tree, leafId: "e7" },
	];
	assert.equal(lines[0], serializeJsonLine({ id: "q1", type: "response", command: "get_entries", success: true, data: data[0] }).trimEnd());
	assert.equal(lines[1], serializeJsonLine({ id: "q2", type: "response", command: "get_tree", success: true, data: data[1] }).trimEnd());
});

// Interrupted calls: in the final events (message_end, turn_end, agent_end) and in the transcript responses
// (get_messages, get_entries, get_tree) each argument value keeps only the lines the hold-back would have
// released; from the first held line to the value's end it is the placeholder.
const hasStringValue = (value) =>
	typeof value === "string" ? value !== "" : value && typeof value === "object" ? Object.values(value).some(hasStringValue) : false;

/** The transcript of one assistant message, as the session manager hands it back. */
function transcriptState(message) {
	const entry = { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message };
	const sessionManager = { getEntries: () => [entry], getTree: () => [{ entry, children: [] }], getLeafId: () => "e1" };
	return { messages: [message], sessionManager };
}

/** Run the call's events, then ask for the transcript three ways; the final events and the three response lines. */
async function interruptedRun(events, final) {
	const got = {};
	const out = await runRpc(events, {
		state: transcriptState(final),
		during: async ({ send }) => {
			for (const type of ["get_messages", "get_entries", "get_tree"]) got[type] = (await send({ type })).line;
		},
	});
	return { finals: finalEventsOf(out.events), responses: got, out };
}

for (const { label, tool, args, secret } of multiLineCases()) {
	test(`rpc: masking consistency for streamed tool arguments, an interrupted call's final events and transcript carry none of its held lines (${label})`, async () => {
		const json = JSON.stringify(args);
		let carried = 0;
		for (const cut of cutPoints(json, secret)) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json.slice(0, cut), toolFragment), { ending: "message_end", finals: true });
			const raw = JSON.stringify(final);
			if (secret.some((line) => raw.includes(line.slice(0, 12)))) carried++;
			const { finals, responses } = await interruptedRun(events, final);
			assert.equal(finals.length, 3, `cut ${cut}: message_end, turn_end and agent_end are written`);
			const placeholder = hasStringValue(final.content[0].arguments);
			for (const [where, text] of [["final events", JSON.stringify(finals)], ...Object.entries(responses)]) {
				assertNoSecretBytes(text, secret, `cut ${cut}: ${where}`);
				if (placeholder) assert.ok(text.includes(PLACEHOLDER), `cut ${cut}: ${where}: the placeholder is written`);
			}
		}
		assert.ok(carried > 0, "fixture sanity: the raw final arguments carry secret lines");
	});
}

test("rpc: masking consistency for streamed tool arguments, no raw held argument text reaches an interrupted call's final events or transcript", async () => {
	for (const { label, tool, args, secret } of multiLineCases()) {
		const json = JSON.stringify(args);
		for (const cut of cutPoints(json, secret)) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json.slice(0, cut), toolFragment), { ending: "message_end", finals: true });
			const { finals, responses } = await interruptedRun(events, final);
			const text = [JSON.stringify(finals), ...Object.values(responses)].join("\n");
			for (const window of heldWindows(json, secret, cut)) {
				assert.ok(!text.includes(window), `${label}, cut ${cut}: raw held text ${JSON.stringify(window)} reached a final event or response`);
			}
		}
	}
});

test("rpc positive control: a completed call's final events and transcript are masked exactly as before", async () => {
	for (const { label, tool, args } of multiLineCases()) {
		const { events, final } = toolCallEvents(tool, fragmentsOf(JSON.stringify(args), toolFragment), { finals: true });
		const { responses, out } = await interruptedRun(events, final);
		const lines = out.stdout.split("\n").filter((line) => /^\{"type":"(message_end|turn_end|agent_end)"/.test(line));
		assert.deepEqual(
			lines.map((line) => `${line}\n`),
			finalEventsOf(events).map((event) => serializeJsonLine(vinciMaskViewEvent(event))),
			`${label}: final events byte-identical to the view-masked events`,
		);
		assert.deepEqual(JSON.parse(responses.get_messages).data.messages, [vinciMaskViewMessage(final)], `${label}: get_messages as before`);
		const toolcallEnd = out.events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
		assert.deepEqual(toolcallEnd?.assistantMessageEvent?.toolCall?.arguments, vinciMaskJson(args), `${label}: toolcall_end arguments masked once`);
		for (const event of finalEventsOf(out.events)) {
			const message = event.type === "agent_end" ? event.messages?.[0] : event.message;
			assert.deepEqual(message?.content?.[0]?.arguments, vinciMaskJson(args), `${label}: ${event.type} arguments masked once`);
		}
		assert.deepEqual(JSON.parse(responses.get_messages)?.data?.messages?.[0]?.content?.[0]?.arguments, vinciMaskJson(args), `${label}: get_messages arguments masked once`);
		assert.deepEqual(partialArgumentTexts(finalEventsOf(out.events)), [], `${label}: no partial argument text in the final events`);
	}
});

// A completed built-in call whose toolcall_end call, partial and final message keep the raw partial argument
// text (a provider or extension that keeps its streaming buffer): that text is the masked JSON of the
// arguments in the streamed events, the final events and the transcript responses.
const toolcallEndAndFinals = (events) => [
	...events.filter((event) => event.assistantMessageEvent?.type === "toolcall_end"),
	...finalEventsOf(events),
];
const eventName = (event) => event?.assistantMessageEvent?.type ?? event?.type;

for (const field of ["partialJson", "partialArgs"]) {
	test(`rpc: masking consistency for streamed tool arguments, a completed call that keeps its partial argument text (${field})`, async () => {
		for (const { label, tool, args, secret } of multiLineCases()) {
			const json = JSON.stringify(args);
			const { events, final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { finals: true, field, keepPartialOnEnd: true });
			assert.equal(final?.content?.[0]?.[field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(finalEventsOf(events)).includes(line.slice(0, 12))), `${label}: fixture sanity: the raw final carries secret bytes`);
			const { responses, out } = await interruptedRun(events, final);
			const masked = JSON.stringify(vinciMaskJson(args));
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
			const ends = toolcallEndAndFinals(out.events);
			assert.deepEqual(ends.map(eventName), ["toolcall_end", "message_end", "turn_end", "agent_end"], `${label}: the end events are written`);
			assert.equal(ends[0]?.assistantMessageEvent?.toolCall?.[field], masked, `${label}: the toolcall_end call's ${field} is the masked JSON of the arguments`);
			const shown = [...ends.map((event) => [eventName(event), event]), ...Object.entries(responses).map(([type, line]) => [type, JSON.parse(line)])];
			for (const [where, value] of shown) {
				const texts = partialArgumentTexts([value]);
				assert.ok(texts.length > 0, `${label}: ${where}: ${field} is there`);
				for (const text of texts) assert.equal(text, masked, `${label}: ${where}: ${field} is the masked JSON of the arguments`);
			}
			for (const text of partialArgumentTexts(out.events)) assert.ok(text === "" || text === masked, `${label}: partial argument text is empty or the masked arguments`);
		}
	});
}

test("rpc positive control: a completed call of a tool the view does not mask keeps its partial argument text, byte-identical", async () => {
	const token = inlineToken();
	// Spaced JSON: a rewrite to the JSON of the parsed arguments would show.
	const json = `{"query": "find ${token}", "limit": 20}`;
	const { events, final } = toolCallEvents("extension_tool", splitAcross(json, token, 0), { finals: true, keepPartialOnEnd: true });
	assert.equal(final?.content?.[0]?.partialJson, json, "fixture sanity: the final message keeps the raw text");
	const out = await runRpc(events);
	assert.equal(out.stdout, events.map((event) => serializeJsonLine(event)).join(""), "byte-identical");
});

test("rpc: a built-in call's streaming partial text is unchanged by the completed-call scrub", async () => {
	for (const field of ["partialJson", "partialArgs"]) {
		for (const { label, tool, args } of multiLineCases()) {
			const { events } = toolCallEvents(tool, fragmentsOf(JSON.stringify(args), toolFragment), { field, keepPartialOnEnd: true });
			const out = await runRpc(events);
			let released = "";
			let seen = 0;
			for (const event of out.events) {
				if (event.type !== "message_update") continue;
				const source = event.assistantMessageEvent;
				if (source?.type === "toolcall_delta") released += source.delta ?? "";
				for (const message of [event.message, source?.partial]) {
					const text = message?.content?.[0]?.[field];
					if (typeof text !== "string") continue;
					seen++;
					assert.equal(text, released, `${field}, ${label}: a streaming ${field} is the text released so far`);
				}
			}
			assert.ok(seen > 0, `${field}, ${label}: fixture sanity: the streaming messages carry ${field}`);
			assert.equal(released, JSON.stringify(vinciMaskJson(args)), `${field}, ${label}: the release is the masked JSON of the arguments`);
		}
	}
});

// A tool call whose name arrives late is held like a built-in until it does.
test("rpc: masking consistency for streamed tool arguments, a built-in name that arrives late", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).write;
	const fragments = fragmentsOf(JSON.stringify(args), toolFragment);
	// The name arrives two deltas before the end: the secret run streams before it.
	const { events } = toolCallEvents("write", fragments, { nameFrom: fragments.length - 2 });
	const nameless = events.filter((event) => event.message?.content?.[0]?.name === "").map((event) => event.assistantMessageEvent.delta ?? "").join("");
	assert.ok(run.secret.every((line) => nameless.includes(line)), "fixture sanity: the secret run streams before the name");
	const out = await runRpc(events);
	const deltas = deltasOf(out.events, "toolcall");
	assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
	assertMasked(deltas, run.secret, "joined deltas");
	assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "the release is the masked JSON of the parsed arguments");
});

for (const ending of ["end", "message_end"]) {
	test(`rpc: masking consistency for streamed tool arguments, a call with no name to the end is released masked (${ending})`, async () => {
		const run = secretRuns()["a multi-line base64 secret"];
		const args = multiLineToolCalls(run.lines).write;
		const { events } = toolCallEvents(undefined, fragmentsOf(JSON.stringify(args), toolFragment), { ending, stopReason: ending === "end" ? undefined : "aborted" });
		const out = await runRpc(events);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "released as a built-in call would be");
	});
}

test("rpc positive control: a late name that names a tool the view does not mask releases the held text unchanged", async () => {
	const json = JSON.stringify({ query: "list the open files", limit: 20 });
	const { events } = toolCallEvents("extension_tool", fragmentsOf(json, 5), { nameFrom: 3 });
	const out = await runRpc(events);
	assert.equal(deltasOf(out.events, "toolcall"), json, "the joined deltas equal the raw argument text");
	const end = out.events.find((event) => event.type === "message_end");
	assert.deepEqual(end.message.content[0].arguments, JSON.parse(json));
	assert.ok(!out.stdout.includes(PLACEHOLDER));
});

for (const index of ["string", "missing"]) {
	test(`rpc: masking consistency for streamed tool arguments, a ${index} content index still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { index, before: [block("text", "Running it.\n")] });
		const out = await runRpc(events);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)));
	});
}

// A call cut by a stream-ending source event: the `done` / `error` event carries the cut call's message.
for (const kind of ["done", "error"]) {
	test(`rpc: masking consistency for streamed tool arguments, a cut call carried by a source ${kind} event`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const built = toolCallEvents(tool, fragmentsOf(json, toolFragment), { ending: "message_end", finals: true, partialOnEnd: true });
			assert.equal(built.final?.content?.[0]?.partialJson, json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(built.final).includes(line.slice(0, 12))), `${label}: fixture sanity: the cut call carries secret bytes`);
			const out = await runRpc(withSourceEnd(built.events, kind, built.final));
			const source = out.events.filter((event) => event.assistantMessageEvent?.type === kind);
			assert.equal(source.length, 1, `${label}: the ${kind} event is written`);
			assertNoSecretBytes(JSON.stringify(source[0]), secret, `${label}: the ${kind} event`);
			assert.ok(JSON.stringify(source[0]).includes(PLACEHOLDER), `${label}: the ${kind} event carries the placeholder`);
			const sourceTexts = partialArgumentTexts([source[0].assistantMessageEvent]);
			assert.ok(sourceTexts.length > 0, `${label}: the ${kind} event's message keeps its partial text`);
			for (const text of sourceTexts) assert.equal(text, PLACEHOLDER, `${label}: the ${kind} event's partial text is the placeholder`);
			const finals = finalEventsOf(out.events);
			assert.equal(finals.length, 3, `${label}: message_end, turn_end and agent_end are written`);
			for (const event of finals) assertNoSecretBytes(JSON.stringify(event), secret, `${label}: ${event.type}`);
		}
	});
}

// A completed call that keeps its partial argument text, carried by a stream-ending source event: the
// `done` / `error` event's message carries the masked JSON of the arguments, not the raw text.
for (const kind of ["done", "error"]) {
	test(`rpc: masking consistency for streamed tool arguments, a completed call that keeps its partial argument text, carried by a source ${kind} event`, async () => {
		for (const { label, tool, args, secret } of multiLineCases()) {
			const json = JSON.stringify(args);
			const built = toolCallEvents(tool, fragmentsOf(json, toolFragment), { finals: true, keepPartialOnEnd: true });
			assert.equal(built.final?.content?.[0]?.partialJson, json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(built.final).includes(line.slice(0, 12))), `${label}: fixture sanity: the raw final carries secret bytes`);
			const out = await runRpc(withSourceEnd(built.events, kind, built.final));
			const masked = JSON.stringify(vinciMaskJson(args));
			const source = out.events.filter((event) => event?.assistantMessageEvent?.type === kind);
			assert.equal(source.length, 1, `${label}: the ${kind} event is written`);
			assertNoSecretBytes(JSON.stringify(source[0]), secret, `${label}: the ${kind} event`);
			const texts = partialArgumentTexts(source);
			assert.ok(texts.length > 0, `${label}: the ${kind} event's message keeps its partialJson`);
			for (const text of texts) assert.equal(text, masked, `${label}: the ${kind} event's partialJson is the masked JSON of the arguments`);
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
		}
	});
}

// A cut call whose final message still carries its raw partial argument text: the final events and the
// transcript responses.
for (const field of ["partialJson", "partialArgs"]) {
	test(`rpc: masking consistency for streamed tool arguments, a cut call's final message that keeps its ${field}`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { ending: "message_end", finals: true, field, partialOnEnd: true });
			assert.equal(final.content[0][field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			const { finals, responses } = await interruptedRun(events, final);
			assert.deepEqual(finals.map((event) => event.type), ["message_end", "turn_end", "agent_end"], `${label}: the final events are written`);
			const shown = [...finals.map((event) => [event.type, event]), ...Object.entries(responses).map(([type, line]) => [type, JSON.parse(line)])];
			for (const [where, value] of shown) {
				assertNoSecretBytes(JSON.stringify(value), secret, `${label}: ${where}`);
				const texts = partialArgumentTexts([value]);
				assert.ok(texts.length > 0, `${label}: ${where}: fixture sanity: ${field} is there`);
				for (const text of texts) assert.equal(text, PLACEHOLDER, `${label}: ${where}: ${field} is the placeholder`);
			}
		}
	});
}

// A cut call with an empty id whose final message keeps its partial text: its interruption is still found
// after message_end rebuilds the block, in the final events and the transcript responses.
for (const field of ["partialJson", "partialArgs"]) {
	test(`rpc: masking consistency for streamed tool arguments, a cut call with an empty id whose final message keeps its ${field}`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { id: "", ending: "message_end", finals: true, field, partialOnEnd: true });
			assert.equal(final.content[0][field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(final).includes(line.slice(0, 12))), `${label}: fixture sanity: the cut call carries secret bytes`);
			const { finals, responses, out } = await interruptedRun(events, final);
			assert.deepEqual(finals.map((event) => event.type), ["message_end", "turn_end", "agent_end"], `${label}: the final events are written`);
			const shown = [...finals.map((event) => [event.type, event]), ...Object.entries(responses).map(([type, line]) => [type, JSON.parse(line)])];
			for (const [where, value] of shown) {
				assertNoSecretBytes(JSON.stringify(value), secret, `${label}: ${where}`);
				const texts = partialArgumentTexts([value]);
				assert.ok(texts.length > 0, `${label}: ${where}: fixture sanity: ${field} is there`);
				for (const text of texts) assert.equal(text, PLACEHOLDER, `${label}: ${where}: ${field} is the placeholder`);
			}
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
		}
	});
}

// A transcript the stream never saw (a reloaded session): a cut call that keeps its partial text is shown
// as interrupted in the transcript responses.
for (const field of ["partialJson", "partialArgs"]) {
	test(`rpc: masking consistency for streamed tool arguments, a reloaded transcript's cut call that keeps its ${field}`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const { final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { ending: "message_end", field, partialOnEnd: true });
			assert.equal(final.content[0][field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(final).includes(line.slice(0, 12))), `${label}: fixture sanity: the cut call carries secret bytes`);
			const { responses, out } = await interruptedRun([], final);
			assert.deepEqual(Object.keys(responses), ["get_messages", "get_entries", "get_tree"], `${label}: the three responses are written`);
			for (const [where, line] of Object.entries(responses)) {
				assertNoSecretBytes(line, secret, `${label}: ${where}`);
				const texts = partialArgumentTexts([JSON.parse(line)]);
				assert.ok(texts.length > 0, `${label}: ${where}: fixture sanity: ${field} is there`);
				for (const text of texts) assert.equal(text, PLACEHOLDER, `${label}: ${where}: ${field} is the placeholder`);
			}
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
		}
	});
}

// A transcript the stream never saw (a reloaded session): a cut call that no longer carries partial text,
// in a message that ended early (aborted or failed), is shown as interrupted in the transcript responses.
for (const stopReason of ["aborted", "error", "length"]) {
	test(`rpc: masking consistency for streamed tool arguments, a reloaded transcript's cut call without partial text in a message that ended ${stopReason}`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const { final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { ending: "message_end", stopReason });
			assert.equal(final.stopReason, stopReason, `${label}: fixture sanity: the message ended ${stopReason}`);
			assert.deepEqual(partialArgumentTexts([final]), [], `${label}: fixture sanity: no partial text`);
			assert.ok(secret.some((line) => JSON.stringify(final).includes(line.slice(0, 12))), `${label}: fixture sanity: the cut call carries secret bytes`);
			const { responses, out } = await interruptedRun([], final);
			assert.deepEqual(Object.keys(responses), ["get_messages", "get_entries", "get_tree"], `${label}: the three responses are written`);
			for (const [where, line] of Object.entries(responses)) {
				assertNoSecretBytes(line, secret, `${label}: ${where}`);
				assert.ok(line.includes(PLACEHOLDER), `${label}: ${where}: the placeholder is written`);
			}
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
		}
	});
}

// A live message that ended early (aborted or failed) and carries a call that completed: its toolcall_end
// shows the masked arguments; its final events show the call over-masked like an interrupted call.
const overMaskValues = (value) =>
	typeof value === "string"
		? vinciOverMaskHeldValue(value)
		: Array.isArray(value)
			? value.map(overMaskValues)
			: value && typeof value === "object"
				? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, overMaskValues(entry)]))
				: value;
for (const stopReason of ["aborted", "error", "length"]) {
	test(`rpc: masking consistency for streamed tool arguments, a completed call in a message that ended ${stopReason} is over-masked in its final events`, async () => {
		for (const { label, tool, args, secret } of multiLineCases()) {
			const { events } = toolCallEvents(tool, fragmentsOf(JSON.stringify(args), toolFragment), { stopReason, finals: true });
			const overMasked = vinciMaskJson(overMaskValues(args));
			assert.notDeepEqual(overMasked, vinciMaskJson(args), `${label}: fixture sanity: the over-mask differs from the mask`);
			const out = await runRpc(events);
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
			const end = out.events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
			assert.deepEqual(end?.assistantMessageEvent?.toolCall?.arguments, vinciMaskJson(args), `${label}: toolcall_end shows the masked arguments`);
			const finals = finalEventsOf(out.events);
			assert.deepEqual(finals.map((event) => event.type), ["message_end", "turn_end", "agent_end"], `${label}: the final events are written`);
			for (const event of finals) {
				const message = event.type === "agent_end" ? event.messages[0] : event.message;
				assert.equal(message.stopReason, stopReason, `${label}: ${event.type}: fixture sanity: the message ended ${stopReason}`);
				assert.deepEqual(message.content[0].arguments, overMasked, `${label}: ${event.type}: the call is over-masked`);
			}
		}
	});
}

// A completed call whose final message carries an empty partial text or the placeholder: kept as given.
for (const [what, kept] of [["an empty", ""], ["the placeholder as its", PLACEHOLDER]]) {
	for (const field of ["partialJson", "partialArgs"]) {
		test(`rpc: masking consistency for streamed tool arguments, a completed call whose final message carries ${what} ${field} keeps it`, async () => {
			const run = secretRuns()["a multi-line hex secret"];
			const args = multiLineToolCalls(run.lines).bash;
			const { events, final } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { field, finals: true, keepPartialOnEnd: true });
			final.content[0][field] = kept;
			const out = await runRpc(events);
			assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
			const finals = finalEventsOf(out.events);
			assert.deepEqual(finals.map((event) => event.type), ["message_end", "turn_end", "agent_end"], "the final events are written");
			for (const event of finals) assert.deepEqual(partialArgumentTexts([event]), [kept], `${event.type}: ${field} is kept as given`);
		});
	}
}

// A content index that names no tool-call block (out of range, or the text block ahead of the call) falls
// back to the call's id, else the last tool-call block; a numeric-string index is read as its number even
// where that fallback would pick another block.
for (const [label, index, after, id] of [
	["an out-of-range content index with a later tool call", 5, [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }], "call-1"],
	["a content index naming a text block with a later tool call", 0, [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }], "call-1"],
	["a numeric-string content index with a later tool call", "string", [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }], ""],
]) {
	test(`rpc: masking consistency for streamed tool arguments, ${label} still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id, index, after, before: [block("text", "Running it.\n")], finals: true });
		const out = await runRpc(events);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "released as the call's masked arguments");
	});
}

// The same fallback when no call carries streaming argument text (a provider that sends only parsed
// arguments): the deltas are held as a masked call's, never passed through to the later call.
for (const [label, index] of [
	["an out-of-range content index", 5],
	["a content index naming a text block", 0],
]) {
	test(`rpc: masking consistency for streamed tool arguments, ${label} with a later tool call and no streaming text still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }];
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "call-1", index, after, before: [block("text", "Running it.\n")], finals: true });
		const stripped = JSON.parse(JSON.stringify(events, (key, value) => (key === "partialJson" ? undefined : value)));
		assert.ok(!JSON.stringify(stripped).includes("partialJson"), "fixture sanity: no block carries streaming text");
		const out = await runRpc(stripped);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		assertMasked(deltasOf(out.events, "toolcall"), run.secret, "joined deltas");
	});
}

// The fallback's last step: no call carries streaming text and none is one the view masks, so the text
// belongs to a call the view does not mask and passes through as that call's (the over-mask side holds
// whenever any call in the message is one the view masks).
test("rpc positive control: an out-of-range content index with only calls the view does not mask is not held", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }];
	const { events } = toolCallEvents("shell_helper", splitAcross(json, token, 0), { id: "call-1", index: 5, after });
	const stripped = JSON.parse(JSON.stringify(events, (key, value) => (key === "partialJson" ? undefined : value)));
	assert.ok(!JSON.stringify(stripped).includes("partialJson"), "fixture sanity: no block carries streaming text");
	const out = await runRpc(stripped);
	assert.equal(out.stdout, stripped.map((event) => serializeJsonLine(event)).join(""), "passed through as calls the view does not mask");
});

// The fallback order: a call still carrying streaming text is taken before a later call the view masks
// that carries none, so a streaming call the view does not mask passes through.
test("rpc positive control: an out-of-range content index takes the streaming call before a later masked call", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const after = [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("shell_helper", splitAcross(json, token, 0), { id: "call-1", index: 5, after });
	assert.ok(events.every((event) => event.message?.content?.[1]?.partialJson === undefined), "fixture sanity: the later call carries no streaming text");
	const out = await runRpc(events);
	assert.equal(out.stdout, events.map((event) => serializeJsonLine(event)).join(""), "the streaming call passes through unchanged");
});

// The fallback takes a streaming call the view masks before a later call the view does not mask that still
// carries streaming text (a provider or extension that keeps the buffer after the call ends).
test("rpc: masking consistency for streamed tool arguments, an out-of-range content index holds the streaming call before a later unmasked call that keeps its text", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {}, partialJson: "{}" }];
	const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "call-1", index: 5, after, finals: true });
	const out = await runRpc(events);
	assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
	const deltas = deltasOf(out.events, "toolcall");
	assertMasked(deltas, run.secret, "joined deltas");
	assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "released once, as the call's masked arguments");
});


// Masking consistency for streamed tool arguments: a call streamed under a tool-name synonym of a built-in
// tool (the agent loop folds the name onto the tool only when the stream ends) is masked as that tool from
// the moment its name is known. Every synonym in the table, plus a mixed-case spelling.
const synonymCases = () => [...toolNameSynonyms(), ["Shell", "bash"]];

/** One call per secret shape, completed and cut (no toolcall_end), streamed under `name`. */
function synonymCalls(name, tool) {
	return Object.entries(secretRuns()).flatMap(([shape, run]) => {
		const args = multiLineArguments(tool, run.lines);
		const json = JSON.stringify(args);
		const cut = json.indexOf(run.lines[Math.floor(run.lines.length / 2)]) + 5;
		const completed = toolCallEvents(name, fragmentsOf(json, toolFragment), { finals: true }).events;
		const interrupted = toolCallEvents(name, fragmentsOf(json.slice(0, cut), toolFragment), { ending: "message_end", finals: true }).events;
		return [
			{ where: `${shape}, completed`, events: completed, secret: run.secret, args },
			{ where: `${shape}, cut`, events: interrupted, secret: run.secret },
		];
	});
}

/** No secret bytes in the joined deltas, any partial argument text, any written event or the whole stdout. */
function assertSynonymMasked(out, raw, secret, where) {
	assert.ok(JSON.stringify(raw).includes(secret[0].slice(0, 12)), `${where}: fixture sanity: the raw events carry the secret`);
	assertMasked(deltasOf(out.events, "toolcall"), secret, `${where}: joined deltas`);
	assertNoSecretBytes(partialArgumentTexts(out.events).join("\n"), secret, `${where}: partial argument text`);
	for (const event of out.events) assertNoSecretBytes(JSON.stringify(event), secret, `${where}: ${event.type} event`);
	assertMasked(out.stdout, secret, `${where}: whole stdout`);
}

for (const [name, tool] of synonymCases()) {
	test(`rpc: masking consistency for streamed tool arguments, a call streamed under the synonym "${name}" of ${tool}`, async () => {
		for (const { where, events, secret, args } of synonymCalls(name, tool)) {
			const out = await runRpc(events);
			assertSynonymMasked(out, events, secret, `${name}, ${where}`);
			if (args) assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(args)), `${name}, ${where}: released as the built-in call is`);
		}
	});
}

test("rpc positive control: a name that is neither a built-in tool nor a synonym of one is not held", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	for (const name of ["constructor", "toString", "shell_helper", "Edit"]) {
		const { events } = toolCallEvents(name, splitAcross(json, token, 0));
		const out = await runRpc(events);
		assert.equal(out.stdout, events.map((event) => serializeJsonLine(event)).join(""), `${name}: as a tool the view does not mask`);
	}
});

// A call whose name is not folded onto a tool (the tool is not in the turn's tool list) runs under its synonym.
test("rpc: tool execution events and results under a tool-name synonym of a built-in tool are masked like that tool's", async () => {
	const token = inlineToken();
	for (const [name] of synonymCases()) {
		const args = { value: `TOKEN=${token}` };
		const content = [{ type: "text", text: `found TOKEN=${token}\n` }];
		const result = { role: "toolResult", toolCallId: "call-1", toolName: name, content, isError: false, timestamp: 1 };
		const events = [
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: name, args },
			{ type: "tool_execution_update", toolCallId: "call-1", toolName: name, args, partialResult: { content } },
			{ type: "tool_execution_end", toolCallId: "call-1", toolName: name, result: { content }, isError: false },
			{ type: "message_end", message: result },
			{ type: "turn_end", message: assistant([block("text", "Done.\n")]), toolResults: [result] },
		];
		const out = await runRpc(events);
		assert.equal(out.events.length, events.length, `${name}: one line per event`);
		for (const event of out.events) assertMasked(JSON.stringify(event), [token], `${name}: ${event.type}`);
	}
});

// What the view masks beyond the streamed text: each kind has its own row.
test("rpc: read, grep, find and ls output is masked, as the view masks it", async () => {
	const token = inlineToken();
	const events = [];
	for (const toolName of ["read", "grep", "find", "ls"]) {
		const content = [{ type: "text", text: `found TOKEN=${token}\n` }];
		events.push({ type: "tool_execution_end", toolCallId: `call-${toolName}`, toolName, result: { content }, isError: false });
		const result = { role: "toolResult", toolCallId: `call-${toolName}`, toolName, content, isError: false, timestamp: 1 };
		events.push({ type: "message_end", message: result });
	}
	const out = await runRpc(events);
	assert.equal(out.events.length, events.length, "one line per event");
	for (const event of out.events) {
		const text = JSON.stringify(event);
		assertMasked(text, [token], `${event.type} (${event.toolName ?? event.message?.toolName})`);
	}
});

test("rpc: turn_end tool results are masked, as the view masks them", async () => {
	const token = inlineToken();
	const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: `TOKEN=${token}\n` }], isError: false, timestamp: 1 };
	const out = await runRpc([{ type: "turn_end", message: assistant([block("text", "Done.\n")]), toolResults: [toolResult] }]);
	const turnEnd = out.events.find((event) => event.type === "turn_end");
	assertMasked(JSON.stringify(turnEnd.toolResults), [token], "turn_end tool results");
});

test("rpc: agent_end messages are masked, as the view masks them", async () => {
	const token = inlineToken();
	const out = await runRpc([{ type: "agent_end", messages: [assistant([block("text", `The value is TOKEN=${token}\n`)])] }]);
	const agentEnd = out.events.find((event) => event.type === "agent_end");
	assertMasked(JSON.stringify(agentEnd.messages), [token], "agent_end messages");
});

test("rpc: an assistant error message is masked, as the view masks it", async () => {
	const token = inlineToken();
	const message = { ...assistant([], "error"), errorMessage: `request failed: TOKEN=${token}` };
	const out = await runRpc([{ type: "message_start", message }, { type: "message_end", message }]);
	for (const event of out.events.filter((candidate) => candidate.type === "message_end" || candidate.type === "message_start")) {
		assertMasked(event.message.errorMessage, [token], `${event.type} error message`);
	}
});

// Every command of the rpc-mode switch, with its verdict. A new command fails the row below until it is
// classed here: masked (its case calls the masker), unmasked by design (with the reason), or no model text.
const RPC_COMMAND_CENSUS = {
	get_protocol: "no model text",
	prompt: "no model text: an acknowledgement or the preflight error",
	steer: "no model text",
	follow_up: "no model text",
	abort: "no model text",
	new_session: "no model text: cancelled flag",
	get_state: "no model text: model, modes, counts and the user-set session name",
	set_model: "no model text: model metadata",
	cycle_model: "no model text: model metadata",
	get_available_models: "no model text: model metadata",
	set_thinking_level: "no model text",
	cycle_thinking_level: "no model text",
	set_steering_mode: "no model text",
	set_follow_up_mode: "no model text",
	compact: "unmasked by design: the compaction summary, which the view shows unmasked",
	set_auto_compaction: "no model text",
	set_auto_retry: "no model text",
	abort_retry: "no model text",
	bash: "unmasked by design: user shell output, which the view shows unmasked",
	abort_bash: "no model text",
	get_session_stats: "no model text: counts, tokens, cost and the session file",
	export_html: "no model text: the written file's path",
	switch_session: "no model text: cancelled flag",
	fork: "unmasked by design: the selected user message text",
	clone: "no model text: cancelled flag",
	get_fork_messages: "unmasked by design: user message text only",
	get_entries: "masked",
	get_tree: "masked",
	get_last_assistant_text: "masked",
	set_session_name: "no model text",
	get_messages: "masked",
	get_commands: "no model text: command names and descriptions",
};

test("rpc command census: every command in the rpc-mode switch has a masking verdict", () => {
	const source = readFileSync(resolve(packages, "coding-agent/src/modes/rpc/rpc-mode.ts"), "utf8");
	const start = source.indexOf("switch (command.type) {");
	const end = source.indexOf("default: {", start);
	assert.ok(start >= 0 && end > start, "fixture sanity: the command switch is found");
	const body = source.slice(start, end);
	const caseLabel = /case\s+(["'`])([^"'`]+)\1\s*:/g;
	const found = [...body.matchAll(caseLabel)].map((match) => match[2]);
	assert.ok(found.length > 0, "fixture sanity: the switch has cases");
	assert.deepEqual(
		found.filter((command) => !Object.hasOwn(RPC_COMMAND_CENSUS, command)),
		[],
		"every RPC command has a census verdict",
	);
	assert.deepEqual(
		Object.keys(RPC_COMMAND_CENSUS).filter((command) => !found.includes(command)),
		[],
		"every census row names a command the switch still has",
	);
	for (const [command, verdict] of Object.entries(RPC_COMMAND_CENSUS)) {
		assert.match(verdict, /^(masked|unmasked by design: .+|no model text(: .+)?)$/, `${command}: a known verdict`);
		if (verdict !== "masked") continue;
		const labels = [...body.matchAll(caseLabel)];
		const at = labels.findIndex((match) => match[2] === command);
		// Comments are stripped first: a comment that names the masker does not count.
		const caseBody = body.slice(labels[at].index, labels[at + 1]?.index).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
		// A masking function, called or handed to map: vinciMaskView*, vinciMaskSecrets or vinciMaskJson (not vinciMaskEnabled).
		assert.match(caseBody, /\bvinciMask(?:View\w*|Secrets|Json)\b\s*[()]/, `${command}: its case calls the masker`);
	}
});
