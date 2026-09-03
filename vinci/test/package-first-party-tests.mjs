#!/usr/bin/env node
// vinci/package.sh promises, in a comment above its tar invocation, that "tests, docs, infrastructure
// state, and release tooling must never enter the public archive". Until this test the exclude-list
// producer did not implement the test half of that promise: its only test-shaped exclusion was the
// hardcoded `node_modules/ssh2/test` carve-out, which governs a DEPENDENCY's own contents. First-party
// trees are tarred wholesale, so any first-party test path under a tarred root shipped.
//
// WHAT THIS ASSERTS: the CONTENTS OF A REAL TARBALL built by the real producer (`bash vinci/package.sh`),
// never the exclusion mechanism. A test that asserted the mechanism — "the excludes file contains line
// X", "tar was invoked with flag Y" — would pass on the exclude-list producer and invert on the
// entry-list producer in PR #48, because those two build the member set from opposite directions. Only
// the artifact is common to both, so only the artifact is asserted here.
//
// MUTATION THIS TEST IS BUILT TO CATCH (verified by running it):
//   Replacing the shape predicate call in vinci/scripts/package-excludes.mjs
//       isFirstPartyTestPath(relativePath)
//   with the per-path enumeration
//       relativePath === "vinci/worker/test"
//   MUST fail this test, by name, on these checks:
//       "planted first-party test path is absent from the archive: vinci/updater/__tests__/…"
//       "planted first-party test path is absent from the archive: vinci/extensions/…"
//       "planted first-party test path is absent from the archive: vinci/themes/specs/…"
//   The per-path form still excludes vinci/worker/test, so the #50 checks below would stay green while
//   every other first-party root silently regressed. That asymmetry is the whole reason the rule keys
//   off path SHAPE, and it is why the planted probes live under roots the tar list ALREADY carries.
//
// Usage:  node vinci/test/package-first-party-tests.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isFirstPartyTestPath } from "../scripts/first-party-test-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "vinci", "identity.json"), "utf8")).version;

let pass = 0;
function check(label, condition) {
	assert.equal(condition, true, label);
	pass += 1;
	console.log(`  ✓ ${label}`);
}

// Probes are planted under roots vinci/package.sh ALREADY tars on main, so this negative control runs
// against today's producer rather than a hypothetical one. Five shapes, so a partial rule cannot pass:
// a __tests__ directory segment, a *.test.* basename with no test directory above it, a `specs`
// directory holding a non-JavaScript file (which only the directory-segment half of the rule catches),
// and one probe for each of the two segments added later — `fixtures` and `__snapshots__`. Both of
// those carry non-JavaScript extensions on purpose: the filename half of the rule cannot see them, so
// only the directory-segment half can, and a probe the filename rule could also catch would pass even
// if its segment were never added to the Set.
const probes = [
	"vinci/updater/__tests__/ws-c3-probe.test.mjs",
	"vinci/extensions/ws-c3-probe.test.mjs",
	"vinci/themes/specs/ws-c3-probe.json",
	"vinci/updater/fixtures/ws-c4-probe.json",
	"vinci/extensions/__snapshots__/ws-c4-probe.snap",
];
// Runtime files under those same roots. If the exclusion ever widened from "test paths" to "the root",
// these disappear too, and the positive control below catches it.
const runtimeWitnesses = ["vinci/bin/vinci", "vinci/identity.json", "package.json"];

