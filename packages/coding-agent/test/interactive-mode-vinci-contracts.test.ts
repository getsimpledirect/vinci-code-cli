import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, type Container, Text, type TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import vinciCopy from "../../../vinci/extensions/vinci-copy.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR, VERSION } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarnessWithExtensions, fauxModel } from "./test-harness.ts";

const clipboard = vi.hoisted(() => ({
	plain: vi.fn<(text: string) => Promise<void>>(),
	routed: vi.fn<(text: string) => Promise<"native" | "terminal" | "remote-only">>(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: clipboard.plain,
	copyToClipboardWithRoute: clipboard.routed,
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
	clipboard.plain.mockResolvedValue(undefined);
	clipboard.routed.mockResolvedValue("native");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Contract tests are offline; inspect the network caller."))),
	);
});
afterEach(() => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	clipboard.plain.mockReset();
	clipboard.routed.mockReset();
});

async function fixture(
	vinci: string | undefined,
	options: {
		mode?: "regular" | "fullscreen";
		copyOnSelect?: boolean;
		env?: string;
		restartSettings?: string;
		remap?: boolean;
	} = {},
) {
	const caseDir = mkdtempSync(join(tmpdir(), "vinci-contracts-"));
	cleanups.push(() => rmSync(caseDir, { recursive: true, force: true }));
	for (const key of Object.keys(process.env)) {
		if (
			key.startsWith("PI_") ||
			key.startsWith("XDG_") ||
			["VINCI_COPY_ON_SELECT", "VINCI_CODE", "TMUX", "ZELLIJ", "STY"].includes(key)
		) {
			vi.stubEnv(key, undefined);
		}
	}
	for (const key of [
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
		"XDG_RUNTIME_DIR",
		"TMPDIR",
	]) {
		const path = join(caseDir, key.toLowerCase());
		mkdirSync(path, { recursive: true });
		vi.stubEnv(key, path);
	}
	vi.stubEnv("TERM", "xterm-256color");
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("VINCI_TOOL_BOOTSTRAP", "0");
	vi.stubEnv("VINCI_CODE", vinci);
	vi.stubEnv("VINCI_COPY_ON_SELECT", options.env);
	const extensionWriter = vi.fn(async (_text: string): Promise<void> => {});
	const core = await createHarnessWithExtensions({
		responses: ["Routing proof message"],
		settings: {
			lastChangelogVersion: VERSION,
			theme: "dark",
			quietStartup: true,
			enableInstallTelemetry: false,
			retry: { enabled: false },
			terminal: { showImages: false },
			copyOnSelect: options.copyOnSelect,
		},
		extensionFactories: [
			{ factory: (api) => vinciCopy(api, extensionWriter), path: "vinci/extensions/vinci-copy.ts" },
		],
	});
	writeFileSync(join(core.tempDir, "settings.json"), "{}");
	if (options.restartSettings) {
		writeFileSync(join(core.tempDir, "settings.json"), readFileSync(options.restartSettings));
		await core.settingsManager.reload();
		core.settingsManager.applyOverrides({
			lastChangelogVersion: VERSION,
			enableInstallTelemetry: false,
			quietStartup: true,
		});
	}
	vi.stubEnv(ENV_AGENT_DIR, core.tempDir);
	if (options.remap)
		writeFileSync(
			join(core.tempDir, "keybindings.json"),
			JSON.stringify({ "tui.select.up": ["ctrl+k"], "tui.select.down": ["ctrl+j"] }),
		);
	const terminal = new VirtualTerminal(160, 24);
	const runtime = new AgentSessionRuntime(
		core.session,
		{
			cwd: core.tempDir,
			agentDir: core.tempDir,
			authStorage: core.authStorage,
			settingsManager: core.settingsManager,
			modelRegistry: core.modelRegistry,
			resourceLoader: core.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Contract fixture must not replace its session; inspect the test entry point.");
		},
	);
	const mode = new InteractiveMode(runtime, {
		terminal,
		manageProcessSignals: false,
		tuiMode: options.mode ?? "regular",
	});
	cleanups.push(() => {
		mode.stop();
		core.cleanup();
	});
	await mode.init();
	await core.session.prompt("seed assistant output");
	await terminal.waitForRender();
	const internals = mode as unknown as {
		ui: TuiAltScreen;
		chatContainer: Container;
		editorContainer: Container;
		createExtensionUIContext(): ExtensionUIContext;
	};
	return { core, mode, terminal, extensionWriter, internals };
}

