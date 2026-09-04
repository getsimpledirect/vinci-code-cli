import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as runtime from "../extensions/lib/qwen-runtime.ts";
import providerExtension from "../extensions/vinci-provider.ts";
import * as cleanroom from "../worker/cleanroom.mjs";
import * as digest from "../worker/contracts/digest.mjs";
import * as economics from "../worker/economics.mjs";
import * as workerRun from "../worker/run.mjs";

const root = resolve(import.meta.dirname, "../..");

const temp = mkdtempSync(join(tmpdir(), "vinci-qwen-test-"));
const secretFile = join(temp, "secret");
const promptFile = join(temp, "prompt.txt");
const qualificationFile = join(temp, "qualification.json");
writeFileSync(secretFile, "test-secret\n", { mode: 0o600 });
writeFileSync(promptFile, "inspect the bounded fixture\n", { mode: 0o600 });

const hex = (pair) => pair.repeat(32);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const baseEnv = {
  VINCI_QWEN_ADMIT: "qualified",
  VINCI_QWEN_BASE_URL: "https://qwen.example.test/v1",
  VINCI_QWEN_SECRET_REF: `file:${secretFile}`,
  VINCI_QWEN_QUALIFICATION_PROMPT_FILE: promptFile,
  VINCI_QWEN_QUALIFICATION_TOOLS: '["read","grep"]',
  VINCI_QWEN_SERVED_REVISION: hex("ab"),
  VINCI_QWEN_RUNTIME_ENGINE: "vllm",
  VINCI_QWEN_RUNTIME_VERSION: "0.10.2",
  VINCI_QWEN_RUNTIME_ARTIFACT_SHA256: hex("cd"),
  VINCI_QWEN_RUNTIME_ARGUMENTS_SHA256: hex("ef"),
  VINCI_QWEN_CONTEXT_WINDOW: "262144",
  VINCI_QWEN_MAX_TOKENS: "8192",
  VINCI_QWEN_INPUT_PER_MILLION_USD: "0.25",
  VINCI_QWEN_OUTPUT_PER_MILLION_USD: "0.75",
  VINCI_QWEN_CACHE_READ_PER_MILLION_USD: "0.05",
  VINCI_QWEN_CACHE_WRITE_PER_MILLION_USD: "0.25",
  VINCI_QWEN_PROMPT_SHA256: sha256(readFileSync(promptFile)),
  VINCI_QWEN_TOOLS_SHA256: sha256('["read","grep"]'),
  VINCI_UNATTENDED_POLICY: "governed",
  VINCI_UNATTENDED_LEASE: "lease-test",
  VINCI_QWEN_WORK_ORDER_ID: "wo-test",
  VINCI_QWEN_RUN_ID: "run-test",
  VINCI_QWEN_ATTEMPT_ID: "task-test/1",
  VINCI_QWEN_CIRCUIT_FILE: join(temp, "circuit.json"),
  VINCI_QWEN_CIRCUIT_THRESHOLD: "2",
  VINCI_QWEN_CIRCUIT_OPEN_MS: "60000",
};

