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

// Wave 1B (W1) — added on top of the vendored copy by the worker; not part of the upstream
// sinec. Full TypeScript validation is not vendored; these are minimal checks before hashing so a
// work order that is missing a required field (or carries an unrecognized top-level key) errors
// loudly instead of quietly hashing into an identity nobody can reproduce.
const WORK_ORDER_KEYS = new Set([
  "schemaVersion",
  "contractVersion",
  "id",
  "request",
  "scope",
  "acceptanceCriteria",
  "grantedAuthority",
  "attentionBudget",
  "requestedBy",
  "owner",
  "riskClassification",
  "verifier",
  "rollbackConditions",
  "escalationRules",
  "supersedes",
  "issuedAt",
  "expiresAt",
]);

/**
 * Minimal structural checks for a work order before hashing:
 *   - must be a plain object;
 *   - `id` (string) and `request` (non-empty string) are required;
 *   - `scope` and `acceptanceCriteria` are optional;
 *   - every top-level key must be a recognized WorkOrder v3 key (unknown keys are rejected so a
 *     schema drift cannot silently change what a digest names).
 */
export function validateDigestRecord(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("work order must be an object");
  if (typeof obj.id !== "string" || obj.id.length === 0) throw new Error("work order requires a non-empty string id");
  if (typeof obj.request !== "string" || obj.request.trim().length === 0) {
    throw new Error("work order requires a non-empty string request");
  }
  for (const key of Object.keys(obj)) {
    if (!WORK_ORDER_KEYS.has(key)) throw new Error(`work order carries an unknown top-level key: ${key}`);
  }
  return true;
}

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 hex over the canonical encoding of `record` (a parsed JSON value). */
export function recordDigest(record) {
  return sha256Hex(canonicalize(record));
}

export function workOrderDigest(record) {
  validateDigestRecord(record);
  return recordDigest(record);
}
export const executionSpecDigest = recordDigest;
