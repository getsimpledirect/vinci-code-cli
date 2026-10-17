import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { type Component, TUI } from "../src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputTerminal extends VirtualTerminal {
	readonly stdin = new StdinBuffer();
	output = "";
	override start(input: (data: string) => void, resize: () => void): void {
		super.start(input, resize);
		this.stdin.on("data", (data) => super.sendInput(data));
	}
	override sendInput(data: string): void {
		// Fragment a real SGR sequence to exercise the buffering boundary as well.
		this.stdin.process(data.slice(0, 3));
		this.stdin.process(data.slice(3));
	}
	override write(data: string): void {
		this.output += data;
		super.write(data);
	}
	override stop(): void {
		this.stdin.destroy();
		this.stdin.removeAllListeners();
		super.stop();
	}
	inverse(row: number, col: number): boolean {
		const xterm = Reflect.get(this, "xterm") as XtermTerminal;
		return Boolean(xterm.buffer.active.getLine(row)?.getCell(col)?.isInverse());
	}
}

const lines = (text: string): Component => ({ render: () => text.split("\n"), invalidate() {} });
const mouse = (button: number, x: number, y: number, release = false): string =>
	`\x1b[<${button};${x};${y}${release ? "m" : "M"}`;

async function setup(text = "alpha\nbeta\ngamma", options: TuiAltScreenOptions = {}, width = 40, height = 6) {
	const terminal = new InputTerminal(width, height);
	const copies: string[] = [];
	const tui = new TuiAltScreen(terminal, false, {
		copySelection: async (text) => {
			copies.push(text);
			return "native";
		},
		...options,
	});
	tui.addChild(lines(text));
	tui.start();
	await terminal.waitForRender();
	return { tui, terminal, copies };
}

for (const variant of ["forward", "generic", "reverse", "ANSI", "Unicode", "scrolled", "dock"] as const) {
	test(`selection copies rendered text once on ${variant} release`, async (t) => {
		const text =
			variant === "ANSI"
				? "\x1b[31mal\x1b[0mpha\nbeta\ngamma"
				: variant === "Unicode"
					? "中e\u0301x\n好e\u0301!\ngamma"
					: "alpha\nbeta\ngamma";
		const h = await setup(text);
		t.after(() => h.tui.stop({ preserveScreen: true }));
		if (variant === "scrolled" || variant === "dock") {
			const view = new ScrollView(lines(`skip\n${text}`), { primary: true });
			h.tui.setLayoutRoot(
				new VStack([
					{ component: view, grow: 1, minSize: 0 },
					{ component: lines("WIDGET"), basis: 1, shrink: 0 },
					{ component: lines("FOOTER"), basis: 1, shrink: 0 },
				]),
			);
			h.terminal.resize(40, 4);
			await h.terminal.waitForRender();
			h.tui.scrollBy(1);
			await h.terminal.waitForRender();
			assert.deepEqual(
				h.terminal.getViewport().map((line) => line.trimEnd()),
				["alpha", "beta", "WIDGET", "FOOTER"],
			);
		}
		const reverse = variant === "reverse";
		h.terminal.sendInput(mouse(0, reverse ? 4 : 1, reverse ? 2 : 1));
		assert.equal(h.copies.length, 0, "press must not copy");
		h.terminal.sendInput(mouse(32, reverse ? 1 : 4, reverse ? 1 : 2));
		assert.equal(h.copies.length, 0, "motion must not copy");
		await h.terminal.waitForRender();
		assert.ok(h.terminal.inverse(0, 0), "the selected first cell must be highlighted in xterm");
		h.terminal.sendInput(
			mouse(variant === "generic" ? 3 : 0, reverse ? 1 : 4, variant === "dock" ? 4 : reverse ? 1 : 2, true),
		);
		await h.terminal.waitForRender();
		assert.doesNotMatch(h.terminal.output, /\x1b\]52;/, "the injected writer must own all clipboard output");
		assert.deepEqual(
			h.copies,
			[variant === "Unicode" ? "中e\u0301x\n好e\u0301!" : "alpha\nbeta"],
			"release must copy the exact rendered selection once",
		);
	});
}

