import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { Agent, fetch as undiciFetch } from "undici";

export const QWEN_PROVIDER = "qwen-h200";
export const QWEN_MODEL = "Qwen/Qwen3.8-27B";
export const QWEN_API = "vinci-qwen-openai-completions";

const QUALIFICATION_SCHEMA = "vinci.qwen-worker-qualification.v2";
const QUALIFICATION_ENVELOPE_SCHEMA = "vinci.qwen-worker-qualification-envelope.v2";
const QUALIFICATION_REQUEST_SCHEMA = "vinci.qwen-worker-qualification-request.v2";
const CIRCUIT_SCHEMA = "vinci.qwen-worker-circuit.v2";
const CANARY_SCHEMA = "vinci.qwen-worker-canary.v2";
const AUTHORITY_ROLE = "non-authoritative-evidence-and-proposals-only";
const FALLBACK_POLICY = "explicit-openrouter-separate-attempt-only";
const QUALIFICATION_AUTHORITY = "independent-never-builder-review";
const MAX_QUALIFICATION_BYTES = 512 * 1024;
const MAX_CANARY_BYTES = 256 * 1024;
const MAX_BURN_IN_BYTES = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const IMMUTABLE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_QUALIFICATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANARY_AGE_AT_ISSUE_MS = 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 1_000;
const LOCK_POLL_MS = 10;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const QWEN_AUTHORITY_ROOT = "/run/vinci/qwen-authority";

export const QWEN_REQUEST_ENCODING = Object.freeze({
  schema: "vinci.qwen-openai-chat-request.v1",
  api: "openai-completions",
  path: "/v1/chat/completions",
  transport: "sse",
  thinking_format: "qwen-chat-template",
  tool_output: "tool-arguments-json",
  redirects: "refused",
  retries: "client-bounded",
});

export const QWEN_REQUALIFICATION_CONDITIONS = Object.freeze([
  "canary-expired-or-failed",
  "capabilities-or-limits-changed",
  "client-build-changed",
  "endpoint-identity-or-address-policy-changed",
  "model-or-revision-changed",
  "outbound-request-encoding-changed",
  "price-basis-changed",
  "runtime-artifact-or-arguments-changed",
  "system-prompt-changed",
  "tool-schema-or-policy-changed",
]);
export const QWEN_CONCURRENCY_LADDER = Object.freeze([1, 2, 4, 8, 16, 24, 32]);

type RuntimeTuple = {
  engine: string;
  version: string;
  artifact_sha256: string;
  arguments_sha256: string;
};

type Qualification = {
  schema: string;
  status: string;
  authority_role: string;
  fallback_policy: string;
  safe_resume: boolean;
  provenance: {
    issuer: string;
    authority: string;
    issued_at: string;
    expires_at: string;
    review_message_id: string;
    review_body_sha256: string;
    burn_in_report_sha256: string;
    canary: {
      schema: string;
      report_sha256: string;
      observed_at: string;
    };
  };
  burn_in: {
    schema: string;
    previous_concurrency: number;
    target_concurrency: number;
    observed_hours: number;
    work_orders: number;
    acceptance_pass_rate: number;
    usage_coverage_rate: number;
    transport_error_rate: number;
    identity_failures: number;
    verification_failures: number;
    circuit_opens: number;
    resource_alarms: number;
    governor_stops: number;
  };
  bindings: {
    model: string;
    revision: string;
    runtime: RuntimeTuple;
    endpoint_sha256: string;
    endpoint_identity_sha256: string;
    work_order_prompt_sha256: string;
    system_prompt_sha256: string;
    tool_names_sha256: string;
    tool_schemas_sha256: string;
    tool_policy_sha256: string;
    client_build_sha256: string;
    extension_build_sha256: string;
    request_encoding_sha256: string;
  };
  capabilities: {
    streaming_sse: boolean;
    tool_calls: boolean;
    structured_output: string;
    usage_chunk: boolean;
  };
  limits: {
    total_timeout_ms: number;
    max_retries: number;
    max_retry_delay_ms: number;
    max_concurrency: number;
    advertised_max_concurrency: number;
    context_window: number;
    max_tokens: number;
    max_request_bytes: number;
    max_response_bytes: number;
    max_error_bytes: number;
  };
  pricing: {
    currency: string;
    basis: string;
    input_per_million_usd: number;
    output_per_million_usd: number;
    cache_read_per_million_usd: number;
    cache_write_per_million_usd: number;
  };
  requalification_conditions: string[];
};

type QualificationEnvelope = {
  schema: string;
  qualification: Qualification;
  signature: {
    algorithm: string;
    key_id: string;
    signature_base64: string;
  };
};

type CircuitState = {
  schema: string;
  failures: number;
  open_until_ms: number;
  last_reason: string | null;
  sequence: number;
};

type LookupAddress = { address: string; family: number };
export type QwenLookup = (hostname: string) => Promise<LookupAddress[]>;
export type QwenFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type QwenAttemptRecord = {
  request_id: string;
  transport_attempt: number;
  started_at: string;
  finished_at: string;
  latency_ms: number;
  outcome: string;
  status: number | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  request_sha256: string;
  response_id: string | null;
};

export type QwenAuthorityBoundary = {
  qualificationTrust: {
    issuer: string;
    publicKeyFile: string;
    publicKeySha256: string;
  };
  fleetPermit: {
    schema: "vinci.qwen-fleet-permit.v1";
    authority: "vgc-fleet-permit-authority";
    permitId: string;
    workOrderId: string;
    runId: string;
    attemptId: string;
    maxConcurrency: number;
    lockDirectory: string;
    issuedAt: string;
    expiresAt: string;
  };
};

export type QwenSemanticSettlement = {
  accepted?: QwenAttemptRecord;
  transportFailed: boolean;
  settled: boolean;
};

export type QwenRuntimeConfig = {
  baseUrl: string;
  healthUrl: string;
  modelsUrl: string;
  chatUrl: string;
  endpointHostname: string;
  endpointLoopback: boolean;
  endpointAddresses: string[];
  secret: string;
  qualification: Qualification;
  qualificationSha256: string;
  circuitFile: string;
  circuitThreshold: number;
  circuitOpenMs: number;
  fleetPermit: {
    permitId: string;
    lockDirectory: string;
    expiresAt: string;
  };
  attribution: {
    workOrderId: string;
    runId: string;
    attemptId: string;
  };
};

export class QwenReadinessError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`qwen_${code}: ${message}`);
    this.name = "QwenReadinessError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new QwenReadinessError(code, message);
}

