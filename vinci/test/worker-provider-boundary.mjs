// The provider boundary on the NORMAL path.
//
// PROVIDER_KEY_ENV promises a child gets ONLY the key its envelope's provider authenticates
// with. That promise was kept exclusively inside cleanRoomEnv; the normal path passed
// `env: undefined`, meaning inherit every provider key the daemon holds. Clean-room mode is
// additionally refused under a Governor, so in the governed configuration the boundary never
// ran. What kept a child off another provider was which keys happened to be ABSENT — an
// accident of box configuration, not a boundary.

import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_KEY_ENV, providerScopedEnv } from "../worker/cleanroom.mjs";

const ALL_KEYS = Object.values(PROVIDER_KEY_ENV).flat();

// A daemon environment holding EVERY provider credential, which is the situation the boundary
// exists for and the one measured on the worker boxes.
const FULL = Object.freeze({
  PATH: "/usr/bin",
  HOME: "/home/jovyan",
  OPENROUTER_API_KEY: "or-secret",
  VINCI_API_KEY: "vinci-secret",
  VINCI_INTERNAL_DEEPINFRA_API_KEY: "di-secret",
});

test("a child gets its own provider's key and no other provider's", () => {
  for (const [provider, keys] of Object.entries(PROVIDER_KEY_ENV)) {
    const env = providerScopedEnv({ base: FULL, provider });
    for (const key of keys) {
      assert.equal(env[key], FULL[key], `${provider} must keep its own key ${key}`);
    }
    for (const other of ALL_KEYS) {
      if (keys.includes(other)) continue;
      assert.equal(env[other], undefined, `${provider} must NOT receive ${other}`);
    }
  }
});

test("an unknown provider gets no provider key at all — fails closed", () => {
  // The launcher then refuses for want of a credential, as it already does in a clean room.
  // Failing OPEN here would hand an unrecognised envelope every key on the box.
  for (const provider of [undefined, null, "", "not-a-provider", "OPENROUTER", "__proto__"]) {
    const env = providerScopedEnv({ base: FULL, provider });
    for (const key of ALL_KEYS) {
      assert.equal(env[key], undefined, `provider ${JSON.stringify(provider)} must receive no ${key}`);
    }
  }
});

test("everything that is not a provider key is passed through untouched", () => {
  // Deliberately SUBTRACTIVE. cleanRoomEnv rebuilds HOME/TMPDIR/agent dirs, which is right for a
  // clean room and would be a far larger behaviour change than this defect warrants here.
  const env = providerScopedEnv({ base: FULL, provider: "openrouter" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/jovyan");
});

test("the caller's environment is not mutated", () => {
  const base = { ...FULL };
  providerScopedEnv({ base, provider: "openrouter" });
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

// --- the seam itself ---------------------------------------------------------------------
// The tests above cover providerScopedEnv. They do NOT cover the decision of whether the worker
// calls it, and that decision is what was wrong: the call site read `env: undefined` on the
// normal path. Reverting it left every test above green, so the boundary could have been
// removed again without anything failing. childEnv is that decision, named so it can be tested.

test("the normal path is scoped, not inherited — the seam, not just the helper", async () => {
  const { childEnv } = await import("../worker/cleanroom.mjs");
  const base = {
    PATH: "/usr/bin",
    OPENROUTER_API_KEY: "or", VINCI_API_KEY: "vinci", VINCI_INTERNAL_DEEPINFRA_API_KEY: "di",
  };
  const env = childEnv({ base, cleanRoom: false, provider: "openrouter" });
  assert.notEqual(env, undefined, "the normal path must NOT inherit the daemon environment");
  assert.equal(env.OPENROUTER_API_KEY, "or");
  assert.equal(env.VINCI_API_KEY, undefined, "the normal path must strip other providers' keys");
  assert.equal(env.VINCI_INTERNAL_DEEPINFRA_API_KEY, undefined);
});

test("the clean-room path still gets the full clean room, not merely scoping", async () => {
  const { childEnv } = await import("../worker/cleanroom.mjs");
  const env = childEnv({
    base: { PATH: "/usr/bin", VINCI_API_KEY: "vinci", OPENROUTER_API_KEY: "or" },
    cleanRoom: true, provider: "vinci", homeDir: "/tmp/h", tmpDir: "/tmp/t",
  });
  assert.equal(env.HOME, "/tmp/h", "clean room still rewrites HOME");
  assert.equal(env.VINCI_API_KEY, "vinci");
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});