test("single clicks and orphan or repeated events never copy or flash", async (t) => {
	const h = await setup();
	t.after(() => h.tui.stop({ preserveScreen: true }));
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(0, 1, 1, true));
	h.terminal.sendInput(mouse(32, 4, 2));
	h.terminal.sendInput(mouse(3, 4, 2, true));
	await h.terminal.waitForRender();
	assert.deepEqual(h.copies, [], "zero-length click and orphan motion/release must not copy");
	assert.ok(!h.terminal.getViewport().some((row) => /Copied|clipboard/.test(row)), "empty gestures must not flash");
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(32, 4, 2));
	h.terminal.sendInput(mouse(0, 4, 2, true));
	assert.deepEqual(h.copies, ["alpha\nbeta"], "positive drag must copy once");
	h.terminal.sendInput(mouse(0, 4, 2, true));
	h.terminal.sendInput(mouse(3, 4, 2, true));
	h.terminal.sendInput(mouse(32, 5, 3));
	h.terminal.sendInput(mouse(0, 5, 3, true));
	assert.equal(h.copies.length, 1, "orphan/repeated release after a completed drag must not recopy");
});

test("standalone selection flashes failure at the top-right without emitting OSC 52", async (t) => {
	const h = await setup(undefined, { copySelection: undefined });
	t.after(() => h.tui.stop({ preserveScreen: true }));
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(32, 4, 2));
	await h.terminal.waitForRender();
	assert.ok(
		!h.terminal.getViewport().some((line) => /Copied|clipboard/.test(line)),
		"standalone press and motion must not flash",
	);
	h.terminal.sendInput(mouse(0, 4, 2, true));
	await h.terminal.waitForRender();
	assert.ok(
		h.terminal.getViewport()[0]!.endsWith(" Couldn't copy to clipboard "),
		"standalone release must flash the exact failure at the top-right",
	);
	assert.doesNotMatch(h.terminal.output, /\x1b\]52;/, "standalone release must emit zero OSC 52");
	assert.deepEqual(h.tui.render(40), ["alpha", "beta", "gamma"], "standalone feedback must stay out of transcript");
});

for (const [name, x, count, expected] of [
	["word", 2, 2, "alpha"],
	["whitespace", 7, 2, "   "],
	["line", 2, 3, "alpha   beta"],
] as const) {
	test(`multi-click selects one ${name} with exact highlight boundaries`, async (t) => {
		const h = await setup("alpha   beta\nnext line");
		t.after(() => h.tui.stop({ preserveScreen: true }));
		for (let n = 0; n < count; n++) {
			h.terminal.sendInput(mouse(0, x, 1));
			h.terminal.sendInput(mouse(0, x, 1, true));
		}
		await h.terminal.waitForRender();
		assert.equal(h.copies.at(-1), expected, "multi-click must copy exactly its word, whitespace or rendered line");
		const start = name === "whitespace" ? 5 : 0;
		const end = name === "word" ? 5 : name === "whitespace" ? 8 : 12;
		for (let col = 0; col <= 12; col++) {
			assert.equal(
				h.terminal.inverse(0, col),
				col >= start && col < end,
				`boundary metadata must highlight only selected cells at column ${col}`,
			);
		}
		assert.equal(h.terminal.inverse(1, 0), false, "triple-click must select only one rendered line");
	});
}

test("word drag extends and reverses at complete word boundaries", async (t) => {
	const h = await setup("alpha   beta\nnext line");
	t.after(() => h.tui.stop({ preserveScreen: true }));
	for (let n = 0; n < 2; n++) {
		h.terminal.sendInput(mouse(0, 10, 1));
		if (n === 0) h.terminal.sendInput(mouse(0, 10, 1, true));
	}
	h.terminal.sendInput(mouse(32, 2, 1));
	h.terminal.sendInput(mouse(0, 2, 1, true));
	assert.deepEqual(h.copies, ["alpha   beta"], "reverse word drag must preserve the initial complete word");
});

test("focus reports cancel an active press and are consumed", async (t) => {
	const h = await setup();
	t.after(() => h.tui.stop({ preserveScreen: true }));
	const input: string[] = [];
	h.tui.setFocus({ ...lines(""), handleInput: (data) => input.push(data) });
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(32, 4, 2));
	h.terminal.sendInput("\x1b[O");
	h.terminal.sendInput("\x1b[I");
	h.terminal.sendInput(mouse(32, 5, 3));
	h.terminal.sendInput(mouse(3, 5, 3, true));
	await h.terminal.waitForRender();
	assert.deepEqual(input, [], "focus reports must never reach the editor");
	assert.deepEqual(h.copies, [], "focus loss must cancel pending copy");
	assert.equal(h.terminal.inverse(0, 0), false, "focus loss must clear unfinished highlights");
});

