import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { CRASH_EDGES, EFFECT_CRASH_EDGES, LOCAL_EVIDENCE_CLASSIFICATION, MUTATION_CASES, NATIVE_LINUX_CASES } from "./harnesses.mjs";

const RECEIPT_KEY = Buffer.alloc(32, 0x43);

function replaceExactly(source, target, replacement, expectedCount = 1) {
  assert.equal(source.split(target).length - 1, expectedCount, `mutation target count: ${target}`);
  return source.replaceAll(target, replacement);
}

async function importCanonicalMutant(name, mutate) {
  const source = readFileSync(new URL("../src/canonical.mjs", import.meta.url), "utf8");
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${name}: mutation must change the source`);
  const directory = mkdtempSync(join(tmpdir(), `vinci-canonical-${name}-`));
  const path = join(directory, "canonical.mjs");
  writeFileSync(path, mutated);
  return import(`${pathToFileURL(path).href}?mutant=${name}`);
}

function historicalReceipt(payload) {
  const body = Buffer.from(
    '{"key_id":"root-key:v3","kind":"terminal","payload":{"$bytes_base64":"3q2+7w=="},"schema":"vinci.containment-broker.receipt/v3"}',
  );
  return {
    authentication: {
      algorithm: "hmac-sha256",
      mac: createHmac("sha256", RECEIPT_KEY).update(body).digest("hex"),
    },
    body_sha256: createHash("sha256").update(body).digest("hex"),
    key_id: "root-key:v3",
    kind: "terminal",
    payload,
    schema: "vinci.containment-broker.receipt/v3",
  };
}

async function assertMutationKilled(name, mutate, securityProperty) {
  const mutant = await importCanonicalMutant(name, mutate);
  assert.equal(await securityProperty(mutant), false, `${name}: mutant survived its security discriminator`);
}

test("canonical security mutations are each killed by a behavioral discriminator", async () => {
  await assertMutationKilled("proxy-guard", (source) => replaceExactly(
    source,
    'if (isProxy(value)) throw new TypeError("Proxy values are not canonical");',
    'if (false) throw new TypeError("Proxy values are not canonical");',
  ), (mutant) => {
    const payload = new Proxy({ $bytes_base64: "3q2+7w==" }, {
      has(target, property) {
        if (property === "$bytes_base64") return false;
        return Reflect.has(target, property);
      },
    });
    try {
      mutant.canonicalBytes({ payload });
      return false;
    } catch {
      return true;
    }
  });

  await assertMutationKilled("verification-snapshot", (source) => replaceExactly(
    source,
    "receipt = snapshotCanonicalValue(receipt);",
    "receipt = receipt;",
  ), (mutant) => {
    const receipt = mutant.authenticateReceipt({
      kind: "terminal",
      keyId: "root-key:v3",
      key: RECEIPT_KEY,
      payload: { decision: "safe" },
    });
    return mutant.verifyReceipt(new Proxy(receipt, {}), {
      kind: "terminal",
      keyId: "root-key:v3",
      key: RECEIPT_KEY,
    }) === false;
  });

  await assertMutationKilled("verification-fail-closed", (source) => replaceExactly(
    source,
    `export function verifyReceipt(receipt, options) {
  try {
    options = snapshotVerifyOptions(options);
    return verifyReceiptUnchecked(receipt, options);
  } catch {
    return false;
  }
}`,
    `export function verifyReceipt(receipt, options) {
  options = snapshotVerifyOptions(options);
  return verifyReceiptUnchecked(receipt, options);
}`,
  ), (mutant) => {
    const receipt = historicalReceipt({ $bytes_base64: "3q2+7w==" });
    Object.defineProperty(receipt, "authentication", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    try {
      return mutant.verifyReceipt(receipt, {
        kind: "terminal",
        keyId: "root-key:v3",
        key: RECEIPT_KEY,
      }) === false;
    } catch {
      return false;
    }
  });

  await assertMutationKilled("verification-options-snapshot", (source) => replaceExactly(
    source,
    "options = snapshotVerifyOptions(options);",
    "options = options;",
  ), (mutant) => {
    const receipt = mutant.authenticateReceipt({
      kind: "terminal",
      keyId: "root-key:v3",
      key: RECEIPT_KEY,
      payload: { decision: "safe" },
    });
    let getterCalls = 0;
    const options = {};
    for (const [name, value] of [["kind", "terminal"], ["keyId", "root-key:v3"], ["key", RECEIPT_KEY]]) {
      Object.defineProperty(options, name, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return value;
        },
      });
    }
    return mutant.verifyReceipt(receipt, options) === false && getterCalls === 0;
  });

  await assertMutationKilled("intrinsic-key-length", (source) => replaceExactly(
    source,
    'if (byteLength < 32) throw new TypeError("receipt authentication key must be at least 32 bytes");',
    'if (false) throw new TypeError("receipt authentication key must be at least 32 bytes");',
  ), (mutant) => {
    const key = Buffer.alloc(0);
    Object.defineProperty(key, "length", { configurable: true, value: 32 });
    try {
      const receipt = mutant.authenticateReceipt({
        kind: "terminal",
        keyId: "root-key:v3",
        key,
        payload: { decision: "must-refuse-empty-key" },
      });
      return mutant.verifyReceipt(receipt, {
        kind: "terminal",
        keyId: "root-key:v3",
        key,
      }) === false;
    } catch {
      return true;
    }
  });

  await assertMutationKilled("reserved-field", (source) => replaceExactly(
    source,
    "if (RESERVED_BYTES_FIELD in value) {",
    "if (false) {",
    2,
  ), (mutant) => {
    try {
      mutant.canonicalBytes({ nested: { $bytes_base64: "AA==" } });
      return false;
    } catch {
      return true;
    }
  });

  await assertMutationKilled("exact-byte-equality", (source) => replaceExactly(
    source,
    "if (!encoded.equals(bytes)) {",
    "if (false) {",
  ), (mutant) => {
    try {
      mutant.decodeCanonicalBytes(Buffer.from('{"value":1,"value":1}'));
      return false;
    } catch {
      return true;
    }
  });

  await assertMutationKilled("safe-integer", (source) => replaceExactly(
    source,
    "if (Number.isInteger(value) && !Number.isSafeInteger(value)) {",
    "if (false) {",
  ), (mutant) => {
    try {
      mutant.canonicalBytes({ value: Number.MAX_SAFE_INTEGER + 1 });
      return false;
    } catch {
      return true;
    }
  });
});

test("crash harness names every irreversible launch, close, seal and receipt edge", () => {
  assert.equal(CRASH_EDGES.length, 29);
  for (const required of ["launch_intent", "task_create", "prelaunch_receipt", "release_armed", "closing", "ingress_close", "kill", "zero", "capture_fsync", "seal", "terminal_receipt"]) {
    assert.ok(CRASH_EDGES.some((edge) => edge.includes(required)), required);
  }
  for (const required of ["intent", "authority_recheck", "transport", "response", "confirmation", "reconciliation"]) {
    assert.ok(EFFECT_CRASH_EDGES.some((edge) => edge.includes(required)), required);
  }
});

test("mutation definitions cover every v3 authority-bearing invariant", () => {
  assert.equal(MUTATION_CASES.length, 22);
  for (const required of ["trampoline", "launch_intent", "UNCONTAINED", "descriptor", "ingress", "zero", "writer", "fsync", "seal", "bytes", "capability", "FD", "target", "authority", "retry", "remote", "fallback"]) {
    assert.ok(MUTATION_CASES.some((entry) => entry.join(" ").toLowerCase().includes(required.toLowerCase())), required);
  }
  assert.ok(NATIVE_LINUX_CASES.includes("transient_zero_one_zero_repopulation"));
  for (const required of [
    "queued_signal_before_clone_and_trampoline_boundary",
    "fd_source_alias_and_reserved_destination_permutations",
    "notification_replay_stale_id_two_writer_and_100000_call_census",
    "unlinked_late_alternate_target_bootstrap_entry",
    "wrong_cgroup_fd_retained_external_writer_and_late_repopulation",
    "prelaunch_divergent_journal_response_loss_and_directory_fsync_failure",
  ]) assert.ok(NATIVE_LINUX_CASES.includes(required), required);
});

test("native sources implement the reviewed boundary while admission remains categorically false", () => {
  const trampoline = readFileSync(new URL("../native/trampoline_linux.c", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../native/launcher_linux.c", import.meta.url), "utf8");
  const admission = JSON.parse(readFileSync(new URL("../native/native-admission.json", import.meta.url), "utf8"));
  assert.match(trampoline, /install_release_mediator/);
  assert.match(trampoline, /__NR_execveat/);
  assert.match(launcher, /CLONE_INTO_CGROUP \| CLONE_PIDFD/);
  assert.match(launcher, /__NR_clone3/);
  assert.equal(admission.admitted, false);
  assert.equal(admission.binary_sha256, null);
  assert.equal(admission.linux_build_receipt, null);
  assert.equal(admission.linux_test_receipt, null);
  // Transitive source manifest, enumerated rather than listed. The previous
  // hardcoded six named three fields the manifest did not even carry, so those
  // assertions compared against undefined; and any native source outside the six
  // could be edited with every test still green. Enumerating the directory means
  // adding, removing or editing ANY native source fails here until the manifest
  // is re-derived and the change re-reviewed.
  const nativeDirectory = new URL("../native/", import.meta.url);
  const sources = readdirSync(nativeDirectory)
    .filter((name) => name !== "native-admission.json")
    .sort();
  assert.ok(sources.length > 0, "native/ must contain sources");
  assert.deepEqual(Object.keys(admission.source_digests).sort(), sources);
  for (const name of sources) {
    const bytes = readFileSync(new URL(name, nativeDirectory));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      admission.source_digests[name],
      `native/${name} does not match its pinned digest`,
    );
  }
});

test("local evidence classification explicitly denies Linux containment proof", () => {
  assert.ok(LOCAL_EVIDENCE_CLASSIFICATION.establishes.every((claim) => claim.startsWith("portable")));
  assert.ok(LOCAL_EVIDENCE_CLASSIFICATION.does_not_establish.includes("clone3 or born-in-domain placement"));
  assert.ok(LOCAL_EVIDENCE_CLASSIFICATION.does_not_establish.includes("memfd fsync/seal behavior or writer elimination"));
});
