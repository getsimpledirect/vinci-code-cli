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
	inlineToken,
	PLACEHOLDER,
	secretRuns,
	streamEvents,
} from "./lib/stream-masking-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../../packages");
const { runRpcMode } = await import(resolve(packages, "coding-agent/src/modes/rpc/rpc-mode.ts"));
const { serializeJsonLine } = await import(resolve(packages, "coding-agent/src/modes/rpc/jsonl.ts"));
const { vinciMaskSecrets } = await import(resolve(packages, "coding-agent/src/core/vinci-mask-secrets.ts"));
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
 * Run runRpcMode, feed `events` to the session listener, then end stdin (the RPC exit path) and wait for
 * process.exit. Returns every stdout line.
 */
async function runRpc(events, { masking = true } = {}) {
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
	};
	const host = { session, setRebindSession() {}, dispose: async () => {} };
	capture = [];
	try {
		void runRpcMode(host);
		// The mode replaced stdout.write with its redirect; its raw writer is bound to capturingWrite.
		process.stdout.write = capturingWrite;
		for (let i = 0; i < 1000 && !listener; i++) await new Promise((r) => setImmediate(r));
		assert.ok(listener, "the RPC mode subscribed to the session");
		for (const event of events) listener(event);
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

const deltasOf = (events, kind = "text") =>
	events
		.filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === `${kind}_delta`)
		.map((event) => event.assistantMessageEvent.delta)
		.join("");

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

test("rpc idempotence: masking already-masked text changes nothing", () => {
	for (const [name, run] of Object.entries(secretRuns())) {
		const text = ["Here it is:", ...run.lines, "That is all."].join("\n");
		const once = vinciMaskSecrets(text);
		assert.ok(once.includes(PLACEHOLDER), `${name}: masked once`);
		assert.equal(vinciMaskSecrets(once), once, `${name}: masked twice equals masked once`);
	}
	const token = `TOKEN=${inlineToken()}`;
	assert.equal(vinciMaskSecrets(vinciMaskSecrets(token)), vinciMaskSecrets(token), "a single-line value");
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
