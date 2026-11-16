/**
 * Mask streamed output consistently (`--mode json` and `--mode rpc`, under VINCI_CODE=1).
 *
 * The secret mask decides some values only from later text: a private-key body is masked back from
 * its END line, multi-line base64 and hex runs are checked whole, and an assignment's value may go on
 * past a line break. So with masking on no maskable body is released piece by piece; each is held
 * whole until its block or result ends, then written once, masked as the interactive view masks it.
 *
 * Text and thinking: every `text_delta` / `thinking_delta` is written with an empty `delta`, and the
 * streaming message (`message` and the event's `partial`) shows each block as it was last released:
 * empty until the block ends. At the block's end (`text_end` / `thinking_end`) ONE synthesized delta
 * carries the whole body, normalised and masked, then the end event goes out carrying the same text. A
 * block that ends any other way (a stream-ending `done` / `error` source event, `message_end`,
 * `agent_end`, the next assistant `message_start`, or an exit path through `flush`) is released the same
 * way, once, before that event. A client that only appends deltas still holds the whole masked answer
 * before the end event.
 *
 * Normalisation, as the view does it before masking: terminal control strings and sequences are stripped
 * (vinciStripControlText, the function the assistant error view uses, then stripAnsi) and carriage returns
 * removed. The written body is the normalised, masked text.
 *
 * Tool output: a `tool_execution_update` keeps its event, but its `partialResult` is emptied (its bodies
 * are held); the masked result goes out at `tool_execution_end`. A result's text parts are masked joined
 * with line breaks, as the view joins them (getTextOutput), in `tool_execution_end`, the tool result
 * message and the final events that carry it. The latest partial result of each tool call is kept: when
 * the tool's end result does not contain its text (an error-only result, say), or the tool never ends (the
 * end of the run, a new assistant message, a rebind or an exit path), it goes out once, as one
 * `tool_execution_update`, before that end: masked whole when no line of it could still be changed by later
 * text, otherwise its text is the placeholder.
 *
 * Bounds: a held body (a text or thinking block, a tool call's argument text, a tool's partial result) is
 * held for at most VINCI_STREAM_HOLD_MAX_BYTES bytes (1 MiB) and VINCI_STREAM_HOLD_DEADLINE_MS (10 minutes)
 * from its first held byte, checked as events arrive. At either bound it goes out at once: a block masked whole
 * when no line of it could still be changed by later text, otherwise the placeholder; a call as when it ends any
 * other way (and its final events show it as interrupted); a partial result as above. Nothing more of that body
 * is held or released while it streams.
 *
 * Masking consistency for streamed tool arguments: the argument text of every tool call is held for the
 * whole call. A call whose arguments the interactive view masks (the built-in tools) releases at its end
 * one delta, the masked JSON of the parsed arguments (the masker the final arguments go through). A call
 * of any other tool releases at its end one delta too: the masked JSON of its held argument text when that
 * text parses (so a value is masked by its property name, as the final arguments are), otherwise only the
 * placeholder; its arguments are the call's arguments as given at its end. A built-in call that ends any
 * other way releases the masked JSON of its argument text when that text parses, and otherwise only the
 * placeholder. Until then its partial argument text is empty and its partial `arguments` are `{}`. A call
 * whose name has not arrived yet is held the same way, and a call that ends with no name is released
 * masked. A tool-name synonym of a built-in tool (which the agent loop folds onto the tool only when the
 * stream ends) is classified as that tool from the moment the name is known. A completed call of any tool
 * that still carries partial argument text (in its `toolcall_end` call or a final message) carries the
 * masked JSON of its arguments there (a call of a tool the view does not mask whose text does not parse
 * carries the placeholder; its arguments are kept).
 *
 * An interrupted call is a held call released without its `toolcall_end` (by `message_end`, `agent_end`,
 * the next `message_start`, a stream-ending source event or an exit path). In the final events that
 * carry it (`message_end`, `turn_end`, `agent_end`, a source `error`/`done` message) and in the
 * transcript responses, a string value of its arguments is kept whole (and masked whole by the writer) only
 * when it is complete (its partial argument text closes it) and the hold-back would release all of it;
 * every other string value is the placeholder, whole: no prefix of it is kept. Any partial argument text
 * the call still carries there is the placeholder. A tool-call event whose content
 * index names no tool-call block is taken to be about the call with its id, else (see TOOL_FALLBACK) a
 * call the view masks when there is one, so its text is held.
 *
 * `vinciMaskStreamJson` masks every string of an outgoing object (normalised, then masked), iteratively
 * so that a deep session tree cannot exhaust the stack. Both writers put everything they write through
 * it. A `thinkingSignature` / `textSignature` string that is the JSON of an object or array (a provider's
 * replay item) is masked decoded and written as its JSON; a reasoning item's summary (or content) texts are
 * masked joined as the provider joins them for the thinking block. Function-valued properties are dropped
 * and String, Number and Boolean objects are written as their values, as JSON.stringify writes them, and an
 * own `__proto__` key is kept. `vinciMaskViewEvent` / `vinciMaskViewMessage` / `vinciMaskViewEntry` /
 * `vinciMaskViewTree` first show interrupted and early-ended built-in calls over-masked, retained partial
 * argument text replaced and tool output joined, then apply it.
 */

import { vinciCanonicalToolName } from "@earendil-works/pi-agent-core";
import { stripAnsi, vinciStripControlText } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { vinciMaskJson, vinciMaskSecrets } from "./vinci-mask-secrets.ts";

/** The most streamed lines an unclosed `${` holds back. */
const INTERPOLATION_HOLD_LINES = 20;

/** What a tool call whose held argument text does not parse releases in its place. */
const UNPARSED_ARGUMENTS = "‹redacted›";

/** The most bytes (UTF-8) one held body may reach before it goes out: 1 MiB. */
export const VINCI_STREAM_HOLD_MAX_BYTES = 1_048_576;

