import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { executionSpecDigest, isPlainBranchName, workOrderDigest } from "./contracts/digest.mjs";
import { checkValidatedExecutionSpecWithinOrder } from "./contracts/within-order.mjs";

const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PROVIDER = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const TERMINAL_STATES = new Set(["COMPLETED", "UNVERIFIED", "BLOCKED", "FAILED"]);
// Lifecycle table (W0.3). Every transition() is checked against it; anything not listed throws.
// PENDING  -> RUNNING immediately before the child is spawned, or straight to BLOCKED/FAILED
//             when the task fails fast (past deadline, envelope error, governor refusal).
// RUNNING  -> exactly one terminal state, written only AFTER the evidence bundle was attempted.
// terminal -> nothing: a finished task is immutable; the daemon skips it on restart.
const TRANSITIONS = new Map([
  ["PENDING", new Set(["RUNNING", "BLOCKED", "FAILED"])],
  ["RUNNING", new Set(TERMINAL_STATES)],
  ["COMPLETED", new Set()],
  ["UNVERIFIED", new Set()],
  ["BLOCKED", new Set()],
  ["FAILED", new Set()],
]);
export const LIFECYCLE_STATES = Object.freeze([...TRANSITIONS.keys()]);

export function assertTransition(from, to) {
  if (!TRANSITIONS.has(from)) throw new Error(`unknown lifecycle state: ${from}`);
  if (!TRANSITIONS.has(to)) throw new Error(`unknown lifecycle state: ${to}`);
  if (!TRANSITIONS.get(from).has(to)) throw new Error(`illegal transition ${from} → ${to}`);
}
const HEADER_KEYS = new Set([
  "repo",
  "evidence",
  "provider",
  "model",
  "budget_usd",
  "max_runtime_s",
  "deadline",
  "ref",
  "branch",
  "claim",
  "evidence_ref",
  "base_ref",
]);

// One branch-name predicate governs prose `branch`, prose `base_ref`, and the digest form's
// targetBranch/baseRef. Keep the exported alias for callers of the prose parser, but delegate to
// the vendored contract predicate so neither path can silently accept a name the other refuses.
export const isPlainRefName = isPlainBranchName;
export function assertPlainRefName(value, name) {
  if (!isPlainRefName(value)) {
    throw new Error(`${name} must be a plain git branch name (1-255 letters, digits, ._/-; no leading -/+, no .., no //, no dot component, no @{, no .lock component, no refs/ prefix, no refspec syntax)`);
  }
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

// The plain-branch rule (PR #8): shared by the prose `branch:` header and the digest form's
// targetBranch, so a contract cannot route a checkout or push anywhere the header could not.
export function assertPlainBranch(branchValue, name = "branch") {
  assertPlainRefName(branchValue, name);
}

export function assertTaskId(taskId) {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
}

export const DEFAULT_ALLOWED_PROVIDERS = "openrouter";

// F5: the provider decision is an operator policy, not a consequence of which credentials happen
// to be installed on the box. Missing configuration defaults to the fleet's declared boundary
// (OpenRouter only); an explicitly malformed value refuses daemon startup rather than widening it.
export function parseAllowedProviders(value = DEFAULT_ALLOWED_PROVIDERS) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("VINCI_WORKER_ALLOWED_PROVIDERS must be a comma-separated non-empty provider list");
  }
  const providers = value.split(",").map((provider) => provider.trim());
  if (providers.some((provider) => !PROVIDER.test(provider))) {
    throw new Error("VINCI_WORKER_ALLOWED_PROVIDERS entries must use lowercase letters, digits, ._- and no leading or trailing punctuation");
  }
  return new Set(providers);
}

export function providerAllowed(provider, allowedProviders) {
  return typeof provider === "string" && allowedProviders instanceof Set && allowedProviders.has(provider);
}

