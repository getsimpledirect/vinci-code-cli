/**
 * `/help` — see what Vinci can do, and where else Vinci works.
 *
 * The Vinci slash menu has advertised "help — See what Vinci can do" since the lean-menu patch,
 * but no command existed behind it (BUILTIN_SLASH_COMMANDS has no `help`, so the menu filter
 * dropped the entry and typing /help did nothing). This extension is that command. Extension
 * commands always join the `/` autocomplete, so no core edit is needed to surface it.
 *
 * Two short sections:
 *   - the Vinci commands a non-programmer actually reaches for, in plain language;
 *   - "Everywhere you work" — the rest of the ecosystem (Chat, phone, Mac, account), with
 *     canonical URLs from vinci-links.ts rendered as OSC-8 hyperlinks (the same escape form the
 *     login dialog uses for its verification link), so they're cmd-clickable where supported and
 *     still readable everywhere else.
 *
 * Additive — no core edits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  VINCI_CHAT_URL,
  VINCI_DESKTOP_DOWNLOAD_URL,
  VINCI_MOBILE_GET_URL,
  VINCI_PLATFORM_URL,
} from "./vinci-links.ts";

/** Cmd-clickable terminal hyperlink; the URL itself is the visible text, so it degrades to plain. */
function osc8(url: string): string {
  return `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
}

const COMMANDS: ReadonlyArray<[string, string]> = [
  ["/login", "Connect to Vinci"],
  ["/logout", "Disconnect from Vinci"],
  ["/model", "Choose which Vinci model to use"],
  ["/new", "Start a fresh conversation"],
  ["/resume", "Pick up an earlier conversation"],
  ["/undo", "Undo the last changes Vinci made to your files"],
  ["/usage", "See this task's model calls, tokens, and cost"],
  ["/security", "Show Vinci's active confidentiality and sandbox controls"],
  ["/support", "Get help and support"],
  ["/feedback", "Send private feedback without uploading your transcript"],
  ["/issue", "Report a bug or request a feature on the public tracker"],
  ["/hotkeys", "Keyboard shortcuts"],
];

const ECOSYSTEM: ReadonlyArray<[string, string]> = [
  ["Chat on the web", VINCI_CHAT_URL],
  ["Vinci on your phone", VINCI_MOBILE_GET_URL],
  ["Vinci Desktop for Mac", VINCI_DESKTOP_DOWNLOAD_URL],
  ["Your account and usage", VINCI_PLATFORM_URL],
];

/** Build the full /help text. `link` is injectable so tests can assert without escape codes. */
export function vinciHelpText(link: (url: string) => string = osc8): string {
  const nameWidth = Math.max(...COMMANDS.map(([name]) => name.length));
  const placeWidth = Math.max(...ECOSYSTEM.map(([label]) => label.length));
  return [
    "Vinci commands",
    ...COMMANDS.map(([name, blurb]) => `  ${name.padEnd(nameWidth)}  ${blurb}`),
    "",
    "Everywhere you work",
    ...ECOSYSTEM.map(([label, url]) => `  ${label.padEnd(placeWidth)}  ${link(url)}`),
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("help", {
    description: "See what Vinci can do",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(vinciHelpText(), "info");
      } else {
        process.stdout.write(`${vinciHelpText()}\n`);
      }
    },
  });
}
