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
    const text = messageText(event.message.content);
    const index = queued.findIndex((message) => message.text === text);
    if (index === -1) return;
    queued.splice(index, 1);
    render(ctx);
  });
}
