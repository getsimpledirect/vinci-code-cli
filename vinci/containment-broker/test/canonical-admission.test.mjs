import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AdmissionRefusedError,
  authenticateReceipt,
  buildPrelaunchReceipt,
  buildTerminalReceipt,
  evaluateHostAdmission,
  NATIVE_IMPLEMENTATION_ADMITTED,
  requireNativeAdmission,
  validatePrelaunchAttestation,
  verifyReceipt,
} from "../src/index.mjs";

const KEY = Buffer.alloc(32, 0x43);

test("canonical authenticated receipts reject tampering and wrong keys", () => {
  const receipt = authenticateReceipt({
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
    payload: { episode_id: "episode-1", decision: "SEALED/contained" },
  });
  assert.equal(verifyReceipt(receipt, { kind: "terminal", keyId: "root-key:v3", key: KEY }), true);
  const tampered = structuredClone(receipt);
  tampered.payload.decision = "SEALED/unproven";
  assert.equal(verifyReceipt(tampered, { kind: "terminal", keyId: "root-key:v3", key: KEY }), false);
  assert.equal(verifyReceipt(receipt, {
    kind: "terminal",
    keyId: "root-key:v3",
    key: Buffer.alloc(32, 0x44),
  }), false);
  assert.equal(verifyReceipt({ ...receipt, untrusted_extra: true }, {
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
  }), false);
  const cycle = [];
  cycle.push(cycle);
  assert.throws(() => authenticateReceipt({
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
    payload: cycle,
  }), /cycles/);
});

test("the local host and missing native receipt categorically refuse launch", () => {
  const policy = { trampoline_binary_sha256: null };
  const probe = {
    platform: process.platform,
    cgroup_version: null,
    delegated: null,
    post_start_placement: false,
    controllers: {},
    domain: {},
    descriptor_continuity: false,
    capture: {},
    admission: {},
  };
  const evaluated = evaluateHostAdmission(probe, policy);
  assert.equal(evaluated.admitted, false);
  // Platform-dependent, and it had never run on Linux until this suite was wired
  // into CI: `unsupported_non_linux` is correctly ABSENT on a Linux host. The
  // invariant being tested is that the host refuses either way, which is
  // asserted above and by the trampoline reason below.
  if (process.platform !== "linux") {
    assert.ok(evaluated.reasons.includes("unsupported_non_linux"));
  } else {
    assert.ok(!evaluated.reasons.includes("unsupported_non_linux"));
  }
  assert.ok(evaluated.reasons.includes("trampoline_binary_unadmitted"));
  assert.throws(
    () => requireNativeAdmission({ probe, policy, nativeAdapter: null }),
    (error) => error.code === "NATIVE_CONTAINMENT_UNAVAILABLE"
      && error.reasons.includes("native_adapter_unavailable")
      && error.reasons.includes("native_implementation_unadmitted")
      && error.reasons.includes("real_linux_admission_unverified"),
  );
  assert.equal(NATIVE_IMPLEMENTATION_ADMITTED, false);
});

function validAttestation() {
  return {
    uid: 501,
    gid: 20,
    supplementary_groups: ["20", "501"],
    no_new_privs: true,
    capabilities: {
      permitted: [],
      effective: [],
      inheritable: [],
      ambient: [],
      bounding: [],
    },
    namespaces: { user: "u:1", pid: "p:1", mount: "m:1", cgroup: "c:1" },
    cgroup_view: { writable: false, identity: "cg:view" },
    cgroup_mount_identity: "cgroup2:mount:1",
    controllers: {
      broker_only: true,
      membership_identity: "cgroup.procs:1",
      kill_identity: "cgroup.kill:1",
      events_identity: "cgroup.events:1",
    },
    controller_objects: {
      events: { identity: "events:1", owner_uid: 0, owner_gid: 0, mode: "0600", acl_sha256: "2".repeat(64), episode_writable: false, broker_only: true },
      kill: { identity: "kill:1", owner_uid: 0, owner_gid: 0, mode: "0200", acl_sha256: "3".repeat(64), episode_writable: false, broker_only: true },
      membership: { identity: "membership:1", owner_uid: 0, owner_gid: 0, mode: "0600", acl_sha256: "4".repeat(64), episode_writable: false, broker_only: true },
    },
    seccomp_profile_identity: "seccomp:vinci-v3",
    lsm_profile_identity: "lsm:vinci-v3",
    inherited_fds: [
      { fd: 3, type: "seqpacket", access: "rw", flags: "cloexec", identity: "control:1" },
      { fd: 4, type: "regular", access: "r", flags: "cloexec", identity: "exec:1" },
    ],
    trampoline_sha256: "a".repeat(64),
    executable_sha256: "b".repeat(64),
    loader_sha256: "e".repeat(64),
    runtime_sha256: "c".repeat(64),
    rootfs_sha256: "f".repeat(64),
    admission_sha256: "1".repeat(64),
    argv_environment_sha256: "d".repeat(64),
    broker_build_sha256: "6".repeat(64),
    package_sha256: "7".repeat(64),
    boot_identity: "boot:1",
    host_identity: "host:1",
    kernel_identity: "kernel:1",
    capture_descriptor_identity: "memfd:1",
    admission_expires_at: "2999-01-01T00:00:00Z",
    release_nonce: "nonce-1",
    domain_descriptor_identity: "domain-fd:1",
    release_object_identity: "release-fd:1",
    launch_adapter: "clone3_trampoline",
    ingress: [{ id: "stdout", max_bytes: 1024, capture_identity: "memfd:1", episode_holds_capture_writer: false }],
    capture_max_bytes: 1024,
    limits: { memory_bytes: 1024, runtime_ms: 5000 },
    deadline: "2999-01-01T00:00:00Z",
    episode_bytes_executed: false,
    capture_bytes_written: false,
  };
}

