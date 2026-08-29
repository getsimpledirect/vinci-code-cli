// Test fixture for worker integration tests.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LEDGER_REF = /^(?:job|exp|bk)_[A-Za-z0-9][A-Za-z0-9._-]*$/;

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function readBody(request) {
  return new Promise((resolveBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : null);
      } catch {
        resolveBody({ __unparsable: body });
      }
    });
  });
}

// Wave 1B: a fake Governor with the lease endpoints (acquire / renew / release / check) plus the
// Stage 2 claim-paths route, with an injectable clock. Everything a test wants to script is a
// field:
//   ttlS            ttl_s served on acquire and renew (seconds; small values make renews frequent)
//   now             clock (ms) used for expires_at — `() => Date.now()` by default
//   mode            "grant" | "leased" | "error" | "hang"  (acquire behaviour)
//   holder          { holder_attempt_id, expires_at } served on mode "leased"
//   renewOkCount    number of renews to grant before renewFailure is served (Infinity = never)
//   renewFailure    { status: 409, reason: "stale_generation" } | { status: 500 } | "drop" (socket destroyed)
//   renewDelayMs    ms a granted renew is held before it is answered (0) — exercises "renew in flight"
//   check           true | false | (body, effectIndex) => ({ valid, reason })
//   releaseStatus   HTTP status for release (200)
//   claim           body served (200) on /v1/governor/claim-paths, or { status, body }
//   epoch           value stamped on every response
// `hits` records every request `{ method, url, auth, body }`; `renews`, `checks`, `releases`
// and `acquires` are the parsed bodies per route in arrival order. `events` is the COMPLETION
// order (`acquire`, `claim`, `renew:start`, `renew:end`, `check`, `release`) so a test can tell a
// release that waited for an in-flight renew from one that raced it.
export class FakeGovernor {
  constructor(options = {}) {
    this.ttlS = options.ttlS ?? 60;
    this.now = options.now ?? (() => Date.now());
    this.mode = options.mode ?? "grant";
    this.holder = options.holder ?? { holder_attempt_id: "other-worker/7", expires_at: "2099-01-01T00:00:00.000Z" };
    this.renewOkCount = options.renewOkCount ?? Infinity;
    this.renewFailure = options.renewFailure ?? { status: 409, reason: "stale_generation" };
    this.check = options.check ?? true;
    this.releaseStatus = options.releaseStatus ?? 200;
    this.renewDelayMs = options.renewDelayMs ?? 0;
    this.claim = options.claim ?? { paths: ["."], ttl: 3600 };
    this.epoch = options.epoch ?? 1;
    this.leaseToken = options.leaseToken ?? "Session gov-token";
    this.hits = [];
    this.acquires = [];
    this.renews = [];
    this.checks = [];
    this.releases = [];
    this.events = [];
    this.leases = new Map();
    this.nextGeneration = 100;
    this.server = null;
    this.url = null;
  }

  expiresAt() {
    return new Date(this.now() + this.ttlS * 1000).toISOString();
  }

