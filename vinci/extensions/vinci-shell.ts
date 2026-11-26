/**
 * Vinci-owned interactive shell.
 *
 * Pi supplies the editor mechanics and agent runtime; this extension owns the persistent product
 * chrome: a stateful composer border, honest connection state, mode/model/project orientation, and
 * the only continuous animation on screen while work is active.
 */
import { basename, isAbsolute, relative, sep } from "node:path";
import {
  CustomEditor,
  formatVinciRecoveryMessage,
  getVinciRecoveryGuidance,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getVinciLook } from "./lib/cli-look.ts";
import { vinciPlainPresentation, vinciReducedMotion } from "./lib/cli-presentation.ts";
import {
  getVinciUiState,
  resetShellUiState,
  setVinciActivity,
  setVinciBlocker,
  setVinciConnection,
  setVinciContinuationPending,
  setVinciProviderError,
  setVinciWorking,
  setVinciWorkingLabel,
  subscribeVinciUiState,
  type VinciActivityState,
} from "./lib/ui-state.ts";
import { containsVerificationCommand } from "./vinci-verification.ts";
import { getVeroPresentation } from "./lib/vero-state.ts";
import { vinciCarriesOperations, vinciRequiredOperations, type VinciRequiredOperation } from "./lib/required-operations.ts";
import { getVinciTaskOutcome } from "./lib/task-outcome.ts";

export const VINCI_PULSE_FRAMES = ["·", "•", "●", "•"] as const;
const ASCII_PULSE_FRAMES = [".", "o", "*", "o"] as const;
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
  horizontal = "─",
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
  return `${edge(leftEdge)}${leftText}${fill(horizontal.repeat(gap))}${rightText}${edge(rightEdge)}`;
}

