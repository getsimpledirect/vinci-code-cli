import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Component, Container, EditorComponent, SettingsList, TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import vinciCopy from "../../../vinci/extensions/vinci-copy.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, createHarnessWithExtensions, fauxModel } from "./test-harness.ts";

type Route = "native" | "terminal" | "remote-only";
const clipboard = vi.hoisted(() => ({
	copy: vi.fn<(text: string) => Promise<void>>(),
	route: vi.fn<(text: string) => Promise<Route>>(),
	native: { setText: vi.fn<(text: string) => Promise<void>>() },
	execSync: vi.fn(),
	spawn: vi.fn(),
	spawnSync: vi.fn(),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
	exec: vi.fn(),
	fork: vi.fn(),
	platform: vi.fn<() => NodeJS.Platform>(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: clipboard.copy,
	copyToClipboardWithRoute: clipboard.route,
}));
vi.mock("../src/utils/clipboard-native.js", () => ({ clipboard: clipboard.native }));
vi.mock("child_process", () => ({
	execSync: clipboard.execSync,
	spawn: clipboard.spawn,
	spawnSync: clipboard.spawnSync,
	execFile: clipboard.execFile,
	execFileSync: clipboard.execFileSync,
	exec: clipboard.exec,
	fork: clipboard.fork,
}));
vi.mock("os", async (importOriginal) => ({
	...(await importOriginal<typeof os>()),
	platform: clipboard.platform,
}));

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	constructor() {
		super(100, 30);
	}
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class Modal implements Component {
	readonly inputs: string[] = [];
	render(): string[] {
		return ["MODAL owns input"];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {}
}

interface Internals {
	ui: TUI;
	headerContainer: Container;
	loadedResourcesContainer: Container;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	editorContainer: Container;
	editor: EditorComponent;
	footer: Component;
	footerDataProvider: { dispose(): void };
	keybindings: KeybindingsManager;
	setupKeyHandlers(): void;
	showSettingsSelector(): void;
	showModelsSelector(): Promise<void>;
	handleReloadCommand(): Promise<void>;
	applyRuntimeSettings(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	createExtensionUIContext(): ExtensionUIContext;
	showStatus(message: string): void;
	showSelector(factory: (done: () => void) => { component: Component; focus: Component }): void;
}

interface FixtureOptions {
	mode?: "regular" | "fullscreen";
	storedMode?: "regular" | "fullscreen";
	setting?: boolean;
	env?: string;
	vinci?: boolean;
	order?: "env-first" | "setting-first";
	tmux?: boolean;
	copyExtension?: boolean;
}

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
	vi.clearAllMocks();
	clipboard.route.mockReset().mockResolvedValue("native");
	clipboard.platform.mockReturnValue("darwin");
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function fixture(options: FixtureOptions = {}) {
	const caseDir = mkdtempSync(join(process.env.TMPDIR ?? dirname(fileURLToPath(import.meta.url)), ".controls-"));
	cleanups.push(() => rmSync(caseDir, { recursive: true, force: true }));
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_")) vi.stubEnv(key, undefined);
	}
	for (const key of ["VINCI_CODE", "VINCI_COPY_ON_SELECT", "TMUX", "ZELLIJ", "STY"]) vi.stubEnv(key, undefined);
	for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
		vi.stubEnv(key, caseDir);
	}
	vi.stubEnv("TERM", "xterm-256color");
	if (options.tmux) vi.stubEnv("TMUX", "controls-test");
	const core = options.copyExtension
		? await createHarnessWithExtensions({ extensionFactories: [(pi) => vinciCopy(pi, clipboard.copy)] })
		: createHarness();
	const settingsPath = join(core.tempDir, "settings.json");
	const settings: Partial<Settings> = {
		theme: "dark",
		quietStartup: true,
		retry: { enabled: false },
		tuiMode: options.storedMode,
		copyOnSelect: options.setting,
	};
	const setEnvironment = () => {
		vi.stubEnv("VINCI_CODE", options.vinci === false ? undefined : "1");
		vi.stubEnv("VINCI_COPY_ON_SELECT", options.env);
	};
	const setSettings = async () => {
		writeFileSync(settingsPath, JSON.stringify(settings));
		await core.settingsManager.reload();
	};
	if (options.order === "setting-first") {
		await setSettings();
		setEnvironment();
	} else {
		setEnvironment();
		await setSettings();
	}
	vi.stubEnv(ENV_AGENT_DIR, core.tempDir);
	const terminal = new RecordingTerminal();
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
			throw new Error("Controls fixture cannot replace its session; inspect the test entry point.");
		},
	);
	const interactiveOptions: InteractiveModeOptions = {
		terminal,
		manageProcessSignals: false,
		tuiMode: options.mode ?? (options.storedMode ? undefined : "fullscreen"),
	};
	const interactive = new InteractiveMode(runtime, interactiveOptions);
	const internals = interactive as unknown as Internals;
	cleanups.push(async () => {
		internals.ui.stop({ preserveScreen: true });
		internals.footerDataProvider.dispose();
		await core.settingsManager.flush();
		core.cleanup();
	});
	for (const child of [
		internals.headerContainer,
		internals.loadedResourcesContainer,
		internals.chatContainer,
		internals.pendingMessagesContainer,
		internals.statusContainer,
		internals.widgetContainerAbove,
		internals.editorContainer,
		internals.widgetContainerBelow,
		internals.footer,
	])
		internals.ui.addChild(child);
	internals.headerContainer.addChild(new Text("HEADER", 0, 0));
	internals.chatContainer.addChild(new Text("selected-text\nsecond-line", 0, 0));
	internals.editor.setText("editor-text");
	internals.setupKeyHandlers();
	internals.ui.setFocus(internals.editor);
	internals.ui.start();
	if (options.copyExtension) await internals.bindCurrentSessionExtensions();
	await terminal.waitForRender();
	return { core, terminal, internals, settingsPath, settings, interactive };
}

