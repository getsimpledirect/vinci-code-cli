import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Regression: a steering message queued mid-run REPLACED the scope task, so the judge then flagged
// the original work as out of scope (observed live 2026-07-15: "before you commit — rename the
// test title" replaced "fix the bug", and the fix edit to index.js drew a beyond-what-you-asked
// pause). Mid-run messages and amendment-shaped openers must AMEND the task, not replace it.

const here = dirname(fileURLToPath(import.meta.url));
const scopePath = resolve(here, "../extensions/vinci-scope.ts");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const scope = await loader.import(scopePath, { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

const handlers = {};
const pi = {
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  registerTool() {},
  registerCommand() {},
  sendMessage() {},
  appendEntry() {},
};
const context = {
  cwd: process.cwd(),
  hasUI: true,
  ui: { setWidget() {}, notify() {} },
  sessionManager: { getBranch: () => [] },
};

scope.default(pi);
async function input(text, streamingBehavior) {
  for (const handler of handlers.input ?? []) await handler({ type: "input", text, source: "interactive", ...(streamingBehavior ? { streamingBehavior } : {}) }, context);
}

const ORIGINAL = "The test suite is failing after a recent refactor. Find and fix the bug, verify with the tests, then commit and push.";
await input(ORIGINAL);
check("a fresh request sets the scope task", scope.getVinciScopeTask() === ORIGINAL);

await input("Actually before you commit anything - rename the fix's test title to mention issue 77", "steer");
check(
  "a mid-run steering message amends the task instead of replacing it",
  scope.getVinciScopeTask().startsWith(ORIGINAL) && scope.getVinciScopeTask().includes("issue 77"),
);

await input("don't forget to double check .env.example didn't end up in the diff", "followUp");
check(
  "a queued follow-up amends too",
  scope.getVinciScopeTask().startsWith(ORIGINAL) && scope.getVinciScopeTask().includes(".env.example"),
);

await input("Also add a changelog entry for the fix");
check(
  "an amendment-shaped message between turns amends as well",
  scope.getVinciScopeTask().startsWith(ORIGINAL) && scope.getVinciScopeTask().includes("changelog"),
);

await input("Now build me a small CLI that converts CSV files to markdown tables");
check(
  "a genuinely new request replaces the task",
  !scope.getVinciScopeTask().includes("test suite") && scope.getVinciScopeTask().includes("CSV"),
);

console.log(`\nscope-amendment-integration: ${pass}/${pass} checks passed (steering amends scope, never shrinks it)`);
