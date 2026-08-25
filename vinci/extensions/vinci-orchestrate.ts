/**
 * The Vinci orchestrator — the automation centerpiece. For a genuinely multi-part task, Vinci
 * TAKES CHARGE instead of grinding through it linearly: it breaks the task into a few concrete
 * parts, works them IN PARALLEL as focused sub-agents, REVIEWS each result (its own grader), and
 * SYNTHESIZES a single vetted plan/result — flagging anything that didn't pass review.
 *
 * Two ways in (the agentic vision):
 *  - AUTOMATIC: `orchestrate` is a TOOL the model invokes on its own when a task is clearly
 *    multi-part (build a feature, refactor across files, research-then-implement).
 *  - MANUAL: `/orchestrate <task>` runs it directly, rendered in its own panel.
 *
 * v1 sub-agents are focused `complete()` workers (the proven council/review machinery — testable
 * against the live gateway). v2 (VINCI_CODE_PLAN) upgrades them to real tool-using nested agents
 * via the pi-agent-core `Agent` primitive so they can read/edit/run on their own. The loop —
 * decompose → parallel work → grade → synthesize — is the part that stays.
 *
 * Additive: no core edits. Reuses Pi's resolved auth for the Vinci provider.
 */
import { classifyCompletionResult, complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  DynamicBorder,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  installVinciUsageAccumulator,
  recordVinciTaskCall,
} from "./lib/usage-accumulator.ts";

// The current-model type, derived from the context (Model isn't re-exported by pi-coding-agent).
type CtxModel = NonNullable<ExtensionContext["model"]>;
type CompleteOpts = { apiKey: string; headers?: Record<string, string>; env?: Record<string, string>; signal?: AbortSignal };

const DECOMPOSER_SYSTEM =
  "You are Vinci's planner. Break the user's task into 2–5 concrete, mostly-independent parts that " +
  "could each be worked on separately. Output ONLY a numbered list — one part per line, each a short, " +
  "actionable objective (imperative, concrete). No preamble, no explanation, no code. If the task is " +
  "genuinely simple and single-step, output just one line.";

const WORKER_SYSTEM =
  "You are one focused sub-agent in a team. Do ONLY your assigned part of the larger task — thoroughly " +
  "and concretely. You have READ-ONLY tools (read, grep, find, ls): use them to look at the ACTUAL files " +
  "in this project before answering — don't guess at names, paths, or existing code. When you have what " +
  "you need, reply with your concrete result (approach + key code) as plain text, no more tool calls. " +
  "Assume a teammate will integrate your piece; do not restate the other parts.";

const GRADER_SYSTEM =
  "You are a strict reviewer. Judge whether the sub-agent's result actually accomplishes its assigned " +
  "part: correct, complete, and on-target. Reply with exactly 'PASS' or 'NEEDS WORK' on the FIRST line, " +
  "then one or two sentences naming the specific gap or confirming it's solid. Be terse.";

const SYNTH_SYSTEM =
  "You are the orchestrator integrating your team's work. Combine the reviewed parts into ONE coherent, " +
  "correct result for the overall task. Lean on the parts that passed review; fix or clearly flag any " +
  "that needed work — never paper over a gap. Lead with the decisive final result/plan, then a short " +
  "'## Notes' section for anything flagged or any follow-up. Concise, concrete, plain language.";

function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

