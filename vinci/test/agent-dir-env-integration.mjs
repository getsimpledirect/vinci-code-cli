// Vinci Code — the agent directory override is honoured wherever Vinci reads or writes it.
//
// The override env name is DERIVED, not fixed: packages/coding-agent/src/config.ts builds it from
// that package's piConfig ("vinci" → VINCI_CODING_AGENT_DIR), while configDir deliberately stays
// ".pi" (PATCHES.md §9). Because the stale upstream fallback (~/.pi/agent) coincides with the real
// default, reading the OLD name looked correct until a user actually moved their agent directory —
// then the header reported "not signed in" for credentials that existed, and the thinking-hint claim
// created ~/.pi/agent on a machine that does not use it.
//
// Every assertion below drives the override through ENV_AGENT_DIR imported from the core config, so
// this pins the BEHAVIOUR (Vinci follows the configured directory) rather than a spelling: renaming
// piConfig moves the product code and this test together.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { ENV_AGENT_DIR } = await loader.import(resolve(root, "packages/coding-agent/src/config.ts"), {
  default: false,
});
const header = await loader.import(resolve(here, "../extensions/vinci-header.ts"), { default: false });
const uiState = await loader.import(resolve(here, "../extensions/lib/ui-state.ts"), { default: false });
const guard = await loader.import(resolve(here, "../extensions/vinci-guard.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });

// The name the fork was forked FROM. Nothing in Vinci sets it, so any code still reading it is
// reading a dead variable; each negative case below fails if a call site regresses to this spelling.
const UPSTREAM_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
assert.notEqual(ENV_AGENT_DIR, UPSTREAM_ENV_AGENT_DIR, "this fork must derive its own agent-dir env name");

const temp = mkdtempSync(join(tmpdir(), "vinci-agent-dir-env-"));
const previous = {
  agentDir: process.env[ENV_AGENT_DIR],
  upstreamAgentDir: process.env[UPSTREAM_ENV_AGENT_DIR],
  home: process.env.HOME,
  trustFile: process.env.VINCI_TRUST_FILE,
};

let passed = 0;
const check = (name) => {
  console.log(`  ✓ ${name}`);
  passed++;
};

/** A throwaway HOME whose default agent directory (~/.pi/agent) does not exist yet. */
function freshHome(name) {
  const home = join(temp, name);
  mkdirSync(home, { recursive: true });
  return home;
}

/** Run vinci-header's session_start against an isolated environment; returns what the user sees. */
async function startSession({ home, agentDir, upstreamAgentDir }) {
  process.env.HOME = home;
  if (agentDir === undefined) delete process.env[ENV_AGENT_DIR];
  else process.env[ENV_AGENT_DIR] = agentDir;
  if (upstreamAgentDir === undefined) delete process.env[UPSTREAM_ENV_AGENT_DIR];
  else process.env[UPSTREAM_ENV_AGENT_DIR] = upstreamAgentDir;

  uiState.resetVinciUiState();
  const handlers = [];
  header.default({
    on(event, handler) {
      if (event === "session_start") handlers.push(handler);
    },
  });
  assert.equal(handlers.length, 1);
  const notifications = [];
  await handlers[0](
    {},
    {
      mode: "tui",
      cwd: home,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
        setHeader() {},
      },
    },
  );
  return { connection: uiState.getVinciUiState().connection, notifications };
}

function writeCredentials(agentDir) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ vinci: { type: "api_key", key: "test" } }));
}

