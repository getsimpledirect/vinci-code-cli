// VENDORED BY COPY — do not edit here without re-syncing the source.
//   source:  vinci-contracts @ origin/feat/work-order-digest (PR #20 chain)
//   file:    packages/work-orders/src/within-order.ts
//            (`GRANT_PREFIXES`, `branchGranted`, `checkValidatedExecutionSpecWithinOrder`)
//   NOT ported: the `path:` half added later on feat/path-grants (`path_not_granted`). The
//   worker still refuses an execution spec carrying the newer `paths` field as `unknown_field`
//   (digest.mjs, SPEC_FIELDS), so there is no spec-side write scope to compare; the `path:`
//   GRAMMAR is vendored separately (path-grant.mjs) purely so a malformed grant makes the ORDER
//   invalid. When the worker learns path scopes, port the `path_not_granted` block too.
//
/**
 * MONOTONICITY: an execution spec may ask for no more than its work order grants.
 *
 * Binding proves a spec was compiled from exactly one order. That is IDENTITY, not containment:
 * a spec bound to the right order can still ask for a tool, a repository, a branch, a promotion,
 * or a deadline the order never granted. This check closes that gap, and it is PURE — it reads
 * two records and returns a verdict. It performs no I/O and consults nothing outside its
 * arguments.
 *
 * Positive-list semantics throughout: anything the spec asks for that the order does not
 * positively grant is a violation. Absence is not permission.
 *
 * THE MAPPING RULE. A work order's `grantedAuthority` is a list of strings and its `scope` is
 * prose; neither carries a tool vocabulary. Rather than a loose "does the prose contain the
 * word", grants are matched by an explicit, exact token grammar. A grant is machine-readable
 * when it has one of these prefixes; every other grant is prose for humans and covers nothing
 * here:
 *
 *   tool:<name>                    exact tool name, case-sensitive
 *   repo:<host>/<owner>/<name>     exact repository
 *   branch:<name>                  exact branch
 *   branch:<prefix>/*              any branch whose name starts with "<prefix>/"
 *                                  (a single trailing "/*"; no other wildcard)
 *   promotion:pull_request         the spec may open a pull request
 *
 * `scope` is NOT machine-checked. It says in words what the order covers; the repo: and branch:
 * grants are its machine-readable projection, and an order whose prose scope names a repository
 * it never grants is an order whose author has not finished writing it.
 *
 * Time: `resourceBounds.deadline` may not be later than `order.expiresAt`. A run that may
 * continue past the grant's expiry is running without one.
 */

export const GRANT_PREFIXES = Object.freeze(["tool:", "repo:", "branch:", "promotion:"]);

const issue = (path, code, message) => ({ path, code, message });

// Local copy of the upstream scalar helper (identical to digest.mjs's), kept here so this module
// stays a faithful, self-contained port of within-order.ts.
function isCanonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function isStrictlyAfter(later, earlier) {
  if (!isCanonicalTimestamp(later) || !isCanonicalTimestamp(earlier)) return false;
  return Date.parse(later) > Date.parse(earlier);
}

function branchGranted(grants, branch) {
  if (grants.has(`branch:${branch}`)) return true;
  for (const grant of grants) {
    if (!grant.startsWith("branch:") || !grant.endsWith("/*")) continue;
    const prefix = grant.slice("branch:".length, -1); // keeps the trailing "/"
    if (prefix.length > 1 && branch.startsWith(prefix) && branch.length > prefix.length) return true;
  }
  return false;
}

/**
 * Every way `s` exceeds `o`, or `{ ok: true }`.
 *
 * The comparison ALONE: both records must ALREADY have gone through validateWorkOrder /
 * validateExecutionSpec (in the worker they have — a record is validated before its digest is
 * computed, and nothing reaches this check until both digests reproduced).
 *
 * Violations are reported one per dimension so a caller can show all of them; the check does not
 * stop at the first.
 */
export function checkValidatedExecutionSpecWithinOrder(s, o) {
  const issues = [];

  // A wildcard grant with nothing before the "/*" is not a scope, it is the absence of one:
  // "branch:*" would cover every branch, which is exactly what the positive-list rule exists to
  // make impossible to say by accident. It is an ERROR on the order side, not a grant that
  // silently covers nothing.
  o.grantedAuthority.forEach((grant, i) => {
    if (grant === "branch:*" || grant === "branch:/*") {
      issues.push(issue(`/order/grantedAuthority/${i}`, "grant_wildcard_unbounded",
        `"${grant}" grants every branch; a branch wildcard needs a non-empty prefix, e.g. branch:feat/*`));
    }
  });
  const grants = new Set(o.grantedAuthority);

  if (isStrictlyAfter(s.resourceBounds.deadline, o.expiresAt)) {
    issues.push(issue("/resourceBounds/deadline", "deadline_exceeds_contract",
      `deadline ${s.resourceBounds.deadline} is later than the order's expiresAt ${o.expiresAt}`));
  }
  s.tools.forEach((tool, i) => {
    if (!grants.has(`tool:${tool}`)) {
      issues.push(issue(`/tools/${i}`, "tool_not_granted", `the order does not grant "tool:${tool}"`));
    }
  });
  const repo = `${s.repository.host}/${s.repository.owner}/${s.repository.name}`;
  if (!grants.has(`repo:${repo}`)) {
    issues.push(issue("/repository", "repository_not_granted", `the order does not grant "repo:${repo}"`));
  }
  if (!branchGranted(grants, s.targetBranch)) {
    issues.push(issue("/targetBranch", "branch_not_granted",
      `the order grants neither "branch:${s.targetBranch}" nor a "branch:<prefix>/*" covering it`));
  }
  if (s.promotion === "pull_request" && !grants.has("promotion:pull_request")) {
    issues.push(issue("/promotion", "promotion_not_granted", 'the order does not grant "promotion:pull_request"'));
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [] };
}
