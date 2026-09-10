// PROPOSAL, not a landed capability. Nothing calls this yet; wiring it into
// materializeEnvelope and the spawn path is the contract owner's decision.
//
// `ExecutionSpec.inputArtifacts` is `{id, digest}[]`. It is digest-bound (the
// whole record feeds executionSpecDigest, and canonicalize walks every key),
// and task.mjs records it verbatim with the comment "no fetch in Wave 1B
// scope". So the contract can already NAME an input the worker must consume,
// and nothing can deliver one.
//
// THE THING THIS MODULE EXISTS FOR: {id, digest} establishes IDENTITY, not
// LOCATION. Between "the contract named this input" and "the worker consumed
// it" sit four steps, each of which can substitute something else:
//
//   requested    the digest ExecutionSpec named
//   resolved     WHICH storage object an AUTHORITY says carries it
//   downloaded   the digest of the bytes that actually arrived
//   materialized the digest of what was written into the workspace
//
// A system whose purpose is improving its own context is exactly where a
// self-certification loop hides, so every link is recorded and every link
// must agree.
//
// TWO IDENTITIES, CHECKED SEPARATELY. The artifact ledger says "these bytes
// are object X" (its own recorded sha256). The execution contract says "the
// input this worker expects has digest Y". Ideally X === Y, but they are
// distinct claims from distinct sources, and letting one pass because the
// other did is how a swap survives. Both are asserted explicitly.
//
// THE WORKER NEVER RESOLVES AN ID ITSELF. `id` is an identifier by
// vinci-contracts' grammar -- it cannot contain "/" -- but that only means it
// is not traversal-shaped. It carries no location semantics whatsoever, and
// no registry backs it. So the id goes to an AUTHORITY, which returns a
// pointer; the worker never treats the id as a path, a URL, or a filename.
// The on-disk name is derived from the DIGEST, not from anything the spec
// author chose.
//
// Modelled on the one existing precedent in the fleet, `vgc artifacts pull`:
// resolve id -> looked-up uri -> fetch -> verify sha256 AFTER download.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isIdentifier } from "./contracts/digest.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

// A context packet is prose and JSON. This ceiling is not a policy about
// artifacts in general -- it is the bound on what this consumer will pull
// into a prompt, and a larger input is a refusal rather than a slow fetch.
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export class InputArtifactError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new InputArtifactError(code, message);
};

export function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. The contract's own claim.
// ---------------------------------------------------------------------------

