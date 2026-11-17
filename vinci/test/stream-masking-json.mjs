// Mask streamed output consistently: `--mode json` through the production runPrintMode. The session is a
// stand-in that emits assistant stream events (one completed line per update); every byte written to
// stdout is recorded. Secret values are synthetic and built at runtime.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	angleEndingEvents,
	angleWhitespaceCases,
	ansiSecretCases,
	assertMasked,
	assertNeverRewritten,
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
	keyMarkers,
	multiLineArguments,
	multiLineToolCalls,
	PLACEHOLDER,
	partialArgumentTexts,
	probeBashCallEvents,
	probeCumulativeEvents,
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
const src = resolve(here, "../../packages/coding-agent/src");
const { runPrintMode, setPrintModeTerminatingForTest } = await import(resolve(src, "modes/print-mode.ts"));
const { vinciMaskJson, vinciMaskSecrets } = await import(resolve(src, "core/vinci-mask-secrets.ts"));
const { waitForRawStdoutBackpressure } = await import(resolve(src, "core/output-guard.ts"));
const { VinciStreamMask } = await import(resolve(src, "core/vinci-stream-mask.ts"));

const realWrite = process.stdout.write;

/**
 * Run runPrintMode in json mode over `events`, emitted from the session's prompt. `during(ctx)` runs after
 * the events, still inside the prompt, with `ctx.listener`, `ctx.stdout()` (everything written so far)
 * and `ctx.rebind()` (the runtime's rebind callback); `final` is the run's last assistant message.
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
			if (during) await during({ listener, stdout: () => chunks.join(""), rebind: () => rebind() });
			messages.push(final ?? assistant([block("text", "done.")]));
		},
	};
	let rebind;
	const runtime = {
		session,
		setRebindSession(fn) {
			rebind = fn;
		},
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

const parseLines = (stdout) =>
	stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

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

test("json: an aborted answer (message_end, no text_end) keeps its complete lines, masked, then the placeholder for the held run", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, stopReason: "aborted" });
	const out = await runJson(events);
	assertMasked(out.stdout, run.secret, "abort");
	const endIndex = out.events.findIndex((event) => event.type === "message_end");
	assert.ok(endIndex > 0, "message_end is written");
	const before = out.events.slice(0, endIndex - 1);
	// 206q (timing): with masking on the whole body is held until the message ends; every earlier delta is empty.
	assert.equal(deltasOf(before), "", "the body is held until the message ends");
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

test("json: agent_end with no message_end flushes the held run as the placeholder", async () => {
	// The base64 run ends in run characters, so it is still held when agent_end arrives.
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	events.push({ type: "agent_end", messages: [] });
	const out = await runJson(events);
	assertMasked(out.stdout, run.secret, "agent_end");
	const agentEnd = out.events.findIndex((event) => event.type === "agent_end");
	assert.ok(agentEnd > 0, "agent_end is written");
	// Without the agent_end flush the run stays held past agent_end (only the final flush would write it).
	const before = deltasOf(out.events.slice(0, agentEnd));
	assert.ok(before.includes(PLACEHOLDER), "the held run is written, masked, before agent_end");
	// 206t (expectation: more masking): agent_end cut the block before its end, so it goes out as the placeholder, not
	// as the mask of the text so far.
	assert.equal(before, PLACEHOLDER, "the placeholder, before agent_end");
	assert.equal(deltasOf(out.events.slice(agentEnd)), "", "nothing is left to write after agent_end");
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
	let atExit;
	let stdoutNow;
	const exitCalled = new Promise((resolveExit) => {
		process.exit = (code) => {
			exited = code;
			// What had reached stdout when the process would have stopped: the final flush has not run.
			atExit = stdoutNow();
			resolveExit();
		};
	});
	let out;
	try {
		out = await runJson(events, {
			during: async ({ stdout }) => {
				stdoutNow = stdout;
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
	assertMasked(atExit, run.secret, "signal: written before exit");
	assert.ok(deltasOf(parseLines(atExit)).includes(PLACEHOLDER), "the signal flush wrote the held run, masked, before exit");
	assertMasked(out.stdout, run.secret, "signal");
});

test("json: the liveness-watchdog exit writes the held run masked before exit", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	const realExit = process.exit;
	const savedTimeout = process.env.VINCI_PRESTREAM_TIMEOUT_MS;
	process.env.VINCI_PRESTREAM_TIMEOUT_MS = "40";
	let exited;
	let atExit;
	let stdoutNow;
	const exitCalled = new Promise((resolveExit) => {
		process.exit = (code) => {
			exited = code;
			atExit = stdoutNow();
			resolveExit();
		};
	});
	try {
		await runJson(events, {
			during: async ({ stdout }) => {
				stdoutNow = stdout;
				await Promise.race([exitCalled, new Promise((r) => setTimeout(r, 3000))]);
			},
		});
	} finally {
		process.exit = realExit;
		// 206s (B06): the watchdog now marks the run terminating before its flush; later rows start a fresh run.
		setPrintModeTerminatingForTest(false);
		if (savedTimeout === undefined) delete process.env.VINCI_PRESTREAM_TIMEOUT_MS;
		else process.env.VINCI_PRESTREAM_TIMEOUT_MS = savedTimeout;
	}
	assert.equal(exited, 1, "the watchdog exits 1");
	assertMasked(atExit, run.secret, "watchdog: written before exit");
	assert.ok(deltasOf(parseLines(atExit)).includes(PLACEHOLDER), "the watchdog flush wrote the held run, masked, before exit");
});

test("json: a rebind writes the held run masked at once", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	let beforeRebind;
	let afterRebind;
	// Recorded inside the prompt and asserted after the run: runPrintMode catches what the prompt throws.
	await runJson(events, {
		during: async ({ stdout, rebind }) => {
			await waitForRawStdoutBackpressure();
			beforeRebind = stdout();
			await rebind();
			// Let the queued writes land; nothing else writes until the stream ends.
			await waitForRawStdoutBackpressure();
			afterRebind = stdout();
		},
	});
	// 206q (timing): the stream so far is written, its text deltas empty (the body is held whole).
	assert.ok(parseLines(beforeRebind).some((event) => event.assistantMessageEvent?.type === "text_delta"), "the stream so far is written");
	assert.equal(deltasOf(parseLines(beforeRebind)), "", "held before the rebind");
	assertMasked(afterRebind, run.secret, "rebind");
	assert.ok(deltasOf(parseLines(afterRebind)).includes(PLACEHOLDER), "the rebind flush wrote the held run, masked");
});

test("json: a new assistant message_start writes the previous message's held run first, masked", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const { events } = streamEvents(["Here it is:", ...run.lines], { end: false, withEnd: false });
	const next = streamEvents(["Next answer."]).events;
	const out = await runJson([...events, ...next]);
	assertMasked(out.stdout, run.secret, "message_start");
	const starts = out.events.flatMap((event, index) => (event.type === "message_start" ? [index] : []));
	assert.equal(starts.length, 2, "two assistant messages");
	assert.ok(deltasOf(out.events.slice(0, starts[1])).includes(PLACEHOLDER), "the held run is written before the next message_start");
});

test("json positive control: prose lines are held, then written whole once at text_end, byte-identical", async () => {
	const lines = ["First line.", "Second line, with a comma;", "Third (and last)."];
	const { events, text } = streamEvents(lines);
	const out = await runJson(events);
	const updates = out.events.filter((event) => event.assistantMessageEvent?.type === "text_delta");
	// 206q (timing): each streamed delta is written empty; one synthesized delta carries the whole body at text_end.
	assert.deepEqual(
		updates.map((event) => event.assistantMessageEvent.delta),
		["", "", "", text],
		"every streamed delta is empty; the whole text is released once, at the block's end",
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

// Masking consistency for streamed tool arguments: the tools whose arguments the view masks.
for (const [label, step] of [
	["case 1", 0],
	["case 2", 9],
]) {
	test(`json: masking consistency for streamed tool arguments, single-line value (${label})`, async () => {
		const token = inlineToken();
		const json = JSON.stringify({ command: `echo ${token}` });
		const fragments = splitAcross(json, token, step);
		assert.ok(fragments.length >= (step ? 3 : 2), "fixture sanity: the value spans the fragments");
		const { events } = toolCallEvents("bash", fragments);
		const out = await runJson(events);
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, [token], "concatenated deltas");
		assertMasked(out.stdout, [token], "whole stdout");
	});
}

test("json positive control: non-secret bash arguments arrive byte-identical once the deltas are joined", async () => {
	const json = JSON.stringify({ command: "ls -la src/components", timeout: 30 });
	const fragments = [json.slice(0, 7), json.slice(7, 19), json.slice(19)];
	const { events } = toolCallEvents("bash", fragments);
	const out = await runJson(events);
	assert.equal(deltasOf(out.events, "toolcall"), json, "the joined deltas equal the raw argument text");
	const end = out.events.find((event) => event.type === "message_end");
	assert.deepEqual(end.message.content[0].arguments, JSON.parse(json));
});

// 206q (scope, r2 Q4): a tool the view does not mask is held too (fail closed): its argument text is released
// once, at the call's end. 206r (F1, more masking): released as the masked JSON of the parsed arguments.
test("json: a tool the view does not mask holds its argument deltas and releases them once, masked", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const { events } = toolCallEvents("extension_tool", splitAcross(json, token, 0));
	const out = await runJson(events);
	const released = out.events.filter((event) => event.assistantMessageEvent?.type === "toolcall_delta" && event.assistantMessageEvent.delta);
	assert.equal(released.length, 1, "one release, at the call's end");
	// 206r (F1, more masking): the release is the masked JSON of the parsed arguments, not the text masked whole.
	assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(JSON.parse(json))), "the masked JSON of the arguments");
	assertMasked(out.stdout, [token], "whole stdout");
	const end = out.events.find((event) => event.type === "message_end");
	const rawEnd = events.find((event) => event.type === "message_end");
	assert.deepEqual(end, JSON.parse(JSON.stringify(vinciMaskJson(rawEnd))), "message_end is masked as before");
});

const toolFragment = 9;
const multiLineCases = () =>
	Object.values(secretRuns()).flatMap((run, n) =>
		Object.entries(multiLineToolCalls(run.lines)).map(([tool, args]) => ({ label: `${tool}, case ${n + 1}`, tool, args, secret: run.secret })),
	);

for (const { label, tool, args, secret } of multiLineCases()) {
	test(`json: masking consistency for streamed tool arguments, multi-line value (${label})`, async () => {
		const json = JSON.stringify(args);
		const { events } = toolCallEvents(tool, fragmentsOf(json, toolFragment));
		const out = await runJson(events);
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, secret, "joined deltas");
		assertNoSecretBytes(partialArgumentTexts(out.events).join("\n"), secret, "partial argument text");
		assertMasked(out.stdout, secret, "whole stdout");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "the release is the masked JSON of the parsed arguments");
		const released = out.events.filter((event) => event.assistantMessageEvent?.type === "toolcall_delta" && event.assistantMessageEvent.delta);
		assert.equal(released.length, 1, "one release, at the call's end");
		for (const text of partialArgumentTexts(out.events)) assert.ok(text === "" || text === deltas, "partial argument text is empty or the released text");
		const end = out.events.find((event) => event.type === "message_end");
		const rawEnd = events.find((event) => event.type === "message_end");
		assert.deepEqual(end, JSON.parse(JSON.stringify(vinciMaskJson(rawEnd))), "message_end is masked as before");
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
	test(`json: masking consistency for streamed tool arguments, a call cut by ${label} (message_end only)`, async () => {
		const { events, secret } = interruptedCall({ ending: "message_end", stopReason, partialOnEnd });
		const out = await runJson(events);
		assertInterrupted(out.events, secret, label);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(end.message.stopReason, stopReason);
		assert.deepEqual(partialArgumentTexts([end]), partialOnEnd ? [PLACEHOLDER] : [], "message_end carries only the released text");
	});
}

test("json: masking consistency for streamed tool arguments, a call cut by agent_end", async () => {
	const { events, secret } = interruptedCall();
	events.push({ type: "agent_end", messages: [] });
	const out = await runJson(events);
	assertInterrupted(out.events, secret, "agent_end");
	assertMasked(out.stdout, secret, "agent_end: whole stdout");
	const agentEnd = out.events.findIndex((event) => event.type === "agent_end");
	assert.equal(deltasOf(out.events.slice(0, agentEnd), "toolcall"), PLACEHOLDER, "released before agent_end");
});

test("json: masking consistency for streamed tool arguments, a call cut by a thrown error", async () => {
	const { events, secret } = interruptedCall();
	const out = await runJson(events, {
		during: async () => {
			throw new Error("provider failed");
		},
	});
	assert.equal(out.exitCode, 1);
	assertInterrupted(out.events, secret, "error");
	assertMasked(out.stdout, secret, "error: whole stdout");
});

test("json: masking consistency for streamed tool arguments, a call cut by a termination signal", async () => {
	const { events, secret } = interruptedCall();
	const realExit = process.exit;
	let exited;
	let atExit;
	let stdoutNow;
	const exitCalled = new Promise((resolveExit) => {
		process.exit = (code) => {
			exited = code;
			atExit = stdoutNow();
			resolveExit();
		};
	});
	try {
		await runJson(events, {
			during: async ({ stdout }) => {
				stdoutNow = stdout;
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
	assertInterrupted(parseLines(atExit), secret, "signal");
	assertMasked(atExit, secret, "signal: written before exit");
});

test("json: masking consistency for streamed tool arguments, a call cut by a rebind", async () => {
	const { events, secret } = interruptedCall();
	let afterRebind;
	await runJson(events, {
		during: async ({ stdout, rebind }) => {
			await rebind();
			await waitForRawStdoutBackpressure();
			afterRebind = stdout();
		},
	});
	assertInterrupted(parseLines(afterRebind), secret, "rebind");
	assertMasked(afterRebind, secret, "rebind: whole stdout");
});

test("json: masking consistency for streamed tool arguments, a call cut by the next message_start", async () => {
	const { events, secret } = interruptedCall();
	const next = streamEvents(["Next answer."]).events;
	const out = await runJson([...events, ...next]);
	assertInterrupted(out.events, secret, "message_start");
	assertMasked(out.stdout, secret, "message_start: whole stdout");
	const starts = out.events.flatMap((event, index) => (event.type === "message_start" ? [index] : []));
	assert.equal(deltasOf(out.events.slice(0, starts[1]), "toolcall"), PLACEHOLDER, "released before the next message_start");
});

test("json: masking consistency for streamed tool arguments, a complete call with no toolcall_end releases its masked parse", async () => {
	const run = secretRuns()["an END-only private-key body"];
	const args = multiLineToolCalls(run.lines).bash;
	const json = JSON.stringify(args);
	const { events } = toolCallEvents("bash", fragmentsOf(json, toolFragment), { ending: "message_end", stopReason: "aborted" });
	const out = await runJson(events);
	assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(args)));
	assertMasked(out.stdout, run.secret, "whole stdout");
});

// Interrupted calls: in the final events (message_end, turn_end, agent_end) an argument value is kept only when
// it is complete and the hold-back would release all of it; any other value is the placeholder, whole (206s (B01):
// no released prefix is kept).
const hasStringValue = (value) =>
	typeof value === "string" ? value !== "" : value && typeof value === "object" ? Object.values(value).some(hasStringValue) : false;

for (const { label, tool, args, secret } of multiLineCases()) {
	test(`json: masking consistency for streamed tool arguments, an interrupted call's final events carry none of its held lines (${label})`, async () => {
		const json = JSON.stringify(args);
		let carried = 0;
		for (const cut of cutPoints(json, secret)) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json.slice(0, cut), toolFragment), { ending: "message_end", finals: true });
			const raw = JSON.stringify(final);
			if (secret.some((line) => raw.includes(line.slice(0, 12)))) carried++;
			const out = await runJson(events);
			const finals = finalEventsOf(out.events);
			assert.equal(finals.length, 3, `cut ${cut}: message_end, turn_end and agent_end are written`);
			const text = JSON.stringify(finals);
			assertNoSecretBytes(text, secret, `cut ${cut}: final events`);
			if (hasStringValue(final.content[0].arguments)) assert.ok(text.includes(PLACEHOLDER), `cut ${cut}: the placeholder is written`);
		}
		assert.ok(carried > 0, "fixture sanity: the raw final arguments carry secret lines");
	});
}

test("json: masking consistency for streamed tool arguments, no raw held argument text reaches an interrupted call's final events", async () => {
	for (const { label, tool, args, secret } of multiLineCases()) {
		const json = JSON.stringify(args);
		for (const cut of cutPoints(json, secret)) {
			const { events } = toolCallEvents(tool, fragmentsOf(json.slice(0, cut), toolFragment), { ending: "message_end", finals: true });
			const out = await runJson(events);
			const text = JSON.stringify(finalEventsOf(out.events));
			for (const window of heldWindows(json, secret, cut)) {
				assert.ok(!text.includes(window), `${label}, cut ${cut}: raw held text ${JSON.stringify(window)} reached a final event`);
			}
		}
	}
});

test("json positive control: a completed call's final events are masked exactly as before", async () => {
	for (const { label, tool, args } of multiLineCases()) {
		const { events } = toolCallEvents(tool, fragmentsOf(JSON.stringify(args), toolFragment), { finals: true });
		const out = await runJson(events);
		const lines = out.stdout.split("\n").filter((line) => /^\{"type":"(message_end|turn_end|agent_end)"/.test(line));
		assert.deepEqual(
			lines,
			finalEventsOf(events).map((event) => JSON.stringify(vinciMaskJson(event))),
			`${label}: byte-identical to the masked events`,
		);
		const toolcallEnd = out.events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
		assert.deepEqual(toolcallEnd?.assistantMessageEvent?.toolCall?.arguments, vinciMaskJson(args), `${label}: toolcall_end arguments masked once`);
		for (const event of finalEventsOf(out.events)) {
			const message = event.type === "agent_end" ? event.messages?.[0] : event.message;
			assert.deepEqual(message?.content?.[0]?.arguments, vinciMaskJson(args), `${label}: ${event.type} arguments masked once`);
		}
		assert.deepEqual(partialArgumentTexts(finalEventsOf(out.events)), [], `${label}: no partial argument text in the final events`);
	}
});

// A completed built-in call whose toolcall_end call, partial and final message keep the raw partial argument
// text (a provider or extension that keeps its streaming buffer): that text is the masked JSON of the arguments.
const toolcallEndAndFinals = (events) => [
	...events.filter((event) => event.assistantMessageEvent?.type === "toolcall_end"),
	...finalEventsOf(events),
];
const eventName = (event) => event?.assistantMessageEvent?.type ?? event?.type;

for (const field of ["partialJson", "partialArgs"]) {
	test(`json: masking consistency for streamed tool arguments, a completed call that keeps its partial argument text (${field})`, async () => {
		for (const { label, tool, args, secret } of multiLineCases()) {
			const json = JSON.stringify(args);
			const { events, final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { finals: true, field, keepPartialOnEnd: true });
			assert.equal(final?.content?.[0]?.[field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(finalEventsOf(events)).includes(line.slice(0, 12))), `${label}: fixture sanity: the raw final carries secret bytes`);
			const out = await runJson(events);
			const masked = JSON.stringify(vinciMaskJson(args));
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
			const ends = toolcallEndAndFinals(out.events);
			assert.deepEqual(ends.map(eventName), ["toolcall_end", "message_end", "turn_end", "agent_end"], `${label}: the end events are written`);
			assert.equal(ends[0]?.assistantMessageEvent?.toolCall?.[field], masked, `${label}: the toolcall_end call's ${field} is the masked JSON of the arguments`);
			for (const event of ends) {
				const texts = partialArgumentTexts([event]);
				assert.ok(texts.length > 0, `${label}: ${eventName(event)}: ${field} is there`);
				for (const text of texts) assert.equal(text, masked, `${label}: ${eventName(event)}: ${field} is the masked JSON of the arguments`);
			}
			for (const text of partialArgumentTexts(out.events)) assert.ok(text === "" || text === masked, `${label}: partial argument text is empty or the masked arguments`);
		}
	});
}

// 206r (F1, more masking): the retained partial argument text of a call of a tool the view does not mask is the
// masked JSON of its arguments (the spaced JSON shows the rewrite); everything else in its end events is as before.
test("json positive control: a completed call of a tool the view does not mask keeps its partial argument text as the masked JSON of its arguments", async () => {
	const token = inlineToken();
	// Spaced JSON: a rewrite to the JSON of the parsed arguments would show.
	const json = `{"query": "find ${token}", "limit": 20}`;
	const { events, final } = toolCallEvents("extension_tool", splitAcross(json, token, 0), { finals: true, keepPartialOnEnd: true });
	assert.equal(final?.content?.[0]?.partialJson, json, "fixture sanity: the final message keeps the raw text");
	const out = await runJson(events);
	const masked = JSON.stringify(vinciMaskJson(JSON.parse(json)));
	const withMasked = (event) => JSON.parse(JSON.stringify(event, (key, value) => (key === "partialJson" && value === json ? masked : value)));
	// 206q (timing, r2 Q4): the call is held while it streams, so only its end events are as before this change.
	const ends = (lines) => lines.filter((line) => /^\{"type":"(message_end|turn_end|agent_end)"/.test(line) || line.includes('"type":"toolcall_end"'));
	assert.deepEqual(
		ends(out.stdout.split("\n").filter(Boolean)),
		ends(events.map((event) => JSON.stringify(vinciMaskJson(withMasked(event))))),
		"the end events are the masked events, their partial argument text the masked JSON of the arguments",
	);
	assert.equal(deltasOf(out.events, "toolcall"), masked, "released once, as the masked JSON of the arguments");
});

test("json: a built-in call's streaming partial text is unchanged by the completed-call scrub", async () => {
	for (const field of ["partialJson", "partialArgs"]) {
		for (const { label, tool, args } of multiLineCases()) {
			const { events } = toolCallEvents(tool, fragmentsOf(JSON.stringify(args), toolFragment), { field, keepPartialOnEnd: true });
			const out = await runJson(events);
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
test("json: masking consistency for streamed tool arguments, a built-in name that arrives late", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).write;
	const fragments = fragmentsOf(JSON.stringify(args), toolFragment);
	// The name arrives two deltas before the end: the secret run streams before it.
	const { events } = toolCallEvents("write", fragments, { nameFrom: fragments.length - 2 });
	const nameless = events.filter((event) => event.message?.content?.[0]?.name === "").map((event) => event.assistantMessageEvent.delta ?? "").join("");
	assert.ok(run.secret.every((line) => nameless.includes(line)), "fixture sanity: the secret run streams before the name");
	const out = await runJson(events);
	const deltas = deltasOf(out.events, "toolcall");
	assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
	assertMasked(deltas, run.secret, "joined deltas");
	assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "the release is the masked JSON of the parsed arguments");
});

for (const ending of ["end", "message_end"]) {
	test(`json: masking consistency for streamed tool arguments, a call with no name to the end is released masked (${ending})`, async () => {
		const run = secretRuns()["a multi-line base64 secret"];
		const args = multiLineToolCalls(run.lines).write;
		const { events } = toolCallEvents(undefined, fragmentsOf(JSON.stringify(args), toolFragment), { ending, stopReason: ending === "end" ? undefined : "aborted" });
		const out = await runJson(events);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), "released as a built-in call would be");
	});
}

test("json positive control: a late name that names a tool the view does not mask releases the held text unchanged", async () => {
	const json = JSON.stringify({ query: "list the open files", limit: 20 });
	const { events } = toolCallEvents("extension_tool", fragmentsOf(json, 5), { nameFrom: 3 });
	const out = await runJson(events);
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
	test(`json: masking consistency for streamed tool arguments, a ${index} content index still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { index, before: [block("text", "Running it.\n")] });
		const out = await runJson(events);
		if (index === "missing") return assertFallbackHeld(out, run.secret);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)));
	});
}

// A call cut by a stream-ending source event: the `done` / `error` event carries the cut call's message.
for (const kind of ["done", "error"]) {
	test(`json: masking consistency for streamed tool arguments, a cut call carried by a source ${kind} event`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const built = toolCallEvents(tool, fragmentsOf(json, toolFragment), { ending: "message_end", finals: true, partialOnEnd: true });
			assert.equal(built.final?.content?.[0]?.partialJson, json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(built.final).includes(line.slice(0, 12))), `${label}: fixture sanity: the cut call carries secret bytes`);
			const out = await runJson(withSourceEnd(built.events, kind, built.final));
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
	test(`json: masking consistency for streamed tool arguments, a completed call that keeps its partial argument text, carried by a source ${kind} event`, async () => {
		for (const { label, tool, args, secret } of multiLineCases()) {
			const json = JSON.stringify(args);
			const built = toolCallEvents(tool, fragmentsOf(json, toolFragment), { finals: true, keepPartialOnEnd: true });
			assert.equal(built.final?.content?.[0]?.partialJson, json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(built.final).includes(line.slice(0, 12))), `${label}: fixture sanity: the raw final carries secret bytes`);
			const out = await runJson(withSourceEnd(built.events, kind, built.final));
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

// A cut call whose final message still carries its raw partial argument text.
for (const field of ["partialJson", "partialArgs"]) {
	test(`json: masking consistency for streamed tool arguments, a cut call's final message that keeps its ${field}`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { ending: "message_end", finals: true, field, partialOnEnd: true });
			assert.equal(final.content[0][field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			const out = await runJson(events);
			const finals = finalEventsOf(out.events);
			assert.deepEqual(finals.map((event) => event.type), ["message_end", "turn_end", "agent_end"], `${label}: the final events are written`);
			for (const event of finals) {
				assertNoSecretBytes(JSON.stringify(event), secret, `${label}: ${event.type}`);
				const texts = partialArgumentTexts([event]);
				assert.ok(texts.length > 0, `${label}: ${event.type}: fixture sanity: ${field} is there`);
				for (const text of texts) assert.equal(text, PLACEHOLDER, `${label}: ${event.type}: ${field} is the placeholder`);
			}
		}
	});
}

// A cut call with an empty id whose final message keeps its partial text: its interruption is still found
// after message_end rebuilds the block.
for (const field of ["partialJson", "partialArgs"]) {
	test(`json: masking consistency for streamed tool arguments, a cut call with an empty id whose final message keeps its ${field}`, async () => {
		for (const { label, tool, json, secret } of cutToolCalls()) {
			const { events, final } = toolCallEvents(tool, fragmentsOf(json, toolFragment), { id: "", ending: "message_end", finals: true, field, partialOnEnd: true });
			assert.equal(final.content[0][field], json, `${label}: fixture sanity: the final message keeps the raw text`);
			assert.ok(secret.some((line) => JSON.stringify(final).includes(line.slice(0, 12))), `${label}: fixture sanity: the cut call carries secret bytes`);
			const out = await runJson(events);
			const finals = finalEventsOf(out.events);
			assert.deepEqual(finals.map((event) => event.type), ["message_end", "turn_end", "agent_end"], `${label}: the final events are written`);
			for (const event of finals) {
				assertNoSecretBytes(JSON.stringify(event), secret, `${label}: ${event.type}`);
				const texts = partialArgumentTexts([event]);
				assert.ok(texts.length > 0, `${label}: ${event.type}: fixture sanity: ${field} is there`);
				for (const text of texts) assert.equal(text, PLACEHOLDER, `${label}: ${event.type}: ${field} is the placeholder`);
			}
			assertNoSecretBytes(out.stdout, secret, `${label}: whole stdout`);
		}
	});
}

// A completed call whose final message carries an empty partial text or the placeholder: kept as given.
for (const [what, kept] of [["an empty", ""], ["the placeholder as its", PLACEHOLDER]]) {
	for (const field of ["partialJson", "partialArgs"]) {
		test(`json: masking consistency for streamed tool arguments, a completed call whose final message carries ${what} ${field} keeps it`, async () => {
			const run = secretRuns()["a multi-line hex secret"];
			const args = multiLineToolCalls(run.lines).bash;
			const { events, final } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { field, finals: true, keepPartialOnEnd: true });
			final.content[0][field] = kept;
			const out = await runJson(events);
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
	test(`json: masking consistency for streamed tool arguments, ${label} still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id, index, after, before: [block("text", "Running it.\n")], finals: true });
		const out = await runJson(events);
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
	test(`json: masking consistency for streamed tool arguments, ${label} with a later tool call and no streaming text still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }];
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "call-1", index, after, before: [block("text", "Running it.\n")], finals: true });
		const stripped = JSON.parse(JSON.stringify(events, (key, value) => (key === "partialJson" ? undefined : value)));
		assert.ok(!JSON.stringify(stripped).includes("partialJson"), "fixture sanity: no block carries streaming text");
		const out = await runJson(stripped);
		assertFallbackHeld(out, run.secret);
	});
}

// The fallback's last step: no call carries streaming text and none is one the view masks. The event names
// no call, so every tool call of the message is held and over-masked in its final events, even calls the
// view does not mask.
test("json: an out-of-range content index with only calls the view does not mask: the message's tool text is held", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {} }];
	const { events } = toolCallEvents("shell_helper", splitAcross(json, token, 0), { id: "call-1", index: 5, after });
	const stripped = JSON.parse(JSON.stringify(events, (key, value) => (key === "partialJson" ? undefined : value)));
	assert.ok(!JSON.stringify(stripped).includes("partialJson"), "fixture sanity: no block carries streaming text");
	const out = await runJson(stripped);
	assert.equal(deltasOf(out.events, "toolcall"), "", "nothing is released after an event that names no call");
	assert.ok(!out.stdout.includes(token), "the final events over-mask the calls");
});

// The fallback order: when any call is one the view masks, an unidentified call's text is held as a masked
// call's, even when a call the view does not mask still carries streaming text.
test("json: masking consistency for streamed tool arguments, an out-of-range content index holds a streaming unmasked call's text when a later call is masked", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const after = [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("shell_helper", splitAcross(json, token, 0), { id: "call-1", index: 5, after });
	assert.ok(events.every((event) => event.message?.content?.[1]?.partialJson === undefined), "fixture sanity: the later call carries no streaming text");
	assert.ok(deltasOf(events, "toolcall").includes(token), "fixture sanity: passed through, the joined deltas would carry the value");
	const out = await runJson(events);
	assert.ok(!deltasOf(out.events, "toolcall").includes(token), "the text is held as a masked call's");
});

// A built-in call that carries only parsed arguments, before a later call the view does not mask that still
// keeps streaming text: the built-in call's text is held.
test("json: masking consistency for streamed tool arguments, an out-of-range content index holds a built-in call without streaming text before a later unmasked call that keeps its text", async () => {
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
	const out = await runJson(events);
	assertFallbackHeld(out, run.secret);
});

// Text the fallback took into a call whose name was not known yet: when that name turns out to be one the
// view does not mask, the text is not released (it may be another call's); the call shows no arguments.
test("json: masking consistency for streamed tool arguments, text taken by the fallback into a call named late as a tool the view does not mask is never shown as that call's", async () => {
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
	const out = await runJson(events);
	assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
	for (const event of out.events.filter((event) => event.type === "message_update")) {
		assert.deepEqual(event.message?.content?.[1]?.arguments, {}, "the later call shows no arguments while streaming");
	}
});

test("json positive control: a call named late as a tool the view does not mask, named by its content index after a built-in call, releases its own text unchanged", async () => {
	const json = JSON.stringify({ query: "list the open files", limit: 20 });
	const before = [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("extension_tool", fragmentsOf(json, 5), { id: "call-2", nameFrom: 3, before });
	const out = await runJson(events);
	assert.equal(deltasOf(out.events, "toolcall"), json, "the joined deltas equal the raw argument text");
	assert.ok(!deltasOf(out.events, "toolcall").includes(PLACEHOLDER));
	// The built-in call ahead of it has no events of its own: its final events show it as interrupted.
	const end = out.events.find((event) => event.type === "message_end");
	assert.deepEqual(end.message.content[1].arguments, JSON.parse(json), "the named call's own arguments are unchanged");
	assert.equal(end.message.content[0].arguments.command, PLACEHOLDER, "the call with no events of its own is over-masked");
});

test("json positive control: a tracked built-in call's streaming message shows its masked arguments once released, not the held empty arguments", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } }];
	const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { after });
	const out = await runJson(events);
	const end = out.events.find((event) => event.assistantMessageEvent?.type === "toolcall_end");
	assert.deepEqual(end?.message?.content?.[0]?.arguments, vinciMaskJson(args), "the released call shows its masked arguments");
	assert.notDeepEqual(end?.message?.content?.[0]?.arguments, {}, "not the held empty arguments");
});

// The fallback takes a streaming call the view masks before a later call the view does not mask that still
// carries streaming text (a provider or extension that keeps the buffer after the call ends).
test("json: masking consistency for streamed tool arguments, an out-of-range content index holds the streaming call before a later unmasked call that keeps its text", async () => {
	const run = secretRuns()["a multi-line hex secret"];
	const args = multiLineToolCalls(run.lines).bash;
	const after = [{ type: "toolCall", id: "call-2", name: "extension_tool", arguments: {}, partialJson: "{}" }];
	const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { id: "call-1", index: 5, after, finals: true });
	const out = await runJson(events);
	assertFallbackHeld(out, run.secret);
});

test("json: masking consistency for streamed tool arguments, an edit call's multi-line new text", async () => {
	for (const [name, run] of Object.entries(secretRuns())) {
		const text = ["Updated block:", ...run.lines, "end of block."].join("\n");
		for (const args of [
			{ path: "notes/out.txt", oldText: "old block", newText: text },
			{ path: "notes/out.txt", edits: [{ oldText: "old block", newText: text }] },
		]) {
			const { events } = toolCallEvents("edit", fragmentsOf(JSON.stringify(args), toolFragment));
			const out = await runJson(events);
			const deltas = deltasOf(out.events, "toolcall");
			assertMasked(deltas, run.secret, `${name}: joined deltas`);
			assertMasked(out.stdout, run.secret, `${name}: whole stdout`);
			assert.equal(deltas, JSON.stringify(vinciMaskJson(args)), `${name}: the release is the masked JSON of the parsed arguments`);
		}
	}
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
	test(`json: masking consistency for streamed tool arguments, a call streamed under the synonym "${name}" of ${tool}`, async () => {
		for (const { where, events, secret, args } of synonymCalls(name, tool)) {
			const out = await runJson(events);
			assertSynonymMasked(out, events, secret, `${name}, ${where}`);
			if (args) assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(args)), `${name}, ${where}: released as the built-in call is`);
		}
	});
}

test("json positive control: a name that is neither a built-in tool nor a synonym of one is not masked as a built-in", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	for (const name of ["constructor", "toString", "shell_helper", "Edit"]) {
		const { events } = toolCallEvents(name, splitAcross(json, token, 0));
		const out = await runJson(events);
		// 206q (timing, r2 Q4): every call is held while it streams, and its end events are as before.
		// 206r (F1, more masking): a tool the view does not mask releases the masked JSON of its arguments at its end.
		const ends = (lines) => lines.filter((line) => /^\{"type":"(message_end|turn_end|agent_end)"/.test(line) || line.includes('"type":"toolcall_end"'));
		assert.deepEqual(
			ends(out.stdout.split("\n").filter(Boolean)),
			ends(events.map((event) => JSON.stringify(vinciMaskJson(event)))),
			`${name}: end events as a tool the view does not mask`,
		);
		assert.equal(deltasOf(out.events, "toolcall"), JSON.stringify(vinciMaskJson(JSON.parse(json))), `${name}: released as the masked JSON of its arguments`);
	}
});

test("json: the text hold-back examines each streamed character a bounded number of times", () => {
	const lines = ["The quick brown fox jumps over the lazy dog; ok.", "A line that a later line may still change abc123"];
	let raw = "";
	for (let i = 0; raw.length < 100 * 1024; i++) raw += `${lines[i % 2]}\n`;
	const stream = new VinciStreamMask();
	const asst = (text) => assistant([block("text", text)]);
	const deltas = [];
	const keep = (outs) => {
		for (const event of outs) if (event.assistantMessageEvent?.type === "text_delta") deltas.push(event.assistantMessageEvent.delta);
	};
	const bound = 4 * raw.length;
	stream.process({ type: "message_start", message: assistant([]) });
	for (let at = 0; at < raw.length && stream.scannedChars < bound; at += 8) {
		const message = asst(raw.slice(0, at + 8));
		keep(stream.process({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: raw.slice(at, at + 8), partial: message } }));
	}
	assert.ok(stream.scannedChars < bound, `scanned ${stream.scannedChars} characters for a ${raw.length}-character text`);
	keep(stream.process({ type: "message_end", message: asst(raw) }));
	assert.equal(deltas.join(""), vinciMaskSecrets(raw), "positive control: the deltas add up to the masked text");
});

test("json: an open `${` holds its lines until it closes, so released text is never rewritten", async () => {
	const lines = ["Run this:", "cd ${PWD:-", "/srv/app};", "Done."];
	const { events } = streamEvents(lines);
	const out = await runJson(events);
	const end = out.events.find((event) => event.type === "message_end");
	assert.ok(fieldOf(end.message).includes(PLACEHOLDER), "fixture sanity: the closed value is masked");
	assertNeverRewritten(out.events, fieldOf(end.message));
	assert.equal(deltasOf(out.events), fieldOf(end.message), "the deltas add up to the message_end text");
});

test("json: an unclosed `${` is held with the rest of the body and released once, at the end", async () => {
	const items = Array.from({ length: 24 }, (_, i) => `item ${i + 1};`);
	const { events } = streamEvents(["Run this:", "echo ${HOME:-", ...items, "Done."], { end: false, withEnd: false });
	events.push({ type: "message_end", message: assistant([block("text", events.at(-1).message.content[0].text)]) });
	const out = await runJson(events);
	const endIndex = out.events.findIndex((event) => event.type === "message_end");
	// 206q (timing): nothing is released line by line any more; the whole body goes out once, just before message_end.
	assert.equal(deltasOf(out.events.slice(0, endIndex - 1)), "", "nothing is released before the end");
	assert.ok(out.events[endIndex - 1]?.assistantMessageEvent?.delta?.includes("item 1;"), "the whole body is released once, before message_end");
});

test("json: a BEGIN-line private key, streamed one line per update, never reaches stdout", async () => {
	const { begin, end: endMarker } = keyMarkers();
	const body = secretRuns()["an END-only private-key body"].secret;
	const { events } = streamEvents(["Here it is:", begin, ...body, endMarker, "That is all."]);
	const out = await runJson(events);
	assertMasked(out.stdout, body, "BEGIN block");
	const end = out.events.find((event) => event.type === "message_end");
	assertNeverRewritten(out.events, fieldOf(end.message));
	assert.equal(deltasOf(out.events), fieldOf(end.message), "the deltas add up to the message_end text");
});

for (const name of ["a multi-line base64 secret", "a multi-line hex secret"]) {
	test(`json: CRLF lines (${name}) never reach stdout and no released prefix ends in a stray carriage return`, async () => {
		const run = secretRuns()[name];
		const { events } = streamEvents(["Here it is:", ...run.lines, "That is all."], { eol: "\r\n" });
		const out = await runJson(events);
		assertMasked(out.stdout, run.secret, `CRLF ${name}`);
		const end = out.events.find((event) => event.type === "message_end");
		assertNeverRewritten(out.events, fieldOf(end.message));
		for (const event of out.events) {
			if (event.assistantMessageEvent?.type !== "text_delta") continue;
			const shown = event.message.content[0].text;
			if (shown !== fieldOf(end.message)) assert.ok(!shown.endsWith("\r"), "a released prefix does not end in a carriage return");
		}
		assert.equal(deltasOf(out.events), fieldOf(end.message), "the deltas add up to the message_end text");
	});
}

test("json: two text blocks each hold back and mask on their own", async () => {
	const runs = secretRuns();
	const a = ["First:", ...runs["a multi-line base64 secret"].lines, "Ok."];
	const b = ["Second:", ...runs["a multi-line hex secret"].lines, "Ok."];
	const events = [{ type: "message_start", message: assistant([]) }];
	const texts = ["", ""];
	const push = (type, index, extra = {}) => {
		const message = assistant(texts.filter((_, i) => i <= index || texts[i]).map((text) => block("text", text)));
		events.push({ type: "message_update", message, assistantMessageEvent: { type, contentIndex: index, partial: message, ...extra } });
	};
	for (const [index, lines] of [a, b].entries()) {
		push("text_start", index);
		for (const line of lines) {
			texts[index] += `${line}\n`;
			push("text_delta", index, { delta: `${line}\n` });
		}
		push("text_end", index, { content: texts[index] });
	}
	events.push({ type: "message_end", message: assistant(texts.map((text) => block("text", text))) });
	const out = await runJson(events);
	assertMasked(out.stdout, runs["a multi-line base64 secret"].secret, "block 0");
	assertMasked(out.stdout, runs["a multi-line hex secret"].secret, "block 1");
	const end = out.events.find((event) => event.type === "message_end");
	for (const index of [0, 1]) {
		assert.equal(deltasOf(out.events, "text", index), end.message.content[index].text, `block ${index}: the deltas add up`);
	}
});

test("json: a tool call after a held run leaves the run held, then writes it masked", async () => {
	const run = secretRuns()["a multi-line base64 secret"];
	const lines = ["Here it is:", ...run.lines];
	const text = lines.map((line) => `${line}\n`).join("");
	const { events: textEvents } = streamEvents(lines, { end: false, withEnd: false });
	const json = JSON.stringify({ command: "ls" });
	const { events: toolEvents } = toolCallEvents("bash", [json.slice(0, 5), json.slice(5)], {
		before: [block("text", text)],
		start: false,
	});
	const out = await runJson([...textEvents, ...toolEvents]);
	assertMasked(out.stdout, run.secret, "tool call after a held run");
	const end = out.events.find((event) => event.type === "message_end");
	assert.equal(deltasOf(out.events), fieldOf(end.message), "the text deltas add up to the message_end text");
	assert.equal(deltasOf(out.events, "toolcall"), json, "the tool-call deltas add up to its argument text");
});

test("json idempotence through the writer: already-masked text comes out unchanged", async () => {
	const values = Object.entries(secretRuns()).map(([name, run]) => [name, ["Here it is:", ...run.lines, "That is all."]]);
	values.push(["a single-line value", [`TOKEN=${inlineToken()}`]]);
	for (const [name, lines] of values) {
		const masked = vinciMaskSecrets(lines.map((line) => `${line}\n`).join(""));
		assert.ok(masked.includes(PLACEHOLDER), `${name}: fixture sanity: masked once`);
		const { events } = streamEvents(masked.split("\n").slice(0, -1));
		const out = await runJson(events);
		const end = out.events.find((event) => event.type === "message_end");
		assert.equal(fieldOf(end.message), masked, `${name}: message_end is unchanged`);
		assert.equal(deltasOf(out.events), masked, `${name}: the deltas are unchanged`);
	}
});

// Events that name no call (an out-of-range content index, no usable id): every tool call of that message is
// held and shown as interrupted in its final events; so is a built-in call the stream could not follow.
for (const [label, { events, secret }] of Object.entries(fallbackCases())) {
	test(`json: masking consistency for streamed tool arguments, events that name no call: ${label}`, async () => {
		const deltas = events.map((event) => event.assistantMessageEvent?.delta ?? "").join("");
		assert.ok(JSON.stringify(events).includes(secret[0]) || deltas.includes(secret[0]), "fixture sanity: the events carry the value");
		const out = await runJson(events);
		assertNoSecretBytes(out.stdout, secret, "whole stdout");
	});
}

// ---------------------------------------------------------------------------------------------------
// Review findings R221-01..05 through runPrintMode: with masking on, no raw secret byte reaches stdout.
// ---------------------------------------------------------------------------------------------------

/** No written event carries the raw `secret` (each named by its type), nor the whole stdout. */
function assertNoRawSecretInEvents(out, secret, where) {
	for (const event of out.events) assertNoRawSecret(JSON.stringify(event), secret, `${where}: ${event?.type} event`);
	assertNoRawSecret(out.stdout, secret, `${where}: whole stdout`);
}

