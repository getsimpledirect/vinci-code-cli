import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provider = await loader.import(resolve(here, "../extensions/vinci-provider.ts"), { default: false });

function registrations(qualification) {
  const prior = process.env.VINCI_DEEPINFRA_QUALIFICATION;
  if (qualification) process.env.VINCI_DEEPINFRA_QUALIFICATION = "1";
  else delete process.env.VINCI_DEEPINFRA_QUALIFICATION;
  const seen = [];
  try {
    provider.default({
      registerProvider(name, config) {
        seen.push({ name, config });
      },
      on() {},
    });
  } finally {
    if (prior === undefined) delete process.env.VINCI_DEEPINFRA_QUALIFICATION;
    else process.env.VINCI_DEEPINFRA_QUALIFICATION = prior;
  }
  return seen;
}

assert.deepEqual(
  registrations(false).map(({ name }) => name),
  ["vinci"],
  "DeepInfra must be absent from normal product model selection",
);

const [managed] = registrations(false);
// `auto` first: it is the default and resolves to whatever class the account chose. The concrete
// classes stay registered so a corpus run can pin one deliberately.
assert.deepEqual(managed.config.models.map(({ id }) => id), ["auto", "forte", "fortissimo"]);
// Class name only, never the occupant. The old label hardcoded "(GLM 5.2)", which survived purely
// because one class existed and its occupant never moved; the whole point of a class is that the
// model behind it rotates without a client release. The occupant is not exposed to API clients
// today anyway — /api/v1/models returns ids only — so any occupant here would be a stale guess.
assert.equal(managed.config.models[0].name, "Vinci");
assert.equal(managed.config.models[0].reasoning, true);
assert.equal(managed.config.models[0].thinkingLevelMap.high, "high");
assert.equal(managed.config.models[0].thinkingLevelMap.xhigh, "xhigh");

const enabled = registrations(true);
assert.deepEqual(enabled.map(({ name }) => name), ["vinci", "deepinfra"]);
const deepinfra = enabled[1].config;
assert.equal(deepinfra.baseUrl, "https://api.deepinfra.com/v1/openai");
assert.equal(deepinfra.apiKey, "$VINCI_INTERNAL_DEEPINFRA_API_KEY");
assert.equal(deepinfra.api, "openai-completions");
assert.equal(deepinfra.models.length, 1);
const forte = deepinfra.models[0];
assert.equal(forte.id, "zai-org/GLM-5.2");
assert.equal(forte.name, "Vinci Forte (GLM 5.2 qualification)");
assert.equal(forte.reasoning, true);
assert.equal(forte.thinkingLevelMap.high, "high");
assert.equal(forte.thinkingLevelMap.xhigh, "xhigh");
assert.equal(forte.compat.supportsDeveloperRole, false);
assert.equal(forte.compat.supportsStore, false);
assert.equal(forte.compat.maxTokensField, "max_tokens");
assert.equal(forte.compat.supportsStrictMode, false);

const taskId = "2d878b1e-74aa-41ee-829b-a16b677db21e";
const blocked = provider.vinciBudgetBlockedMessage(
  '{"error":{"message":"Out of credits. Buying more credits is coming soon.","type":"budget_exhausted"}}',
  taskId,
);
assert.equal(
  blocked,
  "BLOCKED: budget — Vinci usage credits are unavailable for this request. Your checkpoint is saved. " +
    "Review or restore credits at https://platform.getsimpledirect.com/billing?source=code" +
    `, then run \`vinci resume ${taskId}\`.`,
);
assert.match(
  provider.vinciBudgetBlockedMessage("Request failed with status 402", taskId),
  /BLOCKED: budget/,
);
assert.match(
  provider.vinciBudgetBlockedMessage("Today's free allowance is used up — it resets at midnight UTC.", taskId),
  /platform\.getsimpledirect\.com\/billing\?source=code/,
);
assert.equal(provider.vinciBudgetBlockedMessage("429: Slow down a moment", taskId), undefined);
const unsafeTask = provider.vinciBudgetBlockedMessage("budget_exhausted", "task` && touch /tmp/unsafe");
assert.ok(unsafeTask);
assert.doesNotMatch(unsafeTask, /touch|vinci resume/);

