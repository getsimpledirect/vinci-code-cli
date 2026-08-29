// VENDORED BY COPY — do not edit here without re-syncing the source.
//   source:  vinci-contracts @ b2e0188b (PR #20)
//   files:   packages/work-orders/src/digest.ts (`sha256Hex`, `workOrderDigest`)
//            packages/work-orders/src/work-order.ts (`validateWorkOrder`)
//            packages/work-orders/src/execution-spec.ts (`validateExecutionSpec`, `executionSpecDigest`)
//            packages/work-orders/src/attention.ts (`validateAttentionBudget`)
//            packages/contracts/src/{scalars,actor,risk,actions}.ts (the predicates below)
// The identity of a work order or an execution spec: SHA-256, lowercase hex, over the canonical
// encoding (canonical.mjs) of the record. EVERYTHING the record carries is covered — there is no
// digest or signature field to exclude — so the digest names the exact contract or the exact run
// configuration, not "the same request at any version".
//
// Upstream, both digest functions VALIDATE the record before hashing and throw on an invalid one
// ("a digest of an invalid record is not computed"). The worker carries the same rule (Wave 1B
// F3): `workOrderDigest` / `executionSpecDigest` throw on any record that fails the vendored
// validator, so a served record that is missing a required key, carries an unknown key, or names
// a different schema/contract version is REFUSED — never hashed into an identity that happens to
// match what the handoff named. Only validated records are hashed.
import { createHash } from "node:crypto";

import { canonicalize } from "./canonical.mjs";

// ---- scalars (packages/contracts/src/scalars.ts) ---------------------------------------------
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const isIdentifier = (value) => typeof value === "string" && ID_PATTERN.test(value);
export const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isNonBlankText = (value) => typeof value === "string" && value.trim().length > 0;
export function isCanonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function isStrictlyAfter(later, earlier) {
  if (!isCanonicalTimestamp(later) || !isCanonicalTimestamp(earlier)) return false;
  return Date.parse(later) > Date.parse(earlier);
}
const isObjectRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// ---- closed vocabularies (packages/contracts/src/{risk,actions,actor}.ts) --------------------
const RISK_LEVELS = ["critical", "high", "medium", "low"];
const LOWEST_RISK_LEVEL = RISK_LEVELS[RISK_LEVELS.length - 1];
const CONSEQUENTIAL_ACTION_CLASSES = [
  "deployment", "production_database_change", "external_communication", "financial_obligation",
  "billing_modification", "content_publication", "customer_data_deletion", "access_control_change",
  "protected_branch_update", "infrastructure_purchase", "security_policy_change",
];
// `?` marks optional; everything else must be present with exactly that type.
const ACTOR_FIELD_RULES = {
  user: { userId: "string", deviceId: "string?" },
  worker: { workerId: "string" },
  policy: { policyId: "string", policyVersion: "positiveInteger" },
  system: { component: "string" },
  verifier: { verifierId: "string", independent: "boolean" },
};
// plainActor: null unless `actor` is an object of a known kind carrying exactly that kind's fields.
export function plainActor(actor) {
  if (!isObjectRecord(actor)) return null;
  const rules = Object.hasOwn(ACTOR_FIELD_RULES, actor.kind) ? ACTOR_FIELD_RULES[actor.kind] : null;
  if (!rules) return null;
  for (const key of Object.keys(actor)) if (key !== "kind" && !Object.hasOwn(rules, key)) return null;
  for (const [field, rule] of Object.entries(rules)) {
    const optional = rule.endsWith("?");
    const type = optional ? rule.slice(0, -1) : rule;
    if (!Object.hasOwn(actor, field)) {
      if (optional) continue;
      return null;
    }
    const value = actor[field];
    if (type === "string" && typeof value !== "string") return null;
    if (type === "boolean" && typeof value !== "boolean") return null;
    if (type === "positiveInteger" && !(Number.isSafeInteger(value) && value > 0)) return null;
  }
  return actor;
}

const EXHAUSTION_POLICIES = ["block", "escalate"];
const MAX_BUDGET = 1_000;
const isCount = (value, max) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

