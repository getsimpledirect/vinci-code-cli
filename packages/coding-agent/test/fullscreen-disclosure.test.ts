import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const readme = readFileSync(new URL("../../../vinci/README.md", import.meta.url), "utf8");

test.each([
	"Selecting text copies it to your clipboard. Use Shift+drag (Option+drag in iTerm2 and Terminal.app) to select without copying.",
	"If Vinci is force-quit or your connection drops while in fullscreen mode, run `reset` to restore your terminal.",
	"In fullscreen mode, if Vinci crashes or you suspend it with Ctrl+Z, the conversation is not printed to your terminal's scrollback; your session is still saved.",
	"Scroll with the mouse wheel, Shift+PageUp/PageDown, or Ctrl+Home/End. Some terminals use these keys themselves; if they don't scroll Vinci, use the mouse wheel.",
	"`VINCI_COPY_ON_SELECT=0` turns copy-on-select off only when you start Vinci with the `vinci` command. The `copyOnSelect` setting works however Vinci is started.",
])("fullscreen disclosure appears verbatim once: %s", (line) => {
	expect(readme.split(line).length - 1, "required fullscreen disclosure appears exactly once").toBe(1);
});

test("fullscreen opt-in documents both directions, copy controls and pending device QA", () => {
	const section = readme.split("### Fullscreen (opt-in)")[1]?.split("### ")[0] ?? "";
	for (const text of [
		"--tui-mode fullscreen",
		'"tuiMode": "fullscreen"',
		"--tui-mode regular",
		"removing `tuiMode`",
		"/settings",
		"Ctrl+X",
		'"copyOnSelect": false',
		"VINCI_COPY_ON_SELECT=0 vinci",
		"NOT_RUN",
		"Terminal.app",
		"iTerm2",
		"Ghostty",
		"kitty",
		"WezTerm",
		"tmux",
	]) {
		expect(section, `fullscreen opt-in documents ${text}`).toContain(text);
	}
	expect(section).toMatch(/VINCI_COPY_ON_SELECT=0 vinci[^\n]*\n\n`VINCI_COPY_ON_SELECT=0` turns/);
});

test("existing README copy hint wording stays byte-identical", () => {
	const block =
		"| `extensions/vinci-copy.ts` | Clipboard helper — `/copy` or Alt+C opens Vinci's last message, last code block, and last tool output without terminal text selection |";
	expect(readme.split(block).length - 1).toBe(1);
});

test("source-order check: launcher exports Vinci identity before running the Pi CLI", () => {
	const launcher = readFileSync(new URL("../../../vinci/bin/vinci", import.meta.url), "utf8");
	const identity = launcher.indexOf("export VINCI_CODE=1");
	const invocation = launcher.search(/"\$\{PI\[@\]\}"/);
	expect(identity, "launcher exports VINCI_CODE").toBeGreaterThanOrEqual(0);
	expect(invocation, "launcher invokes the Pi CLI after exporting VINCI_CODE").toBeGreaterThan(identity);
});
