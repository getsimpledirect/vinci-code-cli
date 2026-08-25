/**
 * Vinci-owned interactive shell.
 *
 * Pi supplies the editor mechanics and agent runtime; this extension owns the persistent product
 * chrome: a stateful composer border, honest connection state, mode/model/project orientation, and
 * the only continuous animation on screen while work is active.
 */
import { basename } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./lib/format-duration.ts";
import {
  getVinciUiState,
  resetShellUiState,
  setVinciActivity,
  setVinciConnection,
  setVinciContinuationPending,
  setVinciWorking,
  setVinciWorkingLabel,
  subscribeVinciUiState,
  type VinciActivityState,
} from "./lib/ui-state.ts";
import { containsVerificationCommand } from "./vinci-verification.ts";

export const VINCI_PULSE_FRAMES = ["·", "•", "●", "•"] as const;
const PULSE_INTERVAL_MS = 260;
const COMPOSER_TOP_MARGIN = "";

function bashActivity(command: string): string {
  if (containsVerificationCommand(command)) return "Verifying the change…";
  if (/\bgit\s+(?:diff|status|show|log)\b/i.test(command)) return "Reviewing the changes…";
  if (/\b(?:prisma|drizzle-kit|sequelize|knex|rails|rake)\b[^\n]*\b(?:migrate|db\s+push)\b/i.test(command)) {
    return "Updating the database…";
  }
  return "Running the next step…";
}

export function vinciActivityStateForTool(toolName: string, input: unknown): VinciActivityState {
  const name = toolName.toLowerCase();
  if (name === "rerun_check") return "verifying";
  if (
    name === "bash" &&
    containsVerificationCommand(String((input as { command?: unknown } | undefined)?.command ?? ""))
  ) {
    return "verifying";
  }
  return "working";
}

export function vinciActivityStateAfterTool(): VinciActivityState {
  return "working";
}

/** Compact, deterministic activity copy: lively enough to feel human, stable enough to trust. */
export function vinciActivityForTool(toolName: string, input: unknown): string {
  const name = toolName.toLowerCase();
  if (vinciActivityStateForTool(toolName, input) === "verifying") return "Verifying the change…";
  if (name === "web_search" || name === "web_fetch" || name === "web_answer" || name === "library_docs") {
    return "Looking for current information…";
  }
  if (name === "read" || name === "grep" || name === "find" || name === "ls" || /(?:read|inspect|search|look)/.test(name)) {
    return "Looking through the project…";
  }
  if (name === "edit" || name === "write" || /(?:edit|write|update|create)/.test(name)) return "Making the change…";
  if (name === "bash") return bashActivity(String((input as { command?: unknown } | undefined)?.command ?? ""));
  if (name === "todo" || name === "present_plan") return "Organizing the plan…";
  if (name === "review_changes") return "Reviewing the result…";
  if (name === "advisor" || name === "convene_council") return "Considering another perspective…";
  if (name === "orchestrate" || name === "spawn_helper") return "Coordinating the work…";
  if (/(?:test|check|verify)/.test(name)) return "Checking the result…";
  return "Working through it…";
}

export function vinciActivityAfterTool(toolName: string, isError: boolean): string {
  if (isError) return "Adjusting the approach…";
  const name = toolName.toLowerCase();
  if (name === "read" || name === "grep" || name === "find" || name === "ls" || /(?:read|inspect|search|look)/.test(name)) {
    return "Considering what I found…";
  }
  if (name === "edit" || name === "write" || /(?:edit|write|update|create)/.test(name)) return "Checking the change…";
  if (name === "review_changes") return "Considering the review…";
  return "Considering the next step…";
}

function fitBorder(
  left: string,
  right: string,
  width: number,
  edge: (text: string) => string,
  fill: (text: string) => string,
  leftEdge = "─",
  rightEdge = "─",
): string {
  if (width <= 0) return "";
  if (width === 1) return edge(leftEdge);

  let leftText = left;
  let rightText = right;
  const minimumGap = 3;
  const fixedWidth = 2;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }
  if (rightText && !rightText.endsWith(" ")) {
    rightText = `${truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "")} `;
  }

  const gap = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
  return `${edge(leftEdge)}${leftText}${fill("─".repeat(gap))}${rightText}${edge(rightEdge)}`;
}

