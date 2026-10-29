import {
	type Component,
	type Container,
	type EditorComponent,
	setKeybindings,
	TUI,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent, loginLinkHint } from "../src/modes/interactive/components/login-dialog.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./test-harness.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
const cleanups: Array<() => void> = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.stubEnv("VINCI_CODE", "1");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.unstubAllEnvs();
});

describe("George's synthetic owner-QA UX regressions", () => {
	test.each([
		["url", "darwin"],
		["device", "darwin"],
		["url", "linux"],
		["device", "linux"],
	] as const)("Ghostty fullscreen %s sign-in on %s shows the platform gesture", (flow, platform) => {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
		vi.stubEnv("TERM_PROGRAM", "ghostty");
		const tui = new TuiAltScreen(new VirtualTerminal(120, 24));
		const dialog = new LoginDialogComponent(tui, "vinci", () => {});
		if (flow === "url") dialog.showAuth("https://signin.invalid/synthetic");
		else dialog.showDeviceCode({ verificationUri: "https://signin.invalid", userCode: "SYNTHETIC" });
		const screen = stripAnsi(dialog.render(120).join("\n"));
		if (platform === "darwin") {
			expect(screen).toContain("Shift+Cmd+click to open");
			expect(screen).toContain("hold Shift to select/copy the link");
		} else {
			expect(screen).toContain("Ctrl+click to open");
			expect(screen).not.toContain("Cmd+click");
		}
		expect(loginLinkHint("regular", "ghostty", "darwin")).toBe("Cmd+click to open");
		expect(loginLinkHint("fullscreen", "iTerm.app", "darwin")).toBe("Cmd+click to open");
		expect(loginLinkHint("fullscreen", "ghostty", "linux")).toBe("Ctrl+click to open");
	});

	test.each(
		(["regular", "fullscreen"] as const).flatMap((mode) =>
			(["url", "device"] as const).flatMap((flow) =>
				[
					"file:///synthetic/QA%20page.html",
					"file:///synthetic/QA page.html?q=one&next=%2Ftwo",
					"https://signin.invalid/synthetic?q=one%20two&next=%2Fdone#code",
				].map((url) => ({
					mode,
					flow,
					url,
				})),
			),
		),
	)("$mode $flow retains exact OSC 8 targets for $url through wrapping", ({ mode, flow, url }) => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
		const dialog = new LoginDialogComponent(
			tui,
			"vinci",
			() => {},
			undefined,
			undefined,
			undefined,
			url.startsWith("file:"),
		);
		if (flow === "url") dialog.showAuth(url);
		else dialog.showDeviceCode({ verificationUri: url, userCode: "SYNTHETIC" });
		for (const width of [24, 80, 120]) {
			const output = dialog.render(width).join("\n");
			const targets = [...output.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)].map((match) => match[1]).filter(Boolean);
			expect(targets.length).toBeGreaterThanOrEqual(2);
			expect(targets.every((target) => target === url)).toBe(true);
		}
	});

	test.each(
		(["regular", "fullscreen"] as const).flatMap((mode) =>
			(["url", "device"] as const).map((flow) => ({ mode, flow })),
		),
	)(
		"$mode $flow offers an inertly tested keyboard opener without changing manual input or cancel",
		async ({ mode, flow }) => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
			const opener = vi.fn();
			const complete = vi.fn();
			const url = "https://signin.invalid/space%20here?first=one&next=%2Ftwo#end";
			const dialog = new LoginDialogComponent(tui, "vinci", complete, undefined, undefined, opener);
			dialog.focused = true;
			if (flow === "url") dialog.showAuth(url);
			else dialog.showDeviceCode({ verificationUri: url, userCode: "SYNTHETIC" });
			expect(opener).toHaveBeenCalledTimes(flow === "url" ? 1 : 0);
			opener.mockClear();
			expect(stripAnsi(dialog.render(80).join("\n"))).toContain("enter open link in your browser");
			dialog.handleInput("\r");
			expect(opener).toHaveBeenCalledExactlyOnceWith(url);
			expect(dialog.focused).toBe(true);
			opener.mockClear();
			const input = dialog.showManualInput("Paste the synthetic callback code");
			expect(stripAnsi(dialog.render(80).join("\n"))).not.toContain("enter open link");
			dialog.handleInput("synthetic-code");
			dialog.handleInput("\r");
			await expect(input).resolves.toBe("synthetic-code");
			dialog.handleInput("\r");
			expect(opener).not.toHaveBeenCalled();
			const cancelled = dialog.showPrompt("Synthetic prompt");
			dialog.handleInput("\x1b");
			await expect(cancelled).rejects.toThrow("Login cancelled");
			expect(complete).toHaveBeenCalledExactlyOnceWith(false, "Login cancelled");
			dialog.handleInput("\r");
			expect(opener).not.toHaveBeenCalled();
		},
	);

	test("a synchronous opener failure is visible and keeps the URL and focus available", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const opener = vi.fn(() => {
			throw new Error("Synthetic unavailable application opener");
		});
		const dialog = new LoginDialogComponent(tui, "vinci", () => {}, undefined, undefined, opener, true);
		dialog.focused = true;
		const url = "file:///synthetic/link%20with%20space.html";
		dialog.showDeviceCode({ verificationUri: url, userCode: "SYNTHETIC" });
		dialog.handleInput("\r");
		expect(opener).toHaveBeenCalledExactlyOnceWith(url);
		expect(stripAnsi(dialog.render(120).join("\n"))).toContain("Could not open the link.");
		expect(dialog.render(120).join("\n")).toContain(`\x1b]8;;${url}\x07`);
		expect(dialog.focused).toBe(true);
	});

	test("the sign-in open action follows configured confirmation keys and leaves info-only views inert", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": ["ctrl+x"] }));
		const opener = vi.fn();
		const dialog = new LoginDialogComponent(
			new TUI(new VirtualTerminal(80, 24)),
			"vinci",
			() => {},
			undefined,
			undefined,
			opener,
		);
		dialog.showDeviceCode({ verificationUri: "https://signin.invalid/synthetic", userCode: "SYNTHETIC" });
		expect(stripAnsi(dialog.render(120).join("\n"))).toContain("ctrl+x open link");
		dialog.handleInput("\r");
		expect(opener).not.toHaveBeenCalled();
		dialog.handleInput("\x18");
		expect(opener).toHaveBeenCalledExactlyOnceWith("https://signin.invalid/synthetic");
		opener.mockClear();
		dialog.showInfo(["Synthetic informational view"]);
		dialog.handleInput("\x18");
		expect(opener).not.toHaveBeenCalled();
	});

	test.each([false, true])("signed-out model picker explains /login with /other=%s", async (showOtherProviders) => {
		const core = createHarness({ settings: { showOtherProviders } });
		cleanups.push(core.cleanup);
		const selector = new ModelSelectorComponent(
			new TUI(new VirtualTerminal(100, 24)),
			undefined,
			core.settingsManager,
			core.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			async () => {
				throw new Error("Synthetic catalogue unavailable");
			},
		);
		await new Promise((resolve) => setImmediate(resolve));
		const screen = stripAnsi(selector.render(100).join("\n"));
		expect(screen).toContain("Sign in with /login to see your Vinci models.");
		expect(screen).not.toContain("unavailable offline");
		expect(screen).not.toContain("No matching models");
	});

	test("/other's connect menu retains a direct Vinci account route and provider alternatives", () => {
		const methods = InteractiveMode.prototype as unknown as { showLoginAuthTypeSelector(): void };
		let component: Component | undefined;
		const done = vi.fn();
		const context = {
			showSelector(factory: (done: () => void) => { component: Component }) {
				component = factory(done).component;
			},
			showLoginDialog: vi.fn(async () => {}),
			showLoginProviderSelector: vi.fn(),
		};
		methods.showLoginAuthTypeSelector.call(context);
		const screen = stripAnsi(component!.render(100).join("\n"));
		for (const label of ["Vinci account", "Provider account", "API key"]) expect(screen).toContain(label);
		component!.handleInput!("\r");
		expect(context.showLoginDialog).toHaveBeenCalledWith("vinci", "Vinci");
		expect(context.showLoginProviderSelector).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalledOnce();
		methods.showLoginAuthTypeSelector.call(context);
		component!.handleInput!("\x1b[B");
		component!.handleInput!("\r");
		expect(context.showLoginProviderSelector).toHaveBeenCalledWith("oauth");
	});

	test.each(["regular", "fullscreen"] as const)(
		"%s help receives wheel, keeps keyboard navigation and restores editor focus",
		async (tuiMode) => {
			const core = createHarness({ settings: { quietStartup: true, theme: "dark", retry: { enabled: false } } });
			vi.stubEnv(ENV_AGENT_DIR, core.tempDir);
			const terminal = new VirtualTerminal(80, 16);
			const writes = vi.spyOn(terminal, "write");
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
					throw new Error("Synthetic QA must not replace the session");
				},
			);
			const mode = new InteractiveMode(runtime, { terminal, tuiMode, manageProcessSignals: false });
			const internals = mode as unknown as {
				ui: TUI;
				editor: EditorComponent;
				editorContainer: Container;
				footerDataProvider: { dispose(): void };
				showContentOverlay(title: string, body: string): void;
			};
			cleanups.push(() => {
				internals.ui.stop({ preserveScreen: true });
				internals.footerDataProvider.dispose();
				core.cleanup();
			});
			internals.ui.addChild(internals.editorContainer);
			internals.ui.setFocus(internals.editor);
			internals.ui.start();
			internals.showContentOverlay(
				"QA Help",
				Array.from({ length: 40 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n\n"),
			);
			await terminal.waitForRender();
			const before = terminal.getViewport().join("\n");
			expect(before).toContain("line-01");
			terminal.sendInput("\x1b[<65;40;8M");
			await terminal.waitForRender();
			const afterWheel = terminal.getViewport().join("\n");
			expect(afterWheel).not.toBe(before);
			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).not.toBe(afterWheel);
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			terminal.sendInput("z");
			expect(internals.editor.getText()).toBe("z");
			if (tuiMode === "regular") {
				expect(writes.mock.calls.some(([data]) => data.includes("\x1b[?1000h"))).toBe(true);
				expect(writes.mock.calls.some(([data]) => data.includes("\x1b[?1000l"))).toBe(true);
			}
		},
	);
});