/** How long one body may be held, from its first held byte: 10 minutes. */
export const VINCI_STREAM_HOLD_DEADLINE_MS = 600_000;

/** The bounds of one held body, and the clock its deadline is measured with. */
export interface VinciStreamHoldLimits {
	maxBytes: number;
	deadlineMs: number;
	now: () => number;
}

let holdLimits: VinciStreamHoldLimits = {
	maxBytes: VINCI_STREAM_HOLD_MAX_BYTES,
	deadlineMs: VINCI_STREAM_HOLD_DEADLINE_MS,
	now: Date.now,
};

/**
 * Tests only: a smaller byte bound, a shorter deadline or a fake clock for every VinciStreamMask; called with
 * nothing, the defaults again.
 */
export function vinciSetStreamHoldLimitsForTest(limits: Partial<VinciStreamHoldLimits> = {}): void {
	holdLimits = {
		maxBytes: limits.maxBytes ?? VINCI_STREAM_HOLD_MAX_BYTES,
		deadlineMs: limits.deadlineMs ?? VINCI_STREAM_HOLD_DEADLINE_MS,
		now: limits.now ?? Date.now,
	};
}

/** The UTF-8 length of `text`. */
function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Whether `text` is past the byte bound (its length in UTF-16 units never exceeds its UTF-8 length). */
function pastByteBound(text: string): boolean {
	const max = holdLimits.maxBytes;
	return text.length > max || (text.length * 3 > max && utf8Bytes(text) > max);
}

/**
 * Whether a held body is past a bound: `bytes` counted as it streamed, or its current `length` (UTF-16 units),
 * past the byte bound, or held since `started` for the deadline or longer.
 */
function pastBound(bytes: number, length: number, started: number | undefined, now: number): boolean {
	if (bytes > holdLimits.maxBytes || length > holdLimits.maxBytes) return true;
	return started !== undefined && now - started >= holdLimits.deadlineMs;
}

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
	/** The masked body released for this block: empty until the block is released. */
	shown: string;
	/** The block was released (its end event, or the end of its message): its body went out once. */
	done: boolean;
	/** UTF-8 bytes of its deltas so far, and when its first byte was held (for the bounds). */
	bytes: number;
	started?: number;
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
	/** UTF-8 bytes of its held text, and when its first byte was held (for the bounds). */
	bytes: number;
	started?: number;
	/** Released at a bound: nothing more of its text is held, and its final events show it as interrupted. */
	bounded?: boolean;
}

/** The latest update of a running tool, held until its end. */
interface HeldPartial {
	/** The tool's latest `tool_execution_update` event (its partial result is the latest one). */
	event: Json;
	/** When its first partial result was held. */
	started: number;
}

/**
 * The built-in tools whose call header, preview, diff and output the interactive view masks
 * (tools/bash.ts output, tools/write.ts preview, components/diff.ts, and the vinci-render wrappers of
 * bash/read/grep/find/ls/edit/write). Arguments and results of other tools are rendered unmasked.
 */
const VIEW_MASKED_TOOLS = new Set(["bash", "read", "grep", "find", "ls", "edit", "write"]);

type Json = any;

/**
 * A body normalised as the view normalises it before masking: terminal control strings and sequences stripped
 * (vinciStripControlText, the assistant error view's own normaliser, then stripAnsi), then carriage returns
 * removed.
 */
export function vinciNormaliseForMask(text: string): string {
	return stripAnsi(vinciStripControlText(text)).replace(/\r/g, "");
}

/** Property names vinciMaskJson treats as secret (it masks every value under one), as already asked. */
const secretNames = new Map<string, boolean>();

/** Whether vinciMaskJson treats `name` as a secret property name: asked of vinciMaskJson itself. */
function isSecretName(name: string): boolean {
	if (name === "") return false;
	let secret = secretNames.get(name);
	if (secret === undefined) {
		// vinciMaskJson replaces a number only under a secret property name: the same rule, asked directly.
		secret = vinciMaskJson(0, name) !== 0;
		if (secretNames.size < 4096) secretNames.set(name, secret);
	}
	return secret;
}

/**
 * Property names whose string value may be a provider's replay item kept as its JSON (the OpenAI Responses
 * API keeps a reasoning item, summary text included, as JSON.stringify of the item in `thinkingSignature`).
 */
const SIGNATURE_NAMES = new Set(["thinkingSignature", "textSignature"]);

/** What a function value becomes: dropped from an object, and null in an array, as JSON.stringify writes it. */
const DROPPED = Symbol("dropped");

