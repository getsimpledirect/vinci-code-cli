import { setKeybindings, TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.stubEnv("VINCI_CODE", "1");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.unstubAllEnvs());

const invalidTargets: { label: string; target: unknown }[] = [
	{ label: "javascript", target: "javascript:alert(1)" },
	{ label: "mixed-case-javascript", target: "JaVaScRiPt:synthetic()" },
	{ label: "data", target: "data:text/html,<script>synthetic()</script>" },
	{ label: "mailto", target: "mailto:synthetic@signin.invalid" },
	{ label: "http", target: "http://signin.invalid/synthetic" },
	{ label: "ftp", target: "ftp://signin.invalid/synthetic" },
	{ label: "custom-handler", target: "synthetic-app://signin" },
	{ label: "relative", target: "/synthetic/signin" },
	{ label: "scheme-relative", target: "//signin.invalid/synthetic" },
	{ label: "missing-authority-slashes", target: "https:signin.invalid/synthetic" },
	{ label: "missing-host", target: "https://" },
	{ label: "malformed-host", target: "https://[invalid/synthetic" },
	{ label: "credentials", target: "https://synthetic:synthetic@signin.invalid/" },
	{ label: "leading-space", target: " https://signin.invalid/" },
	{ label: "trailing-space", target: "https://signin.invalid/ " },
	{ label: "backslash", target: "https://signin.invalid\\synthetic" },
	{ label: "remote-file", target: "file://remote.invalid/synthetic/QA.html" },
	{ label: "unc-file", target: "file:////remote.invalid/synthetic/QA.html" },
	{ label: "encoded-unc-file", target: "file:///%2fremote.invalid/synthetic/QA.html" },
	{ label: "encoded-backslash-file", target: "file:///synthetic/%5cQA.html" },
	{ label: "encoded-control-file", target: "file:///synthetic/%00QA.html" },
	{ label: "encoded-c1-file", target: "file:///synthetic/%C2%9DQA.html" },
	{ label: "malformed-percent-file", target: "file:///synthetic/%ZZQA.html" },
	{ label: "osc52-injection", target: "https://signin.invalid/\x07\x1b]52;c;U1lOVEhFVElD\x07" },
	{ label: "empty", target: "" },
	{ label: "undefined", target: undefined },
	{ label: "null", target: null },
	{ label: "number", target: 17 },
	{ label: "object", target: { protocol: "https:" } },
	...Array.from({ length: 32 }, (_, code) => ({
		label: `c0-${code.toString(16)}`,
		target: `https://signin.invalid/${String.fromCharCode(code)}synthetic`,
	})),
	...Array.from({ length: 33 }, (_, index) => ({
		label: `del-c1-${(127 + index).toString(16)}`,
		target: `https://signin.invalid/${String.fromCharCode(127 + index)}synthetic`,
	})),
];
const views = (["regular", "fullscreen"] as const).flatMap((mode) =>
	(["url", "device"] as const).map((flow) => ({ mode, flow })),
);

