import { execFileSync } from "node:child_process";

const root = process.argv[2];
if (!root) {
	throw new Error("Usage: package-excludes.mjs <repository-root>");
}

const tree = JSON.parse(
	execFileSync("npm", ["ls", "--omit=dev", "--json", "--depth=0"], {
		cwd: root,
		encoding: "utf8",
	}),
);

for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
	if (dependency && typeof dependency === "object" && dependency.extraneous === true) {
		process.stdout.write(`node_modules/${name}\n`);
	}
}
