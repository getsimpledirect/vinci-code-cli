/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

class VinciAccentComponent implements Component {
	private readonly component: Component;
	private readonly selected: boolean;
	private readonly muted: boolean;

	constructor(component: Component, selected = false, muted = false) {
		this.component = component;
		this.selected = selected;
		this.muted = muted;
	}

	invalidate(): void {
		this.component.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const bar = theme.fg(this.muted ? "dim" : "accent", `${this.selected ? "▌" : "▎"}${width > 1 ? " " : ""}`);
		const prefixWidth = width > 1 ? 2 : 1;
		if (width <= prefixWidth) return [truncateToWidth(bar, width, "")];
		return this.component.render(width - prefixWidth).map((line) => truncateToWidth(bar + line, width, ""));
	}
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;

		const vinci = process.env.VINCI_CODE === "1";
		const topBorder = new DynamicBorder(vinci ? (text) => theme.fg("accent", text) : undefined);
		this.addChild(vinci ? new VinciAccentComponent(topBorder) : topBorder);
		const topSpacer = new Spacer(1);
		this.addChild(vinci ? new VinciAccentComponent(topSpacer) : topSpacer);

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(vinci ? new VinciAccentComponent(this.titleText) : this.titleText);
		const titleSpacer = new Spacer(1);
		this.addChild(vinci ? new VinciAccentComponent(titleSpacer) : titleSpacer);

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		const listSpacer = new Spacer(1);
		this.addChild(vinci ? new VinciAccentComponent(listSpacer) : listSpacer);
		const hints = new Text(
			rawKeyHint("↑↓", "navigate") +
				"  " +
				keyHint("tui.select.confirm", "select") +
				"  " +
				keyHint("tui.select.cancel", "cancel"),
			1,
			0,
		);
		this.addChild(vinci ? new VinciAccentComponent(hints, false, true) : hints);
		const hintsSpacer = new Spacer(1);
		this.addChild(vinci ? new VinciAccentComponent(hintsSpacer) : hintsSpacer);
		const bottomBorder = new DynamicBorder(vinci ? (text) => theme.fg("accent", text) : undefined);
		this.addChild(vinci ? new VinciAccentComponent(bottomBorder) : bottomBorder);

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			if (process.env.VINCI_CODE === "1") {
				const text = isSelected
					? theme.fg("accent", "→ ") + theme.bold(theme.fg("accent", this.options[i]))
					: theme.fg("text", this.options[i]);
				this.listContainer.addChild(new VinciAccentComponent(new Text(text, 1, 0), isSelected, !isSelected));
			} else {
				const text = isSelected
					? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
					: `  ${theme.fg("text", this.options[i])}`;
				this.listContainer.addChild(new Text(text, 1, 0));
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
