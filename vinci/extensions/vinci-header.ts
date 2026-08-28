/**
 * Vinci Code welcome. Everyday sessions get a compact identity/safety header so work owns the
 * screen; VINCI_HERO_HEADER=1 enables the larger logo treatment for demos and first-run moments.
 * Additive: ctx.ui.setHeader on session_start (TUI only).
 *
 * Brand "Made, Not Generated." Cream #F4F1EC on sage #B8C5B0.
 */
import { type ExtensionAPI, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, type ImageTheme, truncateToWidth } from "@earendil-works/pi-tui";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getVinciUiState, setVinciConnection } from "./lib/ui-state.ts";
import { VINCI_GATEWAY_BASE_URL, VINCI_PROD_GATEWAY_URL } from "./vinci-links.ts";

// Both helpers below resolve the agent directory through the core's getAgentDir(). Restating it here
// as `process.env.PI_CODING_AGENT_DIR || ~/.pi/agent` was WRONG: the override env name is DERIVED
// from piConfig.name (now "vinci", so VINCI_CODING_AGENT_DIR — see PATCHES.md §9), while configDir
// deliberately stayed ".pi". The stale literal read an env var nothing sets, so a user who moved
// their agent directory was reported "not signed in" and had ~/.pi/agent created underneath them.

/** Does a Vinci credential exist? This means signed in, not necessarily connected. */
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

// The Vinci logomark — our signature aperture maker's-mark: 12 filled, tangentially-oriented PETAL
// blades radiating around a hollow centre. RASTERIZED (not dot-plotted) so it actually reads as the
// logo: each petal is a filled ellipse drawn on a high-res sub-pixel grid (2×4 per character), then
// downsampled to BRAILLE — packing 8 sub-pixels per cell for smooth, solid blades. Braille sub-pixels
// are ~square, so the ring reads round. Modern terminals (incl. Ghostty) render this crisply; the
// wordmark sits beside it. VINCI_ASCII_WORDMARK also swaps the mark to a simple ring for bare fonts.
function logomark(cols = 22, rows = 8): string[] {
  const W = cols * 2;
  const H = rows * 4;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const R = 16; // ring radius (sub-px) — petal-centre distance from the middle
  const len = 3.4; // petal half-length, tangential — short enough that the 12 blades stay DISTINCT
  const wid = 2.9; // petal half-width, radial (blade thickness)
  const inMark = (sx: number, sy: number): boolean => {
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * 2 * Math.PI - Math.PI / 2;
      const px = cx + R * Math.cos(ang);
      const py = cy + R * Math.sin(ang);
      const t = ang + Math.PI / 2; // petal long axis = tangential
      const dx = sx - px;
      const dy = sy - py;
      const u = dx * Math.cos(t) + dy * Math.sin(t);
      const v = -dx * Math.sin(t) + dy * Math.cos(t);
      if ((u * u) / (len * len) + (v * v) / (wid * wid) <= 1) return true;
    }
    return false;
  };
  const bit = [
    [0x01, 0x02, 0x04, 0x40],
    [0x08, 0x10, 0x20, 0x80],
  ];
  const rowsOut: string[] = [];
  for (let cyi = 0; cyi < rows; cyi++) {
    let line = "";
    for (let cxi = 0; cxi < cols; cxi++) {
      let b = 0;
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          if (inMark(cxi * 2 + dx, cyi * 4 + dy)) b |= bit[dx][dy];
        }
      }
      line += b === 0 ? " " : String.fromCharCode(0x2800 + b);
    }
    rowsOut.push(line);
  }
  return rowsOut;
}
const RING = logomark();

// The Vinci wordmark, rendered as the brand logotype: an elegant lowercase SERIF "v1nci" with the
// dotless i's as serifed 1's ("v1nc1") — the ownable brand signature. Unicode "mathematical bold
// serif" letters/digits are real serif glyphs on modern terminal fonts. VINCI_ASCII_WORDMARK=1 forces
// the plain fallback for terminals that can't render the math block.
const SERIF_WORDMARK = "\u{1D42F}\u{1D7CF}\u{1D427}\u{1D41C}\u{1D7CF}"; // 𝐯𝟏𝐧𝐜𝟏
const PLAIN_WORDMARK = "v1nc1";
const WORDMARK = process.env.VINCI_ASCII_WORDMARK === "1" ? PLAIN_WORDMARK : SERIF_WORDMARK;

// Vinci Code's OWN version — deliberately simple to start; bump it when we ship something worth
// iterating on. (NOT the underlying Pi version, which is an internal detail.)
const VINCI_VERSION = "0.0.51";

// The REAL Vinci logo — the full lockup (maker's-mark + the actual serif "v1nc1" wordmark), cream on a
// TRANSPARENT background (rendered from the official SVG), for terminals that draw images (Ghostty /
// kitty / iTerm). Transparent = no square, blends on any theme. Loaded once; empty → braille fallback.
let LOGO_B64 = "";
try {
  LOGO_B64 = readFileSync(fileURLToPath(new URL("../assets/vinci-logo-lockup.png", import.meta.url))).toString("base64");
} catch {
  /* asset missing → braille fallback */
}
const LOGO_DIMS = { widthPx: 1400, heightPx: 336 };
const LOGO_CELLS = 30; // width of the inline logo, in terminal cells

export function shortPath(p: string, w: number): string {
  const home = process.env.HOME;
  const s = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return s.length <= w ? s : "…" + s.slice(s.length - (w - 1));
}

