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
// against today's producer rather than a hypothetical one. Three shapes, so a partial rule cannot pass:
// a __tests__ directory segment, a *.test.* basename with no test directory above it, and a `specs`
// directory holding a non-JavaScript file (which only the directory-segment half of the rule catches).
const probes = [
	"vinci/updater/__tests__/ws-c3-probe.test.mjs",
	"vinci/extensions/ws-c3-probe.test.mjs",
	"vinci/themes/specs/ws-c3-probe.json",
];
// Runtime files under those same roots. If the exclusion ever widened from "test paths" to "the root",
// these disappear too, and the positive control below catches it.
const runtimeWitnesses = ["vinci/bin/vinci", "vinci/identity.json", "package.json"];

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
try {
	for (const probe of probes) {
		mkdirSync(dirname(join(root, probe)), { recursive: true });
		writeFileSync(join(root, probe), "// planted by vinci/test/package-first-party-tests.mjs\n");
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
} finally {
	for (const probe of probes) rmSync(join(root, probe), { force: true });
	rmSync(join(root, "vinci/updater/__tests__"), { recursive: true, force: true });
	rmSync(join(root, "vinci/themes/specs"), { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
}

console.log(`\npackage-first-party-tests: ${pass}/${pass} checks passed (no first-party test path enters the release archive)`);
