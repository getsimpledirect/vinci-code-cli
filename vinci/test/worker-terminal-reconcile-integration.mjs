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

import { BusClient, WorkerIdentityRefusal } from "../worker/bus.mjs";
import {
  DUPLICATE_DELIVERY,
  listPending,
  recordPending,
  replayPending,
} from "../worker/outbox.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_ID = "lane-b-worker";
const POSTED_BY = `worker:${WORKER_ID}`;
const EXPECTED_WORKER_HEADER = "x-vgc-expected-worker-principal";
const SERVER_STRIP_EDGE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
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
  configured_worker_principal: POSTED_BY,
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

function serverStrip(value) {
  return value.replace(SERVER_STRIP_EDGE, "");
}

class TerminalBusFixture {
  constructor(messages = [], {
    authenticatedPrincipal = POSTED_BY,
    principalRole = "worker",
    postAuthenticatedPrincipal = authenticatedPrincipal,
    postPrincipalRole = principalRole,
    forcedBoundRefusalStatus = null,
  } = {}) {
    this.messages = messages.slice();
    this.posts = [];
    this.nextId = 1;
    this.authenticatedPrincipal = authenticatedPrincipal;
    this.principalRole = principalRole;
    this.postAuthenticatedPrincipal = postAuthenticatedPrincipal;
    this.postPrincipalRole = postPrincipalRole;
    this.forcedBoundRefusalStatus = forcedBoundRefusalStatus;
    this.identityStatus = principalRole === "worker" ? 200 : 403;
    this.identityPayload = { worker_principal: authenticatedPrincipal };
    this.identityRaw = null;
    this.identityDelayMs = 0;
    this.identityRequests = 0;
    this.identityRequestUrls = [];
    this.messageGetRequests = 0;
    this.messagePostRequests = [];
    this.dropAckSubject = null;
    this.droppedAck = false;
    this.breakSecondPage = false;
    this.identityReadbackTransform = null;
    this.terminalReadbackTransform = null;
    this.afterMessageGet = null;
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
      if (request.method === "GET" && url.pathname === "/v1/worker-principal") {
        this.identityRequests += 1;
        this.identityRequestUrls.push(request.url);
        const sendIdentity = () => {
          response.writeHead(this.identityStatus, { "content-type": "application/json" });
          response.end(this.identityRaw ?? JSON.stringify(this.identityPayload));
        };
        if (this.identityDelayMs > 0) setTimeout(sendIdentity, this.identityDelayMs);
        else sendIdentity();
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        this.messageGetRequests += 1;
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
        if (this.terminalReadbackTransform !== null && postedBy !== null && kind !== null) {
          page = page.map((message) => this.terminalReadbackTransform({ ...message }));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ messages: page, total: filtered.length, limit, offset }));
        this.afterMessageGet?.();
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
          const payload = JSON.parse(raw);
          const expectedHeaders = [];
          for (let index = 0; index < request.rawHeaders.length; index += 2) {
            if (request.rawHeaders[index].toLowerCase() === EXPECTED_WORKER_HEADER) {
              expectedHeaders.push(request.rawHeaders[index + 1]);
            }
          }
          this.messagePostRequests.push({ expectedHeaders, payload });
          if (
            expectedHeaders.length > 0
            && (
              expectedHeaders.length !== 1
              || !/^worker:[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/.test(expectedHeaders[0])
            )
          ) {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "expected worker principal must be supplied exactly once" }));
            return;
          }
          if (expectedHeaders.length === 1 && this.forcedBoundRefusalStatus !== null) {
            response.writeHead(this.forcedBoundRefusalStatus, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "forced bound publication refusal" }));
            return;
          }
          if (
            expectedHeaders.length === 1
            && (
              this.postPrincipalRole !== "worker"
              || this.postAuthenticatedPrincipal !== expectedHeaders[0]
            )
          ) {
            const status = this.postPrincipalRole === "ambiguous" ? 403 : 412;
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "authenticated POST principal does not satisfy expected worker" }));
            return;
          }
          if (typeof payload.subject !== "string" || serverStrip(payload.subject).length === 0) {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "subject must be a non-empty string" }));
            return;
          }
          const storedSubject = serverStrip(payload.subject);
          if ([...storedSubject].length > 200) {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "subject must be <= 200 characters" }));
            return;
          }
          if (payload.body !== null && payload.body !== undefined && typeof payload.body !== "string") {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "body must be a string" }));
            return;
          }
          if (typeof payload.body === "string" && payload.body.length > 0 && [...payload.body].length > 8_000) {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ detail: "body must be <= 8000 characters" }));
            return;
          }
          const storedBody = typeof payload.body === "string" ? serverStrip(payload.body) || null : null;
          const row = {
            message_id: `msg_server_${this.nextId++}`,
            ts: new Date().toISOString(),
            from_agent: this.postPrincipalRole === "worker" ? this.postAuthenticatedPrincipal : payload.from_agent,
            posted_by: this.postAuthenticatedPrincipal,
            posted_role: this.postPrincipalRole === "worker" ? "worker" : null,
            to_agent: payload.to_agent ?? null,
            kind: payload.kind,
            subject: storedSubject,
            body: storedBody,
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
  await bus.establishAuthenticatedPostingPrincipal();
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

test("identity binding comes from the worker-only server endpoint without a publication probe", async (t) => {
  const dir = scratch("identity-readback");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir, 1);
  assert.equal(bus.authenticatedPostingPrincipal, POSTED_BY);
  assert.equal(fixture.identityRequests, 1);
  assert.deepEqual(fixture.identityRequestUrls, ["/v1/worker-principal"]);
  assert.equal(fixture.posts.length, 0, "identity resolution itself must be side-effect free");
});

