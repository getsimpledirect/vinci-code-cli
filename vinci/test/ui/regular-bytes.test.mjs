import "./env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { createVinciUiHarness } from "./harness.mjs";

const fixture = new URL("./fixtures/regular-bytes.ansi", import.meta.url);
const FIXED_TMPDIR = "/tmp/vinci-regular-bytes";

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
	// The harness workspace lives under os.tmpdir() and its path is rendered, so pin the temp root
	// to one fixed absolute path: the frozen bytes must not depend on the caller's TMPDIR (CI has none).
	const previousTmpdir = process.env.TMPDIR;
	mkdirSync(FIXED_TMPDIR, { recursive: true });
	process.env.TMPDIR = FIXED_TMPDIR;
	try {
		ui = await createVinciUiHarness({ responses: ["A deterministic response."] });
		await ui.prompt("A deterministic prompt.");
		assert.equal(ui.core.faux.callCount, 1);
		await ui.resize(60, 20);
	} finally {
		if (ui) await ui.close();
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
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
