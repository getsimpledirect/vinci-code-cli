// Integration check for vinci-priority.ts: a turn served at the provider's PRIORITY tier shows a
// themed status badge; any other tier clears it; no UI → no-op.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const ext = await loader.import(resolve(here, "../extensions/vinci-priority.ts"), { default: false });

// Capture the message_end handler the extension registers.
let handler;
ext.default({ on: (name, h) => { if (name === "message_end") handler = h; } });
assert.equal(typeof handler, "function", "extension must register a message_end handler");

const makeCtx = (hasUI) => {
  const calls = [];
  return {
    hasUI,
    ui: { setStatus: (key, text) => calls.push({ key, text }), theme: { fg: (_c, t) => t } },
    _calls: calls,
  };
};
const fire = (ctx, serviceTier) => handler({ message: { role: "assistant", serviceTier } }, ctx);

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log(`  ✓ ${name}`); pass++; };

// priority → badge set, containing the word "priority" and the themed diamond glyph.
{
  const ctx = makeCtx(true);
  fire(ctx, "priority");
  const last = ctx._calls.at(-1);
  check("a priority-served turn sets the vinci-priority status", last?.key === "vinci-priority");
  check("the badge reads 'priority' with the themed ◆ glyph", /◆.*priority/.test(last?.text ?? ""));
  check("the badge carries no emoji", !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(last?.text ?? ""));
}

// default (or missing) tier → badge cleared (undefined), never a stale ◆ priority.
{
  const ctx = makeCtx(true);
  fire(ctx, "default");
  check("a default-tier turn clears the badge (undefined)", ctx._calls.at(-1)?.text === undefined);
  const ctx2 = makeCtx(true);
  fire(ctx2, undefined);
  check("a turn with no echoed tier clears the badge too", ctx2._calls.at(-1)?.text === undefined);
}

// headless / no UI → never touches the status line.
{
  const ctx = makeCtx(false);
  fire(ctx, "priority");
  check("no UI → no setStatus call", ctx._calls.length === 0);
}

console.log(`\npriority-integration: ${pass}/${pass} checks passed (priority tier surfaces a themed badge)`);
