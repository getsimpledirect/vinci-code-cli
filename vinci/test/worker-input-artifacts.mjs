// The resolver must deliver the bytes the CONTRACT named, or refuse. Every
// refusal below is paired with the legitimate case through the same call, so
// a guard that fires on everything is visible as one.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  InputArtifactError,
  resolveInputArtifact,
  resolveInputArtifacts,
  sha256OfBytes,
  validateInputArtifact,
  validatePointer,
} from "../worker/input-artifacts.mjs";

const BYTES = new TextEncoder().encode("accepted findings context packet v1");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
// SAME LENGTH as BYTES, deliberately. The first version of this fixture used
// a shorter string, so the length check fired first and the digest-mismatch
// test never reached the guard it names -- earlier-guard masking inside the
// test for a module whose whole job is catching substitutions.
const OTHER = new TextEncoder().encode("accepted findings context packet v2");
const OTHER_DIGEST = createHash("sha256").update(OTHER).digest("hex");
const URI = "s3://vgc-artifacts/ctx/9f2.tgz";

// A destDir the resolver must CREATE. mkdtempSync already makes 0o700
// directories, so handing one straight to the resolver meant the
// directory-privacy assertion could never discriminate -- the fixture was
// doing the thing under test.
const dest = () => join(mkdtempSync(join(tmpdir(), `input-artifacts-${randomUUID()}-`)), "inputs");
const artifact = (over = {}) => ({ id: "accepted-findings-context", digest: DIGEST, ...over });
const pointer = (over = {}) => ({
  artifact_id: "accepted-findings-context",
  job_id: "job_producer",
  uri: URI,
  bytes: BYTES.byteLength,
  sha256: DIGEST,
  created_at: "2026-09-09T12:00:00Z",
  ...over,
});

const NAMESPACE = ["s3://vgc-artifacts/"];

const opts = (over = {}) => ({
  lookup: async () => pointer(),
  download: async () => BYTES,
  destDir: dest(),
  allowedUriPrefixes: NAMESPACE,
  ...over,
});

async function refuses(code, run, what) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof InputArtifactError, `${what}: expected an InputArtifactError, got ${error}`);
    assert.equal(error.code, code, `${what}: expected code ${code}, got ${error.code}`);
    return error;
  }
  assert.fail(`${what}: expected a refusal (${code}) and none came`);
}

// --- the good path, first --------------------------------------------------

{
  const chain = await resolveInputArtifact(artifact(), opts());
  assert.equal(chain.requested_input_digest, DIGEST);
  assert.equal(chain.resolved_storage_object, URI);
  assert.equal(chain.downloaded_digest, DIGEST);
  assert.equal(chain.materialized_digest, DIGEST);
  assert.ok(chain.materialized_path.endsWith(`${DIGEST}.input`));
  assert.equal(readFileSync(chain.materialized_path, "utf8"), "accepted findings context packet v1");
}

// The local name is the DIGEST, never the id and never anything from the uri.
{
  const chain = await resolveInputArtifact(
    artifact({ id: "totally-different-name" }),
    opts({ lookup: async () => pointer({ artifact_id: "totally-different-name" }) }),
  );
  assert.ok(chain.materialized_path.endsWith(`${DIGEST}.input`));
  assert.ok(!chain.materialized_path.includes("totally-different-name"));
  assert.ok(!chain.materialized_path.includes("9f2"));
}

// Materialized read-only: a task that can rewrite its own input can rewrite
// the evidence of what it was given.
{
  const chain = await resolveInputArtifact(artifact(), opts());
  assert.equal(statSync(chain.materialized_path).mode & 0o777, 0o400);
}

// The materialization claim must come from DISK, not from the buffer we
// already hashed. Hashing `bytes` here would prove the download twice and
// call the second one a materialization.
{
  await refuses(
    "materialization_mismatch",
    () => resolveInputArtifact(artifact(), opts({ readBack: () => OTHER })),
    "a file on disk that differs from what was downloaded",
  );
  // positive control: the honest read-back resolves.
  assert.ok(await resolveInputArtifact(artifact(), opts({ readBack: readFileSync })));
}

