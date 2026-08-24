import {
	Container,
	type Focusable,
	getKeybindings,
	Markdown,
	type MarkdownTheme,
	type OverlayOptions,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const OVERLAY_MARGIN = 1;
const FRAME_HEIGHT = 6;

export function getContentOverlayOptions(tui: TUI): OverlayOptions {
	return {
		anchor: "center",
		width: Math.min(100, Math.max(1, tui.terminal.columns - OVERLAY_MARGIN * 2)),
		maxHeight: Math.max(1, tui.terminal.rows - OVERLAY_MARGIN * 2),
		margin: OVERLAY_MARGIN,
	};
}

export class ContentOverlayComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly markdown: Markdown;
	private readonly onClose: () => void;
	private scrollOffset = 0;
	private contentLineCount = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(tui: TUI, title: string, body: string, markdownTheme: MarkdownTheme, onClose: () => void) {
		super();
		this.tui = tui;
		this.markdown = new Markdown(body, 1, 0, markdownTheme);
		this.onClose = onClose;

		const closeKey = keyDisplayText("tui.select.cancel");
		const upKey = keyDisplayText("tui.select.up");
		const downKey = keyDisplayText("tui.select.down");
		const pageUpKey = keyDisplayText("tui.select.pageUp");
		const pageDownKey = keyDisplayText("tui.select.pageDown");

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.markdown);
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					`${upKey}/${downKey} or ${pageUpKey}/${pageDownKey} to scroll · Press ${closeKey} to close`,
				),
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	private getVisibleBodyHeight(): number {
		const maxHeight = Math.max(1, this.tui.terminal.rows - OVERLAY_MARGIN * 2);
		return Math.max(1, maxHeight - FRAME_HEIGHT);
	}

	private scrollBy(delta: number): void {
		const maxOffset = Math.max(0, this.contentLineCount - this.getVisibleBodyHeight());
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxOffset));
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const bodyLines = this.markdown.render(width);
		const visibleBodyHeight = this.getVisibleBodyHeight();
		this.contentLineCount = bodyLines.length;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, bodyLines.length - visibleBodyHeight));

		const frameLines = this.children.flatMap((child) =>
			child === this.markdown
				? bodyLines.slice(this.scrollOffset, this.scrollOffset + visibleBodyHeight)
				: child.render(width),
		);
		return frameLines.map((line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
		} else if (kb.matches(data, "tui.select.up")) {
			this.scrollBy(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollBy(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollBy(-this.getVisibleBodyHeight());
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollBy(this.getVisibleBodyHeight());
		}
	}
}
