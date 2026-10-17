import "./env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../packages/coding-agent/src/config.ts";
import vinciCrew from "../../extensions/vinci-crew.ts";
import vinciQueue from "../../extensions/vinci-queue.ts";
import vinciTodo from "../../extensions/vinci-todo.ts";
import { createVinciUiHarness, expectSnapshot } from "./harness.mjs";

const NOW = 2_000_000_000_000;
const open = [];
const copies = [];
let caseDir;

beforeEach(() => {
	caseDir = mkdtempSync(join(tmpdir(), "vinci-fullscreen-"));
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("PI_") || name.startsWith("XDG_")) vi.stubEnv(name, undefined);
	}
	for (const name of ["VINCI_COPY_ON_SELECT", "VINCI_CODE", "TMUX", "ZELLIJ", "STY"]) vi.stubEnv(name, undefined);
	for (const name of [
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
		"XDG_RUNTIME_DIR",
		ENV_AGENT_DIR,
		"TMPDIR",
	]) {
		const value = join(caseDir, name.toLowerCase());
		mkdirSync(value, { recursive: true });
		vi.stubEnv(name, value);
	}
	for (const [name, value] of Object.entries({
		PI_OFFLINE: "1",
		VINCI_CODE: "1",
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		TERM_PROGRAM: "xterm",
		VINCI_CREW_CAPACITY: "2",
		VINCI_ASCII_WORDMARK: "1",
		VINCI_NO_VERIFY: "1",
		VINCI_NO_SANDBOX: "1",
	}))
		vi.stubEnv(name, value);
	vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
	const started = performance.now();
	vi.spyOn(Date, "now").mockImplementation(() => NOW + Math.floor(performance.now() - started));
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	resetCapabilitiesCache();
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
});

afterEach(async () => {
	while (open.length) {
		const ui = open.pop();
		if (ui.originalUserBindings) ui.mode.keybindings.setUserBindings(ui.originalUserBindings);
		await ui.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await ui.close();
	}
	copies.length = 0;
	resetCapabilitiesCache();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(caseDir, { recursive: true });
});

async function createUi(options = {}) {
	const ui = await createVinciUiHarness({
		tuiMode: "fullscreen",
		copySelection: async (text) => {
			copies.push(text);
			return "native";
		},
		copyWriter: async (text) => {
			copies.push(text);
			return "native";
		},
		...options,
	});
	open.push(ui);
	return ui;
}

async function snapshot(name, ui) {
	await expectSnapshot(`fullscreen-${name}`, {
		async screen() {
			return (await ui.screen())
				.replace(/Vinci v\d+\.\d+\.\d+/g, "Vinci v<version>")
				.replace(/\b(?:Option|Alt)\+/g, "<alt>+");
		},
	});
}

function assertDock(ui, label) {
	assert.match(
		ui.terminal.getViewport().at(-1),
		/^╰.*╯$/,
		`${label}: EmptyFooter must reserve zero rows below the framed editor`,
	);
}

function seedCrew(pi) {
	pi.on("session_start", () => {
		for (const [id, name] of [
			[1, "agent-A"],
			[2, "agent-B"],
		]) {
			pi.appendEntry("vinci-crew-helper", {
				id,
				name,
				task: `TASK FOR ${name}`,
				status: "waiting",
				finishedAt: NOW - 1000,
				notifiedAt: NOW - 900,
				deliveredAt: NOW - 900,
				transcript: Array.from(
					{ length: 45 },
					(_, index) => `${name} ROW ${String(index).padStart(2, "0")} safe\x1b[2J\x1b]0;blocked\x07 end`,
				),
			});
		}
	});
}

function approval(pi) {
	pi.registerTool({
		name: "confirm_change",
		label: "Confirm change",
		description: "Ask before deleting generated files",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const choice = await ctx.ui.select("Vinci wants to delete generated files", [
				"Allow once",
				"Always allow this",
				"Skip",
			]);
			return { content: [{ type: "text", text: `User chose: ${choice}` }], details: { choice } };
		},
	});
}

