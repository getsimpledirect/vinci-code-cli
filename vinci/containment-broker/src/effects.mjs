import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { authenticateReceipt, canonicalBytes, sha256, verifyReceipt } from "./canonical.mjs";

const EFFECT_STATES = Object.freeze([
  "EFFECT_PREPARED",
  "EFFECT_SENT",
  "EFFECT_CONFIRMED",
  "EFFECT_AMBIGUOUS",
  "EFFECT_FORBIDDEN",
]);

export class EffectInvariantError extends Error {
  constructor(message, code = "EFFECT_INVALID") {
    super(message);
    this.code = code;
  }
}

function safeId(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,191}$/.test(value ?? "")) throw new EffectInvariantError(`invalid ${label}`);
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function exactEffectMechanism(idempotency, reconciliation) {
  const trueIdempotency = idempotency?.provider_guaranteed === true
    && idempotency?.immutable_operation_identity === true;
  const exactReconciliation = reconciliation?.read_only === true
    && Array.isArray(reconciliation?.exact_terminal_predicates)
    && reconciliation.exact_terminal_predicates.length > 0;
  return trueIdempotency || exactReconciliation;
}

export class EffectManager {
  #key;
  #keyId;

  static prepare({ rootDir, episodeId, authority, provider, operationClass, target, content, precondition, idempotency, reconciliation, requestBytesSha256, keyId, key, operationId = randomUUID(), now = () => new Date().toISOString() }) {
    safeId(episodeId, "episode id");
    safeId(operationId, "operation id");
    const authorityExpiry = Date.parse(authority?.expires_at ?? "");
    if (!authority?.valid || !Number.isFinite(authorityExpiry) || authorityExpiry <= Date.now()) {
      throw new EffectInvariantError("effect authority invalid", "EFFECT_AUTHORITY");
    }
    if (!provider || !operationClass || !target || !content || !precondition
      || !/^[0-9a-f]{64}$/.test(requestBytesSha256 ?? "")
      || !exactEffectMechanism(idempotency, reconciliation)) {
      throw new EffectInvariantError("effect intent is incomplete");
    }
    const rootStat = lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new EffectInvariantError("effect root must be a non-symlink directory");
    }
    const operationDir = join(rootDir, operationId);
    mkdirSync(operationDir, { mode: 0o700 });
    fsyncDirectory(rootDir);
    const sanitizedAuthority = {
      identity: authority.identity,
      claim_digest: authority.claim_digest,
      expires_at: authority.expires_at,
    };
    if (!sanitizedAuthority.identity || !sanitizedAuthority.claim_digest) {
      throw new EffectInvariantError("effect authority identity incomplete", "EFFECT_AUTHORITY");
    }
    const intent = {
      operation_id: operationId,
      episode_id: episodeId,
      authority: sanitizedAuthority,
      provider,
      operation_class: operationClass,
      target,
      target_sha256: sha256(target),
      content,
      content_sha256: sha256(content),
      precondition,
      idempotency,
      reconciliation,
      idempotency_key: operationId,
      request_bytes_sha256: requestBytesSha256,
      prepared_at: now(),
    };
    const intentReceipt = authenticateReceipt({ kind: "effect_intent", keyId, key, payload: intent });
    const intentPath = join(operationDir, "intent.json");
    writeFileSync(intentPath, canonicalBytes(intentReceipt), { flag: "wx", mode: 0o600 });
    const fd = openSync(intentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(operationDir);
    return new EffectManager({ operationDir, intent, intentReceipt, keyId, key, now });
  }

  constructor({ operationDir, intent, intentReceipt, keyId, key, now }) {
    this.operationDir = operationDir;
    this.intent = Object.freeze(intent);
    this.intentReceipt = intentReceipt;
    this.#keyId = keyId;
    this.#key = Buffer.from(key);
    this.now = now;
    this.state = "EFFECT_PREPARED";
    this.oneSendConsumed = false;
    this.sequence = 0;
    this.lastRecordDigest = null;
    this.faulted = false;
  }

