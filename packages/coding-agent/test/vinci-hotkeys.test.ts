import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const methods = InteractiveMode.prototype as unknown as {
	handleHotkeysCommand(): void;
	getAppKeyDisplay(action: string): string;
	getEditorKeyDisplay(action: string): string;
};

function hotkeys(): string {
	let body = "";
	const context = {
		getAppKeyDisplay: methods.getAppKeyDisplay,
		getEditorKeyDisplay: methods.getEditorKeyDisplay,
		keybindings: new KeybindingsManager(),
		session: { extensionRunner: { getShortcuts: () => new Map() } },
		showContentOverlay(title: string, text: string) {
			expect(title).toBe("Keyboard Shortcuts");
			body = text;
		},
	};
	methods.handleHotkeysCommand.call(context);
	return body;
}

afterEach(() => {
	vi.unstubAllEnvs();
	setKeybindings(new KeybindingsManager());
});

describe("Vinci hotkeys basics", () => {
	test("puts five everyday controls before the full advanced table", () => {
		vi.stubEnv("VINCI_CODE", "1");
		setKeybindings(new KeybindingsManager());
		const body = hotkeys();
		expect(body).toMatch(/^\*\*BASICS\*\*/);
		const basics = body.split("**Advanced**")[0];
		for (const row of [
			"| `Enter` | Send |",
			"| `Shift+Enter/Ctrl+J` | New line |",
			"| `Escape` | Stop |",
			"| `Ctrl+T` | Show/hide thinking |",
			"| `Ctrl+D` | Exit (when editor is empty) |",
		])
			expect(basics).toContain(row);
		expect(body.indexOf("**Advanced**")).toBeLessThan(body.indexOf("**Navigation**"));
		vi.stubEnv("VINCI_CODE", undefined);
		expect(body.split("**Advanced**\n")[1].trim()).toBe(hotkeys());
	});

	test("reads all five bindings from the effective configuration", () => {
		vi.stubEnv("VINCI_CODE", "1");
		setKeybindings(
			new KeybindingsManager({
				"tui.input.submit": "ctrl+s",
				"tui.input.newLine": "ctrl+n",
				"app.interrupt": "ctrl+q",
				"app.thinking.toggle": "ctrl+y",
				"app.exit": "ctrl+e",
			}),
		);
		const basics = hotkeys().split("**Advanced**")[0];
		expect(basics).toMatch(/^\*\*BASICS\*\*/);
		for (const label of ["Ctrl+S", "Ctrl+N", "Ctrl+Q", "Ctrl+Y", "Ctrl+E"]) expect(basics).toContain(label);
		for (const label of ["`Enter`", "`Escape`", "`Ctrl+T`", "`Ctrl+D`"]) expect(basics).not.toContain(label);
	});

	test("keeps the upstream table without introductory sections", () => {
		vi.stubEnv("VINCI_CODE", undefined);
		setKeybindings(new KeybindingsManager());
		const body = hotkeys();
		expect(body).toMatch(/^\*\*Navigation\*\*/);
		expect(body).not.toContain("**BASICS**");
		expect(body).not.toContain("**Advanced**");
	});
});
