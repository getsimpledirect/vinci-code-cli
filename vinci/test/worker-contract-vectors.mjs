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
import { parsePathGrant } from "../worker/contracts/path-grant.mjs";

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

// path-grant-cases.json: the SHARED golden cases for the `path:` grant grammar, copied byte for
// byte from vinci-contracts @ 9e9a105 (packages/work-orders/vectors/path-grant-cases.json), where
// src/path-grant.test.ts reads the same file. Consuming it here is what stops the vendored port
// (vinci/worker/contracts/path-grant.mjs) and the TypeScript original from drifting apart: a rule
// changed on one side and not the other fails on whichever side did not move.
const pathCases = JSON.parse(readFileSync(join(VECTORS, "path-grant-cases.json"), "utf8"));
assert.ok(Array.isArray(pathCases.accepted) && pathCases.accepted.length > 0, "path-grant-cases.json carries accepted cases");
assert.ok(Array.isArray(pathCases.refused) && pathCases.refused.length > 0, "path-grant-cases.json carries refused cases");
for (const { token, root, kind } of pathCases.accepted) {
  const parsed = parsePathGrant(token);
  assert.ok(parsed !== null, `${token}: a path: token must parse as a path grant`);
  assert.deepEqual(parsed, { ok: true, value: { root, kind } }, `${token}: accepted as ${kind} ${root}`);
}
for (const { token, reason } of pathCases.refused) {
  assert.deepEqual(parsePathGrant(token), { ok: false, reason }, `${token}: refused as ${reason}`);
}
// Non-`path:` tokens are NOT this grammar's business: prose and the other prefixes parse as null
// so validateWorkOrder leaves them exactly as before.
for (const token of ["edit files under src/api", "tool:bash", "repo:github.com/o/n", "branch:feat/*", "bogus:whatever", "", 7, null]) {
  assert.equal(parsePathGrant(token), null, `${JSON.stringify(token)} is not a path: grant`);
}
// too_long is a boundary the shared file does not spell out (1024 characters of root).
assert.deepEqual(parsePathGrant(`path:${"a".repeat(1024)}`), { ok: true, value: { root: "a".repeat(1024), kind: "file" } }, "1024 characters is accepted");
assert.deepEqual(parsePathGrant(`path:${"a".repeat(1025)}`), { ok: false, reason: "too_long" }, "1025 characters is too_long");
// The `monotonicity` section stays UNCONSUMED on purpose: the worker vendors the path grammar
// only (so a malformed grant invalidates the order) and does NOT yet vendor path scopes — an
// execution spec carrying `paths` is refused as unknown_field, so there is no coverage question
// to answer. Port pathRootCovers and consume this section when the worker learns write scopes.
assert.ok(Array.isArray(pathCases.monotonicity) && pathCases.monotonicity.length > 0, "the monotonicity section exists (unconsumed: see above)");

console.log(`PASS worker-contract-vectors (${directories.length} vectors, ${floats.length} float cases, ${pathCases.accepted.length + pathCases.refused.length} path-grant cases)`);