// POSITIVE control probes: runtime-shaped paths that a LOOSER rule would swallow but the real rule
// must ship. Every one of them contains a test-directory segment as a SUBSTRING or a PREFIX of a
// segment, and none of them contains one as a whole segment.
//
// This is the control the negative probes cannot provide. A negative probe only ever proves the rule
// matches enough; nothing in a list of absences can prove it does not match too much, and an
// over-match is the failure that actually ships a broken artifact — it removes a RUNTIME file, the
// build stays green, and no test names the missing path. Deriving the expectation from
// isFirstPartyTestPath instead would be circular: a rule that over-matched would also over-match the
// expectation and the check would pass. These paths are therefore asserted PRESENT by literal name.
//
// They exist because the repository currently contains no such near-miss of its own — the segments
// were added as hardening against future paths, so the adversarial cases have to be planted.
const runtimeProbes = [
	"vinci/updater/ws-c4-fixtures-loader.mjs", // "fixtures" as a substring of a FILENAME
	"vinci/extensions/ws-c4-snapshots-helper.mjs", // "snapshots" without the dunder wrapping
	"vinci/themes/ws-c4-fixtures-extra/keep.json", // "fixtures" as a PREFIX of a directory segment
	"vinci/assets/ws-c4-__snapshots__-data/keep.json", // "__snapshots__" as a prefix of a segment
	// The comment above claims a substring or prefix match "in either position" would take runtime
	// paths with it, but the four entries above only ever exercise the DIRECTORY-SEGMENT position.
	// Un-anchoring TEST_FILE_PATTERN survived every one of them: "latest" contains "test" and
	// "inspector" contains "spec", so vinci/updater/latest-release.json and
	// vinci/extensions/vinci-inspector.mjs would both be dropped from the archive with the suite
	// still green. These two put a real near-miss in the FILENAME position, which is the half the
	// claim was making and nothing was checking.
	"vinci/updater/ws-c4-latest-release.json", // "test" inside "latest", in a FILENAME
	"vinci/extensions/ws-c4-inspector-helper.mjs", // "spec" inside "inspector", in a FILENAME
	// Both of the above end in .json or -helper.mjs, which lets three over-match mutations survive.
	// This one is a bare .mjs whose stem ends in "latest", so the anchored-pattern half is exercised
	// on its own rather than only alongside a distinctive suffix.
	"vinci/updater/ws-c4-latest.mjs", // "test" inside "latest", bare .mjs filename
];

// A file that already existed before this run, inside a directory the plant loop reaches into.
// The cleanup's whole claim is "remove what I planted", not "remove where I planted" -- and until
// this control existed, nothing failed when that claim was false. Recording a plant directory's
// PARENT instead of the directory actually created destroys tracked files here and still reports
// every check passing, because no assertion looked outside the archive.
//
// PLACEMENT IS THE WHOLE CONTROL. A keeper OUTSIDE every plant directory only fires for a strictly
// wider mutant -- one that removes vinci/themes wholesale. It does NOT fire for the exact scenario
// this file's own comments name: "the day a real vinci/themes/specs holds real files". So the
// keeper is created INSIDE a plant directory, before the plant loop. mkdirSync then returns
// undefined for that directory on the plant, so it is never recorded as created, and a correct
// cleanup must leave it alone. Restoring the original by-name recursive rmSync destroys it.
const keeperDirectory = join(root, "vinci/themes/specs");
const keeper = join(keeperDirectory, "ws-c4-preexisting-keeper.json");
const keeperDirectoryPreexisted = existsSync(keeperDirectory);
mkdirSync(keeperDirectory, { recursive: true });
writeFileSync(keeper, '{"note":"existed before the plant loop; a correct cleanup never touches it"}\n');
const keeperBytesBefore = readFileSync(keeper);

function listArchive(outputDirectory) {
	const archive = join(outputDirectory, `vinci-code-${version}.tgz`);
	assert.equal(existsSync(archive), true, `producer wrote no archive at ${archive}`);
	return new Set(
		execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
			.split("\n")
			.filter(Boolean)
			// tar lists directories with a trailing slash; compare on the bare path.
			.map((member) => (member.endsWith("/") ? member.slice(0, -1) : member)),
	);
}

function build(script, outputDirectory) {
	execFileSync("bash", [script, outputDirectory], { cwd: root, encoding: "utf8", stdio: "pipe" });
	return listArchive(outputDirectory);
}