export function parseEnvelope(body) {
  if (typeof body !== "string") throw new Error("handoff body must be text");
  const normalized = body.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator === -1) throw new Error("handoff envelope requires a blank line before the spec");

  const values = new Map();
  for (const line of normalized.slice(0, separator).split("\n")) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`invalid envelope header: ${line}`);
    const [, key, rawValue] = match;
    if (!HEADER_KEYS.has(key)) throw new Error(`unknown envelope header: ${key}`);
    if (values.has(key)) throw new Error(`duplicate envelope header: ${key}`);
    const value = rawValue.trim();
    if (!value) throw new Error(`${key} must not be empty`);
    values.set(key, value);
  }

  const repo = values.get("repo");
  if (!repo || !REPO.test(repo)) throw new Error("repo must be in org/name form");
  const evidence = values.get("evidence") ?? "pr";
  if (evidence !== "pr" && evidence !== "none") throw new Error("evidence must be pr or none");
  const provider = values.get("provider") ?? "openrouter";
  const model = values.get("model") ?? "z-ai/glm-5.2";
  const budgetUsd = positiveNumber(values.get("budget_usd") ?? "5", "budget_usd");
  const maxRuntimeS = positiveNumber(values.get("max_runtime_s") ?? "14400", "max_runtime_s");
  const deadline = values.get("deadline");
  if (deadline && (!UTC_TIMESTAMP.test(deadline) || Number.isNaN(Date.parse(deadline)))) {
    throw new Error("deadline must be an ISO-8601 UTC timestamp");
  }
  const spec = normalized.slice(separator + 2).trim();
  if (!spec) throw new Error("task spec must not be empty");
  const branchValue = values.get("branch");
  if (branchValue !== undefined) assertPlainRefName(branchValue, "branch");
  const claim = values.get("claim") ?? ".";
  const ref = values.get("evidence_ref") ?? values.get("ref");
  // base_ref: the PR base the publisher targets (default main); same name rules as `branch`.
  const baseRef = values.get("base_ref");
  if (baseRef !== undefined) assertPlainRefName(baseRef, "base_ref");

  return {
    repo,
    evidence,
    provider,
    model,
    budget_usd: budgetUsd,
    max_runtime_s: maxRuntimeS,
    deadline,
    ref,
    branch: branchValue,
    base_ref: baseRef,
    claim,
    spec,
  };
}

// ---------------------------------------------------------------------------------------------
// Handoff by reference (Wave 1B): the DIGEST form.
//
// A handoff body whose first non-blank character is `{` is a handoff TRIPLE
//   { "work_order_id", "contract_digest", "execution_spec_digest" }
// — exactly those three keys, nothing else (an extra key is a malformed handoff, not an
// extension point). Anything that does not start with `{` is the legacy prose envelope above.
// Every term the worker runs under is then reachable from the Governor's pinned registry
// (`GET /v1/governor/contracts/{work_order_id}`) and cannot be swapped without one of the three
// values changing — provided the worker RECOMPUTES both digests from what the registry served
// and refuses on any mismatch. materializeEnvelope is that check; it is pure so the refusal
// reasons can be pinned by tests without a bus.
// ---------------------------------------------------------------------------------------------
const TRIPLE_KEYS = ["work_order_id", "contract_digest", "execution_spec_digest"];
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const WORK_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// modelClass -> the (provider, model) the daemon spawns `vinci -p` with. EXPLICIT and closed: a
// class name the table does not know is BLOCKED (`unknown_model_class`), never passed through
// as a model id. The class names are the managed-provider model ids (`vinci` provider: `forte`,
// `fortissimo`; `auto` is deliberately absent — a contract names a class, not "whatever the
// account resolves to").
//
// B2: a spec `provider` pin must equal the configured provider for the class (else
// `provider_mismatch`); it no longer overrides the class's provider. The table itself is
// operator runtime config (VINCI_WORKER_MODEL_CLASSES); DEFAULT_MODEL_CLASSES is the fallback
// used for prose handoffs only. When the operator has NOT configured the table
// (`loadModelClasses().configured === false`), any digest-form materialization refuses with
// `unknown_model_class` "MODEL_CLASSES not configured".
export const DEFAULT_MODEL_CLASSES = Object.freeze({
  forte: Object.freeze({ provider: "vinci", model: "forte" }),
  fortissimo: Object.freeze({ provider: "vinci", model: "fortissimo" }),
});

