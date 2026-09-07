// The provider boundary on the NORMAL path.
//
// PROVIDER_KEY_ENV promises a child gets ONLY the key its envelope's provider authenticates
// with. That promise was kept exclusively inside cleanRoomEnv; the normal path passed
// `env: undefined`, meaning inherit every provider key the daemon holds. Clean-room mode is
// additionally refused under a Governor, so in the governed configuration the boundary never
// ran. What kept a child off another provider was which keys happened to be ABSENT — an
// accident of box configuration, not a boundary.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { childEnv, PROVIDER_CREDENTIAL_ENV, PROVIDER_KEY_ENV, providerScopedEnv } from "../worker/cleanroom.mjs";
import { seedProviderDefinitions } from "../worker/provider-definitions.mjs";
import { parseAllowedProviders, providerAllowed } from "../worker/task.mjs";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");

const ALL_KEYS = Object.values(PROVIDER_KEY_ENV).flat();

// A daemon environment holding EVERY provider credential, which is the situation the boundary
// exists for and the one measured on the worker boxes.
const FULL = Object.freeze({
  PATH: "/usr/bin",
  HOME: "/home/jovyan",
  OPENROUTER_API_KEY: "or-secret",
  VINCI_API_KEY: "vinci-secret",
  VINCI_INTERNAL_DEEPINFRA_API_KEY: "di-secret",
  DEEPINFRA_API_KEY: "di-public-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-secret",
  OPENAI_API_KEY: "openai-secret",
  GEMINI_API_KEY: "gemini-secret",
  AWS_ACCESS_KEY_ID: "aws-access-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GCLOUD_PROJECT: "gcloud-project",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/jovyan/google.json",
  GOOGLE_CLOUD_LOCATION: "us-central1",
  GOOGLE_CLOUD_PROJECT: "google-cloud-project",
  VINCI_CODING_AGENT_DIR: "/home/jovyan/.vinci/agent",
  PI_CODING_AGENT_DIR: "/home/jovyan/.pi/agent",
});

test("a child gets its own provider's key and no other provider's", () => {
  for (const [provider, keys] of Object.entries(PROVIDER_KEY_ENV)) {
    const env = providerScopedEnv({ base: FULL, provider, agentDir: "/isolated/agent" });
    for (const key of keys) {
      assert.equal(env[key], FULL[key], `${provider} must keep its own key ${key}`);
    }
    for (const other of ALL_KEYS) {
      if (keys.includes(other)) continue;
      assert.equal(env[other], undefined, `${provider} must NOT receive ${other}`);
    }
    for (const credential of PROVIDER_CREDENTIAL_ENV) {
      if (keys.includes(credential)) continue;
      assert.equal(env[credential], undefined, `${provider} must NOT receive ${credential}`);
    }
  }
});

test("an unknown provider gets no provider key at all — fails closed", () => {
  // The launcher then refuses for want of a credential, as it already does in a clean room.
  // Failing OPEN here would hand an unrecognised envelope every key on the box.
  for (const provider of [undefined, null, "", "not-a-provider", "OPENROUTER", "__proto__"]) {
    const env = providerScopedEnv({ base: FULL, provider, agentDir: "/isolated/agent" });
    for (const key of ALL_KEYS) {
      assert.equal(env[key], undefined, `provider ${JSON.stringify(provider)} must receive no ${key}`);
    }
  }
});

