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
 * `arguments` are `{}`. A call whose name has not arrived yet is held the same way: a non-built-in name
 * releases the held text unchanged, and a call that ends with no name is released masked. A tool-name
 * synonym of a built-in tool (which the agent loop folds onto the tool only when the stream ends) is
 * classified as that tool from the moment the name is known. A completed call that still carries partial
 * argument text (in its `toolcall_end` call or a final message) carries the masked JSON of its arguments there.
 *
 * An interrupted call is a held call released without its `toolcall_end` (by `message_end`, `agent_end`,
 * the next `message_start`, a stream-ending source event or an exit path). In the final events that
 * carry it (`message_end`, `turn_end`, `agent_end`, a source `error`/`done` message) and in the
 * transcript responses, each string value of its arguments keeps only the lines the hold-back would
 * have released; from the first line it would still hold to the value's end, it is the placeholder. Any
 * partial argument text the call still carries there is the placeholder. A tool-call event whose content
 * index names no tool-call block is taken to be about the call with its id, else (see TOOL_FALLBACK) a
 * call the view masks when there is one, so its text is held.
 *
 * `vinciMaskViewEvent` masks an RPC event in exactly the scope the interactive view masks.
 */

import { vinciCanonicalToolName } from "@earendil-works/pi-agent-core";
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
	/**
	 * Some of its text came from an event that named no call (taken by the fallback; it may be another
	 * call's): nothing is released, it shows no arguments, and a built-in call is interrupted at the end.
	 */
	guessed?: boolean;
}

/**
 * The built-in tools whose call header, preview, diff and output the interactive view masks
 * (tools/bash.ts output, tools/write.ts preview, components/diff.ts, and the vinci-render wrappers of
 * bash/read/grep/find/ls/edit/write). Arguments and results of other tools are rendered unmasked.
 */
const VIEW_MASKED_TOOLS = new Set(["bash", "read", "grep", "find", "ls", "edit", "write"]);

// biome-ignore lint/suspicious/noExplicitAny: events are opaque JSON-shaped values here.
type Json = any;

/** Whether a tool call's name is known: a non-empty string. */
function hasName(block: Json): boolean {
	return typeof block?.name === "string" && block.name !== "";
}

/**
 * A built-in tool, or a tool-name synonym of one (mapped whatever tools the turn has: the over-mask side).
 */
function viewMasksTool(name: unknown): boolean {
	return typeof name === "string" && VIEW_MASKED_TOOLS.has(vinciCanonicalToolName(name));
}

/** A built-in tool, or a call whose name is not known (masked like a built-in: the over-mask side). */
function viewMasksCall(block: Json): boolean {
	return !hasName(block) || viewMasksTool(block.name);
}

/** An event's content index as a number: a numeric string is read as its number; anything else is -1. */
function contentIndexOf(source: Json): number {
	const raw = source?.contentIndex;
	if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
	if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
	return -1;
}

/**
 * The content block a streamed event is about: its content index, or, when that is missing (or, with
 * `checkKind`, names no block of the event's kind), the block with the event's tool-call id, else the
 * last block the first of `prefer` that accepts one picks (in order), else the last block of the event's kind
 * (the one being streamed).
 */
function blockIndexOf(
	source: Json,
	content: Json[],
	matches: (block: Json) => boolean,
	checkKind = false,
	prefer: ((block: Json) => boolean)[] = [],
): number {
	const index = contentIndexOf(source);
	if (index >= 0 && (!checkKind || matches(content[index]))) return index;
	const id = source?.toolCall?.id;
	if (typeof id === "string" && id !== "") {
		const at = content.findIndex((block) => block?.type === "toolCall" && block.id === id);
		if (at >= 0) return at;
	}
	for (const accepts of prefer) for (let at = content.length - 1; at >= 0; at--) if (accepts(content[at])) return at;
	for (let at = content.length - 1; at >= 0; at--) if (matches(content[at])) return at;
	return -1;
}

/**
 * The tool-call fallback when the content index names no call and the event carries no id: a call the view
 * masks that still carries its streaming argument text (a provider drops it once the call ends), else any
 * call the view masks, else a call that still carries streaming text. So an unidentified call's text is
 * held whenever any call in the message is one the view masks.
 */
