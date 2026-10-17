import "./env.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { createVinciUiHarness } from "./harness.mjs";

const fixture = new URL("./fixtures/regular-bytes.ansi", import.meta.url);

test("regular InteractiveMode preserves its complete raw output stream", async () => {
	const output = [];
	vi.useFakeTimers({ now: 1_792_238_400_000, toFake: ["Date", "setInterval", "clearInterval"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const recording = new WeakSet();
	for (const method of [
		"start",
		"stop",
		"write",
		"moveBy",
		"hideCursor",
		"showCursor",
		"clearLine",
		"clearFromCursor",
		"clearScreen",
		"setTitle",
	]) {
		const original = VirtualTerminal.prototype[method];
		vi.spyOn(VirtualTerminal.prototype, method).mockImplementation(function (...args) {
			if (!recording.has(this)) {
				recording.add(this);
				const write = this.xterm.write.bind(this.xterm);
				vi.spyOn(this.xterm, "write").mockImplementation((data, callback) => {
					output.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
					write(data, callback);
				});
			}
			return original.apply(this, args);
		});
	}
	let ui;
	try {
		ui = await createVinciUiHarness({ responses: ["A deterministic response."] });
		await ui.prompt("A deterministic prompt.");
		assert.equal(ui.core.faux.callCount, 1);
		await ui.resize(60, 20);
	} finally {
		if (ui) await ui.close();
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
	const actual = Buffer.from(output.join(""));
	for (const mode of [1000, 1002, 1003, 1004, 1006, 1049]) {
		assert.equal(actual.includes(`\x1b[?${mode}h`), false, `regular mode must never enable ${mode}`);
	}
	if (process.env.CAPTURE_REGULAR_BASELINE === "1") {
		writeFileSync(fixture, actual, { flag: "wx" });
	}
	assert.deepEqual(actual, readFileSync(fixture), "regular InteractiveMode output must equal its frozen bytes");
});
