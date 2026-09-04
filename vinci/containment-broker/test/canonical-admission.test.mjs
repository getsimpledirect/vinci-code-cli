import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import {
  AdmissionRefusedError,
  authenticateReceipt,
  buildPrelaunchReceipt,
  buildTerminalReceipt,
  canonicalBytes,
  decodeCanonicalBytes,
  evaluateHostAdmission,
  NATIVE_IMPLEMENTATION_ADMITTED,
  requireNativeAdmission,
  sha256,
  validatePrelaunchAttestation,
  verifyReceipt,
} from "../src/index.mjs";

const KEY = Buffer.alloc(32, 0x43);

function historicalReceipt(payload) {
  const legacyBody = Buffer.from(
    '{"key_id":"root-key:v3","kind":"terminal","payload":{"$bytes_base64":"3q2+7w=="},"schema":"vinci.containment-broker.receipt/v3"}',
  );
  return {
    authentication: {
      algorithm: "hmac-sha256",
      mac: createHmac("sha256", KEY).update(legacyBody).digest("hex"),
    },
    body_sha256: createHash("sha256").update(legacyBody).digest("hex"),
    key_id: "root-key:v3",
    kind: "terminal",
    payload,
    schema: "vinci.containment-broker.receipt/v3",
  };
}

test("canonical values reject the historical Buffer/plain-object receipt collision", () => {
  const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  assert.throws(
    () => canonicalBytes({ payload: bytes }),
    /binary Buffer values are not canonical/,
  );
  assert.throws(
    () => canonicalBytes({ payload: { $bytes_base64: bytes.toString("base64") } }),
    /reserved canonical field: \$bytes_base64/,
  );
  assert.throws(
    () => authenticateReceipt({
      kind: "terminal",
      keyId: "root-key:v3",
      key: KEY,
      payload: { nested: [{ $bytes_base64: bytes.toString("base64") }] },
    }),
    /reserved canonical field: \$bytes_base64/,
  );

  // This is the exact v3 receipt body that the vulnerable encoder authenticated for either
  // structural input. Verification must reject the historical ambiguous representation too.
  const legacyReceipt = historicalReceipt({ $bytes_base64: "3q2+7w==" });
  assert.equal(verifyReceipt(legacyReceipt, { kind: "terminal", keyId: "root-key:v3", key: KEY }), false);
});

