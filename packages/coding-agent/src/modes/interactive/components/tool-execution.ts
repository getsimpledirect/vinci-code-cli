import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { sanitizeTerminalLabel } from "../../../terminal-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		// [vinci] Vinci's theme drops the tool background panels (tool*Bg = terminal default), which
		// turns the panel's vertical padding + this leading spacer into ~4 lines of dead air between
		// blocks. Tighten to zero — the chat container's own spacer keeps one line between blocks.
		const vinciTight = process.env.VINCI_CODE === "1";
		if (!vinciTight) this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		// [vinci] No background panels at all under VINCI_CODE — Vinci's theme repurposes the tool*Bg
		// tokens as DIFF ROW tints (see components/diff.ts), so the panels must not paint them.
		this.contentBox = new Box(
			1,
			vinciTight ? 0 : 1,
			vinciTight ? undefined : (text: string) => theme.bg("toolPendingBg", text),
		);
		this.contentText = new Text(
			"",
			1,
			vinciTight ? 0 : 1,
			vinciTight ? undefined : (text: string) => theme.bg("toolPendingBg", text),
		);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		const configuredLabel = this.toolDefinition?.label ?? this.builtInToolDefinition?.label;
		const plainLabel =
			configuredLabel || this.toolName.replace(/[_-]+/g, " ").replace(/^./, (first) => first.toUpperCase());
		// [vinci] Give tools without custom renderers the same semantic timeline as built-in tools.
		if (process.env.VINCI_CODE === "1") {
			return new Text(theme.fg("accent", "● ") + theme.fg("toolTitle", theme.bold(plainLabel)), 0, 0);
		}
		return new Text(theme.fg("toolTitle", theme.bold(plainLabel)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		if (process.env.VINCI_CODE === "1") {
			if (this.toolName === "rerun_check") {
				const rawDetails = this.result?.details;
				const details =
					typeof rawDetails === "object" && rawDetails !== null && !Array.isArray(rawDetails)
						? (rawDetails as {
								passed?: unknown;
								killed?: unknown;
								stopped?: unknown;
								unsafeReplay?: unknown;
							})
						: undefined;
				const malformedFlag =
					details !== undefined &&
					[details.passed, details.killed, details.stopped, details.unsafeReplay].some(
						(value) => value !== undefined && typeof value !== "boolean",
					);
				const status =
					details === undefined ||
					malformedFlag ||
					typeof details.passed !== "boolean" ||
					details.killed === true ||
					details.stopped === true ||
					details.unsafeReplay === true
						? "neutral"
						: this.result?.isError === true
							? "failed"
							: details.passed === true
								? "passed"
								: "failed";
				const marker =
					status === "passed"
						? theme.fg("success", "  └ ✓ ")
						: status === "failed"
							? theme.fg("error", "  └ ! ")
							: theme.fg("dim", "  └ ");
				if (this.expanded) {
					const color = status === "failed" ? "error" : status === "neutral" ? "muted" : "toolOutput";
					return new Text(marker + theme.fg(color, output), 0, 0);
				}
				const lines = output
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean);
				const firstLine = lines[0] ?? "Finished.";
				const summary = sanitizeTerminalLabel(firstLine, 60);
				const expansion = lines.length > 1 ? theme.fg("dim", `  ·  ${lines.length} lines, ctrl+o to expand`) : "";
				const color = status === "failed" ? "error" : "muted";
				return new Text(marker + theme.fg(color, summary) + expansion, 0, 0);
			}
			const isError = this.result?.isError ?? false;
			const marker = isError ? theme.fg("error", "  └ ! ") : theme.fg("success", "  └ ✓ ");
			if (this.expanded) return new Text(marker + theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
			const lines = output
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const firstLine = lines[0] ?? (isError ? "The action didn't work." : "Finished.");
			const summary = sanitizeTerminalLabel(firstLine, 60);
			const expansion = lines.length > 1 ? theme.fg("dim", `  ·  ${lines.length} lines, ctrl+o to expand`) : "";
			return new Text(marker + theme.fg(isError ? "error" : "muted", summary) + expansion, 0, 0);
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		// [vinci] see constructor — no state-colored panels under VINCI_CODE (tokens repurposed).
		const bgFn =
			process.env.VINCI_CODE === "1"
				? undefined
				: this.isPartial
					? (text: string) => theme.bg("toolPendingBg", text)
					: this.result?.isError
						? (text: string) => theme.bg("toolErrorBg", text)
						: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const displayResult = this.getDisplayResult() ?? this.result;
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: displayResult.content as any, details: displayResult.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.getDisplayResult(), this.showImages);
	}

	private getDisplayResult(): typeof this.result {
		// [vinci] Hook reasons may contain model-only loop/planning guidance. Preserve it in the agent
		// result while replacing only the display copy with a stable user-facing explanation.
		if (
			process.env.VINCI_CODE === "1" &&
			this.result &&
			typeof this.result.details === "object" &&
			this.result.details !== null &&
			(this.result.details as { vinciBlocked?: unknown }).vinciBlocked === true
		) {
			return {
				...this.result,
				content: [{ type: "text", text: "Vinci paused this action before it ran." }],
			};
		}
		return this.result;
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
