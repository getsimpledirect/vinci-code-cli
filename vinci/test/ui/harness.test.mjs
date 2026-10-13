import "./env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { createVinciUiHarness } from "./harness.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const original = process.env.GIT_CEILING_DIRECTORIES;
const fixtures = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pi-harness-"));

afterEach(() => {
	vi.restoreAllMocks();
	if (original === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
	else process.env.GIT_CEILING_DIRECTORIES = original;
});

for (const initial of [undefined, resolve(root, "vinci/test")]) {
	const kind = initial === undefined ? "absent" : "existing";
	test(`actual harness isolates Git and restores ${kind} ceiling on close`, async () => {
		if (initial === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = initial;
		const ui = await createVinciUiHarness();
		try {
			if (initial !== undefined) assert.ok(process.env.GIT_CEILING_DIRECTORIES.startsWith(initial));
			assert.throws(() =>
				execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ui.core.tempDir, stdio: "pipe" }),
			);
			assert.match(await ui.screen(), /Vinci ──── <workspace>  ·  0% full · ↓ 0 ╯/);
		} finally {
			await ui.close();
		}
		assert.equal(process.env.GIT_CEILING_DIRECTORIES, initial);
	});

	test(`actual terminal-start failure cleans fixture and restores ${kind} ceiling`, async () => {
		if (initial === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = initial;
		const before = fixtures();
		vi.spyOn(VirtualTerminal.prototype, "start").mockImplementation(() => {
			throw new Error("Injected virtual terminal startup failure.");
		});
		await assert.rejects(createVinciUiHarness(), /Injected virtual terminal startup failure/);
		assert.equal(process.env.GIT_CEILING_DIRECTORIES, initial);
		assert.deepEqual(fixtures(), before);
	});
}
