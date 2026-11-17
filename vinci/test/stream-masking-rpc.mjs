// Mask streamed output consistently: `--mode rpc` through the production runRpcMode, in process. The session
// is a stand-in whose listener the test drives; stdin is a stream the test ends (the exit path); every
// string written to stdout is recorded. Secret values are synthetic and built at runtime.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	angleEndingEvents,
	angleWhitespaceCases,
	ansiSecretCases,
	assertMasked,
	assertNoFiveCharacterSecret,
	assertNoRawSecret,
	assertNoSecretBytes,
	assistant,
	block,
	crossLineCases,
	cutPoints,
	cutToolCalls,
	deltasOf,
	fakeSecret,
	fallbackCases,
	finalEventsOf,
	fragmentsOf,
	heldWindows,
	inlineToken,
	isolatedBodyCases,
	multiLineArguments,
	multiLineToolCalls,
	PLACEHOLDER,
	partialArgumentTexts,
	probeBashCallEvents,
	probeCumulativeEvents,
	probeSecret,
	probeToolResultEvents,
	secretRuns,
	splitAcross,
	splitKeyResult,
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
const { createAssistantMessageDiagnostic } = await import(resolve(packages, "ai/src/utils/diagnostics.ts"));

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
		compact: async () => state.compact,
		getUserMessagesForForking: () => state.forkMessages,
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
		fork: async () => state.fork,
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
			// 206s: `emit` hands one more event to the session listener (rows that move a fake clock between events).
			await during({ stdout: () => capture.join(""), rebind: () => rebind(), send, emit: (event) => listener?.(event) });
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

test("rpc: an aborted answer (message_end, no text_end) keeps its complete lines, masked, then the placeholder for the held run", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, stopReason: "aborted" });
	const out = await runRpc(events);
	assertMasked(out.stdout, run.secret, "abort");
	const endIndex = out.events.findIndex((event) => event.type === "message_end");
	assert.ok(endIndex > 0, "message_end is written");
	// 206q (timing): with masking on the whole body is held until the message ends; every earlier delta is empty.
	assert.equal(deltasOf(out.events.slice(0, endIndex - 1)), "", "the body is held until the message ends");
	const flushed = out.events[endIndex - 1];
	assert.equal(flushed.type, "message_update", "a flushed delta precedes message_end");
	assert.ok(flushed.assistantMessageEvent.delta.includes(PLACEHOLDER), "the flushed delta is masked");
	// 206t (expectation: more masking): the abort cut the block before its end, so the flushed delta keeps only the
	// complete lines no later text could change (masked), then the placeholder; message_end shows exactly that.
	const flushedText = deltasOf(out.events);
	assert.ok(flushedText.startsWith("Here it is:\n"), "the complete lines stay");
	assert.ok(flushedText.endsWith(PLACEHOLDER), "then the placeholder for the held run");
	assert.equal(fieldOf(out.events[endIndex].message), flushedText, "message_end shows the block as the stream wrote it");
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