test("receipt verification rejects Proxy values before traps and always fails closed", () => {
  let trapCalls = 0;
  const historicalPayload = new Proxy({ $bytes_base64: "3q2+7w==" }, {
    has(target, property) {
      trapCalls += 1;
      if (property === "$bytes_base64") return false;
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      trapCalls += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      trapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assert.equal(verifyReceipt(historicalReceipt(historicalPayload), {
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
  }), false);
  assert.equal(trapCalls, 0, "Proxy traps must not participate in canonical validation");

  const nestedReceipt = authenticateReceipt({
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
    payload: { nested: { value: true } },
  });
  const nestedProxy = new Proxy({ value: true }, {
    getPrototypeOf(target) {
      trapCalls += 1;
      return Reflect.getPrototypeOf(target);
    },
  });
  assert.equal(verifyReceipt({
    ...nestedReceipt,
    payload: { nested: nestedProxy },
  }, { kind: "terminal", keyId: "root-key:v3", key: KEY }), false);

  const revocable = Proxy.revocable(structuredClone(nestedReceipt), {});
  revocable.revoke();
  assert.doesNotThrow(() => verifyReceipt(revocable.proxy, {
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
  }));
  assert.equal(verifyReceipt(revocable.proxy, { kind: "terminal", keyId: "root-key:v3", key: KEY }), false);

  const throwingAuthentication = structuredClone(nestedReceipt);
  Object.defineProperty(throwingAuthentication, "authentication", {
    enumerable: true,
    get() {
      throw new Error("authentication getter must never escape verification");
    },
  });
  assert.doesNotThrow(() => verifyReceipt(throwingAuthentication, {
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
  }));
  assert.equal(verifyReceipt(throwingAuthentication, {
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
  }), false);

  const throwingOptions = new Proxy({}, {
    get() {
      throw new Error("verification option getter must never escape");
    },
  });
  assert.doesNotThrow(() => verifyReceipt(nestedReceipt, throwingOptions));
  assert.equal(verifyReceipt(nestedReceipt, throwingOptions), false);
});

test("canonical snapshots resist descriptor, prototype, and post-validation mutation", () => {
  const target = { value: true };
  const originalPrototype = Object.getPrototypeOf(target);
  let trapCalls = 0;
  const coordinated = new Proxy(target, {
    getPrototypeOf(inner) {
      trapCalls += 1;
      Object.defineProperty(inner, "hidden", { value: true });
      Object.setPrototypeOf(inner, null);
      return null;
    },
  });
  assert.throws(() => canonicalBytes({ nested: coordinated }), /Proxy values are not canonical/);
  assert.equal(trapCalls, 0);
  assert.equal(Object.getPrototypeOf(target), originalPrototype);
  assert.equal(Object.hasOwn(target, "hidden"), false);

  const sourcePayload = { nested: { decision: "original" } };
  const receipt = authenticateReceipt({
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
    payload: sourcePayload,
  });
  sourcePayload.nested.decision = "mutated-after-authentication";
  Object.setPrototypeOf(sourcePayload.nested, null);
  assert.equal(receipt.payload.nested.decision, "original");
  assert.equal(verifyReceipt(receipt, { kind: "terminal", keyId: "root-key:v3", key: KEY }), true);
});

test("canonical numbers reject unsafe cross-language mathematical integers", () => {
  assert.equal(canonicalBytes({ value: Number.MIN_SAFE_INTEGER }).toString("utf8"), '{"value":-9007199254740991}');
  assert.equal(canonicalBytes({ value: Number.MAX_SAFE_INTEGER }).toString("utf8"), '{"value":9007199254740991}');
  assert.throws(() => canonicalBytes({ value: Number.MIN_SAFE_INTEGER - 1 }), /safe integers/);
  assert.throws(() => canonicalBytes({ value: Number.MAX_SAFE_INTEGER + 1 }), /safe integers/);
  assert.throws(() => decodeCanonicalBytes(Buffer.from('{"value":-9007199254740992}')), /unsupported or reserved/);
  assert.throws(() => decodeCanonicalBytes(Buffer.from('{"value":9007199254740992}')), /unsupported or reserved/);

  // Python and other arbitrary-precision decoders keep these integers distinct; JavaScript does not.
  const lower = JSON.parse('{"value":9007199254740992}');
  const higher = JSON.parse('{"value":9007199254740993}');
  assert.equal(lower.value, higher.value);
  assert.throws(() => decodeCanonicalBytes(Buffer.from('{"value":9007199254740993}')), /unsupported or reserved/);
});

test("canonical JSON has one stable round-trip representation", () => {
  const left = { z: 3, a: { y: true, x: "value" }, list: [null, false, 4.5] };
  const right = { list: [null, false, 4.5], a: { x: "value", y: true }, z: 3 };
  const expected = '{"a":{"x":"value","y":true},"list":[null,false,4.5],"z":3}';
  assert.equal(canonicalBytes(left).toString("utf8"), expected);
  assert.equal(canonicalBytes(right).toString("utf8"), expected);
  assert.equal(canonicalBytes(decodeCanonicalBytes(Buffer.from(expected))).toString("utf8"), expected);
  assert.notEqual(sha256(left), sha256({ ...left, z: 4 }));

  for (let index = 0; index < 128; index += 1) {
    const sample = {
      id: index,
      flags: [index % 2 === 0, null, `value-${index}`],
      nested: { quotient: index / 7, remainder: index % 7 },
    };
    const reordered = {
      nested: { remainder: index % 7, quotient: index / 7 },
      flags: [index % 2 === 0, null, `value-${index}`],
      id: index,
    };
    const bytes = canonicalBytes(sample);
    assert.equal(canonicalBytes(reordered).toString("hex"), bytes.toString("hex"));
    assert.equal(canonicalBytes(decodeCanonicalBytes(bytes)).toString("hex"), bytes.toString("hex"));
    assert.notEqual(sha256(sample), sha256({ ...sample, id: index + 1 }));
  }
});

test("canonical JSON rejects hidden, inherited, accessor, sparse, and extra structure", () => {
  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", { value: true });
  assert.throws(() => canonicalBytes(hidden), /non-enumerable canonical field/);

  const inherited = Object.create({ inherited: true });
  inherited.visible = true;
  assert.throws(() => canonicalBytes(inherited), /only plain objects/);

  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalBytes(accessor), /accessor canonical field/);

  const sparse = new Array(2);
  sparse[1] = "present";
  assert.throws(() => canonicalBytes(sparse), /dense and contain no extra fields/);

  const extra = ["value"];
  extra.label = "hidden by JSON.stringify";
  assert.throws(() => canonicalBytes(extra), /dense and contain no extra fields/);

  assert.throws(() => canonicalBytes({ [Symbol("hidden")]: true }), /symbol canonical fields/);
  assert.throws(() => canonicalBytes({ value: -0 }), /negative zero/);

  const shared = { value: true };
  assert.throws(
    () => canonicalBytes({ first: shared, duplicate: shared }),
    /duplicate object references/,
  );
  assert.throws(
    () => canonicalBytes({ nested: Object.assign(Object.create(null), { $bytes_base64: "AA==", extra: true }) }),
    /reserved canonical field/,
  );
});

test("canonical authenticated receipts reject tampering and wrong keys", () => {
  const receipt = authenticateReceipt({
    kind: "terminal",
    keyId: "root-key:v3",
    key: KEY,
    payload: { episode_id: "episode-1", decision: "SEALED/contained" },
  });
  assert.equal(receipt.body_sha256, "5240574f147b42dabfc74542702a1326b5c9f51965c89f003caba0dba9c6a636");
  assert.equal(receipt.authentication.mac, "c034b00a8d7eecd658026a61c4ed1f3c846801e42eb873241a786c75a3e56f13");
  assert.equal(verifyReceipt(receipt, { kind: "terminal", keyId: "root-key:v3", key: KEY }), true);
  const receiptBytes = canonicalBytes(receipt);
  assert.equal(verifyReceipt(receiptBytes, { kind: "terminal", keyId: "root-key:v3", key: KEY }), true);
  const duplicateSchema = Buffer.from(receiptBytes.toString("utf8").replace(
    /,"schema":("[^"]+")}$/,
    ',"schema":$1,"schema":$1}',
  ));
  assert.notEqual(duplicateSchema.toString("utf8"), receiptBytes.toString("utf8"));
  assert.equal(verifyReceipt(duplicateSchema, { kind: "terminal", keyId: "root-key:v3", key: KEY }), false);
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
