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
 * masked the same way. This is the decision rule of the interactive screen-reader writer. Each
 * completed line is scanned once: the decision state is kept from one delta to the next.
 *
 * Masking consistency for streamed tool arguments: the argument text of a tool call whose arguments
 * the interactive view masks (the built-in tools) is held for the whole call. Its end releases one
 * delta, the masked JSON of the parsed arguments (the masker the final arguments go through). A call
 * that ends any other way releases the masked JSON of its argument text when that text parses, and
 * otherwise only the placeholder. Until then its partial argument text is empty and its partial
 * `arguments` are `{}`.
 *
 * `vinciMaskViewEvent` masks an RPC event in exactly the scope the interactive view masks.
 */

import { vinciMaskJson, vinciMaskSecrets } from "./vinci-mask-secrets.ts";

/** The most streamed lines an unclosed `${` holds back. */
const INTERPOLATION_HOLD_LINES = 20;

/** What a tool call whose held argument text does not parse releases in its place. */
const UNPARSED_ARGUMENTS = "‹redacted›";

const KEY_BLOCK_MARKER = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g;

type StreamedKind = "text" | "thinking";

interface HeldLine {
	index: number;
	/** Offset of the line's line break in the block's text. */
	end: number;
	keyBlock: boolean;
	interpolation: boolean;
	text: string;
}

interface BlockState {
	kind: StreamedKind;
	scanner: HoldScanner;
	/** The masked text emitted so far for this block. */
	shown: string;
	/** The block's end event was seen: everything is released. */
	done: boolean;
}

interface ToolCallState {
	/** The joined raw argument text of every `toolcall_delta` so far; it is never written. */
	raw: string;
	/** The masked argument text released (empty until the call is released). */
	shown: string;
	released: boolean;
	/** The arguments the call shows once released. */
	arguments: unknown;
}

/**
 * The built-in tools whose call header, preview, diff and output the interactive view masks
 * (tools/bash.ts output, tools/write.ts preview, components/diff.ts, and the vinci-render wrappers of
 * bash/read/grep/find/ls/edit/write). Arguments and results of other tools are rendered unmasked.
 */
const VIEW_MASKED_TOOLS = new Set(["bash", "read", "grep", "find", "ls", "edit", "write"]);

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

/** The `${` nesting depth at the end of `line`, starting from `from`. */
function interpolationDepth(line: string, from: number): number {
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
}

/** Whether a completed line could still be changed by the mask once later lines arrive. */
export function vinciLineMayChange(line: string, insideBlock: boolean): boolean {
	if (insideBlock) return true;
	const trimmed = line.trimEnd();
	return trimmed === "" || /[A-Za-z0-9+/=]$/.test(trimmed);
}

/**
 * The hold-back decision over one streamed text, kept from call to call: each completed line is
 * scanned once, and only the lines past the release point are kept. An open BEGIN block holds every
 * line until its END line; an unclosed `${` holds at most INTERPOLATION_HOLD_LINES lines and ends at a
 * completed blank line.
 */
class HoldScanner {
	/** Completed lines released, and the offset where the released text ends. */
	released = 0;
	releasedEnd = 0;
	/** Offset just past the last completed line scanned. */
	private end = 0;
	/** Offset up to which a line break was looked for. */
	private searched = 0;
	/** The text just before `end`, to recognise the same text extended. */
	private tail = "";
	private lines = 0;
	private keyBlock = false;
	private depth = 0;
	private runStart = -1;
	private held: HeldLine[] = [];
	private readonly work: { chars: number };

	constructor(work: { chars: number }) {
		this.work = work;
	}

	/** Scan the lines `raw` completed since the last call; whether the release point moved. */
	scan(raw: string): boolean {
		// A constant-size check per call; the counted work is the search for line breaks and the line scans.
		if (raw.length < this.searched || !raw.startsWith(this.tail, this.end - this.tail.length)) this.restart();
		const before = this.released;
		let from = Math.max(this.end, this.searched);
		for (;;) {
			const at = raw.indexOf("\n", from);
			if (at < 0) {
				this.work.chars += raw.length - from;
				this.searched = raw.length;
				break;
			}
			this.work.chars += at + 1 - from;
			this.line(raw.slice(this.end, at), at);
			this.end = at + 1;
			this.searched = this.end;
			from = this.end;
		}
		this.tail = raw.slice(Math.max(0, this.end - 16), this.end);
		if (this.released <= before) return false;
		let drop = 0;
		while (drop < this.held.length && this.held[drop].index < this.released) drop++;
		this.held.splice(0, drop);
		return true;
	}

	/** The text no longer extends what was scanned: scan it again from its start (released lines stay). */
	private restart(): void {
		this.end = 0;
		this.searched = 0;
		this.tail = "";
		this.lines = 0;
		this.keyBlock = false;
		this.depth = 0;
		this.runStart = -1;
		this.held = [];
	}

