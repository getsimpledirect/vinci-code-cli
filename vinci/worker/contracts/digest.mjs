// VENDORED BY COPY — do not edit here without re-syncing the source.
//   source:  vinci-contracts @ b2e0188b (PR #20)
//   files:   packages/work-orders/src/digest.ts (`sha256Hex`, `workOrderDigest`)
//            packages/work-orders/src/execution-spec.ts (`executionSpecDigest`)
// The identity of a work order or an execution spec: SHA-256, lowercase hex, over the canonical
// encoding (canonical.mjs) of the record. EVERYTHING the record carries is covered — there is no
// digest or signature field to exclude — so the digest names the exact contract or the exact run
// configuration, not "the same request at any version".
//
// The source functions validate the record before hashing and throw on an invalid one. The
// worker does not carry the two validators (it would be a second copy of a schema it does not
// own); it hashes the record the Governor served AS SERVED and compares that identity with the
// one it was handed. A served record whose bytes do not reproduce the handed digest is refused —
// which is the same fail-closed outcome the validator gives, reached from the other side.
import { createHash } from "node:crypto";

import { canonicalize } from "./canonical.mjs";

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 hex over the canonical encoding of `record` (a parsed JSON value). */
export function recordDigest(record) {
  return sha256Hex(canonicalize(record));
}

export const workOrderDigest = recordDigest;
export const executionSpecDigest = recordDigest;