const issue = (path, code, message) => ({ path, code, message });
function rejectUnknownFields(record, allowed, path, noun, issues) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.push(issue(`${path}/${key}`, "unknown_field", `${noun} carries only its declared fields`));
  }
}

// ---- work order (packages/work-orders/src/work-order.ts, schema v3) --------------------------
export const WORK_ORDER_SCHEMA_VERSION = 3;
export const WORK_ORDER_FIELDS = Object.freeze([
  "schemaVersion", "contractVersion", "supersedes", "id", "request", "scope", "acceptanceCriteria",
  "grantedAuthority", "attentionBudget", "requestedBy", "owner", "riskClassification", "verifier",
  "rollbackConditions", "escalationRules", "issuedAt", "expiresAt",
]);
// Every top-level key upstream requires (all of WORK_ORDER_FIELDS except `supersedes`, which is
// required iff contractVersion > 1 and forbidden at 1).
export const WORK_ORDER_REQUIRED_FIELDS = Object.freeze(WORK_ORDER_FIELDS.filter((k) => k !== "supersedes"));
const MAX_CRITERIA = 100;
const MAX_AUTHORITY = 100;
const VERIFIER_KINDS = ["independent", "deterministic", "human", "none"];
const VERIFIER_INDEPENDENCE = ["separate-system", "same-worker", "human", "none"];
const ROLLBACK_ACTIONS = ["pause", "revert_to_checkpoint", "abort"];
const ESCALATION_WHENS = ["approval_timeout", "budget_exhausted", "attention_exhausted", "verifier_unavailable", "policy_undetermined", "stall"];

function validateAttentionBudget(input) {
  const issues = [];
  if (!isObjectRecord(input)) return [issue("", "not_object", "expected an object")];
  rejectUnknownFields(input, ["interruptions", "decisions", "onExhaustion"], "", "a budget", issues);
  for (const field of ["interruptions", "decisions"]) {
    if (!isCount(input[field], MAX_BUDGET)) issues.push(issue(`/${field}`, "invalid_count", `${field} must be an integer between 0 and ${MAX_BUDGET}`));
  }
  if (!EXHAUSTION_POLICIES.includes(input.onExhaustion)) {
    issues.push(issue("/onExhaustion", "invalid_enum", "onExhaustion is block or escalate; there is deliberately no way to say proceed"));
  }
  return issues;
}

function validateCriterion(raw, path, issues, seen) {
  if (!isObjectRecord(raw)) {
    issues.push(issue(path, "invalid_type", "expected an object"));
    return;
  }
  rejectUnknownFields(raw, ["id", "statement", "verifiedBy"], path, "a criterion", issues);
  if (!isIdentifier(raw.id)) issues.push(issue(`${path}/id`, "invalid_id", "a criterion id is an identifier"));
  else if (seen.has(raw.id)) issues.push(issue(`${path}/id`, "duplicate_criterion", "two criteria share an id"));
  else seen.add(raw.id);
  if (!isNonBlankText(raw.statement)) issues.push(issue(`${path}/statement`, "required_field", "a criterion must state what must be true"));
  if (!isNonBlankText(raw.verifiedBy)) issues.push(issue(`${path}/verifiedBy`, "required_field", "say how this will be checked; an uncheckable criterion is a wish"));
}

