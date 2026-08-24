import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateHoldoutVerification, verifyHoldoutScenario } from "./verify-holdout-corpus.mjs";

const manifest = {
  version: 1,
  scenarios: [{
    id: "hidden-behavior",
    allowedChangedFiles: ["source.js"],
    commands: [["node", "$VERIFIER_ROOT/pass.mjs"]],
    timeoutSeconds: 60,
  }],
};
const [scenario] = validateHoldoutVerification(manifest);
assert.throws(
  () => validateHoldoutVerification({ ...manifest, scenarios: [{ ...scenario, allowedChangedFiles: ["../secret"] }] }),
  /unsafe path/,
);
assert.throws(
  () => validateHoldoutVerification({ ...manifest, scenarios: [{ ...scenario, commands: [["bash", "verify.sh"]] }] }),
  /not allowlisted/,
);

const root = mkdtempSync(join(tmpdir(), "vinci-holdout-unit-"));
try {
  const checkout = join(root, "checkout");
  const verifier = join(root, "verifier");
  const output = join(root, "output");
  mkdirSync(checkout);
  mkdirSync(verifier);
  mkdirSync(output);
  execFileSync("git", ["init", "--quiet"], { cwd: checkout });
  writeFileSync(join(checkout, "source.js"), "before\n");
  execFileSync("git", ["add", "source.js"], { cwd: checkout });
  execFileSync("git", ["-c", "user.name=Holdout", "-c", "user.email=holdout@vinci.invalid", "commit", "--quiet", "-m", "seed"], { cwd: checkout });
  writeFileSync(join(checkout, "source.js"), "after\n");
  writeFileSync(join(verifier, "pass.mjs"), "process.exit(0);\n");
  const passed = verifyHoldoutScenario(scenario, checkout, verifier, output);
  assert.equal(passed.passed, true);
  writeFileSync(join(checkout, "unexpected.js"), "no\n");
  const scoped = verifyHoldoutScenario(scenario, checkout, verifier, output);
  assert.equal(scoped.passed, false);
  assert.deepEqual(scoped.unexpectedChangedFiles, ["unexpected.js"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("verify-holdout-corpus-unit: hidden checks and scope gate passed\n");