async function drag(f: Awaited<ReturnType<typeof fixture>>) {
	const lines = f.terminal.getViewport();
	const row = lines.findIndex((line) => line.includes("selected-text"));
	expect(row, "real transcript text is visible before selecting").toBeGreaterThanOrEqual(0);
	const column = lines[row].indexOf("selected-text");
	f.terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
	f.terminal.sendInput(`\x1b[<32;${column + 13};${row + 1}M`);
	f.terminal.sendInput(`\x1b[<0;${column + 13};${row + 1}m`);
	await f.terminal.waitForRender();
}

function settingsList(f: Awaited<ReturnType<typeof fixture>>): SettingsList {
	f.internals.showSettingsSelector();
	const selector = f.internals.editorContainer.children[0] as SettingsSelectorComponent;
	return selector.getSettingsList();
}

function choose(list: SettingsList, query: string): void {
	list.handleInput(query);
	expect(list.render(100).join("\n"), `fullscreen settings contains ${query}`).not.toContain("No matching settings");
	list.handleInput("\r");
}

const decisive = [
	{ setting: true, env: "0" },
	{ setting: false, env: "1" },
	{ setting: false, env: "" },
	{ setting: false, env: "garbage" },
] as const;

describe("InteractiveMode effective copy policy", () => {
	const sourcePath = fileURLToPath(new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url));
	test.each([
		["startup", "constructor(runtimeHost:", "private getAutocompleteSourceTag"],
		["reload", "private async handleReloadCommand", "private async handleExportCommand"],
		["rebind", "private applyRuntimeSettings", "private async rebindCurrentSession"],
		["callback", "onCopyOnSelectChange:", "onWarningsChange:"],
	])("%s wiring calls the shared policy resolver (source check)", (_site, start, end) => {
		const source = readFileSync(sourcePath, "utf8");
		const offset = source.indexOf(start);
		expect(offset, `${start} exists in the real InteractiveMode wiring`).toBeGreaterThanOrEqual(0);
		expect(source.slice(offset, source.indexOf(end, offset)), "call site uses resolveCopyOnSelect").toContain(
			"resolveCopyOnSelect(",
		);
	});
	for (const order of ["env-first", "setting-first"] as const) {
		for (const vinci of [true, false]) {
			for (const cell of decisive) {
				const enabled = cell.setting && (!vinci || cell.env !== "0");
				test(`startup ${order} VINCI_CODE=${vinci ? "1" : "unset"} setting=${cell.setting} env=${JSON.stringify(cell.env)}`, async () => {
					const f = await fixture({ ...cell, order, vinci });
					await drag(f);
					expect(
						clipboard.route.mock.calls.map(([text]) => text),
						"startup uses the effective copy policy",
					).toEqual(enabled ? ["selected-text"] : []);
					expect(
						(f.internals.ui as TuiAltScreen).hasActiveSelection?.() ?? false,
						"nonempty selection stays active even with automatic copy disabled",
					).toBe(true);
				});
				test(`reload ${order} VINCI_CODE=${vinci ? "1" : "unset"} setting=${cell.setting} env=${JSON.stringify(cell.env)}`, async () => {
					const f = await fixture({ setting: true, env: cell.env, order, vinci });
					writeFileSync(f.settingsPath, JSON.stringify({ ...f.settings, copyOnSelect: cell.setting }));
					await f.internals.handleReloadCommand();
					f.internals.chatContainer.clear();
					f.internals.chatContainer.addChild(new Text("selected-text\nsecond-line", 0, 0));
					f.internals.ui.requestRender();
					await f.terminal.waitForRender();
					await drag(f);
					expect(
						clipboard.route.mock.calls.map(([text]) => text),
						"reload refreshes effective copy policy from the setting",
					).toEqual(enabled ? ["selected-text"] : []);
				});
				test(`callback ${order} VINCI_CODE=${vinci ? "1" : "unset"} setting=${cell.setting} env=${JSON.stringify(cell.env)}`, async () => {
					const f = await fixture({ setting: !cell.setting, env: cell.env, order, vinci });
					const list = settingsList(f);
					// Exercise the actual InteractiveMode callback independently of the read-only row UI.
					(list as unknown as { onChange(id: string, value: string): void }).onChange(
						"copy-on-select",
						String(cell.setting),
					);
					list.handleInput("\x1b");
					await f.terminal.waitForRender();
					await drag(f);
					expect(
						clipboard.route.mock.calls.map(([text]) => text),
						"settings callback combines setting with captured environment policy",
					).toEqual(enabled ? ["selected-text"] : []);
				});
			}
		}
	}

	test.each([true, false])(
		"regular mode VINCI_CODE=%s has no fullscreen rows, selection, copies or mouse enable",
		async (vinci) => {
			const f = await fixture({ mode: "regular", setting: true, env: "1", vinci });
			await drag(f);
			expect(f.internals.ui.mode, "regular renderer has no active fullscreen selection").toBe("regular");
			expect(f.internals.ui).not.toHaveProperty("hasActiveSelection");
			const list = settingsList(f);
			list.handleInput("copyonselect");
			expect(list.render(100).join("\n")).toContain("No matching settings");
			list.handleInput("\x1b");
			const modes = settingsList(f);
			modes.handleInput("tuimode");
			expect(modes.render(100).join("\n")).toContain("No matching settings");
			expect(clipboard.route).not.toHaveBeenCalled();
			for (const sequence of ["\x1b[?1049h", "\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h"])
				expect(f.terminal.writes.join("")).not.toContain(sequence);
		},
	);

	test("true setting is a positive control and TMUX uses button-motion tracking", async () => {
		const f = await fixture({ setting: true, tmux: true });
		await drag(f);
		expect(clipboard.route.mock.calls.map(([text]) => text)).toEqual(["selected-text"]);
		expect(f.terminal.writes.join("")).toContain("\x1b[?1002h");
		expect(f.terminal.writes.join("")).not.toContain("\x1b[?1003h");
	});

	test("startup-captured env policy survives later process environment changes and rebind", async () => {
		const f = await fixture({ setting: true, env: "0" });
		vi.stubEnv("VINCI_COPY_ON_SELECT", "1");
		f.internals.applyRuntimeSettings();
		await drag(f);
		expect(clipboard.route, "rebind reuses the startup-captured exact-zero override").not.toHaveBeenCalled();
	});

	test("rebind refreshes a persisted false setting after a positive drag", async () => {
		const f = await fixture({ setting: true });
		await drag(f);
		expect(clipboard.route).toHaveBeenCalledExactlyOnceWith("selected-text");
		clipboard.route.mockClear();
		writeFileSync(f.settingsPath, JSON.stringify({ ...f.settings, copyOnSelect: false }));
		await f.core.settingsManager.reload();
		f.internals.applyRuntimeSettings();
		await drag(f);
		expect(clipboard.route, "rebind preserves persisted false after a settings reload").not.toHaveBeenCalled();
	});
});