try {
  // ── hasCredentials(): the header reads auth.json from the CONFIGURED directory ─────────────────
  {
    const home = freshHome("credentials-home");
    const agentDir = join(temp, "credentials-agent");
    writeCredentials(agentDir);

    const configured = await startSession({ home, agentDir });
    assert.equal(configured.connection, "signed-in", "credentials in the overridden agent dir must read as signed in");
    check("hasCredentials() finds auth.json in the overridden agent directory");

    // The same credentials advertised ONLY under the upstream env name must NOT be found: that name
    // is dead in this fork, and honouring it is exactly the bug (it also masked the missing override).
    const stale = await startSession({ home, agentDir: undefined, upstreamAgentDir: agentDir });
    assert.equal(stale.connection, "signed-out", "the dead upstream env name must not resolve credentials");
    check("hasCredentials() ignores the dead upstream env name");
  }

  // ── claimThinkingHint(): the marker AND its mkdir side effect land in the configured directory ──
  {
    const home = freshHome("hint-home");
    // Deliberately absent: claimThinkingHint() must CREATE it, and create it here rather than under
    // the default location derived from HOME.
    const agentDir = join(temp, "hint-agent", "nested");
    const defaultAgentDir = join(home, ".pi", "agent");

    const first = await startSession({ home, agentDir });
    assert.deepEqual(
      first.notifications,
      [{ message: "Thinking is collapsed by default. Press Ctrl+T anytime to show or hide it.", level: "info" }],
      "a fresh agent directory must still deliver the one-time thinking hint",
    );
    assert.ok(existsSync(join(agentDir, ".vinci-thinking-hint-v1")), "the hint marker must land in the overridden dir");
    check("claimThinkingHint() writes its marker into the overridden agent directory");

    assert.ok(!existsSync(defaultAgentDir), "the default agent directory must not be created on an overridden machine");
    check("claimThinkingHint()'s mkdir does not create the default ~/.pi/agent");

    const second = await startSession({ home, agentDir });
    assert.deepEqual(second.notifications, [], "the marker in the overridden dir must suppress the repeat hint");
    check("the claimed marker is re-read from the overridden agent directory");
  }

  // ── The graduated-trust store follows the configured directory too ─────────────────────────────
  {
    const home = freshHome("trust-home");
    const agentDir = join(temp, "trust-agent");
    delete process.env.VINCI_TRUST_FILE;
    process.env.HOME = home;
    process.env[ENV_AGENT_DIR] = agentDir;
    delete process.env[UPSTREAM_ENV_AGENT_DIR];

    guard.addTrust("/Users/x/proj", "npm publish");
    assert.ok(existsSync(join(agentDir, "vinci-trust.json")), "the trust store must live in the overridden agent dir");
    assert.ok(!existsSync(join(home, ".pi", "agent")), "the default agent directory must not be created");
    assert.ok(guard.isTrusted("/Users/x/proj", "npm publish"), "the trust store must read back from the same place");
    check("the graduated-trust store is written to and read from the overridden agent directory");
  }

  // ── `vinci report-wrong` resolves sessions under the configured directory ──────────────────────
  {
    const home = freshHome("report-home");
    const agentDir = join(temp, "report-agent");
    const taskId = "agent-dir-task";
    const sessionDir = join(agentDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const outcome = {
      schemaVersion: 1,
      taskId,
      state: "DONE",
      reason: "Direct check passed.",
      changedFiles: ["index.js"],
      verificationStatus: "passed",
      verificationCommand: "node --test",
      activeDurationMs: 12_000,
      usage: {
        modelCalls: 4,
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 300,
        cacheWriteTokens: 0,
        reasoningTokens: 10,
        estimatedCostUsd: 0.025,
        providers: ["deepinfra"],
        models: ["zai-org/GLM-5.2"],
      },
      recordedAt: "2026-07-12T12:00:00.000Z",
    };
    const entries = [
      { type: "session", version: 3, id: taskId, timestamp: "2026-07-12T11:59:00.000Z", cwd: root },
      {
        type: "message",
        id: "message1",
        parentId: null,
        timestamp: "2026-07-12T11:59:30.000Z",
        message: { role: "assistant", content: [], timestamp: 1 },
      },
      {
        type: "custom",
        customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
        data: outcome,
        id: "outcome1",
        parentId: "message1",
        timestamp: "2026-07-12T12:00:00.000Z",
      },
    ];
    const sessionPath = join(sessionDir, `${taskId}.jsonl`);
    writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    // No --session-dir: the command must derive the session store from the configured agent dir.
    const run = (extraEnv) =>
      spawnSync("bash", [join(root, "vinci/bin/vinci"), "report-wrong", taskId], {
        cwd: root,
        env: {
          ...process.env,
          [ENV_AGENT_DIR]: undefined,
          [UPSTREAM_ENV_AGENT_DIR]: undefined,
          HOME: home,
          VINCI_INTERNAL_DEEPINFRA_API_KEY: "",
          ...extraEnv,
        },
        encoding: "utf8",
      });

    const configured = run({ [ENV_AGENT_DIR]: agentDir });
    assert.equal(configured.status, 0, configured.stderr);
    assert.match(configured.stdout, /Recorded false-completion report/);
    assert.ok(
      readFileSync(sessionPath, "utf8").includes("vinci-false-completion-report"),
      "the report must be appended to the session under the overridden agent dir",
    );
    check("report-wrong resolves its session store under the overridden agent directory");

    const stale = run({ [UPSTREAM_ENV_AGENT_DIR]: agentDir });
    assert.notEqual(stale.status, 0, "the dead upstream env name must not locate the session store");
    assert.match(stale.stderr, new RegExp(`No task found with ID ${taskId}`));
    check("report-wrong ignores the dead upstream env name");
  }
} finally {
  for (const [name, value] of [
    [ENV_AGENT_DIR, previous.agentDir],
    [UPSTREAM_ENV_AGENT_DIR, previous.upstreamAgentDir],
    ["HOME", previous.home],
    ["VINCI_TRUST_FILE", previous.trustFile],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}

console.log(`agent-dir-env-integration: ${passed}/${passed} passed`);
