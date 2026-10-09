import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { runVocabularyAssertions } from "./vocabulary-assertions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const extensionRoot = resolve(here, "../extensions");
const [acceptModule, outcomeModule, receiptModule, stateModule] = await Promise.all([
  loader.import(resolve(extensionRoot, "vinci-accept.ts"), { default: false }),
  loader.import(resolve(extensionRoot, "lib/task-outcome.ts"), { default: false }),
  loader.import(resolve(extensionRoot, "vinci-receipt.ts"), { default: false }),
  loader.import(resolve(extensionRoot, "lib/verification-state.ts"), { default: false }),
]);

runVocabularyAssertions(
  {
    acceptModule,
    outcomeModule,
    receiptModule,
    stateModule,
    sourceModules: {
      accept: readFileSync(resolve(extensionRoot, "vinci-accept.ts"), "utf8"),
      outcome: readFileSync(resolve(extensionRoot, "lib/task-outcome.ts"), "utf8"),
      receipt: readFileSync(resolve(extensionRoot, "vinci-receipt.ts"), "utf8"),
    },
  },
  "contract-vocabulary.mjs",
);
