import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { ALT_SCREEN_KEYBINDINGS, getKeybindings, KeybindingsManager } from "./keybindings.ts";
import { getScrollViewBox, getScrollViewsAt, type LayoutFrame, renderLayoutFrame } from "./layout.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	getCapabilities,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	CURSOR_MARKER,
	compositeTuiLine,
	TUI,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const wordSegmenter = getWordSegmenter();

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** A position between cells rather than a cell to include. */
	boundary?: boolean;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
}

export interface TuiAltScreenOptions {
	/** Number of logical lines moved for each mouse-wheel event. */
	wheelScrollLines?: number;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Host clipboard route, resolved only after the write attempt completes. */
	copySelection?: (text: string) => Promise<"native" | "terminal" | "remote-only">;
	/** Defer viewport keys and disable selection while an application modal is open. */
	deferViewportInput?: () => boolean;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TUI implements ViewportTUI {
	override readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private terminalStopPending = false;
	private terminalDead = false;
	private transcriptPending = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private selectionGranularity: "character" | "word" | "line" = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionPressActive = false;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private pressedUrl?: string;
	private selectionDragged = false;
	private readonly viewportKeybindings = new KeybindingsManager(ALT_SCREEN_KEYBINDINGS);
	private readonly wheelScrollLines: number;
	private readonly mouseEnabled: boolean;
	private readonly openUrl?: (url: string) => void;
	private readonly copySelection?: TuiAltScreenOptions["copySelection"];
	private readonly deferViewportInput?: () => boolean;

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options: TuiAltScreenOptions = {}) {
		super(terminal, showHardwareCursor);
		this.implicitDocument = {
			render: (width) => super.render(width),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? 3));
		this.mouseEnabled = options.mouse ?? true;
		this.openUrl = options.openUrl;
		this.copySelection = options.copySelection;
		this.deferViewportInput = options.deferViewportInput;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	/** Show a transient message at the top-right of the viewport. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	override invalidate(): void {
		super.invalidate();
		this.layoutRoot?.invalidate();
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	override start(): void {
		if (this.terminalDead) return;
		try {
			super.start();
		} catch (error) {
			try {
				this.stop({ preserveScreen: true });
			} catch {}
			throw error;
		}
	}

	override stop(options: TuiStopOptions = {}): void {
		if (this.terminalDead || (this.stopped && !this.altScreenActive && !this.terminalStopPending)) return;
		try {
			super.stop(options);
		} catch (error) {
			try {
				this.resetTerminal();
			} catch {}
			throw error;
		}
	}

	override resetTerminal(synchronous = false): void {
		this.stopRendering(true);
		this.cancelSelection();
		this.flashes.dispose();
		this.transcriptPending = false;
		if (this.terminalDead) return;
		if (synchronous && this.terminalStopPending) {
			try {
				this.terminal.stop();
				this.terminalStopPending = false;
			} catch {
				// Restore renderer modes even if restoring terminal input failed.
			}
		}
		if (this.terminalDead || !this.altScreenActive) return;
		const reset = `${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteViewportKittyImages()}${DISABLE_MOUSE}${ENABLE_AUTOWRAP}\x1b[?25h${EXIT_ALT_SCREEN}${END_SYNCHRONIZED_OUTPUT}`;
		if (synchronous && this.terminal.writeSync) this.terminal.writeSync(reset);
		else this.terminal.write(reset);
		this.altScreenActive = false;
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	override markTerminalDead(): void {
		this.terminalDead = true;
		this.altScreenActive = false;
		this.terminalStopPending = false;
		this.transcriptPending = false;
		this.stopRendering(true);
		this.cancelSelection();
		this.flashes.dispose();
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	protected override beforeTerminalStart(): void {
		this.cancelSelection();
		this.flashes.dispose();
		this.terminalStopPending = true;
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers need button-motion tracking to avoid forwarding idle pointer movement.
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		const printTranscript = this.altScreenActive && !options.preserveScreen;
		this.resetTerminal();
		this.transcriptPending = printTranscript;
	}

	protected override afterTerminalStop(): void {
		this.terminalStopPending = false;
		if (!this.transcriptPending) return;
		this.transcriptPending = false;
		const width = Math.max(1, this.terminal.columns);
		const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
			(line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)),
		);
		let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${DISABLE_AUTOWRAP}`;
		for (let row = 0; row < this.lastDocument.length; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
		}
		buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
		this.terminal.write(buffer);
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	private deleteViewportKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === "\x1b[O") {
			if (this.selectionPressActive) this.cancelSelection();
			this.lastClick = undefined;
			this.requestRender();
			return { consume: true };
		}
		if (data === "\x1b[I") return { consume: true };
		const defer = this.isOverlayFocused() || this.deferViewportInput?.() === true;
		if (this.hasOverlay() || this.deferViewportInput?.()) this.cancelSelection();
		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			if (defer) return undefined;
			this.routeWheel(wheelEvent);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			this.handleSelectionMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };
		if (defer) return undefined;

		const keybindings = this.viewportKeybindings;
		keybindings.setUserBindings(getKeybindings().getUserBindings());
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - 1));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - 1));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
			};
		}
		return undefined;
	}

	private routeWheel(event: WheelEvent): void {
		let remaining = event.direction * this.wheelScrollLines;
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") {
				this.requestRender();
				return;
			}
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.requestRender();
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
	}

	private cancelSelection(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		if (!point.scrollView || !this.currentLayout) return "";
		return getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines?.[point.row] ?? "";
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			if (point.col >= start && point.col < end) {
				return { start: { ...point, col: start }, end: { ...point, col: end, boundary: true } };
			}
			start = end;
		}
		return undefined;
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const before =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		this.selectionAnchor = before ? initial.end : initial.start;
		this.selectionFocus = before ? range.start : range.end;
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= 500 &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.requestRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		if (!this.mouseEnabled || this.hasOverlay() || this.deferViewportInput?.()) {
			this.cancelSelection();
			return;
		}
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const clickedUrl =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col
					? this.pressedUrl
					: undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			void this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		const scrollView =
			!this.hasOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		if (!scrollView) {
			this.cancelSelection();
			this.requestRender();
			return;
		}
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const count = this.getClickCount(anchor, word);
		const range = count === 2 ? word : count === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionPressActive = true;
		this.selectionGranularity = range ? (count === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.requestRender();
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	private async copySelectionToClipboard(): Promise<void> {
		const selection = this.getSelectionBounds();
		if (!selection || this.hasOverlay() || this.deferViewportInput?.() || !this.currentLayout) return;
		const view = selection.start.scrollView;
		if (!view) return;
		const box = getScrollViewBox(this.currentLayout, view);
		if (!box?.scrollContentLines) return;
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = (box.scrollContentLines[row] ?? "").replaceAll(CURSOR_MARKER, "");
			if (isImageLine(line)) continue;
			const columns = this.getSelectionColumns(line, row, selection, 0, box.rect.width);
			lines.push(
				stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)),
			);
		}
		const text = lines.join("\n");
		if (text.length === 0) return;
		let message = "Couldn't copy to clipboard";
		try {
			if (this.copySelection) {
				const route = await this.copySelection(text);
				message = route === "native" ? "Copied" : route === "terminal" ? "Sent to terminal clipboard" : message;
			}
		} catch {
			// Copy failure is visible without interrupting terminal input.
		}
		if (!this.stopped) this.flash(message);
	}

	private applySelectionHighlight(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		const selection = this.getSelectionBounds();
		if (!selection || this.hasOverlay() || this.deferViewportInput?.()) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${this.applySelectionHighlight(selected)}${after}`;
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashes = this.flashes.render(width).slice(-height);
		if (flashes.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashes.length; row++) {
			const line = flashes[row]!;
			const flashWidth = visibleWidth(line);
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		if (this.hasOverlay() || this.deferViewportInput?.()) this.cancelSelection();
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		const nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const imagesNeedRedraw = screen.some(
			(line, row) =>
				line !== this.previousScreen[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			buffer += `${this.deleteViewportKittyImages()}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			buffer += this.imageProtocol === "iterm2" ? "\x1b[2J" : this.deleteViewportKittyImages();
		}

		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K${screen[row] ?? ""}`;
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
	}
}
