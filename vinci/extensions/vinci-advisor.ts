/**
 * Vinci advisor — the cheap, fast second opinion (Claude Code's `advisor`, done our way). When
 * Vinci is unsure about a SPECIFIC thing mid-task and just wants a quick gut-check — not several
 * angles — it calls `advisor`: ONE question to the STRONGEST available model. Cost-efficient (a
 * single call) and, unlike the council, it escalates to a bigger brain for the actual opinion.
 *
 * The pairing: `advisor` = fast single strong opinion · `convene_council` = deep multi-angle.
 *
 * Escalates to the strongest serving class; if none answers it explicitly announces which current
 * class will serve a genuine self-critique (fresh skeptical pass), which still catches mistakes.
 * Each stronger-tier call is latency-bounded (ADVISOR_TIMEOUT_MS) so a slow route can move to
 * disclosed self-review instead of hanging the turn. Additive; reuses Pi's resolved Vinci auth.
 */
import { classifyCompletionResult, complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

type CtxModel = NonNullable<ExtensionContext["model"]>;
type Registry = ExtensionContext["modelRegistry"];
type CompleteOpts = { apiKey: string; headers?: Record<string, string>; env?: Record<string, string>; signal?: AbortSignal };

const TIER_ORDER = ["forte", "fortissimo"];
const AUTO_CLASS = "auto"; // server-resolved; see askStronger (#182)
const ADVISOR_TIMEOUT_MS = 9000; // never let a stronger-model opinion hang the turn — degrade to self-review
const SAME_CLASS_ATTEMPTS = 2;

const ADVISOR_SYSTEM =
  "You are a senior engineering advisor giving a focused SECOND OPINION. Be direct and honest: say " +
  "whether the approach is sound, name the single biggest risk or a clearly better way if there is " +
  "one, and commit to a recommendation. A few tight sentences — no preamble, no hedging.";
const SELF_REVIEW_SYSTEM =
  "Review this with fresh, skeptical eyes as a second opinion — challenge it. What could be wrong, " +
  "what's the biggest risk, is there a simpler or better way? Be direct and commit to a recommendation. " +
  "A few tight sentences — no preamble.";

const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/** Ask the STRONGEST available tier above the current model, trying lower tiers only after class
 *  unavailability. The caller discloses the actual class before any self-review fallback. */
type StrongerResult = {
  answer?: { text: string; model: CtxModel };
  unavailableClasses: string[];
  /** The current model's class could not be placed in TIER_ORDER, so no escalation was possible.
   *  The caller MUST disclose this — silently self-reviewing is the #182 defect. */
  unknownClass?: boolean;
};

export async function askStronger(
  model: CtxModel,
  registry: Registry,
  opts: CompleteOpts,
  question: string,
  taskId: string,
): Promise<StrongerResult> {
  const unavailableClasses: string[] = [];
  // #182: "auto" is resolved SERVER-side, so the client cannot know its concrete class — and the
  // old TIER_ORDER.indexOf("auto") === -1 made the default setting return here silently, turning
  // every advisor request into an undisclosed self-review. Treat auto as "escalate to the top
  // class": at worst that equals what auto would have served, never weaker, and the reply is
  // labelled with the class that actually answered.
  const idx = model.id === AUTO_CLASS ? TIER_ORDER.length - 2 : TIER_ORDER.indexOf(model.id);
  // An id we cannot place at all must fail HONEST, not silently (#182).
  if (idx < 0) return { unavailableClasses, unknownClass: model.id !== AUTO_CLASS };
  for (let i = TIER_ORDER.length - 1; i > idx; i--) {
    const classId = TIER_ORDER[i];
    const m = registry.find("vinci", classId) as CtxModel | undefined;
    if (!m) {
      unavailableClasses.push(classId);
      continue;
    }
    for (let attempt = 1; attempt <= SAME_CLASS_ATTEMPTS; attempt++) {
      try {
        const attemptSignal = AbortSignal.timeout(ADVISOR_TIMEOUT_MS);
        const r = await complete(
          m,
          { systemPrompt: ADVISOR_SYSTEM, messages: [um(question)] },
          { ...opts, signal: attemptSignal },
        );
        assertSuccessfulVinciCompletion(r, attemptSignal);
        const status = classifyCompletionResult(r);
        if (!status.ok) {
          unavailableClasses.push(classId);
          break;
        }
        recordVinciTaskCall(taskId, r, "advisor:stronger");
        return { answer: { text: textOf(r), model: m }, unavailableClasses };
      } catch (error) {
        const kind = classifyVinciModelError(error);
        if (kind === "transient" && attempt < SAME_CLASS_ATTEMPTS) continue;
        if (kind === "transient" || kind === "unavailable") {
          unavailableClasses.push(classId);
          break;
        }
        throw new Error(
          `Advisor stopped on ${classId}; Vinci will not downgrade after an account or terminal error: ${describeVinciModelError(error)}`,
          { cause: error },
        );
      }
    }
  }
  return { unavailableClasses };
}

const ADVISOR_PARAMS = Type.Object({
  question: Type.String({ description: "The specific thing to sanity-check — an approach, a decision, 'is this right / is there a better way?'" }),
  context: Type.Optional(Type.String({ description: "Optional: the actual relevant context (what you're building, the plan, code, or diff in question). Pass tool output directly; shell substitutions such as $(git diff) are not executed." })),
});

function containsUnresolvedShellSubstitution(value: string): boolean {
  return /\$\([^\n)]/.test(value);
}

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Get a QUICK second opinion from a stronger advisor model — a fast gut-check before you commit, " +
      "cheaper than convening the full council (one call, not several). Use it mid-task to sanity-check " +
      "a SPECIFIC approach or decision when you just want one strong opinion; use convene_council when a " +
      "decision genuinely deserves several independent angles.",
    promptSnippet: "Quick single strong second opinion — cheaper than the council.",
    promptGuidelines: [
      "For a fast sanity-check on a specific approach mid-task, call advisor (one strong opinion). Use convene_council when the decision deserves several angles.",
      "Advisor arguments are data, not shell commands. Read diffs or files first and pass their actual contents; never pass $(...) placeholders.",
    ],
    parameters: ADVISOR_PARAMS,
    async execute(_toolCallId, params: { question: string; context?: string }, signal, _onUpdate, ctx: ExtensionContext) {
      const supplied = params.question + (params.context ? `\n${params.context}` : "");
      if (containsUnresolvedShellSubstitution(supplied)) {
        return {
          content: [{
            type: "text",
            text: "Advisor did not review this request: it contains a literal $(...) shell substitution. Tool arguments are not executed by a shell. Read the diff or file with a tool, then call advisor again with the actual content (split by file if needed). Do not use or report advice from this failed call.",
          }],
          details: { tool: "advisor", reviewed: false },
          isError: true,
        };
      }
      const unavailableDetails = { tool: "advisor", reviewed: false };
      if (!ctx.model) return { content: [{ type: "text", text: "Advisor unavailable: no model selected." }], details: unavailableDetails };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        return { content: [{ type: "text", text: "Advisor unavailable: not signed in (run /login vinci)." }], details: unavailableDetails };
      }
      const opts: CompleteOpts = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal };
      const q = params.question + (params.context ? `\n\nContext:\n${params.context}` : "");
      const reviewedDetails = { tool: "advisor", reviewed: true };
      const taskId = ctx.sessionManager.getSessionId();

      let stronger: StrongerResult;
      try {
        stronger = await askStronger(ctx.model, ctx.modelRegistry, opts, q, taskId);
      } catch (error) {
        const message = describeVinciModelError(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(message);
        throw error;
      }
      if (stronger.answer) {
        return { content: [{ type: "text", text: `${stronger.answer.model.name ?? stronger.answer.model.id} advises:\n\n${stronger.answer.text}` }], details: reviewedDetails };
      }
      const fallbackNotice =
        stronger.unavailableClasses.length > 0
          ? `Stronger Vinci ${stronger.unavailableClasses.join(", ")} ${stronger.unavailableClasses.length === 1 ? "class is" : "classes are"} unavailable. This advisor request will be served by ${ctx.model.name ?? ctx.model.id}; Vinci is not silently selecting a cheaper class.`
          : stronger.unknownClass
            ? `Vinci can't identify a class stronger than ${ctx.model.name ?? ctx.model.id}, so this is a self-review by the same model rather than a second opinion from a stronger one.`
            : undefined;
      if (fallbackNotice) {
        if (ctx.hasUI) ctx.ui.notify(fallbackNotice, "warning");
        else console.error(fallbackNotice);
      }
      let self: Awaited<ReturnType<typeof complete>>;
      try {
        self = await complete(ctx.model, { systemPrompt: SELF_REVIEW_SYSTEM, messages: [um(q)] }, opts);
        assertSuccessfulVinciCompletion(self, opts.signal);
        const status = classifyCompletionResult(self);
        if (!status.ok) throw new Error(status.error || "Self-review response was empty");
        recordVinciTaskCall(taskId, self, "advisor:fallback");
      } catch (error) {
        const message =
          `Advisor stopped on ${ctx.model.id}; no cheaper model was selected: ${describeVinciModelError(error)}`;
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(message);
        throw new Error(message, { cause: error });
      }
      return {
        content: [{ type: "text", text: fallbackNotice ? `${fallbackNotice}\n\n${textOf(self)}` : textOf(self) }],
        details: reviewedDetails,
      };
    },
  });
}