  json(response, status, body) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ epoch: this.epoch, ...body }));
  }

  // Returns true when the request was one of ours (and has been answered).
  async handle(request, response) {
    const url = new URL(request.url, "http://governor.invalid");
    if (!url.pathname.startsWith("/v1/governor/")) return false;
    const body = await readBody(request);
    this.hits.push({ method: request.method, url: request.url, auth: request.headers.authorization, body, at: Date.now() });
    if (url.pathname === "/v1/governor/claim-paths") {
      this.events.push("claim");
      if (this.claim.status) this.json(response, this.claim.status, this.claim.body ?? {});
      else this.json(response, 200, this.claim);
      return true;
    }
    if (url.pathname === "/v1/governor/leases" && request.method === "POST") {
      this.acquires.push(body);
      this.events.push("acquire");
      if (this.mode === "hang") return true; // never answers; the caller's socket stays open
      if (request.headers.authorization !== this.leaseToken) {
        this.json(response, 401, { reason: "bad session token" });
        return true;
      }
      if (this.mode === "leased") {
        this.json(response, 409, { reason: "leased", ...this.holder });
        return true;
      }
      if (this.mode === "error") {
        this.json(response, 500, { reason: "governor exploded" });
        return true;
      }
      const lease = { lease_id: `lease-${this.leases.size + 1}`, fencing_generation: this.nextGeneration++, ttl_s: this.ttlS, expires_at: this.expiresAt(), renews: 0, released: null };
      this.leases.set(lease.lease_id, lease);
      this.json(response, 200, { lease_id: lease.lease_id, fencing_generation: lease.fencing_generation, expires_at: lease.expires_at, ttl_s: lease.ttl_s });
      return true;
    }
    const match = /^\/v1\/governor\/leases\/([^/]+)\/(renew|release|check)$/.exec(url.pathname);
    if (!match || request.method !== "POST") {
      this.json(response, 404, { reason: "no such route" });
      return true;
    }
    const [, leaseId, action] = match;
    const lease = this.leases.get(decodeURIComponent(leaseId));
    if (action === "check") {
      this.checks.push({ lease_id: leaseId, ...body, auth: request.headers.authorization });
      this.events.push("check");
      if (!request.headers.authorization?.startsWith("Bearer ")) {
        this.json(response, 401, { reason: "check needs the bus token" });
        return true;
      }
      const verdict = typeof this.check === "function" ? this.check(body, this.checks.length - 1) : { valid: Boolean(this.check), reason: this.check ? "ok" : "revoked" };
      const stale = !lease || lease.fencing_generation !== body?.fencing_generation;
      this.json(response, 200, stale ? { valid: false, reason: "stale_generation" } : verdict);
      return true;
    }
    if (request.headers.authorization !== this.leaseToken) {
      this.json(response, 401, { reason: "bad session token" });
      return true;
    }
    if (action === "renew") {
      this.renews.push({ lease_id: leaseId, ...body });
      if (!lease) {
        this.json(response, 404, { reason: "unknown lease" });
        return true;
      }
      if (lease.fencing_generation !== body?.fencing_generation) {
        this.json(response, 409, { reason: "stale_generation" });
        return true;
      }
      if (lease.renews >= this.renewOkCount) {
        if (this.renewFailure === "drop") {
          request.socket.destroy();
          return true;
        }
        this.json(response, this.renewFailure.status ?? 409, { reason: this.renewFailure.reason ?? "revoked" });
        return true;
      }
      lease.renews += 1;
      this.events.push("renew:start");
      if (this.renewDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, this.renewDelayMs));
      lease.expires_at = this.expiresAt();
      this.events.push("renew:end");
      this.json(response, 200, { expires_at: lease.expires_at, ttl_s: lease.ttl_s });
      return true;
    }
    this.releases.push({ lease_id: leaseId, ...body });
    this.events.push("release");
    if (lease) lease.released = body?.outcome ?? null;
    this.json(response, this.releaseStatus, {});
    return true;
  }

  async start() {
    this.server = createServer((request, response) => {
      this.handle(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    await new Promise((resolveListen) => this.server.listen(0, "127.0.0.1", resolveListen));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  async close() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((resolveClose) => this.server.close(resolveClose));
    this.server = null;
  }
}

export class WorkerTestFixture {
  constructor(testName) {
    this.testName = testName;
    this.tempDir = mkdtempSync(join(tmpdir(), `worker-test-${testName}-`));
    // The daemon's first run starts its cursor at NOW (skip-history, learned live on
    // 2026-08-27). Fixture handoffs carry historical timestamps, so seed an ancient cursor for
    // every worker id the tests use; worker-first-run-cursor.mjs is the one test that must NOT
    // have this seed and proves the skip-history rule.
    if (!process.env.VINCI_TEST_NO_CURSOR_SEED) {
      const ancient = { ts: "2000-01-01T00:00:00.000Z", message_ids: [] };
      const cursors = Object.fromEntries(["exit-worker", "locked", "publisher", "t1", "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"].map((id) => [id, ancient]));
      writeFileSync(join(this.tempDir, "cursor.json"), JSON.stringify(cursors, null, 2));
    }
    this.reposDir = join(this.tempDir, "origins");
    this.toolsDir = join(this.tempDir, "tools");
    this.recordFile = join(this.tempDir, "vinci-calls.txt");
    this.postedMessages = [];
    this.rejectedPosts = [];
    this.busMessages = [];
    this.evidencePosts = [];
    this.getRequests = [];
    // When set (e.g. 500), every /v1/evidence POST answers with that status instead of 200.
    this.evidencePostStatus = null;
    // When set to a RegExp, every /v1/messages POST whose subject matches answers 500 and is
    // recorded in failedPosts instead of postedMessages (to exercise post-failure retry paths).
    this.failPostSubjects = null;
    this.failedPosts = [];
    // GET /v1/version (unauthenticated, like vinci-gpu-control). Set serveVersion=false to make
    // the route 404 so the daemon records `{ error }` instead of a build.
    this.serverBuild = {
      component: "vinci-gpu-server",
      git_sha: "f1e7a2e0c0ffee00000000000000000000000abc",
      git_sha_source: "git",
      dirty: false,
    };
    this.serveVersion = true;
    // When > 0, /v1/version answers only after this many ms (to exercise the daemon's timeout).
    this.versionDelayMs = 0;
    this.versionRequests = 0;
    this.busServer = null;
    this.busPort = 0;
    mkdirSync(this.reposDir, { recursive: true });
  }

  createRepo(org, name, options = {}) {
    const origin = join(this.reposDir, org, `${name}.git`);
    mkdirSync(dirname(origin), { recursive: true });
    runGit(["init", "--bare", "--initial-branch=main", origin], this.tempDir);

    const temporary = join(this.tempDir, `git-${org}-${name}`);
    runGit(["init", "--initial-branch=main", temporary], this.tempDir);
    runGit(["-C", temporary, "config", "user.email", "test@test.com"], this.tempDir);
    runGit(["-C", temporary, "config", "user.name", "Test"], this.tempDir);
    writeFileSync(join(temporary, "README.md"), "test repo\n");
    for (const [path, contents] of Object.entries(options.files ?? {})) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    runGit(["-C", temporary, "add", "README.md", ...Object.keys(options.files ?? {})], this.tempDir);
    runGit(["-C", temporary, "commit", "-m", "init"], this.tempDir);
    runGit(["-C", temporary, "remote", "add", "origin", `file://${origin}`], this.tempDir);
    runGit(["-C", temporary, "push", "-u", "origin", "main"], this.tempDir);
    rmSync(temporary, { recursive: true });

    return { origin, cloneUrl: `file://${origin}` };
  }

  async startBus(handoffs = []) {
    this.busMessages = handoffs;
    this.postedMessages = [];
    this.rejectedPosts = [];
    this.getRequests = [];
    this.evidencePosts = [];

    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/version") {
        this.versionRequests += 1;
        if (!this.serveVersion) {
          response.writeHead(404);
          response.end();
          return;
        }
        const answer = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(this.serverBuild));
        };
        if (this.versionDelayMs > 0) setTimeout(answer, this.versionDelayMs).unref();
        else answer();
        return;
      }
      if (request.headers.authorization !== "Bearer test-token") {
        response.writeHead(401);
        response.end();
        return;
      }
      const url = new URL(request.url, "http://fixture.invalid");
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        this.getRequests.push({ limit, offset });
        const messages = this.busMessages
          .slice()
          .sort((left, right) => left.ts.localeCompare(right.ts) || left.message_id.localeCompare(right.message_id));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ messages: messages.slice(offset, offset + limit), total: messages.length, limit, offset }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const message = JSON.parse(body);
          const invalidRefs = (message.refs ?? []).filter((ref) => !LEDGER_REF.test(ref));
          if (invalidRefs.length > 0) {
            this.rejectedPosts.push(message);
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: `invalid refs: ${invalidRefs.join(", ")}` }));
            return;
          }
          if (this.failPostSubjects && this.failPostSubjects.test(message.subject ?? "")) {
            this.failedPosts.push(message);
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "fixture: post refused" }));
            return;
          }
          this.postedMessages.push(message);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/evidence") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const evidence = JSON.parse(body);
          const invalidRefs = (evidence.refs ?? []).filter((ref) => !LEDGER_REF.test(ref));
          if (invalidRefs.length > 0) {
            this.rejectedPosts.push(evidence);
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: `invalid refs: ${invalidRefs.join(", ")}` }));
            return;
          }
          if (this.evidencePostStatus) {
            this.rejectedPosts.push(evidence);
            response.writeHead(this.evidencePostStatus, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: `forced ${this.evidencePostStatus}` }));
            return;
          }
          this.evidencePosts.push(evidence);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    this.busServer = server;
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    this.busPort = server.address().port;
  }

  busUrl() {
    return `http://127.0.0.1:${this.busPort}`;
  }

  linkTools(toolsSource) {
    mkdirSync(this.toolsDir, { recursive: true });
    for (const tool of ["vinci", "npm", "gh", "aws"]) {
      symlinkSync(join(toolsSource, tool), join(this.toolsDir, tool));
    }
  }

  getEnv(overrides = {}) {
    return {
      ...process.env,
      VINCI_BUS_TOKEN: "test-token",
      VINCI_WORKER_GIT_BASE: `file://${this.reposDir}/`,
      PATH: `${this.toolsDir}:${process.env.PATH}`,
      FAKE_VINCI_RECORD: this.recordFile,
      FAKE_VINCI_SESSION_FIXTURE: join(dirname(new URL(import.meta.url).pathname), "../fixtures/worker-session.jsonl"),
      FAKE_GH_RECORD: join(this.tempDir, "gh-calls.txt"),
      HOME: join(this.tempDir, "home"),
      VINCI_NO_BOOTSTRAP_HEAL: "1",
      ...overrides,
    };
  }

  getVinciCalls() {
    try {
      return readFileSync(this.recordFile, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  getPostedMessages() {
    return this.postedMessages;
  }

  getEvidencePosts() {
    return this.evidencePosts;
  }

  async cleanup() {
    if (this.busServer) await new Promise((resolveClose) => this.busServer.close(resolveClose));
    rmSync(this.tempDir, { recursive: true, force: true });
  }
}
