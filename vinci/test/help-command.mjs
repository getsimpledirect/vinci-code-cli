// /help — the command the slash menu has advertised ("See what Vinci can do") now exists, prints
// the plain-language command list plus the "Everywhere you work" ecosystem links from
// vinci-links.ts, and never leaks a query param onto the runnable install command (it doesn't
// print the install command at all).
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const helpModule = await loader.import(resolve(root, "vinci/extensions/vinci-help.ts"), {
  default: false,
});

// Canonical ecosystem destinations, pinned as literals (default env — no staging overrides).
const expectedUrls = [
  "https://vinci.getsimpledirect.com/chat?source=code",
  "https://vinci.getsimpledirect.com/get?source=code",
  "https://www.getsimpledirect.com/api/download/mac?source=code",
  "https://platform.getsimpledirect.com/?source=code",
];

let command;
helpModule.default({
  registerCommand(name, options) {
    assert.equal(name, "help");
    command = options;
  },
});

assert.equal(command?.description, "See what Vinci can do");
assert.equal(typeof command?.handler, "function");

// Plain rendering (injectable link fn): both sections, every command, every URL.
const plain = helpModule.vinciHelpText((url) => url);
assert.match(plain, /^Vinci commands\n/);
assert.match(plain, /\nEverywhere you work\n/);
for (const name of [
  "/login",
  "/logout",
  "/model",
  "/new",
  "/resume",
  "/undo",
  "/usage",
  "/security",
  "/support",
  "/feedback",
  "/issue",
  "/hotkeys",
]) {
  assert.ok(plain.includes(`  ${name}`), `missing command ${name}`);
}
for (const url of expectedUrls) {
  assert.ok(plain.includes(url), `missing ecosystem link ${url}`);
}
// The runnable install command must never appear here (it must never gain a query param, and the
// safest way /help honors that is by not printing it).
assert.doesNotMatch(plain, /curl|\/install/);

// Default rendering wraps each URL in an OSC-8 hyperlink, same escape form as the login dialog.
const linked = helpModule.vinciHelpText();
for (const url of expectedUrls) {
  assert.ok(linked.includes(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`), `URL not OSC-8 linked: ${url}`);
}

// Interactive: readable foreground inside the status notification's dim outer color.
const notifications = [];
const foregroundCalls = [];
await command.handler("", {
  hasUI: true,
  ui: {
    theme: {
      fg(color, text) {
        foregroundCalls.push(color);
        return `<${color}>${text}</${color}>`;
      },
    },
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
});
assert.equal(notifications.length, 1);
assert.equal(notifications[0].type, "info");
assert.deepEqual(foregroundCalls, ["text"]);
assert.equal(notifications[0].message, `<text>${helpModule.vinciHelpText()}</text>`);

// Headless: writes the same text to stdout.
const originalWrite = process.stdout.write;
let stdout = "";
process.stdout.write = (chunk) => {
  stdout += chunk.toString();
  return true;
};
try {
  await command.handler("", { hasUI: false });
} finally {
  process.stdout.write = originalWrite;
}
assert.equal(stdout, `${helpModule.vinciHelpText()}\n`);

console.log("  help-command: all checks passed");
