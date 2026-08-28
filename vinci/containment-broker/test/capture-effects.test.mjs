import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BrokerCaptureModel,
  CaptureInvariantError,
  EffectManager,
  REQUIRED_SEALS,
  authenticateReceipt,
  verifyReceipt,
} from "../src/index.mjs";

const EFFECT_KEY = Buffer.alloc(32, 0x45);
const CURRENT_AUTHORITY = {
  valid: true,
  identity: "claim-1",
  claim_digest: "c".repeat(64),
  expires_at: "2999-01-01T00:00:00Z",
};

function effectRoot() {
  const root = mkdtempSync(join(tmpdir(), "vinci-broker-effects-"));
  mkdirSync(join(root, "effects"));
  return join(root, "effects");
}

test("capture closes ingress before zero and late writes never alter sealed bytes", () => {
  const capture = new BrokerCaptureModel({ streamIds: ["stdout", "artifact"], maxBytes: 128 });
  capture.accept("stdout", Buffer.from("hello"));
  capture.accept("artifact", Buffer.from("bytes"));
  const close = capture.closeIngress();
  assert.equal(close.byte_count, 10);
  assert.deepEqual(capture.accept("stdout", Buffer.from("late")), { accepted: false, reason: "ingress_closed" });
  capture.recordDomainZero({
    populated: 0,
    no_writers: true,
    attach_attempts: 0,
    transient_repopulation: false,
    descriptor_continuity: true,
    mediator_joined: true,
    counts_durable: true,
    ingress_generation: 1,
    kill_result: "success",
    domain_tombstoned: true,
    closing_sequence: 8,
    attach_audit_start: 100,
    attach_audit_end: 100,
  });
  const sealed = capture.seal({
    capture_fsync: true,
    seals: REQUIRED_SEALS,
    identity_before: "memfd:dev:ino:1",
    identity_after: "memfd:dev:ino:1",
  });
  const returned = capture.readSealedBytes();
  assert.equal(returned.toString(), "hellobytes");
  returned.fill(0);
  assert.equal(capture.readSealedBytes().toString(), "hellobytes");
  assert.equal(sealed.length, 10);
  assert.match(sealed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(sealed.stream_digests.length, 2);
  assert.equal(sealed.stream_digests[0].stream_id, "stdout");
  assert.match(sealed.stream_digests[0].framing_sha256, /^[0-9a-f]{64}$/);
});

test("retained writers, repopulation, missing fsync or any missing seal fail closed", () => {
  for (const proof of [
    { populated: 0, no_writers: false, attach_attempts: 0, transient_repopulation: false, descriptor_continuity: true, mediator_joined: true, counts_durable: true, ingress_generation: 1, kill_result: "success", domain_tombstoned: true, closing_sequence: 8, attach_audit_start: 100, attach_audit_end: 100 },
    { populated: 0, no_writers: true, attach_attempts: 1, transient_repopulation: false, descriptor_continuity: true, mediator_joined: true, counts_durable: true, ingress_generation: 1, kill_result: "success", domain_tombstoned: true, closing_sequence: 8, attach_audit_start: 100, attach_audit_end: 101 },
    { populated: 0, no_writers: true, attach_attempts: 0, transient_repopulation: true, descriptor_continuity: true, mediator_joined: true, counts_durable: true, ingress_generation: 1, kill_result: "success", domain_tombstoned: true, closing_sequence: 8, attach_audit_start: 100, attach_audit_end: 100 },
  ]) {
    const capture = new BrokerCaptureModel({ streamIds: ["stdout"], maxBytes: 8 });
    capture.closeIngress();
    assert.throws(() => capture.recordDomainZero(proof), CaptureInvariantError);
  }
  const capture = new BrokerCaptureModel({ streamIds: ["stdout"], maxBytes: 8 });
  capture.closeIngress();
  capture.recordDomainZero({
    populated: 0,
    no_writers: true,
    attach_attempts: 0,
    transient_repopulation: false,
    descriptor_continuity: true,
    mediator_joined: true,
    counts_durable: true,
    ingress_generation: 1,
    kill_result: "success",
    domain_tombstoned: true,
    closing_sequence: 8,
    attach_audit_start: 100,
    attach_audit_end: 100,
  });
  assert.throws(() => capture.seal({
    capture_fsync: false,
    seals: REQUIRED_SEALS,
    identity_before: "id",
    identity_after: "id",
  }), (error) => error.code === "CAPTURE_FSYNC");

  const missingSeal = new BrokerCaptureModel({ streamIds: ["stdout"], maxBytes: 8 });
  missingSeal.closeIngress();
  missingSeal.recordDomainZero({
    populated: 0,
    no_writers: true,
    attach_attempts: 0,
    transient_repopulation: false,
    descriptor_continuity: true,
    mediator_joined: true,
    counts_durable: true,
    ingress_generation: 1,
    kill_result: "success",
    domain_tombstoned: true,
    closing_sequence: 8,
    attach_audit_start: 100,
    attach_audit_end: 100,
  });
  assert.throws(() => missingSeal.seal({
    capture_fsync: true,
    seals: REQUIRED_SEALS.slice(1),
    identity_before: "id",
    identity_after: "id",
  }), (error) => error.code === "CAPTURE_SEALS");

  const overflow = new BrokerCaptureModel({ streamIds: ["stdout"], maxBytes: 2 });
  assert.throws(() => overflow.accept("stdout", Buffer.from("too long")), (error) => error.code === "CAPTURE_OVERFLOW");
  assert.throws(() => overflow.accept("stdout", Buffer.from("x")), (error) => error.code === "CAPTURE_ABSORBING");
});

function preparedEffect() {
  return EffectManager.prepare({
    rootDir: effectRoot(),
    episodeId: "episode-effect",
    operationId: `operation-${Math.random().toString(16).slice(2)}`,
    authority: CURRENT_AUTHORITY,
    provider: "test-provider",
    operationClass: "conditional-put",
    target: { bucket: "bucket", key: "object" },
    content: { sha256: "a".repeat(64), bytes: 4 },
    precondition: { absent: true },
    idempotency: { provider_guaranteed: false, immutable_operation_identity: false },
    reconciliation: { method: "HEAD", target: "bucket/object", read_only: true, exact_terminal_predicates: ["one exact target/content/operation match"] },
    requestBytesSha256: "9".repeat(64),
    keyId: "root-effect-key:v3",
    key: EFFECT_KEY,
  });
}

function terminalReceipt() {
  return authenticateReceipt({
    kind: "terminal",
    keyId: "root-effect-key:v3",
    key: EFFECT_KEY,
    payload: {
      authority: true,
      decision: "SEALED/contained",
      episode: { episode_id: "episode-effect", lifecycle_state: "CAPTURE_SEALED" },
    },
  });
}

test("remote effect ambiguity is separate and permanently bans mutation retry", () => {
  const effect = preparedEffect();
  assert.equal(verifyReceipt(effect.intentReceipt, {
    kind: "effect_intent",
    keyId: "root-effect-key:v3",
    key: EFFECT_KEY,
  }), true);
  effect.armOneSend({ currentAuthority: CURRENT_AUTHORITY, localReceipt: terminalReceipt() });
  effect.recordTransportAmbiguity("response_lost");
  assert.equal(effect.state, "EFFECT_AMBIGUOUS");
  assert.equal(effect.reconciliationPlan().mutation_allowed, false);
  assert.throws(
    () => effect.armOneSend({ currentAuthority: CURRENT_AUTHORITY, localReceipt: terminalReceipt() }),
    (error) => error.code === "EFFECT_RETRY_FORBIDDEN",
  );
  assert.deepEqual(effect.confirmReconciliation([]), { confirmed: false, state: "EFFECT_AMBIGUOUS", receipt: null });
});

test("authority identity and expiry are revalidated immediately before the only send", () => {
  const effect = preparedEffect();
  const forbidden = effect.armOneSend({
    currentAuthority: { ...CURRENT_AUTHORITY, identity: "claim-other" },
    localReceipt: terminalReceipt(),
  });
  assert.equal(forbidden.payload.state, "EFFECT_FORBIDDEN");
  assert.equal(effect.state, "EFFECT_FORBIDDEN");
  assert.equal(effect.oneSendConsumed, false);
  assert.throws(() => effect.armOneSend({
    currentAuthority: CURRENT_AUTHORITY,
    localReceipt: terminalReceipt(),
  }));

  const wrongLocalReceipt = preparedEffect();
  const otherEpisode = authenticateReceipt({
    kind: "terminal",
    keyId: "root-effect-key:v3",
    key: EFFECT_KEY,
    payload: {
      authority: true,
      decision: "SEALED/contained",
      episode: { episode_id: "episode-other", lifecycle_state: "CAPTURE_SEALED" },
    },
  });
  const wrongReceiptResult = wrongLocalReceipt.armOneSend({
    currentAuthority: CURRENT_AUTHORITY,
    localReceipt: otherEpisode,
  });
  assert.equal(wrongReceiptResult.payload.state, "EFFECT_FORBIDDEN");
});

test("an invalid authority expiry cannot create a durable effect intent", () => {
  assert.throws(() => EffectManager.prepare({
    rootDir: effectRoot(),
    episodeId: "episode-effect",
    operationId: "operation-invalid-expiry",
    authority: { ...CURRENT_AUTHORITY, expires_at: "not-a-time" },
    provider: "test-provider",
    operationClass: "conditional-put",
    target: { bucket: "bucket", key: "object" },
    content: { sha256: "a".repeat(64), bytes: 4 },
    precondition: { absent: true },
    idempotency: { provider_guaranteed: false, immutable_operation_identity: false },
    reconciliation: { method: "HEAD", target: "bucket/object", read_only: true, exact_terminal_predicates: ["one exact target/content/operation match"] },
    requestBytesSha256: "9".repeat(64),
    keyId: "root-effect-key:v3",
    key: EFFECT_KEY,
  }), (error) => error.code === "EFFECT_AUTHORITY");
});

test("exactly one target/content/operation match can reconcile without a retry", () => {
  const effect = preparedEffect();
  effect.armOneSend({ currentAuthority: CURRENT_AUTHORITY, localReceipt: terminalReceipt() });
  effect.recordTransportAmbiguity("response_lost_after_commit");
  const plan = effect.reconciliationPlan();
  const confirmation = effect.confirmReconciliation([{
    operation_id: plan.operation_id,
    target_sha256: plan.target_sha256,
    content_sha256: plan.content_sha256,
    response_identity: "provider-operation:1",
  }]);
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.receipt.kind, "effect_confirmation");
  assert.equal(effect.state, "EFFECT_CONFIRMED");
  assert.equal(verifyReceipt(confirmation.receipt, {
    kind: "effect_confirmation",
    keyId: "root-effect-key:v3",
    key: EFFECT_KEY,
  }), true);
});

