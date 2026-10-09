// The local verdict vocabulary in vinci/extensions/lib/canonical-verdicts.ts must be byte-for-byte
// the package's — and must reach it at TEST time only. This file is the one place on the
// canonical-verdicts path allowed to import `@getsimpledirect/vinci-contracts` as a value.
//
// 0.0.51 shipped canonical-verdicts.ts importing RUN_STATES/VERDICT_STATUSES from the package at
// runtime; the package is private and excluded from the tarball, so every launch died. The fix keeps
// the vocabulary local and pins it here instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_STATES,
  VERDICT_STATUSES,
  isVerdictStatus as contractIsVerdictStatus,
} from "@getsimpledirect/vinci-contracts";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const libRoot = resolve(here, "../extensions/lib");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const local = await loader.import(resolve(libRoot, "canonical-verdicts.ts"), { default: false });

const contractAttemptStatuses = RUN_STATES.filter((status) => status === "FAILED" || status === "CANCELLED");

assert.deepEqual([...local.VERDICT_STATUSES], [...VERDICT_STATUSES], "VERDICT_STATUSES must equal the package's, in order");
assert.deepEqual(
  [...local.ATTEMPT_STATUSES],
  contractAttemptStatuses,
  "ATTEMPT_STATUSES must equal the package's FAILED/CANCELLED run states, in RUN_STATES order",
);
assert.deepEqual(
  [...local.ACCEPTED_WIRE_STATUSES],
  [...VERDICT_STATUSES, ...contractAttemptStatuses],
  "ACCEPTED_WIRE_STATUSES must be the verdicts followed by the attempt statuses",
);
assert.ok(Object.isFrozen(local.VERDICT_STATUSES) && Object.isFrozen(local.ATTEMPT_STATUSES) && Object.isFrozen(local.ACCEPTED_WIRE_STATUSES));
console.log("ok (1) local VERDICT/ATTEMPT/ACCEPTED_WIRE vocabularies deep-equal the installed contract");

const probes = [...RUN_STATES, ...VERDICT_STATUSES, "verified_pass", "DONE ", "", 42, null, undefined, {}];
for (const probe of probes) {
  assert.equal(local.isVerdictStatus(probe), contractIsVerdictStatus(probe), `isVerdictStatus(${JSON.stringify(probe)}) must agree with the package`);
  assert.equal(local.isAttemptStatus(probe), contractAttemptStatuses.includes(probe), `isAttemptStatus(${JSON.stringify(probe)})`);
  assert.equal(
    local.isAcceptedWireStatus(probe),
    contractIsVerdictStatus(probe) || contractAttemptStatuses.includes(probe),
    `isAcceptedWireStatus(${JSON.stringify(probe)})`,
  );
}
console.log(`ok (2) membership wrappers agree with the package over ${probes.length} probes`);

// Source discipline: the runtime files may reach the package only through `import type`. A value
// import here is exactly the 0.0.51 defect; the check-no-contracts-at-runtime.sh guard also scans
// the BUILT output, but this catches it at the source before a build ever runs.
const valueImport = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["']@getsimpledirect\//m;
const dynamicImport = /(?:\bimport\s*\(|\brequire\s*\()\s*["']@getsimpledirect\//;
for (const file of ["canonical-verdicts.ts", "verification-contract.ts", "verification-state.ts"]) {
  const source = readFileSync(resolve(libRoot, file), "utf8");
  assert.doesNotMatch(source, valueImport, `${file} must import only types from @getsimpledirect/*`);
  assert.doesNotMatch(source, dynamicImport, `${file} must not load @getsimpledirect/* at runtime`);
}
console.log("ok (3) canonical-verdicts.ts, verification-contract.ts, verification-state.ts import only types from the package");

console.log("✓ canonical-verdicts-contract.mjs: all tests passed");
