import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { streamSimple as sourceStreamSimpleOpenAICompletions } from "../../packages/ai/src/api/openai-completions.ts";
import * as runtime from "../extensions/lib/qwen-runtime.ts";
import { qwenProviderConfig } from "../extensions/vinci-qwen-provider.ts";
import * as cleanroom from "../worker/cleanroom.mjs";
import * as digest from "../worker/contracts/digest.mjs";
import * as economics from "../worker/economics.mjs";
import { runVinci } from "../worker/run.mjs";
import { TaskLifecycle } from "../worker/task.mjs";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "vinci-qwen-test-"));
const secretFile = join(temp, "secret");
const promptFile = join(temp, "prompt.txt");
const systemPromptFile = join(temp, "system.txt");
const toolSchemasFile = join(temp, "tools.json");
const canaryFile = join(temp, "canary.json");
const burnInFile = join(temp, "burn-in.json");
const qualificationFile = join(temp, "qualification.json");
const publicKeyFile = join(temp, "qualification-key.pem");
const permitLockDirectory = join(temp, "permit-locks");
const endpointIdentity = "12".repeat(32);
const revision = "ab".repeat(20);
const runtimeTuple = {
  engine: "vllm",
  version: "0.10.2",
  artifact_sha256: "cd".repeat(32),
  arguments_sha256: "ef".repeat(32),
};
const systemPrompt = "bounded governed system prompt";
const workOrderPrompt = "inspect the bounded fixture";
const tools = [
  { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "grep", description: "Search text", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];
const nowMs = Date.parse("2026-09-04T18:00:00.000Z");

async function exerciseConcurrentBreakerWrites(circuitFile, count) {
  const workerFile = join(temp, "breaker-worker.mjs");
  const startFile = join(temp, "breaker-start");
  const runtimeUrl = pathToFileURL(join(root, "vinci/extensions/lib/qwen-runtime.ts")).href;
  writeFileSync(workerFile, `import { existsSync, writeFileSync } from "node:fs";
import { recordQwenCircuitOutcome } from ${JSON.stringify(runtimeUrl)};
const [circuitFile, readyFile, startFile] = process.argv.slice(2);
writeFileSync(readyFile, "ready");
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(startFile)) Atomics.wait(sleep, 0, 0, 5);
recordQwenCircuitOutcome({ circuitFile, circuitThreshold: 100, circuitOpenMs: 60_000 }, false, "concurrent_500");
`, { mode: 0o600 });
  const children = Array.from({ length: count }, (_, index) => {
    const readyFile = join(temp, `breaker-ready-${index}`);
    const child = spawn(process.execPath, [...process.execArgv, workerFile, circuitFile, readyFile, startFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, readyFile };
  });
  await new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (children.every(({ readyFile }) => existsSync(readyFile))) return resolveReady();
      if (Date.now() >= deadline) return rejectReady(new Error("breaker workers did not become ready"));
      setTimeout(poll, 5);
    };
    poll();
  });
  writeFileSync(startFile, "start", { mode: 0o600 });
  await Promise.all(children.map(({ child }) => new Promise((resolveExit, rejectExit) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectExit);
    child.on("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`breaker worker exited ${code}: ${stderr}`)));
  })));
}