for (const args of [
  ["--provider", "openai", "--version"],
  ["--model=openai/gpt-test", "--version"],
  ["--models", "forte,other", "--version"],
  ["--api-key=test-key", "--version"],
]) {
  // Explicit opt-out, not the default. Vinci Code ships OPEN — an open-source client must work
  // with your own key and no account — so the managed-only boundary is something you ask for.
  const rejected = spawnSync("bash", [resolve(root, "vinci/bin/vinci"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, VINCI_SHOW_OTHER_PROVIDERS: "0" },
  });
  assert.equal(rejected.status, 2, `Managed Vinci must reject ${args[0]}`);
  // The rejection message names the class mechanism, not one class: Vinci Code follows whichever
  // class the account resolved, so naming Forte here would be wrong for anyone on another.
  assert.match(rejected.stderr, /managed Vinci model class/);
}

// The other direction, and the one that matters for an open-source client: with NOTHING set — no
// account, no env var, a fresh checkout — the launcher must ACCEPT a third-party provider. If this
// goes red, someone re-defaulted Vinci Code to require a Vinci sign-in before it will do anything.
{
  const openEnv = { ...process.env };
  delete openEnv.VINCI_SHOW_OTHER_PROVIDERS;
  delete openEnv.VINCI_API_KEY;
  const accepted = spawnSync("bash", [resolve(root, "vinci/bin/vinci"), "--provider", "anthropic", "--version"], {
    cwd: root,
    encoding: "utf8",
    env: openEnv,
  });
  assert.notEqual(accepted.status, 2, "Default Vinci Code must ACCEPT --provider — no account required");
  assert.doesNotMatch(
    accepted.stderr,
    /managed Vinci model class/,
    "Default Vinci Code must not tell a BYOK user their provider is unsupported",
  );
  console.log("  \u2713 default accepts a third-party provider with no Vinci account");
}

let messageEnd;
provider.default({
  registerProvider() {},
  on(event, handler) {
    if (event === "message_end") messageEnd = handler;
  },
});
assert.equal(typeof messageEnd, "function");
const normalized = messageEnd(
  {
    message: {
      role: "assistant",
      stopReason: "error",
      provider: "vinci",
      errorMessage: "Request failed: budget_exhausted",
    },
  },
  {
    model: { provider: "vinci" },
    sessionManager: { getSessionId: () => taskId },
  },
);
assert.equal(normalized.message.errorMessage, blocked);

// Use a provider-invoking command (a print prompt) to trigger the key check — `--version` is now
// answered by the launcher BEFORE provider setup (see the version check below), so it no longer forces
// the credential path.
const missingKey = spawnSync("bash", [resolve(root, "vinci/bin/vinci"), "-p", "hi"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    VINCI_PROVIDER: "deepinfra",
    VINCI_MODEL: "zai-org/GLM-5.2",
    VINCI_INTERNAL_DEEPINFRA_API_KEY: "",
  },
});
assert.equal(missingKey.status, 2);
assert.match(missingKey.stderr, /VINCI_INTERNAL_DEEPINFRA_API_KEY is required/);

// `vinci --version` reports the branded version WITHOUT a provider key — checking your version must work
// offline / unconfigured, so the launcher answers it before Pi or provider setup.
const versionOut = spawnSync("bash", [resolve(root, "vinci/bin/vinci"), "--version"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, VINCI_PROVIDER: "deepinfra", VINCI_INTERNAL_DEEPINFRA_API_KEY: "" },
});
assert.equal(versionOut.status, 0);
assert.match(versionOut.stdout.trim(), /^\d+\.\d+\.\d+$/);

process.stdout.write(
  "  Vinci provider: managed Forte uses GLM 5.2 and account credit failures become resumable budget blocks\n",
);