// --- the contract's own claim ----------------------------------------------

assert.deepEqual(validateInputArtifact(artifact(), 0), { id: artifact().id, digest: DIGEST });
for (const [bad, why] of [
  [{ id: "x", digest: DIGEST, extra: 1 }, "an extra key"],
  [{ id: "x" }, "a missing digest"],
  [{ id: "../etc/passwd", digest: DIGEST }, "a traversal-shaped id"],
  [{ id: "a/b", digest: DIGEST }, "a path-shaped id"],
  [{ id: "x", digest: "not-a-digest" }, "a malformed digest"],
  [{ id: "x", digest: DIGEST.toUpperCase() }, "an uppercase digest"],
]) {
  await refuses("invalid_input_artifact", async () => validateInputArtifact(bad, 0), why);
}

// --- the two identities, checked separately --------------------------------

// This is the case that motivates the whole module: the ledger and the
// contract each name content, and neither settles the other.
{
  const error = await refuses(
    "identity_disagreement",
    () => resolveInputArtifact(artifact(), opts({ lookup: async () => pointer({ sha256: OTHER_DIGEST }) })),
    "ledger and contract naming different content",
  );
  assert.match(error.message, /different claims from different authorities/);
  // positive control: they agree, and it resolves.
  assert.ok(await resolveInputArtifact(artifact(), opts()));
}

for (const [over, code, why] of [
  [{ artifact_id: "some-other-artifact" }, "pointer_invalid", "a pointer for a different artifact"],
  [{ uri: "" }, "pointer_invalid", "a pointer with no uri"],
  [{ sha256: "nope" }, "pointer_invalid", "a pointer with no digest"],
  [{ bytes: -1 }, "pointer_invalid", "a negative byte count"],
  [{ bytes: 1.5 }, "pointer_invalid", "a non-integer byte count"],
]) {
  await refuses(code, () => resolveInputArtifact(artifact(), opts({ lookup: async () => pointer(over) })), why);
}
await refuses("pointer_invalid", () => resolveInputArtifact(artifact(), opts({ lookup: async () => null })), "no pointer at all");

// --- verify AFTER download, not before -------------------------------------

{
  const error = await refuses(
    "digest_mismatch",
    () => resolveInputArtifact(
      artifact(),
      // The authority answers correctly and the STORE serves other bytes.
      // Nothing before this point can catch that.
      opts({ download: async () => OTHER }),
    ),
    "the store serving different bytes than the ledger promised",
  );
  assert.match(error.message, /substitution, not a delivery/);
}

{
  await refuses(
    "download_length_mismatch",
    () => resolveInputArtifact(artifact(), opts({ download: async () => BYTES.slice(0, 5) })),
    "a short read",
  );
}

await refuses(
  "download_invalid",
  () => resolveInputArtifact(artifact(), opts({ download: async () => "a string" })),
  "a download that is not bytes",
);

// --- bounded ---------------------------------------------------------------

await refuses(
  "artifact_too_large",
  () => resolveInputArtifact(artifact(), opts({ lookup: async () => pointer({ bytes: DEFAULT_MAX_BYTES + 1 }) })),
  "an artifact over the ceiling",
);
{
  // positive control: exactly at the ceiling is allowed, and the ceiling is
  // a refusal rather than a slow fetch.
  const big = new Uint8Array(64);
  const bigDigest = sha256OfBytes(big);
  assert.ok(await resolveInputArtifact(
    artifact({ digest: bigDigest }),
    opts({
      lookup: async () => pointer({ sha256: bigDigest, bytes: 64 }),
      download: async () => big,
      maxBytes: 64,
    }),
  ));
}

// The ceiling is enforced BEFORE the fetch, so an oversized object is never
// pulled down to discover it was oversized.
{
  let downloaded = false;
  await refuses(
    "artifact_too_large",
    () => resolveInputArtifact(artifact(), opts({
      lookup: async () => pointer({ bytes: DEFAULT_MAX_BYTES + 1 }),
      download: async () => { downloaded = true; return BYTES; },
    })),
    "an oversized artifact",
  );
  assert.equal(downloaded, false, "the ceiling must refuse before the fetch, not after");
}