// The gateway rate-limits bursts (a 5-wide worker fan-out returns 429 "Server busy"). Retry those
// (and transient 5xx) with backoff, and cap how many run at once.
const RATE = /429|rate.?limit|server busy|overloaded|50[234]\b/i;
async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function withRetry<T extends { stopReason?: string; errorMessage?: string }>(fn: () => Promise<T>, signal?: AbortSignal, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const result = await fn();
      if (result.stopReason === "aborted") return result;
      // Check if result is error-shaped (stopReason="error") — if so, trigger a retry.
      if (result.stopReason === "error" && i < tries - 1) {
        last = new Error(result.errorMessage || `Completion ${result.stopReason}`);
        // Treat error-shaped results as transient failures worthy of retry, with backoff
        await waitForRetry(Math.min(8000, 1000 * 2 ** i), signal);
        continue;
      }
      return result;
    } catch (e) {
      last = e;
      if (i === tries - 1 || !RATE.test(e instanceof Error ? e.message : String(e))) throw e;
      // Exponential backoff (1s→8s) — the gateway's shared rate limit needs real breathing room.
      await waitForRetry(Math.min(8000, 1000 * 2 ** i), signal);
    }
  }
  throw last;
}
/** Run fn over items with at most `limit` in flight (keeps the gateway happy), preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const CONCURRENCY = 2;

/** Turn the planner's list into clean subtask strings; robust to numbered / bulleted / messy output. */
function parseSubtasks(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l.length > 2 && !/^(here|these|plan|steps?)[:\s]/i.test(l))
    .slice(0, 5);
}

type Verdict = "pass" | "needs-work" | "unclear";
// The grader is told to lead with 'PASS' or 'NEEDS WORK'. Read the LEADING token — do NOT scan the
// line for stray keywords: a PASS explanation legitimately contains words like "missing pieces"
// ("...the missing helpers are clearly called out"), which would falsely flip it to needs-work.
function parseVerdict(text: string): { verdict: Verdict; critique: string } {
  const clean = text.trim().replace(/^[^a-zA-Z]+/, ""); // strip leading markdown/punctuation
  const lead = clean.toLowerCase();
  const firstLine = clean.split("\n")[0];
  let verdict: Verdict = "unclear";
  if (lead.startsWith("needs")) verdict = "needs-work";
  else if (lead.startsWith("pass")) verdict = "pass";
  else if (/\bneeds?\s*work\b|\bfail(?:s|ed)?\b/i.test(firstLine)) verdict = "needs-work";
  else if (/\bpass(?:es|ed)?\b|\bcorrect\b|\bsolid\b/i.test(firstLine)) verdict = "pass";
  const rest = text.trim().split("\n").slice(1).join(" ").trim() || text.trim();
  return { verdict, critique: rest.slice(0, 200) };
}

export type OrchestratedPart = { task: string; result: string; verdict: Verdict; critique: string; tier?: string };
export type Orchestration = { synthesis: string; parts: OrchestratedPart[] };

// Auto-escalation ladder: when a part fails review, Vinci retries it on the next model up. A tier
// that isn't reachable just throws and we keep the current result; the retry call-site bounds latency.
type Registry = ExtensionContext["modelRegistry"];
const TIER_ORDER = ["forte", "fortissimo"];
class CompletionClassificationError extends Error {}
// The retry worker runs a full multi-step tool loop, so it gets a longer budget than a single-call
// guard (loopbreak's 9s) — enough for legit exploration, but still bounding a slow route.
const ESCALATE_TIMEOUT_MS = 45000;
function nextTier(model: CtxModel, registry: Registry): CtxModel | null {
  const idx = TIER_ORDER.indexOf(model.id);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return (registry.find("vinci", TIER_ORDER[idx + 1]) as CtxModel | undefined) ?? null;
}

// Read-only tools for sub-agents: they can EXPLORE (read/grep/find/ls) but never write — so parallel
// sub-agents can't conflict, and there's nothing destructive to guard. The main agent does the writes.
function readOnlyTools(cwd: string): unknown[] {
  const mk = (f: (c: string) => unknown) => {
    try {
      return f(cwd);
    } catch {
      return null;
    }
  };
  return [mk(createReadTool), mk(createGrepTool), mk(createFindTool), mk(createLsTool)].filter(Boolean);
}

/**
 * A sub-agent that actually explores the codebase: a manual complete() tool-loop over the read-only
 * tools (validated live — piccolo calls tools then answers from real file content). Bounded by
 * maxSteps so cost stays sane; forces a tool-less final answer if it runs out of exploration budget.
 */
