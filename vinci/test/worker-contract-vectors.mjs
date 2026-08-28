// The vendored canonicalizer + digest (vinci/worker/contracts/) must reproduce the golden vectors
// of vinci-contracts @ b2e0188b byte for byte: canonical.txt AND digest.txt for all six vectors,
// and every number in float-cases.json. A worker that computed a different digest from the
// Governor's would refuse every digest-form handoff (or, worse, accept a swapped one).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize } from "../worker/contracts/canonical.mjs";
import { executionSpecDigest, recordDigest, sha256Hex, workOrderDigest } from "../worker/contracts/digest.mjs";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "fixtures/contract-vectors");
const EXPECTED = [
  "execution-spec-1-minimal",
  "execution-spec-2-provider",
  "execution-spec-3-numbers",
  "work-order-1-minimal",
  "work-order-2-amended",
  "work-order-3-unicode",
];

const directories = readdirSync(VECTORS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
assert.deepEqual(directories, EXPECTED, "all six golden vectors must be present");

for (const name of directories) {
  const input = JSON.parse(readFileSync(join(VECTORS, name, "input.json"), "utf8"));
  const canonical = readFileSync(join(VECTORS, name, "canonical.txt"), "utf8");
  const digest = readFileSync(join(VECTORS, name, "digest.txt"), "utf8").trim();
  assert.match(digest, /^[0-9a-f]{64}$/, `${name}: digest.txt is a lowercase hex SHA-256`);
  assert.equal(canonicalize(input), canonical, `${name}: canonical bytes must equal canonical.txt`);
  // The digest is over the canonical bytes — assert both routes so a canonical match cannot hide
  // a digest computed over something else (e.g. JSON.stringify of the parsed input).
  assert.equal(sha256Hex(canonical), digest, `${name}: digest.txt is sha256 of canonical.txt`);
  const compute = name.startsWith("work-order") ? workOrderDigest : executionSpecDigest;
  assert.equal(compute(input), digest, `${name}: recomputed digest must equal digest.txt`);
  assert.equal(recordDigest(input), digest, `${name}: recordDigest agrees`);
  // Key order in input.json must not matter: a reversed-key copy digests identically.
  const reversed = JSON.parse(readFileSync(join(VECTORS, name, "input.json"), "utf8"), (key, value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value,
  );
  assert.equal(compute(reversed), digest, `${name}: key order must not change the digest`);
}

// float-cases.json: ES Number::toString formatting, pinned so the Python port and this port agree.
const floats = JSON.parse(readFileSync(join(VECTORS, "float-cases.json"), "utf8"));
assert.ok(Array.isArray(floats) && floats.length >= 11, "float-cases.json carries the cases");
for (const { input, canonical } of floats) {
  assert.equal(canonicalize(input), canonical, `float ${canonical}`);
  assert.equal(canonicalize({ n: input }), `{"n":${canonical}}`, `float ${canonical} inside an object`);
}

// The rules the port must keep beyond what the vectors exercise.
assert.equal(canonicalize({ b: 1, a: undefined, c: [undefined === 1, null] }), '{"b":1,"c":[false,null]}', "undefined omitted, null kept");
assert.equal(canonicalize({ "é": 1, "z": 2, "Z": 3, "a": 4 }), '{"Z":3,"a":4,"z":2,"é":1}', "keys sorted by UTF-16 code unit");
assert.equal(canonicalize("a b\"\\\n"), JSON.stringify("a b\"\\\n"), "strings escaped like JSON.stringify");
assert.throws(() => canonicalize(Number.NaN), /non-finite/, "NaN is refused");
assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), /non-finite/, "Infinity is refused");
assert.throws(() => canonicalize({ n: -Number.POSITIVE_INFINITY }), /non-finite/, "nested -Infinity is refused");
assert.throws(() => canonicalize(undefined), /type undefined/, "a bare undefined is refused");
assert.throws(() => canonicalize(() => 1), /type function/, "a function is refused");
assert.throws(() => canonicalize(10n), /type bigint/, "a bigint is refused");

console.log(`PASS worker-contract-vectors (${directories.length} vectors, ${floats.length} float cases)`);
