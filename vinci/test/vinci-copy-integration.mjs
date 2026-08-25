import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const copy = await loader.import(resolve(here, "../extensions/vinci-copy.ts"), { default: false });

assert.equal(
  copy.stripAnsiSequences("\u001b[31mred\u001b[0m \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"),
  "red link",
  "ANSI styling and OSC hyperlinks must be removed",
);

// Regression: the control-character sweep must not eat \x09. Tab-indented code is exactly what
// this feature exists to copy, and stripping tabs silently flattens every line to column zero.
assert.equal(
  copy.stripAnsiSequences("function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}"),
  "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}",
  "tab indentation must survive ANSI stripping",
);

assert.equal(
  copy.extractLastCodeBlock("First:\n```js\nconst first = 1;\n```\n\nLast:\n~~~ts\nconst last = 2;\n~~~"),
  "const last = 2;",
  "the final fenced code block must be extracted without its fence",
);

const choices = copy.copyChoices([
  { role: "assistant", content: [{ type: "text", text: "\u001b[32mEarlier\u001b[0m" }] },
  { role: "toolResult", content: [{ type: "text", text: "\u001b[31mtool output\u001b[0m" }] },
  {
    role: "assistant",
    content: [{ type: "text", text: "Latest answer\n```ts\n\u001b[36mconst clean = true;\u001b[0m\n```" }],
  },
]);
assert.deepEqual(
  choices.map((choice) => choice.label),
  ["Vinci's last message", "Last code block", "Last tool output"],
);
assert.ok(choices.every((choice) => !choice.text.includes("\u001b")), "every copy choice must be ANSI stripped");

function createHarness({ messages = [], selection } = {}) {
  const handlers = {};
  const commands = {};
  const copied = [];
  copy.default(
    {
      on(name, handler) {
        (handlers[name] ??= []).push(handler);
      },
      registerCommand(name, definition) {
        commands[name] = definition;
      },
    },
    async (text) => {
      copied.push(text);
    },
  );

  const widgets = [];
  const notifications = [];
  const context = {
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getBranch() {
        return messages.map((message) => ({ type: "message", message }));
      },
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      onTerminalInput() {
        return () => {};
      },
      select() {
        return selection;
      },
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
      },
    },
  };
  return { commands, context, copied, handlers, notifications, widgets };
}

const first = createHarness();
await first.handlers.session_start[0]({ type: "session_start", reason: "startup" }, first.context);
const codeMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Here it is:\n```ts\nconst answer = 42;\n```" }],
};
await first.handlers.message_end[0]({ type: "message_end", message: codeMessage }, first.context);
await first.handlers.message_end[0]({ type: "message_end", message: codeMessage }, first.context);
const visibleHints = first.widgets.filter((widget) => typeof widget.content === "function");
assert.equal(visibleHints.length, 1, "the /copy hint must appear at most once per session");
const theme = {
  fg(_name, text) {
    return text;
  },
};
assert.match(visibleHints[0].content({}, theme).render(120)[0], /\/copy/);

const used = createHarness();
await used.handlers.session_start[0]({ type: "session_start", reason: "startup" }, used.context);
await used.commands.copy.handler("", used.context);
await used.handlers.message_end[0]({ type: "message_end", message: codeMessage }, used.context);
assert.equal(
  used.widgets.filter((widget) => typeof widget.content === "function").length,
  0,
  "using /copy before the first code block must suppress the hint",
);
assert.match(used.notifications[0].message, /Nothing from Vinci is ready to copy yet/);

const withContent = createHarness({
  messages: [{ role: "toolResult", content: [{ type: "text", text: "\u001b[35mready output\u001b[0m" }] }],
  selection: "Last tool output",
});
await withContent.commands.copy.handler("", withContent.context);
assert.deepEqual(withContent.copied, ["ready output"], "/copy must send the selected ANSI-stripped text to the clipboard");
assert.match(withContent.notifications[0].message, /Copied last tool output/);

console.log("vinci-copy-integration: 7/7 passed");
