// Mask streamed output consistently: `--mode json` through the production runPrintMode. The session is a
// stand-in that emits assistant stream events (one completed line per update); every byte written to
// stdout is recorded. Secret values are synthetic and built at runtime.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { secretRuns, assertMasked, PLACEHOLDER, streamEvents, assistant, block } from "./lib/stream-masking-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../packages/coding-agent/src");
const { runPrintMode, setPrintModeTerminatingForTest } = await import(resolve(src, "modes/print-mode.ts"));
const { vinciMaskJson } = await import(resolve(src, "core/vinci-mask-secrets.ts"));

const realWrite = process.stdout.write;

/**
 * Run runPrintMode in json mode over `events`, emitted from the session's prompt. `during(listener)` runs
 * after the events, still inside the prompt; `final` is the run's last assistant message.
 */
async function runJson(events, { masking = true, during, final } = {}) {
	const saved = process.env.VINCI_CODE;
	if (masking) process.env.VINCI_CODE = "1";
	else delete process.env.VINCI_CODE;
	const messages = [];
	let listener;
	const session = {
		state: { messages },
		agent: { waitForIdle: async () => {} },
		sessionManager: { getHeader: () => undefined },
		extensionRunner: undefined,
		bindExtensions: async () => {},
		subscribe(fn) {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
		prompt: async () => {
			for (const event of events) listener?.(event);
			if (during) await during(listener);
			messages.push(final ?? assistant([block("text", "done.")]));
		},
	};
	const runtime = {
		session,
		setRebindSession() {},
		dispose: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
	};
	const chunks = [];
	process.stdout.write = function (chunk, encodingOrCallback, callback) {
		if (typeof chunk !== "string") return realWrite.call(process.stdout, chunk, encodingOrCallback, callback);
		chunks.push(chunk);
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	};
	const savedError = console.error;
	console.error = () => {};
	let exitCode;
	try {
		exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: "go" });
	} finally {
		process.stdout.write = realWrite;
		console.error = savedError;
		if (saved === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = saved;
	}
	const stdout = chunks.join("");
	const parsed = stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	return { stdout, events: parsed, exitCode };
}

const deltasOf = (events, kind = "text") =>
	events
		.filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === `${kind}_delta`)
		.map((event) => event.assistantMessageEvent.delta)
		.join("");

const fieldOf = (message, kind = "text") => message.content.find((part) => part.type === kind)?.[kind];

for (const [name, run] of Object.entries(secretRuns())) {
	test(`json: ${name}, streamed one line per update, never reaches stdout; the placeholder does`, async () => {
		const { events, text } = streamEvents(["Here it is:", ...run.lines, "That is all."]);
		const out = await runJson(events);
		assertMasked(out.stdout, run.secret, name);
		const end = out.events.find((event) => event.type === "message_end");
		// A consumer reading message_end gets the same masked text as before this change.
		const rawEnd = events.find((event) => event.type === "message_end");
		assert.deepEqual(end, JSON.parse(JSON.stringify(vinciMaskJson(rawEnd))), "message_end is masked as before");
		assert.equal(deltasOf(out.events), fieldOf(end.message), "the deltas add up to the message_end text");
		assert.ok(fieldOf(end.message).includes(PLACEHOLDER), "message_end holds the placeholder");
		assert.ok(text.includes(run.lines[0]), "fixture sanity: the raw stream holds the secret run");
	});
}

test("json: a thinking block holds back and masks the same way", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Thinking it over:", ...run.lines, "Done."], { kind: "thinking" });
	const out = await runJson(events);
	assertMasked(out.stdout, run.secret, "thinking");
	const end = out.events.find((event) => event.type === "message_end");
	assert.equal(deltasOf(out.events, "thinking"), fieldOf(end.message, "thinking"));
});

test("json: an aborted answer (message_end, no text_end) flushes the held run masked", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, stopReason: "aborted" });
	const out = await runJson(events);
	assertMasked(out.stdout, run.secret, "abort");
	const endIndex = out.events.findIndex((event) => event.type === "message_end");
	assert.ok(endIndex > 0, "message_end is written");
	const before = out.events.slice(0, endIndex - 1);
	assert.equal(deltasOf(before), "Here it is:", "the run is held while it may still change");
	const flushed = out.events[endIndex - 1];
	assert.equal(flushed.type, "message_update", "a flushed delta precedes message_end");
	assert.ok(flushed.assistantMessageEvent.delta.includes(PLACEHOLDER), "the flushed delta is masked");
	assert.equal(deltasOf(out.events), fieldOf(out.events[endIndex].message), "the deltas add up to the message_end text");
});

test("json: agent_end with no message_end flushes the held run masked", async () => {
	const run = secretRuns()["an END-only private-key body"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	events.push({ type: "agent_end", messages: [] });
	const out = await runJson(events);
	assertMasked(out.stdout, run.secret, "agent_end");
	const agentEnd = out.events.findIndex((event) => event.type === "agent_end");
	assert.equal(out.events[agentEnd - 1].type, "message_update", "a flushed delta precedes agent_end");
	assert.ok(deltasOf(out.events).includes(PLACEHOLDER), "the deltas hold the placeholder");
});

test("json: an error mid-stream still writes the held run masked", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	const out = await runJson(events, {
		during: async () => {
			throw new Error("provider failed");
		},
	});
	assert.equal(out.exitCode, 1);
	assertMasked(out.stdout, run.secret, "error");
	assert.ok(deltasOf(out.events).includes(PLACEHOLDER), "the deltas hold the placeholder");
});

test("json: a termination signal mid-stream writes the held run masked before exit", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	const realExit = process.exit;
	let exited;
	const exitCalled = new Promise((resolveExit) => {
		process.exit = (code) => {
			exited = code;
			resolveExit();
		};
	});
	let out;
	try {
		out = await runJson(events, {
			during: async () => {
				process.emit("SIGTERM");
				await Promise.race([exitCalled, new Promise((r) => setTimeout(r, 6000))]);
			},
		});
	} finally {
		process.exit = realExit;
		setPrintModeTerminatingForTest(false);
		process.exitCode = undefined;
	}
	assert.equal(exited, 143, "the signal path exits 143");
	assertMasked(out.stdout, run.secret, "signal");
	assert.ok(deltasOf(out.events).includes(PLACEHOLDER), "the deltas hold the placeholder");
});

test("json positive control: prose lines are each written when they complete, byte-identical", async () => {
	const lines = ["First line.", "Second line, with a comma;", "Third (and last)."];
	const { events, text } = streamEvents(lines);
	const out = await runJson(events);
	const updates = out.events.filter((event) => event.assistantMessageEvent?.type === "text_delta");
	assert.deepEqual(
		updates.map((event) => event.assistantMessageEvent.delta),
		["First line.", "\nSecond line, with a comma;", "\nThird (and last).", "\n"],
		"each line is released at the update that completes it; the trailing newline at the end",
	);
	assert.equal(deltasOf(out.events), text, "the deltas add up to the raw text");
	const end = out.events.find((event) => event.type === "message_end");
	assert.equal(fieldOf(end.message), text);
	assert.ok(!out.stdout.includes(PLACEHOLDER));
});

test("json with masking off: the stream is byte-identical to the events", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines, "That is all."]);
	const out = await runJson(events, { masking: false });
	assert.equal(out.stdout, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
});