test("non-credential environment is preserved but stored auth is isolated", () => {
  // Deliberately SUBTRACTIVE. cleanRoomEnv rebuilds HOME/TMPDIR/agent dirs, which is right for a
  // clean room and would be a far larger behaviour change than this defect warrants here.
  const env = providerScopedEnv({ base: FULL, provider: "openrouter", agentDir: "/isolated/agent" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/jovyan");
  assert.equal(env.VINCI_CODING_AGENT_DIR, "/isolated/agent");
  assert.equal(env.PI_CODING_AGENT_DIR, "/isolated/agent");
});

test("the caller's environment is not mutated", () => {
  const base = { ...FULL };
  providerScopedEnv({ base, provider: "openrouter", agentDir: "/isolated/agent" });
  assert.equal(base.VINCI_API_KEY, "vinci-secret", "scoping must not strip keys from the daemon itself");
  assert.equal(base.VINCI_INTERNAL_DEEPINFRA_API_KEY, "di-secret");
});

test("every provider in the map is covered by the boundary", () => {
  // If a provider is added to PROVIDER_KEY_ENV later, it is scoped by construction rather than
  // by someone remembering to extend a list here.
  assert.ok(Object.keys(PROVIDER_KEY_ENV).length >= 3);
  for (const keys of Object.values(PROVIDER_KEY_ENV)) {
    assert.ok(Array.isArray(keys) && keys.length > 0);
  }
});

test("the removal inventory covers every bundled provider auth env value", () => {
  const source = readFileSync(join(ROOT, "packages/ai/src/env-api-keys.ts"), "utf8");
  const bundled = new Set(
    [...source.matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)].map((match) => match[1]),
  );
  assert.ok(bundled.size >= 40, "the independent provider-auth inventory parser must not narrow silently");
  const removed = new Set(PROVIDER_CREDENTIAL_ENV);
  for (const credential of bundled) {
    assert.equal(removed.has(credential), true, `${credential} affects bundled provider authentication and must be removed unless explicitly selected`);
  }
});

// --- the seam itself ---------------------------------------------------------------------
// The tests above cover providerScopedEnv. They do NOT cover the decision of whether the worker
// calls it, and that decision is what was wrong: the call site read `env: undefined` on the
// normal path. Reverting it left every test above green, so the boundary could have been
// removed again without anything failing. childEnv is that decision, named so it can be tested.

test("the normal path is scoped, not inherited — the seam, not just the helper", () => {
  const base = {
    PATH: "/usr/bin",
    OPENROUTER_API_KEY: "or", VINCI_API_KEY: "vinci", VINCI_INTERNAL_DEEPINFRA_API_KEY: "di",
  };
  const env = childEnv({ base, cleanRoom: false, provider: "openrouter", agentDir: "/isolated/agent" });
  assert.notEqual(env, undefined, "the normal path must NOT inherit the daemon environment");
  assert.equal(env.OPENROUTER_API_KEY, "or");
  assert.equal(env.VINCI_API_KEY, undefined, "the normal path must strip other providers' keys");
  assert.equal(env.VINCI_INTERNAL_DEEPINFRA_API_KEY, undefined);
});

test("the clean-room path still gets the full clean room, not merely scoping", () => {
  const env = childEnv({
    base: { PATH: "/usr/bin", VINCI_API_KEY: "vinci", OPENROUTER_API_KEY: "or" },
    cleanRoom: true, provider: "vinci", homeDir: "/tmp/h", tmpDir: "/tmp/t",
  });
  assert.equal(env.HOME, "/tmp/h", "clean room still rewrites HOME");
  assert.equal(env.VINCI_API_KEY, "vinci");
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});

test("provider definitions seed only the selected model and approved environment references", async () => {
  const fixture = new WorkerTestFixture("provider-definitions-helper");
  const priorHome = process.env.HOME;
  const priorBaseUrl = process.env.VLLM_BASE_URL;
  try {
    const home = join(fixture.tempDir, "definition-home");
    const slot = join(fixture.tempDir, "definition-slot");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(slot, { recursive: true });
    process.env.HOME = home;
    process.env.VLLM_BASE_URL = "https://vllm.example.invalid/v1";
    writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({
      providers: {
        vllm: {
          baseUrl: "https://vllm.example.invalid/v1",
          apiKey: "$VLLM_API_KEY",
          api: "openai-completions",
          models: [
            { id: "Qwen/Qwen3.8-27B", reasoning: true, contextWindow: 32768, maxTokens: 4096 },
            { id: "Qwen/Not-Selected", reasoning: false },
          ],
        },
        unrelated: {
          baseUrl: "https://unrelated.example.invalid/v1",
          apiKey: "SYNTHETIC_LITERAL_NOT_A_SECRET",
          headers: { Authorization: "Bearer SYNTHETIC_HEADER_NOT_A_SECRET" },
          models: [{ id: "unrelated" }],
        },
      },
    }));
    const outcome = seedProviderDefinitions(slot, "vllm", "Qwen/Qwen3.8-27B");
    assert.deepEqual(outcome, { seeded: true, reason: "selected_provider_only" });
    const seeded = JSON.parse(readFileSync(join(slot, "models.json"), "utf8"));
    assert.deepEqual(Object.keys(seeded.providers), ["vllm"]);
    assert.equal(seeded.providers.vllm.apiKey, "$VLLM_API_KEY");
    assert.equal(seeded.providers.vllm.baseUrl, "$VLLM_BASE_URL");
    assert.deepEqual(seeded.providers.vllm.models.map(({ id }) => id), ["Qwen/Qwen3.8-27B"]);
    assert.doesNotMatch(JSON.stringify(seeded), /SYNTHETIC_|Not-Selected|unrelated/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorBaseUrl === undefined) delete process.env.VLLM_BASE_URL;
    else process.env.VLLM_BASE_URL = priorBaseUrl;
    await fixture.cleanup();
  }
});

