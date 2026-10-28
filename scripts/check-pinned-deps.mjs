import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkForgeBackport, forgeSourcePath } from "./check-forge-backport.mjs";
import { checkSandboxSource, sandboxArchivePath, sandboxIntegrity, sandboxVersion } from "./check-sandbox-runtime-source.mjs";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const packageJsonFiles = [];
const lockJsonFiles = [];
// Reviewed upstream security fix floors; include standalone example locks in the same traversal.
// https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr
// https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv
// https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c
// https://github.com/nodejs/undici/security/advisories/GHSA-4qv8-2p9j-2685
// https://github.com/nodejs/undici/security/advisories/GHSA-f72v-6w45-q472
// https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
const securityVersions = {
	"brace-expansion": { 1: "1.1.21", 5: "5.0.12" },
	"shell-quote": { 1: "1.11.0" },
	undici: { 6: "6.29.1", 7: "7.30.1", 8: "8.12.2" },
	zod: { 4: "4.6.6" },
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

try {
	checkForgeBackport();
} catch (error) {
	failures.push(`${error.message} Restore the reviewed Forge source package before retrying.`);
}
try {
	checkSandboxSource();
} catch (error) {
	failures.push(`${error.message} Restore the reviewed sandbox consumer archive before retrying.`);
}

collectPackageJsonFiles(".");

for (const file of packageJsonFiles.sort()) {
	const packageJson = JSON.parse(readFileSync(file, "utf8"));
	if (file === "package.json" || file === "packages/coding-agent/examples/extensions/sandbox/package.json") {
		const expected = file === "package.json" ? `file:./${sandboxArchivePath}` : `file:./vendor/sandbox-runtime/sandbox-runtime-${sandboxVersion}.tgz`;
		const dependencies = file === "package.json" ? packageJson.devDependencies : packageJson.dependencies;
		if (dependencies?.["@anthropic-ai/sandbox-runtime"] !== expected) failures.push(`${file}: restore the reviewed sandbox consumer dependency "${expected}".`);
	}
	if (file === "package.json" || file === "packages/coding-agent/examples/extensions/gondolin/package.json") {
		const expected = file === "package.json" ? `file:./${forgeSourcePath}` : "file:./vendor/node-forge";
		const dependencies = file === "package.json" ? packageJson.devDependencies : packageJson.dependencies;
		if (packageJson.overrides?.["node-forge"] !== "$node-forge" || dependencies?.["node-forge"] !== expected) failures.push(`${file}: the reviewed Forge dependency/override is missing; restore "${expected}" and its "$node-forge" reference before installing dependencies.`);
	}

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
	let forgeEntries = 0;
	let sandboxEntries = 0;
	for (const [path, entry] of Object.entries(lock.packages)) {
		const names = new Set([path.split("node_modules/").at(-1), entry.name]);
		for (const name of names) {
			if (name === "@anthropic-ai/sandbox-runtime" && path.includes("node_modules/")) {
				sandboxEntries++;
				const source = typeof entry.resolved === "string" ? resolve(dirname(file), entry.resolved.replace(/^file:/, "")) : undefined;
				if (source !== resolve(sandboxArchivePath) || entry.link === true || entry.version !== sandboxVersion || entry.integrity !== sandboxIntegrity || entry.dependencies?.zod !== "4.6.6") failures.push(`${file}: ${path} does not resolve to the sealed Zod 4 sandbox consumer; regenerate and review its lock.`);
				continue;
			}
			if (name === "node-forge" && path.includes("node_modules/")) {
				forgeEntries++;
				const expectedPath = resolve(forgeSourcePath);
				const source = typeof entry.resolved === "string" ? resolve(dirname(file), entry.resolved.replace(/^file:/, "")) : undefined;
				const metadata = lock.packages[entry.resolved];
				const linked = entry.link === true && metadata?.version === "1.4.2" && metadata?.engines?.node === ">= 6.13.0";
				const packed = entry.link !== true && entry.resolved?.startsWith("file:") && entry.version === "1.4.2" && entry.engines?.node === ">= 6.13.0";
				if (source !== expectedPath || (!linked && !packed)) {
					failures.push(`${file}: ${path} does not resolve to the reviewed Forge source; regenerate its lock with the local backport override.`);
				}
				continue;
			}
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
	if ((file === "package-lock.json" || file === "packages/coding-agent/examples/extensions/sandbox/package-lock.json") && sandboxEntries !== 1) failures.push(`${file}: the sandbox graph must include exactly one sealed Zod 4 consumer.`);
	if ((file === "package-lock.json" || file === "packages/coding-agent/examples/extensions/gondolin/package-lock.json") && forgeEntries !== 1) {
		failures.push(`${file}: the Gondolin graph must include exactly one reviewed Forge backport; regenerate and review the local override resolution.`);
	}
}

if (failures.length > 0) {
	console.error("Dependency version checks failed; resolve every finding before retrying.");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`Known patched-advisory version floors passed for ${lockJsonFiles.length} lockfiles; unpatched advisories still require separate review.`);
