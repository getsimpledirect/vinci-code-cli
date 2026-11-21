/**
 * Memory integration.
 *
 * CONTRACT CHANGE (2026-07-29): this suite previously asserted that Vinci must REFUSE to save
 * unless the user explicitly asked ("durable project writes require an explicit user request").
 * That gate is deliberately gone. Vinci now saves on its own initiative too — but an unprompted
 * save is never silent: it is marked `auto` in the file and announced with an undoable receipt.
 * The explicit/autonomous distinction is preserved; it now selects the receipt, not permission.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// File-system observation for the rows below, installed BEFORE the extension is imported.
// The extension imports its fs functions by name. jiti turns `import { fchmodSync } from "node:fs"`
// into `_nodeFs = await jitiImport("node:fs")` plus calls of the form `(0, _nodeFs.fchmodSync)(...)`.
// For a "node:" specifier jiti uses a native import(), so _nodeFs is node:fs's ESM namespace, seen
// through jiti's interop proxy, which keeps each property from its first read. Assigning a function on
// the CommonJS object afterwards never reaches the extension. So each observed function is replaced
// once, here, by a dispatcher on the CommonJS object. syncBuiltinESMExports() then points the ESM
// namespace at the dispatchers, and only after that is the extension imported. A row observes by
// setting fsHooks[name] and clears it after. With no hook set, the dispatcher calls the original.
const fsModule = createRequire(import.meta.url)("node:fs");
const fsHooks = {};
for (const name of ["openSync", "fchmodSync", "chmodSync", "ftruncateSync", "writeFileSync"]) {
  const original = fsModule[name];
  fsModule[name] = function (...args) {
    const hook = fsHooks[name];
    return hook ? hook(original, ...args) : original.apply(this, args);
  };
}
syncBuiltinESMExports();
const clearHooks = () => {
  for (const name of Object.keys(fsHooks)) delete fsHooks[name];
};

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const entries = await loader.import(resolve(here, "../extensions/lib/memory-entries.ts"), { default: false });
const memory = await loader.import(resolve(here, "../extensions/vinci-memory.ts"), { default: false });
const secrets = await loader.import(resolve(here, "../extensions/lib/secrets.ts"), { default: false });

let passed = 0;
const ok = () => {
  passed += 1;
};

// ── Pure entry handling ─────────────────────────────────────────────────────────────────────────

{
  const parsed = entries.parseMemoryEntries("- we use pnpm\n- never touch generated/\n");
  assert.equal(parsed.length, 2, "legacy undated lines must still parse");
  assert.equal(parsed[0].text, "we use pnpm");
  assert.equal(parsed[0].date, undefined);
  assert.equal(parsed[0].autonomous, false);
  ok();
}

{
  const line = "- (2026-07-29, auto, pinned) deploys are Friday-only";
  const [entry] = entries.parseMemoryEntries(line);
  assert.equal(entry.text, "deploys are Friday-only");
  assert.equal(entry.date, "2026-07-29");
  assert.equal(entry.autonomous, true);
  assert.equal(entry.pinned, true);
  assert.equal(entries.formatEntry(entry), line, "formatting must round-trip the parsed entry");
  ok();
}

{
  const many = Array.from({ length: 40 }, (_, i) => ({
    date: "2026-07-29",
    text: `fact number ${i} with enough words to take real space in the budget`,
    pinned: false,
    autonomous: false,
  }));
  const selection = entries.selectForInjection(many, 400);
  assert.ok(selection.omitted > 0, "this fixture must exceed the cap");
  assert.equal(selection.shown + selection.omitted, selection.total);
  assert.ok(selection.text.length <= 400);
  ok();
}

{
  // The old implementation sliced the last N chars, dropping the OLDEST notes with no signal.
  const two = [
    { date: "2026-01-01", text: "oldest foundational fact", pinned: false, autonomous: false },
    { date: "2026-07-29", text: "newest fact", pinned: false, autonomous: false },
  ];
  const tight = entries.selectForInjection(two, 30);
  assert.ok(tight.text.includes("newest fact"), "the most recent entry wins the budget");
  assert.equal(tight.omitted, 1, "a dropped entry must be counted, never silently lost");
  ok();
}

{
  const mixed = [
    { date: "2026-01-01", text: "pinned rule", pinned: true, autonomous: false },
    { date: "2026-07-29", text: "newer but unpinned", pinned: false, autonomous: false },
  ];
  // Budget fits exactly one of the two, so the pin is what decides which one survives.
  const selection = entries.selectForInjection(mixed, 40);
  assert.ok(selection.text.includes("pinned rule"), "pinned entries outrank newer unpinned ones");
  assert.equal(selection.omitted, 1);
  ok();
}

{
  let list = [];
  list = entries.upsertEntry(list, { date: "2026-07-29", text: "we use pnpm", pinned: false, autonomous: false });
  list = entries.upsertEntry(list, { date: "2026-07-29", text: "We use pnpm.", pinned: false, autonomous: false });
  assert.equal(list.length, 1, "a restatement must replace, not append");

  list = entries.upsertEntry(list, { date: "2026-07-30", text: "we deploy on Friday", pinned: false, autonomous: false });
  assert.equal(list.length, 2, "an unrelated fact must be added");

  list = entries.upsertEntry(list, { date: "2026-07-31", text: "we deploy on Monday", pinned: false, autonomous: false });
  assert.equal(list.length, 2, "a same-subject contradiction must replace what it contradicts");
  assert.ok(list.some((e) => e.text === "we deploy on Monday"));
  assert.ok(!list.some((e) => e.text === "we deploy on Friday"));
  ok();
}

{
  const list = entries.upsertEntry([{ date: "2026-01-01", text: "we use pnpm", pinned: true, autonomous: false }], {
    date: "2026-07-29",
    text: "we use pnpm everywhere",
    pinned: false,
    autonomous: true,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].pinned, true, "an update must not quietly unpin a pinned note");
  ok();
}

// Hand-edited content survives a save. /memory tells people the file is theirs to edit; an earlier
// version parsed to a list and re-serialised from it, deleting every heading, note and blank line
// the next time Vinci saved a fact.
{
  const handEdited = "# My project notes\n\nStuff I care about:\n\n- we use pnpm\n- never touch generated/\n\nSee the wiki for more.\n";
  const doc = entries.parseMemoryDocument(handEdited);
  assert.equal(entries.documentEntries(doc).length, 2, "entries are still found among the prose");
  assert.equal(entries.serializeDocument(doc), handEdited, "an untouched document round-trips byte for byte");

  const saved = entries.serializeDocument(
    entries.upsertIntoDocument(doc, { date: "2026-07-29", text: "deploys are Friday-only", pinned: false, autonomous: true }),
  );
  assert.match(saved, /# My project notes/, "the heading survives a save");
  assert.match(saved, /Stuff I care about:/, "prose survives a save");
  assert.match(saved, /See the wiki for more\./, "a trailing note survives a save");
  assert.match(saved, /- \(2026-07-29, auto\) deploys are Friday-only/, "the new fact is written");
  // The new entry joins the existing list rather than landing after the trailing prose.
  assert.ok(
    saved.indexOf("deploys are Friday-only") < saved.indexOf("See the wiki"),
    "a new fact is appended after the last entry, not at the end of the file",
  );
  ok();
}

// A CRLF file must not come back with mixed endings: entry lines are regenerated with LF, so
// preserving CR only on the untouched lines would leave the file half one way and half the other.
{
  const doc = entries.parseMemoryDocument("# Notes\r\n\r\n- we use pnpm\r\n");
  assert.equal(entries.documentEntries(doc).length, 1);
  assert.equal(entries.serializeDocument(doc), "# Notes\n\n- we use pnpm\n");
  assert.doesNotMatch(entries.serializeDocument(doc), /\r/, "no stray carriage returns survive a save");
  ok();
}

// A note whose own text looks like an entry marker must not corrupt its metadata on the round trip.
{
  const written = entries.serializeDocument(
    entries.upsertIntoDocument([], {
      date: "2026-07-29",
      text: "(2026-01-01, auto, pinned) tricky",
      pinned: false,
      autonomous: false,
    }),
  );
  const [back] = entries.documentEntries(entries.parseMemoryDocument(written));
  assert.equal(back.text, "(2026-01-01, auto, pinned) tricky", "the fact text survives verbatim");
  assert.equal(back.date, "2026-07-29", "the real date wins over the one inside the text");
  assert.equal(back.autonomous, false, "a marker inside the text must not flip provenance");
  assert.equal(back.pinned, false);
  ok();
}

// Deleting one note leaves every other line — entries and prose alike — exactly where it was.
{
  const handEdited = "# Notes\n\n- alpha\n- beta\n\ntrailing prose\n";
  const doc = entries.parseMemoryDocument(handEdited);
  const after = entries.serializeDocument(entries.removeEntryFromDocument(doc, 0));
  assert.equal(after, "# Notes\n\n- beta\n\ntrailing prose\n");
  ok();
}

// ── Extension behaviour ─────────────────────────────────────────────────────────────────────────

function harness() {
  const handlers = {};
  const commands = {};
  let remember;
  memory.default({
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool(tool) {
      if (tool.name === "remember") remember = tool;
    },
    registerCommand(name, definition) {
      commands[name] = definition;
    },
  });

  const cwd = mkdtempSync(join(tmpdir(), "vinci-memory-it-"));
  // Point VINCI_HOME at a temp dir: without it, user-scoped memory resolves to the real
  // ~/.vinci-code/memory.md, so this suite would read the developer's own notes and its assertions
  // would depend on whatever happened to be saved there.
  const home = mkdtempSync(join(tmpdir(), "vinci-memory-home-"));
  process.env.VINCI_HOME = home;
  const notifications = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
  const input = async (text, source = "interactive") => {
    for (const handler of handlers.input ?? []) await handler({ text, source }, ctx);
  };
  const cleanup = () => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.VINCI_HOME;
  };
  return { cleanup, commands, ctx, cwd, handlers, home, input, notifications, remember };
}

const memFile = (cwd) => join(cwd, ".vinci", "memory.md");
const userMemFile = (home) => join(home, "memory.md");

// H05 R-spy, a positive control that runs FIRST: the observation installed above sees the extension's
// own save of the memory file. Without it, the R-order and R-perm rows could pass on silence.
{
  const h = harness();
  const seen = [];
  const observe = (name) => (original, target, ...rest) => {
    if (typeof target === "number") seen.push(name);
    else if (target === memFile(h.cwd)) seen.push(`${name}(path)`);
    return original(target, ...rest);
  };
  try {
    for (const name of ["openSync", "fchmodSync", "ftruncateSync", "writeFileSync"]) fsHooks[name] = observe(name);
    await h.input("remember that we deploy on Fridays");
    const r = await h.remember.execute("rs", { note: "we deploy on Fridays" }, undefined, undefined, h.ctx);
    clearHooks();
    assert.match(r.content[0].text, /^Remembered/, "H05 R-spy: the save itself succeeds");
    assert.ok(seen.length >= 1, "H05 R-spy: the fs observation sees the extension's save of the memory file");
    process.stdout.write(`  R-spy fired: ${seen.join(",")}\n`);
    ok();
  } finally {
    clearHooks();
    h.cleanup();
  }
}

// An unprompted save now succeeds — and is marked and announced rather than refused.
{
  const h = harness();
  try {
    await h.input("Fix the parser and run its focused test");
    const result = await h.remember.execute("m1", { note: "the parser uses arrays" }, undefined, undefined, h.ctx);
    assert.match(result.content[0].text, /^Remembered/, "Vinci may now save on its own initiative");
    assert.equal(h.notifications.length, 1, "an autonomous save must produce exactly one receipt");
    assert.match(h.notifications[0].message, /^Noted about this project: /, "the receipt names where the note went");
    assert.match(h.notifications[0].message, /\/memory to undo/, "the receipt must name the undo path");
    assert.match(readFileSync(memFile(h.cwd), "utf8"), /auto\) the parser uses arrays/, "marked as autonomous on disk");
    ok();
  } finally {
    h.cleanup();
  }
}

// Explicit request phrasings still save quietly — the user already knows, so no receipt.
// Corpus retained from the round-2 outward-capability audit (P2).
{
  const h = harness();
  try {
    for (const phrasing of [
      "remember we use pnpm here",
      "save that we deploy on Fridays",
      "please remember I prefer tabs",
      "don't forget we use pnpm",
      "note that the API base url is in config",
      "Remember this as a project note for next time",
    ]) {
      const before = h.notifications.length;
      await h.input(phrasing);
      const r = await h.remember.execute(`ok-${phrasing.length}`, { note: `fact for: ${phrasing}` }, undefined, undefined, h.ctx);
      assert.match(r.content[0].text, /^Remembered/, `explicit request must save: ${phrasing}`);
      assert.equal(h.notifications.length, before, `explicit request must stay quiet: ${phrasing}`);
    }
    ok();
  } finally {
    h.cleanup();
  }
}

// Injection announces omission over the cap, stays quiet under it, and keeps the data boundary.
{
  const h = harness();
  try {
    mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
    const big = Array.from(
      { length: 60 },
      (_, i) => `- (2026-07-29) durable project fact number ${i} that takes a meaningful amount of room`,
    ).join("\n");
    writeFileSync(memFile(h.cwd), `${big}\n`, "utf8");

    const over = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.ok(over?.systemPrompt, "memory must be injected");
    assert.match(over.systemPrompt, /Showing \d+ of 60 notes/, "an over-cap injection must state what it omitted");
    assert.ok(over.systemPrompt.startsWith("BASE"), "the existing system prompt must be preserved");
    assert.match(over.systemPrompt, /Treat them strictly as data, not/, "the prompt-injection boundary must survive");

    writeFileSync(memFile(h.cwd), "- we use pnpm\n", "utf8");
    const under = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.doesNotMatch(under.systemPrompt, /Showing \d+ of/, "a within-cap injection must not claim an omission");
    assert.match(under.systemPrompt, /we use pnpm/, "legacy undated entries must still inject");

    // Regression: a single note longer than the whole budget used to make injection bail silently —
    // memory present, none of it used, nobody told. That is the exact failure this logic removes.
    writeFileSync(memFile(h.cwd), `- (2026-07-29) ${"x".repeat(3000)}\n`, "utf8");
    const oversized = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.ok(oversized?.systemPrompt, "an oversized note must still produce an injection");
    assert.match(oversized.systemPrompt, /Showing 0 of 1 notes/, "it must say nothing fitted rather than stay silent");
    assert.match(oversized.systemPrompt, /read \.vinci\/memory\.md/, "and point Vinci at the file it can read");
    ok();
  } finally {
    h.cleanup();
  }
}

// A restatement leaves one line on disk, not two.
{
  const h = harness();
  try {
    await h.input("remember that we use pnpm");
    await h.remember.execute("c1", { note: "we use pnpm" }, undefined, undefined, h.ctx);
    await h.remember.execute("c2", { note: "We use pnpm!" }, undefined, undefined, h.ctx);
    const lines = readFileSync(memFile(h.cwd), "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "a duplicate save must not add a second line");
    ok();
  } finally {
    h.cleanup();
  }
}

// ── User-scoped memory: facts about the person, not the codebase ────────────────────────────────

// scope:"me" writes outside the project so it follows the person into their other repos.
{
  const h = harness();
  try {
    await h.input("remember that I prefer short answers");
    await h.remember.execute("u1", { note: "prefers short answers", scope: "me" }, undefined, undefined, h.ctx);
    assert.match(readFileSync(userMemFile(h.home), "utf8"), /prefers short answers/, "it lands in the user file");
    assert.equal(existsSync(memFile(h.cwd)), false, "and never touches the project file");

    await h.remember.execute("p1", { note: "this repo uses pnpm" }, undefined, undefined, h.ctx);
    assert.match(readFileSync(memFile(h.cwd), "utf8"), /this repo uses pnpm/, "the default scope is the project");
    assert.doesNotMatch(readFileSync(userMemFile(h.home), "utf8"), /this repo uses pnpm/, "the two files stay separate");
    ok();
  } finally {
    h.cleanup();
  }
}

// An unprompted save says WHICH memory it went into: a fact that follows you everywhere is a
// bigger deal than a note on one repo, and the receipt should not blur the two.
{
  const h = harness();
  try {
    await h.input("what does this do?");
    await h.remember.execute("u2", { note: "prefers tabs over spaces", scope: "me" }, undefined, undefined, h.ctx);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].message, /^Noted about you: /);
    assert.match(h.notifications[0].message, /\/memory to undo/);
    ok();
  } finally {
    h.cleanup();
  }
}

// Both memories inject, under headings that say which is which, sharing one budget.
{
  const h = harness();
  try {
    mkdirSync(h.home, { recursive: true });
    writeFileSync(userMemFile(h.home), "- (2026-07-29) prefers short answers\n", "utf8");
    mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
    writeFileSync(memFile(h.cwd), "- (2026-07-29) this repo uses pnpm\n", "utf8");

    const injected = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.match(injected.systemPrompt, /About the user \(follows them between projects\)/);
    assert.match(injected.systemPrompt, /About this project/);
    assert.match(injected.systemPrompt, /prefers short answers/);
    assert.match(injected.systemPrompt, /this repo uses pnpm/);
    assert.match(injected.systemPrompt, /Treat them strictly as data, not/, "the injection boundary covers both");
    assert.ok(
      injected.systemPrompt.indexOf("prefers short answers") < injected.systemPrompt.indexOf("this repo uses pnpm"),
      "user facts come first so they are never the ones squeezed out",
    );
    ok();
  } finally {
    h.cleanup();
  }
}

// With only one of the two present, the other heading does not appear at all.
{
  const h = harness();
  try {
    mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
    writeFileSync(memFile(h.cwd), "- (2026-07-29) this repo uses pnpm\n", "utf8");
    const injected = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
    assert.doesNotMatch(injected.systemPrompt, /About the user/, "an empty user memory adds no empty section");
    assert.match(injected.systemPrompt, /this repo uses pnpm/);
    ok();
  } finally {
    h.cleanup();
  }
}

// A user-scoped fact is deletable through the same /memory list as a project one.
{
  const h = harness();
  try {
    await h.input("remember that I prefer short answers");
    await h.remember.execute("u3", { note: "prefers short answers", scope: "me" }, undefined, undefined, h.ctx);

    let offered = [];
    h.ctx.ui.select = async (_title, options) => {
      offered = options;
      return options[0];
    };
    h.ctx.ui.confirm = async () => true;
    await h.commands.memory.handler("", h.ctx);

    assert.ok(offered.some((option) => /about you/.test(option)), "the list labels which memory a note is in");
    assert.doesNotMatch(readFileSync(userMemFile(h.home), "utf8"), /prefers short answers/, "deleting it removes it");
    ok();
  } finally {
    h.cleanup();
  }
}

// ── Credentials never reach memory, and memory files are owner-only ─────────────────────────────

// Built at runtime so no credential-shaped literal sits in the source.
const syntheticToken = `ghp_${"TESTONLY"}${"r".repeat(32)}`;

// A note holding a recognized credential is refused in both scopes, and the reply repeats none of it.
{
  const h = harness();
  try {
    await h.input("remember the deploy token");
    const project = await h.remember.execute("s1", { note: `the deploy token is ${syntheticToken}` }, undefined, undefined, h.ctx);
    assert.equal(existsSync(memFile(h.cwd)), false, "H05 M1: a note holding a recognized credential must not be written");
    assert.doesNotMatch(project.content[0].text, /^Remembered/, "H05 M1: a refused note must not be reported as saved");
    assert.equal(project.content[0].text.includes(syntheticToken), false, "H05-1: the refusal must not echo the credential");
    assert.equal(project.content[0].text.includes("deploy token"), false, "H05-1: the refusal must not echo the note");
    const personal = await h.remember.execute("s2", { note: syntheticToken, scope: "me" }, undefined, undefined, h.ctx);
    assert.equal(existsSync(userMemFile(h.home)), false, "H05 M1: personal memory must not receive the credential either");
    assert.equal(personal.content[0].text.includes(syntheticToken), false, "H05-1: the personal refusal must not echo it");
    assert.equal(h.notifications.length, 0, "H05 M1: a refused note produces no save receipt");
    ok();
  } finally {
    h.cleanup();
  }
}

// Ordinary text (markdown, unicode, surrounding whitespace) is still saved: the file holds exactly the
// serialized entry of the collapsed note (the tool's existing whitespace collapse).
{
  const h = harness();
  try {
    await h.input("remember this convention");
    const raw = "  Use **pnpm**, not `npm` — café, naïve, 日本語 → see [the guide](docs/guide.md)   \n";
    const expected = raw.replace(/\s+/g, " ").trim();
    const result = await h.remember.execute("p2", { note: raw }, undefined, undefined, h.ctx);
    assert.match(result.content[0].text, /^Remembered/, "H05-2: ordinary text must not be refused");
    const date = new Date().toISOString().slice(0, 10);
    const serialized = entries.serializeDocument(
      entries.upsertIntoDocument([], { date, text: expected, pinned: false, autonomous: false }),
    );
    assert.equal(readFileSync(memFile(h.cwd), "utf8"), serialized, "H05-2: the file holds exactly the serialized entry");
    assert.ok(readFileSync(memFile(h.cwd)).includes(Buffer.from(expected, "utf8")), "H05-2: the collapsed note's UTF-8 bytes are on disk");
    ok();
  } finally {
    h.cleanup();
  }
}

// A credential shape the masker recognizes only before line breaks are collapsed is refused too.
// The fixture is chosen at run time from candidates, by the shared masker itself: the first one it
// changes as given but not once collapsed. None found = the row fails (the raw check would be moot).
{
  const collapse = (text) => text.replace(/\s+/g, " ").trim();
  const wrapped = (text) => {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    return `${b64.slice(0, 24)}\n${b64.slice(24)}`;
  };
  const value = `Zq81${"mT0xLw9v"}B2nH`;
  const candidates = [
    `password="abcd\nexample"`,
    `config blob:\n${wrapped(`API_KEY=${value}\n`)}`,
    `notes\nDB_PASSWORD=${value}`,
    `${wrapped(`export TOKEN=${value}\n`)}`,
  ];
  const splitOnly = candidates.find(
    (c) => secrets.redactSecrets(c) !== c && secrets.redactSecrets(collapse(c)) === collapse(c),
  );
  assert.ok(splitOnly !== undefined, "H05 R-raw: at least one credential shape is recognized only before collapsing");
  console.log(`  R-raw fixture: candidate ${candidates.indexOf(splitOnly)}`);
  const h = harness();
  try {
    await h.input("remember the config blob");
    const r = await h.remember.execute("rr", { note: splitOnly }, undefined, undefined, h.ctx);
    assert.equal(existsSync(memFile(h.cwd)), false, "H05 R-raw: a credential recognized before collapsing must not be written");
    assert.doesNotMatch(r.content[0].text, /^Remembered/, "H05 R-raw: the refused note is not reported as saved");
    ok();
  } finally {
    h.cleanup();
  }
}

// An unprompted (autonomous) credential save is refused silently: no receipt, no echo.
{
  const h = harness();
  try {
    await h.input("Fix the parser and run its focused test");
    const r = await h.remember.execute("ra", { note: `ci uses ${syntheticToken}` }, undefined, undefined, h.ctx);
    assert.equal(existsSync(memFile(h.cwd)), false, "H05 R-auto: an autonomous credential note must not be written");
    assert.equal(h.notifications.length, 0, "H05 R-auto: a refused autonomous note produces no receipt");
    assert.equal(r.content[0].text.includes(syntheticToken), false, "H05 R-auto: the refusal must not echo the credential");
    ok();
  } finally {
    h.cleanup();
  }
}

// A note that is not text is refused cleanly: no throw, nothing written.
{
  const h = harness();
  try {
    await h.input("remember this");
    let r;
    try {
      r = await h.remember.execute("rn", { note: 12345 }, undefined, undefined, h.ctx);
    } catch (e) {
      assert.fail(`H05 R-nonstring: a non-string note must be refused, not throw (${e instanceof Error ? e.name : typeof e})`);
    }
    assert.match(r.content[0].text, /^Not saved/, "H05 R-nonstring: a non-string note is refused");
    assert.equal(existsSync(memFile(h.cwd)), false, "H05 R-nonstring: nothing is written");
    ok();
  } finally {
    h.cleanup();
  }
}

if (process.platform !== "win32") {
  // New memory files are created owner-only, even under a permissive umask.
  {
    const h = harness();
    const previousUmask = process.umask(0o022);
    try {
      await h.input("remember that I prefer tabs");
      await h.remember.execute("m3a", { note: "prefers tabs", scope: "me" }, undefined, undefined, h.ctx);
      await h.remember.execute("m3b", { note: "this repo uses tabs" }, undefined, undefined, h.ctx);
      assert.equal(statSync(userMemFile(h.home)).mode & 0o777, 0o600, "H05 M3: personal memory is created owner-only");
      assert.equal(statSync(memFile(h.cwd)).mode & 0o777, 0o600, "H05 M3: project memory is created owner-only");
      ok();
    } finally {
      process.umask(previousUmask);
      h.cleanup();
    }
  }

  // An existing shared-read memory file is narrowed on every write: a save and a /memory forget.
  {
    const h = harness();
    try {
      mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
      writeFileSync(memFile(h.cwd), "- (2026-07-29) we use pnpm\n", "utf8");
      chmodSync(memFile(h.cwd), 0o644);
      await h.input("remember that we deploy on Fridays");
      await h.remember.execute("m4", { note: "we deploy on Fridays" }, undefined, undefined, h.ctx);
      assert.equal(statSync(memFile(h.cwd)).mode & 0o777, 0o600, "H05 M4: an existing memory file is narrowed on save");

      chmodSync(memFile(h.cwd), 0o644);
      h.ctx.ui.select = async (_title, options) => options[0];
      h.ctx.ui.confirm = async () => true;
      await h.commands.memory.handler("", h.ctx);
      assert.equal(statSync(memFile(h.cwd)).mode & 0o777, 0o600, "H05 M4: an existing memory file is narrowed on forget");
      ok();
    } finally {
      h.cleanup();
    }
  }

  // A memory path that is a link is refused in both scopes: nothing is written and the target is untouched.
  {
    const h = harness();
    try {
      const target = join(h.home, "outside-target.md");
      writeFileSync(target, "outside\n", "utf8");
      mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
      symlinkSync(target, memFile(h.cwd));
      symlinkSync(target, userMemFile(h.home));
      await h.input("remember that we use pnpm");
      for (const [id, scope, path] of [["l1", undefined, memFile(h.cwd)], ["l2", "me", userMemFile(h.home)]]) {
        const r = await h.remember.execute(id, { note: "we use pnpm", scope }, undefined, undefined, h.ctx);
        assert.doesNotMatch(r.content[0].text, /^Remembered/, "H05 R-link: a linked memory path is not reported as saved");
        assert.match(r.content[0].text, /is a link or not a regular file/, "H05 R-link: the refusal names the link");
        assert.equal(lstatSync(path).isSymbolicLink(), true, "H05 R-link: the link itself is left as it was");
      }
      assert.equal(readFileSync(target, "utf8"), "outside\n", "H05 R-link: the link target is untouched");
      ok();
    } finally {
      h.cleanup();
    }
  }

  // An existing shared-read file is owner-only BEFORE its content changes: every content write the
  // extension makes is observed (through the fs observation installed before the import; R-spy proves
  // it fires) and the file's mode recorded then.
  {
    const h = harness();
    const modes = [];
    try {
      mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
      writeFileSync(memFile(h.cwd), "- (2026-07-29) we use pnpm\n", "utf8");
      chmodSync(memFile(h.cwd), 0o644);
      fsHooks.writeFileSync = (original, target, ...rest) => {
        if (typeof target === "number") modes.push(fstatSync(target).mode & 0o777);
        else if (typeof target === "string" && target === memFile(h.cwd) && existsSync(target)) modes.push(statSync(target).mode & 0o777);
        return original(target, ...rest);
      };
      // Truncation is the first content change: the mode is recorded there too.
      fsHooks.ftruncateSync = (original, target, ...rest) => {
        if (typeof target === "number") modes.push(fstatSync(target).mode & 0o777);
        return original(target, ...rest);
      };
      await h.input("remember that we deploy on Fridays");
      const r = await h.remember.execute("ro", { note: "we deploy on Fridays" }, undefined, undefined, h.ctx);
      clearHooks();
      assert.match(r.content[0].text, /^Remembered/, "H05 R-order: the save itself succeeds");
      assert.ok(modes.length >= 2, "H05 R-order: the truncation and the content write were observed");
      assert.deepEqual(modes, modes.map(() => 0o600), "H05 R-order: the file is owner-only before its content changes");
      ok();
    } finally {
      clearHooks();
      h.cleanup();
    }
  }

  // A failed permission change (a file someone else owns) refuses the save and leaves the file as it was.
  // Simulated: owning a file as another user needs root, so the chmod call is made to fail with EPERM.
  {
    const h = harness();
    const eperm = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
    };
    try {
      const before = "- (2026-07-29) we use pnpm\n";
      mkdirSync(dirname(memFile(h.cwd)), { recursive: true });
      writeFileSync(memFile(h.cwd), before, "utf8");
      chmodSync(memFile(h.cwd), 0o644);
      fsHooks.fchmodSync = eperm;
      fsHooks.chmodSync = eperm;
      await h.input("remember that we deploy on Fridays");
      const r = await h.remember.execute("rp", { note: "we deploy on Fridays" }, undefined, undefined, h.ctx);
      clearHooks();
      assert.doesNotMatch(r.content[0].text, /^Remembered/, "H05 R-perm: a failed chmod is not reported as saved");
      assert.equal(readFileSync(memFile(h.cwd), "utf8"), before, "H05 R-perm: a failed chmod writes nothing");
      ok();
    } finally {
      clearHooks();
      h.cleanup();
    }
  }
}

process.stdout.write(`  memory integration: ${passed}/${passed} passed (project + user scopes, marked, announced, undoable)\n`);
