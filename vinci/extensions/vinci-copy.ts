/**
 * Vinci copy — put useful output on the clipboard without terminal selection.
 *
 *   • /copy  → choose Vinci's last message, the last code block, or the last tool output.
 *   • Alt+C  → open the same picker from the keyboard.
 *
 * Additive and session-local. This extension never enables terminal mouse tracking.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type CopyChoice = {
  label: string;
  text: string;
};

type ClipboardWriter = (text: string) => Promise<void>;

/** Remove ANSI escape sequences and terminal control characters from copied output. */
export function stripAnsiSequences(text: string): string {
  return (
    text
      .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
      .replace(/(?:\x1b[P^_X]|\x90|\x98|\x9e|\x9f)[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[ -/]*[@-~]/g, "")
      .replace(/\r\n?/g, "\n")
      // Keep \x09 (tab) and \x0a (newline): stripping tabs would silently destroy the
      // indentation of every tab-indented code block this feature exists to copy.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  );
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Return the final fenced Markdown code block, without its fence or language label. */
export function extractLastCodeBlock(text: string): string | undefined {
  const normalized = stripAnsiSequences(text);
  const pattern = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  let last: string | undefined;
  for (const match of normalized.matchAll(pattern)) {
    last = match[2]?.replace(/\n$/, "");
  }
  return last;
}

export function copyChoices(messages: readonly AgentMessage[]): CopyChoice[] {
  let lastAssistant = "";
  let lastCodeBlock: string | undefined;
  let lastToolOutput = "";

  for (const message of messages) {
    const text = stripAnsiSequences(messageText(message));
    if (message.role === "assistant" && text.trim()) {
      lastAssistant = text.trim();
      lastCodeBlock = extractLastCodeBlock(text) ?? lastCodeBlock;
    } else if (message.role === "toolResult" && text.trim()) {
      lastToolOutput = text.trim();
    }
  }

  const choices: CopyChoice[] = [];
  if (lastAssistant) choices.push({ label: "Vinci's last message", text: lastAssistant });
  if (lastCodeBlock?.trim()) choices.push({ label: "Last code block", text: stripAnsiSequences(lastCodeBlock) });
  if (lastToolOutput) choices.push({ label: "Last tool output", text: lastToolOutput });
  return choices;
}

function copyHintWidget(): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => ({
    render(width: number): string[] {
      return [
        truncateToWidth(
          theme.fg("muted", "  Tip · Use /copy when you want Vinci's output on your clipboard."),
          width,
          theme.fg("dim", "…"),
        ),
      ];
    },
    invalidate(): void {},
  });
}

function sessionMessages(ctx: ExtensionContext): AgentMessage[] {
  return ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

export default function (pi: ExtensionAPI, writeClipboard: ClipboardWriter = copyToClipboard) {
  let liveMessages: AgentMessage[] = [];
  let featureUsed = false;
  let hintShown = false;
  let pickerOpen = false;
  let offInput: (() => void) | undefined;

  const markUsed = (ctx: ExtensionContext) => {
    featureUsed = true;
    if (ctx.hasUI) ctx.ui.setWidget("vinci-copy-hint", undefined);
  };

  const openCopyPicker = async (ctx: ExtensionContext) => {
    markUsed(ctx);
    if (pickerOpen) return;
    pickerOpen = true;
    try {
      const choices = copyChoices([...sessionMessages(ctx), ...liveMessages]);
      if (choices.length === 0) {
        ctx.ui.notify("Nothing from Vinci is ready to copy yet.", "info");
        return;
      }

      const selected = await ctx.ui.select(
        "Copy to clipboard",
        choices.map((choice) => choice.label),
      );
      const choice = choices.find((candidate) => candidate.label === selected);
      if (!choice) return;

      await writeClipboard(stripAnsiSequences(choice.text));
      ctx.ui.notify(`Copied ${choice.label.toLowerCase()}.`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Couldn't copy to clipboard: ${message}`, "error");
    } finally {
      pickerOpen = false;
    }
  };

  pi.registerCommand("copy", {
    description: "Copy Vinci's latest message, code block, or tool output",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await openCopyPicker(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    liveMessages = [];
    featureUsed = false;
    hintShown = false;
    pickerOpen = false;
    ctx.ui.setWidget("vinci-copy-hint", undefined);
    try {
      offInput?.();
      offInput = ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, "alt+c")) return undefined;
        if (!pickerOpen) void openCopyPicker(ctx);
        return { consume: true };
      });
    } catch {
      offInput = undefined;
    }
  });

  pi.on("message_end", (event, ctx) => {
    liveMessages.push(event.message);
    if (
      hintShown ||
      featureUsed ||
      ctx.mode !== "tui" ||
      event.message.role !== "assistant" ||
      extractLastCodeBlock(messageText(event.message)) === undefined
    ) {
      return;
    }
    hintShown = true;
    ctx.ui.setWidget("vinci-copy-hint", copyHintWidget(), { placement: "aboveEditor" });
  });

  pi.on("agent_end", (event) => {
    liveMessages = [...event.messages];
  });

  pi.on("session_shutdown", () => {
    try {
      offInput?.();
    } catch {
      // A stale input listener must not block session teardown.
    }
    offInput = undefined;
  });
}