const work = mkdtempSync(join(tmpdir(), "vinci-package-first-party-tests-"));
// Exactly what this run brought into existence, so the cleanup can remove that and nothing else. An
// earlier version deleted the probes' enclosing directories by NAME and recursively
// (rmSync("vinci/themes/specs", { recursive: true })). That is correct only while those directories
// exist solely because this test created them: the day a real vinci/themes/specs holds real files, a
// single run of this test deletes them, and the deletion happens in a `finally` that runs even when
// the run failed. Recording what was created inverts the rule from "remove where I planted" to
// "remove what I planted".
const plantedFiles = [];
const createdDirectories = [];
let thrown;
try {
	for (const probe of [...probes, ...runtimeProbes]) {
		const absolute = join(root, probe);
		// mkdirSync(recursive) returns the FIRST directory it had to create, or undefined when the whole
		// chain already existed. So a non-undefined return is a directory that did not exist before this
		// run, and its entire subtree came into existence after it — which is what makes removing that
		// one path recursively safe, and what makes an already-present directory untouchable.
		const createdRoot = mkdirSync(dirname(absolute), { recursive: true });
		if (createdRoot !== undefined) createdDirectories.push(createdRoot);
		writeFileSync(absolute, "// planted by vinci/test/package-first-party-tests.mjs\n");
		plantedFiles.push(absolute);
	}

	// ── The producer that governs main today ────────────────────────────────────────────────────────
	const shipped = build(join(root, "vinci", "package.sh"), join(work, "release"));

	for (const probe of probes) {
		check(`planted first-party test path is absent from the archive: ${probe}`, !shipped.has(probe));
	}
	check(
		"the enclosing test directories are absent too, not just their files",
		!shipped.has("vinci/updater/__tests__") && !shipped.has("vinci/themes/specs"),
	);
	// Positive control through the same entry point: the exclusion removed test paths and nothing else.
	for (const witness of runtimeWitnesses) {
		check(`runtime file still ships: ${witness}`, shipped.has(witness));
	}
	// Positive control aimed at OVER-matching specifically: near-miss runtime paths must survive.
	for (const runtimeProbe of runtimeProbes) {
		check(`near-miss runtime path still ships (rule did not over-match): ${runtimeProbe}`, shipped.has(runtimeProbe));
	}
	// WHAT THIS DOES AND DOES NOT DO. An earlier version of this comment claimed the pair was "stated
	// as a set difference so it also catches the archive GAINING a member". It did not: `unexpected`
	// filtered `shipped` against `probes` alone -- a duplicate of the loop a few lines above, which
	// fires first -- and the second conjunct compared a Set's size against the count it was built
	// from, which is constant-true for every possible archive. Proven by execution: the archive
	// gained vinci/install.sh and vinci/build.sh, which package.sh's own comment forbids as release
	// tooling, and the suite stayed green. Detecting a GAINED member needs a baseline listing to
	// difference against, which this test does not take; claiming it here was the same overclaim
	// this file exists to prevent, committed in the comment rather than the code.
	// So these two now say only what they check: no planted TEST probe shipped, and every planted
	// RUNTIME probe did.
	const unexpected = [...shipped].filter((member) => probes.includes(member));
	check(`no planted test probe is a member of the archive (found ${unexpected.length}: ${unexpected.join(", ") || "none"})`, unexpected.length === 0);
	check(
		"every planted runtime probe is accounted for in the archive",
		runtimeProbes.every((runtimeProbe) => shipped.has(runtimeProbe)),
	);
	check("the shipped extension layer is still populated", [...shipped].filter((m) => m.startsWith("vinci/extensions/")).length > 10);
	check("the shipped built packages are still populated", [...shipped].filter((m) => m.startsWith("packages/coding-agent/dist/")).length > 10);
	// ssh2's own test directory is a DEPENDENCY carve-out in package.sh, unrelated to this rule. Assert
	// it is still handled so a future reader does not mistake this rule for the thing that covers it.
	check("no node_modules/ssh2/test member ships", ![...shipped].some((m) => m.startsWith("node_modules/ssh2/test")));

	// ── The PR #50 case, now MEASURED rather than simulated ─────────────────────────────────────────
	// SCOPE: these assertions are about the REAL archive built above by the REAL vinci/package.sh, on a
	// tree where BOTH halves are present.
	//
	// Before the base was integrated this could only be a simulation. vinci/worker was not in
	// package.sh's tar path list, so nothing under it shipped and there was nothing to exclude; this
	// file reproduced #50's tar block on a disposable copy of package.sh and asserted against that
	// copy's output. The simulation's prediction was that 21 members under vinci/worker/ would ship and
	// the two test files would not. Merging origin/main (through PR #51, e85c5d0f) into this branch put
	// #50's tar-list edit and #51's shape-predicate exclusion in ONE tree for the first time, and the
	// real artifact reproduces that prediction exactly — so the simulation is retired here and the same
	// claims are now stated against `shipped`.
	//
	// The two real files #49 put on main are named literally, because they are the files at stake:
	// #50's own packaged-artifact checker has no unexpected-file or closure check that would notice
	// them shipping.
	check("vinci/worker is tarred at all — PR #50's tar-list edit is live in this tree", [...shipped].some((m) => m.startsWith("vinci/worker")));
	for (const workerTest of ["vinci/worker/test/economics.test.mjs", "vinci/worker/test/economics-session.test.mjs"]) {
		check(`real worker test file is absent from the archive: ${workerTest}`, !shipped.has(workerTest));
	}
	check("the vinci/worker/test directory itself is absent", !shipped.has("vinci/worker/test"));
	// Positive reachability control through the same entry point: worker runtime DID ship, so the
	// absences above are the exclusion working and not the root failing to be tarred at all. Note
	// economics.mjs is asserted alongside worker.mjs on purpose — it is the runtime SIBLING of
	// economics.test.mjs, so an exclusion that over-matched on the name would drop it.
	check(
		"worker runtime still ships",
		shipped.has("vinci/worker/worker.mjs") && shipped.has("vinci/worker/run.mjs") && shipped.has("vinci/worker/economics.mjs"),
	);
	check(
		"every other vinci/worker member survived (21 runtime paths)",
		[...shipped].filter((m) => m.startsWith("vinci/worker/")).length === 21,
	);

	// Closure check over the WHOLE archive, not just the paths this test planted or named. The checks
	// above are the non-circular evidence (planted probes, and the two real files named literally);
	// this one catches a first-party test path nobody thought to enumerate. It is stated over the
	// artifact's members, so it holds identically for the entry-list producer in PR #48.
	const leaked = [...shipped].filter((member) => isFirstPartyTestPath(member));
	check(`archive carries no first-party test path at all (found ${leaked.length}: ${leaked.join(", ") || "none"})`, leaked.length === 0);
} catch (error) {
	thrown = error;
} finally {
	// Files first, then only the directories this run created — deepest first, so a created parent is
	// removed after any created child. Directories that already existed are never named here at all.
	for (const file of plantedFiles) rmSync(file, { force: true });
	for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
		rmSync(directory, { recursive: true, force: true });
	}
	rmSync(work, { recursive: true, force: true });
}