export const MODEL_CLASSES = DEFAULT_MODEL_CLASSES;

// B3: the closed set of capabilities this worker advertises. Wave 1B ships with an EMPTY set —
// a spec may request none, and any requested capability is BLOCKED (`capability_unsupported`)
// rather than silently unfulfilled. Grow this list only when the worker actually provides one.
export const SUPPORTED_CAPABILITIES = Object.freeze([]);

// B2: read the operator model-class table from VINCI_WORKER_MODEL_CLASSES. The value is a JSON
// object `{ <class>: { provider, model } }`, or `@<path>` naming a JSON file (parsed
// identically; `@/foo.json` reads `/foo.json`). Unset => `{ configured: false, table:
// DEFAULT_MODEL_CLASSES }` (prose-only: every digest handoff refuses).
export function loadModelClasses(env = process.env) {
  const raw = env.VINCI_WORKER_MODEL_CLASSES;
  if (raw === undefined || raw === "") return { configured: false, table: DEFAULT_MODEL_CLASSES };
  const source = raw.startsWith("@") ? raw.slice(1) : null;
  let value;
  try {
    const text = source !== null ? readFileSync(source, "utf8") : raw;
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid VINCI_WORKER_MODEL_CLASSES: ${error.message}`);
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("invalid VINCI_WORKER_MODEL_CLASSES: expected a non-empty JSON object of <class> -> { provider, model }");
  }
  const table = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.model !== "string") {
      throw new Error(`invalid VINCI_WORKER_MODEL_CLASSES: class ${name} must be { provider, model }`);
    }
    table[name] = Object.freeze({ provider: entry.provider, model: entry.model });
  }
  return { configured: true, table: Object.freeze(table) };
}

export function isDigestHandoff(body) {
  return typeof body === "string" && body.trimStart().startsWith("{");
}

class HandoffRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function refuse(code, message) {
  throw new HandoffRefusal(code, message);
}

export function parseHandoffTriple(body) {
  if (!isDigestHandoff(body)) refuse("malformed_handoff", "a digest handoff is a JSON object");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    refuse("malformed_handoff", `handoff triple is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refuse("malformed_handoff", "handoff triple is not an object");
  const keys = Object.keys(parsed).sort();
  const expected = [...TRIPLE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    const extra = keys.filter((key) => !TRIPLE_KEYS.includes(key));
    const missing = TRIPLE_KEYS.filter((key) => !keys.includes(key));
    refuse(
      "malformed_handoff",
      `handoff triple carries exactly {${TRIPLE_KEYS.join(", ")}}` +
        (extra.length ? `; unexpected: ${extra.join(", ")}` : "") +
        (missing.length ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
  const { work_order_id, contract_digest, execution_spec_digest } = parsed;
  if (typeof work_order_id !== "string" || !WORK_ORDER_ID.test(work_order_id)) refuse("malformed_handoff", "work_order_id is an identifier");
  if (typeof contract_digest !== "string" || !DIGEST.test(contract_digest)) refuse("malformed_handoff", "contract_digest is a lowercase hex SHA-256");
  if (typeof execution_spec_digest !== "string" || !DIGEST.test(execution_spec_digest)) refuse("malformed_handoff", "execution_spec_digest is a lowercase hex SHA-256");
  return { work_order_id, contract_digest, execution_spec_digest };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The candidate specs a registry answer carries: `execution_specs[]` when present, else the
// singular `execution_spec`. Both shapes are what gpu-control's contract_routes.py serves.
function candidateSpecs(registry) {
  if (Array.isArray(registry.execution_specs)) return registry.execution_specs.filter(isRecord);
  return isRecord(registry.execution_spec) ? [registry.execution_spec] : [];
}

// Turn a verified (triple, registry answer) pair into the envelope the rest of the daemon runs.
// Throws a HandoffRefusal (`.code` is the refusal reason) on ANY disagreement; the daemon maps
// every one of them to BLOCKED before a clone and before a model spawn. Order of checks:
//   1. the served work order reproduces contract_digest      (contract_digest_mismatch)
//   2. one served spec reproduces execution_spec_digest     (execution_spec_digest_mismatch)
//   3. that spec names this order by id AND digest          (binding_mismatch)
//   3.5 the spec asks for no MORE than the order grants     (execution_exceeds_contract)
//   4. materialization: host, model class, branch, bounds   (per-field reasons)
// A digest is recomputed from the record AS SERVED (canonical bytes of the JSON the registry
// returned); nothing from the triple is trusted until the record it names reproduces it.
// B2/B3: `opts` carries the runtime model-class table. `materializeEnvelope` stays PURE — it
// never reads env — so refusal reasons can be pinned by tests without a bus. processHandoff
// passes the table loaded from VINCI_WORKER_MODEL_CLASSES (see loadModelClasses):
//   opts.modelClasses           the class -> { provider, model } table (default DEFAULT_MODEL_CLASSES)
//   opts.modelClassesConfigured whether the operator configured the table; false => prose-only.
export function materializeEnvelope(triple, registry, opts = {}) {
  if (!isRecord(registry)) refuse("registry_malformed", "registry answer is not an object");
  const modelClasses = opts.modelClasses ?? DEFAULT_MODEL_CLASSES;
  const modelClassesConfigured = opts.modelClassesConfigured ?? true;
  const order = registry.work_order;
  if (!isRecord(order)) refuse("registry_malformed", "registry answer carries no work_order");

  // 1. contract identity — F3: the digest is computed ONLY over a record the vendored upstream
  // validator accepts (every required key present, no unknown key, schemaVersion 3). An invalid
  // served order is refused as `invalid_work_order` before its bytes are ever hashed, so a
  // record that merely reproduces the handed digest cannot get through on identity alone.
  let contractDigest;
  try {
    contractDigest = workOrderDigest(order);
  } catch (error) {
    refuse("invalid_work_order", `served work order fails validation: ${describeIssues(error)}`);
  }
  if (contractDigest !== triple.contract_digest) {
    refuse("contract_digest_mismatch", `served work order digests to ${contractDigest.slice(0, 8)}, handoff names ${triple.contract_digest.slice(0, 8)}`);
  }

  // 2. execution-spec identity: select by recomputed digest, never by position
  const specs = candidateSpecs(registry);
  if (specs.length === 0) refuse("registry_malformed", "registry answer carries no execution spec");
  // F3: a candidate is hashed only after it validates; an invalid candidate can never be "the
  // spec" (its digest is not computed), and when no valid candidate matches, an invalid one is
  // reported as `invalid_execution_spec` rather than hidden behind a digest mismatch.
  let spec = null;
  const invalid = [];
  for (const candidate of specs) {
    try {
      if (executionSpecDigest(candidate) === triple.execution_spec_digest) {
        spec = candidate;
        break;
      }
    } catch (error) {
      invalid.push(describeIssues(error));
    }
  }
  if (!spec && invalid.length > 0) refuse("invalid_execution_spec", `served execution spec fails validation: ${invalid[0]}`);
  if (!spec) {
    refuse("execution_spec_digest_mismatch", `none of ${specs.length} served spec(s) digests to ${triple.execution_spec_digest.slice(0, 8)}`);
  }

  // 3. binding: the spec was compiled from exactly this order, and the order is the one asked for
  if (order.id !== triple.work_order_id) refuse("binding_mismatch", `served work order is ${order.id}, handoff names ${triple.work_order_id}`);
  if (spec.workOrderId !== triple.work_order_id) refuse("binding_mismatch", `spec names work order ${spec.workOrderId}, handoff names ${triple.work_order_id}`);
  if (spec.workOrderDigest !== triple.contract_digest) {
    refuse("binding_mismatch", "spec was compiled from a different version of this work order (workOrderDigest != contract_digest)");
  }

  // 3.5 CONTAINMENT (BLOCK-1 of the W1B review): step 3 proves WHICH order the spec was compiled
  // from. That is identity, not containment — a spec bound to the right order can still name a
  // repository, a branch, a promotion, a tool or a deadline the order never granted, and before
  // this check such a spec ran to COMPLETED and pushed. Both records are already VALIDATED here
  // (a record is validated before its digest is computed, steps 1 and 2), which is exactly the
  // precondition of the vendored upstream comparison, so it is called directly. Pure: no I/O.
  const within = checkValidatedExecutionSpecWithinOrder(spec, order);
  if (!within.ok) refuse("execution_exceeds_contract", `execution spec asks for more than the work order grants: ${describeContainment(within.issues)}`);

  // 4. materialize
  const repository = spec.repository;
  if (!isRecord(repository)) refuse("invalid_spec_field", "repository is an object");
  if (repository.host !== "github.com") refuse("unsupported_repository_host", `repository host ${JSON.stringify(repository.host)} is not github.com`);
  const repo = `${repository.owner}/${repository.name}`;
  if (typeof repository.owner !== "string" || typeof repository.name !== "string" || !REPO.test(repo)) {
    refuse("invalid_spec_field", "repository owner/name must form org/name");
  }
  // B2: prose-only mode (operator never configured a table) refuses every digest handoff.
  if (modelClassesConfigured !== true) {
    refuse("unknown_model_class", "MODEL_CLASSES not configured");
  }
  if (typeof spec.modelClass !== "string" || !Object.hasOwn(modelClasses, spec.modelClass)) {
    refuse("unknown_model_class", `modelClass ${JSON.stringify(spec.modelClass)} is not in the worker's class table (${Object.keys(modelClasses).join(", ")})`);
  }
  const modelClass = modelClasses[spec.modelClass];
  let provider = modelClass.provider;
  if (spec.provider !== undefined) {
    if (typeof spec.provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.provider)) refuse("invalid_spec_field", "provider is an identifier");
    // B2: an explicit provider pin must MATCH the configured provider for the class.
    if (spec.provider !== modelClass.provider) {
      refuse("provider_mismatch", `spec provider ${JSON.stringify(spec.provider)} does not match configured provider ${JSON.stringify(modelClass.provider)} for modelClass ${JSON.stringify(spec.modelClass)}`);
    }
    provider = spec.provider;
  }
  try {
    assertPlainBranch(spec.targetBranch, "targetBranch");
  } catch (error) {
    refuse("invalid_spec_field", error.message);
  }
  if (typeof spec.baseCommit !== "string" || !COMMIT.test(spec.baseCommit)) refuse("invalid_spec_field", "baseCommit is a full 40-character lowercase hex SHA-1");
  // F4: baseRef is REQUIRED (the base checkout fetches origin/<baseRef> and proves baseCommit is
  // an ancestor of it) and held to the same plain-branch rule as targetBranch.
  try {
    assertPlainBranch(spec.baseRef, "baseRef");
  } catch (error) {
    refuse("invalid_spec_field", error.message);
  }
  const bounds = spec.resourceBounds;
  if (!isRecord(bounds)) refuse("invalid_spec_field", "resourceBounds is an object");
  if (!Number.isSafeInteger(bounds.budgetMicrousd) || bounds.budgetMicrousd < 0) refuse("invalid_spec_field", "budgetMicrousd is a non-negative safe integer");
  if (!Number.isSafeInteger(bounds.maxRuntimeS) || bounds.maxRuntimeS <= 0) refuse("invalid_spec_field", "maxRuntimeS is a positive integer");
  if (typeof bounds.deadline !== "string" || !UTC_TIMESTAMP.test(bounds.deadline) || Number.isNaN(Date.parse(bounds.deadline))) {
    refuse("invalid_spec_field", "deadline is an ISO-8601 UTC timestamp");
  }
  if (spec.output !== "branch" && spec.output !== "patch" && spec.output !== "artifact" && spec.output !== "none") refuse("invalid_spec_field", "output is one of branch, patch, artifact, none");
  if (spec.promotion !== "pull_request" && spec.promotion !== "none") refuse("invalid_spec_field", "promotion is one of pull_request, none");
  if (!isRecord(spec.evidence) || typeof spec.evidence.required !== "boolean") refuse("invalid_spec_field", "evidence.required is boolean");
  // B3: enforce the remaining spec fields before anything is cloned or spawned.
  // tools (list): non-empty, all tool-name strings; passed to vinci as --tools <csv>.
  if (!Array.isArray(spec.tools)) refuse("invalid_spec_field", "tools is a list of tool names");
  if (spec.tools.length === 0) refuse("no_tools", "tools is empty; at least one tool is required");
  if (!spec.tools.every((t) => typeof t === "string" && t.length > 0)) refuse("invalid_spec_field", "tools entries are non-empty tool names");
  const tools = [...spec.tools];
  // inputArtifacts (list): recorded as-is (no fetch in Wave 1B scope).
  if (spec.inputArtifacts !== undefined && !Array.isArray(spec.inputArtifacts)) refuse("invalid_spec_field", "inputArtifacts is a list");
  const inputArtifacts = Array.isArray(spec.inputArtifacts) ? spec.inputArtifacts : [];
  // requiredCapabilities (list): validated against SUPPORTED_CAPABILITIES (an empty set in
  // Wave 1B) — any capability we do not advertise BLOCKs the task.
  if (spec.requiredCapabilities !== undefined && !Array.isArray(spec.requiredCapabilities)) refuse("invalid_spec_field", "requiredCapabilities is a list");
  const requiredCapabilities = Array.isArray(spec.requiredCapabilities) ? spec.requiredCapabilities : [];
  for (const capability of requiredCapabilities) {
    if (!SUPPORTED_CAPABILITIES.includes(capability)) {
      refuse("capability_unsupported", `requiredCapability ${JSON.stringify(capability)} is not supported by this worker (supported: ${SUPPORTED_CAPABILITIES.join(", ") || "none"})`);
    }
  }
  // A pull request is promotion, not evidence: the daemon's `evidence: pr` (open a PR, and a PR
  // is what COMPLETED requires) is materialized ONLY for a branch output promoted by pull
  // request. Every other output/promotion pair is `none` and the publisher never opens a PR.
  const promotesPr = spec.promotion === "pull_request" && spec.output === "branch";
  const evidence = promotesPr && spec.evidence.required ? "pr" : "none";
  // The spec text handed to `vinci -p` is the work order's `request` (WorkOrder v3: durable
  // intent; `scope` and `acceptanceCriteria` ride along beneath it so the agent sees them).
  if (typeof order.request !== "string" || !order.request.trim()) refuse("invalid_spec_field", "work order request text is empty");
  const specText = renderRequest(order);

  return {
    envelope: {
      work_order_id: triple.work_order_id,
      repo,
      evidence,
      provider,
      model: modelClass.model,
      budget_usd: bounds.budgetMicrousd / 1e6,
      max_runtime_s: bounds.maxRuntimeS,
      deadline: bounds.deadline,
      ref: undefined,
      branch: spec.targetBranch,
      claim: ".",
      spec: specText,
      promotion: spec.promotion,
      output: spec.output,
      base_commit: spec.baseCommit,
      base_ref: spec.baseRef,
      tools,
    },
    contract: {
      work_order_id: triple.work_order_id,
      contract_digest: contractDigest,
      execution_spec_digest: triple.execution_spec_digest,
      base_commit: spec.baseCommit,
      base_ref: spec.baseRef,
      promotion: spec.promotion,
      output: spec.output,
      model_class: spec.modelClass,
      tools,
      input_artifacts: inputArtifacts,
      required_capabilities: requiredCapabilities,
    },
  };
}

// `<path> <code>[; …]` for the containment issues of step 3.5. Every dimension the spec exceeded
// is named (not just the first): an operator repairing an over-broad spec needs the whole list.
// Capped so one over-long tools array cannot fill the terminal post.
function describeContainment(issues) {
  const named = issues.slice(0, 8).map((i) => `${i.path || "/"} ${i.code}`).join("; ");
  return issues.length > 8 ? `${named}; +${issues.length - 8} more` : named;
}

// `<path> <code>[; …]` for a digest validator's `.issues`, or the bare message when it has none.
function describeIssues(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) return error?.message ?? "invalid record";
  return issues.slice(0, 3).map((i) => `${i.path || "/"} ${i.code}`).join("; ") + (issues.length > 3 ? `; +${issues.length - 3} more` : "");
}

function renderRequest(order) {
  const lines = [order.request.trim()];
  if (typeof order.scope === "string" && order.scope.trim()) lines.push("", `Scope: ${order.scope.trim()}`);
  const criteria = Array.isArray(order.acceptanceCriteria) ? order.acceptanceCriteria : [];
  const statements = criteria
    .filter((c) => isRecord(c) && typeof c.statement === "string" && c.statement.trim())
    .map((c) => `- ${typeof c.id === "string" ? `${c.id}: ` : ""}${c.statement.trim()}`);
  if (statements.length > 0) lines.push("", "Acceptance criteria:", ...statements);
  return lines.join("\n");
}

// `contract=<work_order_id>@<digest8>` for every terminal post of a digest-form task; null for prose.
export function contractTag(record) {
  if (!record || typeof record.work_order_id !== "string" || typeof record.contract_digest !== "string") return null;
  return `contract=${record.work_order_id}@${record.contract_digest.slice(0, 8)}`;
}

// The task-record shape of a vinciBinaryVersion() result: `{ version, path }`, `{ error }`, or null.
export function vinciBinaryRecord(binary) {
  if (!binary || typeof binary !== "object") return null;
  if (binary.error) return { error: binary.error };
  return { version: binary.version, path: binary.path };
}

export class TaskLifecycle {
  constructor(stateDir, taskId) {
    assertTaskId(taskId);
    this.taskFile = join(stateDir, "tasks", `${taskId}.json`);
    mkdirSync(dirname(this.taskFile), { recursive: true });
    this.state = this.load(taskId);
  }

  load(taskId) {
    try {
      const state = JSON.parse(readFileSync(this.taskFile, "utf8"));
      if (!state || typeof state !== "object") throw new Error("state is not an object");
      return state;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`cannot read task state ${this.taskFile}: ${error.message}`);
      return {
        task: taskId,
        attempt: 0,
        session_id: taskId,
        state: "PENDING",
        started_at: null,
        finished_at: null,
        exit_code: null,
        head: null,
        base_commit: null,
        base_ref: null,
        pr: null,
        publish: null,
        evidence: null,
        limit_tripped: null,
        vinci_version: null,
        worker_build: null,
        server_build: null,
        vinci_binary: null,
        provider: null,
        model: null,
        cost_usd: 0,
        outcome: null,
        terminal: false,
        lease: null,
        evidence_error: null,
        harness_stop: null,
        evidence_result_state: null,
        work_order_id: null,
        contract_digest: null,
        execution_spec_digest: null,
        base_commit: null,
        promotion: null,
      };
    }
  }

  save() {
    const temporary = `${this.taskFile}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.taskFile);
  }

  isTerminal() {
    return this.state.terminal === true || TERMINAL_STATES.has(this.state.state);
  }

  // builds (W0.5): `{ workerBuild: { version, commit, dirty, source }, serverBuild: <payload|{error}>,
  // vinciBinary: { version, path } | { error } }`.
  // `vinci_version` is kept for compatibility and is the DAEMON CHECKOUT's identity.json version
  // (same as worker_build.version) — it is NOT the version of the `vinci` binary that ran the
  // task; that is `vinci_binary` (#18). At startAttempt it is the daemon's LAST OBSERVED probe
  // (what an early blocker that never spawns gets); a task that reaches the spawn re-probes
  // immediately before it and overwrites the field via record({ vinci_binary }).
  // `worker_build` / `server_build` name the exact builds that produced this record and ride
  // into result.json unchanged.
  startAttempt(task, vinciVersion, builds = {}) {
    if (this.isTerminal()) throw new Error(`cannot start an attempt on terminal state ${this.state.state}`);
    const firstAttempt = !(Number.isInteger(this.state.attempt) && this.state.attempt > 0);
    const nextAttempt = (Number.isInteger(this.state.attempt) ? this.state.attempt : 0) + 1;
    // Qwen accounting is attempt-scoped. Reusing the task's durable session id blended usage and
    // latency from a prior failed Attempt into its retry; a fresh deterministic session prevents
    // that while the task id remains the WorkOrder lineage.
    const sessionId = task.envelope.provider === "qwen-h200"
      ? `${task.id}-qwen-attempt-${nextAttempt}`
      : typeof this.state.session_id === "string" && this.state.session_id ? this.state.session_id : task.id;
    this.state = {
      ...this.state,
      task: task.id,
      attempt: nextAttempt,
      session_id: sessionId,
      state: "PENDING",
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      head: null,
      base_commit: firstAttempt ? null : this.state.base_commit ?? null,
      base_ref: task.envelope.base_ref ?? "main",
      pr: null,
      publish: null,
      evidence: task.envelope.evidence,
      limit_tripped: null,
      vinci_version: vinciVersion,
      worker_build: builds.workerBuild
        ? { version: builds.workerBuild.version, commit: builds.workerBuild.commit, dirty: builds.workerBuild.dirty }
        : null,
      server_build: builds.serverBuild ?? null,
      vinci_binary: vinciBinaryRecord(builds.vinciBinary),
      provider: task.envelope.provider,
      model: task.envelope.model,
      cost_usd: 0,
      outcome: null,
      terminal: false,
      lease: null,
      evidence_error: null,
      harness_stop: null,
      evidence_result_state: null,
      // Wave 1B: set by record() once a digest-form handoff has been materialized; null for prose.
      work_order_id: null,
      contract_digest: null,
      execution_spec_digest: null,
      base_commit: null,
      promotion: null,
    };
    this.save();
    return { attempt: this.state.attempt, firstAttempt, sessionId };
  }

  // Update published fields without changing state (lease grant, run results before publish).
  record(fields = {}) {
    if (this.isTerminal()) throw new Error(`illegal update of terminal state ${this.state.state}`);
    this.state = { ...this.state, ...fields, state: this.state.state };
    this.save();
  }

  // The snapshot transition(state, fields) WOULD write, validated against the table but not
  // saved. The worker uploads this as result.json BEFORE committing the terminal state.
  plan(state, fields = {}) {
    assertTransition(this.state.state, state);
    const next = { ...this.state, ...fields, state };
    if (TERMINAL_STATES.has(state)) {
      next.finished_at = typeof fields.finished_at === "string" ? fields.finished_at : new Date().toISOString();
      next.terminal = true;
    }
    return next;
  }

  transition(state, fields = {}) {
    this.state = this.plan(state, fields);
    this.save();
  }

  snapshot() {
    return { ...this.state };
  }
}
