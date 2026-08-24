import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const scope = await loader.import(resolve(here, "../extensions/vinci-scope.ts"), { default: false });
const scopeDrift = await loader.import(resolve(here, "../extensions/lib/scope-drift.ts"), { default: false });

const list = `The infrastructure gaps are:
1. No SETUP.md for new developers.
2. README.md describes the wrong app.
3. No CONTRIBUTING.md for contributors.`;

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

const one = scope.resolveNumberedSelection("Let's start with 1)", list);
check("a short numbered reply resolves against the previous assistant list", one?.task.includes("No SETUP.md"));
check("a numbered reply does not authorize sibling items", !one?.task.includes("README.md"));
check("the selected item exposes its concrete file boundary", one?.files.join(",") === "setup.md");

const compound = scope.resolveNumberedSelection("let's do maybe 1 and 3", list);
check("compound numbered approval resolves both selected items", compound?.files.join(",") === "setup.md,contributing.md");
check(
  "how-to wording is classified as advisory even when it names the desired feature",
  scope.isAdvisoryRequest("What if I want to add auth to this repo, how would I go about it?"),
);
check("a direct implementation request is not advisory", !scope.isAdvisoryRequest("Can you add auth to this repo?"));
check("audit-and-fix is an action, not advisory (sweep P2-10)", !scope.isAdvisoryRequest("Audit the code and fix the bugs you find."));
check("review-then-repair-it is an action", !scope.isAdvisoryRequest("Review the auth flow and fix it."));
check("a pure audit stays advisory", scope.isAdvisoryRequest("Audit the code and tell me what you find."));
// A non-programmer naming a deliverable is an action, even with a secondary "tell me how to see it"
// clause (found live 2026-07-15: this exact shape blocked every file write as read-only advisory).
check(
  "a build-a-deliverable request with a 'tell me how' tail is NOT advisory",
  !scope.isAdvisoryRequest("I want a simple website for my dog-walking business with services and prices, and tell me how to see it when it's done"),
);
check(
  "'build me an app' is an action even asking how to view it",
  !scope.isAdvisoryRequest("Build me a to-do app and tell me how to run it"),
);
check(
  "'I need a landing page' is an action",
  !scope.isAdvisoryRequest("I need a landing page for my bakery, tell me how to open it"),
);
// Genuine advice about building must STILL be advisory — the opener is not "I want/build me a <thing>".
check(
  "'how do I build a website' stays advisory",
  scope.isAdvisoryRequest("How do I build a website for my business?"),
);
check(
  "'give me ideas for a website' stays advisory",
  scope.isAdvisoryRequest("Give me some ideas for a website for my shop"),
);
check(
  "nested dependency inspection resolves the actual package",
  scope.dependencyPackageFromInspection("cat node_modules/body-parser/node_modules/qs/lib/parse.js") === "qs",
);
check(
  "a direct runtime dependency probe resolves the imported package",
  scope.dependencyPackageFromInspection("node -e \"const qs = require('qs'); qs.parse('a=1')\"") === "qs",
);
check(
  "tracked dependency source candidates exclude metadata and tests",
  scope
    .trackedDependencySourcePaths(
      [
        "package.json:42:    \"qs\": \"6.14.2\"",
        "test/req.query.js:8:const qs = require('qs')",
        "lib/middleware/query.js:17:var qs = require('qs')",
        "lib/utils.js:18:var qs = require('qs')",
      ].join("\n"),
    )
    .join(",") === "lib/middleware/query.js,lib/utils.js",
);

const handlers = {};
const execCalls = [];
const appendedEntries = [];
const registeredTools = {};
const pi = {
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  registerTool(tool) {
    registeredTools[tool.name] = tool;
  },
  appendEntry(customType, data) {
    appendedEntries.push({ type: "custom", customType, data });
  },
  async exec(command, args, options) {
    execCalls.push({ command, args, options });
    return {
      stdout: [
        "package.json:42:    \"qs\": \"6.14.2\"",
        "test/req.query.js:8:const qs = require('qs')",
        "lib/utils.js:18:var qs = require('qs')",
      ].join("\n"),
      stderr: "",
      code: 0,
      killed: false,
    };
  },
};
scope.default(pi);