test("VINCI_CODE=1 typed /copy reaches core with vinci-copy explicitly loaded", async () => {
	clipboard.plain.mockResolvedValue(undefined);
	const { mode, terminal, core, extensionWriter } = await fixture("1");
	const internals = mode as unknown as {
		handleCopyCommand(): Promise<void>;
		showExtensionSelector(): Promise<string | undefined>;
	};
	const coreHandler = vi.spyOn(internals, "handleCopyCommand");
	const picker = vi.spyOn(internals, "showExtensionSelector");
	expect(
		core.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "copy"),
		"vinci-copy command is registered",
	).toBe(true);
	terminal.sendInput("/copy");
	terminal.sendInput("\r");
	await terminal.waitForRender();
	expect(coreHandler, "typed /copy must enter the real core handler").toHaveBeenCalledTimes(1);
	expect([...clipboard.plain.mock.calls, ...clipboard.routed.mock.calls], "core clipboard module is mocked").toEqual([
		["Routing proof message"],
	]);
	expect(picker, "typed /copy must not open vinci-copy's picker").not.toHaveBeenCalled();
	expect(extensionWriter, "typed /copy must not enter the extension clipboard writer").not.toHaveBeenCalled();
	expect(terminal.getViewport().join("\n")).toContain("Copied last agent message to clipboard");
});

for (const vinci of ["1", undefined])
	test.each([
		["native", "Copied last agent message to clipboard"],
		["terminal", "Sent last agent message to terminal clipboard"],
		["remote-only", "Copied on the remote machine only; it was too large to send to your local clipboard."],
		["throw", "clipboard fixture failure"],
	] as const)(`typed /copy route %s exact status VINCI_CODE=${vinci}`, async (route, expected) => {
		const { terminal } = await fixture(vinci);
		if (route === "throw") {
			clipboard.routed.mockRejectedValue(new Error("clipboard fixture failure"));
			clipboard.plain.mockRejectedValue(new Error("clipboard fixture failure"));
		} else {
			clipboard.routed.mockResolvedValue(route);
		}
		terminal.sendInput("/copy");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n"), `exact ${route} status`).toContain(
			vinci === "1" || route === "throw" ? expected : "Copied last agent message to clipboard",
		);
	});

const mouse = ["\x1b[<65;2;2M", "\x1b[<0;2;2M", "\x1b[<32;8;2M", "\x1b[<0;8;2m"];
test.each([
	["1", "fullscreen", false, true, []],
	["1", "fullscreen", true, true, mouse],
	["1", "fullscreen", false, false, []],
	["1", "fullscreen", true, false, mouse],
	[undefined, "fullscreen", false, true, [mouse[0]]],
	["1", "regular", false, true, mouse],
] as const)(
	"custom modal input contract VINCI_CODE=%s mode=%s opt-in=%s overlay=%s",
	async (vinci, mode, acceptsMouseInput, overlay, expected) => {
		const { terminal, internals } = await fixture(vinci, { mode });
		const inputs: string[] = [];
		let finish: ((result: unknown) => void) | undefined;
		const component: Component & { acceptsMouseInput: boolean } = {
			acceptsMouseInput,
			render: () => ["custom modal"],
			invalidate() {},
			handleInput(data) {
				inputs.push(data);
			},
		};
		const modal = internals.createExtensionUIContext().custom(
			(_ui, _theme, _keys, done) => {
				finish = done;
				return component;
			},
			{ overlay },
		);
		await terminal.waitForRender();
		terminal.sendInput("before");
		for (const sequence of mouse) terminal.sendInput(sequence);
		terminal.sendInput("after");
		await terminal.waitForRender();
		expect(inputs, "custom modal receives the exact allowed input and no hidden-copy payload").toEqual([
			"before",
			...expected,
			"after",
		]);
		expect(clipboard.routed).not.toHaveBeenCalled();
		finish?.(undefined);
		await modal;
	},
);

