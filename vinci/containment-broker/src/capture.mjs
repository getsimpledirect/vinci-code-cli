import { sha256 } from "./canonical.mjs";

const REQUIRED_SEALS = Object.freeze([
  "F_SEAL_GROW",
  "F_SEAL_SEAL",
  "F_SEAL_SHRINK",
  "F_SEAL_WRITE",
]);

export class CaptureInvariantError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class BrokerCaptureModel {
  #frames = [];
  #sealedBytes = null;

  constructor({ streamIds, maxBytes }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be positive");
    if (!Array.isArray(streamIds) || streamIds.length === 0 || new Set(streamIds).size !== streamIds.length
      || streamIds.some((streamId) => typeof streamId !== "string" || streamId.length === 0)) {
      throw new TypeError("streamIds must be a non-empty unique list");
    }
    this.streamIds = Object.freeze([...streamIds]);
    this.maxBytes = maxBytes;
    this.accepting = true;
    this.generation = 0;
    this.totalBytes = 0;
    this.zeroProof = null;
    this.sealed = null;
    this.failed = false;
  }

  accept(streamId, chunk) {
    if (this.failed) throw new CaptureInvariantError("capture is absorbing failed", "CAPTURE_ABSORBING");
    if (!this.accepting) return Object.freeze({ accepted: false, reason: "ingress_closed" });
    if (!this.streamIds.includes(streamId)) this.#fail("undeclared capture stream", "CAPTURE_STREAM_UNDECLARED");
    if (!Buffer.isBuffer(chunk)) this.#fail("capture chunks must be Buffer values", "CAPTURE_BYTES_INVALID");
    if (this.totalBytes + chunk.length > this.maxBytes) {
      this.#fail("capture bound exceeded", "CAPTURE_OVERFLOW");
    }
    const bytes = Buffer.from(chunk);
    const frame = Object.freeze({
      sequence: this.#frames.length + 1,
      stream_id: streamId,
      offset: this.totalBytes,
      length: bytes.length,
      sha256: sha256(bytes),
      bytes,
    });
    this.#frames.push(frame);
    this.totalBytes += bytes.length;
    return Object.freeze({ accepted: true, sequence: frame.sequence });
  }

  closeIngress() {
    if (this.failed) throw new CaptureInvariantError("capture is absorbing failed", "CAPTURE_ABSORBING");
    if (!this.accepting) this.#fail("capture ingress already closed", "CAPTURE_CLOSE_DUPLICATE");
    this.accepting = false;
    this.generation += 1;
    return Object.freeze({
      accepting: false,
      generation: this.generation,
      frame_count: this.#frames.length,
      byte_count: this.totalBytes,
    });
  }

  recordDomainZero(proof) {
    if (this.failed) throw new CaptureInvariantError("capture is absorbing failed", "CAPTURE_ABSORBING");
    if (this.accepting) this.#fail("capture ingress must close before zero", "CAPTURE_ORDER");
    const failures = [];
    if (proof?.populated !== 0) failures.push("domain_not_zero");
    if (proof?.no_writers !== true) failures.push("writers_remain");
    if (proof?.attach_attempts !== 0) failures.push("attach_attempt_detected");
    if (proof?.transient_repopulation !== false) failures.push("transient_repopulation");
    if (proof?.descriptor_continuity !== true) failures.push("descriptor_continuity_lost");
    if (proof?.mediator_joined !== true) failures.push("mediator_not_joined");
    if (proof?.counts_durable !== true) failures.push("mediator_counts_not_durable");
    if (proof?.kill_result !== "success") failures.push("whole_domain_kill_unproven");
    if (proof?.domain_tombstoned !== true) failures.push("domain_not_tombstoned");
    if (!Number.isSafeInteger(proof?.closing_sequence)) failures.push("closing_sequence_missing");
    if (!Number.isSafeInteger(proof?.attach_audit_start)
      || !Number.isSafeInteger(proof?.attach_audit_end)
      || proof.attach_audit_end < proof.attach_audit_start) failures.push("attach_audit_incomplete");
    if (proof?.ingress_generation !== this.generation) failures.push("ingress_generation_mismatch");
    if (failures.length) this.#fail(failures.join(","), "CAPTURE_ZERO_UNPROVEN");
    this.zeroProof = Object.freeze({ ...proof });
    return this.zeroProof;
  }

  seal(proof) {
    if (this.failed) throw new CaptureInvariantError("capture is absorbing failed", "CAPTURE_ABSORBING");
    if (!this.zeroProof) this.#fail("domain zero must precede capture seal", "CAPTURE_ORDER");
    if (this.sealed) this.#fail("capture is already sealed", "CAPTURE_SEAL_DUPLICATE");
    if (proof?.capture_fsync !== true) this.#fail("capture fsync unproven", "CAPTURE_FSYNC");
    const seals = [...(proof?.seals ?? [])].sort();
    if (JSON.stringify(seals) !== JSON.stringify(REQUIRED_SEALS)) {
      this.#fail("required capture seals unproven", "CAPTURE_SEALS");
    }
    if (proof?.identity_before !== proof?.identity_after || !proof?.identity_before) {
      this.#fail("capture identity changed", "CAPTURE_IDENTITY");
    }
    const bytes = Buffer.concat(this.#frames.map((frame) => frame.bytes));
    const streamDigests = this.streamIds.map((streamId) => {
      const frames = this.#frames.filter((frame) => frame.stream_id === streamId);
      const framing = frames.map(({ bytes: _bytes, ...frame }) => frame);
      const streamBytes = Buffer.concat(frames.map((frame) => frame.bytes));
      return Object.freeze({
        stream_id: streamId,
        frame_count: frames.length,
        length: streamBytes.length,
        framing_sha256: sha256(framing),
        bytes_sha256: sha256(streamBytes),
      });
    });
    this.#sealedBytes = Buffer.from(bytes);
    this.sealed = Object.freeze({
      schema: "vinci.containment-broker.capture/v3",
      capture_identity: proof.identity_after,
      ingress_generation: this.generation,
      frame_count: this.#frames.length,
      frames: Object.freeze(this.#frames.map(({ bytes: _bytes, ...frame }) => Object.freeze(frame))),
      stream_digests: Object.freeze(streamDigests),
      length: bytes.length,
      sha256: sha256(bytes),
      seals: Object.freeze(seals),
      capture_fsync: true,
    });
    return this.sealed;
  }

  readSealedBytes() {
    if (this.failed) throw new CaptureInvariantError("capture is absorbing failed", "CAPTURE_ABSORBING");
    if (!this.sealed || !this.#sealedBytes) this.#fail("capture is not sealed", "CAPTURE_UNSEALED");
    if (sha256(this.#sealedBytes) !== this.sealed.sha256) {
      this.#fail("sealed capture memory changed", "CAPTURE_BYTES_CHANGED");
    }
    return Buffer.from(this.#sealedBytes);
  }

  #fail(message, code) {
    this.failed = true;
    this.accepting = false;
    throw new CaptureInvariantError(message, code);
  }
}

export { REQUIRED_SEALS };
