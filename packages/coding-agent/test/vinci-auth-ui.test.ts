import { Container, Input, setKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollOAuthDeviceCodeFlow } from "../../ai/src/utils/oauth/device-code.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

type AuthUiContext = {
	ui: TUI;
	editor: Input;
	editorContainer: Container;
	chatContainer: Container;
	session: {
		model: undefined;
		modelRegistry: { authStorage: AuthStorage; refresh: () => void; getAvailable: () => never[] };
	};
	footer: { invalidate: () => void };
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	checkDaxnutsEasterEgg: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	completeProviderAuthentication: (
		providerId: string,
		name: string,
		type: "oauth" | "api_key",
		previous: undefined,
	) => Promise<void>;
};

type AuthUiMethods = {
	showStatus(this: AuthUiContext, message: string): void;
	showError(this: AuthUiContext, message: string): void;
	showLoginDialog(this: AuthUiContext, id: string, name: string): Promise<void>;
	showApiKeyLoginDialog(this: AuthUiContext, id: string, name: string): Promise<void>;
	completeProviderAuthentication(
		this: AuthUiContext,
		id: string,
		name: string,
		type: "oauth" | "api_key",
		previous: undefined,
	): Promise<void>;
};

const methods = InteractiveMode.prototype as unknown as AuthUiMethods;
const runningUis: TUI[] = [];

function createAuthUi(width = 80, rows = 24): AuthUiContext {
	const terminal = new VirtualTerminal(width, rows);
	const ui = new TUI(terminal);
	const editor = new Input();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const chatContainer = new Container();
	ui.addChild(chatContainer);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	ui.start();
	runningUis.push(ui);
	const context: AuthUiContext = {
		ui,
		editor,
		editorContainer,
		chatContainer,
		session: {
			model: undefined,
			modelRegistry: { authStorage: AuthStorage.inMemory(), refresh: vi.fn(), getAvailable: () => [] },
		},
		footer: { invalidate: vi.fn() },
		updateAvailableProviderCount: async () => {},
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		checkDaxnutsEasterEgg: vi.fn(),
		showStatus: (message) => methods.showStatus.call(context, message),
		showError: (message) => methods.showError.call(context, message),
		completeProviderAuthentication: (id, name, type, previous) =>
			methods.completeProviderAuthentication.call(context, id, name, type, previous),
	};
	return context;
}

function currentDialog(context: AuthUiContext): LoginDialogComponent {
	const dialog = context.editorContainer.children[0];
	expect(dialog).toBeInstanceOf(LoginDialogComponent);
	return dialog as LoginDialogComponent;
}

function chat(context: AuthUiContext): string {
	return stripAnsi(context.chatContainer.render(120).join("\n"));
}

beforeEach(() => {
	vi.stubEnv("VINCI_CODE", "1");
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});

