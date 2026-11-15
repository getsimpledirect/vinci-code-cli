// Mask streamed output consistently: `--mode json` through the production runPrintMode. The session is a
// stand-in that emits assistant stream events (one completed line per update); every byte written to
// stdout is recorded. Secret values are synthetic and built at runtime.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertMasked,
	assertNeverRewritten,
	assertNoSecretBytes,
	assistant,
	block,
	cutPoints,
	deltasOf,
	finalEventsOf,
	fragmentsOf,
	heldWindows,
	inlineToken,
	keyMarkers,
	multiLineArguments,
	multiLineToolCalls,
	PLACEHOLDER,
	partialArgumentTexts,
	secretRuns,
	splitAcross,
	streamEvents,
	toolCallEvents,
	toolNameSynonyms,
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
	assert.equal(before, vinciMaskSecrets(["Here it is:", ...run.lines, ""].join("\n")), "all of it, before agent_end");
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
	assert.ok(beforeRebind.includes("Here it is:"), "the stream so far is written");
	assert.ok(!deltasOf(parseLines(beforeRebind)).includes(PLACEHOLDER), "held before the rebind");
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

test("json: a tool the view does not mask keeps its old per-event masking of argument deltas", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	const { events } = toolCallEvents("extension_tool", splitAcross(json, token, 0));
	const out = await runJson(events);
	assert.equal(out.stdout, events.map((event) => `${JSON.stringify(vinciMaskJson(event))}\n`).join(""), "as before this change");
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

// Interrupted calls: in the final events (message_end, turn_end, agent_end) each argument value keeps only
// the lines the hold-back would have released; from the first held line to the value's end it is the placeholder.
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

for (const index of ["string", "missing"]) {
	test(`json: masking consistency for streamed tool arguments, a ${index} content index still holds the call`, async () => {
		const run = secretRuns()["a multi-line hex secret"];
		const args = multiLineToolCalls(run.lines).bash;
		const { events } = toolCallEvents("bash", fragmentsOf(JSON.stringify(args), toolFragment), { index, before: [block("text", "Running it.\n")] });
		const out = await runJson(events);
		assertNoSecretBytes(out.stdout, run.secret, "whole stdout");
		const deltas = deltasOf(out.events, "toolcall");
		assertMasked(deltas, run.secret, "joined deltas");
		assert.equal(deltas, JSON.stringify(vinciMaskJson(args)));
	});
}

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

test("json positive control: a name that is neither a built-in tool nor a synonym of one is not held", async () => {
	const token = inlineToken();
	const json = JSON.stringify({ query: `find ${token}` });
	for (const name of ["constructor", "toString", "shell_helper", "Edit"]) {
		const { events } = toolCallEvents(name, splitAcross(json, token, 0));
		const out = await runJson(events);
		assert.equal(out.stdout, events.map((event) => `${JSON.stringify(vinciMaskJson(event))}\n`).join(""), `${name}: as a tool the view does not mask`);
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

test("json: an unclosed `${` holds at most its line cap, then releases", async () => {
	const items = Array.from({ length: 24 }, (_, i) => `item ${i + 1};`);
	const { events } = streamEvents(["Run this:", "echo ${HOME:-", ...items, "Done."], { end: false, withEnd: false });
	events.push({ type: "message_end", message: assistant([block("text", events.at(-1).message.content[0].text)]) });
	const out = await runJson(events);
	const endIndex = out.events.findIndex((event) => event.type === "message_end");
	assert.ok(deltasOf(out.events.slice(0, endIndex - 1)).includes("item 1;"), "the capped run is released before the end");
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
