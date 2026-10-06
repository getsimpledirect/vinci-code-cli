import { type Component, getKeybindings, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** [vinci] Review long approval context without exposing unreviewed affirmative choices. */
export class VinciContextReview implements Component {
	private page = 0;
	private renderedPage = -1;
	private visited = new Set<number>();
	private selected = 0;
	private layout = "";
	private pageCount = 1;
	private usable = false;
	private reviewed = false;
	private seconds: number | undefined;
	private readonly title: string;
	private readonly options: string[];
	private readonly dimensions: () => { width: number; rows: number };
	private readonly onSelect: (option: string) => void;
	private readonly onCancel: () => void;

	constructor(
		title: string,
		options: string[],
		dimensions: () => { width: number; rows: number },
		onSelect: (option: string) => void,
		onCancel: () => void,
	) {
		// Commands are data: show control bytes literally instead of letting them erase or move review text.
		this.title = title.replace(
			/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,
			(char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
		);
		this.options = options;
		this.dimensions = dimensions;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	invalidate(): void {}

	setCountdown(seconds: number): void {
		this.seconds = seconds;
	}

	render(width: number): string[] {
		const { rows } = this.dimensions();
		const layout = `${width}:${rows}`;
		if (layout !== this.layout) {
			this.layout = layout;
			this.page = 0;
			this.renderedPage = -1;
			this.visited.clear();
			this.selected = 0;
		}
		if (width <= 0 || rows <= 0) {
			this.usable = false;
			this.reviewed = false;
			return [];
		}
		const textLines = (text: string) => new Text(text, 0, 0).render(width);
		const context = textLines(this.title);
		const choices = this.options.flatMap((option, index) =>
			textLines(index === this.selected ? theme.fg("accent", `→ ${option}`) : `  ${option}`),
		);
		const hints = textLines(`↑↓ · ${keyText("tui.select.confirm")} select · ${keyText("tui.select.cancel")} cancel`);
		const countdown = this.seconds === undefined ? [] : [truncateToWidth(`Time left: ${this.seconds}s`, width, "")];
		const whole = [...context, "", ...choices, ...countdown, ...hints];
		this.usable = width >= 20;
		if (this.usable && whole.length <= rows) {
			this.reviewed = true;
			this.pageCount = 1;
			this.renderedPage = 0;
			return whole;
		}

		// Reserve every choice even before review so revealing choices never hides context.
		const navigation = textLines(`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} review`);
		const pageRows = rows - choices.length - hints.length - navigation.length - countdown.length - 1;
		this.usable &&= pageRows >= 2;
		if (!this.usable) {
			this.reviewed = false;
			this.selected = 0;
			return [
				...countdown,
				...textLines(
					`Resize to review\n${keyText("tui.select.confirm")} No · ${keyText("tui.select.cancel")} cancel`,
				),
			]
				.slice(0, rows)
				.map((line) => truncateToWidth(line, width, ""));
		}
		this.pageCount = Math.ceil(context.length / pageRows);
		this.page = Math.min(this.page, this.pageCount - 1);
		this.visited.add(this.page);
		this.renderedPage = this.page;
		this.reviewed = this.visited.size === this.pageCount;
		const visibleContext = context.slice(this.page * pageRows, (this.page + 1) * pageRows);
		while (visibleContext.length < pageRows) visibleContext.push("");
		const status = truncateToWidth(
			`Review ${this.page + 1}/${this.pageCount}${this.reviewed ? " · complete" : " · more below"}`,
			width,
			"",
		);
		return [
			...visibleContext,
			status,
			...navigation,
			...(this.reviewed ? choices : textLines(theme.fg("accent", `→ ${this.options[0]}`))),
			...countdown,
			...hints,
		];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		const { width, rows } = this.dimensions();
		// Resize can arrive before paint. Never use an approval selected in the old layout.
		if (this.layout !== `${width}:${rows}`) {
			this.selected = 0;
			this.reviewed = false;
			if (kb.matches(data, "tui.select.confirm") || data === "\n") this.onSelect(this.options[0]);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.onSelect(this.options[this.reviewed ? this.selected : 0]);
		} else if (this.usable && this.renderedPage === this.page && kb.matches(data, "tui.select.pageDown")) {
			this.page = Math.min(this.pageCount - 1, this.page + 1);
		} else if (this.usable && this.renderedPage === this.page && kb.matches(data, "tui.select.pageUp")) {
			this.page = Math.max(0, this.page - 1);
		} else if (this.reviewed && (kb.matches(data, "tui.select.up") || data === "k")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (this.reviewed && (kb.matches(data, "tui.select.down") || data === "j")) {
			this.selected = Math.min(this.options.length - 1, this.selected + 1);
		}
	}
}