test.each([true, false])("custom modal strips mouse from mixed text input overlay=%s", async (overlay) => {
	const { terminal, internals } = await fixture("1", { mode: "fullscreen" });
	const inputs: string[] = [];
	let finish: ((result: unknown) => void) | undefined;
	const modal = internals.createExtensionUIContext().custom(
		(_ui, _theme, _keys, done) => {
			finish = done;
			return {
				render: () => ["custom mixed input"],
				invalidate() {},
				handleInput(data) {
					inputs.push(data);
				},
			};
		},
		{ overlay },
	);
	await terminal.waitForRender();
	terminal.sendInput(`left${mouse[0]}right`);
	await terminal.waitForRender();
	expect(inputs, "mixed text retains keyboard bytes and strips the SGR mouse sequence").toEqual(["leftright"]);
	finish?.(undefined);
	await modal;
});

for (const vinci of ["1", undefined])
	test.each([false, true])(`built-in model selector wheel navigation VINCI_CODE=${vinci} remap=%s`, async (remap) => {
		const { terminal, core, internals } = await fixture(vinci, { mode: "fullscreen", remap });
		vi.spyOn(core.modelRegistry, "getAvailable").mockReturnValue(
			Array.from({ length: 12 }, (_, i) => ({ ...fauxModel, id: `wheel-${i}`, name: `Wheel ${i}` })),
		);
		terminal.sendInput("/model");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		const selector = internals.editorContainer.children[0] as unknown as { selectedIndex: number };
		expect(selector.selectedIndex, "model selector starts at its first item").toBe(0);
		terminal.sendInput(mouse[0]);
		await terminal.waitForRender();
		expect(selector.selectedIndex, "Vinci built-in model selector still scrolls with the wheel").toBe(
			vinci === "1" ? 1 : 0,
		);
	});

async function selectTranscript(f: Awaited<ReturnType<typeof fixture>>, clicks = 0, release = true) {
	const lines = f.terminal.getViewport();
	const row = lines.findIndex((line) => line.includes("Routing proof message"));
	expect(row, "copy target is visible").toBeGreaterThanOrEqual(0);
	const x = lines[row].indexOf("Routing proof message") + 1;
	for (let i = 0; i < Math.max(clicks, 1); i++) {
		f.terminal.sendInput(`\x1b[<0;${x};${row + 1}M`);
		if (!clicks) f.terminal.sendInput(`\x1b[<32;${x + 4};${row + 1}M`);
		if (release) f.terminal.sendInput(`\x1b[<0;${clicks ? x : x + 4};${row + 1}m`);
	}
	if (vi.isFakeTimers()) {
		await vi.advanceTimersByTimeAsync(20);
		const flushed = f.terminal.flush();
		await vi.advanceTimersByTimeAsync(0);
		await flushed;
	} else await f.terminal.waitForRender();
}

const disclosure =
	"Selecting text copies it to your clipboard. Use Shift+drag (Option+drag in iTerm2 and Terminal.app) to select without copying.";
test("first automatic fullscreen copy shows the exact disclosure for five seconds and persists its global flag", async () => {
	const f = await fixture("1", { mode: "fullscreen" });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const started = Date.now();
	await selectTranscript(f);
	expect(f.terminal.getViewport().join("\n"), "first copy shows exact disclosure beside copy feedback").toContain(
		disclosure,
	);
	await f.core.settingsManager.flush();
	const globalPath = join(f.core.tempDir, "settings.json");
	expect(
		JSON.parse(readFileSync(globalPath, "utf8")).vinciCopyDisclosureShown,
		"disclosure flag is persisted globally",
	).toBe(true);
	await vi.advanceTimersByTimeAsync(4_999 - (Date.now() - started));
	const beforeExpiry = f.terminal.flush();
	await vi.advanceTimersByTimeAsync(0);
	await beforeExpiry;
	expect(f.terminal.getViewport().join("\n"), "disclosure remains readable at 4999 ms").toContain(disclosure);
	await vi.advanceTimersByTimeAsync(1);
	f.internals.ui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	const expired = f.terminal.flush();
	await vi.advanceTimersByTimeAsync(0);
	await expired;
	expect(f.terminal.getViewport().join("\n"), "disclosure expires at 5000 ms").not.toContain(disclosure);
	await selectTranscript(f);
	expect(f.terminal.getViewport().join("\n"), "second automatic copy never repeats the disclosure").not.toContain(
		disclosure,
	);
});

