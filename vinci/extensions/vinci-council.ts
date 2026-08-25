/**
 * The Vinci Council in the CLI — Vinci weighs a hard decision from several INDEPENDENT
 * angles (optimist / skeptic / realist / strategist) in parallel, then a "chair" combines
 * them: the strongest answer + where they agree/disagree + a confidence line.
 *
 * Two ways in, per the agentic vision:
 *  - AUTOMATIC: `convene_council` is a TOOL the model invokes on its own when it hits a
 *    genuine decision / trade-off (the same instinct as vinci-chat's auto-router).
 *  - MANUAL: `/council <question>` triggers it directly.
 *
 * Additive: the shared runCouncil() calls the model via pi-ai's `complete` (reusing Pi's
 * resolved auth for the Vinci provider). Lens + chair prompts mirror vinci-chat/lib/harness/
 * council.ts. First slice of the shared harness (VINCI_CODE_PLAN slice C).
 */
import { classifyCompletionResult, complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The current-model type, derived from the context (Model isn't re-exported by pi-coding-agent).
type CtxModel = NonNullable<ExtensionContext["model"]>;
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  installVinciUsageAccumulator,
  recordVinciTaskCall,
} from "./lib/usage-accumulator.ts";
import {
  assertSuccessfulVinciCompletion,
  classifyVinciModelError,
  describeVinciModelError,
} from "./vinci-model-provenance.ts";

const LENSES: Array<{ label: string; system: string }> = [
  { label: "Optimist", system: "Take the optimistic lens: make the strongest, most concrete case for the best option or path — the real upside and why it could genuinely work." },
  { label: "Skeptic", system: "Take the skeptical lens: name the biggest risks, hidden costs, shaky assumptions, and failure modes — what would make this a mistake, and what is everyone overlooking?" },
  { label: "Realist", system: "Take the pragmatic lens: what is actually feasible given real constraints (time, effort, skill)? The practical path and the concrete first step. Say what works, not the ideal." },
  { label: "Strategist", system: "Take the long-term lens: second-order effects and where each path leads in a year or more. Which choice best serves the deeper goal, even if it is harder now?" },
];

const LENS_FRAME =
  "You are one voice on a small council weighing a question for an engineer. Give your take " +
  "directly and COMMIT to a recommendation — never ask the user a question. Two to four tight sentences. ";

const CHAIR_SYSTEM =
  "You are the chair of a small council. You are given several independent takes on the same " +
  "question, each from a deliberately different angle. Weigh them against each other — do not " +
  "simply average them; take the strongest reasoning from each. Write the strongest combined " +
  "answer first (a short, decisive recommendation). Then add three short Markdown sections: " +
  "'## Where the council agrees', '## Where it disagrees', and '## Confidence' (one line: high, " +
  "medium, or low, with a clause why). Be concise and concrete.";

type CompleteOpts = { apiKey: string; headers?: Record<string, string>; env?: Record<string, string>; signal?: AbortSignal };

function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

// Advisor escalation: the lenses run cheap (the base model — several perspectives, low cost), but the
// CHAIR — the final judgment — runs on a STRONGER model when one's available. That's the "ask a more
// powerful advisor" idea, folded into the council + cost-efficient (only one expensive call). The
// chair call is latency-bounded (CHAIR_TIMEOUT_MS): if the stronger tier isn't serving OR is too
// slow, the user is told which base class will synthesize before that call starts.
type Registry = ExtensionContext["modelRegistry"];
const TIER_ORDER = ["forte", "fortissimo"];
const CHAIR_TIMEOUT_MS = 15000; // bound stronger-model chair synthesis — degrade to the base-model chair
const SAME_CLASS_ATTEMPTS = 2;
function nextTierId(model: CtxModel): string | undefined {
  const idx = TIER_ORDER.indexOf(model.id);
  return idx < 0 || idx >= TIER_ORDER.length - 1 ? undefined : TIER_ORDER[idx + 1];
}

/** Run the lenses in parallel, then a (stronger-model, when available) chair. Returns the combined
 *  answer (Markdown). Shared by the /council command and the convene_council tool. */
export async function runCouncil(
  model: CtxModel,
  opts: CompleteOpts,
  question: string,
  registry: Registry,
  taskId: string,
  announce: (message: string, level: "warning" | "error") => void,
): Promise<string> {
  const takes = await Promise.all(
    LENSES.map(async (lens) => {
      try {
        const r = await complete(model, { systemPrompt: LENS_FRAME + lens.system, messages: [um(question)] }, opts);
        assertSuccessfulVinciCompletion(r, opts.signal);
        const status = classifyCompletionResult(r);
        recordVinciTaskCall(taskId, r, `council:${lens.label.toLowerCase()}`);
        // Skip empty lens takes; council will synthesize from non-empty ones
        if (!status.ok) {
          console.warn(`Council ${lens.label} lens returned empty; skipping this take`);
          return { label: lens.label, text: "" };
        }
        return { label: lens.label, text: textOf(r) };
      } catch (error) {
        const message =
          `Council ${lens.label.toLowerCase()} lens stopped on ${model.id}; no model substitution was attempted: ${describeVinciModelError(error)}`;
        announce(message, "error");
        throw new Error(message, { cause: error });
      }
    }),
  );
  if (opts.signal?.aborted) return "";
  const material = takes.map((t) => `### ${t.label}\n${t.text}`).join("\n\n");
  const chairCtx = { systemPrompt: CHAIR_SYSTEM, messages: [um(`QUESTION: ${question}\n\nThe council's takes:\n\n${material}`)] };
  const strongerClass = nextTierId(model);
  let fallbackNotice: string | undefined;
  if (strongerClass) {
    const advisor = registry.find("vinci", strongerClass) as CtxModel | undefined;
    if (!advisor) {
      fallbackNotice = `Vinci ${strongerClass} is unavailable. Council synthesis will be served by ${model.name ?? model.id}; Vinci is not silently selecting a cheaper class.`;
    } else {
      for (let attempt = 1; attempt <= SAME_CLASS_ATTEMPTS; attempt++) {
        try {
          const attemptSignal = AbortSignal.timeout(CHAIR_TIMEOUT_MS);
          const response = await complete(
            advisor,
            chairCtx,
            { ...opts, signal: attemptSignal },
          );
          assertSuccessfulVinciCompletion(response, attemptSignal);
          const status = classifyCompletionResult(response);
          recordVinciTaskCall(taskId, response, "council:chair");
          // Empty chair from stronger class: fall back to weaker class
          if (!status.ok) {
            console.warn("Council chair from stronger class returned empty; falling back");
            break;
          }
          return textOf(response);
        } catch (error) {
          const kind = classifyVinciModelError(error);
          if (kind === "transient" && attempt < SAME_CLASS_ATTEMPTS) continue;
          if (kind === "transient" || kind === "unavailable") {
            fallbackNotice = `Vinci ${strongerClass} is unavailable after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}. Council synthesis will be served by ${model.name ?? model.id}; Vinci is not silently selecting a cheaper class.`;
            break;
          }
          const message = `Council stopped on ${strongerClass}; Vinci will not downgrade after an account or terminal error: ${describeVinciModelError(error)}`;
          announce(message, "error");
          throw new Error(message, { cause: error });
        }
      }
    }
  }
  if (fallbackNotice) announce(fallbackNotice, "warning");
  try {
    const response = await complete(model, chairCtx, opts);
    assertSuccessfulVinciCompletion(response, opts.signal);
    const status = classifyCompletionResult(response);
    recordVinciTaskCall(taskId, response, "council:chair");
    // Empty chair fallback: return lenses only without chair synthesis
    if (!status.ok) {
      console.warn("Council chair fallback returned empty; using lenses only");
      const lensOnly = `(Chair synthesis unavailable — the council's takes follow.)\n\n${material}`;
      return fallbackNotice ? `${fallbackNotice}\n\n${lensOnly}` : lensOnly;
    }
    return fallbackNotice ? `${fallbackNotice}\n\n${textOf(response)}` : textOf(response);
  } catch (error) {
    const message =
      `Council stopped on ${model.id}; no cheaper model was selected: ${describeVinciModelError(error)}`;
    announce(message, "error");
    throw new Error(message, { cause: error });
  }
}

const COUNCIL_PARAMS = Type.Object({
  question: Type.String({ description: "What you're unsure about — the decision, trade-off, or hard sub-problem to weigh from multiple angles." }),
});

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  // AUTOMATIC — a tool the model calls on its own for genuine decisions/trade-offs.
  pi.registerTool({
    name: "convene_council",
    label: "Vinci Council",
    description:
      "Get a stronger SECOND OPINION when you're genuinely unsure — call this MID-TASK, before you " +
      "commit to an approach you're not confident about, when a sub-problem is thorny, or when the user " +
      "faces a real decision/trade-off. Several independent angles (optimist, skeptic, realist, strategist) " +
      "are weighed and combined BY A STRONGER MODEL into a decisive recommendation with where they " +
      "agree/disagree and a confidence level. Reach for it whenever you'd otherwise guess at something " +
      "important — not for routine steps you're already confident in.",
    promptSnippet: "Get a stronger second opinion on something you're unsure about — several angles, combined.",
    promptGuidelines: [
      "When you're genuinely uncertain about an approach, or facing a real trade-off mid-task, call convene_council for a stronger second opinion BEFORE committing — don't just guess.",
    ],
    parameters: COUNCIL_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const details = { tool: "convene_council" };
      if (!ctx.model) return { content: [{ type: "text", text: "The council is unavailable: no model selected." }], details };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        return { content: [{ type: "text", text: "The council is unavailable: not signed in (run /login vinci)." }], details };
      }
      const synthesis = await runCouncil(
        ctx.model,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
        params.question,
        ctx.modelRegistry,
        ctx.sessionManager.getSessionId(),
        (message, level) => {
          if (ctx.hasUI) ctx.ui.notify(message, level);
          else console.error(message);
        },
      );
      return { content: [{ type: "text", text: synthesis || "The council returned nothing." }], details };
    },
  });

  // MANUAL — /council <question>, rendered in its own panel.
  pi.registerCommand("council", {
    description: "Weigh a hard decision from several independent angles, then combine",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (ctx.mode !== "tui") return void ctx.ui.notify("The council needs interactive mode", "error");
      if (!question) return void ctx.ui.notify("Usage: /council <a decision or hard question>", "info");
      if (!ctx.model) return void ctx.ui.notify("No model selected", "error");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return void ctx.ui.notify("error" in auth ? auth.error : "Not signed in — run /login vinci", "error");
      if (!auth.apiKey) return void ctx.ui.notify("Not connected to Vinci — type /login to connect.", "error");
      const model = ctx.model;
      const registry = ctx.modelRegistry;
      const taskId = ctx.sessionManager.getSessionId();
      const opts: CompleteOpts = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

      const synthesis = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Convening the council · ${LENSES.length} takes…`);
        loader.onAbort = () => done(null);
        runCouncil(model, { ...opts, signal: loader.signal }, question, registry, taskId, (message, level) =>
          ctx.ui.notify(message, level))
          .then((s) => done(s || null))
          .catch(() => done("The council couldn't finish that one — mind trying again in a moment?"));
        return loader;
      });

      if (!synthesis) return void ctx.ui.notify("Council cancelled", "info");

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold("  Vinci Council")), 1, 0));
        container.addChild(new Markdown(synthesis, 1, 1, getMarkdownTheme()));
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
