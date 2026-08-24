/**
 * Vinci outcome — "did it work?", in plain language (roadmap Tier 2).
 *
 * The verification system (Phases 1–2) makes the MODEL's claims trustworthy. This closes the loop for
 * the USER: after a change, a non-programmer needs to know, in plain words, WHAT changed and — the
 * part frontier tools skip because they assume a developer who can read a diff — the ONE concrete
 * thing THEY can do to confirm it actually worked (a command to run, a page to open, a thing to
 * click). Grounded in the REAL git diff, not the model's say-so — same honesty moat as the grader,
 * pointed at the user instead of the model.
 *
 *   • /check → read the uncommitted diff, explain what changed + the single best way to confirm it.
 *
 * Additive — no core patch. Reuses the shared grounded-diff infra (gatherDiff/gatherTask). The model
 * is also nudged (character pack) to end a task this way on its own; /check is the reliable, grounded
 * backstop the user can run anytime.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { classifyCompletionResult, complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { gatherDiff, gatherTask } from "./lib/grader.ts";
import {
  installVinciUsageAccumulator,
  recordVinciTaskCall,
} from "./lib/usage-accumulator.ts";

type CompleteOpts = { apiKey: string; headers?: Record<string, string>; env?: Record<string, string>; signal?: AbortSignal };

export const OUTCOME_SYSTEM =
  "You are explaining to a NON-PROGRAMMER what was just done to their project and how they can " +
  "confirm it actually worked. You are given the TASK they asked for and the DIFF of what changed. " +
  "Reply in EXACTLY this shape, warm and plain, with NO jargon and NO file paths (name the real-world " +
  "thing — 'the page that shows your orders', not 'the route handler'):\n\n" +
  "What changed: <1-2 short sentences a non-technical person understands>\n\n" +
  "To check it worked: <the SINGLE most useful concrete thing they can do — one command to run, one " +
  "web address to open, or one specific thing to look at or click. If it genuinely can't be checked " +
  "without more setup, say so honestly and name the closest thing they can look at.>\n\n" +
  "Rules: Do NOT claim it works — give them the way to SEE for themselves. If the diff does not " +
  "actually accomplish the task, say plainly what's missing instead of inventing a check. One check — " +
  "the most important one. Keep the whole thing under ~60 words.";

const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/** Grounded plain-language "what changed + how to confirm it" for the user, over the real diff. */
export async function explainForUser(
  model: NonNullable<Parameters<typeof complete>[0]>,
  opts: CompleteOpts,
  task: string,
  diff: string,
  taskId?: string,
): Promise<string> {
  if (!diff) return "";
  const r = await complete(model, { systemPrompt: OUTCOME_SYSTEM, messages: [um(`TASK:\n${task}\n\nDIFF:\n${diff}`)] }, opts);
  if (taskId) recordVinciTaskCall(taskId, r, "outcome:check");
  const status = classifyCompletionResult(r);
  if (!status.ok) return "";
  return textOf(r);
}

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  pi.registerCommand("check", {
    description: "Explain in plain language what changed and the one way to confirm it worked",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return void ctx.ui.notify("Check needs interactive mode", "error");
      if (!ctx.model) return void ctx.ui.notify("No model selected", "error");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return void ctx.ui.notify("error" in auth ? auth.error : "Not connected — run /login vinci", "error");
      if (!auth.apiKey) return void ctx.ui.notify("Not connected to Vinci — type /login to connect.", "error");
      const diff = gatherDiff(process.cwd());
      if (!diff) return void ctx.ui.notify("No changes yet — nothing to check.", "info");
      const model = ctx.model;
      const opts: CompleteOpts = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
      const task = gatherTask(ctx);
      const taskId = ctx.sessionManager.getSessionId();

      const card = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Checking what changed…");
        loader.onAbort = () => done(null);
        explainForUser(model, { ...opts, signal: loader.signal }, task, diff, taskId)
          .then((s) => done(s || null))
          .catch(() => done("Couldn't put that together just now — mind trying /check again in a moment?"));
        return loader;
      });

      if (!card) return void ctx.ui.notify("Check cancelled", "info");

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold("  Did it work?")), 1, 0));
        container.addChild(new Markdown(card, 1, 1, getMarkdownTheme()));
        container.addChild(new Text(theme.fg("dim", "  Press Enter or Esc to close"), 1, 0));
        container.addChild(border);
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
          },
        };
      });
    },
  });
}