test("selected-provider literal, command, and header credentials fail closed", async () => {
  const fixture = new WorkerTestFixture("provider-definitions-unsafe");
  const priorHome = process.env.HOME;
  const priorBaseUrl = process.env.VLLM_BASE_URL;
  try {
    const home = join(fixture.tempDir, "definition-home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    process.env.HOME = home;
    process.env.VLLM_BASE_URL = "https://vllm.example.invalid/v1";
    const source = join(home, ".pi", "agent", "models.json");
    const selected = (extra) => ({ providers: { vllm: {
      baseUrl: "$VLLM_BASE_URL",
      apiKey: "$VLLM_API_KEY",
      api: "openai-completions",
      models: [{ id: "Qwen/Qwen3.8-27B" }],
      ...extra,
    } } });
    for (const [name, config, reason] of [
      ["literal", selected({ apiKey: "SYNTHETIC_LITERAL_NOT_A_SECRET" }), /apiKey must be an exact/],
      ["command", selected({ apiKey: "!printf SYNTHETIC_COMMAND_NOT_EXECUTED" }), /apiKey must be an exact/],
      ["provider-header", selected({ headers: { Authorization: "$VLLM_API_KEY" } }), /headers are not safe/],
      ["model-header", selected({ models: [{ id: "Qwen/Qwen3.8-27B", headers: { Authorization: "$VLLM_API_KEY" } }] }), /headers are not safe/],
      ["model-override-header", selected({ modelOverrides: { "Qwen/Qwen3.8-27B": { headers: { Authorization: "$VLLM_API_KEY" } } } }), /headers are not safe/],
      ["url-userinfo", selected({ baseUrl: "https://synthetic-user:synthetic-pass@vllm.example.invalid/v1" }), /may not carry credentials/],
      ["url-query", selected({ baseUrl: "https://vllm.example.invalid/v1?key=SYNTHETIC_NOT_A_SECRET" }), /may not carry credentials/],
      ["url-mismatch", selected({ baseUrl: "https://other.example.invalid/v1" }), /does not match VLLM_BASE_URL/],
      ["unknown-field", selected({ credentialNote: "SYNTHETIC_NOT_A_SECRET" }), /unsupported provider vllm field/],
    ]) {
      const slot = join(fixture.tempDir, `slot-${name}`);
      mkdirSync(slot);
      writeFileSync(source, JSON.stringify(config));
      assert.throws(() => seedProviderDefinitions(slot, "vllm", "Qwen/Qwen3.8-27B"), reason);
      assert.equal(existsSync(join(slot, "models.json")), false, `${name} must not leave a child-visible file`);
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorBaseUrl === undefined) delete process.env.VLLM_BASE_URL;
    else process.env.VLLM_BASE_URL = priorBaseUrl;
    await fixture.cleanup();
  }
});

test("missing optional definitions stay distinct from malformed definitions", async () => {
  const fixture = new WorkerTestFixture("provider-definitions-missing");
  const priorHome = process.env.HOME;
  const priorBaseUrl = process.env.VLLM_BASE_URL;
  try {
    const home = join(fixture.tempDir, "definition-home");
    const slot = join(fixture.tempDir, "definition-slot");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(slot);
    process.env.HOME = home;
    process.env.VLLM_BASE_URL = "https://vllm.example.invalid/v1";
    assert.deepEqual(
      seedProviderDefinitions(slot, "vllm", "Qwen/Qwen3.8-27B"),
      { seeded: false, reason: "definitions_missing" },
    );
    writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { unrelated: {} } }));
    assert.deepEqual(
      seedProviderDefinitions(slot, "vllm", "Qwen/Qwen3.8-27B"),
      { seeded: false, reason: "provider_missing" },
    );
    writeFileSync(join(home, ".pi", "agent", "models.json"), "{not-json");
    assert.throws(
      () => seedProviderDefinitions(slot, "vllm", "Qwen/Qwen3.8-27B"),
      /cannot read .*models\.json/,
    );
    assert.equal(existsSync(join(slot, "models.json")), false);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorBaseUrl === undefined) delete process.env.VLLM_BASE_URL;
    else process.env.VLLM_BASE_URL = priorBaseUrl;
    await fixture.cleanup();
  }
});

