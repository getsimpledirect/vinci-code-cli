import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const extension = await loader.import(resolve(here, "../extensions/vinci-completion-receipt.ts"), { default: false });
const verification = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });

const handlers = {};
extension.default({
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  // Keep the stub in step with what the extension registers (#10 added /verify).
  registerCommand: () => {},
  registerTool: () => {},
  appendEntry: () => {},
});
const finalize = handlers.message_end?.[0];
assert.ok(finalize, "final receipt extension must register a message_end handler");

verification.resetVinciVerificationState();
verification.recordVinciMutation();
verification.recordVinciVerification("npm run check", true, "12 tests passed");

const message = {
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "A later extension rewrote this final answer." }],
};
const finalized = await finalize({ type: "message_end", message }, {});
const text = finalized.message.content.at(-1).text;
assert.match(text, /Completed:/);
assert.match(text, /Verification passed: npm run check/);

const alreadyGrounded = {
  ...message,
  content: [{ type: "text", text: "Completed: change implemented. Verification: 12 tests passed." }],
};
assert.equal(await finalize({ type: "message_end", message: alreadyGrounded }, {}), undefined);

verification.recordVinciVerificationAttempt("npm test", "behavioral");
const incomplete = await finalize({ type: "message_end", message }, {});
assert.match(incomplete.message.content.at(-1).text, /Done — please check it:/);
assert.match(incomplete.message.content.at(-1).text, /test suite couldn't be run/i);
assert.doesNotMatch(incomplete.message.content.at(-1).text, /Verification passed:/);

const conflicting = await finalize({
  type: "message_end",
  message: {
    ...message,
    content: [{ type: "text", text: "Verification passed: npm run check. All tests passed." }],
  },
}, {});
assert.match(conflicting.message.content.at(-1).text, /Done — please check it:/);
assert.doesNotMatch(conflicting.message.content.at(-1).text, /Verification passed|tests passed/i);

verification.resetVinciVerificationState();
verification.recordVinciMutation("The change affects routing behavior.");
verification.recordVinciVerification("npm run check", true, "Static checks passed");
const staticVerifiedState = verification.getVinciVerificationState();
assert.equal(staticVerifiedState.status, "stale");
assert.equal(staticVerifiedState.verifiedRevision, staticVerifiedState.mutationRevision);
const staticVerified = await finalize({
  type: "message_end",
  message: {
    ...message,
    content: [{ type: "text", text: "Implemented the routing fix." }],
  },
}, {});
assert.match(staticVerified.message.content.at(-1).text, /Verification passed: npm run check/);

verification.resetVinciVerificationState();
verification.recordVinciMutation("The change affects routing behavior.");
const unverifiedState = verification.getVinciVerificationState();
assert.ok(unverifiedState.verifiedRevision < unverifiedState.mutationRevision);
assert.equal(await finalize({
  type: "message_end",
  message: {
    ...message,
    content: [{ type: "text", text: "Implemented the routing fix." }],
  },
}, {}), undefined);

verification.recordVinciVerification("npm run check", true, "Static checks passed");
verification.recordVinciVerification("npm run check", false, "Static checks failed");
const failedState = verification.getVinciVerificationState();
assert.equal(failedState.status, "failed");
assert.equal(failedState.verifiedRevision, failedState.mutationRevision);
assert.equal(await finalize({
  type: "message_end",
  message: {
    ...message,
    content: [{ type: "text", text: "Implemented the routing fix." }],
  },
}, {}), undefined);

// A `stale` state with an attempted-but-inconclusive behavioural check must HEDGE, not claim.
// Reporting verification that genuinely passed is the point of this change, but an attempted
// behavioural check that produced no result is material either way. When this warning was gated on
// `currentPass`, the stale path skipped it and closed with a bare "Verification passed: npm run
// check" while `npm test` had been tried and produced nothing — disclosed under one status, hidden
// under the other.
verification.resetVinciVerificationState();
verification.recordVinciMutation("The change affects routing behavior.");
verification.recordVinciVerification("npm run check", true, "Static checks passed");
verification.recordVinciVerificationAttempt("npm test", "behavioral");
const staleIncompleteState = verification.getVinciVerificationState();
assert.equal(staleIncompleteState.status, "stale");
assert.equal(staleIncompleteState.verifiedRevision, staleIncompleteState.mutationRevision);
const staleIncomplete = await finalize({
  type: "message_end",
  message: {
    ...message,
    content: [{ type: "text", text: "Implemented the routing fix." }],
  },
}, {});
const staleIncompleteText = staleIncomplete.message.content.at(-1).text;
assert.match(staleIncompleteText, /Done — please check it:/);
assert.doesNotMatch(
  staleIncompleteText,
  /Verification passed:/,
  "an inconclusive behavioural attempt must not close as a bare verification claim",
);

// Stale-owed with NO behavioural attempt must DISCLOSE the outstanding evidence. Reporting only the
// static check is literally true and under-discloses, and left a worse asymmetry than it fixed:
// attempting a behavioural check and getting no result hedged, while never attempting one produced a
// cleaner-looking bare "Verification passed". Not trying is not better than trying and failing.
verification.resetVinciVerificationState();
verification.recordVinciMutation("The change affects routing behavior.");
verification.recordVinciVerification("npm run check", true, "Static checks passed");
const staleOwedNoAttempt = await finalize({
  type: "message_end",
  message: { ...message, content: [{ type: "text", text: "Implemented the routing fix." }] },
}, {});
const staleOwedText = staleOwedNoAttempt.message.content.at(-1).text;
assert.match(staleOwedText, /Verification passed: npm run check/);
assert.match(
  staleOwedText,
  /behavioural test suite has not been run/i,
  "a stale receipt must name the evidence it is still missing, not just the check that passed",
);

// A WAITING:/BLOCKED: close must still emit NOTHING now that this guard sits under
// currentVerification rather than currentPass. The model is saying the TASK is not done; appending a
// receipt beneath that would contradict it.
verification.resetVinciVerificationState();
verification.recordVinciMutation("The change affects routing behavior.");
verification.recordVinciVerification("npm run check", true, "Static checks passed");
assert.equal(
  await finalize({
    type: "message_end",
    message: { ...message, content: [{ type: "text", text: "WAITING: need the Stripe key before finishing." }] },
  }, {}),
  undefined,
  "a WAITING/BLOCKED close must not receive a receipt even when verification is current",
);

console.log("completion-receipt-integration: 11/11 passed");