// --- the list --------------------------------------------------------------

{
  const chains = await resolveInputArtifacts([artifact()], opts());
  assert.equal(chains.length, 1);
  assert.equal(chains[0].materialized_digest, DIGEST);
}
assert.deepEqual(await resolveInputArtifacts([], opts()), [], "no declared inputs is a valid state");
assert.deepEqual(await resolveInputArtifacts(undefined, opts()), [], "an absent list is a valid state");

await refuses(
  "duplicate_input_artifact",
  () => resolveInputArtifacts([artifact(), artifact()], opts()),
  "the same artifact declared twice",
);

// All-or-nothing: one bad entry refuses the task rather than delivering the
// rest. A worker running with three of its four named inputs produces a
// result nobody can interpret.
{
  const good = artifact();
  const bad = artifact({ id: "second-input", digest: OTHER_DIGEST });
  await refuses(
    "identity_disagreement",
    () => resolveInputArtifacts([good, bad], opts({
      lookup: async (id) => (id === good.id ? pointer() : pointer({ artifact_id: "second-input", sha256: DIGEST })),
    })),
    "one of two inputs disagreeing",
  );
}

// --- the pointer validator in isolation ------------------------------------

assert.deepEqual(validatePointer(pointer(), artifact(), NAMESPACE), { uri: URI, bytes: BYTES.byteLength, sha256: DIGEST });

console.log("worker-input-artifacts: all controls passed");

// --- corrections from review ------------------------------------------------

// PERMISSION BEFORE PUBLICATION. Concluding that the write mode was useless
// because the final mode was chmod-ed was the wrong lesson: the ordering was
// load-bearing and nothing tested it. The final pathname must never exist
// writable, even briefly, so every narrowing happens on the temp path and the
// rename publishes something already read-only.
{
  const seen = [];
  const chain = await resolveInputArtifact(artifact(), opts({
    // Observe the mode of the file at the moment it is read back, i.e. after
    // staging and before/at publication.
    readBack: (path) => {
      seen.push({ path, mode: statSync(path).mode & 0o777 });
      return BYTES;
    },
  }));
  // The staged file is already 0o400 when its identity is verified, BEFORE
  // it ever acquires the final name.
  const staged = seen.find((s) => s.path.endsWith(".partial"));
  assert.ok(staged, "identity must be verified while the file is still unpublished");
  assert.equal(staged.mode, 0o400, "the temp file must be read-only before it is published");
  // And the published file is read-only too.
  assert.equal(statSync(chain.materialized_path).mode & 0o777, 0o400);
  // The containing directory is private BEFORE anything is written into it,
  // so the partial file is never reachable by another user even briefly.
  assert.equal(statSync(dirname(chain.materialized_path)).mode & 0o777, 0o700);
}

// A staged file whose bytes do not hash correctly never acquires the final
// name at all -- it is refused while still unpublished.
{
  const destDir = dest();
  let readCount = 0;
  await refuses(
    "materialization_mismatch",
    () => resolveInputArtifact(artifact(), opts({
      destDir,
      readBack: (path) => { readCount += 1; return path.endsWith(".partial") ? OTHER : BYTES; },
    })),
    "a staged file that does not hash correctly",
  );
  assert.equal(readCount, 1, "the refusal must happen at staging, before publication");
  assert.throws(() => statSync(join(destDir, `${DIGEST}.input`)), "the final name must not exist");
}

// --- id + digest, and ambiguity fails closed --------------------------------

// The resolver is asked for BOTH. Sending only the id would require artifact
// ids to be globally unique, which nothing establishes.
{
  const asked = [];
  await resolveInputArtifact(artifact(), opts({
    lookup: async (id, digest) => { asked.push([id, digest]); return pointer(); },
  }));
  assert.deepEqual(asked, [["accepted-findings-context", DIGEST]]);
}

