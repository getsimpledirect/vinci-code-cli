/**
 * Multi-answer ask_user: the checklist a user ticks when several options can be true at once.
 * `ctx.ui.select` is single-choice by construction, so this surface is drawn via `ctx.ui.custom`.
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const checklist = await loader.import(resolve(here, "../extensions/lib/ask-checklist.ts"), { default: false });

let passed = 0;
const ok = () => {
  passed += 1;
};

const theme = { fg: (_color, text) => text, bold: (text) => text };
const options = [
  { label: "forfaits-* only", description: "Mobile plans first.", recommended: true },
  { label: "box-* too", description: "Include internet boxes.", recommended: false },
  { label: "every fetcher", description: "Even those without Airtable.", recommended: false },
];

// The recommended option starts ticked, so pressing Enter immediately is a sensible answer
// rather than an empty one.
{
  const state = checklist.createChecklistState(options);
  assert.deepEqual(checklist.chosenLabels(state, options), ["forfaits-* only"]);
  assert.equal(state.cursor, 0);
  ok();
}

// With no recommendation, nothing is pre-ticked — Vinci must not invent a default.
{
  const plain = options.map((option) => ({ ...option, recommended: false }));
  const state = checklist.createChecklistState(plain);
  assert.deepEqual(checklist.chosenLabels(state, plain), []);
  ok();
}

// Ticking accumulates, and the answer keeps the options' own order rather than click order.
{
  const state = checklist.createChecklistState(options);
  checklist.moveCursor(state, 1, options.length); // → box-*
  checklist.toggleCurrent(state);
  checklist.moveCursor(state, 1, options.length); // → every fetcher
  checklist.toggleCurrent(state);
  assert.deepEqual(checklist.chosenLabels(state, options), ["forfaits-* only", "box-* too", "every fetcher"]);
  ok();
}

// Ticking is a toggle: the same key removes it again.
{
  const state = checklist.createChecklistState(options);
  checklist.toggleCurrent(state); // untick the pre-ticked recommendation
  assert.deepEqual(checklist.chosenLabels(state, options), []);
  checklist.toggleCurrent(state);
  assert.deepEqual(checklist.chosenLabels(state, options), ["forfaits-* only"]);
  ok();
}

// The cursor wraps in both directions so arrow keys never dead-end.
{
  const state = checklist.createChecklistState(options);
  checklist.moveCursor(state, -1, options.length);
  assert.equal(state.cursor, options.length - 1, "up from the first row wraps to the last");
  checklist.moveCursor(state, 1, options.length);
  assert.equal(state.cursor, 0, "down from the last row wraps to the first");
  ok();
}

// Rendering: a checkbox per row, the cursor marker, descriptions, and a visible way out.
{
  const state = checklist.createChecklistState(options);
  checklist.moveCursor(state, 1, options.length);
  checklist.toggleCurrent(state);
  const lines = checklist.renderAskChecklist("Which fetchers?", options, state, theme);
  const body = lines.join("\n");

  assert.match(body, /Which fetchers\?/);
  assert.match(body, /1\. \[✓\] forfaits-\* only \(Recommended\)/, "the recommendation is marked and pre-ticked");
  assert.match(body, /2\. \[✓\] box-\* too/, "a ticked row shows a filled box");
  assert.match(body, /3\. \[ \] every fetcher/, "an unticked row shows an empty box");
  assert.match(body, /Mobile plans first\./, "each option keeps its plain-language description");
  assert.match(body, /space to tick .* enter when done .* esc to cancel/, "the way out is always on screen");
  assert.ok(
    lines.some((line) => line.includes("› 2.")),
    "the cursor marks the row the user is on",
  );
  ok();
}

// Rows are returned untruncated: they carry ANSI colour, so the caller clips them width-aware.
{
  const state = checklist.createChecklistState(options);
  const coloured = { fg: (_c, text) => `[36m${text}[0m`, bold: (text) => text };
  const lines = checklist.renderAskChecklist("Q", options, state, coloured);
  assert.ok(
    lines.some((line) => line.includes("[36m")),
    "colour is applied by the theme, not stripped here",
  );
  ok();
}

// ── The ask_user tool itself, driven with real keystrokes ───────────────────────────────────────

const scope = await loader.import(resolve(here, "../extensions/vinci-scope.ts"), { default: false });

function askTool() {
  const tools = [];
  scope.default({ on: () => {}, registerTool: (tool) => tools.push(tool), registerCommand: () => {} });
  return tools.find((tool) => tool.name === "ask_user");
}

const KEY = { up: "\x1b[A", down: "\x1b[B", space: " ", enter: "\r", escape: "\x1b" };

function checklistCtx(keystrokes) {
  const seen = { customOpened: false, selectOpened: false, rendered: [] };
  const flat = { fg: (_c, text) => text, bold: (text) => text };
  return {
    seen,
    ctx: {
      hasUI: true,
      ui: {
        theme: flat,
        custom(factory) {
          seen.customOpened = true;
          return new Promise((resolvePromise) => {
            const component = factory({ requestRender() {} }, flat, {}, resolvePromise);
            seen.rendered = component.render(80);
            for (const key of keystrokes) component.handleInput(key);
          });
        },
        select() {
          seen.selectOpened = true;
          return undefined;
        },
      },
    },
  };
}

const askOptions = [
  { label: "forfaits-* only", description: "Mobile plans first.", recommended: true },
  { label: "box-* too", description: "Include internet boxes." },
  { label: "every fetcher", description: "Even those without Airtable." },
];

// multiple:true ticks a checklist and returns every ticked answer — never the select dialog.
{
  const harness = checklistCtx([KEY.down, KEY.space, KEY.enter]);
  const result = await askTool().execute(
    "ask-1",
    { question: "Which fetchers?", options: askOptions, multiple: true },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(harness.seen.customOpened, true, "a multi-answer question uses the checklist");
  assert.equal(harness.seen.selectOpened, false, "it must not fall back to the single-choice dialog");
  assert.match(result.content[0].text, /The user chose: forfaits-\* only, box-\* too/);
  assert.ok(harness.seen.rendered.join("\n").includes("[✓]"), "the checklist renders checkboxes");
  ok();
}

// Unticking everything is a real answer: every option was declined, not "no response".
{
  const harness = checklistCtx([KEY.space, KEY.enter]);
  const result = await askTool().execute(
    "ask-2",
    { question: "Which fetchers?", options: askOptions, multiple: true },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(result.content[0].text, /ticked nothing — treat every option as declined/);
  ok();
}

// Esc cancels without inventing an answer.
{
  const harness = checklistCtx([KEY.escape]);
  const result = await askTool().execute(
    "ask-3",
    { question: "Which fetchers?", options: askOptions, multiple: true },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(result.content[0].text, /cancelled without choosing/);
  ok();
}

// Without multiple, the long-standing single-choice path is untouched.
{
  const harness = checklistCtx([]);
  await askTool().execute("ask-4", { question: "One or the other?", options: askOptions }, undefined, undefined, harness.ctx);
  assert.equal(harness.seen.selectOpened, true, "a single-choice question still uses ctx.ui.select");
  assert.equal(harness.seen.customOpened, false, "and must not open the checklist");
  ok();
}

process.stdout.write(`  ask checklist: ${passed}/${passed} passed (multi-answer ask_user ticks, toggles, wraps)\n`);
