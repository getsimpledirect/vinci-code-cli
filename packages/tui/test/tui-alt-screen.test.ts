import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly output: string[] = [];
	override write(data: string): void {
		this.output.push(data);
		super.write(data);
	}
}

function lines(...content: string[]): Component {
	return { render: () => content, invalidate() {} };
}

function dockedUi() {
	const terminal = new RecordingTerminal(40, 10);
	const tui = new TuiAltScreen(terminal, true);
	const transcript = lines(...Array.from({ length: 30 }, (_, index) => `masked row ${index}`));
	const scroll = new ScrollView(transcript, { follow: "end", primary: true });
	const editor = { ...lines("editor top", `> draft${CURSOR_MARKER}`, "editor bottom"), focused: false };
	const dock = new VStack([{ component: editor, minSize: 3, shrink: 0 }, lines("widget"), lines("footer")]);
	tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, dock]));
	tui.setFocus(editor);
	return { terminal, tui, scroll, editor };
}

test("R1 fullscreen enters and symmetrically resets its own terminal modes", async () => {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild(lines("body"));
	tui.start();
	await terminal.waitForRender();
	tui.stop();
	const output = terminal.output.join("");
	assert.ok(output.includes("\x1b[?1049h"), "fullscreen start must enter the alternate screen");
	for (const mode of [1000, 1002, 1006, 1049]) {
		assert.ok(output.includes(`\x1b[?${mode}h`), `fullscreen start must enable ${mode}`);
		assert.ok(output.includes(`\x1b[?${mode}l`), `fullscreen stop must reset ${mode}`);
	}
	assert.ok(output.includes("\x1b[?7h"), "fullscreen stop must restore autowrap");
	assert.equal(output.includes("\x1b]52;"), false, "fullscreen must not write to the clipboard");
	const regularTerminal = new RecordingTerminal();
	const regular = new TUI(regularTerminal);
	regular.addChild(lines("body"));
	regular.start();
	await regularTerminal.waitForRender();
	regular.stop();
	for (const mode of [1000, 1002, 1003, 1004, 1006, 1049]) {
		assert.equal(regularTerminal.output.join("").includes(`\x1b[?${mode}h`), false);
	}
});

test("R2 transcript scrolling preserves the fixed editor, widget, footer and editor cursor", async () => {
	const { terminal, tui, scroll } = dockedUi();
	try {
		tui.start();
		await terminal.waitForRender();
		const before = terminal.getViewport().map((line) => line.trimEnd());
		assert.deepEqual(
			before.slice(5),
			["editor top", "> draft", "editor bottom", "widget", "footer"],
			"fixed dock must remain visible",
		);
		assert.deepEqual(terminal.getCursorPosition(), { x: 7, y: 6 }, "cursor must be visible in the editor");
		assert.ok(terminal.output.at(-1)?.includes("\x1b[?25h"), "editor hardware cursor must be shown");
		assert.equal(scroll.scrollTop, 25);
		tui.scrollBy(-3);
		await terminal.waitForRender();
		assert.equal(scroll.scrollTop, 22);
		assert.notDeepEqual(
			terminal
				.getViewport()
				.slice(0, 5)
				.map((line) => line.trimEnd()),
			before.slice(0, 5),
		);
		assert.deepEqual(
			terminal
				.getViewport()
				.slice(5)
				.map((line) => line.trimEnd()),
			before.slice(5),
		);
		assert.deepEqual(terminal.getCursorPosition(), { x: 7, y: 6 });
	} finally {
		tui.stop();
	}
});

test("R3 clipped and scrolled pointer positions resolve to rendered scroll-view source coordinates", async () => {
	const terminal = new RecordingTerminal(40, 10);
	const tui = new TuiAltScreen(terminal);
	const scroll = new ScrollView(lines(...Array.from({ length: 20 }, (_, index) => `MASK-${index}`)), {
		primary: true,
	});
	const inner = new VStack([lines("inner heading", "inner heading 2"), { component: scroll, basis: 8, shrink: 0 }]);
	const outer = new ScrollView(inner);
	tui.setLayoutRoot(
		new VStack([lines("header", "header 2"), { component: outer, basis: 4, shrink: 0 }, lines("dock")]),
	);
	try {
		tui.start();
		await terminal.waitForRender();
		scroll.scrollBy(6);
		tui.requestRender();
		await terminal.waitForRender();
		assert.equal(
			terminal.getViewport()[5]?.trimEnd(),
			"MASK-7",
			"positive control must render the clipped source row",
		);
		terminal.sendInput("\x1b[<0;3;6M");
		const point = Reflect.get(tui, "selectionAnchor");
		assert.deepEqual(
			point,
			{ row: 7, col: 2, scrollView: scroll },
			"pointer must use scroll-view source coordinates after clipping",
		);
		terminal.sendInput("\x1b[<32;6;6M");
		terminal.sendInput("\x1b[<0;6;6m");
		await terminal.waitForRender();
		assert.ok(terminal.output.join("").includes("\x1b[7m"), "rendered text selection must be highlighted");
		assert.equal(terminal.output.join("").includes("\x1b]52;"), false, "selection release must not emit OSC 52");
	} finally {
		tui.stop();
	}
});