test("every bound worker POST carries the exact configured atomic precondition", async (t) => {
  const dir = scratch("bound-post-header");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

  await bus.post("status", "bound non-terminal status", "still running");

  assert.equal(fixture.identityRequests, 0, "the POST precondition is not derived from identity discovery");
  assert.equal(fixture.posts.length, 1);
  assert.deepEqual(fixture.messagePostRequests[0].expectedHeaders, [POSTED_BY]);
  assert.equal(fixture.messagePostRequests[0].payload.from_agent, undefined);
  assert.equal(fixture.messagePostRequests[0].payload.posted_by, undefined);
  assert.equal(fixture.posts[0].posted_by, POSTED_BY, "the server stamps publication identity");
});

test("TOCTOU identity discovery cannot authorize a differently authenticated terminal POST", async (t) => {
  const dir = scratch("atomic-toctou");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture([], {
    authenticatedPrincipal: POSTED_BY,
    principalRole: "worker",
    postAuthenticatedPrincipal: "george",
    postPrincipalRole: "admin",
  });
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir);

  await assert.rejects(
    () => bus.postTerminal("status", TERMINAL.subject, TERMINAL.body, TERMINAL.options),
    (error) => error instanceof WorkerIdentityRefusal
      && error.code === "worker_publication_precondition_refused"
      && /failed: 412/.test(error.message),
  );

  assert.equal(fixture.identityRequests, 2, "both discovery reads still report the claimed worker");
  assert.equal(fixture.messagePostRequests.length, 1, "there is no unbound downgrade retry");
  assert.deepEqual(fixture.messagePostRequests[0].expectedHeaders, [POSTED_BY]);
  assert.equal(fixture.posts.length, 0, "the server-style guard refuses before row insertion");
  assert.equal(fixture.messages.length, 0);
  assert.equal(listPending(join(dir, "outbox")).length, 1, "refusal retains terminal evidence");
});