	private line(text: string, end: number): void {
		const index = this.lines++;
		this.work.chars += text.length;
		for (const match of text.matchAll(KEY_BLOCK_MARKER)) this.keyBlock = match[1] === "BEGIN";
		this.depth = interpolationDepth(text, this.depth);
		if (this.depth > 0 && this.runStart < 0) this.runStart = index;
		if (this.depth > 0 && (text.trim() === "" || index - this.runStart >= INTERPOLATION_HOLD_LINES)) {
			// The run ends here: its earlier lines no longer count as inside it.
			for (let i = this.held.length - 1; i >= 0 && this.held[i].index >= this.runStart; i--) {
				this.held[i].interpolation = false;
				this.settle(this.held[i]);
			}
			this.depth = interpolationDepth(text, 0);
			this.runStart = this.depth > 0 ? index : -1;
		}
		if (this.depth === 0) this.runStart = -1;
		if (index < this.released) return;
		const held: HeldLine = {
			index,
			end,
			keyBlock: this.keyBlock,
			interpolation: this.depth > 0,
			text,
		};
		this.held.push(held);
		this.settle(held);
	}

	/** Release up to `line` when nothing later can change it. */
	private settle(line: HeldLine): void {
		if (line.index + 1 > this.released && !vinciLineMayChange(line.text, line.keyBlock || line.interpolation)) {
			this.released = line.index + 1;
			this.releasedEnd = line.end;
		}
	}
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
	private tools = new Map<number, ToolCallState>();
	private latest: Json = undefined;
	private readonly mask: (text: string) => string;
	private readonly work = { chars: 0 };

	constructor(mask: (text: string) => string = vinciMaskSecrets) {
		this.mask = mask;
	}

	/** Characters the text hold-back has examined so far (a work measure for tests). */
	get scannedChars(): number {
		return this.work.chars;
	}