/** Validate a work order from untrusted input. Returns `{ ok, issues }`; fail-closed, unknown fields rejected. */
export function validateWorkOrder(input) {
  if (!isObjectRecord(input)) return { ok: false, issues: [issue("", "not_object", "expected an object")] };
  const record = input;
  const issues = [];

  rejectUnknownFields(record, WORK_ORDER_FIELDS, "", "a work order", issues);
  for (const key of WORK_ORDER_REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, key)) issues.push(issue(`/${key}`, "required_field", `a work order requires ${key}`));
  }
  if (record.schemaVersion !== WORK_ORDER_SCHEMA_VERSION) issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 3"));
  if (!Number.isSafeInteger(record.contractVersion) || record.contractVersion < 1) {
    issues.push(issue("/contractVersion", "invalid_contract_version", "contractVersion is an integer at least 1"));
  }
  const hasSupersedes = Object.hasOwn(record, "supersedes");
  if (record.contractVersion === 1 && hasSupersedes) {
    issues.push(issue("/supersedes", "supersedes_forbidden", "contract version 1 supersedes nothing"));
  } else if (typeof record.contractVersion === "number" && record.contractVersion > 1) {
    if (!hasSupersedes) issues.push(issue("/supersedes", "supersedes_required", "contract versions after 1 must identify their predecessor"));
    else if (!isObjectRecord(record.supersedes)) issues.push(issue("/supersedes", "invalid_type", "supersedes is an object"));
    else {
      rejectUnknownFields(record.supersedes, ["contractVersion", "amendmentId"], "/supersedes", "supersedes", issues);
      if (record.supersedes.contractVersion !== record.contractVersion - 1) {
        issues.push(issue("/supersedes/contractVersion", "supersedes_version_mismatch", "supersedes.contractVersion must be exactly one less than contractVersion"));
      }
      if (!isIdentifier(record.supersedes.amendmentId)) issues.push(issue("/supersedes/amendmentId", "invalid_id", "amendmentId is an identifier"));
    }
  }
  if (!isIdentifier(record.id)) issues.push(issue("/id", "invalid_id", "id is an identifier"));
  for (const field of ["request", "scope"]) {
    if (!isNonBlankText(record[field])) {
      issues.push(issue(`/${field}`, "required_field", field === "scope" ? "scope must say what this covers; an unscoped order grants everything" : "request must say what was asked for"));
    }
  }

  const seenCriteria = new Set();
  if (!Array.isArray(record.acceptanceCriteria)) issues.push(issue("/acceptanceCriteria", "invalid_type", "acceptanceCriteria is an array"));
  else if (record.acceptanceCriteria.length === 0) issues.push(issue("/acceptanceCriteria", "criteria_required", "fix what done means BEFORE the work starts; criteria written afterwards cannot fail"));
  else if (record.acceptanceCriteria.length > MAX_CRITERIA) issues.push(issue("/acceptanceCriteria", "too_many", `at most ${MAX_CRITERIA} criteria`));
  else record.acceptanceCriteria.forEach((c, i) => validateCriterion(c, `/acceptanceCriteria/${i}`, issues, seenCriteria));

  if (!Array.isArray(record.grantedAuthority)) issues.push(issue("/grantedAuthority", "invalid_type", "grantedAuthority is an array"));
  else if (record.grantedAuthority.length > MAX_AUTHORITY) issues.push(issue("/grantedAuthority", "too_many", `at most ${MAX_AUTHORITY} grants`));
  else {
    const seenGrants = new Set();
    record.grantedAuthority.forEach((grant, i) => {
      if (!isNonBlankText(grant)) {
        issues.push(issue(`/grantedAuthority/${i}`, "invalid_grant", "a grant is a non-blank string"));
        return;
      }
      if (seenGrants.has(grant)) issues.push(issue(`/grantedAuthority/${i}`, "duplicate_grant", "a grant is listed twice"));
      seenGrants.add(grant);
    });
  }

  for (const problem of validateAttentionBudget(record.attentionBudget)) {
    issues.push(issue(`/attentionBudget${problem.path}`, problem.code, problem.message));
  }

  if (plainActor(record.requestedBy) === null) {
    issues.push(issue("/requestedBy", "invalid_actor", "requestedBy must be an actor of kind user, worker, policy, system or verifier, carrying exactly that kind's fields (see ACTOR_FIELDS)"));
  }
  const owner = plainActor(record.owner);
  if (owner === null || owner.kind !== "user") issues.push(issue("/owner", "owner_must_be_human", "owner must be a valid actor of kind user"));

  let riskLevel = null;
  let consequentialClasses = null;
  if (!isObjectRecord(record.riskClassification)) issues.push(issue("/riskClassification", "invalid_type", "riskClassification is an object"));
  else {
    const risk = record.riskClassification;
    rejectUnknownFields(risk, ["level", "consequentialClasses", "rationale"], "/riskClassification", "riskClassification", issues);
    if (typeof risk.level !== "string" || !RISK_LEVELS.includes(risk.level)) issues.push(issue("/riskClassification/level", "unknown_risk_level", "level must come from RISK_LEVELS"));
    else riskLevel = risk.level;
    if (!Array.isArray(risk.consequentialClasses)) issues.push(issue("/riskClassification/consequentialClasses", "invalid_type", "consequentialClasses is an array"));
    else {
      consequentialClasses = risk.consequentialClasses;
      const seen = new Set();
      risk.consequentialClasses.forEach((value, index) => {
        if (typeof value !== "string" || !CONSEQUENTIAL_ACTION_CLASSES.includes(value)) issues.push(issue(`/riskClassification/consequentialClasses/${index}`, "unknown_consequential_class", "class must come from CONSEQUENTIAL_ACTION_CLASSES"));
        else if (seen.has(value)) issues.push(issue(`/riskClassification/consequentialClasses/${index}`, "duplicate_consequential_class", "a consequential class is listed twice"));
        else seen.add(value);
      });
    }
    if (!isNonBlankText(risk.rationale)) issues.push(issue("/riskClassification/rationale", "required_field", "risk rationale must be non-blank text"));
  }
  if (riskLevel !== null && consequentialClasses !== null && riskLevel !== LOWEST_RISK_LEVEL && consequentialClasses.length === 0) {
    issues.push(issue("/riskClassification/consequentialClasses", "risk_without_classes", "risk above the lowest level must name at least one consequential class"));
  }

  if (!isObjectRecord(record.verifier)) issues.push(issue("/verifier", "invalid_type", "verifier is an object"));
  else {
    const verifier = record.verifier;
    rejectUnknownFields(verifier, ["kind", "verifierId", "independence"], "/verifier", "verifier", issues);
    const validKind = typeof verifier.kind === "string" && VERIFIER_KINDS.includes(verifier.kind);
    const validIndependence = typeof verifier.independence === "string" && VERIFIER_INDEPENDENCE.includes(verifier.independence);
    if (!validKind) issues.push(issue("/verifier/kind", "unknown_verifier_kind", "kind must be independent, deterministic, human, or none"));
    if (verifier.verifierId !== null && !isNonBlankText(verifier.verifierId)) issues.push(issue("/verifier/verifierId", "invalid_verifier_id", "verifierId must be non-blank text or null"));
    if (!validIndependence) issues.push(issue("/verifier/independence", "unknown_verifier_independence", "independence must be separate-system, same-worker, human, or none"));
    if (validKind && verifier.kind === "none" && riskLevel !== null && riskLevel !== LOWEST_RISK_LEVEL) {
      issues.push(issue("/verifier/kind", "consequential_work_needs_verifier", "only the lowest risk level may declare no verifier"));
    }
    if (validKind && validIndependence && verifier.kind === "independent" && verifier.independence !== "separate-system") {
      issues.push(issue("/verifier/independence", "self_review_is_not_independent", "an independent verifier must run in a separate system; same-worker review is not independent"));
    }
    if (validKind && validIndependence) {
      const coherent =
        (verifier.kind === "none" && verifier.independence === "none") ||
        (verifier.kind === "human" && verifier.independence === "human") ||
        (verifier.kind === "deterministic" && (verifier.independence === "separate-system" || verifier.independence === "same-worker")) ||
        verifier.kind === "independent";
      if (!coherent) issues.push(issue("/verifier/independence", "verifier_independence_incoherent", `independence "${String(verifier.independence)}" is not a coherent claim for a "${String(verifier.kind)}" verifier`));
    }
  }

  if (!Array.isArray(record.rollbackConditions)) issues.push(issue("/rollbackConditions", "invalid_type", "rollbackConditions is an array"));
  else {
    record.rollbackConditions.forEach((raw, index) => {
      const path = `/rollbackConditions/${index}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "a rollback condition is an object"));
        return;
      }
      rejectUnknownFields(raw, ["trigger", "action", "checkpointRequired"], path, "a rollback condition", issues);
      if (!isNonBlankText(raw.trigger)) issues.push(issue(`${path}/trigger`, "required_field", "rollback trigger must be non-blank text"));
      if (typeof raw.action !== "string" || !ROLLBACK_ACTIONS.includes(raw.action)) issues.push(issue(`${path}/action`, "unknown_rollback_action", "action must be pause, revert_to_checkpoint, or abort"));
      if (typeof raw.checkpointRequired !== "boolean") issues.push(issue(`${path}/checkpointRequired`, "invalid_type", "checkpointRequired is boolean"));
    });
    if (consequentialClasses !== null && consequentialClasses.length > 0 && record.rollbackConditions.length === 0) {
      issues.push(issue("/rollbackConditions", "consequential_work_needs_rollback", "consequential work must state at least one rollback condition"));
    }
  }

  const coveredEscalations = new Set();
  if (!Array.isArray(record.escalationRules)) issues.push(issue("/escalationRules", "invalid_type", "escalationRules is an array"));
  else {
    record.escalationRules.forEach((raw, index) => {
      const path = `/escalationRules/${index}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an escalation rule is an object"));
        return;
      }
      rejectUnknownFields(raw, ["when", "to", "within"], path, "an escalation rule", issues);
      if (typeof raw.when !== "string" || !ESCALATION_WHENS.includes(raw.when)) issues.push(issue(`${path}/when`, "unknown_escalation_condition", "when must be a declared escalation condition"));
      else coveredEscalations.add(raw.when);
      const target = plainActor(raw.to);
      if (target === null || target.kind !== "user") issues.push(issue(`${path}/to`, "escalation_target_must_be_human", "an escalation target must be a valid actor of kind user"));
      if (!Number.isSafeInteger(raw.within) || raw.within <= 0) issues.push(issue(`${path}/within`, "invalid_escalation_window", "within must be a positive integer number of seconds"));
    });
  }
  if (!coveredEscalations.has("verifier_unavailable") || !coveredEscalations.has("policy_undetermined")) {
    issues.push(issue("/escalationRules", "escalation_gap", "escalationRules must cover verifier_unavailable and policy_undetermined"));
  }

  for (const field of ["issuedAt", "expiresAt"]) {
    if (!isCanonicalTimestamp(record[field])) issues.push(issue(`/${field}`, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
  }
  if (isCanonicalTimestamp(record.issuedAt) && isCanonicalTimestamp(record.expiresAt) && Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)) {
    issues.push(issue("/expiresAt", "expiry_not_after_issuance", "expiresAt must be strictly later than issuedAt"));
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

// ---- execution spec (packages/work-orders/src/execution-spec.ts, schema v1) ------------------
export const EXECUTION_SPEC_SCHEMA_VERSION = 1;
export const EXECUTION_OUTPUTS = Object.freeze(["branch", "patch", "artifact", "none"]);
export const EXECUTION_PROMOTIONS = Object.freeze(["pull_request", "none"]);
export const SPEC_FIELDS = Object.freeze([
  "schemaVersion", "workOrderId", "workOrderDigest", "repository", "baseRef", "baseCommit",
  "targetBranch", "modelClass", "provider", "resourceBounds", "tools", "inputArtifacts",
  "requiredCapabilities", "output", "evidence", "promotion", "issuedAt",
]);
// Every top-level key upstream requires (all of SPEC_FIELDS except the optional `provider` pin).
export const SPEC_REQUIRED_FIELDS = Object.freeze(SPEC_FIELDS.filter((k) => k !== "provider"));
const MAX_LIST = 100;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
const CAPABILITY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

// The plain-branch rule of the upstream validator (PR #8 rules + `git check-ref-format --branch`).
export function isPlainBranchName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("refs/") || /^refs[/.]/.test(value)) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock") || value === "HEAD") return false;
  return value.split("/").every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
}

