import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createVinciLook, VINCI_WELCOME_CHOICES } from "../extensions/lib/cli-look.ts";

const version = "0.0.62";
const header = {
  version, project: "example", branch: "main", model: "Vinci Forte", connection: "signed-in",
};
const states = [
  ["Ready", "muted"], ["Thinking", "accent"], ["Thinking - Checking...", "accent"],
  ["Done", "success"], ["Error - Sign-in expired. Run /login.", "error"], ["Blocked", "error"],
  ["Not sure", "link"], ["Needs your OK", "warning"], ["Waiting for you", "warning"],
];
const palettes = {
  dark: {
    text: [[244, 241, 236], 255, null], accent: [[184, 197, 176], 151, 32], muted: [[163, 163, 156], 247, null],
    dim: [[138, 138, 130], 102, null], success: [[156, 190, 143], 144, 32], warning: [[217, 180, 138], 180, 33],
    error: [[224, 122, 110], 173, 31], link: [[168, 192, 216], 146, 34], border: [[56, 56, 56], 237, null],
  },
  light: {
    text: [[20, 22, 26], 233, null], accent: [[88, 107, 72], 22, 32], muted: [[108, 106, 98], 242, null],
    dim: [[114, 112, 106], 242, null], success: [[78, 122, 63], 22, 32], warning: [[138, 94, 18], 94, 33],
    error: [[181, 72, 60], 124, 31], link: [[62, 108, 143], 60, 34], border: [[226, 222, 212], 253, null],
  },
};
const colors = ["truecolor", "256", "16", "none"];
let cases = 0;
for (const width of [80, 120]) {
  for (const theme of ["dark", "light"]) {
    for (const color of colors) {
      const look = createVinciLook({ width, theme, color, ascii: true, plain: false });
      const welcome = look.welcome(version, VINCI_WELCOME_CHOICES, 0);
      const expectedWelcome = [
        width === 80 ? "  Vinci Code 0.0.62" : "  Vinci Code".padEnd(113) + version,
        "  Made, not generated.", "",
        "  Vinci checks the work before anything is called done.", "",
        "  How do you want to connect?",
        "  > Connect to Vinci         pair this computer in your browser",
        "    Use my own API key       Anthropic, OpenAI, OpenRouter and more",
        "    Not now                  look around first - /login any time", "",
        "  Up/Down move - Enter choose - Esc quit",
      ];
      const renderedHeader = look.header(header);
      const expectedHeader = [
        width === 80
          ? "  Vinci Code 0.0.62 - Made, not generated."
          : "  Vinci Code - Made, not generated.".padEnd(113) + version,
        "  example (main) - Vinci Forte",
        "  Signed in - /undo to undo - /help",
        "  Try: fix a bug - add a feature - explain this code", "",
      ];
      assert.deepEqual(welcome.map(stripVTControlCharacters), expectedWelcome);
      assert.deepEqual(renderedHeader.map(stripVTControlCharacters), expectedHeader);
      assert.ok([...welcome, ...renderedHeader].every((line) => visibleWidth(line) < width));
      assert.match(welcome[0], /\x1b\[1mVinci Code\x1b\[22m/);
      assert.doesNotMatch(welcome.join("\n") + renderedHeader.join("\n"), /\x1b_G|\x1b\]1337|\x1b\[2m/);
      for (const [token, [rgb, index, ansi]] of Object.entries(palettes[theme])) {
        const prefix = color === "truecolor" ? `38;2;${rgb.join(";")}`
          : color === "256" ? `38;5;${index}`
            : color === "16" ? ansi : null;
        const expected = prefix === null ? token : `\x1b[${prefix}m${token}\x1b[39m`;
        assert.equal(look.fg(token, token), expected, `${theme} ${color} ${token}`);
      }
      for (const [label, token] of states) {
        const border = look.topBorder(label, token);
        assert.equal(visibleWidth(border), width);
        assert.equal(stripVTControlCharacters(border), `+- ${label} `.padEnd(width - 1, "-") + "+");
        assert.ok(border.includes(look.fg(token, label)));
      }
      cases++;
    }
  }
}

const utf8 = createVinciLook({ width: 80, theme: "dark", color: "none", ascii: false, plain: false });
assert.deepEqual(utf8.welcome(version, VINCI_WELCOME_CHOICES, 0).slice(6), [
  "  › Connect to Vinci         pair this computer in your browser",
  "    Use my own API key       Anthropic, OpenAI, OpenRouter and more",
  "    Not now                  look around first · /login any time", "",
  "  Up/Down move · Enter choose · Esc quit",
]);
assert.deepEqual(utf8.header(header).slice(0, 4), [
  "  Vinci Code 0.0.62 · Made, not generated.",
  "  example (main) · Vinci Forte",
  "  Signed in · /undo to undo · /help",
  "  Try: fix a bug · add a feature · explain this code",
].map((line) => line.replace("Vinci Code", "\x1b[1mVinci Code\x1b[22m")));
assert.equal(
  utf8.header({ ...header, environment: `▲ ${"x".repeat(60)}` })[2],
  `  ▲ ${"x".repeat(38)}… · Signed in · /undo to undo · /help`,
  "80-column header keeps connection text and whole command hints when a long environment badge crowds the row.",
);
assert.equal(
  utf8.header({ ...header, model: undefined })[1],
  "  example (main) · Choose a model: /model",
  "80-column header prompts to choose a model on the context line when no model is set.",
);
assert.equal(utf8.topBorder("Ready", "muted"), "╭─ Ready ".padEnd(79, "─") + "╮");
assert.deepEqual([utf8.corners, utf8.horizontal, utf8.vertical], [["╭", "╮", "╰", "╯"], "─", "│"]);

const plain = createVinciLook({ width: 80, theme: "dark", color: "truecolor", ascii: false, plain: true });
const plainWelcome = plain.welcome(version, [VINCI_WELCOME_CHOICES[0], VINCI_WELCOME_CHOICES[2]], 0).join("\n");
assert.match(plainWelcome, /  1\. Connect to Vinci[\s\S]*  2\. Not now/);
assert.match(plainWelcome, /Type a choice number and press Enter\. Ctrl\+C quits\./);
assert.doesNotMatch(plainWelcome + plain.header(header).join("\n"), /\x1b|[^\x00-\x7f]/);
console.log(`look-render: ${cases}/16 layout and palette combinations, 9 states each, UTF-8 glyphs and plain fallback passed`);
