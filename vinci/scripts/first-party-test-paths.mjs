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
// Both the producer (package-entries.mjs, which writes tar's entry list) and the verifier
// (packaged-artifact-check.mjs, which decides the trusted release surface) import this one
// predicate. Splitting the rule across the two is the pairwise failure this file exists to prevent:
// a producer-only exclusion makes every artifact fail verification as "required by the trusted
// package layout is missing", and a verifier-only exclusion lets the files ship uninspected.
const TEST_DIRECTORY_SEGMENTS = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "specs"]);
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