describe("sign-in target safety before storage, rendering or opening", () => {
	test.each(views.flatMap((view) => invalidTargets.map((target) => ({ ...view, ...target }))))(
		"$mode $flow rejects $label without rendering or opening the target",
		({ mode, flow, target }) => {
			const terminal = new VirtualTerminal(120, 24);
			const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
			const opener = vi.fn();
			const complete = vi.fn();
			// Even the explicit local-fixture policy cannot admit unsupported schemes/controls.
			const dialog = new LoginDialogComponent(tui, "vinci", complete, undefined, undefined, opener, true);
			dialog.focused = true;
			if (flow === "url") dialog.showAuth(target as string, "Synthetic instructions must not appear on rejection");
			else dialog.showDeviceCode({ verificationUri: target as string, userCode: "SYNTHETIC-CODE" });
			for (const width of [24, 80, 120]) {
				const output = dialog.render(width).join("\n");
				expect(stripAnsi(output).replace(/\s+/g, " ")).toContain("Sign-in link is invalid or unsupported");
				expect(output).not.toContain("\x1b]8;");
				expect(output).not.toContain("\x1b]52;");
				expect(output).not.toContain("Synthetic instructions");
				expect(output).not.toContain("SYNTHETIC-CODE");
				expect(stripAnsi(output)).not.toContain("open link");
				if (typeof target === "string" && target.length > 0) expect(output).not.toContain(target);
			}
			dialog.handleInput("\r");
			expect(opener).not.toHaveBeenCalled();
			expect(dialog.focused).toBe(true);
			dialog.handleInput("\x1b");
			expect(complete).toHaveBeenCalledExactlyOnceWith(false, "Login cancelled");
		},
	);

	test.each(views)("$mode $flow removes a previous accepted target when an unsafe one arrives", ({ mode, flow }) => {
		const terminal = new VirtualTerminal(120, 24);
		const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
		const opener = vi.fn();
		const dialog = new LoginDialogComponent(tui, "vinci", () => {}, undefined, undefined, opener);
		if (flow === "url") dialog.showAuth("https://signin.invalid/accepted");
		else dialog.showDeviceCode({ verificationUri: "https://signin.invalid/accepted", userCode: "SYNTHETIC" });
		opener.mockClear();
		if (flow === "url") dialog.showAuth("javascript:synthetic()");
		else dialog.showDeviceCode({ verificationUri: "javascript:synthetic()", userCode: "SYNTHETIC" });
		dialog.handleInput("\r");
		expect(opener).not.toHaveBeenCalled();
		expect(dialog.render(120).join("\n")).not.toContain("accepted");
	});

	test.each(views)(
		"$mode $flow invalid-target error cannot submit an earlier hidden prompt",
		async ({ mode, flow }) => {
			const terminal = new VirtualTerminal(120, 24);
			const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
			const opener = vi.fn();
			const dialog = new LoginDialogComponent(tui, "vinci", () => {}, undefined, undefined, opener);
			if (flow === "url") dialog.showAuth("https://signin.invalid/accepted");
			else dialog.showDeviceCode({ verificationUri: "https://signin.invalid/accepted", userCode: "SYNTHETIC" });
			const input = dialog.showManualInput("Synthetic callback code");
			dialog.handleInput("synthetic-stale");
			let settled = false;
			const observed = input.then(
				() => {
					settled = true;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			opener.mockClear();
			if (flow === "url") dialog.showAuth("javascript:synthetic()");
			else dialog.showDeviceCode({ verificationUri: "javascript:synthetic()", userCode: "SYNTHETIC" });
			dialog.handleInput("\r");
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(opener).not.toHaveBeenCalled();
			dialog.handleInput("\x1b");
			expect(await observed).toBeInstanceOf(Error);
		},
	);

	test.each(views)("$mode $flow requires explicit fixture opt-in for local file links", ({ mode, flow }) => {
		const terminal = new VirtualTerminal(120, 24);
		const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
		const opener = vi.fn();
		const dialog = new LoginDialogComponent(tui, "vinci", () => {}, undefined, undefined, opener);
		if (flow === "url") dialog.showAuth("file:///synthetic/QA.html");
		else dialog.showDeviceCode({ verificationUri: "file:///synthetic/QA.html", userCode: "SYNTHETIC" });
		dialog.handleInput("\r");
		expect(opener).not.toHaveBeenCalled();
		expect(stripAnsi(dialog.render(120).join("\n"))).toContain("invalid or unsupported");
	});

	test.each(
		views.flatMap((view) =>
			[
				"https://signin.invalid/space here?one=two&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback#end",
				"HTTPS://SignIn.invalid/Case?State=ONE&next=%2Fdone#end",
				"https://signin.invalid/unicode/π?literal=%0A",
				"file:///synthetic/QA page.html?one=two&next=%2Fdone#end",
				"file://localhost/synthetic/QA%20page.html",
				"file:///synthetic/%F0%9F%98%80.html",
			].map((target, index) => ({ ...view, target, index })),
		),
	)(
		"$mode $flow preserves valid target bytes for case$index with configurable keys/manual Enter/cancel",
		async ({ mode, flow, target }) => {
			setKeybindings(new KeybindingsManager({ "tui.select.confirm": ["ctrl+x"] }));
			const terminal = new VirtualTerminal(120, 24);
			const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TUI(terminal);
			const opener = vi.fn();
			const complete = vi.fn();
			const dialog = new LoginDialogComponent(
				tui,
				"vinci",
				complete,
				undefined,
				undefined,
				opener,
				target.startsWith("file:"),
			);
			dialog.focused = true;
			if (flow === "url") dialog.showAuth(target);
			else dialog.showDeviceCode({ verificationUri: target, userCode: "SYNTHETIC" });
			expect(opener).toHaveBeenCalledTimes(flow === "url" ? 1 : 0);
			if (flow === "url") expect(opener).toHaveBeenCalledWith(target);
			opener.mockClear();
			for (const width of [24, 80, 120]) {
				const output = dialog.render(width).join("\n");
				const targets = [...output.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)].map((match) => match[1]);
				expect(targets.filter(Boolean).length).toBeGreaterThanOrEqual(2);
				expect(targets.filter(Boolean).every((url) => url === target)).toBe(true);
				expect(targets.filter(Boolean).length).toEqual(targets.filter((url) => !url).length);
			}
			dialog.handleInput("\r");
			expect(opener).not.toHaveBeenCalled();
			dialog.handleInput("\x18");
			expect(opener).toHaveBeenCalledExactlyOnceWith(target);
			opener.mockClear();
			const prompt = dialog.showManualInput("Synthetic callback code");
			dialog.handleInput("synthetic-code");
			dialog.handleInput("\r");
			await expect(prompt).resolves.toBe("synthetic-code");
			expect(opener).not.toHaveBeenCalled();
			const cancelled = dialog.showPrompt("Synthetic prompt");
			dialog.handleInput("\x1b");
			await expect(cancelled).rejects.toThrow("Login cancelled");
			expect(complete).toHaveBeenCalledExactlyOnceWith(false, "Login cancelled");
			expect(dialog.focused).toBe(true);
		},
	);
});
