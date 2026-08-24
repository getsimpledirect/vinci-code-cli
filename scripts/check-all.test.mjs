import assert from "node:assert/strict";
import test from "node:test";
import { runChecks } from "./check-all.mjs";

test("runChecks runs every check and reports all failures", () => {
	const invoked = [];
	let output = "";
	const checks = [
		{ name: "first", command: "first-command", args: [] },
		{ name: "second", command: "second-command", args: ["arg"] },
		{ name: "third", command: "third-command", args: [] },
	];
	const statuses = [1, 0, 2];

	const exitCode = runChecks(checks, {
		spawn(command, args) {
			invoked.push({ command, args });
			return { status: statuses.shift() };
		},
		output: {
			write(chunk) {
				output += chunk;
			},
		},
	});

	assert.equal(exitCode, 1);
	assert.deepEqual(invoked, [
		{ command: "first-command", args: [] },
		{ command: "second-command", args: ["arg"] },
		{ command: "third-command", args: [] },
	]);
	assert.match(output, /FAIL first \(exit 1\)/);
	assert.match(output, /PASS second \(exit 0\)/);
	assert.match(output, /FAIL third \(exit 2\)/);
});