// 206q (scope, r2 Q2): everything the RPC mode writes goes through the whole-object masker, so what the view
// leaves unmasked (user text, other tools' output, retry errors) is masked too, as the JSON mode masks it.
test("rpc: what the view leaves unmasked is masked too (user text, other tools' output, retry errors)", async () => {
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
	assert.equal(out.stdout, events.map((event) => serializeJsonLine(vinciMaskJson(event))).join(""), "each event masked whole");
	assert.ok(!out.stdout.includes(token), "no event carries the token");
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
			// 206q (timing): the stream so far is written, its text deltas empty (the body is held whole).
			assert.ok(parseLines(stdout()).some((event) => event.assistantMessageEvent?.type === "text_delta"), "the stream so far is written");
			assert.equal(deltasOf(parseLines(stdout())), "", "held before the rebind");
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

// 206q (scope, r2 Q2 and Q4): a tool the view does not mask is held too (fail closed): its argument text is
// released once, at the call's end. 206r (F1, more masking): released as the masked JSON of the parsed arguments.
test("rpc: a tool the view does not mask holds its argument deltas and releases them once, masked", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const { events } = toolCallEvents("extension_tool", splitAcross(json, token, 0));
	const out = await runRpc(events);
	const released = out.events.filter((event) => event.assistantMessageEvent?.type === "toolcall_delta" && event.assistantMessageEvent.delta);
	assert.equal(released.length, 1, "one release, at the call's end");
	// 206r (F1, more masking): the release is the masked JSON of the parsed arguments, not the text masked whole.
	assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(JSON.parse(json))), "the masked JSON of the arguments");
	assertMasked(out.stdout, [token], "whole stdout");
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

// 206q (scope, r2 Q2): every response goes through the whole-object masker, so user text, user shell commands
// and their output are masked too.
test("rpc responses: what the view leaves unmasked is masked too (user text, user shell commands and their output)", async () => {
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
	assert.deepEqual(got.messages, vinciMaskJson([user, shell]), "user messages and user shell commands are masked whole");
	assert.deepEqual(got.bash, vinciMaskJson(bash), "the bash command response is masked whole");
	assert.ok(!JSON.stringify(got).includes(token), "no response carries the token");
});

// 206q (scope, r2 Q2): the census commands masked only by output() (compact, fork, get_fork_messages; bash is
// the row above), each driven through the RPC writer with the token in its reply.
test("rpc responses: compact, fork and get_fork_messages replies are masked by output()", async () => {
	const token = inlineToken();
	const compact = { summary: `kept TOKEN=${token}`, firstKeptEntryId: "e1", tokensBefore: 10 };
	const fork = { selectedText: `my value is ${token}`, cancelled: true };
	const forkMessages = [{ entryId: "e1", text: `my value is ${token}` }];
	const got = {};
	const lines = [];
	await runRpc([], {
		state: { compact, fork, forkMessages },
		during: async ({ send }) => {
			for (const command of [{ type: "compact" }, { type: "fork", entryId: "e1" }, { type: "get_fork_messages" }]) {
				const { response, line } = await send(command);
				got[command.type] = response;
				lines.push(line);
			}
		},
	});
	assert.equal(got.compact.success, true, "fixture sanity: compact answered");
	assert.deepEqual(got.compact.data, vinciMaskJson(compact), "the compact reply is masked whole");
	assert.deepEqual(got.fork.data, vinciMaskJson({ text: fork.selectedText, cancelled: true }), "the fork reply is masked whole");
	assert.deepEqual(got.get_fork_messages.data, vinciMaskJson({ messages: forkMessages }), "the get_fork_messages reply is masked whole");
	for (const [index, line] of lines.entries()) assertNoSecretBytes(line, [token], `reply ${index + 1}`);
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
	// 206q (scope, r2 Q2): the entries the view leaves unmasked are masked whole too (unchanged when they carry no secret).
	for (const index of state.raw) {
		assert.deepEqual(got[index], vinciMaskJson(state.entries[index]), `${where}: entry ${state.entries[index].id} is masked whole`);
		assertNoSecretBytes(JSON.stringify(got[index]), [state.token], `${where}: entry ${state.entries[index].id}`);
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
// (get_messages, get_entries, get_tree) an argument value is kept only when it is complete and the hold-back would
// release all of it; any other value is the placeholder, whole (206s (B01): no released prefix is kept).
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

// 206r (F1, more masking): the retained partial argument text of a call of a tool the view does not mask is the
// masked JSON of its arguments (the spaced JSON shows the rewrite); everything else in its end events is as before.
test("rpc positive control: a completed call of a tool the view does not mask keeps its partial argument text as the masked JSON of its arguments", async () => {
	const token = inlineToken();
	// Spaced JSON: a rewrite to the JSON of the parsed arguments would show.
	const json = `{"query": "find ${token}", "limit": 20}`;
	const { events, final } = toolCallEvents("extension_tool", splitAcross(json, token, 0), { finals: true, keepPartialOnEnd: true });
	assert.equal(final?.content?.[0]?.partialJson, json, "fixture sanity: the final message keeps the raw text");
	const out = await runRpc(events);
	const masked = JSON.stringify(vinciMaskJson(JSON.parse(json)));
	const withMasked = (event) => JSON.parse(JSON.stringify(event, (key, value) => (key === "partialJson" && value === json ? masked : value)));
	// 206q (timing and scope, r2 Q2 and Q4): the call is held while it streams, and every string is masked;
	// its end events are the masked events.
	const ends = (lines) => lines.filter((line) => /^\{"type":"(message_end|turn_end|agent_end)"/.test(line) || line.includes('"type":"toolcall_end"'));
	assert.deepEqual(
		ends(out.stdout.split("\n").filter(Boolean)),
		ends(events.map((event) => serializeJsonLine(vinciMaskJson(withMasked(event))).trimEnd())),
		"the end events are the masked events, their partial argument text the masked JSON of the arguments",
	);
	assert.equal(deltasOf(out.events, "toolcall"), masked, "released once, as the masked JSON of the arguments");
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

/** Text the fallback took (the events name no call) is not released; the final events show the call as interrupted. */
function assertFallbackHeld(out, secret) {
	assertNoSecretBytes(out.stdout, secret, "whole stdout");
	assert.equal(deltasOf(out.events, "toolcall"), "", "text the fallback took is not released");
	assert.ok(JSON.stringify(finalEventsOf(out.events)).includes(PLACEHOLDER), "the final events show the call as interrupted");
}

for (const index of ["string", "missing"]) {
	test(`rpc: masking consistency for streamed tool arguments, a ${index} content index still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { index, before: [block("text", "Running it.\n")] });
		const out = await runRpc(events);
		if (index === "missing") return assertFallbackHeld(out, run.secret);
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
// back to the fallback (the deltas carry no id), so the call's text is not released and its final events show
// it as interrupted; a numeric-string index is read as its number even where that fallback would pick
// another block, and the call is released as its masked arguments.
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
		if (index !== "string") return assertFallbackHeld(out, run.secret);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "released as the call's masked arguments");
	});
}

// The same fallback when no call carries streaming argument text (a provider that sends only parsed
// arguments): the deltas are held, never passed through to the later call.
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
		assertFallbackHeld(out, run.secret);
	});
}

// The fallback's last step: no call carries streaming text and none is one the view masks. The event names
// no call, so every tool call of the message is held and over-masked in its final events, even calls the
// view does not mask.
test("rpc: an out-of-range content index with only calls the view does not mask: the message's tool text is held", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }];
	const { events } = toolCallEvents("shell_helper", splitAcross(json, token, 0), { id: "call-1", index: 5, after });
	const stripped = JSON.parse(JSON.stringify(events, (key, value) => (key === "partialJson" ? undefined : value)));
	assert.ok(!JSON.stringify(stripped).includes("partialJson"), "fixture sanity: no block carries streaming text");
	const out = await runRpc(stripped);
	assert.equal(deltasOf(out.events, "toolcall"), "", "nothing is released after an event that names no call");
	assert.ok(!out.stdout.includes(token), "the final events over-mask the calls");
});

// The fallback order: when any call is one the view masks, an unidentified call's text is held as a masked
// call's, even when a call the view does not mask still carries streaming text.
test("rpc: masking consistency for streamed tool arguments, an out-of-range content index holds a streaming unmasked call's text when a later call is masked", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const after = [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("shell_helper", splitAcross(json, token, 0), { id: "call-1", index: 5, after });
	assert.ok(events.every((event) => event.message?.content?.[1]?.partialJson === undefined), "fixture sanity: the later call carries no streaming text");
	assert.ok(deltasOf(events, "toolcall").includes(token), "fixture sanity: passed through, the joined deltas would carry the value");
	const out = await runRpc(events);
	assert.ok(!deltasOf(out.events, "toolcall").includes(token), "the text is held as a masked call's");
});

// A built-in call that carries only parsed arguments, before a later call the view does not mask that still
// keeps streaming text: the built-in call's text is held.
test("rpc: masking consistency for streamed tool arguments, an out-of-range content index holds a built-in call without streaming text before a later unmasked call that keeps its text", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {}, partialJson: "{}" }];
	const built = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "call-1", index: 5, after, finals: true });
	const strip = (message) => (message?.content ? { ...message, content: message.content.map((block, at) => (at === 0 ? (({ partialJson, ...rest }) => rest)(block) : block)) } : message);
	const events = built.events.map((event) => {
		const copy = { ...event, message: strip(event.message) };
		if (event.assistantMessageEvent?.partial) copy.assistantMessageEvent = { ...event.assistantMessageEvent, partial: strip(event.assistantMessageEvent.partial) };
		return copy;
	});
	assert.ok(events.every((event) => event.message?.content?.[0]?.partialJson === undefined), "fixture sanity: the built-in call carries no streaming text");
	assert.ok(events.some((event) => event.message?.content?.[1]?.partialJson === "{}"), "fixture sanity: the later call keeps its text");
	const out = await runRpc(events);
	assertFallbackHeld(out, run.secret);
});

// Text the fallback took into a call whose name was not known yet: when that name turns out to be one the
// view does not mask, the text is not released (it may be another call's); the call shows no arguments.
test("rpc: masking consistency for streamed tool arguments, text taken by the fallback into a call named late as a tool the view does not mask is never shown as that call's", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "", arguments: {} }];
	const built = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "", index: 5, after, finals: true });
	const shape = (message, final) =>
		message?.content
			? {
					...message,
					content: message.content.map((block, at) =>
						at === 0 ? (({ partialJson, ...rest }) => rest)(block) : at === 1 && final ? { ...block, name: "extension_tool" } : block,
					),
				}
			: message;
	const events = built.events.map((event) => {
		const final = event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end" || event.assistantMessageEvent?.type === "toolcall_end";
		const copy = { ...event, message: shape(event.message, final) };
		if (event.messages) copy.messages = event.messages.map((message) => shape(message, true));
		if (event.assistantMessageEvent?.partial) copy.assistantMessageEvent = { ...event.assistantMessageEvent, partial: shape(event.assistantMessageEvent.partial, final) };
		return copy;
	});
	assert.ok(events.every((event) => event.message?.content?.[0]?.partialJson === undefined), "fixture sanity: the built-in call carries no streaming text");
	assert.equal(events.find((event) => event.type === "message_end")?.message?.content?.[1]?.name, "extension_tool", "fixture sanity: the later call is named late");
	const out = await runRpc(events);
	assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
	for (const event of out.events.filter((event) => event.type === "message_update")) {
		assert.deepEqual(event.message?.content?.[1]?.arguments, {}, "the later call shows no arguments while streaming");
	}
});

test("rpc positive control: a call named late as a tool the view does not mask, named by its content index after a built-in call, releases its own text unchanged", async () => {
	const json = JSON.stringify({ query: "list the open files", limit: 20 });
	const before = [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("extension_tool", fragmentsOf(json, 5), { id: "call-2", nameFrom: 3, before });
	const out = await runRpc(events);
	assert.equal(deltasOf(out.events, "toolcall"), json, "the joined deltas equal the raw argument text");
	assert.ok(!deltasOf(out.events, "toolcall").includes(PLACEHOLDER));
	// The built-in call ahead of it has no events of its own: its final events show it as interrupted.
	const end = out.events.find((event) => event.type === "message_end");
	assert.deepEqual(end.message.content[1].arguments, JSON.parse(json), "the named call's own arguments are unchanged");
	assert.equal(end.message.content[0].arguments.command, PLACEHOLDER, "the call with no events of its own is over-masked");
});

test("rpc positive control: a tracked built-in call's streaming message shows its masked arguments once released, not the held empty arguments", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { after });
	const out = await runRpc(events);
	const end = out.events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
	assert.deepEqual(end?.message?.content?.[0]?.arguments, vinciMaskJson(args), "the released call shows its masked arguments");
	assert.notDeepEqual(end?.message?.content?.[0]?.arguments, {}, "not the held empty arguments");
});

// The fallback takes a streaming call the view masks before a later call the view does not mask that still
// carries streaming text (a provider or extension that keeps the buffer after the call ends).
test("rpc: masking consistency for streamed tool arguments, an out-of-range content index holds the streaming call before a later unmasked call that keeps its text", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {}, partialJson: "{}" }];
	const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "call-1", index: 5, after, finals: true });
	const out = await runRpc(events);
	assertFallbackHeld(out, run.secret);
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

test("rpc positive control: a name that is neither a built-in tool nor a synonym of one is not masked as a built-in", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	for (const name of ["constructor", "toString", "shell_helper", "Edit"]) {
		const { events } = toolCallEvents(name, splitAcross(json, token, 0));
		const out = await runRpc(events);
		// 206q (timing and scope, r2 Q2 and Q4): every call is held while it streams and every string is masked.
		// 206r (F1, more masking): a tool the view does not mask releases the masked JSON of its arguments at its end.
		const ends = (lines) => lines.filter((line) => /^\{"type":"(message_end|turn_end|agent_end)"/.test(line) || line.includes('"type":"toolcall_end"'));
		assert.deepEqual(
			ends(out.stdout.split("\n").filter(Boolean)),
			ends(events.map((event) => serializeJsonLine(vinciMaskJson(event)).trimEnd())),
			`${name}: end events as a tool the view does not mask`,
		);
		assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(JSON.parse(json))), `${name}: released as the masked JSON of its arguments`);
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
// classed here: masked (its case calls the masker), masked by output() (with the reason: output() masks every
// string it writes), unmasked by design (with the reason), or no model text.
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
	compact: "masked by output(): the compaction summary",
	set_auto_compaction: "no model text",
	set_auto_retry: "no model text",
	abort_retry: "no model text",
	bash: "masked by output(): user shell output",
	abort_bash: "no model text",
	get_session_stats: "no model text: counts, tokens, cost and the session file",
	export_html: "no model text: the written file's path",
	switch_session: "no model text: cancelled flag",
	fork: "masked by output(): the selected user message text",
	clone: "no model text: cancelled flag",
	get_fork_messages: "masked by output(): user message text only",
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
		assert.match(verdict, /^(masked|masked by output\(\): .+|unmasked by design: .+|no model text(: .+)?)$/, `${command}: a known verdict`);
		if (verdict.startsWith("masked by output(): ")) {
			// 206q (scope, r2 Q2): output() puts everything it writes through the whole-object masker when masking is on.
			assert.match(
				source,
				/const output = \([^)]*\) => \{\s*writeRawStdout\(serializeJsonLine\(vinciMaskEnabled\(\) \? vinciMaskStreamJson\(obj\) : obj\)\);/,
				`${command}: output() masks what it writes`,
			);
			continue;
		}
		if (verdict !== "masked") continue;
		const labels = [...body.matchAll(caseLabel)];
		const at = labels.findIndex((match) => match[2] === command);
		// Comments are stripped first: a comment that names the masker does not count.
		const caseBody = body.slice(labels[at].index, labels[at + 1]?.index).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
		// A masking function, called or handed to map: vinciMaskView*, vinciMaskSecrets or vinciMaskJson (not vinciMaskEnabled).
		assert.match(caseBody, /\bvinciMask(?:View\w*|Secrets|Json)\b\s*[()]/, `${command}: its case calls the masker`);
	}
});

// Events that name no call (an out-of-range content index, no usable id): every tool call of that message is
// held and shown as interrupted in its final events; so is a built-in call the stream could not follow.
for (const [label, { events, secret }] of Object.entries(fallbackCases())) {
	test(`rpc: masking consistency for streamed tool arguments, events that name no call: ${label}`, async () => {
		const deltas = events.map((event) => event.assistantMessageEvent?.delta ?? "").join("");
		assert.ok(JSON.stringify(events).includes(secret[0]) || deltas.includes(secret[0]), "fixture sanity: the events carry the value");
		const out = await runRpc(events);
		assertNoSecretBytes(out.stdout, secret, "whole stdout");
	});
}

// ---------------------------------------------------------------------------------------------------
// Review findings R221-01..05 through runRpcMode: with masking on, no raw secret byte reaches stdout.
// ---------------------------------------------------------------------------------------------------

/** The transcript of `messages` as the session hands it back: one chain of message entries. */
function chainState(messages) {
	const entries = messages.map((message, i) => ({
		type: "message",
		id: `e${i + 1}`,
		parentId: i === 0 ? null : `e${i}`,
		timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
		message,
	}));
	let tree = [];
	for (let i = entries.length - 1; i >= 0; i--) tree = [{ entry: entries[i], children: tree }];
	const leafId = entries.at(-1)?.id ?? null;
	const sessionManager = { getEntries: () => entries, getTree: () => tree, getLeafId: () => leafId };
	return { messages, sessionManager };
}

/** Run `events`, then ask for the transcript three ways; every stdout line (events and responses) is in `out`. */
async function runWithTranscript(events, messages) {
	return runRpc(events, {
		state: chainState(messages),
		during: async ({ send }) => {
			for (const type of ["get_messages", "get_entries", "get_tree"]) await send({ type });
		},
	});
}

/** No written line carries the raw `secret` (each line named by its event type or response command), nor the whole stdout. */
function assertNoRawSecretInLines(out, secret, where) {
	for (const line of out.events) {
		const name = line?.type === "response" ? `${line.command} response` : `${line?.type} event`;
		assertNoRawSecret(JSON.stringify(line), secret, `${where}: ${name}`);
	}
	assertNoRawSecret(out.stdout, secret, `${where}: whole stdout`);
}

// 206r (C4): the run completed: the RPC mode exited 0 and each expected terminal event was written (a run that
// failed part-way, its output cut short, would otherwise pass an absence check).
function assertCompleted(out, terminals, where) {
	assert.equal(out.exitCode, 0, `${where}: the run exits 0`);
	for (const type of terminals) assert.ok(out.events.some((line) => line?.type === type), `${where}: ${type} is written`);
}

// R221-01: a value the masker finds only once a later chunk arrives is never released raw.
for (const kind of ["text", "thinking"]) {
	for (const { label, chunks, secret } of crossLineCases()) {
		test(`rpc R221-01: ${kind}, ${label}: no raw secret byte reaches stdout`, async () => {
			const { events, text } = streamEvents(chunks, { kind, eol: "" });
			assert.ok(text.includes(secret), "fixture sanity: the raw stream holds the secret");
			assert.ok(!vinciMaskSecrets(text).includes(secret), "fixture sanity: the mask of the joined body hides the secret");
			const out = await runRpc(events);
			assertNoRawSecret(out.stdout, secret, `R221-01 (rpc, ${kind}, ${label})`);
			assertCompleted(out, ["message_end"], `R221-01 (rpc, ${kind}, ${label})`); // 206r (C4)
		});
	}
}

// R221-03: built-in tool results carry their output twice: in content and in details (an edit's patch, a
// truncated output's content). Every copy is masked, in events and in the transcript responses. Inputs are the
// review probe's, one run per tool as the probe ran them.
async function r221_03(part, toolName, details) {
	const secret = probeSecret();
	const result = { content: [{ type: "text", text: `password=${secret}` }], details };
	const message = { role: "toolResult", toolName, toolCallId: "a", ...result };
	assert.ok(JSON.stringify(details.patch ?? details.truncation).includes(secret), `${toolName}: fixture sanity: the details carry the secret`);
	const events = [
		{ type: "tool_execution_start", toolName, toolCallId: "a", args: toolName === "bash" ? { command: "printf" } : { path: ".env" } },
		...(toolName === "bash" ? [{ type: "tool_execution_update", toolName, toolCallId: "a", args: { command: "printf" }, partialResult: result }] : []),
		{ type: "tool_execution_end", toolName, toolCallId: "a", result, isError: false },
		{ type: "message_start", message },
		{ type: "message_end", message },
		{ type: "turn_end", message: { role: "assistant", content: [], stopReason: "stop" }, toolResults: [message] },
		{ type: "agent_end", messages: [message] },
	];
	const out = await runWithTranscript(events, [message]);
	assert.deepEqual(
		out.events.filter((line) => line?.type === "response").map((line) => line.command),
		["get_messages", "get_entries", "get_tree"],
		`${toolName}: fixture sanity: the three responses are written`,
	);
	assertNoRawSecretInLines(out, secret, `R221-03${part} (rpc, ${toolName})`);
	assertCompleted(out, ["tool_execution_end"], `R221-03${part} (rpc, ${toolName})`); // 206r (C4)
}

test("rpc R221-03a: an edit's details.patch: no raw secret byte reaches stdout", async () => {
	const secret = probeSecret();
	await r221_03("a", "edit", {
		diff: `-password=${secret}\n+password=changed!42\n`,
		patch: `--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-password=${secret}\n+password=changed!42\n`,
	});
});

test("rpc R221-03b: a bash result's details.truncation.content: no raw secret byte reaches stdout", async () => {
	const secret = probeSecret();
	await r221_03("b", "bash", { truncation: { content: `password=${secret}`, truncated: true } });
});

// R221-04: an assistant message's diagnostics (built with the real diagnostic constructor) are masked too. Inputs
// are the review probe's.
test("rpc R221-04: an assistant message's diagnostics[].error.message and .stack: no raw secret byte reaches stdout", async () => {
	const secret = probeSecret();
	const error = new Error(`socket payload password=${secret}`);
	const diagnostic = createAssistantMessageDiagnostic("provider_transport_failure", error);
	assert.ok(diagnostic?.error?.message?.includes(secret), "fixture sanity: the diagnostic message carries the secret");
	assert.ok(diagnostic?.error?.stack?.includes(secret), "fixture sanity: the diagnostic stack carries the secret");
	const message = { role: "assistant", content: [], stopReason: "error", errorMessage: error.message, diagnostics: [diagnostic] };
	const events = [
		{ type: "message_start", message },
		{ type: "message_end", message },
		{ type: "turn_end", message, toolResults: [] },
		{ type: "agent_end", messages: [message] },
	];
	const out = await runWithTranscript(events, [message]);
	assert.deepEqual(
		out.events.filter((line) => line?.type === "response").map((line) => line.command),
		["get_messages", "get_entries", "get_tree"],
		"fixture sanity: the three responses are written",
	);
	assertNoRawSecretInLines(out, secret, "R221-04 (rpc)");
	assertCompleted(out, ["message_end", "agent_end"], "R221-04 (rpc)"); // 206r (C4)
});

// R221-05: bash output is masked as the view masks it, on the joined and final body, not per fragment. Inputs
// are the review probe's.
test("rpc R221-05: a bash result whose text parts join into a key block: no raw key byte reaches stdout", async () => {
	const { parts, hidden, details } = splitKeyResult();
	assert.ok(vinciMaskSecrets(parts[0]).includes(hidden), "fixture sanity: the first part alone is not masked");
	assert.ok(!vinciMaskSecrets(parts.join("\n")).includes(hidden), "fixture sanity: the mask of the joined body hides the body");
	const events = probeToolResultEvents(
		parts.map((text) => ({ type: "text", text })),
		details,
	);
	const out = await runRpc(events);
	assertNoRawSecretInLines(out, hidden, "R221-05 (rpc, parts join)");
	assertCompleted(out, ["tool_execution_end"], "R221-05 (rpc, parts join)"); // 206r (C4)
});

test("rpc R221-05: a cumulative bash update that ends before the END line: no raw key byte reaches stdout", async () => {
	const { cumulative, final, hidden } = splitKeyResult();
	assert.ok(vinciMaskSecrets(cumulative).includes(hidden), "fixture sanity: the first update alone is not masked");
	assert.ok(!vinciMaskSecrets(final).includes(hidden), "fixture sanity: the mask of the final body hides the body");
	const out = await runRpc(probeCumulativeEvents(cumulative, final));
	assertNoRawSecretInLines(out, hidden, "R221-05 (rpc, cumulative update)");
	assertCompleted(out, ["tool_execution_end"], "R221-05 (rpc, cumulative update)"); // 206r (C4)
});

// R221-02 [S3]: a terminal control sequence (or a carriage return) inside an assignment, as the review probe built
// it. These rows are S3's: when S3 is scoped out as a Known limit, run with VINCI_STREAM_MASK_S3_ROWS=0 and they
// are skipped with that reason.
const s3Rows = { skip: process.env.VINCI_STREAM_MASK_S3_ROWS === "0" ? "S3 scoped out (Known limit: control-sequence-split secrets)" : false };

test("rpc R221-02 [S3]: a control sequence inside an assignment in streamed bash arguments: no raw secret byte reaches stdout", s3Rows, async () => {
	const { secret, command } = ansiSecretCases();
	const out = await runRpc(probeBashCallEvents(command));
	assertNoRawSecret(out.stdout, secret, "R221-02 (rpc, bash arguments)");
	assertCompleted(out, ["message_end", "agent_end"], "R221-02 (rpc, bash arguments)"); // 206r (C4)
});

for (const [label, field] of [
	["a control sequence", "ansiOutput"],
	["a carriage return", "crOutput"],
]) {
	test(`rpc R221-02 [S3]: ${label} inside an assignment in bash output: no raw secret byte reaches stdout`, s3Rows, async () => {
		const cases = ansiSecretCases();
		const { details } = splitKeyResult();
		const out = await runRpc(probeToolResultEvents([{ type: "text", text: cases[field] }], details));
		assertNoRawSecret(out.stdout, cases.secret, `R221-02 (rpc, bash output, ${label})`);
		assertCompleted(out, ["tool_execution_end"], `R221-02 (rpc, bash output, ${label})`); // 206r (C4)
	});
}

test("rpc R221-02 [S3]: a control sequence inside an assignment in an assistant error message: no raw secret byte reaches stdout", s3Rows, async () => {
	const { secret, errorMessage } = ansiSecretCases();
	const message = { role: "assistant", content: [], stopReason: "error", errorMessage };
	const out = await runRpc([{ type: "message_end", message }]);
	assertNoRawSecret(out.stdout, secret, "R221-02 (rpc, assistant error message)");
	// 206r (C4): this row's input is message_end alone (no agent_end by design): message_end is its terminal event.
	assertCompleted(out, ["message_end"], "R221-02 (rpc, assistant error message)");
});

// Append-only consumers of the RPC stream: each rebuilds the answer from deltas alone, before text_end.
function consumerAnswers() {
	const runs = secretRuns();
	const thinkingRun = runs["a multi-line hex secret"];
	const textRun = runs["a multi-line base64 secret"];
	const thinking = streamEvents(["Thinking it over:\n", ...thinkingRun.lines.map((line) => `${line}\n`), "Done."], { kind: "thinking", eol: "" });
	const answer = streamEvents(["Here it is:\n", ...textRun.lines.map((line) => `${line}\n`), "That is all."], { eol: "" });
	return { events: [...thinking.events, ...answer.events], thinkingRun, textRun };
}

/** The masked final texts the writer put in the assistant message_end events, by kind. */
function writtenFinals(out, kind) {
	return out.events
		.filter((line) => line?.type === "message_end" && Array.isArray(line.message?.content))
		.map((line) => fieldOf(line.message, kind))
		.filter((text) => typeof text === "string");
}

// test/rpc-example.ts: prints every text_delta and thinking_delta as it arrives.
test("rpc consumer control (rpc-example): thinking and text deltas alone print the full masked answer before text_end", async () => {
	const { events, thinkingRun, textRun } = consumerAnswers();
	const out = await runRpc(events);
	let printed = "";
	let atTextEnd;
	for (const line of out.events) {
		if (line?.type !== "message_update") continue;
		const source = line.assistantMessageEvent;
		if (source?.type === "text_delta" || source?.type === "thinking_delta") printed += source.delta ?? "";
		if (source?.type === "text_end" && atTextEnd === undefined) atTextEnd = printed;
	}
	const [thinking] = writtenFinals(out, "thinking");
	const [text] = writtenFinals(out, "text");
	assert.ok(typeof thinking === "string" && thinking.includes(PLACEHOLDER), "the written thinking is masked");
	assert.ok(typeof text === "string" && text.includes(PLACEHOLDER), "the written answer is masked");
	assert.equal(atTextEnd, thinking + text, "the consumer has printed the full masked thinking and answer by text_end");
	assertMasked(atTextEnd, thinkingRun.secret, "consumer, thinking");
	assertMasked(atTextEnd, textRun.secret, "consumer, answer");
});

// examples/rpc-extension-ui.ts: appends each text_delta to an output log, splitting it on line breaks.
test("rpc consumer control (rpc-extension-ui): text deltas alone build the full masked answer in the log before text_end", async () => {
	const { events, textRun } = consumerAnswers();
	const out = await runRpc(events);
	const header = "Agent:";
	const log = [];
	let hasTextOutput = false;
	let atTextEnd;
	for (const line of out.events) {
		if (line?.type !== "message_update") continue;
		const source = line.assistantMessageEvent;
		if (source?.type === "text_delta") {
			if (!hasTextOutput) {
				hasTextOutput = true;
				log.push("");
				log.push(header);
			}
			const parts = String(source.delta ?? "").split("\n");
			for (let i = 0; i < parts.length; i++) {
				if (i > 0) log.push("");
				if (parts[i]) log[log.length - 1] += parts[i];
			}
		}
		if (source?.type === "text_end" && atTextEnd === undefined) {
			const at = log.findIndex((entry) => entry.startsWith(header));
			atTextEnd = at < 0 ? "" : log.slice(at).join("\n").slice(header.length);
		}
	}
	const [text] = writtenFinals(out, "text");
	assert.ok(typeof text === "string" && text.includes(PLACEHOLDER), "the written answer is masked");
	assert.equal(atTextEnd, text, "the consumer's log holds the full masked answer by text_end");
	assertMasked(atTextEnd, textRun.secret, "consumer, answer");
});

test("rpc positive control (206q): ordinary prose arrives whole by text_end and the deltas rebuild the final text", async () => {
	const { events, text } = streamEvents(["First line.\n", "Second line, with a comma;\n", "Third (and last)."], { eol: "" });
	const out = await runRpc(events);
	const endAt = out.events.findIndex((line) => line?.assistantMessageEvent?.type === "text_end");
	assert.ok(endAt > 0, "text_end is written");
	assert.equal(deltasOf(out.events.slice(0, endAt)), text, "the deltas before text_end rebuild the raw text");
	assert.equal(out.events[endAt].assistantMessageEvent.content, text, "text_end carries the raw text");
	const end = out.events.find((line) => line?.type === "message_end");
	assert.equal(end?.message?.content ? fieldOf(end.message) : undefined, text, "message_end carries the raw text");
	assert.ok(!out.stdout.includes(PLACEHOLDER), "nothing is masked");
});

test("rpc positive control (206q): ordinary bash output arrives whole at tool_execution_end", async () => {
	const content = [
		{ type: "text", text: "line one" },
		{ type: "text", text: "line two" },
	];
	const result = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content, isError: false, timestamp: 1 };
	const events = [
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
		{ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "ls" }, partialResult: { content: [content[0]], details: {} } },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content }, isError: false },
		{ type: "message_end", message: result },
	];
	const out = await runRpc(events);
	const joined = (parts) => (Array.isArray(parts) ? parts.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : undefined);
	const end = out.events.find((line) => line?.type === "tool_execution_end");
	assert.equal(joined(end?.result?.content), "line one\nline two", "tool_execution_end carries the whole output");
	const message = out.events.find((line) => line?.type === "message_end");
	assert.equal(joined(message?.message?.content), "line one\nline two", "the tool result message carries the whole output");
	assert.ok(!out.stdout.includes(PLACEHOLDER), "nothing is masked");
});

// Masking off is byte-identical to main: one fixed run (events, then transcript commands) against a golden
// captured on main by the host.
const maskingOffGolden = resolve(here, "fixtures/stream-masking-off-golden.json");

test("rpc with masking off: one fixed run's stdout is byte-identical to the golden captured on main", async () => {
	assert.ok(existsSync(maskingOffGolden), `the masking-off golden is at ${maskingOffGolden}`);
	const golden = JSON.parse(readFileSync(maskingOffGolden, "utf8"));
	const fixture = golden?.fixture;
	assert.ok(Array.isArray(fixture?.events) && fixture.events.length > 0, "fixture sanity: the golden holds its events");
	assert.ok(Array.isArray(fixture?.rpcCommands) && fixture?.rpcState, "fixture sanity: the golden holds its commands and session state");
	assert.equal(typeof golden?.rpc, "string", "fixture sanity: the golden holds the rpc stdout");
	const { messages, entries, tree, leafId, lastAssistantText } = fixture.rpcState;
	const sessionManager = { getEntries: () => entries, getTree: () => tree, getLeafId: () => leafId };
	const out = await runRpc(fixture.events, {
		masking: false,
		state: { messages, lastAssistantText, sessionManager },
		during: async ({ send }) => {
			for (const type of fixture.rpcCommands) await send({ type });
		},
	});
	assert.equal(out.stdout, golden.rpc, "masking off: stdout is byte-identical to main");
});

// ---------------------------------------------------------------------------------------------------
// 206r: a tool the view does not mask, replayed signatures and serialization hooks, through runRpcMode.
// ---------------------------------------------------------------------------------------------------

// 206r (F1): obviously fake values under names the property masker knows and the text masker misses in quoted
// JSON (Authorization, access, refresh, key), at top level and nested.
function f1Arguments() {
	const values = {
		Authorization: ["Qv7Lx2Nm", "8Rt4Pz6Wk"].join("-"),
		access: ["Hb3Jd9Fs", "5Gq1Mc7Yt"].join("-"),
		refresh: ["Ze6Wn4Kp", "2Xu8Vr3Lb"].join("-"),
		key: ["Tm5Ca1Hy", "7Do9Es4Ui"].join("-"),
		"headers.Authorization": ["Pw2Ri8Oe", "6Su3Ya5Bn"].join("-"),
	};
	const args = {
		path: "notes/out.txt",
		Authorization: values.Authorization,
		access: values.access,
		refresh: values.refresh,
		key: values.key,
		headers: { Authorization: values["headers.Authorization"] },
	};
	return { args, values };
}

/** The stdout line of the first written line that `matches`. */
const lineOf = (stdout, matches) => stdout.split("\n").find((line) => line !== "" && matches(JSON.parse(line)));

// 206r (F1): a call of a tool the view does not mask releases the masked JSON of its arguments, so no value
// under a secret name reaches a toolcall_delta, the toolcall_end event, message_end, the transcript or anything else.
test("rpc 206r (F1): a call of a tool the view does not mask: no value under a secret name reaches its deltas, toolcall_end or message_end", async () => {
	const { args, values } = f1Arguments();
	const json = JSON.stringify(args);
	const fragments = fragmentsOf(json, 7);
	for (const value of Object.values(values)) {
		assert.ok(!fragments.some((fragment) => fragment.includes(value)), `fixture sanity: ${value} is split across deltas`);
	}
	const { events, final } = toolCallEvents("mytool", fragments, { finals: true, keepPartialOnEnd: true });
	assert.equal(final?.content?.[0]?.partialJson, json, "fixture sanity: the final message keeps the raw text");
	const out = await runRpc(events, {
		state: { messages: [final] },
		during: async ({ send }) => {
			await send({ type: "get_messages" });
		},
	});
	assertCompleted(out, ["message_end", "agent_end"], "206r (F1, rpc)");
	const deltas = out.events.filter((line) => line?.assistantMessageEvent?.type === "toolcall_delta");
	assert.ok(deltas.length >= fragments.length, "fixture sanity: the toolcall_delta events are written");
	const toolcallEnd = lineOf(out.stdout, (line) => line?.assistantMessageEvent?.type === "toolcall_end");
	const messageEnd = lineOf(out.stdout, (line) => line?.type === "message_end");
	const transcript = lineOf(out.stdout, (line) => line?.type === "response" && line.command === "get_messages");
	assert.ok(toolcallEnd && messageEnd && transcript, "the toolcall_end and message_end events and the get_messages response are written");
	for (const [name, value] of Object.entries(values)) {
		deltas.forEach((line, n) => assertNoRawSecret(line.assistantMessageEvent.delta, value, `206r (F1, rpc): ${name}: toolcall_delta ${n}`));
		assertNoRawSecret(toolcallEnd, value, `206r (F1, rpc): ${name}: the toolcall_end event`);
		assertNoRawSecret(messageEnd, value, `206r (F1, rpc): ${name}: the message_end event`);
		assertNoRawSecret(transcript, value, `206r (F1, rpc): ${name}: the get_messages response`);
		assertNoRawSecret(out.stdout, value, `206r (F1, rpc): ${name}: whole stdout`);
	}
	assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(args)), "the release is the masked JSON of the arguments");
});

// 206r (C2): an OpenAI Responses reasoning item kept as the thinking block's signature (JSON.stringify of the item).
function reasoningSignature(summaryText) {
	const encrypted = Buffer.from("opaque reasoning state, a stand-in value only. ".repeat(4)).toString("base64");
	return JSON.stringify({ id: "rs_fake0001", type: "reasoning", summary: [{ type: "summary_text", text: summaryText }], encrypted_content: encrypted });
}

/** Thinking stream events whose end events carry `signature` as the block's thinkingSignature, then turn_end and agent_end. */
function signedThinkingEvents(lines, signature) {
	const { events, text } = streamEvents(lines, { kind: "thinking" });
	const signed = (message) =>
		message?.content ? { ...message, content: message.content.map((part) => (part?.type === "thinking" ? { ...part, thinkingSignature: signature } : part)) } : message;
	const shown = events.map((event) => {
		if (event.type !== "message_end" && event.assistantMessageEvent?.type !== "thinking_end") return event;
		const copy = { ...event, message: signed(event.message) };
		if (event.assistantMessageEvent?.partial) copy.assistantMessageEvent = { ...event.assistantMessageEvent, partial: copy.message };
		return copy;
	});
	const final = shown.at(-1).message;
	return { events: [...shown, { type: "turn_end", message: final, toolResults: [] }, { type: "agent_end", messages: [final] }], text, final };
}

/** Every thinkingSignature string anywhere in `value`. */
function signaturesIn(value) {
	const found = [];
	const walk = (entry) => {
		if (Array.isArray(entry)) entry.forEach(walk);
		else if (entry && typeof entry === "object") {
			for (const [key, inner] of Object.entries(entry)) {
				if (key === "thinkingSignature" && typeof inner === "string") found.push(inner);
				else walk(inner);
			}
		}
	};
	walk(value);
	return found;
}

test("rpc 206r (C2): a private-key body inside a reasoning item's summary kept as thinkingSignature: no raw key byte reaches stdout", async () => {
	const run = secretRuns()["an END-only private-key body"];
	const lines = ["Checking the deploy key:", ...run.lines, "Done."];
	const signature = reasoningSignature(`${lines.join("\n")}\n`);
	assert.ok(signature.includes(run.secret[0].slice(0, 12)), "fixture sanity: the signature carries the key body");
	// 206r (C2 fixture): the opaque fields share no window with the key body, so a red row means the summary text leaked.
	const { summary: _summary, ...opaque } = JSON.parse(signature);
	assertNoSecretBytes(JSON.stringify(opaque), run.secret, "fixture sanity: the signature outside its summary");
	const { events, final } = signedThinkingEvents(lines, signature);
	const out = await runRpc(events, {
		state: { messages: [final] },
		during: async ({ send }) => {
			await send({ type: "get_messages" });
		},
	});
	assertCompleted(out, ["message_end", "agent_end"], "206r (C2, rpc)");
	for (const line of out.events) assertNoSecretBytes(JSON.stringify(line), run.secret, `206r (C2, rpc): ${line?.type === "response" ? `${line.command} response` : `${eventName(line)} event`}`);
	assertNoSecretBytes(out.stdout, run.secret, "206r (C2, rpc): whole stdout");
	const written = signaturesIn(out.events.find((line) => line?.type === "message_end"));
	assert.equal(written.length, 1, "message_end carries the signature");
	assert.ok(JSON.parse(written[0]).summary[0].text.includes(PLACEHOLDER), "the signature is masked decoded: its summary text holds the placeholder");
});

test("rpc positive control 206r (C2): a reasoning item with no secret, kept as thinkingSignature, is written byte-identical", async () => {
	const lines = ["Looked at the repository layout.", "Planned a small edit to the parser."];
	const signature = reasoningSignature(`${lines.join("\n")}\n`);
	const { events, final } = signedThinkingEvents(lines, signature);
	const out = await runRpc(events, {
		state: { messages: [final] },
		during: async ({ send }) => {
			await send({ type: "get_messages" });
		},
	});
	assertCompleted(out, ["message_end", "agent_end"], "206r (C2 control, rpc)");
	const written = signaturesIn(out.events);
	assert.ok(written.length >= 5, "fixture sanity: thinking_end, message_end, turn_end, agent_end and get_messages carry the signature");
	for (const text of written) assert.equal(text, signature, "the written thinkingSignature is the input string, byte for byte");
});

// 206r (C3): a value whose toJSON returns an object with its own toJSON, `depth` levels deep, the last returning text.
function hookChain(depth, text) {
	let value = text;
	for (let level = 0; level < depth; level++) {
		const inner = value;
		value = { toJSON: () => inner };
	}
	return value;
}

/** A tool result whose details are `details`: tool_execution_start, tool_execution_end and the tool result message. */
function detailsEvents(details) {
	const result = { content: [{ type: "text", text: "done" }], details };
	const message = { role: "toolResult", toolCallId: "call-1", toolName: "extension_tool", ...result, isError: false, timestamp: 1 };
	return [
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "extension_tool", args: {} },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "extension_tool", result, isError: false },
		{ type: "message_start", message },
		{ type: "message_end", message },
	];
}

// The RPC mode masks each event twice (vinciMaskViewEvent, then output()): a chain of 3 reaches past both.
test("rpc 206r (C3): details whose toJSON returns an object with its own toJSON: no raw secret reaches stdout", async () => {
	const secret = fakeSecret();
	for (const depth of [2, 3]) {
		const details = hookChain(depth, `password=${secret}`);
		let reached = details;
		for (let level = 0; level < depth; level++) reached = reached.toJSON();
		assert.equal(reached, `password=${secret}`, `fixture sanity: depth ${depth}: the hooks end in the secret`);
		const out = await runRpc(detailsEvents(details));
		assertCompleted(out, ["tool_execution_end", "message_end"], `206r (C3, rpc, depth ${depth})`);
		assertNoRawSecret(out.stdout, secret, `206r (C3, rpc, depth ${depth}): whole stdout`);
		const end = out.events.find((line) => line?.type === "tool_execution_end");
		assert.deepEqual(end?.result?.details, JSON.parse(JSON.stringify(details)), `depth ${depth}: details serialise as JSON.stringify serialises them`);
	}
});

test("rpc positive control 206r (C3): ordinary toJSON values and function-valued properties serialise as JSON.stringify serialises them", async () => {
	const details = { when: new Date(0), info: { toJSON: () => ({ note: "plain text" }) }, list: [1, () => 1, "x"], hook: () => 1 };
	const out = await runRpc(detailsEvents(details));
	assertCompleted(out, ["tool_execution_end", "message_end"], "206r (C3 control, rpc)");
	const expected = JSON.parse(JSON.stringify(details));
	assert.deepEqual(expected, { when: "1970-01-01T00:00:00.000Z", info: { note: "plain text" }, list: [1, null, "x"] }, "fixture sanity");
	const end = out.events.find((line) => line?.type === "tool_execution_end");
	assert.deepEqual(end?.result?.details, expected, "tool_execution_end details are unchanged");
	const message = out.events.find((line) => line?.type === "message_end");
	assert.deepEqual(message?.message?.details, expected, "the tool result message's details are unchanged");
});

// ---------------------------------------------------------------------------------------------------
// 206s: review findings B01..B08 through runRpcMode. Inputs are the review probes', byte for byte. Each row
// asserts the run completed, and fails on the code before 206s by an assertion (a raw secret byte on stdout, or a
// missing, duplicated or retyped field), never by a crash.
// ---------------------------------------------------------------------------------------------------

const {
	angleCutCase,
	boxedDetails,
	controlStringError,
	interruptedCutEvents,
	keyBlockProgress,
	ownProtoDetails,
	progressEvents,
	releasedUpdates,
	retainedCutEvents,
	splitReasoningMessage,
} = await import("./lib/stream-masking-fixtures.mjs");
const streamMaskModule = await import(resolve(packages, "coding-agent/src/core/vinci-stream-mask.ts"));
const ansiModule = await import(resolve(packages, "coding-agent/src/utils/ansi.ts"));

/** The test-only hold-bounds setter; where it is not exported the row fails here, by an assertion. */
function holdLimitsSetter() {
	const set = streamMaskModule.vinciSetStreamHoldLimitsForTest;
	if (typeof set !== "function") assert.fail("206s (B05): vinciSetStreamHoldLimitsForTest is exported (the hold bounds can be set for a test)");
	return set;
}

/** The nonempty deltas of one kind, as the written events that carry them. */
const releasedDeltas = (events, kind = "text") =>
	events.filter((event) => event?.type === "message_update" && event.assistantMessageEvent?.type === `${kind}_delta` && event.assistantMessageEvent.delta !== "");

// 206s (B01): a cut or interrupted call keeps no released raw prefix of a value, in events and transcript responses.
test("rpc 206s (B01): an aborted call whose argument text was cut after a complete multi-line value: no raw secret byte reaches stdout", async () => {
	const { events, message, command, secret } = interruptedCutEvents();
	assert.ok(command.includes(secret), "fixture sanity: the command carries the secret");
	assert.ok(!vinciMaskSecrets(command).includes(secret), "fixture sanity: the view masks the whole command");
	const out = await runWithTranscript(events, [message]);
	assert.deepEqual(
		out.events.filter((line) => line?.type === "response").map((line) => line.command),
		["get_messages", "get_entries", "get_tree"],
		"fixture sanity: the three responses are written",
	);
	assertNoRawSecretInLines(out, secret, "206s (B01, rpc, interrupted)");
	assertCompleted(out, ["message_end", "agent_end"], "206s (B01, rpc, interrupted)");
	const messages = out.events.find((line) => line?.command === "get_messages")?.data?.messages;
	assert.equal(messages?.[0]?.content?.[0]?.arguments?.command, PLACEHOLDER, "get_messages: the cut call's command is the placeholder, whole");
});

test("rpc 206s (B01): a completed call that keeps argument text cut after a complete multi-line value (retained invalid partial): no raw secret byte reaches stdout", async () => {
	const { events, message, command, secret } = retainedCutEvents();
	assert.ok(!vinciMaskSecrets(command).includes(secret), "fixture sanity: the view masks the whole command");
	assert.throws(() => JSON.parse(message.content[0].partialJson), SyntaxError, "fixture sanity: the retained partial argument text is not complete JSON");
	const out = await runWithTranscript(events, [message]);
	assertNoRawSecretInLines(out, secret, "206s (B01, rpc, retained cut text)");
	assertCompleted(out, ["message_end", "turn_end", "agent_end"], "206s (B01, rpc, retained cut text)");
});

// 206s (B02): a reasoning item's parts are masked joined, as the provider joins them, in events and get_messages.
for (const field of ["summary", "content"]) {
	test(`rpc 206s (B02): a private-key body split across a reasoning item's ${field} entries, kept as thinkingSignature: no raw key byte reaches stdout`, async () => {
		const { events, run, message } = splitReasoningMessage(field);
		assert.ok(run.secret.some((line) => vinciMaskSecrets(line) === line), "fixture sanity: an entry alone is not masked");
		assert.ok(vinciMaskSecrets(message.content[0].thinking).includes(PLACEHOLDER), "fixture sanity: the joined body (the thinking block) is masked");
		let line;
		const out = await runRpc(events, {
			state: { messages: [message] },
			during: async ({ send }) => {
				({ line } = await send({ type: "get_messages" }));
			},
		});
		assertNoSecretBytes(out.stdout, run.secret, `206s (B02, rpc, ${field}): whole stdout`);
		assertNoSecretBytes(line, run.secret, `206s (B02, rpc, ${field}): get_messages`);
		assertCompleted(out, ["message_end", "agent_end"], `206s (B02, rpc, ${field})`);
		const written = signaturesIn(out.events.find((event) => event?.type === "message_end"));
		assert.equal(written.length, 1, "message_end carries the signature");
		assert.ok(JSON.parse(written[0])[field].map((part) => part.text).join("\n\n").includes(PLACEHOLDER), `the signature's ${field} text holds the placeholder`);
	});
}

// 206s (B03): the stream normalises control strings with the error view's own function.
test("rpc 206s (B03): a DCS string inside an assignment's key in an assistant error: no raw secret byte reaches stdout", async () => {
	const { secret, errorMessage, events } = controlStringError();
	const out = await runRpc(events);
	assertNoRawSecret(out.stdout, secret, "206s (B03, rpc)");
	assertCompleted(out, ["message_end", "agent_end"], "206s (B03, rpc)");
	const strip = ansiModule.vinciStripControlText;
	if (typeof strip !== "function") assert.fail("206s (B03): utils/ansi.ts exports the shared control normaliser vinciStripControlText");
	assert.ok(!vinciMaskSecrets(strip(errorMessage)).includes(secret), "positive control: the error view's transform masks the secret");
});

// 206s (B04): a tool's latest progress is kept and released once, masked, when nothing later carries it.
test("rpc 206s (B04): a tool's progress followed by the end of input (no tool end) goes out once, as the placeholder", async () => {
	const { text, update } = progressEvents();
	const out = await runRpc([update]);
	assert.equal(out.exitCode, 0, "206s (B04, rpc, update then end of input): the run exits 0");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	assert.equal(released[0].toolCallId, "partial-only", "for its tool call");
	// 206t (expectation: more masking): a kept partial result never reached its end, so it goes out as the placeholder
	// with empty details, not masked whole.
	assert.ok(text !== PLACEHOLDER, "fixture sanity: the progress is ordinary text");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
	assert.deepEqual(released[0].partialResult.details, {}, "with empty details");
});

test("rpc 206s (B04): a tool's progress followed by an error-only tool end goes out once, before the end, as the placeholder", async () => {
	const { text, errorUpdate, errorEnd } = progressEvents();
	const out = await runRpc([errorUpdate, errorEnd]);
	assertCompleted(out, ["tool_execution_end"], "206s (B04, rpc, update then error)");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	// 206t (expectation: more masking): the error-only end does not carry the kept progress, which never reached its end,
	// so it goes out as the placeholder, not masked whole.
	assert.ok(text !== PLACEHOLDER, "fixture sanity: the progress is ordinary text");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
	const endAt = out.events.findIndex((event) => event?.type === "tool_execution_end");
	assert.ok(out.events.indexOf(released[0]) < endAt, "before the tool end");
	assert.equal(out.events[endAt].result.content[0].text, "operation aborted.", "the error-only end is written as it was");
});

test("rpc 206s (B04): a tool's progress that is a key body cut before its END line goes out as the placeholder: no raw key byte reaches stdout", async () => {
	const { body, final, hidden, update } = keyBlockProgress();
	assert.ok(vinciMaskSecrets(body).includes(hidden), "fixture sanity: the cut body alone is not masked");
	assert.ok(!vinciMaskSecrets(final).includes(hidden), "fixture sanity: the whole body is masked");
	const out = await runRpc([update]);
	assert.equal(out.exitCode, 0, "206s (B04, rpc, key-block progress): the run exits 0");
	assertNoRawSecretInLines(out, hidden, "206s (B04, rpc, key-block progress)");
	const released = out.events.filter((event) => event?.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes(PLACEHOLDER));
	assert.equal(released.length, 1, "the kept progress is written once, as the placeholder (it cannot be masked whole)");
	assert.deepEqual(released[0].partialResult.details, {}, "its details are empty");
});

test("rpc 206s (B04): a tool's progress cut inside an angle value, then an error-only end, goes out as the placeholder: no raw secret byte reaches stdout", async () => {
	const { secret, body, update, errorEnd } = angleCutCase();
	assert.ok(vinciMaskSecrets(body).includes(secret), "fixture sanity: the cut body alone is not masked");
	assert.ok(!vinciMaskSecrets(`${body}>\n`).includes(secret), "fixture sanity: with its closing line it is masked");
	const lineMayChange = streamMaskModule.vinciLineMayChange;
	assert.ok(body.split("\n").slice(0, -1).every((line) => !lineMayChange(line, false)), "fixture sanity: the hold-back releases every line");
	const out = await runRpc([update, errorEnd]);
	assertCompleted(out, ["tool_execution_end"], "206s (B04, rpc, angle-cut progress)");
	assertNoRawSecretInLines(out, secret, "206s (B04, rpc, angle-cut progress)");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder (a later line could still mask it)");
	assert.deepEqual(released[0].partialResult.details, {}, "its details are empty");
});

// 206s (B05): a held body has a byte bound and a deadline; at either it goes out at once, and nothing raw follows.
test("rpc 206s (B05): a text block past the byte bound goes out at once, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const run = secretRuns()["an END-only private-key body"];
	const { events } = streamEvents(["Here it is:", ...run.lines, "That is all."]);
	set({ maxBytes: 200 });
	let out;
	try {
		out = await runRpc(events);
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206s (B05, rpc, text cap)");
	assertNoSecretBytes(out.stdout, run.secret, "206s (B05, rpc, text cap): whole stdout");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "text_delta");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the body was cut inside the key body");
	assert.ok(out.events.indexOf(released[0]) < out.events.indexOf(deltas.at(-1)), "at the bound, before the block's later deltas");
});

test("rpc 206s (B05): a text block cut inside an angle value at the byte bound goes out as the placeholder: no raw secret byte reaches stdout", async () => {
	const set = holdLimitsSetter();
	const { secret, body, lines, cutBytes } = angleCutCase();
	assert.ok(vinciMaskSecrets(body).includes(secret), "fixture sanity: the cut body alone is not masked");
	const { events } = streamEvents(lines);
	set({ maxBytes: cutBytes });
	let out;
	try {
		out = await runRpc(events);
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206s (B05, rpc, angle-cut text cap)");
	assertNoRawSecretInLines(out, secret, "206s (B05, rpc, angle-cut text cap)");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "text_delta");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the body was cut inside the angle value");
	assert.ok(out.events.indexOf(released[0]) < out.events.indexOf(deltas.at(-1)), "at the bound, before the block's later deltas");
});

test("rpc 206s (B05): a tool call's argument text past the byte bound goes out at once, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const chunk = "x".repeat(256);
	const fragments = ['{"command":"', ...Array.from({ length: 16 }, () => chunk)];
	const { events } = toolCallEvents("bash", fragments, { ending: "none" });
	set({ maxBytes: 1024 });
	let out;
	try {
		out = await runRpc(events);
	} finally {
		set();
	}
	assert.equal(out.exitCode, 0, "206s (B05, rpc, argument cap): the run exits 0");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "toolcall_delta");
	const released = releasedDeltas(out.events, "toolcall");
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the text so far does not parse");
	assert.ok(out.events.indexOf(released[0]) < out.events.indexOf(deltas.at(-1)), "at the bound, before the call's later deltas");
});

test("rpc 206s (B05): a text block held for the deadline (10 minutes, a fake clock) goes out at once, as the placeholder", async () => {
	const set = holdLimitsSetter();
	let now = 0;
	const lines = ["First line.\n", "Second line.\n", "Third line.\n", "Fourth line.\n", "Fifth line.\n"];
	const { events } = streamEvents(lines, { eol: "" });
	const head = events.slice(0, 4);
	const [third, fourth, ...tail] = events.slice(4);
	set({ now: () => now });
	let out;
	try {
		out = await runRpc(head, {
			during: async ({ emit }) => {
				now = 599_999;
				emit(third);
				now = 600_000;
				emit(fourth);
				for (const event of tail) emit(event);
			},
		});
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206s (B05, rpc, deadline)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	// 206t (expectation: more masking): a body cut at the deadline goes out as the placeholder, never as the mask of the
	// text so far.
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the deadline (not before), the placeholder");
});

// 206s (B07): an own "__proto__" key and its data survive the whole-object masker, as JSON.stringify writes them.
test("rpc 206s (B07): an own __proto__ key in tool details, nested and through toJSON, is written as JSON.stringify writes it", async () => {
	for (const [label, details] of [
		["parsed", ownProtoDetails()],
		["through toJSON", { toJSON: () => ownProtoDetails() }],
	]) {
		const events = detailsEvents(details);
		assert.ok(JSON.stringify(events[1]).includes('"__proto__":{"note":"plain preserved data"'), `${label}: fixture sanity: JSON.stringify writes the own key`);
		const out = await runRpc(events);
		assertCompleted(out, ["tool_execution_end", "message_end"], `206s (B07, rpc, ${label})`);
		const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
		assert.equal(`${line}\n`, serializeJsonLine(events[1]), `${label}: the tool_execution_end line is JSON.stringify's, own __proto__ key and data included`);
	}
});

// 206s (B08): String, Number and Boolean objects are written as their values, as JSON.stringify writes them.
test("rpc 206s (B08): String, Number and Boolean objects in tool details, nested in an array too, are written as JSON.stringify writes them", async () => {
	const events = detailsEvents(boxedDetails());
	assert.ok(JSON.stringify(events[1]).includes('"message":"ordinary boxed message","count":7,"flag":true'), "fixture sanity: JSON.stringify writes the values");
	const out = await runRpc(events);
	assertCompleted(out, ["tool_execution_end", "message_end"], "206s (B08, rpc)");
	const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
	assert.equal(`${line}\n`, serializeJsonLine(events[1]), "the tool_execution_end line is JSON.stringify's");
});

test("rpc 206s (B08): a String or Number object under a secret name is masked as its value is", async () => {
	const secret = fakeSecret();
	const details = { password: new String(secret), list: [{ password: new String(secret) }], auth: { password: new Number(4242) } };
	const plain = { password: secret, list: [{ password: secret }], auth: { password: 4242 } };
	const out = await runRpc(detailsEvents(details));
	assertCompleted(out, ["tool_execution_end", "message_end"], "206s (B08, rpc, secret name)");
	assertNoRawSecret(out.stdout, secret, "206s (B08, rpc, secret name): whole stdout");
	const end = out.events.find((event) => event?.type === "tool_execution_end");
	assert.equal(typeof end?.result?.details?.password, "string", "written as a string, as JSON.stringify writes it");
	assert.deepEqual(end.result.details, JSON.parse(JSON.stringify(vinciMaskJson(plain))), "masked as the values are masked under their names");
});

// ---------------------------------------------------------------------------------------------------
// 206t: review findings D01..D05 through runRpcMode. Inputs are the review probes', byte for byte. Each row asserts the
// run completed, and fails on the code before 206t by an assertion (a cut token byte on stdout, retained bytes over the
// bound, a lost update, an output that differs from JSON.stringify's), never by a crash.
// ---------------------------------------------------------------------------------------------------

const {
	assertNoPrefixBytes,
	boundedInputs,
	checkpointUpdate,
	crossRealmBoxed,
	earlyCutCases,
	multiByteStartEvents,
	overriddenBoxed,
	probeCallEvents,
	probeTextMessage,
	probeTextUpdate,
	retainedStringBytes,
	tokenPrefixCase,
	tokenPrefixUpdate,
	toolEnd,
} = await import("./lib/stream-masking-fixtures.mjs");
const vm = await import("node:vm");

/** 206t (D01): the cut token alone is not masked, and the whole token masks to its 4-character head (positive control). */
function tokenControl(where) {
	const { prefix, full, tail } = tokenPrefixCase();
	assert.equal(vinciMaskSecrets(prefix), prefix, `${where}: fixture sanity: the cut token alone is not masked`);
	const masked = vinciMaskSecrets(full);
	assert.ok(masked.startsWith(prefix.slice(0, 4)) && masked.includes(PLACEHOLDER), `${where}: positive control: the whole token masks to its head`);
	assertNoPrefixBytes(masked, tail, `${where}: positive control`);
	return { prefix, full, tail };
}

/** 206t: the written updates of `toolCallId` that carry anything (content or details), not the held empty shape. */
const keptReleases = (events, toolCallId) =>
	events.filter(
		(event) =>
			event?.type === "tool_execution_update" &&
			event.toolCallId === toolCallId &&
			(JSON.stringify(event.partialResult?.content ?? []) !== "[]" || JSON.stringify(event.partialResult?.details ?? {}) !== "{}"),
	);

const otherToolUpdate = () => ({ type: "tool_execution_update", toolCallId: "other", partialResult: { content: [] } });

/** 206t: a masker of the event path's kind, for measuring what it keeps. */
const newStreamMask = () => new streamMaskModule.VinciStreamMask();

// 206t (D01): a body cut before its natural end (a bound, the deadline, the end of input, an error-only end) goes out as
// the placeholder, never as the mask of its prefix.
test("rpc 206t (D01): a token cut below its minimum length at a text block's byte bound goes out as the placeholder: no byte past its head reaches stdout", async () => {
	const set = holdLimitsSetter();
	const { prefix, full, tail } = tokenControl("206t (D01, rpc, text cap)");
	const { events } = streamEvents([prefix, full.slice(prefix.length)], { eol: "" });
	set({ maxBytes: 16 });
	let out;
	try {
		out = await runRpc(events);
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D01, rpc, text cap): whole stdout");
	assertCompleted(out, ["message_end"], "206t (D01, rpc, text cap)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the bound, the placeholder");
	const end = out.events.find((event) => event?.type === "message_end");
	assert.equal(fieldOf(end.message), vinciMaskSecrets(full), "positive control: message_end carries the whole token, masked to its head");
});

test("rpc 206t (D01): a token cut below its minimum length at a text block's deadline (a fake clock) goes out as the placeholder: no byte past its head reaches stdout", async () => {
	const set = holdLimitsSetter();
	const { prefix, full, tail } = tokenControl("206t (D01, rpc, text deadline)");
	const cut = probeTextMessage(prefix);
	const whole = probeTextMessage(full);
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	try {
		out = await runRpc([{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(cut, prefix)], {
			during: async ({ emit }) => {
				now = 101;
				emit(probeTextUpdate(cut, ""));
				emit(probeTextUpdate(whole, full.slice(prefix.length)));
				emit({ type: "message_update", message: whole, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: full, partial: whole } });
				emit({ type: "message_end", message: whole });
			},
		});
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D01, rpc, text deadline): whole stdout");
	assertCompleted(out, ["message_end"], "206t (D01, rpc, text deadline)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the deadline, the placeholder");
	const end = out.events.find((event) => event?.type === "message_end");
	assert.equal(fieldOf(end.message), vinciMaskSecrets(full), "positive control: message_end carries the whole token, masked to its head");
});

test("rpc 206t (D01): a token cut below its minimum length when input ends before its block ends goes out as the placeholder: no byte past its head reaches stdout", async () => {
	const { prefix, tail } = tokenControl("206t (D01, rpc, text end of input)");
	const cut = probeTextMessage(prefix);
	const out = await runRpc([{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(cut, prefix)]);
	assertNoPrefixBytes(out.stdout, tail, "206t (D01, rpc, text end of input): whole stdout");
	assert.equal(out.exitCode, 0, "206t (D01, rpc, text end of input): the run exits 0");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release, at the end of input");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the block was cut before its end");
});

/** 206t (D01): a probe message that ended with `stopReason`. */
const endedWith = (text, stopReason) => ({ ...probeTextMessage(text), stopReason });

/**
 * 206t (D01): `text` streamed as one text block with no text_end, then a cut: a source `error` event (`withError`) and
 * message_end, or message_end alone, of a message that ended with `stopReason`; then agent_end carrying it.
 */
function earlyEndEvents(text, stopReason, withError) {
	const ended = endedWith(text, stopReason);
	const events = [{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(probeTextMessage(text), text)];
	if (withError) events.push({ type: "message_update", message: ended, assistantMessageEvent: { type: "error", reason: "error", error: ended } });
	events.push({ type: "message_end", message: ended }, { type: "agent_end", messages: [ended] });
	return events;
}

/** 206t (D01): the block's text in each final event written: the `error` event's message, message_end, agent_end. */
const finalTexts = (events) =>
	events.flatMap((event) => {
		if (event?.assistantMessageEvent?.type === "error") return [["error", fieldOf(event.assistantMessageEvent.error)]];
		if (event?.type === "message_end") return [["message_end", fieldOf(event.message)]];
		if (event?.type === "agent_end") return (event.messages ?? []).map((message) => ["agent_end", fieldOf(message)]);
		return [];
	});

const EARLY_ENDINGS = [
	["at a source error event", "error", true],
	["at message_end with stopReason aborted and no text_end", "aborted", false],
	["at message_end with stopReason length and no text_end", "length", false],
];

// #207 closure rows: a stream cut (error or length) while a completed line ending in "-" or "_" is still held
// must replace the held text with the placeholder, whole; no raw byte of it is written before the cut. Benign text,
// so the placeholder does not depend on the masker recognising a secret.
for (const [variant, body, stopReason, withError] of [
	["length, -", "see the release-candidate-\nnotes", "length", false],
	["error, -", "see the release-candidate-\nnotes", "error", true],
	["length, _", "see the release_candidate_\nnotes", "length", false],
]) {
	test(`rpc 207 (S-R1n, ${variant}): a held line is cut as one placeholder, never raw`, async () => {
		const where = `207 (S-R1n, rpc, ${variant})`;
		const out = await runRpc(earlyEndEvents(body, stopReason, withError));
		assertCompleted(out, ["message_end", "agent_end"], where);
		assert.ok(!out.stdout.includes("see the release"), `${where}: no raw byte of the held line reaches stdout`);
		const released = releasedDeltas(out.events);
		assert.equal(released.length, 1, `${where}: one release`);
		assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, `${where}: the placeholder, whole`);
		assert.equal(out.events.indexOf(released[0]), 2, `${where}: the release is at index 2`);
		const endAt = out.events.findIndex((event) => withError ? event.assistantMessageEvent?.type === "error" : event.type === "message_end");
		assert.equal(endAt, 3, `${where}: ${withError ? "error" : "message_end"} follows at index 3`);
		assert.equal(deltasOf(out.events.slice(0, 2)), "", `${where}: nothing is released before index 2`);
		for (const [type, shown] of finalTexts(out.events)) assert.equal(shown, PLACEHOLDER, `${where}: ${type} shows the placeholder, whole`);
	});
}

// Pins #207's releasesWhole path for a complete value; missing indexes keep the call interrupted.
// Its toolcall_end retains complete JSON, so closedValueStrings marks the value complete at the length cut.
test("rpc 207 (S-T1, length): a complete tool-call argument ending in \"-\" and a line break is the placeholder in a cut call", async () => {
	const where = "207 (S-T1, rpc, length)";
	const args = { command: "see the release-\n" };
	const json = JSON.stringify(args);
	const { events, final } = toolCallEvents("bash", fragmentsOf(json, toolFragment), {
		index: "missing",
		stopReason: "length",
		finals: true,
		keepPartialOnEnd: true,
	});
	assert.deepEqual(final?.content?.[0]?.arguments, args, "fixture sanity: the cut call carries the complete argument value");
	assert.equal(final?.content?.[0]?.partialJson, json, "fixture sanity: retained JSON closes the argument value");
	const out = await runRpc(events);
	assertCompleted(out, ["message_end", "turn_end", "agent_end"], where);
	const end = out.events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
	assert.equal(end?.assistantMessageEvent?.toolCall?.arguments?.command, PLACEHOLDER, `${where}: the complete value is the placeholder`);
	assert.ok(!out.stdout.includes("see the release"), `${where}: no raw argument value reaches stdout`);
});

for (const [ch, where] of [
	["-", "207 (S-G1, rpc, -)"],
	["_", "207 (S-G1, rpc, _)"],
]) {
	test(`rpc 207 (S-G1, control): a line ending in "${ch}" is released unchanged at text_end`, async () => {
		const { events, text: body } = streamEvents([`build step${ch}`, " done"], { eol: "" });
		const out = await runRpc(events);
		assertCompleted(out, ["message_end"], where);
		assert.equal(deltasOf(out.events.slice(0, 4)), "", `${where}: nothing is released before index 4`);
		const released = releasedDeltas(out.events);
		assert.equal(released.length, 1, `${where}: one release`);
		assert.equal(out.events.indexOf(released[0]), 4, `${where}: the release is at index 4`);
		const endAt = out.events.findIndex((event) => event.assistantMessageEvent?.type === "text_end");
		assert.equal(endAt, 5, `${where}: text_end follows at index 5`);
		assert.equal(released[0].assistantMessageEvent.delta, body, `${where}: the full body is released byte-identical`);
		assert.equal(out.events[endAt].assistantMessageEvent.content, body, `${where}: text_end carries the full body`);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(fieldOf(end.message), body, `${where}: message_end carries the full body`);
	});
}

test("rpc 207 (S-C1/E3, control): benign prose ending in a dash is released unchanged at text_end", async () => {
	const { events, text } = streamEvents(["see the release-candidate-", "then read the notes."]);
	const out = await runRpc(events);
	assertCompleted(out, ["message_end"], "207 (S-C1/E3, rpc)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	const endAt = out.events.findIndex((event) => event.assistantMessageEvent?.type === "text_end");
	assert.equal(out.events.indexOf(released[0]), 4, "released at the natural block end, at the existing event index");
	assert.equal(endAt, 5, "text_end immediately follows the release");
	assert.equal(deltasOf(out.events.slice(0, 4)), "", "held until text_end");
	assert.equal(released[0].assistantMessageEvent.delta, text, "the whole body is byte-identical");
	assert.equal(out.events[endAt].assistantMessageEvent.content, text, "text_end carries the unchanged body");
	const end = out.events.find((event) => event.type === "message_end");
	assert.equal(fieldOf(end.message), text, "message_end carries the unchanged body");
});

// 206t (D01): a block cut by an error, an abort or the length limit keeps its complete lines (those the hold-back
// releases, masked as one body) and ends with the placeholder for the unfinished part; no byte of the cut token, an
// open key block, an open ${ or an open angle value reaches stdout, whole.
for (const [ending, stopReason, withError] of EARLY_ENDINGS) {
	for (const { label, text, head, startsWith, forbidden } of earlyCutCases()) {
		test(`rpc 206t (D01): ${label}, ${ending}: the complete lines go out masked, then the placeholder; no byte past the token's head reaches stdout`, async () => {
			const where = `206t (D01, rpc, ${label}, ${ending})`;
			const { tail } = tokenControl(where);
			const out = await runRpc(earlyEndEvents(text, stopReason, withError));
			assertCompleted(out, ["message_end", "agent_end"], where);
			assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
			for (const part of forbidden) assert.ok(!out.stdout.includes(part), `${where}: ${JSON.stringify(part.slice(0, 12))} reached stdout`);
			const released = releasedDeltas(out.events);
			assert.equal(released.length, 1, `${where}: one release`);
			const delta = released[0].assistantMessageEvent.delta;
			if (head !== undefined) assert.equal(delta, `${vinciMaskSecrets(head)}${PLACEHOLDER}`, `${where}: the complete lines, masked, then the placeholder`);
			else {
				assert.ok(delta.startsWith(startsWith), `${where}: the complete lines before the open value are kept`);
				assert.ok(delta.endsWith(PLACEHOLDER), `${where}: then the placeholder`);
			}
		});
	}
}

for (const [ending, stopReason, withError] of EARLY_ENDINGS) {
	test(`rpc 206t (D01): a block cut ${ending}: every final event shows the block exactly as its streamed deltas wrote it`, async () => {
		const where = `206t (D01, rpc, final equals streamed, ${ending})`;
		const { tail } = tokenControl(where);
		const { text } = earlyCutCases()[1];
		const out = await runRpc(earlyEndEvents(text, stopReason, withError));
		assertCompleted(out, ["message_end", "agent_end"], where);
		assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
		const streamed = deltasOf(out.events);
		assert.ok(streamed.includes("Here it is:") && streamed.endsWith(PLACEHOLDER), `${where}: fixture sanity: complete lines, then the placeholder`);
		const finals = finalTexts(out.events);
		assert.equal(finals.length, withError ? 3 : 2, `${where}: the final events are written`);
		for (const [type, shown] of finals) assert.equal(shown, streamed, `${where}: ${type} shows the block as the stream wrote it`);
	});
}

test("rpc 206t (D01): multi-line control: a full token on an earlier complete line is masked to its head and its lines stay; the cut last line is the placeholder", async () => {
	const where = "206t (D01, rpc, multi-line control)";
	const { full, tail } = tokenControl(where);
	const out = await runRpc(earlyEndEvents(earlyCutCases()[1].text, "aborted", false));
	assertCompleted(out, ["message_end"], where);
	assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
	const streamed = deltasOf(out.events);
	assert.ok(streamed.startsWith("Here it is:\nThe old token was "), `${where}: the complete lines stay`);
	assert.ok(streamed.includes(`${vinciMaskSecrets(full)}.\n`), `${where}: the full token is masked to its head`);
	assert.ok(streamed.endsWith(`.\n${PLACEHOLDER}`), `${where}: the cut last line is the placeholder`);
});

test("rpc 206t (D01): positive control: a message that ended normally (done, stopReason stop, no text_end) releases the whole token masked to its head, not the placeholder", async () => {
	const where = "206t (D01, rpc, done stop)";
	const { full, tail } = tokenControl(where);
	const whole = endedWith(full, "stop");
	const out = await runRpc([
		{ type: "message_start", message: probeTextMessage("") },
		probeTextUpdate(whole, full),
		{ type: "message_update", message: whole, assistantMessageEvent: { type: "done", reason: "stop", message: whole } },
		{ type: "message_end", message: whole },
	]);
	assertCompleted(out, ["message_end"], where);
	assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, vinciMaskSecrets(full), "masked whole, not the placeholder");
	assert.notEqual(released[0].assistantMessageEvent.delta, PLACEHOLDER, "not the placeholder");
});

test("rpc 206t (D01): a block of an early-ended message that never streamed a delta goes out in the cut form: no byte past the token's head reaches stdout", async () => {
	const where = "206t (D01, rpc, never streamed)";
	const { prefix, tail } = tokenControl(where);
	const ended = endedWith(prefix, "aborted");
	const out = await runRpc([
		{ type: "message_start", message: probeTextMessage("") },
		{ type: "message_end", message: ended },
		{ type: "agent_end", messages: [ended] },
	]);
	assertCompleted(out, ["message_end", "agent_end"], where);
	assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
	assert.equal(deltasOf(out.events), PLACEHOLDER, `${where}: one delta, the placeholder`);
	for (const [type, shown] of finalTexts(out.events)) assert.equal(shown, PLACEHOLDER, `${where}: ${type} shows the block as the stream wrote it`);
});

/** 206t (D01): an RPC session holding one message: get_messages, get_entries and get_tree all hand it back. */
function cutSession(message) {
	const entry = { type: "message", id: "c1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message };
	const tree = [{ entry, children: [] }];
	return { messages: [message], sessionManager: { getEntries: () => [entry], getTree: () => tree, getLeafId: () => "c1" } };
}

/** 206t (D01): the block's text in each transcript response: get_messages, get_entries, get_tree. */
async function transcriptTexts(send) {
	const messages = (await send({ type: "get_messages" })).response.data.messages;
	const entries = (await send({ type: "get_entries" })).response.data.entries;
	const tree = (await send({ type: "get_tree" })).response.data.tree;
	return [
		["get_messages", fieldOf(messages[0])],
		["get_entries", fieldOf(entries[0].message)],
		["get_tree", fieldOf(tree[0].entry.message)],
	];
}

// 206t (D01): the transcript responses are stdout too. A block cut by an error, an abort or the length limit is shown
// there in the cut form, computed from the message alone: the same text the stream wrote, before and after a reload.
// The reload is a second RPC mode over a JSON copy of the session (what reading the session file gives: fresh objects,
// no stream state and no object the first mode saw); this harness has no session file of its own.
for (const [ending, stopReason, withError] of EARLY_ENDINGS) {
	for (const { label, text, forbidden } of earlyCutCases()) {
		test(`rpc 206t (D01): ${label}, ${ending}: get_messages, get_entries and get_tree show the block as the stream wrote it, before and after a reload; no byte past the token's head reaches stdout`, async () => {
			const where = `206t (D01, rpc transcript, ${label}, ${ending})`;
			const { tail } = tokenControl(where);
			const events = earlyEndEvents(text, stopReason, withError);
			const ended = events.find((event) => event.type === "message_end").message;
			let before;
			const out = await runRpc(events, {
				state: cutSession(ended),
				during: async ({ send }) => {
					before = await transcriptTexts(send);
				},
			});
			assertCompleted(out, ["message_end", "agent_end"], where);
			assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
			let after;
			const reloaded = await runRpc([], {
				state: cutSession(JSON.parse(JSON.stringify(ended))),
				during: async ({ send }) => {
					after = await transcriptTexts(send);
				},
			});
			assertNoPrefixBytes(reloaded.stdout, tail, `${where}: whole stdout after the reload`);
			for (const part of forbidden) {
				assert.ok(!out.stdout.includes(part) && !reloaded.stdout.includes(part), `${where}: ${JSON.stringify(part.slice(0, 12))} reached stdout`);
			}
			const streamed = deltasOf(out.events);
			assert.ok(streamed.endsWith(PLACEHOLDER), `${where}: fixture sanity: the stream wrote the cut form`);
			for (const [command, shown] of before) assert.equal(shown, streamed, `${where}: ${command} shows the block as the stream wrote it`);
			for (const [command, shown] of after) assert.equal(shown, streamed, `${where}: ${command} after the reload shows the block as the stream wrote it`);
		});
	}
}

/** 206t (D01): the session as getLastAssistantText reads it: its text blocks joined, trimmed (cutSession, plus that). */
function lastTextSession(message) {
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	return { ...cutSession(message), lastAssistantText: text || undefined };
}

// 206t (D01): get_last_assistant_text writes to stdout too: a block cut by an error, an abort or the length limit reads
// there as the stream wrote it (the get_messages view), before and after a reload.
for (const [ending, stopReason, withError] of EARLY_ENDINGS) {
	for (const { label, text, forbidden } of earlyCutCases()) {
		test(`rpc 206t (D01): ${label}, ${ending}: get_last_assistant_text reads the block as the stream wrote it, before and after a reload; no byte past the token's head reaches stdout`, async () => {
			const where = `206t (D01, rpc last text, ${label}, ${ending})`;
			const { tail } = tokenControl(where);
			const events = earlyEndEvents(text, stopReason, withError);
			const ended = events.find((event) => event.type === "message_end").message;
			let before;
			const out = await runRpc(events, {
				state: lastTextSession(ended),
				during: async ({ send }) => {
					before = (await send({ type: "get_last_assistant_text" })).response.data.text;
				},
			});
			assertCompleted(out, ["message_end", "agent_end"], where);
			assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
			let after;
			const reloaded = await runRpc([], {
				state: lastTextSession(JSON.parse(JSON.stringify(ended))),
				during: async ({ send }) => {
					after = (await send({ type: "get_last_assistant_text" })).response.data.text;
				},
			});
			assertNoPrefixBytes(reloaded.stdout, tail, `${where}: whole stdout after the reload`);
			for (const part of forbidden) {
				assert.ok(!out.stdout.includes(part) && !reloaded.stdout.includes(part), `${where}: ${JSON.stringify(part.slice(0, 12))} reached stdout`);
			}
			const streamed = deltasOf(out.events);
			assert.ok(streamed.endsWith(PLACEHOLDER), `${where}: fixture sanity: the stream wrote the cut form`);
			assert.equal(before, streamed, `${where}: get_last_assistant_text reads the block as the stream wrote it`);
			assert.equal(after, streamed, `${where}: get_last_assistant_text after the reload reads the block as the stream wrote it`);
		});
	}
}

/**
 * 206t (D01): a thinking block still open (no thinking_end) while a later text block streams (no text_end), then the
 * message ends early. Each block ends in the cut token.
 */
function thinkingThenTextEvents(stopReason, withError) {
	const { prefix } = tokenPrefixCase();
	const thinking = `Let me check.\n${prefix}`;
	const text = `The answer follows.\n${prefix}`;
	const message = (thinkingText, textText, reason = "stop") => ({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: thinkingText },
			{ type: "text", text: textText },
		],
		stopReason: reason,
	});
	const ended = message(thinking, text, stopReason);
	const afterThinking = message(thinking, "");
	const afterText = message(thinking, text);
	const events = [
		{ type: "message_start", message: message("", "") },
		{ type: "message_update", message: afterThinking, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinking, partial: afterThinking } },
		{ type: "message_update", message: afterText, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: text, partial: afterText } },
	];
	if (withError) events.push({ type: "message_update", message: ended, assistantMessageEvent: { type: "error", reason: "error", error: ended } });
	events.push({ type: "message_end", message: ended }, { type: "agent_end", messages: [ended] });
	return { events, ended };
}

for (const [ending, stopReason, withError] of EARLY_ENDINGS) {
	test(`rpc 206t (D01): a thinking block still open while a later text block streams, cut ${ending}: it goes out in the cut form, and the final events and get_messages show it so, before and after a reload; no byte past the token's head reaches stdout`, async () => {
		const where = `206t (D01, rpc, open thinking before text, ${ending})`;
		const { tail } = tokenControl(where);
		const { events, ended } = thinkingThenTextEvents(stopReason, withError);
		let before;
		const out = await runRpc(events, {
			state: cutSession(ended),
			during: async ({ send }) => {
				before = (await send({ type: "get_messages" })).response.data.messages[0];
			},
		});
		assertCompleted(out, ["message_end", "agent_end"], where);
		assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
		let after;
		const reloaded = await runRpc([], {
			state: cutSession(JSON.parse(JSON.stringify(ended))),
			during: async ({ send }) => {
				after = (await send({ type: "get_messages" })).response.data.messages[0];
			},
		});
		assertNoPrefixBytes(reloaded.stdout, tail, `${where}: whole stdout after the reload`);
		const thinking = deltasOf(out.events, "thinking");
		assert.equal(thinking, `${vinciMaskSecrets("Let me check.\n")}${PLACEHOLDER}`, `${where}: the thinking block's complete lines, masked, then the placeholder`);
		assert.equal(deltasOf(out.events), `${vinciMaskSecrets("The answer follows.\n")}${PLACEHOLDER}`, `${where}: the text block too`);
		const finals = out.events.flatMap((event) => {
			if (event?.assistantMessageEvent?.type === "error") return [event.assistantMessageEvent.error];
			if (event?.type === "message_end") return [event.message];
			if (event?.type === "agent_end") return event.messages ?? [];
			return [];
		});
		assert.equal(finals.length, withError ? 3 : 2, `${where}: the final events are written`);
		for (const message of finals) assert.equal(fieldOf(message, "thinking"), thinking, `${where}: a final event shows the thinking block as the stream wrote it`);
		assert.equal(fieldOf(before, "thinking"), thinking, `${where}: get_messages shows the thinking block as the stream wrote it`);
		assert.equal(fieldOf(after, "thinking"), thinking, `${where}: get_messages after the reload shows the thinking block as the stream wrote it`);
	});
}

for (const [label, ending, limits] of [
	["at the byte bound", "end", { maxBytes: 16 }],
	["at the end of input (no tool end)", "none", undefined],
	["before an error-only tool end", "error", undefined],
]) {
	test(`rpc 206t (D01): a tool's progress that is a token cut below its minimum length, ${label}, goes out as the placeholder: no byte past its head reaches stdout`, async () => {
		const set = holdLimitsSetter();
		const where = `206t (D01, rpc, progress ${label})`;
		const { full, tail } = tokenControl(where);
		const events = [tokenPrefixUpdate()];
		if (ending === "end") events.push(toolEnd("token-prefix", full));
		if (ending === "error") events.push(toolEnd("token-prefix", "operation aborted.", { isError: true }));
		if (limits) set(limits);
		let out;
		try {
			out = await runRpc(events);
		} finally {
			set();
		}
		assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
		assertCompleted(out, ending === "none" ? [] : ["tool_execution_end"], where);
		const released = releasedUpdates(out.events);
		assert.equal(released.length, 1, "the kept progress is written once");
		assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
		if (ending === "end") {
			const end = out.events.find((event) => event?.type === "tool_execution_end");
			assert.equal(end.result.content[0].text, vinciMaskSecrets(full), "positive control: the tool end carries the whole token, masked to its head");
		}
	});
}

// 206t (D02): the byte bound counts what is kept for a held body (its UTF-8 bytes, details and control bytes included), and
// after the bound nothing raw of it is kept. The kept bytes are measured on the masker itself.
for (const [label, key] of [
	["ordinary text with large details", "largeDetails"],
	["details only", "detailsOnly"],
]) {
	test(`rpc 206t (D02): a tool's progress past the byte bound by its details (${label}) goes out at once as the placeholder, and is not kept`, async () => {
		const set = holdLimitsSetter();
		const inputs = boundedInputs();
		const update = inputs[key];
		set({ maxBytes: 1024 });
		let out;
		let retained;
		try {
			out = await runRpc([update]);
			const stream = newStreamMask();
			stream.process(update);
			retained = retainedStringBytes(stream);
		} finally {
			set();
		}
		assert.ok(!out.stdout.includes(inputs.payload.slice(0, 64)), `206t (D02, rpc, ${label}): the details past the bound never reach stdout`);
		assert.ok(retained <= 1024, `the masker keeps at most the bound (${retained} bytes kept)`);
		assert.equal(out.exitCode, 0, `206t (D02, rpc, ${label}): the run exits 0`);
		const lines = out.events.filter((event) => event?.type === "tool_execution_update");
		const released = keptReleases(out.events, update.toolCallId);
		assert.equal(released.length, 1, "one release");
		assert.equal(lines.indexOf(released[0]), 0, "at once: the update itself");
		assert.equal(released[0].partialResult.content[0]?.text, PLACEHOLDER, "as the placeholder");
		assert.deepEqual(released[0].partialResult.details, {}, "its details are not written");
	});
}

test("rpc 206t (D02): a tool's progress past the byte bound by control bytes the normaliser removes goes out at once as the placeholder, and is not kept", async () => {
	const set = holdLimitsSetter();
	const { controls } = boundedInputs();
	set({ maxBytes: 1024 });
	let out;
	let retained;
	try {
		out = await runRpc([controls]);
		const stream = newStreamMask();
		stream.process(controls);
		retained = retainedStringBytes(stream);
	} finally {
		set();
	}
	assert.ok(retained <= 1024, `206t (D02, rpc, controls): the masker keeps at most the bound (${retained} bytes kept)`);
	assert.equal(out.exitCode, 0, "206t (D02, rpc, controls): the run exits 0");
	const lines = out.events.filter((event) => event?.type === "tool_execution_update");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(lines.indexOf(released[0]), 0, "at once: the update itself");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
});

test("rpc 206t (D02): a text block past the byte bound in UTF-8 bytes but not in UTF-16 units, with no delta of its own, goes out at once as the placeholder", async () => {
	const set = holdLimitsSetter();
	const { body, events } = multiByteStartEvents();
	assert.ok(body.length <= 1024 && Buffer.byteLength(body, "utf8") > 1024, "fixture sanity: under the bound in UTF-16 units, past it in UTF-8 bytes");
	set({ maxBytes: 1024 });
	let out;
	let retained;
	try {
		out = await runRpc(events);
		const stream = newStreamMask();
		for (const event of events.slice(0, 2)) stream.process(event);
		retained = retainedStringBytes(stream);
	} finally {
		set();
	}
	assert.ok(retained <= 1024, `206t (D02, rpc, multi-byte): the masker keeps at most the bound (${retained} bytes kept)`);
	assertCompleted(out, ["message_end"], "206t (D02, rpc, multi-byte)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "as the placeholder");
	const textEnd = out.events.findIndex((event) => event?.assistantMessageEvent?.type === "text_end");
	assert.ok(out.events.indexOf(released[0]) < textEnd, "at the bound, before the block's end");
});

test("rpc 206t (D02): a call's cumulative argument text past the byte bound is not kept after the bound (no raw cumulative message)", async () => {
	const set = holdLimitsSetter();
	const { callDeltas } = boundedInputs();
	const events = probeCallEvents(callDeltas);
	set({ maxBytes: 1024 });
	let out;
	let retained;
	try {
		out = await runRpc(events);
		const stream = newStreamMask();
		for (const event of events) stream.process(event);
		retained = retainedStringBytes(stream);
	} finally {
		set();
	}
	assert.ok(retained <= 1024, `206t (D02, rpc, cumulative arguments): the masker keeps at most the bound (${retained} bytes kept)`);
	assert.ok(!out.stdout.includes("x".repeat(64)), "the held argument text never reaches stdout");
	assert.equal(out.exitCode, 0, "206t (D02, rpc, cumulative arguments): the run exits 0");
	const released = releasedDeltas(out.events, "toolcall");
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the bound, the placeholder");
});

// 206t (D03): no timer. The deadline of every held body is checked on every event, of any type; a silent stream holds
// until the next event or the end.
test("rpc 206t (D03): a text block's deadline (a fake clock) is checked on an unrelated event: the block goes out at that event, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const text = probeTextMessage("ordinary.");
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	try {
		out = await runRpc([{ type: "message_start", message: text }, probeTextUpdate(text, "ordinary.")], {
			during: async ({ emit }) => {
				now = 101;
				emit(otherToolUpdate());
				emit({ type: "message_update", message: text, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ordinary.", partial: text } });
				emit({ type: "message_end", message: text });
			},
		});
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206t (D03, rpc, unrelated event)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	const other = out.events.findIndex((event) => event?.type === "tool_execution_update");
	assert.ok(other > 0 && out.events.indexOf(released[0]) < other, "released at the unrelated event, before it is written");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "as the placeholder");
});

test("rpc 206t (D03): in a tool-update-only stream a kept partial result's deadline is checked on another tool's update; it goes out then, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const { tail } = tokenControl("206t (D03, rpc, tool updates only)");
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	try {
		out = await runRpc([tokenPrefixUpdate()], {
			during: async ({ emit }) => {
				now = 101;
				emit(otherToolUpdate());
			},
		});
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D03, rpc, tool updates only): whole stdout");
	assert.equal(out.exitCode, 0, "206t (D03, rpc, tool updates only): the run exits 0");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	assert.equal(released[0].toolCallId, "token-prefix", "for its tool call");
	const other = out.events.findIndex((event) => event?.toolCallId === "other");
	assert.ok(other > 0 && out.events.indexOf(released[0]) < other, "at the other tool's update, before it is written");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
});

test("rpc 206t (D03): a text block held past its deadline with no later event releases nothing while the stream is silent, then goes out at the end as the placeholder", async () => {
	const set = holdLimitsSetter();
	const { prefix, tail } = tokenControl("206t (D03, rpc, silent)");
	const cut = probeTextMessage(prefix);
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	let silent;
	try {
		out = await runRpc([{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(cut, prefix)], {
			during: async ({ stdout }) => {
				now = 10_000;
				await waitForRawStdoutBackpressure();
				silent = stdout();
			},
		});
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D03, rpc, silent): whole stdout");
	assert.equal(out.exitCode, 0, "206t (D03, rpc, silent): the run exits 0");
	assert.equal(deltasOf(parseLines(silent)), "", "nothing is released while the stream is silent");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release, at the end");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "as the placeholder");
});

// 206t (D04): an end supersedes a kept partial result only when it carries all of it (text, details and other fields,
// normalised and masked); otherwise the kept update goes out once, before the end, as the placeholder.
for (const [label, end] of [
	["an error-only tool end", () => toolEnd("details-only", "operation aborted.", { isError: true, details: {}, toolName: "bash" })],
	["a tool end without its details", () => toolEnd("details-only", "done.", { details: {}, toolName: "bash" })],
	["the end of input (no tool end)", undefined],
]) {
	test(`rpc 206t (D04): a details-only checkpoint, then ${label}: the kept update goes out once, before it, as the placeholder`, async () => {
		const where = `206t (D04, rpc, details-only, ${label})`;
		const out = await runRpc([checkpointUpdate(), ...(end ? [end()] : [])]);
		assertCompleted(out, end ? ["tool_execution_end"] : [], where);
		const released = keptReleases(out.events, "details-only");
		assert.equal(released.length, 1, `${where}: the kept update is written once, not lost`);
		if (end) {
			const endAt = out.events.findIndex((event) => event?.type === "tool_execution_end");
			assert.ok(out.events.indexOf(released[0]) < endAt, "before the tool end");
		}
		assert.equal(released[0].partialResult.content[0]?.text, PLACEHOLDER, "as the placeholder: a kept partial result is never released raw");
		assert.deepEqual(released[0].partialResult.details, {}, "its details are not written");
	});
}

test("rpc 206t (D04): progress whose text the end repeats but whose details differ goes out once, before the end, as the placeholder; with equal details it does not", async () => {
	const update = (details) => ({
		type: "tool_execution_update",
		toolCallId: "stage",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "step one." }], details },
	});
	const end = toolEnd("stage", "step one.", { details: { stage: "second" }, toolName: "bash" });
	const out = await runRpc([update({ stage: "first" }), end]);
	assertCompleted(out, ["tool_execution_end"], "206t (D04, rpc, equal text)");
	const released = keptReleases(out.events, "stage");
	assert.equal(released.length, 1, "the kept update is written once, not lost");
	const endAt = out.events.findIndex((event) => event?.type === "tool_execution_end");
	assert.ok(out.events.indexOf(released[0]) < endAt, "before the tool end");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
	const same = await runRpc([update({ stage: "second" }), end]);
	assertCompleted(same, ["tool_execution_end"], "206t (D04, rpc, equal payload)");
	assert.equal(keptReleases(same.events, "stage").length, 0, "positive control: an end that carries all of it supersedes it");
});

