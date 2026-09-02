import { runtimePackageExcludes } from "./runtime-package-closure.mjs";

const root = process.argv[2];
if (!root) {
	throw new Error("Usage: package-excludes.mjs <repository-root>");
}

for (const path of runtimePackageExcludes(root)) process.stdout.write(`${path}\n`);
process.stdout.write("node_modules/.package-lock.json\n");
