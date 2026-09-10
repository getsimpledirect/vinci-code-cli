// The resolver must deliver the bytes the CONTRACT named, or refuse. Every
// refusal below is paired with the legitimate case through the same call, so
// a guard that fires on everything is visible as one.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const dest = () => mkdtempSync(join(tmpdir(), `input-artifacts-${randomUUID()}-`));
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

const opts = (over = {}) => ({
  lookup: async () => pointer(),
  download: async () => BYTES,
  destDir: dest(),
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
    "download_truncated",
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

assert.deepEqual(validatePointer(pointer(), artifact()), { uri: URI, bytes: BYTES.byteLength, sha256: DIGEST });

console.log("worker-input-artifacts: all controls passed");