// 206t (D05): boxed values are recognised by their internal brand (any realm) and read with the prototype's own valueOf,
// as JSON.stringify reads them.
test("rpc 206t (D05): String, Number and Boolean objects made in another realm are written as JSON.stringify writes them", async () => {
	const events = detailsEvents(crossRealmBoxed(vm));
	assert.ok(JSON.stringify(events[1]).includes('"message":"ordinary boxed message","count":7,"flag":true'), "fixture sanity: JSON.stringify writes the values");
	const out = await runRpc(events);
	const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
	assert.equal(`${line}\n`, serializeJsonLine(events[1]), "206t (D05, rpc, another realm): the tool_execution_end line is JSON.stringify's");
	assertCompleted(out, ["tool_execution_end", "message_end"], "206t (D05, rpc, another realm)");
});

for (const throwing of [false, true]) {
	const label = throwing ? "throwing" : "overridden";
	test(`rpc 206t (D05): boxed values with ${label} own methods that JSON.stringify does not call are written as JSON.stringify writes them`, async () => {
		const events = detailsEvents(overriddenBoxed({ throwing }));
		const native = serializeJsonLine(events[1]);
		assert.ok(native.includes('"flag":true') && native.includes('"message":"ordinary boxed message"'), "fixture sanity: JSON.stringify reads the own values");
		let thrown;
		const out = await runRpc([], {
			during: async ({ emit }) => {
				for (const event of events) {
					try {
						emit(event);
					} catch (error) {
						thrown = error;
					}
				}
			},
		});
		assert.equal(thrown, undefined, `206t (D05, rpc, ${label}): the writer takes every event (no own method is called)`);
		const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
		assert.equal(`${line}\n`, native, "the tool_execution_end line is JSON.stringify's");
		assertCompleted(out, ["tool_execution_end", "message_end"], `206t (D05, rpc, ${label})`);
	});
}