async function toolLoopWorker(
  model: CtxModel,
  opts: CompleteOpts,
  overall: string,
  part: string,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTools (structurally Tool[]) + ad-hoc message shapes.
  tools: any[],
  taskId: string,
  maxSteps = 4,
): Promise<string> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const messages: unknown[] = [um(`OVERALL TASK: ${overall}\n\nYOUR PART: ${part}`)];
  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return "";
    const resp = await withRetry(
      () => complete(model, { systemPrompt: WORKER_SYSTEM, messages: messages as never, tools }, { ...opts, maxTokens: 1200 }),
      opts.signal,
    );
    recordVinciTaskCall(taskId, resp, "orchestrate:worker");
    // biome-ignore lint/suspicious/noExplicitAny: content is a discriminated union; we filter toolCalls.
    const calls = (resp.content as any[]).filter((c) => c.type === "toolCall");
    if (calls.length === 0) {
      // Final step (no tool calls) — classify for empty content
      const status = classifyCompletionResult(resp);
      if (!status.ok) throw new Error(status.error || "Worker returned no valid content");
      return textOf(resp);
    }
    messages.push(resp);
    for (const c of calls) {
      const tool = toolMap.get(c.name);
      let content: unknown = [{ type: "text", text: `unknown tool ${c.name}` }];
      let isError = true;
      if (tool) {
        try {
          const r = await tool.execute(c.id, c.arguments, opts.signal);
          content = r.content;
          isError = false;
        } catch (e) {
          content = [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }];
        }
      }
      messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content, isError });
    }
  }
  // Out of exploration budget → force a concrete final answer with no tools.
  const final = await withRetry(
    () => complete(model, { systemPrompt: `${WORKER_SYSTEM} You're out of exploration steps — give your best result now, no tool calls.`, messages: messages as never, tools: [] }, { ...opts, maxTokens: 1200 }),
    opts.signal,
  );
  recordVinciTaskCall(taskId, final, "orchestrate:worker-final");
  const finalStatus = classifyCompletionResult(final);
  if (!finalStatus.ok) throw new Error(finalStatus.error || "Final answer returned no valid content");
  return textOf(final);
}

