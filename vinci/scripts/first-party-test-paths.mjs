// The single rule behind vinci/package.sh's promise that "tests, docs, infrastructure state, and
// release tooling must never enter the public archive". It is a CLASS rule, deliberately not a list
// of paths: the archive tars first-party directories (vinci/worker, vinci/extensions, packages/*/dist,
// …) wholesale, so any per-path exclusion silently stops covering the next test directory somebody
// adds while still reading as closed. Keying off the shape of the path instead means a first-party
// test file cannot ship without being renamed out of every convention the repository uses.
//
// Scope is first-party only. Paths inside node_modules are governed by the production dependency
// closure (runtime-package-closure.mjs) plus the explicit ssh2/test carve-out; a dependency is
// entitled to ship whatever its own package contents are, and pruning those by name would change
// which bytes of a third-party package the artifact carries.
//
// On this branch the only importer is the producer, package-excludes.mjs, which emits one exclusion
// per matching path into the file package.sh already passes to tar's --exclude-from. The verifier
// here (packaged-artifact-check.mjs) does NOT import it, and does not need to: this producer's
// checker has no closure requirement over first-party roots, so a producer-only rule is complete.
//
// That is worth stating because it is NOT true of every branch. On the entry-list producer the rule
// has to be two-sided -- that checker requires every authority entry under vinci/worker, so a
// producer-only exclusion would make every artifact fail verification as "required by the trusted
// package layout is missing", and a verifier-only exclusion would let the files ship uninspected.
// An earlier version of this comment described that two-sided arrangement while sitting on this
// branch, where it is false: it named package-entries.mjs and packaged-artifact-check.mjs as the
// importers when neither imports it here. A header that asserts a pairwise property the branch does
// not have is the same defect the file exists to prevent, one level up -- so it says what is true
// here, and names the other configuration as the other configuration.
// `fixtures` and `__snapshots__` are near-universal conventions for test DATA, and test data under a
// tarred first-party root ships exactly like test code does. Both were added as HARDENING, not as a
// behaviour change: at the time they were added the repository held no first-party `fixtures` or
// `__snapshots__` path under any root vinci/package.sh tars, and the generated exclude list was
// byte-identical with and without them. They are here so the next such directory is covered the day
// it is created rather than the day somebody notices it in a release.
//
// Adding a segment here is the one edit this file invites. Changing the MATCHING STRUCTURE is not:
// membership is an exact Set.has() on a whole path segment, and the filename rule is an anchored
// pattern. A substring or prefix test in either position would silently match runtime paths — a
// `fixtures` substring rule would take `vinci/extensions/fixtures-loader.mjs` with it — and the
// resulting artifact would be missing a runtime file that no negative test names.
const TEST_DIRECTORY_SEGMENTS = new Set([
	"test",
	"tests",
	"__tests__",
	"__mocks__",
	"spec",
	"specs",
	"fixtures",
	"__snapshots__",
]);
const TEST_FILE_PATTERN = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/;

export function isFirstPartyTestPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "") return false;
  const segments = relativePath.split("/");
  if (segments.includes("node_modules")) return false;
  for (const [index, segment] of segments.entries()) {
    if (TEST_DIRECTORY_SEGMENTS.has(segment.toLowerCase())) return true;
    if (index === segments.length - 1 && TEST_FILE_PATTERN.test(segment.toLowerCase())) return true;
  }
  return false;
}