const selections = [];
const context = {
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  model: undefined,
  modelRegistry: undefined,
  sessionManager: {
    getBranch() {
      return [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: list }] } }];
    },
  },
  ui: {
    async select(title) {
      selections.push(title);
      return "Skip it — find another way";
    },
    async confirm() {
      return false;
    },
    notify() {},
  },
};

for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Let's start with 1)", source: "interactive" }, context);
  await handler({ type: "input", text: "Okay keep going", source: "interactive" }, context);
}

async function toolCall(path) {
  return callTool("write", { path, content: "test" });
}

async function callTool(toolName, input) {
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler({ toolName, input }, context);
    if (result !== undefined) return result;
  }
  return undefined;
}

async function toolResult(toolName, input, text) {
  for (const handler of handlers.tool_result ?? []) {
    const result = await handler(
      { toolName, input, content: [{ type: "text", text }], details: {}, isError: false },
      context,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}

check("the selected file remains an automatic in-scope edit", await toolCall("SETUP.md") === undefined);
const sibling = await toolCall("README.md");
check("a sibling item is paused instead of silently implemented", sibling?.block === true);
check("the pause explains the selected boundary", /selected only setup\.md/i.test(selections.at(-1) ?? ""));

const cleanupDir = mkdtempSync(join(tmpdir(), "vinci-scope-cleanup-"));
context.cwd = cleanupDir;
for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Fix the query parsing regression", source: "interactive" }, context);
}
check("a new diagnostic file is an automatic in-scope write", await toolCall("test-regression.js") === undefined);
const scratchWrite = await toolCall("repro.mjs");
check(
  "a scratch repro file is redirected to inline diagnostics without prompting for an outside write",
  scratchWrite?.block === true && /inline diagnostic/i.test(scratchWrite.reason) && /outside writes require/i.test(scratchWrite.reason),
);
check("scratch detection covers common diagnostic names", scope.isProjectDiagnosticScratch("debug-parser.js"));
check("scratch detection covers diagnostic directories", scope.isProjectDiagnosticScratch("_probe/sub/a.test.js"));
writeFileSync(join(cleanupDir, "test-regression.js"), "test\n");
const selectionsBeforeCleanup = selections.length;
check(
  "Vinci can remove a diagnostic file it created during the same task",
  await callTool("bash", { command: "rm -f test-regression.js" }) === undefined && selections.length === selectionsBeforeCleanup,
);
writeFileSync(join(cleanupDir, "user-notes.txt"), "keep\n");
const userFileDelete = await callTool("bash", { command: "rm user-notes.txt" });
check("deleting a pre-existing user file still pauses", userFileDelete?.block === true);
check("recursive cleanup never inherits the exemption", scope.simpleDeleteTargets("rm -rf test-regression.js", cleanupDir) === null);

for (const handler of handlers.input ?? []) {
  await handler(
    {
      type: "input",
      text: "What if I want to add auth to this repo, how would I go about it?",
      source: "interactive",
    },
    context,
  );
}
const advisoryWrite = await toolCall("src/app/api/auth/logout/route.ts");
check("an advisory request cannot silently become a file edit", advisoryWrite?.block === true);
check("the advisory guard tells the model to keep the turn read-only", /read-only/i.test(advisoryWrite?.reason ?? ""));
check("read-only inspection remains available for an advisory request", await callTool("read", { path: "README.md" }) === undefined);

for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Please add auth to this repo", source: "interactive" }, context);
}
check("an explicit implementation request authorizes a new file", await toolCall("auth-helper.ts") === undefined);
const dependencyWrite = await toolCall("node_modules/qs/lib/utils.js");
check("installed dependency files cannot be edited even during an implementation task", dependencyWrite?.block === true);
check("the dependency boundary redirects Vinci to tracked project source", /tracked project source/i.test(dependencyWrite?.reason ?? ""));
const dependencyRead = await toolResult("read", { path: "node_modules/qs/lib/utils.js" }, "export function parse() {}");
check("reading dependency source adds source-ownership guidance", /read-only evidence/i.test(dependencyRead?.content.at(-1)?.text ?? ""));
check(
  "dependency inspection appends bounded tracked project references",
  /lib\/utils\.js:18:var qs = require\('qs'\)/.test(dependencyRead?.content.at(-1)?.text ?? "") &&
    (dependencyRead?.content.at(-1)?.text ?? "").indexOf("lib/utils.js") <
      (dependencyRead?.content.at(-1)?.text ?? "").indexOf("package.json"),
);
check(
  "dependency reference search is fixed-string, tracked, and workspace-scoped",
  execCalls.at(-1)?.command === "git" &&
    execCalls.at(-1)?.args.includes("-F") &&
    execCalls.at(-1)?.options.cwd === cleanupDir,
);
const uninspectedDependencyEdit = await toolCall("auth-helper.ts");
check("dependency source candidates are enforced before mutation", uninspectedDependencyEdit?.block === true);
check("the ownership checkpoint names the unread source", /lib\/utils\.js/.test(uninspectedDependencyEdit?.reason ?? ""));
await toolResult("read", { path: "lib/utils.js" }, "var qs = require('qs');");
check("mutation resumes after the surfaced source candidate is inspected", await toolCall("auth-helper.ts") === undefined);
check(
  "dependency source guidance appears only once per task",
  (await toolResult("bash", { command: "rg parse node_modules/qs" }, "node_modules/qs/lib/utils.js")) === undefined,
);
for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Continue fixing the query parser", source: "interactive" }, context);
}
const dependencyShellRead = await toolResult(
  "bash",
  { command: "cat node_modules/qs/package.json | grep version" },
  '"version": "6.14.2"',
);
check(
  "shell inspection of a relative dependency path also gets source-ownership guidance",
  /actual runtime call site/i.test(dependencyShellRead?.content.at(-1)?.text ?? ""),
);
await toolResult("read", { path: "lib/utils.js" }, "var qs = require('qs');");
const overwrite = await toolCall("user-notes.txt");
check("write cannot replace an existing user file after an edit failure", overwrite?.block === true);
check("the overwrite guard directs the model back to edit", /use edit/i.test(overwrite?.reason ?? ""));
for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Fix this without rewriting user-notes.txt", source: "interactive" }, context);
}
check("a negated rewrite never authorizes whole-file replacement", (await toolCall("user-notes.txt"))?.block === true);