for (const { label, whitespace, secret } of angleWhitespaceCases()) {
	for (const separator of [":", "="]) {
		for (const kind of ["text", "thinking"]) {
			for (const streamed of [false, true]) {
				for (const stopReason of ["error", "aborted", "length"]) {
					const name = `rpc 206u (E01): ${label}, ${separator}, ${kind}, streamed=${streamed}, ${stopReason}`;
					test(name, async () => {
						const body = `password${separator}${whitespace}<\n${secret}\n>`;
						const whole = vinciMaskSecrets(body);
						assertNoSecretBytes(whole, [secret.slice(2)], `${name}: whole-body control`);
						assert.ok(whole.includes(`${secret.slice(0, 2)}…${PLACEHOLDER}`), `${name}: normal mask head`);
						const { events, final } = angleEndingEvents(body, kind, streamed, stopReason);
						const replies = [];
						const out = await runRpc(events, {
							state: lastTextSession(final),
							during: async ({ send }) => {
								for (const type of ["get_messages", "get_entries", "get_tree", "get_last_assistant_text"]) {
									replies.push((await send({ type })).response);
								}
							},
						});
						assertCompleted(out, ["message_end", "turn_end", "agent_end"], name);
						assertNoSecretBytes(out.stdout, [secret.slice(2)], name);
						assertNoFiveCharacterSecret(out.stdout, secret.slice(2), name);
						assert.equal(deltasOf(out.events, kind), PLACEHOLDER);
						assert.ok(
							out.events.some(
								(event) => event.assistantMessageEvent?.type === (stopReason === "error" ? "error" : "done"),
							),
						);
						for (const event of finalEventsOf(out.events)) {
							const message = event.type === "agent_end" ? event.messages[0] : event.message;
							assert.equal(fieldOf(message, kind), PLACEHOLDER, `${name}: ${event.type}`);
						}
						assert.equal(replies.length, 4, `${name}: all views answered`);
						for (const reply of replies) assert.equal(reply.success, true, `${name}: ${reply.command}`);
						for (const message of [
							replies[0].data.messages[0],
							replies[1].data.entries[0].message,
							replies[2].data.tree[0].entry.message,
						]) {
							assert.equal(fieldOf(message, kind), PLACEHOLDER, `${name}: transcript body`);
						}
						if (kind === "text") assert.equal(replies[3].data.text, PLACEHOLDER);
						const natural = await runRpc(angleEndingEvents(body, kind, streamed, "stop").events);
						assertCompleted(natural, ["message_end", "agent_end"], `${name}: natural end`);
						assertNoFiveCharacterSecret(natural.stdout, secret.slice(2), `${name}: natural end`);
						const naturalEnd = natural.events.find((event) => event.type === "message_end");
						assert.equal(fieldOf(naturalEnd.message, kind), whole);
						assert.equal(
							streamMaskModule.vinciOpenAngleLine(body, body.length - 1),
							body.lastIndexOf("\n", body.indexOf(separator)) + 1,
						);
					});
				}
			}
		}
	}
}

