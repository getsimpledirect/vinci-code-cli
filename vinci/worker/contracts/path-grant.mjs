// VENDORED BY COPY — do not edit here without re-syncing the source.
//   source:  vinci-contracts @ 9e9a105 (branch feat/path-grants)
//   file:    packages/work-orders/src/path-grant.ts
//            (`PATH_GRANT_PREFIX`, `MAX_PATH_ROOT_LENGTH`, `PATH_ROOT_REFUSALS`,
//             `parsePathRoot`, `parsePathGrant`, `describePathRootRefusal`)
//   vectors: packages/work-orders/vectors/path-grant-cases.json, copied byte for byte to
//            vinci/test/fixtures/contract-vectors/path-grant-cases.json and read by
//            vinci/test/worker-contract-vectors.mjs, so this port and the TypeScript one
//            cannot drift apart silently.
//
/**
 * The `path:` grant token — WRITE SCOPE, stated positively.
 *
 * A work order that grants `repo:` and `branch:` says where a run may land commits; it says
 * nothing about which files those commits may touch. Until this token existed every pinned
 * order had ROOT scope by omission, which is exactly the kind of authority the positive-list
 * rule exists to make impossible to hold by accident. So:
 *
 *   path:<root>      <root> is a relative, normalised path inside the repository. A trailing
 *                    "/" grants the directory and everything under it; otherwise the token
 *                    grants ONE file.
 *
 * FAIL CLOSED: there is no token that spells the repository root — `path:.`, `path:/`, and
 * `path:` are all refused — so root scope cannot be granted at all, only enumerated.
 *
 * <root> is refused, with a typed reason, when it
 *   - is empty                                     (empty)
 *   - begins with "/" (absolute)                   (absolute)
 *   - is "." alone, i.e. names the root            (root_scope)
 *   - has a "." segment ("./a", "a/./b")           (dot_segment)
 *   - has a ".." segment ("a/../b", "../a")        (dotdot_segment)
 *   - has an empty segment ("a//b")                (empty_segment)
 *   - contains a backslash                         (backslash)
 *   - contains a NUL                               (nul)
 *   - is longer than MAX_PATH_ROOT_LENGTH          (too_long)
 *
 * The grammar is deliberately NOT a normaliser: "a/../b" is refused, not rewritten to "b". A
 * grant that has to be cleaned before it can be read is a grant two implementations can clean
 * differently.
 *
 * WHAT THE WORKER USES THIS FOR (and what it deliberately does not).
 * The worker vendors the GRAMMAR only, so that `validateWorkOrder` refuses an order carrying a
 * malformed `path:` grant (`path:../../etc/passwd`, `path:/etc/shadow`, `path:.`) instead of
 * waving it through as opaque prose. It does NOT yet vendor path SCOPES: an execution spec that
 * carries the newer `paths` field is still refused as `unknown_field` — see the note on
 * SPEC_FIELDS in digest.mjs. `pathRootCovers` (the monotonicity half of the upstream module) is
 * therefore not ported; the shared vectors file's `monotonicity` section stays unconsumed until
 * the worker learns write scopes.
 */

export const PATH_GRANT_PREFIX = "path:";
export const MAX_PATH_ROOT_LENGTH = 1024;

export const PATH_ROOT_REFUSALS = Object.freeze([
  "empty", "absolute", "root_scope", "dot_segment", "dotdot_segment",
  "empty_segment", "backslash", "nul", "too_long",
]);

/** Parse the `<root>` part of a `path:` grant. Never throws; never normalises. */
export function parsePathRoot(root) {
  if (typeof root !== "string" || root.length === 0) return { ok: false, reason: "empty" };
  if (root.length > MAX_PATH_ROOT_LENGTH) return { ok: false, reason: "too_long" };
  if (root.includes("\0")) return { ok: false, reason: "nul" };
  if (root.includes("\\")) return { ok: false, reason: "backslash" };
  if (root.startsWith("/")) return { ok: false, reason: "absolute" };
  if (root === ".") return { ok: false, reason: "root_scope" };

  const directory = root.endsWith("/");
  const segments = (directory ? root.slice(0, -1) : root).split("/");
  for (const segment of segments) {
    if (segment === "") return { ok: false, reason: "empty_segment" };
    if (segment === ".") return { ok: false, reason: "dot_segment" };
    if (segment === "..") return { ok: false, reason: "dotdot_segment" };
  }
  return { ok: true, value: { root, kind: directory ? "directory" : "file" } };
}

/**
 * Parse a whole grant token. `null` when the token is not a `path:` grant at all (so the caller
 * can leave prose and the other prefixes alone); otherwise the parse of everything after the
 * prefix.
 */
export function parsePathGrant(grant) {
  if (typeof grant !== "string" || !grant.startsWith(PATH_GRANT_PREFIX)) return null;
  return parsePathRoot(grant.slice(PATH_GRANT_PREFIX.length));
}

/** A grant-side refusal reason, worded for the issue it produces. */
export function describePathRootRefusal(reason) {
  switch (reason) {
    case "empty": return "a path root is non-empty";
    case "absolute": return "a path root is relative to the repository; no leading \"/\"";
    case "root_scope": return "\".\" would grant the whole repository; root scope is not expressible, enumerate the roots instead";
    case "dot_segment": return "a path root is normalised; no \".\" segment";
    case "dotdot_segment": return "a path root is normalised and inside the repository; no \"..\" segment";
    case "empty_segment": return "a path root is normalised; no empty segment (\"//\")";
    case "backslash": return "a path root uses \"/\" only; no backslash";
    case "nul": return "a path root contains no NUL";
    case "too_long": return `a path root is at most ${MAX_PATH_ROOT_LENGTH} characters`;
    default: return "a path root is refused";
  }
}