test("edge auto-scroll runs every 50 ms and release or stop cancels it", async (t) => {
	const h = await setup("zero\none\ntwo\nthree\nfour\nfive\nsix", {}, 40, 3);
	t.after(() => h.tui.stop({ preserveScreen: true }));
	h.tui.scrollToTop();
	await h.terminal.waitForRender();
	t.mock.timers.enable({ apis: ["setInterval"] });
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(32, 5, 3));
	t.mock.timers.tick(49);
	assert.equal(h.tui.viewportTop, 0);
	t.mock.timers.tick(1);
	assert.equal(h.tui.viewportTop, 1, "the real interval must move one source row at 50 ms");
	h.terminal.sendInput(mouse(32, 5, 2));
	t.mock.timers.tick(100);
	assert.equal(h.tui.viewportTop, 1, "moving away from the edge must stop auto-scroll");
	h.terminal.sendInput(mouse(32, 5, 3));
	t.mock.timers.tick(50);
	h.terminal.sendInput(mouse(0, 5, 3, true));
	assert.deepEqual(h.copies, ["zero\none\ntwo\nthree\nfour"], "edge scrolling must extend copied source text");
	const releasedTop = h.tui.viewportTop;
	t.mock.timers.tick(100);
	assert.equal(h.tui.viewportTop, releasedTop, "release must stop auto-scroll");
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(32, 5, 3));
	h.tui.stop({ preserveScreen: true });
	t.mock.timers.tick(100);
	assert.equal(h.tui.viewportTop, releasedTop, "stop must stop auto-scroll");
});

test("focused overlays own wheel and viewport keys, and all overlays block selection", async (t) => {
	const h = await setup(Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n"));
	t.after(() => h.tui.stop({ preserveScreen: true }));
	const input: string[] = [];
	const overlay = h.tui.showOverlay({ ...lines("CREW"), handleInput: (data) => input.push(data) });
	await h.terminal.waitForRender();
	const before = h.tui.viewportTop;
	h.terminal.sendInput(mouse(64, 1, 1));
	h.terminal.sendInput("\x1b[5~");
	assert.deepEqual(input, [mouse(64, 1, 1), "\x1b[5~"], "focused overlay must receive wheel and PageUp");
	assert.equal(h.tui.viewportTop, before, "overlay input must not scroll underlying transcript");
	h.terminal.sendInput(mouse(0, 1, 1));
	h.terminal.sendInput(mouse(32, 4, 2));
	h.terminal.sendInput(mouse(0, 4, 2, true));
	assert.deepEqual(h.copies, [], "no transcript selection may start under an overlay");
	overlay.hide();
});

for (const width of [40, 12]) {
	for (const route of ["native", "terminal", "remote-only", "throw"] as const) {
		test(`feedback ${route} at width ${width} uses viewport cells after settlement`, async (t) => {
			let settle: (route: "native" | "terminal" | "remote-only") => void = () => {};
			let reject: (error: Error) => void = () => {};
			let calls = 0;
			const h = await setup(
				undefined,
				{
					copySelection: () => {
						calls++;
						return new Promise((resolve, rejectPromise) => {
							settle = resolve;
							reject = rejectPromise;
						});
					},
				},
				width,
			);
			t.after(() => h.tui.stop({ preserveScreen: true }));
			h.terminal.sendInput(mouse(0, 1, 1));
			h.terminal.sendInput(mouse(32, 4, 2));
			h.terminal.sendInput(mouse(0, 4, 2, true));
			await h.terminal.waitForRender();
			assert.equal(calls, 1, "selection must call injected async writer once");
			assert.ok(
				!h.terminal.getViewport().some((line) => /Copied|clipboard/.test(line)),
				"Copied must never flash before the writer resolves",
			);
			if (route === "throw") reject(new Error("mock clipboard failure"));
			else settle(route);
			await h.terminal.waitForRender();
			const message =
				route === "native"
					? "Copied"
					: route === "terminal"
						? "Sent to terminal clipboard"
						: "Couldn't copy to clipboard";
			const flash = ` ${message} `.slice(0, width);
			const row = h.terminal.getViewport()[0]!.padEnd(width);
			assert.equal(row.slice(width - flash.length), flash, "exact route feedback must appear at the top-right");
			assert.deepEqual(
				h.tui.render(width),
				["alpha", "beta", "gamma"],
				"feedback must never enter transcript status",
			);
			assert.doesNotMatch(h.terminal.output, /\x1b\]52;/, "injected writes must not emit an additional OSC 52");
			await new Promise((resolve) => setTimeout(resolve, 850));
			assert.ok(
				h.terminal.getViewport()[0]!.includes(flash.trim()),
				"failure and success flash must last at least 850 ms",
			);
			await new Promise((resolve) => setTimeout(resolve, 220));
			await h.terminal.waitForRender();
			assert.ok(
				!h.terminal.getViewport().some((line) => line.includes(flash.trim())),
				"flash must expire after its duration",
			);
		});
	}
}

