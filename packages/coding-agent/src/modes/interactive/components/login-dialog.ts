import { getOAuthProviders, type OAuthDeviceCodeInfo } from "@earendil-works/pi-ai/oauth";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

const URL_CONTROL_BYTES = /[\x00-\x1f\x7f-\x9f]/;

function isSupportedSignInUrl(target: unknown, allowLocalFileLinks: boolean): target is string {
	if (
		typeof target !== "string" ||
		target.trim() !== target ||
		URL_CONTROL_BYTES.test(target) ||
		target.includes("\\")
	)
		return false;
	try {
		const parsed = new URL(target);
		if (parsed.username || parsed.password) return false;
		if (parsed.protocol === "https:") return /^https:\/\//i.test(target) && parsed.hostname !== "";
		// Real provider sign-in uses HTTPS. Owned local QA fixtures may explicitly opt in to
		// canonical local file URLs; remote authorities and UNC paths are never admitted.
		if (!allowLocalFileLinks || parsed.protocol !== "file:" || !/^file:\/\/(?:localhost)?\//i.test(target))
			return false;
		if (parsed.hostname && parsed.hostname !== "localhost") return false;
		const localPath = decodeURIComponent(parsed.pathname);
		return (
			localPath.startsWith("/") &&
			!localPath.startsWith("//") &&
			!localPath.includes("\\") &&
			!URL_CONTROL_BYTES.test(localPath)
		);
	} catch {
		return false;
	}
}

export function loginLinkHint(
	mode: TUI["mode"],
	terminal = process.env.TERM_PROGRAM,
	platform = process.platform,
): string {
	if (platform === "darwin" && terminal?.toLowerCase() === "ghostty" && mode === "fullscreen") {
		return "Shift+Cmd+click to open · hold Shift to select/copy the link";
	}
	return platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
}

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: (success: boolean, message?: string) => void;
	private linkUrl?: string;
	private linkActionHint?: Text;
	private linkActionEnabled = false;
	private openUrl: (url: string) => void;
	private allowLocalFileLinks: boolean;
	private linkError = false;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
		openUrl: (url: string) => void = openBrowser,
		allowLocalFileLinks = false,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;
		this.openUrl = openUrl;
		this.allowLocalFileLinks = allowLocalFileLinks;

		const providerInfo = getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerNameOverride || providerInfo?.name || providerId;
		// [vinci] Vero sign-in copy under VINCI_CODE=1
		const vinci = process.env.VINCI_CODE === "1";
		const title = titleOverride ?? (vinci ? "Sign in" : `Login to ${providerName}`);

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(vinci ? `Vero - ${title}` : title)), 1, 0));
		if (vinci) this.addChild(new Text(theme.fg("dim", `Provider: ${providerName}`), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private replaceInputWithSubmittedText(value: string): void {
		const vinci = process.env.VINCI_CODE === "1";
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(vinci ? "Input submitted" : `> ${value}`, 0, 0) : child,
		);
		if (vinci) this.input.setValue("");
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		if (!this.prepareLink(url)) return;
		if (process.env.VINCI_CODE === "1") {
			this.contentContainer.addChild(new Text("Pending: finish sign-in in your browser.", 1, 0));
		}
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = loginLinkHint(this.tui.mode);
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.linkActionHint = new Text(keyHint("tui.select.confirm", "open link in your browser"), 1, 0);
		this.contentContainer.addChild(this.linkActionHint);

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}
		if (process.env.VINCI_CODE === "1") {
			this.contentContainer.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		}

		this.openLink();
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		if (!this.prepareLink(info.verificationUri)) return;
		if (process.env.VINCI_CODE === "1") {
			this.contentContainer.addChild(new Text("Pending: open the link and authorize the code.", 1, 0));
		}
		const linkedUrl = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = loginLinkHint(this.tui.mode);
		const hyperlink = `\x1b]8;;${info.verificationUri}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.linkActionHint = new Text(keyHint("tui.select.confirm", "open link in your browser"), 1, 0);
		this.contentContainer.addChild(this.linkActionHint);
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.linkError = false;
		this.linkActionEnabled = false;
		this.linkActionHint?.setText("If needed, select and copy the URL above into your browser.");
		this.input.setValue("");
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.linkError = false;
		this.linkActionEnabled = false;
		this.linkActionHint?.setText("If needed, select and copy the URL above into your browser.");
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Show informational text without prompting for input.
	 */
	showInfo(lines: string[]): void {
		this.linkError = false;
		this.linkUrl = undefined;
		this.linkActionHint = undefined;
		this.linkActionEnabled = false;
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	private prepareLink(target: unknown): target is string {
		// Clear a previous accepted target too, so a rejected update cannot leave Enter actionable.
		this.linkUrl = undefined;
		this.linkActionEnabled = false;
		this.linkActionHint = undefined;
		this.linkError = true;
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		if (!isSupportedSignInUrl(target, this.allowLocalFileLinks)) {
			// Never echo the rejected value: it may contain terminal commands or credentials.
			this.contentContainer.addChild(
				new Text("Sign-in link is invalid or unsupported. Cancel and try signing in again.", 1, 0),
			);
			this.contentContainer.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
			this.tui.requestRender();
			return false;
		}
		this.linkUrl = target;
		this.linkActionEnabled = true;
		this.linkError = false;
		return true;
	}

	private openLink(): void {
		if (!this.linkUrl || this.abortController.signal.aborted) return;
		try {
			this.openUrl(this.linkUrl);
		} catch {
			this.contentContainer.addChild(
				new Text("Could not open the link. Select and copy the URL into your browser.", 1, 0),
			);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (this.linkError) return;
		if (this.linkActionEnabled && !this.inputResolver && this.linkUrl && kb.matches(data, "tui.select.confirm")) {
			this.openLink();
			this.tui.requestRender();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