try {
  assert.throws(
    () => runtime.buildQwenQualificationTemplate({ ...baseEnv, VINCI_QWEN_ADMIT: undefined }),
    /qualification_not_admitted/,
  );
  const qualification = runtime.buildQwenQualificationTemplate(baseEnv);
  assert.equal(qualification.model, "Qwen/Qwen3.8-27B");
  assert.equal(qualification.limits.max_concurrency, 1, "concurrency must start conservative");
  assert.equal(qualification.limits.max_retries, 1);
  assert.equal(qualification.authority_role, "non-authoritative-evidence-and-proposals-only");
  assert.equal(qualification.fallback_policy, "explicit-openrouter-separate-attempt-only");
  writeFileSync(qualificationFile, `${JSON.stringify(qualification)}\n`, { mode: 0o400 });
  chmodSync(qualificationFile, 0o400);
  const env = {
    ...baseEnv,
    VINCI_QWEN_QUALIFICATION_FILE: qualificationFile,
    VINCI_QWEN_QUALIFICATION_SHA256: sha256(readFileSync(qualificationFile)),
  };
  const config = runtime.loadQwenRuntimeConfig(env);
  assert.equal(config.baseUrl, "https://qwen.example.test/v1");
  assert.equal(config.secret, "test-secret");

  const runtimeTuple = qualification.runtime;
  const observed = [];
  const readyFetch = async (url, init = {}) => {
    observed.push({ url: String(url), authorization: new Headers(init.headers).get("authorization"), method: init.method ?? "GET", body: init.body });
    if (String(url).endsWith("/health") && !new Headers(init.headers).has("authorization")) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (String(url).endsWith("/health")) return Response.json({ status: "ready" });
    if (String(url).endsWith("/v1/models") && !new Headers(init.headers).has("authorization")) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (String(url).endsWith("/v1/models")) {
      return Response.json({ object: "list", data: [{ id: runtime.QWEN_MODEL, revision: qualification.revision, runtime: runtimeTuple }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const identity = await runtime.probeQwenReadiness(config, { fetchImpl: readyFetch, nowMs: 1_000 });
  assert.deepEqual(identity, { revision: qualification.revision, runtime: runtimeTuple });
  assert.deepEqual(observed.map(({ authorization }) => authorization), ["Bearer test-secret", "Bearer test-secret", null, null]);
  assert.doesNotMatch(JSON.stringify(observed), /VINCI_QWEN_SECRET_REF/);

  const promptMismatch = { ...env, VINCI_QWEN_PROMPT_SHA256: hex("01") };
  assert.throws(() => runtime.loadQwenRuntimeConfig(promptMismatch), /qwen_prompt_mismatch/);
  assert.throws(
    () => runtime.loadQwenRuntimeConfig({ ...env, VINCI_UNATTENDED_POLICY: "off" }),
    /qwen_authority_forbidden/,
  );
  assert.throws(
    () => runtime.buildQwenQualificationTemplate({ ...baseEnv, VINCI_QWEN_MAX_CONCURRENCY: "9" }),
    /max_concurrency/,
  );

  const vectors = join(root, "vinci/test/fixtures/contract-vectors");
  const emptyCriteriaOrder = {
    ...JSON.parse(readFileSync(join(vectors, "work-order-1-minimal/input.json"), "utf8")),
    acceptanceCriteria: [],
  };
  assert.throws(
    () => digest.workOrderDigest(emptyCriteriaOrder),
    /criteria_required/,
    "the existing contract gate must reject a Qwen batch without acceptance criteria before materialization",
  );
  assert.throws(
    () => workerRun.runVinci({
      envelope: { provider: "qwen-h200", model: runtime.QWEN_MODEL, ref: "legacy-prose-ref", tools: ["read"], spec: "legacy prose" },
      repoDir: temp,
      stateDir: temp,
      taskId: "task-test",
      sessionId: "run-test",
    }),
    /validated digest WorkOrder identity and acceptance criteria/,
    "legacy prose cannot bypass the WorkOrder acceptance-criteria gate",
  );

  const wrongModelConfig = { ...config, circuitFile: join(temp, "wrong-model-circuit.json") };
  await assert.rejects(
    runtime.probeQwenReadiness(wrongModelConfig, {
      fetchImpl: async (url, init = {}) => {
        if (String(url).endsWith("/health")) return Response.json({ status: "ready" });
        if (!new Headers(init.headers).has("authorization")) return Response.json({}, { status: 401 });
        return Response.json({ object: "list", data: [{ id: "Qwen/Qwen3.8-27B-alias", revision: qualification.revision, runtime: runtimeTuple }] });
      },
      nowMs: 2_000,
    }),
    /qwen_model_mismatch/,
  );

  const authOpenConfig = { ...config, circuitFile: join(temp, "auth-open-circuit.json") };
  await assert.rejects(
    runtime.probeQwenReadiness(authOpenConfig, {
      fetchImpl: async (url) => String(url).endsWith("/health")
        ? Response.json({ status: "ready" })
        : Response.json({ object: "list", data: [{ id: runtime.QWEN_MODEL, revision: qualification.revision, runtime: runtimeTuple }] }),
      nowMs: 3_000,
    }),
    /qwen_auth_not_enforced/,
  );

  const circuitConfig = { ...config, circuitFile: join(temp, "breaker.json") };
  let failedCalls = 0;
  const unavailable = async () => {
    failedCalls += 1;
    throw new Error("offline fake");
  };
  await assert.rejects(runtime.probeQwenReadiness(circuitConfig, { fetchImpl: unavailable, nowMs: 10_000 }), /endpoint_unavailable/);
  assert.equal(failedCalls, 2, "one retry means exactly two bounded attempts");
  await assert.rejects(runtime.probeQwenReadiness(circuitConfig, { fetchImpl: unavailable, nowMs: 11_000 }), /endpoint_unavailable/);
  const callsAtOpen = failedCalls;
  await assert.rejects(runtime.probeQwenReadiness(circuitConfig, { fetchImpl: unavailable, nowMs: 12_000 }), /qwen_circuit_open/);
  assert.equal(failedCalls, callsAtOpen, "open circuit must make no endpoint call");

  const cancelledConfig = { ...config, circuitFile: join(temp, "cancelled.json") };
  const controller = new AbortController();
  controller.abort("fixture cancellation");
  await assert.rejects(
    runtime.probeQwenReadiness(cancelledConfig, {
      signal: controller.signal,
      fetchImpl: async (_url, init = {}) => {
        assert.equal(init.signal.aborted, true);
        throw new DOMException("aborted", "AbortError");
      },
    }),
    /qwen_cancelled/,
  );

  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"report_","arguments":"{\\"status\\":\\""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"ready","arguments":"ready\\"}"}}]}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    "data: [DONE]",
    "",
  ].join("\n");
  const canaryCalls = [];
  const canary = await runtime.runQwenCanary(
    { ...baseEnv, VINCI_QWEN_CANARY_TIMEOUT_MS: "1000" },
    async (url, init = {}) => {
      canaryCalls.push({ url: String(url), init });
      if (String(url).endsWith("/health") && !new Headers(init.headers).has("authorization")) return Response.json({}, { status: 401 });
      if (String(url).endsWith("/health")) return Response.json({ status: "ready" });
      if (String(url).endsWith("/v1/models") && !new Headers(init.headers).has("authorization")) return Response.json({}, { status: 401 });
      if (String(url).endsWith("/v1/models")) return Response.json({ object: "list", data: [{ id: runtime.QWEN_MODEL, revision: qualification.revision, runtime: runtimeTuple }] });
      if (String(url).endsWith("/v1/chat/completions")) return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      throw new Error(`unexpected URL ${url}`);
    },
  );
  assert.equal(canary.capabilities.structured_output, "tool-arguments-json");
  assert.equal(canary.capabilities.usage_chunk, true);
  const inference = canaryCalls.find(({ url }) => url.endsWith("/chat/completions"));
  const payload = JSON.parse(inference.init.body);
  assert.equal(payload.model, "Qwen/Qwen3.8-27B");
  assert.equal(payload.stream, true);
  assert.equal(payload.tools[0].function.name, "report_ready");

  const extensionEnvNames = [
    ...Object.keys(env),
    "VINCI_QWEN_SELECTED",
  ];
  const prior = new Map(extensionEnvNames.map((name) => [name, process.env[name]]));
  const nativeFetch = globalThis.fetch;
  try {
    Object.assign(process.env, env, { VINCI_QWEN_SELECTED: "1", VINCI_QWEN_CIRCUIT_FILE: join(temp, "extension-circuit.json") });
    globalThis.fetch = readyFetch;
    const registrations = [];
    const handlers = {};
    const labels = [];
    await providerExtension({
      registerProvider(name, providerConfig) { registrations.push({ name, providerConfig }); },
      on(name, handler) { (handlers[name] ??= []).push(handler); },
      appendEntry(name, value) { labels.push({ name, value }); },
    });
    assert.deepEqual(registrations.map(({ name }) => name), ["vinci", "qwen-h200"]);
    const qwen = registrations[1].providerConfig;
    assert.equal(qwen.api, "vinci-qwen-openai-completions");
    assert.equal(qwen.apiKey, "runtime-resolved-secret-reference", "provider config must not contain the secret value");
    assert.equal(qwen.models[0].id, "Qwen/Qwen3.8-27B");
    assert.equal(qwen.models[0].cost.input, 0.25);
    assert.equal(process.env.VINCI_QWEN_SECRET_REF, undefined, "bootstrap secret reference must be scrubbed");

    const headers = {};
    for (const handler of handlers.before_provider_headers ?? []) {
      await handler({ headers }, { model: { provider: "qwen-h200" } });
    }
    assert.equal(headers["x-vinci-work-order-id"], "wo-test");
    assert.equal(headers["x-vinci-run-id"], "run-test");
    assert.equal(headers["x-vinci-attempt-id"], "task-test/1");
    assert.equal(headers["x-vinci-qwen-output-authority"], "non-authoritative");

    for (let index = 0; index < 2; index += 1) {
      for (const handler of handlers.after_provider_response ?? []) {
        await handler({ status: 401 }, { model: { provider: "qwen-h200" } });
      }
    }
    assert.throws(
      () => qwen.streamSimple(
        { ...qwen.models[0], provider: "qwen-h200", api: qwen.api },
        { messages: [] },
      ),
      /qwen_circuit_open/,
      "authentication failures must open the circuit before another inference call",
    );

    for (const handler of handlers.message_end ?? []) {
      await handler(
        { message: { role: "assistant", provider: "qwen-h200", stopReason: "stop" } },
        { sessionManager: { getSessionId: () => "run-test" } },
      );
    }
    assert.equal(labels[0].name, "vinci-qwen-output-label");
    assert.equal(labels[0].value.authority, "non-authoritative");
    assert.equal(labels[0].value.independent_check_required, true);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.equal(cleanroom.CLEAN_ROOM_ENV_ALLOWLIST.includes("VINCI_QWEN_SECRET_REF"), false);
  assert.ok(cleanroom.PROVIDER_KEY_ENV["qwen-h200"].includes("VINCI_QWEN_SECRET_REF"));
  const scoped = cleanroom.providerScopedEnv({
    base: {
      OPENROUTER_API_KEY: "must-drop",
      VINCI_QWEN_SECRET_REF: "env:QWEN_DYNAMIC_TEST_SECRET",
      QWEN_DYNAMIC_TEST_SECRET: "dynamic-test-secret",
    },
    provider: "qwen-h200",
    agentDir: join(temp, "agent"),
  });
  assert.equal(scoped.OPENROUTER_API_KEY, undefined);
  assert.equal(scoped.VINCI_QWEN_SECRET_REF, "env:QWEN_DYNAMIC_TEST_SECRET");
  assert.equal(scoped.QWEN_DYNAMIC_TEST_SECRET, "dynamic-test-secret");
  const cleanScoped = cleanroom.cleanRoomEnv({
    base: scoped,
    provider: "qwen-h200",
    homeDir: join(temp, "clean-home"),
    tmpDir: join(temp, "clean-tmp"),
  });
  assert.equal(cleanScoped.QWEN_DYNAMIC_TEST_SECRET, "dynamic-test-secret");
  const otherProvider = cleanroom.providerScopedEnv({
    base: scoped,
    provider: "openrouter",
    agentDir: join(temp, "other-agent"),
  });
  assert.equal(otherProvider.VINCI_QWEN_SECRET_REF, undefined);
  assert.equal(otherProvider.QWEN_DYNAMIC_TEST_SECRET, undefined, "a dynamic Qwen secret must not cross provider boundaries");
  const envSecretConfig = { ...env, VINCI_QWEN_SECRET_REF: "env:QWEN_DYNAMIC_TEST_SECRET", QWEN_DYNAMIC_TEST_SECRET: "dynamic-test-secret" };
  assert.equal(runtime.loadQwenRuntimeConfig(envSecretConfig).secret, "dynamic-test-secret");
  assert.equal(envSecretConfig.QWEN_DYNAMIC_TEST_SECRET, undefined, "the resolved secret must be scrubbed before repository tools run");

  const summary = economics.buildEconomicsSummary({
    workOrderId: "wo-test",
    attemptLabel: "task-test/1",
    sessionId: "run-test",
    started: "2026-09-04T10:00:00.000Z",
    finished: "2026-09-04T10:00:02.000Z",
    usageEntries: [{ provider: "qwen-h200", model: runtime.QWEN_MODEL, model_calls: 1, input_tokens: 10, output_tokens: 2, cost_microusd: 4 }],
    sessionState: { path: "/fake/session", source: "usage_entries", costUsd: 0.000004 },
    receipt: { verificationStatus: "passed" },
    run: { exit_code: 0, limit_tripped: null, harness_stops: [] },
    taskState: "UNVERIFIED",
  });
  assert.equal(summary.route.policy_id, "single-provider-no-automatic-fallback");
  assert.equal(summary.route.initial_provider, "qwen-h200");
  assert.equal(summary.route.initial_model, "Qwen/Qwen3.8-27B");
  assert.equal(summary.work_order_id, "wo-test");
  assert.equal(summary.session_id, "run-test");
  assert.equal(summary.attempt_label, "task-test/1");
  assert.equal(summary.started_at, "2026-09-04T10:00:00.000Z");
  assert.equal(summary.finished_at, "2026-09-04T10:00:02.000Z");
} finally {
  chmodSync(qualificationFile, 0o600);
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("  Qwen H200 provider: qualification, readiness, auth, circuit, canary, attribution, and telemetry guards pass\n");