test("a remote response confirms only the exact operation, target and content identities", () => {
  const mismatch = preparedEffect();
  mismatch.armOneSend({ currentAuthority: CURRENT_AUTHORITY, localReceipt: terminalReceipt() });
  mismatch.recordResponse({
    confirmed: true,
    responseIdentity: "response-1",
    operationId: mismatch.intent.operation_id,
    targetSha256: mismatch.intent.target_sha256,
    contentSha256: "0".repeat(64),
    currentAuthority: CURRENT_AUTHORITY,
  });
  assert.equal(mismatch.state, "EFFECT_AMBIGUOUS");

  const exact = preparedEffect();
  exact.armOneSend({ currentAuthority: CURRENT_AUTHORITY, localReceipt: terminalReceipt() });
  const receipt = exact.recordResponse({
    confirmed: true,
    responseIdentity: "response-2",
    operationId: exact.intent.operation_id,
    targetSha256: exact.intent.target_sha256,
    contentSha256: exact.intent.content_sha256,
    currentAuthority: CURRENT_AUTHORITY,
  });
  assert.equal(exact.state, "EFFECT_CONFIRMED");
  assert.equal(receipt.kind, "effect_confirmation");
});

test("authority loss immediately after send is durable ambiguity, never remote success", () => {
  const effect = preparedEffect();
  effect.armOneSend({ currentAuthority: CURRENT_AUTHORITY, localReceipt: terminalReceipt() });
  const receipt = effect.recordResponse({
    confirmed: true,
    responseIdentity: "response-after-expiry",
    operationId: effect.intent.operation_id,
    targetSha256: effect.intent.target_sha256,
    contentSha256: effect.intent.content_sha256,
    currentAuthority: { ...CURRENT_AUTHORITY, valid: false },
  });
  assert.equal(receipt.payload.state, "EFFECT_AMBIGUOUS");
  assert.equal(effect.state, "EFFECT_AMBIGUOUS");
});