test("rpc 206u (E01): whitespace-only prefix holds the angle opener", async () => {
	const { secret } = angleWhitespaceCases()[0];
	const body = `${" \n\t".repeat(1700)}<\n${secret}\n>`;
	const out = await runRpc(angleEndingEvents(body, "text", true, "error").events);
	assertCompleted(out, ["message_end", "agent_end"], "206u (E01): whitespace-only prefix");
	assertNoFiveCharacterSecret(out.stdout, secret, "206u (E01): whitespace-only prefix");
	assert.equal(deltasOf(out.events), PLACEHOLDER);
});

test("rpc 206u (E01): second guard alone holds an unclosed angle beyond the old window", async () => {
	const { secret } = angleWhitespaceCases()[0];
	const body = `password=${" ".repeat(5000)}<\n${secret}\n`;
	const { events, final } = angleEndingEvents(body, "text", true, "error");
	const out = await runRpc(events, {
		state: lastTextSession(final),
		during: async ({ send }) => {
			for (const type of ["get_messages", "get_entries", "get_tree", "get_last_assistant_text"]) await send({ type });
		},
	});
	assertCompleted(out, ["message_end", "agent_end"], "206u (E01): second guard alone");
	assertNoFiveCharacterSecret(out.stdout, secret.slice(2), "206u (E01): second guard alone");
	assert.equal(deltasOf(out.events), PLACEHOLDER);
});