// 206r (C4): the run completed: runPrintMode returned 0 and each expected terminal event was written (a run that
// failed part-way, its output cut short, would otherwise pass an absence check).
function assertCompleted(out, terminals, where) {
	assert.equal(out.exitCode, 0, `${where}: the run exits 0`);
	for (const type of terminals) assert.ok(out.events.some((event) => event?.type === type), `${where}: ${type} is written`);
}

// R221-01: a value the masker finds only once a later chunk arrives is never released raw.
for (const kind of ["text", "thinking"]) {
	for (const { label, chunks, secret } of crossLineCases()) {
		test(`json R221-01: ${kind}, ${label}: no raw secret byte reaches stdout`, async () => {
			const { events, text } = streamEvents(chunks, { kind, eol: "" });
			assert.ok(text.includes(secret), "fixture sanity: the raw stream holds the secret");
			assert.ok(!vinciMaskSecrets(text).includes(secret), "fixture sanity: the mask of the joined body hides the secret");
			const out = await runJson(events);
			assertNoRawSecret(out.stdout, secret, `R221-01 (json, ${kind}, ${label})`);
			assertCompleted(out, ["message_end"], `R221-01 (json, ${kind}, ${label})`); // 206r (C4)
		});
	}
}

// R221-05: bash output is masked as the view masks it, on the joined and final body, not per fragment. Inputs
// are the review probe's.
test("json R221-05: a bash result whose text parts join into a key block: no raw key byte reaches stdout", async () => {
	const { parts, hidden, details } = splitKeyResult();
	assert.ok(vinciMaskSecrets(parts[0]).includes(hidden), "fixture sanity: the first part alone is not masked");
	assert.ok(!vinciMaskSecrets(parts.join("\n")).includes(hidden), "fixture sanity: the mask of the joined body hides the body");
	const events = probeToolResultEvents(
		parts.map((text) => ({ type: "text", text })),
		details,
	);
	const out = await runJson(events);
	assertNoRawSecretInEvents(out, hidden, "R221-05 (json, parts join)");
	assertCompleted(out, ["tool_execution_end"], "R221-05 (json, parts join)"); // 206r (C4)
});

