// Consumer-boundary proof for terminal outbox reconciliation. The direct cases drive the real
// HTTP BusClient; the final case drives two fresh `vinci worker` processes and can be pointed at
// an unpacked/installed candidate with VINCI_TEST_WORKER_LAUNCHER.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BusClient } from "../worker/bus.mjs";
import {
  DUPLICATE_DELIVERY,
  listPending,
  recordPending,
  replayPending,
} from "../worker/outbox.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_ID = "lane-b-worker";
const POSTED_BY = `worker:${WORKER_ID}`;
const TERMINAL = Object.freeze({
  kind: "status",
  subject: "task msg_lane_b completed",
  body: "state=COMPLETED contract=wo_lane_b@01234567 attempt=msg_lane_b/1 economics_sha256=e".concat(
    "1".repeat(63),
    " evidence_uri=s3://evidence/msg_lane_b/1 evidence_sha256=",
    "a".repeat(64),
  ),
  options: {
    outcome: "COMPLETED",
    inReplyTo: "msg_lane_b",
    refs: ["job_lane_b"],
  },
  expected_posted_by: POSTED_BY,
});

function terminalRow(id, overrides = {}) {
  return {
    message_id: id,
    ts: "2026-09-13T12:00:00.000Z",
    from_agent: POSTED_BY,
    posted_by: POSTED_BY,
    to_agent: null,
    kind: TERMINAL.kind,
    subject: TERMINAL.subject,
    body: TERMINAL.body,
    outcome: TERMINAL.options.outcome,
    in_reply_to: TERMINAL.options.inReplyTo,
    refs: TERMINAL.options.refs,
    ...overrides,
  };
}

class TerminalBusFixture {
  constructor(messages = [], { authenticatedPrincipal = POSTED_BY, principalRole = "worker" } = {}) {
    this.messages = messages.slice();
    this.posts = [];
    this.nextId = 1;
    this.authenticatedPrincipal = authenticatedPrincipal;
    this.principalRole = principalRole;
    this.dropAckSubject = null;
    this.droppedAck = false;
    this.breakSecondPage = false;
    this.identityReadbackTransform = null;
    this.server = null;
    this.url = null;
    this.terminalCommitted = null;
    this.resolveTerminalCommitted = null;
  }

  async start() {
    this.terminalCommitted = new Promise((resolveCommitted) => {
      this.resolveTerminalCommitted = resolveCommitted;
    });
    this.server = createServer((request, response) => {
      const url = new URL(request.url, "http://fixture.invalid");
      if (request.method === "GET" && url.pathname === "/v1/version") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ component: "lane-b-fixture", git_sha: "f".repeat(40), dirty: false }));
        return;
      }
      if (request.headers.authorization !== "Bearer test-token") {
        response.writeHead(401);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const fromAgent = url.searchParams.get("from");
        const postedBy = url.searchParams.get("posted_by");
        const kind = url.searchParams.get("kind");
        const since = url.searchParams.get("since");
        const filtered = this.messages.filter((message) =>
          (fromAgent === null || message.from_agent === fromAgent)
          && (postedBy === null || message.posted_by === postedBy)
          && (kind === null || message.kind === kind)
          && (since === null || message.ts >= since));
        let page = this.breakSecondPage && offset > 0 ? [] : filtered.slice(offset, offset + limit);
        if (this.identityReadbackTransform !== null && fromAgent !== null && since !== null) {
          page = page.map((message) => this.identityReadbackTransform({ ...message }));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ messages: page, total: filtered.length, limit, offset }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
          const payload = JSON.parse(raw);
          if (
            this.principalRole === "worker"
            && payload.from_agent !== undefined
            && payload.from_agent !== this.authenticatedPrincipal
          ) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "from_agent must match authenticated worker principal" }));
            return;
          }
          const row = {
            message_id: `msg_server_${this.nextId++}`,
            ts: new Date().toISOString(),
            from_agent: this.principalRole === "worker" ? this.authenticatedPrincipal : payload.from_agent,
            posted_by: this.authenticatedPrincipal,
            to_agent: payload.to_agent ?? null,
            kind: payload.kind,
            subject: payload.subject ?? "",
            body: payload.body ?? "",
            outcome: payload.outcome ?? null,
            in_reply_to: payload.in_reply_to ?? null,
            refs: payload.refs ?? [],
          };
          this.messages.push(row);
          this.posts.push(row);
          if (row.subject === TERMINAL.subject) this.resolveTerminalCommitted?.(row);
          if (row.subject === this.dropAckSubject && !this.droppedAck) {
            this.droppedAck = true;
            request.socket.destroy();
            return;
          }
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ message_id: row.message_id, ts: row.ts }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolveListen) => this.server.listen(0, "127.0.0.1", resolveListen));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  async close() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((resolveClose) => this.server.close(resolveClose));
  }
}