test("the actual worker seam gives a vllm child only its selected safe definition", async () => {
  const fixture = new WorkerTestFixture("provider-definitions-seam");
  try {
    fixture.createRepo("test", "repo");
    fixture.linkTools(TOOLS);
    const home = join(fixture.tempDir, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: {
      vllm: {
        baseUrl: "https://vllm.example.invalid/v1",
        apiKey: "$VLLM_API_KEY",
        api: "openai-completions",
        models: [{ id: "Qwen/Qwen3.8-27B", reasoning: true }],
      },
      unrelated: {
        baseUrl: "https://unrelated.example.invalid/v1",
        apiKey: "SYNTHETIC_LITERAL_NOT_A_SECRET",
        models: [{ id: "unrelated" }],
      },
    } }));
    await fixture.startBus([{
      message_id: "provider-definitions-seam-1",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "selected provider definition",
      body: "repo: test/repo\nevidence: none\nprovider: vllm\nmodel: Qwen/Qwen3.8-27B\n\nTask",
      ts: "2026-09-07T00:00:00Z",
      posted_by: "scheduler",
    }]);
    const child = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      { env: fixture.getEnv({
        HOME: home,
        VLLM_API_KEY: "SYNTHETIC_SELECTED_NOT_A_SECRET",
        VLLM_BASE_URL: "https://vllm.example.invalid/v1",
        VINCI_WORKER_ALLOWED_PROVIDERS: "vllm",
      }), stdio: "pipe" },
    );
    assert.equal(await new Promise((resolveClose) => child.once("close", resolveClose)), 0);
    const slot = join(fixture.tempDir, "provider-slots", "provider-definitions-seam-1", "1", "vllm");
    const seeded = JSON.parse(readFileSync(join(slot, "models.json"), "utf8"));
    assert.deepEqual(Object.keys(seeded.providers), ["vllm"]);
    assert.equal(seeded.providers.vllm.apiKey, "$VLLM_API_KEY");
    assert.equal(seeded.providers.vllm.baseUrl, "$VLLM_BASE_URL");
    assert.doesNotMatch(JSON.stringify(seeded), /SYNTHETIC_|unrelated/);
    const calls = fixture.getVinciCalls();
    assert.equal(calls.length, 1, "positive control: the configured selected provider remains reachable");
  } finally {
    await fixture.cleanup();
  }
});

test("provider allowlist defaults to OpenRouter and rejects malformed widening", () => {
  const defaults = parseAllowedProviders();
  assert.deepEqual([...defaults], ["openrouter"]);
  assert.equal(providerAllowed("openrouter", defaults), true);
  assert.equal(providerAllowed("deepinfra", defaults), false);
  assert.throws(() => parseAllowedProviders(""), /non-empty provider list/);
  assert.throws(() => parseAllowedProviders("openrouter,,deepinfra"), /entries must use lowercase/);
  assert.throws(() => parseAllowedProviders("openrouter,../deepinfra"), /entries must use lowercase/);
});

test("provider allowlist is operator-configurable without case folding", () => {
  const allowed = parseAllowedProviders("openrouter, deepinfra,openrouter");
  assert.deepEqual([...allowed], ["openrouter", "deepinfra"]);
  assert.equal(providerAllowed("deepinfra", allowed), true);
  assert.equal(providerAllowed("OpenRouter", allowed), false);
});

test("daemon blocks a disallowed provider before clone or spawn", async () => {
  const fixture = new WorkerTestFixture("provider-gate");
  try {
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: "provider-gate-1",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "disallowed provider",
      body: "repo: test/repo\nevidence: none\nprovider: deepinfra\n\nTask",
      ts: "2026-08-31T08:00:00Z",
      posted_by: "scheduler",
    }]);
    const child = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      { env: fixture.getEnv(), stdio: "pipe" },
    );
    assert.equal(await new Promise((resolveClose) => child.once("close", resolveClose)), 0);
    const state = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", "provider-gate-1.json"), "utf8"));
    assert.equal(state.state, "BLOCKED");
    assert.match(state.outcome.reason, /^provider_not_allowed:/);
    assert.equal(existsSync(join(fixture.tempDir, "repos")), false, "provider refusal must happen before clone");
    assert.equal(fixture.getVinciCalls().length, 0, "provider refusal must happen before spawn");
    const refusal = fixture.getPostedMessages().at(-1);
    assert.equal(refusal.kind, "status", "terminal refusal must not create an open blocker decision");
    assert.equal(refusal.outcome, "BLOCKED");
    assert.match(refusal.body, /VINCI_WORKER_ALLOWED_PROVIDERS=openrouter/);
    const online = fixture.getPostedMessages().find((message) => message.subject === "worker w1 online");
    assert.match(online.body, /allowed_providers=openrouter/);
  } finally {
    await fixture.cleanup();
  }
});
