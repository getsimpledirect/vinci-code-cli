import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const packageJsonFiles = [];
const lockJsonFiles = [];
// Reviewed upstream security fix floors; include standalone example locks in the same traversal.
// https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr
// https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv
// https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5
const securityVersions = {
	"brace-expansion": { 1: "1.1.21", 5: "5.0.12" },
	"shell-quote": { 1: "1.11.0" },
	undici: { 6: "6.28.1", 7: "7.29.1", 8: "8.10.2" },
};

function collectPackageJsonFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectPackageJsonFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name === "package.json") {
			packageJsonFiles.push(join(directory, entry.name));
		}
		if (entry.isFile() && (entry.name === "package-lock.json" || entry.name === "npm-shrinkwrap.json")) {
			lockJsonFiles.push(join(directory, entry.name));
		}
	}
}

function isInternalWorkspaceDependency(name) {
	return name.startsWith("@earendil-works/pi-");
}

function isNonRegistrySpecifier(specifier) {
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

function getVersionSpecifier(specifier) {
	if (!specifier.startsWith("npm:")) return specifier;
	const aliasTarget = specifier.slice("npm:".length);
	const versionSeparator = aliasTarget.lastIndexOf("@");
	if (versionSeparator <= 0) return specifier;
	return aliasTarget.slice(versionSeparator + 1);
}

const failures = [];

collectPackageJsonFiles(".");

for (const file of packageJsonFiles.sort()) {
	const packageJson = JSON.parse(readFileSync(file, "utf8"));

	for (const section of dependencySections) {
		const dependencies = packageJson[section];
		if (!dependencies) continue;

		for (const [name, specifier] of Object.entries(dependencies)) {
			if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) continue;
			if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
			failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
		}
	}
}

for (const file of lockJsonFiles.sort()) {
	const lock = JSON.parse(readFileSync(file, "utf8"));
	if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
		failures.push(`${file}: the package graph is missing; regenerate the lockfile before checking advisory versions.`);
		continue;
	}
	for (const [path, entry] of Object.entries(lock.packages)) {
		const names = new Set([path.split("node_modules/").at(-1), entry.name]);
		for (const name of names) {
			if (!Object.hasOwn(securityVersions, name)) continue;
			const versions = securityVersions[name];
			const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(entry.version ?? "")?.slice(1).map(Number);
			const minimum = actual && versions[actual[0]];
			if (!minimum) {
				failures.push(`${file}: ${path} has unreviewed version "${entry.version}"; review its security fix floor.`);
				continue;
			}
			const required = minimum.split(".").map(Number);
			if (actual[1] < required[1] || (actual[1] === required[1] && actual[2] < required[2])) {
				failures.push(`${file}: ${path} has affected version "${entry.version}"; update to ${minimum} or newer in the reviewed major.`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("Dependency version checks failed; resolve every finding before retrying.");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`Known patched-advisory version floors passed for ${lockJsonFiles.length} lockfiles; unpatched advisories still require separate review.`);