/** decompose → parallel tool-using sub-agents → grade each → synthesize. Shared by tool + command. */
export async function runOrchestrator(
  model: CtxModel,
  opts: CompleteOpts,
  task: string,
  cwd: string,
  registry: Registry,
  taskId: string,
  onPhase?: (msg: string) => void,
): Promise<Orchestration> {
  const call = async (systemPrompt: string, userText: string, maxTokens: number, source: string) => {
    const response = await withRetry(
      () => complete(model, { systemPrompt, messages: [um(userText)] }, { ...opts, maxTokens }),
      opts.signal,
    );
    recordVinciTaskCall(taskId, response, source);
    const status = classifyCompletionResult(response);
    if (!status.ok) throw new CompletionClassificationError(status.error || "Completion returned no valid content");
    return response;
  };
  const grade = async (subtask: string, result: string) => {
    try {
      return parseVerdict(
        textOf(
          await call(
            GRADER_SYSTEM,
            `PART: ${subtask}\n\nRESULT:\n${result}`,
            200,
            "orchestrate:grading",
          ),
        ),
      );
    } catch (error) {
      if (!(error instanceof CompletionClassificationError)) throw error;
      return { verdict: "needs-work" as const, critique: "grader returned no usable output" };
    }
  };
  const aborted = () => opts.signal?.aborted ?? false;
  const tools = readOnlyTools(cwd);

  onPhase?.("Planning the approach…");
  let planText = "";
  try {
    planText = textOf(
      await call(
        DECOMPOSER_SYSTEM,
        task,
        400,
        "orchestrate:planning",
      ),
    );
  } catch (error) {
    if (!(error instanceof CompletionClassificationError)) throw error;
    console.warn(`Orchestrator planner returned no usable output: ${error.message}`);
  }
  if (aborted()) return { synthesis: "", parts: [] };
  let subtasks = parseSubtasks(planText);
  if (subtasks.length < 2) subtasks = [task]; // simple/single → one part, still graded + synthesized

  onPhase?.(`Working ${subtasks.length} part${subtasks.length === 1 ? "" : "s"} (exploring the code)…`);
  const worked = await mapLimit(subtasks, CONCURRENCY, async (st) => {
    try {
      const result = await toolLoopWorker(model, opts, task, st, tools, taskId);
      return { task: st, result };
    } catch (error) {
      console.warn(`Orchestrator worker failed for subtask "${st}": ${error instanceof Error ? error.message : String(error)}`);
      return { task: st, result: "" };
    }
  });
  if (aborted()) return { synthesis: "", parts: [] };

  onPhase?.("Reviewing each result…");
  const parts: OrchestratedPart[] = await mapLimit(worked, CONCURRENCY, async (w) => {
    const { verdict, critique } = await grade(w.task, w.result);
    return { ...w, verdict, critique };
  });
  if (aborted()) return { synthesis: "", parts };

  // Auto-escalate: any part that didn't pass review is retried on a stronger serving class
  // if one is available. Vinci manages its own knobs — and tells you. The retry is latency-bounded
  // (ESCALATE_TIMEOUT_MS): a tier that isn't serving OR is too slow throws/times out and we keep the
  // current result.
  for (const p of parts.filter((x) => x.verdict === "needs-work")) {
    if (aborted()) break;
    let stronger = nextTier(model, registry);
    while (stronger) {
      onPhase?.(`This part's tricky — bringing in ${stronger.name ?? stronger.id}…`);
      // Bound the whole stronger-tier retry worker: with no per-call timeout, a slow route could hang
      // here. On timeout the worker either throws (→ catch below) or returns empty (→ the guard below)
      // — either way we keep the current result (loopbreak/scope escalation idiom).
      const escalateSignal = AbortSignal.timeout(ESCALATE_TIMEOUT_MS);
      try {
        const better = await toolLoopWorker(stronger, { ...opts, signal: escalateSignal }, task, p.task, tools, taskId);
        if (escalateSignal.aborted) break; // timed out mid-worker → keep the current result, don't overwrite with a partial
        const v = await grade(p.task, better);
        p.result = better;
        p.verdict = v.verdict;
        p.critique = v.critique;
        p.tier = stronger.name ?? stronger.id;
        if (v.verdict === "pass") break; // good enough — stop climbing
      } catch {
        break; // this tier isn't serving (dormant) or timed out — keep the current result
      }
      stronger = nextTier(stronger, registry);
    }
  }
  if (aborted()) return { synthesis: "", parts };

  onPhase?.("Bringing it together…");
  const material = parts
    .map((p, i) => `### Part ${i + 1}: ${p.task}\n**Review:** ${p.verdict}${p.critique ? ` — ${p.critique}` : ""}\n\n${p.result}`)
    .join("\n\n");
  try {
    const synth = await call(
      SYNTH_SYSTEM,
      `OVERALL TASK: ${task}\n\nThe reviewed parts:\n\n${material}`,
      2000,
      "orchestrate:synthesis",
    );
    return { synthesis: textOf(synth), parts };
  } catch (error) {
    if (!(error instanceof CompletionClassificationError)) throw error;
    return { synthesis: "Synthesis unavailable — the reviewed parts are shown as produced.", parts };
  }
}

/** Compact, model-facing trace so the agent can act on what the orchestrator found. */
function traceForModel(o: Orchestration): string {
  const trace = o.parts
    .map((p, i) => `${i + 1}. [${p.verdict}] ${p.task}${p.tier ? ` · redone with ${p.tier}` : ""}${p.verdict === "needs-work" && p.critique ? ` (flag: ${p.critique})` : ""}`)
    .join("\n");
  return `${o.synthesis}\n\n---\nHow this was broken down (and reviewed):\n${trace}`;
}

