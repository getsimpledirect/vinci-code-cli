/** Vinci identity and live connection information. */
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { getVinciLook, hasVinciCredentials, vinciEnvironmentBadge } from "./lib/cli-look.ts";
import { vinciAscii, vinciPlainPresentation } from "./lib/cli-presentation.ts";
import { VINCI_VERSION } from "./lib/product-identity.ts";
import { getVinciUiState, setVinciConnection } from "./lib/ui-state.ts";
import { createVeroImages, renderVeroHeader, veroImagesEnabled } from "./lib/vero-image.ts";
import { getVeroPresentation, type VeroPose } from "./lib/vero-state.ts";

// [#229] The connection state was read once at session_start, so /logout removed the credential
// while the header kept reporting "signed in" - directly above the auth picker it had just
// opened. Nothing anywhere set "signed-out" after startup. auth.json is re-parsed only when its
// mtime moves, so a repaint costs one stat, and every route that changes credentials is caught:
// the command, an expiring token, or the file being edited by hand.
let credCache: { mtimeMs: number; present: boolean } | undefined;
function hasCredentialsFresh(): boolean {
  const agentDir = getAgentDir();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(join(agentDir, "auth.json")).mtimeMs;
  } catch {
    credCache = undefined;
    return false;
  }
  if (credCache?.mtimeMs === mtimeMs) return credCache.present;
  const present = hasVinciCredentials(agentDir);
  credCache = { mtimeMs, present };
  return present;
}

const THINKING_HINT_MARKER = ".vinci-thinking-hint-v1";

const HERO_POSES = {
  Ready: "rich",
  Thinking: "working",
  Done: "done",
  Error: "blocked",
  "Not sure": "review",
  Blocked: "blocked",
  "Needs your OK": "review",
  "Waiting for you": "review",
} satisfies Record<ReturnType<typeof getVeroPresentation>["label"], VeroPose>;

function claimThinkingHint(): boolean {
  const dir = getAgentDir();
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(join(dir, THINKING_HINT_MARKER), "wx"));
    return true;
  } catch {
    return false;
  }
}

export function shortPath(p: string, w: number): string {
  const home = process.env.HOME;
  const s = home && (p === home || p.startsWith(home + sep)) ? "~" + p.slice(home.length) : p;
  return s.length <= w ? s : "…" + s.slice(s.length - (w - 1));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    setVinciConnection(hasVinciCredentials(getAgentDir()) ? "signed-in" : "signed-out");
    if (vinciPlainPresentation()) return;
    if (claimThinkingHint()) {
      ctx.ui.notify("Thinking is collapsed by default. Press Ctrl+T anytime to show or hide it.", "info");
    }
    const branch = (await pi.exec?.("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined))?.stdout.trim();
    ctx.ui.setHeader((tui, theme) => {
      const veroImages = process.env.VINCI_HERO_HEADER === "1" && !vinciAscii() ? createVeroImages() : undefined;
      return {
        render(width: number): string[] {
          let connection = getVinciUiState().connection;
          if (connection === "signed-in" || connection === "signed-out") {
            connection = hasCredentialsFresh() ? "signed-in" : "signed-out";
          }
          const data = {
            version: VINCI_VERSION,
            project: basename(ctx.cwd) || ctx.cwd,
            branch: branch || undefined,
            model: ctx.model?.name ?? ctx.model?.id,
            connection,
            environment: vinciEnvironmentBadge(),
          };
          if (veroImages?.size && (tui?.terminal.rows ?? 24) >= 12 && veroImagesEnabled(width)) {
            const image = veroImages.get(HERO_POSES[getVeroPresentation().label]);
            if (image) return renderVeroHeader(getVinciLook(width - 8, theme.name).header(data), image, width);
          }
          return getVinciLook(width, theme.name).header(data);
        },
        invalidate() {
          for (const image of veroImages?.values() ?? []) image.invalidate();
        },
      };
    });
  });
}