// More than one match is unresolvable, not a choice. Picking the newest is
// how the wrong artifact arrives with every digest check passing.
for (const [answer, why] of [
  [[pointer(), pointer({ uri: "s3://other/obj.tgz" })], "two matching pointers"],
  [[], "an empty pointer list"],
]) {
  await refuses("ambiguous_pointer", () => resolveInputArtifact(artifact(), opts({ lookup: async () => answer })), why);
}
// positive control: a single-element list resolves exactly like a bare object.
{
  const chain = await resolveInputArtifact(artifact(), opts({ lookup: async () => [pointer()] }));
  assert.equal(chain.materialized_digest, DIGEST);
}

// --- the read-back seam is not caller-controlled in production --------------

// resolveInputArtifacts is the production entry point. A caller must not be
// able to supply the function that decides what the worker believes it
// materialized, so the seam does not pass through it.
{
  let injected = false;
  const chains = await resolveInputArtifacts([artifact()], {
    ...opts(),
    readBack: () => { injected = true; return OTHER; },
  });
  assert.equal(injected, false, "readBack must not be forwardable through the production entry point");
  assert.equal(chains[0].materialized_digest, DIGEST);
}

console.log("worker-input-artifacts: review corrections passed");

// --- the download trust boundary -------------------------------------------

// An authority that can SELECT an object does not thereby gain arbitrary
// network-fetch authority. The pointer decides where this worker goes.
{
  // positive control: inside the qualified namespace, it resolves.
  assert.ok(await resolveInputArtifact(artifact(), opts()));

  for (const [uri, why] of [
    ["s3://someone-elses-bucket/obj.tgz", "another bucket"],
    ["https://evil.example/obj.tgz", "an http endpoint"],
    ["file:///etc/passwd", "a local file url"],
    ["http://169.254.169.254/latest/meta-data/", "a link-local metadata address"],
    ["s3://vgc-artifacts-evil/obj.tgz", "a prefix-adjacent bucket name"],
    // The namespace must be a PREFIX, not a substring. Every case above
    // fails a substring test too, so none of them could tell `startsWith`
    // from `includes` -- a mutation to `includes` survived until these.
    ["https://evil.example/redirect?to=s3://vgc-artifacts/obj.tgz", "the namespace as a query parameter"],
    ["s3://attacker-bucket/s3://vgc-artifacts/obj.tgz", "the namespace buried in a key"],
  ]) {
    await refuses(
      "uri_outside_namespace",
      () => resolveInputArtifact(artifact(), opts({ lookup: async () => pointer({ uri }) })),
      why,
    );
  }
}

// No allowlist is a refusal, not a pass. A permissive default would make the
// trust boundary invisible at the call site, which is the one place it has
// to be visible.
for (const missing of [undefined, [], null, "s3://vgc-artifacts/"]) {
  await refuses(
    "no_uri_allowlist",
    () => resolveInputArtifact(artifact(), { ...opts(), allowedUriPrefixes: missing }),
    `an allowlist of ${JSON.stringify(missing)}`,
  );
}

// The namespace reaches the primitive through the PRODUCTION entry point too,
// so wiring cannot accidentally drop it and get a permissive fetch.
await refuses(
  "uri_outside_namespace",
  () => resolveInputArtifacts([artifact()], { ...opts(), lookup: async () => pointer({ uri: "s3://elsewhere/x" }) }),
  "an out-of-namespace pointer through the production entry point",
);

// --- execution-atomic, NOT materialization-atomic ---------------------------

// The honest property, asserted rather than described: a refusal on the
// second artifact leaves the first one materialized. That residue is
// verified and immutable, but it exists -- calling this a transaction would
// be a claim the code does not implement.
{
  const destDir = dest();
  const first = artifact();
  const second = artifact({ id: "second-input", digest: OTHER_DIGEST });
  await refuses(
    "identity_disagreement",
    () => resolveInputArtifacts([first, second], {
      ...opts(),
      destDir,
      lookup: async (id) => (id === first.id ? pointer() : pointer({ artifact_id: "second-input", sha256: DIGEST })),
    }),
    "the second of two inputs disagreeing",
  );
  // The FIRST artifact is on disk. This is residue, not rollback.
  assert.equal(statSync(join(destDir, `${DIGEST}.input`)).mode & 0o777, 0o400,
    "the earlier artifact stays materialized: execution-atomic, not materialization-atomic");
}

console.log("worker-input-artifacts: trust-boundary controls passed");