const ORCH_PARAMS = Type.Object({
  task: Type.String({ description: "The multi-part task to take charge of: build/refactor/research-then-implement, etc." }),
});

// Reach the inner loader's setMessage() to show live phases (BorderedLoader wraps a Loader).
function setPhase(loader: BorderedLoader, msg: string): void {
  // biome-ignore lint/suspicious/noExplicitAny: private inner loader; TS-private only, present at runtime.
  (loader as any).loader?.setMessage?.(msg);
}

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  // AUTOMATIC — a tool the model calls on its own for clearly multi-part work.
  pi.registerTool({
    name: "orchestrate",
    label: "Vinci Orchestrator",
    description:
      "Take charge of a genuinely MULTI-PART task: break it into a few concrete parts, work them in " +
      "parallel, review each result, and return one vetted, integrated plan/result. Use this for building " +
      "a feature, refactoring across several files, or research-then-implement work — NOT for a single " +
      "edit, a simple question, or a quick command (do those directly).",
    promptSnippet: "Decompose a multi-part task, work the parts in parallel, review each, and synthesize.",
    promptGuidelines: ["Prefer orchestrate for multi-part work; do single-step tasks directly."],
    parameters: ORCH_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const details = { tool: "orchestrate" };
      if (!ctx.model) return { content: [{ type: "text", text: "Orchestration unavailable: no model selected." }], details };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        return { content: [{ type: "text", text: "Orchestration unavailable: not signed in (run /login vinci)." }], details };
      }
      const o = await runOrchestrator(
        ctx.model,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
        params.task,
        ctx.cwd,
        ctx.modelRegistry,
        ctx.sessionManager.getSessionId(),
      );
      return { content: [{ type: "text", text: o.synthesis ? traceForModel(o) : "Orchestration returned nothing." }], details };
    },
  });

  // MANUAL — /orchestrate <task>, rendered in its own panel with the breakdown + reviews.
  pi.registerCommand("orchestrate", {
    description: "Take charge of a multi-part task: break it down, work the parts, review each, synthesize",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (ctx.mode !== "tui") return void ctx.ui.notify("The orchestrator needs interactive mode", "error");
      if (!task) return void ctx.ui.notify("Usage: /orchestrate <a multi-part task>", "info");
      if (!ctx.model) return void ctx.ui.notify("No model selected", "error");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return void ctx.ui.notify("error" in auth ? auth.error : "Not signed in — run /login vinci", "error");
      if (!auth.apiKey) return void ctx.ui.notify("Not connected to Vinci — type /login to connect.", "error");
      const model = ctx.model;
      const cwd = ctx.cwd;
      const registry = ctx.modelRegistry;
      const taskId = ctx.sessionManager.getSessionId();
      const opts: CompleteOpts = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

      const result = await ctx.ui.custom<Orchestration | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Taking charge · planning…");
        loader.onAbort = () => done(null);
        runOrchestrator(model, { ...opts, signal: loader.signal }, task, cwd, registry, taskId, (msg) => setPhase(loader, `Taking charge · ${msg}`))
          .then((o) => done(o.synthesis ? o : null))
          .catch(() => done({ synthesis: "The orchestrator couldn't finish that one — mind trying again in a moment?", parts: [] }));
        return loader;
      });

      if (!result) return void ctx.ui.notify("Orchestration cancelled", "info");

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        const mark = (v: Verdict) => (v === "pass" ? "✓" : v === "needs-work" ? "⚠" : "·");
        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold("  Vinci orchestrated this")), 1, 0));
        container.addChild(new Markdown(result.synthesis, 1, 1, getMarkdownTheme()));
        if (result.parts.length) {
          container.addChild(new Text(theme.fg("dim", "  How I broke it down:"), 1, 0));
          for (const p of result.parts) {
            const badge = p.tier ? theme.fg("accent", `  ↑ ${p.tier}`) : "";
            container.addChild(new Text(theme.fg("dim", `  ${mark(p.verdict)} ${p.task}`) + badge, 1, 0));
          }
        }
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
