import assert from "node:assert/strict";
import { test } from "node:test";
import { TUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const RESET = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l";

class RecordingTerminal extends VirtualTerminal {
	output = "";
	synchronousOutput = "";
	stopCount = 0;
	failStart = false;
	failStop = false;
	failShowCursor = false;
	failStopBeforeRestore = false;
	failWrites = 0;
	override write(data: string): void {
		if (this.failWrites-- > 0) throw new Error("terminal write failed");
		this.output += data;
		super.write(data);
	}
	writeSync(data: string): void {
		this.synchronousOutput += data;
		this.write(data);
	}
	override start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.failStart) throw new Error("terminal start failed");
		super.start(onInput, onResize);
	}
	override stop(): void {
		this.stopCount++;
		if (this.failStopBeforeRestore) throw new Error("terminal stop failed before input restore");
		super.stop();
		if (this.failStop) throw new Error("terminal stop failed");
	}
	override showCursor(): void {
		if (this.failShowCursor) throw new Error("show cursor failed before input restore");
		super.showCursor();
	}
}

test("fullscreen stop resets every mode before rendering the final transcript, once", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => ["unique transcript"], invalidate() {} });
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	tui.stop();
	tui.stop();
	tui.resetTerminal(true);
	assert.ok(terminal.output.includes(RESET), "normal stop must emit the full reset");
	assert.equal(terminal.output.split(RESET).length - 1, 1, "duplicate stop must not repeat the reset");
	assert.equal(
		terminal.output.split("unique transcript").length - 1,
		1,
		"duplicate stop must not repeat the transcript",
	);
	assert.ok(terminal.output.indexOf(RESET) < terminal.output.indexOf("unique transcript"));
	assert.equal(terminal.stopCount, 1, "exit fallback must not repeat successful input cleanup");
});

test("fullscreen preserveScreen stop restores without rendering a transcript and can resume", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => ["private transcript"], invalidate() {} });
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	tui.stop({ preserveScreen: true });
	assert.ok(terminal.output.includes(RESET), "preserveScreen stop must emit the full reset");
	assert.equal(terminal.output.includes("private transcript"), false);
	tui.start();
	await terminal.waitForRender();
	tui.stop({ preserveScreen: true });
	assert.equal(terminal.output.split("\x1b[?1049h").length - 1, 1, "resume must enter fullscreen once");
});

test("fullscreen terminal start failure resets after alternate screen entry", () => {
	const terminal = new RecordingTerminal();
	terminal.failStart = true;
	const tui = new TuiAltScreen(terminal);
	assert.throws(() => tui.start(), /terminal start failed/);
	assert.ok(terminal.output.includes("\x1b[?1049h"), "positive control must enter the alternate screen");
	assert.ok(terminal.output.includes(RESET), "terminal start failure must emit the full reset");
});

test("fullscreen transcript failure cannot prevent terminal reset", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	let failRender = false;
	tui.addChild({
		render: () => {
			if (failRender) throw new Error("transcript failed");
			return ["body"];
		},
		invalidate() {},
	});
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	failRender = true;
	assert.throws(() => tui.stop(), /transcript failed/);
	assert.ok(terminal.output.includes(RESET), "transcript failure must emit the full reset");
});

test("fullscreen terminal stop failure cannot prevent terminal reset", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	terminal.failStop = true;
	assert.throws(() => tui.stop(), /terminal stop failed/);
	assert.ok(terminal.output.includes(RESET), "terminal stop failure must emit the full reset");
});

test("regular stop and resume never acquire fullscreen modes", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TUI(terminal);
	for (let attempt = 0; attempt < 2; attempt++) {
		tui.start();
		await terminal.waitForRender();
		tui.stop();
	}
	assert.doesNotMatch(terminal.output, /\x1b\[\?(?:1000|1002|1003|1004|1006|1049)[hl]/);
});

test("fullscreen synchronous fallback restores input and modes without a transcript, once", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => ["fallback transcript"], invalidate() {} });
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	Reflect.get(tui, "resetTerminal")?.call(tui, true);
	assert.ok(terminal.synchronousOutput.includes(RESET), "exit fallback must emit the full reset synchronously");
	assert.equal(terminal.stopCount, 1, "exit fallback must restore terminal input ownership");
	Reflect.get(tui, "resetTerminal")?.call(tui, true);
	tui.stop();
	assert.equal(terminal.output.includes("fallback transcript"), false);
	assert.equal(terminal.output.split(RESET).length - 1, 1);
});

test("fullscreen synchronous fallback resets even when terminal input restoration throws", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	terminal.failStop = true;
	Reflect.get(tui, "resetTerminal")?.call(tui, true);
	assert.ok(terminal.synchronousOutput.includes(RESET), "failing input restoration must still emit the full reset");
});

test("fullscreen failed reset write stays retryable without duplicating the transcript", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => ["retry transcript"], invalidate() {} });
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	terminal.failWrites = 1;
	assert.throws(() => tui.stop(), /terminal write failed/);
	Reflect.get(tui, "resetTerminal")?.call(tui, true);
	assert.ok(terminal.output.includes(RESET), "failed reset write must leave the full reset retryable");
	assert.equal(terminal.output.includes("retry transcript"), false);
	assert.equal(terminal.output.split(RESET).length - 1, 1);
});

test("fullscreen dead-terminal marking prevents stop and exit fallback writes", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.start();
	await terminal.waitForRender();
	terminal.output = "";
	Reflect.get(tui, "markTerminalDead")?.call(tui);
	tui.stop();
	Reflect.get(tui, "resetTerminal")?.call(tui, true);
	assert.equal(terminal.output, "", "dead terminal must receive no recursive restore write");
});

test("fullscreen preserveScreen can resume before its first queued render", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => ["resumed body"], invalidate() {} });
	tui.start();
	tui.stop({ preserveScreen: true });
	terminal.output = "";
	tui.start();
	await terminal.waitForRender();
	assert.ok(terminal.output.includes("resumed body"), "resume must schedule a fresh render");
	tui.stop({ preserveScreen: true });
});

for (const boundary of ["show cursor", "terminal stop"] as const) {
	test(`fullscreen exit fallback retries input cleanup after ${boundary} fails following the mode reset`, async () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal);
		const input: string[] = [];
		const editor = {
			render: () => ["unfinished cleanup transcript"],
			invalidate() {},
			handleInput: (data: string) => input.push(data),
		};
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		terminal.output = "";
		terminal.failShowCursor = boundary === "show cursor";
		terminal.failStopBeforeRestore = boundary === "terminal stop";
		assert.throws(() => tui.stop(), /failed before input restore/);
		assert.ok(terminal.output.includes(RESET), "mode reset must succeed before the input cleanup failure");
		terminal.sendInput("before retry");
		assert.deepEqual(input, ["before retry"], "positive control must retain input before successful cleanup");
		terminal.failShowCursor = false;
		terminal.failStopBeforeRestore = false;
		tui.resetTerminal(true);
		terminal.sendInput("after retry");
		assert.equal(terminal.output.split(RESET).length - 1, 1, "input retry must not duplicate the mode reset");
		assert.equal(terminal.output.includes("unfinished cleanup transcript"), false);
		assert.doesNotMatch(terminal.output, /\x1b\[\?(?:1000|1002|1003|1004|1006|1049)h/);
		assert.deepEqual(input, ["before retry"], "exit fallback must complete input cleanup after the mode reset");
		const successfulStopCount = terminal.stopCount;
		tui.resetTerminal(true);
		assert.equal(terminal.stopCount, successfulStopCount, "successful input retry must be idempotent");
	});
}
