import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Regression: "git commit && git push" arrived as ONE network-gated command, so declining the push
// silently cancelled the commit too — and the model then summarized a local commit that never
// happened (adversarial session #1, 2026-07-15). A network action bundled with local mutations is
// now blocked outright with coaching to split, so approval and denial each mean exactly one thing.

const here = dirname(fileURLToPath(import.meta.url));
const guardPath = resolve(here, "../extensions/vinci-guard.ts");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const guard = await loader.import(guardPath, { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

function harness() {
  const handlers = {};
  const sent = [];
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    appendEntry() {},
  };
  return { handlers, sent, pi };
}

async function firstBlock(handlers, command, context) {
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler({ toolName: "bash", input: { command } }, context);
    if (result?.block) return result;
  }
  return undefined;
}

// Headless context: the pure bundle check fires before any UI confirmation path.
const context = {
  cwd: process.cwd(),
  hasUI: false,
  ui: { setWidget() {}, notify() {} },
};

const { handlers, sent, pi } = harness();
guard.default(pi);

const bundled = await firstBlock(handlers, 'cd /tmp/x && git commit -m "fix parser" -q && git push origin main', context);
check("commit bundled with push is blocked", bundled?.block === true);
check("the block coaches splitting, not a confirmation prompt", String(bundled?.reason ?? "").includes("separate commands"));
check(
  "the model is told which local changes were bundled",
  sent.some((s) => s.message?.customType === "vinci-network-bundle-block" && String(s.message?.content ?? "").includes("git commit")),
);

// Two network actions in one command are NOT a bundle: a denial consistently cancels both, so the
// ordinary network approval covers them. Only local mutations riding on a network approval are.
const installAndPush = await firstBlock(handlers, "npm install left-pad && git push origin main", context);
check(
  "two network actions follow the normal approval path",
  installAndPush?.block === true && !String(installAndPush?.reason ?? "").includes("separate commands"),
);

const pushWithDiagnostics = await firstBlock(handlers, "cd /tmp/x && git push origin main 2>&1 | tail -5", context);
check(
  "push plus read-only diagnostics is NOT treated as a bundle",
  pushWithDiagnostics?.block === true && !String(pushWithDiagnostics?.reason ?? "").includes("separate commands"),
);

const barePush = await firstBlock(handlers, "git push origin main", context);
check(
  "a bare push still follows the normal network approval path",
  barePush?.block === true && !String(barePush?.reason ?? "").includes("separate commands"),
);

const localOnly = await firstBlock(handlers, 'git add index.js && git commit -m "fix" -q', context);
check("purely local compound commands are untouched by the network gate", localOnly === undefined || !String(localOnly?.reason ?? "").includes("separate commands"));

console.log(`\nnetwork-bundle-integration: ${pass}/${pass} checks passed (approvals mean exactly one thing)`);
