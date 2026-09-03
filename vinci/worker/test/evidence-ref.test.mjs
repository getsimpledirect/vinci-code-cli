// Which ledger row an evidence bundle is filed under (CCM-v0 follow-up to #49).
//
// Before this, a GOVERNED handoff posted no evidence at all: task.mjs sets `ref: undefined`
// on a contract envelope, so `isLedgerRef(ref)` was false and uploadEvidence skipped the bus.
// The economics summary was written to disk and never reached the ledger, which is the join
// the whole measurement depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEvidenceRef } from "../evidence.mjs";
import { isLedgerRef } from "../bus.mjs";

test("a governed handoff files under its work order id", () => {
  assert.equal(
    resolveEvidenceRef({ contractWorkOrderId: "bk_9f2c1d", envelopeRef: undefined }),
    "bk_9f2c1d",
  );
});

test("the contract id wins over an envelope ref, and they are told apart", () => {
  // Deliberately DIFFERENT values: a fixture where both sources coincide cannot discriminate.
  assert.equal(
    resolveEvidenceRef({ contractWorkOrderId: "bk_contract", envelopeRef: "bk_envelope" }),
    "bk_contract",
  );
});

test("a prose handoff is unchanged", () => {
  assert.equal(resolveEvidenceRef({ contractWorkOrderId: null, envelopeRef: "job_17" }), "job_17");
});

test("the gate is NOT widened: a non-ledger work order id falls through", () => {
  // task.mjs's WORK_ORDER_ID admits ids LEDGER_REF does not (e.g. the golden vector's
  // "wo-vec-1"). Those must behave exactly as before — fall back, and post nothing when
  // there is nothing to fall back to.
  assert.ok(!isLedgerRef("wo-vec-1"), "test premise: wo- ids are not ledger refs");
  assert.equal(resolveEvidenceRef({ contractWorkOrderId: "wo-vec-1", envelopeRef: "job_5" }), "job_5");
  assert.equal(resolveEvidenceRef({ contractWorkOrderId: "wo-vec-1", envelopeRef: undefined }), null);
  assert.ok(!isLedgerRef(resolveEvidenceRef({ contractWorkOrderId: "wo-vec-1", envelopeRef: undefined })));
});

test("malformed input never throws and never invents a ref", () => {
  for (const input of [undefined, null, {}, { contractWorkOrderId: 7 }, { envelopeRef: [] },
    { contractWorkOrderId: "", envelopeRef: "" }, { contractWorkOrderId: "../etc", envelopeRef: undefined }]) {
    const out = resolveEvidenceRef(input);
    assert.ok(out === null || typeof out === "string", `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(resolveEvidenceRef(), null);
});
