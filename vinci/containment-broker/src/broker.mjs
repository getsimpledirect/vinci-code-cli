import { authenticateReceipt, sha256, verifyReceipt } from "./canonical.mjs";
import { AdmissionRefusedError, evaluateHostAdmission, validatePrelaunchAttestation } from "./admission.mjs";
import { REQUIRED_SEALS } from "./capture.mjs";

export class NativeContainmentUnavailableError extends Error {
  constructor(reasons) {
    super(`native containment unavailable: ${reasons.join(", ")}`);
    this.code = "NATIVE_CONTAINMENT_UNAVAILABLE";
    this.reasons = Object.freeze([...reasons]);
  }
}

export const NATIVE_IMPLEMENTATION_ADMITTED = false;

function refuseUnadmittedNativeReceipt() {
  if (!NATIVE_IMPLEMENTATION_ADMITTED) {
    throw new NativeContainmentUnavailableError(["native_implementation_unadmitted"]);
  }
}

export function requireNativeAdmission({ probe, policy, nativeAdapter }) {
  const evaluated = evaluateHostAdmission(probe, policy);
  const reasons = [...evaluated.reasons];
  if (!NATIVE_IMPLEMENTATION_ADMITTED) reasons.push("native_implementation_unadmitted");
  if (nativeAdapter?.schema !== "vinci.containment-broker.native-adapter/v3") reasons.push("native_adapter_unavailable");
  if (nativeAdapter?.binary_sha256 !== policy?.trampoline_binary_sha256) reasons.push("native_adapter_digest_mismatch");
  if (nativeAdapter?.real_linux_admission_receipt_verified !== true) reasons.push("real_linux_admission_unverified");
  if (reasons.length) throw new NativeContainmentUnavailableError(reasons);
  return Object.freeze({ admitted: true, adapter: nativeAdapter, host: probe });
}

export function buildPrelaunchReceipt({ attestation, policy, episode, journalDigest, keyId, key }) {
  refuseUnadmittedNativeReceipt();
  const validated = validatePrelaunchAttestation(attestation, policy);
  if (!episode?.episode_id || !episode?.domain_identity || episode?.lifecycle_state !== "TASK_CREATED"
    || !/^[0-9a-f]{64}$/.test(journalDigest ?? "")) {
    throw new AdmissionRefusedError(["episode_or_journal_identity_missing"]);
  }
  return authenticateReceipt({
    kind: "prelaunch",
    keyId,
    key,
    payload: {
      episode,
      journal_digest: journalDigest,
      attestation: validated,
      release_barrier: {
        fixed_trampoline: true,
        one_shot: true,
        nonce_sha256: sha256(policy.release_nonce),
        episode_bytes_executed: false,
      },
    },
  });
}

export function buildTerminalReceipt({ episode, journalDigest, prelaunchReceipt, zeroProof, capture, eventsEvidence, keyId, key }) {
  refuseUnadmittedNativeReceipt();
  if (!episode?.episode_id || episode?.lifecycle_state !== "CAPTURE_SEALED"
    || !/^[0-9a-f]{64}$/.test(journalDigest ?? "") || !prelaunchReceipt?.body_sha256) {
    throw new TypeError("terminal receipt identity incomplete");
  }
  if (!verifyReceipt(prelaunchReceipt, { kind: "prelaunch", keyId, key })) {
    throw new TypeError("prelaunch receipt authentication invalid");
  }
  if (zeroProof?.populated !== 0 || zeroProof?.no_writers !== true || zeroProof?.attach_attempts !== 0
    || zeroProof?.transient_repopulation !== false || zeroProof?.descriptor_continuity !== true
    || zeroProof?.kill_result !== "success" || zeroProof?.domain_tombstoned !== true
    || !Number.isSafeInteger(zeroProof?.closing_sequence)
    || !Number.isSafeInteger(zeroProof?.attach_audit_start)
    || !Number.isSafeInteger(zeroProof?.attach_audit_end)
    || zeroProof.attach_audit_end < zeroProof.attach_audit_start) {
    throw new TypeError("terminal zero proof incomplete");
  }
  if (!capture?.capture_fsync || !/^[0-9a-f]{64}$/.test(capture?.sha256 ?? "")
    || JSON.stringify([...(capture?.seals ?? [])].sort()) !== JSON.stringify(REQUIRED_SEALS)) {
    throw new TypeError("sealed capture proof incomplete");
  }
  if (!/^[0-9a-f]{64}$/.test(eventsEvidence?.bytes_sha256 ?? "")
    || !Array.isArray(eventsEvidence?.samples) || eventsEvidence.samples.length === 0
    || eventsEvidence.samples.some((sample) => sample?.populated !== 0)) {
    throw new TypeError("cgroup events evidence incomplete");
  }
  return authenticateReceipt({
    kind: "terminal",
    keyId,
    key,
    payload: {
      decision: "SEALED/contained",
      episode,
      journal_digest: journalDigest,
      prelaunch_receipt_sha256: prelaunchReceipt.body_sha256,
      zero_proof: zeroProof,
      events_evidence: eventsEvidence,
      capture: {
        identity: capture.capture_identity,
        ingress_generation: capture.ingress_generation,
        frame_count: capture.frame_count,
        frames: capture.frames,
        stream_digests: capture.stream_digests,
        length: capture.length,
        sha256: capture.sha256,
        seals: capture.seals,
        fsync: capture.capture_fsync,
      },
      authority: true,
    },
  });
}
