// Which ledger row an evidence bundle is filed under (CCM-v0 follow-up to #49).
//
// Before this, a GOVERNED handoff posted no evidence at all: task.mjs sets `ref: undefined`
// on a contract envelope, so `isLedgerRef(ref)` was false and uploadEvidence skipped the bus.
// The economics summary was written to disk and never reached the ledger, which is the join
// the whole measurement depends on.
// WHY THESE UNIT TESTS ARE NOT REDUNDANT WITH THE INTEGRATION CONTROL.
//
// There are two gates on the evidence ref: the resolver's (`isLedgerRef` inside
// resolveEvidenceRef) and the POST's (`isLedgerRef(ref)` before the fetch). They MASK EACH
// OTHER, so no single control discriminates either one alone. Measured by mutation against
// worker-handoff-triple.mjs at this head, re-run after every change below:
//
//   widen the RESOLVER gate only  -> integration SURVIVES; these unit tests FAIL
//   widen the POST gate only      -> integration SURVIVES; these unit tests PASS
//                                    (masked: the resolver already returned null, so the
//                                     widened gate is never reached)
//   widen BOTH gates              -> integration FAILS
//
// So the integration test pins the PAIR, and the resolver's own gate is pinned ONLY here.
// Deleting these as "already covered by the integration test" would silently unpin the
// resolver gate and leave a widened POST gate undetectable by any test in the repo.
//
// The both-gates row is load-bearing and was NOT free: it holds only because the integration
// test asserts `f.rejectedPosts` is empty. Once the fake bus began enforcing the server's
// job_ref rule, a widened pair stopped producing an EXTRA accepted post (which a count
// assertion caught) and started producing a REFUSED one (which no count assertion sees).
// The measured table said FAILS while the code said SURVIVES for one commit, which is how
// the missing assertion was found. If that assertion is removed, this row reverts to
// SURVIVES and nothing in the repo detects a widened pair.

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

test("a non-ledger work order id REFUSES rather than misfiling", () => {
  // task.mjs's WORK_ORDER_ID admits ids LEDGER_REF does not (the golden vector's "wo-vec-1",
  // and every order registry in vinci-gpu-control today). Such an order must post NOTHING.
  // Falling back to the envelope ref would file the bundle under a row the economics summary
  // does not name — the summary takes contract-first unconditionally. The ledger records that
  // as an ECONOMICS_REFUSED binding:work_order_mismatch event but still stores the evidence row
  // (economics never blocks evidence), so the misfile persists. Refusal here, not misfiling.
  assert.ok(!isLedgerRef("wo-vec-1"), "test premise: wo- ids are not ledger refs");
  assert.equal(resolveEvidenceRef({ contractWorkOrderId: "wo-vec-1", envelopeRef: undefined }), null);
  assert.equal(resolveEvidenceRef({ contractWorkOrderId: "wo-vec-1", envelopeRef: "job_5" }), null,
    "a contract naming an unfilable row does not borrow another row");
  // And the gate is still not widened: nothing non-ledger ever leaves here.
  for (const id of ["wo-vec-1", "wo-example-001", "../etc", "bk", "bk_", " bk_1"]) {
    const out = resolveEvidenceRef({ contractWorkOrderId: id, envelopeRef: undefined });
    assert.ok(out === null || isLedgerRef(out), `${id} -> ${out}`);
  }
});

test("a contract id that disagrees with the summary cannot be filed under a third row", () => {
  // The summary uses contract-first unconditionally; if the resolver used anything else while
  // the contract id was present, job_ref and summary.work_order_id would disagree.
  for (const [contractId, envelopeRef] of [["bk_a", "bk_b"], ["wo-x", "bk_b"], ["bk_a", undefined]]) {
    const out = resolveEvidenceRef({ contractWorkOrderId: contractId, envelopeRef });
    assert.ok(out === null || out === contractId,
      `a present contract id must yield itself or nothing, got ${out} for ${contractId}/${envelopeRef}`);
  }
});

test("malformed input never throws and never invents a ref", () => {
  for (const input of [undefined, null, {}, { contractWorkOrderId: 7 }, { envelopeRef: [] },
    { contractWorkOrderId: "", envelopeRef: "" }, { contractWorkOrderId: "../etc", envelopeRef: undefined }]) {
    const out = resolveEvidenceRef(input);
    assert.ok(out === null || typeof out === "string", `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(resolveEvidenceRef(), null);
});
