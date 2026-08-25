/**
 * Vinci tool-load — deferred tool schemas (roadmap #54 / GAP_ANALYSIS).
 *
 * Measured: bozza ships ~3.7k tokens of tool schemas on EVERY request across ~20 tools. For a 9B
 * that's context bloat AND a disambiguation burden (too many similar tools → the tool-name
 * hallucination we've patched). This defers the rare, specialist meta/delegation tools out of the
 * default active set: their PURPOSES stay visible in the `load_tools` meta-tool, but their full
 * schemas are only loaded when actually needed. Everyday tools (read/bash/edit/write/grep/find/ls,
 * todo, web_search/web_fetch, review_changes) are NEVER deferred — a 9B must reach those with zero
 * indirection. Only the "specialist cluster" a 9B rarely invokes well is deferred, so this can't
 * regress the common loop; the specialists stay reachable (and their /commands are unaffected).
 *
 * Additive — no core patch. Uses ctx.getActiveTools/setActiveTools. Env-tunable
 * (VINCI_DEFERRED_TOOLS="a,b,c"); kill switch VINCI_NO_DEFER=1 (nothing deferred, load_tools absent).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Tools we know how to defer, with the one-line purpose the model sees in load_tools. Only tools in
// this map can be deferred (so we never hide a tool whose purpose the model can't discover).
const KNOWN_DEFERRABLE: Record<string, string> = {
  advisor: "get a quick second opinion from a stronger model on one specific question",
  convene_council: "weigh a hard decision from several angles (optimist / skeptic / realist / strategist)",
  orchestrate: "break a big multi-part task into parts, work them in parallel, and synthesize the result",
  spawn_helper: "delegate a focused sub-task to a background helper working in its own copy of the repo",
  library_docs: "look up a library's official documentation (Context7)",
  web_answer: "get a direct, sourced answer to a factual or current-events question",
};

const DEFAULT_DEFERRED = ["advisor", "convene_council", "orchestrate", "spawn_helper"];

/** The set of tool names to defer (env-overridable), restricted to ones we have a purpose blurb for. */
export function deferredSet(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.VINCI_NO_DEFER === "1") return [];
  const raw = env.VINCI_DEFERRED_TOOLS;
  const names = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_DEFERRED;
  return names.filter((n) => n in KNOWN_DEFERRABLE);
}

/** Active set with deferred-but-not-yet-loaded tools removed (loaded ones + everything else kept). */
export function applyDeferral(active: string[], deferred: Set<string>, loaded: Set<string>): string[] {
  return active.filter((name) => !deferred.has(name) || loaded.has(name));
}

/** One-line menu of what can be loaded, for the load_tools description. */
export function loadMenu(deferred: string[]): string {
  return deferred.map((n) => `• ${n}: ${KNOWN_DEFERRABLE[n]}`).join("\n");
}

export default function (pi: ExtensionAPI) {
  const deferred = deferredSet();
  if (deferred.length === 0) return; // nothing to defer → no-op (kill switch or empty set)
  const deferredSetObj = new Set(deferred);
  const loaded = new Set<string>();

  // Remove deferred-but-not-loaded tools from the active set. Idempotent + fail-safe. Tool-set
  // control lives on `pi` (ExtensionAPI), NOT the event ctx (which doesn't expose it).
  const applyDeferralNow = (): void => {
    try {
      const active = pi.getActiveTools();
      const next = applyDeferral(active, deferredSetObj, loaded);
      if (next.length !== active.length) pi.setActiveTools(next);
    } catch {
      /* never break anything over a tool-set tweak */
    }
  };

  // Apply as EARLY as possible (session_start) so the FIRST request's system prompt is also built
  // from the reduced set — setActiveTools rebuilds the base system prompt, so the deferred tools'
  // guideline text drops out too, not just their schemas. Then re-apply every turn so the reduction
  // survives any per-turn active-set reset. NOTE: if session_start runs before pi's tool-set actions
  // are wired, the early call is a caught no-op — the tools-ARRAY reduction (the ~3.7k-token win)
  // still lands from turn 1 via before_agent_start; only the prompt-TEXT half would land from turn 2.
  pi.on("session_start", async () => void applyDeferralNow());
  pi.on("before_agent_start", async () => {
    applyDeferralNow();
    return undefined; // undefined → system prompt left untouched (never wiped)
  });

  pi.registerTool({
    name: "load_tools",
    label: "Load tool",
    description:
      "Some specialist tools are kept unloaded by default to stay fast and focused. When a task needs " +
      "one, call load_tools to activate it, then call the tool itself. You can load:\n" +
      loadMenu(deferred),
    promptSnippet: "Activate a specialist tool (advisor, council, orchestrate, helper) when a task needs it.",
    parameters: Type.Object({
      tool: Type.Union(
        deferred.map((n) => Type.Literal(n)),
        { description: "The specialist tool to activate." },
      ),
    }),
    async execute(_id, params: { tool: string }) {
      const tool = params?.tool;
      const details = { tool: "load_tools", loaded: tool };
      if (!tool || !deferredSetObj.has(tool)) {
        return { content: [{ type: "text", text: `"${tool}" isn't a loadable tool. Options: ${deferred.join(", ")}.` }], details };
      }
      // Activate, then VERIFY it actually took — setActiveTools silently ignores unknown names (e.g. a
      // VINCI_DEFERRED_TOOLS entry whose extension isn't loaded), so don't claim success blindly.
      let activated = false;
      try {
        const active = pi.getActiveTools();
        if (!active.includes(tool)) pi.setActiveTools([...active, tool]);
        activated = pi.getActiveTools().includes(tool);
      } catch {
        activated = false;
      }
      if (!activated) {
        return {
          content: [{ type: "text", text: `Couldn't activate "${tool}" — it isn't available in this session. Carry on without it.` }],
          details,
        };
      }
      loaded.add(tool);
      return {
        content: [{ type: "text", text: `✓ ${tool} is now available — call it now. (${KNOWN_DEFERRABLE[tool]})` }],
        details,
      };
    },
  });
}
