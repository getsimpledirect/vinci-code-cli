// Vinci Code shell footer path boundary regression test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const source = fileURLToPath(new URL("../extensions/vinci-shell.ts", import.meta.url));
const shell = await loader.import(source, { default: false });
const { getEditorTheme, initTheme, theme } = await loader.import(
  fileURLToPath(new URL("../../packages/coding-agent/src/modes/interactive/theme/theme.ts", import.meta.url)),
);
const { VirtualTerminal } = await loader.import(
  fileURLToPath(new URL("../../packages/tui/test/virtual-terminal.ts", import.meta.url)),
);
const { KeybindingsManager } = await loader.import(
  fileURLToPath(new URL("../../packages/coding-agent/src/core/keybindings.ts", import.meta.url)),
);

const handlers = new Map();
shell.default({
  registerCommand() {},
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  on(eventName, handler) {
    handlers.set(eventName, handler);
  },
});

async function emit(eventName, event, context) {
  const handler = handlers.get(eventName);
  assert.equal(typeof handler, "function", `${eventName} handler must be registered`);
  await handler(event, context);
}

initTheme("dark", false);
const terminal = new VirtualTerminal(140, 20);
const tui = new TUI(terminal);
let editor;
const footerContext = {
  cwd: process.cwd(),
  model: { name: "Offline UI QA" },
  getContextUsage: () => ({ percent: 20, tokens: 26_000 }),
  ui: {
    theme,
    setWorkingVisible() {},
    setFooter() {},
    setTitle() {},
    setEditorComponent(factory) {
      editor = factory(tui, getEditorTheme(), new KeybindingsManager());
    },
  },
};

await emit("session_start", {}, footerContext);

function footerAt(width) {
  terminal.resize(width, 12);
  const line = editor.render(width).at(-1);
  assert.equal(visibleWidth(line), width, `footer must use exactly ${width} terminal cells`);
  const plain = stripVTControlCharacters(line);
  assert.match(plain, /20% full · ↓ 26k ╯$/, "footer metrics must remain complete");
  assert.ok(plain.includes("▶ AUTO  ·  Offline UI QA"), "footer mode and model must remain complete");
  return plain;
}

async function withHome(home, callback) {
  const previousHome = process.env.HOME;
  try {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    await callback();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

async function assertProject({ name, home, cwd, width, expected }) {
  await test(name, async () => {
    await withHome(home, () => {
      footerContext.cwd = cwd;
      assert.ok(footerAt(width).includes(expected));
    });
  });
}

const home = join(sep, "Users", "alice");

await assertProject({
  name: "shell footer abbreviates exact HOME",
  home,
  cwd: home,
  width: 140,
  expected: "~",
});

await assertProject({
  name: "shell footer abbreviates a true HOME descendant",
  home,
  cwd: join(home, "project"),
  width: 140,
  expected: `~${sep}project`,
});

await assertProject({
  name: "shell footer preserves a HOME descendant named dot-dot-cache",
  home,
  cwd: join(home, "..cache"),
  width: 140,
  expected: `~${sep}..cache`,
});

const sibling = `${home}-other${sep}project`;
await assertProject({
  name: "shell footer rejects an unrelated same-prefix sibling",
  home,
  cwd: sibling,
  width: 140,
  expected: sibling,
});

const parent = resolve(home, "..");
await assertProject({
  name: "shell footer leaves the HOME parent path unchanged",
  home,
  cwd: parent,
  width: 140,
  expected: parent,
});

const unrelated = join(sep, "opt", "project");
await assertProject({
  name: "shell footer leaves unrelated paths unchanged",
  home,
  cwd: unrelated,
  width: 140,
  expected: unrelated,
});

await assertProject({
  name: "shell footer leaves paths unchanged when HOME is absent",
  home: undefined,
  cwd: join(home, "project"),
  width: 140,
  expected: join(home, "project"),
});

await test("shell footer keeps width below 100 on the project basename", async () => {
  await withHome(home, () => {
    footerContext.cwd = join(home, "long-parent", "project-name");
    const footer = footerAt(80);
    assert.ok(footer.includes("project-name"));
    assert.ok(!footer.includes(home), "footer must not include the HOME path prefix at narrow width");
    assert.ok(!footer.includes("long-parent"), "footer must not include the parent directory at narrow width");
  });
});

await emit("session_shutdown", {}, footerContext);
