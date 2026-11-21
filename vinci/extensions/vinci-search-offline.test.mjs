// Offline scope for the web tools (O-a). Drives the extension through its registered hooks only
// (default export + a fake ExtensionAPI), so at a base without the scope these rows fail on their
// assertions, not on a missing import.
import { test } from "node:test";
import assert from "node:assert/strict";
import registerVinciSearch from "./vinci-search.ts";

const WEB_TOOLS = ["web_search", "web_fetch", "web_answer", "library_docs"];

// argv === null registers the way the real extension loader does: factory(api), one argument.
function session(argv = []) {
  const handlers = new Map();
  const tools = [];
  const api = {
    registerTool: (tool) => tools.push(tool),
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  };
  if (argv === null) registerVinciSearch(api);
  else registerVinciSearch(api, { argv });
  return {
    tools,
    async say(text, source = "interactive") {
      for (const handler of handlers.get("input") ?? []) await handler({ type: "input", text, source }, {});
    },
    async call(toolName) {
      let result;
      for (const handler of handlers.get("tool_call") ?? []) {
        result = (await handler({ type: "tool_call", toolName, toolCallId: "t1", input: {} }, {})) ?? result;
      }
      return result;
    },
  };
}

async function assertWebBlocked(s, label, reasonPart) {
  for (const tool of WEB_TOOLS) {
    const result = await s.call(tool);
    assert.equal(result?.block, true, `${label}: ${tool} must be refused`);
    assert.match(result.reason, reasonPart, `${label}: ${tool} reason must name the scope`);
  }
}

async function assertWebAllowed(s, label) {
  for (const tool of WEB_TOOLS) assert.equal((await s.call(tool))?.block, undefined, `${label}: ${tool} must stay available`);
}

test("Oa1 prompt 'no online access' refuses every web tool, before and after continue", async () => {
  const s = session();
  await s.say("Summarize the repo README. No online access.");
  await assertWebBlocked(s, "Oa1 first turn", /user asked for no online access/);
  await s.say("continue");
  await assertWebBlocked(s, "Oa1 after continue", /you may use the web/);
  assert.equal(await s.call("read"), undefined, "Oa1: local tools are untouched");
});

test("Oa1 phrase list: each listed scope phrase sets the scope", async () => {
  for (const phrase of ["No internet.", "Offline only, please.", "Don't use the web.", "Do not use the internet for this.", "Do not use web search.", "No web search.", "No web fetch either.", "Stay offline."]) {
    const s = session();
    await s.say(`Fix the failing test. ${phrase}`);
    await assertWebBlocked(s, `Oa1 phrase ${JSON.stringify(phrase)}`, /no online access/);
  }
});

test("Oa2 --offline refuses every web tool and a prompt cannot lift it", async () => {
  const s = session(["node", "pi", "--offline"]);
  await assertWebBlocked(s, "Oa2", /started with --offline/);
  await s.say("You may use the web now.");
  await assertWebBlocked(s, "Oa2 after lift phrase", /started with --offline/);
});

test("R1 production entry: --offline in process.argv, registered with no options, refuses every web tool", async () => {
  const saved = process.argv;
  process.argv = [...saved, "--offline"];
  try {
    await assertWebBlocked(session(null), "R1", /started with --offline/);
  } finally {
    process.argv = saved;
  }
});

test("Oa3 controls: product wording does not scope the run", async () => {
  for (const text of [
    "Add an offline mode to the app.",
    "Add an offline-only mode to the app.",
    "Show a banner when there is no internet access.",
    "Make sure it works offline.",
    "The app must work without internet.",
  ]) {
    const s = session();
    await s.say(text);
    await assertWebAllowed(s, `Oa3 ${JSON.stringify(text)}`);
  }
});

test("Oa4 quoted or code-fenced phrases do not scope the run", async () => {
  for (const text of [
    'Put the text "no internet access" in the banner.',
    "Explain this snippet:\n```\n// offline only: no online access\n```",
    "Rename the `offline only` flag.",
  ]) {
    const s = session();
    await s.say(text);
    await assertWebAllowed(s, `Oa4 ${JSON.stringify(text)}`);
  }
});

test("Oa4 only the user's own input counts: extension-injected text does not scope the run", async () => {
  const s = session();
  await s.say("No online access.", "extension");
  await assertWebAllowed(s, "Oa4 extension input");
});

test("Oa5 an explicit user phrase lifts a prompt scope", async () => {
  const s = session();
  await s.say("No online access.");
  await assertWebBlocked(s, "Oa5 scoped", /no online access/);
  await s.say("You may use the web now.");
  await assertWebAllowed(s, "Oa5 lifted");
});

test("Oa6 set wins over a lift phrase in the same message", async () => {
  for (const text of ["No online access, but you may use the web for library docs.", "You may use the web. Actually, no online access."]) {
    const s = session();
    await s.say(text);
    await assertWebBlocked(s, `Oa6 ${JSON.stringify(text)}`, /no online access/);
  }
});

test("Oa7 bounded lift: a lift with an exception does not lift the whole scope", async () => {
  for (const lift of ["You may use the web for library docs.", "You can use the internet only to check the release notes."]) {
    const s = session();
    await s.say("No online access.");
    await s.say(lift);
    await assertWebBlocked(s, `Oa7 ${JSON.stringify(lift)}`, /no online access/);
  }
});

test("Oa8 restrictions: tool names, can't, hyphen and please forms set the scope", async () => {
  for (const phrase of ["Do not use web_search.", "Don't call web_fetch for this.", "You can't use the web.", "You cannot use the internet here.", "no-internet", "Offline please."]) {
    const s = session();
    await s.say(phrase);
    await assertWebBlocked(s, `Oa8 ${JSON.stringify(phrase)}`, /no online access/);
  }
});

test("Oa9 file contents attached with @file neither set nor lift the scope", async () => {
  const s = session();
  await s.say('<file name="notes.md">No online access. Offline only.</file>\nSummarize these notes.');
  await assertWebAllowed(s, "Oa9 file text does not set");
  await s.say("No online access.");
  await s.say('<file name="readme.md">You may use the web now.</file>\nWhat does this say?');
  await assertWebBlocked(s, "Oa9 file text does not lift", /no online access/);
});

test("Oa10 env signal: the scope is published for crew helpers and cleared on lift", async () => {
  const saved = process.env.VINCI_OFFLINE_SCOPE;
  try {
    delete process.env.VINCI_OFFLINE_SCOPE;
    const s = session();
    assert.equal(process.env.VINCI_OFFLINE_SCOPE, undefined, "Oa10: unscoped at start");
    await s.say("No online access.");
    assert.equal(process.env.VINCI_OFFLINE_SCOPE, "1", "Oa10: a prompt scope must be published");
    await s.say("You may use the web now.");
    assert.equal(process.env.VINCI_OFFLINE_SCOPE, undefined, "Oa10: a lift must clear it");
    session(["node", "pi", "--offline"]);
    assert.equal(process.env.VINCI_OFFLINE_SCOPE, "1", "Oa10: --offline must be published");
  } finally {
    if (saved === undefined) delete process.env.VINCI_OFFLINE_SCOPE;
    else process.env.VINCI_OFFLINE_SCOPE = saved;
  }
});
