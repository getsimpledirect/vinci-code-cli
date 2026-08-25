import { setKeybindings, TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ContentOverlayComponent } from "../src/modes/interactive/components/content-overlay.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ContentOverlayComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("scrolls long markdown with page keys", () => {
		const tui = new TUI(new VirtualTerminal(80, 12));
		const body = Array.from({ length: 20 }, (_, index) => `- Line ${String(index + 1).padStart(2, "0")}`).join("\n");
		const overlay = new ContentOverlayComponent(tui, "Title", body, getMarkdownTheme(), () => {});

		const firstPage = stripAnsi(overlay.render(60).join("\n"));
		expect(firstPage).toContain("Line 01");
		expect(firstPage).not.toContain("Line 20");

		overlay.handleInput("\x1b[6~");
		const secondPage = stripAnsi(overlay.render(60).join("\n"));
		expect(secondPage).not.toContain("Line 01");
		expect(secondPage).toContain("Line 05");
	});

	test("closes through the selector cancel keybinding", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const onClose = vi.fn();
		const overlay = new ContentOverlayComponent(tui, "Title", "Body", getMarkdownTheme(), onClose);

		overlay.handleInput("\x1b");

		expect(onClose).toHaveBeenCalledOnce();
	});
});
