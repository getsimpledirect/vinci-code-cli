import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const QWEN_PROVIDER = "qwen-h200";
export const QWEN_MODEL = "Qwen/Qwen3.8-27B";
export const QWEN_API = "vinci-qwen-openai-completions";

const QUALIFICATION_SCHEMA = "vinci.qwen-worker-qualification.v1";
const CIRCUIT_SCHEMA = "vinci.qwen-worker-circuit.v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const FALLBACK_POLICY = "explicit-openrouter-separate-attempt-only";
const AUTHORITY_ROLE = "non-authoritative-evidence-and-proposals-only";
const HEX64 = /^[0-9a-f]{64}$/;
const IMMUTABLE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

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
  model: string;
  revision: string;
  runtime: RuntimeTuple;
  endpoint_sha256: string;
  prompt_sha256: string;
  tools_sha256: string;
  capabilities: {
    streaming_sse: boolean;
    tool_calls: boolean;
    structured_output: string;
  };
  limits: {
    timeout_ms: number;
    max_retries: number;
    max_retry_delay_ms: number;
    max_concurrency: number;
    context_window: number;
    max_tokens: number;
  };
  pricing: {
    input_per_million_usd: number;
    output_per_million_usd: number;
    cache_read_per_million_usd: number;
    cache_write_per_million_usd: number;
  };
};

export type QwenRuntimeConfig = {
  baseUrl: string;
  healthUrl: string;
  modelsUrl: string;
  chatUrl: string;
  secret: string;
  secretRef: string;
  qualification: Qualification;
  qualificationSha256: string;
  circuitFile: string;
  circuitThreshold: number;
  circuitOpenMs: number;
  attribution: {
    workOrderId: string;
    runId: string;
    attemptId: string;
  };
};