export function validateInputArtifact(entry, index) {
  const at = `inputArtifacts[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    refuse("invalid_input_artifact", `${at} is an object`);
  }
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys[0] !== "digest" || keys[1] !== "id") {
    refuse("invalid_input_artifact", `${at} carries exactly {id, digest}, got {${keys.join(", ")}}`);
  }
  if (!isIdentifier(entry.id)) {
    refuse("invalid_input_artifact", `${at}/id is not an identifier`);
  }
  if (typeof entry.digest !== "string" || !HEX64.test(entry.digest)) {
    refuse("invalid_input_artifact", `${at}/digest is a lowercase sha256 hex digest`);
  }
  return { id: entry.id, digest: entry.digest };
}

// ---------------------------------------------------------------------------
// 2. The authority's answer. The worker asks; it does not decide.
// ---------------------------------------------------------------------------

// The pointer shape vinci-gpu-control's artifacts ledger already emits:
// {artifact_id, job_id, uri, bytes, sha256, created_at}. Only the four fields
// this consumer needs are read, and the rest are ignored rather than trusted.
export function validatePointer(pointer, artifact) {
  // An authority may answer with a list. Nothing establishes that artifact
  // ids form a globally unique namespace -- the investigation behind this
  // module found no registry semantics at all -- so more than one match is
  // a refusal, never a pick-the-newest. Choosing by recency is how the
  // wrong artifact arrives with every digest check passing.
  if (Array.isArray(pointer)) {
    if (pointer.length !== 1) {
      refuse(
        "ambiguous_pointer",
        `the authority returned ${pointer.length} pointer records for ${artifact.id}; artifact ids are not known to be globally unique, so this is unresolvable rather than a choice`,
      );
    }
    pointer = pointer[0];
  }
  if (pointer === null || typeof pointer !== "object") {
    refuse("pointer_invalid", `no pointer record for artifact ${artifact.id}`);
  }
  if (pointer.artifact_id !== artifact.id) {
    refuse("pointer_invalid", `pointer names artifact ${JSON.stringify(pointer.artifact_id)}, asked for ${JSON.stringify(artifact.id)}`);
  }
  if (typeof pointer.uri !== "string" || !pointer.uri.trim()) {
    refuse("pointer_invalid", `pointer for ${artifact.id} carries no uri`);
  }
  if (typeof pointer.sha256 !== "string" || !HEX64.test(pointer.sha256)) {
    refuse("pointer_invalid", `pointer for ${artifact.id} carries no sha256`);
  }
  if (!Number.isInteger(pointer.bytes) || pointer.bytes < 0) {
    refuse("pointer_invalid", `pointer for ${artifact.id} carries no byte count`);
  }
  // IDENTITY 1 vs IDENTITY 2. The ledger says the object holds these bytes;
  // the contract says the input has that digest. Disagreement means the two
  // authorities name different content, and downloading either one would be
  // a guess about which is right.
  if (pointer.sha256 !== artifact.digest) {
    refuse(
      "identity_disagreement",
      `the artifact ledger says ${artifact.id} is ${pointer.sha256.slice(0, 12)}… but the execution contract expects ${artifact.digest.slice(0, 12)}…; these are different claims from different authorities and neither one settles the other`,
    );
  }
  return { uri: pointer.uri, bytes: pointer.bytes, sha256: pointer.sha256 };
}

// ---------------------------------------------------------------------------
// 3. Resolve, fetch, verify, materialize.
// ---------------------------------------------------------------------------

/**
 * Resolve one declared input artifact into verified local bytes.
 *
 * `lookup(id) -> pointer` and `download(uri, {maxBytes}) -> Uint8Array` are
 * injected. Both defaults live at the call site rather than here, because
 * the authority endpoint and the object-store client are deployment
 * concerns and this module must stay testable without either.
 *
 * Returns the delivery chain, which is the evidence vinci-gpu-control's
 * `input delivery observation` consumes. Every stage is reported, including
 * the ones that did not happen.
 */
export async function resolveInputArtifact(artifact, { lookup, download, destDir, maxBytes = DEFAULT_MAX_BYTES, readBack = readFileSync }) {
  const chain = {
    artifact_id: artifact.id,
    requested_input_digest: artifact.digest,
    resolved_storage_object: null,
    downloaded_digest: null,
    materialized_digest: null,
    materialized_path: null,
  };

  // The resolver is asked for id AND expected digest. Sending only the id
  // would require artifact ids to be globally unique, which nothing
  // establishes; the digest lets the authority disambiguate rather than
  // guess, and lets it refuse rather than return the wrong subject.
  const pointer = validatePointer(await lookup(artifact.id, artifact.digest), artifact);
  chain.resolved_storage_object = pointer.uri;

  if (pointer.bytes > maxBytes) {
    refuse("artifact_too_large", `${artifact.id} is ${pointer.bytes} bytes, over the ${maxBytes}-byte ceiling for a worker input`);
  }

  const bytes = await download(pointer.uri, { maxBytes });
  if (!(bytes instanceof Uint8Array)) {
    refuse("download_invalid", `download of ${artifact.id} returned ${typeof bytes}, not bytes`);
  }
  // A short read is not a small file. The ledger recorded a length; bytes
  // that stop early hash to something else and would be caught below, but
  // naming the actual failure beats reporting a digest mismatch for it.
  if (bytes.byteLength !== pointer.bytes) {
    refuse("download_truncated", `${artifact.id} downloaded ${bytes.byteLength} bytes, the ledger recorded ${pointer.bytes}`);
  }
  chain.downloaded_digest = sha256OfBytes(bytes);
  if (chain.downloaded_digest !== artifact.digest) {
    refuse(
      "digest_mismatch",
      `${artifact.id} downloaded as ${chain.downloaded_digest.slice(0, 12)}… but the execution contract named ${artifact.digest.slice(0, 12)}…; this is a substitution, not a delivery`,
    );
  }

  // CONTENT-ADDRESSED LOCAL NAME. Not the id, not anything from the uri:
  // both are strings someone else chose, and a filename is a place. The
  // digest is the only name here that the bytes themselves prove.
  const finalPath = join(destDir, `${artifact.digest}.input`);
  const tempPath = `${finalPath}.partial`;
  // The destination is private BEFORE anything is written into it, so the
  // partial file is never reachable by another user even briefly.
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  chmodSync(destDir, 0o700);

  // PERMISSION BEFORE PUBLICATION. An earlier version wrote, renamed, then
  // chmod-ed -- which leaves an interval where the FINAL pathname exists
  // and is still writable. Tests do not normally observe that interleaving,
  // which is exactly why a mutation of the write mode survived: the ordering
  // was the load-bearing part and nothing was checking it. Every narrowing
  // now happens on the TEMP path, and the rename publishes something that is
  // already read-only.
  writeFileSync(tempPath, bytes, { mode: 0o400 });
  const handle = openSync(tempPath, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  chmodSync(tempPath, 0o400);
  // Verify identity while it is still unpublished: a temp file that does not
  // hash correctly must never acquire the final name at all.
  const stagedDigest = sha256OfBytes(readBack(tempPath));
  if (stagedDigest !== artifact.digest) {
    refuse("materialization_mismatch", `${artifact.id} staged as ${stagedDigest.slice(0, 12)}…, not ${artifact.digest.slice(0, 12)}…`);
  }
  renameSync(tempPath, finalPath);
  const dirHandle = openSync(destDir, "r");
  try {
    fsyncSync(dirHandle);
  } catch {
    // Directory fsync is not portable everywhere; the rename is still
    // atomic, so this is durability hardening rather than a correctness
    // step, and failing it must not fail the delivery.
  } finally {
    closeSync(dirHandle);
  }

  // Re-read from disk rather than re-hashing the buffer we already have.
  // Hashing the in-memory copy would prove the download and call it the
  // materialization -- the two are only the same claim if nothing went
  // wrong between them, which is the thing being checked.
  // Re-read the PUBLISHED path. Hashing the buffer we already have would
  // prove the download and label it the materialization; they are the same
  // claim only if nothing went wrong in between, which is the thing being
  // checked. A mutation that hashes `bytes` here survived every test until
  // this seam existed.
  chain.materialized_digest = sha256OfBytes(readBack(finalPath));
  if (chain.materialized_digest !== artifact.digest) {
    refuse("materialization_mismatch", `${artifact.id} materialized as ${chain.materialized_digest.slice(0, 12)}…, not ${artifact.digest.slice(0, 12)}…`);
  }
  chain.materialized_path = finalPath;
  return chain;
}

/**
 * Resolve every declared input artifact, or refuse the task.
 *
 * All-or-nothing on purpose: a worker that ran with three of its four named
 * inputs would produce a result nobody could interpret, and the contract
 * digest covers the whole list.
 */
export async function resolveInputArtifacts(inputArtifacts, { lookup, download, destDir, maxBytes = DEFAULT_MAX_BYTES }) {
  // THE PRODUCTION ENTRY POINT ENUMERATES WHAT IT FORWARDS. `readBack` is a
  // test seam and must stay one: forwarding an options object wholesale
  // would let a caller supply the very function that decides what the
  // worker believes it materialized. Trusted code picks that
  // implementation, so it is not in this signature and cannot pass through
  // it. Callers only reach it by calling the lower-level function directly,
  // which production does not do.
  const options = { lookup, download, destDir, maxBytes };
  const declared = (inputArtifacts ?? []).map(validateInputArtifact);
  const seen = new Set();
  for (const artifact of declared) {
    if (seen.has(artifact.id)) {
      refuse("duplicate_input_artifact", `inputArtifacts names ${artifact.id} twice`);
    }
    seen.add(artifact.id);
  }
  const chains = [];
  for (const artifact of declared) {
    chains.push(await resolveInputArtifact(artifact, options));
  }
  return chains;
}
