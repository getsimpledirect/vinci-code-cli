// Optional in public trees; private CI requires both packages and runs the separate tsgo type pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packages = ["@getsimpledirect/vinci-contracts", "@getsimpledirect/vinci-model-classes"];
const missing = [];
for (const name of packages) {
  try {
    require.resolve(`${name}/package.json`);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    missing.push(name);
  }
}
if (missing.length > 0) {
  if (process.env.VINCI_REQUIRE_PRIVATE_CONTRACTS === "1") {
    console.error(`FAIL: required private contracts packages not installed: ${missing.join(", ")}. Install both 0.2.0 packages before running private CI.`);
    process.exit(1);
  }
  console.log("SKIP: private contracts packages not installed (public tree); drift is enforced in the private repository CI.");
  process.exit(0);
}

try {
  const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const [contract, modelClasses, local, outcome] = await Promise.all([
    loader.import(require.resolve(packages[0]), { default: false }),
    loader.import(require.resolve(packages[1]), { default: false }),
    loader.import(resolve(here, "../extensions/lib/canonical-verdicts.ts"), { default: false }),
    loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false }),
  ]);
  const attempts = contract.RUN_STATES.filter((status) => status === "FAILED" || status === "CANCELLED");
  assert.deepEqual([...local.VERDICT_STATUSES], [...contract.VERDICT_STATUSES], "VERDICT_STATUSES must equal the private package, in order");
  assert.deepEqual([...local.ATTEMPT_STATUSES], attempts, "ATTEMPT_STATUSES must equal FAILED/CANCELLED in private RUN_STATES order");
  assert.deepEqual([...local.ACCEPTED_WIRE_STATUSES], [...contract.VERDICT_STATUSES, ...attempts], "ACCEPTED_WIRE_STATUSES must equal private verdicts followed by attempts");
  console.log("ok (1) local VERDICT/ATTEMPT/ACCEPTED_WIRE vocabularies deep-equal the installed private contract");

  const probes = [...contract.RUN_STATES, ...contract.VERDICT_STATUSES, "verified_pass", "DONE ", "", 42, null, undefined, {}];
  for (const probe of probes) {
    assert.equal(local.isVerdictStatus(probe), contract.isVerdictStatus(probe), `isVerdictStatus(${JSON.stringify(probe)}) must agree with the private package`);
    assert.equal(local.isAttemptStatus(probe), attempts.includes(probe), `isAttemptStatus(${JSON.stringify(probe)})`);
    assert.equal(local.isAcceptedWireStatus(probe), contract.isVerdictStatus(probe) || attempts.includes(probe), `isAcceptedWireStatus(${JSON.stringify(probe)})`);
  }
  console.log(`ok (2) membership wrappers agree with the private package over ${probes.length} probes`);

  for (const status of [...contract.VERDICT_STATUSES, ...attempts]) {
    for (const staled of [false, true]) {
      const verification = attempts.includes(status) ? { kind: "not-issued", reason: status } : { kind: "issued", status, staled };
      assert.equal(outcome.remoteVerdictTaskState({ status, staled }), contract.terminalStateOfVerification(verification), `Task outcome for ${status} (staled=${staled}) must agree with the private package`);
    }
  }
  console.log("ok (3) fresh/stale verdict and attempt outcomes agree with the private contract");

  // Extract the local type's literals without adding a new runtime array to shipped provenance.
  const sourcePath = resolve(here, "../extensions/vinci-model-provenance.ts");
  const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
  const evidence = source.statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === "ResolutionEvidence");
  assert.ok(evidence && ts.isUnionTypeNode(evidence.type), "Local ResolutionEvidence must remain a literal union");
  const localEvidence = evidence.type.types.map((type) => {
    assert.ok(ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal), "ResolutionEvidence members must be string literals");
    return type.literal.text;
  });
  assert.deepEqual(localEvidence, [...modelClasses.RESOLUTION_EVIDENCE], "Local ResolutionEvidence must equal the private model-classes runtime vocabulary, in order");
  console.log("ok (4) local ResolutionEvidence deep-equals the installed private model-classes vocabulary");
  console.log("✓ private-contracts-drift.mjs: all runtime drift checks passed; run the private tsgo pin separately");
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  console.error(`FAIL: private contracts drift check failed: ${message}. Reconcile local definitions with the private contracts before merging.`);
  process.exitCode = 1;
}
