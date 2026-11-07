import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { createJiti } from "jiti/static";

const root = realpathSync(resolve(process.env.VINCI_TEST_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))));
const built = process.env.VINCI_TEST_BUILT === "1";
const sourceOnly = !built && process.env.VINCI_TEST_SOURCE_ONLY === "1";
process.env.VINCI_CODE = "1";
if (built) {
  const sourceRoot = realpathSync(resolve(process.env.VINCI_TEST_SOURCE_ROOT ?? root));
  console.log(execFileSync(process.execPath, [
    resolve(sourceRoot, "vinci/scripts/build-source-identity.mjs"), "check", sourceRoot,
    resolve(root, "vinci/dist/source-identity.json"),
  ], { encoding: "utf8" }).trim());
}
const location = (name, path) => {
  const selected = resolve(root, path);
  assert.equal(realpathSync(selected), selected, `load the selected ${name} module without fallback`);
  console.log(`Resolved ${name} module: ${selected}`);
  console.log(`${name} module SHA-256: ${createHash("sha256").update(readFileSync(selected)).digest("hex")}`);
  return selected;
};
const extension = built ? "js" : "ts";
const directory = built ? "dist" : "src";
const tuiPath = location("TUI", `packages/tui/${sourceOnly ? "src/index.ts" : "dist/index.js"}`);
const bindingsPath = location("keybindings", `packages/coding-agent/${directory}/core/keybindings.${extension}`);
const hintsPath = location("keybinding-hints", `packages/coding-agent/${directory}/modes/interactive/components/keybinding-hints.${extension}`);
const modePath = location("interactive-mode", `packages/coding-agent/${directory}/modes/interactive/interactive-mode.${extension}`);
const themePath = location("theme", `packages/coding-agent/${directory}/modes/interactive/theme/theme.${extension}`);
const aliases = sourceOnly ? {
  "@earendil-works/pi-ai/compat": resolve(root, "packages/ai/src/compat.ts"),
  "@earendil-works/pi-ai/oauth": resolve(root, "packages/ai/src/oauth.ts"),
  "@earendil-works/pi-ai": resolve(root, "packages/ai/src/index.ts"),
  "@earendil-works/pi-agent-core": resolve(root, "packages/agent/src/index.ts"),
  "@earendil-works/pi-tui": resolve(root, "packages/tui/src/index.ts"),
} : {};
if (sourceOnly) {
  console.log("Source-only loader; consumer and shipped-artifact controls require the built dependencies.");
  for (const [name, selected] of Object.entries(aliases)) console.log(`Source-only alias ${name}: ${selected}`);
} else {
  const require = createRequire(pathToFileURL(modePath));
  assert.equal(realpathSync(require.resolve("@earendil-works/pi-tui")), tuiPath, "the selected consumer must resolve the matching TUI payload");
}
const loader = built ? undefined : createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: true,
  tryNative: false,
  alias: aliases,
});
const load = (path) => built ? import(pathToFileURL(path).href) : loader.import(path);
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const selectedPlatform = process.env.VINCI_TEST_PLATFORM ?? process.platform;
Object.defineProperty(process, "platform", { ...platform, value: selectedPlatform });
let tui;
let keybindings;
try {
  tui = await load(tuiPath);
  keybindings = await load(bindingsPath);
} finally {
  Object.defineProperty(process, "platform", platform);
}
const { InteractiveMode } = await load(modePath);
const hints = await load(hintsPath);
const { initTheme } = await load(themePath);
initTheme("dark", false);
const { KeybindingsManager } = keybindings;
const methods = InteractiveMode.prototype;
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function manager(config = {}) {
  const selected = new KeybindingsManager(config);
  tui.setKeybindings(selected);
  return selected;
}
function displayKey(key) {
  Object.defineProperty(process, "platform", { ...platform, value: selectedPlatform });
  try {
    return hints.formatKeyText(key, { capitalize: true });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}
function hotkeys(selected, shortcuts = new Map()) {
  tui.setKeybindings(selected);
  let body;
  const context = {
    getAppKeyDisplay: methods.getAppKeyDisplay,
    getEditorKeyDisplay: methods.getEditorKeyDisplay,
    keybindings: selected,
    session: { extensionRunner: { getShortcuts: () => shortcuts } },
    showContentOverlay(title, text) {
      assert.equal(title, "Keyboard Shortcuts", "exercise the actual hotkeys overlay");
      body = text;
    },
  };
  Object.defineProperty(process, "platform", { ...platform, value: selectedPlatform });
  try {
    methods.handleHotkeysCommand.call(context);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.equal(typeof body, "string", "the actual hotkeys command must render content");
  return body;
}
function emptyBindings() {
  return Object.fromEntries(Object.keys(new KeybindingsManager().getEffectiveConfig()).map((action) => [action, []]));
}
function startup(selected) {
  tui.setKeybindings(selected);
  const code = readFileSync(modePath, "utf8");
  const start = code.indexOf("// Build startup instructions using keybinding hint helpers");
  const end = code.indexOf("this.builtInHeader = new ExpandableText(", start);
  assert.ok(start >= 0 && end > start, "select the actual startup instruction statements");
  const body = `function startup() {\n${code.slice(start, end)}\nreturn { expandedInstructions, compactInstructions, compactOnboarding };\n}`;
  const compiled = transformSync(body, { loader: "ts" }).code;
  return new Function("keyText", "keyHint", "rawKeyHint", "theme", `${compiled}\nreturn startup();`)(
    hints.keyText, hints.keyHint, hints.rawKeyHint, { fg: (_color, text) => text },
  );
}

test("unbound display formatter preserves empty key semantics and omits keyless hints", () => {
  manager({ "app.thinking.cycle": [] });
  assert.equal(hints.keyText("app.thinking.cycle"), "", "an unbound key remains semantically empty");
  assert.equal(hints.keyDisplayText("app.thinking.cycle"), "Unbound", "an empty display binding must say Unbound");
  assert.equal(hints.keyHint("app.thinking.cycle", "to cycle thinking level"), "", "unbound actions must not become startup instructions");
  assert.equal(hints.rawKeyHint("", "to cycle models"), "", "empty raw hints must not become startup instructions");
});

test("actual hotkeys shows the deliberately unbound thinking action", () => {
  const selected = manager();
  assert.deepEqual(selected.getKeys("app.thinking.cycle"), [], "the effective default is deliberately unbound");
  const body = hotkeys(selected);
  assert.ok(body.includes("**BASICS**") && body.includes("**Advanced**"), "both actual hotkeys groups must be present");
  assert.ok(body.includes("| `Unbound` | Cycle thinking level |"), "the actual thinking row must display Unbound");
  assert.ok(!body.includes("``"), "actual hotkeys must contain no empty backticks");
});

test("actual hotkeys labels an unavailable suspend binding", () => {
  const selected = selectedPlatform === "win32" ? manager() : manager({ "app.suspend": [] });
  assert.deepEqual(selected.getKeys("app.suspend"), [], "the tested suspend binding is unavailable, including the simulated Windows default");
  assert.ok(hotkeys(selected).includes("| `Unbound` | Suspend to background |"), "the actual suspend row must display Unbound");
});

test("the same action rebound and separate bound actions retain their keys", () => {
  const selected = manager({ "app.thinking.cycle": "ctrl+alt+t" });
  const body = hotkeys(selected);
  assert.ok(body.includes(`| \`${displayKey("ctrl+alt+t")}\` | Cycle thinking level |`), "the rebound thinking action must show its configured key");
  assert.ok(body.includes("| `Enter` | Send |"), "a separate bound basics action must retain its key");
  assert.ok(body.includes("| `Enter` | Send message |"), "the repeated advanced bound action must retain its key");
  assert.ok(body.includes("| `Ctrl+C` | Clear editor (first) / exit (second) |"), "a separate bound app action must retain its key");
  assert.ok(plain(hints.keyHint("app.thinking.cycle", "to cycle thinking level")).includes("to cycle thinking level"), "a rebound action retains its startup hint");
});

test("all user-empty, repeated, grouped and extension rows display Unbound", () => {
  const body = hotkeys(manager(emptyBindings()), new Map([["", { description: "Extension action" }]]));
  for (const row of [
    "| `Unbound` | Send |", "| `Unbound` | Send message |",
    "| `Unbound` | Exit (when editor is empty) |",
    "| `Unbound` | Suspend to background |", "| `Unbound` | Extension action |",
    "| `Unbound` / `Unbound` | Move by word |",
    "| `Unbound` / `Unbound` / `Unbound` / `Unbound` | Move cursor / browse history |",
  ]) assert.ok(body.includes(row), `the actual hotkeys row must retain an Unbound label: ${row}`);
  assert.equal(body.split("| `Unbound` | Exit (when editor is empty) |").length - 1, 2, "both exit rows must use the same policy");
  assert.ok(!body.includes("``"), "all displayed groups must avoid empty backticks");
  for (const row of body.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Key |"))) {
    const cell = row.split("|")[1].trim();
    assert.match(cell, /^(?:`Unbound`(?: \/ `Unbound`)*|`\/`|`!`|`!!`)$/, `every displayed row must follow the same Unbound policy: ${row}`);
  }
  assert.ok(hotkeys(manager({ "app.thinking.cycle": "" })).includes("| `Unbound` | Cycle thinking level |"), "an empty user string also displays Unbound");
});

test("a mixed group preserves its bound member", () => {
  const selected = manager({ "tui.editor.cursorWordLeft": [], "tui.editor.cursorWordRight": "ctrl+alt+r" });
  const body = hotkeys(selected);
  const row = body.split("\n").find((line) => line.endsWith("| Move by word |"));
  assert.ok(row, "the actual mixed group must be present");
  assert.ok(row.includes(`\`${displayKey("ctrl+alt+r")}\``), "the bound member of a mixed group must keep its key");
});

test("startup instructions omit unavailable actions and retain usable grouped keys", () => {
  const empty = startup(manager(emptyBindings()));
  assert.ok(!plain(empty.expandedInstructions).includes("to cycle thinking level"), "an unbound thinking action must not become a startup instruction");
  assert.ok(!plain(empty.expandedInstructions).includes("twice"), "an unbound clear action must not produce a keyless repeated-key instruction");
  assert.ok(!plain(empty.expandedInstructions).includes("to cycle models"), "an entirely unbound model group must not produce a slash-only instruction");
  assert.ok(!plain(empty.compactInstructions).includes("clear/exit"), "an entirely unbound compact group must be omitted");
  assert.ok(!plain(empty.expandedInstructions).includes("\n\n"), "omitted expanded hints must not leave blank instruction rows");
  assert.ok(!plain(empty.compactInstructions).startsWith(" · "), "omitted compact hints must not leave leading separators");
  assert.equal(plain(empty.compactOnboarding), "Use /hotkeys to view keyboard shortcuts.", "unbound expansion must offer a usable command");
  const partial = startup(manager({ "app.model.cycleForward": [], "app.model.cycleBackward": "ctrl+alt+b" }));
  const modelHint = plain(partial.expandedInstructions).split("\n").find((line) => line.endsWith("to cycle models"));
  assert.equal(modelHint, `${hints.formatKeyText("ctrl+alt+b")} to cycle models`, "a partial model group must show only its usable key");
});