// These run on BOTH paths. The previous version sat after try/finally with no catch, so any
// earlier assertion throw skipped them entirely -- the comment claimed "including on the failure
// path" while the code could not deliver it, and a failing probe destroyed tracked files with
// nothing saying so. `thrown` is captured, the cleanup assertions run, and the original error is
// re-thrown afterwards so the first failure is still what a reader sees.

// OVER-deletion: a file that existed before the plant loop, inside a plant directory, byte-identical.
check(
	`pre-existing file survived the cleanup byte-identical: ${relative(root, keeper)}`,
	existsSync(keeper) && readFileSync(keeper).equals(keeperBytesBefore),
);

// UNDER-deletion, which nothing checked in either direction. A no-op cleanup passed every other
// assertion here while leaving planted files behind -- and seven of them are runtimeProbes, which by
// design are NOT excluded, so a regressed cleanup puts junk straight into the released tarball.
const leftBehind = plantedFiles.filter((file) => existsSync(file));
check(
	`the cleanup actually ran: no planted file remains (found ${leftBehind.length}: ${leftBehind.map((f) => relative(root, f)).join(", ") || "none"})`,
	leftBehind.length === 0,
);

// This test's own keeper is removed last, after it has done its work; the directory only if this
// run created it.
rmSync(keeper, { force: true });
if (!keeperDirectoryPreexisted) rmSync(keeperDirectory, { recursive: true, force: true });

if (thrown !== undefined) throw thrown;

console.log(`\npackage-first-party-tests: ${pass}/${pass} checks passed (no first-party test path enters the release archive)`);