function policyFor(attestation) {
  return {
    uid: attestation.uid,
    gid: attestation.gid,
    supplementary_groups: attestation.supplementary_groups,
    capabilities: attestation.capabilities,
    namespaces: attestation.namespaces,
    cgroup_mount_identity: attestation.cgroup_mount_identity,
    cgroup_view_identity: attestation.cgroup_view.identity,
    controllers: attestation.controllers,
    controller_objects: attestation.controller_objects,
    seccomp_profile_identity: attestation.seccomp_profile_identity,
    lsm_profile_identity: attestation.lsm_profile_identity,
    inherited_fds: attestation.inherited_fds,
    trampoline_sha256: attestation.trampoline_sha256,
    executable_sha256: attestation.executable_sha256,
    loader_sha256: attestation.loader_sha256,
    runtime_sha256: attestation.runtime_sha256,
    rootfs_sha256: attestation.rootfs_sha256,
    admission_sha256: attestation.admission_sha256,
    argv_environment_sha256: attestation.argv_environment_sha256,
    broker_build_sha256: attestation.broker_build_sha256,
    package_sha256: attestation.package_sha256,
    boot_identity: attestation.boot_identity,
    host_identity: attestation.host_identity,
    kernel_identity: attestation.kernel_identity,
    capture_descriptor_identity: attestation.capture_descriptor_identity,
    admission_expires_at: attestation.admission_expires_at,
    release_nonce: attestation.release_nonce,
    domain_descriptor_identity: attestation.domain_descriptor_identity,
    release_object_identity: attestation.release_object_identity,
    launch_adapter: attestation.launch_adapter,
    ingress: attestation.ingress,
    capture_max_bytes: attestation.capture_max_bytes,
    limits: attestation.limits,
    deadline: attestation.deadline,
  };
}

test("portable prelaunch schema requires exact privilege and FD facts", () => {
  const attestation = validAttestation();
  assert.match(validatePrelaunchAttestation(attestation, policyFor(attestation)).attestation_sha256, /^[0-9a-f]{64}$/);

  const root = structuredClone(attestation);
  root.uid = 0;
  assert.throws(() => validatePrelaunchAttestation(root, policyFor(attestation)), AdmissionRefusedError);

  const capability = structuredClone(attestation);
  capability.capabilities.effective = ["CAP_SYS_ADMIN"];
  assert.throws(
    () => validatePrelaunchAttestation(capability, policyFor(attestation)),
    (error) => error.reasons.includes("forbidden_capability:effective"),
  );

  const unexpectedFd = structuredClone(attestation);
  unexpectedFd.inherited_fds.push({ fd: 7, type: "directory", access: "rw", flags: "cloexec", identity: "root" });
  assert.throws(
    () => validatePrelaunchAttestation(unexpectedFd, policyFor(attestation)),
    (error) => error.reasons.includes("fd_allowlist_mismatch"),
  );

  const writableController = structuredClone(attestation);
  writableController.controller_objects.kill.episode_writable = true;
  assert.throws(
    () => validatePrelaunchAttestation(writableController, policyFor(attestation)),
    (error) => error.reasons.includes("controller_objects_invalid"),
  );
});

test("authority receipt builders categorically refuse the unadmitted native implementation", () => {
  const attestation = validAttestation();
  assert.throws(() => buildPrelaunchReceipt({
    attestation,
    policy: policyFor(attestation),
    episode: { episode_id: "episode-receipt", domain_identity: "domain:1", lifecycle_state: "TASK_CREATED" },
    journalDigest: "2".repeat(64),
    keyId: "root-key:v3",
    key: KEY,
  }), (error) => error.code === "NATIVE_CONTAINMENT_UNAVAILABLE"
    && error.reasons.includes("native_implementation_unadmitted"));
  assert.throws(() => buildTerminalReceipt({
    episode: { episode_id: "episode-receipt", lifecycle_state: "CAPTURE_SEALED" },
    journalDigest: "3".repeat(64),
    prelaunchReceipt: {},
    zeroProof: {},
    capture: {},
    eventsEvidence: {},
    keyId: "root-key:v3",
    key: KEY,
  }), (error) => error.code === "NATIVE_CONTAINMENT_UNAVAILABLE");
});
