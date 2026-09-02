import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimePackageExcludes } from "./runtime-package-closure.mjs";

const rootArgument = process.argv[2];
if (!rootArgument) throw new Error("Usage: package-entries.mjs <repository-root>");
const root = resolve(rootArgument);

const releaseRoots = [
	"packages/agent/dist",
	"packages/agent/package.json",
	"packages/ai/dist",
	"packages/ai/package.json",
	"packages/coding-agent/dist",
	"packages/coding-agent/package.json",
	"packages/orchestrator/dist",
	"packages/orchestrator/package.json",
	"packages/tui/dist",
	"packages/tui/package.json",
	"vinci/bin",
	"vinci/extensions",
	"vinci/themes",
	"vinci/assets",
	"vinci/updater",
	"vinci/worker",
	"vinci/scripts/report-wrong.mjs",
	"vinci/scripts/reap-heal-temp.mjs",
	"vinci/scripts/resolve-dispatch.mjs",
	"vinci/dispatch-manifest.json",
	"vinci/identity.json",
	"vinci/NOTICE",
	"package.json",
	"node_modules",
];
const excludedPackages = new Set(runtimePackageExcludes(root));

function belongsToExcludedPackage(relativePath) {
	let cursor = relativePath;
	while (cursor) {
		if (excludedPackages.has(cursor)) return true;
		const slash = cursor.lastIndexOf("/");
		if (slash === -1) return false;
		cursor = cursor.slice(0, slash);
	}
	return false;
}

function excluded(relativePath) {
	if (
		/\.map$/.test(relativePath)
		|| relativePath === "vinci/worker/README.md"
		|| relativePath === "node_modules/.package-lock.json"
	) return true;
	const nestedPath = `/${relativePath}`;
	return belongsToExcludedPackage(relativePath)
		|| /\/node_modules\/(?:\.cache|\.vite|\.bin)(?:\/|$)/.test(nestedPath)
		|| /\/node_modules\/ssh2\/test(?:\/|$)/.test(nestedPath);
}

function emit(relativePath) {
	if (excluded(relativePath)) return;
	const path = join(root, ...relativePath.split("/"));
	if (!existsSync(path)) throw new Error(`Required package entry is missing: ${relativePath}`);
	const stat = lstatSync(path);
	process.stdout.write(`${relativePath}\n`);
	if (!stat.isDirectory() || stat.isSymbolicLink()) return;
	for (const entry of readdirSync(path).sort()) emit(`${relativePath}/${entry}`);
}

for (const relativePath of releaseRoots) emit(relativePath);