	/**
	 * The events to write in place of `event`. Text and thinking fields of a streaming assistant
	 * message hold only their released, masked text; a delta holds the masked text it releases (empty
	 * while held). A block's end, `message_end`, `agent_end` and a new assistant `message_start` are
	 * preceded by one synthesized delta per block that still had held text. Every other event passes
	 * through unchanged.
	 */
	process(event: Json): Json[] {
		switch (event?.type) {
			case "message_start":
				if (isAssistant(event.message)) {
					const held = this.flush();
					this.latest = event.message;
					return [...held, event];
				}
				return [event];
			case "message_update":
				if (isAssistant(event.message)) return this.update(event);
				return [event];
			case "message_end":
				if (isAssistant(event.message)) {
					const held = this.release(event.message);
					const end = this.endEvent(event);
					this.reset();
					return [...held, end];
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
		const held = this.latest && (this.blocks.size > 0 || this.tools.size > 0) ? this.release(this.latest) : [];
		this.reset();
		return held;
	}

	private reset(): void {
		this.blocks.clear();
		this.tools.clear();
		this.latest = undefined;
	}

	/** Advance `state` over `raw` and return the block's masked released text. */
	private advance(state: BlockState, raw: string): string {
		if (state.done) return this.mask(raw);
		if (!state.scanner.scan(raw)) return state.shown;
		const shown = this.mask(raw.slice(0, state.scanner.releasedEnd));
		// A later key body's END scan or a line-spanning run may still take the trailing whitespace
		// (including the `\r` of a CRLF line) of a released line.
		return shown.replace(/[ \t\r]+$/, "");
	}

	private toolStateFor(index: number, block: Json): ToolCallState | undefined {
		if (block?.type !== "toolCall" || !VIEW_MASKED_TOOLS.has(block.name)) return undefined;
		let state = this.tools.get(index);
		if (!state) {
			state = { raw: "", shown: "", released: false, arguments: {} };
			this.tools.set(index, state);
		}
		return state;
	}

	/**
	 * Release a held tool call once: `ended` holds the parsed arguments at the call's end; any other end
	 * parses the held text, and text that does not parse releases only the placeholder. Returns the
	 * released delta (empty when no argument text was streamed).
	 */
	private releaseTool(state: ToolCallState, ended: unknown): string {
		if (state.released) return "";
		state.released = true;
		let parsed = ended;
		if (parsed === undefined && state.raw.trim() !== "") {
			try {
				parsed = JSON.parse(state.raw);
			} catch {
				parsed = undefined;
			}
		}
		state.arguments = parsed ?? {};
		if (state.raw === "") state.shown = "";
		else state.shown = parsed === undefined ? UNPARSED_ARGUMENTS : JSON.stringify(vinciMaskJson(parsed));
		return state.shown;
	}

	/**
	 * A streaming tool call shows only what was released: its partial argument text is the released,
	 * masked text, and its arguments stay `{}` until the call is released.
	 */
	private toolBlock(block: Json, state: ToolCallState): Json {
		const shown: Json = { ...block };
		for (const field of ["partialJson", "partialArgs"]) {
			if (typeof block[field] === "string") shown[field] = state.shown;
		}
		shown.arguments = state.released ? state.arguments : {};
		return shown;
	}

	/** `message_end` as given, except that a held tool call's partial argument text is the released text. */
	private endEvent(event: Json): Json {
		const content = event.message.content;
		const carries = (block: Json, index: number) =>
			this.tools.has(index) && (typeof block?.partialJson === "string" || typeof block?.partialArgs === "string");
		if (!content.some(carries)) return event;
		const shown = content.map((block: Json, index: number) => {
			if (!carries(block, index)) return block;
			const masked = { ...block };
			const state = this.tools.get(index) as ToolCallState;
			for (const field of ["partialJson", "partialArgs"]) {
				if (typeof block[field] === "string") masked[field] = state.shown;
			}
			return masked;
		});
		return { ...event, message: { ...event.message, content: shown } };
	}

	private stateFor(index: number, kind: StreamedKind): BlockState {
		let state = this.blocks.get(index);
		if (!state || state.kind !== kind) {
			state = { kind, scanner: new HoldScanner(this.work), shown: "", done: false };
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
		const toolIndex =
			source?.type === "toolcall_start" || source?.type === "toolcall_delta" || source?.type === "toolcall_end"
				? (source.contentIndex as number)
				: -1;
		let toolAdded = "";
		const toolState = toolIndex >= 0 ? this.toolStateFor(toolIndex, message.content[toolIndex]) : undefined;
		if (toolState) {
			if (source.type === "toolcall_delta" && typeof source.delta === "string") toolState.raw += source.delta;
			if (source.type === "toolcall_end") {
				toolAdded = this.releaseTool(toolState, source.toolCall?.arguments ?? message.content[toolIndex]?.arguments);
			}
		}
		const added = new Map<number, string>();
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) {
				const tool = block?.type === "toolCall" ? this.tools.get(index) : undefined;
				return tool ? this.toolBlock(block, tool) : block;
			}
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
		if (toolAdded) out.push(this.toolDelta(masked, toolIndex, toolAdded));
		let rewritten = source;
		if (source && typeof source === "object") {
			rewritten = { ...source };
			if ("partial" in source) rewritten.partial = masked;
			if (source.type === "text_delta" || source.type === "thinking_delta") {
				rewritten.delta = added.get(source.contentIndex) ?? "";
			}
			if (toolState && source.type === "toolcall_delta") rewritten.delta = "";
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
		if ((this.blocks.size === 0 && this.tools.size === 0) || !isAssistant(message)) return [];
		const added = new Map<number, string>();
		const toolAdded = new Map<number, string>();
		for (const [index, state] of this.tools) {
			const text = this.releaseTool(state, undefined);
			if (text) toolAdded.set(index, text);
		}
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) {
				const tool = block?.type === "toolCall" ? this.tools.get(index) : undefined;
				return tool ? this.toolBlock(block, tool) : block;
			}
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
		return [
			...[...added].map(([index, text]) => this.delta(masked, index, text)),
			...[...toolAdded].map(([index, text]) => this.toolDelta(masked, index, text)),
		];
	}

	private toolDelta(masked: Json, index: number, text: string): Json {
		return {
			type: "message_update",
			message: masked,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta: text, partial: masked },
		};
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

/**
 * Mask one session message in the scope the interactive view masks: assistant text, thinking and
 * error text, built-in tool call arguments and built-in tool results. Other messages are unchanged.
 */
export function vinciMaskViewMessage(message: Json): Json {
	return maskMessage(message);
}

/**
 * Mask one session entry in the `get_messages` scope: a message entry's message goes through
 * vinciMaskViewMessage. Ids, parent ids, timestamps and every other entry kind (compaction and branch
 * summaries, custom and custom-message entries, labels, session info) are unchanged.
 */
export function vinciMaskViewEntry(entry: Json): Json {
	if (entry?.type !== "message" || !entry.message) return entry;
	return { ...entry, message: maskMessage(entry.message) };
}

/**
 * Mask the entries of a session tree with vinciMaskViewEntry; the nodes, children, labels and order are
 * unchanged. Iterative, like the tree's own construction: a long session is a deep chain.
 */
export function vinciMaskViewTree(roots: Json[]): Json[] {
	const copy = (node: Json): Json => {
		if (!node || typeof node !== "object") return node;
		return "entry" in node ? { ...node, entry: vinciMaskViewEntry(node.entry) } : { ...node };
	};
	const masked = roots.map(copy);
	const stack: Json[] = [...masked];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object" || !Array.isArray(node.children)) continue;
		node.children = node.children.map(copy);
		for (const child of node.children) stack.push(child);
	}
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
	// text_delta / thinking_delta and a built-in tool's toolcall_delta already carry released, masked
	// text (VinciStreamMask); other tools' deltas pass through, as the view leaves their arguments unmasked.
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
