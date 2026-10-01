// Mutation control: remove poll()'s since/kind/to searchParams lines and restart
// from offset 0 unfiltered. Assertion (a) must fail on the request count.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BusClient } from "../worker/bus.mjs";

const cursorTs = "2026-10-01T12:00:00.000Z";
const oldTs = "2026-09-01T12:00:00.000Z";
const newerTs = "2026-10-01T12:01:00.000Z";
const cursor = { ts: cursorTs, message_ids: ["msg_seen", "msg_same_new"] };
const requests = [];

function message(message_id, ts, kind = "handoff", to_agent = "worker:w1") {
  return { message_id, ts, kind, to_agent, from_agent: "scheduler", posted_by: "scheduler", subject: "task", body: "body", refs: [] };
}

const background = Array.from({ length: 993 }, (_, index) => message(
  `msg_background_${String(index).padStart(4, "0")}`,
  oldTs,
  index % 3 === 0 ? "handoff" : "status",
  index % 10 === 0 ? "worker:w1" : null,
));
const newerA = message("msg_a", newerTs);
const newerZ = message("msg_z", newerTs);
const sameSeen = message("msg_seen", cursorTs);
const sameNew = message("msg_same_new", cursorTs);
const oldHandoff = message("msg_old", oldTs);
const otherWorker = message("msg_w2", newerTs, "handoff", "worker:w2");
const broadcast = message("msg_broadcast", newerTs, "handoff", null);
let messages = [...background, newerA, newerZ, sameSeen, sameNew, oldHandoff, otherWorker, broadcast];
assert.equal(messages.length, 1000);

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  requests.push(url.search);
  if (request.headers.authorization !== "Bearer test-token") {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== "GET" || url.pathname !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }
  const params = url.searchParams;
  const to = params.get("to");
  // The bearer represents w1: the server forces its own principal even without to.
  if (to !== null && to !== "worker:w1") {
    response.writeHead(403).end();
    return;
  }
  const limit = Number(params.get("limit") ?? 50);
  const offset = Number(params.get("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
    response.writeHead(422).end();
    return;
  }
  const sinceId = params.get("since_id");
  const sinceIndex = messages.findIndex((row) => row.message_id === sinceId);
  const filtered = messages
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => (
      (row.to_agent === "worker:w1" || row.to_agent === null)
      && (params.get("from") === null || row.from_agent === params.get("from"))
      && (params.get("kind") === null || row.kind === params.get("kind"))
      && (params.get("since") === null || row.ts >= params.get("since"))
      && (sinceId === null || index > sinceIndex)
      && (params.get("until") === null || row.ts <= params.get("until"))
      && (params.get("ref") === null || row.refs.includes(params.get("ref")))
      && (params.get("posted_by") === null || row.posted_by === params.get("posted_by"))
    ))
    .sort((left, right) => right.row.ts.localeCompare(left.row.ts) || right.index - left.index)
    .map(({ row }) => row);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ messages: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const bus = new BusClient(`http://127.0.0.1:${server.address().port}`, "test-token", 100);

  // (a) Only two strictly newer handoffs; both cursor-ts ids are already seen.
  const bounded = await bus.poll("w1", cursor);
  assert.ok(requests.length <= 1, `bounded poll must issue <= 1 request; got ${requests.length}`);
  assert.equal(requests.length, 1);
  const boundedQuery = new URLSearchParams(requests[0]);
  assert.equal(boundedQuery.get("kind"), "handoff");
  assert.equal(boundedQuery.get("to"), "worker:w1");
  assert.equal(boundedQuery.get("since"), cursorTs);
  assert.equal(boundedQuery.get("limit"), "100");
  assert.equal(boundedQuery.get("offset"), "0");
  // Same-ts server insertion order is z,a; client must return id order a,z.
  assert.deepEqual(bounded, [newerA, newerZ]);

  // (b) Exactly two unread messages: one new cursor-ts id and one newer handoff.
  messages = messages.map((row) => row === newerZ ? { ...row, kind: "status" } : row);
  requests.length = 0;
  const equivalent = await bus.poll("w1", { ts: cursorTs, message_ids: [sameSeen.message_id] });
  assert.deepEqual(equivalent, [sameNew, newerA], "inclusive since must retain unseen cursor-ts ids and exclude seen ids, broadcasts, and w2");
  assert.equal(requests.length, 1);

  // (d) Null cursor has no since, includes history, and still drops broadcasts.
  requests.length = 0;
  const withoutCursor = await bus.poll("w1", null);
  const expectedWithoutCursor = messages
    .filter((row) => row.kind === "handoff" && row.to_agent === "worker:w1")
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.message_id.localeCompare(right.message_id));
  assert.deepEqual(withoutCursor, expectedWithoutCursor);
  assert.ok(withoutCursor.some((row) => row.message_id === oldHandoff.message_id));
  assert.ok(requests.length > 0);
  for (const queryString of requests) {
    const query = new URLSearchParams(queryString);
    assert.equal(query.get("kind"), "handoff");
    assert.equal(query.get("to"), "worker:w1");
    assert.equal(query.has("since"), false);
    assert.equal(query.get("limit"), "100");
  }

  // (c) Replace the fixture with 250 matching newer handoffs and 750 old rows.
  const matching = Array.from({ length: 250 }, (_, index) => message(
    `msg_page_${String(index).padStart(3, "0")}`,
    new Date(Date.parse(newerTs) + Math.floor(index / 2) * 1000).toISOString(),
  ));
  messages = [...background.slice(0, 750), ...matching];
  assert.equal(messages.length, 1000);
  requests.length = 0;
  const paged = await bus.poll("w1", cursor);
  assert.equal(requests.length, 3, "250 matching handoffs must take exactly three filtered pages");
  assert.equal(paged.length, 250);
  assert.deepEqual(paged, matching, "all filtered pages must return in ts/id order");
  assert.deepEqual(requests.map((query) => Number(new URLSearchParams(query).get("offset"))), [0, 100, 200]);
  for (const queryString of requests) {
    const query = new URLSearchParams(queryString);
    assert.equal(query.get("kind"), "handoff");
    assert.equal(query.get("to"), "worker:w1");
    assert.equal(query.get("since"), cursorTs);
    assert.equal(query.get("limit"), "100");
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("PASS worker-bus-poll-bounded: bounded requests, cursor equivalence, filtered paging, null cursor");
