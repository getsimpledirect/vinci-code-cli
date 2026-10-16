/**
 * Vinci Code welcome. Everyday sessions get a compact identity/safety header so work owns the
 * screen; VINCI_HERO_HEADER=1 selects the approved rich Vero pose in an explicit image preview.
 * Additive: ctx.ui.setHeader on session_start (TUI only).
 *
 * Brand "Made, Not Generated." Cream #F4F1EC on sage #B8C5B0.
 */
import { type ExtensionAPI, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getVinciUiState, setVinciConnection } from "./lib/ui-state.ts";
import { VINCI_VERSION } from "./lib/product-identity.ts";
import { getVeroPresentation, vinciPlainPresentation } from "./lib/vero-state.ts";
import { createVeroImages, renderVeroHeader, veroImagesEnabled } from "./lib/vero-image.ts";
import { VINCI_GATEWAY_BASE_URL, VINCI_PROD_GATEWAY_URL } from "./vinci-links.ts";

// Both helpers below resolve the agent directory through the core's getAgentDir(). Restating it here
// as `process.env.PI_CODING_AGENT_DIR || ~/.pi/agent` was WRONG: the override env name is DERIVED
// from piConfig.name (now "vinci", so VINCI_CODING_AGENT_DIR — see PATCHES.md §9), while configDir
// deliberately stayed ".pi". The stale literal read an env var nothing sets, so a user who moved
// their agent directory was reported "not signed in" and had ~/.pi/agent created underneath them.

/** A saved credential is not proof that the provider accepted it. */
function hasCredentials(): boolean {
  try {
    const data = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
    return Boolean(data?.vinci);
  } catch {
    return false;
  }
}

// [#229] The connection state was read once at session_start, so /logout removed the credential
// while the header kept reporting "signed in" - directly above the auth picker it had just
// opened. Nothing anywhere set "signed-out" after startup. auth.json is re-parsed only when its
// mtime moves, so a repaint costs one stat, and every route that changes credentials is caught:
// the command, an expiring token, or the file being edited by hand.
let credCache: { mtimeMs: number; present: boolean } | undefined;
function hasCredentialsFresh(): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(join(getAgentDir(), "auth.json")).mtimeMs;
  } catch {
    credCache = undefined;
    return false;
  }
  if (credCache?.mtimeMs === mtimeMs) return credCache.present;
  const present = hasCredentials();
  credCache = { mtimeMs, present };
  return present;
}

const THINKING_HINT_MARKER = ".vinci-thinking-hint-v1";

/** Atomically claim the durable one-time thinking hint for this Vinci installation. */
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

const PAD = "  "; // left margin

export function shortPath(p: string, w: number): string {
  const home = process.env.HOME;
  const s = home && (p === home || p.startsWith(home + sep)) ? "~" + p.slice(home.length) : p;
  return s.length <= w ? s : "…" + s.slice(s.length - (w - 1));
}

function colors(theme: Theme) {
  if (vinciPlainPresentation()) {
    const plain = (text: string) => text;
    return { sage: plain, cream: plain, muted: plain, dim: plain, bold: plain };
  }
  return {
    sage: (t: string) => theme.fg("accent", t),
    cream: (t: string) => theme.fg("mdHeading", t),
    muted: (t: string) => theme.fg("muted", t),
    dim: (t: string) => theme.fg("dim", t),
    bold: (t: string) => theme.bold(t),
  };
}

// Canonical form for comparing gateway URLs: URL-parsed (which lowercases scheme + host) with
// trailing slashes stripped, so a cosmetic variant of the prod URL — trailing slash, uppercase
// host — is not mistaken for a different backend. Unparseable values fall back to a lowercased
// string compare.
function canonicalGatewayUrl(url: string): string {
  const stripped = url.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(stripped);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return stripped.toLowerCase();
  }
}

// Non-prod visibility: a session pointed anywhere but the production gateway must SAY so, or a
// dev login/task is indistinguishable from prod at a glance. `VINCI_ENV=dev` (the supported
// switch, see bin/vinci) reads as "dev"; any other base-URL override shows the gateway host.
// Warning-colored, matching the header's existing state idiom ("! reconnect").
function environmentBadge(theme: Theme): string | null {
  const onDev = process.env.VINCI_ENV === "dev";
  // An exported-but-EMPTY override means "unset", not a mystery backend.
  const effective = VINCI_GATEWAY_BASE_URL.trim() || VINCI_PROD_GATEWAY_URL;
  if (!onDev && canonicalGatewayUrl(effective) === canonicalGatewayUrl(VINCI_PROD_GATEWAY_URL)) return null;
  let label = "dev";
  if (!onDev) {
    try {
      label = new URL(effective).host;
    } catch {
      label = effective;
    }
  }
  return theme.fg("warning", `▲ ${label}`);
}