for (const variant of [
  { name: "body with trailing newline", subject: TERMINAL.subject, body: `${TERMINAL.body}\n`, storedBody: TERMINAL.body },
  { name: "subject with surrounding server whitespace", subject: `\u0085 ${TERMINAL.subject} \u001c`, body: TERMINAL.body, storedBody: TERMINAL.body },
  { name: "whitespace-only body stored as null", subject: TERMINAL.subject, body: " \n\u0085", storedBody: null },
]) {
  test(`ACK loss reconciles the canonical server row for ${variant.name}`, async (t) => {
    const dir = scratch(`canonical-${variant.name.replaceAll(" ", "-")}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = new TerminalBusFixture();
    fixture.dropAckSubject = serverStrip(variant.subject);
    await fixture.start();
    t.after(() => fixture.close());
    const beforeCrash = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

    await assert.rejects(
      () => beforeCrash.postTerminal("status", variant.subject, variant.body, TERMINAL.options),
      /fetch failed/,
    );
    assert.equal(fixture.posts.length, 1, "the first bound POST committed before its ACK was lost");
    assert.equal(fixture.posts[0].subject, TERMINAL.subject);
    assert.equal(fixture.posts[0].body, variant.storedBody);
    assert.equal(fixture.posts[0].posted_by, POSTED_BY);
    assert.equal(listPending(join(dir, "outbox")).length, 1);

    const restarted = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);
    const summary = await replayPending(restarted, join(dir, "outbox"), { warn() {}, error() {} });
    const terminalRequests = fixture.messagePostRequests.filter(({ payload }) =>
      serverStrip(payload.subject) === TERMINAL.subject);

    assert.equal(summary.reconciled, 1);
    assert.equal(summary.delivered, 0);
    assert.equal(terminalRequests.length, 1, "canonical reconciliation must not append a duplicate");
    assert.equal(fixture.posts.length, 1);
    assert.equal(listPending(join(dir, "outbox")).length, 0);
  });
}

for (const malformedBody of [123, true, { unexpected: "object" }, ["unexpected array"]]) {
  test(`malformed terminal reconciliation body ${JSON.stringify(malformedBody)} cannot erase pending evidence`, async (t) => {
    const dir = scratch("malformed-body");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = new TerminalBusFixture([
      terminalRow("msg_different_body", { body: "DIFFERENT NONEMPTY BODY" }),
    ]);
    fixture.terminalReadbackTransform = (message) => ({ ...message, body: malformedBody });
    await fixture.start();
    t.after(() => fixture.close());
    recordPending({ ...TERMINAL, body: " \n\u0085" }, join(dir, "outbox"));
    const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

    const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

    assert.equal(summary.failed, 1);
    assert.equal(summary.reconciled, 0);
    assert.equal(summary.delivered, 0);
    assert.equal(fixture.messagePostRequests.length, 0, "a malformed readback cannot authorize a POST or deletion");
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.messages[0].body, "DIFFERENT NONEMPTY BODY");
    assert.equal(listPending(join(dir, "outbox")).length, 1);
  });
}

for (const malformedSubject of [123, true, { unexpected: "object" }, ["unexpected array"]]) {
  test(`malformed terminal reconciliation subject ${JSON.stringify(malformedSubject)} fails closed`, async (t) => {
    const dir = scratch("malformed-subject");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = new TerminalBusFixture([terminalRow("msg_exact_with_malformed_readback")]);
    fixture.terminalReadbackTransform = (message) => ({ ...message, subject: malformedSubject });
    await fixture.start();
    t.after(() => fixture.close());
    recordTerminal(dir);
    const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

    const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

    assert.equal(summary.failed, 1);
    assert.equal(summary.reconciled, 0);
    assert.equal(summary.delivered, 0);
    assert.equal(fixture.messagePostRequests.length, 0, "malformed readback must not downgrade to publication");
    assert.equal(fixture.messages.length, 1);
    assert.equal(listPending(join(dir, "outbox")).length, 1);
  });
}

test("terminal canonicalization preserves server length and empty-subject refusals", async (t) => {
  const dir = scratch("canonical-validation");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

  await assert.rejects(
    () => bus.postTerminal("status", TERMINAL.subject, " ".repeat(8_001), TERMINAL.options),
    /body must be <= 8000 characters before canonical storage/,
  );
  await assert.rejects(
    () => bus.postTerminal("status", " \n\u0085", TERMINAL.body, TERMINAL.options),
    /subject must be a non-empty string/,
  );

  assert.equal(fixture.identityRequests, 0);
  assert.equal(fixture.messagePostRequests.length, 0);
  assert.equal(fixture.posts.length, 0);
  assert.equal(listPending(join(dir, "outbox")).length, 2, "both refused terminal records remain durable");
});

test("bearer and configured identity are immutable after a successful lookup", async (t) => {
  const dir = scratch("identity-immutable");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir);

  assert.throws(() => { bus.token = "replacement-token"; }, TypeError);
  assert.throws(() => { bus.expectedPostingPrincipal = "worker:other"; }, TypeError);
  assert.equal(bus.token, "test-token");
  assert.equal(bus.expectedPostingPrincipal, POSTED_BY);
});

test("a server-side identity change after prior success blocks terminal publication and preserves evidence", async (t) => {
  const dir = scratch("identity-changed-before-post");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir);
  fixture.identityPayload = { worker_principal: "worker:other" };

  await assert.rejects(
    () => bus.postTerminal("status", TERMINAL.subject, TERMINAL.body, TERMINAL.options),
    (error) => error instanceof WorkerIdentityRefusal && error.code === "worker_identity_mismatch",
  );
  assert.equal(fixture.identityRequests, 2, "terminal publication must not reuse the earlier lookup");
  assert.equal(fixture.posts.length, 0);
  const [pending] = listPending(join(dir, "outbox"));
  assert.equal(pending.entry.configured_worker_principal, POSTED_BY);
  assert.equal(pending.entry.expected_posted_by, undefined);
});

test("an identity outage after prior success blocks reconciliation before any message read", async (t) => {
  const dir = scratch("identity-outage-before-reconcile");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordTerminal(dir);
  const fixture = new TerminalBusFixture([terminalRow("msg_exact")]);
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir);
  fixture.identityStatus = 503;

  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(fixture.identityRequests, 2, "reconciliation must freshly resolve identity");
  assert.equal(fixture.messageGetRequests, 0);
  assert.equal(fixture.posts.length, 0);
  assert.equal(bus.authenticatedPostingPrincipal, null, "a failed refresh must erase stale identity state");
  assert.equal(listPending(join(dir, "outbox")).length, 1);
});

test("identity is checked again between cardinality zero and the replay POST", async (t) => {
  const dir = scratch("identity-change-after-scan");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordTerminal(dir);
  const fixture = new TerminalBusFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const bus = await authenticatedBus(fixture, dir);
  fixture.afterMessageGet = () => {
    fixture.identityPayload = { worker_principal: "worker:other" };
    fixture.afterMessageGet = null;
  };

  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

  assert.equal(summary.failed, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(fixture.identityRequests, 3, "startup, reconciliation, and publication each require identity");
  assert.equal(fixture.messageGetRequests, 1, "absence was observed before identity changed");
  assert.equal(fixture.posts.length, 0, "changed identity must block the terminal POST");
  assert.equal(listPending(join(dir, "outbox")).length, 1);
});

test("exact old A/B ACK-loss sequence now refuses both attempts and retains evidence", async (t) => {
  const dir = scratch("ir-block-closed");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new TerminalBusFixture([], {
    authenticatedPrincipal: "worker:other",
    principalRole: "worker",
  });
  fixture.dropAckSubject = TERMINAL.subject;
  await fixture.start();
  t.after(() => fixture.close());

  const beforeCrash = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);
  await assert.rejects(
    () => beforeCrash.postTerminal("status", TERMINAL.subject, TERMINAL.body, TERMINAL.options),
    (error) => error instanceof WorkerIdentityRefusal && error.code === "worker_identity_mismatch",
  );
  assert.equal(terminalPostCount(fixture), 0, "the mismatched bearer cannot create the first terminal effect");
  assert.equal(listPending(join(dir, "outbox")).length, 1);

  const restarted = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);
  const summary = await replayPending(restarted, join(dir, "outbox"), { warn() {}, error() {} });
  assert.equal(summary.failed, 1);
  assert.equal(summary.reconciled, 0);
  assert.equal(summary.delivered, 0);
  assert.equal(fixture.messageGetRequests, 0);
  assert.equal(terminalPostCount(fixture), 0, "restart cannot duplicate under the wrong authenticated principal");
  assert.equal(listPending(join(dir, "outbox")).length, 1);
});

for (const failure of [
  { name: "missing bearer", token: "", code: "worker_identity_forbidden", pattern: /failed: 401/ },
  { name: "unknown bearer", token: "unknown-token", code: "worker_identity_forbidden", pattern: /failed: 401/ },
  { name: "ambiguous bearer", status: 403, raw: '{"detail":"operator error: overlapping credential"}', code: "worker_identity_forbidden", pattern: /failed: 403/ },
  { name: "malformed JSON", raw: "{not json", code: "worker_identity_malformed", pattern: /returned invalid JSON/ },
  { name: "null response", raw: "null", code: "worker_identity_malformed", pattern: /must be exactly/ },
  { name: "array response", raw: '[]', code: "worker_identity_malformed", pattern: /must be exactly/ },
  { name: "primitive response", raw: '"worker:lane-b-worker"', code: "worker_identity_malformed", pattern: /must be exactly/ },
  { name: "missing principal", payload: {}, code: "worker_identity_malformed", pattern: /must be exactly/ },
  { name: "extra property", payload: { worker_principal: POSTED_BY, source: "client" }, code: "worker_identity_malformed", pattern: /must be exactly/ },
  { name: "non-string principal", payload: { worker_principal: 42 }, code: "worker_identity_malformed", pattern: /string worker_principal/ },
  { name: "invalid worker form", payload: { worker_principal: "admin:lane-b-worker" }, code: "worker_identity_malformed", pattern: /invalid worker principal/ },
]) {
  test(`identity ${failure.name} fails closed before reconciliation or terminal POST`, async (t) => {
    const dir = scratch(`identity-${failure.name.replaceAll(" ", "-")}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    recordTerminal(dir);
    const fixture = new TerminalBusFixture();
    if (failure.status !== undefined) fixture.identityStatus = failure.status;
    if (failure.raw !== undefined) fixture.identityRaw = failure.raw;
    if (failure.payload !== undefined) fixture.identityPayload = failure.payload;
    await fixture.start();
    t.after(() => fixture.close());
    const bus = new BusClient(
      fixture.url,
      failure.token ?? "test-token",
      100,
      join(dir, "outbox"),
      POSTED_BY,
    );

    await assert.rejects(
      () => bus.establishAuthenticatedPostingPrincipal(),
      (error) => error instanceof WorkerIdentityRefusal
        && error.refused === true
        && error.code === failure.code
        && failure.pattern.test(error.message),
    );
    assert.equal(bus.authenticatedPostingPrincipal, null);
    const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });
    assert.equal(summary.failed, 1);
    await assert.rejects(() => bus.postTerminal("status", TERMINAL.subject, TERMINAL.body, TERMINAL.options));
    assert.equal(terminalPostCount(fixture), 0);
    assert.equal(fixture.messageGetRequests, 0, "identity refusal must precede reconciliation reads");
    assert.equal(listPending(join(dir, "outbox")).length, 2, "both pre-existing and new terminal evidence remain");
  });
}

