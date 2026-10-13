import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runVocabularyAssertions } from "./vocabulary-assertions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const builtAcceptPath = resolve(root, "vinci/dist/extensions/vinci-accept.js");
const builtOutcomePath = resolve(root, "vinci/dist/extensions/lib/task-outcome.js");
const builtReceiptPath = resolve(root, "vinci/dist/extensions/vinci-receipt.js");
const builtStatePath = resolve(root, "vinci/dist/extensions/lib/verification-state.js");

if (process.env.VINCI_PACKAGED_VOCABULARY_REUSE_BUILD !== "1") {
  const build = spawnSync("bash", [resolve(root, "vinci/build.sh")], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  assert.equal(build.status, 0, "packaged vocabulary build must succeed");
}

for (const builtPath of [builtAcceptPath, builtOutcomePath, builtReceiptPath, builtStatePath]) {
  assert(existsSync(builtPath), `built vocabulary module must exist: ${builtPath}`);
}
const builtSource = readFileSync(builtStatePath, "utf8");
assert.match(builtSource, /VERIFIED_PASS/);
assert.match(builtSource, /CONDITIONAL/);
assert.match(builtSource, /CANCELLED/);
assert.doesNotMatch(builtSource, /(?:require\s*\(\s*|from\s*)["']@getsimpledirect/);

const cacheKey = Date.now();
const [acceptModule, outcomeModule, receiptModule, stateModule] = await Promise.all([
  import(`${pathToFileURL(builtAcceptPath).href}?vocabulary=${cacheKey}`),
  import(`${pathToFileURL(builtOutcomePath).href}?vocabulary=${cacheKey}`),
  import(`${pathToFileURL(builtReceiptPath).href}?vocabulary=${cacheKey}`),
  import(`${pathToFileURL(builtStatePath).href}?vocabulary=${cacheKey}`),
]);
runVocabularyAssertions(
  {
    acceptModule,
    outcomeModule,
    receiptModule,
    stateModule,
    sourceModules: {
      accept: readFileSync(builtAcceptPath, "utf8"),
      outcome: readFileSync(builtOutcomePath, "utf8"),
      receipt: readFileSync(builtReceiptPath, "utf8"),
    },
  },
  "packaged-vocabulary.mjs",
);
