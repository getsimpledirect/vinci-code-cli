#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMIT_TYPES = Object.freeze([
	"feat", "fix", "docs", "refactor", "test", "chore", "ci", "build", "perf", "revert",
]);

export function validateCommitMessage(message, { allowGenerated = true } = {}) {
	if (!allowGenerated && /[\r\n]/.test(message)) return "Keep the pull request title on one line.";
	const original = message.trimStart().split(/\r?\n/, 1)[0];
	if (allowGenerated && /^(?:Merge (?:branch|remote-tracking branch|pull request|tag) |(?:Revert|Reapply) ")/.test(original)) return;
	const header = allowGenerated ? original.replace(/^(?:(?:fixup|squash|amend)! )+/, "") : original;
	const match = /^([a-z]+)(?:\(([a-z0-9]+(?:[/-][a-z0-9]+)*)\))?!?: (\S(?:.*\S)?)$/.exec(header);
	if (!match || !COMMIT_TYPES.includes(match[1])) {
		return "Use type(scope): description with a documented type and an optional lowercase area scope.";
	}
	if ([...header].length > 100) return "Shorten the commit header to at most 100 characters.";
	if (/\p{Extended_Pictographic}/u.test(header)) return "Remove emojis from the commit header.";
}

export function checkCommitMessage(args) {
	try {
		const pullRequest = args[0] === "--pull-request-event";
		const path = pullRequest ? args[1] : args[0];
		if (!path || args.length !== (pullRequest ? 2 : 1)) {
			throw new Error("Pass a commit message file or --pull-request-event <event.json>.");
		}
		const contents = readFileSync(path, "utf8");
		const message = pullRequest ? JSON.parse(contents).pull_request?.title : contents;
		if (typeof message !== "string") throw new Error("Supply an event containing pull_request.title.");
		const error = validateCommitMessage(message, { allowGenerated: !pullRequest });
		if (error) throw new Error(error);
		return 0;
	} catch (error) {
		console.error(`Commit convention check failed: ${error.message} Correct the input and retry the check.`);
		return 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = checkCommitMessage(process.argv.slice(2));
}