test("json R221-05: a cumulative bash update that ends before the END line: no raw key byte reaches stdout", async () => {
	const { cumulative, final, hidden } = splitKeyResult();
	assert.ok(vinciMaskSecrets(cumulative).includes(hidden), "fixture sanity: the first update alone is not masked");
	assert.ok(!vinciMaskSecrets(final).includes(hidden), "fixture sanity: the mask of the final body hides the body");
	const out = await runJson(probeCumulativeEvents(cumulative, final));
	assertNoRawSecretInEvents(out, hidden, "R221-05 (json, cumulative update)");
	assertCompleted(out, ["tool_execution_end"], "R221-05 (json, cumulative update)"); // 206r (C4)
});

// R221-02 [S3]: a terminal control sequence (or a carriage return) inside an assignment, as the review probe built
// it. These rows are S3's: when S3 is scoped out as a Known limit, run with VINCI_STREAM_MASK_S3_ROWS=0 and they
// are skipped with that reason.
const s3Rows = { skip: process.env.VINCI_STREAM_MASK_S3_ROWS === "0" ? "S3 scoped out (Known limit: control-sequence-split secrets)" : false };

test("json R221-02 [S3]: a control sequence inside an assignment in streamed bash arguments: no raw secret byte reaches stdout", s3Rows, async () => {
	const { secret, command } = ansiSecretCases();
	const out = await runJson(probeBashCallEvents(command));
	assertNoRawSecret(out.stdout, secret, "R221-02 (json, bash arguments)");
	assertCompleted(out, ["message_end", "agent_end"], "R221-02 (json, bash arguments)"); // 206r (C4)
});

