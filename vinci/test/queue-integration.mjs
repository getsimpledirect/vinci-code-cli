import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const queue = await loader.import(resolve(here, "../extensions/vinci-queue.ts"), { default: false });

const handlers = {};
const pi = {
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
};
queue.default(pi);

const widgets = [];
const context = {
  hasUI: true,
  ui: {
    setWidget(key, content, options) {
      widgets.push({ key, content, options });
    },
  },
};

for (const handler of handlers.input ?? []) {
  await handler(
    {
      type: "input",
      text: "Please keep the existing API shape too",
      source: "interactive",
      streamingBehavior: "followUp",
    },
    context,
  );
}

const visible = widgets.at(-1);
assert.equal(visible?.key, "vinci-user-queue");
assert.equal(typeof visible?.content, "function");
assert.equal(visible?.options?.placement, "aboveEditor");

const theme = {
  fg(_name, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};
const lines = visible.content({}, theme).render(120);
assert.match(lines.join("\n"), /Queued for Vinci · 1 message/);
assert.match(lines.join("\n"), /after this step/);

for (const handler of handlers.message_start ?? []) {
  await handler(
    {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "Please keep the existing API shape too" }],
        timestamp: Date.now(),
      },
    },
    context,
  );
}

assert.equal(widgets.at(-1)?.content, undefined);
process.stdout.write("  queue integration: submitted messages stay visible until Vinci receives them\n");
