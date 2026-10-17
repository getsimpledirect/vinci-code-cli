import { mkdtempSync, rmSync } from "node:fs";
import type * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Component, Container, EditorComponent, TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StdinBuffer } from "../../tui/src/stdin-buffer.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "./test-harness.ts";

type ClipboardRoute = "native" | "terminal" | "remote-only";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	copyToClipboardWithRoute: vi.fn<(text: string) => Promise<ClipboardRoute>>(),
	clipboard: { setText: vi.fn<(text: string) => Promise<void>>() },
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
	copyToClipboard: clipboardMocks.copyToClipboard,
	copyToClipboardWithRoute: clipboardMocks.copyToClipboardWithRoute,
}));

// Keep native and shell boundaries mocked even when exercising the constructor's default writer.
vi.mock("../src/utils/clipboard-native.js", () => ({ clipboard: clipboardMocks.clipboard }));
vi.mock("child_process", () => ({
	execSync: clipboardMocks.execSync,
	spawn: clipboardMocks.spawn,
	spawnSync: clipboardMocks.spawnSync,
	execFile: clipboardMocks.execFile,
	execFileSync: clipboardMocks.execFileSync,
	exec: clipboardMocks.exec,
	fork: clipboardMocks.fork,
}));
vi.mock("os", async (importOriginal) => ({
	...(await importOriginal<typeof os>()),
	platform: clipboardMocks.platform,
}));

class BufferedTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	private readonly stdin = new StdinBuffer();

	constructor() {
		super(48, 16);
		this.stdin.on("data", (data) => super.sendInput(data));
	}

	override sendInput(data: string): void {
		// Exercise incomplete SGR packets through the production sequence assembler.
		this.stdin.process(data.slice(0, 3));
		this.stdin.process(data.slice(3));
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stdin.clear();
		super.stop();
	}
}

class InputPanel implements Component {
	focused = false;
	readonly inputs: string[] = [];
	readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	render(): string[] {
		return [this.label];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

interface ModeInternals {
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
	createExtensionUIContext(): ExtensionUIContext;
	setExtensionFooter(factory: (() => Component) | undefined): void;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
	vi.clearAllMocks();
	clipboardMocks.copyToClipboardWithRoute.mockReset();
	clipboardMocks.platform.mockReturnValue("darwin");
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.unstubAllEnvs();
});

async function fixture(mode: "fullscreen" | "regular" = "fullscreen", useDefaultClipboard = false) {
	const caseDir = mkdtempSync(
		join(process.env.TMPDIR ?? dirname(fileURLToPath(import.meta.url)), ".fullscreen-selection-"),
	);
	cleanups.push(() => rmSync(caseDir, { recursive: true, force: true }));
	vi.stubEnv("TMPDIR", caseDir);
	const core = createHarness({
		settings: { theme: "dark", quietStartup: true, retry: { enabled: false } },
	});
	// Constructor keybinding migrations and footer discovery must stay in this case directory.
	vi.stubEnv(ENV_AGENT_DIR, core.tempDir);
	const terminal = new BufferedTerminal();
	const writer = vi.fn(async (_text: string): Promise<"native"> => "native");
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
			throw new Error("Selection fixture must not replace its session; inspect the test entry point.");
		},
	);
	const options: InteractiveModeOptions = { terminal, manageProcessSignals: false, tuiMode: mode };
	if (!useDefaultClipboard) options.copySelection = writer;
	const interactive = new InteractiveMode(runtime, options);
	const internals = interactive as unknown as ModeInternals;
	const ui = internals.ui;
	cleanups.push(() => {
		ui.stop({ preserveScreen: true });
		internals.footerDataProvider.dispose();
		core.cleanup();
	});

	// Mount the real constructor's containers in the production init order, without tool bootstrap,
	// process handlers, providers, watchers or a real InteractiveMode child.
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
	]) {
		ui.addChild(child);
	}
	internals.headerContainer.addChild(new Text("HEADER excluded", 0, 0));
	internals.chatContainer.addChild(new Text("alpha\nbeta\ngamma", 0, 0));
	internals.editor.setText("editor-own-input");
	const extensionUI = internals.createExtensionUIContext();
	extensionUI.setWidget("above", ["WIDGET excluded"]);
	extensionUI.setWidget("below", ["ROSTER excluded"], { placement: "belowEditor" });
	internals.setExtensionFooter(() => new Text("FOOTER excluded", 0, 0));
	ui.setFocus(internals.editor);
	ui.start();
	await terminal.waitForRender();
	return { terminal, writer, internals, ui, extensionUI };
}

