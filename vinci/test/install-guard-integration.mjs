import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const installer = resolve(root, "vinci/install.sh");

// A bin dir inside VINCI_HOME makes the shim a symlink to itself, and every later `vinci` call
// dies with "too many levels of symbolic links". Found by hitting it during a real install: the
// installer left a broken install behind and the error named neither path involved.
//
// These cases must never run a real install. The refusal cases exit at the guard, before any
// download. The ACCEPT cases are pointed at an unreachable manifest so they fail immediately
// AFTER the guard — proving the guard let them through without installing anything.
const stage = mkdtempSync(join(tmpdir(), "vinci-install-guard-"));
const home = join(stage, "home");

function run(vinciHome, binDir) {
	try {
		execFileSync("sh", [installer], {
			cwd: root,
			encoding: "utf8",
			stdio: "pipe",
			timeout: 60_000,
			env: {
				...process.env,
				VINCI_HOME: vinciHome,
				VINCI_BIN_DIR: binDir,
				// Unreachable on purpose: an ACCEPT case must not reach the network.
				VINCI_UPDATE_MANIFEST_URL: "http://127.0.0.1:1/never",
			},
		});
		return "";
	} catch (error) {
		return `${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
}

const GUARD = /VINCI_BIN_DIR must not be inside VINCI_HOME/;

// REFUSED: the shim would point at itself.
for (const [vh, bin, why] of [
	[home, join(home, "bin"), "bin dir nested in home"],
	[home, home, "bin dir identical to home"],
	[`${home}/`, `${join(home, "bin")}/`, "trailing slashes must not defeat the check"],
]) {
	assert.match(run(vh, bin), GUARD, `must refuse: ${why}`);
}

// ACCEPTED: a sibling sharing a name prefix is NOT inside home. A naive prefix match fails here,
// which is the whole reason the check compares with a trailing separator.
for (const [vh, bin, why] of [
	[home, `${home}-other/bin`, "sibling sharing a prefix is not containment"],
	[home, join(stage, "elsewhere", "bin"), "unrelated bin dir"],
]) {
	const output = run(vh, bin);
	assert.doesNotMatch(output, GUARD, `must accept: ${why}`);
}

process.stdout.write(
	"install-guard-integration: VINCI_BIN_DIR inside VINCI_HOME is refused (3 shapes); prefix-similar siblings still accepted\n",
);
