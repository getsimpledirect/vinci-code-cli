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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { childEnv, PROVIDER_CREDENTIAL_ENV, PROVIDER_KEY_ENV, providerScopedEnv } from "../worker/cleanroom.mjs";
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
  GOOGLE_APPLICATION_CREDENTIALS: "/home/jovyan/google.json",
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

test("the credential-removal inventory covers every bundled provider env key", () => {
  const source = readFileSync(join(ROOT, "packages/ai/src/env-api-keys.ts"), "utf8");
  const bundled = new Set(
    [...source.matchAll(/["']([A-Z][A-Z0-9_]*(?:API_KEY|OAUTH_TOKEN|GITHUB_TOKEN)|HF_TOKEN)["']/g)]
      .map((match) => match[1]),
  );
  const removed = new Set(PROVIDER_CREDENTIAL_ENV);
  for (const credential of bundled) {
    assert.equal(removed.has(credential), true, `${credential} is a bundled provider credential and must be removed unless explicitly selected`);
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
    assert.match(fixture.getPostedMessages().at(-1).body, /VINCI_WORKER_ALLOWED_PROVIDERS=openrouter/);
    const online = fixture.getPostedMessages().find((message) => message.subject === "worker w1 online");
    assert.match(online.body, /allowed_providers=openrouter/);
  } finally {
    await fixture.cleanup();
  }
});