test("identity timeout fails closed with pending retained and no terminal POST", async (t) => {
  const dir = scratch("identity-timeout");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordTerminal(dir);
  const fixture = new TerminalBusFixture();
  fixture.identityDelayMs = 200;
  await fixture.start();
  t.after(() => fixture.close());
  const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY, 20);

  await assert.rejects(
    () => bus.establishAuthenticatedPostingPrincipal(),
    (error) => error instanceof WorkerIdentityRefusal && error.code === "worker_identity_unavailable",
  );
  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });
  assert.equal(summary.failed, 1);
  assert.equal(terminalPostCount(fixture), 0);
  assert.equal(fixture.messageGetRequests, 0);
  assert.equal(listPending(join(dir, "outbox")).length, 1);
});

test("identity network failure fails closed with pending retained and no terminal POST", async (t) => {
  const dir = scratch("identity-network");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordTerminal(dir);
  const fixture = new TerminalBusFixture();
  await fixture.start();
  const unreachableUrl = fixture.url;
  await fixture.close();
  const bus = new BusClient(unreachableUrl, "test-token", 100, join(dir, "outbox"), POSTED_BY, 100);

  await assert.rejects(
    () => bus.establishAuthenticatedPostingPrincipal(),
    (error) => error instanceof WorkerIdentityRefusal && error.code === "worker_identity_unavailable",
  );
  const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });
  assert.equal(summary.failed, 1);
  assert.equal(listPending(join(dir, "outbox")).length, 1);
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
  assert.equal(fixture.identityRequests, 2, "duplicate classification uses a fresh identity lookup");
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
  assert.equal(fixture.identityRequests, 2, "pagination starts only after a fresh identity lookup");
});

