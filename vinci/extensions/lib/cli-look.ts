import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { VINCI_GATEWAY_BASE_URL, VINCI_PROD_GATEWAY_URL } from "../vinci-links.ts";
import { getCapabilities, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { vinciAscii, vinciNoColor, vinciPlainPresentation } from "./cli-presentation.ts";

const PALETTES = {
  dark: {
    text: ["244;241;236", 255, 0], accent: ["184;197;176", 151, 32], muted: ["163;163;156", 247, 0],
    dim: ["138;138;130", 102, 0], success: ["156;190;143", 144, 32], warning: ["217;180;138", 180, 33],
    error: ["224;122;110", 173, 31], link: ["168;192;216", 146, 34], border: ["56;56;56", 237, 0],
  },
  light: {
    text: ["20;22;26", 233, 0], accent: ["88;107;72", 22, 32], muted: ["108;106;98", 242, 0],
    dim: ["114;112;106", 242, 0], success: ["78;122;63", 22, 32], warning: ["138;94;18", 94, 33],
    error: ["181;72;60", 124, 31], link: ["62;108;143", 60, 34], border: ["226;222;212", 253, 0],
  },
} as const;

export type VinciLookTheme = keyof typeof PALETTES;
type LookTheme = VinciLookTheme;
export type VinciLookToken = keyof (typeof PALETTES)["dark"];
export type VinciLookColor = "truecolor" | "256" | "16" | "none";
type LookColor = VinciLookColor;
type LookOptions = { width: number; theme: LookTheme; color: LookColor; ascii: boolean; plain: boolean };

export const VINCI_WELCOME_CHOICES = [
  { id: "vinci", label: "Connect to Vinci", caption: "pair this computer in your browser" },
  { id: "key", label: "Use my own API key", caption: "Anthropic, OpenAI, OpenRouter and more" },
  { id: "later", label: "Not now", caption: "look around first - /login any time" },
] as const;

export type VinciWelcomeChoice = (typeof VINCI_WELCOME_CHOICES)[number];
type WelcomeOptions = {
  profile: string;
  signedIn: boolean;
  showOtherProviders: boolean;
  select(choices: readonly VinciWelcomeChoice[]): Promise<VinciWelcomeChoice["id"] | undefined>;
  pair(): Promise<void>;
  key(): Promise<void>;
};

export async function runVinciWelcome({ profile, signedIn, showOtherProviders, select, pair, key }: WelcomeOptions): Promise<"quit" | "continue"> {
  const marker = join(profile, ".vinci-welcome-v1");
  if (signedIn || existsSync(marker)) return "continue";
  const choices = showOtherProviders
    ? VINCI_WELCOME_CHOICES
    : VINCI_WELCOME_CHOICES.filter(({ id }) => id !== "key");
  const choice = await select(choices);
  if (!choice || !choices.some(({ id }) => id === choice)) return "quit";
  mkdirSync(profile, { recursive: true });
  try {
    const file = openSync(marker, "wx");
    try {
      writeFileSync(file, `${choice}\n`);
    } finally {
      closeSync(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (choice === "vinci") await pair();
  if (choice === "key") await key();
  return "continue";
}

type Header = {
  version: string;
  project: string;
  branch?: string;
  model?: string;
  connection: "unknown" | "signed-out" | "signed-in" | "connected" | "reconnect";
  environment?: string;
};

export function hasVinciCredentials(agentDir: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    return Boolean(data?.vinci);
  } catch {
    return false;
  }
}

function canonicalGatewayUrl(url: string): string {
  const stripped = url.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(stripped);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return stripped.toLowerCase();
  }
}

export function vinciEnvironmentBadge(): string | undefined {
  const onDev = process.env.VINCI_ENV === "dev";
  const effective = VINCI_GATEWAY_BASE_URL.trim() || VINCI_PROD_GATEWAY_URL;
  if (!onDev && canonicalGatewayUrl(effective) === canonicalGatewayUrl(VINCI_PROD_GATEWAY_URL)) return undefined;
  let label = "dev";
  if (!onDev) {
    try {
      label = new URL(effective).host;
    } catch {
      label = effective;
    }
  }
  return `${vinciAscii() ? "!" : "▲"} ${label}`;
}

/**
 * Colour path for the Vinci look (spec r4 section 2): none for plain or NO_COLOR/--no-color, then
 * truecolor, 256 and 16. The launcher's exit bookend mirrors this decision in shell.
 */
export function vinciLookColor(trueColor: () => boolean = () => getCapabilities().trueColor): VinciLookColor {
  const force = process.env.FORCE_COLOR;
  return vinciPlainPresentation() || vinciNoColor() ? "none"
    : trueColor() || force === "3" ? "truecolor"
      : /256color/i.test(process.env.TERM ?? "") || force === "2" ? "256" : "16";
}

/** Opening foreground SGR for a look token, or "" where the path emits no colour (none, 16-colour default fg). */
export function vinciLookSgr(theme: VinciLookTheme, color: VinciLookColor, token: VinciLookToken): string {
  if (color === "none") return "";
  const [rgb, index, ansi] = PALETTES[theme][token];
  const code = color === "truecolor" ? `38;2;${rgb}` : color === "256" ? `38;5;${index}` : ansi;
  return code ? `\x1b[${code}m` : "";
}

export function getVinciLook(width: number, themeName?: string) {
  const plain = vinciPlainPresentation();
  const color = vinciLookColor();
  return createVinciLook({ width, theme: /light/i.test(themeName ?? "") ? "light" : "dark", color, ascii: vinciAscii(), plain });
}

function clipPlain(text: string, width: number, ellipsis: string): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  const ellipsisWidth = visibleWidth(ellipsis);
  const ellipsisFits = ellipsisWidth <= width;
  const source = ellipsisFits ? text : ellipsis;
  const available = ellipsisFits ? width - ellipsisWidth : width;
  let taken = "";
  for (const char of Array.from(source)) {
    if (visibleWidth(taken + char) > available) break;
    taken += char;
  }
  return ellipsisFits ? taken + ellipsis : taken;
}

export function createVinciLook({ width, theme, color, ascii, plain }: LookOptions) {
  ascii = ascii || plain;
  const separator = ascii ? " - " : " · ";
  const marker = ascii ? ">" : "›";
  const limit = Math.max(0, width - 1);
  const fg = (token: VinciLookToken, text: string): string => {
    if (plain || !text) return text;
    const sgr = vinciLookSgr(theme, color, token);
    return sgr ? `${sgr}${text}\x1b[39m` : text;
  };
  const bold = (text: string) => plain ? text : `\x1b[1m${text}\x1b[22m`;
  const fit = (line: string) => truncateToWidth(line, limit, "");
  const inset = "  ";
  const wordmark = () => inset + fg("text", bold("Vinci Code"));
  const tagline = () => fg("muted", "Made, not generated.");
  const versioned = (leading: string, version: string) =>
    leading + " ".repeat(Math.max(1, limit - visibleWidth(leading) - visibleWidth(version))) + fg("muted", version);

  function welcome(version: string, choices: readonly VinciWelcomeChoice[], selected: number): string[] {
    return [
      width >= 120 ? versioned(wordmark(), version) : wordmark() + " " + fg("muted", version),
      inset + tagline(), "",
      inset + fg("text", "Vinci checks the work before anything is called done."), "",
      inset + fg("text", "How do you want to connect?"),
      ...choices.map(({ label, caption }, index) => {
        const prefix = plain ? `${index + 1}. ` : index === selected ? `${marker} ` : "  ";
        return inset + fg(!plain && index === selected ? "accent" : "text", prefix + label) +
          " ".repeat(Math.max(1, 29 - inset.length - visibleWidth(prefix + label))) + fg("muted", caption.replaceAll(" - ", separator));
      }), "",
      inset + fg("muted", plain ? "Type a choice number and press Enter. Ctrl+C quits." :
        `Up/Down move${separator}Enter choose${separator}Esc quit`),
    ].map(fit);
  }

  function connectionLabel(connection: Header["connection"]): string {
    if (connection === "connected") return fg("success", "Connected");
    if (connection === "signed-in") return fg("text", "Signed in");
    if (connection === "reconnect") return fg("error", `Reconnect${separator}/login`);
    return fg("accent", "/login") + fg("text", " to connect");
  }

  function header(data: Header): string[] {
    const { version, project, branch, model, connection, environment } = data;
    const joinHint = fg("dim", separator);
    const versionLine = width >= 120
      ? versioned(wordmark() + joinHint + tagline(), version)
      : wordmark() + " " + fg("muted", version) + joinHint + tagline();
    const modelLabel = model || "Choose a model: /model";
    const clean = (text: string) => stripVTControlCharacters(text).replace(/[\r\n\t]/g, " ");
    const projectLabel = clean(branch ? `${project} (${branch})` : project);
    const context = inset + fg("text", projectLabel) + joinHint + fg("text", clean(modelLabel));
    let guidance = connectionLabel(connection);
    const badgeLabel = environment ? clean(environment) : "";
    const minLongBadgeWidth = 16;
    const minBadgeWidth = Math.min(visibleWidth(badgeLabel), minLongBadgeWidth);
    const connectionOnlyBadgeWidth = limit - visibleWidth(inset + guidance + joinHint);
    const badgeWidthWithHints = connectionOnlyBadgeWidth - visibleWidth(`${joinHint}/undo to undo${joinHint}/help`);
    const badgeWidth = badgeWidthWithHints >= minBadgeWidth ? badgeWidthWithHints : connectionOnlyBadgeWidth;
    const badge = badgeLabel ? clipPlain(badgeLabel, badgeWidth, ascii ? "..." : "…") : "";
    if (badge) guidance = fg("warning", badge) + joinHint + guidance;
    for (const hint of ["/undo to undo", "/help"]) {
      const candidate = guidance + joinHint + fg("muted", hint);
      if (visibleWidth(inset + candidate) <= limit) guidance = candidate;
    }
    return [versionLine, context, inset + guidance, inset + fg("muted", `Try: fix a bug${separator}add a feature${separator}explain this code`), ""].map(fit);
  }

  const corners = ascii ? ["+", "+", "+", "+"] : ["╭", "╮", "╰", "╯"];
  const horizontal = ascii ? "-" : "─";
  const vertical = ascii ? "|" : "│";
  function topBorder(label: string, token: VinciLookToken, pulse?: string): string {
    if (width <= 0) return "";
    if (width === 1) return fg("border", corners[0]);
    const status = stripVTControlCharacters(`${pulse ? pulse + " " : ""}${label}`).replace(/[\r\n\t]/g, " ");
    const clipped = truncateToWidth(status, Math.max(0, width - 5), "");
    const gap = width - 2 - (clipped ? visibleWidth(clipped) + 3 : 0);
    return fg("border", corners[0] + (clipped ? horizontal + " " : "")) +
      (clipped ? fg(token, clipped) + " " : "") + fg("border", horizontal.repeat(gap) + corners[1]);
  }
  return { fg, bold, welcome, header, connectionLabel, topBorder, corners, horizontal, vertical, marker, separator, ascii };
}
