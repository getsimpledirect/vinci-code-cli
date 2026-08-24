import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "write") return undefined;
    const marker = process.env.VINCI_CHECKPOINT_KILL_MARKER;
    if (!marker) return undefined;
    writeFileSync(marker, "side effect landed; tool result not persisted\n", "utf8");
    await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
    return undefined;
  });
}
