// The self-hosted vLLM lane (`--provider telus-qwen`) that the worker fleet runs inference on.
//
// Every constant asserted here was MEASURED against the live deployment on 2026-09-06, not read off
// a model card. The probe and its verbatim response are named next to each assertion, because the
// failure this file exists to prevent is a plausible-looking constant that the server rejects:
//
//   GET  /v1/models                      -> one id, "Qwen/Qwen3.8-27B", max_model_len 32768
//   reasoning_effort: "low" | "medium"   -> 200            <- the ONLY two values that work
//   reasoning_effort omitted             -> 200
//   reasoning_effort: "high" | "none"    -> 400 "Unexpected reasoning effort ... Supported types
//                                              are xhigh (default), medium, and low."
//   reasoning_effort: "xhigh" | "off"    -> 400 pydantic literal_error, "Input should be 'none',
//                                              'low', 'medium' or 'high'"
//
// Note the trap in those last two rows: the endpoint validates reasoning_effort TWICE with two
// DIFFERENT accepted sets (pydantic none|low|medium|high, then a reasoning parser xhigh|medium|low),
// and the parser's error text recommends "xhigh (default)" -- which pydantic refuses. The server
// documents an input that cannot succeed, so only the intersection { low, medium } is safe.
//   role: "developer"                    -> 400 "Unexpected message role."
//   tools + strict, streaming, store     -> 200
//
// The `high` row is load-bearing: vinci/bin/vinci passes `--thinking high` on EVERY launch, so a map
// that forwards an unaccepted value 400s the lane's first real request while every offline test
// stays green. That is not hypothetical -- it happened here, and only an end-to-end run caught it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

import { CLEAN_ROOM_ENV_ALLOWLIST, PROVIDER_KEY_ENV, cleanRoomEnv } from "../worker/cleanroom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const launcher = resolve(root, "vinci/bin/vinci");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });

const BASE_URL = "https://qwen3-example.invalid/v1";
const MODEL_ID = "Qwen/Qwen3.8-27B";

// Registration is gated on CREDENTIAL PRESENCE rather than an opt-in flag, because the worker
// spawns the launcher with `--provider telus-qwen` as a CLI arg and never sets VINCI_PROVIDER
// (vinci/worker/run.mjs) — a flag-gated registration would be missing in the one process that
// needs it. So the gate under test is: both vars present, or no provider at all.
function registrations({ key, baseUrl }) {
  const prior = {
    TELUS_QWEN_API_KEY: process.env.TELUS_QWEN_API_KEY,
    TELUS_QWEN_BASE_URL: process.env.TELUS_QWEN_BASE_URL,
    VINCI_DEEPINFRA_QUALIFICATION: process.env.VINCI_DEEPINFRA_QUALIFICATION,
  };
  // DeepInfra off, so anything beyond "vinci" in the result is this lane and not that one.
  delete process.env.VINCI_DEEPINFRA_QUALIFICATION;
  if (key === undefined) delete process.env.TELUS_QWEN_API_KEY;
  else process.env.TELUS_QWEN_API_KEY = key;
  if (baseUrl === undefined) delete process.env.TELUS_QWEN_BASE_URL;
  else process.env.TELUS_QWEN_BASE_URL = baseUrl;
  const seen = [];
  try {
    provider.default({
      registerProvider(name, config) {
        seen.push({ name, config });
      },
      on() {},
    });
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return seen;
}

// --- the gate, both directions, one variable at a time --------------------------------------
assert.deepEqual(
  registrations({}).map(({ name }) => name),
  ["vinci"],
  "with no credential the lane must not appear in model selection at all",
);
assert.deepEqual(
  registrations({ key: "k" }).map(({ name }) => name),
  ["vinci"],
  "a key without an endpoint must NOT register: there is no default host to fall back to",
);
assert.deepEqual(
  registrations({ baseUrl: BASE_URL }).map(({ name }) => name),
  ["vinci"],
  "an endpoint without a key must not register",
);
// Positive reachability control on the same entry point: with both present the lane IS registered.
// Without this, every assertion above would still pass if registerProvider were deleted outright.
const enabled = registrations({ key: "k", baseUrl: BASE_URL });
assert.deepEqual(enabled.map(({ name }) => name), ["vinci", "telus-qwen"]);

const telus = enabled[1].config;
assert.equal(telus.api, "openai-completions");
assert.equal(telus.apiKey, "$TELUS_QWEN_API_KEY");
// The endpoint comes from the environment. A hardcoded host would keep sending a task's prompts to
// a rented hostname after the deployment moved, which is the reason this is asserted and not typed.
assert.equal(telus.baseUrl, BASE_URL);
assert.equal(telus.models.length, 1);

const model = telus.models[0];
assert.equal(model.id, MODEL_ID);
assert.equal(model.reasoning, true);
// GET /v1/models reports max_model_len 32768 for this deployment.
assert.equal(model.contextWindow, 32_768);
assert.ok(model.maxTokens <= model.contextWindow);
// The server accepts ONLY these three values. Assert the whole map against that closed set rather
// than spot-checking one row, so a future edit cannot introduce a fourth value that 400s in prod.
const ACCEPTED_EFFORTS = new Set(["low", "medium"]);
for (const [level, sent] of Object.entries(model.thinkingLevelMap)) {
  if (sent === null) continue;
  assert.ok(
    ACCEPTED_EFFORTS.has(sent),
    `thinkingLevelMap.${level} sends reasoning_effort=${JSON.stringify(sent)}, which this server rejects with 400`,
  );
}
// Named explicitly because bin/vinci hardcodes `--thinking high`: this row runs on every launch.
assert.equal(model.thinkingLevelMap.high, "medium");
// role "developer" is a 400 on this server ("Unexpected message role").
assert.equal(model.compat.supportsDeveloperRole, false);
assert.equal(model.compat.maxTokensField, "max_tokens");
assert.equal(model.compat.supportsReasoningEffort, true);

// --- clean room: the child gets this lane's key and NOTHING else's ---------------------------
assert.deepEqual(PROVIDER_KEY_ENV["telus-qwen"], ["TELUS_QWEN_API_KEY"]);
const roomBase = {
  PATH: "/usr/bin",
  TELUS_QWEN_API_KEY: "telus-secret",
  TELUS_QWEN_BASE_URL: BASE_URL,
  OPENROUTER_API_KEY: "openrouter-secret",
  VINCI_API_KEY: "vinci-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
};
const room = cleanRoomEnv({ base: roomBase, provider: "telus-qwen", homeDir: "/tmp/h", tmpDir: "/tmp/t" });
assert.equal(room.TELUS_QWEN_API_KEY, "telus-secret");
// Not a secret, but the provider does not register without it, so the task cannot run if it is
// dropped. It travels through the allowlist, not through PROVIDER_KEY_ENV.
assert.ok(CLEAN_ROOM_ENV_ALLOWLIST.includes("TELUS_QWEN_BASE_URL"));
assert.equal(room.TELUS_QWEN_BASE_URL, BASE_URL);
for (const leaked of ["OPENROUTER_API_KEY", "VINCI_API_KEY", "AWS_SECRET_ACCESS_KEY"]) {
  assert.equal(room[leaked], undefined, `${leaked} must not reach a telus-qwen task`);
}
// The reverse control: another provider's task must not receive THIS lane's key.
const openrouterRoom = cleanRoomEnv({ base: roomBase, provider: "openrouter", homeDir: "/tmp/h", tmpDir: "/tmp/t" });
assert.equal(openrouterRoom.TELUS_QWEN_API_KEY, undefined);
assert.equal(openrouterRoom.OPENROUTER_API_KEY, "openrouter-secret");

// --- launcher: each refusal isolated to the guard it claims to test ---------------------------
// `-p` (not `--version`) because the launcher answers --version BEFORE provider setup, so a
// --version probe would exit 0 without ever reaching the checks below.
function launch(env) {
  return spawnSync("bash", [launcher, "-p", "hi"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, VINCI_PROVIDER: "telus-qwen", VINCI_MODEL: MODEL_ID, ...env },
  });
}

