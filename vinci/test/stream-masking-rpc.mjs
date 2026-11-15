// Mask streamed output consistently: `--mode rpc` through the production runRpcMode, in process. The session
// is a stand-in whose listener the test drives; stdin is a stream the test ends (the exit path); every
// string written to stdout is recorded. Secret values are synthetic and built at runtime.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertMasked,
	assistant,
	block,
	deltasOf,
	inlineToken,
	PLACEHOLDER,
	secretRuns,
	splitAcross,
	streamEvents,
	toolCallEvents,
} from "./lib/stream-masking-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../../packages");
const { runRpcMode } = await import(resolve(packages, "coding-agent/src/modes/rpc/rpc-mode.ts"));
const { serializeJsonLine } = await import(resolve(packages, "coding-agent/src/modes/rpc/jsonl.ts"));
const { vinciMaskSecrets } = await import(resolve(packages, "coding-agent/src/core/vinci-mask-secrets.ts"));
const { waitForRawStdoutBackpressure } = await import(resolve(packages, "coding-agent/src/core/output-guard.ts"));
const { RpcProcessInstance } = await import(resolve(packages, "orchestrator/src/rpc-process.ts"));

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
 * RPC exit path) and wait for process.exit. `state` stands in for the session's messages and bash result.
 * Returns every stdout line.
 */
async function runRpc(events, { masking = true, during, state = {} } = {}) {
	const saved = process.env.VINCI_CODE;
	if (masking) process.env.VINCI_CODE = "1";
	else delete process.env.VINCI_CODE;
	const stdin = new PassThrough();
	Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
	const realExit = process.exit;
	let exitCode;
	const exited = new Promise((resolveExit) => {
		process.exit = (code) => {
			exitCode = code ?? 0;
			resolveExit();
		};
	});
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
		stdin.end();
		await bounded(exited, 5000, "the RPC mode exits after stdin ends");
		const stdout = capture.join("");
		return {
			stdout,
			exitCode,
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

// Tool-call argument deltas of the tools whose arguments the view masks are held back per tool call.
for (const [label, step] of [
	["two deltas", 0],
	["five deltas", 9],
]) {
	test(`rpc: a value split across ${label} of a bash call never reaches stdout; the placeholder does`, async () => {
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

test("rpc: a pretty-printed bash call released line by line never carries the raw partial argument text", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ command: `echo ${token}`, note: "x" }, null, 2);
	// Each fragment ends at a line break, so completed lines are released while the call streams.
	const fragments = json.split(/(?<=\n)/);
	assert.ok(fragments.length >= 3, "fixture sanity: several lines");
	const { events } = toolCallEvents("bash", fragments);
	const out = await runRpc(events);
	assertMasked(deltasOf(out.events, "toolcall"), [token], "concatenated deltas");
	assertMasked(out.stdout, [token], "whole stdout");
});