test("flashes stack at the top-right and collapse on expiry with an empty footer", async (t) => {
	const h = await setup();
	t.after(() => h.tui.stop({ preserveScreen: true }));
	h.tui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(lines("body")), grow: 1 },
			{ component: { render: () => [], invalidate() {} } },
		]),
	);
	h.tui.flash("First", 70);
	h.tui.flash("Second", 180);
	await h.terminal.waitForRender();
	assert.ok(h.terminal.getViewport()[0]!.endsWith(" First "), "first flash must occupy the top-right viewport cell");
	assert.ok(h.terminal.getViewport()[1]!.endsWith(" Second "), "second flash must stack below the first");
	await new Promise((resolve) => setTimeout(resolve, 80));
	await h.terminal.waitForRender();
	assert.ok(h.terminal.getViewport()[0]!.endsWith(" Second "), "remaining flashes must collapse to the top");
});

test("failure flash schedules at least the success duration", async (t) => {
	let fail = false;
	const h = await setup(undefined, {
		copySelection: async () => {
			if (fail) throw new Error("injected failure");
			return "native";
		},
	});
	t.after(() => h.tui.stop({ preserveScreen: true }));
	const timeout = t.mock.method(globalThis, "setTimeout");
	const select = async () => {
		h.terminal.sendInput(mouse(0, 1, 1));
		h.terminal.sendInput(mouse(32, 4, 2));
		h.terminal.sendInput(mouse(0, 4, 2, true));
		await h.terminal.waitForRender();
	};
	await select();
	assert.ok(h.terminal.getViewport()[0]!.includes("Copied"), "success flash must be visible");
	fail = true;
	await select();
	assert.ok(
		h.terminal.getViewport()[1]!.includes("Couldn't copy to clipboard"),
		"failure flash must never be suppressed",
	);
	const delays = timeout.mock.calls
		.map((call) => call.arguments[1])
		.filter((delay) => typeof delay === "number" && delay >= 100);
	assert.equal(delays.length, 2, "both route outcomes must schedule a visible flash timer");
	assert.ok(delays[1]! >= delays[0]!, "failure flash duration must be at least the success duration");
});

test("multiplexer tracking is selected on every start and reset symmetrically", async () => {
	const keys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		for (const setting of ["direct", "TMUX", "ZELLIJ", "STY", "tmux-256color", "screen-256color"]) {
			for (const key of keys) delete process.env[key];
			if (setting === "TMUX" || setting === "ZELLIJ" || setting === "STY") process.env[setting] = "present";
			else process.env.TERM = setting;
			const terminal = new InputTerminal();
			const tui = new TuiAltScreen(terminal);
			try {
				for (let start = 0; start < 2; start++) {
					terminal.output = "";
					tui.start();
					await terminal.waitForRender();
					assert.equal(
						terminal.output.includes("\x1b[?1003h"),
						setting === "direct",
						`${setting} must choose the appropriate tracking mode on start/resume`,
					);
					assert.ok(terminal.output.includes("\x1b[?1004h"), "focus reporting must be enabled");
					tui.stop({ preserveScreen: true });
					for (const mode of [1000, 1002, 1003, 1004, 1006]) assert.ok(terminal.output.includes(`\x1b[?${mode}l`));
				}
			} finally {
				tui.stop({ preserveScreen: true });
			}
		}
	} finally {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
});

test("regular mode never starts application selection or emits clipboard bytes", async () => {
	const terminal = new InputTerminal();
	const tui = new TUI(terminal);
	tui.addChild(lines("alpha\nbeta\ngamma"));
	try {
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput(mouse(0, 1, 1));
		terminal.sendInput(mouse(32, 4, 2));
		terminal.sendInput(mouse(0, 4, 2, true));
		await terminal.waitForRender();
		assert.doesNotMatch(terminal.output, /\x1b\]52;|\x1b\[7m/);
	} finally {
		tui.stop();
	}
});