type CircuitState = {
  schema: string;
  failures: number;
  open_until_ms: number;
  last_reason: string | null;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("qualification_invalid", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) fail("qualification_invalid", `${label} has unexpected or missing fields`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("qualification_invalid", `${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("qualification_invalid", `${label} must be a finite non-negative number`);
  }
  return value;
}

export function normalizeQwenBaseUrl(raw: string | undefined): {
  baseUrl: string;
  healthUrl: string;
  modelsUrl: string;
  chatUrl: string;
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
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    fail("config_invalid", "VINCI_QWEN_BASE_URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  const withoutSlashes = parsed.toString().replace(/\/+$/, "");
  const root = withoutSlashes.endsWith("/v1") ? withoutSlashes.slice(0, -3) : withoutSlashes;
  return {
    baseUrl: `${root}/v1`,
    healthUrl: `${root}/health`,
    modelsUrl: `${root}/v1/models`,
    chatUrl: `${root}/v1/chat/completions`,
  };
}

function readSecretReference(reference: string | undefined, env: NodeJS.ProcessEnv): string {
  if (!reference) fail("config_missing", "VINCI_QWEN_SECRET_REF is required");
  let secret: string;
  if (reference.startsWith("env:")) {
    const name = reference.slice(4);
    if (!ENV_NAME.test(name)) fail("config_invalid", "VINCI_QWEN_SECRET_REF env name is invalid");
    secret = env[name] ?? "";
    // Keep the resolved value only in the provider closure. Repository tools inherit this process
    // environment, so leaving a dynamically named credential here would bypass the static key
    // inventory even though the reference itself is scrubbed later.
    delete env[name];
  } else if (reference.startsWith("file:")) {
    const path = reference.slice(5);
    if (!isAbsolute(path)) fail("config_invalid", "VINCI_QWEN_SECRET_REF file path must be absolute");
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      fail("credential_unavailable", "the referenced Qwen credential file is unavailable");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      fail("credential_unsafe", "the referenced Qwen credential must be a private regular file");
    }
    secret = readFileSync(path, "utf8").trim();
  } else {
    fail("config_invalid", "VINCI_QWEN_SECRET_REF must use env:NAME or file:/absolute/path");
  }
  if (!secret || secret.length > 16_384 || /\s/.test(secret)) {
    fail("credential_invalid", "the referenced Qwen credential is empty, oversized, or contains whitespace");
  }
  return secret;
}

function validateRuntime(value: unknown): RuntimeTuple {
  exactKeys(value, ["engine", "version", "artifact_sha256", "arguments_sha256"], "runtime");
  for (const key of ["engine", "version"] as const) {
    if (typeof value[key] !== "string" || !value[key]) fail("qualification_invalid", `runtime.${key} must be a non-empty string`);
  }
  for (const key of ["artifact_sha256", "arguments_sha256"] as const) {
    if (typeof value[key] !== "string" || !HEX64.test(value[key])) fail("qualification_invalid", `runtime.${key} must be lowercase SHA-256`);
  }
  return value as RuntimeTuple;
}

function validateQualification(raw: unknown): Qualification {
  exactKeys(
    raw,
    [
      "schema",
      "status",
      "authority_role",
      "fallback_policy",
      "model",
      "revision",
      "runtime",
      "endpoint_sha256",
      "prompt_sha256",
      "tools_sha256",
      "capabilities",
      "limits",
      "pricing",
    ],
    "qualification",
  );
  if (raw.schema !== QUALIFICATION_SCHEMA || raw.status !== "qualified") fail("qualification_invalid", "qualification is not an admitted v1 qualified record");
  if (raw.authority_role !== AUTHORITY_ROLE) fail("authority_forbidden", "Qwen must remain non-authoritative");
  if (raw.fallback_policy !== FALLBACK_POLICY) fail("fallback_forbidden", "fallback must be a separately authorized OpenRouter attempt");
  if (raw.model !== QWEN_MODEL) fail("model_mismatch", `qualification must name ${QWEN_MODEL}`);
  if (typeof raw.revision !== "string" || !IMMUTABLE_REVISION.test(raw.revision)) {
    fail("qualification_invalid", "revision must be an immutable lowercase 40- or 64-hex commit/digest");
  }
  const runtime = validateRuntime(raw.runtime);
  for (const key of ["endpoint_sha256", "prompt_sha256", "tools_sha256"] as const) {
    if (typeof raw[key] !== "string" || !HEX64.test(raw[key])) fail("qualification_invalid", `${key} must be lowercase SHA-256`);
  }

  exactKeys(raw.capabilities, ["streaming_sse", "tool_calls", "structured_output"], "capabilities");
  if (raw.capabilities.streaming_sse !== true || raw.capabilities.tool_calls !== true) {
    fail("capability_missing", "streaming SSE and structured tool calls must both be qualified");
  }
  if (raw.capabilities.structured_output !== "tool-arguments-json") {
    fail("capability_missing", "the worker-required structured output is tool-arguments JSON");
  }

  exactKeys(raw.limits, ["timeout_ms", "max_retries", "max_retry_delay_ms", "max_concurrency", "context_window", "max_tokens"], "limits");
  const limits = {
    timeout_ms: boundedInteger(raw.limits.timeout_ms, 1_000, 300_000, "limits.timeout_ms"),
    max_retries: boundedInteger(raw.limits.max_retries, 0, 2, "limits.max_retries"),
    max_retry_delay_ms: boundedInteger(raw.limits.max_retry_delay_ms, 0, 30_000, "limits.max_retry_delay_ms"),
    max_concurrency: boundedInteger(raw.limits.max_concurrency, 1, 8, "limits.max_concurrency"),
    context_window: boundedInteger(raw.limits.context_window, 8_192, 2_000_000, "limits.context_window"),
    max_tokens: boundedInteger(raw.limits.max_tokens, 256, 131_072, "limits.max_tokens"),
  };
  if (limits.max_tokens > limits.context_window) fail("qualification_invalid", "limits.max_tokens exceeds limits.context_window");

  exactKeys(raw.pricing, ["input_per_million_usd", "output_per_million_usd", "cache_read_per_million_usd", "cache_write_per_million_usd"], "pricing");
  const pricing = {
    input_per_million_usd: nonNegativeNumber(raw.pricing.input_per_million_usd, "pricing.input_per_million_usd"),
    output_per_million_usd: nonNegativeNumber(raw.pricing.output_per_million_usd, "pricing.output_per_million_usd"),
    cache_read_per_million_usd: nonNegativeNumber(raw.pricing.cache_read_per_million_usd, "pricing.cache_read_per_million_usd"),
    cache_write_per_million_usd: nonNegativeNumber(raw.pricing.cache_write_per_million_usd, "pricing.cache_write_per_million_usd"),
  };

  return { ...(raw as unknown as Qualification), runtime, limits, pricing };
}

function readQualification(env: NodeJS.ProcessEnv): { qualification: Qualification; digest: string } {
  const path = env.VINCI_QWEN_QUALIFICATION_FILE;
  const expectedDigest = env.VINCI_QWEN_QUALIFICATION_SHA256;
  if (!path || !isAbsolute(path)) fail("config_missing", "VINCI_QWEN_QUALIFICATION_FILE must be an absolute path");
  if (!expectedDigest || !HEX64.test(expectedDigest)) fail("config_missing", "VINCI_QWEN_QUALIFICATION_SHA256 must pin the qualification bytes");
  let stat;
  let bytes: Buffer;
  try {
    stat = lstatSync(path);
    bytes = readFileSync(path);
  } catch {
    fail("qualification_unavailable", "the pinned qualification artifact is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    fail("qualification_unsafe", "the qualification artifact must be a non-writable regular file");
  }
  if (sha256(bytes) !== expectedDigest) fail("qualification_digest_mismatch", "qualification bytes do not match the process pin");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("qualification_invalid", "qualification is not JSON");
  }
  return { qualification: validateQualification(parsed), digest: expectedDigest };
}

export function loadQwenRuntimeConfig(env: NodeJS.ProcessEnv = process.env): QwenRuntimeConfig {
  const urls = normalizeQwenBaseUrl(env.VINCI_QWEN_BASE_URL);
  const secretRef = env.VINCI_QWEN_SECRET_REF;
  const secret = readSecretReference(secretRef, env);
  const admitted = readQualification(env);
  const qualification = admitted.qualification;
  const expectedEndpoint = sha256(urls.baseUrl);
  if (qualification.endpoint_sha256 !== expectedEndpoint) fail("endpoint_mismatch", "qualification is bound to a different base URL");
  if (qualification.prompt_sha256 !== env.VINCI_QWEN_PROMPT_SHA256) fail("prompt_mismatch", "task prompt is not the qualified prompt");
  if (qualification.tools_sha256 !== env.VINCI_QWEN_TOOLS_SHA256) fail("tools_mismatch", "task tools are not the qualified tools");
  if (env.VINCI_UNATTENDED_POLICY !== "governed" || !env.VINCI_UNATTENDED_LEASE) {
    fail("authority_forbidden", "Qwen worker runs require a deterministic Governor lease");
  }
  const workOrderId = env.VINCI_QWEN_WORK_ORDER_ID;
  const runId = env.VINCI_QWEN_RUN_ID;
  const attemptId = env.VINCI_QWEN_ATTEMPT_ID;
  if (!workOrderId || !runId || !attemptId) fail("attribution_missing", "WorkOrder, Run, and Attempt attribution are required");
  const circuitFile = env.VINCI_QWEN_CIRCUIT_FILE;
  if (!circuitFile || !isAbsolute(circuitFile)) fail("config_missing", "VINCI_QWEN_CIRCUIT_FILE must be an absolute path");
  return {
    ...urls,
    secret,
    secretRef: secretRef as string,
    qualification,
    qualificationSha256: admitted.digest,
    circuitFile,
    circuitThreshold: boundedInteger(Number(env.VINCI_QWEN_CIRCUIT_THRESHOLD ?? "3"), 1, 10, "VINCI_QWEN_CIRCUIT_THRESHOLD"),
    circuitOpenMs: boundedInteger(Number(env.VINCI_QWEN_CIRCUIT_OPEN_MS ?? "60000"), 1_000, 3_600_000, "VINCI_QWEN_CIRCUIT_OPEN_MS"),
    attribution: { workOrderId, runId, attemptId },
  };
}

function emptyCircuit(): CircuitState {
  return { schema: CIRCUIT_SCHEMA, failures: 0, open_until_ms: 0, last_reason: null };
}

function readCircuit(path: string): CircuitState {
  if (!existsSync(path)) return emptyCircuit();
  try {
    const stat = lstatSync(path);
    const value = JSON.parse(readFileSync(path, "utf8")) as CircuitState;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || value.schema !== CIRCUIT_SCHEMA || !Number.isSafeInteger(value.failures) || value.failures < 0 || !Number.isSafeInteger(value.open_until_ms) || value.open_until_ms < 0) {
      fail("circuit_invalid", "circuit state is malformed or unsafe");
    }
    return value;
  } catch (error) {
    if (error instanceof QwenReadinessError) throw error;
    fail("circuit_invalid", "circuit state is unreadable");
  }
}

function writeCircuit(path: string, state: CircuitState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${canonical(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function assertQwenCircuitClosed(config: QwenRuntimeConfig, nowMs = Date.now()): void {
  const state = readCircuit(config.circuitFile);
  if (state.open_until_ms > nowMs) fail("circuit_open", `endpoint circuit is open until ${new Date(state.open_until_ms).toISOString()}`);
}

export function recordQwenCircuitOutcome(config: QwenRuntimeConfig, ok: boolean, reason: string, nowMs = Date.now()): void {
  if (ok) {
    writeCircuit(config.circuitFile, emptyCircuit());
    return;
  }
  const current = readCircuit(config.circuitFile);
  const failures = current.failures + 1;
  writeCircuit(config.circuitFile, {
    schema: CIRCUIT_SCHEMA,
    failures,
    open_until_ms: failures >= config.circuitThreshold ? nowMs + config.circuitOpenMs : 0,
    last_reason: reason.slice(0, 128),
  });
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > MAX_RESPONSE_BYTES) fail("response_oversized", "endpoint response exceeded 256 KiB");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const abort = () => controller.abort(signal?.reason ?? "cancelled");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) fail("cancelled", "readiness probe was cancelled");
      if (attempt === retries) break;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  const suffix = lastError instanceof Error && lastError.name === "AbortError" ? "timed out" : "failed";
  fail("endpoint_unavailable", `request ${suffix} after ${retries + 1} bounded attempt(s)`);
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

function servedIdentity(response: Response, payload: unknown): { revision: string; runtime: RuntimeTuple } {
  exactKeys(payload, ["object", "data"], "models response");
  if (payload.object !== "list" || !Array.isArray(payload.data)) fail("models_invalid", "/v1/models must return an OpenAI list");
  const matches = payload.data.filter((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === QWEN_MODEL);
  if (matches.length !== 1) fail("model_mismatch", `/v1/models must expose exactly one ${QWEN_MODEL}`);
  const model = matches[0] as Record<string, unknown>;
  const runtimeValue = model.runtime;
  const runtime = runtimeValue && typeof runtimeValue === "object"
    ? validateRuntime(runtimeValue)
    : validateRuntime({
        engine: response.headers.get("x-vinci-runtime-engine"),
        version: response.headers.get("x-vinci-runtime-version"),
        artifact_sha256: response.headers.get("x-vinci-runtime-artifact-sha256"),
        arguments_sha256: response.headers.get("x-vinci-runtime-arguments-sha256"),
      });
  const revision = typeof model.revision === "string" ? model.revision : response.headers.get("x-vinci-model-revision");
  if (!revision || !IMMUTABLE_REVISION.test(revision)) fail("identity_missing", "/v1/models omitted the immutable served revision");
  return { revision, runtime };
}

async function validateHealthResponse(response: Response): Promise<void> {
  if (!response.ok) fail("health_failed", `authenticated /health returned ${response.status}`);
  const healthText = await readBoundedText(response);
  if (!healthText) fail("health_invalid", "/health returned an empty response");
  let healthBody: unknown;
  try {
    healthBody = JSON.parse(healthText);
  } catch {
    fail("health_invalid", "/health returned non-JSON content");
  }
  const status = healthBody && typeof healthBody === "object" ? (healthBody as Record<string, unknown>).status : undefined;
  if (status !== "ok" && status !== "ready") fail("health_failed", "/health did not report ready");
}

export async function probeQwenReadiness(
  config: QwenRuntimeConfig,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; nowMs?: number } = {},
): Promise<{ revision: string; runtime: RuntimeTuple }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now();
  assertQwenCircuitClosed(config, nowMs);
  const timeoutMs = config.qualification.limits.timeout_ms;
  const retries = config.qualification.limits.max_retries;
  try {
    const health = await request(config.healthUrl, { headers: authHeaders(config) }, timeoutMs, retries, fetchImpl, options.signal);
    await validateHealthResponse(health);

    const models = await request(config.modelsUrl, { headers: authHeaders(config) }, timeoutMs, retries, fetchImpl, options.signal);
    if (!models.ok) fail("models_failed", `authenticated /v1/models returned ${models.status}`);
    const modelsText = await readBoundedText(models);
    let modelsBody: unknown;
    try {
      modelsBody = JSON.parse(modelsText);
    } catch {
      fail("models_invalid", "/v1/models returned non-JSON content");
    }
    const identity = servedIdentity(models, modelsBody);
    if (identity.revision !== config.qualification.revision || canonical(identity.runtime) !== canonical(config.qualification.runtime)) {
      fail("runtime_mismatch", "served model revision/runtime differs from the qualification tuple");
    }

    for (const [url, path] of [[config.healthUrl, "/health"], [config.modelsUrl, "/v1/models"]] as const) {
      const anonymous = await request(url, { headers: { accept: "application/json" } }, timeoutMs, 0, fetchImpl, options.signal);
      await readBoundedText(anonymous);
      if (anonymous.status !== 401 && anonymous.status !== 403) {
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
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; nowMs?: number } = {},
): Promise<QwenRuntimeConfig> {
  const config = loadQwenRuntimeConfig(env);
  await probeQwenReadiness(config, options);
  return config;
}

function canaryEndpointConfig(env: NodeJS.ProcessEnv): Pick<QwenRuntimeConfig, "baseUrl" | "healthUrl" | "modelsUrl" | "chatUrl" | "secret" | "attribution"> {
  const urls = normalizeQwenBaseUrl(env.VINCI_QWEN_BASE_URL);
  return {
    ...urls,
    secret: readSecretReference(env.VINCI_QWEN_SECRET_REF, env),
    attribution: {
      workOrderId: "canary-read-only",
      runId: "canary-read-only",
      attemptId: "canary-read-only/1",
    },
  };
}

export async function runQwenCanary(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const config = canaryEndpointConfig(env);
  const timeoutMs = boundedInteger(Number(env.VINCI_QWEN_CANARY_TIMEOUT_MS ?? "30000"), 1_000, 300_000, "VINCI_QWEN_CANARY_TIMEOUT_MS");
  const started = Date.now();
  const health = await request(config.healthUrl, { headers: authHeaders(config) }, timeoutMs, 0, fetchImpl);
  await validateHealthResponse(health);
  const models = await request(config.modelsUrl, { headers: authHeaders(config) }, timeoutMs, 0, fetchImpl);
  if (!models.ok) fail("models_failed", `authenticated /v1/models returned ${models.status}`);
  const identity = servedIdentity(models, JSON.parse(await readBoundedText(models)));
  for (const [url, path] of [[config.healthUrl, "/health"], [config.modelsUrl, "/v1/models"]] as const) {
    const anonymous = await request(url, { headers: { accept: "application/json" } }, timeoutMs, 0, fetchImpl);
    await readBoundedText(anonymous);
    if (anonymous.status !== 401 && anonymous.status !== 403) fail("auth_not_enforced", `unauthenticated ${path} was not refused`);
  }

  const response = await request(
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
    timeoutMs,
    0,
    fetchImpl,
  );
  if (!response.ok) fail("canary_failed", `streaming tool-call inference returned ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    fail("canary_invalid", "streaming tool-call inference did not return text/event-stream");
  }
  const stream = await readBoundedText(response);
  let toolName = "";
  let argumentsText = "";
  let usageSeen = false;
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      fail("canary_invalid", "stream contained malformed JSON");
    }
    if (chunk.usage && typeof chunk.usage === "object") usageSeen = true;
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
  if (toolName !== "report_ready" || canonical(argumentsValue) !== canonical({ status: "ready" })) {
    fail("canary_invalid", "stream did not return the required structured tool call");
  }
  if (!usageSeen) fail("canary_invalid", "stream omitted the usage chunk required for token telemetry");
  return {
    schema: "vinci.qwen-worker-canary.v1",
    model: QWEN_MODEL,
    revision: identity.revision,
    runtime: identity.runtime,
    authenticated: true,
    anonymous_refused: true,
    capabilities: { streaming_sse: true, tool_calls: true, structured_output: "tool-arguments-json", usage_chunk: usageSeen },
    latency_ms: Date.now() - started,
    authority_role: AUTHORITY_ROLE,
    fallback_policy: FALLBACK_POLICY,
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) fail("config_missing", `${name} is required`);
  return value;
}

