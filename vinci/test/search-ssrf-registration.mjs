import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harness = readFileSync(resolve(here, "run.sh"), "utf8");
const registration =
  'run_group search-ssrf node --experimental-strip-types "${ROOT}/vinci/extensions/vinci-search.test.mjs"';
const occurrences = harness.split(registration).length - 1;

assert.equal(
  occurrences,
  1,
  "the canonical harness must run the production-import SSRF test exactly once with TypeScript stripping",
);

console.log("search-ssrf-registration: canonical production-import lane is registered exactly once");