function validateStringList(value, path, issues, accept, code, message) {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "invalid_type", `${path.slice(1)} is an array`));
    return;
  }
  if (value.length > MAX_LIST) {
    issues.push(issue(path, "too_many", `at most ${MAX_LIST} entries`));
    return;
  }
  const seen = new Set();
  value.forEach((item, i) => {
    if (!accept(item)) {
      issues.push(issue(`${path}/${i}`, code, message));
      return;
    }
    if (seen.has(item)) issues.push(issue(`${path}/${i}`, "duplicate_entry", "an entry is listed twice"));
    seen.add(item);
  });
}

/** Validate an execution spec from untrusted input. Returns `{ ok, issues }`; fail-closed, unknown fields rejected. */
export function validateExecutionSpec(input) {
  if (!isObjectRecord(input)) return { ok: false, issues: [issue("", "not_object", "expected an object")] };
  const record = input;
  const issues = [];

  rejectUnknownFields(record, SPEC_FIELDS, "", "an execution spec", issues);
  for (const key of SPEC_REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, key)) issues.push(issue(`/${key}`, "required_field", `an execution spec requires ${key}`));
  }
  if (record.schemaVersion !== EXECUTION_SPEC_SCHEMA_VERSION) issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  if (!isIdentifier(record.workOrderId)) issues.push(issue("/workOrderId", "invalid_id", "workOrderId is an identifier"));
  if (!isDigest(record.workOrderDigest)) issues.push(issue("/workOrderDigest", "invalid_digest", "workOrderDigest is a lowercase hex SHA-256"));

  if (!isObjectRecord(record.repository)) issues.push(issue("/repository", "invalid_type", "repository is an object"));
  else {
    const repo = record.repository;
    rejectUnknownFields(repo, ["host", "owner", "name"], "/repository", "repository", issues);
    if (typeof repo.host !== "string" || !HOST_PATTERN.test(repo.host)) issues.push(issue("/repository/host", "invalid_host", "host is a lowercase hostname, e.g. github.com"));
    for (const field of ["owner", "name"]) {
      if (!isIdentifier(repo[field])) issues.push(issue(`/repository/${field}`, "invalid_id", `repository ${field} is an identifier`));
    }
  }

  for (const field of ["baseRef", "targetBranch"]) {
    if (!isPlainBranchName(record[field])) {
      issues.push(issue(`/${field}`, "invalid_ref", `${field} must be a plain git branch name (letters, digits, ._/-; no leading -/+, no .., no refs/ prefix, no refspec syntax)`));
    }
  }
  if (typeof record.baseCommit !== "string" || !COMMIT_PATTERN.test(record.baseCommit)) issues.push(issue("/baseCommit", "invalid_commit", "baseCommit is a full 40-character lowercase hex SHA-1"));
  if (!isIdentifier(record.modelClass)) issues.push(issue("/modelClass", "invalid_model_class", "modelClass is an identifier"));
  if (Object.hasOwn(record, "provider") && !isIdentifier(record.provider)) issues.push(issue("/provider", "invalid_provider", "provider, when present, is an identifier"));

  let deadline = null;
  if (!isObjectRecord(record.resourceBounds)) issues.push(issue("/resourceBounds", "invalid_type", "resourceBounds is an object"));
  else {
    const bounds = record.resourceBounds;
    rejectUnknownFields(bounds, ["budgetMicrousd", "maxRuntimeS", "deadline"], "/resourceBounds", "resourceBounds", issues);
    if (!Number.isSafeInteger(bounds.budgetMicrousd) || bounds.budgetMicrousd < 0) issues.push(issue("/resourceBounds/budgetMicrousd", "invalid_budget", "budgetMicrousd is a non-negative safe integer number of micro-USD; floats and USD are rejected"));
    if (!Number.isSafeInteger(bounds.maxRuntimeS) || bounds.maxRuntimeS <= 0) issues.push(issue("/resourceBounds/maxRuntimeS", "invalid_runtime", "maxRuntimeS is a positive integer number of seconds"));
    if (!isCanonicalTimestamp(bounds.deadline)) issues.push(issue("/resourceBounds/deadline", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
    else deadline = bounds.deadline;
  }

  validateStringList(record.tools, "/tools", issues, isNonBlankText, "invalid_tool", "a tool name is non-blank text");
  validateStringList(record.requiredCapabilities, "/requiredCapabilities", issues, (v) => typeof v === "string" && CAPABILITY_PATTERN.test(v), "invalid_capability", "a required capability is a CapabilityMatrix key name, e.g. structuredEvidence");

  if (!Array.isArray(record.inputArtifacts)) issues.push(issue("/inputArtifacts", "invalid_type", "inputArtifacts is an array"));
  else if (record.inputArtifacts.length > MAX_LIST) issues.push(issue("/inputArtifacts", "too_many", `at most ${MAX_LIST} artifacts`));
  else {
    const seen = new Set();
    record.inputArtifacts.forEach((raw, i) => {
      const path = `/inputArtifacts/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an input artifact is an object"));
        return;
      }
      rejectUnknownFields(raw, ["id", "digest"], path, "an input artifact", issues);
      if (!isIdentifier(raw.id)) issues.push(issue(`${path}/id`, "invalid_id", "an artifact id is an identifier"));
      else if (seen.has(raw.id)) issues.push(issue(`${path}/id`, "duplicate_artifact", "two artifacts share an id"));
      else seen.add(raw.id);
      if (!isDigest(raw.digest)) issues.push(issue(`${path}/digest`, "invalid_digest", "an artifact digest is a lowercase hex SHA-256"));
    });
  }

  const validOutput = typeof record.output === "string" && EXECUTION_OUTPUTS.includes(record.output);
  if (!validOutput) issues.push(issue("/output", "unknown_output", `output must be one of ${EXECUTION_OUTPUTS.join(", ")}`));
  if (!isObjectRecord(record.evidence)) issues.push(issue("/evidence", "invalid_type", "evidence is an object"));
  else {
    rejectUnknownFields(record.evidence, ["required"], "/evidence", "evidence", issues);
    if (typeof record.evidence.required !== "boolean") issues.push(issue("/evidence/required", "invalid_type", "evidence.required is boolean"));
  }
  const validPromotion = typeof record.promotion === "string" && EXECUTION_PROMOTIONS.includes(record.promotion);
  if (!validPromotion) issues.push(issue("/promotion", "unknown_promotion", `promotion must be one of ${EXECUTION_PROMOTIONS.join(", ")}`));
  else if (validOutput && record.promotion === "pull_request" && record.output !== "branch") {
    issues.push(issue("/promotion", "promotion_needs_branch", 'a pull request promotes a branch; output must be "branch"'));
  }
  if (!isCanonicalTimestamp(record.issuedAt)) issues.push(issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
  else if (deadline !== null && !isStrictlyAfter(deadline, record.issuedAt)) {
    issues.push(issue("/resourceBounds/deadline", "deadline_not_after_issuance", "deadline must be strictly later than issuedAt"));
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

// ---- digests (packages/work-orders/src/digest.ts + execution-spec.ts) -----------------------
/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 hex over the canonical encoding of `record` (a parsed JSON value). UNVALIDATED: the
 *  raw identity of any JSON value. Tests use it to name a record the validators would refuse;
 *  the daemon only ever hashes through the two validating functions below. */
export function recordDigest(record) {
  return sha256Hex(canonicalize(record));
}

class InvalidRecordError extends Error {
  constructor(noun, issues) {
    const first = issues[0];
    super(`cannot digest an invalid ${noun}: ${first?.path || "/"} ${first?.code ?? "invalid"}`);
    this.issues = issues;
  }
}

/** Digest of a VALIDATED work order; throws (with `.issues`) on an invalid one. */
export function workOrderDigest(record) {
  const result = validateWorkOrder(record);
  if (!result.ok) throw new InvalidRecordError("work order", result.issues);
  return recordDigest(record);
}

/** Digest of a VALIDATED execution spec; throws (with `.issues`) on an invalid one. */
export function executionSpecDigest(spec) {
  const result = validateExecutionSpec(spec);
  if (!result.ok) throw new InvalidRecordError("execution spec", result.issues);
  return recordDigest(spec);
}
