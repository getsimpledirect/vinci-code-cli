import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getOverflowPatterns, isContextOverflow } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { vinciMaskSecrets } from "../../../core/vinci-mask-secrets.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

// [vinci] raw provider error JSON (a 400/429/500, a socket error) alarms a non-programmer for nothing
// ("spoiling the fun"). Under VINCI_CODE we replace the KNOWN, non-actionable-as-raw-text categories
// with a calm human line. A truly unknown error still shows raw, so real problems surface (and stay
// debuggable).
const VINCI = process.env.VINCI_CODE === "1";
// VINCI: a small model will sometimes read a secret (it needs the real value to edit a .env) and then
// helpfully ECHO it back in its prose — "the key is sk-ant-…" — painting it on screen. Mask the
// model's own text/thinking at render, the same way we mask edit diffs. Display-only: the message and
// what the model reasons over keep the real value; only the on-screen string is redacted.
const vinciMaskOut = (s: string): string => (VINCI ? vinciMaskSecrets(s) : s);
const VINCI_OVERFLOW_LINE = "Context filled up — condensing the history and picking up where I left off…";
function vinciCalmsOverflow(message: AssistantMessage): boolean {
	if (!VINCI || !message.errorMessage) return false;
	// isContextOverflow covers the canonical stopReason==="error" case (the exact condition the
	// auto-recovery keys on). The extra checks catch an aborted-mid-overflow turn and the underscore
	// form our own gateway returns ("context_length_exceeded: 400: …").
	if (isContextOverflow(message)) return true;
	const em = message.errorMessage;
	return /context[_ ]length[_ ]exceeded/i.test(em) || getOverflowPatterns().some((p) => p.test(em));
}

// Map the transient / connection / auth categories to a calm line + tone. Returns null for anything
// unrecognized so genuinely novel errors still show raw. (Pi already retries 429s/5xx with backoff —
// this only softens the message the user sees once retries are exhausted or a request truly fails.)
export function vinciFriendlyError(
	errorMessage?: string,
	vinci = VINCI,
): { text: string; tone: "muted" | "warning" } | null {
	if (!vinci || !errorMessage) return null;
	const m = errorMessage;
	if (/\b429\b|rate[_ ]?limit|too many requests|server busy|overloaded|quota/i.test(m)) {
		return { text: "Vinci's servers are busy right now — give it a moment and try again.", tone: "muted" };
	}
	if (/Provider stream timed out after \d+ms without (?:an|a content) event/i.test(m)) {
		return {
			text: "Vinci's provider stopped responding. Continue to retry from where it paused.",
			tone: "muted",
		};
	}
	// Server-side trouble (a 5xx, a request timeout, a dropped/reset connection to OUR provider) is NOT
	// the user's network — telling them to "check your connection" blames them for our outage and sends
	// them chasing their wifi. Own it, and reassure them their work is safe. Checked BEFORE the
	// client-connection branch so a timeout/5xx never falls through to the "check your connection" copy.
	if (/\b5\d\d\b|timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|EPIPE/i.test(m)) {
		return {
			text: "Vinci's servers are having trouble right now — this is on our end, not your setup. Your progress is saved; give it a moment and try again.",
			tone: "muted",
		};
	}
	// Genuine client-side network failures (DNS can't resolve, connection refused, offline) — here
	// "check your connection" is the right, actionable advice.
	if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|dns/i.test(m)) {
		return { text: "Vinci couldn't reach its servers — check your connection and try again.", tone: "muted" };
	}
	if (
		/\b401\b|\b403\b|unauthor|forbidden|invalid[_ ].*(api[_ ]?key|token|credential)|not signed in|authentication/i.test(
			m,
		)
	) {
		return { text: "Vinci isn't connected. Run /login vinci to reconnect.", tone: "warning" };
	}
	return null; // unknown → fall through to the raw error so it still surfaces
}

export function vinciRetryFailureMessage(attempt: number, finalError: string | undefined, vinci = VINCI): string {
	if (
		vinci &&
		finalError &&
		/Provider stream timed out after \d+ms without (?:an|a content) event/i.test(finalError)
	) {
		return `Vinci's provider stopped responding after ${attempt} attempts. Continue to retry from where it paused.`;
	}
	// A bare "Request timed out" / 5xx / reset after exhausting retries used to leak through as the raw
	// "Retry failed after N attempts: Request timed out." — technical and alarming for a non-programmer,
	// and (again) a server-side problem. Soften it and reassure, without pretending it succeeded.
	if (
		vinci &&
		finalError &&
		/\b5\d\d\b|timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|EPIPE/i.test(finalError)
	) {
		return `Vinci's servers didn't respond after ${attempt} attempts — this is on our end. Your progress is saved; try again in a moment.`;
	}
	return `Retry failed after ${attempt} attempts: ${finalError || "Unknown error"}`;
}

// VINCI: render a failure as a calm, designed line — a soft left accent bar carries the tone (red /
// amber / muted) while the message stays readable — so it reads as "handled", not an alarming raw
// dump (the guide: errors are styled blocks with a next step, not bare red text). Off → plain line.
function vinciErrorLine(text: string, tone: "muted" | "warning" | "error"): string {
	if (!VINCI) return theme.fg(tone, text);
	return theme.fg(tone, "▎ ") + theme.fg(tone === "muted" ? "muted" : "text", text);
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(vinciMaskOut(content.text.trim()), this.outputPad, 0, this.markdownTheme),
				);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(vinciMaskOut(content.thinking.trim()), this.outputPad, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					vinciErrorLine(
						VINCI
							? process.env.VINCI_NO_AUTOCONTINUE === "1"
								? "Vinci reached its reply-length limit — the reply may be cut off. Ask it to keep going."
								: "Vinci hit its reply-length limit — continuing the answer…"
							: "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
						"warning",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (vinciCalmsOverflow(message)) {
				// Recoverable context overflow — a calm, muted line instead of the raw 400.
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(vinciErrorLine(VINCI_OVERFLOW_LINE, "muted"), this.outputPad, 0));
			} else if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(vinciErrorLine(abortMessage, "muted"), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const friendly = vinciFriendlyError(message.errorMessage);
				this.contentContainer.addChild(new Spacer(1));
				if (friendly) {
					this.contentContainer.addChild(
						new Text(vinciErrorLine(friendly.text, friendly.tone), this.outputPad, 0),
					);
				} else {
					const errorMsg = message.errorMessage || "Unknown error";
					this.contentContainer.addChild(
						new Text(vinciErrorLine(`Error: ${errorMsg}`, "error"), this.outputPad, 0),
					);
				}
			}
		}
	}
}