/** A signature string that is the JSON of an object or array: that value; anything else: undefined. */
function decodedSignature(text: string): object | undefined {
	const start = text.trimStart()[0];
	if (start !== "{" && start !== "[") return undefined;
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The fields of a reasoning replay item whose `text` parts the provider joins into the thinking block
 * (openai-responses-shared.ts: `summary[].text`, else `content[].text`), and the join it uses.
 */
const REASONING_PART_FIELDS = ["summary", "content"];
const REASONING_JOIN = "\n\n";

/**
 * A decoded replay item with each of its reasoning part lists masked as the thinking block is masked: the
 * parts' texts normalised, joined as the provider joins them, then masked whole. When masking each part on its
 * own gives the same joined text, the parts are kept (the walk masks each the same way); otherwise the masked
 * joined body replaces their texts, as one part where the first one was. Anything else is returned as given.
 */
function shapeReasoningItem(decoded: object): object {
	if (Array.isArray(decoded)) return decoded;
	let shaped: Json = decoded;
	for (const field of REASONING_PART_FIELDS) {
		const parts = (decoded as Json)[field];
		if (!Array.isArray(parts)) continue;
		const texts = parts.filter((part: Json) => typeof part?.text === "string");
		if (texts.length < 2) continue;
		// Masked under the name the walk masks each part's text under.
		const normalised = texts.map((part: Json) => vinciNormaliseForMask(part.text as string));
		const joined = vinciMaskJson(normalised.join(REASONING_JOIN), "text") as string;
		const each = normalised.map((text: string) => vinciMaskJson(text, "text") as string);
		if (each.join(REASONING_JOIN) === joined) continue;
		let placed = false;
		const kept: Json[] = [];
		for (const part of parts) {
			if (typeof part?.text !== "string") kept.push(part);
			else if (!placed) {
				kept.push({ ...part, text: joined });
				placed = true;
			}
		}
		if (shaped === decoded) shaped = { ...decoded };
		shaped[field] = kept;
	}
	return shaped;
}

/**
 * A signature string as written. When it is the JSON of an object or array, that value is masked decoded
 * (shapeReasoningItem, then vinciMaskStreamJson) and, when that changes anything, written as the JSON of the
 * masked value. Otherwise (nothing inside is masked, or it is not such JSON) it is masked as any other string
 * is: a signature that masking and normalisation leave unchanged (compact provider JSON with no secret) is kept
 * byte-identical, so a client can still replay it.
 */
function maskSignature(text: string, name: string): unknown {
	const decoded = decodedSignature(text);
	if (decoded !== undefined) {
		const masked = JSON.stringify(vinciMaskStreamJson(shapeReasoningItem(decoded)));
		if (masked !== JSON.stringify(decoded)) return masked;
	}
	return vinciMaskJson(vinciNormaliseForMask(text), name);
}

/** A String, Number or Boolean object as its value, as JSON.stringify reads it; anything else as given. */
function unboxed(value: Json): Json {
	if (value instanceof Number) return Number(value);
	if (value instanceof String) return String(value);
	if (value instanceof Boolean) return value.valueOf();
	return value;
}

/**
 * Mask every string of `value` as the writers write it with masking on: normalised (vinciNormaliseForMask),
 * then masked by vinciMaskJson's per-value rule (a value under a secret property name is masked whatever it
 * holds; numbers and booleans are kept unless they are under one). Keys, numbers and structure are unchanged
 * as JSON.stringify would write them: a value with a `toJSON` method is read through it, as JSON.stringify
 * reads it, and a function value is dropped as JSON.stringify drops it (null in an array), so the output holds
 * nothing callable for JSON.stringify to call; a String, Number or Boolean object is masked as its value, and an
 * own `__proto__` key stays an own key. A signature string (SIGNATURE_NAMES) goes through maskSignature.
 * Iterative, so that a deep session tree cannot exhaust the stack; a shared object is masked once, and a cycle
 * stays a cycle (which JSON.stringify then refuses, as it refuses the raw value).
 */
export function vinciMaskStreamJson(value: unknown): unknown {
	const memo = new Map<object, Map<string, unknown>>();
	const pending: { source: Json; target: Json; name: string }[] = [];
	const visit = (entry: unknown, key: string, name: string): unknown => {
		let current: Json = entry;
		if (
			current !== null &&
			(typeof current === "object" || typeof current === "function") &&
			typeof current.toJSON === "function"
		) {
			current = current.toJSON(key);
		}
		if (typeof current === "function") return DROPPED;
		// After its one toJSON step a String, Number or Boolean object is its value, as JSON.stringify reads it.
		current = unboxed(current);
		if (current === null || typeof current !== "object") {
			if (typeof current === "string" && SIGNATURE_NAMES.has(name)) return maskSignature(current, name);
			return vinciMaskJson(typeof current === "string" ? vinciNormaliseForMask(current) : current, name);
		}
		// Under a secret property name every descendant keeps that name; otherwise each object value is
		// masked under its own key (an array's values under the array's name, which then is not secret).
		const inherited = isSecretName(name) ? name : "";
		let seen = memo.get(current);
		const known = seen?.get(inherited);
		if (known !== undefined) return known;
		const target: Json = Array.isArray(current) ? [] : {};
		if (!seen) {
			seen = new Map();
			memo.set(current, seen);
		}
		seen.set(inherited, target);
		pending.push({ source: current, target, name: inherited });
		return target;
	};
	const root = visit(value, "", "");
	while (pending.length > 0) {
		const { source, target, name } = pending.pop() as { source: Json; target: Json; name: string };
		if (Array.isArray(source)) {
			for (let at = 0; at < source.length; at++) {
				const shown = visit(source[at], String(at), name);
				target[at] = shown === DROPPED ? null : shown;
			}
		} else {
			for (const [key, entry] of Object.entries(source)) {
				const shown = visit(entry, key, name || key);
				if (shown === DROPPED) continue;
				// An own "__proto__" key is defined: assigning it would set the target's prototype instead.
				if (key === "__proto__") {
					Object.defineProperty(target, key, {
						value: shown,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				} else target[key] = shown;
			}
		}
	}
	return root === DROPPED ? undefined : root;
}

/** A text part of a tool result's content. */
function isTextPart(part: Json): boolean {
	return part?.type === "text" && typeof part.text === "string";
}

/** One text part of tool output normalised as getTextOutput normalises it: stripAnsi, binary filter, CR removal. */
function normaliseToolText(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}

/**
 * A tool result (or tool result message) with its output masked as the view masks it: the text parts
 * each normalised (normaliseToolText) and joined with line breaks, as getTextOutput joins them, then masked
 * whole. When masking the parts one by one gives the same joined text, each part keeps its own normalised,
 * masked text; otherwise the masked joined body replaces them, as one text part where the first one was.
 * Other parts and fields are kept here (the writer masks every string); anything without text parts is
 * returned as given.
 */
export function vinciMaskToolOutput(result: Json, mask: (text: string) => string = vinciMaskSecrets): Json {
	if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result;
	const texts = result.content.filter(isTextPart);
	if (texts.length === 0) return result;
	const normalised = texts.map((part: Json) => normaliseToolText(part.text as string));
	const parts = normalised.map((text: string) => mask(text));
	const joined = mask(normalised.join("\n"));
	if (parts.join("\n") === joined) {
		let at = 0;
		const content = result.content.map((part: Json) => (isTextPart(part) ? { ...part, text: parts[at++] } : part));
		return { ...result, content };
	}
	let placed = false;
	const content: Json[] = [];
	for (const part of result.content) {
		if (!isTextPart(part)) content.push(part);
		else if (!placed) {
			content.push({ ...part, text: joined });
			placed = true;
		}
	}
	return { ...result, content };
}

/** A tool result message through vinciMaskToolOutput; any other message as given. */
function maskToolResultMessage(message: Json): Json {
	return message?.role === "toolResult" ? vinciMaskToolOutput(message) : message;
}

/** Each message of a list through maskToolResultMessage; anything that is not a list as given. */
function maskToolResultMessages(messages: Json): Json {
	return Array.isArray(messages) ? messages.map(maskToolResultMessage) : messages;
}

/**
 * A tool update's partial result as written: its bodies are held until the tool ends, so its content is
 * empty and its details (when it has them) are empty too. A string partial result is empty; anything that
 * is not an object or a string is kept (it carries no body).
 */
function heldPartialResult(partial: Json): Json {
	if (typeof partial === "string") return "";
	if (!partial || typeof partial !== "object") return partial;
	if (Array.isArray(partial)) return [];
	const held: Json = { content: [] };
	if ("details" in partial) held.details = {};
	return held;
}

/** The text of a tool result (or partial result) as the view shows it: its text parts normalised and joined. */
function resultText(result: Json): string {
	if (typeof result === "string") return normaliseToolText(result);
	if (!result || typeof result !== "object" || !Array.isArray(result.content)) return "";
	return result.content
		.filter(isTextPart)
		.map((part: Json) => normaliseToolText(part.text as string))
		.join("\n");
}

/** A result's content with its text parts replaced by one placeholder part, where the first one was. */
function placeholderContent(content: Json): Json[] {
	if (!Array.isArray(content)) return [];
	let placed = false;
	const shown: Json[] = [];
	for (const part of content) {
		if (!isTextPart(part)) shown.push(part);
		else if (!placed) {
			shown.push({ ...part, text: UNPARSED_ARGUMENTS });
			placed = true;
		}
	}
	return shown;
}

/** Whether the hold-back would release all of `text`: its last line ends in a line break and no line of it is held. */
function releasesWhole(text: string): boolean {
	const scanner = new HoldScanner({ chars: 0 });
	scanner.scan(text);
	return scanner.released > 0 && scanner.releasedEnd + 1 >= text.length;
}

/**
 * Continuations the mask's cross-line grammar can still join to a cut body: an angle value's closing `>`, a chained
 * call that ends a value, and a key block's END line (built split, so this source carries no key marker).
 */
const SETTLE_CLOSERS: readonly string[] = [">\n", ".trim()\n", ["-----END ", "PRIVATE KEY-----\n"].join("")];

/**
 * Whether a body that may have been cut (a partial result, a body at a bound) can be masked whole: it is empty,
 * or the hold-back would release all of it, its last line taken as complete, and its masked text stays a prefix
 * of the mask of the body with any SETTLE_CLOSERS continuation. A body that ends inside a key block, an open `${`,
 * an open angle value or a line that later text could still change cannot. `mask` is the caller's own mask.
 */
function settles(text: string, mask: (text: string) => string): boolean {
	if (text === "") return true;
	const whole = text.endsWith("\n") ? text : `${text}\n`;
	if (!releasesWhole(whole)) return false;
	const masked = mask(whole);
	return SETTLE_CLOSERS.every((closer) => mask(`${whole}${closer}`).startsWith(masked));
}

/** The key a tool event's kept partial result is held under: its tool-call id. */
function partialKey(event: Json): string {
	return typeof event?.toolCallId === "string" ? event.toolCallId : "";
}

/** `event` with its `field` through `shape`: the same object when the field is absent or nothing changes. */
function withField(event: Json, field: string, shape: (value: Json) => Json): Json {
	if (!event || typeof event !== "object" || !(field in event)) return event;
	const shown = shape(event[field]);
	return shown === event[field] ? event : { ...event, [field]: shown };
}

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
 * A streaming message's block with no tool-call state: a call shows no arguments and empty partial text,
 * as a held call does (its own events went to another call, or have not come yet); any other block is
 * unchanged.
 */
function untrackedCallBlock(block: Json): Json {
	if (block?.type !== "toolCall") return block;
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
	return (
		block?.type === "toolCall" && (typeof block.partialJson === "string" || typeof block.partialArgs === "string")
	);
}

/**
 * One argument value of an interrupted or cut call. A value known to be `complete` that the hold-back would
 * release whole (it ends in a released line break) is kept, and the writer masks it whole, as the view masks it.
 * Any other value (one that may have been cut, or that the hold-back would split) is the placeholder, whole: no
 * prefix of it is kept, since a kept prefix can lose the context that makes a value a secret.
 */
export function vinciOverMaskHeldValue(text: string, complete = false): string {
	if (text === "") return text;
	if (complete && releasesWhole(text)) return text;
	return UNPARSED_ARGUMENTS;
}

/**
 * Every string value of `value` (at any depth) through vinciOverMaskHeldValue, complete when `complete` holds
 * it; keys and other values unchanged.
 */
function overMaskArguments(value: unknown, complete: ReadonlySet<string>): unknown {
	if (typeof value === "string") return vinciOverMaskHeldValue(value, complete.has(value));
	if (Array.isArray(value)) return value.map((entry) => overMaskArguments(entry, complete));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, overMaskArguments(entry, complete)]));
	}
	return value;
}

