#!/usr/bin/env node
// Stage the locked dependency closure as portable files, retaining relative workspace links.
// First inspect every selected file and enforce the worker's churn ceiling before copying any.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const [rootArgument, stageArgument, mode] = process.argv.slice(2);
if (!rootArgument || !stageArgument || (mode !== undefined && mode !== "--estimate")) {
	console.error("Usage: stage-runtime-dependencies.mjs <repository-root> <stage-root> [--estimate]; supply owned directories before packaging.");
	process.exit(2);
}
const root = realpathSync(rootArgument);
const stage = resolve(stageArgument);
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packages = new Map();
const workspaces = ["agent", "ai", "coding-agent", "orchestrator", "tui"];
const workspacePaths = new Set(workspaces.map((name) => `packages/${name}`));

function locate(name, from) {
	for (let directory = from; ; directory = dirname(directory)) {
		const candidate = join(directory, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (directory === root) break;
		if (!directory.startsWith(root + sep)) break;
	}
	throw new Error(`Runtime dependency "${name}" is missing from "${relative(root, from)}". Hydrate the locked dependency before packaging.`);
}

function visit(directory) {
	const logicalPath = relative(root, directory);
	if (packages.has(logicalPath)) return;
	const source = realpathSync(directory);
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	const workspace = workspacePaths.has(relative(root, source));
	const entry = lock.packages[logicalPath];
	if (!entry) throw new Error(`Runtime dependency "${logicalPath}" is absent from package-lock.json. Restore the reviewed lock before packaging.`);
	if (!entry.link && entry.version !== manifest.version) {
		throw new Error(`Runtime dependency "${logicalPath}" has version "${manifest.version}", expected locked "${entry.version}". Hydrate that exact locked version before packaging.`);
	}
	packages.set(logicalPath, { source, workspace, target: workspace ? relative(root, source) : logicalPath });
	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
		let dependency;
		try { dependency = locate(name, directory); }
		catch (error) {
			if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional) continue;
			throw error;
		}
		visit(dependency);
	}
}
for (const name of workspaces) visit(join(root, "packages", name));
// Custom extensions may consume any shipped workspace's public package name, including one not
// imported by another workspace. Preserve all aliases that the previous monorepo payload exposed.
for (const name of workspaces) {
	const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
	visit(locate(manifest.name, root));
}

const files = [];
const links = [];
let bytes = 0;
function inspect(source, destination, packageRoot) {
	const details = lstatSync(source);
	if (details.isSymbolicLink()) {
		const target = readlinkSync(source);
		const resolved = resolve(dirname(source), target);
		if (target.startsWith(sep) || (resolved !== packageRoot && !resolved.startsWith(packageRoot + sep))) {
			throw new Error(`Runtime package symlink "${source}" escapes its package. Restore portable reviewed dependency bytes before packaging.`);
		}
		links.push({ destination, target });
		return;
	}
	if (details.isDirectory()) {
		for (const name of readdirSync(source)) {
			if (name === "node_modules" || name === ".git" || name.endsWith(".map")) continue;
			inspect(join(source, name), join(destination, name), packageRoot);
		}
		return;
	}
	if (!details.isFile()) throw new Error(`Runtime package entry "${source}" is not a regular file. Restore reviewed package bytes before packaging.`);
	// Dependency declarations are development tooling; the first-party Runtime facade declaration
	// is packaged explicitly by package.sh and remains available to its deployed consumer.
	if (/\.(?:map|d\.(?:ts|mts|cts))$/.test(source)) return;
	bytes += details.size;
	files.push({ source, destination, mode: details.mode & 0o777 });
}
for (const [path, dependency] of packages) {
	if (dependency.workspace) {
		if (path !== dependency.target) links.push({ destination: join(stage, path), target: relative(dirname(join(stage, path)), join(stage, dependency.target)) });
		continue;
	}
	inspect(dependency.source, join(stage, path), dependency.source);
}
console.log(`Runtime dependency staging estimate: ${packages.size} selected packages, ${files.length} regular files, ${links.length} portable links, ${bytes} bytes; versions agree with package-lock.json.`);
if (files.length + links.length > 10000 || bytes > 5_000_000_000) {
	throw new Error("Runtime dependency staging exceeds 10,000 entries or 5 GB. Report the estimate and obtain a bounded packaging plan before copying.");
}
if (mode !== "--estimate") {
	mkdirSync(join(stage, "node_modules"), { recursive: true });
	mkdirSync(join(stage, "packages"), { recursive: true });
	for (const file of files) {
		mkdirSync(dirname(file.destination), { recursive: true });
		copyFileSync(file.source, file.destination);
		chmodSync(file.destination, file.mode);
	}
	for (const link of links) {
		mkdirSync(dirname(link.destination), { recursive: true });
		symlinkSync(link.target, link.destination);
	}
	console.log(`Staged ${files.length} runtime dependency files and ${links.length} portable links under ${stage}.`);
}