for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Fix the query parser again", source: "interactive" }, context);
}
await toolResult("bash", { command: "cat lib/utils.js" }, "var qs = require('qs');");
await toolResult("read", { path: "node_modules/qs/lib/utils.js" }, "export function parse() {}");
check(
  "dependency ownership remembers a project inspection made before candidates were discovered",
  await callTool("edit", { path: "auth-helper.ts", edits: [{ oldText: "old", newText: "new" }] }) === undefined,
);

for (const handler of handlers.input ?? []) {
  await handler({ type: "input", text: "Fix repeated qs values", source: "interactive" }, context);
}
await toolResult("read", { path: "lib/utils.js" }, "var qs = require('qs');");
const runtimeProbe = await toolResult(
  "bash",
  { command: "node -e \"const qs = require('qs'); qs.parse('a=1')\"" },
  "{ a: '1' }",
);
check(
  "direct runtime probes surface tracked dependency ownership",
  /tracked project references for qs/i.test(runtimeProbe?.content.at(-1)?.text ?? ""),
);
check(
  "a project source read made before the runtime probe satisfies the later ownership candidate",
  await callTool("edit", { path: "auth-helper.ts", edits: [{ oldText: "old", newText: "new" }] }) === undefined,
);
rmSync(cleanupDir, { recursive: true, force: true });