/**
 * The string values a call's partial argument text closes: each string literal of the text that ends before
 * the text does and is followed by `,`, `}` or `]` (a value, not a key). A value it does not close may have
 * been cut.
 */
function closedValueStrings(block: Json): Set<string> {
	const closed = new Set<string>();
	for (const field of ["partialJson", "partialArgs"]) {
		const text = block?.[field];
		if (typeof text !== "string" || text === UNPARSED_ARGUMENTS) continue;
		for (let at = text.indexOf('"'); at >= 0; at = text.indexOf('"', at)) {
			let end = at + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			// A literal the text ends inside was cut there; nothing after it is complete.
			if (end >= text.length) break;
			let next = end + 1;
			while (next < text.length && /\s/.test(text[next])) next++;
			if (next < text.length && ",}]".includes(text[next])) {
				try {
					const value = JSON.parse(text.slice(at, end + 1));
					if (typeof value === "string") closed.add(value);
				} catch {
					// not a JSON string literal: not complete
				}
			}
			at = end + 1;
		}
	}
	return closed;
}

/**
 * A completed call's retained partial argument text (`partialJson` / `partialArgs`, a non-empty string): the
 * masked JSON of its arguments, the text its released delta carries. A built-in call whose text is not
 * complete JSON is shown as cut (maskCutCall); a call of any other tool whose text is not complete JSON
 * carries the placeholder there (its arguments are kept, and masked by the writer). Other blocks, an empty
 * text and an interrupted call's placeholder are kept as given (the same object when nothing changes).
 */
