/**
 * Mask streamed output consistently (`--mode json` and `--mode rpc`, under VINCI_CODE=1).
 *
 * The secret mask decides some values only once later lines are present: a private-key body is
 * masked back from its END line, multi-line base64 is checked on its decoded whole, and hex runs
 * span line breaks; an assignment's `${` value runs to its closing brace. Masking each streamed
 * event alone would therefore emit the first lines of such a value before the mask can see it.
 *
 * `VinciStreamMask` holds back, per text or thinking block of the streaming assistant message, the
 * trailing completed lines a later line could still change: one inside an open BEGIN block or `${`,
 * a blank one, or one ending in a base64, hex or key-body character. The held run is released by the
 * next line that cannot belong to it; the block's released text is then masked whole. A block's end
 * (`text_end` / `thinking_end`), `message_end`, `agent_end` and every exit path release everything,
 * masked the same way. This is the decision rule of the interactive screen-reader writer.
 *
 * `vinciMaskViewEvent` masks an RPC event in exactly the scope the interactive view masks.
 */

import { vinciMaskJson, vinciMaskSecrets } from "./vinci-mask-secrets.ts";

/** The most streamed lines an unclosed `${` holds back. */
const INTERPOLATION_HOLD_LINES = 20;

type StreamedKind = "text" | "thinking";

interface BlockState {
	kind: StreamedKind;
	/** Raw lines released so far. */
	released: number;
	/** The masked text emitted so far for this block. */
	shown: string;
	/** The block's end event was seen: everything is released. */
	done: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: events are opaque JSON-shaped values here.
type Json = any;

function streamedKind(block: Json): StreamedKind | undefined {
	if (block?.type === "text" && typeof block.text === "string") return "text";
	if (block?.type === "thinking" && typeof block.thinking === "string") return "thinking";
	return undefined;
}

function isAssistant(message: Json): boolean {
	return message?.role === "assistant" && Array.isArray(message.content);
}

/** For each line: whether a private-key BEGIN block is still open at its end. */
export function vinciOpenKeyBlocks(lines: string[]): boolean[] {
	const marker = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g;
	let open = false;
	return lines.map((line) => {
		for (const match of line.matchAll(marker)) open = match[1] === "BEGIN";
		return open;
	});
}

/**
 * For each line: whether a `${` opened so far is still unclosed at its end. An unclosed `${` holds
 * at most INTERPOLATION_HOLD_LINES lines and ends at a completed blank line.
 */
export function vinciOpenInterpolations(lines: string[]): boolean[] {
	const open: boolean[] = [];
	const scan = (line: string, from: number): number => {
		let depth = from;
		for (let i = 0; i < line.length; i++) {
			if (line.startsWith("${", i)) {
				depth++;
				i++;
			} else if (line[i] === "}" && depth > 0) {
				depth--;
			}
		}
		return depth;
	};
	let depth = 0;
	let runStart = -1;
	for (const [index, line] of lines.entries()) {
		depth = scan(line, depth);
		if (depth > 0 && runStart < 0) runStart = index;
		// The last line is still streaming: only a completed line ends the run.
		const completed = index < lines.length - 1;
		const blank = line.trim() === "";
		if (depth > 0 && completed && (blank || index - runStart >= INTERPOLATION_HOLD_LINES)) {
			open.fill(false, runStart);
			depth = scan(line, 0);
			runStart = depth > 0 ? index : -1;
		}
		if (depth === 0) runStart = -1;
		open.push(depth > 0);
	}
	return open;
}

/** Whether a completed line could still be changed by the mask once later lines arrive. */
export function vinciLineMayChange(line: string, insideBlock: boolean): boolean {
	if (insideBlock) return true;
	const trimmed = line.trimEnd();
	return trimmed === "" || /[A-Za-z0-9+/=]$/.test(trimmed);
}

/** The text `next` adds after `before`; when the mask rewrote emitted text, the rewritten tail. */
function addedText(before: string, next: string): string {
	if (next.startsWith(before)) return next.slice(before.length);
	let same = 0;
	while (same < before.length && same < next.length && before[same] === next[same]) same++;
	return next.slice(same);
}

export class VinciStreamMask {
	private blocks = new Map<number, BlockState>();
	private latest: Json = undefined;
	private readonly mask: (text: string) => string;

	constructor(mask: (text: string) => string = vinciMaskSecrets) {
		this.mask = mask;
	}

