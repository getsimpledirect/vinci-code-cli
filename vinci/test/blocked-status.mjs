import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = realpathSync(resolve(process.env.VINCI_TEST_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))));
const built = process.env.VINCI_TEST_BUILT === "1";
if (built) {
  console.log(execFileSync(process.execPath, [
    resolve(root, "vinci/scripts/build-source-identity.mjs"), "check", root,
    resolve(root, "vinci/dist/source-identity.json"),
  ], { encoding: "utf8" }).trim());
}
const selectedPath = resolve(root, built ? "vinci/dist/extensions/lib/blocked-status.js" : "vinci/extensions/lib/blocked-status.ts");
const selected = realpathSync(selectedPath);
assert.equal(selected, selectedPath, "load the selected module without fallback");
console.log(`Resolved blocked-status module: ${selected}`);
console.log(`Blocked-status module SHA-256: ${createHash("sha256").update(readFileSync(selected)).digest("hex")}`);
const { vinciBlockedStatusLine } = await import(pathToFileURL(selected).href);

test("existing blocked status spellings remain readable", () => {
  for (const prefix of [
    "Blocked:", "Verification blocked:", "Verification: Blocked—",
    "**Blocked:**", "__Verification blocked__:", "**Verification:** **Blocked**—",
    "*Blocked*:", "_Blocked:_",
  ]) {
    assert.equal(vinciBlockedStatusLine(`${prefix} the sandbox cannot start.`), "Blocked: the sandbox cannot start.", prefix);
  }
  assert.equal(vinciBlockedStatusLine("Read the requested file. The task is complete."), undefined, "read-only completion has no blocker");
});

test("top-level Markdown status headings expose their specific blocker", () => {
  for (const heading of [
    "## Status: blocked by sandbox",
    "# Status: blocked by sandbox",
    "###### Status: blocked by sandbox",
    "   ## Status: blocked by sandbox",
    "## STATUS: BLOCKED by sandbox",
    "## Status: blocked: by sandbox",
    "## Status: blocked—by sandbox",
    "## **Status:** **blocked** by sandbox",
    "## __Status__: _blocked_ by sandbox",
    "## Status: blocked by sandbox ###",
  ]) {
    assert.equal(vinciBlockedStatusLine(heading), "Blocked: by sandbox", `the actual heading must expose its blocker: ${heading}`);
  }
  assert.equal(
    vinciBlockedStatusLine("## Status: blocked by sandbox\nBlocked: a later status."),
    "Blocked: by sandbox",
    "the first explicit status wins",
  );
});

test("quoted, inline, indented and malformed heading examples are excluded", () => {
  for (const example of [
    "> ## Status: blocked by sandbox",
    " > ## Status: blocked by sandbox",
    "`## Status: blocked by sandbox`",
    "An example: ## Status: blocked by sandbox",
    "    ## Status: blocked by sandbox",
    "\t## Status: blocked by sandbox",
    " \t## Status: blocked by sandbox",
    "    Blocked: an indented example.",
    "\tBlocked: an indented example.",
    "####### Status: blocked by sandbox",
    "##Status: blocked by sandbox",
    "## Status: blockedness by sandbox",
    "## Status: blocked",
    "## Status: blocked ###",
    "## **Status: blocked by sandbox",
    "## Status: **blocked by sandbox",
  ]) {
    assert.equal(vinciBlockedStatusLine(example), undefined, `an example must not become task status: ${JSON.stringify(example)}`);
  }
});

test("fences preserve marker and opening length until a valid closing delimiter", () => {
  for (const example of [
    "```text\n## Status: blocked by sandbox\n```",
    "~~~text\n## Status: blocked by sandbox\n~~~",
    "```text\n## Status: blocked by sandbox",
    "~~~\n## Status: blocked by sandbox",
    "````text\n```\n## Status: blocked by sandbox\n````",
    "~~~~\n~~~\n## Status: blocked by sandbox\n~~~~",
    "```text\n~~~\n## Status: blocked by sandbox\n```",
    "~~~text\n```\n## Status: blocked by sandbox\n~~~",
    "```text\n``` trailing text\n## Status: blocked by sandbox\n```",
    "```invalid`info\n## Status: blocked by sandbox\n```",
    "````\n```\nBlocked: a fenced example.\n````",
    "~~~\n```\nBlocked: a fenced example.\n~~~",
  ]) {
    assert.equal(vinciBlockedStatusLine(example), undefined, `fenced content must not become task status: ${JSON.stringify(example)}`);
  }
  for (const [opening, closing] of [["```text", "```"], ["~~~~text", "~~~~~"], ["   ```", "  ```   "]]) {
    assert.equal(
      vinciBlockedStatusLine(`${opening}\nBlocked: a fenced example.\n${closing}\n## Status: blocked by sandbox`),
      "Blocked: by sandbox",
      "a valid matching closing delimiter restores prose",
    );
  }
});
