// Production bus rows: older rows carry posted_by null (pre-PR #70) and body may be null.
// One unroutable row must be skipped, never abort the poll (measured on the first live start).
import assert from "node:assert/strict";
import { normaliseMessage } from "../worker/bus.mjs";

const base = { message_id: "msg_a", ts: "2026-08-27T00:00:00Z", kind: "handoff", to_agent: "worker:x", subject: "s", body: "b", posted_by: "p" };
assert.equal(normaliseMessage(base).body, "b");
assert.equal(normaliseMessage({ ...base, posted_by: null }).posted_by, "", "null posted_by is tolerated");
assert.equal(normaliseMessage({ ...base, body: null }).body, "", "null body is tolerated");
assert.equal(normaliseMessage({ ...base, to_agent: undefined }).to_agent, null, "missing to_agent is broadcast");
assert.equal(normaliseMessage({ ...base, message_id: 7 }), null, "non-string id is unroutable");
assert.equal(normaliseMessage({ ...base, ts: "not-a-date" }), null, "bad ts is unroutable");
assert.equal(normaliseMessage({ ...base, to_agent: 5 }), null, "non-string to_agent is unroutable");
console.log("PASS worker-bus-rows: 7 assertions");