export function buildQwenQualificationTemplate(env: NodeJS.ProcessEnv = process.env): Qualification {
  if (env.VINCI_QWEN_ADMIT !== "qualified") {
    fail("qualification_not_admitted", "VINCI_QWEN_ADMIT=qualified is required after independent canary review");
  }
  const urls = normalizeQwenBaseUrl(env.VINCI_QWEN_BASE_URL);
  const promptFile = requiredEnv(env, "VINCI_QWEN_QUALIFICATION_PROMPT_FILE");
  if (!isAbsolute(promptFile)) fail("config_invalid", "VINCI_QWEN_QUALIFICATION_PROMPT_FILE must be absolute");
  let prompt: string;
  try {
    prompt = readFileSync(promptFile, "utf8");
  } catch {
    fail("config_invalid", "qualification prompt file is unreadable");
  }
  let tools: unknown;
  try {
    tools = JSON.parse(requiredEnv(env, "VINCI_QWEN_QUALIFICATION_TOOLS"));
  } catch {
    fail("config_invalid", "VINCI_QWEN_QUALIFICATION_TOOLS must be a JSON array");
  }
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => typeof tool === "string" && tool.length > 0)) {
    fail("config_invalid", "VINCI_QWEN_QUALIFICATION_TOOLS must be a non-empty array of tool names");
  }
  const revision = requiredEnv(env, "VINCI_QWEN_SERVED_REVISION");
  if (!IMMUTABLE_REVISION.test(revision)) {
    fail("config_invalid", "VINCI_QWEN_SERVED_REVISION must be an immutable lowercase 40- or 64-hex commit/digest");
  }
  const runtime = validateRuntime({
    engine: requiredEnv(env, "VINCI_QWEN_RUNTIME_ENGINE"),
    version: requiredEnv(env, "VINCI_QWEN_RUNTIME_VERSION"),
    artifact_sha256: requiredEnv(env, "VINCI_QWEN_RUNTIME_ARTIFACT_SHA256"),
    arguments_sha256: requiredEnv(env, "VINCI_QWEN_RUNTIME_ARGUMENTS_SHA256"),
  });
  const numberEnv = (name: string) => Number(requiredEnv(env, name));
  return validateQualification({
    schema: QUALIFICATION_SCHEMA,
    status: "qualified",
    authority_role: AUTHORITY_ROLE,
    fallback_policy: FALLBACK_POLICY,
    model: QWEN_MODEL,
    revision,
    runtime,
    endpoint_sha256: sha256(urls.baseUrl),
    prompt_sha256: sha256(prompt),
    tools_sha256: sha256(canonical(tools)),
    capabilities: {
      streaming_sse: true,
      tool_calls: true,
      structured_output: "tool-arguments-json",
    },
    limits: {
      timeout_ms: Number(env.VINCI_QWEN_TIMEOUT_MS ?? "120000"),
      max_retries: Number(env.VINCI_QWEN_MAX_RETRIES ?? "1"),
      max_retry_delay_ms: Number(env.VINCI_QWEN_MAX_RETRY_DELAY_MS ?? "5000"),
      max_concurrency: Number(env.VINCI_QWEN_MAX_CONCURRENCY ?? "1"),
      context_window: numberEnv("VINCI_QWEN_CONTEXT_WINDOW"),
      max_tokens: numberEnv("VINCI_QWEN_MAX_TOKENS"),
    },
    pricing: {
      input_per_million_usd: numberEnv("VINCI_QWEN_INPUT_PER_MILLION_USD"),
      output_per_million_usd: numberEnv("VINCI_QWEN_OUTPUT_PER_MILLION_USD"),
      cache_read_per_million_usd: numberEnv("VINCI_QWEN_CACHE_READ_PER_MILLION_USD"),
      cache_write_per_million_usd: numberEnv("VINCI_QWEN_CACHE_WRITE_PER_MILLION_USD"),
    },
  });
}

export function scrubQwenBootstrapEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ["VINCI_QWEN_SECRET_REF", "VINCI_QWEN_QUALIFICATION_FILE", "VINCI_QWEN_QUALIFICATION_SHA256"]) delete env[name];
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  if (process.argv.includes("--canary")) {
    runQwenCanary()
      .then((report) => process.stdout.write(`${canonical(report)}\n`))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  } else if (process.argv.includes("--qualification-template")) {
    try {
      process.stdout.write(`${canonical(buildQwenQualificationTemplate())}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