for (const { label, blocks, cap, events, secret } of isolatedBodyCases()) {
	const name = `rpc 206u (E02): ${label}`;
	test(name, async () => {
		const set = holdLimitsSetter();
		let out;
		let snapshot;
		set({ maxBytes: cap });
		try {
			const stream = newStreamMask();
			for (const event of events) {
				if (event.type === "message_end") break;
				stream.process(event);
			}
			snapshot = stream.snapshot;
			out = await runRpc(events);
		} finally {
			set();
		}
		assertCompleted(out, ["message_end", "agent_end"], name);
		assertNoFiveCharacterSecret(out.stdout, secret.slice(2), name);
		const sourceEnd = out.events.find((event) => event.assistantMessageEvent?.type === "done");
		assert.ok(sourceEnd, `${name}: source done is written`);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(end.message.stopReason, "stop", `${name}: normal message end`);
		for (const [index, spec] of blocks.entries()) {
			const expected = spec.cut ? PLACEHOLDER : vinciMaskSecrets(spec.text);
			assert.equal(deltasOf(out.events, spec.kind, index), expected, `${name}: block ${index} release`);
			assert.equal(end.message.content[index][spec.kind], expected, `${name}: block ${index} at message_end`);
			if (spec.thinkingSignature) {
				assert.equal(end.message.content[index].thinkingSignature, spec.thinkingSignature);
				assert.equal(snapshot?.content?.[index]?.thinkingSignature, undefined, `${name}: no retained signature`);
			}
			if (!spec.cut) {
				assert.notEqual(expected, PLACEHOLDER, `${name}: the normal body is preserved`);
				if (spec.endOnly) assert.ok(Buffer.byteLength(expected, "utf8") > cap, `${name}: shown text exceeds cap`);
				const at = out.events.findIndex(
					(event) =>
						event.assistantMessageEvent?.type === `${spec.kind}_end` &&
						event.assistantMessageEvent.contentIndex === index,
				);
				assert.ok(at >= 0, `${name}: block ${index} end is written`);
				assert.equal(deltasOf(out.events.slice(0, at), spec.kind, index), expected);
			}
		}
	});
}