async function exerciseCrossProcessFleetPermit(config) {
  const release = runtime.acquireQwenFleetPermit(config);
  const workerFile = join(temp, "permit-worker.mjs");
  const runtimeUrl = pathToFileURL(join(root, "vinci/extensions/lib/qwen-runtime.ts")).href;
  writeFileSync(workerFile, `import { acquireQwenFleetPermit } from ${JSON.stringify(runtimeUrl)};
const [lockDirectory, permitId, expiresAt] = process.argv.slice(2);
try {
  acquireQwenFleetPermit({ fleetPermit: { lockDirectory, permitId, expiresAt }, qualification: { limits: { total_timeout_ms: 1_000 } } });
  process.exitCode = 2;
} catch (error) {
  if (error?.code !== "concurrency_exceeded") throw error;
}
`, { mode: 0o600 });
  try {
    const child = spawn(process.execPath, [...process.execArgv, workerFile, config.fleetPermit.lockDirectory, config.fleetPermit.permitId, config.fleetPermit.expiresAt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolveExit, rejectExit) => {
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", rejectExit);
      child.on("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`permit worker exited ${code}: ${stderr}`)));
    });
  } finally {
    release();
  }
}

function freshenPermit(config) {
  config.fleetPermit.expiresAt = new Date(Date.now() + 60_000).toISOString();
  return config;
}

writeFileSync(secretFile, "synthetic-test-secret\n", { mode: 0o600 });
mkdirSync(permitLockDirectory, { mode: 0o700 });
writeFileSync(promptFile, workOrderPrompt, { mode: 0o400 });
writeFileSync(systemPromptFile, systemPrompt, { mode: 0o400 });
writeFileSync(toolSchemasFile, `${JSON.stringify(tools)}\n`, { mode: 0o400 });
const canary = {
  schema: "vinci.qwen-worker-canary.v2",
  observed_at: "2026-09-04T16:00:00.000Z",
  endpoint_sha256: runtime.qwenSha256("https://qwen.example.test/v1"),
  endpoint_identity_sha256: endpointIdentity,
  model: runtime.QWEN_MODEL,
  revision,
  runtime: runtimeTuple,
  capabilities: { streaming_sse: true, tool_calls: true, structured_output: "tool-arguments-json", usage_chunk: true },
  safe_resume: false,
};
writeFileSync(canaryFile, `${runtime.qwenCanonical(canary)}\n`, { mode: 0o400 });
const entryBurnIn = {
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
};
writeFileSync(burnInFile, `${runtime.qwenCanonical(entryBurnIn)}\n`, { mode: 0o400 });

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyBytes = publicKey.export({ type: "spki", format: "pem" });
writeFileSync(publicKeyFile, publicKeyBytes, { mode: 0o400 });

const requestEnv = {
  VINCI_QWEN_BASE_URL: "https://qwen.example.test/v1",
  VINCI_QWEN_QUALIFICATION_PROMPT_FILE: promptFile,
  VINCI_QWEN_QUALIFICATION_SYSTEM_PROMPT_FILE: systemPromptFile,
  VINCI_QWEN_QUALIFICATION_TOOL_SCHEMAS_FILE: toolSchemasFile,
  VINCI_QWEN_QUALIFICATION_TOOLS: '["read","grep"]',
  VINCI_QWEN_CANARY_REPORT_FILE: canaryFile,
  VINCI_QWEN_BURN_IN_REPORT_FILE: burnInFile,
  VINCI_QWEN_SERVED_REVISION: revision,
  VINCI_QWEN_RUNTIME_ENGINE: runtimeTuple.engine,
  VINCI_QWEN_RUNTIME_VERSION: runtimeTuple.version,
  VINCI_QWEN_RUNTIME_ARTIFACT_SHA256: runtimeTuple.artifact_sha256,
  VINCI_QWEN_RUNTIME_ARGUMENTS_SHA256: runtimeTuple.arguments_sha256,
  VINCI_QWEN_ENDPOINT_IDENTITY_SHA256: endpointIdentity,
  VINCI_QWEN_CLIENT_BUILD_SHA256: "21".repeat(32),
  VINCI_QWEN_EXTENSION_BUILD_SHA256: "23".repeat(32),
  VINCI_QWEN_CONTEXT_WINDOW: "262144",
  VINCI_QWEN_MAX_TOKENS: "8192",
  VINCI_QWEN_ADVERTISED_MAX_CONCURRENCY: "32",
  VINCI_QWEN_MAX_CONCURRENCY: "1",
  VINCI_QWEN_TOTAL_TIMEOUT_MS: "1000",
  VINCI_QWEN_MAX_RETRIES: "1",
  VINCI_QWEN_MAX_RETRY_DELAY_MS: "0",
  VINCI_QWEN_MAX_REQUEST_BYTES: "4096",
  VINCI_QWEN_MAX_RESPONSE_BYTES: "4096",
  VINCI_QWEN_MAX_ERROR_BYTES: "256",
  VINCI_QWEN_PRICE_BASIS: "operator-estimate:h200-amortized-2026-09-04",
  VINCI_QWEN_INPUT_PER_MILLION_USD: "0.25",
  VINCI_QWEN_OUTPUT_PER_MILLION_USD: "0.75",
  VINCI_QWEN_CACHE_READ_PER_MILLION_USD: "0.05",
  VINCI_QWEN_CACHE_WRITE_PER_MILLION_USD: "0.25",
};

function qualificationFromRequest(overrides = {}, qualificationRequestEnv = requestEnv) {
  const candidate = runtime.buildQwenQualificationRequest(qualificationRequestEnv).candidate;
  return {
    schema: "vinci.qwen-worker-qualification.v2",
    status: "qualified",
    authority_role: candidate.authority_role,
    fallback_policy: candidate.fallback_policy,
    safe_resume: false,
    provenance: {
      issuer: "reviewer:test",
      authority: "independent-never-builder-review",
      issued_at: "2026-09-04T17:00:00.000Z",
      expires_at: "2026-09-05T17:00:00.000Z",
      review_message_id: "msg_independent_test",
      review_body_sha256: "45".repeat(32),
      burn_in_report_sha256: candidate.burn_in_report_sha256,
      canary: {
        schema: "vinci.qwen-worker-canary.v2",
        report_sha256: candidate.canary_report_sha256,
        observed_at: candidate.canary_observed_at,
      },
    },
    bindings: {
      model: candidate.model,
      revision: candidate.revision,
      runtime: candidate.runtime,
      endpoint_sha256: candidate.endpoint_sha256,
      endpoint_identity_sha256: candidate.endpoint_identity_sha256,
      work_order_prompt_sha256: candidate.work_order_prompt_sha256,
      system_prompt_sha256: candidate.system_prompt_sha256,
      tool_names_sha256: candidate.tool_names_sha256,
      tool_schemas_sha256: candidate.tool_schemas_sha256,
      tool_policy_sha256: candidate.tool_policy_sha256,
      client_build_sha256: candidate.client_build_sha256,
      extension_build_sha256: candidate.extension_build_sha256,
      request_encoding_sha256: candidate.request_encoding_sha256,
    },
    capabilities: candidate.capabilities,
    limits: candidate.limits,
    burn_in: candidate.burn_in,
    pricing: candidate.pricing,
    requalification_conditions: [...runtime.QWEN_REQUALIFICATION_CONDITIONS],
    ...overrides,
  };
}

function signedEnvelope(qualification, signingKey = privateKey) {
  const signature = sign(null, Buffer.from(runtime.qwenCanonical(qualification)), signingKey).toString("base64");
  return {
    schema: "vinci.qwen-worker-qualification-envelope.v2",
    qualification,
    signature: { algorithm: "Ed25519", key_id: "test-ed25519-1", signature_base64: signature },
  };
}

function writeQualification(value) {
  if (typeof value === "object" && value !== null) value = `${runtime.qwenCanonical(value)}\n`;
  try {
    chmodSync(qualificationFile, 0o600);
  } catch {}
  writeFileSync(qualificationFile, value, { mode: 0o600 });
  chmodSync(qualificationFile, 0o400);
  return runtime.qwenSha256(readFileSync(qualificationFile));
}

let qualification = qualificationFromRequest();
let qualificationDigest = writeQualification(signedEnvelope(qualification));

const baseRuntimeEnv = {
  VINCI_QWEN_BASE_URL: requestEnv.VINCI_QWEN_BASE_URL,
  VINCI_QWEN_QUALIFICATION_FILE: qualificationFile,
  VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest,
  VINCI_QWEN_PROMPT_SHA256: qualification.bindings.work_order_prompt_sha256,
  VINCI_QWEN_TOOLS_SHA256: qualification.bindings.tool_names_sha256,
  VINCI_QWEN_TOOL_POLICY_SHA256: qualification.bindings.tool_policy_sha256,
  VINCI_QWEN_CLIENT_BUILD_SHA256: qualification.bindings.client_build_sha256,
  VINCI_QWEN_EXTENSION_BUILD_SHA256: qualification.bindings.extension_build_sha256,
  VINCI_UNATTENDED_POLICY: "governed",
  VINCI_UNATTENDED_LEASE: "lease-test",
  VINCI_QWEN_WORK_ORDER_ID: "wo-test",
  VINCI_QWEN_RUN_ID: "run-test",
  VINCI_QWEN_ATTEMPT_ID: "task-test/1",
  VINCI_QWEN_CIRCUIT_FILE: join(temp, "circuit.json"),
  VINCI_QWEN_CIRCUIT_THRESHOLD: "2",
  VINCI_QWEN_CIRCUIT_OPEN_MS: "60000",
};

const authorityBoundary = {
  qualificationTrust: {
    issuer: "reviewer:test",
    publicKeyFile,
    publicKeySha256: runtime.qwenSha256(publicKeyBytes),
  },
  fleetPermit: {
    schema: "vinci.qwen-fleet-permit.v1",
    authority: "vgc-fleet-permit-authority",
    permitId: "permit-test-1",
    workOrderId: "wo-test",
    runId: "run-test",
    attemptId: "task-test/1",
    maxConcurrency: 1,
    lockDirectory: permitLockDirectory,
    issuedAt: "2026-09-04T17:59:00.000Z",
    expiresAt: "2026-09-04T18:04:00.000Z",
  },
};

function runtimeEnv(overrides = {}) {
  return { ...baseRuntimeEnv, VINCI_QWEN_SECRET_FD: String(openSync(secretFile, "r")), ...overrides };
}

function loadConfig(overrides = {}) {
  return runtime.loadQwenRuntimeConfig(runtimeEnv(overrides), nowMs, authorityBoundary);
}

function identityHeaders(overrides = {}) {
  return {
    "content-type": "text/event-stream",
    "x-vinci-model-id": runtime.QWEN_MODEL,
    "x-vinci-model-revision": revision,
    "x-vinci-endpoint-identity-sha256": endpointIdentity,
    "x-vinci-runtime-engine": runtimeTuple.engine,
    "x-vinci-runtime-version": runtimeTuple.version,
    "x-vinci-runtime-artifact-sha256": runtimeTuple.artifact_sha256,
    "x-vinci-runtime-arguments-sha256": runtimeTuple.arguments_sha256,
    ...overrides,
  };
}

const usage = {
  prompt_tokens: 10,
  completion_tokens: 2,
  total_tokens: 12,
  prompt_tokens_details: null,
  completion_tokens_details: null,
};
const validSse = [
  `data: ${JSON.stringify({ id: "chunk-1", object: "chat.completion.chunk", created: 1, model: runtime.QWEN_MODEL, choices: [], usage })}`,
  "data: [DONE]",
  "",
].join("\n");
const requestBody = JSON.stringify({
  model: runtime.QWEN_MODEL,
  messages: [{ role: "system", content: systemPrompt }, { role: "user", content: workOrderPrompt }],
  tools: tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })),
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 64,
});

