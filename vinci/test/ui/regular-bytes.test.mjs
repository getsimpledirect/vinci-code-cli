import "./env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { createVinciUiHarness } from "./harness.mjs";

const fixture = new URL("./fixtures/regular-journey.json", import.meta.url);
const FIXED_TMPDIR = "/tmp/vinci-regular-bytes";

// What this pins (the raw stream itself is not frozen: TUI.requestRender coalesces frames on a
// real setTimeout, so the number of intermediate frames a real InteractiveMode journey paints
// varies by machine; byte-exactness is pinned at the TUI level in packages/tui/test):
// regular mode never toggles a mouse/focus/alt-screen mode, uses exactly the base's set of
// private terminal modes, and settles on the base's screen and cursor at each checkpoint.
const FORBIDDEN_MODES = [1000, 1002, 1003, 1004, 1006, 1049];

function privateModes(stream) {
	return [...new Set(stream.match(/\x1b\[\?[0-9;]+[hl]/g) ?? [])].sort();
}

// The header shows the release version; normalise it so a version bump is not a screen change.
const normaliseVersion = (screen) => screen.replace(/Vinci v\d+\.\d+\.\d+/g, "Vinci v<version>");

async function checkpoint(ui) {
	return { screen: normaliseVersion(await ui.screen()), cursor: ui.terminal.getCursorPosition() };
}

test("regular InteractiveMode emits no new terminal modes and settles on the base screen", async () => {
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
	const checkpoints = {};
	// The harness workspace lives under os.tmpdir() and its path is rendered, so pin the temp root
	// to one fixed absolute path: the frozen bytes must not depend on the caller's TMPDIR (CI has none).
	const previousTmpdir = process.env.TMPDIR;
	mkdirSync(FIXED_TMPDIR, { recursive: true });
	process.env.TMPDIR = FIXED_TMPDIR;
	// Terminal capabilities are detected from TERM/COLORTERM/TERM_PROGRAM/TMUX and change the
	// colour and hyperlink bytes, so pin them on the same pi-tui instance the app renders with.
	resetCapabilitiesCache();
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	try {
		ui = await createVinciUiHarness({ responses: ["A deterministic response."] });
		checkpoints.started = await checkpoint(ui);
		await ui.prompt("A deterministic prompt.");
		assert.equal(ui.core.faux.callCount, 1);
		checkpoints.answered = await checkpoint(ui);
		await ui.resize(60, 20);
		checkpoints.resized = await checkpoint(ui);
	} finally {
		if (ui) await ui.close();
		resetCapabilitiesCache();
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
	const stream = output.join("");
	// Positive control: the journey really rendered the prompt and the response.
	assert.ok(stream.length > 0, "the regular journey must write terminal output");
	assert.ok(stream.includes("A deterministic prompt."), "the stream must contain the prompt");
	assert.ok(stream.includes("A deterministic response."), "the stream must contain the response");
	for (const mode of FORBIDDEN_MODES) {
		for (const action of ["h", "l"]) {
			assert.equal(stream.includes(`\x1b[?${mode}${action}`), false, `regular mode must never emit ?${mode}${action}`);
		}
	}
	const actual = { modes: privateModes(stream), checkpoints };
	if (process.env.CAPTURE_REGULAR_BASELINE === "1") {
		writeFileSync(fixture, `${JSON.stringify(actual, null, "\t")}\n`, { flag: "wx" });
	}
	const expected = JSON.parse(readFileSync(fixture, "utf8"));
	assert.deepEqual(actual.modes, expected.modes, "regular mode must use exactly the base's set of private terminal modes");
	assert.deepEqual(actual.checkpoints, expected.checkpoints, "regular mode must settle on the base's screen and cursor");
});
