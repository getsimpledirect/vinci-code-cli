/** Make user messages submitted during a run visibly queued instead of silently disappearing. */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

type QueuedMessage = {
  text: string;
  behavior: "steer" | "followUp";
};

function messageText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function cleanPreview(text: string): string {
  const clean = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 96 ? `${clean.slice(0, 95)}…` : clean;
}

function queueWidget(messages: readonly QueuedMessage[]): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => ({
    render(width: number): string[] {
      const count = messages.length === 1 ? "1 message" : `${messages.length} messages`;
      const heading = theme.fg("warning", theme.bold(`  ↳ Queued for Vinci · ${count}`));
      const latest = messages.at(-1);
      const timing = latest?.behavior === "steer" ? "Vinci will read it at the next safe pause" : "Vinci will read it after this step";
      const detail = theme.fg("muted", `  “${cleanPreview(latest?.text ?? "")}”`) + theme.fg("dim", `  ·  ${timing}`);
      return [
        truncateToWidth(heading, width, theme.fg("dim", "…")),
        truncateToWidth(detail, width, theme.fg("dim", "…")),
      ];
    },
    invalidate(): void {},
  });
}

export default function (pi: ExtensionAPI) {
  const queued: QueuedMessage[] = [];

  const render = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("vinci-user-queue", queued.length ? queueWidget([...queued]) : undefined, {
      placement: "aboveEditor",
    });
  };

  // The text we record at `input` is NOT the text that ends up on the wire: later `input` handlers
  // transform it (vinci-guard redacts secrets and strips attached image paths), and the session then
  // expands skill commands and prompt templates. So an exact text match is a best case, not a
  // contract — matching on it alone pinned delivered messages in the widget forever. The session is
  // the authority on what is still queued, so reconcile against its count: it already retires a
  // message before this event reaches us, and it also drops the whole queue when the user aborts or
  // pulls the queue back into the editor, neither of which produces a message_start at all.
  const reconcile = (ctx: ExtensionContext) => {
    // Steering drains ahead of follow-ups, so the oldest steering entry is the one that left first.
    while (queued.length > ctx.pendingMessageCount()) {
      const oldest = queued.findIndex((message) => message.behavior === "steer");
      queued.splice(oldest === -1 ? 0 : oldest, 1);
    }
    render(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    queued.length = 0;
    render(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (!event.streamingBehavior || event.source === "extension" || !event.text.trim()) return;
    queued.push({ text: event.text, behavior: event.streamingBehavior });
    render(ctx);
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user" || queued.length === 0) return;
    // The count decides HOW MANY entries to retire; the text only decides WHICH one, so that the
    // preview keeps naming a message that is genuinely still waiting. A user message the session
    // never queued (an extension injecting one mid-run) therefore cannot retire anything.
    const delivered = messageText(event.message.content);
    if (queued.length > ctx.pendingMessageCount()) {
      const exact = queued.findIndex((message) => message.text === delivered);
      if (exact !== -1) queued.splice(exact, 1);
    }
    reconcile(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => reconcile(ctx));

  pi.on("agent_end", async (_event, ctx) => reconcile(ctx));
}