try {
  assert.equal(qualification.safe_resume, false);
  assert.equal(qualification.limits.max_concurrency, 1);
  assert.equal(qualification.limits.advertised_max_concurrency, 32);
  assert.equal(qualification.bindings.request_encoding_sha256, runtime.qwenSha256(runtime.qwenCanonical(runtime.QWEN_REQUEST_ENCODING)));
  const config = loadConfig();
  assert.equal(config.secret, "synthetic-test-secret");
  assert.equal(config.qualification.provenance.authority, "independent-never-builder-review");
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv(), nowMs),
    /authority record.*unavailable|config_unavailable/,
    "runtime must not derive qualification trust or fleet permission from Worker environment",
  );
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({ VINCI_QWEN_CLIENT_BUILD_SHA256: "99".repeat(32) }), nowMs, authorityBoundary),
    /client_build_mismatch/,
  );

  const rogueKeys = generateKeyPairSync("ed25519");
  const roguePublicFile = join(temp, "rogue-key.pem");
  const roguePublicBytes = rogueKeys.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(roguePublicFile, roguePublicBytes, { mode: 0o400 });
  qualificationDigest = writeQualification(signedEnvelope(qualification, rogueKeys.privateKey));
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({
      VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest,
      VINCI_QWEN_QUALIFICATION_PUBLIC_KEY_FILE: roguePublicFile,
      VINCI_QWEN_QUALIFICATION_PUBLIC_KEY_SHA256: runtime.qwenSha256(roguePublicBytes),
      VINCI_QWEN_QUALIFICATION_ISSUER: "reviewer:test",
    }), nowMs, authorityBoundary),
    /qualification_signature_invalid/,
    "a Worker-chosen trust key must not self-admit a qualification",
  );
  qualificationDigest = writeQualification(signedEnvelope(qualification));
  baseRuntimeEnv.VINCI_QWEN_QUALIFICATION_SHA256 = qualificationDigest;

  const invalidSignature = structuredClone(signedEnvelope(qualification));
  invalidSignature.qualification.bindings.model = "Qwen/Qwen3.8-27B-tampered";
  qualificationDigest = writeQualification(invalidSignature);
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({ VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest }), nowMs, authorityBoundary),
    /qualification_signature_invalid/,
  );
  qualificationDigest = writeQualification(signedEnvelope(qualification));
  baseRuntimeEnv.VINCI_QWEN_QUALIFICATION_SHA256 = qualificationDigest;

  qualificationDigest = writeQualification(qualification);
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({ VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest }), nowMs, authorityBoundary),
    /qualification envelope.*missing fields|qualification envelope.*unexpected/,
  );
  qualificationDigest = writeQualification(signedEnvelope(qualification));
  baseRuntimeEnv.VINCI_QWEN_QUALIFICATION_SHA256 = qualificationDigest;

  const expired = qualificationFromRequest({
    provenance: { ...qualification.provenance, issued_at: "2026-09-01T16:00:00.000Z", expires_at: "2026-09-02T16:00:00.000Z" },
  });
  qualificationDigest = writeQualification(signedEnvelope(expired));
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({ VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest }), nowMs, authorityBoundary),
    /qualification_expired/,
  );
  qualificationDigest = writeQualification(signedEnvelope(qualification));
  baseRuntimeEnv.VINCI_QWEN_QUALIFICATION_SHA256 = qualificationDigest;

  const concurrency32 = qualificationFromRequest({
    limits: { ...qualification.limits, max_concurrency: 32 },
    burn_in: {
      ...entryBurnIn,
      previous_concurrency: 24,
      target_concurrency: 32,
      observed_hours: 168,
      work_orders: 1_000,
      transport_error_rate: 0.005,
    },
  });
  qualificationDigest = writeQualification(signedEnvelope(concurrency32));
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({ VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest }), nowMs, authorityBoundary),
    /fleet_permit_invalid/,
  );
  qualificationDigest = writeQualification(signedEnvelope(qualification));
  baseRuntimeEnv.VINCI_QWEN_QUALIFICATION_SHA256 = qualificationDigest;

  const skippedStage = qualificationFromRequest({
    limits: { ...qualification.limits, max_concurrency: 8 },
    burn_in: { ...entryBurnIn, previous_concurrency: 2, target_concurrency: 8, observed_hours: 168, work_orders: 1_000 },
  });
  qualificationDigest = writeQualification(signedEnvelope(skippedStage));
  assert.throws(
    () => runtime.loadQwenRuntimeConfig(runtimeEnv({ VINCI_QWEN_QUALIFICATION_SHA256: qualificationDigest }), nowMs, authorityBoundary),
    /burn_in_gate_failed/,
  );
  qualificationDigest = writeQualification(signedEnvelope(qualification));
  baseRuntimeEnv.VINCI_QWEN_QUALIFICATION_SHA256 = qualificationDigest;

  const observed = [];
  const readyFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    observed.push({ url: String(url), authorization: headers.get("authorization") });
    if (String(url).endsWith("/health") && !headers.has("authorization")) return Response.json({}, { status: 401 });
    if (String(url).endsWith("/health")) return Response.json({ status: "ready" });
    if (String(url).endsWith("/v1/models") && !headers.has("authorization")) return Response.json({}, { status: 401 });
    if (String(url).endsWith("/v1/models")) {
      return Response.json({
        object: "list",
        data: [{ id: runtime.QWEN_MODEL, revision, runtime: runtimeTuple, endpoint_identity_sha256: endpointIdentity }],
      });
    }
    throw new Error(`unexpected fake URL ${url}`);
  };
  const lookupPublic = async () => [{ address: "93.184.216.34", family: 4 }];
  const readyConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "ready-circuit.json") });
  const identity = await runtime.probeQwenReadiness(readyConfig, { fetchImpl: readyFetch, lookupImpl: lookupPublic, nowMs });
  assert.equal(identity.endpointIdentity, endpointIdentity);
  assert.deepEqual(observed.map((entry) => entry.authorization), ["Bearer synthetic-test-secret", "Bearer synthetic-test-secret", null, null]);

  const canarySse = [
    `data: ${JSON.stringify({
      id: "canary-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: runtime.QWEN_MODEL,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "report_ready", arguments: '{"status":"ready"}' } }] } }],
    })}`,
    `data: ${JSON.stringify({ id: "canary-usage", object: "chat.completion.chunk", created: 2, model: runtime.QWEN_MODEL, choices: [], usage })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const canaryFetch = async (url, init = {}) => {
    const target = String(url);
    const authenticated = new Headers(init.headers).has("authorization");
    if (!authenticated && (target.endsWith("/health") || target.endsWith("/v1/models"))) return Response.json({}, { status: 401 });
    if (target.endsWith("/health")) return Response.json({ status: "ready" });
    if (target.endsWith("/v1/models")) {
      return Response.json({
        object: "list",
        data: [{ id: runtime.QWEN_MODEL, revision, runtime: runtimeTuple, endpoint_identity_sha256: endpointIdentity }],
      });
    }
    if (target.endsWith("/v1/chat/completions")) return new Response(canarySse, { headers: identityHeaders() });
    throw new Error(`unexpected canary URL ${target}`);
  };
  const canaryReport = await runtime.runQwenCanary(
    {
      VINCI_QWEN_BASE_URL: requestEnv.VINCI_QWEN_BASE_URL,
      VINCI_QWEN_SECRET_REF: `file:${secretFile}`,
      VINCI_QWEN_CANARY_TIMEOUT_MS: "1000",
    },
    canaryFetch,
    lookupPublic,
  );
  assert.equal(canaryReport.safe_resume, false);
  assert.equal(canaryReport.endpoint_identity_sha256, endpointIdentity);
  assert.equal(canaryReport.pinned_addresses_sha256, runtime.qwenSha256(runtime.qwenCanonical(["93.184.216.34"])));

  const privateConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "private-circuit.json") });
  await assert.rejects(runtime.pinQwenEndpoint(privateConfig, async () => [{ address: "169.254.169.254", family: 4 }]), /ssrf_forbidden/);

  const records = [];
  const breakerConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "breaker.json") });
  breakerConfig.endpointAddresses = ["93.184.216.34"];
  let failedCalls = 0;
  const retryKeys = [];
  const requestDigests = [];
  const fleetPermitIds = [];
  const failingTransport = runtime.createQwenInferenceFetch(
    breakerConfig,
    "request-500",
    (record) => records.push(record),
    async (_url, init = {}) => {
      failedCalls += 1;
      const headers = new Headers(init.headers);
      retryKeys.push(headers.get("x-vinci-idempotency-key"));
      requestDigests.push(headers.get("x-vinci-qwen-request-sha256"));
      fleetPermitIds.push(headers.get("x-vinci-qwen-fleet-permit-id"));
      return new Response("failure", { status: 500 });
    },
  );
  await assert.rejects(
    failingTransport(breakerConfig.chatUrl, { method: "POST", body: requestBody }),
    /qwen_http_status/,
  );
  assert.equal(failedCalls, 2, "threshold two must count both real HTTP 500 responses");
  assert.equal(records.length, 2);
  assert.deepEqual(retryKeys, ["request-500/0", "request-500/1"]);
  assert.deepEqual(requestDigests, [runtime.qwenSha256(requestBody), runtime.qwenSha256(requestBody)]);
  assert.deepEqual(fleetPermitIds, [authorityBoundary.fleetPermit.permitId, authorityBoundary.fleetPermit.permitId]);
  assert.deepEqual(records.map((record) => record.transport_attempt), [0, 1]);
  assert.ok(records.every((record) => record.cost_usd === 0 && record.input_tokens === 0 && record.output_tokens === 0));
  assert.throws(() => runtime.assertQwenCircuitClosed(breakerConfig), /qwen_circuit_open/);

  const concurrentCircuitFile = join(temp, "concurrent-breaker.json");
  await exerciseConcurrentBreakerWrites(concurrentCircuitFile, 8);
  const concurrentState = JSON.parse(readFileSync(concurrentCircuitFile, "utf8"));
  assert.equal(concurrentState.schema, "vinci.qwen-worker-circuit.v2");
  assert.equal(concurrentState.failures, 8, "atomic breaker updates must not lose concurrent failures");
  assert.equal(concurrentState.sequence, 8);

  const mismatchConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "mismatch.json") });
  mismatchConfig.endpointAddresses = ["93.184.216.34"];
  const mismatchTransport = runtime.createQwenInferenceFetch(
    mismatchConfig,
    "request-mismatch",
    () => {},
    async () => new Response(validSse, { headers: identityHeaders({ "x-vinci-model-id": "Qwen/wrong" }) }),
  );
  await assert.rejects(mismatchTransport(mismatchConfig.chatUrl, { method: "POST", body: requestBody }), /response_identity_mismatch/);

  const runtimeMismatchRecords = [];
  const runtimeMismatchConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "runtime-mismatch.json") });
  runtimeMismatchConfig.endpointAddresses = ["93.184.216.34"];
  await assert.rejects(
    runtime.createQwenInferenceFetch(
      runtimeMismatchConfig,
      "request-runtime-mismatch",
      (record) => runtimeMismatchRecords.push(record),
      async () => new Response(validSse, { headers: identityHeaders({ "x-vinci-runtime-version": "wrong" }) }),
    )(runtimeMismatchConfig.chatUrl, { method: "POST", body: requestBody }),
    /response_identity_mismatch/,
  );
  assert.equal(runtimeMismatchRecords[0].outcome, "response_identity_mismatch");

  const redirectConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "redirect.json") });
  redirectConfig.endpointAddresses = ["93.184.216.34"];
  await assert.rejects(
    runtime.createQwenInferenceFetch(redirectConfig, "request-redirect", () => {}, async () => new Response("", { status: 302 }))(
      redirectConfig.chatUrl,
      { method: "POST", body: requestBody },
    ),
    /redirect_forbidden/,
  );
  await assert.rejects(
    runtime.createQwenInferenceFetch(redirectConfig, "request-ssrf", () => {}, async () => new Response(validSse, { headers: identityHeaders() }))(
      "http://169.254.169.254/latest/meta-data",
      { method: "POST", body: requestBody },
    ),
    /ssrf_forbidden/,
  );
  await assert.rejects(
    runtime.createQwenInferenceFetch(redirectConfig, "request-too-large", () => {}, async () => new Response(validSse, { headers: identityHeaders() }))(
      redirectConfig.chatUrl,
      { method: "POST", body: "x".repeat(5_000) },
    ),
    /request_oversized/,
  );
  const mutatedBody = JSON.stringify({ ...JSON.parse(requestBody), messages: [{ role: "system", content: systemPrompt }, { role: "user", content: "post-hook mutation" }] });
  await assert.rejects(
    runtime.createQwenInferenceFetch(redirectConfig, "request-mutated", () => {}, async () => new Response(validSse, { headers: identityHeaders() }))(
      redirectConfig.chatUrl,
      { method: "POST", body: mutatedBody },
    ),
    /prompt_mismatch/,
    "the transport must reject bytes changed after payload hooks",
  );

  const cancelledConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "cancelled-retry.json") });
  cancelledConfig.endpointAddresses = ["93.184.216.34"];
  cancelledConfig.qualification.limits.max_retry_delay_ms = 1_000;
  const retryAbort = new AbortController();
  let cancelledCalls = 0;
  await assert.rejects(
    runtime.createQwenInferenceFetch(cancelledConfig, "request-cancelled", () => {}, async () => {
      cancelledCalls += 1;
      queueMicrotask(() => retryAbort.abort("operator_stop"));
      return new Response("retry", { status: 429, headers: { "retry-after": "1" } });
    })(cancelledConfig.chatUrl, { method: "POST", body: requestBody, signal: retryAbort.signal }),
    /cancelled/,
  );
  assert.equal(cancelledCalls, 1, "cancellation during Retry-After must prevent the next transport attempt");

  const oversizedConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "oversized.json") });
  oversizedConfig.endpointAddresses = ["93.184.216.34"];
  await assert.rejects(
    runtime.createQwenInferenceFetch(oversizedConfig, "request-oversized", () => {}, async () => new Response("x".repeat(300), { status: 500 }))(
      oversizedConfig.chatUrl,
      { method: "POST", body: requestBody },
    ),
    /response_oversized/,
  );

  const successRecords = [];
  const successConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "success.json") });
  successConfig.endpointAddresses = ["93.184.216.34"];
  const successSettlement = { transportFailed: false, settled: false };
  const recordSuccess = (record) => successRecords.push(record);
  const successResponse = await runtime.createQwenInferenceFetch(
    successConfig,
    "request-success",
    recordSuccess,
    async () => new Response(validSse, { headers: identityHeaders() }),
    successSettlement,
  )(successConfig.chatUrl, { method: "POST", body: requestBody });
  assert.equal(await successResponse.text(), validSse);
  assert.equal(successRecords.length, 0, "raw SSE completion must not be recorded as success before parser acceptance");
  runtime.settleQwenSemanticOutcome(successConfig, successSettlement, true, "success", recordSuccess);
  assert.equal(successRecords[0].outcome, "success");
  assert.equal(successRecords[0].input_tokens, 10);
  assert.equal(successRecords[0].output_tokens, 2);
  assert.equal(successRecords[0].cost_usd, 0.000004);

  const invalidUsage = { ...usage, total_tokens: 99 };
  const invalidUsageSse = [
    `data: ${JSON.stringify({ id: "chunk-bad-usage", object: "chat.completion.chunk", created: 1, model: runtime.QWEN_MODEL, choices: [], usage: invalidUsage })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const invalidUsageConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "invalid-usage.json") });
  invalidUsageConfig.endpointAddresses = ["93.184.216.34"];
  const invalidUsageResponse = await runtime.createQwenInferenceFetch(
    invalidUsageConfig,
    "request-invalid-usage",
    () => {},
    async () => new Response(invalidUsageSse, { headers: identityHeaders() }),
  )(invalidUsageConfig.chatUrl, { method: "POST", body: requestBody });
  await assert.rejects(invalidUsageResponse.text(), /usage_invalid/);

  const oversizedSuccessConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "oversized-success.json") });
  oversizedSuccessConfig.endpointAddresses = ["93.184.216.34"];
  const oversizedSuccessResponse = await runtime.createQwenInferenceFetch(
    oversizedSuccessConfig,
    "request-oversized-success",
    () => {},
    async () => new Response(`data: ${"x".repeat(5_000)}\n`, { headers: identityHeaders() }),
  )(oversizedSuccessConfig.chatUrl, { method: "POST", body: requestBody });
  await assert.rejects(oversizedSuccessResponse.text(), /response_oversized/);

  const timeoutConfig = loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "timeout.json") });
  timeoutConfig.endpointAddresses = ["93.184.216.34"];
  const timeoutResponse = await runtime.createQwenInferenceFetch(
    timeoutConfig,
    "request-timeout",
    () => {},
    async (_url, init = {}) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { headers: identityHeaders() }),
  )(timeoutConfig.chatUrl, { method: "POST", body: requestBody });
  await assert.rejects(timeoutResponse.text(), /AbortError|aborted/);

  const context = { systemPrompt, messages: [{ role: "user", content: workOrderPrompt, timestamp: Date.now() }], tools };
  const parserValidSse = [
    `data: ${JSON.stringify({ id: "parsed-1", object: "chat.completion.chunk", created: 1, model: runtime.QWEN_MODEL, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "parsed-2", object: "chat.completion.chunk", created: 2, model: runtime.QWEN_MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    `data: ${JSON.stringify({ id: "parsed-usage", object: "chat.completion.chunk", created: 3, model: runtime.QWEN_MODEL, choices: [], usage })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  let parserTransportCalls = 0;
  const parserTransport = async () => {
    parserTransportCalls += 1;
    return new Response(parserValidSse, { headers: identityHeaders() });
  };
  const permitConfig = freshenPermit(loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "permit.json") }));
  permitConfig.endpointAddresses = ["93.184.216.34"];
  assert.throws(
    () => runtime.acquireQwenFleetPermit({ ...permitConfig, fleetPermit: { ...permitConfig.fleetPermit, expiresAt: new Date(Date.now() - 1).toISOString() } }),
    /fleet_permit_expired/,
  );
  await exerciseCrossProcessFleetPermit(permitConfig);
  const semanticRecords = [];
  const provider = qwenProviderConfig(permitConfig, sourceStreamSimpleOpenAICompletions, (record) => semanticRecords.push(record), parserTransport);
  const model = { ...provider.models[0], provider: runtime.QWEN_PROVIDER, api: runtime.QWEN_API, baseUrl: provider.baseUrl };
  const firstPermitStream = provider.streamSimple(model, context);
  const competingProvider = qwenProviderConfig(permitConfig, sourceStreamSimpleOpenAICompletions, () => {}, parserTransport);
  assert.throws(
    () => competingProvider.streamSimple(model, context),
    /concurrency_exceeded/,
    "two provider instances sharing an external permit must not run concurrently",
  );
  let secondPermitStream;
  let firstPermitError;
  for await (const event of firstPermitStream) {
    if (event.type === "done") {
      assert.doesNotThrow(
        () => { secondPermitStream = provider.streamSimple(model, context); },
        "permit must be released before the terminal result event becomes observable",
      );
    }
    if (event.type === "error") firstPermitError = event.error.errorMessage;
  }
  assert.ok(secondPermitStream, `${firstPermitError}; transport calls=${parserTransportCalls}`);
  await secondPermitStream.result();
  assert.deepEqual(semanticRecords.map((record) => record.outcome), ["success", "success"]);

  const missingFinishSse = [
    `data: ${JSON.stringify({ id: "missing-finish", object: "chat.completion.chunk", created: 1, model: runtime.QWEN_MODEL, choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "missing-finish-usage", object: "chat.completion.chunk", created: 2, model: runtime.QWEN_MODEL, choices: [], usage })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const truncatedRecords = [];
  const truncatedConfig = freshenPermit(loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "truncated.json"), VINCI_QWEN_CIRCUIT_THRESHOLD: "1" }));
  truncatedConfig.endpointAddresses = ["93.184.216.34"];
  const truncatedProvider = qwenProviderConfig(
    truncatedConfig,
    sourceStreamSimpleOpenAICompletions,
    (record) => truncatedRecords.push(record),
    async () => new Response(missingFinishSse, { headers: identityHeaders() }),
  );
  const truncated = await truncatedProvider.streamSimple({ ...truncatedProvider.models[0], provider: runtime.QWEN_PROVIDER, api: runtime.QWEN_API, baseUrl: truncatedProvider.baseUrl }, context).result();
  assert.equal(truncated.stopReason, "error");
  assert.match(truncated.errorMessage, /finish_reason/);
  assert.equal(truncatedRecords[0].outcome, "parser_error");
  assert.throws(() => runtime.assertQwenCircuitClosed(truncatedConfig), /qwen_circuit_open/);

  const unknownToolSse = [
    `data: ${JSON.stringify({ id: "bad-tool-1", object: "chat.completion.chunk", created: 1, model: runtime.QWEN_MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "unqualified_tool", arguments: "{}" } }] }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "bad-tool-2", object: "chat.completion.chunk", created: 2, model: runtime.QWEN_MODEL, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
    `data: ${JSON.stringify({ id: "bad-tool-usage", object: "chat.completion.chunk", created: 3, model: runtime.QWEN_MODEL, choices: [], usage })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const toolRecords = [];
  const toolConfig = freshenPermit(loadConfig({ VINCI_QWEN_CIRCUIT_FILE: join(temp, "tool-semantic.json"), VINCI_QWEN_CIRCUIT_THRESHOLD: "1" }));
  toolConfig.endpointAddresses = ["93.184.216.34"];
  const toolProvider = qwenProviderConfig(
    toolConfig,
    sourceStreamSimpleOpenAICompletions,
    (record) => toolRecords.push(record),
    async () => new Response(unknownToolSse, { headers: identityHeaders() }),
  );
  const badTool = await toolProvider.streamSimple({ ...toolProvider.models[0], provider: runtime.QWEN_PROVIDER, api: runtime.QWEN_API, baseUrl: toolProvider.baseUrl }, context).result();
  assert.equal(badTool.stopReason, "error");
  assert.match(badTool.errorMessage, /qwen_semantic_invalid/);
  assert.equal(toolRecords[0].outcome, "parser_semantic_invalid");
  assert.throws(() => runtime.assertQwenCircuitClosed(toolConfig), /qwen_circuit_open/);

  const vectors = join(root, "vinci/test/fixtures/contract-vectors");
  const emptyCriteriaOrder = {
    ...JSON.parse(readFileSync(join(vectors, "work-order-1-minimal/input.json"), "utf8")),
    acceptanceCriteria: [],
  };
  assert.throws(() => digest.workOrderDigest(emptyCriteriaOrder), /criteria_required/);

  const fakeBin = join(temp, "bin");
  const fakeVinci = join(fakeBin, "vinci");
  const spawnRecord = join(temp, "spawn-record.json");
  mkdirSync(fakeBin);
  writeFileSync(fakeVinci, `#!/usr/bin/env node
