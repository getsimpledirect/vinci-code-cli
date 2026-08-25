/**
 * Vinci modes — Auto and Plan, cycled with Shift+Tab (the pattern people expect).
 *
 *   ▶ Auto  (default) — Vinci builds freely: reads, edits, runs commands. The guard still blocks
 *                       anything catastrophic and /undo reverts.
 *   ◇ Plan            — planning ONLY. Vinci explores the codebase (read/grep/find/ls) and writes a
 *                       detailed plan in the UI, but the write/edit/bash tools are switched off, so it can't
 *                       change anything. Approve by switching back to Auto and saying go.
 *
 * Mostly automatic: for a genuinely big/risky task Vinci lays out a plan first on its own (see the
 * character pack) — Shift+Tab is the manual override. Pure extension: registerShortcut binds the
 * key, a tool_call block enforces "no coding" in Plan, and a system-prompt note steers the planning.
 * No core patch.
 */
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getVinciAutomationStop, sendVinciControl } from "./lib/control.ts";
import { setVinciMode, type VinciMode } from "./lib/ui-state.ts";

let mode: VinciMode = "auto";
let allowPlanFile = false;
let planPresented = false;
let planContinues = 0;
const MAX_PLAN_CONTINUES = 6;

function assistantText(message: { role: string; content?: readonly { type: string; text?: string }[] }): string {
  if (message.role !== "assistant" || !message.content) return "";
  return message.content
    .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

// In Plan mode we block anything that CHANGES the project. write/edit always. bash is trickier —
// the model EXPLORES with it (ls/cat/grep/find/git status), so we only block bash that MODIFIES
// (rm/mv/mkdir/touch, sed -i, package installs, git write ops, or a `>`/`>>` file redirect).
// Read-only bash runs, so the model can actually explore and reach a plan.
const MUTATING_TOOLS = new Set(["write", "edit"]);
// Match mutating VERBS only at a command position (line start or after ; | & && ||) so flags like
// `ls -ln` or filenames like `cat cp.txt` don't false-positive (which would re-break exploration).
const AT = "(?:^|[;&|\\n])\\s*(?:sudo\\s+)?";
const MUTATING_BASH = new RegExp(`${AT}(rm|rmdir|mv|cp|mkdir|touch|ln|tee|dd|chmod|chown|truncate|rename|shred)\\b`, "i");
const MUTATING_SED = new RegExp(`${AT}sed\\b[^|;&]*\\s-i`, "i");
const MUTATING_GIT = new RegExp(`${AT}git\\s+(add|commit|push|checkout|switch|reset|merge|rebase|stash|apply|clean|rm|mv|tag|init)\\b`, "i");
const MUTATING_PKG = new RegExp(`${AT}(npm|pnpm|yarn|bun|pip|pip3|brew|apt|apt-get|cargo|gem|composer)\\s+(install|add|i|remove|uninstall|rm|update|upgrade|ci|link)\\b`, "i");
const MUTATING_DATABASE = new RegExp(
  `${AT}(?:(?:npx|pnpm\\s+exec|yarn\\s+exec|bunx)\\s+)?(?:prisma\\s+(?:migrate\\s+(?:dev|deploy|reset|resolve)|db\\s+push)|drizzle-kit\\s+(?:push|migrate)|sequelize\\s+db:migrate|knex\\s+migrate:latest|(?:rails|rake)\\s+db:migrate)\\b`,
  "i",
);
// A `>`/`>>` that writes to a real file (not 2>&1, >&, or >/dev/null).
const WRITE_REDIRECT = /(?<![0-9&>])>>?(?!\s*(?:\/dev\/null\b|&))\s*\S/;
export function planCommandMutates(cmd: string): boolean {
  return (
    MUTATING_BASH.test(cmd) ||
    MUTATING_SED.test(cmd) ||
    MUTATING_GIT.test(cmd) ||
    MUTATING_PKG.test(cmd) ||
    MUTATING_DATABASE.test(cmd) ||
    WRITE_REDIRECT.test(cmd)
  );
}

const PLAN_BLOCK =
  "Plan Mode is on — planning only, no file changes. Explore freely with read/grep/find/ls and " +
  "read-only commands (ls, cat, git status/log/diff). When your plan is ready, call present_plan " +
  "for one-tap approval; if the user approves you'll switch to Auto and build it.";

// A short, clear approval — the WHOLE message must be one (so "yes but also do X" doesn't count and
// instead falls through to the confirm-on-write below). Lets a plain "yes" auto-switch to Auto.
const APPROVAL =
  /^\s*(?:yes|yep|yeah|yup|sure|ok(?:ay)?|go(?:\s*ahead)?|do it|build it|make it|add it|proceed|please do|go for it|sounds good|let'?s (?:do it|go|build it)|approve[d]?|confirm(?:ed)?|👍)[\s.!]*$/i;
const APPROVAL_AND_BUILD =
  /^\s*(?:yes[\s,;:!-]+)?approve[d]?[\s,;:!-]+(?:let'?s\s+)?(?:start\s+)?(?:implement(?:ing)?|build(?:ing)?|execute|make (?:the )?changes)(?:\s+(?:it|this|the plan))?[\s.!]*$/i;
// Planning INTENT, not the mere word "plan": an imperative planning verb at a clause start (with an
// optional "please"/"let's" lead-in). The old noun match flipped Auto→Plan on "keep going with the
// plan" mid-task (round-2 audit P2-7).
const PLAN_ONLY_REQUEST = /(?:^|[.!?]\s+)(?:(?:please|let'?s)\s+)*(?:plan|design|map out|sketch|outline|think through)\b/i;
const IMPLEMENT_TOO =
  /\b(?:implement|build|code|execute|make (?:the )?changes|start changing|then do it|keep going|continue|proceed|go ahead|stick to|carry on)\b/i;
const SAVE_PLAN_FILE = /\b(?:save|write|create|put)\b[^\n]{0,40}\bplan\b[^\n]{0,30}\b(?:file|document|markdown|\.md)\b/i;
const PLAN_FILE = /(?:^|[-_.])plans?(?:[-_.][^.]+)?\.md$/i;

const PLAN_PROMPT = `
## Plan Mode is ON — plan, don't build
You are PLANNING, not building: anything that would CHANGE a file is switched off (write/edit, and
commands like rm/mkdir/touch or a "> file" redirect). But you CAN explore freely — read, grep, find,
ls, and read-only shell commands (ls, cat, git status/log/diff). Take your time, look at the real
code, then form a DETAILED plan: the approach in plain language, the exact files you'll create or
change and what each change does, the steps in order, and any risks worth confirming.
Do NOT stop on a progress update or wait for the user to say "continue". Keep doing focused,
read-only inspection until the plan is complete or a specific material decision truly blocks it.
When the plan is ready, call the **present_plan** tool (a one-line summary + the ordered steps) so
the user can approve it in ONE tap — don't just write the plan as prose. If they approve you'll be
switched to Auto to build it right away; if not, ask what to change.`;

// Distinct COLOURS so the mode is obvious at a glance: Auto = green (go / building), Plan = amber
// (hold / planning, no changes). Both bold + coloured. (Footer status keeps embedded colour —
// sanitizeStatusText only touches whitespace.)
function indicator(m: VinciMode, theme: Theme): string {
  return m === "plan"
    ? `${theme.fg("warning", theme.bold("◇ PLAN"))}${theme.fg("warning", " — read-only, no changes")}${theme.fg("dim", " · Shift+Tab to build")}`
    : `${theme.fg("success", theme.bold("▶ AUTO"))}${theme.fg("success", " — building")}${theme.fg("dim", " · Shift+Tab to plan first")}`;
}

const PLAN_PARAMS = Type.Object({
  summary: Type.String({ description: "One line: what you'll build/change, in plain language." }),
  steps: Type.Array(Type.String(), { description: "The plan, in order — each step or file you'll change, phrased simply." }),
});

export default function (pi: ExtensionAPI) {
  // present_plan — the model calls this when its plan is ready. Shows the plan with a one-tap
  // "Build?" approval; on yes it flips to Auto (unblocking the tools) and tells the model to build
  // right away, in the same turn. That's the whole approve→build flow, no Shift+Tab or "go" needed.
  pi.registerTool({
    name: "present_plan",
    label: "Plan",
    description:
      "Present your finished plan to the user for one-tap approval before building. Call it once you've " +
      "formed a plan — in Plan mode, or for a big/risky task in Auto mode. Give a one-line summary and the " +
      "ordered steps/files. If approved you'll build it immediately; if not, ask what to change.",
    promptSnippet: "Show your plan for one-tap approval before building.",
    // Friendly header (matches vinci-render's style) instead of the raw "present_plan".
    renderCall: (args: { summary?: string }, theme: Theme) => {
      let t = theme.fg("accent", "Here's the plan");
      if (args?.summary) t += theme.fg("dim", "  " + (args.summary.length > 68 ? args.summary.slice(0, 67) + "…" : args.summary));
      return new Text(t, 0, 0);
    },
    parameters: PLAN_PARAMS,
    async execute(_toolCallId, params: { summary: string; steps: string[] }, _signal, _onUpdate, ctx: ExtensionContext) {
      const details = { tool: "present_plan" };
      planPresented = true;
      planContinues = 0;
      if (!ctx.hasUI) {
        // No UI to approve (e.g. print mode) — proceed so automation isn't blocked.
        mode = "auto";
        setVinciMode(mode);
        return { content: [{ type: "text", text: "No approval step here — I'll go ahead and build it." }], details };
      }
      // A blank line between steps so a plan of long, paragraph-length steps reads as a scannable list
      // instead of a wall (a non-programmer has to actually read this before approving).
      const steps = (params.steps ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n\n");
      const approved = await ctx.ui.confirm("Vinci's plan", `${params.summary}\n\n${steps}\n\nBuild this?`);
      if (approved) {
        mode = "auto"; // unblock the write/edit/bash tools so the build can proceed this turn
        setVinciMode(mode);
        ctx.ui.setStatus("vinci-mode", indicator(mode, ctx.ui.theme));
        ctx.ui.notify("Plan approved ✓", "info");
        // First person so it reads as Vinci narrating (not a leaked instruction), while still cueing
        // the model to start building this turn.
        return { content: [{ type: "text", text: "Approved — building it now. I'll make the changes and run whatever's needed." }], details };
      }
      ctx.ui.notify("Not approved yet — tell me what to change.", "info");
      return { content: [{ type: "text", text: "Not approved yet — I'll ask what you'd like to change, revise the plan, and show it again. Staying in Plan mode until then." }], details };
    },
  });

  // Shift+Tab cycles Auto ⇄ Plan.
  pi.registerShortcut("shift+tab", {
    description: "Switch between Auto (build) and Plan (plan only)",
    handler: (ctx: ExtensionContext) => {
      mode = mode === "auto" ? "plan" : "auto";
      planPresented = false;
      planContinues = 0;
      setVinciMode(mode);
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("vinci-mode", indicator(mode, ctx.ui.theme));
      ctx.ui.notify(
        mode === "plan"
          ? "Plan mode — I'll explore and write a plan, but won't change anything. Shift+Tab when you're ready to build."
          : "Auto mode — I'll build it.",
        "info",
      );
    },
  });

  // Show the current mode from the start.
  pi.on("session_start", async (_event, ctx) => {
    mode = "auto";
    allowPlanFile = false;
    planPresented = false;
    planContinues = 0;
    setVinciMode(mode);
    if (ctx.hasUI) ctx.ui.setStatus("vinci-mode", indicator(mode, ctx.ui.theme));
  });

  // Auto-toggle: when the user CONFIRMS in Plan mode ("yes", "go ahead", "build it"…), switch to Auto
  // right then — no second dialog, they already said yes. Their message then runs in Auto so Vinci
  // can build immediately. Only a whole-message approval flips it; anything with more detail ("yes but
  // change X") stays in Plan so Vinci keeps planning (and the confirm-on-write below still backstops).
  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    allowPlanFile = SAVE_PLAN_FILE.test(text);
    planContinues = 0;
    if (mode === "plan") planPresented = false;

    // A mid-stream steer is not the user changing modes: flipping on streamed text that happens to
    // mention "plan" switched the mode mid-turn (round-2 audit P2-7). Never flip on streaming input.
    if (event.streamingBehavior) return undefined;

    // Natural-language planning gets the same deterministic read-only boundary as Shift+Tab. A user
    // should not need to know a mode shortcut to keep "let's plan this out" from changing files.
    if (mode === "auto" && PLAN_ONLY_REQUEST.test(text) && !IMPLEMENT_TOO.test(text)) {
      mode = "plan";
      planPresented = false;
      setVinciMode(mode);
      if (ctx.hasUI) {
        ctx.ui.setStatus("vinci-mode", indicator(mode, ctx.ui.theme));
        ctx.ui.notify("Plan mode — exploring and designing without changing your project.", "info");
      }
      return undefined;
    }

    if (mode === "plan" && (APPROVAL.test(text) || APPROVAL_AND_BUILD.test(text))) {
      mode = "auto";
      setVinciMode(mode);
      if (ctx.hasUI) {
        ctx.ui.setStatus("vinci-mode", indicator(mode, ctx.ui.theme));
        ctx.ui.notify("Approved — switching to Auto and building it.", "info");
      }
    }
    return undefined;
  });

  // In Plan mode, read-only exploration runs freely (read/grep/find/ls + `ls -la`/`cat`/`git status`).
  // But the moment Vinci tries to CHANGE something (write/edit/mutating bash), that means it's done
  // planning and ready to build — so instead of just blocking, we ASK to switch to Auto and go. Yes →
  // leave Plan and let it build; No → stay in Plan. (This is the reliable approve→build path even when
  // the model doesn't call present_plan — a write attempt IS the "ready to build?" moment.)
  pi.on("tool_call", async (event, ctx) => {
    if (mode !== "plan") return undefined;
    const path =
      event.toolName === "write" || event.toolName === "edit"
        ? String((event.input as { path?: unknown }).path ?? "")
        : "";
    if (path && PLAN_FILE.test(basename(path)) && !allowPlanFile) {
      sendVinciControl(
        pi,
        "vinci-plan-file-block",
        "Keep the plan in Vinci's plan UI. Do not create a plan file unless the user explicitly asks to save one. Continue planning and call present_plan when ready.",
      );
      return { block: true, reason: "Plan mode keeps plans in Vinci instead of writing project files." };
    }
    const wantsToChange =
      MUTATING_TOOLS.has(event.toolName) ||
      (event.toolName === "bash" && planCommandMutates(String((event.input as { command?: unknown }).command ?? "")));
    if (!wantsToChange) return undefined;
    if (!ctx.hasUI) {
      sendVinciControl(pi, "vinci-plan-headless-block", PLAN_BLOCK);
      return { block: true, reason: "Plan mode kept the project unchanged; no approval UI is available." };
    }
    const ok = await ctx.ui.confirm("Vinci — ready to build?", "Vinci has a plan and wants to start making changes. Switch to Auto and build it now?");
    if (ok) {
      mode = "auto";
      setVinciMode(mode);
      ctx.ui.setStatus("vinci-mode", indicator(mode, ctx.ui.theme));
      ctx.ui.notify("Building it now.", "info");
      return undefined; // let this change through — we're in Auto now
    }
    sendVinciControl(pi, "vinci-plan-block", PLAN_BLOCK);
    return { block: true, reason: "Plan mode kept the project unchanged." };
  });

  // Steer the model to plan (not build) while in Plan mode.
  pi.on("before_agent_start", async (event) => {
    if (mode !== "plan") return undefined;
    return { systemPrompt: `${event.systemPrompt}\n${PLAN_PROMPT}` };
  });

  // Planning is active work, not a sequence of user-operated checkpoints. If the model ends on a
  // progress paragraph before presenting a plan, queue a private follow-up while the loop is still
  // open. A real question, error, abort, or present_plan call still returns control normally.
  pi.on("turn_end", async (event) => {
    if (process.env.VINCI_NO_AUTOCONTINUE === "1" || mode !== "plan" || planPresented) return;
    if (getVinciAutomationStop().stopped) return;
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
    if (event.message.content.some((part) => part.type === "toolCall")) return;
    if (/\?\s*$/.test(assistantText(event.message)) || planContinues >= MAX_PLAN_CONTINUES) return;

    planContinues++;
    const finalRecovery = planContinues === MAX_PLAN_CONTINUES;
    pi.sendMessage(
      {
        customType: "vinci-plan-continue",
        display: false,
        content: finalRecovery
          ? "Planning is still unfinished. Use the evidence already gathered and call present_plan now, or ask one specific question if a material decision truly blocks the plan."
          : "Continue the read-only planning work now without waiting for the user to say continue. Do the next focused inspection, synthesize courses and infrastructure into one concrete plan, and call present_plan when it is ready.",
      },
      { deliverAs: "followUp" },
    );
  });
}
