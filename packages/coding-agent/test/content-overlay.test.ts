import { setKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	ContentOverlayComponent,
	getContentOverlayOptions,
} from "../src/modes/interactive/components/content-overlay.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class OverlayTUI extends TUI {
	renderOverlays(): string[] {
		return this.compositeOverlays([], this.terminal.columns, this.terminal.rows);
	}
}

describe("ContentOverlayComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => vi.unstubAllEnvs());

	test.each([56, 60, 80])("keeps the close line on screen at eight rows and %i columns", (columns) => {
		vi.stubEnv("VINCI_CODE", "1");
		const tui = new OverlayTUI(new VirtualTerminal(columns, 8));
		const body = Array.from({ length: 30 }, (_, i) => `- Line ${i + 1}`).join("\n");
		const overlay = new ContentOverlayComponent(tui, "Title", body, getMarkdownTheme(), () => {});
		tui.showOverlay(overlay, getContentOverlayOptions(tui));
		const screen = stripAnsi(tui.renderOverlays().join("\n"));
		expect(screen).toMatch(/Press Escape\/Ctrl\+C\s+to close/);
		const lines = overlay.render(columns - 2);
		expect(lines.length).toBeLessThanOrEqual(6);
		expect(stripAnsi(lines.join("\n"))).toContain("Line 1");
		expect(stripAnsi(lines.at(-1) ?? "")).toBe("─".repeat(columns - 2));
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns - 2);
	});

	test.each([56, 60, 80])("keeps the whole close instruction at %i terminal columns", (columns) => {
		vi.stubEnv("VINCI_CODE", "1");
		const tui = new TUI(new VirtualTerminal(columns, 12));
		const body = Array.from({ length: 30 }, (_, i) => `- Line ${i + 1}`).join("\n");
		const overlay = new ContentOverlayComponent(tui, "Title", body, getMarkdownTheme(), () => {});
		const lines = overlay.render(columns - 2);
		const output = stripAnsi(lines.join("\n"));
		expect(output).toMatch(/Press Escape\/Ctrl\+C\s+to close/);
		expect(output).toContain("PageUp/PageDown");
		expect(lines.length).toBeLessThanOrEqual(10);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns - 2);
	});

	test("reserves space for the Vinci footer while paging and obeys a remapped close key", () => {
		vi.stubEnv("VINCI_CODE", "1");
		setKeybindings(new KeybindingsManager({ "tui.select.cancel": "ctrl+x" }));
		const tui = new TUI(new VirtualTerminal(56, 12));
		const body = Array.from({ length: 20 }, (_, i) => `- Line ${String(i + 1).padStart(2, "0")}`).join("\n");
		const close = vi.fn();
		const overlay = new ContentOverlayComponent(tui, "Title", body, getMarkdownTheme(), close);
		const first = stripAnsi(overlay.render(54).join("\n"));
		expect(first).toContain("Line 03");
		expect(first).not.toContain("Line 04");
		expect(first).toContain("Press Ctrl+X to close");
		overlay.handleInput("\x1b[6~");
		const second = stripAnsi(overlay.render(54).join("\n"));
		expect(second).toContain("Line 04");
		expect(second).not.toContain("Line 03");
		overlay.handleInput("\x1b");
		expect(close).not.toHaveBeenCalled();
		overlay.handleInput("\x18");
		expect(close).toHaveBeenCalledOnce();
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