for (const [label, field] of [
	["a control sequence", "ansiOutput"],
	["a carriage return", "crOutput"],
]) {
	test(`json R221-02 [S3]: ${label} inside an assignment in bash output: no raw secret byte reaches stdout`, s3Rows, async () => {
		const cases = ansiSecretCases();
		const { details } = splitKeyResult();
		const out = await runJson(probeToolResultEvents([{ type: "text", text: cases[field] }], details));
		assertNoRawSecret(out.stdout, cases.secret, `R221-02 (json, bash output, ${label})`);
		assertCompleted(out, ["tool_execution_end"], `R221-02 (json, bash output, ${label})`); // 206r (C4)
	});
}

test("json R221-02 [S3]: a control sequence inside an assignment in an assistant error message: no raw secret byte reaches stdout", s3Rows, async () => {
	const { secret, errorMessage } = ansiSecretCases();
	const message = { role: "assistant", content: [], stopReason: "error", errorMessage };
	const out = await runJson([{ type: "message_end", message }]);
	assertNoRawSecret(out.stdout, secret, "R221-02 (json, assistant error message)");
	// 206r (C4): this row's input is message_end alone (no agent_end by design): message_end is its terminal event.
	assertCompleted(out, ["message_end"], "R221-02 (json, assistant error message)");
});

// Append-only consumer (scripts/session-transcripts.ts): non-empty text deltas are appended to a buffer, which is
// printed and cleared at tool_execution_start and turn_end. There it must hold the full masked answer.
test("json consumer control (session transcripts): text deltas alone rebuild each masked answer by tool start and turn end", async () => {
	const runs = secretRuns();
	const answer = (run, intro) => [`${intro}\n`, ...run.lines.map((line) => `${line}\n`), "That is all."];
	const first = streamEvents(answer(runs["a multi-line base64 secret"], "Here it is:"), { eol: "" });
	const second = streamEvents(answer(runs["a multi-line hex secret"], "And this:"), { eol: "" });
	const events = [
		...first.events,
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "notes.txt" } },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "notes\n" }] }, isError: false },
		...second.events,
		{ type: "turn_end", message: second.events.at(-1).message, toolResults: [] },
	];
	const out = await runJson(events);
	const printed = [];
	let buffer = "";
	for (const event of out.events) {
		const source = event?.assistantMessageEvent;
		if (event?.type === "message_update" && source) {
			if (source.type === "text_delta" && source.delta) buffer += source.delta;
		} else if (event?.type === "tool_execution_start" && event.toolName) {
			if (buffer.trim()) {
				printed.push(buffer);
				buffer = "";
			}
		} else if (event?.type === "turn_end") {
			if (buffer.trim()) printed.push(buffer);
			buffer = "";
		}
	}
	const answers = out.events
		.filter((event) => event?.type === "message_end" && event.message?.role === "assistant" && Array.isArray(event.message.content))
		.map((event) => fieldOf(event.message));
	assert.equal(answers.length, 2, "two answers are written");
	for (const text of answers) assert.ok(typeof text === "string" && text.includes(PLACEHOLDER), "each written answer is masked");
	assert.deepEqual(printed, answers, "the consumer prints each full masked answer");
	assertMasked(printed.join("\n"), runs["a multi-line base64 secret"].secret, "consumer, first answer");
	assertMasked(printed.join("\n"), runs["a multi-line hex secret"].secret, "consumer, second answer");
});

test("json positive control (206q): ordinary prose arrives whole by text_end and the deltas rebuild the final text", async () => {
	const { events, text } = streamEvents(["First line.\n", "Second line, with a comma;\n", "Third (and last)."], { eol: "" });
	const out = await runJson(events);
	const endAt = out.events.findIndex((event) => event?.assistantMessageEvent?.type === "text_end");
	assert.ok(endAt > 0, "text_end is written");
	assert.equal(deltasOf(out.events.slice(0, endAt)), text, "the deltas before text_end rebuild the raw text");
	assert.equal(out.events[endAt].assistantMessageEvent.content, text, "text_end carries the raw text");
	const end = out.events.find((event) => event?.type === "message_end");
	assert.equal(end?.message?.content ? fieldOf(end.message) : undefined, text, "message_end carries the raw text");
	assert.ok(!out.stdout.includes(PLACEHOLDER), "nothing is masked");
});

test("json positive control (206q): ordinary bash output arrives whole at tool_execution_end", async () => {
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
	const out = await runJson(events);
	const joined = (parts) => (Array.isArray(parts) ? parts.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : undefined);
	const end = out.events.find((event) => event?.type === "tool_execution_end");
	assert.equal(joined(end?.result?.content), "line one\nline two", "tool_execution_end carries the whole output");
	const message = out.events.find((event) => event?.type === "message_end");
	assert.equal(joined(message?.message?.content), "line one\nline two", "the tool result message carries the whole output");
	assert.ok(!out.stdout.includes(PLACEHOLDER), "nothing is masked");
});

// Masking off is byte-identical to main: one fixed run against a golden captured on main by the host.
const maskingOffGolden = resolve(here, "fixtures/stream-masking-off-golden.json");

test("json with masking off: one fixed run's stdout is byte-identical to the golden captured on main", async () => {
	assert.ok(existsSync(maskingOffGolden), `the masking-off golden is at ${maskingOffGolden}`);
	const golden = JSON.parse(readFileSync(maskingOffGolden, "utf8"));
	assert.ok(Array.isArray(golden?.fixture?.events) && golden.fixture.events.length > 0, "fixture sanity: the golden holds its events");
	assert.equal(typeof golden?.json, "string", "fixture sanity: the golden holds the json stdout");
	const out = await runJson(golden.fixture.events, { masking: false });
	assert.equal(out.stdout, golden.json, "masking off: stdout is byte-identical to main");
});

