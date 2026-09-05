import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harness = readFileSync(resolve(here, "run.sh"), "utf8");

function executableRegistrations(source) {
  // Whole executable shell line only: a comment, echo/string decoy, suffix, or prefix must not count.
  return source.match(
    /^[ \t]*run_group search-ssrf node --experimental-strip-types "\$\{ROOT\}\/vinci\/extensions\/vinci-search\.test\.mjs"[ \t]*\r?$/gm,
  ) ?? [];
}

function assertRegisteredOnce(source) {
  assert.equal(
    executableRegistrations(source).length,
    1,
    "the canonical harness must run the production-import SSRF test exactly once with TypeScript stripping",
  );
}

assertRegisteredOnce(harness);
const [registrationLine] = executableRegistrations(harness);
const withoutRegistration = harness.replace(registrationLine, "");
assert.throws(() => assertRegisteredOnce(withoutRegistration), /must run the production-import SSRF test exactly once/);

const indentation = registrationLine.match(/^[ \t]*/)?.[0] ?? "";
const commentedOut = harness.replace(registrationLine, `${indentation}# ${registrationLine.trimStart()}`);
assert.throws(() => assertRegisteredOnce(commentedOut), /must run the production-import SSRF test exactly once/);

const substringDecoy = `${withoutRegistration}\necho '${registrationLine.trim()}'\n`;
assert.throws(() => assertRegisteredOnce(substringDecoy), /must run the production-import SSRF test exactly once/);

console.log("search-ssrf-registration: exact executable line passes; removal/comment/substring mutations fail");