const TOOL_FALLBACK = [
	(block: Json) => isStreamingCall(block) && viewMasksCall(block),
	(block: Json) => block?.type === "toolCall" && viewMasksCall(block),
	(block: Json) => isStreamingCall(block),
];

/**
 * A streaming message's block with no tool-call state: a call the view masks shows no arguments and empty
 * partial text, as a held call does (its own events went to another call); any other block is unchanged.
 */
function untrackedCallBlock(block: Json, held = false): Json {
	if (block?.type !== "toolCall" || (!held && !viewMasksCall(block))) return block;
	const shown: Json = { ...block, arguments: {} };
	for (const field of ["partialJson", "partialArgs"]) {
		if (typeof block[field] === "string") shown[field] = "";
	}
	return shown;
}

/** Whether a tool event names the call at `index` itself: by its content index, or by its call id. */
function namesToolCall(source: Json, content: Json[], index: number): boolean {
	if (contentIndexOf(source) === index) return true;
	const id = source?.toolCall?.id;
	return typeof id === "string" && id !== "" && content[index]?.id === id;
}

/** A tool call that still carries its streaming argument text. */
function isStreamingCall(block: Json): boolean {
	return block?.type === "toolCall" && (typeof block.partialJson === "string" || typeof block.partialArgs === "string");
}

/**
 * One argument value of an interrupted call: the lines the hold-back would have released, then the
 * placeholder in place of the first line it would still hold and everything after it. A last line with
 * no line break is still held (the value may have been cut inside it), so only a value ending in a
 * released line break is unchanged.
 */
export function vinciOverMaskHeldValue(text: string): string {
	if (text === "") return text;
	const scanner = new HoldScanner({ chars: 0 });
	scanner.scan(text);
	if (scanner.released > 0 && scanner.releasedEnd + 1 >= text.length) return text;
	const kept = scanner.released > 0 ? text.slice(0, scanner.releasedEnd + 1) : "";
	return `${kept}${UNPARSED_ARGUMENTS}`;
}

/** Every string value of `value` (at any depth) through vinciOverMaskHeldValue; keys and other values unchanged. */
function overMaskArguments(value: unknown): unknown {
	if (typeof value === "string") return vinciOverMaskHeldValue(value);
	if (Array.isArray(value)) return value.map(overMaskArguments);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, overMaskArguments(entry)]));
	}
	return value;
}

/**
 * A completed built-in call's retained partial argument text (`partialJson` / `partialArgs`, a non-empty
 * string): the masked JSON of its arguments, the text its released delta carries. Other blocks, an empty
 * text and an interrupted call's placeholder are kept as given (the same object when nothing changes).
 */
function maskCompletedPartial(block: Json): Json {
	if (block?.type !== "toolCall" || !viewMasksCall(block)) return block;
	if (isCutCall(block)) return maskCutCall(block);
	let shown = block;
	for (const field of ["partialJson", "partialArgs"]) {
		const text = block[field];
		if (typeof text !== "string" || text === "" || text === UNPARSED_ARGUMENTS) continue;
		if (shown === block) shown = { ...block };
		shown[field] = JSON.stringify(vinciMaskJson(block.arguments ?? {}));
	}
	return shown;
}

/** A call whose partial argument text is not complete JSON: the stream was cut inside it. */
function isCutCall(block: Json): boolean {
	return ["partialJson", "partialArgs"].some((field) => {
		const text = block[field];
		if (typeof text !== "string" || text === "" || text === UNPARSED_ARGUMENTS) return false;
		try {
			JSON.parse(text);
			return false;
		} catch {
			return true;
		}
	});
}

/** An interrupted call as shown: arguments over-masked, any partial argument text the placeholder. */
function maskCutCall(block: Json): Json {
	const shown: Json = { ...block, arguments: overMaskArguments(block.arguments) };
	for (const field of ["partialJson", "partialArgs"]) {
		if (typeof block[field] === "string" && block[field] !== "") shown[field] = UNPARSED_ARGUMENTS;
	}
	return shown;
}