	/**
	 * The events to write in place of `event`. Text and thinking fields of a streaming assistant
	 * message hold only their released, masked text; a delta holds the masked text it releases (empty
	 * while held). A block's end, `message_end` and `agent_end` are preceded by one synthesized delta
	 * per block that still had held text. Every other event passes through unchanged.
	 */
	process(event: Json): Json[] {
		switch (event?.type) {
			case "message_start":
				if (isAssistant(event.message)) {
					this.reset();
					this.latest = event.message;
				}
				return [event];
			case "message_update":
				if (isAssistant(event.message)) return this.update(event);
				return [event];
			case "message_end":
				if (isAssistant(event.message)) {
					const held = this.release(event.message);
					this.reset();
					return [...held, event];
				}
				return [event];
			case "agent_end":
				return [...this.flush(), event];
			default:
				return [event];
		}
	}

	/** Release whatever the streaming message still holds, masked (exit paths call this). */
	flush(): Json[] {
		const held = this.latest && this.blocks.size > 0 ? this.release(this.latest) : [];
		this.reset();
		return held;
	}

	private reset(): void {
		this.blocks.clear();
		this.latest = undefined;
	}

	/** Advance `state` over `raw` and return the block's masked released text. */
	private advance(state: BlockState, raw: string): string {
		const lines = raw.split("\n");
		let release = state.done ? lines.length : state.released;
		if (!state.done) {
			const keyBlock = vinciOpenKeyBlocks(lines);
			const interpolation = vinciOpenInterpolations(lines);
			for (let i = state.released; i < lines.length - 1; i++) {
				if (!vinciLineMayChange(lines[i], keyBlock[i] || interpolation[i])) release = i + 1;
			}
			if (release <= state.released) return state.shown;
		}
		state.released = release;
		const shown = this.mask(lines.slice(0, release).join("\n"));
		// A later key body's END scan may still take the trailing whitespace of a released line.
		return state.done ? shown : shown.replace(/[ \t]+$/, "");
	}

	private stateFor(index: number, kind: StreamedKind): BlockState {
		let state = this.blocks.get(index);
		if (!state || state.kind !== kind) {
			state = { kind, released: 0, shown: "", done: false };
			this.blocks.set(index, state);
		}
		return state;
	}

	private update(event: Json): Json[] {
		const message = event.message;
		this.latest = message;
		const source = event.assistantMessageEvent;
		const ending =
			source?.type === "text_end" || source?.type === "thinking_end" ? (source.contentIndex as number) : -1;
		const added = new Map<number, string>();
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) return block;
			const state = this.stateFor(index, kind);
			if (index === ending) state.done = true;
			const shown = this.advance(state, block[kind]);
			added.set(index, addedText(state.shown, shown));
			state.shown = shown;
			return { ...block, [kind]: shown };
		});
		const masked = { ...message, content };
		const out: Json[] = [];
		const endingAdded = added.get(ending);
		if (endingAdded) out.push(this.delta(masked, ending, endingAdded));
		let rewritten = source;
		if (source && typeof source === "object") {
			rewritten = { ...source };
			if ("partial" in source) rewritten.partial = masked;
			if (source.type === "text_delta" || source.type === "thinking_delta") {
				rewritten.delta = added.get(source.contentIndex) ?? "";
			}
			if (ending >= 0 && added.has(ending)) {
				const block = content[ending];
				rewritten.content = block[streamedKind(block) as StreamedKind];
			}
		}
		out.push({ ...event, message: masked, assistantMessageEvent: rewritten });
		return out;
	}

	/** One synthesized delta per block of `message` that still held text, all of it released and masked. */
	private release(message: Json): Json[] {
		if (this.blocks.size === 0 || !isAssistant(message)) return [];
		const added = new Map<number, string>();
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) return block;
			const state = this.blocks.get(index);
			if (!state || state.kind !== kind) return { ...block, [kind]: this.mask(block[kind]) };
			state.done = true;
			const shown = this.advance(state, block[kind]);
			const text = addedText(state.shown, shown);
			if (text) added.set(index, text);
			state.shown = shown;
			return { ...block, [kind]: shown };
		});
		const masked = { ...message, content };
		return [...added].map(([index, text]) => this.delta(masked, index, text));
	}

	private delta(masked: Json, index: number, text: string): Json {
		const kind = streamedKind(masked.content[index]);
		return {
			type: "message_update",
			message: masked,
			assistantMessageEvent: {
				type: kind === "thinking" ? "thinking_delta" : "text_delta",
				contentIndex: index,
				delta: text,
				partial: masked,
			},
		};
	}
}