// ---------------------------------------------------------------------------------------------------
// 206r: a tool the view does not mask, replayed signatures and serialization hooks, through runPrintMode.
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

/** The stdout line of the first written event that `matches`. */
const lineOf = (stdout, matches) => stdout.split("\n").find((line) => line !== "" && matches(JSON.parse(line)));

// 206r (F1): a call of a tool the view does not mask releases the masked JSON of its arguments, so no value
// under a secret name reaches a toolcall_delta, the toolcall_end event, message_end or anything else.
test("json 206r (F1): a call of a tool the view does not mask: no value under a secret name reaches its deltas, toolcall_end or message_end", async () => {
	const { args, values } = f1Arguments();
	const json = JSON.stringify(args);
	const fragments = fragmentsOf(json, 7);
	for (const value of Object.values(values)) {
		assert.ok(!fragments.some((fragment) => fragment.includes(value)), `fixture sanity: ${value} is split across deltas`);
	}
	const { events, final } = toolCallEvents("mytool", fragments, { finals: true, keepPartialOnEnd: true });
	assert.equal(final?.content?.[0]?.partialJson, json, "fixture sanity: the final message keeps the raw text");
	const out = await runJson(events);
	assertCompleted(out, ["message_end", "agent_end"], "206r (F1, json)");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "toolcall_delta");
	assert.ok(deltas.length >= fragments.length, "fixture sanity: the toolcall_delta events are written");
	const toolcallEnd = lineOf(out.stdout, (event) => event?.assistantMessageEvent?.type === "toolcall_end");
	const messageEnd = lineOf(out.stdout, (event) => event?.type === "message_end");
	assert.ok(toolcallEnd && messageEnd, "the toolcall_end and message_end events are written");
	for (const [name, value] of Object.entries(values)) {
		deltas.forEach((event, n) => assertNoRawSecret(event.assistantMessageEvent.delta, value, `206r (F1, json): ${name}: toolcall_delta ${n}`));
		assertNoRawSecret(toolcallEnd, value, `206r (F1, json): ${name}: the toolcall_end event`);
		assertNoRawSecret(messageEnd, value, `206r (F1, json): ${name}: the message_end event`);
		assertNoRawSecret(out.stdout, value, `206r (F1, json): ${name}: whole stdout`);
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
	return { events: [...shown, { type: "turn_end", message: final, toolResults: [] }, { type: "agent_end", messages: [final] }], text };
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

test("json 206r (C2): a private-key body inside a reasoning item's summary kept as thinkingSignature: no raw key byte reaches stdout", async () => {
	const run = secretRuns()["an END-only private-key body"];
	const lines = ["Checking the deploy key:", ...run.lines, "Done."];
	const signature = reasoningSignature(`${lines.join("\n")}\n`);
	assert.ok(signature.includes(run.secret[0].slice(0, 12)), "fixture sanity: the signature carries the key body");
	// 206r (C2 fixture): the opaque fields share no window with the key body, so a red row means the summary text leaked.
	const { summary: _summary, ...opaque } = JSON.parse(signature);
	assertNoSecretBytes(JSON.stringify(opaque), run.secret, "fixture sanity: the signature outside its summary");
	const { events } = signedThinkingEvents(lines, signature);
	const out = await runJson(events);
	assertCompleted(out, ["message_end", "agent_end"], "206r (C2, json)");
	for (const event of out.events) assertNoSecretBytes(JSON.stringify(event), run.secret, `206r (C2, json): ${eventName(event)} event`);
	assertNoSecretBytes(out.stdout, run.secret, "206r (C2, json): whole stdout");
	const written = signaturesIn(out.events.find((event) => event?.type === "message_end"));
	assert.equal(written.length, 1, "message_end carries the signature");
	assert.ok(JSON.parse(written[0]).summary[0].text.includes(PLACEHOLDER), "the signature is masked decoded: its summary text holds the placeholder");
});

test("json positive control 206r (C2): a reasoning item with no secret, kept as thinkingSignature, is written byte-identical", async () => {
	const lines = ["Looked at the repository layout.", "Planned a small edit to the parser."];
	const signature = reasoningSignature(`${lines.join("\n")}\n`);
	const { events } = signedThinkingEvents(lines, signature);
	const out = await runJson(events);
	assertCompleted(out, ["message_end", "agent_end"], "206r (C2 control, json)");
	const written = signaturesIn(out.events);
	assert.ok(written.length >= 4, "fixture sanity: thinking_end, message_end, turn_end and agent_end carry the signature");
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

test("json 206r (C3): details whose toJSON returns an object with its own toJSON: no raw secret reaches stdout", async () => {
	const secret = fakeSecret();
	for (const depth of [2, 3]) {
		const details = hookChain(depth, `password=${secret}`);
		let reached = details;
		for (let level = 0; level < depth; level++) reached = reached.toJSON();
		assert.equal(reached, `password=${secret}`, `fixture sanity: depth ${depth}: the hooks end in the secret`);
		const out = await runJson(detailsEvents(details));
		assertCompleted(out, ["tool_execution_end", "message_end"], `206r (C3, json, depth ${depth})`);
		assertNoRawSecret(out.stdout, secret, `206r (C3, json, depth ${depth}): whole stdout`);
		const end = out.events.find((event) => event?.type === "tool_execution_end");
		assert.deepEqual(end?.result?.details, JSON.parse(JSON.stringify(details)), `depth ${depth}: details serialise as JSON.stringify serialises them`);
	}
});

test("json positive control 206r (C3): ordinary toJSON values and function-valued properties serialise as JSON.stringify serialises them", async () => {
	const details = { when: new Date(0), info: { toJSON: () => ({ note: "plain text" }) }, list: [1, () => 1, "x"], hook: () => 1 };
	const out = await runJson(detailsEvents(details));
	assertCompleted(out, ["tool_execution_end", "message_end"], "206r (C3 control, json)");
	const expected = JSON.parse(JSON.stringify(details));
	assert.deepEqual(expected, { when: "1970-01-01T00:00:00.000Z", info: { note: "plain text" }, list: [1, null, "x"] }, "fixture sanity");
	const end = out.events.find((event) => event?.type === "tool_execution_end");
	assert.deepEqual(end?.result?.details, expected, "tool_execution_end details are unchanged");
	const message = out.events.find((event) => event?.type === "message_end");
	assert.deepEqual(message?.message?.details, expected, "the tool result message's details are unchanged");
});

// ---------------------------------------------------------------------------------------------------
// 206s: review findings B01..B08 through runPrintMode. Inputs are the review probes', byte for byte. Each row
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
const streamMaskModule = await import(resolve(src, "core/vinci-stream-mask.ts"));
const ansiModule = await import(resolve(src, "utils/ansi.ts"));

/** The test-only hold-bounds setter; where it is not exported the row fails here, by an assertion. */
function holdLimitsSetter() {
	const set = streamMaskModule.vinciSetStreamHoldLimitsForTest;
	if (typeof set !== "function") assert.fail("206s (B05): vinciSetStreamHoldLimitsForTest is exported (the hold bounds can be set for a test)");
	return set;
}

/** The nonempty deltas of one kind, as the written events that carry them. */
const releasedDeltas = (events, kind = "text") =>
	events.filter((event) => event?.type === "message_update" && event.assistantMessageEvent?.type === `${kind}_delta` && event.assistantMessageEvent.delta !== "");

// 206s (B01): a cut or interrupted call keeps no released raw prefix of a value: a value whose context the cut may
// have removed is the placeholder, whole.
test("json 206s (B01): an aborted call whose argument text was cut after a complete multi-line value: no raw secret byte reaches stdout", async () => {
	const { events, command, secret } = interruptedCutEvents();
	assert.ok(command.includes(secret), "fixture sanity: the command carries the secret");
	assert.ok(!vinciMaskSecrets(command).includes(secret), "fixture sanity: the view masks the whole command");
	const out = await runJson(events);
	assertNoRawSecretInEvents(out, secret, "206s (B01, json, interrupted)");
	assertCompleted(out, ["message_end", "agent_end"], "206s (B01, json, interrupted)");
	for (const event of out.events.filter((event) => event.type === "message_end" || event.type === "agent_end")) {
		const message = event.type === "agent_end" ? event.messages[0] : event.message;
		assert.equal(message.content[0].arguments.command, PLACEHOLDER, `${event.type}: the cut call's command is the placeholder, whole`);
	}
});

test("json 206s (B01): a completed call that keeps argument text cut after a complete multi-line value (retained invalid partial): no raw secret byte reaches stdout", async () => {
	const { events, command, secret, message } = retainedCutEvents();
	assert.ok(!vinciMaskSecrets(command).includes(secret), "fixture sanity: the view masks the whole command");
	assert.throws(() => JSON.parse(message.content[0].partialJson), SyntaxError, "fixture sanity: the retained partial argument text is not complete JSON");
	const out = await runJson(events);
	assertNoRawSecretInEvents(out, secret, "206s (B01, json, retained cut text)");
	assertCompleted(out, ["message_end", "turn_end", "agent_end"], "206s (B01, json, retained cut text)");
});

// 206s (B02): a reasoning item's parts are masked joined, as the provider joins them into the thinking block.
for (const field of ["summary", "content"]) {
	test(`json 206s (B02): a private-key body split across a reasoning item's ${field} entries, kept as thinkingSignature: no raw key byte reaches stdout`, async () => {
		const { events, run, message } = splitReasoningMessage(field);
		assert.ok(run.secret.some((line) => vinciMaskSecrets(line) === line), "fixture sanity: an entry alone is not masked");
		assert.ok(vinciMaskSecrets(message.content[0].thinking).includes(PLACEHOLDER), "fixture sanity: the joined body (the thinking block) is masked");
		const out = await runJson(events);
		assertNoSecretBytes(out.stdout, run.secret, `206s (B02, json, ${field}): whole stdout`);
		assertCompleted(out, ["message_end", "agent_end"], `206s (B02, json, ${field})`);
		const written = signaturesIn(out.events.find((event) => event?.type === "message_end"));
		assert.equal(written.length, 1, "message_end carries the signature");
		const decoded = JSON.parse(written[0]);
		assert.ok(decoded[field].map((part) => part.text).join("\n\n").includes(PLACEHOLDER), `the signature's ${field} text holds the placeholder`);
	});
}

// 206s (B03): the stream normalises control strings with the error view's own function.
test("json 206s (B03): a DCS string inside an assignment's key in an assistant error: no raw secret byte reaches stdout", async () => {
	const { secret, errorMessage, events } = controlStringError();
	const out = await runJson(events);
	assertNoRawSecret(out.stdout, secret, "206s (B03, json)");
	assertCompleted(out, ["message_end", "agent_end"], "206s (B03, json)");
	const strip = ansiModule.vinciStripControlText;
	if (typeof strip !== "function") assert.fail("206s (B03): utils/ansi.ts exports the shared control normaliser vinciStripControlText");
	assert.ok(!vinciMaskSecrets(strip(errorMessage)).includes(secret), "positive control: the error view's transform masks the secret");
});

// 206s (B04): a tool's latest progress is kept and released once, masked, when nothing later carries it.
test("json 206s (B04): a tool's progress followed by the end of the run (no tool end) goes out once, as the placeholder", async () => {
	const { text, update } = progressEvents();
	const out = await runJson([update]);
	assert.equal(out.exitCode, 0, "206s (B04, json, update then end of run): the run exits 0");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	assert.equal(released[0].toolCallId, "partial-only", "for its tool call");
	// 206t (expectation: more masking): a kept partial result never reached its end, so it goes out as the placeholder
	// with empty details, not masked whole.
	assert.ok(text !== PLACEHOLDER, "fixture sanity: the progress is ordinary text");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
	assert.deepEqual(released[0].partialResult.details, {}, "with empty details");
});

test("json 206s (B04): a tool's progress followed by an error-only tool end goes out once, before the end, as the placeholder", async () => {
	const { text, errorUpdate, errorEnd } = progressEvents();
	const out = await runJson([errorUpdate, errorEnd]);
	assertCompleted(out, ["tool_execution_end"], "206s (B04, json, update then error)");
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

test("json 206s (B04): a tool's progress that is a key body cut before its END line goes out as the placeholder: no raw key byte reaches stdout", async () => {
	const { body, final, hidden, update } = keyBlockProgress();
	assert.ok(vinciMaskSecrets(body).includes(hidden), "fixture sanity: the cut body alone is not masked");
	assert.ok(!vinciMaskSecrets(final).includes(hidden), "fixture sanity: the whole body is masked");
	const out = await runJson([update]);
	assert.equal(out.exitCode, 0, "206s (B04, json, key-block progress): the run exits 0");
	assertNoRawSecretInEvents(out, hidden, "206s (B04, json, key-block progress)");
	const released = out.events.filter((event) => event?.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes(PLACEHOLDER));
	assert.equal(released.length, 1, "the kept progress is written once, as the placeholder (it cannot be masked whole)");
	assert.deepEqual(released[0].partialResult.details, {}, "its details are empty");
});

test("json 206s (B04): a tool's progress cut inside an angle value, then an error-only end, goes out as the placeholder: no raw secret byte reaches stdout", async () => {
	const { secret, body, update, errorEnd } = angleCutCase();
	assert.ok(vinciMaskSecrets(body).includes(secret), "fixture sanity: the cut body alone is not masked");
	assert.ok(!vinciMaskSecrets(`${body}>\n`).includes(secret), "fixture sanity: with its closing line it is masked");
	const lineMayChange = streamMaskModule.vinciLineMayChange;
	assert.ok(body.split("\n").slice(0, -1).every((line) => !lineMayChange(line, false)), "fixture sanity: the hold-back releases every line");
	const out = await runJson([update, errorEnd]);
	assertCompleted(out, ["tool_execution_end"], "206s (B04, json, angle-cut progress)");
	assertNoRawSecretInEvents(out, secret, "206s (B04, json, angle-cut progress)");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder (a later line could still mask it)");
	assert.deepEqual(released[0].partialResult.details, {}, "its details are empty");
});

// 206s (B05): a held body has a byte bound and a deadline; at either it goes out at once, and nothing raw follows.
test("json 206s (B05): a text block past the byte bound goes out at once, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const run = secretRuns()["an END-only private-key body"];
	const { events } = streamEvents(["Here it is:", ...run.lines, "That is all."]);
	set({ maxBytes: 200 });
	let out;
	try {
		out = await runJson(events);
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206s (B05, json, text cap)");
	assertNoSecretBytes(out.stdout, run.secret, "206s (B05, json, text cap): whole stdout");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "text_delta");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the body was cut inside the key body");
	assert.ok(out.events.indexOf(released[0]) < out.events.indexOf(deltas.at(-1)), "at the bound, before the block's later deltas");
});

test("json 206s (B05): a text block cut inside an angle value at the byte bound goes out as the placeholder: no raw secret byte reaches stdout", async () => {
	const set = holdLimitsSetter();
	const { secret, body, lines, cutBytes } = angleCutCase();
	assert.ok(vinciMaskSecrets(body).includes(secret), "fixture sanity: the cut body alone is not masked");
	const { events } = streamEvents(lines);
	set({ maxBytes: cutBytes });
	let out;
	try {
		out = await runJson(events);
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206s (B05, json, angle-cut text cap)");
	assertNoRawSecretInEvents(out, secret, "206s (B05, json, angle-cut text cap)");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "text_delta");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the body was cut inside the angle value");
	assert.ok(out.events.indexOf(released[0]) < out.events.indexOf(deltas.at(-1)), "at the bound, before the block's later deltas");
});

test("json 206s (B05): a tool call's argument text past the byte bound goes out at once, as the placeholder; its held text is dropped", async () => {
	const set = holdLimitsSetter();
	const chunk = "x".repeat(256);
	const fragments = ['{"command":"', ...Array.from({ length: 16 }, () => chunk)];
	const { events } = toolCallEvents("bash", fragments, { ending: "none" });
	set({ maxBytes: 1024 });
	let out;
	try {
		out = await runJson(events);
	} finally {
		set();
	}
	assert.equal(out.exitCode, 0, "206s (B05, json, argument cap): the run exits 0");
	const deltas = out.events.filter((event) => event?.assistantMessageEvent?.type === "toolcall_delta");
	const released = releasedDeltas(out.events, "toolcall");
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder: the text so far does not parse");
	assert.ok(out.events.indexOf(released[0]) < out.events.indexOf(deltas.at(-1)), "at the bound, before the call's later deltas");
	// The held state stays bounded however long the call streams (measured on the masker itself).
	const stream = new VinciStreamMask();
	let raw = "";
	set({ maxBytes: 16384 });
	try {
		for (let n = 0; n < 64; n++) {
			const delta = "x".repeat(4096);
			raw += delta;
			const call = { type: "toolCall", id: "growing", name: "bash", arguments: {}, partialJson: raw };
			const message = assistant([call]);
			stream.process({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta, partial: message } });
		}
	} finally {
		set();
	}
	assert.ok(stream.tools.get(0).raw.length <= 16384, `the held argument text stays bounded (${stream.tools.get(0).raw.length} characters)`);
});

test("json 206s (B05): a text block held for the deadline (10 minutes, a fake clock) goes out at once, as the placeholder", async () => {
	const set = holdLimitsSetter();
	let now = 0;
	const lines = ["First line.\n", "Second line.\n", "Third line.\n", "Fourth line.\n", "Fifth line.\n"];
	const { events } = streamEvents(lines, { eol: "" });
	// message_start, text_start, five deltas, text_end, message_end
	const head = events.slice(0, 4);
	const [third, fourth, ...tail] = events.slice(4);
	set({ now: () => now });
	let out;
	try {
		out = await runJson(head, {
			during: async ({ listener }) => {
				now = 599_999;
				listener(third);
				now = 600_000;
				listener(fourth);
				for (const event of tail) listener(event);
			},
		});
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206s (B05, json, deadline)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	// 206t (expectation: more masking): a body cut at the deadline goes out as the placeholder, never as the mask of the
	// text so far.
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the deadline (not before), the placeholder");
});

// 206s (B06): after the watchdog's flush no event is taken: a late end event releases nothing again.
test("json 206s (B06): a late text_end during the watchdog exit's drain gives no second release", async () => {
	const message = assistant([block("text", "ordinary progress.")]);
	const late = [
		{ type: "message_update", message, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ordinary progress.", partial: message } },
		{ type: "message_end", message },
		{ type: "agent_end", messages: [message] },
	];
	const savedCode = process.env.VINCI_CODE;
	const savedTimeout = process.env.VINCI_PRESTREAM_TIMEOUT_MS;
	process.env.VINCI_CODE = "1";
	process.env.VINCI_PRESTREAM_TIMEOUT_MS = "40";
	const chunks = [];
	const exits = [];
	// The session callback is kept past any unsubscribe: a late event still reaches it, and only the mode can ignore it.
	let callback;
	let endPrompt;
	const promptEnded = new Promise((resolvePrompt) => {
		endPrompt = resolvePrompt;
	});
	let drainHeld = false;
	const messages = [];
	const session = {
		state: { messages },
		agent: { waitForIdle: async () => {} },
		sessionManager: { getHeader: () => undefined },
		extensionRunner: undefined,
		bindExtensions: async () => {},
		subscribe(fn) {
			callback = fn;
			return () => {};
		},
		prompt: async () => {
			callback({ type: "message_start", message: assistant([]) });
			callback({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ordinary progress.", partial: message } });
			await promptEnded;
			messages.push(message);
		},
	};
	const runtime = { session, setRebindSession() {}, dispose: async () => {} };
	const realExit = process.exit;
	const savedError = console.error;
	process.stdout.write = function (chunk, encodingOrCallback, cb) {
		if (typeof chunk !== "string") return realWrite.call(process.stdout, chunk, encodingOrCallback, cb);
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : cb;
		chunks.push(chunk);
		if (chunk === "" && exits.length === 0 && !drainHeld) {
			// The watchdog exit's drain is held while the late events arrive.
			drainHeld = true;
			setImmediate(() => {
				for (const event of late) callback(event);
				setImmediate(() => done?.());
			});
			return true;
		}
		done?.();
		return true;
	};
	process.exit = (code) => {
		exits.push(code);
		endPrompt();
	};
	console.error = () => {};
	let returned;
	try {
		returned = await runPrintMode(runtime, { mode: "json", initialMessage: "go" });
	} finally {
		process.stdout.write = realWrite;
		process.exit = realExit;
		console.error = savedError;
		setPrintModeTerminatingForTest(false);
		process.exitCode = undefined;
		if (savedCode === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = savedCode;
		if (savedTimeout === undefined) delete process.env.VINCI_PRESTREAM_TIMEOUT_MS;
		else process.env.VINCI_PRESTREAM_TIMEOUT_MS = savedTimeout;
	}
	assert.equal(exits[0], 1, "206s (B06): the watchdog exit (1) is requested");
	assert.ok(drainHeld, "fixture sanity: the late events arrived while the exit's drain was held");
	assert.equal(typeof returned, "number", "the run returned");
	const events = parseLines(chunks.join(""));
	const released = releasedDeltas(events);
	assert.equal(released.length, 1, "exactly one nonempty delta: the late text_end releases nothing again");
	// 206t (expectation: more masking): the watchdog's flush cut the block before its end, so it goes out as the
	// placeholder, not as the mask of the text so far.
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "the placeholder, once");
});

// 206s (B07): an own "__proto__" key and its data survive the masker, as JSON.stringify writes them.
test("json 206s (B07): an own __proto__ key in tool details, nested and through toJSON, is written as JSON.stringify writes it", async () => {
	for (const [label, details] of [
		["parsed", ownProtoDetails()],
		["through toJSON", { toJSON: () => ownProtoDetails() }],
	]) {
		const events = detailsEvents(details);
		assert.ok(JSON.stringify(events[1]).includes('"__proto__":{"note":"plain preserved data"'), `${label}: fixture sanity: JSON.stringify writes the own key`);
		const out = await runJson(events);
		assertCompleted(out, ["tool_execution_end", "message_end"], `206s (B07, json, ${label})`);
		const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
		assert.equal(line, JSON.stringify(events[1]), `${label}: the tool_execution_end line is JSON.stringify's, own __proto__ key and data included`);
	}
});

// 206s (B08): String, Number and Boolean objects are written as their values, as JSON.stringify writes them.
test("json 206s (B08): String, Number and Boolean objects in tool details, nested in an array too, are written as JSON.stringify writes them", async () => {
	const events = detailsEvents(boxedDetails());
	assert.ok(JSON.stringify(events[1]).includes('"message":"ordinary boxed message","count":7,"flag":true'), "fixture sanity: JSON.stringify writes the values");
	const out = await runJson(events);
	assertCompleted(out, ["tool_execution_end", "message_end"], "206s (B08, json)");
	const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
	assert.equal(line, JSON.stringify(events[1]), "the tool_execution_end line is JSON.stringify's");
});

test("json 206s (B08): a String or Number object under a secret name is masked as its value is", async () => {
	const secret = fakeSecret();
	const details = { password: new String(secret), list: [{ password: new String(secret) }], auth: { password: new Number(4242) } };
	const plain = { password: secret, list: [{ password: secret }], auth: { password: 4242 } };
	const out = await runJson(detailsEvents(details));
	assertCompleted(out, ["tool_execution_end", "message_end"], "206s (B08, json, secret name)");
	assertNoRawSecret(out.stdout, secret, "206s (B08, json, secret name): whole stdout");
	const end = out.events.find((event) => event?.type === "tool_execution_end");
	assert.equal(typeof end?.result?.details?.password, "string", "written as a string, as JSON.stringify writes it");
	assert.deepEqual(end.result.details, JSON.parse(JSON.stringify(vinciMaskJson(plain))), "masked as the values are masked under their names");
});

// ---------------------------------------------------------------------------------------------------
// 206t: review findings D01..D05 through runPrintMode. Inputs are the review probes', byte for byte. Each row asserts
// the run completed, and fails on the code before 206t by an assertion (a cut token byte on stdout, retained bytes over
// the bound, a lost update, an output that differs from JSON.stringify's), never by a crash.
// ---------------------------------------------------------------------------------------------------

const {
	assertNoPrefixBytes,
	boundedInputs,
	checkpointUpdate,
	crossRealmBoxed,
	angleCrossCheckInputs,
	cutHoldCrossCheckInputs,
	earlyCutCases,
	multiByteStartEvents,
	overriddenBoxed,
	probeSecret,
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

// 206t (D01): a body cut before its natural end (a bound, the deadline, the end of the run, an error-only end) goes out as
// the placeholder, never as the mask of its prefix.
test("json 206t (D01): a token cut below its minimum length at a text block's byte bound goes out as the placeholder: no byte past its head reaches stdout", async () => {
	const set = holdLimitsSetter();
	const { prefix, full, tail } = tokenControl("206t (D01, json, text cap)");
	const { events } = streamEvents([prefix, full.slice(prefix.length)], { eol: "" });
	set({ maxBytes: 16 });
	let out;
	try {
		out = await runJson(events);
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D01, json, text cap): whole stdout");
	assertCompleted(out, ["message_end"], "206t (D01, json, text cap)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the bound, the placeholder");
	const end = out.events.find((event) => event?.type === "message_end");
	assert.equal(fieldOf(end.message), vinciMaskSecrets(full), "positive control: message_end carries the whole token, masked to its head");
});

test("json 206t (D01): a token cut below its minimum length at a text block's deadline (a fake clock) goes out as the placeholder: no byte past its head reaches stdout", async () => {
	const set = holdLimitsSetter();
	const { prefix, full, tail } = tokenControl("206t (D01, json, text deadline)");
	const cut = probeTextMessage(prefix);
	const whole = probeTextMessage(full);
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	try {
		out = await runJson([{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(cut, prefix)], {
			during: async ({ listener }) => {
				now = 101;
				listener(probeTextUpdate(cut, ""));
				listener(probeTextUpdate(whole, full.slice(prefix.length)));
				listener({ type: "message_update", message: whole, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: full, partial: whole } });
				listener({ type: "message_end", message: whole });
			},
		});
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D01, json, text deadline): whole stdout");
	assertCompleted(out, ["message_end"], "206t (D01, json, text deadline)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the deadline, the placeholder");
	const end = out.events.find((event) => event?.type === "message_end");
	assert.equal(fieldOf(end.message), vinciMaskSecrets(full), "positive control: message_end carries the whole token, masked to its head");
});

test("json 206t (D01): a token cut below its minimum length when the run ends before its block ends goes out as the placeholder: no byte past its head reaches stdout", async () => {
	const { prefix, tail } = tokenControl("206t (D01, json, text end of run)");
	const cut = probeTextMessage(prefix);
	const out = await runJson([{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(cut, prefix)]);
	assertNoPrefixBytes(out.stdout, tail, "206t (D01, json, text end of run): whole stdout");
	assert.equal(out.exitCode, 0, "206t (D01, json, text end of run): the run exits 0");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release, at the end of the run");
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
	test(`json 207 (S-R1n, ${variant}): a held line is cut as one placeholder, never raw`, async () => {
		const where = `207 (S-R1n, json, ${variant})`;
		const out = await runJson(earlyEndEvents(body, stopReason, withError));
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

for (const [ch, where] of [
	["-", "207 (S-G1, json, -)"],
	["_", "207 (S-G1, json, _)"],
]) {
	test(`json 207 (S-G1, control): a line ending in "${ch}" is released unchanged at text_end`, async () => {
		const { events, text: body } = streamEvents([`build step${ch}`, " done"], { eol: "" });
		const out = await runJson(events);
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

test("json 207 (S-C1/E3, control): benign prose ending in a dash is released unchanged at text_end", async () => {
	const { events, text } = streamEvents(["see the release-candidate-", "then read the notes."]);
	const out = await runJson(events);
	assertCompleted(out, ["message_end"], "207 (S-C1/E3, json)");
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
		test(`json 206t (D01): ${label}, ${ending}: the complete lines go out masked, then the placeholder; no byte past the token's head reaches stdout`, async () => {
			const where = `206t (D01, json, ${label}, ${ending})`;
			const { tail } = tokenControl(where);
			const out = await runJson(earlyEndEvents(text, stopReason, withError));
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
	test(`json 206t (D01): a block cut ${ending}: every final event shows the block exactly as its streamed deltas wrote it`, async () => {
		const where = `206t (D01, json, final equals streamed, ${ending})`;
		const { tail } = tokenControl(where);
		const { text } = earlyCutCases()[1];
		const out = await runJson(earlyEndEvents(text, stopReason, withError));
		assertCompleted(out, ["message_end", "agent_end"], where);
		assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
		const streamed = deltasOf(out.events);
		assert.ok(streamed.includes("Here it is:") && streamed.endsWith(PLACEHOLDER), `${where}: fixture sanity: complete lines, then the placeholder`);
		const finals = finalTexts(out.events);
		assert.equal(finals.length, withError ? 3 : 2, `${where}: the final events are written`);
		for (const [type, shown] of finals) assert.equal(shown, streamed, `${where}: ${type} shows the block as the stream wrote it`);
	});
}

test("json 206t (D01): multi-line control: a full token on an earlier complete line is masked to its head and its lines stay; the cut last line is the placeholder", async () => {
	const where = "206t (D01, json, multi-line control)";
	const { full, tail } = tokenControl(where);
	const out = await runJson(earlyEndEvents(earlyCutCases()[1].text, "aborted", false));
	assertCompleted(out, ["message_end"], where);
	assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
	const streamed = deltasOf(out.events);
	assert.ok(streamed.startsWith("Here it is:\nThe old token was "), `${where}: the complete lines stay`);
	assert.ok(streamed.includes(`${vinciMaskSecrets(full)}.\n`), `${where}: the full token is masked to its head`);
	assert.ok(streamed.endsWith(`.\n${PLACEHOLDER}`), `${where}: the cut last line is the placeholder`);
});

test("json 206t (D01): positive control: a message that ended normally (done, stopReason stop, no text_end) releases the whole token masked to its head, not the placeholder", async () => {
	const where = "206t (D01, json, done stop)";
	const { full, tail } = tokenControl(where);
	const whole = endedWith(full, "stop");
	const out = await runJson([
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

test("json 206t (D01): a block of an early-ended message that never streamed a delta goes out in the cut form: no byte past the token's head reaches stdout", async () => {
	const where = "206t (D01, json, never streamed)";
	const { prefix, tail } = tokenControl(where);
	const ended = endedWith(prefix, "aborted");
	const out = await runJson([
		{ type: "message_start", message: probeTextMessage("") },
		{ type: "message_end", message: ended },
		{ type: "agent_end", messages: [ended] },
	]);
	assertCompleted(out, ["message_end", "agent_end"], where);
	assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
	assert.equal(deltasOf(out.events), PLACEHOLDER, `${where}: one delta, the placeholder`);
	for (const [type, shown] of finalTexts(out.events)) assert.equal(shown, PLACEHOLDER, `${where}: ${type} shows the block as the stream wrote it`);
});

// 206t (D01): the open-angle rule of a cut block is the mask's own (an angle value after `:` / `=` is joined up to the
// next `>`, across lines), widened to any name. Cross-check: on every input the mask joins, the rule finds the open
// value; with a secret name the two agree exactly; without one the rule may only be wider (fail closed).
test("json 206t (D01): the open-angle rule of a cut block agrees with the mask: every value the mask joins across lines is found open", () => {
	const { vinciOpenAngleLine } = streamMaskModule;
	if (typeof vinciOpenAngleLine !== "function") assert.fail("206t (D01): vinci-stream-mask.ts exports vinciOpenAngleLine (the open-angle rule of a cut block)");
	const secret = probeSecret();
	const wider = [];
	for (const { text, keyed } of angleCrossCheckInputs()) {
		const joins = !vinciMaskSecrets(`${text}${secret}>\n`).includes(secret);
		const open = vinciOpenAngleLine(text) >= 0;
		if (joins) assert.ok(open, `${JSON.stringify(text)}: the mask joins the next lines, so the value is open`);
		if (keyed) assert.equal(open, joins, `${JSON.stringify(text)}: with a secret name the rule and the mask agree`);
		else if (open && !joins) wider.push(text);
	}
	assert.ok(wider.length > 0, "fixture sanity: an input without a secret name shows the rule's fail-closed widening");
	assert.ok(angleCrossCheckInputs().some(({ keyed, text }) => keyed && vinciOpenAngleLine(text) < 0), "fixture sanity: a closed keyed value");
});

// 206t (D01): every construct of the mask that lets later text change how earlier complete lines are masked is held at
// a cut. Cross-check against the mask itself: on each input the mask is run on the opened and the closed text, and
// whether the later text changed the earlier masked lines is observed, not assumed; the lines the hold releases
// (vinciCutHeadEnd), masked, must be how the closed text masks them (trailing white space aside: an END marker joins
// its run to the line before it), and a control the mask does not change is released whole.
for (const construct of [...new Set(cutHoldCrossCheckInputs().map((input) => input.construct))]) {
	test(`json 206t (D01): the cut hold agrees with the mask for ${construct}: the lines it releases are masked as the closed text masks them`, () => {
		const headEnd = streamMaskModule.vinciCutHeadEnd;
		if (typeof headEnd !== "function") assert.fail("206t (D01): vinci-stream-mask.ts exports vinciCutHeadEnd (where the released part of a cut block ends)");
		const inputs = cutHoldCrossCheckInputs().filter((input) => input.construct === construct);
		for (const { opened, closed, changes, release, held } of inputs) {
			const where = `${construct}: ${JSON.stringify(opened.slice(-40))}`;
			const maskedClosed = vinciMaskSecrets(closed);
			const changed = !maskedClosed.startsWith(vinciMaskSecrets(opened).trimEnd());
			assert.equal(changed, changes, `${where}: fixture sanity: the mask ${changes ? "changes" : "does not change"} the earlier lines once the later text arrives`);
			const end = headEnd(opened);
			assert.ok(Number.isInteger(end) && end >= 0 && end <= opened.length, `${where}: the released end is an offset into the text`);
			const released = opened.slice(0, end);
			assert.ok(maskedClosed.startsWith(vinciMaskSecrets(released).trimEnd()), `${where}: the released lines are masked as the closed text masks them`);
			if (release) assert.equal(released, opened, `${where}: control: a text the mask does not change is released whole`);
			if (held !== undefined) assert.ok(end <= held, `${where}: the construct's lines are held`);
		}
		assert.ok(inputs.some((input) => input.changes) || inputs.some((input) => input.held !== undefined), "fixture sanity: the construct is exercised");
	});
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
	test(`json 206t (D01): a thinking block still open while a later text block streams, cut ${ending}: it goes out in the cut form, and every final event shows it so; no byte past the token's head reaches stdout`, async () => {
		const where = `206t (D01, json, open thinking before text, ${ending})`;
		const { tail } = tokenControl(where);
		const { events } = thinkingThenTextEvents(stopReason, withError);
		const out = await runJson(events);
		assertCompleted(out, ["message_end", "agent_end"], where);
		assertNoPrefixBytes(out.stdout, tail, `${where}: whole stdout`);
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
	});
}

for (const [label, ending, limits] of [
	["at the byte bound", "end", { maxBytes: 16 }],
	["at the end of the run (no tool end)", "none", undefined],
	["before an error-only tool end", "error", undefined],
]) {
	test(`json 206t (D01): a tool's progress that is a token cut below its minimum length, ${label}, goes out as the placeholder: no byte past its head reaches stdout`, async () => {
		const set = holdLimitsSetter();
		const where = `206t (D01, json, progress ${label})`;
		const { full, tail } = tokenControl(where);
		const events = [tokenPrefixUpdate()];
		if (ending === "end") events.push(toolEnd("token-prefix", full));
		if (ending === "error") events.push(toolEnd("token-prefix", "operation aborted.", { isError: true }));
		if (limits) set(limits);
		let out;
		try {
			out = await runJson(events);
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
	test(`json 206t (D02): a tool's progress past the byte bound by its details (${label}) goes out at once as the placeholder, and is not kept`, async () => {
		const set = holdLimitsSetter();
		const inputs = boundedInputs();
		const update = inputs[key];
		set({ maxBytes: 1024 });
		let out;
		let retained;
		try {
			out = await runJson([update]);
			const stream = new VinciStreamMask();
			stream.process(update);
			retained = retainedStringBytes(stream);
		} finally {
			set();
		}
		assert.ok(!out.stdout.includes(inputs.payload.slice(0, 64)), `206t (D02, json, ${label}): the details past the bound never reach stdout`);
		assert.ok(retained <= 1024, `the masker keeps at most the bound (${retained} bytes kept)`);
		assert.equal(out.exitCode, 0, `206t (D02, json, ${label}): the run exits 0`);
		const lines = out.events.filter((event) => event?.type === "tool_execution_update");
		const released = keptReleases(out.events, update.toolCallId);
		assert.equal(released.length, 1, "one release");
		assert.equal(lines.indexOf(released[0]), 0, "at once: the update itself");
		assert.equal(released[0].partialResult.content[0]?.text, PLACEHOLDER, "as the placeholder");
		assert.deepEqual(released[0].partialResult.details, {}, "its details are not written");
	});
}

test("json 206t (D02): a tool's progress past the byte bound by control bytes the normaliser removes goes out at once as the placeholder, and is not kept", async () => {
	const set = holdLimitsSetter();
	const { controls } = boundedInputs();
	set({ maxBytes: 1024 });
	let out;
	let retained;
	try {
		out = await runJson([controls]);
		const stream = new VinciStreamMask();
		stream.process(controls);
		retained = retainedStringBytes(stream);
	} finally {
		set();
	}
	assert.ok(retained <= 1024, `206t (D02, json, controls): the masker keeps at most the bound (${retained} bytes kept)`);
	assert.equal(out.exitCode, 0, "206t (D02, json, controls): the run exits 0");
	const lines = out.events.filter((event) => event?.type === "tool_execution_update");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(lines.indexOf(released[0]), 0, "at once: the update itself");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
});

test("json 206t (D02): a text block past the byte bound in UTF-8 bytes but not in UTF-16 units, with no delta of its own, goes out at once as the placeholder", async () => {
	const set = holdLimitsSetter();
	const { body, events } = multiByteStartEvents();
	assert.ok(body.length <= 1024 && Buffer.byteLength(body, "utf8") > 1024, "fixture sanity: under the bound in UTF-16 units, past it in UTF-8 bytes");
	set({ maxBytes: 1024 });
	let out;
	let retained;
	try {
		out = await runJson(events);
		const stream = new VinciStreamMask();
		for (const event of events.slice(0, 2)) stream.process(event);
		retained = retainedStringBytes(stream);
	} finally {
		set();
	}
	assert.ok(retained <= 1024, `206t (D02, json, multi-byte): the masker keeps at most the bound (${retained} bytes kept)`);
	assertCompleted(out, ["message_end"], "206t (D02, json, multi-byte)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "as the placeholder");
	const textEnd = out.events.findIndex((event) => event?.assistantMessageEvent?.type === "text_end");
	assert.ok(out.events.indexOf(released[0]) < textEnd, "at the bound, before the block's end");
});

test("json 206t (D02): a call's cumulative argument text past the byte bound is not kept after the bound (no raw cumulative message)", async () => {
	const set = holdLimitsSetter();
	const { callDeltas } = boundedInputs();
	const events = probeCallEvents(callDeltas);
	set({ maxBytes: 1024 });
	let out;
	let retained;
	try {
		out = await runJson(events);
		const stream = new VinciStreamMask();
		for (const event of events) stream.process(event);
		retained = retainedStringBytes(stream);
	} finally {
		set();
	}
	assert.ok(retained <= 1024, `206t (D02, json, cumulative arguments): the masker keeps at most the bound (${retained} bytes kept)`);
	assert.ok(!out.stdout.includes("x".repeat(64)), "the held argument text never reaches stdout");
	assert.equal(out.exitCode, 0, "206t (D02, json, cumulative arguments): the run exits 0");
	const released = releasedDeltas(out.events, "toolcall");
	assert.equal(released.length, 1, "one release");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "at the bound, the placeholder");
});

// 206t (D03): no timer. The deadline of every held body is checked on every event, of any type; a silent stream holds
// until the next event or the end.
test("json 206t (D03): a text block's deadline (a fake clock) is checked on an unrelated event: the block goes out at that event, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const text = probeTextMessage("ordinary.");
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	try {
		out = await runJson([{ type: "message_start", message: text }, probeTextUpdate(text, "ordinary.")], {
			during: async ({ listener }) => {
				now = 101;
				listener(otherToolUpdate());
				listener({ type: "message_update", message: text, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ordinary.", partial: text } });
				listener({ type: "message_end", message: text });
			},
		});
	} finally {
		set();
	}
	assertCompleted(out, ["message_end"], "206t (D03, json, unrelated event)");
	const released = releasedDeltas(out.events);
	assert.equal(released.length, 1, "one release");
	const other = out.events.findIndex((event) => event?.type === "tool_execution_update");
	assert.ok(other > 0 && out.events.indexOf(released[0]) < other, "released at the unrelated event, before it is written");
	assert.equal(released[0].assistantMessageEvent.delta, PLACEHOLDER, "as the placeholder");
});

test("json 206t (D03): in a tool-update-only stream a kept partial result's deadline is checked on another tool's update; it goes out then, as the placeholder", async () => {
	const set = holdLimitsSetter();
	const { tail } = tokenControl("206t (D03, json, tool updates only)");
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	try {
		out = await runJson([tokenPrefixUpdate()], {
			during: async ({ listener }) => {
				now = 101;
				listener(otherToolUpdate());
			},
		});
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D03, json, tool updates only): whole stdout");
	assert.equal(out.exitCode, 0, "206t (D03, json, tool updates only): the run exits 0");
	const released = releasedUpdates(out.events);
	assert.equal(released.length, 1, "the kept progress is written once");
	assert.equal(released[0].toolCallId, "token-prefix", "for its tool call");
	const other = out.events.findIndex((event) => event?.toolCallId === "other");
	assert.ok(other > 0 && out.events.indexOf(released[0]) < other, "at the other tool's update, before it is written");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
});

test("json 206t (D03): a text block held past its deadline with no later event releases nothing while the stream is silent, then goes out at the end as the placeholder", async () => {
	const set = holdLimitsSetter();
	const { prefix, tail } = tokenControl("206t (D03, json, silent)");
	const cut = probeTextMessage(prefix);
	let now = 0;
	set({ deadlineMs: 100, now: () => now });
	let out;
	let silent;
	try {
		out = await runJson([{ type: "message_start", message: probeTextMessage("") }, probeTextUpdate(cut, prefix)], {
			during: async ({ stdout }) => {
				now = 10_000;
				await waitForRawStdoutBackpressure();
				silent = stdout();
			},
		});
	} finally {
		set();
	}
	assertNoPrefixBytes(out.stdout, tail, "206t (D03, json, silent): whole stdout");
	assert.equal(out.exitCode, 0, "206t (D03, json, silent): the run exits 0");
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
	["the end of the run (no tool end)", undefined],
]) {
	test(`json 206t (D04): a details-only checkpoint, then ${label}: the kept update goes out once, before it, as the placeholder`, async () => {
		const where = `206t (D04, json, details-only, ${label})`;
		const out = await runJson([checkpointUpdate(), ...(end ? [end()] : [])]);
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

test("json 206t (D04): progress whose text the end repeats but whose details differ goes out once, before the end, as the placeholder; with equal details it does not", async () => {
	const update = (details) => ({
		type: "tool_execution_update",
		toolCallId: "stage",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "step one." }], details },
	});
	const end = toolEnd("stage", "step one.", { details: { stage: "second" }, toolName: "bash" });
	const out = await runJson([update({ stage: "first" }), end]);
	assertCompleted(out, ["tool_execution_end"], "206t (D04, json, equal text)");
	const released = keptReleases(out.events, "stage");
	assert.equal(released.length, 1, "the kept update is written once, not lost");
	const endAt = out.events.findIndex((event) => event?.type === "tool_execution_end");
	assert.ok(out.events.indexOf(released[0]) < endAt, "before the tool end");
	assert.equal(released[0].partialResult.content[0].text, PLACEHOLDER, "as the placeholder");
	const same = await runJson([update({ stage: "second" }), end]);
	assertCompleted(same, ["tool_execution_end"], "206t (D04, json, equal payload)");
	assert.equal(keptReleases(same.events, "stage").length, 0, "positive control: an end that carries all of it supersedes it");
});

// 206t (D05): boxed values are recognised by their internal brand (any realm) and read with the prototype's own valueOf,
// as JSON.stringify reads them.
test("json 206t (D05): String, Number and Boolean objects made in another realm are written as JSON.stringify writes them", async () => {
	const events = detailsEvents(crossRealmBoxed(vm));
	assert.ok(JSON.stringify(events[1]).includes('"message":"ordinary boxed message","count":7,"flag":true'), "fixture sanity: JSON.stringify writes the values");
	const out = await runJson(events);
	const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
	assert.equal(line, JSON.stringify(events[1]), "206t (D05, json, another realm): the tool_execution_end line is JSON.stringify's");
	assertCompleted(out, ["tool_execution_end", "message_end"], "206t (D05, json, another realm)");
});

for (const throwing of [false, true]) {
	const label = throwing ? "throwing" : "overridden";
	test(`json 206t (D05): boxed values with ${label} own methods that JSON.stringify does not call are written as JSON.stringify writes them`, async () => {
		const events = detailsEvents(overriddenBoxed({ throwing }));
		const native = JSON.stringify(events[1]);
		assert.ok(native.includes('"flag":true') && native.includes('"message":"ordinary boxed message"'), "fixture sanity: JSON.stringify reads the own values");
		let thrown;
		const out = await runJson([], {
			during: async ({ listener }) => {
				for (const event of events) {
					try {
						listener(event);
					} catch (error) {
						thrown = error;
					}
				}
			},
		});
		assert.equal(thrown, undefined, `206t (D05, json, ${label}): the writer takes every event (no own method is called)`);
		const line = lineOf(out.stdout, (event) => event?.type === "tool_execution_end");
		assert.equal(line, native, "the tool_execution_end line is JSON.stringify's");
		assertCompleted(out, ["tool_execution_end", "message_end"], `206t (D05, json, ${label})`);
	});
}

for (const { label, whitespace, secret } of angleWhitespaceCases()) {
	for (const separator of [":", "="]) {
		for (const kind of ["text", "thinking"]) {
			for (const streamed of [false, true]) {
				for (const stopReason of ["error", "aborted", "length"]) {
					const name = `json 206u (E01): ${label}, ${separator}, ${kind}, streamed=${streamed}, ${stopReason}`;
					test(name, async () => {
						const body = `password${separator}${whitespace}<\n${secret}\n>`;
						const whole = vinciMaskSecrets(body);
						assertNoSecretBytes(whole, [secret.slice(2)], `${name}: whole-body control`);
						assert.ok(whole.includes(`${secret.slice(0, 2)}…${PLACEHOLDER}`), `${name}: normal mask head`);
						const built = angleEndingEvents(body, kind, streamed, stopReason);
						const out = await runJson(built.events);
						assertCompleted(out, ["message_end", "turn_end", "agent_end"], name);
						assertNoSecretBytes(out.stdout, [secret.slice(2)], name);
						assertNoFiveCharacterSecret(out.stdout, secret.slice(2), name);
						assert.equal(deltasOf(out.events, kind), PLACEHOLDER, `${name}: the angle value stays held`);
						const source = out.events.find(
							(event) => event.assistantMessageEvent?.type === (stopReason === "error" ? "error" : "done"),
						);
						assert.ok(source, `${name}: source end is written`);
						for (const event of finalEventsOf(out.events)) {
							const message = event.type === "agent_end" ? event.messages[0] : event.message;
							assert.equal(fieldOf(message, kind), PLACEHOLDER, `${name}: ${event.type}`);
						}
						const natural = await runJson(angleEndingEvents(body, kind, streamed, "stop").events);
						assertCompleted(natural, ["message_end", "agent_end"], `${name}: natural end`);
						assertNoFiveCharacterSecret(natural.stdout, secret.slice(2), `${name}: natural end`);
						const naturalEnd = natural.events.find((event) => event.type === "message_end");
						assert.equal(fieldOf(naturalEnd.message, kind), whole);
						// Check the opener independently: the start of the line holding the `:` or `=`.
						// The assignment guard also holds this value.
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

test("json 206u (E01): whitespace-only prefix holds the angle opener", async () => {
	const { secret } = angleWhitespaceCases()[0];
	const body = `${" \n\t".repeat(1700)}<\n${secret}\n>`;
	const out = await runJson(angleEndingEvents(body, "text", true, "error").events);
	assertCompleted(out, ["message_end", "agent_end"], "206u (E01): whitespace-only prefix");
	assertNoFiveCharacterSecret(out.stdout, secret, "206u (E01): whitespace-only prefix");
	assert.equal(deltasOf(out.events), PLACEHOLDER);
});

test("json 206u (E01): second guard alone holds an unclosed angle beyond the old window", async () => {
	const { secret } = angleWhitespaceCases()[0];
	const body = `password=${" ".repeat(5000)}<\n${secret}\n`;
	const out = await runJson(angleEndingEvents(body, "text", true, "error").events);
	assertCompleted(out, ["message_end", "agent_end"], "206u (E01): second guard alone");
	assertNoFiveCharacterSecret(out.stdout, secret.slice(2), "206u (E01): second guard alone");
	assert.equal(deltasOf(out.events), PLACEHOLDER);
});

test("json 206u (E01): seeded cut stdout agrees with whole-body hidden runs", async () => {
	const seed = 0x206e01;
	const cases = 2000;
	let state = seed;
	const random = () => {
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	const started = performance.now();
	let exercised = 0;
	try {
		for (let index = 0; index < cases; index++) {
			const secret = `qV${index.toString(36).padStart(4, "0")}${"L9mK2wR8pT4xN6bH3dF5"}!`;
			const count = index === 0 ? 300 : Math.floor(random() * 5001);
			const whitespace = index % 3 === 0 ? " ".repeat(count) : " \n\t".repeat(Math.ceil(count / 3)).slice(0, count);
			const { begin, end } = keyMarkers();
			const fragments = [
				`password=${whitespace}<\n${secret}\n>`,
				`password=${whitespace}${secret}\nDone.`,
				`${begin}\n${secret}\n${end}`,
				`password=${whitespace}${"$"}{VALUE:-\n${secret}\n}`,
			];
			const full =
				index === 0
					? fragments[0]
					: Array.from(
							{ length: 1 + Math.floor(random() * 4) },
							() => fragments[Math.floor(random() * fragments.length)],
						).join("\n");
			const cut = index === 0 ? full.length : Math.floor(random() * (full.length + 1));
			const stopReason = ["error", "aborted", "length"][Math.floor(random() * 3)];
			const masked = vinciMaskSecrets(full);
			const hidden = [];
			// Ask the actual mask which values it replaces, then compare each value with its actual rendering.
			const traced = vinciMaskSecrets(full, {
				render(value, kind) {
					const shown =
						kind === "private-key"
							? vinciMaskSecrets(value)
							: vinciMaskSecrets(value, { propertyName: "password" });
					let left = 0;
					while (left < value.length && value[left] === shown[left]) left++;
					let right = 0;
					while (
						right < value.length - left &&
						value[value.length - 1 - right] === shown[shown.length - 1 - right]
					) right++;
					const at = value.indexOf(secret);
					if (at >= 0) {
						hidden.push(secret.slice(Math.max(0, left - at), Math.min(secret.length, value.length - right - at)));
					}
					return shown;
				},
			});
			const inputs = JSON.stringify({ seed, index, full, cut, stopReason });
			assert.equal(traced, masked, `206u (E01): oracle rendering agrees: ${inputs}`);
			const built = angleEndingEvents(full.slice(0, cut), index % 2 ? "thinking" : "text", true, stopReason);
			const out = await runJson(built.events);
			assertCompleted(out, ["message_end", "agent_end"], inputs);
			for (const run of hidden) {
				assertNoFiveCharacterSecret(masked, run, `206u (E01): whole-body control: ${inputs}`);
				assertNoFiveCharacterSecret(out.stdout, run, `206u (E01): cut stdout: ${inputs}`);
				if (run.length >= 5) exercised++;
			}
		}
		assert.ok(exercised > 0, "206u (E01): the oracle exercises hidden runs");
	} finally {
		console.log(`206u (E01): seed=${seed} cases=${cases} runtimeMs=${(performance.now() - started).toFixed(1)}`);
	}
});

for (const { label, blocks, cap, events, secret } of isolatedBodyCases()) {
	const name = `json 206u (E02): ${label}`;
	test(name, async () => {
		const set = holdLimitsSetter();
		let out;
		let snapshot;
		set({ maxBytes: cap });
		try {
			const stream = new VinciStreamMask();
			for (const event of events) {
				if (event.type === "message_end") break;
				stream.process(event);
			}
			snapshot = stream.snapshot;
			out = await runJson(events);
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
			const name = `json 206u (E02): ${kind}, ${field}, afterBound=${afterBound}: retained snapshot stays within cap`;
			test(name, async () => {
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
				set({ maxBytes: cap });
				let out;
				let retained;
				try {
					const stream = new VinciStreamMask();
					for (const event of events) stream.process(event);
					retained = retainedStringBytes(stream);
					out = await runJson([
						...events,
						{
							type: "message_update",
							message: final,
							assistantMessageEvent: { type: "done", reason: "stop", message: final },
						},
						{ type: "message_end", message: final },
						{ type: "agent_end", messages: [final] },
					]);
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
			});
		}
	}
}