for (const refusal of [
  { name: "wrong worker", postAuthenticatedPrincipal: "worker:other", postPrincipalRole: "worker", code: "worker_publication_precondition_refused" },
  { name: "admin", postAuthenticatedPrincipal: "george", postPrincipalRole: "admin", code: "worker_publication_precondition_refused" },
  { name: "collector", postAuthenticatedPrincipal: "collector:ci", postPrincipalRole: "collector", code: "worker_publication_precondition_refused" },
  { name: "agent", postAuthenticatedPrincipal: "agent:configured", postPrincipalRole: "agent", code: "worker_publication_precondition_refused" },
  { name: "ambiguous", postAuthenticatedPrincipal: "worker:ambiguous", postPrincipalRole: "ambiguous", code: "worker_publication_forbidden" },
  { name: "malformed precondition response", forcedBoundRefusalStatus: 422, code: "worker_publication_precondition_malformed" },
]) {
  test(`atomic publication keeps pending when the POST authenticates as ${refusal.name}`, async (t) => {
    const dir = scratch(`atomic-${refusal.name.replaceAll(" ", "-")}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = new TerminalBusFixture([], refusal);
    await fixture.start();
    t.after(() => fixture.close());
    const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

    await assert.rejects(
      () => bus.postTerminal("status", TERMINAL.subject, TERMINAL.body, TERMINAL.options),
      (error) => error instanceof WorkerIdentityRefusal && error.code === refusal.code,
    );

    assert.equal(fixture.identityRequests, 1, "discovery succeeds but does not authorize the POST");
    assert.equal(fixture.messagePostRequests.length, 1, "refusal must not trigger an unbound retry");
    assert.deepEqual(fixture.messagePostRequests[0].expectedHeaders, [POSTED_BY]);
    assert.equal(fixture.posts.length, 0);
    assert.equal(fixture.messages.length, 0);
    assert.equal(listPending(join(dir, "outbox")).length, 1);
  });
}

for (const invalidBinding of [
  { name: "missing", entry: { ...TERMINAL, configured_worker_principal: undefined, expected_posted_by: undefined } },
  { name: "malformed", entry: { ...TERMINAL, configured_worker_principal: "worker:bad/id" } },
]) {
  test(`${invalidBinding.name} pending worker binding is retained without any POST`, async (t) => {
    const dir = scratch(`binding-${invalidBinding.name}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const entry = { ...invalidBinding.entry };
    if (invalidBinding.name === "missing") {
      delete entry.configured_worker_principal;
      delete entry.expected_posted_by;
    }
    recordPending(entry, join(dir, "outbox"));
    const fixture = new TerminalBusFixture();
    await fixture.start();
    t.after(() => fixture.close());
    const bus = new BusClient(fixture.url, "test-token", 100, join(dir, "outbox"), POSTED_BY);

    const summary = await replayPending(bus, join(dir, "outbox"), { warn() {}, error() {} });

    assert.equal(summary.failed, 1);
    assert.equal(fixture.identityRequests, 0);
    assert.equal(fixture.messageGetRequests, 0);
    assert.equal(fixture.messagePostRequests.length, 0);
    assert.equal(fixture.posts.length, 0);
    assert.equal(listPending(join(dir, "outbox")).length, 1);
  });
}

for (const mismatch of [
  { name: "wrong worker", authenticatedPrincipal: "worker:other", principalRole: "worker" },
  { name: "admin", authenticatedPrincipal: "george", principalRole: "admin" },
  { name: "collector", authenticatedPrincipal: "collector:ci", principalRole: "collector" },
]) {
  test(`IR BLOCK control: ${mismatch.name} bearer is refused before terminal replay or publication`, async (t) => {
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
      assert.match(run.stderr(), /bearer authenticates as worker:other, but --id requires worker:lane-b-worker/);
    } else {
      assert.match(run.stderr(), /worker identity GET .* failed: 403/);
    }
    assert.equal(fixture.posts.length, 0, "identity refusal must precede every publication");
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
  const terminalRequests = fixture.messagePostRequests.filter(({ payload }) => payload.subject === TERMINAL.subject);
  assert.equal(terminalRows.length, 1, "restart must reconcile, not append a duplicate");
  assert.equal(terminalRequests.length, 1, "ACK loss must not cause another terminal POST");
  assert.deepEqual(terminalRequests[0].expectedHeaders, [POSTED_BY]);
  assert.equal(terminalRequests[0].payload.from_agent, undefined);
  assert.equal(terminalRequests[0].payload.posted_by, undefined);
  assert.equal(terminalRows[0].posted_by, POSTED_BY);
  assert.equal(terminalRows[0].in_reply_to, TERMINAL.options.inReplyTo);
  assert.deepEqual(terminalRows[0].refs, TERMINAL.options.refs);
  assert.match(terminalRows[0].body, /contract=wo_lane_b@01234567/);
  assert.match(terminalRows[0].body, /attempt=msg_lane_b\/1/);
  assert.match(terminalRows[0].body, /economics_sha256=e[1]{63}/);
  assert.match(terminalRows[0].body, /evidence_sha256=a{64}/);
  assert.equal(listPending(join(dir, "outbox")).length, 0);
  assert.match(second.stderr(), /reconciled 1/);
  assert.equal(
    fixture.identityRequests,
    5,
    "both startups, both reconciliations, and the first replay POST each authenticate independently",
  );
});
