// Failing read-only shell commands (git status in a folder that is not a repository) must not get a later edit refused,
// and must still be bounded on their own. Measures the real loopbreak hook with scripted input/agent_start/tool_call/
// tool_result events, no model and no executed tools. A blocked call gets no tool_result here.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
const ext = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
const hardStop = await loader.import(resolve(here, "../extensions/lib/hard-stop.ts"), { default: false });

const FAIL = { isError: true, text: "fatal: not a git repository (or any of the parent directories): .git" };
const OK = { isError: false, text: " M a.txt" };
const EDITED = { isError: false, text: "Applied 1 edit." };
const EDIT_FAILED = { isError: true, text: "Could not find the exact text to replace." };
const STATUS = Array.from({ length: 8 }, (_, i) => `git status --porcelain .${"/".repeat(i)}`); // one byte apart
const ERROR_STREAK_REASON = "Vinci paused after several failed actions.";
const READ_ONLY_REASON = "Vinci paused after several failed read-only commands.";

function fixture(id) {
  const handlers = {};
  const lists = {};
  const controls = [];
  const taskId = `rs-${id}`;
  const ctx = {
    hasUI: false,
    ui: { notify() {} },
    cwd: resolve(here, "../.."),
    mode: "tui",
    sessionManager: { getSessionId: () => taskId },
    abort() {},
  };
  ext.default({
    on(name, fn) { handlers[name] = fn; (lists[name] ??= []).push(fn); },
    sendMessage(message, options) { controls.push({ message, options }); },
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
  });
  control.clearVinciAutomationStop();
  hardStop.clearVinciHardStop(taskId);
  let n = 0;
  const f = {
    async start(text) {
      for (const fn of lists.input) await fn({ text, source: "interactive" }, ctx);
      for (const fn of lists.agent_start) await fn({}, ctx);
    },
    // tool_call, then (only when allowed and a result is given) tool_result.
    async call(toolName, input, result) {
      n++;
      const before = controls.length;
      const r = await handlers.tool_call({ toolName, input }, ctx);
      const allowed = r === undefined;
      if (allowed && result) {
        for (const fn of lists.tool_result) {
          await fn({ toolName, input, isError: result.isError, content: [{ type: "text", text: result.text }], details: {} }, ctx);
        }
      }
      const sent = controls.slice(before).map(({ message }) => message);
      return { n, allowed, reason: r?.reason ?? null, controls: sent.map((m) => m.customType), contents: sent.map((m) => m.content) };
    },
    status(command, result) { return f.call("bash", { command }, result); },
    edit(path, result = EDITED) { return f.call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }, result); },
    hardStop() { return hardStop.getVinciHardStop(taskId) ?? null; },
    automationStopped() { return control.getVinciAutomationStop().stopped; },
    clear() { control.clearVinciAutomationStop(); hardStop.clearVinciHardStop(taskId); },
  };
  return f;
}

// Every row starts with the A4 positive control: an ordinary read-only command is allowed.
async function begin(id) {
  const f = fixture(id);
  await f.start(`${id}: change a.txt and report`);
  const a4 = await f.status(`ls -a ${id}`, { isError: false, text: "a.txt b.txt" });
  assert.equal(a4.allowed, true, `${id} A4: an ordinary read-only command is allowed (positive control)`);
  return f;
}

test("S1 an edit after four failing read-only commands is allowed", async () => {
  const f = await begin("S1");
  for (const c of STATUS.slice(0, 4)) assert.equal((await f.status(c, FAIL)).allowed, true, "S1: each failing status call runs");
  const e = await f.edit("S1.txt");
  assert.equal(e.reason, null, `S1: the edit is not refused (got: ${e.reason})`);
  assert.equal(e.allowed, true, "S1: the edit is allowed");
  f.clear();
});

test("S2 a fifth read-only command after four failing ones is paused with read-only wording", async () => {
  const f = await begin("S2");
  for (const c of STATUS.slice(0, 4)) assert.equal((await f.status(c, FAIL)).allowed, true, "S2: each failing status call runs");
  const fifth = await f.status(STATUS[4], FAIL);
  assert.equal(fifth.reason, READ_ONLY_REASON, `S2: the fifth read-only call is paused as read-only (got: ${fifth.reason})`);
  assert.ok(fifth.controls.includes("vinci-readonly-error-streak"), "S2: the read-only error-streak control is sent");
  const steer = String(fifth.contents[fifth.controls.indexOf("vinci-readonly-error-streak")]);
  assert.ok(steer.includes("edits are still allowed"), `S2: the read-only steer says edits are still allowed (got: ${steer})`);
  assert.equal(f.hardStop(), null, "S2: no hard stop is recorded for the read-only pause");
  assert.equal(f.automationStopped(), false, "S2: no automation stop for the read-only pause");
  f.clear();
});

test("S2b after the read-only pause an edit is still allowed", async () => {
  const f = await begin("S2b");
  for (const c of STATUS.slice(0, 4)) await f.status(c, FAIL);
  const fifth = await f.status(STATUS[4], FAIL);
  assert.equal(fifth.reason, READ_ONLY_REASON, `S2b: the read-only pause fired first (got: ${fifth.reason})`);
  const e = await f.edit("S2b.txt");
  assert.equal(e.reason, null, `S2b: the edit after the read-only pause is not refused (got: ${e.reason})`);
  assert.equal(e.allowed, true, "S2b: the edit is allowed");
  f.clear();
});

test("S3 four failing edits still pause the next action (unchanged)", async () => {
  const f = await begin("S3");
  for (let i = 0; i < 4; i++) assert.equal((await f.edit(`S3-${i}.txt`, EDIT_FAILED)).allowed, true, "S3: each failing edit runs");
  const next = await f.edit("S3-next.txt");
  assert.equal(next.reason, ERROR_STREAK_REASON, `S3: the next action is refused by the error streak (got: ${next.reason})`);
  assert.ok(next.controls.includes("vinci-error-streak"), "S3: the error-streak control is sent");
  f.clear();
});

test("S4 a failing read-only command neither counts toward nor resets the edit-failure streak", async () => {
  const f = await begin("S4");
  for (let i = 0; i < 3; i++) await f.edit(`S4-${i}.txt`, EDIT_FAILED);
  assert.equal((await f.status(STATUS[0], FAIL)).allowed, true, "S4: the failing status call runs");
  const fourthEdit = await f.edit("S4-3.txt", EDIT_FAILED);
  assert.equal(fourthEdit.reason, null, `S4: the edit after the status call is allowed (got: ${fourthEdit.reason})`);
  const next = await f.edit("S4-next.txt");
  assert.equal(next.reason, ERROR_STREAK_REASON, `S4: after the fourth failed edit the next action is refused (got: ${next.reason})`);
  f.clear();
});

test("S5 a succeeding read-only command resets the read-only failure count", async () => {
  const f = await begin("S5");
  for (const c of STATUS.slice(0, 3)) await f.status(c, FAIL);
  assert.equal((await f.status("git status --porcelain", OK)).allowed, true, "S5: the succeeding status call runs");
  for (const c of STATUS.slice(3, 6)) {
    const r = await f.status(c, FAIL);
    assert.equal(r.reason, null, `S5: each later failing read-only call runs (got: ${r.reason})`);
  }
  const next = await f.status(STATUS[6], FAIL);
  assert.equal(next.reason, null, `S5: the next read-only call is allowed (got: ${next.reason})`);
  f.clear();
});