for (const kind of ["text", "thinking"]) {
	for (const afterBound of [false, true]) {
		for (const field of ["signature", "unknown string", "unknown containers"]) {
			test(`rpc 206u (E02): ${kind}, ${field}, afterBound=${afterBound}: retained snapshot stays within cap`, async () => {
				const set = holdLimitsSetter();
				const cap = 1024;
				const signatureName = kind === "text" ? "textSignature" : "thinkingSignature";
				const payload = "ordinary opaque data; ".repeat(220);
				const signature = field === "signature" ? payload : "ordinary signature";
				const signed = assistant([{ ...block(kind, "ordinary."), [signatureName]: signature }]);
				if (field === "unknown string") signed.extra = payload;
				if (field === "unknown containers") signed.extra = { [payload]: [new Uint8Array(4096), 17, false] };
				const empty = { ...signed, content: [{ ...signed.content[0], [kind]: "" }] };
				const messages = [...(afterBound ? [assistant([block(kind, "x".repeat(2048))])] : []), empty, signed];
				const events = messages.map((message) => ({
					type: "message_update",
					message,
					assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta: "", partial: message },
				}));
				const final = { ...signed, stopReason: "stop" };
				let out;
				let retained;
				set({ maxBytes: cap });
				try {
					const stream = newStreamMask();
					for (const event of events) stream.process(event);
					retained = retainedStringBytes(stream);
					out = await runRpc(
						[
							...events,
							{
								type: "message_update",
								message: final,
								assistantMessageEvent: { type: "done", reason: "stop", message: final },
							},
							{ type: "message_end", message: final },
							{ type: "agent_end", messages: [final] },
						],
						{
							state: cutSession(final),
							during: async ({ send }) => {
								await send({ type: "get_entries" });
							},
						},
					);
				} finally {
					set();
				}
				assert.ok(retained <= cap, `206u (E02): ${retained} retained bytes exceed ${cap}`);
				assertCompleted(out, ["message_end", "agent_end"], "206u (E02)");
				assert.equal(deltasOf(out.events, kind), PLACEHOLDER, "206u (E02): metadata also triggers the bound");
				const end = out.events.find((event) => event.type === "message_end");
				assert.equal(end.message.content[0][signatureName], signature);
				const source = out.events.find((event) => event.assistantMessageEvent?.type === "done");
				assert.equal(source?.assistantMessageEvent.message.content[0][signatureName], signature);
				const entry = out.events.find((event) => event.command === "get_entries");
				assert.equal(entry?.success, true);
				assert.equal(entry.data.entries[0].message.content[0][signatureName], signature);
			});
		}
	}
}

