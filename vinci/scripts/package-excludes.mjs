import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isFirstPartyTestPath } from "./first-party-test-paths.mjs";

const root = process.argv[2];
if (!root) {
	throw new Error("Usage: package-excludes.mjs <repository-root>");
}

const tree = JSON.parse(
	execFileSync("npm", ["ls", "--omit=dev", "--json", "--depth=0"], {
		cwd: root,
		encoding: "utf8",
	}),
);

for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
	if (dependency && typeof dependency === "object" && dependency.extraneous === true) {
		process.stdout.write(`node_modules/${name}\n`);
	}
}

// vinci/package.sh promises that "tests, docs, infrastructure state, and release tooling must never
// enter the public archive", and then tars first-party directories WHOLESALE (`vinci/bin
// vinci/extensions vinci/themes vinci/assets vinci/updater`, `packages/*/dist`, and — once #50 lands —
// `vinci/worker`). Nothing in the tar invocation implemented the test half of that promise: its only
// test-shaped exclusion is the hardcoded `node_modules/ssh2/test` carve-out, which is about a
// dependency's own contents and says nothing about first-party trees. So the comment asserted a rule
// the producer did not enforce, and #49 has already put vinci/worker/test/*.test.mjs in the repo.
//
// This walk closes that gap by DISCOVERING the offending paths rather than listing them. Two
// properties matter and both are deliberate:
//
//   1. It keys off path SHAPE via the shared predicate, never off a per-path enumeration such as
//      `relativePath === "vinci/worker/test"`. A per-path rule stops covering the next test directory
//      somebody adds while still reading as closed — that is the failure mode this file exists to
//      avoid, and the mutation test in vinci/test/package-first-party-tests.mjs pins it.
//   2. It walks the repository, not package.sh's tar path list. The exclusion file therefore already
//      covers a first-party root the moment it is added to that list, so PR #50 can add `vinci/worker`
//      with no change here and no change to package.sh. Patterns that match nothing are inert for both
//      bsdtar and GNU tar, which is what makes over-emitting safe.
//
// Scope stays first-party: isFirstPartyTestPath returns false under node_modules, and the walk skips
// node_modules outright, so a dependency still ships exactly the bytes its own package contains.
function collectFirstPartyTestPaths(repositoryRoot) {
	const found = [];
	const walk = (relativeDirectory) => {
		let entries;
		try {
			entries = readdirSync(join(repositoryRoot, relativeDirectory), { withFileTypes: true });
		} catch {
			return; // unreadable directory: nothing to exclude from it
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			// node_modules is governed by the production dependency closure above plus the explicit
			// ssh2/test carve-out. Dot-directories (.git, .github, .vinci) are never in the tar list.
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
			if (isFirstPartyTestPath(relativePath)) {
				// Emit the match and stop descending: both tars drop a matched directory with its whole
				// subtree, so its children would only add redundant lines.
				found.push(relativePath);
				continue;
			}
			// Dirents report a symlink as a symlink, not a directory, so this never follows one out of
			// the tree or into a node_modules workspace link.
			if (entry.isDirectory()) walk(relativePath);
		}
	};
	walk("");
	return found;
}

// tar reads --exclude-from lines as GLOBS. A literal path containing a glob metacharacter would be
// matched as a pattern and could therefore match NOTHING — the test file would ship, silently, which
// is the exact outcome this producer exists to prevent. There is no escaping form both bsdtar and GNU
// tar accept, so fail the build loudly instead of shipping a hole.
const GLOB_METACHARACTER = /[*?[\]\\]/;
const firstPartyTestPaths = collectFirstPartyTestPaths(root);
const unquotable = firstPartyTestPaths.filter((relativePath) => GLOB_METACHARACTER.test(relativePath));
if (unquotable.length > 0) {
	throw new Error(
		`first-party test path contains a glob metacharacter and cannot be excluded safely:\n  ${unquotable.join("\n  ")}`,
	);
}
for (const relativePath of firstPartyTestPaths) {
	process.stdout.write(`${relativePath}\n`);
}
