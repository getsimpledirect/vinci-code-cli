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
    this.reposDir = join(this.tempDir, "origins");
    this.toolsDir = join(this.tempDir, "tools");
    this.recordFile = join(this.tempDir, "vinci-calls.txt");
    this.postedMessages = [];
    this.rejectedPosts = [];
    this.busMessages = [];
    this.getRequests = [];
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

    const server = createServer((request, response) => {
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
          this.postedMessages.push(message);
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
    for (const tool of ["vinci", "npm", "gh"]) {
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

  async cleanup() {
    if (this.busServer) await new Promise((resolveClose) => this.busServer.close(resolveClose));
    rmSync(this.tempDir, { recursive: true, force: true });
  }
}