describe("fullscreen settings controls", () => {
	test.each([true, false])("mode changes persist for restart, VINCI_CODE=%s", async (vinci) => {
		const f = await fixture({ setting: true, vinci });
		const runningUi = f.internals.ui;
		const notice = vi.spyOn(f.internals, "showStatus");
		const list = settingsList(f);
		choose(list, "tuimode");
		expect(f.internals.ui, "mode settings retain the running renderer").toBe(runningUi);
		expect(f.internals.ui.mode, "mode settings leave the current fullscreen mode active").toBe("fullscreen");
		await f.core.settingsManager.flush();
		expect(
			JSON.parse(readFileSync(f.settingsPath, "utf8")).tuiMode,
			"mode row persists regular for the next startup",
		).toBe("regular");
		list.handleInput("\x1b");
		await f.terminal.waitForRender();
		const text = f.terminal.getViewport().join("\n");
		if (vinci) {
			expect(notice).toHaveBeenCalledExactlyOnceWith("Takes effect next time you start Vinci");
			expect(text).toContain("Takes effect next time you start Vinci");
		} else {
			expect(notice).not.toHaveBeenCalled();
			expect(text).not.toContain("Vinci");
		}
		await drag(f);
		expect(clipboard.route, "changing tuiMode never switches the running fullscreen instance").toHaveBeenCalledTimes(
			1,
		);
	});

	test.each([true, false])("env zero row is read-only only in Vinci, VINCI_CODE=%s", async (vinci) => {
		const f = await fixture({ setting: true, env: "0", vinci });
		const before = readFileSync(f.settingsPath, "utf8");
		const changeSetting = vi.spyOn(f.core.settingsManager, "setCopyOnSelect");
		const list = settingsList(f);
		list.handleInput("copyonselect");
		const text = list.render(100).join("\n");
		if (vinci)
			expect(text, "read-only value shows the exact startup override").toContain("Off (VINCI_COPY_ON_SELECT=0)");
		else expect(text).not.toContain("VINCI_COPY_ON_SELECT");
		list.handleInput("\r");
		await f.core.settingsManager.flush();
		if (vinci)
			expect(readFileSync(f.settingsPath, "utf8"), "selecting read-only env row changes no setting").toBe(before);
		else expect(JSON.parse(readFileSync(f.settingsPath, "utf8")).copyOnSelect).toBe(false);
		if (vinci) expect(changeSetting, "read-only row never invokes the settings callback").not.toHaveBeenCalled();
		else expect(changeSetting).toHaveBeenCalledExactlyOnceWith(false);
		list.handleInput("\x1b");
		await f.terminal.waitForRender();
		expect(f.terminal.getViewport().join("\n")).not.toContain("Error:");
		await drag(f);
		expect(clipboard.route).not.toHaveBeenCalled();
	});

	test("editable copy row changes the effective setting immediately", async () => {
		const f = await fixture({ setting: true });
		const list = settingsList(f);
		choose(list, "copyonselect");
		list.handleInput("\x1b");
		await f.terminal.waitForRender();
		await drag(f);
		expect(clipboard.route, "turning automatic copy off applies before another drag").not.toHaveBeenCalled();
		await f.core.settingsManager.flush();
		expect(JSON.parse(readFileSync(f.settingsPath, "utf8")).copyOnSelect).toBe(false);
	});
});