function scratch(name) {
  return mkdtempSync(join(tmpdir(), `vinci-terminal-${name}-`));
}

function recordTerminal(dir) {
  return recordPending(TERMINAL, join(dir, "outbox"));
}

async function authenticatedBus(fixture, dir, pageSize = 100) {
  const bus = new BusClient(fixture.url, "test-token", pageSize, join(dir, "outbox"), POSTED_BY);
  await bus.establishAuthenticatedPostingPrincipal("status", `worker ${WORKER_ID} online`, "identity probe");
  return bus;
}

function terminalPostCount(fixture) {
  return fixture.posts.filter((row) => row.subject === TERMINAL.subject).length;
}

function runWorker(launcher, serverUrl, stateDir, { once = true } = {}) {
  const args = [
    "worker", "start",
    "--id", WORKER_ID,
    "--server", serverUrl,
    "--state-dir", stateDir,
    "--poll-seconds", "300",
  ];
  if (once) args.push("--once");
  const child = spawn(launcher, args, {
    env: {
      ...process.env,
      HOME: join(stateDir, "home"),
      PATH: `${dirname(launcher)}:${process.env.PATH}`,
      VINCI_BUS_TOKEN: "test-token",
      VINCI_NO_BOOTSTRAP_HEAL: "1",
      VINCI_UPDATE_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`worker did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

async function withTimeout(promise, message, timeoutMs = 15_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("same from_agent with the wrong server-stamped posted_by does not reconcile", async (t) => {
  const dir = scratch("provenance");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture([
    terminalRow("msg_forged", { from_agent: POSTED_BY, posted_by: "worker:other" }),
  ]);
  await fixture.start();
  t.after(() => fixture.close());
  recordTerminal(dir);

  const bus = await authenticatedBus(fixture, dir);
  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

  assert.equal(summary.reconciled, 0);
  assert.equal(summary.delivered, 1, "wrong authenticated provenance is cardinality zero");
  assert.equal(terminalPostCount(fixture), 1);
  assert.equal(listPending(join(dir, "outbox")).length, 0);
});

test("identity binding selects the exact acknowledged row and refuses missing stamped provenance", async (t) => {
  const dir = scratch("identity-readback");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir, 1);
  assert.equal(bus.authenticatedPostingPrincipal, POSTED_BY);

  const refusedDir = scratch("identity-missing-stamp");
  t.after(() => rmSync(refusedDir, { recursive: true, force: true }));
  const malformed = new TerminalBusFixture();
  malformed.identityReadbackTransform = (message) => {
    delete message.posted_by;
    return message;
  };
  await malformed.start();
  t.after(() => malformed.close());
  const unbound = new BusClient(malformed.url, "test-token", 1, join(refusedDir, "outbox"), POSTED_BY);

  await assert.rejects(
    () => unbound.establishAuthenticatedPostingPrincipal("status", `worker ${WORKER_ID} online`, "identity probe"),
    /malformed or filter-inconsistent/,
  );
  assert.equal(unbound.authenticatedPostingPrincipal, null);
  await assert.rejects(
    () => unbound.postTerminal("status", TERMINAL.subject, TERMINAL.body, TERMINAL.options),
    /authenticated worker posting-principal binding/,
  );
  assert.equal(listPending(join(refusedDir, "outbox")).length, 0);
  assert.equal(terminalPostCount(malformed), 0);
});

test("two exact server-stamped rows are a retained duplicate condition with no third POST", async (t) => {
  const dir = scratch("duplicate");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture([
    terminalRow("msg_exact_1"),
    terminalRow("msg_exact_2", { ts: "2026-09-13T12:00:01.000Z" }),
  ]);
  await fixture.start();
  t.after(() => fixture.close());
  recordTerminal(dir);

  const bus = await authenticatedBus(fixture, dir, 1);
  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

  assert.equal(summary.duplicate, 1);
  assert.equal(summary.conditions[0].type, DUPLICATE_DELIVERY);
  assert.equal(summary.conditions[0].exact_match_count, 2);
  assert.equal(terminalPostCount(fixture), 0, "duplicate detection must not append a third row");
  assert.equal(listPending(join(dir, "outbox"))[0].entry.delivery_condition.type, DUPLICATE_DELIVERY);
});

test("a near match and a later exact match are distinguished across complete pagination", async (t) => {
  const dir = scratch("pagination-positive");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture([
    terminalRow("msg_near_body", { body: `${TERMINAL.body} mutated` }),
    terminalRow("msg_near_subject", { subject: `${TERMINAL.subject} mutated` }),
    terminalRow("msg_near_outcome", { outcome: "FAILED" }),
    terminalRow("msg_near_reply", { in_reply_to: "msg_other_attempt" }),
    terminalRow("msg_near_refs", { refs: ["job_other"] }),
    terminalRow("msg_near_recipient", { to_agent: POSTED_BY }),
    terminalRow("msg_exact"),
  ]);
  await fixture.start();
  t.after(() => fixture.close());
  recordTerminal(dir);

  const bus = await authenticatedBus(fixture, dir, 1);
  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

  assert.equal(summary.reconciled, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(terminalPostCount(fixture), 0);
  assert.equal(listPending(join(dir, "outbox")).length, 0);
});

test("premature pagination is incomplete observation: retain pending and POST zero", async (t) => {
  const dir = scratch("pagination-fail-closed");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture([
    terminalRow("msg_near", { body: `${TERMINAL.body} mutated` }),
    terminalRow("msg_exact"),
  ]);
  fixture.breakSecondPage = true;
  await fixture.start();
  t.after(() => fixture.close());
  recordTerminal(dir);

  const bus = await authenticatedBus(fixture, dir, 1);
  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(terminalPostCount(fixture), 0);
  assert.equal(listPending(join(dir, "outbox")).length, 1);
});

for (const mismatch of [
  { name: "wrong worker", authenticatedPrincipal: "worker:other", principalRole: "worker" },
  { name: "admin", authenticatedPrincipal: "george", principalRole: "admin" },
  { name: "collector", authenticatedPrincipal: "collector:ci", principalRole: "collector" },
]) {
  test(`${mismatch.name} bearer is refused before terminal replay`, async (t) => {
    const dir = scratch(`identity-${mismatch.principalRole}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "home"), { recursive: true });
    recordTerminal(dir);
    const fixture = new TerminalBusFixture([], mismatch);
    await fixture.start();
    t.after(() => fixture.close());
    const launcher = resolve(process.env.VINCI_TEST_WORKER_LAUNCHER ?? join(ROOT, "vinci/bin/vinci"));

    const run = runWorker(launcher, fixture.url, dir);
    const exit = await waitForExit(run.child);

    assert.equal(exit.code, 1, run.stderr());
    assert.equal(terminalPostCount(fixture), 0, "identity refusal must occur before terminal replay");
    assert.equal(listPending(join(dir, "outbox")).length, 1, "identity refusal must retain terminal debt");
    if (mismatch.principalRole === "worker") {
      assert.match(run.stderr(), /from_agent must match authenticated worker principal/);
      assert.equal(fixture.posts.length, 0, "a wrong worker bearer must be rejected at POST");
    } else {
      assert.match(run.stderr(), /bearer authenticates as .*--id requires worker:lane-b-worker/);
      assert.equal(fixture.posts.length, 1, "non-worker bearer may author only the startup probe before refusal");
      assert.equal(fixture.posts[0].posted_by, mismatch.authenticatedPrincipal);
    }
  });
}

