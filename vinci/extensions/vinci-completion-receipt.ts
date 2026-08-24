/** Final-stage completion receipt guard.
 *
 * Vinci verification runs early so it can steer failed and stale checks before other behavior
 * extensions. Later extensions may legitimately rewrite the final assistant text, which can remove
 * the receipt that verification added. This extension is loaded last and reapplies only the
 * verifier-grounded completion receipt after every other message transformation has finished.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { groundedCompletionReceipt } from "./vinci-verification.ts";
import { vinciVerificationDisabled } from "./lib/verification-control.ts";

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    if (vinciVerificationDisabled() || event.message.role !== "assistant") return undefined;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return undefined;
    if (event.message.content.some((part) => part.type === "toolCall")) return undefined;

    const text = event.message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const receipt = groundedCompletionReceipt(text);
    if (receipt === text) return undefined;
    const content = event.message.content.filter((part) => part.type !== "text");
    return { message: { ...event.message, content: [...content, { type: "text", text: receipt }] } };
  });
}