  forbidBeforeSend(reason) {
    if (this.state !== "EFFECT_PREPARED" || this.oneSendConsumed) throw new EffectInvariantError("effect already exposed");
    return this.#commit("EFFECT_FORBIDDEN", { reason, mutation_exposed: false });
  }

  #authorityStillExact(currentAuthority) {
    const expiry = Date.parse(currentAuthority?.expires_at ?? "");
    return currentAuthority?.valid === true
      && currentAuthority?.identity === this.intent.authority.identity
      && currentAuthority?.claim_digest === this.intent.authority.claim_digest
      && Number.isFinite(expiry)
      && expiry > Date.now();
  }

  #localReceiptIsExact(localReceipt) {
    return verifyReceipt(localReceipt, { kind: "terminal", keyId: this.#keyId, key: this.#key })
      && localReceipt?.payload?.authority === true
      && localReceipt?.payload?.decision === "SEALED/contained"
      && localReceipt?.payload?.episode?.episode_id === this.intent.episode_id
      && localReceipt?.payload?.episode?.lifecycle_state === "CAPTURE_SEALED";
  }

  armOneSend({ currentAuthority, localReceipt }) {
    if (this.state !== "EFFECT_PREPARED" || this.oneSendConsumed) {
      throw new EffectInvariantError("effect send capability consumed", "EFFECT_RETRY_FORBIDDEN");
    }
    if (!this.#authorityStillExact(currentAuthority) || !this.#localReceiptIsExact(localReceipt)) {
      return this.forbidBeforeSend("authority_or_local_receipt_invalid");
    }
    this.oneSendConsumed = true;
    return this.#commit("EFFECT_SENT", {
      intent_receipt_sha256: this.intentReceipt.body_sha256,
      local_receipt_sha256: localReceipt.body_sha256,
      request_exposure_authorized: true,
    });
  }

  recordResponse({ confirmed, responseIdentity, operationId, targetSha256, contentSha256, currentAuthority }) {
    if (this.state !== "EFFECT_SENT") throw new EffectInvariantError("effect was not sent");
    if (!this.#authorityStillExact(currentAuthority)) {
      return this.#commit("EFFECT_AMBIGUOUS", { reason: "authority_lost_after_send" });
    }
    if (confirmed === true
      && operationId === this.intent.operation_id
      && targetSha256 === this.intent.target_sha256
      && contentSha256 === this.intent.content_sha256
      && responseIdentity) {
      return this.#confirm({
        confirmation_source: "direct_response",
        response_identity: responseIdentity,
        operation_id: operationId,
        target_sha256: targetSha256,
        content_sha256: contentSha256,
      });
    }
    return this.#commit("EFFECT_AMBIGUOUS", { reason: "response_did_not_prove_exact_effect" });
  }

  recordTransportAmbiguity(reason) {
    if (this.state !== "EFFECT_SENT") throw new EffectInvariantError("effect was not sent");
    return this.#commit("EFFECT_AMBIGUOUS", { reason });
  }

  reconciliationPlan() {
    if (this.state !== "EFFECT_AMBIGUOUS") throw new EffectInvariantError("reconciliation is ambiguity-only");
    return Object.freeze({
      mutation_allowed: false,
      operation_id: this.intent.operation_id,
      target_sha256: this.intent.target_sha256,
      content_sha256: this.intent.content_sha256,
      query: this.intent.reconciliation,
    });
  }

  confirmReconciliation(matches) {
    if (this.state !== "EFFECT_AMBIGUOUS") throw new EffectInvariantError("reconciliation is ambiguity-only");
    const observations = Array.isArray(matches) ? matches : [];
    const exact = observations.filter((match) => match?.operation_id === this.intent.operation_id
      && match?.target_sha256 === this.intent.target_sha256
      && match?.content_sha256 === this.intent.content_sha256);
    if (exact.length !== 1 || observations.length !== 1) {
      return Object.freeze({ confirmed: false, state: "EFFECT_AMBIGUOUS", receipt: null });
    }
    if (!exact[0]?.response_identity) {
      return Object.freeze({ confirmed: false, state: "EFFECT_AMBIGUOUS", receipt: null });
    }
    const receipt = this.#confirm({
      confirmation_source: "read_only_reconciliation",
      response_identity: exact[0].response_identity,
      operation_id: this.intent.operation_id,
      target_sha256: this.intent.target_sha256,
      content_sha256: this.intent.content_sha256,
      reconciliation: this.intent.reconciliation,
      exact_match: exact[0],
    });
    return Object.freeze({ confirmed: true, state: "EFFECT_CONFIRMED", match: exact[0], receipt });
  }

  assertNoRetry() {
    if (this.oneSendConsumed || ["EFFECT_SENT", "EFFECT_AMBIGUOUS", "EFFECT_CONFIRMED"].includes(this.state)) {
      throw new EffectInvariantError("mutation retry forbidden", "EFFECT_RETRY_FORBIDDEN");
    }
  }

  #commit(state, detail) {
    if (this.faulted) throw new EffectInvariantError("effect journal is faulted", "EFFECT_DURABILITY_AMBIGUOUS");
    if (!EFFECT_STATES.includes(state)) throw new EffectInvariantError("unknown effect state");
    const payload = {
      operation_id: this.intent.operation_id,
      intent_receipt_sha256: this.intentReceipt.body_sha256,
      state,
      detail,
      recorded_at: this.now(),
      predecessor_state: this.state,
      predecessor_receipt_sha256: this.lastRecordDigest,
      sequence: this.sequence + 1,
    };
    const record = authenticateReceipt({ kind: "effect_state", keyId: this.#keyId, key: this.#key, payload });
    this.sequence += 1;
    const path = join(this.operationDir, `${String(this.sequence).padStart(4, "0")}-${state}.json`);
    try {
      writeFileSync(path, canonicalBytes(record), { flag: "wx", mode: 0o600 });
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(this.operationDir);
    } catch (cause) {
      this.faulted = true;
      this.oneSendConsumed = true;
      this.state = "EFFECT_AMBIGUOUS";
      throw new EffectInvariantError(`effect durability ambiguity: ${cause.message}`, "EFFECT_DURABILITY_AMBIGUOUS");
    }
    this.lastRecordDigest = record.body_sha256;
    this.state = state;
    return Object.freeze(record);
  }

  #confirm(detail) {
    if (this.faulted) throw new EffectInvariantError("effect journal is faulted", "EFFECT_DURABILITY_AMBIGUOUS");
    const confirmation = authenticateReceipt({
      kind: "effect_confirmation",
      keyId: this.#keyId,
      key: this.#key,
      payload: {
        operation_id: this.intent.operation_id,
        original_state: this.state,
        intent_receipt_sha256: this.intentReceipt.body_sha256,
        target_sha256: this.intent.target_sha256,
        content_sha256: this.intent.content_sha256,
        idempotency_key: this.intent.idempotency_key,
        state: "EFFECT_CONFIRMED",
        predecessor_state: this.state,
        predecessor_receipt_sha256: this.lastRecordDigest,
        sequence: this.sequence + 1,
        observed_at: this.now(),
        ...detail,
        decision: "exactly_one_intended_effect_confirmed",
      },
    });
    const path = join(this.operationDir, `${String(this.sequence + 1).padStart(4, "0")}-EFFECT_CONFIRMED.json`);
    try {
      writeFileSync(path, canonicalBytes(confirmation), { flag: "wx", mode: 0o600 });
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(this.operationDir);
    } catch (cause) {
      this.faulted = true;
      this.oneSendConsumed = true;
      this.state = "EFFECT_AMBIGUOUS";
      throw new EffectInvariantError(`effect confirmation ambiguity: ${cause.message}`, "EFFECT_DURABILITY_AMBIGUOUS");
    }
    this.sequence += 1;
    this.lastRecordDigest = confirmation.body_sha256;
    this.state = "EFFECT_CONFIRMED";
    return confirmation;
  }
}

export { EFFECT_STATES };
