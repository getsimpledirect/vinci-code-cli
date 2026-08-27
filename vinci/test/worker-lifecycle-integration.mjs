import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(root, "vinci/bin/vinci");
const fixtures = join(root, "vinci/test/fixtures/worker-test-tools");

function envelope(overrides = {}) {
  const headers = {
    repo: "test/repo",
    evidence: "none",
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    budget_usd: "5",
    max_runtime_s: "30",
    ref: "job_42",
    ...overrides,
  };
  return `${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")}\n\nImplement the task.`;
}

async function fakeBus(body) {
  const posts = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    if (request.method === "GET" && request.url?.startsWith("/v1/messages")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        messages: [{
          message_id: "1",
          to_agent: "t1",
          kind: "handoff",
          subject: "lifecycle task",
          body,
          ts: "2026-08-26T10:00:00Z",
          posted_by: "scheduler",
        }],
        total: 1,
        limit: 100,
        offset: 0,
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/messages") {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        posts.push(JSON.parse(raw));
        response.setHeader("content-type", "application/json");
        response.end("{}");
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    posts,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

function runWorker(url, stateDir, extraEnv = {}) {
  const vinciRecord = join(stateDir, "vinci.log");
  writeFileSync(vinciRecord, "");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "bash",
      [launcher, "worker", "start", "--id", "t1", "--server", url, "--once", "--state-dir", stateDir],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: join(stateDir, "home"),
          PATH: `${fixtures}:${process.env.PATH}`,
          VINCI_BUS_TOKEN: "test-token",
          VINCI_NO_BOOTSTRAP_HEAL: "1",
          VINCI_WORKER_KILL_GRACE_MS: "25",
          VINCI_WORKER_LIMIT_POLL_MS: "25",
          FAKE_GH_RECORD: join(stateDir, "gh.log"),
          FAKE_GIT_RECORD: join(stateDir, "git.log"),
          FAKE_VINCI_RECORD: vinciRecord,
          ...extraEnv,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`worker timed out\n${stdout}\n${stderr}`));
    }, 5_000);
    child.once("error", rejectRun);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(vinciRecord);
      else rejectRun(new Error(`worker exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function taskState(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "tasks", "1.json"), "utf8"));
}

async function scenario(name, body, env, verify, prepare) {
  const stateDir = mkdtempSync(join(tmpdir(), `vinci-worker-${name}-`));
  const bus = await fakeBus(body);
  try {
    if (prepare) prepare(stateDir);
    const vinciRecord = await runWorker(bus.url, stateDir, env);
    await verify({ bus, state: taskState(stateDir), vinciRecord });
  } finally {
    await new Promise((resolveClose) => bus.server.close(resolveClose));
    rmSync(stateDir, { recursive: true, force: true });
  }
}

await scenario(
  "restart",
  envelope(),
  {},
  ({ bus, state, vinciRecord }) => {
    assert.equal(state.attempt, 2);
    assert.equal(state.session_id, "kept-session");
    assert.equal(state.state, "COMPLETED");
    assert.equal(JSON.parse(readFileSync(vinciRecord, "utf8").trim()).argv[2], "kept-session");
    assert.deepEqual(bus.posts.map((post) => post.kind), ["finding"], "restart must not post a second claim");
  },
  (stateDir) => {
    mkdirSync(join(stateDir, "tasks"), { recursive: true });
    writeFileSync(
      join(stateDir, "tasks", "1.json"),
      `${JSON.stringify({ task: "1", attempt: 1, session_id: "kept-session", state: "RUNNING", terminal: false })}\n`,
    );
  },
);

await scenario("runtime", envelope({ max_runtime_s: "0.05" }), { FAKE_VINCI_SLEEP: "10000" }, ({ state, vinciRecord }) => {
  assert.equal(state.state, "FAILED");
  assert.equal(state.limit_tripped, "max_runtime_s");
  assert.match(readFileSync(vinciRecord, "utf8"), /SIGTERM/);
});

await scenario(
  "budget",
  envelope({ budget_usd: "1" }),
  { FAKE_VINCI_SLEEP: "10000", FAKE_VINCI_USAGE: "1" },
  ({ state, vinciRecord }) => {
    assert.equal(state.state, "FAILED");
    assert.equal(state.limit_tripped, "budget_usd");
    assert.equal(state.cost_usd, 9.99);
    assert.match(readFileSync(vinciRecord, "utf8"), /SIGTERM/);
  },
);

await scenario("deadline", envelope({ deadline: "2020-01-01T00:00:00Z" }), {}, ({ bus, state, vinciRecord }) => {
  assert.equal(state.state, "BLOCKED");
  assert.equal(state.limit_tripped, "deadline");
  assert.equal(readFileSync(vinciRecord, "utf8"), "");
  assert.deepEqual(bus.posts.map((post) => post.kind), ["blocker"]);
});

await scenario("blocked", envelope(), { FAKE_VINCI_OUTCOME: "BLOCKED" }, ({ bus, state }) => {
  assert.equal(state.state, "BLOCKED");
  assert.deepEqual(bus.posts.map((post) => post.kind), ["status", "blocker"]);
});

await scenario("unverified", envelope({ evidence: "pr" }), { FAKE_GH_EXIT: "1" }, ({ bus, state }) => {
  assert.equal(state.state, "UNVERIFIED");
  assert.equal(state.pr, null);
  assert.deepEqual(bus.posts.map((post) => post.kind), ["status", "status"]);
});

assert.equal(existsSync(join(root, "definitely-not-a-real-worker-network-artifact")), false);
process.stdout.write("  worker lifecycle: restart, limits, blocked, and unverified outcomes\n");