function plainLine(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function formatTokens(count: number): string {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatContext(ctx: ExtensionContext, ascii: boolean): string {
  const usage = ctx.getContextUsage();
  if (!usage || usage.percent === null) return "";
  // Keep the percentage and token count together; footer allocation treats metrics as atomic so
  // a clipped suffix can never turn a value such as 26k into a misleading 2.
  const percent = `${Math.round(usage.percent)}% full`;
  return usage.tokens === null || usage.tokens === undefined ? percent : `${percent}${ascii ? " - " : " · ↓ "}${formatTokens(usage.tokens)}`;
}

function formatModel(ctx: ExtensionContext): string {
  const name = ctx.model?.name ?? ctx.model?.id ?? "connecting";
  return name.replace(/^Vinci\s+/i, "").replace(/\s*\(([^)]+)\)$/, " $1");
}

function formatProject(cwd: string, width: number): string {
  if (width < 100) return basename(cwd) || cwd;
  const home = process.env.HOME;
  if (!home) return cwd;
  const fromHome = relative(home, cwd);
  if (fromHome === "") return "~";
  return fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome) ? `~/${fromHome}` : cwd;
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
  let providerBlocker: { provider?: string; reason: string } | undefined;
  let toolBlocker: { reason: string } | undefined;
  let toolMessages: unknown[] = [];
  const toolCalls = new Map<string, string>();
  let pendingOperations: readonly VinciRequiredOperation[] = [];
  let priorOperations: readonly VinciRequiredOperation[] = [];
  let displayedRecovery: string | undefined;
  const publishRecovery = () => {
    const reason = toolBlocker?.reason ?? providerBlocker?.reason;
    setVinciProviderError(providerBlocker?.reason);
    if (reason) {
      setVinciBlocker(reason);
      displayedRecovery = getVinciUiState().blockingReason;
    } else if (displayedRecovery && getVinciUiState().blockingReason === displayedRecovery) {
      setVinciBlocker(undefined);
      displayedRecovery = undefined;
    }
  };

  const requestRender = () => activeTui?.requestRender();
  const stopAnimation = () => {
    if (animation) clearInterval(animation);
    animation = undefined;
  };
  const clearContinuationWatchdog = () => {
    if (continuationWatchdog) clearTimeout(continuationWatchdog);
    continuationWatchdog = undefined;
  };
  const updateAnimation = () => {
    if (!activeTui || vinciReducedMotion() || getVeroPresentation().label !== "Thinking") {
      stopAnimation();
      return;
    }
    if (animation) return;
    frame = 0;
    animation = setInterval(() => {
      frame = (frame + 1) % VINCI_PULSE_FRAMES.length;
      requestRender();
    }, PULSE_INTERVAL_MS);
  };

  pi.on("session_start", async (_event, ctx) => {
    unsubscribeState?.();
    unsubscribeState = undefined;
    activeTui = undefined;
    verificationToolCallIds.clear();
    resetShellUiState();
    providerBlocker = undefined;
    toolBlocker = undefined;
    pendingOperations = getVinciTaskOutcome()?.requiredOperations ?? [];
    priorOperations = pendingOperations;
    toolMessages = [];
    toolCalls.clear();
    displayedRecovery = undefined;
    stopAnimation();
    clearContinuationWatchdog();
    if (ctx.mode !== "tui") return;
    if (vinciPlainPresentation()) return;
    unsubscribeState = subscribeVinciUiState(() => {
      updateAnimation();
      requestRender();
    });

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
        const look = getVinciLook(width, theme.name);
        const modeLabel =
          state.mode === "plan"
            ? look.fg("warning", look.bold(look.ascii ? "PLAN" : "◇ PLAN"))
            : look.fg("success", look.bold(look.ascii ? "AUTO" : "▶ AUTO"));
        const work = getVeroPresentation();
        const frames = look.ascii ? ASCII_PULSE_FRAMES : VINCI_PULSE_FRAMES;
        const pulse = work.label === "Thinking" ? frames[animation ? frame : 2] : undefined;
        const detail = work.detail && look.ascii ? work.detail.replaceAll("…", "...") : work.detail;
        const label = detail ? work.label + look.separator + detail : work.label;
        // Reserve the corners and minimum border gap first, then fit complete status fields before
        // the project. Widening to a full cwd must never steal cells from numeric context metrics.
        const footerBudget = Math.max(0, width - 2 - 3);
        const ellipsis = look.ascii ? "..." : "…";
        let bottomLeft = truncateToWidth(` ${modeLabel} `, footerBudget, ellipsis);
        let context = width >= 70 ? formatContext(ctx, look.ascii) : "";
        if (context && visibleWidth(bottomLeft) + visibleWidth(context) + 2 > footerBudget) context = "";
        const contextWidth = context ? visibleWidth(context) + 2 : 0;
        const separator = look.ascii ? "  -  " : "  ·  ";
        const modelWidth = footerBudget - visibleWidth(bottomLeft) - contextWidth - visibleWidth(separator);
        if (modelWidth > 0) {
          const model = truncateToWidth(look.fg("muted", formatModel(ctx)), modelWidth, look.fg("muted", ellipsis));
          bottomLeft = ` ${modeLabel}${look.fg("dim", separator)}${model} `;
        }
        const project = `${formatProject(ctx.cwd, width)}${branch ? ` (${branch})` : ""}`;
        const projectWidth = footerBudget - visibleWidth(bottomLeft) - contextWidth - (context ? visibleWidth(separator) : 2);
        // Truncation resets ANSI styling before its ellipsis. Style each segment independently so
        // shortening the path cannot change the following metrics' foreground color.
        const fittedProject = projectWidth > 0
          ? truncateToWidth(look.fg("dim", project), projectWidth, look.fg("dim", ellipsis))
          : "";
        const bottomRightParts = [fittedProject, context ? look.fg("dim", context) : ""].filter(Boolean);
        const bottomRight = bottomRightParts.length ? ` ${bottomRightParts.join(look.fg("dim", separator))} ` : "";
        const edgeColor = (text: string) => look.fg("border", text);
        lines[0] = look.topBorder(label, work.token, pulse);
        const bottomBorderIndex = lines.findIndex(
          (line, index) => index > 0 && (/^─+$/.test(plainLine(line)) || /^─── ↓ \d+ more ─*$/.test(plainLine(line))),
        );
        if (bottomBorderIndex > 0) {
          const contentLines: string[] = [];
          for (let index = 1; index < bottomBorderIndex; index++) {
            const prompt = index === 1 ? look.fg("accent", look.marker) : " ";
            const content = `${prompt}${lines[index].slice(1)}`;
            contentLines.push(`${edgeColor(look.vertical)}${content}${edgeColor(look.vertical)}`);
          }
          const blank = `${edgeColor(look.vertical)}${" ".repeat(innerWidth)}${edgeColor(look.vertical)}`;
          const bottom = fitBorder(bottomLeft, bottomRight, width, edgeColor, edgeColor, look.corners[2], look.corners[3], look.horizontal);
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

  pi.on("before_agent_start", (event) => {
    if (vinciCarriesOperations(event.prompt, pendingOperations.length > 0)) return;
    pendingOperations = [];
    priorOperations = [];
    toolMessages = [];
    toolCalls.clear();
    toolBlocker = undefined;
    publishRecovery();
  });

  pi.on("agent_start", (event) => {
    // A custom turn sent as a new request skips before_agent_start: start a fresh request scope (#170).
    if (event?.newRequest && !event.continuesRetry) {
      pendingOperations = [];
      toolBlocker = undefined;
    }
    priorOperations = pendingOperations;
    toolMessages = [];
    toolCalls.clear();
    publishRecovery();
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
    updateAnimation();
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

  pi.on("tool_result", (event, ctx) => {
    const output = Array.isArray(event.content)
      ? event.content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n")
      : "";
    const signature = JSON.stringify({ toolName: event.toolName, input: event.input });
    if (toolCalls.get(event.toolCallId) !== signature) {
      toolMessages.push({ role: "assistant", content: [{ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.input }] });
      toolCalls.set(event.toolCallId, signature);
    }
    toolMessages.push({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, content: event.content, details: event.details, isError: event.isError });
    pendingOperations = vinciRequiredOperations(toolMessages, priorOperations, ctx.cwd);
    toolBlocker = pendingOperations.length ? { reason: formatVinciRecoveryMessage(pendingOperations[0].reason || output) } : undefined;
    publishRecovery();
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

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason === "error") {
      const error = message.errorMessage || "The provider could not complete this activity.";
      const provider = message.provider || ctx?.model?.provider;
      providerBlocker = { provider, reason: formatVinciRecoveryMessage(error, provider) };
      publishRecovery();
      if (getVinciRecoveryGuidance(error, provider).kind === "authentication") setVinciConnection("reconnect");
      return;
    }
    if (message.stopReason === "aborted") return;
    const provider = message.provider || ctx?.model?.provider;
    if (provider && providerBlocker?.provider === provider) {
      providerBlocker = undefined;
      publishRecovery();
    }
    if (!providerBlocker) setVinciConnection("connected");
  });

  pi.on("agent_end", (event) => {
    // A pending auto-retry resumes the same turn after backoff: keep the working state (the
    // reconnect indicator shows the attempt) instead of ending it here.
    if (event.willRetry) return;
    verificationToolCallIds.clear();
    if (getVinciUiState().continuationPending) {
      if (!activeTui) {
        stopAnimation();
        clearContinuationWatchdog();
        setVinciContinuationPending(false);
        setVinciWorking(false);
        return;
      }
      updateAnimation();
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
    providerBlocker = undefined;
    toolBlocker = undefined;
    displayedRecovery = undefined;
  });
}