// rmdir removes only EMPTY directories (no data loss) — it must not trip the delete scope-prompt,
// while dangerous rm / rm -rf / unlink still do (found live 2026-07-15: flattening a nested folder).
const bash = (command) => ({ command });
check("rmdir is not a delete-category drift (empty dirs only, no data loss)", scope.categoryOf("bash", bash("rmdir linkhi")) === null);
check("rmdir -p is still safe", scope.categoryOf("bash", bash("rmdir -p a/b/c")) === null);
check("rm still flags as delete", scope.categoryOf("bash", bash("rm notes.txt")) === "delete");
check("rm -rf still flags as delete", scope.categoryOf("bash", bash("rm -rf build")) === "delete");
check("unlink still flags as delete", scope.categoryOf("bash", bash("unlink old.log")) === "delete");
check("git rm still flags as delete", scope.categoryOf("bash", bash("git rm src/x.js")) === "delete");

// ---- #179: a headless run has nobody to pause for, so the semantic judge runs ADVISORY there ----
// It records drift and never blocks; interactive behavior above is untouched.
const headlessDir = mkdtempSync(join(tmpdir(), "vinci-scope-headless-"));
const headlessFile = (name) => {
  const path = join(headlessDir, name);
  writeFileSync(path, "existing\n");
  return path;
};
const judgeFaux = registerFauxProvider({
  api: "faux:scope-judge",
  provider: "faux-scope-judge",
  models: [{ id: "scope-judge" }],
});
const headlessContext = {
  ...context,
  cwd: headlessDir,
  mode: "print",
  hasUI: false,
  model: judgeFaux.getModel("scope-judge"),
  modelRegistry: {
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "faux-scope-key", headers: {}, env: {} };
    },
  },
  sessionManager: {
    ...context.sessionManager,
    getSessionId() {
      return "scope-headless-task";
    },
  },
};

async function headlessEdit(path) {
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler(
      { toolName: "edit", input: { path, edits: [{ oldText: "existing", newText: "changed" }] } },
      headlessContext,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}

async function headlessTask(text) {
  for (const handler of handlers.input ?? []) {
    await handler({ type: "input", text, source: "print" }, headlessContext);
  }
}

try {
  await headlessTask("Fix the login button");
  const billing = headlessFile("billing.js");
  judgeFaux.setResponses([fauxAssistantMessage("OUT — unrelated billing area")]);
  const driftEdit = await headlessEdit(billing);
  check("headless drift is advisory: the tool call is still permitted", driftEdit === undefined);
  check(
    "headless drift is recorded in plain language",
    scope.getVinciScopeDriftNotes().join("|") === "Changed billing.js, which the request did not mention",
  );
  check(
    "the drift note travels on a session entry, so a crew handoff can carry it",
    scopeDrift.scanVinciScopeDriftEntries(appendedEntries).join("|") ===
      "Changed billing.js, which the request did not mention",
  );

  // Dedupe: the same file is judged once per task, in headless exactly as in interactive.
  const callsAfterFirstJudge = judgeFaux.state.callCount;
  judgeFaux.setResponses([fauxAssistantMessage("OUT — should never be asked")]);
  const secondEdit = await headlessEdit(billing);
  check(
    "a second edit to the same file costs no second judge call",
    secondEdit === undefined && judgeFaux.state.callCount === callsAfterFirstJudge,
  );
  check("and records no duplicate note", scope.getVinciScopeDriftNotes().length === 1);

  // The important one: an in-scope edit must produce NO note. False drift would be worse than none.
  const inScope = headlessFile("login-panel.js");
  judgeFaux.setResponses([fauxAssistantMessage("IN — this is the login button")]);
  const inScopeEdit = await headlessEdit(inScope);
  check(
    "an in-scope headless edit is permitted and records nothing",
    inScopeEdit === undefined && scope.getVinciScopeDriftNotes().length === 1 && appendedEntries.length === 1,
  );

  // An unsure verdict is not drift either.
  const unsureFile = headlessFile("unsure-area.js");
  judgeFaux.setResponses([fauxAssistantMessage("UNSURE — cannot tell")]);
  await headlessEdit(unsureFile);
  check("an unsure verdict records nothing", scope.getVinciScopeDriftNotes().length === 1);

  // A judge that fails must cost the turn nothing: no block, no note, no thrown error.
  const failingFile = headlessFile("judge-fails.js");
  judgeFaux.setResponses([]); // exhausted → the provider errors
  const failedJudge = await headlessEdit(failingFile);
  check(
    "a failed scope check never blocks the headless turn and records nothing",
    failedJudge === undefined && scope.getVinciScopeDriftNotes().length === 1,
  );

  // The per-turn cap is the same bound as interactive: at most MAX_SCOPE_CHECKS judge calls.
  await headlessTask("Fix the login button again");
  check("a new request clears the collected drift", scope.getVinciScopeDriftNotes().length === 0);
  const cappedFiles = Array.from({ length: 8 }, (_, index) => headlessFile(`unrelated-${index}.js`));
  judgeFaux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("IN — related enough")));
  const callsBeforeCap = judgeFaux.state.callCount;
  for (const path of cappedFiles) {
    check(`headless judging never blocks (${basename(path)})`, (await headlessEdit(path)) === undefined);
  }
  check(
    "the per-turn judge cap holds in headless",
    judgeFaux.state.callCount - callsBeforeCap === 6 && judgeFaux.getPendingResponseCount() === 2,
  );
} finally {
  judgeFaux.unregister();
  rmSync(headlessDir, { recursive: true, force: true });
}

