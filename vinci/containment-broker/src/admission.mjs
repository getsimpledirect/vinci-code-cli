import { canonicalBytes, sha256 } from "./canonical.mjs";

export const FORBIDDEN_CAPABILITIES = Object.freeze([
  "CAP_SYS_ADMIN",
  "CAP_DAC_OVERRIDE",
  "CAP_SETUID",
  "CAP_SETGID",
  "CAP_SYS_PTRACE",
  "CAP_BPF",
]);

export const FORBIDDEN_FALLBACKS = Object.freeze([
  "pid",
  "pgid",
  "process_group",
  "proc",
  "pipe_eof",
  "subreaper",
  "pkill",
  "daemon_cgroup",
  "post_start_attach",
]);

export class AdmissionRefusedError extends Error {
  constructor(reasons) {
    super(`containment admission refused: ${reasons.join(", ")}`);
    this.code = "CONTAINMENT_ADMISSION_REFUSED";
    this.reasons = Object.freeze([...reasons]);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

export function evaluateHostAdmission(probe, policy) {
  const reasons = [];
  if (probe?.platform !== "linux") reasons.push("unsupported_non_linux");
  if (probe?.cgroup_version !== 2) reasons.push("cgroup_v2_required");
  if (probe?.delegated !== false) reasons.push("domain_must_be_non_delegated");
  if (probe?.post_start_placement !== false) reasons.push("post_start_placement_forbidden");
  if (probe?.controllers?.kill !== true) reasons.push("cgroup_kill_unavailable");
  if (probe?.controllers?.events !== true) reasons.push("cgroup_events_unavailable");
  if (probe?.domain?.episode_writable !== false) reasons.push("episode_writable_domain");
  if (!nonEmpty(probe?.domain?.mount_identity)) reasons.push("mount_identity_missing");
  if (probe?.descriptor_continuity !== true) reasons.push("descriptor_continuity_unproven");
  if (probe?.capture?.memfd_allow_sealing !== true) reasons.push("sealable_memfd_unavailable");
  if (probe?.capture?.required_seals !== true) reasons.push("required_memfd_seals_unavailable");
  if (!probe?.admission?.valid || !nonEmpty(probe?.admission?.identity)) reasons.push("runtime_unadmitted");
  const admissionExpiry = Date.parse(probe?.admission?.expires_at ?? "");
  if (!Number.isFinite(admissionExpiry) || admissionExpiry <= Date.now()) reasons.push("runtime_admission_expired");
  if (!["clone3_trampoline", "admitted_oci_trampoline"].includes(probe?.launch_adapter)) {
    reasons.push("launch_adapter_unadmitted");
  }
  if (!/^[0-9a-f]{64}$/.test(policy?.trampoline_binary_sha256 ?? "")) reasons.push("trampoline_binary_unadmitted");
  if (probe?.trampoline_binary_sha256 !== policy?.trampoline_binary_sha256) reasons.push("trampoline_digest_mismatch");
  if (probe?.fallback != null && probe.fallback !== "none") reasons.push("process_fallback_forbidden");
  return Object.freeze({ admitted: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function sortedUniqueStrings(value) {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length
    && value.every((entry, index) => index === 0 || value[index - 1] < entry);
}

function exactFdAllowlist(value) {
  return Array.isArray(value)
    && value.every((entry, index) => Number.isSafeInteger(entry?.fd)
      && entry.fd >= 0
      && (index === 0 || value[index - 1].fd < entry.fd)
      && nonEmpty(entry.type)
      && nonEmpty(entry.access)
      && nonEmpty(entry.flags)
      && nonEmpty(entry.identity));
}

function exactControllerObjects(value) {
  if (!value || typeof value !== "object") return false;
  const expected = ["events", "kill", "membership"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) return false;
  return expected.every((name) => {
    const entry = value[name];
    return nonEmpty(entry?.identity)
      && Number.isSafeInteger(entry?.owner_uid)
      && Number.isSafeInteger(entry?.owner_gid)
      && /^[0-7]{4}$/.test(entry?.mode ?? "")
      && /^[0-9a-f]{64}$/.test(entry?.acl_sha256 ?? "")
      && entry?.episode_writable === false
      && entry?.broker_only === true;
  });
}

function exactIngress(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry, index) => nonEmpty(entry?.id)
      && (index === 0 || value[index - 1].id < entry.id)
      && Number.isSafeInteger(entry?.max_bytes)
      && entry.max_bytes > 0
      && nonEmpty(entry?.capture_identity)
      && entry?.episode_holds_capture_writer === false);
}

export function validatePrelaunchAttestation(attestation, policy) {
  const reasons = [];
  if (!Number.isSafeInteger(attestation?.uid) || attestation.uid === 0) reasons.push("episode_uid_forbidden");
  else if (attestation.uid !== policy?.uid) reasons.push("episode_uid_mismatch");
  if (!Number.isSafeInteger(attestation?.gid) || attestation.gid === 0) reasons.push("episode_gid_invalid");
  else if (attestation.gid !== policy?.gid) reasons.push("episode_gid_mismatch");
  if (!sortedUniqueStrings(attestation?.supplementary_groups)) reasons.push("supplementary_groups_not_canonical");
  else if (attestation.supplementary_groups.includes("0")) reasons.push("root_supplementary_group_forbidden");
  else if (sha256(attestation.supplementary_groups) !== sha256(policy?.supplementary_groups ?? [])) {
    reasons.push("supplementary_groups_mismatch");
  }
  if (attestation?.no_new_privs !== true) reasons.push("no_new_privs_required");
  for (const setName of ["permitted", "effective", "inheritable", "ambient", "bounding"]) {
    const capabilities = attestation?.capabilities?.[setName];
    if (!sortedUniqueStrings(capabilities ?? [])) reasons.push(`capability_set_invalid:${setName}`);
    else if (sha256(capabilities) !== sha256(policy?.capabilities?.[setName] ?? [])) {
      reasons.push(`capability_allowlist_mismatch:${setName}`);
    }
    if ((capabilities ?? []).some((capability) => FORBIDDEN_CAPABILITIES.includes(capability))) {
      reasons.push(`forbidden_capability:${setName}`);
    }
  }
  for (const namespace of ["user", "pid", "mount", "cgroup"]) {
    if (!nonEmpty(attestation?.namespaces?.[namespace])) reasons.push(`namespace_missing:${namespace}`);
    else if (attestation.namespaces[namespace] !== policy?.namespaces?.[namespace]) {
      reasons.push(`namespace_mismatch:${namespace}`);
    }
  }
  if (attestation?.cgroup_view?.writable !== false) reasons.push("cgroup_view_writable");
  if (!nonEmpty(attestation?.cgroup_view?.identity)) reasons.push("cgroup_view_identity_missing");
  else if (attestation.cgroup_view.identity !== policy?.cgroup_view_identity) reasons.push("cgroup_view_identity_mismatch");
  if (!nonEmpty(attestation?.cgroup_mount_identity)) reasons.push("cgroup_mount_identity_missing");
  else if (attestation.cgroup_mount_identity !== policy?.cgroup_mount_identity) reasons.push("cgroup_mount_identity_mismatch");
  if (attestation?.controllers?.broker_only !== true) reasons.push("controller_permissions_unproven");
  for (const field of ["membership_identity", "kill_identity", "events_identity"]) {
    if (!nonEmpty(attestation?.controllers?.[field])) reasons.push(`controller_${field}_missing`);
    else if (attestation.controllers[field] !== policy?.controllers?.[field]) {
      reasons.push(`controller_${field}_mismatch`);
    }
  }
  if (!exactControllerObjects(attestation?.controller_objects)) reasons.push("controller_objects_invalid");
  else if (sha256(attestation.controller_objects) !== sha256(policy?.controller_objects ?? null)) {
    reasons.push("controller_objects_mismatch");
  }
  for (const field of ["seccomp_profile_identity", "lsm_profile_identity"]) {
    if (!nonEmpty(attestation?.[field]) || attestation[field] !== policy?.[field]) reasons.push(`${field}_mismatch`);
  }
  if (!exactFdAllowlist(attestation?.inherited_fds)) reasons.push("fd_allowlist_missing_or_invalid");
  else if (sha256(attestation.inherited_fds) !== sha256(policy?.inherited_fds ?? [])) reasons.push("fd_allowlist_mismatch");
  for (const field of [
    "trampoline_sha256",
    "executable_sha256",
    "loader_sha256",
    "runtime_sha256",
    "rootfs_sha256",
    "admission_sha256",
    "argv_environment_sha256",
    "broker_build_sha256",
    "package_sha256",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(attestation?.[field] ?? "") || attestation[field] !== policy?.[field]) {
      reasons.push(`${field}_mismatch`);
    }
  }
  if (!nonEmpty(attestation?.release_nonce) || attestation.release_nonce !== policy?.release_nonce) reasons.push("release_nonce_mismatch");
  for (const field of ["domain_descriptor_identity", "release_object_identity", "launch_adapter"]) {
    if (!nonEmpty(attestation?.[field]) || attestation[field] !== policy?.[field]) reasons.push(`${field}_mismatch`);
  }
  for (const field of ["boot_identity", "host_identity", "kernel_identity", "capture_descriptor_identity"]) {
    if (!nonEmpty(attestation?.[field]) || attestation[field] !== policy?.[field]) reasons.push(`${field}_mismatch`);
  }
  const admissionExpiry = Date.parse(attestation?.admission_expires_at ?? "");
  if (!Number.isFinite(admissionExpiry) || admissionExpiry <= Date.now()
    || attestation.admission_expires_at !== policy?.admission_expires_at) {
    reasons.push("admission_expiry_invalid_or_mismatch");
  }
  if (!exactIngress(attestation?.ingress)) reasons.push("ingress_invalid");
  else if (sha256(attestation.ingress) !== sha256(policy?.ingress ?? null)) reasons.push("ingress_identity_mismatch");
  if (!Number.isSafeInteger(attestation?.capture_max_bytes) || attestation.capture_max_bytes <= 0
    || attestation.capture_max_bytes !== policy?.capture_max_bytes) {
    reasons.push("capture_bound_mismatch");
  }
  if (sha256(attestation?.limits ?? null) !== sha256(policy?.limits ?? null)) reasons.push("resource_limits_mismatch");
  if (attestation?.deadline !== policy?.deadline) reasons.push("deadline_mismatch");
  if (attestation?.episode_bytes_executed !== false || attestation?.capture_bytes_written !== false) {
    reasons.push("pre_release_execution_or_capture_unproven");
  }
  if (reasons.length) throw new AdmissionRefusedError(reasons);
  return Object.freeze({
    schema: "vinci.containment-broker.prelaunch-attestation/v3",
    attestation_sha256: sha256(canonicalBytes(attestation)),
    attestation,
  });
}