test("R4 complete SGR press, drag and release decode with zero-based coordinates", () => {
	const tui = new TuiAltScreen(new RecordingTerminal());
	const decode = Reflect.get(tui, "parseSgrMouseEvent").bind(tui);
	assert.deepEqual(
		["\x1b[<0;2;3M", "\x1b[<32;4;5M", "\x1b[<0;4;5m"].map(decode),
		[
			{ button: 0, x: 1, y: 2, release: false },
			{ button: 32, x: 3, y: 4, release: false },
			{ button: 0, x: 3, y: 4, release: true },
		],
		"SGR events must decode press, drag and release coordinates",
	);
});

test("selection stays within rendered scroll-view text and excludes docks and overlays", async () => {
	const { terminal, tui } = dockedUi();
	try {
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;9M");
		assert.equal(Reflect.get(tui, "selectionAnchor"), undefined, "dock text must not start a selection");
		terminal.sendInput("\x1b[<0;1;2M");
		assert.ok(Reflect.get(tui, "selectionAnchor"), "rendered transcript must be selectable");
		const overlay = tui.showOverlay(lines("modal"));
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;2M");
		assert.equal(Reflect.get(tui, "selectionAnchor"), undefined, "overlay must block transcript selection");
		overlay.hide();
	} finally {
		tui.stop();
	}
});

test("R4 every byte split preserves decoded events and keeps mouse payload out of the editor", async () => {
	const sequences = ["\x1b[<0;2;3M", "\x1b[<32;4;4M", "\x1b[<0;4;4m"];
	const stream = sequences.join("");
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal);
	const editorInputs: string[] = [];
	tui.addChild(lines("one", "two", "three", "four", "five"));
	tui.setFocus({ ...lines("editor"), handleInput: (data) => editorInputs.push(data) });
	const decode = Reflect.get(tui, "parseSgrMouseEvent").bind(tui);
	const expected = sequences.map(decode);
	try {
		tui.start();
		await terminal.waitForRender();
		const wholeBuffer = new StdinBuffer({ timeout: 10 });
		const wholeEvents: unknown[] = [];
		wholeBuffer.on("data", (data) => {
			wholeEvents.push(decode(data));
			terminal.sendInput(data);
		});
		try {
			wholeBuffer.process(stream);
			assert.deepEqual(editorInputs, [], "whole mouse stream must stay out of the editor");
			assert.deepEqual(wholeEvents, expected, "whole byte stream must decode all three SGR events");
		} finally {
			wholeBuffer.destroy();
		}
		for (let split = 1; split < stream.length; split++) {
			const buffer = new StdinBuffer({ timeout: 10 });
			const events: unknown[] = [];
			buffer.on("data", (data) => {
				const event = decode(data);
				if (event) events.push(event);
				terminal.sendInput(data);
			});
			try {
				buffer.process(stream.slice(0, split));
				await Promise.resolve();
				buffer.process(stream.slice(split));
				assert.deepEqual(editorInputs, [], `editor must receive no mouse payload at byte split ${split}`);
				assert.deepEqual(events, wholeEvents, `fragmented stream must decode identically at byte split ${split}`);
			} finally {
				buffer.destroy();
			}
		}
		terminal.sendInput("x");
		assert.deepEqual(editorInputs, ["x"], "ordinary editor input must still be delivered");
	} finally {
		tui.stop();
	}
});

test("R5 nested dock preserves a custom editor minimum beside an empty custom footer", () => {
	const editor = lines(`custom editor${CURSOR_MARKER}`);
	const dock = new VStack([{ component: editor, minSize: 3 }, lines()]);
	const frame = renderLayoutFrame(
		new VStack([{ component: lines("body"), basis: 0, grow: 1 }, dock]),
		40,
		5,
		() => {},
	);
	assert.equal(frame.lines[2]?.includes("custom editor"), true, "nested minimum must allocate three editor rows");
	assert.equal(frame.lines[2]?.includes(CURSOR_MARKER), true, "custom editor cursor must remain visible");
	assert.equal(dock.render(40).length, 3, "intrinsic dock measurement must honor nested editor minimum");
});

test("contained wheel routing keeps the primary transcript still while chained routing can scroll it", async () => {
	for (const overscroll of ["chain", "contain"] as const) {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const content = lines(...Array.from({ length: 20 }, (_, row) => `row ${row}`));
		const primary = new ScrollView(content, { primary: true });
		const secondary = new ScrollView(content, { overscroll });
		tui.setLayoutRoot(
			new VStack([
				{ component: primary, basis: 4 },
				{ component: secondary, basis: 4 },
			]),
		);
		try {
			tui.start();
			await terminal.waitForRender();
			primary.scrollBy(5);
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<64;1;6M");
			await terminal.waitForRender();
			assert.equal(secondary.scrollTop, 0);
			assert.equal(
				primary.scrollTop,
				overscroll === "chain" ? 2 : 5,
				"contained wheel must not scroll the primary transcript",
			);
		} finally {
			tui.stop();
		}
	}
});
