/**
 * The Vinci grader ("Outcomes") in the CLI — an INDEPENDENT reviewer that reads the real
 * git diff of what changed and judges it against the task: does it correctly + completely do
 * the job, and what are the concrete problems? Vinci's honesty moat applied to code review.
 *
 * Completion claims are reviewed automatically by the core turn-end gate. The explicit surfaces stay
 * available for user-requested or genuinely mid-task review without duplicating that automatic call:
 *  - TOOL: `review_changes` for an explicit second opinion before completion.
 *  - COMMAND: `/review` grades the working-tree diff on demand.
 *
 * Grounded in the ACTUAL diff (not the model's claim about what it did). Mirrors the
 * self-check concept from vinci-chat/lib/harness/grader.ts (verifyAnswer). Shared harness
 * slice (VINCI_CODE_PLAN roadmap ②). Additive — no core patch.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
// Shared grader core (untracked-aware diff + skeptical-of-unverified-claims prompt). See
// lib/grader.ts and vinci/docs/verification.md.
import { type CompleteOpts, gatherDiff, gatherTask, runReview } from "./lib/grader.ts";
import {
  installVinciUsageAccumulator,
  recordVinciTaskCall,
} from "./lib/usage-accumulator.ts";

const REVIEW_PARAMS = Type.Object({
  task: Type.Optional(Type.String({ description: "What the change was meant to accomplish (defaults to the latest user request)." })),
});

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  // EXPLICIT — core already reviews settled completion claims; this is for requested/mid-task review.
  pi.registerTool({
    name: "review_changes",
    label: "Vinci Review",
    description:
      "When the user explicitly requests a separate review, have an independent reviewer grade the current git diff: it " +
      "reads the ACTUAL uncommitted changes and returns concrete problems (bugs, missing cases, risks) " +
      "or confirms the work is solid, with a verdict. Do not call this as a routine final step because " +
      "completion claims are reviewed automatically.",
    promptSnippet: "Independently review the current git diff against the task and return concrete issues + a verdict.",
    promptGuidelines: [
      "Do not call review_changes as a routine final step; completion claims are reviewed automatically. Use it only for an explicit user request or a real mid-task second opinion.",
    ],
    parameters: REVIEW_PARAMS,
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
      const details = { tool: "review_changes" };
      if (!ctx.model) return { content: [{ type: "text", text: "Review unavailable: no model." }], details };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) return { content: [{ type: "text", text: "Review unavailable: not signed in (/login vinci)." }], details };
      const diff = gatherDiff(process.cwd());
      if (!diff) return { content: [{ type: "text", text: "No uncommitted changes to review." }], details };
      const task = params.task?.trim() || gatherTask(ctx);
      const taskId = ctx.sessionManager.getSessionId();
      const critique = await runReview(
        ctx.model,
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal,
          onUsage: (response) => recordVinciTaskCall(taskId, response, "review"),
        },
        task,
        diff,
      );
      return { content: [{ type: "text", text: critique || "The reviewer returned nothing." }], details };
    },
  });

  // MANUAL — /review, rendered in its own panel.
  pi.registerCommand("review", {
    description: "Independently review your uncommitted changes against the task",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return void ctx.ui.notify("Review needs interactive mode", "error");
      if (!ctx.model) return void ctx.ui.notify("No model selected", "error");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return void ctx.ui.notify("error" in auth ? auth.error : "Not signed in — run /login vinci", "error");
      if (!auth.apiKey) return void ctx.ui.notify("Not connected to Vinci — type /login to connect.", "error");
      const diff = gatherDiff(process.cwd());
      if (!diff) return void ctx.ui.notify("No uncommitted changes to review.", "info");
      const model = ctx.model;
      const taskId = ctx.sessionManager.getSessionId();
      const opts: CompleteOpts = {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        onUsage: (response) => recordVinciTaskCall(taskId, response, "review"),
      };
      const task = gatherTask(ctx);

      const critique = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Reviewing your changes…");
        loader.onAbort = () => done(null);
        runReview(model, { ...opts, signal: loader.signal }, task, diff)
          .then((s) => done(s || null))
          .catch(() => done("The review couldn't finish that one — mind trying again in a moment?"));
        return loader;
      });

      if (!critique) return void ctx.ui.notify("Review cancelled", "info");

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold("  Vinci Review")), 1, 0));
        container.addChild(new Markdown(critique, 1, 1, getMarkdownTheme()));
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