import { fstatSync, readFileSync, writeFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const secret = readFileSync(3);
writeFileSync(process.env.QWEN_TEST_SPAWN_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin, qwenEnvKeys: Object.keys(process.env).filter((key) => key.includes("QWEN_SECRET")), clientBuild: process.env.VINCI_QWEN_CLIENT_BUILD_SHA256, secretBytes: fstatSync(3).size, secretReadBytes: secret.length }));
`, { mode: 0o700 });
  chmodSync(fakeVinci, 0o700);
  const stateDir = join(temp, "run-state");
  mkdirSync(join(stateDir, "tasks"), { recursive: true });
  writeFileSync(join(stateDir, "tasks", "task-spawn.json"), JSON.stringify({ attempt: 1 }), { mode: 0o600 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    await runVinci({
      envelope: {
        provider: runtime.QWEN_PROVIDER,
        model: runtime.QWEN_MODEL,
        work_order_id: "wo-spawn",
        spec: "synthetic prompt must not be argv",
        tools: ["read"],
        max_runtime_s: 10,
        budget_usd: 1,
      },
      repoDir: temp,
      stateDir,
      taskId: "task-spawn",
      sessionId: "run-spawn",
      env: {
        PATH: `${fakeBin}:${originalPath}`,
        QWEN_TEST_SPAWN_RECORD: spawnRecord,
        VINCI_QWEN_SECRET_REF: `file:${secretFile}`,
      },
      envDelta: {},
    });
  } finally {
    process.env.PATH = originalPath;
  }
  const spawned = JSON.parse(readFileSync(spawnRecord, "utf8"));
  assert.equal(spawned.argv.includes("synthetic prompt must not be argv"), false);
  assert.equal(spawned.argv.includes("synthetic-test-secret"), false);
  assert.equal(spawned.argv.includes(secretFile), false);
  assert.equal(spawned.stdin, "synthetic prompt must not be argv");
  assert.equal(spawned.stdin.includes("synthetic-test-secret"), false);
  assert.deepEqual(spawned.qwenEnvKeys, ["VINCI_QWEN_SECRET_FD"]);
  assert.match(spawned.clientBuild, /^[0-9a-f]{64}$/);
  assert.notEqual(spawned.clientBuild, runtime.qwenSha256(readFileSync(fakeVinci)), "client build must include executed parser and coding-agent dependencies, not only the launcher");
  assert.equal(spawned.secretBytes, spawned.secretReadBytes);

  const lifecycle = new TaskLifecycle(join(temp, "attempt-state"), "task-attempt");
  const first = lifecycle.startAttempt({ id: "task-attempt", envelope: { provider: runtime.QWEN_PROVIDER, evidence: "none" } }, "test");
  const second = lifecycle.startAttempt({ id: "task-attempt", envelope: { provider: runtime.QWEN_PROVIDER, evidence: "none" } }, "test");
  assert.equal(first.sessionId, "task-attempt-qwen-attempt-1");
  assert.equal(second.sessionId, "task-attempt-qwen-attempt-2");

  assert.equal(cleanroom.CLEAN_ROOM_ENV_ALLOWLIST.includes("VINCI_QWEN_SECRET_REF"), false);
  assert.ok(cleanroom.PROVIDER_KEY_ENV[runtime.QWEN_PROVIDER].includes("VINCI_QWEN_SECRET_REF"));
  const scoped = cleanroom.providerScopedEnv({
    base: { OPENROUTER_API_KEY: "drop", VINCI_QWEN_SECRET_REF: `file:${secretFile}` },
    provider: runtime.QWEN_PROVIDER,
    agentDir: join(temp, "agent"),
  });
  assert.equal(scoped.OPENROUTER_API_KEY, undefined);
  assert.equal(scoped.VINCI_QWEN_SECRET_REF, `file:${secretFile}`);
  assert.equal(cleanroom.providerScopedEnv({ base: scoped, provider: "openrouter", agentDir: join(temp, "other") }).VINCI_QWEN_SECRET_REF, undefined);

  const summary = economics.buildEconomicsSummary({
    workOrderId: "wo-test",
    attemptLabel: "task-test/1",
    sessionId: "run-test",
    started: "2026-09-04T10:00:00.000Z",
    finished: "2026-09-04T10:00:02.000Z",
    usageEntries: [{ provider: runtime.QWEN_PROVIDER, model: runtime.QWEN_MODEL, model_calls: 1, input_tokens: 10, output_tokens: 2, cost_microusd: 4 }],
    sessionState: { path: "/fake/session", source: "usage_entries", costUsd: 0.000004 },
    receipt: { verificationStatus: "passed" },
    run: { exit_code: 0, limit_tripped: null, harness_stops: [] },
    taskState: "UNVERIFIED",
  });
  assert.equal(summary.route.policy_id, "single-provider-no-automatic-fallback");
  assert.equal(summary.work_order_id, "wo-test");
  assert.equal(summary.session_id, "run-test");
  assert.equal(summary.attempt_label, "task-test/1");
} finally {
  try {
    chmodSync(qualificationFile, 0o600);
  } catch {}
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("PASS worker-qwen-provider signed qualification, bounded transport, containment, attribution, and concurrency guards\n");
