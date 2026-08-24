/**
 * VINCI_CODE — show when a turn was actually served on the provider's PRIORITY tier (front-of-queue).
 *
 * Coding-agent traffic requests DeepInfra's Priority tier so a busy model doesn't leave the user
 * staring at a stalled turn. The provider echoes `service_tier` back on the response, and the
 * completions adapter captures it onto the assistant message. When a turn was genuinely served at
 * priority, show a small themed badge in the status line (next to `● connected`) so the user can see
 * they got the fast lane; clear it on any turn that wasn't. Display-only — no model involvement, and no
 * extra cost beyond what the provider already billed for the tier it actually delivered.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("message_end", (event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (event.message.role !== "assistant") return;
    const served = event.message.serviceTier;
    ctx.ui.setStatus(
      "vinci-priority",
      served === "priority" ? ctx.ui.theme.fg("accent", "◆ priority") : undefined,
    );
  });
}