async function drag(
	terminal: BufferedTerminal,
	label: string,
	startColumn = 0,
	endColumn = label.length - 1,
): Promise<void> {
	const lines = terminal.getViewport();
	const row = lines.findIndex((line) => line.includes(label));
	expect(row, `rendered line containing ${JSON.stringify(label)} is visible`).toBeGreaterThanOrEqual(0);
	const left = lines[row].indexOf(label);
	terminal.sendInput(`\x1b[<0;${left + startColumn + 1};${row + 1}M`);
	terminal.sendInput(`\x1b[<32;${left + endColumn + 1};${row + 1}M`);
	terminal.sendInput(`\x1b[<0;${left + endColumn + 1};${row + 1}m`);
	await terminal.waitForRender();
}

describe("InteractiveMode fullscreen selectable regions", () => {
	test.each([
		["native", "Copied"],
		["terminal", "Sent to terminal clipboard"],
		["remote-only", "Couldn't copy to clipboard"],
		["throw", "Couldn't copy to clipboard"],
	] as const)("default clipboard writer maps %s to its visible route feedback", async (route, message) => {
		let resolve: (route: ClipboardRoute) => void = () => {};
		let reject: (error: Error) => void = () => {};
		clipboardMocks.copyToClipboardWithRoute.mockImplementation(
			() =>
				new Promise<ClipboardRoute>((onResolve, onReject) => {
					resolve = onResolve;
					reject = onReject;
				}),
		);
		const { terminal, writer } = await fixture("fullscreen", true);
		const processMocks = [
			clipboardMocks.execSync,
			clipboardMocks.spawn,
			clipboardMocks.spawnSync,
			clipboardMocks.execFile,
			clipboardMocks.execFileSync,
			clipboardMocks.exec,
			clipboardMocks.fork,
		];
		// Constructor capability probes are also faked; count only the selection's helper calls.
		for (const processMock of processMocks) processMock.mockClear();
		const lines = terminal.getViewport();
		const row = lines.findIndex((line) => line.includes("alpha"));
		expect(row, "rendered transcript text is visible").toBeGreaterThanOrEqual(0);
		const column = lines[row].indexOf("alpha");
		terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
		terminal.sendInput(`\x1b[<32;${column + 5};${row + 1}M`);
		expect(
			clipboardMocks.copyToClipboardWithRoute,
			"press and motion must not call the default writer",
		).not.toHaveBeenCalled();
		terminal.sendInput(`\x1b[<0;${column + 5};${row + 1}m`);
		await terminal.waitForRender();
		expect(
			clipboardMocks.copyToClipboardWithRoute,
			"nonempty release must call the default clipboard route writer exactly once",
		).toHaveBeenCalledTimes(1);
		expect(clipboardMocks.copyToClipboardWithRoute).toHaveBeenCalledWith("alpha");
		expect(writer, "this constructor received no injected writer option").not.toHaveBeenCalled();
		for (const feedback of ["Copied", "Sent to terminal clipboard", "Couldn't copy to clipboard"]) {
			expect(terminal.getViewport()[0], "route feedback waits for the default writer to settle").not.toContain(
				feedback,
			);
		}
		if (route === "throw") reject(new Error("recording clipboard failure"));
		else resolve(route);
		await terminal.waitForRender();
		const flash = ` ${message} `;
		expect(
			terminal.getViewport()[0].padEnd(terminal.columns).slice(-flash.length),
			"default route feedback occupies the actual top-right xterm cells",
		).toBe(flash);
		terminal.sendInput(`\x1b[<0;${column + 5};${row + 1}m`);
		await terminal.waitForRender();
		expect(
			clipboardMocks.copyToClipboardWithRoute,
			"repeated release cannot call the default writer again",
		).toHaveBeenCalledTimes(1);
		expect(clipboardMocks.copyToClipboard).not.toHaveBeenCalled();
		expect(clipboardMocks.clipboard.setText).not.toHaveBeenCalled();
		for (const processMock of processMocks) {
			expect(processMock, "default route tests cannot reach a real clipboard helper").not.toHaveBeenCalled();
		}
		expect(terminal.writes.join(""), "recording route writer never emits OSC 52").not.toContain("\x1b]52;");
	});

	test.each(["HEADER excluded", "WIDGET excluded", "ROSTER excluded", "FOOTER excluded"])(
		"excludes %s while the editor remains selectable",
		async (excluded) => {
			const { terminal, writer } = await fixture();
			await drag(terminal, "editor-own-input");
			expect(
				writer.mock.calls.map(([text]) => text),
				"editor selection copies rendered user input once",
			).toEqual(["editor-own-input"]);
			writer.mockClear();
			await drag(terminal, excluded);
			expect(writer, "header, widgets and footer never reach the clipboard writer").not.toHaveBeenCalled();
		},
	);

	test("copies the rendered mask through the host writer with an empty custom footer", async () => {
		const { terminal, writer, internals } = await fixture();
		internals.setExtensionFooter(() => new Text("", 0, 0));
		internals.chatContainer.clear();
		internals.chatContainer.addChild(new Text("token=[REDACTED]", 0, 0));
		internals.ui.requestRender();
		await terminal.waitForRender();
		await drag(terminal, "token=[REDACTED]");
		expect(
			writer.mock.calls.map(([text]) => text),
			"selection copies displayed masking, not hidden data",
		).toEqual(["token=[REDACTED]"]);
		expect(terminal.writes.join(""), "injected host writer prevents a second OSC 52 writer").not.toContain(
			"\x1b]52;",
		);
		expect(terminal.getViewport()[0], "feedback is visible despite the empty custom footer").toContain("Copied");
	});

	test("editor-replacing selectors own viewport keys and wheel, and disable selection everywhere", async () => {
		const { terminal, writer, internals, ui } = await fixture();
		const panel = new InputPanel("MODEL SELECTOR excluded");
		let close = () => {};
		internals.showSelector((done) => {
			close = done;
			return { component: panel, focus: panel };
		});
		await terminal.waitForRender();
		const beforeTop = (ui as TuiAltScreen).viewportTop;
		const keys = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF", "\x1b[<64;2;3M"];
		for (const key of keys) terminal.sendInput(key);
		await terminal.waitForRender();
		expect(panel.inputs, "editor modal receives all viewport navigation and wheel input").toEqual(keys);
		expect((ui as TuiAltScreen).viewportTop, "modal input never moves the transcript").toBe(beforeTop);
		await drag(terminal, "alpha");
		await drag(terminal, "MODEL SELECTOR excluded");
		expect(writer, "no text is copied while an editor modal is open").not.toHaveBeenCalled();
		close();
		ui.requestRender();
		await terminal.waitForRender();
		await drag(terminal, "editor-own-input");
		expect(
			writer.mock.calls.map(([text]) => text),
			"closing modal restores editor selection",
		).toEqual(["editor-own-input"]);
	});

	test.each([false, true])("ctx.ui.custom overlay=%s disables transcript and modal selection", async (overlay) => {
		const { terminal, writer, extensionUI } = await fixture();
		const panel = new InputPanel(overlay ? "CREW OVERLAY excluded" : "CUSTOM MODAL excluded");
		const transcriptRow = terminal.getViewport().findIndex((line) => line.includes("alpha"));
		terminal.sendInput(`\x1b[<0;1;${transcriptRow + 1}M`);
		let close: (result: undefined) => void = () => {};
		const closed = extensionUI.custom<undefined>(
			(_tui, _theme, _keybindings, done) => {
				close = done;
				return panel;
			},
			{ overlay, overlayOptions: { width: 30, row: 3 } },
		);
		await terminal.waitForRender();
		await drag(terminal, panel.label);
		if (!overlay) await drag(terminal, "alpha");
		expect(writer, "custom modal and crew overlay never copy any selection").not.toHaveBeenCalled();
		close(undefined);
		await closed;
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;5;${transcriptRow + 1}m`);
		await terminal.waitForRender();
		expect(writer, "closing modal cancels the prior press and cannot revive its release").not.toHaveBeenCalled();
		await drag(terminal, "editor-own-input");
		expect(
			writer.mock.calls.map(([text]) => text),
			"closing custom modal restores editor selection",
		).toEqual(["editor-own-input"]);
	});

	test("an asynchronous custom modal disables selection until it closes", async () => {
		const { terminal, writer, extensionUI } = await fixture();
		let mount: (component: Component) => void = () => {};
		let close: (result: undefined) => void = () => {};
		const component = new Promise<Component>((resolve) => {
			mount = resolve;
		});
		const closed = extensionUI.custom<undefined>((_tui, _theme, _keys, done) => {
			close = done;
			return component;
		});
		await terminal.waitForRender();
		await drag(terminal, "alpha");
		expect(writer, "pending custom modal cannot copy the underlying transcript").not.toHaveBeenCalled();
		mount(new InputPanel("ASYNC MODAL excluded"));
		await terminal.waitForRender();
		await drag(terminal, "ASYNC MODAL excluded");
		expect(writer, "mounted custom modal cannot copy any text").not.toHaveBeenCalled();
		close(undefined);
		await closed;
		await terminal.waitForRender();
		await drag(terminal, "editor-own-input");
		expect(
			writer.mock.calls.map(([text]) => text),
			"closing asynchronous modal restores editor selection",
		).toEqual(["editor-own-input"]);
	});

	test("regular mode ignores all selection and clipboard routes", async () => {
		const { terminal, writer } = await fixture("regular");
		await drag(terminal, "alpha");
		await drag(terminal, "editor-own-input");
		expect(writer).not.toHaveBeenCalled();
		for (const bytes of ["\x1b]52;", "\x1b[?1049h", "\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h"]) {
			expect(terminal.writes.join("")).not.toContain(bytes);
		}
	});
});