// Missing key: the endpoint IS supplied, so a refusal here cannot be the base-URL guard answering.
const noKey = launch({ TELUS_QWEN_API_KEY: "", TELUS_QWEN_BASE_URL: BASE_URL });
assert.equal(noKey.status, 2);
assert.match(noKey.stderr, /TELUS_QWEN_API_KEY is required/);

// Missing endpoint: the key IS supplied, so this isolates the other guard.
const noUrl = launch({ TELUS_QWEN_API_KEY: "k", TELUS_QWEN_BASE_URL: "" });
assert.equal(noUrl.status, 2);
assert.match(noUrl.stderr, /TELUS_QWEN_BASE_URL is required/);

// Wrong model, both credentials present: neither credential guard can be the one refusing.
const wrongModel = launch({ TELUS_QWEN_API_KEY: "k", TELUS_QWEN_BASE_URL: BASE_URL, VINCI_MODEL: "Qwen/Other" });
assert.equal(wrongModel.status, 2);
assert.match(wrongModel.stderr, /pinned to Qwen\/Qwen3\.8-27B/);

// Positive reachability control through the SAME entry point and environment. Without it, every
// refusal above would still pass if the `telus-qwen)` arm were simply `exit 2` — the lane would be
// unreachable and the suite would stay green. With both credentials and the pinned model the
// launcher must get PAST its guards and hand off to pi; pi then fails on the unroutable host, which
// is a different failure with a different exit code and none of our guard messages.
const reached = spawnSync("bash", [launcher, "-p", "hi"], {
  cwd: root,
  encoding: "utf8",
  timeout: 90_000,
  env: {
    ...process.env,
    VINCI_PROVIDER: "telus-qwen",
    VINCI_MODEL: MODEL_ID,
    TELUS_QWEN_API_KEY: "k",
    TELUS_QWEN_BASE_URL: BASE_URL,
    VINCI_TOOL_BOOTSTRAP: "0",
    VINCI_NO_RESUME: "1",
    VINCI_NO_VERIFY: "1",
  },
});
assert.notEqual(reached.status, 2, `launcher refused a fully-configured telus-qwen lane: ${reached.stderr}`);
for (const guard of [/TELUS_QWEN_API_KEY is required/, /TELUS_QWEN_BASE_URL is required/, /pinned to Qwen/, /Unsupported VINCI_PROVIDER/]) {
  assert.doesNotMatch(reached.stderr, guard, "a fully-configured lane must clear every launcher guard");
}

// No silent fallback: a provider this launcher does not know must REFUSE, never quietly resolve to
// the managed Vinci class. A lane that fails open forges independence — a result stamped with a
// model that did not generate it is worse than no result.
const unknown = spawnSync("bash", [launcher, "-p", "hi"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, VINCI_PROVIDER: "telus-qwn", VINCI_MODEL: MODEL_ID },
});
assert.equal(unknown.status, 2, "a typo'd provider must refuse, not fall back");
assert.match(unknown.stderr, /Unsupported VINCI_PROVIDER/);

process.stdout.write(
  "  Telus Qwen lane: registers only with both credentials, pins the served model, maps --thinking high to the highest accepted effort (medium), and leaks no other provider's key\n",
);
