#!/usr/bin/env bash
# Runtime import test for a PACKAGED Vinci artifact: unpack the tarball into a scratch directory
# and actually `import()` every shipped extension module, in an isolated Node process with a
# clean environment and the tarball's own node_modules. This is the check that reproduces the
# 0.0.51 failure (`ERR_MODULE_NOT_FOUND @getsimpledirect/vinci-contracts`): the static resolver in
# vinci/test/packaged-artifact-check.mjs only follows RELATIVE specifiers, and `vinci --version`
# returns 0 without loading any extension, so a bare package missing from the tarball's
# node_modules passed every gate in vinci-release.yml.
#
# Mirrors vinci/bin/vinci's choice of extension layer: `vinci/dist/extensions/*.js` when the
# tarball ships compiled extensions (native ESM import), else `vinci/extensions/*.ts` through the
# tarball's own jiti (the same loader the coding agent uses at runtime).
#
# Usage:  vinci/scripts/check-packaged-extensions-load.sh <vinci-code-X.Y.Z.tgz>
# Exit:   0 every module imported; 1 at least one module failed (each is listed); 2 usage/setup.
#
# NOTE (2026-08-28): a sibling SEV-1 branch is adding a similar check to the release pipeline. At
# the time of writing no such script was visible on origin, so this file was created here; if the
# two converge, keep ONE script with this name and contract.
set -euo pipefail

TGZ="${1:-}"
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "usage: $0 <vinci-code-X.Y.Z.tgz>" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vinci-ext-load.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root" "$WORK/home"
tar -xzf "$TGZ" -C "$WORK/root"

cd "$WORK/root"
# Clean environment: no NODE_OPTIONS, no NODE_PATH, no repo-local .env — only the tarball's own
# resolution. Nothing here contacts the network; a module import that needs one is itself a bug.
# Not exec'd so the EXIT trap above still removes the scratch directory.
env -i PATH="$PATH" HOME="$WORK/home" node --input-type=module - <<'EOF'
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const distDir = join(root, "vinci", "dist", "extensions");
const srcDir = join(root, "vinci", "extensions");

function list(dir, test) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(test).sort().map((f) => join(dir, f));
}

let files;
let load;
let layer;
if (existsSync(distDir)) {
  layer = "vinci/dist/extensions (compiled, native ESM import)";
  const isJs = (f) => f.endsWith(".js");
  files = [...list(distDir, isJs), ...list(join(distDir, "lib"), isJs)];
  load = (file) => import(pathToFileURL(file).href);
} else {
  layer = "vinci/extensions (TypeScript via the tarball's jiti)";
  const isTs = (f) => f.endsWith(".ts") && !f.endsWith(".d.ts");
  files = [...list(srcDir, isTs), ...list(join(srcDir, "lib"), isTs)];
  const jitiEntry = join(root, "node_modules", "jiti", "lib", "jiti.mjs");
  if (!existsSync(jitiEntry)) {
    console.error(`✗ tarball ships TypeScript extensions but no node_modules/jiti: ${jitiEntry}`);
    process.exit(2);
  }
  const { createJiti } = await import(pathToFileURL(jitiEntry).href);
  // The runtime loader aliases the workspace packages to their built entry points.
  const alias = {};
  for (const [name, dir] of [
    ["@mariozechner/pi-coding-agent", "coding-agent"],
    ["@mariozechner/pi-ai", "ai"],
    ["@mariozechner/pi-tui", "tui"],
    ["@mariozechner/pi-agent-core", "agent"],
  ]) {
    const entry = join(root, "packages", dir, "dist", "index.js");
    if (existsSync(entry)) alias[name] = entry;
  }
  const jiti = createJiti(pathToFileURL(join(srcDir, "_probe.ts")).href, { moduleCache: false, alias });
  load = (file) => jiti.import(file);
}

if (files.length === 0) {
  console.error(`✗ no extension modules found under ${layer}`);
  process.exit(2);
}

console.log(`extension layer: ${layer}`);
const failures = [];
for (const file of files) {
  const rel = file.slice(root.length + 1);
  try {
    await load(file);
  } catch (error) {
    const first = String(error && error.message ? error.message : error).split("\n")[0];
    failures.push(`${rel}: ${error && error.code ? `${error.code} ` : ""}${first}`);
  }
}
for (const f of failures) console.log(`✗ ${f}`);
console.log(`${files.length} modules checked, ${failures.length} failed to import`);
process.exit(failures.length === 0 ? 0 : 1);
EOF
