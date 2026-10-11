import assert from "node:assert/strict";
import test from "node:test";
import { isAllowlisted, loadTokenPatterns, scanText } from "./check-secrets.mjs";

// The pre-commit scanner's detection set is DERIVED from TOKEN_PATTERNS (see check-secrets.mjs),
// so a shape added to the masker must land here too — and this file proves it, per shape, down to
// the pattern that carries it. Fixture tokens are built by RUNTIME CONCATENATION: the committed
// source never contains a contiguous key shape (the concatenation breaks the pattern), and no
// live-looking key is committed. Where a literal marker is needed for the allowlist checks it is
// the repo's own TESTONLY convention.
const SHAPES = [
	["Replicate r8_", "r8_" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV5wX6"],
	["PyPI upload pypi-", "pypi-" + "AgEIcHlwaS5vcmc" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9s"],
	["Google OAuth ya29.", "ya29." + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV5wX6"],
	["Together tgp_v1_", "tgp_v1_" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV5"],
];

function matchingPatternIndices(token) {
	return loadTokenPatterns()
		.map((pattern, index) => (pattern.test(token) ? index : -1))
		.filter((index) => index >= 0);
}

test("each new credential shape is caught by a load-bearing derived pattern", () => {
	for (const [name, token] of SHAPES) {
		const indices = matchingPatternIndices(token);
		assert.ok(indices.length >= 1, `${name}: no derived pattern matches the shape`);
		// Discrimination: disabling exactly the matching pattern must un-catch the shape — that is
		// what makes THIS pattern (not a neighboring one) the load-bearing detector.
		for (const index of indices) {
			process.env.CHECK_SECRETS_DISABLE_PATTERN = String(index);
			try {
				const remaining = matchingPatternIndices(token);
				assert.deepEqual(
					remaining,
					indices.filter((candidate) => candidate !== index),
					`${name}: disabling pattern ${index} did not un-catch the shape`,
				);
			} finally {
				delete process.env.CHECK_SECRETS_DISABLE_PATTERN;
			}
		}
	}
});

test("the scanner catches an unmarked leak line carrying each new shape", () => {
	for (const [name, token] of SHAPES) {
		const line = `command failed with token=${token} in the output`;
		assert.ok(!isAllowlisted(line), `${name}: the fixture line must not be allowlisted by accident`);
		const hits = scanText(line);
		assert.equal(hits.length, 1, `${name}: an unmarked leak line must be flagged`);
		assert.equal(hits[0].line, 1);
	}
});

test("a TESTONLY-marked fixture line stays allowlisted (the repo's test-vector convention)", () => {
	for (const [name, token] of SHAPES) {
		const marked = `test fixture token=${token.slice(0, 5)}TESTONLY${token.slice(5)} end`;
		assert.ok(isAllowlisted(marked), `${name}: the TESTONLY marker must allowlist the line`);
		assert.deepEqual(scanText(marked), [], `${name}: a TESTONLY line must not be flagged`);
	}
});

test("benign prose look-alikes are not flagged through the full scan pipeline", () => {
	for (const line of [
		"add the pypi-requirements extra to the test dependencies",
		"the pypi-package-manager-tooling flag is long but it is prose",
		"the r8_ prefix identifies Replicate tokens",
		"the ya29. prefix identifies Google access tokens",
		"the tgp_v1_ prefix identifies Together tokens",
		`short prefix run: r8_${"aB1cD2eF3"} and tgp_v1_${"aB1cD2eF3"} stay plain words`,
	]) {
		assert.deepEqual(scanText(line), [], `benign line flagged: ${line}`);
	}
});

test("an invalid CHECK_SECRETS_DISABLE_PATTERN value refuses rather than scanning stale", () => {
	process.env.CHECK_SECRETS_DISABLE_PATTERN = "not-a-number";
	try {
		assert.throws(() => loadTokenPatterns(), /not a valid pattern index/);
	} finally {
		delete process.env.CHECK_SECRETS_DISABLE_PATTERN;
	}
});