// ---------------------------------------------------------------------------------------------------
// RPC scope: exactly what the interactive view masks.
// ---------------------------------------------------------------------------------------------------

/**
 * The built-in tools whose call header, preview, diff and output the interactive view masks
 * (tools/bash.ts output, tools/write.ts preview, components/diff.ts, and the vinci-render wrappers of
 * bash/read/grep/find/ls/edit/write). Results of other tools are rendered unmasked by the view.
 */
const VIEW_MASKED_TOOLS = new Set(["bash", "read", "grep", "find", "ls", "edit", "write"]);

function maskText(value: unknown): unknown {
	return typeof value === "string" ? vinciMaskSecrets(value) : value;
}

function maskToolOutput(result: Json): Json {
	if (!result || typeof result !== "object") return result;
	const masked = { ...result };
	if (Array.isArray(result.content)) {
		masked.content = result.content.map((part: Json) =>
			part?.type === "text" && typeof part.text === "string" ? { ...part, text: vinciMaskSecrets(part.text) } : part,
		);
	}
	if (result.details && typeof result.details === "object" && typeof result.details.diff === "string") {
		masked.details = { ...result.details, diff: vinciMaskSecrets(result.details.diff) };
	}
	return masked;
}

function maskAssistantMessage(message: Json): Json {
	const content = message.content.map((block: Json) => {
		const kind = streamedKind(block);
		if (kind) return { ...block, [kind]: vinciMaskSecrets(block[kind]) };
		if (block?.type === "toolCall" && VIEW_MASKED_TOOLS.has(block.name)) {
			return { ...block, arguments: vinciMaskJson(block.arguments) };
		}
		return block;
	});
	const masked = { ...message, content };
	if (typeof message.errorMessage === "string") masked.errorMessage = vinciMaskSecrets(message.errorMessage);
	return masked;
}

function maskMessage(message: Json): Json {
	if (isAssistant(message)) return maskAssistantMessage(message);
	if (message?.role === "toolResult" && VIEW_MASKED_TOOLS.has(message.toolName)) return maskToolOutput(message);
	return message;
}

function maskAssistantEvent(source: Json): Json {
	if (!source || typeof source !== "object") return source;
	const masked = { ...source };
	if (source.partial) masked.partial = maskMessage(source.partial);
	if (source.message) masked.message = maskMessage(source.message);
	if (source.error) masked.error = maskMessage(source.error);
	if (source.type === "text_end" || source.type === "thinking_end") masked.content = maskText(source.content);
	if (source.type === "toolcall_end" && source.toolCall && VIEW_MASKED_TOOLS.has(source.toolCall.name)) {
		masked.toolCall = { ...source.toolCall, arguments: vinciMaskJson(source.toolCall.arguments) };
	}
	if (source.type === "toolcall_delta") {
		const call = source.partial?.content?.[source.contentIndex];
		if (call?.type === "toolCall" && VIEW_MASKED_TOOLS.has(call.name)) masked.delta = maskText(source.delta);
	}
	// text_delta / thinking_delta already carry released, masked text (VinciStreamMask).
	return masked;
}

/**
 * Mask one RPC session event in the scope the interactive view masks: assistant text, thinking and
 * error text; the arguments and output of the built-in tools. User messages, user shell commands,
 * other tools' arguments and output, compaction summaries, retry errors and extension events pass
 * through unchanged, as the view renders them unmasked.
 */
export function vinciMaskViewEvent(event: Json): Json {
	switch (event?.type) {
		case "message_start":
		case "message_end":
			return { ...event, message: maskMessage(event.message) };
		case "message_update":
			return {
				...event,
				message: maskMessage(event.message),
				assistantMessageEvent: maskAssistantEvent(event.assistantMessageEvent),
			};
		case "turn_end":
			return {
				...event,
				message: maskMessage(event.message),
				toolResults: Array.isArray(event.toolResults) ? event.toolResults.map(maskMessage) : event.toolResults,
			};
		case "agent_end":
			return { ...event, messages: Array.isArray(event.messages) ? event.messages.map(maskMessage) : event.messages };
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			if (!VIEW_MASKED_TOOLS.has(event.toolName)) return event;
			const masked = { ...event };
			if ("args" in event) masked.args = vinciMaskJson(event.args);
			if ("partialResult" in event) masked.partialResult = maskToolOutput(event.partialResult);
			if ("result" in event) masked.result = maskToolOutput(event.result);
			return masked;
		}
		default:
			return event;
	}
}
