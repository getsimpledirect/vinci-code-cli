import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CRASH_EDGES, EFFECT_CRASH_EDGES, LOCAL_EVIDENCE_CLASSIFICATION, MUTATION_CASES, NATIVE_LINUX_CASES } from "./harnesses.mjs";

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
});

test("native sources remain explicit unadmitted fail-closed artifacts", () => {
  const trampoline = readFileSync(new URL("../native/trampoline_linux.c", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../native/launcher_linux.c", import.meta.url), "utf8");
  const admission = JSON.parse(readFileSync(new URL("../native/native-admission.json", import.meta.url), "utf8"));
  assert.match(trampoline, /unadmitted trampoline build refused/);
  assert.match(trampoline, /return 126/);
  assert.match(launcher, /return -ENOTSUP/);
  assert.equal(admission.admitted, false);
  assert.equal(admission.binary_sha256, null);
  assert.equal(admission.linux_test_receipt, null);
  assert.equal(createHash("sha256").update(trampoline).digest("hex"), admission.trampoline_source_sha256);
  assert.equal(createHash("sha256").update(launcher).digest("hex"), admission.launcher_source_sha256);
  const protocol = readFileSync(new URL("../native/protocol.h", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(protocol).digest("hex"), admission.protocol_header_sha256);
});

test("local evidence classification explicitly denies Linux containment proof", () => {
  assert.ok(LOCAL_EVIDENCE_CLASSIFICATION.establishes.every((claim) => claim.startsWith("portable")));
  assert.ok(LOCAL_EVIDENCE_CLASSIFICATION.does_not_establish.includes("clone3 or born-in-domain placement"));
  assert.ok(LOCAL_EVIDENCE_CLASSIFICATION.does_not_establish.includes("memfd fsync/seal behavior or writer elimination"));
});