// --- symlink attack on the staging path (CRITICAL, found in review) --------

// Pre-place a symlink where the resolver will stage, pointing at a file
// OUTSIDE destDir. Before the fix: writeFileSync and chmodSync follow the
// link, so the victim was overwritten with the artifact bytes and forced to
// 0o400; renameSync does NOT follow, so the published "materialized" file
// became a symlink out of the sandbox; and the digest re-read followed it
// and matched, so the whole chain reported success.
{
  const root = mkdtempSync(join(tmpdir(), `symlink-${randomUUID()}-`));
  const destDir = join(root, "inputs");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const victim = join(root, "victim.txt");
  writeFileSync(victim, "ORIGINAL", { mode: 0o644 });
  // The deterministic name the resolver used before the fix.
  symlinkSync(victim, join(destDir, `${DIGEST}.input.partial`));

  const chain = await resolveInputArtifact(artifact(), opts({ destDir }));

  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL", "a file outside destDir must not be written through a symlink");
  assert.equal(statSync(victim).mode & 0o777, 0o644, "a file outside destDir must not be permission-clobbered");
  assert.equal(lstatSync(chain.materialized_path).isSymbolicLink(), false, "the published artifact must be a real file, not a link out of the sandbox");
  assert.equal(lstatSync(chain.materialized_path).isFile(), true);
  assert.equal(readFileSync(chain.materialized_path, "utf8"), "accepted findings context packet v1");
}

// The staging name is unpredictable, so it cannot be pre-created at all.
{
  const destDir = dest();
  await resolveInputArtifact(artifact(), opts({ destDir }));
  const names = readdirSync(destDir);
  assert.deepEqual(names, [`${DIGEST}.input`], "no residue, and the published name is digest-derived");
}
{
  // Two resolutions of the same artifact into one directory do not collide
  // on the staging path -- which a fixed `.partial` name would.
  const destDir = dest();
  await resolveInputArtifact(artifact(), opts({ destDir }));
  await resolveInputArtifact(artifact(), opts({ destDir }));
  assert.deepEqual(readdirSync(destDir), [`${DIGEST}.input`]);
}

// Exclusive create: anything already sitting at the staging path is a
// refusal, never something written through. The staging name is random, so
// this is exercised by driving the write at a path that already exists --
// the property is `flag: "wx"`, not the name.
{
  const destDir = dest();
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const squatted = join(destDir, "squatted.partial");
  writeFileSync(squatted, "squatter");
  assert.throws(
    () => writeFileSync(squatted, BYTES, { mode: 0o400, flag: "wx" }),
    (error) => error.code === "EEXIST",
    "exclusive create must refuse an occupied path rather than write through it",
  );
  // ...and the squatter is untouched, which is the point.
  assert.equal(readFileSync(squatted, "utf8"), "squatter");
}

// --- wrong-typed input is the module's own refusal, not a TypeError --------

for (const bad of [{}, "hello", 42, true]) {
  await refuses("invalid_input_artifact", () => resolveInputArtifacts(bad, opts()), `inputArtifacts of ${JSON.stringify(bad)}`);
}
assert.deepEqual(await resolveInputArtifacts(null, opts()), [], "null is still 'no declared inputs'");

// --- unanchored allowlist prefixes are refused -----------------------------

// `s3://vgc-artifacts` without the delimiter admits
// `s3://vgc-artifacts@evil.example/x`, which passes startsWith while a
// WHATWG parser reads host evil.example. Demonstrated in review.
await refuses(
  "unanchored_uri_prefix",
  () => resolveInputArtifact(artifact(), { ...opts(), allowedUriPrefixes: ["s3://vgc-artifacts"] }),
  "an unanchored prefix",
);
await refuses(
  "unanchored_uri_prefix",
  () => resolveInputArtifact(artifact(), {
    ...opts(),
    allowedUriPrefixes: ["s3://vgc-artifacts"],
    lookup: async () => pointer({ uri: "s3://vgc-artifacts@evil.example/x" }),
  }),
  "the userinfo-confusion URI its absence would have admitted",
);

console.log("worker-input-artifacts: ambient-capability controls passed");