test("restart reloads persisted disclosure and never shows it again", async () => {
	const first = await fixture("1", { mode: "fullscreen" });
	await selectTranscript(first);
	await first.core.settingsManager.flush();
	first.mode.stop();
	const restarted = await fixture("1", {
		mode: "fullscreen",
		restartSettings: join(first.core.tempDir, "settings.json"),
	});
	await selectTranscript(restarted);
	expect(
		restarted.terminal.getViewport().join("\n"),
		"fresh session reloads the global flag and never repeats disclosure",
	).not.toContain(disclosure);
});

test("a remote-only first copy neither shows nor spends the disclosure; a later delivered copy shows it", async () => {
	const f = await fixture("1", { mode: "fullscreen" });
	clipboard.routed.mockResolvedValueOnce("remote-only");
	await selectTranscript(f);
	expect(f.terminal.getViewport().join("\n"), "remote-only copy shows no clipboard disclosure").not.toContain(
		disclosure,
	);
	await f.core.settingsManager.flush();
	const globalPath = join(f.core.tempDir, "settings.json");
	const stored = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, "utf8")) : {};
	expect(stored.vinciCopyDisclosureShown, "remote-only copy leaves the install flag unset").not.toBe(true);
	clipboard.routed.mockResolvedValueOnce("native");
	await selectTranscript(f);
	expect(f.terminal.getViewport().join("\n"), "the first delivered copy then shows the disclosure").toContain(
		disclosure,
	);
});

test("Ctrl+X with automatic copying enabled copies the active selection without disclosure", async () => {
	const f = await fixture("1", { mode: "fullscreen" });
	await selectTranscript(f, 0, false);
	f.terminal.sendInput("\x18");
	await f.terminal.waitForRender();
	expect(clipboard.routed, "Ctrl+X copies an active selection before release").toHaveBeenCalledTimes(1);
	expect(f.terminal.getViewport().join("\n"), "Ctrl+X never shows disclosure").not.toContain(disclosure);
});

test.each([
	["1", "regular", undefined, undefined],
	["1", "fullscreen", false, undefined],
	["1", "fullscreen", true, "0"],
	[undefined, "fullscreen", true, undefined],
] as const)(
	"disclosure is suppressed VINCI_CODE=%s mode=%s setting=%s env=%s",
	async (vinci, mode, copyOnSelect, env) => {
		const f = await fixture(vinci, { mode, copyOnSelect, env });
		if (mode === "fullscreen") await selectTranscript(f);
		expect(f.terminal.getViewport().join("\n")).not.toContain(disclosure);
		if (vinci === "1" && mode === "fullscreen") {
			f.terminal.sendInput("\x18");
			await f.terminal.waitForRender();
			expect(
				clipboard.routed,
				"Ctrl+X copies retained selection even with auto-copy disabled",
			).toHaveBeenCalledTimes(1);
			expect(f.terminal.getViewport().join("\n"), "Ctrl+X never shows disclosure").not.toContain(disclosure);
		}
	},
);

test.each(["1", undefined])("triple-click line trimming is wired only for VINCI_CODE=%s", async (vinci) => {
	const f = await fixture(vinci, { mode: "fullscreen" });
	f.internals.chatContainer.clear();
	f.internals.chatContainer.addChild(new Text("Routing proof message   ", 0, 0));
	f.internals.ui.requestRender();
	await f.terminal.waitForRender();
	await selectTranscript(f, 3);
	const actual = clipboard.routed.mock.calls.at(-1)?.[0];
	expect(actual, "triple-click LINE copy trims renderer padding only in Vinci").toBe(
		vinci === "1" ? "Routing proof message" : "Routing proof message".padEnd(160),
	);
});