// ---- #185: a crew helper HAS a UI context but nobody answers it ---------------------------------
// A helper runs as `vinci --mode rpc`, so ctx.hasUI is TRUE and the guard takes its interactive path
// — but crew handles no extension_ui_request, so the pause used to sit there until the helper's
// 10-minute ceiling. The prompt must resolve to the guard's OWN conservative branch instead, be
// recorded as scope drift, and never, ever resolve to "Go ahead".
check(
  "only an rpc child the crew launched counts as unanswerable",
  scopeDrift.isUnanswerableVinciUI("rpc", { VINCI_CREW_HELPER: "1" }) === true &&
    scopeDrift.isUnanswerableVinciUI("tui", { VINCI_CREW_HELPER: "1" }) === false &&
    scopeDrift.isUnanswerableVinciUI("rpc", {}) === false &&
    scopeDrift.isUnanswerableVinciUI(undefined, { VINCI_CREW_HELPER: "1" }) === false,
);

const helperDir = mkdtempSync(join(tmpdir(), "vinci-scope-helper-"));
const previousHelperEnv = process.env[scopeDrift.VINCI_CREW_HELPER_ENV];
process.env[scopeDrift.VINCI_CREW_HELPER_ENV] = "1";
// Nothing ever answers these — exactly the live shape. Any await on them hangs the turn.
let helperSelects = 0;
let helperConfirms = 0;
const helperContext = {
  ...context,
  cwd: helperDir,
  mode: "rpc",
  hasUI: true,
  ui: {
    select() {
      helperSelects++;
      return new Promise(() => {});
    },
    confirm() {
      helperConfirms++;
      return new Promise(() => {});
    },
    notify() {},
    theme: { fg: (_name, text) => text },
  },
};

