import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const fixture = new URL("./fixtures/tui-regular-bytes.ansi", import.meta.url);

test("regular mode preserves the complete ordered output stream", async () => {
	resetCapabilitiesCache();
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const terminal = new VirtualTerminal(40, 10);
	const output: string[] = [];
	const xterm = Reflect.get(terminal, "xterm") as XtermTerminal;
	const write = xterm.write.bind(xterm);
	xterm.write = (data, callback) => {
		output.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
		write(data, callback);
	};
	const tui = new TUI(terminal, true);
	let text = "";
	let status = "Ready";
	const editor: Component & { focused: boolean } = {
		focused: false,
		render: () => [status, `> ${text}${CURSOR_MARKER}`],
		handleInput: (data) => {
			text += data;
			tui.requestRender();
		},
		invalidate() {},
	};
	tui.addChild(editor);
	tui.setFocus(editor);
	try {
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("hello");
		await terminal.waitForRender();
		status = "Updated";
		tui.requestRender();
		await terminal.waitForRender();
		terminal.resize(32, 8);
		await terminal.waitForRender();
		const overlay = tui.showOverlay({ render: () => ["Permission"], invalidate() {} }, { width: 16 });
		await terminal.waitForRender();
		overlay.hide();
		await terminal.waitForRender();
	} finally {
		tui.stop();
		await terminal.flush();
		resetCapabilitiesCache();
	}
	const actual = Buffer.from(output.join(""));
	for (const mode of [1000, 1002, 1003, 1004, 1006, 1049]) {
		assert.equal(actual.includes(`\x1b[?${mode}h`), false, `regular mode must never enable ${mode}`);
	}
	if (process.env.CAPTURE_REGULAR_BASELINE === "1") {
		writeFileSync(fixture, actual, { flag: "wx" });
	}
	assert.deepEqual(actual, readFileSync(fixture), "regular output must equal the frozen baseline byte for byte");
});
