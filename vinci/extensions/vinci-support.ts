import { spawn } from "node:child_process";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VINCI_SUPPORT_URL } from "./vinci-links.ts";

// Canonical, env-following support URL (carries ?source=code) — derived in vinci-links.ts from the
// gateway origin, so a VINCI_BASE_URL / VINCI_ENV=dev override repoints /support consistently.
const SUPPORT_URL = VINCI_SUPPORT_URL;

/** Open the Vinci support page with the platform's default browser. */
function openSupportPage(spawnProcess: typeof spawn): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [SUPPORT_URL]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", SUPPORT_URL]]
        : ["xdg-open", [SUPPORT_URL]];

  try {
    spawnProcess(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // Browser opening is best-effort; the URL remains available in the terminal.
  }
}

export default function (pi: ExtensionAPI, spawnProcess: typeof spawn = spawn) {
  pi.registerCommand("support", {
    description: "Get help and support",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      const linkedUrl = `\x1b]8;;${SUPPORT_URL}\x07${SUPPORT_URL}\x1b]8;;\x07`;
      process.stdout.write(`${linkedUrl}\n${SUPPORT_URL}\n`);
      openSupportPage(spawnProcess);
    },
  });
}
