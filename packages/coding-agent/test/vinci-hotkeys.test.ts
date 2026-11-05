import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const methods = InteractiveMode.prototype as unknown as {
	handleHotkeysCommand(): void;
	getAppKeyDisplay(action: string): string;
	getEditorKeyDisplay(action: string): string;
};

function hotkeys(keybindings = new KeybindingsManager(), shortcuts = new Map()): string {
	let body = "";
	const context = {
		getAppKeyDisplay: methods.getAppKeyDisplay,
		getEditorKeyDisplay: methods.getEditorKeyDisplay,
		keybindings,
		session: { extensionRunner: { getShortcuts: () => shortcuts } },
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
	test("runs the standalone unbound hotkeys consumer regression", { timeout: 60_000 }, () => {
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		const result = spawnSync(
			process.execPath,
			["--test", fileURLToPath(new URL("../../../vinci/test/unbound-hotkeys.mjs", import.meta.url))],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					JITI_FS_CACHE: "false",
					VINCI_TEST_ROOT: root,
					VINCI_TEST_BUILT: "0",
					VINCI_TEST_SOURCE_ONLY: "0",
				},
				encoding: "utf8",
				timeout: 45_000,
				maxBuffer: 2 * 1024 * 1024,
			},
		);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
		expect(result.error, diagnostic).toBeUndefined();
		expect(result.signal, diagnostic).toBeNull();
		expect(result.status, diagnostic).toBe(0);
	});

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

	test("labels an unbound thinking action and preserves its configured replacement", () => {
		vi.stubEnv("VINCI_CODE", "1");
		const unbound = new KeybindingsManager({ "app.thinking.cycle": [] });
		setKeybindings(unbound);
		expect(hotkeys(unbound)).toContain("| `Unbound` | Cycle thinking level |");
		expect(hotkeys(unbound)).not.toContain("``");
		const rebound = new KeybindingsManager({ "app.thinking.cycle": "ctrl+alt+t" });
		setKeybindings(rebound);
		expect(hotkeys(rebound)).toContain(
			`| \`${formatKeyText("ctrl+alt+t", { capitalize: true })}\` | Cycle thinking level |`,
		);
		expect(hotkeys(rebound)).toContain("| `Enter` | Send |");
	});

	test("labels empty bindings in all repeated rows, grouped rows and extension rows", () => {
		vi.stubEnv("VINCI_CODE", "1");
		const defaults = new KeybindingsManager().getEffectiveConfig();
		const keybindings = new KeybindingsManager(
			Object.fromEntries(Object.keys(defaults).map((action) => [action, []])),
		);
		setKeybindings(keybindings);
		const body = hotkeys(keybindings, new Map([["", { description: "Extension action" }]]));
		expect(body).not.toContain("``");
		expect(body).toContain("| `Unbound` | Send |");
		expect(body).toContain("| `Unbound` | Send message |");
		expect(body).toContain("| `Unbound` / `Unbound` | Move by word |");
		expect(body).toContain("| `Unbound` | Suspend to background |");
		expect(body).toContain("| `Unbound` | Extension action |");
	});

	test("preserves a bound member of a mixed group", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.cursorWordLeft": [],
			"tui.editor.cursorWordRight": "ctrl+alt+r",
		});
		setKeybindings(keybindings);
		expect(hotkeys(keybindings)).toContain(
			`| \`Unbound\` / \`${formatKeyText("ctrl+alt+r", { capitalize: true })}\` | Move by word |`,
		);
	});
});