// Every helper assertion runs under a deadline far below HELPER_TIMEOUT_MS (10 min): if the guard
// still awaited an unanswerable prompt, this rejects instead of quietly passing after a long wait.
const HELPER_DEADLINE_MS = 5000;
async function withinDeadline(label, run) {
  let timer;
  const started = Date.now();
  try {
    const value = await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not resolve within ${HELPER_DEADLINE_MS}ms`)), HELPER_DEADLINE_MS);
      }),
    ]);
    return { value, elapsed: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function helperInput(text) {
  for (const handler of handlers.input ?? []) await handler({ type: "input", text, source: "interactive" }, helperContext);
}

async function helperToolCall(toolName, input) {
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler({ toolName, input }, helperContext);
    if (result !== undefined) return result;
  }
  return undefined;
}

try {
  await helperInput("Fix the login button");
  writeFileSync(join(helperDir, "user-notes.txt"), "keep\n");
  const entriesBeforeHelper = appendedEntries.length;
  const deletePause = await withinDeadline("an unanswerable delete pause", () =>
    helperToolCall("bash", { command: "rm user-notes.txt" }),
  );
  check(
    "an unanswerable scope pause resolves instead of stalling the helper",
    deletePause.value?.block === true && deletePause.elapsed < HELPER_DEADLINE_MS,
  );
  check("and it never asked a question nobody could hear", helperSelects === 0);
  check(
    "it fails to the conservative branch — the skip reason, never 'Go ahead'",
    /do NOT delete files/.test(deletePause.value?.reason ?? "") && !/go ahead/i.test(deletePause.value?.reason ?? ""),
  );
  check(
    "the unanswerable pause is recorded as scope drift in plain language",
    scope.getVinciScopeDriftNotes().includes("Paused on a step that would delete files and could not ask, so skipped it"),
  );
  check(
    "and travels on a session entry, so the crew handoff can carry it",
    scopeDrift
      .scanVinciScopeDriftEntries(appendedEntries.slice(entriesBeforeHelper))
      .includes("Paused on a step that would delete files and could not ask, so skipped it"),
  );
  // The decisive property: a pause that could not be answered must not become a standing approval.
  const repeatDelete = await withinDeadline("a repeated unanswerable delete pause", () =>
    helperToolCall("bash", { command: "rm user-notes.txt" }),
  );
  check(
    "an unanswered pause never approves the category for the rest of the task",
    repeatDelete.value?.block === true && /do NOT delete files/.test(repeatDelete.value?.reason ?? ""),
  );
  check("and the same note is not recorded twice", scope.getVinciScopeDriftNotes().length === 1);

  // The volume confirm is the same shape: ctx.ui.confirm with no answerer.
  await helperInput("Tidy up the checkout flow");
  let volumePause;
  for (let index = 1; index <= 8; index++) {
    volumePause = await withinDeadline(`an unanswerable volume confirm (write ${index})`, () =>
      helperToolCall("write", { path: join(helperDir, `tidy-${index}.js`), content: "x" }),
    );
  }
  check(
    "the volume confirm also fails conservatively instead of waiting for an answer",
    volumePause?.value?.block === true && /Stop and check/i.test(volumePause?.value?.reason ?? "") && helperConfirms === 0,
  );
  check(
    "the unanswerable volume pause is recorded as scope drift too",
    scope.getVinciScopeDriftNotes().includes("Paused on a change spanning 8 files and could not ask, so skipped it"),
  );

  // ask_user has the same problem: a helper calling it used to emit a question with no answerer.
  const asked = await withinDeadline("ask_user inside a helper", () =>
    registeredTools.ask_user.execute(
      "call-1",
      { question: "Which database should I use?", options: ["Postgres", "SQLite"] },
      undefined,
      undefined,
      helperContext,
    ),
  );
  check(
    "ask_user in a helper answers honestly instead of hanging",
    /no way to ask right now/i.test(asked.value?.content?.[0]?.text ?? "") && helperSelects === 0,
  );

  // The constraint that matters most: a real terminal is NOT degraded, even with the marker present.
  const selectionsBeforeInteractive = selections.length;
  for (const handler of handlers.input ?? []) {
    await handler({ type: "input", text: "Fix the login button", source: "interactive" }, context);
  }
  writeFileSync(join(helperDir, "notes.txt"), "keep\n");
  context.cwd = helperDir;
  const interactiveDelete = await callTool("bash", { command: "rm notes.txt" });
  check(
    "a real TUI still gets the full prompt — hasUI is true in both, so only the helper degrades",
    selections.length === selectionsBeforeInteractive + 1 && interactiveDelete?.block === true,
  );
} finally {
  if (previousHelperEnv === undefined) delete process.env[scopeDrift.VINCI_CREW_HELPER_ENV];
  else process.env[scopeDrift.VINCI_CREW_HELPER_ENV] = previousHelperEnv;
  rmSync(helperDir, { recursive: true, force: true });
}

console.log(`\nscope-integration: ${pass}/${pass} checks passed (intent and file-scope boundaries)`);
