#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const vinciRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = resolve(vinciRoot, "extensions");
const outputRoot = resolve(vinciRoot, "dist/extensions");

for (const moduleName of ["canonical-verdicts", "verification-contract", "verification-state"]) {
  await build({
    entryPoints: [resolve(extensionsRoot, `lib/${moduleName}.ts`)],
    outfile: resolve(outputRoot, `lib/${moduleName}.js`),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    logLevel: "warning",
  });
}

// Built extensions resolve "../identity.json" relative to themselves (vinci-feedback, vinci-issue),
// so the dist tree must carry the same identity file the sources see.
import { copyFileSync } from "node:fs";
copyFileSync(new URL("../identity.json", import.meta.url), new URL("../dist/identity.json", import.meta.url));