// 206g (#227): every ECMAScript WhiteSpace and LineTerminator code point that survives normalisation.
// vinci-stream-mask.ts:381-382, vinciNormaliseForMask's .replace(/\r/g, "") removes U+000D before masking.
const gapWhitespaceCases = [
	["U+0009", "\u0009"],
	["U+000A", "\u000a"],
	["U+000B", "\u000b"],
	["U+000C", "\u000c"],
	["U+0020", "\u0020"],
	["U+00A0", "\u00a0"],
	["U+1680", "\u1680"],
	["U+2000", "\u2000"],
	["U+2001", "\u2001"],
	["U+2002", "\u2002"],
	["U+2003", "\u2003"],
	["U+2004", "\u2004"],
	["U+2005", "\u2005"],
	["U+2006", "\u2006"],
	["U+2007", "\u2007"],
	["U+2008", "\u2008"],
	["U+2009", "\u2009"],
	["U+200A", "\u200a"],
	["U+2028", "\u2028"],
	["U+2029", "\u2029"],
	["U+202F", "\u202f"],
	["U+205F", "\u205f"],
	["U+3000", "\u3000"],
	["U+FEFF", "\ufeff"],
];

for (const [label, separator] of gapWhitespaceCases) {
	test(`rpc 206g (#227): writer ${label}`, async () => {
		const where = `206g (#227): ${label}`;
		const { secret } = angleWhitespaceCases()[0];
		const body = `TOKEN=${separator}<\n${secret}\n`;
		const { events } = angleEndingEvents(body, "text", true, "error");
		assert.ok(events.some((event) => event.assistantMessageEvent?.delta === body), `${where}: the open value is streamed`);
		const out = await runRpc(events);
		assertCompleted(out, ["message_end", "turn_end", "agent_end"], where);
		assertNoSecretBytes(out.stdout, [secret], `${where}: no raw byte of the open value reaches stdout`);
		assertNoFiveCharacterSecret(out.stdout, secret, `${where}: no raw byte of the open value reaches stdout`);
		assert.equal(deltasOf(out.events), PLACEHOLDER, `${where}: the angle value stays held`);
		assert.ok(out.events.some((event) => event.assistantMessageEvent?.type === "error"), `${where}: the source cut is written`);
		for (const event of finalEventsOf(out.events)) {
			const message = event.type === "agent_end" ? event.messages[0] : event.message;
			assert.equal(fieldOf(message), PLACEHOLDER, `${where}: ${event.type} holds the open value`);
		}
	});
}

// 206g (#229/#230): isolate each metadata charge from argument bytes, with the same normal-end control.
for (const [issue, metadataOn, label] of [
	["#229", "call", "held call metadata crosses the byte bound"],
	["#230", "message", "message metadata crosses the held call byte bound"],
	["#229/#230", "none", "held call without oversized metadata ends normally"],
]) {
	test(`rpc 206g (${issue}): ${label}`, async () => {
		const where = `206g (${issue})`;
		const set = holdLimitsSetter();
		const cap = 1024;
		const { secret } = angleWhitespaceCases()[0];
		const args = { command: `printf 'TOKEN=${secret}'`, timeout: 30, note: "ordinary arguments" };
		const json = JSON.stringify(args);
		const payload = "opaque metadata; ".repeat(65);
		const callMetadata = metadataOn === "call" ? { thoughtSignature: payload } : {};
		const messageMetadata = metadataOn === "message" ? { providerMetadata: payload } : {};
		const argumentBytes = Buffer.byteLength(json, "utf8");
		const callMetadataBytes = Buffer.byteLength(JSON.stringify(callMetadata), "utf8");
		const messageMetadataBytes = Buffer.byteLength(JSON.stringify(messageMetadata), "utf8");
		assert.ok(argumentBytes >= 80 && argumentBytes <= 160, `${where}: fixture sanity: small arguments are held`);
		if (metadataOn === "call") {
			assert.ok(argumentBytes + messageMetadataBytes < cap, `${where}: fixture sanity: args + message metadata < 1024`);
			assert.ok(argumentBytes + callMetadataBytes > cap, `${where}: fixture sanity: args + call metadata > 1024`);
		} else if (metadataOn === "message") {
			assert.ok(argumentBytes + callMetadataBytes < cap, `${where}: fixture sanity: args + call metadata < 1024`);
			assert.ok(argumentBytes + messageMetadataBytes > cap, `${where}: fixture sanity: args + message metadata > 1024`);
		} else {
			assert.ok(argumentBytes + callMetadataBytes + messageMetadataBytes < cap, `${where}: fixture sanity: the control stays below 1024`);
		}
		const head = probeCallEvents([json]);
		const first = head[0].message;
		head.splice(1, 0, { type: "message_update", message: first, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: first } });
		const held = head.at(-1).message;
		const call = { ...held.content[0], ...callMetadata };
		const message = { ...held, ...messageMetadata, content: [call] };
		const update = { type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message } };
		const final = { ...message, content: [{ ...call, arguments: args }], stopReason: "toolUse" };
		const tail = [
			{ type: "message_update", message: final, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: final.content[0], partial: final } },
			{ type: "message_update", message: final, assistantMessageEvent: { type: "done", reason: "toolUse", message: final } },
			{ type: "message_end", message: final },
			{ type: "agent_end", messages: [final] },
		];
		let out;
		let beforeBound;
		let atBound;
		let retained;
		set({ maxBytes: cap });
		try {
			out = await runRpc(head, {
				during: async ({ emit, stdout }) => {
					await waitForRawStdoutBackpressure();
					beforeBound = parseLines(stdout());
					emit(update);
					await waitForRawStdoutBackpressure();
					atBound = parseLines(stdout());
					for (const event of tail) emit(event);
				},
			});
			const stream = newStreamMask();
			for (const event of head) stream.process(event);
			stream.process(update);
			// Measure before the normal end resets the stream, at the same update observed on stdout.
			retained = retainedStringBytes(stream);
			for (const event of tail) stream.process(event);
		} finally {
			set();
		}
		assert.equal(deltasOf(beforeBound, "toolcall"), "", `${where}: the small call is held before the metadata update`);
		const crossing = atBound.slice(beforeBound.length);
		assert.ok(crossing.some((event) => event.assistantMessageEvent?.type === "toolcall_delta"), `${where}: the metadata update is written`);
		if (metadataOn === "none") {
			assert.notEqual(deltasOf(crossing, "toolcall"), PLACEHOLDER, `${where}: the control is not released as the placeholder at the update`);
			assert.equal(deltasOf(crossing, "toolcall"), "", `${where}: the control stays held at the update`);
			assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(args)), `${where}: the normal end releases the real arguments, masked as usual`);
			const end = out.events.find((event) => event.type === "message_end");
			assert.deepEqual(end?.message.content[0].arguments, vinciMaskJson(args), `${where}: message_end keeps the real arguments, masked as usual`);
		} else {
			assert.equal(deltasOf(crossing, "toolcall"), PLACEHOLDER, `${where}: the call is released as the placeholder at the bound`);
			assert.equal(deltasOf(out.events, "toolcall"), PLACEHOLDER, `${where}: the normal end releases no argument text again`);
		}
		assert.ok(retained <= cap, `${where}: retainedStringBytes(stream) <= 1024 (${retained} bytes kept)`);
		assertNoSecretBytes(out.stdout, [secret], `${where}: no raw argument byte reaches stdout`);
		assertNoFiveCharacterSecret(out.stdout, secret.slice(2), `${where}: no raw argument byte reaches stdout`);
		assertCompleted(out, ["message_end", "agent_end"], where);
		const done = out.events.find((event) => event.assistantMessageEvent?.type === "done");
		assert.equal(done?.assistantMessageEvent.message.stopReason, "toolUse", `${where}: source done ends normally with toolUse`);
		assert.equal(out.events.find((event) => event.type === "message_end")?.message.stopReason, "toolUse", `${where}: message_end ends normally with toolUse`);
	});
}