// Network observations take precedence over credential presence.
function connectionLabel(theme: Theme, width: number): string {
  const { sage, muted, dim } = colors(theme);
  const state = getVinciUiState().connection;
  // The environment badge leads the connection area so it survives narrow-width truncation.
  const badge = environmentBadge(theme);
  const lead = badge ? badge + dim("   ·   ") : "";
  if (state === "connected") return lead + theme.fg("success", width < 40 ? "connected · ask" : "● connected");
  if (state === "signed-in") return lead + sage(width < 40 ? "auth saved · ask" : "● credential saved");
  if (state === "reconnect") return lead + theme.fg("warning", width < 40 ? "reconnect: /login" : "! reconnect");
  return lead + sage("/login") + muted(" to connect");
}

// The product/version and Vero identity stay visible before optional context is clipped.
function compactHeader(theme: Theme, modelName: string, width: number, cwd: string, short: boolean): string[] {
  const { sage, cream, muted, dim, bold } = colors(theme);
  const brand = PAD + cream(bold(`Vinci v${VINCI_VERSION}`)) + (width >= 40 ? sage(" Code") : "");
  const vero = getVeroPresentation();
  const label = width < 28 && vero.label === "DONE-UNVERIFIED" ? "UNVERIFIED" : vero.label;
  const model = width < 40 && modelName === "Choose a model: /model" ? "/model" : modelName;
  const context = PAD + muted(`Vero ${label}`) + dim(width < 40 ? " " : " · ") + cream(model) +
    (width >= 60 ? dim(" · " + shortPath(cwd, Math.max(16, width - 40))) : "");
  const next = vero.label === "READY" ? "Ask Vero a task" : vero.nextAction;
  let safety = PAD + (width < 40 && vero.label !== "READY"
    ? muted(next)
    : connectionLabel(theme, width) + (width >= 40 ? dim(" · ") + muted(next) : ""));
  for (const hint of [sage("/undo"), sage("Ctrl+T") + muted(" thinking")]) {
    const extended = safety + dim(" · ") + hint;
    if (width >= 40 && visibleWidth(extended) <= width) safety = extended;
  }
  const lines = [brand, context, safety].map((line) => truncateToWidth(line, width, ""));
  return short ? lines : ["", ...lines, ""];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    setVinciConnection(hasCredentials() ? "signed-in" : "signed-out");
    if (claimThinkingHint()) {
      ctx.ui.notify("Thinking is collapsed by default. Press Ctrl+T anytime to show or hide it.", "info");
    }
    ctx.ui.setHeader((tui, theme) => {
      const veroImages = createVeroImages();
      return {
        render(width: number): string[] {
          // Read the model at render time so the header shows the REAL session model (it used to
          // hardcode the launch default — a /model switch left the header lying vs. the footer).
          const modelName = ctx.model?.name ?? ctx.model?.id ?? "Choose a model: /model";
          // Same reason as the model name above: a value read once at startup goes stale in
          // place. The connection state was set only at session_start, so /logout left the
          // header saying "signed in" beside the auth picker it had just opened.
          // Only the two credential-derived states are refreshed here. "connected" and
          // "reconnect" are narrower facts earned by an actual request (vinci-shell sets them),
          // and re-deriving those from a file on disk would throw away what the network proved.
          const conn = getVinciUiState().connection;
          if (conn === "signed-in" || conn === "signed-out") {
            setVinciConnection(hasCredentialsFresh() ? "signed-in" : "signed-out");
          }
          const short = (tui?.terminal.rows ?? 24) < 12;
          const presentation = getVeroPresentation();
          const pose = process.env.VINCI_HERO_HEADER === "1" && presentation.pose === "pixel" ? "rich" : presentation.pose;
          const showVero = !short && veroImagesEnabled(width) && veroImages.has(pose);
          const lines = compactHeader(theme, modelName, showVero ? width - 8 : width, ctx.cwd, short);
          if (vinciPlainPresentation()) return lines.map(stripVTControlCharacters);
          return showVero ? renderVeroHeader(lines, veroImages.get(pose), width) : lines;
        },
        invalidate() {
          for (const veroImage of veroImages.values()) veroImage.invalidate();
        },
      };
    });
  });
}
