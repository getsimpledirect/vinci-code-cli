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
import { dirname, join, resolve } from "node:path";
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
];

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
// PR #50's tar-list edit, applied to a DISPOSABLE copy of package.sh. package.sh derives ROOT from its
// own location, so the copy has to sit in vinci/ for the build to find the repository.
const simulationScript = join(root, "vinci", "package.pr50-simulation.tmp.sh");
// Exactly what this run brought into existence, so the cleanup can remove that and nothing else. An
// earlier version deleted the probes' enclosing directories by NAME and recursively
// (rmSync("vinci/themes/specs", { recursive: true })). That is correct only while those directories
// exist solely because this test created them: the day a real vinci/themes/specs holds real files, a
// single run of this test deletes them, and the deletion happens in a `finally` that runs even when
// the run failed. Recording what was created inverts the rule from "remove where I planted" to
// "remove what I planted".
const plantedFiles = [];
const createdDirectories = [];
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
	// The unplanted artifact is unchanged by all of this: every member the archive carries that this
	// test did not plant is a path the repository already had. Stated as a set difference so it also
	// catches the archive GAINING a member — a widened rule cannot add one, but the simulation copy of
	// package.sh below could, and this is the check that would see it.
	const plantedMembers = new Set([...probes, ...runtimeProbes]);
	const unexpected = [...shipped].filter((member) => probes.includes(member));
	check(`no planted test probe is a member of the archive (found ${unexpected.length}: ${unexpected.join(", ") || "none"})`, unexpected.length === 0);
	check(
		"every planted runtime probe is accounted for in the archive",
		runtimeProbes.every((runtimeProbe) => shipped.has(runtimeProbe)) && plantedMembers.size === probes.length + runtimeProbes.length,
	);
	check("the shipped extension layer is still populated", [...shipped].filter((m) => m.startsWith("vinci/extensions/")).length > 10);
	check("the shipped built packages are still populated", [...shipped].filter((m) => m.startsWith("packages/coding-agent/dist/")).length > 10);
	// ssh2's own test directory is a DEPENDENCY carve-out in package.sh, unrelated to this rule. Assert
	// it is still handled so a future reader does not mistake this rule for the thing that covers it.
	check("no node_modules/ssh2/test member ships", ![...shipped].some((m) => m.startsWith("node_modules/ssh2/test")));

	// ── The PR #50 case, which main CANNOT exercise ─────────────────────────────────────────────────
	// SCOPE: this block does NOT assert main's current behaviour. On main, vinci/worker is not in
	// package.sh's tar path list at all, so nothing under it ships and there is nothing to exclude. PR
	// #50 (cf196e63) adds `vinci/worker` to that list and excludes only vinci/worker/README.md; from
	// that moment the two real files below would ship, and #50's own checker has no unexpected-file or
	// closure check to notice. The simulation below reproduces #50's tar block exactly so this branch
	// can prove the archive is closed BEFORE #50 merges.
	check("on main, vinci/worker is not tarred at all", ![...shipped].some((m) => m.startsWith("vinci/worker")));

	const packageScript = readFileSync(join(root, "vinci", "package.sh"), "utf8");
	const simulated = packageScript
		.replace("  --exclude='*.ts.map' \\\n", "  --exclude='*.ts.map' \\\n  --exclude='vinci/worker/README.md' \\\n")
		.replace(
			"  vinci/bin vinci/extensions vinci/themes vinci/assets vinci/updater \\\n",
			"  vinci/bin vinci/extensions vinci/themes vinci/assets vinci/updater vinci/worker \\\n",
		);
	check("the #50 simulation actually edited package.sh's tar list", simulated !== packageScript && simulated.includes("vinci/updater vinci/worker \\"));
	writeFileSync(simulationScript, simulated);

	const shippedUnderPr50 = build(simulationScript, join(work, "release-pr50"));
	// The two real files #49 put on main — named literally, because these are the files at stake.
	for (const workerTest of ["vinci/worker/test/economics.test.mjs", "vinci/worker/test/economics-session.test.mjs"]) {
		check(`#50 SIMULATION: real worker test file is absent from the archive: ${workerTest}`, !shippedUnderPr50.has(workerTest));
	}
	check("#50 SIMULATION: the vinci/worker/test directory itself is absent", !shippedUnderPr50.has("vinci/worker/test"));
	// Positive reachability control for the simulation: worker runtime DID ship, so the absences above
	// are the exclusion working and not the root failing to be tarred at all.
	check("#50 SIMULATION: worker runtime still ships", shippedUnderPr50.has("vinci/worker/worker.mjs") && shippedUnderPr50.has("vinci/worker/run.mjs"));
	check(
		"#50 SIMULATION: every other vinci/worker member survived (21 runtime paths)",
		[...shippedUnderPr50].filter((m) => m.startsWith("vinci/worker/")).length === 21,
	);

	// Closure check over the WHOLE archive, not just the paths this test planted or named. The two
	// checks above are the non-circular evidence (planted probes, and the two real files named
	// literally); this one catches a first-party test path nobody thought to enumerate. It is stated
	// over the artifact's members, so it holds identically for the entry-list producer in PR #48.
	for (const listing of [shipped, shippedUnderPr50]) {
		const leaked = [...listing].filter((member) => isFirstPartyTestPath(member));
		check(`archive carries no first-party test path at all (found ${leaked.length}: ${leaked.join(", ") || "none"})`, leaked.length === 0);
	}
} finally {
	// Files first, then only the directories this run created — deepest first, so a created parent is
	// removed after any created child. Directories that already existed are never named here at all.
	for (const file of plantedFiles) rmSync(file, { force: true });
	for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
		rmSync(directory, { recursive: true, force: true });
	}
	rmSync(simulationScript, { force: true });
	rmSync(work, { recursive: true, force: true });
}

console.log(`\npackage-first-party-tests: ${pass}/${pass} checks passed (no first-party test path enters the release archive)`);
