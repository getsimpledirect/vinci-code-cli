import { type Component, Loader, type TUI } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { formatDuration } from "../../../utils/format-duration.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer, ElapsedTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) => {
			const duration = formatDuration(seconds * 1000);
			return process.env.VINCI_CODE === "1"
				? `Provider response paused — reconnecting (${attempt}/${maxAttempts}) in ${duration}... (${keyText("app.interrupt")} to cancel)`
				: `Retrying (${attempt}/${maxAttempts}) in ${duration}... (${keyText("app.interrupt")} to cancel)`;
		};
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	private elapsedTimer: ElapsedTimer | undefined;

	constructor(ui: TUI, reason: CompactionStatusReason, tokens?: number) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		// [vinci] Reframe compaction as calm housekeeping (matches vinci-compact.ts) — no scary
		// "Context overflow detected". Upstream wording when VINCI_CODE is unset.
		const vinci = process.env.VINCI_CODE === "1";
		const vinciLabel = (elapsedMs: number) => {
			const tokenProgress = tokens === undefined ? "" : ` · ↓ ${formatTokens(tokens)} tokens`;
			return `Tidying up our conversation… (${formatDuration(elapsedMs, { rounding: "floor" })}${tokenProgress}) ${cancelHint}`;
		};
		const upstreamLabel =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			vinci ? vinciLabel(0) : upstreamLabel,
		);
		if (vinci) this.elapsedTimer = new ElapsedTimer(ui, (elapsedMs) => this.setMessage(vinciLabel(elapsedMs)));
	}

	override dispose(): void {
		this.elapsedTimer?.dispose();
		this.elapsedTimer = undefined;
		super.dispose();
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
