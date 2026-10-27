// Sandbox-safe: every invocation must exit at the argument boundary, before runtime dispatch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = resolve(root, "vinci/bin/vinci");
const { VINCI_SHOW_OTHER_PROVIDERS: ignored, ...base } = process.env;
const cases = [
  ["--provider", "openai"], ["--provider=openai"],
  ["--model", "openai/gpt-test"], ["--model=openai/gpt-test"],
  ["--models", "forte,openai/gpt-test"], ["--models=openai/gpt-test"],
  ["--model", "vinci/unknown"], ["--model=mezzo-extra"],
  ["--model", "forte:high"], ["--models=*"],
  ["--model", ""], ["--model="], ["--model"],
  ["--provider", ""], ["--provider="], ["--provider"],
  ["--models"], ["--api-key"], ["--api-key=[filtered]"],
  ["--model", "forte", "--provider", "openrouter"],
  ["--provider", "vinci", "--models", "unknown"],
];
let count = 0;
for (const visibility of [undefined, "0"]) {
  for (const args of cases) {
    const env = {
      ...base, VINCI_SOURCE_CLI: "1", VINCI_NO_BOOTSTRAP_HEAL: "1",
      VINCI_TOOL_BOOTSTRAP: "0", VINCI_UPDATE_DISABLED: "1", PI_OFFLINE: "1",
      ...(visibility === undefined ? {} : { VINCI_SHOW_OTHER_PROVIDERS: visibility }),
    };
    const result = spawnSync("bash", [launcher, ...args, "--version"], {
      cwd: root, env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined, "refusal must complete without a spawn error");
    assert.equal(result.status, 2, "other-provider arguments must exit before dispatch");
    assert.match(result.stderr, /Other providers are off/);
    assert.match(result.stderr, /auto, mezzo, forte/);
    assert.match(result.stderr, /\/other/);
    assert.equal(result.stdout, "", "refusal must not start the runtime");
    count++;
  }
  // No arguments leaves an empty normalization array. Reject an invalid environment class next,
  // still before runtime dispatch, to protect bare launches on the system Bash.
  const empty = spawnSync("bash", [launcher], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: {
      ...base, VINCI_SOURCE_CLI: "1", VINCI_MODEL: "doesnotexist",
      VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_TOOL_BOOTSTRAP: "0", VINCI_UPDATE_DISABLED: "1",
      ...(visibility === undefined ? {} : { VINCI_SHOW_OTHER_PROVIDERS: visibility }),
    },
  });
  assert.equal(empty.error, undefined);
  assert.equal(empty.status, 2, "empty boundary must reach the environment argument check");
  assert.match(empty.stderr, /Unknown Vinci model/);
  assert.equal(empty.stdout, "");
  count++;
}
process.stdout.write(`vinci-launcher-refusals: ${count} argument refusals exited 2 before runtime dispatch\n`);
