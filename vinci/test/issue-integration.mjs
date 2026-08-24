/**
 * `/issue` — the PUBLIC tracker path.
 *
 * The invariant worth protecting: Vinci composes and opens, it never posts, and the conversation is
 * never attached. Everything else is convenience.
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const issueUrl = await loader.import(resolve(here, "../extensions/lib/issue-url.ts"), { default: false });
const issueExt = await loader.import(resolve(here, "../extensions/vinci-issue.ts"), { default: false });

let passed = 0;
const ok = () => {
  passed += 1;
};

const REPO = "https://github.com/getsimpledirect/vinci-code-releases";

// A bug routes to the bug form with its own field ids; a feature routes to the feature form.
{
  const bug = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "Tests reported as passing",
    body: "It said the tests passed but they never ran.",
    version: "0.0.35",
    os: "macOS",
  });
  const parsed = new URL(bug);
  assert.equal(parsed.origin + parsed.pathname, `${REPO}/issues/new`);
  assert.equal(parsed.searchParams.get("template"), "bug.yml");
  assert.equal(parsed.searchParams.get("what-happened"), "It said the tests passed but they never ran.");
  assert.equal(parsed.searchParams.get("version"), "0.0.35");
  assert.equal(parsed.searchParams.get("os"), "macOS");

  const feature = issueUrl.buildIssueUrl(REPO, {
    kind: "feature",
    title: "Copy without selecting",
    body: "Selecting long output in my terminal is awkward.",
    version: "0.0.35",
    os: "Linux",
  });
  const featureParams = new URL(feature).searchParams;
  assert.equal(featureParams.get("template"), "feature.yml");
  assert.equal(featureParams.get("problem"), "Selecting long output in my terminal is awkward.");
  assert.equal(featureParams.get("what-happened"), null, "the feature form has no what-happened field");
  ok();
}

// A very long report is trimmed to fit GitHub's URL ceiling, and says so rather than truncating
// silently — the user finishes it in the browser.
{
  const url = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "Long one",
    body: "x".repeat(50_000),
    version: "0.0.35",
    os: "macOS",
  });
  assert.ok(url.length <= issueUrl.ISSUE_URL_LIMIT, `url must fit the limit, got ${url.length}`);
  const body = new URL(url).searchParams.get("what-happened");
  assert.match(body, /trimmed — add the rest in the browser/, "the trim must be visible to the user");
  assert.ok(body.length > 1000, "trimming should keep as much as fits, not collapse the report");
  ok();
}

// Regression: only the body used to be trimmed, so a long title pushed the URL past the ceiling no
// matter how far the body shrank — and the over-long URL was returned anyway.
{
  const url = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "T".repeat(9000),
    body: "short",
    version: "0.0.35",
    os: "macOS",
  });
  assert.ok(url.length <= issueUrl.ISSUE_URL_LIMIT, `a long title must still fit, got ${url.length}`);
  const title = new URL(url).searchParams.get("title");
  assert.ok(title.length <= issueUrl.ISSUE_TITLE_LIMIT, "the title is capped to one line");
  assert.match(title, /…$/, "a capped title says it was cut");
  assert.equal(new URL(url).searchParams.get("what-happened"), "short", "the body is not sacrificed for a long title");
  ok();
}

// Regression: trimming sliced by UTF-16 unit, so cutting an emoji in half left a lone surrogate
// that renders as a replacement character — in a public issue title.
{
  const longTitle = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "🎉".repeat(200),
    body: "b",
    version: "0.0.35",
    os: "macOS",
  });
  const longBody = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "t",
    body: "🎉".repeat(5000),
    version: "0.0.35",
    os: "macOS",
  });
  assert.doesNotMatch(new URL(longTitle).searchParams.get("title"), /�/, "a trimmed title keeps whole characters");
  assert.doesNotMatch(
    new URL(longBody).searchParams.get("what-happened"),
    /�/,
    "a trimmed body keeps whole characters",
  );
  assert.ok(longTitle.length <= issueUrl.ISSUE_URL_LIMIT && longBody.length <= issueUrl.ISSUE_URL_LIMIT);
  ok();
}

// Non-ASCII content survives the round trip intact.
{
  const url = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "emoji 🎉 accents éàü",
    body: "日本語のテキスト",
    version: "0.0.35",
    os: "macOS",
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("title"), "emoji 🎉 accents éàü");
  assert.equal(params.get("what-happened"), "日本語のテキスト");
  ok();
}

// A body that already fits is passed through untouched.
{
  const url = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: "Short",
    body: "Just this.",
    version: "0.0.35",
    os: "macOS",
  });
  assert.equal(new URL(url).searchParams.get("what-happened"), "Just this.");
  ok();
}

// Characters that would break a hand-built query string survive the round trip.
{
  const nasty = 'crash on `git commit -m "a&b"` — 100% repro, see #12 + ?x=1';
  const url = issueUrl.buildIssueUrl(REPO, {
    kind: "bug",
    title: nasty,
    body: nasty,
    version: "0.0.35",
    os: "macOS",
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("title"), nasty, "ampersands, quotes and hashes must not corrupt the form");
  assert.equal(params.get("what-happened"), nasty);
  ok();
}

// Platform mapping matches the dropdown values in bug.yml.
{
  assert.equal(issueUrl.osLabel("darwin"), "macOS");
  assert.equal(issueUrl.osLabel("linux"), "Linux");
  assert.equal(issueUrl.osLabel("win32"), "Windows (WSL)");
  assert.equal(issueUrl.osLabel("freebsd"), "Other");
  ok();
}

// The preview shows the issue as text, and never carries the transcript.
{
  const preview = issueUrl.issuePreview({
    kind: "bug",
    title: "Tests reported as passing",
    body: "It said the tests passed.",
    version: "0.0.35",
    os: "macOS",
  });
  assert.match(preview, /Title: Tests reported as passing/);
  assert.match(preview, /Vinci Code 0\.0\.35 · macOS/);
  ok();
}

// ── The command itself ──────────────────────────────────────────────────────────────────────────

// The opener is injected so this suite never launches a real browser.
const opened = [];
function issueCommand() {
  const commands = {};
  issueExt.default({ on: () => {}, registerTool: () => {}, registerCommand: (name, def) => (commands[name] = def) }, (url) =>
    opened.push(url),
  );
  return commands.issue;
}

function ctxFor({ kind = "Something is broken", title = "It broke", body = "Here is what happened.", confirm = true } = {}) {
  const seen = { notified: [], confirmPrompt: "", editorPrompt: "" };
  return {
    seen,
    ctx: {
      mode: "tui",
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: {
        select: async () => kind,
        input: async () => title,
        editor: async (prompt) => {
          seen.editorPrompt = prompt;
          return body;
        },
        confirm: async (_heading, message) => {
          seen.confirmPrompt = message;
          return confirm;
        },
        notify: (message) => seen.notified.push(message),
      },
    },
  };
}

// The confirmation states plainly that this is public and that the conversation is not attached.
{
  opened.length = 0;
  const harness = ctxFor({});
  await issueCommand().handler("", harness.ctx);
  assert.match(harness.seen.confirmPrompt, /conversation is NOT attached/i);
  assert.match(harness.seen.confirmPrompt, /nothing is posted until you press Submit/i);
  assert.equal(opened.length, 1, "a confirmed issue opens the prefilled form");
  assert.equal(harness.seen.notified.length, 1, "the URL is surfaced in case the browser did not open");
  assert.match(harness.seen.notified[0], /issues\/new\?/);
  ok();
}

// Declining the confirmation opens nothing and says nothing.
{
  opened.length = 0;
  const harness = ctxFor({ confirm: false });
  await issueCommand().handler("", harness.ctx);
  assert.equal(opened.length, 0, "declining must not open a browser");
  assert.equal(harness.seen.notified.length, 0, "declining must not report success");
  ok();
}

// A feature request asks the feature question, not the bug one.
{
  const harness = ctxFor({ kind: "Something is missing" });
  await issueCommand().handler("", harness.ctx);
  assert.match(harness.seen.editorPrompt, /What were you trying to do/);
  assert.match(harness.seen.notified[0], /template=feature\.yml/);
  ok();
}

// Secrets pasted into the report are redacted before they can reach a public form.
{
  const harness = ctxFor({ body: "it failed with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL" });
  await issueCommand().handler("", harness.ctx);
  const sent = harness.seen.notified[0];
  assert.ok(
    !sent.includes("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL"),
    "an API key must never survive into the issue URL",
  );
  ok();
}

// Backing out at any prompt is silent — an empty title or body files nothing.
{
  for (const abort of [{ title: "" }, { body: "" }]) {
    opened.length = 0;
    const harness = ctxFor(abort);
    await issueCommand().handler("", harness.ctx);
    assert.equal(opened.length, 0, `aborting with ${JSON.stringify(abort)} must open nothing`);
    assert.equal(harness.seen.notified.length, 0, `aborting with ${JSON.stringify(abort)} must file nothing`);
  }
  ok();
}

process.stdout.write(`  issue command: ${passed}/${passed} passed (composes and opens, never posts, no transcript)\n`);