function colors(theme: Theme) {
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

// Model / cwd / help / example lines — shared by both header layouts.
function connectionLabel(theme: Theme): string {
  const { sage, muted, dim } = colors(theme);
  const state = getVinciUiState().connection;
  // The environment badge leads the connection area so it survives narrow-width truncation.
  const badge = environmentBadge(theme);
  const lead = badge ? badge + dim("   ·   ") : "";
  if (state === "connected") return lead + theme.fg("success", "● connected");
  if (state === "signed-in") return lead + sage("● signed in");
  if (state === "reconnect") return lead + theme.fg("warning", "! reconnect");
  return lead + sage("/login") + muted(" to connect");
}

function infoLines(theme: Theme, modelName: string, cwd: string): string[] {
  const { sage, cream, muted, dim } = colors(theme);
  const ctx = PAD + cream(modelName) + dim("   ·   " + shortPath(cwd, 40));
  const lead = connectionLabel(theme);
  const sep = dim("     ·     ");
  // Lead with what reassures a non-programmer: the safety net, plus the two most useful controls.
  const tips =
    PAD + lead + sep + sage("/undo") + muted(" to undo") + sep + sage("Ctrl+T") + muted(" thinking") + sep + sage("/thinking") + muted(" speed");
  const examples =
    PAD + muted("Try asking:  ") + sage("“build me a simple website”") + dim("   ·   ") + sage("“explain this project”");
  return [ctx, tips, "", examples];
}

// Fallback header: the braille aperture mark beside the serif wordmark (no image support).
function brailleHeader(theme: Theme, modelName: string, width: number, cwd: string): string[] {
  const { sage, cream, muted, dim, bold } = colors(theme);
  const GAP = "    ";
  const nameRow = 3; // vertical centre of the 8-row mark
  const brandName = cream(bold(WORDMARK)) + dim("   ·   ") + sage("code");
  const brandTag = muted("Made, not generated.") + dim("   ·   v" + VINCI_VERSION);
  const wm = RING.map(
    (r, i) => PAD + cream(r) + GAP + (i === nameRow ? brandName : i === nameRow + 1 ? brandTag : ""),
  );
  return ["", ...wm, "", ...infoLines(theme, modelName, cwd), ""].map((line) => truncateToWidth(line, width, ""));
}

// Image header: the REAL Vinci logo (mark + serif wordmark) rendered inline (Ghostty/kitty/iTerm), with
// the "code" + tagline as text beneath it. image.render() returns the graphics sequence + blank rows so
// the TUI reserves height. The logo image already carries the wordmark, so no text wordmark here.
function imageHeader(theme: Theme, image: Image, width: number, modelName: string, cwd: string): string[] {
  const { sage, muted, dim } = colors(theme);
  const codeTag = PAD + sage("code") + dim("   ·   ") + muted("Made, not generated.") + dim("   ·   v" + VINCI_VERSION);
  return ["", ...image.render(width), "", codeTag, "", ...infoLines(theme, modelName, cwd), ""].map((line) =>
    truncateToWidth(line, width, ""),
  );
}

// The everyday header is compact: brand, context, safety. The large logo remains available through
// VINCI_HERO_HEADER=1 for demos and first-run experiences, but normal sessions preserve workspace.
function compactHeader(theme: Theme, modelName: string, width: number, cwd: string): string[] {
  const { sage, cream, muted, dim, bold } = colors(theme);
  const brand =
    PAD +
    sage(bold(process.env.VINCI_ASCII_WORDMARK === "1" ? "*" : "✹")) +
    "  " +
    cream(bold(WORDMARK)) +
    sage(" code") +
    dim("   ·   ") +
    muted("Made, not generated.") +
    dim("   ·   v" + VINCI_VERSION);
  const context = PAD + cream(modelName) + dim("   ·   " + shortPath(cwd, Math.max(16, width - 30)));
  const safety =
    PAD +
    connectionLabel(theme) +
    dim("   ·   ") +
    sage("/undo") +
    muted(" safety net") +
    dim("   ·   ") +
    sage("Ctrl+T") +
    muted(" thinking") +
    dim("   ·   ") +
    sage("/thinking") +
    muted(" speed");
  return ["", brand, context, safety, ""].map((line) => truncateToWidth(line, width, ""));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    setVinciConnection(hasCredentials() ? "signed-in" : "signed-out");
    if (claimThinkingHint()) {
      ctx.ui.notify("Thinking is collapsed by default. Press Ctrl+T anytime to show or hide it.", "info");
    }
    ctx.ui.setHeader((_tui, theme) => {
      // Render the real logomark image where the terminal supports it (Ghostty/kitty/iTerm); otherwise
      // the braille aperture. VINCI_ASCII_WORDMARK=1 also forces the no-image path. Built per-header so
      // capability + theme are current.
      const canImage = LOGO_B64 !== "" && process.env.VINCI_ASCII_WORDMARK !== "1" && !!getCapabilities().images;
      const image = canImage
        ? new Image(
            LOGO_B64,
            "image/png",
            { fallbackColor: (s: string) => theme.fg("dim", s) } satisfies ImageTheme,
            { maxWidthCells: LOGO_CELLS },
            LOGO_DIMS,
          )
        : undefined;
      return {
        render(width: number): string[] {
          // Read the model at render time so the header shows the REAL session model (it used to
          // hardcode the launch default — a /model switch left the header lying vs. the footer).
          const modelName = ctx.model?.name ?? ctx.model?.id ?? "Vinci Forte (GLM 5.2)";
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
          if (process.env.VINCI_HERO_HEADER !== "1") {
            return compactHeader(theme, modelName, width, ctx.cwd);
          }
          return image
            ? imageHeader(theme, image, width, modelName, ctx.cwd)
            : brailleHeader(theme, modelName, width, ctx.cwd);
        },
        invalidate() {
          image?.invalidate();
        },
      };
    });
  });
}
