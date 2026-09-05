// Canonical evidence identity for CCM-v0 (#53 / #54, after the #295 option-1 ruling).
//
// Discriminating mutations, re-run against this file plus worker-handoff-triple.mjs:
//   - admit a raw `wo-` string without validated contract provenance -> unit failure
//   - restore the POST gate to job_/exp_/bk_ only                 -> integration failure
//   - derive the terminal ref again from envelope.ref            -> integration failure
//   - substitute a bk_ backlog identity for the WorkOrder        -> integration failure
// The integration control also requires zero server refusals on the positive path, so a client
// and fake-server widening cannot mask each other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isEvidenceRef, isLedgerRef, isWorkOrderEvidenceRef } from "../bus.mjs";
import { resolveEvidenceRef } from "../evidence.mjs";

test("the evidence namespace adds only a bounded wo- shape", () => {
  for (const ref of ["wo-a", "wo-g1-n1", `wo-${"a".repeat(125)}`]) {
    assert.equal(isWorkOrderEvidenceRef(ref), true, ref);
    assert.equal(isEvidenceRef(ref), true, ref);
    assert.equal(isLedgerRef(ref), false, `${ref} is not a legacy ledger ref`);
  }
  for (const ref of ["wo-", "wo-a/b", " wo-a", "wo-a ", `wo-${"a".repeat(126)}`, 7, null]) {
    assert.equal(isWorkOrderEvidenceRef(ref), false, JSON.stringify(ref));
  }
});

test("a governed handoff files under its validated WorkOrder", () => {
  assert.equal(
    resolveEvidenceRef({
      contractWorkOrderId: "wo-g1-n1",
      contractValidated: true,
      envelopeRef: undefined,
    }),
    "wo-g1-n1",
  );
  // Existing caller-supplied WorkOrder ids remain valid when the validated record really uses
  // that id; this is not a backlog substitution because the value comes from the contract.
  assert.equal(
    resolveEvidenceRef({ contractWorkOrderId: "bk_contract", contractValidated: true }),
    "bk_contract",
  );
});

test("a raw wo- string has no authority without validated contract provenance", () => {
  for (const contractValidated of [undefined, false, null, "true", 1]) {
    assert.equal(
      resolveEvidenceRef({
        contractWorkOrderId: "wo-g1-n1",
        contractValidated,
        envelopeRef: "bk_fallback",
      }),
      null,
      String(contractValidated),
    );
  }
});

test("a present contract identity yields itself or nothing, never a third row", () => {
  for (const [contractWorkOrderId, envelopeRef, expected] of [
    ["wo-g1-n1", "bk_backlog", "wo-g1-n1"],
    ["bk_actual_work_order", "bk_backlog", "bk_actual_work_order"],
    ["caller-id", "bk_backlog", null],
    ["wo-", "bk_backlog", null],
    [7, "bk_backlog", null],
    [null, "bk_backlog", null],
  ]) {
    assert.equal(
      resolveEvidenceRef({ contractWorkOrderId, contractValidated: true, envelopeRef }),
      expected,
      `${JSON.stringify(contractWorkOrderId)} / ${envelopeRef}`,
    );
  }
});

test("prose handoffs stay on the legacy namespace and cannot spell a wo- bypass", () => {
  for (const ref of ["job_17", "exp_run", "bk_row"]) {
    assert.equal(resolveEvidenceRef({ envelopeRef: ref }), ref);
  }
  for (const ref of ["wo-g1-n1", "caller-id", "bk_", " bk_1", "", [], 7]) {
    assert.equal(resolveEvidenceRef({ envelopeRef: ref }), null, JSON.stringify(ref));
  }
});

test("missing and malformed inputs never throw or invent a ref", () => {
  for (const input of [
    undefined,
    null,
    {},
    [],
    { contractWorkOrderId: undefined, envelopeRef: undefined },
    { contractWorkOrderId: "../etc", contractValidated: true },
    { contractValidated: true, envelopeRef: "job_fallback" },
  ]) {
    assert.equal(resolveEvidenceRef(input), null, JSON.stringify(input));
  }
});
