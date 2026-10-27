import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": resolve(root, "packages/tui/src/index.ts") },
  moduleCache: false,
  tryNative: false,
});
const accept = await loader.import(resolve(root, "vinci/extensions/vinci-accept.ts"), { default: false });
let tool;
accept.default({ registerTool(value) { tool = value; } });

// These literal expectations characterize the renderer at 1db46f35, independently of its helpers.
const passed = ["Acceptance verification passed.", "success", "  └ ✓ "];
const failed = ["Verification failed; no acceptance pass recorded.", "error", "  └ ! "];
const conditional = ["Verification completed conditionally; no acceptance pass recorded.", "text", "  └ "];
const skipped = ["Verification skipped; no acceptance pass recorded.", "text", "  └ "];
const progress = ["Verification in progress; no pass recorded.", "text", "  └ "];
const setup = ["Verification isn't set up yet. Install the Vinci Acceptance CLI, then run vinci verify again.", "text", "  └ "];
const recorded = { exitCode: 0, latchRecorded: true };
const cases = [
  { name: "VERIFIED_PASS recorded at exit 0", status: "VERIFIED_PASS", expected: passed },
  { name: "BLOCKED", status: "BLOCKED", expected: failed },
  { name: "FAILED", status: "FAILED", expected: failed },
  { name: "CONDITIONAL", status: "CONDITIONAL", expected: conditional },
  { name: "CANCELLED", status: "CANCELLED", expected: skipped },
  { name: "RUNNING", status: "RUNNING", expected: progress },
  { name: "QUEUED", status: "QUEUED", expected: progress },
  { name: "exitCode 127 overrides a pass", status: "VERIFIED_PASS", details: { ...recorded, exitCode: 127 }, expected: setup },
  { name: "exitCode 1 overrides a pass", status: "VERIFIED_PASS", details: { ...recorded, exitCode: 1 }, expected: failed },
  { name: "isPartial overrides a pass", status: "VERIFIED_PASS", isPartial: true, expected: progress },
  { name: "isError overrides a pass", status: "VERIFIED_PASS", isError: true, expected: failed },
  { name: "unparseable text", text: "not JSON", expected: skipped },
  { name: "unrecorded pass", status: "VERIFIED_PASS", details: { ...recorded, latchRecorded: false }, expected: skipped },
  { name: "pass without details", status: "VERIFIED_PASS", details: undefined, expected: skipped },
  { name: "pass without exit code", status: "VERIFIED_PASS", details: { latchRecorded: true }, expected: skipped },
  { name: "truthy latch is not recorded", status: "VERIFIED_PASS", details: { ...recorded, latchRecorded: 1 }, expected: skipped },
  { name: "string exit code is not zero", status: "VERIFIED_PASS", details: { ...recorded, exitCode: "0" }, expected: skipped },
  { name: "partial BLOCKED", status: "BLOCKED", isPartial: true, expected: progress },
  { name: "partial FAILED with error", status: "FAILED", isPartial: true, isError: true, expected: progress },
  { name: "CONDITIONAL with error", status: "CONDITIONAL", isError: true, expected: failed },
  { name: "CANCELLED with nonzero exit", status: "CANCELLED", details: { ...recorded, exitCode: 1 }, expected: failed },
  // In-progress copy wins over failure copy, but keeps the failure colour and marker.
  { name: "RUNNING with error", status: "RUNNING", isError: true, expected: [progress[0], "error", "  └ ! "] },
  { name: "QUEUED with nonzero exit", status: "QUEUED", details: { ...recorded, exitCode: 1 }, expected: [progress[0], "error", "  └ ! "] },
  { name: "setup overrides partial and error", status: "FAILED", details: { ...recorded, exitCode: 127 }, isPartial: true, isError: true, expected: setup },
  { name: "setup suppresses verdict failure", status: "BLOCKED", details: { ...recorded, exitCode: 127 }, isError: true, expected: setup },
  { name: "unparseable text with error", text: "not JSON", isError: true, expected: failed },
  { name: "empty text", text: "", expected: skipped },
  { name: "null JSON", text: "null", expected: skipped },
  { name: "nonstring status", status: 1, expected: skipped },
  { name: "unknown status", status: "UNKNOWN", expected: skipped },
  { name: "nontext content is ignored", text: "not JSON", extraContent: [{ type: "image" }], expected: skipped },
  { name: "text parts are joined with a newline", content: [{ type: "text", text: '{"status":' }, { type: "text", text: '"VERIFIED_PASS"}' }], text: '{"status":\n"VERIFIED_PASS"}', expected: passed },
];

for (const fixture of cases) {
  test(`accept renderResult: ${fixture.name}`, () => {
    const text = fixture.text ?? JSON.stringify({ status: fixture.status });
    const details = Object.hasOwn(fixture, "details") ? fixture.details : recorded;
    const [label, color, marker] = fixture.expected;
    for (const expanded of [false, true]) {
      const calls = [];
      const widget = tool.renderResult({
        content: fixture.content ?? [...(fixture.extraContent ?? []), { type: "text", text }],
        details,
      }, { expanded, isPartial: fixture.isPartial ?? false }, {
        fg(actualColor, actualText) { calls.push({ color: actualColor, text: actualText }); return actualText; },
      }, { isError: fixture.isError ?? false });
      assert.equal(calls.length, 1, "one foreground application");
      const actual = calls[0];
      assert.equal(actual.color, color, "colour");
      const actualMarker = actual.text.match(/^  └ (?:[✓!] )?/)[0];
      assert.equal(actualMarker, marker, "marker");
      assert.equal(actual.text.slice(actualMarker.length).split("\n")[0], label, "label");
      const expectedText = marker + label + (expanded && text ? `\n${text}` : "");
      assert.equal(actual.text, expectedText, "exact foreground text including expanded content");
      assert.equal(widget.render(1000).map((line) => line.trimEnd()).join("\n"), expectedText, "Text widget bytes");
    }
  });
}