test("installed worker survives commit-then-ACK-loss and process loss without a duplicate", async (t) => {
  const dir = scratch("installed-restart");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "home"), { recursive: true });
  recordTerminal(dir);
  const fixture = new TerminalBusFixture();
  fixture.dropAckSubject = TERMINAL.subject;
  await fixture.start();
  t.after(() => fixture.close());
  const launcher = resolve(process.env.VINCI_TEST_WORKER_LAUNCHER ?? join(ROOT, "vinci/bin/vinci"));

  const first = runWorker(launcher, fixture.url, dir, { once: false });
  await withTimeout(fixture.terminalCommitted, "terminal was not committed");
  first.child.kill("SIGKILL");
  const firstExit = await waitForExit(first.child);
  assert.equal(firstExit.signal, "SIGKILL", first.stderr());
  assert.equal(listPending(join(dir, "outbox")).length, 1, "ACK loss must leave the debt durable");

  const second = runWorker(launcher, fixture.url, dir);
  const secondExit = await waitForExit(second.child);
  assert.equal(secondExit.code, 0, second.stderr());
  const terminalRows = fixture.messages.filter((row) => row.subject === TERMINAL.subject);
  assert.equal(terminalRows.length, 1, "restart must reconcile, not append a duplicate");
  assert.equal(terminalRows[0].posted_by, POSTED_BY);
  assert.equal(terminalRows[0].in_reply_to, TERMINAL.options.inReplyTo);
  assert.deepEqual(terminalRows[0].refs, TERMINAL.options.refs);
  assert.match(terminalRows[0].body, /contract=wo_lane_b@01234567/);
  assert.match(terminalRows[0].body, /attempt=msg_lane_b\/1/);
  assert.match(terminalRows[0].body, /economics_sha256=e[1]{63}/);
  assert.match(terminalRows[0].body, /evidence_sha256=a{64}/);
  assert.equal(listPending(join(dir, "outbox")).length, 0);
  assert.match(second.stderr(), /reconciled 1/);
});
