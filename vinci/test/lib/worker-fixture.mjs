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

  async startBus(handoffs = [], contractRegistry = {}) {
    this.busMessages = handoffs;
    this.contractRegistry = contractRegistry;
    this.postedMessages = [];
    this.rejectedPosts = [];
    this.getRequests = [];
    this.evidencePosts = [];
    this.contractRequests = [];

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
      // Wave 1B: the Governor's pinned-contract registry, served by the same listener so the
      // daemon's digest-form contract fetch (`GET <server>/v1/governor/contracts/{work_order_id}`)
      // can be exercised end-to-end without a second server. Keyed by work_order_id; a caller
      // returning an entry for the id answers 200, anything else 404.
      const contractsMatch = /^\/v1\/governor\/contracts\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && contractsMatch) {
        const workOrderId = decodeURIComponent(contractsMatch[1]);
        this.contractRequests.push({ workOrderId });
        const entry = this.contractRegistry?.[workOrderId];
        if (!entry) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: `no contract for ${workOrderId}` }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          work_order: entry.work_order,
          execution_specs: entry.execution_specs ?? [entry.execution_spec].filter(Boolean),
          digests: entry.digests ?? {},
          handoffs: entry.handoffs ?? [],
        }));
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
    // B2: configure MODEL_CLASSES for digest handoff tests (forte and fortissimo are the
    // standard managed-provider classes; worker tests may extend this for test cases).
    const defaultModelClasses = JSON.stringify({
      forte: { provider: "vinci", model: "forte" },
      fortissimo: { provider: "vinci", model: "fortissimo" },
    });
    return {
      ...process.env,
      VINCI_BUS_TOKEN: "test-token",
      VINCI_WORKER_GIT_BASE: `file://${this.reposDir}/`,
      VINCI_WORKER_MODEL_CLASSES: overrides.VINCI_WORKER_MODEL_CLASSES ?? defaultModelClasses,
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
