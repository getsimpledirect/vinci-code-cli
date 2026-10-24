import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateCommitMessage } from "./check-commit-message.mjs";

const temporary = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "commit-message-"));
const checker = fileURLToPath(new URL("./check-commit-message.mjs", import.meta.url));
const hook = fileURLToPath(new URL("../.husky/commit-msg", import.meta.url));

after(() => {
	for (const entry of readdirSync(temporary)) unlinkSync(join(temporary, entry));
	rmdirSync(temporary);
});

test("documented conventional types and Vinci scopes are accepted", () => {
	for (const header of [
		"feat(vinci): improve first use", "fix(worker): retain terminal evidence", "docs: explain releases",
		"refactor(coding-agent): isolate rendering", "test(ai): pin retry behavior", "chore(deps): refresh metadata",
		"ci: check PR titles", "build(release): prepare signed artifacts", "perf(tui): reduce redraws",
		"revert(updater): restore activation behavior", "feat(provider/router)!: change the request contract",
	]) assert.equal(validateCommitMessage(`${header}\n\nA detailed body.`), undefined, header);
});

test("malformed headers fail with an actionable next step", () => {
	for (const header of [
		"", "Vinci Code distribution layer", "feature(vinci): add a feature", "fix(Vinci): change casing",
		"fix(): missing scope", "fix: ", "fix: trailing space ", `fix: ${"x".repeat(100)}`,
		"fix: remove \u{1F600}", "fix (vinci): extra space",
	]) assert.equal(typeof validateCommitMessage(header), "string", header);
});

test("generated Git and autosquash commits stay usable without accepting them as PR titles", () => {
	for (const header of [
		"Merge branch 'topic'", "Merge pull request #1 from owner/topic", "Revert \"fix: original\"",
		"Reapply \"fix: original\"", "fixup! fix(worker): retain output", "squash! feat(vinci): improve output",
		"amend! fix(ai): correct the parser",
	]) {
		assert.equal(validateCommitMessage(header), undefined, header);
		assert.equal(typeof validateCommitMessage(header, { allowGenerated: false }), "string", header);
	}
	assert.equal(typeof validateCommitMessage("fixup! unstructured subject"), "string");
});

test("the real commit-msg hook checks a quoted message-file path", () => {
	const message = join(temporary, "commit message.txt");
	for (const [contents, status] of [["fix(worker): preserve output\n", 0], ["unstructured subject\n", 1]]) {
		writeFileSync(message, contents);
		const result = spawnSync("sh", [hook, message], { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, status, result.stderr);
	}
});

test("the structured event entry reads a PR title without evaluating it", () => {
	const event = join(temporary, "event.json");
	const marker = "commit-convention-must-not-execute";
	for (const [title, status] of [[`fix: $(touch ${marker})`, 0], ["unstructured title", 1], ["fix: valid title\nci: hidden line", 1]]) {
		writeFileSync(event, JSON.stringify({ pull_request: { title } }));
		const result = spawnSync(process.execPath, [checker, "--pull-request-event", event], { cwd: temporary, encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, status, result.stderr);
		assert.equal(existsSync(join(temporary, marker)), false);
	}
	writeFileSync(event, "{}");
	assert.equal(spawnSync(process.execPath, [checker, "--pull-request-event", event], { encoding: "utf8", timeout: 10000 }).status, 1);
	assert.match(readFileSync(hook, "utf8"), /check-commit-message\.mjs "\$1"/);
});
