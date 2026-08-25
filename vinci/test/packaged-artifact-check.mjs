#!/usr/bin/env node
// Verify a PACKAGED Vinci artifact can actually load — the one thing the offline harness
// structurally cannot check, because the harness runs from the repo where every source path
// resolves.
//
// 0.0.31 shipped broken: #46 added an import from `vinci/extensions/lib/verification-state.ts`
// to `packages/coding-agent/src/core/vinci-grader.ts`. That file exists in the repo but the
// tarball ships only `packages/coding-agent/dist` — so the extension failed to load and the CLI
// died at startup. Full harness green, both CI legs green, 50 live campaign runs green: every
// gate ran from the repo, so none of them could see it.
//
// Usage:  node vinci/test/packaged-artifact-check.mjs <unpacked-artifact-root>
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error("usage: packaged-artifact-check.mjs <unpacked-artifact-root>");
  process.exit(2);
}

// Every relative specifier the shipped extension layer resolves at RUNTIME. Bare specifiers
// (node:, package names) are resolved by node/jiti and are out of scope here.
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+["'](\.[^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(path, out);
    } else if (/\.(ts|mjs|js)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const extensionsRoot = join(root, "vinci", "extensions");
if (!existsSync(extensionsRoot)) {
  console.error(`✗ packaged artifact has no vinci/extensions: ${extensionsRoot}`);
  process.exit(1);
}

const failures = [];
let checked = 0;

for (const file of walk(extensionsRoot)) {
  const source = readFileSync(file, "utf8");
  const specifiers = [
    ...[...source.matchAll(RELATIVE_IMPORT)].map((m) => m[1]),
    ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]),
  ];
  for (const specifier of specifiers) {
    checked += 1;
    const base = resolve(dirname(file), specifier);
    // A TS specifier may point at .ts that ships as .ts, or at built .js next to a .d.ts.
    const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.js")];
    if (candidates.some((candidate) => existsSync(candidate))) continue;
    failures.push(`${file.slice(root.length + 1)} -> ${specifier} (resolved ${base.slice(root.length + 1)})`);
  }
}

if (failures.length > 0) {
  console.error(`✗ packaged artifact: ${failures.length} unresolvable import(s) in the shipped extension layer`);
  console.error("  These load at runtime, so the CLI will fail to start:");
  for (const failure of failures) console.error(`    ${failure}`);
  console.error("\n  Most likely cause: an extension imports from packages/*/src, which is NOT shipped.");
  console.error("  Import the built module under packages/*/dist instead.");
  process.exit(1);
}

console.log(`  ✓ packaged artifact: ${checked} relative imports in vinci/extensions all resolve inside the tarball`);
