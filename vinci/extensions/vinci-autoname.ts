/**
 * Vinci session auto-naming.
 *
 * The resume picker lists your past sessions — but a raw first command ("Using your tools, does the
 * file vinci/bin/vinci exist…") is hard to tell apart at a glance. So after the first exchange we ask
 * the model for a short, human title — the way a chat app names a thread — and store it as the
 * session name. The picker shows that title in place of the first message (it already renders
 * `session.name ?? firstMessage`).
 *
 * Additive: one cheap `complete()` call per new session, fire-and-forget, interactive only, and it
 * never throws into the session. No core patch.
 */
import { classifyCompletionResult, complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	installVinciUsageAccumulator,
	recordVinciTaskCall,
} from "./lib/usage-accumulator.ts";

const TITLE_SYSTEM =
	"You write a very short title for a coding session, the way a chat app names a thread. Given the " +
	"user's first request, reply with ONLY a 2-to-5 word title in Title Case that names the task — no " +
	"quotes, no punctuation, no preamble, no trailing period. Examples: 'Add Dark Mode Toggle', " +
	"'Fix Login Redirect', 'Remove Anthropic Key'.";

const TITLE_TIMEOUT_MS = 8000;
const MAX_TITLE_LEN = 48;

const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
	return resp.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/**
 * Turn a model's title reply into a tidy session name. A 4B often ignores "Title Case" and returns
 * snake_case / kebab / lowercase, so we normalize: first non-empty line, strip quotes/markdown/trailing
 * punctuation, turn _ and - separators into spaces, Title-Case each word (preserving existing caps so
 * acronyms like API/SSH survive), and cap the length.
 */
export function cleanTitle(raw: string): string {
	const first = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	const words = first
		.replace(/^["'`*_#\s-]+/, "")
		.replace(/["'`*_.\s]+$/, "")
		.replace(/[\r\t_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const titled = words
		.split(" ")
		.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ");
	return titled.length > MAX_TITLE_LEN ? `${titled.slice(0, MAX_TITLE_LEN - 1).trim()}…` : titled;
}

async function generateTitle(pi: ExtensionAPI, firstUserText: string, ctx: ExtensionContext): Promise<void> {
	try {
		if (!ctx.model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return;
		const opts = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) };
		const resp = await complete(ctx.model, { systemPrompt: TITLE_SYSTEM, messages: [um(firstUserText.slice(0, 500))] }, opts);
		recordVinciTaskCall(ctx.sessionManager.getSessionId(), resp, "autoname");
		const status = classifyCompletionResult(resp);
		if (!status.ok) return;
		const title = cleanTitle(textOf(resp));
		if (title.length < 2) return;
		// Re-check immediately before writing. The name was checked before the model call, and that
		// call is slow enough for the user to run /name in the meantime — without this, a generated
		// title silently overwrites the name they chose.
		if (pi.getSessionName()) return;
		pi.setSessionName(title);
	} catch {
		/* naming is best-effort — never break the session */
	}
}

// Auto-naming is OFF pending a session-persistence signal (owner decision, 2026-07-28).
//
// It was silently dead for an unknown period: the code called `ctx.setSessionName`, which does not
// exist — the method lives on `pi`, and the `typeof ... !== "function"` guard turned that into a
// quiet no-op. That call-site bug is FIXED below. Switching the feature back on is a separate
// decision, because `generateTitle` issues a BILLED model call and `ctx.hasUI` is true in RPC and
// interactive `--no-session`, where the resulting name cannot even persist. `--no-session` is CLI
// state (`parsed.noSession`) that no extension API exposes, so gating on it correctly needs a new
// signal on ExtensionContext. Flip this to `true` once that exists.
const AUTONAME_ENABLED = false;

export default function (pi: ExtensionAPI) {
	installVinciUsageAccumulator(pi);
	let firstUserText: string | undefined;
	let named = false;

	pi.on("session_start", async () => {
		firstUserText = undefined;
		named = false;
	});

	// The first thing the user asks is what we title from.
	pi.on("input", async (event) => {
		if (firstUserText === undefined && event.text?.trim()) firstUserText = event.text.trim();
	});

	// After the first turn completes, title the session once — fire-and-forget so it never delays
	// anything. Interactive only (the title is for the picker; skip the cost on `-p` one-shots), and
	// only when the session isn't already named.
	pi.on("agent_end", async (_event, ctx) => {
		if (!AUTONAME_ENABLED) return;
		if (named || !ctx.hasUI || !firstUserText) return;
		if (pi.getSessionName()) {
			named = true;
			return;
		}
		if (!ctx.model) return;
		named = true; // one attempt per session, regardless of outcome
		void generateTitle(pi, firstUserText, ctx);
	});
}