describe("fullscreen configurable app.message.copy action", () => {
	test.each([
		{ setting: false, env: undefined, route: "native", flash: "Copied" },
		{ setting: true, env: "0", route: "terminal", flash: "Sent to terminal clipboard" },
		{ setting: true, env: undefined, route: "native", flash: "Copied" },
	] as const)("selection copies once through the route writer: %j", async (cell) => {
		const f = await fixture(cell);
		clipboard.route.mockResolvedValue(cell.route);
		await drag(f);
		const autoCalls = cell.setting && cell.env !== "0" ? 1 : 0;
		expect(clipboard.route).toHaveBeenCalledTimes(autoCalls);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(
			clipboard.route.mock.calls.map(([text]) => text),
			"configured Ctrl+X copies only the active selection once",
		).toEqual(Array(autoCalls + 1).fill("selected-text"));
		expect(f.terminal.getViewport()[0]).toContain(cell.flash);
		expect(clipboard.copy, "manual selection copy never falls back to last-message copy").not.toHaveBeenCalled();
	});

	test.each(["remote-only", "throw"] as const)("failed manual selection copy stays a failure: %s", async (failure) => {
		const f = await fixture({ setting: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("different last message");
		await drag(f);
		clipboard.route.mockClear();
		if (failure === "throw") clipboard.route.mockRejectedValue(new Error("recorded failure"));
		else clipboard.route.mockResolvedValue(failure);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(
			clipboard.route.mock.calls.map(([text]) => text),
			"failed copy attempts exactly the selected text once",
		).toEqual(["selected-text"]);
		expect(clipboard.copy, "failure never falls through to another copy route").not.toHaveBeenCalled();
		expect(f.terminal.getViewport()[0]).toContain("Couldn't copy to clipboard");
	});

	test.each([true, false])("nothing selected does nothing with automatic copy %s", async (setting) => {
		const f = await fixture({ setting });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("must not copy last message");
		const before = f.terminal.getViewport();
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
		expect(f.terminal.getViewport(), "empty selection produces no flash or model clear").toEqual(before);
	});

	test("a user key override moves selection copy away from Ctrl+X", async () => {
		const f = await fixture({ setting: false });
		f.internals.keybindings.setUserBindings({ "app.message.copy": "ctrl+y" });
		await drag(f);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route, "old Ctrl+X cannot copy after a user override").not.toHaveBeenCalled();
		expect(clipboard.copy, "old Ctrl+X cannot copy a last message after a user override").not.toHaveBeenCalled();
		f.terminal.sendInput("\x19");
		await f.terminal.waitForRender();
		expect(clipboard.route.mock.calls.map(([text]) => text)).toEqual(["selected-text"]);
	});

	test.each([true, false])("Ctrl+X guards text-building failures, VINCI_CODE=%s", async (vinci) => {
		const f = await fixture({ setting: false, vinci });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("must not copy after text-building failure");
		await drag(f);
		clipboard.route.mockClear();
		const ui = f.internals.ui as TuiAltScreen;
		const throwText = () => {
			throw new Error("recorded selected-text construction failure");
		};
		vi.spyOn(
			ui as unknown as { getActiveSelectionText(): string | undefined },
			"getActiveSelectionText",
		).mockImplementation(throwText);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(
			f.terminal.getViewport()[0],
			"text-building failure produces visible failure feedback without rejecting",
		).toContain("Couldn't copy to clipboard");
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
		f.terminal.sendInput("z");
		expect(f.internals.editor.getText(), "input remains live after the copy exception").toBe("editor-textz");
	});

	test.each([true, false])("ungated upstream fallback remains available with auto-copy %s", async (setting) => {
		const f = await fixture({ setting, vinci: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("upstream last assistant");
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(
			clipboard.route.mock.calls.map(([text]) => text),
			"VINCI_CODE-unset preserves upstream last-message fallback",
		).toEqual(["upstream last assistant"]);
		expect(f.terminal.getViewport()[0]).toContain("Copied");
	});

	test("ungated upstream reports its existing error when no last message exists", async () => {
		const f = await fixture({ setting: false, vinci: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue(undefined);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(f.terminal.getViewport().join("\n")).toContain("No agent messages to copy yet.");
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
	});

	test("ungated upstream prefers an active selection when automatic copy is disabled", async () => {
		const f = await fixture({ setting: false, vinci: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("upstream last assistant");
		await drag(f);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route.mock.calls.map(([text]) => text)).toEqual(["selected-text"]);
	});

	test("ungated upstream retains last-message behavior with an active auto-copy selection", async () => {
		const f = await fixture({ setting: true, vinci: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("upstream last assistant");
		await drag(f);
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route.mock.calls.map(([text]) => text)).toEqual(["selected-text", "upstream last assistant"]);
	});

	test("the real models selector retains app.models.clearAll and disables mouse selection", async () => {
		const f = await fixture({ setting: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue(
			"last message must not leak through model input",
		);
		vi.spyOn(f.core.modelRegistry, "getAvailable").mockReturnValue([fauxModel]);
		await f.internals.showModelsSelector();
		const selector = f.internals.editorContainer.children[0];
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route, "model selector Ctrl+X never copies through the route writer").not.toHaveBeenCalled();
		expect(clipboard.copy, "model selector Ctrl+X never copies the last message").not.toHaveBeenCalled();
		expect(selector.render(100).join("\n"), "models selector Ctrl+X clears all enabled models").toContain(
			"0/1 enabled",
		);
		await drag(f);
		expect(
			(f.internals.ui as TuiAltScreen).hasActiveSelection(),
			"model selector disables transcript mouse selection",
		).toBe(false);
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
	});

	test.each(["crew", "permission", "editor"] as const)("%s modal owns Ctrl+X with no clipboard call", async (kind) => {
		const f = await fixture({ setting: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue(
			"last message must not leak through modal input",
		);
		await drag(f);
		clipboard.route.mockClear();
		const panel = new Modal();
		let close = () => {};
		let closed: Promise<unknown> | undefined;
		if (kind === "editor")
			f.internals.showSelector((done) => {
				close = done;
				return { component: panel, focus: panel };
			});
		else if (kind === "permission") {
			closed = f.internals.createExtensionUIContext().confirm("Permission", "Allow this operation?");
			const permission = f.internals.editorContainer.children[0];
			vi.spyOn(permission, "handleInput").mockImplementation((data) => panel.handleInput(data));
			close = () => f.internals.createExtensionUIContext().setEditorText("");
		} else {
			closed = f.internals.createExtensionUIContext().custom<undefined>(
				(_ui, _theme, _keys, done) => {
					close = () => done(undefined);
					return panel;
				},
				{ overlay: kind === "crew" },
			);
		}
		await f.terminal.waitForRender();
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route, "modal Ctrl+X never copies through the route writer").not.toHaveBeenCalled();
		expect(clipboard.copy, "modal Ctrl+X never copies the last message").not.toHaveBeenCalled();
		expect(panel.inputs).toEqual(["\x18"]);
		await drag(f);
		expect(
			(f.internals.ui as TuiAltScreen).hasActiveSelection(),
			"open modal disables transcript mouse selection",
		).toBe(false);
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
		if (kind === "permission") {
			vi.restoreAllMocks();
			f.terminal.sendInput("\x1b");
		} else close();
		await closed;
	});

	test("regular mode retains its base Ctrl+X behavior and performs no copy", async () => {
		const f = await fixture({ mode: "regular", setting: false });
		vi.spyOn(f.core.session, "getLastAssistantText").mockReturnValue("not a selection");
		f.terminal.sendInput("\x18");
		await f.terminal.waitForRender();
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
		expect(f.internals.editor.getText()).toBe("editor-text");
	});

	test("Alt+C still opens the real Vinci /copy picker", async () => {
		const f = await fixture({ setting: false, copyExtension: true });
		await f.core.session.prompt("produce a message");
		f.terminal.sendInput("\x1bc");
		await f.terminal.waitForRender();
		expect(f.internals.editorContainer.render(100).join("\n")).toContain("Copy to clipboard");
		expect(clipboard.route).not.toHaveBeenCalled();
		expect(clipboard.copy).not.toHaveBeenCalled();
		f.terminal.sendInput("\x1b");
		await f.terminal.waitForRender();
	});
});