function maskCompletedPartial(block: Json): Json {
	if (block?.type !== "toolCall") return block;
	const builtIn = viewMasksCall(block);
	if (builtIn && isCutCall(block)) return maskCutCall(block);
	let shown = block;
	for (const field of ["partialJson", "partialArgs"]) {
		const text = block[field];
		if (typeof text !== "string" || text === "" || text === UNPARSED_ARGUMENTS) continue;
		if (shown === block) shown = { ...block };
		const parses = builtIn || parsesAsJson(text);
		shown[field] = parses ? JSON.stringify(vinciMaskStreamJson(block.arguments ?? {})) : UNPARSED_ARGUMENTS;
	}
	return shown;
}

/** Whether `text` is complete JSON. */
function parsesAsJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
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

/**
 * An interrupted call as shown: arguments over-masked (a value its partial argument text closes counts as
 * complete), any partial argument text the placeholder.
 */
function maskCutCall(block: Json): Json {
	const shown: Json = { ...block, arguments: overMaskArguments(block.arguments, closedValueStrings(block)) };
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
	/** The latest partial result of each running tool, by tool-call id, until it goes out or its end supersedes it. */
	private partials = new Map<string, HeldPartial>();
	/** Tools whose partial result went out at a bound: their later updates are written held and not kept. */
	private boundedPartials = new Set<string>();
	private readonly mask: (text: string) => string;
	private readonly work = { chars: 0 };

	constructor(mask: (text: string) => string = vinciMaskSecrets) {
		this.mask = mask;
	}

	/**
	 * Characters a hold-back scan has examined (a work measure for tests). Streamed text is held whole and
	 * never scanned while it streams, so this stays at zero.
	 */
	get scannedChars(): number {
		return this.work.chars;
	}

	/** A block's body as written: normalised, then masked (the view's order). */
	private body(text: string): string {
		return this.mask(vinciNormaliseForMask(text));
	}

	/**
	 * The events to write in place of `event`. Text and thinking fields of a streaming assistant message
	 * hold only their released, masked body (empty until the block is released); a text or thinking delta
	 * is written empty. A block's end, a stream-ending source event, `message_end`, `agent_end` and a new
	 * assistant `message_start` are preceded by one synthesized delta per block not yet released. A tool
	 * update's partial result is emptied (the latest one is kept until the tool ends); a tool result's output is
	 * masked joined. Every other event passes through unchanged (the writer masks every string). A partial result
	 * held past the deadline goes out first.
	 */
	process(event: Json): Json[] {
		const expired = this.expirePartials();
		const out = this.handle(event);
		return expired.length > 0 ? [...expired, ...out] : out;
	}

	private handle(event: Json): Json[] {
		switch (event?.type) {
			case "message_start":
				if (isAssistant(event.message)) {
					const held = this.flush();
					this.latest = event.message;
					return [...held, event];
				}
				return [withField(event, "message", maskToolResultMessage)];
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
				return [withField(event, "message", maskToolResultMessage)];
			case "turn_end":
				return [withField(this.withMessage(event, "message"), "toolResults", maskToolResultMessages)];
			case "agent_end": {
				const held = this.flush();
				if (!Array.isArray(event.messages)) return [...held, event];
				const messages = event.messages.map((message: Json) => maskToolResultMessage(this.maskFinal(message)));
				return [...held, { ...event, messages }];
			}
			case "tool_execution_update":
				// The update keeps its event; its bodies are held until the tool ends (the latest one is kept).
				return [this.holdPartial(event)];
			case "tool_execution_end":
				return [
					...this.endPartial(event),
					withField(event, "result", (result: Json) => vinciMaskToolOutput(result, this.mask)),
				];
			default:
				return [event];
		}
	}

	/**
	 * A tool update as written: its partial result is held (heldPartialResult) and kept as the tool's latest
	 * until the tool ends. One past the byte bound goes out at once instead (shownPartial), and later updates of
	 * that tool are written held and not kept.
	 */
	private holdPartial(event: Json): Json {
		const id = partialKey(event);
		const held = withField(event, "partialResult", heldPartialResult);
		if (this.boundedPartials.has(id)) return held;
		const started = this.partials.get(id)?.started ?? holdLimits.now();
		if (pastByteBound(resultText(event.partialResult))) {
			this.partials.delete(id);
			this.boundedPartials.add(id);
			return withField(event, "partialResult", (partial: Json) => this.shownPartial(partial));
		}
		this.partials.set(id, { event, started });
		return held;
	}

	/**
	 * Before a tool's end event: its kept partial result, once, when the end result does not contain its text
	 * (an error-only end, say); nothing when it does, or when it has no text.
	 */
	private endPartial(event: Json): Json[] {
		const id = partialKey(event);
		this.boundedPartials.delete(id);
		const held = this.partials.get(id);
		if (!held) return [];
		this.partials.delete(id);
		const text = resultText(held.event.partialResult);
		if (text === "" || resultText(event.result).includes(text)) return [];
		return [this.releasePartial(held)];
	}

	/** Partial results held for the deadline or longer go out now; later updates of those tools are not kept. */
	private expirePartials(): Json[] {
		if (this.partials.size === 0) return [];
		const now = holdLimits.now();
		const out: Json[] = [];
		for (const [id, held] of this.partials) {
			if (now - held.started < holdLimits.deadlineMs) continue;
			this.partials.delete(id);
			this.boundedPartials.add(id);
			out.push(this.releasePartial(held));
		}
		return out;
	}

	/** Every kept partial result goes out (the end of the run, a new assistant message, a rebind, an exit path). */
	private releasePartials(): Json[] {
		const out = [...this.partials.values()].map((held) => this.releasePartial(held));
		this.partials.clear();
		this.boundedPartials.clear();
		return out;
	}

	/** A kept tool update written once more, its partial result shown (shownPartial). */
	private releasePartial(held: HeldPartial): Json {
		return withField(held.event, "partialResult", (partial: Json) => this.shownPartial(partial));
	}

	/**
	 * A partial result as released: masked whole (its text parts joined, as at the tool's end) when its text can
	 * be masked whole (settles); otherwise its text is the placeholder and its details are empty.
	 */
	private shownPartial(partial: Json): Json {
		const text = resultText(partial);
		const whole = settles(text, this.mask);
		if (typeof partial === "string") return whole ? this.mask(text) : UNPARSED_ARGUMENTS;
		if (!partial || typeof partial !== "object" || Array.isArray(partial)) return heldPartialResult(partial);
		if (whole) return vinciMaskToolOutput(partial, this.mask);
		const shown: Json = { ...partial, content: placeholderContent(partial.content) };
		if ("details" in partial) shown.details = {};
		return shown;
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
			// A built-in call with no state of its own, whose state took fallback text, or that went out at a bound
			// is interrupted too; after a tool event that named no call, every call of the message is.
			if (!this.fallback && state && state.released && !state.guessed && !state.bounded) return;
			this.interruptedBlocks.add(block);
			if (typeof block.id === "string" && block.id !== "") this.interruptedIds.add(block.id);
			this.anyInterrupted = true;
		});
	}

	/**
	 * Release whatever the streaming message still holds, masked, then every kept partial result (exit paths,
	 * `agent_end` and a new assistant message call this).
	 */
	flush(): Json[] {
		const held = this.latest && (this.blocks.size > 0 || this.tools.size > 0) ? this.release(this.latest) : [];
		this.reset();
		const partials = this.releasePartials();
		return partials.length > 0 ? [...held, ...partials] : held;
	}

	private reset(): void {
		this.blocks.clear();
		this.tools.clear();
		this.latest = undefined;
		this.fallback = false;
	}

	/**
	 * The held state of a tool call: every call is held until it ends (a built-in call, one whose name has
	 * not arrived yet, and a call of any other tool alike); what it releases depends on its name then.
	 */
	private toolStateFor(index: number, block: Json): ToolCallState | undefined {
		if (block?.type !== "toolCall") return undefined;
		let state = this.tools.get(index);
		if (!state) {
			state = { raw: "", shown: "", released: false, arguments: {}, bytes: 0 };
			this.tools.set(index, state);
		}
		return state;
	}

	/**
	 * Release a held call once at its end: a call the view masks as its masked arguments (releaseTool), a
	 * call of any other tool as the masked JSON of its held text (releaseOther).
	 */
	private releaseCall(state: ToolCallState, block: Json, ended: unknown): string {
		if (block?.type === "toolCall" && !viewMasksCall(block)) return this.releaseOther(state, block, ended);
		return this.releaseTool(state, ended);
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
		else state.shown = parsed === undefined ? UNPARSED_ARGUMENTS : JSON.stringify(vinciMaskStreamJson(parsed));
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

	/**
	 * Release a held call of a tool the view does not mask: one delta, the masked JSON of its held argument
	 * text when that text parses (each value masked under its property name, as the final arguments are),
	 * otherwise only the placeholder; its arguments are the call's arguments as given at its end. Text the
	 * fallback took is not released. Returns the released delta (empty when no argument text was streamed).
	 */
	private releaseOther(state: ToolCallState, block: Json, ended?: unknown): string {
		if (state.released) return "";
		if (state.guessed) return this.dropGuessed(state);
		state.released = true;
		state.arguments = ended ?? block.arguments;
		if (state.raw === "") state.shown = "";
		else {
			let parsed: unknown;
			let parses = true;
			try {
				parsed = JSON.parse(state.raw);
			} catch {
				parses = false;
			}
			state.shown = parses ? JSON.stringify(vinciMaskStreamJson(parsed)) : UNPARSED_ARGUMENTS;
		}
		return state.shown;
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
			state = { kind, shown: "", done: false, bytes: 0 };
			this.blocks.set(index, state);
		}
		return state;
	}

	/** Release a held block once: its body, normalised and masked; returns the synthesized delta's text. */
	private releaseBlock(state: BlockState, raw: string): string {
		if (state.done) return "";
		state.done = true;
		state.shown = this.body(raw);
		return state.shown;
	}

	/**
	 * Release a held block at a bound, once: its body so far masked whole when no line of it could still be
	 * changed by later text (settles), otherwise the placeholder. Nothing more of it is released while it streams.
	 */
	private releaseBoundedBlock(state: BlockState, raw: string): string {
		state.done = true;
		const body = vinciNormaliseForMask(raw);
		state.shown = settles(body, this.mask) ? this.mask(body) : UNPARSED_ARGUMENTS;
		return state.shown;
	}

	/**
	 * Release every held call whose argument text is past a bound, as when it ends any other way (its text masked
	 * when it parses, else the placeholder); its held text is dropped, its arguments are not shown while the message
	 * streams, and its final events show it as interrupted. The released deltas are added to `added`.
	 */
	private releaseBoundedCalls(message: Json, now: number, added: Map<number, string>): void {
		for (const [index, state] of this.tools) {
			if (state.bounded || state.released) continue;
			if (!pastBound(state.bytes, state.raw.length, state.started, now)) continue;
			state.bounded = true;
			const text = state.guessed
				? this.dropGuessed(state)
				: this.releaseCall(state, message.content[index], undefined);
			state.arguments = {};
			state.raw = "";
			if (text) added.set(index, text);
		}
	}

	private update(event: Json): Json[] {
		const message = event.message;
		this.latest = message;
		const source = event.assistantMessageEvent;
		const type = source?.type;
		const now = holdLimits.now();
		const streamedIndex =
			type === "text_delta" || type === "text_end" || type === "thinking_delta" || type === "thinking_end"
				? blockIndexOf(source, message.content, (block) => streamedKind(block) === type.split("_")[0])
				: -1;
		const ending = type === "text_end" || type === "thinking_end" ? streamedIndex : -1;
		const isTool = type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end";
		const toolIndex = isTool
			? blockIndexOf(source, message.content, (block) => block?.type === "toolCall", true, TOOL_FALLBACK)
			: -1;
		const toolGuessed = toolIndex >= 0 && !namesToolCall(source, message.content, toolIndex);
		if (isTool && (toolIndex < 0 || toolGuessed)) this.fallback = true;
		const toolAdded = new Map<number, string>();
		this.holdAllAfterFallback();
		const toolState = toolIndex >= 0 ? this.toolStateFor(toolIndex, message.content[toolIndex]) : undefined;
		if (toolState && toolGuessed) toolState.guessed = true;
		this.holdAllAfterFallback();
		if (toolState) {
			// A released call (at its end, or at a bound) holds no more text.
			if (type === "toolcall_delta" && typeof source.delta === "string" && !toolState.released) {
				toolState.raw += source.delta;
				toolState.bytes += utf8Bytes(source.delta);
				if (toolState.started === undefined) toolState.started = now;
			}
			if (type === "toolcall_end") {
				const block = message.content[toolIndex];
				const id = source.toolCall?.id ?? block?.id;
				if (typeof id === "string") this.interruptedIds.delete(id);
				const text = this.releaseCall(toolState, block, source.toolCall?.arguments ?? block?.arguments);
				if (text) toolAdded.set(toolIndex, text);
			}
		}
		this.releaseBoundedCalls(message, now, toolAdded);
		// A stream-ending source event (`done` / `error`) ends every call still held: they are interrupted.
		const final = type === "done" ? source.message : type === "error" ? source.error : undefined;
		if (final) this.markInterrupted(final);
		// It also ends every text and thinking block not yet released: each body goes out once, before it.
		const streamEnded = type === "done" || type === "error";
		const added = new Map<number, string>();
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) {
				const tool = block?.type === "toolCall" ? this.tools.get(index) : undefined;
				return tool ? this.toolBlock(block, tool) : untrackedCallBlock(block);
			}
			const state = this.stateFor(index, kind);
			if (!state.done) {
				if (state.started === undefined && block[kind] !== "") state.started = now;
				const delta = index === streamedIndex && type.endsWith("_delta") ? source.delta : undefined;
				if (typeof delta === "string") state.bytes += utf8Bytes(delta);
			}
			if (index === ending || streamEnded) {
				const text = this.releaseBlock(state, block[kind]);
				if (text) added.set(index, text);
			} else if (!state.done && pastBound(state.bytes, block[kind].length, state.started, now)) {
				const text = this.releaseBoundedBlock(state, block[kind]);
				if (text) added.set(index, text);
			}
			return { ...block, [kind]: state.shown };
		});
		const masked = { ...message, content };
		const out: Json[] = [];
		for (const [index, text] of added) out.push(this.delta(masked, index, text));
		for (const [index, text] of toolAdded) out.push(this.toolDelta(masked, index, text));
		let rewritten = source;
		if (source && typeof source === "object") {
			rewritten = { ...source };
			if ("partial" in source) rewritten.partial = masked;
			// Streamed text and every call's argument text are held: their deltas are written empty.
			if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") rewritten.delta = "";
			if (type === "done" && final) rewritten.message = this.maskFinal(final);
			if (type === "error" && final) rewritten.error = this.maskFinal(final);
			if (type === "toolcall_end" && source.toolCall)
				rewritten.toolCall = this.fallback ? maskCutCall(source.toolCall) : maskCompletedPartial(source.toolCall);
			if (ending >= 0) {
				const block = content[ending];
				const kind = streamedKind(block);
				if (kind) rewritten.content = block[kind];
			}
		}
		out.push({ ...event, message: masked, assistantMessageEvent: rewritten });
		return out;
	}

	/** One synthesized delta per block of `message` not yet released, its whole body masked; held calls released. */
	private release(message: Json): Json[] {
		if (!isAssistant(message)) return [];
		// A built-in call with no state of its own is interrupted even when nothing else was streamed.
		this.markInterrupted(message);
		if (this.blocks.size === 0 && this.tools.size === 0) return [];
		this.holdAllAfterFallback();
		const added = new Map<number, string>();
		const toolAdded = new Map<number, string>();
		for (const [index, state] of this.tools) {
			const text = this.releaseCall(state, message.content[index], undefined);
			if (text) toolAdded.set(index, text);
		}
		const content = message.content.map((block: Json, index: number) => {
			const kind = streamedKind(block);
			if (!kind) {
				const tool = block?.type === "toolCall" ? this.tools.get(index) : undefined;
				return tool ? this.toolBlock(block, tool) : untrackedCallBlock(block);
			}
			const state = this.blocks.get(index);
			if (!state || state.kind !== kind) return { ...block, [kind]: this.body(block[kind]) };
			const text = this.releaseBlock(state, block[kind]);
			if (text) added.set(index, text);
			return { ...block, [kind]: state.shown };
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
// RPC: every string of what the writer sends is masked (vinciMaskStreamJson). Before that, built-in calls
// the stream could not follow are shown over-masked and tool output is masked joined, as in the view.
// ---------------------------------------------------------------------------------------------------

/** A message the stream ended early (aborted, failed or cut at its length limit): its built-in calls may have been cut. */
function endedEarly(message: Json): boolean {
	return message?.stopReason === "aborted" || message?.stopReason === "error" || message?.stopReason === "length";
}

/**
 * A message shaped for the whole-object mask: in an assistant message, each built-in call is over-masked
 * when the message ended early; every other call carries the masked JSON of its arguments in place of any
 * retained partial argument text (maskCompletedPartial); a tool result message's output is masked joined.
 * Other messages, and everything else, are unchanged here.
 */
function shapeMessage(message: Json): Json {
	if (message?.role === "toolResult") return vinciMaskToolOutput(message);
	if (!isAssistant(message)) return message;
	const early = endedEarly(message);
	let changed = false;
	const content = message.content.map((block: Json) => {
		if (block?.type !== "toolCall") return block;
		const shown = early && viewMasksCall(block) ? maskCutCall(block) : maskCompletedPartial(block);
		if (shown !== block) changed = true;
		return shown;
	});
	return changed ? { ...message, content } : message;
}

/** Each message of a list through shapeMessage; anything that is not a list as given. */
function shapeMessages(messages: Json): Json {
	return Array.isArray(messages) ? messages.map(shapeMessage) : messages;
}

/** A session entry shaped for the whole-object mask: a message entry's message through shapeMessage. */
function shapeEntry(entry: Json, stream?: VinciStreamMask): Json {
	if (entry?.type !== "message" || !entry.message) return entry;
	return { ...entry, message: shapeMessage(stream ? stream.maskInterrupted(entry.message) : entry.message) };
}

/**
 * Mask one session message as RPC writes it: every string masked (vinciMaskStreamJson), after shapeMessage.
 * `stream`: the event path's VinciStreamMask; the calls it saw interrupted are over-masked the same way.
 */
export function vinciMaskViewMessage(message: Json, stream?: VinciStreamMask): Json {
	return vinciMaskStreamJson(shapeMessage(stream ? stream.maskInterrupted(message) : message));
}

/**
 * Mask one session entry as RPC writes it: every string of the entry masked, after a message entry's message
 * is shaped as vinciMaskViewMessage shapes it. Ids, parent ids, timestamps and the entry's keys are unchanged.
 */
export function vinciMaskViewEntry(entry: Json, stream?: VinciStreamMask): Json {
	return vinciMaskStreamJson(shapeEntry(entry, stream));
}

/**
 * Mask a session tree as RPC writes it: each node's entry shaped as vinciMaskViewEntry shapes it, then every
 * string masked; the nodes, children, labels and order are unchanged. Iterative, like the tree's own
 * construction: a long session is a deep chain.
 */
export function vinciMaskViewTree(roots: Json[], stream?: VinciStreamMask): Json[] {
	const copy = (node: Json): Json => {
		if (!node || typeof node !== "object") return node;
		return "entry" in node ? { ...node, entry: shapeEntry(node.entry, stream) } : { ...node };
	};
	const shaped = roots.map(copy);
	const stack: Json[] = [...shaped];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object" || !Array.isArray(node.children)) continue;
		node.children = node.children.map(copy);
		for (const child of node.children) stack.push(child);
	}
	return vinciMaskStreamJson(shaped) as Json[];
}

/** An assistant stream event shaped for the whole-object mask: the messages it carries through shapeMessage. */
function shapeAssistantEvent(source: Json): Json {
	if (!source || typeof source !== "object") return source;
	const shaped = { ...source };
	if (source.partial) shaped.partial = shapeMessage(source.partial);
	if (source.message) shaped.message = shapeMessage(source.message);
	if (source.error) shaped.error = shapeMessage(source.error);
	return shaped;
}

/**
 * Mask one RPC session event: every string masked (vinciMaskStreamJson), after the messages it carries are
 * shaped (built-in calls of a message that ended early over-masked, retained partial argument text replaced,
 * tool output masked joined). Nothing is passed through unmasked: user text, other tools' arguments and
 * output, compaction summaries, retry errors and extension events are masked too.
 */
export function vinciMaskViewEvent(event: Json): Json {
	let shaped = event;
	switch (event?.type) {
		case "message_start":
		case "message_end":
			shaped = withField(event, "message", shapeMessage);
			break;
		case "message_update":
			shaped = withField(withField(event, "message", shapeMessage), "assistantMessageEvent", shapeAssistantEvent);
			break;
		case "turn_end":
			shaped = withField(withField(event, "message", shapeMessage), "toolResults", shapeMessages);
			break;
		case "agent_end":
			shaped = withField(event, "messages", shapeMessages);
			break;
		case "tool_execution_update":
			shaped = withField(event, "partialResult", (result: Json) => vinciMaskToolOutput(result));
			break;
		case "tool_execution_end":
			shaped = withField(event, "result", (result: Json) => vinciMaskToolOutput(result));
			break;
	}
	return vinciMaskStreamJson(shaped);
}