export function qwenSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function qwenCanonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(qwenCanonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${qwenCanonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("qualification_invalid", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (qwenCanonical(actual) !== qwenCanonical(wanted)) fail("qualification_invalid", `${label} has unexpected or missing fields`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("qualification_invalid", `${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("qualification_invalid", `${label} must be a finite non-negative number`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/.test(value)) {
    fail("qualification_invalid", `${label} must be a bounded single-line string`);
  }
  return value;
}

function timestamp(value: unknown, label: string): { text: string; time: number } {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) fail("qualification_invalid", `${label} must be an ISO-8601 UTC timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail("qualification_invalid", `${label} is not a valid timestamp`);
  return { text: value, time };
}

function validateRuntime(value: unknown): RuntimeTuple {
  exactKeys(value, ["engine", "version", "artifact_sha256", "arguments_sha256"], "runtime");
  const engine = nonEmptyString(value.engine, "runtime.engine");
  const version = nonEmptyString(value.version, "runtime.version");
  if (typeof value.artifact_sha256 !== "string" || !HEX64.test(value.artifact_sha256)) {
    fail("qualification_invalid", "runtime.artifact_sha256 must be lowercase SHA-256");
  }
  if (typeof value.arguments_sha256 !== "string" || !HEX64.test(value.arguments_sha256)) {
    fail("qualification_invalid", "runtime.arguments_sha256 must be lowercase SHA-256");
  }
  return { engine, version, artifact_sha256: value.artifact_sha256, arguments_sha256: value.arguments_sha256 };
}

function validateQualification(raw: unknown, expectedIssuer: string, nowMs: number): Qualification {
  exactKeys(
    raw,
    [
      "schema",
      "status",
      "authority_role",
      "fallback_policy",
      "safe_resume",
      "provenance",
      "burn_in",
      "bindings",
      "capabilities",
      "limits",
      "pricing",
      "requalification_conditions",
    ],
    "qualification",
  );
  if (raw.schema !== QUALIFICATION_SCHEMA || raw.status !== "qualified") {
    fail("qualification_invalid", "qualification is not an admitted v2 qualified record");
  }
  if (raw.authority_role !== AUTHORITY_ROLE) fail("authority_forbidden", "Qwen must remain non-authoritative");
  if (raw.fallback_policy !== FALLBACK_POLICY) fail("fallback_forbidden", "fallback must be a separately authorized OpenRouter attempt");
  if (raw.safe_resume !== false) fail("safe_resume_forbidden", "safeResume remains false until independently requalified");

  exactKeys(raw.provenance, ["issuer", "authority", "issued_at", "expires_at", "review_message_id", "review_body_sha256", "burn_in_report_sha256", "canary"], "provenance");
  if (raw.provenance.issuer !== expectedIssuer) fail("issuer_mismatch", "qualification issuer differs from the process-pinned issuer");
  if (raw.provenance.authority !== QUALIFICATION_AUTHORITY) fail("authority_forbidden", "qualification authority must be independent review");
  const issued = timestamp(raw.provenance.issued_at, "provenance.issued_at");
  const expires = timestamp(raw.provenance.expires_at, "provenance.expires_at");
  if (issued.time > nowMs + 5 * 60 * 1000 || expires.time <= nowMs || expires.time <= issued.time) {
    fail("qualification_expired", "qualification issue/expiry interval is not currently valid");
  }
  if (expires.time - issued.time > MAX_QUALIFICATION_LIFETIME_MS) {
    fail("qualification_invalid", "qualification lifetime exceeds seven days");
  }
  nonEmptyString(raw.provenance.review_message_id, "provenance.review_message_id");
  if (typeof raw.provenance.review_body_sha256 !== "string" || !HEX64.test(raw.provenance.review_body_sha256)) {
    fail("qualification_invalid", "provenance.review_body_sha256 must be lowercase SHA-256");
  }
  if (typeof raw.provenance.burn_in_report_sha256 !== "string" || !HEX64.test(raw.provenance.burn_in_report_sha256)) {
    fail("qualification_invalid", "provenance.burn_in_report_sha256 must be lowercase SHA-256");
  }
  exactKeys(raw.provenance.canary, ["schema", "report_sha256", "observed_at"], "provenance.canary");
  if (raw.provenance.canary.schema !== CANARY_SCHEMA) fail("qualification_invalid", "qualification cites the wrong canary schema");
  if (typeof raw.provenance.canary.report_sha256 !== "string" || !HEX64.test(raw.provenance.canary.report_sha256)) {
    fail("qualification_invalid", "provenance.canary.report_sha256 must be lowercase SHA-256");
  }
  const canaryObserved = timestamp(raw.provenance.canary.observed_at, "provenance.canary.observed_at");
  if (canaryObserved.time > issued.time || issued.time - canaryObserved.time > MAX_CANARY_AGE_AT_ISSUE_MS) {
    fail("qualification_invalid", "canary evidence must precede issuance by no more than 24 hours");
  }

  exactKeys(
    raw.bindings,
    [
      "model",
      "revision",
      "runtime",
      "endpoint_sha256",
      "endpoint_identity_sha256",
      "work_order_prompt_sha256",
      "system_prompt_sha256",
      "tool_names_sha256",
      "tool_schemas_sha256",
      "tool_policy_sha256",
      "client_build_sha256",
      "extension_build_sha256",
      "request_encoding_sha256",
    ],
    "bindings",
  );
  if (raw.bindings.model !== QWEN_MODEL) fail("model_mismatch", `qualification must name ${QWEN_MODEL}`);
  if (typeof raw.bindings.revision !== "string" || !IMMUTABLE_REVISION.test(raw.bindings.revision)) {
    fail("qualification_invalid", "bindings.revision must be an immutable lowercase 40- or 64-hex digest");
  }
  const runtime = validateRuntime(raw.bindings.runtime);
  for (const key of [
    "endpoint_sha256",
    "endpoint_identity_sha256",
    "work_order_prompt_sha256",
    "system_prompt_sha256",
    "tool_names_sha256",
    "tool_schemas_sha256",
    "tool_policy_sha256",
    "client_build_sha256",
    "extension_build_sha256",
    "request_encoding_sha256",
  ] as const) {
    if (typeof raw.bindings[key] !== "string" || !HEX64.test(raw.bindings[key])) {
      fail("qualification_invalid", `bindings.${key} must be lowercase SHA-256`);
    }
  }

  exactKeys(raw.capabilities, ["streaming_sse", "tool_calls", "structured_output", "usage_chunk"], "capabilities");
  if (raw.capabilities.streaming_sse !== true || raw.capabilities.tool_calls !== true || raw.capabilities.usage_chunk !== true) {
    fail("capability_missing", "streaming SSE, tool calls, and usage chunks must be independently qualified");
  }
  if (raw.capabilities.structured_output !== "tool-arguments-json") {
    fail("capability_missing", "structured output must be tool-arguments JSON");
  }

  exactKeys(
    raw.limits,
    [
      "total_timeout_ms",
      "max_retries",
      "max_retry_delay_ms",
      "max_concurrency",
      "advertised_max_concurrency",
      "context_window",
      "max_tokens",
      "max_request_bytes",
      "max_response_bytes",
      "max_error_bytes",
    ],
    "limits",
  );
  const limits = {
    total_timeout_ms: boundedInteger(raw.limits.total_timeout_ms, 1_000, 300_000, "limits.total_timeout_ms"),
    max_retries: boundedInteger(raw.limits.max_retries, 0, 2, "limits.max_retries"),
    max_retry_delay_ms: boundedInteger(raw.limits.max_retry_delay_ms, 0, 30_000, "limits.max_retry_delay_ms"),
    max_concurrency: boundedInteger(raw.limits.max_concurrency, 1, 32, "limits.max_concurrency"),
    advertised_max_concurrency: boundedInteger(raw.limits.advertised_max_concurrency, 1, 32, "limits.advertised_max_concurrency"),
    context_window: boundedInteger(raw.limits.context_window, 8_192, 2_000_000, "limits.context_window"),
    max_tokens: boundedInteger(raw.limits.max_tokens, 256, 131_072, "limits.max_tokens"),
    max_request_bytes: boundedInteger(raw.limits.max_request_bytes, 1_024, 16 * 1024 * 1024, "limits.max_request_bytes"),
    max_response_bytes: boundedInteger(raw.limits.max_response_bytes, 1_024, 64 * 1024 * 1024, "limits.max_response_bytes"),
    max_error_bytes: boundedInteger(raw.limits.max_error_bytes, 256, 256 * 1024, "limits.max_error_bytes"),
  };
  if (limits.max_tokens > limits.context_window) fail("qualification_invalid", "limits.max_tokens exceeds limits.context_window");
  if (limits.max_concurrency > limits.advertised_max_concurrency) {
    fail("qualification_invalid", "qualified concurrency exceeds Ayush's advertised ceiling");
  }
  if (!QWEN_CONCURRENCY_LADDER.includes(limits.max_concurrency)) {
    fail("qualification_invalid", "qualified concurrency is not on the closed 1→2→4→8→16→24→32 ladder");
  }

  exactKeys(
    raw.burn_in,
    [
      "schema",
      "previous_concurrency",
      "target_concurrency",
      "observed_hours",
      "work_orders",
      "acceptance_pass_rate",
      "usage_coverage_rate",
      "transport_error_rate",
      "identity_failures",
      "verification_failures",
      "circuit_opens",
      "resource_alarms",
      "governor_stops",
    ],
    "burn_in",
  );
  if (raw.burn_in.schema !== "vinci.qwen-worker-burn-in.v1") fail("qualification_invalid", "burn-in report schema is not v1");
  const ladderIndex = QWEN_CONCURRENCY_LADDER.indexOf(limits.max_concurrency);
  const burnIn = {
    schema: raw.burn_in.schema,
    previous_concurrency: boundedInteger(raw.burn_in.previous_concurrency, 0, 32, "burn_in.previous_concurrency"),
    target_concurrency: boundedInteger(raw.burn_in.target_concurrency, 1, 32, "burn_in.target_concurrency"),
    observed_hours: nonNegativeNumber(raw.burn_in.observed_hours, "burn_in.observed_hours"),
    work_orders: boundedInteger(raw.burn_in.work_orders, 0, Number.MAX_SAFE_INTEGER, "burn_in.work_orders"),
    acceptance_pass_rate: nonNegativeNumber(raw.burn_in.acceptance_pass_rate, "burn_in.acceptance_pass_rate"),
    usage_coverage_rate: nonNegativeNumber(raw.burn_in.usage_coverage_rate, "burn_in.usage_coverage_rate"),
    transport_error_rate: nonNegativeNumber(raw.burn_in.transport_error_rate, "burn_in.transport_error_rate"),
    identity_failures: boundedInteger(raw.burn_in.identity_failures, 0, Number.MAX_SAFE_INTEGER, "burn_in.identity_failures"),
    verification_failures: boundedInteger(raw.burn_in.verification_failures, 0, Number.MAX_SAFE_INTEGER, "burn_in.verification_failures"),
    circuit_opens: boundedInteger(raw.burn_in.circuit_opens, 0, Number.MAX_SAFE_INTEGER, "burn_in.circuit_opens"),
    resource_alarms: boundedInteger(raw.burn_in.resource_alarms, 0, Number.MAX_SAFE_INTEGER, "burn_in.resource_alarms"),
    governor_stops: boundedInteger(raw.burn_in.governor_stops, 0, Number.MAX_SAFE_INTEGER, "burn_in.governor_stops"),
  };
  if (burnIn.target_concurrency !== limits.max_concurrency) fail("qualification_invalid", "burn-in target differs from qualified concurrency");
  if (ladderIndex === 0) {
    if (burnIn.previous_concurrency !== 0 || burnIn.observed_hours !== 0 || burnIn.work_orders !== 0) {
      fail("qualification_invalid", "concurrency 1 is the zero-history entry stage");
    }
  } else if (
    burnIn.previous_concurrency !== QWEN_CONCURRENCY_LADDER[ladderIndex - 1] ||
    burnIn.observed_hours < 168 ||
    burnIn.work_orders < 1_000 ||
    burnIn.acceptance_pass_rate !== 1 ||
    burnIn.usage_coverage_rate !== 1 ||
    burnIn.transport_error_rate > 0.005 ||
    burnIn.identity_failures !== 0 ||
    burnIn.verification_failures !== 0 ||
    burnIn.circuit_opens !== 0 ||
    burnIn.resource_alarms !== 0 ||
    burnIn.governor_stops !== 0
  ) {
    fail("burn_in_gate_failed", "promotion requires the immediately prior stage, 168 hours, 1,000 WorkOrders, complete acceptance/usage, ≤0.5% transport errors, and zero stop triggers");
  }
  if (burnIn.acceptance_pass_rate > 1 || burnIn.usage_coverage_rate > 1 || burnIn.transport_error_rate > 1) {
    fail("qualification_invalid", "burn-in rates must be in [0, 1]");
  }

  exactKeys(
    raw.pricing,
    ["currency", "basis", "input_per_million_usd", "output_per_million_usd", "cache_read_per_million_usd", "cache_write_per_million_usd"],
    "pricing",
  );
  if (raw.pricing.currency !== "USD") fail("qualification_invalid", "pricing.currency must be USD");
  const pricing = {
    currency: "USD",
    basis: nonEmptyString(raw.pricing.basis, "pricing.basis", 1_024),
    input_per_million_usd: nonNegativeNumber(raw.pricing.input_per_million_usd, "pricing.input_per_million_usd"),
    output_per_million_usd: nonNegativeNumber(raw.pricing.output_per_million_usd, "pricing.output_per_million_usd"),
    cache_read_per_million_usd: nonNegativeNumber(raw.pricing.cache_read_per_million_usd, "pricing.cache_read_per_million_usd"),
    cache_write_per_million_usd: nonNegativeNumber(raw.pricing.cache_write_per_million_usd, "pricing.cache_write_per_million_usd"),
  };

  if (!Array.isArray(raw.requalification_conditions) || qwenCanonical(raw.requalification_conditions) !== qwenCanonical(QWEN_REQUALIFICATION_CONDITIONS)) {
    fail("qualification_invalid", "requalification conditions must match the closed v2 contract");
  }
  return {
    ...(raw as unknown as Qualification),
    burn_in: burnIn,
    bindings: { ...(raw.bindings as Qualification["bindings"]), runtime },
    limits,
    pricing,
    requalification_conditions: [...QWEN_REQUALIFICATION_CONDITIONS],
  };
}

function secureRegularFile(path: string, label: string, maximumBytes: number): Buffer {
  if (!isAbsolute(path)) fail("config_invalid", `${label} must be an absolute path`);
  let stat;
  let bytes: Buffer;
  try {
    stat = lstatSync(path);
    bytes = readFileSync(path);
  } catch {
    fail("config_unavailable", `${label} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    fail("config_unsafe", `${label} must be a non-writable regular file`);
  }
  if (bytes.length < 1 || bytes.length > maximumBytes) fail("config_invalid", `${label} has an invalid byte length`);
  return bytes;
}

function secureAuthorityFile(path: string, label: string, maximumBytes: number): Buffer {
  const bytes = secureRegularFile(path, label, maximumBytes);
  if (lstatSync(path).uid !== 0) fail("authority_boundary_unsafe", `${label} must be owned by root`);
  return bytes;
}

function pathWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

function validateProductionAuthorityRoot(): void {
  let stat;
  try {
    stat = lstatSync(QWEN_AUTHORITY_ROOT);
  } catch {
    fail("config_unavailable", "Qwen independent authority root is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    fail("authority_boundary_unsafe", "Qwen independent authority root must be a root-owned non-writable directory");
  }
}

function loadIndependentAuthority(
  workOrderId: string,
  runId: string,
  attemptId: string,
  nowMs: number,
  injected?: QwenAuthorityBoundary,
): QwenAuthorityBoundary {
  let boundary: QwenAuthorityBoundary;
  if (injected) boundary = injected;
  else {
    validateProductionAuthorityRoot();
    const identity = qwenSha256(`${workOrderId}\0${runId}\0${attemptId}`);
    const bytes = secureAuthorityFile(
      join(QWEN_AUTHORITY_ROOT, `${identity}.json`),
      "Qwen independent authority record",
      MAX_QUALIFICATION_BYTES,
    );
    try {
      boundary = JSON.parse(bytes.toString("utf8")) as QwenAuthorityBoundary;
    } catch {
      fail("authority_boundary_invalid", "Qwen independent authority record is not JSON");
    }
  }
  exactKeys(boundary, ["qualificationTrust", "fleetPermit"], "independent authority boundary");
  exactKeys(boundary.qualificationTrust, ["issuer", "publicKeyFile", "publicKeySha256"], "qualification trust boundary");
  const trust = boundary.qualificationTrust;
  if (!IDENTIFIER.test(trust.issuer) || !isAbsolute(trust.publicKeyFile) || !HEX64.test(trust.publicKeySha256)) {
    fail("authority_boundary_invalid", "qualification trust boundary is malformed");
  }
  exactKeys(
    boundary.fleetPermit,
    ["schema", "authority", "permitId", "workOrderId", "runId", "attemptId", "maxConcurrency", "lockDirectory", "issuedAt", "expiresAt"],
    "fleet permit",
  );
  const permit = boundary.fleetPermit;
  if (permit.schema !== "vinci.qwen-fleet-permit.v1" || permit.authority !== "vgc-fleet-permit-authority") {
    fail("fleet_permit_invalid", "Qwen requires the external VGC fleet permit authority");
  }
  nonEmptyString(permit.permitId, "fleet permit id");
  if (permit.workOrderId !== workOrderId || permit.runId !== runId || permit.attemptId !== attemptId) {
    fail("fleet_permit_invalid", "fleet permit attribution does not match this exact WorkOrder/Run/Attempt");
  }
  if (permit.maxConcurrency !== 1) fail("fleet_permit_invalid", "current Qwen fleet permit must enforce concurrency 1");
  if (!isAbsolute(permit.lockDirectory)) fail("fleet_permit_invalid", "fleet permit lock directory must be absolute");
  const issued = timestamp(permit.issuedAt, "fleet permit issuedAt");
  const expires = timestamp(permit.expiresAt, "fleet permit expiresAt");
  if (issued.time > nowMs + 30_000 || expires.time <= nowMs || expires.time - issued.time > 5 * 60_000) {
    fail("fleet_permit_invalid", "fleet permit must be current and live for no more than five minutes");
  }
  if (!injected) {
    const keyRoot = join(QWEN_AUTHORITY_ROOT, "keys");
    let keyRootStat;
    try {
      keyRootStat = lstatSync(keyRoot);
    } catch {
      fail("config_unavailable", "qualification trust key root is unavailable");
    }
    if (!keyRootStat.isDirectory() || keyRootStat.isSymbolicLink() || keyRootStat.uid !== 0 || (keyRootStat.mode & 0o022) !== 0) {
      fail("authority_boundary_unsafe", "qualification trust key root must be a root-owned non-writable directory");
    }
    if (!pathWithin(keyRoot, trust.publicKeyFile) || dirname(trust.publicKeyFile) !== keyRoot) {
      fail("authority_boundary_unsafe", "qualification trust key must be inside the independent authority key root");
    }
    if (permit.lockDirectory !== join(QWEN_AUTHORITY_ROOT, "locks")) {
      fail("authority_boundary_unsafe", "fleet permit lock directory must be the independent authority lock root");
    }
    let lockStat;
    try {
      lockStat = lstatSync(permit.lockDirectory);
    } catch {
      fail("config_unavailable", "fleet permit lock directory is unavailable");
    }
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.uid !== 0 || (lockStat.mode & 0o1000) === 0) {
      fail("authority_boundary_unsafe", "fleet permit lock directory must be a root-owned sticky directory");
    }
  }
  return boundary;
}

function readSecretDescriptor(env: NodeJS.ProcessEnv): string {
  const raw = env.VINCI_QWEN_SECRET_FD;
  delete env.VINCI_QWEN_SECRET_FD;
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 64) fail("config_missing", "VINCI_QWEN_SECRET_FD must name a scoped inherited descriptor");
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail("credential_unsafe", "Qwen credential descriptor is not a private regular file");
    bytes = readFileSync(fd);
  } catch (error) {
    if (error instanceof QwenReadinessError) throw error;
    fail("credential_unavailable", "Qwen credential descriptor is unreadable");
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  if (bytes.length < 1 || bytes.length > 16_384) fail("credential_invalid", "Qwen credential has an invalid byte length");
  const secret = bytes.toString("utf8").trim();
  bytes.fill(0);
  if (!secret || /\s/.test(secret)) fail("credential_invalid", "Qwen credential is empty or contains whitespace");
  return secret;
}

function readCanarySecret(reference: string | undefined): string {
  if (!reference?.startsWith("file:")) fail("config_invalid", "VINCI_QWEN_SECRET_REF must use file:/absolute/private/path");
  const bytes = secureRegularFile(reference.slice(5), "Qwen canary credential", 16_384);
  const secret = bytes.toString("utf8").trim();
  bytes.fill(0);
  if (!secret || /\s/.test(secret)) fail("credential_invalid", "Qwen canary credential is empty or contains whitespace");
  return secret;
}

export function normalizeQwenBaseUrl(raw: string | undefined): {
  baseUrl: string;
  healthUrl: string;
  modelsUrl: string;
  chatUrl: string;
  endpointHostname: string;
  endpointLoopback: boolean;
} {
  if (!raw) fail("config_missing", "VINCI_QWEN_BASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("config_invalid", "VINCI_QWEN_BASE_URL must be an absolute URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail("config_invalid", "VINCI_QWEN_BASE_URL may not contain credentials, a query, or a fragment");
  }
  const endpointLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && endpointLoopback)) {
    fail("config_invalid", "VINCI_QWEN_BASE_URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  const withoutSlashes = parsed.toString().replace(/\/+$/, "");
  const root = withoutSlashes.endsWith("/v1") ? withoutSlashes.slice(0, -3) : withoutSlashes;
  return {
    baseUrl: `${root}/v1`,
    healthUrl: `${root}/health`,
    modelsUrl: `${root}/v1/models`,
    chatUrl: `${root}/v1/chat/completions`,
    endpointHostname: parsed.hostname.replace(/^\[|\]$/g, ""),
    endpointLoopback,
  };
}

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || (b === 175 && c === 48))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function loopbackIpv4(address: string): boolean {
  return /^127\./.test(address);
}

export async function pinQwenEndpoint(config: QwenRuntimeConfig, lookupImpl: QwenLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true })): Promise<void> {
  let answers: LookupAddress[];
  const family = isIP(config.endpointHostname);
  if (family !== 0) answers = [{ address: config.endpointHostname, family }];
  else {
    try {
      answers = await lookupImpl(config.endpointHostname);
    } catch {
      fail("dns_unavailable", "endpoint hostname could not be resolved");
    }
  }
  if (answers.length < 1) fail("dns_unavailable", "endpoint hostname resolved to no addresses");
  if (answers.some((answer) => answer.family !== 4)) fail("ssrf_forbidden", "endpoint must resolve only to pinned IPv4 addresses");
  const addresses = [...new Set(answers.map((answer) => answer.address))].sort();
  if (config.endpointLoopback) {
    if (addresses.some((address) => !loopbackIpv4(address))) fail("dns_rebinding", "loopback endpoint resolved outside loopback");
  } else if (addresses.some((address) => !publicIpv4(address))) {
    fail("ssrf_forbidden", "endpoint resolved to a private, local, reserved, or non-public address");
  }
  config.endpointAddresses = addresses;
}

function readQualification(
  env: NodeJS.ProcessEnv,
  nowMs: number,
  trust: QwenAuthorityBoundary["qualificationTrust"],
  injectedAuthority: boolean,
): { qualification: Qualification; digest: string } {
  const path = env.VINCI_QWEN_QUALIFICATION_FILE;
  const expectedDigest = env.VINCI_QWEN_QUALIFICATION_SHA256;
  if (!path || !expectedDigest || !HEX64.test(expectedDigest)) fail("config_missing", "qualification file and byte digest pin are required");
  const bytes = secureRegularFile(path, "Qwen qualification artifact", MAX_QUALIFICATION_BYTES);
  if (qwenSha256(bytes) !== expectedDigest) fail("qualification_digest_mismatch", "qualification bytes do not match the process pin");
  const publicKeyBytes = injectedAuthority
    ? secureRegularFile(trust.publicKeyFile, "Qwen qualification public key", 64 * 1024)
    : secureAuthorityFile(trust.publicKeyFile, "Qwen qualification public key", 64 * 1024);
  if (qwenSha256(publicKeyBytes) !== trust.publicKeySha256) {
    fail("qualification_key_mismatch", "qualification public key bytes do not match the independent authority pin");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("qualification_invalid", "qualification artifact is not JSON");
  }
  exactKeys(parsed, ["schema", "qualification", "signature"], "qualification envelope");
  if (parsed.schema !== QUALIFICATION_ENVELOPE_SCHEMA) fail("qualification_invalid", "qualification envelope schema is not v2");
  exactKeys(parsed.signature, ["algorithm", "key_id", "signature_base64"], "qualification signature");
  if (parsed.signature.algorithm !== "Ed25519") fail("qualification_invalid", "qualification signature algorithm must be Ed25519");
  nonEmptyString(parsed.signature.key_id, "qualification signature key_id");
  if (typeof parsed.signature.signature_base64 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(parsed.signature.signature_base64)) {
    fail("qualification_invalid", "qualification signature is not canonical base64 Ed25519");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyBytes);
  } catch {
    fail("qualification_key_invalid", "qualification trust key is not valid SPKI/PEM");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("qualification_key_invalid", "qualification trust key must be Ed25519");
  const signedBytes = Buffer.from(qwenCanonical(parsed.qualification));
  if (!verify(null, signedBytes, publicKey, Buffer.from(parsed.signature.signature_base64, "base64"))) {
    fail("qualification_signature_invalid", "qualification signature does not verify under the pinned trust key");
  }
  return { qualification: validateQualification(parsed.qualification, trust.issuer, nowMs), digest: expectedDigest };
}

export function loadQwenRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  injectedAuthority?: QwenAuthorityBoundary,
): QwenRuntimeConfig {
  const urls = normalizeQwenBaseUrl(env.VINCI_QWEN_BASE_URL);
  const secret = readSecretDescriptor(env);
  const workOrderId = env.VINCI_QWEN_WORK_ORDER_ID;
  const runId = env.VINCI_QWEN_RUN_ID;
  const attemptId = env.VINCI_QWEN_ATTEMPT_ID;
  if (!workOrderId || !runId || !attemptId) fail("attribution_missing", "WorkOrder, Run, and Attempt attribution are required");
  const authority = loadIndependentAuthority(workOrderId, runId, attemptId, nowMs, injectedAuthority);
  const admitted = readQualification(env, nowMs, authority.qualificationTrust, injectedAuthority !== undefined);
  const qualification = admitted.qualification;
  const bindings = qualification.bindings;
  if (bindings.endpoint_sha256 !== qwenSha256(urls.baseUrl)) fail("endpoint_mismatch", "qualification is bound to a different base URL");
  if (bindings.work_order_prompt_sha256 !== env.VINCI_QWEN_PROMPT_SHA256) fail("prompt_mismatch", "WorkOrder prompt is not the qualified prompt");
  if (bindings.tool_names_sha256 !== env.VINCI_QWEN_TOOLS_SHA256) fail("tools_mismatch", "ordered task tools are not qualified");
  if (bindings.tool_policy_sha256 !== env.VINCI_QWEN_TOOL_POLICY_SHA256) fail("tool_policy_mismatch", "task tool policy is not qualified");
  if (bindings.client_build_sha256 !== env.VINCI_QWEN_CLIENT_BUILD_SHA256) fail("client_build_mismatch", "executed client build is not qualified");
  if (bindings.extension_build_sha256 !== env.VINCI_QWEN_EXTENSION_BUILD_SHA256) fail("extension_build_mismatch", "executed Qwen extension build is not qualified");
  if (bindings.request_encoding_sha256 !== qwenSha256(qwenCanonical(QWEN_REQUEST_ENCODING))) {
    fail("request_encoding_mismatch", "outbound OpenAI request encoding is not qualified");
  }
  if (env.VINCI_UNATTENDED_POLICY !== "governed" || !env.VINCI_UNATTENDED_LEASE) {
    fail("authority_forbidden", "Qwen Worker runs require a deterministic Governor lease");
  }
  if (qualification.limits.max_concurrency !== authority.fleetPermit.maxConcurrency) {
    fail("fleet_permit_invalid", "qualification concurrency differs from the external fleet permit");
  }
  const circuitFile = env.VINCI_QWEN_CIRCUIT_FILE;
  if (!circuitFile || !isAbsolute(circuitFile)) fail("config_missing", "VINCI_QWEN_CIRCUIT_FILE must be an absolute path");
  return {
    ...urls,
    endpointAddresses: [],
    secret,
    qualification,
    qualificationSha256: admitted.digest,
    circuitFile,
    circuitThreshold: boundedInteger(Number(env.VINCI_QWEN_CIRCUIT_THRESHOLD ?? "3"), 1, 10, "VINCI_QWEN_CIRCUIT_THRESHOLD"),
    circuitOpenMs: boundedInteger(Number(env.VINCI_QWEN_CIRCUIT_OPEN_MS ?? "60000"), 1_000, 3_600_000, "VINCI_QWEN_CIRCUIT_OPEN_MS"),
    fleetPermit: {
      permitId: authority.fleetPermit.permitId,
      lockDirectory: authority.fleetPermit.lockDirectory,
      expiresAt: authority.fleetPermit.expiresAt,
    },
    attribution: { workOrderId, runId, attemptId },
  };
}

function emptyCircuit(sequence = 0): CircuitState {
  return { schema: CIRCUIT_SCHEMA, failures: 0, open_until_ms: 0, last_reason: null, sequence };
}

function readCircuit(path: string): CircuitState {
  if (!existsSync(path)) return emptyCircuit();
  let stat;
  let value: unknown;
  try {
    stat = lstatSync(path);
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("circuit_invalid", "circuit state is unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    fail("circuit_invalid", "circuit state is not a private regular file");
  }
  exactKeys(value, ["schema", "failures", "open_until_ms", "last_reason", "sequence"], "circuit state");
  if (value.schema !== CIRCUIT_SCHEMA) fail("circuit_invalid", "circuit state has the wrong schema");
  const failures = boundedInteger(value.failures, 0, Number.MAX_SAFE_INTEGER, "circuit failures");
  const openUntil = boundedInteger(value.open_until_ms, 0, Number.MAX_SAFE_INTEGER, "circuit open_until_ms");
  const sequence = boundedInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER, "circuit sequence");
  if (value.last_reason !== null && (typeof value.last_reason !== "string" || value.last_reason.length > 128)) {
    fail("circuit_invalid", "circuit last_reason is malformed");
  }
  return { schema: CIRCUIT_SCHEMA, failures, open_until_ms: openUntil, last_reason: value.last_reason as string | null, sequence };
}

function writeCircuit(path: string, state: CircuitState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, `${qwenCanonical(state)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function withCircuitLock<T>(path: string, operation: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("circuit_lock_failed", "circuit lock cannot be acquired");
      if (Date.now() >= deadline) fail("circuit_busy", "concurrent circuit update did not complete within one second");
      Atomics.wait(SLEEP_CELL, 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return operation();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      fail("circuit_lock_failed", "circuit lock could not be released");
    }
  }
}

export function assertQwenCircuitClosed(config: QwenRuntimeConfig, nowMs = Date.now()): void {
  const state = readCircuit(config.circuitFile);
  if (state.open_until_ms > nowMs) fail("circuit_open", `endpoint circuit is open until ${new Date(state.open_until_ms).toISOString()}`);
}

export function recordQwenCircuitOutcome(config: QwenRuntimeConfig, ok: boolean, reason: string, nowMs = Date.now()): void {
  withCircuitLock(config.circuitFile, () => {
    const current = readCircuit(config.circuitFile);
    if (ok) {
      writeCircuit(config.circuitFile, emptyCircuit(current.sequence + 1));
      return;
    }
    const failures = current.failures + 1;
    writeCircuit(config.circuitFile, {
      schema: CIRCUIT_SCHEMA,
      failures,
      open_until_ms: failures >= config.circuitThreshold ? nowMs + config.circuitOpenMs : 0,
      last_reason: reason.slice(0, 128),
      sequence: current.sequence + 1,
    });
  });
}

async function readBoundedText(response: Response, maximumBytes: number, abort?: AbortController): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > maximumBytes) {
      abort?.abort("response_oversized");
      fail("response_oversized", `endpoint response exceeded ${maximumBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("response_invalid", "endpoint response is not valid UTF-8");
  }
}

function authHeaders(config: Pick<QwenRuntimeConfig, "secret" | "attribution">): Record<string, string> {
  return {
    authorization: `Bearer ${config.secret}`,
    accept: "application/json",
    "x-vinci-work-order-id": config.attribution.workOrderId,
    "x-vinci-run-id": config.attribution.runId,
    "x-vinci-attempt-id": config.attribution.attemptId,
    "x-vinci-qwen-output-authority": "non-authoritative",
  };
}

function pinnedAgent(config: QwenRuntimeConfig, addressIndex: number): Agent {
  if (config.endpointAddresses.length < 1) fail("dns_unpinned", "endpoint DNS must be validated and pinned before transport");
  const address = config.endpointAddresses[addressIndex % config.endpointAddresses.length];
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    },
  });
}

function realPinnedFetch(config: QwenRuntimeConfig, addressIndex: number): { fetchImpl: QwenFetch; close: () => void } {
  const agent = pinnedAgent(config, addressIndex);
  return {
    fetchImpl: async (input, init) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const requestInit = { ...(init as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>), dispatcher: agent };
      return undiciFetch(target, requestInit) as unknown as Response;
    },
    close: () => {
      void agent.close();
    },
  };
}

async function boundedRequest(
  config: QwenRuntimeConfig,
  url: string,
  init: RequestInit,
  maximumBytes: number,
  options: { fetchImpl?: QwenFetch; signal?: AbortSignal } = {},
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("total_timeout"), config.qualification.limits.total_timeout_ms);
  const abort = () => controller.abort(options.signal?.reason ?? "cancelled");
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const real = options.fetchImpl ? null : realPinnedFetch(config, 0);
  try {
    const response = await (options.fetchImpl ?? real!.fetchImpl)(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) fail("redirect_forbidden", "endpoint redirects are refused");
    const text = await readBoundedText(response, maximumBytes, controller);
    return { response, text };
  } catch (error) {
    if (error instanceof QwenReadinessError) throw error;
    if (options.signal?.aborted) fail("cancelled", "endpoint request was cancelled");
    if (controller.signal.aborted) fail("request_timeout", "endpoint request exceeded its total deadline");
    fail("endpoint_unavailable", "endpoint request failed");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    real?.close();
  }
  throw new Error("unreachable");
}

function servedIdentity(response: Response, payload: unknown): { revision: string; runtime: RuntimeTuple; endpointIdentity: string } {
  exactKeys(payload, ["object", "data"], "models response");
  if (payload.object !== "list" || !Array.isArray(payload.data)) fail("models_invalid", "/v1/models must return an OpenAI list");
  const matches = payload.data.filter((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === QWEN_MODEL);
  if (matches.length !== 1) fail("model_mismatch", `/v1/models must expose exactly one ${QWEN_MODEL}`);
  const model = matches[0] as Record<string, unknown>;
  const runtime = model.runtime && typeof model.runtime === "object"
    ? validateRuntime(model.runtime)
    : validateRuntime({
        engine: response.headers.get("x-vinci-runtime-engine"),
        version: response.headers.get("x-vinci-runtime-version"),
        artifact_sha256: response.headers.get("x-vinci-runtime-artifact-sha256"),
        arguments_sha256: response.headers.get("x-vinci-runtime-arguments-sha256"),
      });
  const revision = typeof model.revision === "string" ? model.revision : response.headers.get("x-vinci-model-revision");
  if (!revision || !IMMUTABLE_REVISION.test(revision)) fail("identity_missing", "/v1/models omitted the immutable served revision");
  const endpointIdentity = typeof model.endpoint_identity_sha256 === "string"
    ? model.endpoint_identity_sha256
    : response.headers.get("x-vinci-endpoint-identity-sha256");
  if (!endpointIdentity || !HEX64.test(endpointIdentity)) fail("identity_missing", "/v1/models omitted endpoint identity");
  return { revision, runtime, endpointIdentity };
}

async function validateHealthResponse(response: Response, text: string): Promise<void> {
  if (!response.ok) fail("health_failed", `authenticated /health returned ${response.status}`);
  if (!text) fail("health_invalid", "/health returned an empty response");
  let healthBody: unknown;
  try {
    healthBody = JSON.parse(text);
  } catch {
    fail("health_invalid", "/health returned non-JSON content");
  }
  const status = healthBody && typeof healthBody === "object" ? (healthBody as Record<string, unknown>).status : undefined;
  if (status !== "ok" && status !== "ready") fail("health_failed", "/health did not report ready");
}

export async function probeQwenReadiness(
  config: QwenRuntimeConfig,
  options: { fetchImpl?: QwenFetch; signal?: AbortSignal; nowMs?: number; lookupImpl?: QwenLookup } = {},
): Promise<{ revision: string; runtime: RuntimeTuple; endpointIdentity: string }> {
  const nowMs = options.nowMs ?? Date.now();
  assertQwenCircuitClosed(config, nowMs);
  if (config.endpointAddresses.length < 1) await pinQwenEndpoint(config, options.lookupImpl);
  const maximum = config.qualification.limits.max_response_bytes;
  try {
    const health = await boundedRequest(config, config.healthUrl, { headers: authHeaders(config) }, maximum, options);
    await validateHealthResponse(health.response, health.text);
    const models = await boundedRequest(config, config.modelsUrl, { headers: authHeaders(config) }, maximum, options);
    if (!models.response.ok) fail("models_failed", `authenticated /v1/models returned ${models.response.status}`);
    let modelsBody: unknown;
    try {
      modelsBody = JSON.parse(models.text);
    } catch {
      fail("models_invalid", "/v1/models returned non-JSON content");
    }
    const identity = servedIdentity(models.response, modelsBody);
    const bindings = config.qualification.bindings;
    if (
      identity.revision !== bindings.revision ||
      qwenCanonical(identity.runtime) !== qwenCanonical(bindings.runtime) ||
      identity.endpointIdentity !== bindings.endpoint_identity_sha256
    ) {
      fail("runtime_mismatch", "served endpoint/model/runtime differs from the signed qualification");
    }
    for (const [url, path] of [[config.healthUrl, "/health"], [config.modelsUrl, "/v1/models"]] as const) {
      const anonymous = await boundedRequest(config, url, { headers: { accept: "application/json" } }, maximum, options);
      if (anonymous.response.status !== 401 && anonymous.response.status !== 403) {
        fail("auth_not_enforced", `unauthenticated ${path} was not refused`);
      }
    }
    recordQwenCircuitOutcome(config, true, "ready", nowMs);
    return identity;
  } catch (error) {
    if (!(error instanceof QwenReadinessError) || error.code !== "circuit_open") {
      recordQwenCircuitOutcome(config, false, error instanceof QwenReadinessError ? error.code : "probe_failed", nowMs);
    }
    throw error;
  }
}

export async function ensureQwenReady(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: QwenFetch; signal?: AbortSignal; nowMs?: number; lookupImpl?: QwenLookup; authorityBoundary?: QwenAuthorityBoundary } = {},
): Promise<QwenRuntimeConfig> {
  const config = loadQwenRuntimeConfig(env, options.nowMs, options.authorityBoundary);
  await pinQwenEndpoint(config, options.lookupImpl);
  await probeQwenReadiness(config, options);
  return config;
}

function responseIdentityHeaders(response: Response, config: QwenRuntimeConfig): void {
  const bindings = config.qualification.bindings;
  const observed = {
    model: response.headers.get("x-vinci-model-id"),
    revision: response.headers.get("x-vinci-model-revision"),
    endpoint: response.headers.get("x-vinci-endpoint-identity-sha256"),
    runtime: {
      engine: response.headers.get("x-vinci-runtime-engine"),
      version: response.headers.get("x-vinci-runtime-version"),
      artifact_sha256: response.headers.get("x-vinci-runtime-artifact-sha256"),
      arguments_sha256: response.headers.get("x-vinci-runtime-arguments-sha256"),
    },
  };
  if (
    observed.model !== QWEN_MODEL ||
    observed.revision !== bindings.revision ||
    observed.endpoint !== bindings.endpoint_identity_sha256 ||
    qwenCanonical(observed.runtime) !== qwenCanonical(bindings.runtime)
  ) {
    fail("response_identity_mismatch", "inference response headers do not match the signed model/runtime/endpoint identity");
  }
}

function validateUsage(value: unknown): { input: number; output: number } {
  exactKeys(value, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"], "stream usage");
  const prompt = boundedInteger(value.prompt_tokens, 0, Number.MAX_SAFE_INTEGER, "stream usage prompt_tokens");
  const completion = boundedInteger(value.completion_tokens, 0, Number.MAX_SAFE_INTEGER, "stream usage completion_tokens");
  const total = boundedInteger(value.total_tokens, 0, Number.MAX_SAFE_INTEGER, "stream usage total_tokens");
  if (total !== prompt + completion) fail("usage_invalid", "stream usage total_tokens does not equal prompt plus completion");
  if (value.prompt_tokens_details !== null && typeof value.prompt_tokens_details !== "object") fail("usage_invalid", "prompt token details are malformed");
  if (value.completion_tokens_details !== null && typeof value.completion_tokens_details !== "object") fail("usage_invalid", "completion token details are malformed");
  return { input: prompt, output: completion };
}

function validateSseData(data: string): { done: boolean; responseId?: string; usage?: { input: number; output: number } } {
  if (data === "[DONE]") return { done: true };
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    fail("stream_invalid", "inference stream contains malformed JSON");
  }
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) fail("stream_invalid", "inference stream chunk is not an object");
  const record = chunk as Record<string, unknown>;
  const allowed = new Set(["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) fail("stream_invalid", "inference stream chunk has an unexpected field");
  if (typeof record.id !== "string" || !record.id || record.object !== "chat.completion.chunk" || record.model !== QWEN_MODEL || !Array.isArray(record.choices)) {
    fail("response_identity_mismatch", "inference stream chunk does not identify the exact qualified model/object");
  }
  if (record.usage !== undefined && record.usage !== null) {
    return { done: false, responseId: record.id, usage: validateUsage(record.usage) };
  }
  return { done: false, responseId: record.id };
}

function retryDelayMs(response: Response, maximum: number): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return Math.min(250, maximum);
  const seconds = Number(raw);
  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(requested) || requested < 0 || requested > maximum) {
    fail("retry_delay_exceeded", "provider retry delay is invalid or exceeds the qualified cap");
  }
  return requested;
}

async function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new QwenReadinessError("cancelled", "retry delay was cancelled"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function bodyBytes(body: RequestInit["body"]): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  fail("request_invalid", "Qwen request body must be a bounded in-memory encoding");
}

function inferenceBody(
  response: Response,
  config: QwenRuntimeConfig,
  abort: AbortController,
  finish: (outcome: string, status: number | null, inputTokens?: number, outputTokens?: number, responseId?: string | null) => void,
): ReadableStream<Uint8Array> {
  if (!response.body) fail("stream_invalid", "successful inference response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  let doneSeen = false;
  let usageSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let responseId: string | null = null;
  let settled = false;
  const settle = (outcome: string, status: number | null) => {
    if (settled) return;
    settled = true;
    finish(outcome, status, 0, 0, responseId);
  };
  const inspect = (text: string, final: boolean) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    const trailing = lines.pop() ?? "";
    pending = final ? "" : trailing;
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) fail("stream_invalid", "inference stream contains a non-SSE field");
      if (doneSeen) fail("stream_invalid", "inference stream contains data after [DONE]");
      const result = validateSseData(line.slice(5).trim());
      if (result.responseId && responseId && result.responseId !== responseId) {
        fail("response_identity_mismatch", "inference stream changed response id between chunks");
      }
      responseId ??= result.responseId ?? null;
      if (result.usage && usageSeen) fail("usage_invalid", "inference stream contains more than one usage object");
      if (result.done && !usageSeen) fail("stream_invalid", "inference stream ended before its strict usage object");
      doneSeen = result.done;
      if (result.usage) {
        usageSeen = true;
        inputTokens = result.usage.input;
        outputTokens = result.usage.output;
      }
    }
    if (final && trailing.trim()) fail("stream_invalid", "inference stream ended with a partial SSE line");
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          inspect(decoder.decode(), true);
          if (!doneSeen || !usageSeen) fail("stream_invalid", "inference stream omitted [DONE] or its strict usage object");
          if (!settled) {
            settled = true;
            finish("transport_accepted", response.status, inputTokens, outputTokens, responseId);
          }
          controller.close();
          return;
        }
        bytes += next.value.length;
        if (bytes > config.qualification.limits.max_response_bytes) {
          abort.abort("response_oversized");
          fail("response_oversized", "inference stream exceeded the signed response-byte bound");
        }
        inspect(decoder.decode(next.value, { stream: true }), false);
        controller.enqueue(next.value);
      } catch (error) {
        settle(error instanceof QwenReadinessError ? error.code : "stream_error", response.status);
        controller.error(error);
      }
    },
    cancel() {
      abort.abort("cancelled");
      settle("cancelled", response.status);
      void reader.cancel();
    },
  });
}

export function createQwenInferenceFetch(
  config: QwenRuntimeConfig,
  requestId: string,
  onAttempt: (record: QwenAttemptRecord) => void,
  injectedFetch?: QwenFetch,
  semanticSettlement: QwenSemanticSettlement = { transportFailed: false, settled: false },
): QwenFetch {
  return async (input, init = {}) => {
    assertQwenCircuitClosed(config);
    const sourceRequest = input instanceof Request ? input : undefined;
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method ?? sourceRequest?.method ?? "GET").toUpperCase();
    if (target.href !== config.chatUrl || method !== "POST") {
      fail("ssrf_forbidden", "inference transport may call only the exact qualified chat-completions URL");
    }
    const requestBytes = init.body !== undefined
      ? bodyBytes(init.body)
      : sourceRequest
        ? Buffer.from(await sourceRequest.clone().arrayBuffer())
        : Buffer.alloc(0);
    if (requestBytes.length > config.qualification.limits.max_request_bytes) {
      fail("request_oversized", "inference request exceeded the signed request-byte bound");
    }
    let finalPayload: unknown;
    try {
      finalPayload = JSON.parse(requestBytes.toString("utf8"));
    } catch {
      fail("request_invalid", "final serialized Qwen request body is not JSON");
    }
    validateQwenOutboundPayload(config, finalPayload);
    const requestSha256 = qwenSha256(requestBytes);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("total_timeout"), config.qualification.limits.total_timeout_ms);
    const externalSignal = init.signal ?? sourceRequest?.signal;
    const abort = () => controller.abort(externalSignal?.reason ?? "cancelled");
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    let timerOwnedByBody = false;
    try {
      for (let transportAttempt = 0; transportAttempt <= config.qualification.limits.max_retries; transportAttempt += 1) {
        assertQwenCircuitClosed(config);
        const started = Date.now();
        const startedAt = new Date(started).toISOString();
        const real = injectedFetch ? null : realPinnedFetch(config, transportAttempt);
        const headers = new Headers(sourceRequest?.headers);
        if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        headers.set("authorization", `Bearer ${config.secret}`);
        for (const [name, value] of Object.entries(qwenProviderHeaders(config, requestId))) {
          if (value !== null) headers.set(name, value);
        }
        headers.set("x-vinci-idempotency-key", `${requestId}/${transportAttempt}`);
        headers.set("x-vinci-qwen-request-sha256", requestSha256);
        let attemptReported = false;
        const finishAttempt = (outcome: string, status: number | null, inputTokens = 0, outputTokens = 0, responseId: string | null = null) => {
          if (attemptReported) return;
          attemptReported = true;
          real?.close();
          const finished = Date.now();
          const record: QwenAttemptRecord = {
            request_id: requestId,
            transport_attempt: transportAttempt,
            started_at: startedAt,
            finished_at: new Date(finished).toISOString(),
            latency_ms: finished - started,
            outcome,
            status,
            cost_usd: outcome === "transport_accepted"
              ? (inputTokens * config.qualification.pricing.input_per_million_usd + outputTokens * config.qualification.pricing.output_per_million_usd) / 1_000_000
              : 0,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            request_sha256: requestSha256,
            response_id: responseId,
          };
          if (outcome === "transport_accepted") {
            semanticSettlement.accepted = record;
          } else {
            semanticSettlement.transportFailed = true;
            semanticSettlement.settled = true;
            if (outcome !== "cancelled") recordQwenCircuitOutcome(config, false, outcome, finished);
            onAttempt(record);
          }
        };
        let response: Response;
        try {
          response = await (injectedFetch ?? real!.fetchImpl)(target, {
            ...init,
            method,
            body: requestBytes,
            headers,
            redirect: "error",
            signal: controller.signal,
          });
        } catch (error) {
          const outcome = externalSignal?.aborted ? "cancelled" : controller.signal.aborted ? "request_timeout" : "transport_error";
          finishAttempt(outcome, null);
          if (externalSignal?.aborted) fail("cancelled", "inference request was cancelled");
          if (controller.signal.aborted) fail("request_timeout", "inference request exceeded its total deadline");
          if (transportAttempt === config.qualification.limits.max_retries) throw error;
          await cancellableDelay(Math.min(250, config.qualification.limits.max_retry_delay_ms), controller.signal);
          continue;
        }
        if (response.status >= 300 && response.status < 400) {
          finishAttempt("redirect_forbidden", response.status);
          fail("redirect_forbidden", "inference redirects are refused");
        }
        if (!response.ok) {
          try {
            await readBoundedText(response, config.qualification.limits.max_error_bytes, controller);
          } catch (error) {
            finishAttempt(error instanceof QwenReadinessError ? error.code : "error_body_invalid", response.status);
            throw error;
          }
          finishAttempt(`http_${response.status}`, response.status);
          const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
          if (!retryable || transportAttempt === config.qualification.limits.max_retries) {
            fail("http_status", `inference returned HTTP ${response.status}`);
          }
          await cancellableDelay(retryDelayMs(response, config.qualification.limits.max_retry_delay_ms), controller.signal);
          continue;
        }
        try {
          responseIdentityHeaders(response, config);
        } catch (error) {
          finishAttempt(error instanceof QwenReadinessError ? error.code : "response_identity_mismatch", response.status);
          throw error;
        }
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
          finishAttempt("content_type_invalid", response.status);
          fail("stream_invalid", "inference response is not text/event-stream");
        }
        const finish = (outcome: string, status: number | null, inputTokens = 0, outputTokens = 0, responseId: string | null = null) => {
          clearTimeout(timeout);
          externalSignal?.removeEventListener("abort", abort);
          finishAttempt(outcome, status, inputTokens, outputTokens, responseId);
        };
        const body = inferenceBody(response, config, controller, finish);
        timerOwnedByBody = true;
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      fail("endpoint_unavailable", "inference transport exhausted its bounded attempts");
    } finally {
      if (!timerOwnedByBody) {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abort);
      }
    }
  };
}

export function settleQwenSemanticOutcome(
  config: QwenRuntimeConfig,
  settlement: QwenSemanticSettlement,
  accepted: boolean,
  reason: string,
  onAttempt: (record: QwenAttemptRecord) => void,
): void {
  if (settlement.settled) return;
  settlement.settled = true;
  if (!settlement.accepted) {
    if (!settlement.transportFailed) recordQwenCircuitOutcome(config, false, reason);
    return;
  }
  const finished = Date.now();
  const outcome = accepted ? "success" : reason;
  recordQwenCircuitOutcome(config, accepted, outcome, finished);
  onAttempt({
    ...settlement.accepted,
    finished_at: new Date(finished).toISOString(),
    latency_ms: Math.max(0, finished - Date.parse(settlement.accepted.started_at)),
    outcome,
  });
}

export function assertQwenContextBindings(config: QwenRuntimeConfig, context: Context): void {
  const bindings = config.qualification.bindings;
  const workOrderMessage = context.messages.find((message) => message.role === "user");
  if (!workOrderMessage || typeof workOrderMessage.content !== "string" || qwenSha256(workOrderMessage.content) !== bindings.work_order_prompt_sha256) {
    fail("prompt_mismatch", "first runtime user message is not the exact qualified WorkOrder prompt");
  }
  if (qwenSha256(context.systemPrompt ?? "") !== bindings.system_prompt_sha256) {
    fail("system_prompt_mismatch", "full assembled system prompt is not independently qualified");
  }
  const tools = context.tools ?? [];
  if (qwenSha256(qwenCanonical(tools.map((tool) => tool.name))) !== bindings.tool_names_sha256) {
    fail("tools_mismatch", "runtime tool order differs from the signed qualification");
  }
  if (qwenSha256(qwenCanonical(tools)) !== bindings.tool_schemas_sha256) {
    fail("tool_schema_mismatch", "runtime tool schemas differ from the signed qualification");
  }
}

export function validateQwenOutboundPayload(config: QwenRuntimeConfig, payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("request_invalid", "outbound request payload must be an object");
  const value = payload as Record<string, unknown>;
  const allowed = new Set([
    "model",
    "messages",
    "tools",
    "tool_choice",
    "stream",
    "stream_options",
    "temperature",
    "max_tokens",
    "reasoning_effort",
    "chat_template_kwargs",
  ]);
  if (Object.entries(value).some(([key, field]) => field !== undefined && !allowed.has(key))) {
    fail("request_invalid", "outbound request payload has an unqualified field");
  }
  if (value.model !== QWEN_MODEL || value.stream !== true || !Array.isArray(value.messages)) {
    fail("request_invalid", "outbound request must stream the exact qualified model and messages");
  }
  if (!Array.isArray(value.tools)) fail("request_invalid", "outbound request must carry the qualified tool schemas");
  const messages = value.messages as Array<unknown>;
  const records = messages.filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message));
  if (records.length !== messages.length) fail("request_invalid", "outbound messages must be objects");
  const system = records.find((message) => message.role === "system" || message.role === "developer");
  const workOrder = records.find((message) => message.role === "user");
  if (!system || typeof system.content !== "string" || qwenSha256(system.content) !== config.qualification.bindings.system_prompt_sha256) {
    fail("system_prompt_mismatch", "final serialized request does not contain the exact qualified system prompt");
  }
  if (!workOrder || typeof workOrder.content !== "string" || qwenSha256(workOrder.content) !== config.qualification.bindings.work_order_prompt_sha256) {
    fail("prompt_mismatch", "final serialized request does not contain the exact qualified WorkOrder prompt");
  }
  const wireTools = (value.tools as Array<unknown>).map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) fail("request_invalid", "outbound tool schema must be an object");
    const wire = tool as Record<string, unknown>;
    exactKeys(wire, ["type", "function"], "outbound tool schema");
    if (wire.type !== "function" || !wire.function || typeof wire.function !== "object" || Array.isArray(wire.function)) {
      fail("request_invalid", "outbound tool schema must be an OpenAI function");
    }
    const fn = wire.function as Record<string, unknown>;
    exactKeys(fn, ["name", "description", "parameters"], "outbound tool function");
    return { name: fn.name, description: fn.description, parameters: fn.parameters };
  });
  if (qwenSha256(qwenCanonical(wireTools.map((tool) => tool.name))) !== config.qualification.bindings.tool_names_sha256) {
    fail("tools_mismatch", "final serialized request tool order differs from qualification");
  }
  if (qwenSha256(qwenCanonical(wireTools)) !== config.qualification.bindings.tool_schemas_sha256) {
    fail("tool_schema_mismatch", "final serialized request tool schemas differ from qualification");
  }
  if (typeof value.max_tokens !== "number" || !Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > config.qualification.limits.max_tokens) {
    fail("request_invalid", "outbound max_tokens exceeds the signed bound");
  }
  const streamOptions = value.stream_options;
  if (!streamOptions || typeof streamOptions !== "object" || (streamOptions as Record<string, unknown>).include_usage !== true) {
    fail("request_invalid", "outbound stream must request usage telemetry");
  }
}

export function acquireQwenFleetPermit(config: QwenRuntimeConfig): () => void {
  const expiresAt = Date.parse(config.fleetPermit.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() < config.qualification.limits.total_timeout_ms) {
    fail("fleet_permit_expired", "the external Qwen fleet permit cannot cover the full bounded request deadline");
  }
  const lockPath = join(config.fleetPermit.lockDirectory, "qwen-h200-concurrency-1");
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("concurrency_exceeded", "the external Qwen fleet permit is already held by another provider process");
    }
    fail("fleet_permit_unavailable", "the external Qwen fleet permit could not be acquired");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      rmdirSync(lockPath);
    } catch {
      fail("fleet_permit_release_failed", "the external Qwen fleet permit could not be released cleanly");
    }
  };
}

function canaryConfig(env: NodeJS.ProcessEnv): QwenRuntimeConfig {
  const urls = normalizeQwenBaseUrl(env.VINCI_QWEN_BASE_URL);
  const secret = readCanarySecret(env.VINCI_QWEN_SECRET_REF);
  return {
    ...urls,
    endpointAddresses: [],
    secret,
    qualification: {
      schema: QUALIFICATION_SCHEMA,
      status: "qualified",
      authority_role: AUTHORITY_ROLE,
      fallback_policy: FALLBACK_POLICY,
      safe_resume: false,
      provenance: {
        issuer: "canary-only",
        authority: QUALIFICATION_AUTHORITY,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1_000).toISOString(),
        review_message_id: "canary-only",
        review_body_sha256: "0".repeat(64),
        burn_in_report_sha256: "0".repeat(64),
        canary: { schema: CANARY_SCHEMA, report_sha256: "0".repeat(64), observed_at: new Date().toISOString() },
      },
      burn_in: {
        schema: "vinci.qwen-worker-burn-in.v1",
        previous_concurrency: 0,
        target_concurrency: 1,
        observed_hours: 0,
        work_orders: 0,
        acceptance_pass_rate: 1,
        usage_coverage_rate: 1,
        transport_error_rate: 0,
        identity_failures: 0,
        verification_failures: 0,
        circuit_opens: 0,
        resource_alarms: 0,
        governor_stops: 0,
      },
      bindings: {
        model: QWEN_MODEL,
        revision: "0".repeat(40),
        runtime: { engine: "canary", version: "canary", artifact_sha256: "0".repeat(64), arguments_sha256: "0".repeat(64) },
        endpoint_sha256: qwenSha256(urls.baseUrl),
        endpoint_identity_sha256: "0".repeat(64),
        work_order_prompt_sha256: "0".repeat(64),
        system_prompt_sha256: "0".repeat(64),
        tool_names_sha256: "0".repeat(64),
        tool_schemas_sha256: "0".repeat(64),
        tool_policy_sha256: "0".repeat(64),
        client_build_sha256: "0".repeat(64),
        extension_build_sha256: "0".repeat(64),
        request_encoding_sha256: qwenSha256(qwenCanonical(QWEN_REQUEST_ENCODING)),
      },
      capabilities: { streaming_sse: true, tool_calls: true, structured_output: "tool-arguments-json", usage_chunk: true },
      limits: {
        total_timeout_ms: boundedInteger(Number(env.VINCI_QWEN_CANARY_TIMEOUT_MS ?? "30000"), 1_000, 300_000, "VINCI_QWEN_CANARY_TIMEOUT_MS"),
        max_retries: 0,
        max_retry_delay_ms: 0,
        max_concurrency: 1,
        advertised_max_concurrency: 1,
        context_window: 8_192,
        max_tokens: 64,
        max_request_bytes: 64 * 1024,
        max_response_bytes: MAX_CANARY_BYTES,
        max_error_bytes: 64 * 1024,
      },
      pricing: {
        currency: "USD",
        basis: "canary-only",
        input_per_million_usd: 0,
        output_per_million_usd: 0,
        cache_read_per_million_usd: 0,
        cache_write_per_million_usd: 0,
      },
      requalification_conditions: [...QWEN_REQUALIFICATION_CONDITIONS],
    },
    qualificationSha256: "0".repeat(64),
    circuitFile: "/canary/unused",
    circuitThreshold: 1,
    circuitOpenMs: 1_000,
    fleetPermit: { permitId: "canary-only", lockDirectory: "/canary", expiresAt: new Date(Date.now() + 1_000).toISOString() },
    attribution: { workOrderId: "canary-read-only", runId: "canary-read-only", attemptId: "canary-read-only/1" },
  };
}

export async function runQwenCanary(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: QwenFetch,
  lookupImpl?: QwenLookup,
): Promise<Record<string, unknown>> {
  const config = canaryConfig(env);
  await pinQwenEndpoint(config, lookupImpl);
  const maximum = config.qualification.limits.max_error_bytes;
  const started = Date.now();
  const health = await boundedRequest(config, config.healthUrl, { headers: authHeaders(config) }, maximum, { fetchImpl });
  await validateHealthResponse(health.response, health.text);
  const models = await boundedRequest(config, config.modelsUrl, { headers: authHeaders(config) }, maximum, { fetchImpl });
  if (!models.response.ok) fail("models_failed", `authenticated /v1/models returned ${models.response.status}`);
  const identity = servedIdentity(models.response, JSON.parse(models.text));
  config.qualification.bindings.revision = identity.revision;
  config.qualification.bindings.runtime = identity.runtime;
  config.qualification.bindings.endpoint_identity_sha256 = identity.endpointIdentity;
  for (const [url, path] of [[config.healthUrl, "/health"], [config.modelsUrl, "/v1/models"]] as const) {
    const anonymous = await boundedRequest(config, url, { headers: { accept: "application/json" } }, maximum, { fetchImpl });
    if (anonymous.response.status !== 401 && anonymous.response.status !== 403) fail("auth_not_enforced", `unauthenticated ${path} was not refused`);
  }
  const response = await boundedRequest(
    config,
    config.chatUrl,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        model: QWEN_MODEL,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
        max_tokens: 64,
        messages: [
          { role: "system", content: "Call report_ready exactly once. Do not return prose." },
          { role: "user", content: "Report readiness." },
        ],
        tools: [{
          type: "function",
          function: {
            name: "report_ready",
            description: "Reports deterministic worker compatibility.",
            strict: false,
            parameters: {
              type: "object",
              properties: { status: { type: "string", enum: ["ready"] } },
              required: ["status"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "report_ready" } },
      }),
    },
    MAX_CANARY_BYTES,
    { fetchImpl },
  );
  if (!response.response.ok) fail("canary_failed", `streaming tool-call inference returned ${response.response.status}`);
  responseIdentityHeaders(response.response, config);
  if (!response.response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    fail("canary_invalid", "streaming tool-call inference did not return text/event-stream");
  }
  let toolName = "";
  let argumentsText = "";
  let usageSeen = false;
  let doneSeen = false;
  for (const line of response.text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (doneSeen) fail("canary_invalid", "stream contained data after [DONE]");
    const validation = validateSseData(data);
    doneSeen = validation.done;
    usageSeen ||= validation.usage !== undefined;
    if (validation.done) continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      fail("canary_invalid", "stream contained malformed JSON");
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const delta = choice && typeof choice === "object" ? (choice as Record<string, unknown>).delta : null;
      const toolCalls = delta && typeof delta === "object" && Array.isArray((delta as Record<string, unknown>).tool_calls)
        ? ((delta as Record<string, unknown>).tool_calls as unknown[])
        : [];
      for (const call of toolCalls) {
        const fn = call && typeof call === "object" ? (call as Record<string, unknown>).function : null;
        if (!fn || typeof fn !== "object") continue;
        const name = (fn as Record<string, unknown>).name;
        const args = (fn as Record<string, unknown>).arguments;
        if (typeof name === "string") toolName += name;
        if (typeof args === "string") argumentsText += args;
      }
    }
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(argumentsText);
  } catch {
    fail("canary_invalid", "tool-call arguments were not complete JSON");
  }
  if (toolName !== "report_ready" || qwenCanonical(argumentsValue) !== qwenCanonical({ status: "ready" }) || !usageSeen || !doneSeen) {
    fail("canary_invalid", "stream omitted the required structured tool call, strict usage, or [DONE]");
  }
  return {
    schema: CANARY_SCHEMA,
    observed_at: new Date().toISOString(),
    endpoint_sha256: qwenSha256(config.baseUrl),
    endpoint_identity_sha256: identity.endpointIdentity,
    pinned_addresses_sha256: qwenSha256(qwenCanonical(config.endpointAddresses)),
    model: QWEN_MODEL,
    revision: identity.revision,
    runtime: identity.runtime,
    authenticated: true,
    anonymous_refused: true,
    capabilities: { streaming_sse: true, tool_calls: true, structured_output: "tool-arguments-json", usage_chunk: true },
    latency_ms: Date.now() - started,
    authority_role: AUTHORITY_ROLE,
    fallback_policy: FALLBACK_POLICY,
    safe_resume: false,
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) fail("config_missing", `${name} is required`);
  return value;
}

export function buildQwenQualificationRequest(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const urls = normalizeQwenBaseUrl(env.VINCI_QWEN_BASE_URL);
  const readInput = (name: string, maximum: number) => secureRegularFile(requiredEnv(env, name), name, maximum);
  const prompt = readInput("VINCI_QWEN_QUALIFICATION_PROMPT_FILE", 1024 * 1024);
  const systemPrompt = readInput("VINCI_QWEN_QUALIFICATION_SYSTEM_PROMPT_FILE", 4 * 1024 * 1024);
  const toolSchemas = readInput("VINCI_QWEN_QUALIFICATION_TOOL_SCHEMAS_FILE", 4 * 1024 * 1024);
  const canaryBytes = readInput("VINCI_QWEN_CANARY_REPORT_FILE", MAX_CANARY_BYTES);
  const burnInBytes = readInput("VINCI_QWEN_BURN_IN_REPORT_FILE", MAX_BURN_IN_BYTES);
  let canary: unknown;
  try {
    canary = JSON.parse(canaryBytes.toString("utf8"));
  } catch {
    fail("config_invalid", "canary report is not JSON");
  }
  if (!canary || typeof canary !== "object" || (canary as Record<string, unknown>).schema !== CANARY_SCHEMA || (canary as Record<string, unknown>).model !== QWEN_MODEL) {
    fail("config_invalid", "canary report does not describe the v2 exact-model canary");
  }
  let burnIn: unknown;
  try {
    burnIn = JSON.parse(burnInBytes.toString("utf8"));
  } catch {
    fail("config_invalid", "burn-in report is not JSON");
  }
  if (!burnIn || typeof burnIn !== "object" || (burnIn as Record<string, unknown>).schema !== "vinci.qwen-worker-burn-in.v1") {
    fail("config_invalid", "burn-in report does not describe the v1 numeric gate");
  }
  let tools: unknown;
  try {
    tools = JSON.parse(requiredEnv(env, "VINCI_QWEN_QUALIFICATION_TOOLS"));
  } catch {
    fail("config_invalid", "VINCI_QWEN_QUALIFICATION_TOOLS must be a JSON array");
  }
  if (!Array.isArray(tools) || tools.length < 1 || !tools.every((tool) => typeof tool === "string" && tool.length > 0)) {
    fail("config_invalid", "VINCI_QWEN_QUALIFICATION_TOOLS must be a non-empty ordered string array");
  }
  let parsedToolSchemas: unknown;
  try {
    parsedToolSchemas = JSON.parse(toolSchemas.toString("utf8"));
  } catch {
    fail("config_invalid", "VINCI_QWEN_QUALIFICATION_TOOL_SCHEMAS_FILE must contain JSON");
  }
  const runtime = validateRuntime({
    engine: requiredEnv(env, "VINCI_QWEN_RUNTIME_ENGINE"),
    version: requiredEnv(env, "VINCI_QWEN_RUNTIME_VERSION"),
    artifact_sha256: requiredEnv(env, "VINCI_QWEN_RUNTIME_ARTIFACT_SHA256"),
    arguments_sha256: requiredEnv(env, "VINCI_QWEN_RUNTIME_ARGUMENTS_SHA256"),
  });
  const revision = requiredEnv(env, "VINCI_QWEN_SERVED_REVISION");
  if (!IMMUTABLE_REVISION.test(revision)) fail("config_invalid", "served revision must be immutable 40- or 64-hex");
  const numberEnv = (name: string) => Number(requiredEnv(env, name));
  const toolPolicy = {
    ordered_tools: tools,
    unattended_policy: "governed",
    authority: "Governor",
    safe_resume: false,
  };
  return {
    schema: QUALIFICATION_REQUEST_SCHEMA,
    candidate: {
      model: QWEN_MODEL,
      revision,
      runtime,
      endpoint_sha256: qwenSha256(urls.baseUrl),
      endpoint_identity_sha256: requiredEnv(env, "VINCI_QWEN_ENDPOINT_IDENTITY_SHA256"),
      work_order_prompt_sha256: qwenSha256(prompt),
      system_prompt_sha256: qwenSha256(systemPrompt),
      tool_names_sha256: qwenSha256(qwenCanonical(tools)),
      tool_schemas_sha256: qwenSha256(qwenCanonical(parsedToolSchemas)),
      tool_policy_sha256: qwenSha256(qwenCanonical(toolPolicy)),
      client_build_sha256: requiredEnv(env, "VINCI_QWEN_CLIENT_BUILD_SHA256"),
      extension_build_sha256: requiredEnv(env, "VINCI_QWEN_EXTENSION_BUILD_SHA256"),
      request_encoding_sha256: qwenSha256(qwenCanonical(QWEN_REQUEST_ENCODING)),
      canary_report_sha256: qwenSha256(canaryBytes),
      canary_observed_at: (canary as Record<string, unknown>).observed_at,
      burn_in_report_sha256: qwenSha256(burnInBytes),
      burn_in: burnIn,
      capabilities: (canary as Record<string, unknown>).capabilities,
      limits: {
        total_timeout_ms: Number(env.VINCI_QWEN_TOTAL_TIMEOUT_MS ?? "120000"),
        max_retries: Number(env.VINCI_QWEN_MAX_RETRIES ?? "1"),
        max_retry_delay_ms: Number(env.VINCI_QWEN_MAX_RETRY_DELAY_MS ?? "5000"),
        max_concurrency: Number(env.VINCI_QWEN_MAX_CONCURRENCY ?? "1"),
        advertised_max_concurrency: numberEnv("VINCI_QWEN_ADVERTISED_MAX_CONCURRENCY"),
        context_window: numberEnv("VINCI_QWEN_CONTEXT_WINDOW"),
        max_tokens: numberEnv("VINCI_QWEN_MAX_TOKENS"),
        max_request_bytes: Number(env.VINCI_QWEN_MAX_REQUEST_BYTES ?? String(4 * 1024 * 1024)),
        max_response_bytes: Number(env.VINCI_QWEN_MAX_RESPONSE_BYTES ?? String(16 * 1024 * 1024)),
        max_error_bytes: Number(env.VINCI_QWEN_MAX_ERROR_BYTES ?? String(64 * 1024)),
      },
      pricing: {
        currency: "USD",
        basis: requiredEnv(env, "VINCI_QWEN_PRICE_BASIS"),
        input_per_million_usd: numberEnv("VINCI_QWEN_INPUT_PER_MILLION_USD"),
        output_per_million_usd: numberEnv("VINCI_QWEN_OUTPUT_PER_MILLION_USD"),
        cache_read_per_million_usd: numberEnv("VINCI_QWEN_CACHE_READ_PER_MILLION_USD"),
        cache_write_per_million_usd: numberEnv("VINCI_QWEN_CACHE_WRITE_PER_MILLION_USD"),
      },
      requalification_conditions: QWEN_REQUALIFICATION_CONDITIONS,
      safe_resume: false,
      authority_role: AUTHORITY_ROLE,
      fallback_policy: FALLBACK_POLICY,
    },
  };
}

export function scrubQwenBootstrapEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of [
    "VINCI_QWEN_QUALIFICATION_FILE",
    "VINCI_QWEN_QUALIFICATION_SHA256",
  ]) delete env[name];
}

export function qwenProviderHeaders(config: QwenRuntimeConfig, requestId: string): ProviderHeaders {
  return {
    "x-vinci-work-order-id": config.attribution.workOrderId,
    "x-vinci-run-id": config.attribution.runId,
    "x-vinci-attempt-id": config.attribution.attemptId,
    "x-vinci-qwen-request-id": requestId,
    "x-vinci-qwen-fleet-permit-id": config.fleetPermit.permitId,
    "x-vinci-qwen-output-authority": "non-authoritative",
    "x-vinci-qwen-qualification-sha256": config.qualificationSha256,
  };
}

export function qwenModelWithOpenAiApi(model: Model<string>): Model<"openai-completions"> {
  return { ...model, api: "openai-completions" } as Model<"openai-completions">;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  if (process.argv.includes("--canary")) {
    runQwenCanary()
      .then((report) => process.stdout.write(`${qwenCanonical(report)}\n`))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  } else if (process.argv.includes("--qualification-request")) {
    try {
      process.stdout.write(`${qwenCanonical(buildQwenQualificationRequest())}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
