import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

let savedEnvironment: Map<string, string | undefined>;
beforeEach(() => {
	const keys = new Set([
		...Object.keys(process.env).filter((key) => key.startsWith("PI_")),
		"VINCI_CODE",
		"VINCI_COPY_ON_SELECT",
		"TMUX",
		"ZELLIJ",
		"STY",
		"TERM",
	]);
	savedEnvironment = new Map([...keys].map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.TERM = "xterm-256color";
});
afterEach(() => {
	for (const [key, value] of savedEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

class RecordingTerminal extends VirtualTerminal {
	output = "";
	override write(data: string): void {
		this.output += data;
		super.write(data);
	}
}

async function setup(options: TuiAltScreenOptions = {}) {
	const terminal = new RecordingTerminal(48, 6);
	const copies: string[] = [];
	const tui = new TuiAltScreen(terminal, false, {
		copySelection: async (text) => {
			copies.push(text);
			return "native";
		},
		...options,
	});
	const component: Component = { render: () => ["alpha", "beta", "gamma"], invalidate() {} };
	tui.addChild(component);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, copies };
}

function drag(terminal: RecordingTerminal): void {
	terminal.sendInput("\x1b[<0;1;1M");
	terminal.sendInput("\x1b[<32;4;2M");
	terminal.sendInput("\x1b[<0;4;2m");
}

test("copyOnSelect false preserves a visible active selection without an automatic copy", async (t) => {
	const h = await setup({ copyOnSelect: false });
	t.after(() => h.tui.stop({ preserveScreen: true }));
	drag(h.terminal);
	await h.terminal.waitForRender();
	assert.deepEqual(h.copies, [], "copyOnSelect false must prevent the release writer call");
	assert.match(h.terminal.output, /\x1b\[7m/, "copyOnSelect false must keep the rendered selection visible");
	assert.equal(h.tui.hasActiveSelection(), true, "the visible nonempty selection must remain active");
	assert.equal(h.tui.getCopyOnSelect(), false, "the copy policy getter must reflect the constructor option");
	assert.equal(await h.tui.copyActiveSelectionToClipboard(), true, "manual copy must succeed while auto-copy is off");
	assert.deepEqual(h.copies, ["alpha\nbeta"], "manual copy must use exactly the active rendered selection");
	await h.terminal.waitForRender();
	assert.ok(h.terminal.getViewport()[0]!.endsWith(" Copied "), "manual copy must use commit-3 route feedback");
});

test("copyOnSelect setter updates the next real drag immediately in both directions", async (t) => {
	const h = await setup();
	t.after(() => h.tui.stop({ preserveScreen: true }));
	assert.equal(h.tui.getCopyOnSelect(), true, "copy-on-select must default true");
	h.tui.setCopyOnSelect(false);
	drag(h.terminal);
	assert.deepEqual(h.copies, [], "disabling copy-on-select must affect the next release immediately");
	h.tui.setCopyOnSelect(true);
	drag(h.terminal);
	assert.deepEqual(h.copies, ["alpha\nbeta"], "reenabling copy-on-select must restore the same real drag writer");
});

test("active helpers reject empty and modal-covered selections without copy or flash", async (t) => {
	const h = await setup({ copyOnSelect: false });
	t.after(() => h.tui.stop({ preserveScreen: true }));
	assert.equal(h.tui.hasActiveSelection(), false);
	assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
	h.terminal.sendInput("\x1b[<0;1;1M");
	h.terminal.sendInput("\x1b[<0;1;1m");
	assert.equal(h.tui.hasActiveSelection(), false, "a single cell click is empty");
	drag(h.terminal);
	assert.equal(h.tui.hasActiveSelection(), true, "positive control must have an active selection");
	const modal = h.tui.showOverlay({ render: () => ["modal"], invalidate() {} });
	assert.equal(h.tui.hasActiveSelection(), false, "a modal must make the underlying selection inactive");
	assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
	assert.deepEqual(h.copies, [], "empty and modal-covered selections must call no writer");
	await h.terminal.waitForRender();
	assert.doesNotMatch(h.terminal.getViewport().join("\n"), /Copied|clipboard/, "empty and modal paths must not flash");
	modal.hide();
});

test("manual copy preserves terminal-route and failed-writer results without fallback", async (t) => {
	for (const route of ["terminal", "remote-only", "throw"] as const) {
		let calls = 0;
		const h = await setup({
			copyOnSelect: false,
			copySelection: async (text) => {
				calls++;
				assert.equal(text, "alpha\nbeta", "only selected rendered text may reach the writer");
				if (route === "throw") throw new Error("injected clipboard failure");
				return route;
			},
		});
		t.after(() => h.tui.stop({ preserveScreen: true }));
		h.terminal.sendInput("\x1b[<0;1;1M");
		h.terminal.sendInput("\x1b[<32;4;2M");
		assert.equal(
			await h.tui.copyActiveSelectionToClipboard(),
			route === "terminal",
			"manual result must match route outcome",
		);
		assert.equal(calls, 1, "manual selection copy must call the route exactly once, including failure");
		await h.terminal.waitForRender();
		const expected = route === "terminal" ? "Sent to terminal clipboard" : "Couldn't copy to clipboard";
		assert.ok(h.terminal.getViewport()[0]!.endsWith(` ${expected} `), "manual copy must show the exact route flash");
		h.tui.stop({ preserveScreen: true });
	}
});

test("L-a mouse release contains text-building throws without unhandled rejection and keeps input live", async (t) => {
	const h = await setup();
	t.after(() => h.tui.stop({ preserveScreen: true }));
	const input: string[] = [];
	h.tui.setFocus({ render: () => [], invalidate() {}, handleInput: (data) => input.push(data) });
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	h.terminal.sendInput("\x1b[<0;1;1M");
	h.terminal.sendInput("\x1b[<32;4;2M");
	const original = Reflect.get(h.tui, "getSelectionColumns") as (...args: unknown[]) => unknown;
	let injected = false;
	Reflect.set(h.tui, "getSelectionColumns", (...args: unknown[]) => {
		if (!injected) {
			injected = true;
			throw new Error("injected selection text-building failure");
		}
		return original.apply(h.tui, args);
	});
	h.terminal.sendInput("\x1b[<0;4;2m");
	await h.terminal.waitForRender();
	assert.deepEqual(unhandled, [], "selection text-building failure must produce zero unhandled rejections");
	assert.deepEqual(h.copies, [], "text-building failure must not reach the writer");
	assert.ok(
		h.terminal.getViewport()[0]!.endsWith(" Couldn't copy to clipboard "),
		"text-building failure must flash failure",
	);
	h.terminal.sendInput("x");
	assert.deepEqual(input, ["x"], "terminal input must remain live after the copy failure");
});

test("L-a manual copy contains both text-building and failure-flash throws", async (t) => {
	const h = await setup({ copyOnSelect: false });
	t.after(() => h.tui.stop({ preserveScreen: true }));
	h.terminal.sendInput("\x1b[<0;1;1M");
	h.terminal.sendInput("\x1b[<32;4;2M");
	const originalColumns = Reflect.get(h.tui, "getSelectionColumns");
	const originalFlash = h.tui.flash;
	Reflect.set(h.tui, "getSelectionColumns", () => {
		throw new Error("injected manual text-building failure");
	});
	Reflect.set(h.tui, "flash", () => {
		throw new Error("injected failure-flash failure");
	});
	try {
		let result: boolean | undefined;
		await assert.doesNotReject(async () => {
			result = await h.tui.copyActiveSelectionToClipboard();
		}, "manual copy must never reject when text-building and failure-flash throw");
		assert.equal(result, false, "manual copy must resolve false even if the failure flash throws");
		assert.deepEqual(h.copies, [], "failed text building must never write another payload");
	} finally {
		Reflect.set(h.tui, "getSelectionColumns", originalColumns);
		Reflect.set(h.tui, "flash", originalFlash);
	}
});

test("TMUX fullscreen tracking enables button motion without idle all-motion events", async (t) => {
	process.env.TMUX = "isolated-test-session";
	const h = await setup({ copyOnSelect: false });
	t.after(() => h.tui.stop({ preserveScreen: true }));
	assert.match(h.terminal.output, /\x1b\[\?1002h/, "TMUX must enable button-motion tracking");
	assert.doesNotMatch(h.terminal.output, /\x1b\[\?1003h/, "TMUX must never enable idle all-motion tracking");
});