/** `message` with each block through maskCompletedPartial (the same object when nothing changes). */
function maskCompletedPartials(message: Json): Json {
	if (!isAssistant(message)) return message;
	let changed = false;
	const content = message.content.map((block: Json) => {
		const shown = maskCompletedPartial(block);
		if (shown !== block) changed = true;
		return shown;
	});
	return changed ? { ...message, content } : message;
}

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
	/** Interrupted calls (released without their toolcall_end), by call id and by block object. */
	private interruptedIds = new Set<string>();
	private interruptedBlocks = new WeakSet<object>();
	private anyInterrupted = false;
	/**
	 * A tool event of the streaming message named no call (no usable content index, no id): every tool call of
	 * that message is held from then on, releases nothing, and is shown as interrupted in its final events.
	 */
	private fallback = false;
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
					return [...held, this.withMessage(end, "message")];
				}
				return [event];
			case "turn_end":
				return [this.withMessage(event, "message")];
			case "agent_end": {
				const held = this.flush();
				if (!Array.isArray(event.messages)) return [...held, event];
				return [...held, { ...event, messages: event.messages.map((message: Json) => this.maskFinal(message)) }];
			}
			default:
				return [event];
		}
	}

	/** `event` with its `field` message through maskFinal (the same object when nothing changes). */
	private withMessage(event: Json, field: string): Json {
		const message = event[field];
		const shown = this.maskFinal(message);
		return shown === message ? event : { ...event, [field]: shown };
	}

	/** A final message: maskInterrupted, then maskCompletedPartials (the same object when nothing changes). */
	private maskFinal(message: Json): Json {
		return maskCompletedPartials(this.maskInterrupted(message));
	}

	/**
	 * `message` with the arguments of every interrupted tool call over-masked (vinciOverMaskHeldValue on
	 * each string value) and any partial argument text it still carries replaced by the placeholder.
	 * Messages with no interrupted call are returned as given.
	 */
	maskInterrupted(message: Json): Json {
		if (!this.anyInterrupted || !isAssistant(message)) return message;
		let changed = false;
		const content = message.content.map((block: Json) => {
			if (!this.isInterrupted(block)) return block;
			changed = true;
			return maskCutCall(block);
		});
		return changed ? { ...message, content } : message;
	}

	private isInterrupted(block: Json): boolean {
		if (block?.type !== "toolCall") return false;
		if (this.interruptedBlocks.has(block)) return true;
		return typeof block.id === "string" && block.id !== "" && this.interruptedIds.has(block.id);
	}

	/** Record the calls of `message` still held (not released by their toolcall_end) as interrupted. */
	private markInterrupted(message: Json): void {
		if (!isAssistant(message)) return;
		message.content.forEach((block: Json, index: number) => {
			if (block?.type !== "toolCall" || (!this.fallback && !viewMasksCall(block))) return;
			const state = this.tools.get(index);
			// A built-in call with no state of its own, or whose state took fallback text, is interrupted too;
			// after a tool event that named no call, every call of the message is.
			if (!this.fallback && state && state.released && !state.guessed) return;
			this.interruptedBlocks.add(block);
			if (typeof block.id === "string" && block.id !== "") this.interruptedIds.add(block.id);
			this.anyInterrupted = true;
		});
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
		this.fallback = false;
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

	/** The held state of a built-in tool call, or of one whose name has not arrived yet (held the same way). */
	private toolStateFor(index: number, block: Json): ToolCallState | undefined {
		if (block?.type !== "toolCall" || !viewMasksCall(block)) return undefined;
		let state = this.tools.get(index);
		if (!state) {
			state = { raw: "", shown: "", released: false, arguments: {} };
			this.tools.set(index, state);
		}
		return state;
	}

	/**
	 * A call held while its name was unknown whose name now names a tool the view does not mask: it is
	 * no longer held, and the text held so far is returned to be released unchanged.
	 */
	private unholdNamed(index: number, block: Json): string {
		const state = this.tools.get(index);
		if (!state || block?.type !== "toolCall" || viewMasksCall(block)) return "";
		this.tools.delete(index);
		if (state.guessed) return this.dropGuessed(state);
		return state.released ? "" : state.raw;
	}

	/**
	 * Release a held tool call once: `ended` holds the parsed arguments at the call's end; any other end
	 * parses the held text, and text that does not parse releases only the placeholder. Returns the
	 * released delta (empty when no argument text was streamed).
	 */
	private releaseTool(state: ToolCallState, ended: unknown): string {
		if (state.released) return "";
		if (state.guessed) return this.dropGuessed(state);
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
	 * End a call whose held text was taken by the fallback (it may be another call's): nothing is released,
	 * and the call shows no arguments and empty partial text until the final events, which over-mask a
	 * built-in call and carry a call the view does not mask with its own arguments.
	 */
	/** After a tool event that named no call, every tracked call of the message is held as taken by the fallback. */
	private holdAllAfterFallback(): void {
		if (this.fallback) for (const state of this.tools.values()) state.guessed = true;
	}

	private dropGuessed(state: ToolCallState): string {
		state.released = true;
		state.shown = "";
		state.arguments = {};
		return "";
	}

	/** Release a call held while its name was unknown, unchanged: its name names a tool the view does not mask. */
	private releaseUnchanged(state: ToolCallState, block: Json): string {
		if (state.released) return "";
		state.released = true;
		state.shown = state.raw;
		state.arguments = block.arguments;
		return state.raw;
	}

	/**
	 * A streaming tool call shows only what was released: its partial argument text is the released,
	 * masked text, and its arguments stay `{}` until the call is released.
	 */
	private toolBlock(block: Json, state: ToolCallState): Json {
		const shown: Json = { ...block };
		for (const field of ["partialJson", "partialArgs"]) {
			if (typeof block[field] === "string") shown[field] = state.guessed ? "" : state.shown;
		}
		shown.arguments = state.released && !state.guessed ? state.arguments : {};
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
			if (this.interruptedBlocks.has(block)) this.interruptedBlocks.add(masked);
			const state = this.tools.get(index) as ToolCallState;
			for (const field of ["partialJson", "partialArgs"]) {
				const text = block[field];
				if (typeof text === "string" && text !== "" && text !== UNPARSED_ARGUMENTS) masked[field] = state.shown;
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
		const type = source?.type;
		const streamedIndex =
			type === "text_delta" || type === "text_end" || type === "thinking_delta" || type === "thinking_end"
				? blockIndexOf(source, message.content, (block) => streamedKind(block) === type.split("_")[0])
				: -1;
		const ending = type === "text_end" || type === "thinking_end" ? streamedIndex : -1;
		const isTool = type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end";
		const toolIndex = isTool ? blockIndexOf(source, message.content, (block) => block?.type === "toolCall", true, TOOL_FALLBACK) : -1;
		const toolGuessed = toolIndex >= 0 && !namesToolCall(source, message.content, toolIndex);
		if (isTool && (toolIndex < 0 || toolGuessed)) this.fallback = true;
		let toolAdded = "";
		let passedThrough = "";
		this.holdAllAfterFallback();
		if (toolIndex >= 0) passedThrough = this.unholdNamed(toolIndex, message.content[toolIndex]);
		const toolState = toolIndex >= 0 ? this.toolStateFor(toolIndex, message.content[toolIndex]) : undefined;
		if (toolState && toolGuessed) toolState.guessed = true;
		this.holdAllAfterFallback();
		if (toolState) {
			if (type === "toolcall_delta" && typeof source.delta === "string") toolState.raw += source.delta;
			if (type === "toolcall_end") {
				const id = source.toolCall?.id ?? message.content[toolIndex]?.id;
				if (typeof id === "string") this.interruptedIds.delete(id);
				toolAdded = this.releaseTool(toolState, source.toolCall?.arguments ?? message.content[toolIndex]?.arguments);
			}
		}
		// A stream-ending source event (`done` / `error`) ends every call still held: they are interrupted.
		const final = type === "done" ? source.message : type === "error" ? source.error : undefined;
		if (final) this.markInterrupted(final);
		const added = new Map<number, string>();
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) {
				const tool = block?.type === "toolCall" ? this.tools.get(index) : undefined;
				return tool ? this.toolBlock(block, tool) : untrackedCallBlock(block, this.fallback);
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
		if (passedThrough) out.push(this.toolDelta(masked, toolIndex, passedThrough));
		let rewritten = source;
		if (source && typeof source === "object") {
			rewritten = { ...source };
			if ("partial" in source) rewritten.partial = masked;
			if (source.type === "text_delta" || source.type === "thinking_delta") {
				rewritten.delta = added.get(streamedIndex) ?? "";
			}
			if ((toolState || this.fallback) && source.type === "toolcall_delta") rewritten.delta = "";
			if (type === "done" && final) rewritten.message = this.maskFinal(final);
			if (type === "error" && final) rewritten.error = this.maskFinal(final);
			if (type === "toolcall_end" && source.toolCall) rewritten.toolCall = this.fallback ? maskCutCall(source.toolCall) : maskCompletedPartial(source.toolCall);
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
		if (!isAssistant(message)) return [];
		// A built-in call with no state of its own is interrupted even when nothing else was streamed.
		this.markInterrupted(message);
		if (this.blocks.size === 0 && this.tools.size === 0) return [];
		this.holdAllAfterFallback();
		const added = new Map<number, string>();
		const toolAdded = new Map<number, string>();
		for (const [index, state] of this.tools) {
			const block = message.content[index];
			// A name that arrived only now and names a tool the view does not mask: released unchanged.
			const unmasked = block?.type === "toolCall" && !viewMasksCall(block);
			const text = !unmasked ? this.releaseTool(state, undefined) : state.guessed ? this.dropGuessed(state) : this.releaseUnchanged(state, block);
			if (text) toolAdded.set(index, text);
		}
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) {
				const tool = block?.type === "toolCall" ? this.tools.get(index) : undefined;
				return tool ? this.toolBlock(block, tool) : untrackedCallBlock(block, this.fallback);
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

/** A message the stream ended early (aborted, failed or cut at its length limit): its built-in calls may have been cut. */
function endedEarly(message: Json): boolean {
	return message?.stopReason === "aborted" || message?.stopReason === "error" || message?.stopReason === "length";
}

function maskAssistantMessage(message: Json): Json {
	const early = endedEarly(message);
	const content = message.content.map((block: Json) => {
		const kind = streamedKind(block);
		if (kind) return { ...block, [kind]: vinciMaskSecrets(block[kind]) };
		if (block?.type === "toolCall" && viewMasksCall(block)) {
			const shown = early ? maskCutCall(block) : maskCompletedPartial(block);
			return { ...shown, arguments: vinciMaskJson(shown.arguments) };
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
 * `stream`: the event path's VinciStreamMask; the calls it saw interrupted are over-masked the same way.
 */
export function vinciMaskViewMessage(message: Json, stream?: VinciStreamMask): Json {
	return maskMessage(stream ? stream.maskInterrupted(message) : message);
}

/**
 * Mask one session entry in the `get_messages` scope: a message entry's message goes through
 * vinciMaskViewMessage. Ids, parent ids, timestamps and every other entry kind (compaction and branch
 * summaries, custom and custom-message entries, labels, session info) are unchanged.
 */
export function vinciMaskViewEntry(entry: Json, stream?: VinciStreamMask): Json {
	if (entry?.type !== "message" || !entry.message) return entry;
	return { ...entry, message: vinciMaskViewMessage(entry.message, stream) };
}

/**
 * Mask the entries of a session tree with vinciMaskViewEntry; the nodes, children, labels and order are
 * unchanged. Iterative, like the tree's own construction: a long session is a deep chain.
 */
export function vinciMaskViewTree(roots: Json[], stream?: VinciStreamMask): Json[] {
	const copy = (node: Json): Json => {
		if (!node || typeof node !== "object") return node;
		return "entry" in node ? { ...node, entry: vinciMaskViewEntry(node.entry, stream) } : { ...node };
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
	if (message?.role === "toolResult" && viewMasksTool(message.toolName)) return maskToolOutput(message);
	return message;
}

function maskAssistantEvent(source: Json): Json {
	if (!source || typeof source !== "object") return source;
	const masked = { ...source };
	if (source.partial) masked.partial = maskMessage(source.partial);
	if (source.message) masked.message = maskMessage(source.message);
	if (source.error) masked.error = maskMessage(source.error);
	if (source.type === "text_end" || source.type === "thinking_end") masked.content = maskText(source.content);
	if (source.type === "toolcall_end" && source.toolCall && viewMasksCall(source.toolCall)) {
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
			if (!viewMasksTool(event.toolName)) return event;
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