describe("Vinci opt-in fullscreen journeys", { concurrency: false }, () => {
	test("header, framed editor and EmptyFooter survive a short resized composer", async () => {
		const ui = await createUi();
		assertDock(ui, "startup");
		assert.match(await ui.screen(), /Vinci v\d+\.\d+\.\d+ Code/);
		assert.match(await ui.screen(), /\/login to connect/);
		await snapshot("startup-80x24", ui);
		ui.sendKeys("DRAFT-SENTINEL");
		await ui.resize(60, 14);
		assertDock(ui, "60x14 resize");
		assert.equal(ui.mode.editor.getText(), "DRAFT-SENTINEL");
		assert.match(await ui.screen(), /DRAFT-SENTINEL/);
		assert.equal(ui.core.faux.callCount, 0);
		await snapshot("composer-60x14", ui);
	});

	test("code and exact copy hint sit above the editor and Alt+C copies through the picker", async () => {
		const ui = await createUi({
			loadVinciCopy: true,
			responses: ["Here is the guard:\n\n```js\nconst limit = 5;\n```\n\nThat caps retries."],
		});
		await ui.prompt("Show the guard");
		assertDock(ui, "code response");
		const screen = await ui.screen();
		const hint = "Tip · Use /copy when you want Vinci's output on your clipboard.";
		assert.match(screen, /const limit = 5;/);
		assert.doesNotMatch(screen, /```/);
		assert.ok(screen.includes(hint), "the unchanged /copy hint must render");
		assert.ok(screen.indexOf(hint) < screen.indexOf("╭"), "copy hint must precede the editor");
		await snapshot("code-hint-80x24", ui);
		ui.sendKeys("\x1bc");
		await ui.waitForText("Copy to clipboard");
		assert.match(await ui.screen(), /Last code block/);
		ui.sendKeys("j", "\r");
		await ui.waitForText("Copied last code block.");
		assert.deepEqual(copies, ["const limit = 5;"]);
		assert.doesNotMatch(await ui.screen(), /Tip · Use \/copy/);
	});

	test("a real plan remains above the editor", async () => {
		const ui = await createUi({
			extensions: [{ factory: vinciTodo, path: "vinci/extensions/vinci-todo.ts" }],
			responses: [
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Inspect the UI", status: "done" },
									{ title: "Verify terminal sizes", status: "doing" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				"The plan is ready. Which terminal size should we prioritize?",
			],
		});
		await ui.prompt("Plan the layout");
		assertDock(ui, "plan response");
		const screen = await ui.screen();
		assert.match(screen, /Plan\s+1\/2/);
		assert.match(screen, /Verify terminal sizes/);
		assert.ok(screen.indexOf("Verify terminal sizes") < screen.indexOf("╭"), "plan must precede the editor");
		assert.equal(
			ui.terminal.xterm.buffer.active.type,
			"alternate",
			"the plan journey must render in the alternate viewport",
		);
		await snapshot("plan-80x24", ui);
	});

	test("active work and the actual user queue remain accessible above the editor", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const ui = await createUi({
			extensions: [{ factory: vinciQueue, path: "vinci/extensions/vinci-queue.ts" }],
			tools: [
				{
					name: "slow_check",
					label: "Check project",
					description: "Wait for test release",
					parameters: Type.Object({}),
					async execute() {
						await gate;
						return { content: [{ type: "text", text: "Check complete." }], details: {} };
					},
				},
			],
			responses: [
				{
					text: "I am checking the project setup.",
					toolCalls: [{ name: "slow_check", args: {} }],
					stopReason: "toolUse",
				},
				"The check finished.",
				"The queued request is recorded.",
			],
		});
		const { completion } = await ui.startPrompt("Check the project");
		try {
			await ui.waitForText("Checking the result…");
			await ui.session.prompt("Keep the docs unchanged", { streamingBehavior: "followUp" });
			await ui.waitForText("Queued for Vinci");
			assertDock(ui, "active queue");
			const screen = await ui.screen();
			assert.match(screen, /Keep the docs unchanged/);
			assert.ok(screen.indexOf("Queued for Vinci") < screen.indexOf("╭"), "queue must precede the editor");
			assert.equal(
				ui.terminal.xterm.buffer.active.type,
				"alternate",
				"the queue journey must render in the alternate viewport",
			);
			await snapshot("active-queue-80x24", ui);
		} finally {
			release();
			await completion;
		}
	});

	test("permission choices accept keyboard input and return to the framed editor", async () => {
		const ui = await createUi({
			extensions: [{ factory: approval, path: "vinci/test/ui/fullscreen-journeys.test.mjs" }],
			responses: [
				{ toolCalls: [{ name: "confirm_change", args: {} }], stopReason: "toolUse" },
				"Skipped the deletion and kept the project unchanged.",
			],
		});
		const { completion } = await ui.startPrompt("Clean generated files");
		await ui.waitForText("Vinci wants to delete generated files");
		const screen = await ui.screen();
		assert.match(screen, /Allow once/);
		assert.match(screen, /Always allow this/);
		assert.match(screen, /Skip/);
		assert.match(
			ui.terminal.getViewport().at(-1),
			/─{5}/,
			"permission choices must stay anchored at the bottom of the fullscreen dock",
		);
		await snapshot("permission-80x24", ui);
		ui.sendKeys("j", "j", "\r");
		await completion;
		await ui.settle();
		assertDock(ui, "permission dismissed");
		assert.match(await ui.screen(), /Skipped the deletion/);
	});

	test("diff previews and the completion receipt remain visible above the composer", async () => {
		const ui = await createUi({
			responses: [
				{
					toolCalls: [
						{
							name: "edit",
							args: {
								path: "config.ts",
								edits: [{ oldText: 'const mood = "quiet";', newText: 'const mood = "lively";' }],
							},
						},
					],
					stopReason: "toolUse",
				},
				"I made the interface feel more lively.",
			],
		});
		writeFileSync(join(ui.core.tempDir, "config.ts"), 'const mood = "quiet";\n');
		await ui.prompt("Make the interface feel lively");
		assertDock(ui, "edit response");
		const screen = await ui.screen();
		assert.match(screen, /changed · \+1 −1/);
		assert.match(screen, /-\s*1 const mood = "quiet";/);
		assert.match(screen, /\+\s*1 const mood = "lively";/);
		assert.match(screen, /Done — please check it/);
		assert.ok(screen.indexOf("Done — please check it") < screen.indexOf("╭"), "receipt must precede the editor");
		assert.equal(
			ui.terminal.xterm.buffer.active.type,
			"alternate",
			"the diff journey must render in the alternate viewport",
		);
		await snapshot("diff-receipt-80x24", ui);
	});

	test("provider errors remain visible with the ready editor", async () => {
		const ui = await createUi({
			responses: [{ error: "The local provider stopped responding.", stopReason: "error" }],
		});
		await ui.prompt("Run the checks");
		assertDock(ui, "failed response");
		assert.match(await ui.screen(), /local provider stopped responding/);
		assert.match(await ui.screen(), /Stopped — needs you/);
		await snapshot("error-80x24", ui);
	});

	for (const tuiMode of ["regular", "fullscreen"])
		test(`${tuiMode} crew owns paging, switching and mouse input while hiding the orchestrator`, async () => {
			const ui = await createUi({
				tuiMode,
				responses: ["ORCHESTRATOR TRANSCRIPT SENTINEL"],
				extensions: [
					{ factory: seedCrew, path: "vinci/test/ui/crew-seed-extension.ts" },
					{ factory: vinciCrew, path: "vinci/extensions/vinci-crew.ts" },
				],
			});
			await ui.prompt("ORCHESTRATOR REQUEST SENTINEL");
			const base = await ui.screen();
			assert.ok(base.indexOf("agent-A") > base.indexOf("╰"), "crew roster must follow the editor");
			const delivered = [];
			const originalCustom = ui.mode.showExtensionCustom.bind(ui.mode);
			vi.spyOn(ui.mode, "showExtensionCustom").mockImplementation((factory, options) =>
				originalCustom(async (...args) => {
					const component = await factory(...args);
					const input = component.handleInput;
					component.handleInput = (data) => {
						delivered.push(data);
						input?.(data);
					};
					return component;
				}, options),
			);
			ui.sendKeys("\x1b[B");
			await ui.waitForText("↑↓ move");
			ui.sendKeys("\r");
			await ui.waitForText("Agent · agent-A");
			let screen = await ui.screen();
			assert.match(screen, /agent-A ROW 44 safe end/);
			assert.doesNotMatch(screen, /ORCHESTRATOR|\[2J|blocked|● main/);
			ui.originalUserBindings = ui.mode.keybindings.getUserBindings();
			ui.mode.keybindings.setUserBindings({
				...ui.originalUserBindings,
				"tui.altScreen.pageUp": "pageUp",
				"tui.altScreen.pageDown": "pageDown",
			});
			ui.sendKeys("\x1b[5~");
			await ui.settle();
			screen = await ui.screen();
			assert.doesNotMatch(
				screen,
				/agent-A ROW 44 /,
				"PageUp must scroll the crew component rather than the hidden transcript",
			);
			ui.sendKeys("\x1b[6~");
			await ui.waitForText("agent-A ROW 44");
			ui.sendKeys("\t");
			await ui.waitForText("Agent · agent-B");
			ui.sendKeys("\x1b[Z");
			await ui.waitForText("Agent · agent-A");
			ui.sendKeys("\x1b[<64;5;6M", "\x1b[<0;5;6M", "\x1b[<32;15;6M", "\x1b[<0;15;6m");
			await ui.settle();
			assert.deepEqual(copies, [], "focused crew overlay must never copy hidden transcript");
			if (tuiMode === "fullscreen") {
				assert.deepEqual(
					delivered.filter((data) => /\x1b\[</.test(data)),
					[],
					"crew custom component must receive ZERO raw mouse bytes",
				);
				await snapshot("crew-80x24", ui);
				await ui.resize(60, 14);
				assert.match(await ui.screen(), /Message this agent:.*\n.*\(read-only\)/);
				assert.match(await ui.screen(), /Esc to close/);
				assert.doesNotMatch(await ui.screen(), /ORCHESTRATOR/);
				await snapshot("crew-60x14", ui);
				await ui.resize(80, 24);
			}
			ui.sendKeys("\x1b");
			await ui.waitForText("ORCHESTRATOR TRANSCRIPT SENTINEL");
			if (tuiMode === "fullscreen") {
				const lines = ui.terminal.getViewport();
				const row = lines.findIndex((line) => line.includes("ORCHESTRATOR TRANSCRIPT SENTINEL"));
				const column = lines[row].indexOf("ORCHESTRATOR");
				ui.sendKeys(
					`\x1b[<0;${column + 1};${row + 1}M`,
					`\x1b[<32;${column + 13};${row + 1}M`,
					`\x1b[<0;${column + 13};${row + 1}m`,
				);
				await ui.settle();
				assert.deepEqual(
					copies,
					["ORCHESTRATOR "],
					"visible transcript selection after closing crew must copy through the in-memory writer",
				);
				const flashRow = ui.terminal.getViewport().findIndex((line) => line.includes("Copied"));
				assert.ok(flashRow >= 0 && flashRow <= 2, "selection feedback must appear in the top-right flash layer");
			}
		});
});