afterEach(() => {
	for (const ui of runningUis.splice(0)) ui.stop();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Vinci auth UI boundaries", () => {
	it.each([20, 39, 40, 60, 80, 120])("keeps provider and configured key hints readable at %i columns", (width) => {
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[{ id: "openai", name: "OpenAI", authType: "api_key" }],
			vi.fn(),
			vi.fn(),
		);
		const lines = selector.render(width);
		const output = stripAnsi(lines.join("\n"));
		expect(output).toContain("Vero");
		expect(output).toContain("OpenAI");
		expect(output).toContain("API key");
		expect(output).toMatch(/enter[\s\S]*choose/);
		expect(output).toMatch(/escape[\s\S]*back/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("keeps browser authorization pending until provider completion", () => {
		const context = createAuthUi(39);
		const dialog = new LoginDialogComponent(context.ui, "github-copilot", vi.fn(), "GitHub Copilot");
		dialog.showAuth("https://example.invalid/authorize", "Choose your provider account.");
		const output = stripAnsi(dialog.render(39).join("\n"));
		expect(output).toContain("Vero");
		expect(output).toContain("GitHub Copilot");
		expect(output).toContain("Pending");
		expect(output).toMatch(/browser/);
		expect(output).toMatch(/escape[\s\S]*cancel/);
		expect(output).not.toMatch(/connected|authenticated|signed in/i);
		expect(openBrowser).toHaveBeenCalledWith("https://example.invalid/authorize");
	});

	it.each(["synthetic-secret-C2-distinctive", "https://example.invalid/callback?code=synthetic-C2-code"])(
		"passes the exact login input while hiding its confirmation value: %s",
		async (value) => {
			const context = createAuthUi();
			const dialog = new LoginDialogComponent(context.ui, "github-copilot", vi.fn(), "GitHub Copilot");
			const submitted = dialog.showPrompt("Enter the requested input:");
			dialog.handleInput(value);
			dialog.handleInput("\r");
			await expect(submitted).resolves.toBe(value);
			const output = stripAnsi(dialog.render(120).join("\n"));
			expect(output).toContain("Input submitted");
			expect(output).not.toContain(value);
		},
	);

	it("does not turn a late completion into success after actual cancellation", async () => {
		const context = createAuthUi();
		let completeLogin = () => {};
		vi.spyOn(context.session.modelRegistry.authStorage, "login").mockImplementation(
			async () =>
				new Promise<void>((resolve) => {
					completeLogin = resolve;
				}),
		);
		const completion = methods.showLoginDialog.call(context, "github-copilot", "GitHub Copilot");
		currentDialog(context).handleInput("\x1b");
		completeLogin();
		await completion;
		expect(chat(context)).toMatch(/cancelled/);
		expect(chat(context)).not.toMatch(/Logged in|connected/);
	});

	it("reports saved account sign-in only after the provider completes the pending flow", async () => {
		const context = createAuthUi();
		let completeLogin = () => {};
		vi.spyOn(context.session.modelRegistry.authStorage, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onDeviceCode({ verificationUri: "https://example.invalid/device", userCode: "FIXTURE-CODE" });
			await new Promise<void>((resolve) => {
				completeLogin = resolve;
			});
			context.session.modelRegistry.authStorage.set("github-copilot", {
				type: "oauth",
				access: "synthetic-access",
				refresh: "synthetic-refresh",
				expires: Date.now() + 60_000,
			});
		});
		const completion = methods.showLoginDialog.call(context, "github-copilot", "GitHub Copilot");
		expect(stripAnsi(currentDialog(context).render(120).join("\n"))).toContain("Pending");
		expect(chat(context)).not.toMatch(/Logged in|connected/);
		completeLogin();
		await completion;
		expect(context.editorContainer.children).toEqual([context.editor]);
		expect(chat(context)).toContain("Logged in to GitHub Copilot");
		expect(chat(context)).toContain("Vero");
		expect(chat(context)).toContain("/model");
	});

	it("keeps the actual bounded device-flow timeout distinct from a generic login failure", async () => {
		const context = createAuthUi();
		vi.spyOn(context.session.modelRegistry.authStorage, "login").mockImplementation(async () => {
			await pollOAuthDeviceCodeFlow({ expiresInSeconds: 0, poll: async () => ({ status: "pending" }) });
		});
		await methods.showLoginDialog.call(context, "github-copilot", "GitHub Copilot");
		expect(chat(context)).toContain("Sign-in expired or timed out");
		expect(chat(context)).toContain("Device flow timed out");
		expect(chat(context)).toContain("/login");
	});

	it("shows and obeys configured cancellation keys rather than hardcoding Escape", async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.cancel": ["ctrl+x"] }));
		const context = createAuthUi(20);
		const completion = methods.showApiKeyLoginDialog.call(context, "openai", "OpenAI");
		const dialog = currentDialog(context);
		expect(stripAnsi(dialog.render(20).join("\n"))).toMatch(/ctrl\+x[\s\S]*cancel/);
		dialog.handleInput("\x18");
		await completion;
		expect(chat(context)).toMatch(/OpenAI[\s\S]*cancelled/);
		expect(context.session.modelRegistry.authStorage.get("openai")).toBeUndefined();
	});

	it.each(["VINCI_PLAIN", "VINCI_SCREEN_READER", "VINCI_REDUCED_MOTION", "NO_COLOR"])(
		"retains text and keyboard choice with %s",
		(flag) => {
			vi.stubEnv(flag, "1");
			initTheme("light");
			const selector = new OAuthSelectorComponent(
				"login",
				AuthStorage.inMemory(),
				[{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth" }],
				vi.fn(),
				vi.fn(),
			);
			const output = stripAnsi(selector.render(39).join("\n"));
			expect(output).toContain("Vero");
			expect(output).toContain("Provider account");
			expect(output).toMatch(/enter[\s\S]*choose/);
			expect(output).toMatch(/escape[\s\S]*back/);
			expect(output).not.toMatch(/\x1b_G|\x1b\]1337/);
		},
	);

	it("reports actual cancellation and restores the editor without claiming login success", async () => {
		const context = createAuthUi();
		vi.spyOn(context.session.modelRegistry.authStorage, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onDeviceCode({ verificationUri: "https://example.invalid/device", userCode: "FIXTURE-CODE" });
			await new Promise<void>((_resolve, reject) =>
				callbacks.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true }),
			);
		});
		const completion = methods.showLoginDialog.call(context, "github-copilot", "GitHub Copilot");
		currentDialog(context).handleInput("\x1b");
		await completion;
		expect(context.editorContainer.children).toEqual([context.editor]);
		expect(chat(context)).toMatch(/GitHub Copilot[\s\S]*cancelled/);
		expect(chat(context)).toContain("/login");
		expect(chat(context)).not.toMatch(/Logged in|connected|Failed/);
	});

	it("distinguishes a provider-reported expiry from an unrelated failure and preserves the original", async () => {
		const context = createAuthUi();
		vi.spyOn(context.session.modelRegistry.authStorage, "login").mockRejectedValue(new Error("expired_token"));
		await methods.showLoginDialog.call(context, "github-copilot", "GitHub Copilot");
		expect(chat(context)).toMatch(/expired/i);
		expect(chat(context)).toContain("expired_token");
		expect(chat(context)).toContain("/login");
		expect(chat(context)).not.toMatch(/Logged in|connected/);
	});

	it.each([
		"403 account access denied",
		"503 provider unavailable",
		"Unknown authorization failure",
		"Could not read expired_token fixture config",
	])("preserves the actual failure %s without inferring expiry", async (message) => {
		const context = createAuthUi();
		vi.spyOn(context.session.modelRegistry.authStorage, "login").mockRejectedValue(new Error(message));
		await methods.showLoginDialog.call(context, "github-copilot", "GitHub Copilot");
		expect(chat(context)).toContain(message);
		expect(chat(context)).toMatch(/failed/i);
		expect(chat(context)).toContain("/login");
		expect(chat(context)).not.toMatch(/Sign-in expired|Logged in|connected/i);
	});

	it("saving a key does not claim authenticated provider access or portable subscription rights", async () => {
		const context = createAuthUi();
		const completion = methods.showApiKeyLoginDialog.call(context, "openai", "OpenAI");
		currentDialog(context).handleInput("synthetic-api-key");
		currentDialog(context).handleInput("\r");
		await completion;
		expect(context.session.modelRegistry.authStorage.get("openai")).toEqual({
			type: "api_key",
			key: "synthetic-api-key",
		});
		expect(chat(context)).toContain("Saved API key for OpenAI");
		expect(chat(context)).toContain("Vero");
		expect(chat(context)).toContain("/model");
		expect(chat(context)).not.toMatch(/You're connected|web and your phone|subscription/i);
	});

	it("preserves upstream identity and silence on cancellation outside Vinci", async () => {
		vi.stubEnv("VINCI_CODE", "0");
		const context = createAuthUi();
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[{ id: "openai", name: "OpenAI", authType: "api_key" }],
			vi.fn(),
			vi.fn(),
		);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Select provider to configure:");
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("Vero");
		const completion = methods.showApiKeyLoginDialog.call(context, "openai", "OpenAI");
		expect(stripAnsi(currentDialog(context).render(120).join("\n"))).toContain("Login to OpenAI");
		currentDialog(context).handleInput("\x1b");
		await completion;
		expect(chat(context)).toBe("");
	});
});
