import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const queue = await loader.import(resolve(here, "../extensions/vinci-queue.ts"), { default: false });

const theme = {
  fg(_name, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

function harness() {
  const handlers = {};
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
  };
  queue.default(pi);

  const widgets = [];
  // The session is the authority on what is still queued; the widget mirrors it. `pending` stands in
  // for AgentSession.pendingMessageCount, which the session decrements before the extension sees
  // message_start and zeroes outright when the user aborts or pulls the queue back into the editor.
  const context = {
    hasUI: true,
    pending: 0,
    hasPendingMessages: () => context.pending > 0,
    pendingMessageCount: () => context.pending,
    ui: {
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
      },
    },
  };

  const emit = async (name, event) => {
    for (const handler of handlers[name] ?? []) await handler(event, context);
  };

  const submit = async (text, streamingBehavior) => {
    context.pending++;
    await emit("input", { type: "input", text, source: "interactive", streamingBehavior });
  };

  const deliver = async (text) => {
    context.pending--;
    await emit("message_start", {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    });
  };

  const rendered = () => {
    const latest = widgets.at(-1);
    if (!latest?.content) return undefined;
    return latest.content({}, theme).render(120).join("\n");
  };

  return { context, emit, submit, deliver, rendered, widgets };
}

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

{
  const { submit, deliver, rendered, widgets } = harness();
  await submit("Please keep the existing API shape too", "followUp");

  const visible = widgets.at(-1);
  check("the widget is placed above the editor", visible?.key === "vinci-user-queue" && visible?.options?.placement === "aboveEditor");
  check("a submitted message is shown as queued", /Queued for Vinci · 1 message/.test(rendered() ?? ""));
  check("a follow-up says when Vinci will read it", /after this step/.test(rendered() ?? ""));

  await deliver("Please keep the existing API shape too");
  check("the widget clears once Vinci receives the message", rendered() === undefined);
}

// Regression (2026-09-06): the widget matched deliveries by exact text, but the text it recorded at
// `input` is not the text that gets delivered. Later `input` handlers transform it — vinci-guard
// redacts secrets and strips attached image paths — and the session then expands skill commands and
// prompt templates. Every transformed message therefore stayed pinned in the widget forever, which
// is how a live session ended up reading "Queued for Vinci · 4 messages" with nothing left queued.
{
  const { submit, deliver, rendered } = harness();
  const typed = 'Try this: curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrst" https://api.example.com';
  const delivered = 'Try this: curl -H "Authorization: Bearer <vinci-secret>" https://api.example.com';
  await submit(typed, "steer");
  check("the message is queued as typed", /Queued for Vinci · 1 message/.test(rendered() ?? ""));

  await deliver(delivered);
  check("a message redacted on its way to the model still clears the widget", rendered() === undefined);
}

{
  const { submit, deliver, rendered } = harness();
  await submit("/plan ship the worker", "steer");
  await submit("and keep the lease loop", "steer");
  check("both messages are counted", /Queued for Vinci · 2 messages/.test(rendered() ?? ""));

  await deliver("<expanded prompt template for: ship the worker>");
  check("expanding a slash command does not pin the message", /Queued for Vinci · 1 message/.test(rendered() ?? ""));
  check("the remaining preview names the message still waiting", /keep the lease loop/.test(rendered() ?? ""));

  await deliver("and keep the lease loop");
  check("the widget empties after the last delivery", rendered() === undefined);
}

// Aborting, or pressing the dequeue key to pull the queue back into the editor, empties the session
// queue without ever producing a message_start. Nothing would have cleared the widget.
{
  const { context, emit, submit, rendered } = harness();
  await submit("wait, do the other thing first", "steer");
  check("the message is queued before the abort", /Queued for Vinci · 1 message/.test(rendered() ?? ""));

  context.pending = 0;
  await emit("agent_end", { type: "agent_end", messages: [] });
  check("pulling the queue back into the editor clears the widget", rendered() === undefined);
}

{
  const { context, emit, submit, rendered } = harness();
  await submit("keep this one queued", "followUp");
  await emit("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
  check(
    "a turn ending with the message still queued leaves it visible",
    /Queued for Vinci · 1 message/.test(rendered() ?? "") && context.pending === 1,
  );
}

console.log(`\nqueue-integration: ${pass}/${pass} checks passed (submitted messages stay visible until Vinci actually receives them)`);
