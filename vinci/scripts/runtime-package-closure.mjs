import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const RUNTIME_WORKSPACE_PACKAGE_ROOTS = [
	"packages/agent",
	"packages/ai",
	"packages/coding-agent",
	"packages/orchestrator",
	"packages/tui",
];

function packageDirectories(nodeModules) {
	if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) return [];
	const packages = [];
	for (const entry of readdirSync(nodeModules).sort()) {
		if (entry.startsWith(".")) continue;
		const path = join(nodeModules, entry);
		if (!lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) continue;
		if (!entry.startsWith("@")) {
			packages.push(path);
			continue;
		}
		if (lstatSync(path).isSymbolicLink()) continue;
		for (const scopedEntry of readdirSync(path).sort()) {
			const scopedPath = join(path, scopedEntry);
			if (lstatSync(scopedPath).isDirectory() || lstatSync(scopedPath).isSymbolicLink()) {
				packages.push(scopedPath);
			}
		}
	}
	return packages;
}

function installedPackageDirectories(repositoryRoot) {
	const found = [];
	const queue = [join(repositoryRoot, "node_modules")];
	while (queue.length > 0) {
		const nodeModules = queue.shift();
		for (const packageRoot of packageDirectories(nodeModules)) {
			found.push(packageRoot);
			if (!lstatSync(packageRoot).isSymbolicLink()) queue.push(join(packageRoot, "node_modules"));
		}
	}
	return found;
}

function readPackage(packageRoot) {
	const path = join(packageRoot, "package.json");
	if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Runtime package has no package.json: ${path}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

function resolveDependency(repositoryRoot, packageRoot, name) {
	let cursor = packageRoot;
	while (true) {
		const candidate = join(cursor, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (cursor === repositoryRoot) return null;
		const parent = dirname(cursor);
		if (parent === cursor || relative(repositoryRoot, parent).startsWith(`..${sep}`)) return null;
		cursor = parent;
	}
}

// Return every installed package directory that is outside the production dependency closure of
// the five workspaces shipped by vinci/package.sh. This removes development CLIs and test runners as
// complete package graphs instead of maintaining a name-by-name list whose dependencies can escape
// to a parent node_modules directory.
export function runtimePackageExcludes(repositoryRoot) {
	const root = resolve(repositoryRoot);
	const installed = installedPackageDirectories(root);
	const installedRelative = new Map(installed.map((path) => [relative(root, path).split(sep).join("/"), path]));
	const reachable = new Set();
	const visited = new Set();
	const queue = RUNTIME_WORKSPACE_PACKAGE_ROOTS.map((path) => join(root, ...path.split("/")));
	for (const workspaceRoot of queue) {
		const workspace = readPackage(workspaceRoot);
		if (typeof workspace.name !== "string") throw new Error(`Runtime workspace has no package name: ${workspaceRoot}`);
		const linkedRoot = resolveDependency(root, root, workspace.name);
		if (linkedRoot === null) throw new Error(`Runtime workspace is not linked in node_modules: ${workspace.name}`);
		reachable.add(relative(root, linkedRoot).split(sep).join("/"));
	}

	while (queue.length > 0) {
		const packageRoot = queue.shift();
		const physicalKey = resolve(packageRoot);
		if (visited.has(physicalKey)) continue;
		visited.add(physicalKey);
		const manifest = readPackage(packageRoot);
		const dependencyGroups = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies];
		const optionalPeers = manifest.peerDependenciesMeta ?? {};
		for (const group of dependencyGroups) {
			for (const name of Object.keys(group ?? {})) {
				const dependencyRoot = resolveDependency(root, packageRoot, name);
				if (dependencyRoot === null) {
					if (group === manifest.optionalDependencies || optionalPeers[name]?.optional === true) continue;
					throw new Error(`${manifest.name ?? packageRoot} requires missing runtime dependency ${name}`);
				}
				const relativeDependency = relative(root, dependencyRoot).split(sep).join("/");
				reachable.add(relativeDependency);
				queue.push(dependencyRoot);
			}
		}
	}

	return [...installedRelative.keys()].filter((path) => !reachable.has(path)).sort();
}