function plainLine(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function paintBackground(text: string, background: (part: string) => string): string {
  return text
    .split("\x1b[0m")
    .map((part) => background(part))
    .join("\x1b[0m");
}

function formatTokens(count: number): string {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  if (!usage || usage.percent === null) return "";
  // "% full" leads (the primary at-a-glance signal); the raw token count trails so it degrades
  // gracefully — on a narrow border the token add-on truncates first, keeping "% full" intact.
  const percent = `${Math.round(usage.percent)}% full`;
  return usage.tokens === null || usage.tokens === undefined ? percent : `${percent} · ↓ ${formatTokens(usage.tokens)}`;
}

function formatModel(ctx: ExtensionContext): string {
  const name = ctx.model?.name ?? ctx.model?.id ?? "connecting";
  return name.replace(/^Vinci\s+/i, "").replace(/\s*\(([^)]+)\)$/, " $1");
}

function formatProject(cwd: string, width: number): string {
  if (width < 100) return basename(cwd) || cwd;
  const home = process.env.HOME;
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function authFailed(errorMessage: string | undefined): boolean {
  return !!errorMessage && /\b401\b|\b403\b|unauthor|forbidden|invalid[_ -].*(key|token|credential)|not signed in|authentication/i.test(errorMessage);
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  let branch: string | undefined;
  let frame = 0;

  // /thinking — let the user trade speed for depth. Vinci Forte (GLM 5.2) has three usable levels:
  // Quick disables reasoning entirely (~instant first token), Balanced is the thoughtful default, Deep
  // spends the most on hard problems. (GLM collapses low/medium/high into one, so we expose exactly
  // these three; the gateway honors the choice — see the reasoning_effort plumbing.)
  const THINKING_CHOICES: ReadonlyArray<{ level: ThinkingLevel; name: string; blurb: string }> = [
    { level: "medium", name: "Quick", blurb: "answers right away — skips deep thinking (fastest)" },
    { level: "high", name: "Balanced", blurb: "thinks first, then answers — the default" },
    { level: "xhigh", name: "Deep", blurb: "maximum reasoning for hard problems (slowest)" },
  ];
  pi.registerCommand("thinking", {
    description: "Set how much Vinci thinks before answering (speed vs depth)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const current = pi.getThinkingLevel();
      const rows = THINKING_CHOICES.map((c) => `${c.name} — ${c.blurb}${c.level === current ? "   ● current" : ""}`);
      const choice = await ctx.ui.select("How should Vinci think?", rows);
      if (choice === undefined) return;
      const picked = THINKING_CHOICES[rows.indexOf(choice)];
      if (!picked) return;
      pi.setThinkingLevel(picked.level);
      ctx.ui.notify(`Thinking set to ${picked.name} — ${picked.blurb}.`, "info");
    },
  });
  let animation: ReturnType<typeof setInterval> | undefined;
  let continuationWatchdog: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeState: (() => void) | undefined;
  const verificationToolCallIds = new Set<string>();

  const requestRender = () => activeTui?.requestRender();
  const stopAnimation = () => {
    if (animation) clearInterval(animation);
    animation = undefined;
  };
  const clearContinuationWatchdog = () => {
    if (continuationWatchdog) clearTimeout(continuationWatchdog);
    continuationWatchdog = undefined;
  };
  const startAnimation = () => {
    stopAnimation();
    // Print mode has no TUI to animate; an interval here only pins the event
    // loop open after the answer is written.
    if (!activeTui) return;
    frame = 0;
    animation = setInterval(() => {
      frame = (frame + 1) % VINCI_PULSE_FRAMES.length;
      requestRender();
    }, PULSE_INTERVAL_MS);
  };

  pi.on("session_start", async (_event, ctx) => {
    verificationToolCallIds.clear();
    resetShellUiState();
    stopAnimation();
    clearContinuationWatchdog();
    unsubscribeState?.();
    unsubscribeState = subscribeVinciUiState(requestRender);

    ctx.ui.setWorkingVisible(false);
    ctx.ui.setFooter(() => new EmptyFooter());
    ctx.ui.setTitle(`Vinci · ${basename(ctx.cwd) || "project"}`);

    const branchResult = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined);
    branch = branchResult?.stdout.trim() || undefined;

    class VinciEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: 2, autocompleteMaxVisible: 6 });
        activeTui = tui;
      }

      override setPaddingX(padding: number): void {
        super.setPaddingX(Math.max(2, padding));
      }

      render(width: number): string[] {
        if (width < 4) return super.render(width);
        const innerWidth = width - 2;
        const lines = super.render(innerWidth);
        if (lines.length < 2) return lines;

        const state = getVinciUiState();
        const theme = ctx.ui.theme;
        const elapsedMs = state.workingSince ? Math.max(0, Date.now() - state.workingSince) : 0;
        const elapsed = formatDuration(elapsedMs, { rounding: "floor" });
        const workingLabel = truncateToWidth(state.workingLabel, Math.max(16, width - 42), "…");
        const modeLabel =
          state.mode === "plan"
            ? theme.fg("warning", theme.bold("◇ PLAN"))
            : theme.fg("success", theme.bold("▶ AUTO"));
        const connectionLabel =
          state.connection === "connected"
            ? theme.fg("success", " ● connected ")
            : state.connection === "signed-in"
              ? theme.fg("accent", " ● signed in ")
              : state.connection === "reconnect"
                ? theme.fg("warning", " ! reconnect ")
                : state.connection === "signed-out"
                  ? theme.fg("warning", " /login ")
                  : theme.fg("dim", " ◌ checking ");
        const pulse = frame === 2 ? theme.bold(VINCI_PULSE_FRAMES[frame]) : VINCI_PULSE_FRAMES[frame];
        const topLeft = state.working
          ? theme.fg("accent", ` ${pulse} `) +
            theme.fg("mdHeading", ` ${workingLabel} `) +
            theme.fg("dim", `· ${elapsed} `)
          : state.mode === "plan"
            ? theme.fg("warning", theme.bold(" ◇ Plan with Vinci "))
            : theme.fg("accent", theme.bold(" ✹ Ask Vinci "));
        const context = formatContext(ctx);
        const project = `${formatProject(ctx.cwd, width)}${branch ? ` (${branch})` : ""}`;
        const bottomLeft = ` ${modeLabel}${theme.fg("dim", "  ·  ")}${theme.fg("muted", formatModel(ctx))} `;
        const bottomRightParts = width >= 70 ? [project, context].filter(Boolean) : [project];
        const bottomRight = theme.fg("dim", ` ${bottomRightParts.join("  ·  ")} `);
        const edgeColor = state.working
          ? (text: string) => theme.fg("accent", text)
          : state.mode === "plan"
            ? (text: string) => theme.fg("warning", text)
            : (text: string) => theme.fg("accent", text);
        const fillColor = (text: string) => theme.fg("borderMuted", text);

        lines[0] = fitBorder(topLeft, connectionLabel, width, edgeColor, fillColor, "╭", "╮");
        const bottomBorderIndex = lines.findIndex(
          (line, index) => index > 0 && (/^─+$/.test(plainLine(line)) || /^─── ↓ \d+ more ─*$/.test(plainLine(line))),
        );
        if (bottomBorderIndex > 0) {
          const contentLines: string[] = [];
          for (let index = 1; index < bottomBorderIndex; index++) {
            const prompt = index === 1 ? theme.fg("accent", "›") : " ";
            const content = `${prompt}${lines[index].slice(1)}`;
            contentLines.push(
              `${edgeColor("│")}${paintBackground(content, (part) => theme.bg("selectedBg", part))}${edgeColor("│")}`,
            );
          }
          const blank = `${edgeColor("│")}${theme.bg("selectedBg", " ".repeat(innerWidth))}${edgeColor("│")}`;
          const bottom = fitBorder(bottomLeft, bottomRight, width, edgeColor, fillColor, "╰", "╯");
          const autocomplete = lines.slice(bottomBorderIndex + 1).map((line) => ` ${line} `);
          // TUI keeps the end of the component tree at the bottom of the viewport.
          // Put transient autocomplete rows above the composer so opening or closing
          // the picker does not move the input box or its cursor line.
          return [...autocomplete, COMPOSER_TOP_MARGIN, lines[0], blank, ...contentLines, blank, bottom];
        }
        return [COMPOSER_TOP_MARGIN, ...lines];
      }
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VinciEditor(tui, theme, keybindings));
    requestRender();
  });

  pi.on("agent_start", () => {
    verificationToolCallIds.clear();
    clearContinuationWatchdog();
    const continuing = getVinciUiState().continuationPending;
    setVinciContinuationPending(false);
    setVinciWorking(
      true,
      continuing
        ? "Continuing the task…"
        : getVinciUiState().mode === "plan"
          ? "Considering the approach…"
          : "Contemplating…",
    );
    startAnimation();
  });

  pi.on("turn_start", () => {
    if (!getVinciUiState().continuationPending) return;
    clearContinuationWatchdog();
    setVinciContinuationPending(false);
  });

  pi.on("tool_call", (event) => {
    if (vinciActivityStateForTool(event.toolName, event.input) === "verifying") {
      verificationToolCallIds.add(event.toolCallId);
      setVinciActivity("verifying");
      setVinciWorkingLabel("Verifying the change…");
      return;
    }
    if (verificationToolCallIds.size > 0) return;
    setVinciActivity("working");
    setVinciWorkingLabel(vinciActivityForTool(event.toolName, event.input));
  });

  pi.on("tool_result", (event) => {
    if (verificationToolCallIds.size > 0) return;
    setVinciActivity(vinciActivityStateAfterTool());
    setVinciWorkingLabel(vinciActivityAfterTool(event.toolName, !!event.isError));
  });

  pi.on("tool_execution_start", (event) => {
    if (vinciActivityStateForTool(event.toolName, event.args) === "verifying") return;
    if (verificationToolCallIds.size > 0) return;
    setVinciActivity("working");
    setVinciWorkingLabel(vinciActivityForTool(event.toolName, event.args));
  });

  pi.on("tool_execution_end", (event) => {
    const verificationEnded = verificationToolCallIds.delete(event.toolCallId);
    if (verificationToolCallIds.size > 0) {
      setVinciActivity("verifying");
      setVinciWorkingLabel("Verifying the change…");
      return;
    }
    if (!verificationEnded) return;
    setVinciActivity(vinciActivityStateAfterTool());
    setVinciWorkingLabel(vinciActivityAfterTool(event.toolName, !!event.isError));
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason === "error") {
      if (authFailed(message.errorMessage)) setVinciConnection("reconnect");
      return;
    }
    setVinciConnection("connected");
  });

  pi.on("agent_end", () => {
    verificationToolCallIds.clear();
    if (getVinciUiState().continuationPending) {
      if (!activeTui) {
        stopAnimation();
        clearContinuationWatchdog();
        setVinciContinuationPending(false);
        setVinciWorking(false);
        return;
      }
      startAnimation();
      clearContinuationWatchdog();
      continuationWatchdog = setTimeout(() => {
        // Whether the continuation resolved on its own or timed out here, the
        // pending animation must not outlive the pending state.
        stopAnimation();
        if (!getVinciUiState().continuationPending) return;
        setVinciContinuationPending(false);
        setVinciWorking(false);
      }, 15_000);
      return;
    }
    stopAnimation();
    setVinciWorking(false);
  });

  pi.on("session_shutdown", () => {
    verificationToolCallIds.clear();
    stopAnimation();
    clearContinuationWatchdog();
    unsubscribeState?.();
    unsubscribeState = undefined;
    activeTui = undefined;
  });
}
