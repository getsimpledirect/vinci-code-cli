import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "vinci-feedback-"));
const previousVinciHome = process.env.VINCI_HOME;
const previousBaseUrl = process.env.VINCI_BASE_URL;
process.env.VINCI_HOME = join(temporary, "vinci-home");
process.env.VINCI_BASE_URL = "https://feedback.example/api/v1";

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const feedbackExtension = await loader.import(resolve(root, "vinci/extensions/vinci-feedback.ts"), {
  default: true,
});

let command;
feedbackExtension({
  registerCommand(name, options) {
    assert.equal(name, "feedback");
    command = options;
  },
});
assert.equal(typeof command?.handler, "function");

const plantedSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
const transcriptOnly = "TRANSCRIPT-ONLY-PRIVACY-GUARD";

function messageEntry(id, role, content) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-07-20T12:00:00.000Z",
    message: { role, content, timestamp: 1 },
  };
}

function makeContext({ description, confirm = true, email = "", notifications = [], confirmations = [] }) {
  const branch = [
    { type: "custom", id: "ignored", parentId: null, timestamp: "2026-07-20T11:59:00.000Z" },
    messageEntry("user", "user", `${transcriptOnly} api_key=${plantedSecret}`),
    messageEntry("assistant", "assistant", [{ type: "text", text: "assistant reply" }]),
  ];
  return {
    mode: "tui",
    ui: {
      async select(title, options) {
        assert.equal(title, "What went wrong?");
        assert.deepEqual(options, [
          "claimed done but wasn't",
          "got stuck / looped",
          "wrong result",
          "confusing",
          "other",
        ]);
        return options[0];
      },
      async editor(title, prefill) {
        assert.equal(title, "Describe what went wrong");
        assert.equal(prefill, "");
        return description;
      },
      async confirm(title, message) {
        confirmations.push({ title, message });
        return confirm;
      },
      async input(title) {
        assert.equal(title, "Email for a reply (optional)");
        return email;
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getBranch() {
        return branch;
      },
      getSessionId() {
        return "feedback-session";
      },
    },
  };
}

function reportFiles() {
  const directory = join(process.env.VINCI_HOME, "feedback");
  return existsSync(directory) ? readdirSync(directory).map((name) => join(directory, name)) : [];
}

const originalFetch = globalThis.fetch;
try {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };

  const confirmations = [];
  await command.handler(
    "",
    makeContext({
      description: `The agent exposed api_key=${plantedSecret} and claimed success.`,
      email: "person@example.com",
      confirmations,
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://feedback.example/api/feedback");
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["kind", "message", "replyTo"]);
  assert.equal(sent[0].body.kind, "vinci-code");
  assert.equal(sent[0].body.replyTo, "person@example.com");
  assert.doesNotMatch(sent[0].body.message, new RegExp(plantedSecret));
  assert.doesNotMatch(sent[0].body.message, new RegExp(transcriptOnly));
  assert.equal(confirmations[0].title, "check this before sending");
  assert.match(confirmations[0].message, /This is exactly what will be sent:/);
  assert.match(confirmations[0].message, /transcript stays on your machine at /);
  assert.equal(
    confirmations[0].message.match(/^This is exactly what will be sent:\n\n([\s\S]*)\n\ntranscript stays on your machine at /)?.[1],
    sent[0].body.message,
  );

  const firstReport = reportFiles()[0];
  assert.ok(firstReport);
  const localReport = readFileSync(firstReport, "utf8");
  assert.doesNotMatch(localReport, new RegExp(plantedSecret));
  assert.match(localReport, new RegExp(transcriptOnly));

  await command.handler("", makeContext({ description: "x".repeat(8_000) }));
  assert.equal(sent.length, 2);
  assert.ok(sent[1].body.message.length < 4_000, `message length was ${sent[1].body.message.length}`);

  const failedNotifications = [];
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const reportsBeforeFailure = reportFiles().length;
  await assert.doesNotReject(
    command.handler("", makeContext({ description: "Network failure case", notifications: failedNotifications })),
  );
  assert.equal(reportFiles().length, reportsBeforeFailure + 1);
  assert.match(failedNotifications.at(-1)?.message ?? "", /^could not send, report saved at /);

  let emptyDescriptionFetches = 0;
  globalThis.fetch = async () => {
    emptyDescriptionFetches++;
    return { ok: true, status: 200 };
  };
  const reportsBeforeAbort = reportFiles().length;
  await command.handler("", makeContext({ description: "   " }));
  assert.equal(emptyDescriptionFetches, 0);
  assert.equal(reportFiles().length, reportsBeforeAbort);

  console.log("  feedback integration: 5 privacy, truncation, failure, and abort checks passed");
} finally {
  globalThis.fetch = originalFetch;
  if (previousVinciHome === undefined) delete process.env.VINCI_HOME;
  else process.env.VINCI_HOME = previousVinciHome;
  if (previousBaseUrl === undefined) delete process.env.VINCI_BASE_URL;
  else process.env.VINCI_BASE_URL = previousBaseUrl;
  rmSync(temporary, { recursive: true, force: true });
}
