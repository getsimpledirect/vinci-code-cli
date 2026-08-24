import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-agent-core": resolve(here, "../../packages/agent/src/index.ts"),
    "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/src/index.ts"),
  },
  moduleCache: false,
  tryNative: false,
});
const crew = await loader.import(resolve(here, "../extensions/lib/crew-worktree.ts"), { default: false });
const state = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
const crewExt = await loader.import(resolve(here, "../extensions/vinci-crew.ts"), { default: false });
const scopeExt = await loader.import(resolve(here, "../extensions/vinci-scope.ts"), { default: false });
const scopeDrift = await loader.import(resolve(here, "../extensions/lib/scope-drift.ts"), { default: false });

let pass = 0;
let fail = 0;
const check = (name, condition) => {
  try {
    assert.ok(condition, name);
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    fail++;
    // Set immediately, not just at the summary line: checks that run after the summary printed
    // must still fail the suite.
    process.exitCode = 1;
  }
};

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function killSpawnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForExit(child, 5_000);
  child.kill("SIGKILL");
  await exit;
}

function waitForJson(path, predicate, timeoutMs, child) {
  return new Promise((resolveValue, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.off("exit", onExit);
      if (error) reject(error);
      else resolveValue(value);
    };
    const checkFile = () => {
      try {
        if (existsSync(path)) {
          const value = JSON.parse(readFileSync(path, "utf8"));
          if (predicate(value)) finish(undefined, value);
        }
      } catch {
        // A writer may be between truncate and write; the next immediate turn retries.
      }
      if (!settled) setImmediate(checkFile);
    };
    const onExit = (code, signal) => {
      checkFile();
      if (!settled) finish(new Error(`process exited before ${path} was ready (code=${code} signal=${signal})`));
    };
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${path}`)), timeoutMs);
    child?.once("exit", onExit);
    checkFile();
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessDeath(pid, timeoutMs) {
  return new Promise((resolveDeath, reject) => {
    const deadline = Date.now() + timeoutMs;
    const inspect = () => {
      if (!processIsAlive(pid)) {
        resolveDeath();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`process ${pid} survived SIGKILL`));
        return;
      }
      setImmediate(inspect);
    };
    inspect();
  });
}

function waitForCondition(predicate, description, timeoutMs) {
  return new Promise((resolveCondition, reject) => {
    const deadline = Date.now() + timeoutMs;
    const inspect = () => {
      try {
        if (predicate()) {
          resolveCondition();
          return;
        }
      } catch {
        // The observed cleanup can move through transient filesystem states.
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }
      setImmediate(inspect);
    };
    inspect();
  });
}

const base = mkdtempSync(join(tmpdir(), "crew-it-"));
const outside = mkdtempSync(join(tmpdir(), "crew-nonrepo-"));
const sessionDir = mkdtempSync(join(tmpdir(), "crew-session-"));
const toolRepo = mkdtempSync(join(tmpdir(), "crew-tools-"));
const printRepo = mkdtempSync(join(tmpdir(), "crew-print-"));
const shutdownRepo = mkdtempSync(join(tmpdir(), "crew-shutdown-"));
const worktrees = [];
const git = (args, cwd = base) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function writeKillRpc(path, markerPath, sentinel, respondToPrompt) {
  writeFileSync(
    path,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const markerPath = ${JSON.stringify(markerPath)};`,
      `const sentinel = ${JSON.stringify(sentinel)};`,
      `const respondToPrompt = ${JSON.stringify(respondToPrompt)};`,
      'const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      "setInterval(() => {}, 60_000);",
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const command = JSON.parse(line);",
      '  const respond = (data = {}) => send({ type: "response", id: command.id, success: true, data });',
      '  if (command.type === "prompt") {',
      '    appendFileSync("README.md", `${sentinel}\\n`);',
      '    writeFileSync(markerPath, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));',
      "    if (respondToPrompt) {",
      "      respond();",
      '      send({ type: "agent_start" });',
      "    }",
      '  } else if (command.type === "get_state") respond({ isStreaming: true, sessionFile: null });',
      "  else respond();",
      "});",
    ].join("\n"),
  );
}

async function exerciseParentDeath(killChildBeforeReload) {
  const repo = mkdtempSync(join(tmpdir(), killChildBeforeReload ? "crew-both-death-" : "crew-parent-death-"));
  const durabilitySession = mkdtempSync(join(tmpdir(), "crew-durability-session-"));
  const statePath = join(durabilitySession, "helpers.json");
  const markerPath = join(durabilitySession, "rpc-ready.json");
  const fakeRpcPath = join(repo, "durability-rpc.mjs");
  const parentHarnessPath = join(durabilitySession, "parent-harness.mjs");
  const sentinel = killChildBeforeReload ? "BOTH-DEATH-RECOVERED" : "PARENT-DEATH-RECOVERED";
  const repoGit = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let parent;
  let rpcPid;
  let orphanRoot;
  let orphanBranch;
  try {
    writeFileSync(join(repo, "README.md"), "# durability\n");
    writeKillRpc(fakeRpcPath, markerPath, sentinel, true);
    repoGit(["init", "-q"]);
    repoGit(["add", "-A"]);
    repoGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);

    writeFileSync(
      parentHarnessPath,
      [
        'import { writeFileSync } from "node:fs";',
        `import vinciCrew from ${JSON.stringify(pathToFileURL(resolve(here, "../extensions/vinci-crew.ts")).href)};`,
        `const statePath = ${JSON.stringify(statePath)};`,
        `process.argv[1] = ${JSON.stringify(fakeRpcPath)};`,
        "const entries = [];",
        "const tools = [];",
        "const handlers = {};",
        "const pi = {",
        '  on(name, handler) { (handlers[name] ??= []).push(handler); },',
        "  appendEntry(customType, data) {",
        '    entries.push({ type: "custom", customType, data });',
        '    writeFileSync(statePath, JSON.stringify(entries), { mode: 0o600 });',
        "  },",
        "  registerTool(tool) { tools.push(tool); },",
        "  registerCommand() {},",
        "  sendMessage() {},",
        "  sendUserMessage() {},",
        "};",
        "vinciCrew(pi);",
        "const ctx = {",
        `  cwd: ${JSON.stringify(repo)},`,
        '  model: { provider: "faux", id: "faux-model" },',
        "  sessionManager: {",
        "    getBranch: () => [],",
        `    getSessionDir: () => ${JSON.stringify(durabilitySession)},`,
        `    getSessionId: () => ${JSON.stringify(killChildBeforeReload ? "both-death" : "parent-death")},`,
        "  },",
        "  ui: {",
        '    theme: { fg: (_color, text) => text, bold: (text) => text },',
        "    notify() {},",
        "    setWidget() {},",
        "  },",
        "};",
        'for (const handler of handlers.session_start ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);',
        'await tools.find((tool) => tool.name === "spawn_helper").execute(',
        '  "durability",',
        `  { name: "durability", task: ${JSON.stringify(`append ${sentinel}`)} },`,
        "  undefined,",
        "  undefined,",
        "  ctx,",
        ");",
        "await new Promise(() => {});",
      ].join("\n"),
    );

    parent = spawn(process.execPath, ["--experimental-strip-types", parentHarnessPath], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let parentOutput = "";
    parent.stdout.on("data", (chunk) => {
      parentOutput += chunk;
    });
    parent.stderr.on("data", (chunk) => {
      parentOutput += chunk;
    });
    const parentExit = waitForExit(parent, 15_000);
    const marker = await waitForJson(markerPath, (value) => Number.isInteger(value?.pid) && typeof value?.cwd === "string", 10_000, parent);
    rpcPid = marker.pid;
    orphanRoot = marker.cwd;
    const branchList = repoGit(["branch", "--list", "vinci/helper-1-*"]).trim().split("\n").filter(Boolean);
    orphanBranch = branchList[0]?.trim().replace(/^\*\s*/, "");

    parent.kill("SIGKILL");
    const parentResult = await parentExit;
    assert.equal(parentResult.signal, "SIGKILL", parentOutput.slice(-4000));
    assert.ok(processIsAlive(rpcPid), "the RPC child must still be active when only the main process dies");

    let childKilledBeforeReload = false;
    if (killChildBeforeReload) {
      process.kill(rpcPid, "SIGKILL");
      await waitForProcessDeath(rpcPid, 5_000);
      childKilledBeforeReload = true;
    }
    const childAliveAtReload = processIsAlive(rpcPid);

    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    const reloadHandlers = {};
    const reloadEntries = [];
    const reloadPi = {
      on(name, handler) {
        (reloadHandlers[name] ??= []).push(handler);
      },
      appendEntry(customType, data) {
        reloadEntries.push({ customType, data });
      },
      registerTool() {},
      registerCommand() {},
      sendMessage() {},
      sendUserMessage() {},
    };
    crewExt.default(reloadPi);
    const reloadCtx = {
      cwd: repo,
      sessionManager: {
        getBranch: () => persisted,
        getSessionDir: () => durabilitySession,
        getSessionId: () => killChildBeforeReload ? "both-death" : "parent-death",
      },
      ui: {
        theme: { fg: (_color, text) => text, bold: (text) => text },
        notify() {},
        setWidget() {},
      },
    };
    for (const handler of reloadHandlers.session_start ?? []) {
      await handler({ type: "session_start", reason: "resume" }, reloadCtx);
    }
    const restored = reloadEntries
      .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 1)
      .at(-1)?.data;
    for (const handler of reloadHandlers.session_shutdown ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" });
    }
    return {
      parentSignal: parentResult.signal,
      childAliveAtReload,
      childKilledBeforeReload,
      restoredStatus: restored?.status,
      recoveredDiff: restored?.diffPath ? readFileSync(restored.diffPath, "utf8") : "",
      recoveredReason: restored?.reason ?? "",
      orphanRemoved: !existsSync(orphanRoot) && !repoGit(["branch", "--list", orphanBranch ?? "missing"]).trim(),
      sentinel,
    };
  } finally {
    await killSpawnedProcess(parent);
    if (rpcPid && processIsAlive(rpcPid)) {
      try {
        process.kill(rpcPid, "SIGKILL");
        await waitForProcessDeath(rpcPid, 5_000);
      } catch {
        // The final assertions below detect a surviving process through the recovered state.
      }
    }
    if (orphanRoot && existsSync(orphanRoot) && orphanBranch) {
      crew.removeCrewWorktree(repo, { root: orphanRoot, cwd: orphanRoot, branch: orphanBranch });
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(durabilitySession, { recursive: true, force: true });
  }
}

async function exerciseChildDeath() {
  const repo = mkdtempSync(join(tmpdir(), "crew-child-death-"));
  const durabilitySession = mkdtempSync(join(tmpdir(), "crew-child-death-session-"));
  const statePath = join(durabilitySession, "helpers.json");
  const markerPath = join(durabilitySession, "rpc-ready.json");
  const fakeRpcPath = join(repo, "child-death-rpc.mjs");
  const mainHarnessPath = join(durabilitySession, "main-harness.mjs");
  const repoGit = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let main;
  let rpcPid;
  let worktreeRoot;
  let worktreeBranch;
  try {
    writeFileSync(join(repo, "README.md"), "# child death\n");
    writeKillRpc(fakeRpcPath, markerPath, "CHILD-DEATH-PARTIAL", false);
    repoGit(["init", "-q"]);
    repoGit(["add", "-A"]);
    repoGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);

    writeFileSync(
      mainHarnessPath,
      [
        'import { writeFileSync } from "node:fs";',
        `import vinciCrew from ${JSON.stringify(pathToFileURL(resolve(here, "../extensions/vinci-crew.ts")).href)};`,
        `const statePath = ${JSON.stringify(statePath)};`,
        `process.argv[1] = ${JSON.stringify(fakeRpcPath)};`,
        "const entries = [];",
        "const tools = [];",
        "const handlers = {};",
        "const pi = {",
        '  on(name, handler) { (handlers[name] ??= []).push(handler); },',
        "  appendEntry(customType, data) {",
        '    entries.push({ type: "custom", customType, data });',
        '    writeFileSync(statePath, JSON.stringify(entries), { mode: 0o600 });',
        "  },",
        "  registerTool(tool) { tools.push(tool); },",
        "  registerCommand() {},",
        "  sendMessage() {},",
        "  sendUserMessage() {},",
        "};",
        "vinciCrew(pi);",
        "const ctx = {",
        `  cwd: ${JSON.stringify(repo)},`,
        '  model: { provider: "faux", id: "faux-model" },',
        "  sessionManager: {",
        "    getBranch: () => [],",
        `    getSessionDir: () => ${JSON.stringify(durabilitySession)},`,
        '    getSessionId: () => "child-death",',
        "  },",
        "  ui: {",
        '    theme: { fg: (_color, text) => text, bold: (text) => text },',
        "    notify() {},",
        "    setWidget() {},",
        "  },",
        "};",
        'for (const handler of handlers.session_start ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);',
        'await tools.find((tool) => tool.name === "spawn_helper").execute(',
        '  "child-death",',
        '  { name: "child-death", task: "write a partial change and remain active" },',
        "  undefined,",
        "  undefined,",
        "  ctx,",
        ");",
        "await new Promise(() => {});",
      ].join("\n"),
    );

    main = spawn(process.execPath, ["--experimental-strip-types", mainHarnessPath], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let mainOutput = "";
    main.stdout.on("data", (chunk) => {
      mainOutput += chunk;
    });
    main.stderr.on("data", (chunk) => {
      mainOutput += chunk;
    });
    const mainExit = waitForExit(main, 15_000);
    const marker = await waitForJson(markerPath, (value) => Number.isInteger(value?.pid) && typeof value?.cwd === "string", 10_000, main);
    rpcPid = marker.pid;
    worktreeRoot = marker.cwd;
    worktreeBranch = repoGit(["branch", "--list", "vinci/helper-1-*"]).trim().replace(/^\*\s*/, "");

    process.kill(rpcPid, "SIGKILL");
    // The child had already appended its sentinel before dying, so the helper must terminalize as
    // `waiting` with that partial work preserved — not `failed` with the edit thrown away.
    const preservedEntries = await waitForJson(
      statePath,
      (entries) =>
        entries.some(
          (entry) =>
            entry.customType === "vinci-crew-helper" &&
            entry.data?.status === "waiting" &&
            /SIGKILL/.test(entry.data?.error ?? ""),
        ),
      10_000,
      main,
    );
    await waitForProcessDeath(rpcPid, 5_000);
    await waitForCondition(
      () => !existsSync(worktreeRoot) && !repoGit(["branch", "--list", worktreeBranch]).trim(),
      "the failed child's worktree teardown",
      10_000,
    );
    const mainSurvivedChildDeath = main.exitCode === null && main.signalCode === null;
    const preserved = preservedEntries
      .filter((entry) => entry.customType === "vinci-crew-helper")
      .at(-1)?.data;
    // Read the saved patch from disk: it must outlive the worktree that the teardown below removes.
    const preservedDiff =
      preserved?.diffPath && existsSync(preserved.diffPath) ? readFileSync(preserved.diffPath, "utf8") : "";

    main.kill("SIGKILL");
    const mainResult = await mainExit;
    assert.equal(mainResult.signal, "SIGKILL", mainOutput.slice(-4000));
    return {
      mainSurvivedChildDeath,
      preserved,
      preservedDiff,
      worktreeRemoved: !existsSync(worktreeRoot) && !repoGit(["branch", "--list", worktreeBranch]).trim(),
    };
  } finally {
    await killSpawnedProcess(main);
    if (rpcPid && processIsAlive(rpcPid)) {
      try {
        process.kill(rpcPid, "SIGKILL");
        await waitForProcessDeath(rpcPid, 5_000);
      } catch {
        // The returned cleanup assertion reports this path.
      }
    }
    if (worktreeRoot && existsSync(worktreeRoot) && worktreeBranch) {
      crew.removeCrewWorktree(repo, {
        root: worktreeRoot,
        cwd: worktreeRoot,
        branch: worktreeBranch,
      });
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(durabilitySession, { recursive: true, force: true });
  }
}

try {
  check("Crew exposes child usage accounting for integration coverage", typeof crewExt.accountHelperUsage === "function");
  if (typeof crewExt.accountHelperUsage === "function") {
    const accountingHelper = { id: 99, name: "accounting", task: "account usage", status: "done" };
    let accountingAttempts = 0;
    const accountingWarnings = [];
    const originalConsoleWarn = console.warn;
    console.warn = (message) => accountingWarnings.push(String(message));
    try {
      await crewExt.accountHelperUsage(
        {
          async getEntries() {
            accountingAttempts++;
            throw new Error("child entry stream unavailable");
          },
        },
        { sessionManager: { getSessionId: () => "crew-accounting-test" } },
        accountingHelper,
      );
    } finally {
      console.warn = originalConsoleWarn;
    }
    check("Crew bounds failed child usage reads at three retries", accountingAttempts === 4);
    check(
      "Crew explicitly warns when child usage cannot be accounted",
      accountingWarnings.some((warning) => /unable to account.*after 3 retry attempts/i.test(warning)),
    );
    check("Crew does not mark failed child accounting complete", accountingHelper.usageAccounted !== true);

    const successfulAccountingHelper = {
      id: 100,
      name: "accounting-success",
      task: "account usage",
      status: "done",
    };
    const childUsage = {
      modelCalls: 2,
      inputTokens: 40,
      outputTokens: 8,
      cachedTokens: 4,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      estimatedCostUsd: 0.03,
      providers: ["vinci"],
      models: ["vinci-forte"],
    };
    await crewExt.accountHelperUsage(
      {
        async getEntries() {
          return {
            entries: [{
              type: "custom",
              customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
              data: {
                schemaVersion: 1,
                taskId: "child-accounting-test",
                state: "DONE",
                reason: "Done.",
                changedFiles: [],
                verificationStatus: "none",
                verificationCommand: "",
                usage: childUsage,
                recordedAt: "2026-07-25T00:00:00.000Z",
              },
            }],
          };
        },
        async getMessages() {
          throw new Error("durable outcome usage should win");
        },
      },
      { sessionManager: { getSessionId: () => "crew-accounting-test" } },
      successfulAccountingHelper,
    );
    check(
      "Crew marks usage accounted only after a successful durable read and recording",
      successfulAccountingHelper.usageAccounted === true &&
        successfulAccountingHelper.childUsage?.estimatedCostUsd === 0.03,
    );
  }

  const staleTempCopy = mkdtempSync(join(tmpdir(), "vinci-agent-gc-old-"));
  const freshTempCopy = mkdtempSync(join(tmpdir(), "vinci-agent-gc-fresh-"));
  try {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(staleTempCopy, oldTime, oldTime);
    const sweep = crew.sweepStaleTempCopies();
    check("stale temp-copy sweep removes workspaces older than 24 hours", sweep.removed >= 1 && !existsSync(staleTempCopy));
    check("stale temp-copy sweep preserves fresh workspaces", existsSync(freshTempCopy));
  } finally {
    rmSync(staleTempCopy, { recursive: true, force: true });
    rmSync(freshTempCopy, { recursive: true, force: true });
  }

  writeFileSync(join(base, "README.md"), "# demo\n");
  writeFileSync(
    join(base, "verify.mjs"),
    'import { readFileSync } from "node:fs";\nconst text = readFileSync("README.md", "utf8");\nif (!text.includes("HELPER-WAS-HERE") || text.includes("BROKEN")) process.exit(1);\nconsole.log("1 test passed");\n',
  );
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);

  writeFileSync(join(base, "README.md"), "# demo\n\nMAIN-DIRTY\n");
  writeFileSync(join(base, "notes.txt"), "MAIN-UNTRACKED\n");
  const helper = crew.createCrewWorktree(base, "1", "test");
  worktrees.push(helper);
  check("helper sees the caller's dirty tracked state", readFileSync(join(helper.root, "README.md"), "utf8").includes("MAIN-DIRTY"));
  check("helper sees safe untracked files", readFileSync(join(helper.root, "notes.txt"), "utf8") === "MAIN-UNTRACKED\n");

  writeFileSync(join(helper.root, "README.md"), "# demo\n\nMAIN-DIRTY\nHELPER-WAS-HERE\n");
  writeFileSync(join(helper.root, "notes.txt"), "MAIN-UNTRACKED\nHELPER-NOTE\n");
  writeFileSync(join(helper.root, "new.txt"), "new helper file\n");
  const patch = crew.captureCrewPatch(helper);
  check("captures helper edits", /\+HELPER-WAS-HERE/.test(patch.diff));
  check("captures helper-created files", /new file mode.*new\.txt/s.test(patch.diff));
  check("does not claim the caller's dirty line as a helper addition", !/^\+MAIN-DIRTY$/m.test(patch.diff));
  check(
    "does not claim the caller's untracked file as helper-created",
    !/diff --git a\/notes\.txt b\/notes\.txt\nnew file mode/.test(patch.diff),
  );
  check("main stays untouched while helper works", !readFileSync(join(base, "README.md"), "utf8").includes("HELPER-WAS-HERE"));
  check("main paths still match the helper baseline", crew.crewPathsUnchanged(base, patch));
  check("ordinary source patch is eligible for automatic validation", !crew.isConsequentialCrewPatch(patch));

  const validation = crew.createCrewWorktree(base, "validation", "test");
  worktrees.push(validation);
  crew.applyCrewPatch(validation.cwd, patch.diff);
  const verified = crew.runCrewVerifier(validation, "node verify.mjs");
  check("exact verifier passes in a disposable integration worktree", verified.passed && /1 test passed/.test(verified.output));
  crew.removeCrewWorktree(base, validation);
  worktrees.splice(worktrees.indexOf(validation), 1);

  crew.applyCrewPatch(base, patch.diff);
  check("validated patch lands in main", readFileSync(join(base, "README.md"), "utf8").includes("HELPER-WAS-HERE"));
  check("validated helper-created file lands in main", readFileSync(join(base, "new.txt"), "utf8") === "new helper file\n");
  crew.removeCrewWorktree(base, helper);
  worktrees.splice(worktrees.indexOf(helper), 1);

  git(["add", "-A"]);
  git(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "land helper"]);
  const stale = crew.createCrewWorktree(base, "stale", "test");
  worktrees.push(stale);
  writeFileSync(join(stale.root, "README.md"), `${readFileSync(join(stale.root, "README.md"), "utf8")}STALE-HELPER\n`);
  const stalePatch = crew.captureCrewPatch(stale);
  writeFileSync(join(base, "README.md"), `${readFileSync(join(base, "README.md"), "utf8")}MAIN-CONCURRENT\n`);
  check("concurrent main edits make helper paths stale", !crew.crewPathsUnchanged(base, stalePatch));
  check("stale helper change was not applied", !readFileSync(join(base, "README.md"), "utf8").includes("STALE-HELPER"));
  crew.removeCrewWorktree(base, stale);
  worktrees.splice(worktrees.indexOf(stale), 1);

  const failing = crew.createCrewWorktree(base, "failing", "test");
  worktrees.push(failing);
  writeFileSync(join(failing.root, "README.md"), `${readFileSync(join(failing.root, "README.md"), "utf8")}BROKEN\n`);
  const failingPatch = crew.captureCrewPatch(failing);
  const failingValidation = crew.createCrewWorktree(base, "failing-validation", "test");
  worktrees.push(failingValidation);
  crew.applyCrewPatch(failingValidation.cwd, failingPatch.diff);
  check("failed verifier rejects integration", !crew.runCrewVerifier(failingValidation, "node verify.mjs").passed);
  check("failed verifier leaves main unchanged", !readFileSync(join(base, "README.md"), "utf8").includes("BROKEN"));
  crew.removeCrewWorktree(base, failingValidation);
  worktrees.splice(worktrees.indexOf(failingValidation), 1);
  crew.removeCrewWorktree(base, failing);
  worktrees.splice(worktrees.indexOf(failing), 1);

  const deletion = crew.createCrewWorktree(base, "deletion", "test");
  worktrees.push(deletion);
  unlinkSync(join(deletion.root, "new.txt"));
  check("deletions require user review", crew.isConsequentialCrewPatch(crew.captureCrewPatch(deletion)));
  crew.removeCrewWorktree(base, deletion);
  worktrees.splice(worktrees.indexOf(deletion), 1);

  // Non-Git projects (a plain website folder) are now supported via a bounded temp-copy workspace
  // — Vinci Agents Phase 1 — instead of failing closed. Round-trip an edit through the copy.
  writeFileSync(join(outside, "page.html"), "<h1>hi</h1>\n");
  writeFileSync(join(outside, ".env"), "SECRET=original\n");
  writeFileSync(join(outside, ".gitignore"), ".env\n"); // .env is gitignored, yet must still be seeded
  const nonRepo = crew.createCrewWorktree(outside, "nonrepo", "test");
  worktrees.push(nonRepo);
  check("non-Git project gets an isolated temp-copy workspace", nonRepo.kind === "temp-copy");
  check("temp-copy workspace is outside the project folder", !nonRepo.cwd.startsWith(outside));
  check("gitignored .env is still seeded so the project can run", readFileSync(join(nonRepo.cwd, ".env"), "utf8").includes("SECRET=original"));
  writeFileSync(join(nonRepo.cwd, "page.html"), "<h1>edited</h1>\n");
  writeFileSync(join(nonRepo.cwd, ".env"), "SECRET=leaked\n"); // an agent edit to .env inside the copy
  const nonRepoPatch = crew.captureCrewPatch(nonRepo);
  check("temp-copy has no stale main-folder paths before apply", crew.crewPathsUnchanged(outside, nonRepoPatch));
  crew.applyCrewPatch(outside, nonRepoPatch.diff);
  check("temp-copy applies its edit back to the main folder", readFileSync(join(outside, "page.html"), "utf8").includes("edited"));
  check("seed-only .env is never written back to the real project", readFileSync(join(outside, ".env"), "utf8").includes("SECRET=original"));
  crew.removeCrewWorktree(outside, nonRepo);
  worktrees.splice(worktrees.indexOf(nonRepo), 1);
  check("compound verifier commands are rejected", crew.parseVerifierInvocation("npm test && rm -rf .", base) === null);
  check("verifier cd cannot escape the isolated checkout", crew.parseVerifierInvocation("cd ../outside && npm test", base) === null);
  check("one safe verifier subdirectory is supported", crew.parseVerifierInvocation("cd . && node verify.mjs", base)?.executable === "node");

  // Auto-integration must not bless a tree the helper's verifier never saw (audit P1-2). The
  // baseline revision is captured before verification/review begin; recordCrewIntegrationOutcome
  // is the exact function the live apply path records through (asserted against the source below).
  state.resetVinciVerificationState();
  const cleanBaseline = state.getVinciVerificationState().mutationRevision;
  const clean = crewExt.recordCrewIntegrationOutcome(cleanBaseline, {
    command: "node verify.mjs",
    summary: "1 test passed",
    checkClass: "behavioral",
    commandKey: "node verify.mjs",
  });
  check(
    "integration with no concurrent main edits records the helper's verification as passed",
    !clean.mainEditedDuringIntegration &&
      clean.state.status === "passed" &&
      clean.state.command === "node verify.mjs" &&
      clean.state.checkClass === "behavioral" &&
      clean.state.commandKey === "node verify.mjs",
  );
  check("clean integration marks the applied revision itself as verified", clean.state.verifiedRevision === clean.state.mutationRevision);

  state.resetVinciVerificationState();
  const reviewBaseline = state.getVinciVerificationState().mutationRevision;
  state.recordVinciMutation(); // the MAIN session edits while the helper is still under review
  const raced = crewExt.recordCrewIntegrationOutcome(reviewBaseline, {
    command: "node verify.mjs",
    summary: "1 test passed",
    checkClass: "behavioral",
    commandKey: "node verify.mjs",
  });
  check(
    "a main-session mutation during review downgrades the apply to mutation-only (stale, not passed)",
    raced.mainEditedDuringIntegration && raced.state.status === "stale" && raced.state.status !== "passed",
  );
  check(
    "no verification command is recorded for the unreviewed combined revision",
    raced.state.verifiedRevision !== raced.state.mutationRevision && raced.state.command === "",
  );
  state.resetVinciVerificationState();

  // Crew proof extraction uses the shared incomplete-attempt predicate: a lower static pass cannot
  // auto-integrate after a behavioral runner was denied or failed to execute.
  state.recordVinciMutation();
  state.recordVinciVerification("pnpm typecheck", true, "types pass", false, "static", "pnpm typecheck");
  state.recordVinciVerificationAttempt("pnpm test", "behavioral");
  const incompleteProof = crewExt.verificationProof([
    { type: "custom", customType: state.VINCI_VERIFICATION_ENTRY, data: { ...state.getVinciVerificationState() } },
  ]);
  check("Crew rejects a passing static snapshot with an incomplete behavioral attempt", incompleteProof === undefined);

  state.resetVinciVerificationState();
  state.recordVinciMutation();
  state.recordVinciVerification("pnpm test --filter app", true, "18 tests passed", false, "behavioral", "pnpm test --filter app");
  const behavioralProof = crewExt.verificationProof([
    { type: "custom", customType: state.VINCI_VERIFICATION_ENTRY, data: { ...state.getVinciVerificationState() } },
  ]);
  check(
    "Crew proof preserves the validated verifier class and command key",
    behavioralProof?.checkClass === "behavioral" && behavioralProof.commandKey === "pnpm test --filter app",
  );

  // A helper's no-cd proof is bound to its private worktree. Integration must transfer that proof
  // to the main session's effective directory so the removed helper cwd cannot strand the latch.
  const helperCwd = join(base, ".vinci-helper-proof");
  state.resetVinciVerificationState();
  state.recordVinciMutation();
  state.recordVinciVerification(
    "pnpm test --filter app",
    true,
    "18 tests passed",
    false,
    "behavioral",
    "pnpm test --filter app",
    true,
    helperCwd,
  );
  const cwdBoundProof = crewExt.verificationProof([
    { type: "custom", customType: state.VINCI_VERIFICATION_ENTRY, data: { ...state.getVinciVerificationState() } },
  ]);
  const transferBaseline = state.getVinciVerificationState().mutationRevision;
  const transferred = crewExt.recordCrewIntegrationOutcome(transferBaseline, cwdBoundProof, base);
  check(
    "Crew rewrites a helper's cwd-bound proof to the integrating session directory",
    cwdBoundProof?.commandCwd === helperCwd &&
      transferred.state.status === "passed" &&
      transferred.state.commandCwd === base,
  );
  state.recordVinciVerification(
    "pnpm test --filter app",
    false,
    "1 test failed",
    false,
    "behavioral",
    "pnpm test --filter app",
    true,
    base,
  );
  state.recordVinciVerification(
    "pnpm test --filter app",
    true,
    "18 tests passed",
    false,
    "behavioral",
    "pnpm test --filter app",
    true,
    base,
  );
  check("the transferred proof remains clearable in the main directory", state.getVinciVerificationState().status === "passed");
  state.resetVinciVerificationState();

  const parentDeath = await exerciseParentDeath(false);
  check(
    "SIGKILL of the main process reloads and salvages the active helper's orphaned worktree",
    parentDeath.parentSignal === "SIGKILL" &&
      parentDeath.childAliveAtReload &&
      parentDeath.restoredStatus === "waiting" &&
      parentDeath.recoveredDiff.includes(parentDeath.sentinel) &&
      /recovered from its orphaned worktree/.test(parentDeath.recoveredReason) &&
      parentDeath.orphanRemoved,
  );

  const bothDeath = await exerciseParentDeath(true);
  check(
    "SIGKILL of both the main process and RPC child still reloads and salvages the orphaned worktree",
    bothDeath.parentSignal === "SIGKILL" &&
      bothDeath.childKilledBeforeReload &&
      !bothDeath.childAliveAtReload &&
      bothDeath.restoredStatus === "waiting" &&
      bothDeath.recoveredDiff.includes(bothDeath.sentinel) &&
      /recovered from its orphaned worktree/.test(bothDeath.recoveredReason) &&
      bothDeath.orphanRemoved,
  );

  const childDeath = await exerciseChildDeath();
  // Regression: this path used to discard the child's work. runHelper captured a patch only on the
  // success path, so when promptAndWait rejected, `finally` removed the worktree and the edits went
  // with it. The partial patch is now captured in the catch, before teardown.
  check(
    "SIGKILL of the RPC child preserves the partial patch for review instead of discarding it",
    childDeath.mainSurvivedChildDeath &&
      childDeath.preserved?.status === "waiting" &&
      /SIGKILL/.test(childDeath.preserved.error ?? "") &&
      Boolean(childDeath.preserved.diffPath) &&
      childDeath.preservedDiff.includes("CHILD-DEATH-PARTIAL") &&
      childDeath.worktreeRemoved,
  );

  // Keep the narrow restore-path fixture as a unit-level complement to the real SIGKILL scenarios
  // above. It covers the patchless sibling and undelivered-result branches in one restored session.
  const orphan = crew.createCrewWorktree(base, "7", "dead");
  worktrees.push(orphan);
  writeFileSync(join(orphan.root, "README.md"), `${readFileSync(join(orphan.root, "README.md"), "utf8")}ORPHAN-RECOVERED\n`);
  const crewHandlers = {};
  const crewEntries = [];
  const crewTools = [];
  const crewCommands = new Map();
  const crewNotifications = [];
  const crewDeliveries = [];
  const crewPi = {
    on(name, handler) {
      (crewHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      crewEntries.push({ customType, data });
    },
    registerTool(tool) {
      crewTools.push(tool);
    },
    registerCommand(name, command) {
      crewCommands.set(name, command);
    },
    sendMessage(message, options) {
      crewDeliveries.push({ message, options });
    },
    sendUserMessage() {},
  };
  crewExt.default(crewPi);
  const crewCtx = {
    cwd: base,
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: "vinci-crew-helper", data: { id: 7, name: "orphaned", task: "edit the README", status: "working" } },
        { type: "custom", customType: "vinci-crew-helper", data: { id: 8, name: "patchless", task: "never produced work", status: "working" } },
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: { id: 9, name: "restore-undelivered", task: "report after resume", status: "failed", finishedAt: Date.now() - 1000 },
        },
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: {
            id: 10,
            name: "malformed-honesty",
            task: "restore malformed honesty",
            status: "working",
            attestation: "attested",
            deviations: "not-an-array",
            deferred: [],
            omitted: { deviations: 0, deferred: 0 },
          },
        },
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: {
            id: 11,
            name: "invalid-attestation",
            task: "restore invalid attestation",
            status: "working",
            attestation: "invalid-string",
            deviations: [],
            deferred: [],
            omitted: { deviations: 0, deferred: 0 },
          },
        },
      ],
      getSessionDir: () => sessionDir,
      getSessionId: () => "crew-restore-test",
    },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      notify(message, level) {
        crewNotifications.push({ message, level });
      },
      setWidget() {},
    },
  };
  for (const handler of crewHandlers.session_start ?? []) await handler({ type: "session_start", reason: "resume" }, crewCtx);
  const restored7 = crewEntries.filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 7).at(-1);
  check("interrupted 'working' helper with a surviving worktree is restored as waiting", restored7?.data.status === "waiting");
  check(
    "the recovered patch carries the orphaned helper's real work",
    !!restored7?.data.diffPath && /\+ORPHAN-RECOVERED/.test(readFileSync(restored7.data.diffPath, "utf8")),
  );
  check("the recovered helper explains the harvest", /recovered from its orphaned worktree/.test(restored7?.data.reason ?? ""));
  check("the orphaned worktree branch is cleaned up after the harvest", !git(["branch", "--list", "vinci/helper-7-dead"]).trim());
  check(
    "an interrupted helper with no surviving worktree keeps today's blocked-no-patch behavior",
    crewEntries.some(
      (entry) =>
        entry.data?.id === 8 &&
        entry.data.status === "blocked" &&
        /before it produced a patch/.test(entry.data.reason ?? ""),
    ),
  );
  const restoredMalformedHonesty = crewEntries
    .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 10)
    .at(-1)?.data;
  const restoredInvalidAttestation = crewEntries
    .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 11)
    .at(-1)?.data;
  check(
    "malformed persisted honesty resets atomically on restore",
    restoredMalformedHonesty?.attestation === "missing" &&
      JSON.stringify(restoredMalformedHonesty.deviations) === "[]" &&
      JSON.stringify(restoredMalformedHonesty.deferred) === "[]" &&
      JSON.stringify(restoredMalformedHonesty.omitted) === JSON.stringify({ deviations: 0, deferred: 0 }),
  );
  check(
    "an invalid persisted attestation string resets all honesty on restore",
    restoredInvalidAttestation?.attestation === "missing" &&
      JSON.stringify(restoredInvalidAttestation.deviations) === "[]" &&
      JSON.stringify(restoredInvalidAttestation.deferred) === "[]" &&
      JSON.stringify(restoredInvalidAttestation.omitted) === JSON.stringify({ deviations: 0, deferred: 0 }),
  );

  // Print mode exits immediately after the main answer, so session_shutdown must keep the process
  // alive long enough for both running and capacity-queued agents to finish instead of stopping
  // their RPC children and preserving only partial work.
  writeFileSync(join(printRepo, "README.md"), "# print mode\n");
  const printGit = (args) =>
    execFileSync("git", args, { cwd: printRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  printGit(["init", "-q"]);
  printGit(["add", "README.md"]);
  printGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);
  const fakeRpcPath = join(printRepo, "fake-rpc-agent.mjs");
  writeFileSync(
    fakeRpcPath,
    [
      'import { appendFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      "let streaming = false;",
      "let completed = 0;",
      'const assistant = { role: "assistant", content: [{ type: "text", text: "finished" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };',
      'const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const command = JSON.parse(line);",
      '  const respond = (data = {}) => send({ type: "response", id: command.id, success: true, data });',
      '  if (command.type === "prompt") {',
      "    streaming = true;",
      "    respond();",
      "    setTimeout(() => {",
      '      appendFileSync("README.md", `agent-${++completed} finished\\n`);',
      "      streaming = false;",
      '      send({ type: "message_end", message: assistant });',
      '      send({ type: "agent_end", messages: [assistant] });',
      "    }, 100);",
      '  } else if (command.type === "get_state") respond({ isStreaming: streaming, sessionFile: null });',
      '  else if (command.type === "get_session_stats") respond({ tokens: { total: 2 } });',
      '  else if (command.type === "get_last_assistant_text") respond({ text: "finished" });',
      '  else if (command.type === "get_messages") respond({ messages: [assistant] });',
      '  else if (command.type === "get_entries") respond({ entries: [], leafId: null });',
      "  else respond();",
      "});",
    ].join("\n"),
  );
  printGit(["add", "fake-rpc-agent.mjs"]);
  printGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "fake rpc"]);

  const printHandlers = {};
  const printTools = [];
  const printEntries = [];
  const printPi = {
    on(name, handler) {
      (printHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      printEntries.push({ customType, data });
    },
    registerTool(tool) {
      printTools.push(tool);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  crewExt.default(printPi);
  const printCtx = {
    cwd: printRepo,
    mode: "print",
    model: { provider: "faux", id: "faux-model" },
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => sessionDir,
      getSessionId: () => "print-mode-test",
    },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      notify() {},
      setWidget() {},
    },
  };
  const originalCliPath = process.argv[1];
  const originalCapacity = process.env.VINCI_CREW_CAPACITY;
  process.argv[1] = fakeRpcPath;
  process.env.VINCI_CREW_CAPACITY = "1";
  try {
    for (const handler of printHandlers.session_start ?? []) {
      await handler({ type: "session_start", reason: "startup" }, printCtx);
    }
    const spawnHelper = printTools.find((tool) => tool.name === "spawn_helper");
    await spawnHelper.execute("print-1", { name: "first", task: "append the first line" }, undefined, undefined, printCtx);
    await spawnHelper.execute("print-2", { name: "second", task: "append the second line" }, undefined, undefined, printCtx);
    for (const handler of printHandlers.session_shutdown ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" });
    }
  } finally {
    process.argv[1] = originalCliPath;
    if (originalCapacity === undefined) delete process.env.VINCI_CREW_CAPACITY;
    else process.env.VINCI_CREW_CAPACITY = originalCapacity;
  }
  const printResults = new Map();
  for (const entry of printEntries) {
    if (entry.customType === "vinci-crew-helper") printResults.set(entry.data.id, entry.data);
  }
  check(
    "print-mode shutdown waits for running and queued agents to finish",
    printResults.size === 2 &&
      [...printResults.values()].every(
        (result) =>
          result.status === "waiting" &&
          typeof result.diffPath === "string" &&
          readFileSync(result.diffPath, "utf8").includes("agent-1 finished"),
      ),
  );

  const messageTool = crewTools.find((tool) => tool.name === "message_agent");
  // agent_id is deliberately OPTIONAL: when the user's reference is ambiguous the model must omit it
  // and let Vinci ask which agent, rather than guessing an id and steering the wrong one.
  check(
    "message_agent registers message as required and agent_id as optional so ambiguity is asked about",
    messageTool?.parameters?.properties?.agent_id?.type === "number" &&
      messageTool?.parameters?.properties?.message?.type === "string" &&
      messageTool.parameters.properties.message.minLength === 1 &&
      messageTool.parameters.properties.message.maxLength === 4000 &&
      messageTool.parameters.properties.message.pattern === "\\S" &&
      !messageTool.parameters.required?.includes("agent_id") &&
      messageTool.parameters.required?.includes("message"),
  );

  class FakeRpc {
    constructor(streaming) {
      this.streaming = streaming;
      this.steered = [];
    }
    async getState() {
      return { isStreaming: this.streaming };
    }
    async steer(message) {
      this.steered.push(message);
    }
  }
  const fakeRpc = new FakeRpc(true);
  const runningHelper = { id: 11, name: "tests", task: "add tests", status: "working", client: fakeRpc };
  const accepted = await crewExt.messageRunningAgent(runningHelper, "  cover the race  ");
  check("message is accepted while the agent is actively streaming and delivered via steer", accepted === "Sent to tests" && fakeRpc.steered[0] === "cover the race");
  const emptyRejection = await crewExt.messageRunningAgent(runningHelper, " \t\n ");
  check(
    "empty agent messages are rejected with a model-actionable instruction",
    emptyRejection === "Give the agent a non-empty instruction." && fakeRpc.steered.length === 1,
  );
  const longRejection = await crewExt.messageRunningAgent(runningHelper, "x".repeat(4001));
  check(
    "agent messages over 4000 characters are rejected at runtime",
    longRejection === "Keep the agent instruction to 4000 characters or fewer." && fakeRpc.steered.length === 1,
  );
  const nullAgentRejection = await crewExt.messageRunningAgent(null, "cover the missing helper");
  check(
    "a null agent is rejected without attempting an RPC state read",
    nullAgentRejection === "That agent isn't running — you can't message it right now" && fakeRpc.steered.length === 1,
  );

  fakeRpc.streaming = true;
  fakeRpc.states = [true, false, false];
  const originalGetState = fakeRpc.getState.bind(fakeRpc);
  fakeRpc.getState = async () => {
    if (fakeRpc.states.length) fakeRpc.streaming = fakeRpc.states.shift();
    return originalGetState();
  };
  let capturedWhileStreaming;
  const settledAfterSteer = await crewExt.waitForSteeredHelperIdle(fakeRpc, 100, 1);
  if (settledAfterSteer) capturedWhileStreaming = fakeRpc.streaming;
  check(
    "a messaged helper is captured only after two idle checks skip the post-agent_end streaming gap",
    runningHelper.messagedDuringRun === true && settledAfterSteer && capturedWhileStreaming === false,
  );
  fakeRpc.streaming = false;
  const idleRejection = await crewExt.messageRunningAgent(runningHelper, "too late");
  runningHelper.status = "done";
  const doneRejection = await crewExt.messageRunningAgent(runningHelper, "also too late");
  check(
    "message is rejected at the idle/completed boundary",
    idleRejection === "That agent isn't running — you can't message it right now" &&
      doneRejection === "That agent isn't running — you can't message it right now" &&
      fakeRpc.steered.length === 1,
  );

  // ── Disambiguation: ask which agent instead of guessing an id ────────────────────────────────
  {
    const anyAgent = () => true;
    const pickerCtx = (choice) => {
      const asked = [];
      return {
        asked,
        ctx: {
          hasUI: true,
          ui: {
            select(question, options) {
              asked.push({ question, options });
              return typeof choice === "number" ? options[choice] : choice;
            },
          },
        },
      };
    };
    const a = { id: 3, name: "parser", status: "working" };
    const b = { id: 7, name: "readme", status: "working" };

    const solo = pickerCtx(0);
    const soloTarget = await crewExt.resolveAgentTarget(solo.ctx, [a], undefined, anyAgent, "Which?", "none");
    check(
      "a single candidate is used without asking the user anything",
      soloTarget.helper === a && solo.asked.length === 0,
    );

    const many = pickerCtx(1);
    const manyTarget = await crewExt.resolveAgentTarget(many.ctx, [a, b], undefined, anyAgent, "Which agent?", "none");
    check(
      "an ambiguous reference opens a picker and uses the agent the user chose",
      manyTarget.helper === b &&
        many.asked.length === 1 &&
        many.asked[0].question === "Which agent?" &&
        many.asked[0].options.length === 2 &&
        many.asked[0].options[0].includes("parser"),
    );

    const explicit = pickerCtx(0);
    const explicitTarget = await crewExt.resolveAgentTarget(explicit.ctx, [a, b], 7, anyAgent, "Which?", "none");
    check(
      "an explicit id names its agent directly and never opens a picker",
      explicitTarget.helper === b && explicit.asked.length === 0,
    );

    // Regression: a bad id used to fall through to the candidate list, and with a single candidate
    // it silently acted on that one instead — asking for agent 99 would steer agent 3.
    const wrongId = pickerCtx(0);
    const wrongIdTarget = await crewExt.resolveAgentTarget(wrongId.ctx, [a], 99, anyAgent, "Which?", "none");
    check(
      "an id that matches no agent is reported as wrong, never silently retargeted",
      !wrongIdTarget.helper && /No agent with id 99/.test(wrongIdTarget.error ?? "") && wrongId.asked.length === 0,
    );

    const wrongIdMany = pickerCtx(0);
    const wrongIdManyTarget = await crewExt.resolveAgentTarget(wrongIdMany.ctx, [a, b], 99, anyAgent, "Which?", "none");
    check(
      "a bad id does not open a picker either — the id was the mistake, not the ambiguity",
      !wrongIdManyTarget.helper && wrongIdMany.asked.length === 0,
    );

    const cancelled = pickerCtx(undefined);
    const cancelledTarget = await crewExt.resolveAgentTarget(cancelled.ctx, [a, b], undefined, anyAgent, "Which?", "none");
    check(
      "declining the picker acts on no agent at all",
      Boolean(cancelledTarget.error) && !cancelledTarget.helper,
    );

    const headless = await crewExt.resolveAgentTarget(
      { hasUI: false, ui: {} },
      [a, b],
      undefined,
      anyAgent,
      "Which?",
      "none",
    );
    check(
      "with no way to ask, an ambiguous reference refuses and names the candidates rather than guessing",
      Boolean(headless.error) && headless.error.includes("parser") && headless.error.includes("readme") && !headless.helper,
    );

    const empty = await crewExt.resolveAgentTarget(pickerCtx(0).ctx, [], undefined, anyAgent, "Which?", "nothing to do");
    check("no eligible agents reports the caller's own plain-language reason", empty.error === "nothing to do");
  }

  const liveViewHelper = { id: 12, name: "live", task: "stream", status: "working" };
  crewExt.reduceHelperEvent(liveViewHelper, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "old partial" }] },
    assistantMessageEvent: { type: "text_delta", delta: "old partial" },
  });
  crewExt.reduceHelperEvent(liveViewHelper, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "replacement partial" }] },
    assistantMessageEvent: { type: "text_delta", delta: "replacement partial" },
  });
  check(
    "live message_update replaces the full partial instead of appending",
    liveViewHelper.livePartial?.join("\n") === "replacement partial" && !liveViewHelper.livePartial.join("\n").includes("old partial"),
  );

  const childSecret = "sk-proj-Abcd123456789012345678901234";
  crewExt.reduceHelperEvent(liveViewHelper, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: `child token: ${childSecret}` }] },
    assistantMessageEvent: { type: "text_delta", delta: childSecret },
  });
  const maskedViewerLines = crewExt.viewerTranscriptLines(liveViewHelper).join("\n");
  check(
    "token-shaped child text is masked in the viewer's produced lines",
    maskedViewerLines.includes("‹redacted›") && !maskedViewerLines.includes(childSecret),
  );

  let viewerClosed = false;
  let selectCount = 0;
  const viewerTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const viewerCtx = {
    ...crewCtx,
    ui: {
      theme: viewerTheme,
      notify() {},
      setWidget() {},
      async select(_title, options) {
        selectCount++;
        return options[0];
      },
      custom(factory) {
        return new Promise((resolveViewer) => {
          factory({ requestRender() {} }, viewerTheme, undefined, (value) => {
            viewerClosed = true;
            resolveViewer(value);
          });
        });
      },
    },
  };
  const viewerPromise = crewCommands.get("agents").handler("", viewerCtx);
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  check("agent viewer remains open until explicitly closed or the session shuts down", selectCount === 2 && !viewerClosed);
  for (const handler of crewHandlers.session_shutdown ?? []) await handler({ type: "session_shutdown", reason: "reload" });
  await viewerPromise;
  check("session shutdown closes the active agent viewer promise", viewerClosed);

  const fakeListeners = [];
  const fakeEventRpc = {
    onEvent(listener) {
      fakeListeners.push(listener);
    },
    emit(event) {
      try {
        for (const listener of fakeListeners) listener(event);
      } catch {
        // Mirrors RpcClient.handleLine(): one shared try around all listeners.
      }
    },
  };
  let laterListenerSawEdge = false;
  let completionCollected = false;
  const isolatedHelper = {
    id: 13,
    name: "isolated",
    task: "finish",
    status: "working",
    viewerRepaint() {
      throw new Error("dead viewer");
    },
  };
  fakeEventRpc.onEvent((event) => crewExt.reduceHelperEvent(isolatedHelper, event));
  fakeEventRpc.onEvent((event) => {
    if (event.type === "message_end") laterListenerSawEdge = true;
    if (event.type === "agent_end") completionCollected = true;
  });
  fakeEventRpc.emit({
    type: "message_end",
    get message() {
      throw new Error("malformed reducer input");
    },
  });
  fakeEventRpc.emit({ type: "agent_end", messages: [] });
  check(
    "throwing reducer input and repaint callback do not suppress the completion collector",
    laterListenerSawEdge && completionCollected,
  );

  const envelope = crewExt.buildAgentResult(
    {
      id: 14,
      name: "envelope",
      task: "return typed data",
      status: "integrated",
      summary: "implemented",
      verification: {
        command: "node verify.mjs",
        summary: "1 test passed",
        mutationRevision: 3,
        verifiedRevision: 3,
        checkClass: "behavioral",
        commandKey: "node verify.mjs",
      },
    },
    { paths: ["src/agent.ts", "test/agent.test.ts"] },
  );
  check(
    "AgentResult envelope contains typed fields and authoritative patch paths",
    JSON.stringify(envelope) ===
      JSON.stringify({
        agentId: 14,
        name: "envelope",
        task: "return typed data",
        status: "integrated",
        summary: "implemented",
        filesChanged: ["src/agent.ts", "test/agent.test.ts"],
        verification: {
          command: "node verify.mjs",
          summary: "1 test passed",
          mutationRevision: 3,
          verifiedRevision: 3,
          checkClass: "behavioral",
          commandKey: "node verify.mjs",
        },
        // #5: required on every envelope. This helper never attested, so it is `missing` — the
        // envelope must not invent an empty attestation on its behalf.
        deviations: [],
        deferred: [],
        attestation: "missing",
        omitted: { deviations: 0, deferred: 0 },
      }),
  );

  const waitingDiff = [
    "diff --git a/src/waiting.ts b/src/waiting.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/waiting.ts",
    "@@ -0,0 +1 @@",
    "+export const waiting = true;",
    "",
  ].join("\n");
  const waitingWithoutPatch = crewExt.buildAgentResult({
    id: 16,
    name: "waiting",
    task: "add waiting fixture",
    status: "waiting",
    summary: "implemented",
    diff: waitingDiff,
    patchPaths: ["src/waiting.ts"],
  });
  check(
    "waiting AgentResult without a patch object reports persisted changed paths",
    JSON.stringify(waitingWithoutPatch.filesChanged) === JSON.stringify(["src/waiting.ts"]),
  );

  const restoredDiff = waitingDiff.replaceAll("waiting.ts", "restored.ts").replace("waiting =", "restored =");
  const restoredDiffOnly = crewExt.buildAgentResult({
    id: 17,
    name: "restored",
    task: "restore saved work",
    status: "waiting",
    summary: "recovered",
    diff: restoredDiff,
  });
  check(
    "restored waiting AgentResult derives changed paths from its diff string",
    JSON.stringify(restoredDiffOnly.filesChanged) === JSON.stringify(["src/restored.ts"]),
  );

  // ── #5: typed honesty fields, and the three states they must keep apart ──────────────────────
  // The failure this guards against is an agent reporting "DEVIATIONS: none" over skipped work, so
  // every assertion here is about NOT-ATTESTED being distinguishable from ATTESTED-EMPTY.
  const attested = crewExt.parseHandoffAttestation(
    'Did the thing.\n```vinci-handoff\n{"deviations": ["used tabs, file was tabbed"], "deferred": [{"item": "the CLI flag", "reason": "out of scope"}]}\n```',
  );
  check(
    "#5 attested handoff parses deviations and deferred",
    attested.attestation === "attested" &&
      JSON.stringify(attested.deviations) === JSON.stringify(["used tabs, file was tabbed"]) &&
      attested.deferred.length === 1 &&
      attested.deferred[0].item === "the CLI flag" &&
      attested.deferred[0].reason === "out of scope",
  );
  check("#5 the handoff block is stripped from the human-facing summary", attested.summary === "Did the thing.");

  const attestedEmpty = crewExt.parseHandoffAttestation('All done.\n```vinci-handoff\n{"deviations": [], "deferred": []}\n```');
  const noBlock = crewExt.parseHandoffAttestation("All done.");
  check(
    "#5 a deliberate empty attestation is NOT the same as no attestation",
    attestedEmpty.attestation === "attested" &&
      noBlock.attestation === "missing" &&
      attestedEmpty.attestation !== noBlock.attestation &&
      JSON.stringify(attestedEmpty.deferred) === JSON.stringify(noBlock.deferred),
  );
  check(
    "#5 malformed, truncated and wrong-shaped blocks are missing, never a throw",
    ["```vinci-handoff\n{not json\n```", "```vinci-handoff\n{\"deviations\": []}\n```", "```vinci-handoff\n[]\n```", "```vinci-handoff\n{\"deviations\": \"x\", \"deferred\": []}\n```", "```vinci-handoff\n{\"deviations\": [], \"deferred\": [{\"item\": 1, \"reason\": \"x\"}]}\n```"].every(
      (text) => crewExt.parseHandoffAttestation(`ok\n${text}`).attestation === "missing",
    ),
  );

  // ── #195: the single-line fence form, exactly as live helpers write it ────────────────────────
  // Both fixtures below are VERBATIM tails from real helper handoffs (session 2026-08-05T17-40-31Z):
  // the model flattened the block onto one line and the old parser downgraded both to `missing`,
  // dropping the attestation and leaving JSON residue in the human-facing summary.
  const liveFormatFix = crewExt.parseHandoffAttestation(
    'Rounding is correct in both directions (e.g. 1.55 → 1.6).\n\n```vinci-handoff {"deviations": [], "deferred": []} ```\n\nI made the change, but this project has no automated test to run, so I couldn\'t verify it with a check — run it yourself to confirm it works.',
  );
  check(
    "#195 a verbatim live single-line handoff parses as attested",
    liveFormatFix.attestation === "attested" && liveFormatFix.deviations.length === 0 && liveFormatFix.deferred.length === 0,
  );
  check(
    "#195 the single-line block is stripped; surrounding prose survives",
    !liveFormatFix.summary.includes("vinci-handoff") &&
      liveFormatFix.summary.includes("Rounding is correct") &&
      liveFormatFix.summary.includes("run it yourself to confirm"),
  );
  const singleLineWithContent = crewExt.parseHandoffAttestation(
    'Done.\n```vinci-handoff {"deviations": ["renamed the helper, old name shadowed a global"], "deferred": [{"item": "the retry tests", "reason": "no harness in this repo"}]} ```',
  );
  check(
    "#195 a single-line attestation with real content survives intact",
    singleLineWithContent.attestation === "attested" &&
      singleLineWithContent.deviations[0]?.includes("shadowed a global") &&
      singleLineWithContent.deferred[0]?.item === "the retry tests",
  );
  check(
    "#195 a malformed single-line block is missing, and still stripped from the summary",
    (() => {
      const r = crewExt.parseHandoffAttestation("ok\n```vinci-handoff {not json} ```");
      return r.attestation === "missing" && !r.summary.includes("vinci-handoff");
    })(),
  );
  check(
    "#195 an embedded ``` inside a single-line JSON string does not end the block early",
    crewExt.parseHandoffAttestation(
      'ok\n```vinci-handoff {"deviations": ["documented the ``` fence syntax"], "deferred": []} ```',
    ).deviations[0] === "documented the ``` fence syntax",
  );
  check(
    "#195 a truncated single-line attempt after a valid block voids it, like the multi-line form",
    crewExt.parseHandoffAttestation(
      'Quoted:\n```vinci-handoff\n{"deviations": [], "deferred": []}\n```\nFinal:\n```vinci-handoff {"deviations": [',
    ).attestation === "missing",
  );
  check(
    "#195 stripHandoffBlocks drops a single-line block line and keeps its neighbours",
    (() => {
      const lines = crewExt.stripHandoffBlocks(["before", '```vinci-handoff {"deviations": [], "deferred": []} ```', "after"]);
      return JSON.stringify(lines) === JSON.stringify(["before", "after"]);
    })(),
  );
  check(
    "#195 parse and strip agree on whether a line is a single-line block (grammar cannot drift apart)",
    // stripHandoffBlocks hand-duplicates HANDOFF_FENCE's single-line grammar. This pins their
    // agreement: for every line shape, the parser removes the block from the summary iff the
    // transcript stripper drops the line. Loosening either regex alone fails here.
    [
      '```vinci-handoff {"deviations": [], "deferred": []} ```',
      '\t```vinci-handoff\t{"deviations": [], "deferred": []}\t```',
      '```vinci-handoff{"deviations": [], "deferred": []} ```',
      '````vinci-handoff {"deviations": [], "deferred": []} ````',
      '```vinci-handoff {"deviations": [], "deferred": []} ``` trailing prose',
      '```vinci-handoff {"deviations": [], "deferred": []} ``',
      "```vinci-handoff {not json} ```",
      "plain prose line",
    ].every((line) => {
      const parsedStripped = !crewExt.parseHandoffAttestation(`x\n${line}\ny`).summary.includes(line);
      const transcriptStripped = !crewExt.stripHandoffBlocks(["x", line, "y"]).includes(line);
      return parsedStripped === transcriptStripped;
    }),
  );

  writeFileSync(join(shutdownRepo, "README.md"), "# shutdown capture\n");
  const shutdownGit = (args) =>
    execFileSync("git", args, { cwd: shutdownRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  shutdownGit(["init", "-q"]);
  shutdownGit(["add", "README.md"]);
  shutdownGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);
  const shutdownMarker = join(sessionDir, "shutdown-rpc-ready.json");
  const shutdownRpcPath = join(shutdownRepo, "shutdown-rpc-agent.mjs");
  writeFileSync(
    shutdownRpcPath,
    [
      'import { createInterface } from "node:readline";',
      'import { writeFileSync } from "node:fs";',
      `const marker = ${JSON.stringify(shutdownMarker)};`,
      'const handoff = "captured at shutdown\\n```vinci-handoff\\n{\\"deviations\\": [], \\"deferred\\": []}\\n```";',
      'const assistant = { role: "assistant", content: [{ type: "text", text: handoff }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };',
      'const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const command = JSON.parse(line);",
      '  const respond = (data = {}) => send({ type: "response", id: command.id, success: true, data });',
      '  if (command.type === "prompt") {',
      "    respond();",
      '    send({ type: "agent_start" });',
      "    writeFileSync(marker, JSON.stringify({ pid: process.pid }));",
      '  } else if (command.type === "get_state") respond({ isStreaming: true, sessionFile: null });',
      '  else if (command.type === "get_messages") respond({ messages: [assistant] });',
      '  else if (command.type === "get_entries") respond({ entries: [], leafId: null });',
      '  else if (command.type === "get_session_stats") respond({ tokens: { total: 2 } });',
      '  else if (command.type === "get_last_assistant_text") respond({ text: handoff });',
      "  else respond();",
      "});",
    ].join("\n"),
  );
  shutdownGit(["add", "shutdown-rpc-agent.mjs"]);
  shutdownGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "fake shutdown rpc"]);
  const shutdownHandlers = {};
  const shutdownTools = [];
  const shutdownEntries = [];
  const shutdownPi = {
    on(name, handler) {
      (shutdownHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      shutdownEntries.push({ customType, data });
    },
    registerTool(tool) {
      shutdownTools.push(tool);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  crewExt.default(shutdownPi);
  const shutdownCtx = {
    cwd: shutdownRepo,
    model: { provider: "faux", id: "faux-model" },
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => sessionDir,
      getSessionId: () => "shutdown-capture-test",
    },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      notify() {},
      setWidget() {},
    },
  };
  let shutdownRpcPid;
  const originalCliPathForShutdown = process.argv[1];
  process.argv[1] = shutdownRpcPath;
  try {
    for (const handler of shutdownHandlers.session_start ?? []) {
      await handler({ type: "session_start", reason: "startup" }, shutdownCtx);
    }
    await shutdownTools
      .find((tool) => tool.name === "spawn_helper")
      .execute("shutdown", { name: "shutdown", task: "finish during shutdown" }, undefined, undefined, shutdownCtx);
    const marker = await waitForJson(shutdownMarker, (value) => Number.isInteger(value?.pid), 10_000);
    shutdownRpcPid = marker.pid;
    for (const handler of shutdownHandlers.session_shutdown ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" });
    }
  } finally {
    process.argv[1] = originalCliPathForShutdown;
    if (shutdownRpcPid && processIsAlive(shutdownRpcPid)) {
      try {
        process.kill(shutdownRpcPid, "SIGKILL");
        await waitForProcessDeath(shutdownRpcPid, 5_000);
      } catch {
        // The persisted capture assertion below still reports an incomplete shutdown path.
      }
    }
  }
  const shutdownCaptured = shutdownEntries
    .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 1)
    .at(-1)?.data;
  check(
    "shutdown capture parses honesty and strips the raw handoff block",
    shutdownCaptured?.attestation === "attested" &&
      shutdownCaptured.summary === "captured at shutdown" &&
      !shutdownCaptured.transcript?.some((line) => line.includes("vinci-handoff") || line.includes('"deviations"')),
  );
  check(
    "#5 the LAST block wins, so a quoted contract example is not read as the answer",
    crewExt.parseHandoffAttestation(
      'I will end with:\n```vinci-handoff\n{"deviations": [], "deferred": []}\n```\nActually:\n```vinci-handoff\n{"deviations": [], "deferred": [{"item": "tests", "reason": "ran out of time"}]}\n```',
    ).deferred[0]?.item === "tests",
  );
  const truncatedAfterValid = crewExt.parseHandoffAttestation(
    'Quoted example:\n```vinci-handoff\n{"deviations": [], "deferred": []}\n```\nFinal answer:\n```vinci-handoff\n{"deviations": [], "deferred": [',
  );
  const validWithTrailingProse = crewExt.parseHandoffAttestation(
    'Done.\n```vinci-handoff\n{"deviations": [], "deferred": []}\n```\nTrailing prose remains allowed.',
  );
  check(
    "a final unterminated handoff fence voids an earlier complete example",
    truncatedAfterValid.attestation === "missing",
  );
  check(
    "trailing prose after one complete handoff remains attested",
    validWithTrailingProse.attestation === "attested",
  );

  // Bounds. Exact boundaries, not upper bounds: an upper-bound assertion passes even if oversized
  // input is discarded wholesale, which is the failure mode being guarded against.
  const F = "```";
  const blk = (o) => `${F}vinci-handoff\n${JSON.stringify(o)}\n${F}`;
  const at32 = crewExt.parseHandoffAttestation(blk({ deviations: [], deferred: Array.from({ length: 32 }, (_, i) => ({ item: `i${i}`, reason: "r" })) }));
  const at35 = crewExt.parseHandoffAttestation(blk({ deviations: [], deferred: Array.from({ length: 35 }, (_, i) => ({ item: `i${i}`, reason: "r" })) }));
  check(
    "#5 exactly 32 entries is kept whole with nothing reported omitted",
    at32.deferred.length === 32 && at32.omitted.deferred === 0 && at32.attestation === "attested",
  );
  check(
    "#5 a 33rd entry is DROPPED BUT COUNTED — never silently swallowed",
    at35.deferred.length === 32 && at35.omitted.deferred === 3 && at35.attestation === "attested",
  );
  const at400 = crewExt.parseHandoffAttestation(blk({ deviations: ["y".repeat(400)], deferred: [] }));
  const at401 = crewExt.parseHandoffAttestation(blk({ deviations: ["y".repeat(401)], deferred: [] }));
  check(
    "#5 a 400-char entry is untouched and a 401-char entry is clipped with an ellipsis",
    at400.deviations[0].length === 400 &&
      !at400.deviations[0].endsWith("\u2026") &&
      at401.deviations[0].length === 400 &&
      at401.deviations[0].endsWith("\u2026"),
  );
  check(
    "#5 clipping never splits a surrogate pair",
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(
      crewExt.parseHandoffAttestation(blk({ deviations: ["x".repeat(398) + "\u{1F389}" + "tail".repeat(50)], deferred: [] })).deviations[0],
    ),
  );
  check(
    "#5 an omitted count reaches the orchestrator as an INCOMPLETE list",
    (() => {
      const before = crewDeliveries.length;
      crewExt.finalizeHelper(crewPi, { id: 24, name: "verbose", task: "t", status: "done", summary: "s",
        attestation: "attested", deviations: [], deferred: [{ item: "a", reason: "b" }], omitted: { deviations: 0, deferred: 3 } });
      const text = crewDeliveries[before]?.message?.content ?? "";
      return text.includes("NOT shown") && text.includes("incomplete");
    })(),
  );
  check(
    "#5 a blank deferred reason invalidates the attestation rather than passing through empty",
    crewExt.parseHandoffAttestation(blk({ deviations: [], deferred: [{ item: "real", reason: "   " }] })).attestation === "missing" &&
      crewExt.parseHandoffAttestation(blk({ deviations: ["  "], deferred: [] })).attestation === "missing",
  );
  check(
    "#5 a fence inside the JSON does not end the block, and every block leaves the summary",
    (() => {
      const inner = crewExt.parseHandoffAttestation(`ok\n${blk({ deviations: [`used ${F}js fences`], deferred: [] })}`);
      const two = crewExt.parseHandoffAttestation(`a\n${blk({ deviations: [], deferred: [] })}\nb\n${blk({ deviations: [], deferred: [{ item: "x", reason: "y" }] })}`);
      return inner.attestation === "attested" && inner.summary === "ok" && !two.summary.includes("vinci-handoff") && two.deferred[0]?.item === "x";
    })(),
  );
  check(
    "#5 a result persisted before this feature still delivers instead of throwing",
    (() => {
      const before = crewDeliveries.length;
      crewExt.finalizeHelper(crewPi, { id: 25, name: "legacy", task: "t", status: "waiting", summary: "s",
        diff: "diff --git a/src/a.ts b/src/a.ts\n", patchPaths: ["src/a.ts"],
        result: { agentId: 25, name: "legacy", task: "t", status: "waiting", summary: "s", filesChanged: ["src/a.ts"], verification: null } });
      return crewDeliveries.length > before;
    })(),
  );
  check(
    "#5 the raw handoff block never reaches the viewer through the transcript",
    !crewExt
      .viewerTranscriptLines({ status: "done", attestation: "attested", deviations: [], deferred: [{ item: "x", reason: "y" }],
        transcript: crewExt.stripHandoffBlocks(["did it", `${F}vinci-handoff`, '{"deviations": [], "deferred": []}', F]), summary: "did it" })
      .some((line) => line.includes("vinci-handoff")),
  );

  const honest = crewExt.buildAgentResult({
    id: 19,
    name: "honest",
    task: "do the thing",
    status: "done",
    summary: "did it",
    attestation: "attested",
    deviations: ["picked JSON over YAML"],
    deferred: [{ item: "the migration", reason: "needs a maintainer decision" }],
  });
  const silent = crewExt.buildAgentResult({ id: 20, name: "silent", task: "do the thing", status: "done", summary: "did it" });
  check(
    "#5 buildAgentResult carries an attestation through, and a pre-#5 helper record is missing",
    honest.attestation === "attested" &&
      honest.deferred[0].item === "the migration" &&
      silent.attestation === "missing" &&
      silent.deviations.length === 0 &&
      silent.deferred.length === 0,
  );
  check(
    "#5 an unattested helper never yields a fabricated empty attestation",
    crewExt.buildAgentResult({
      id: 21,
      name: "fabricator",
      task: "do the thing",
      status: "done",
      summary: "did it",
      deviations: ["this was never attested"],
      deferred: [{ item: "smuggled", reason: "no attestation" }],
    }).attestation === "missing" &&
      crewExt.buildAgentResult({
        id: 21,
        name: "fabricator",
        task: "do the thing",
        status: "done",
        summary: "did it",
        deviations: ["this was never attested"],
        deferred: [{ item: "smuggled", reason: "no attestation" }],
      }).deferred.length === 0,
  );

  // #179: drift the agent's own scope guard observed in a headless run travels on `deviations`,
  // labelled apart from the agent's claims — and it neither needs nor grants an attestation.
  const observedDrift = crewExt.buildAgentResult({
    id: 23,
    name: "drifter",
    task: "fix the login button",
    status: "done",
    summary: "did it",
    scopeDrift: ["Changed billing.js, which the request did not mention"],
  });
  check(
    "#179 guard-observed drift reaches the handoff deviations, labelled as an observation",
    observedDrift.deviations.length === 1 &&
      observedDrift.deviations[0] === "Scope guard: Changed billing.js, which the request did not mention",
  );
  check(
    "#179 observed drift never credits an unattested agent with an attestation",
    observedDrift.attestation === "missing" && observedDrift.deferred.length === 0,
  );
  check(
    "#179 an attested agent keeps its own deviations alongside the guard's",
    crewExt
      .buildAgentResult({
        id: 24,
        name: "attested-drifter",
        task: "fix the login button",
        status: "done",
        summary: "did it",
        attestation: "attested",
        deviations: ["picked JSON over YAML"],
        deferred: [],
        scopeDrift: ["Changed billing.js, which the request did not mention"],
      })
      .deviations.join(" | ") ===
      "Scope guard: Changed billing.js, which the request did not mention | picked JSON over YAML",
  );
  // #185: a helper's UI prompts have no answerer, so a pause it could not ask about becomes the
  // guard's own skip — and must reach the user the same way any other observed drift does. Built
  // from the guard's real note through the real session-entry channel, not a hand-written string.
  const unanswerableNote = scopeExt.scopeUnanswerableNote("README.md");
  const unanswerableDrift = scopeDrift.scanVinciScopeDriftEntries([
    { type: "custom", customType: scopeDrift.VINCI_SCOPE_DRIFT_ENTRY, data: { note: unanswerableNote } },
  ]);
  check(
    "#185 an unanswerable helper pause survives the child-session boundary",
    unanswerableDrift.join("|") === "Paused on README.md and could not ask, so skipped it",
  );
  check(
    "#185 it reaches the handoff deviations, labelled as the guard's observation",
    crewExt
      .buildAgentResult({
        id: 25,
        name: "unanswered",
        task: "fix the login button",
        status: "done",
        summary: "did it",
        scopeDrift: unanswerableDrift,
      })
      .deviations.join("|") === "Scope guard: Paused on README.md and could not ask, so skipped it",
  );
  check(
    "#179 the viewer footer shows observed drift even when the agent never attested",
    crewExt
      .viewerTranscriptLines({
        status: "done",
        summary: "did it",
        scopeDrift: ["Changed billing.js, which the request did not mention"],
      })
      .join("\n")
      .includes("Scope guard noticed:\n  • Changed billing.js, which the request did not mention"),
  );

  const honestyDeliveryCount = crewDeliveries.length;
  crewExt.finalizeHelper(crewPi, {
    id: 22,
    name: "deferrer",
    task: "do the thing",
    status: "done",
    summary: "did most of it",
    attestation: "attested",
    deviations: [],
    deferred: [{ item: "the retry path", reason: "needs a design call" }],
  });
  const deferredText = crewDeliveries[honestyDeliveryCount]?.message?.content ?? "";
  check(
    "#5 deferred work is stated to the orchestrator as NOT done",
    deferredText.includes("the retry path") &&
      deferredText.includes("needs a design call") &&
      deferredText.includes("NOT done"),
  );

  const missingDeliveryCount = crewDeliveries.length;
  crewExt.finalizeHelper(crewPi, { id: 23, name: "quiet", task: "do the thing", status: "done", summary: "did it" });
  const missingText = crewDeliveries[missingDeliveryCount]?.message?.content ?? "";
  check(
    "#5 a handoff with no attestation is flagged UNCONFIRMED to the orchestrator",
    missingText.includes("UNCONFIRMED") && missingText.includes("did not report"),
  );

  check(
    "#5 the viewer separates deliberately-left from not-reported, and shows neither while running",
    crewExt
      .viewerTranscriptLines({ status: "done", attestation: "attested", deviations: [], deferred: [{ item: "the flag", reason: "scope" }], summary: "s" })
      .some((line) => line.includes("the flag") && line.includes("scope")) &&
      crewExt
        .viewerTranscriptLines({ status: "done", summary: "s" })
        .some((line) => line.includes("not reported")) &&
      !crewExt.viewerTranscriptLines({ status: "working", summary: "s" }).some((line) => line.includes("Deliberately left")),
  );
  check(
    "the honesty viewer reports omitted deferred entries after the visible list",
    crewExt
      .viewerTranscriptLines({
        status: "done",
        attestation: "attested",
        deviations: [],
        deferred: [{ item: "visible item", reason: "scope" }],
        omitted: { deviations: 0, deferred: 2 },
        summary: "s",
      })
      .some((line) => line.includes("…and 2 more not shown")),
  );

  const waitingDeliveryCount = crewDeliveries.length;
  crewExt.finalizeHelper(crewPi, {
    id: 18,
    name: "approval",
    task: "hold changes for approval",
    status: "waiting",
    summary: "implemented",
    diff: waitingDiff,
    patchPaths: ["src/waiting.ts"],
  });
  const waitingResultText = crewDeliveries[waitingDeliveryCount]?.message?.content ?? "";
  check(
    "waiting AgentResult text tells the orchestrator to use finished work and not redo it",
    waitingResultText.includes("The agent finished") &&
      waitingResultText.includes("Use use_agent_work with agent_id 18") &&
      waitingResultText.includes("ask the user in plain language") &&
      waitingResultText.includes("src/waiting.ts") &&
      waitingResultText.includes("DO NOT redo this work") &&
      !waitingResultText.includes("made no file changes"),
  );

  const emptyDoneDeliveryCount = crewDeliveries.length;
  crewExt.finalizeHelper(crewPi, {
    id: 19,
    name: "empty",
    task: "inspect only",
    status: "done",
    summary: "nothing to change",
  });
  const emptyDoneResultText = crewDeliveries[emptyDoneDeliveryCount]?.message?.content ?? "";
  check(
    "genuinely empty done AgentResult text says it made no file changes",
    emptyDoneResultText.includes("made no file changes"),
  );

  const crewSource = readFileSync(resolve(here, "../extensions/vinci-crew.ts"), "utf8");
  // ── Continuing a finished agent ─────────────────────────────────────────────────────────────
  {
    const continueTool = crewTools.find((tool) => tool.name === "continue_agent");
    check(
      "continue_agent takes an optional id and a required instruction",
      continueTool?.parameters?.properties?.instruction?.type === "string" &&
        continueTool.parameters.required?.includes("instruction") &&
        !continueTool.parameters.required?.includes("agent_id"),
    );
    check(
      "continue_agent tells the orchestrator it resumes rather than restarts",
      /where it left off/i.test(continueTool?.description ?? "") &&
        /conversation it already had/i.test(continueTool?.description ?? ""),
    );

    // The rule George settled: a continued agent works from the project as it stands now, but never
    // loses its own unreviewed work along the way.
    check(
      "work still waiting for review is put back, so the agent does not redo it",
      crewExt.continuationPatchPath({ diffPath: "/tmp/p.diff" }) === "/tmp/p.diff",
    );
    check(
      "already-applied work is NOT replayed — it is in the project, and replaying would conflict",
      crewExt.continuationPatchPath({ applied: true, diffPath: "/tmp/p.diff" }) === undefined,
    );
    check(
      "dismissed work is NOT replayed — putting it back would undo the user's decision",
      crewExt.continuationPatchPath({ dismissedAt: Date.now(), diffPath: "/tmp/p.diff" }) === undefined,
    );
    check(
      "an agent that produced no patch carries nothing forward",
      crewExt.continuationPatchPath({ diffPath: undefined }) === undefined,
    );

    // Resuming needs the child's saved conversation; without it there is nothing to continue.
    const continuable = { id: 1, name: "parser", status: "waiting", childSession: "/tmp/s.jsonl" };
    const noSession = { id: 2, name: "readme", status: "waiting" };
    const stillWorking = { id: 3, name: "tests", status: "working", childSession: "/tmp/s2.jsonl" };
    const eligible = (candidate) =>
      ["done", "waiting", "failed", "blocked"].includes(candidate.status) && Boolean(candidate.childSession);
    check(
      "only a finished agent with a saved conversation can be continued",
      eligible(continuable) && !eligible(noSession) && !eligible(stillWorking),
    );
  }

  // A completed helper's session records its private worktree as cwd, and that worktree is removed
  // after the helper finishes. Continuing must therefore FORK the conversation into the fresh
  // worktree. `--session` would retain the deleted cwd and the real non-interactive CLI would exit
  // before RPC startup.
  {
    const sourceCwd = mkdtempSync(join(tmpdir(), "crew-continuation-old-cwd-"));
    const sourceSession = join(sessionDir, "continuation-source.jsonl");
    const continuedSession = join(sessionDir, "continuation-fork.jsonl");
    const launchMarker = join(sessionDir, "continuation-launch.json");
    const continuationRpc = join(sessionDir, "continuation-rpc.mjs");
    writeFileSync(
      sourceSession,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "continuation-source",
        timestamp: new Date().toISOString(),
        cwd: sourceCwd,
      })}\n`,
    );
    rmSync(sourceCwd, { recursive: true, force: true });
    writeFileSync(
      continuationRpc,
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        'import { createInterface } from "node:readline";',
        `const continuedSession = ${JSON.stringify(continuedSession)};`,
        `const launchMarker = ${JSON.stringify(launchMarker)};`,
        'const forkIndex = process.argv.indexOf("--fork");',
        'if (process.argv.includes("--session") || forkIndex === -1 || !process.argv[forkIndex + 1]) process.exit(2);',
        'const sourceSession = process.argv[forkIndex + 1];',
        'const sourceHeader = JSON.parse(readFileSync(sourceSession, "utf8").split("\\n")[0]);',
        'if (existsSync(sourceHeader.cwd)) process.exit(3);',
        'writeFileSync(continuedSession, `${JSON.stringify({ ...sourceHeader, cwd: process.cwd() })}\\n`);',
        'writeFileSync(launchMarker, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), sourceSession }));',
        'const assistant = { role: "assistant", content: [{ type: "text", text: "continued" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };',
        'const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        "  const command = JSON.parse(line);",
        '  const respond = (data = {}) => send({ type: "response", id: command.id, success: true, data });',
        '  if (command.type === "prompt") {',
        "    respond();",
        '    send({ type: "agent_start" });',
        '    send({ type: "message_end", message: assistant });',
        '    send({ type: "agent_end", messages: [assistant] });',
        '  } else if (command.type === "get_state") respond({ isStreaming: false, sessionFile: continuedSession });',
        '  else if (command.type === "get_session_stats") respond({ tokens: { total: 2 } });',
        '  else if (command.type === "get_last_assistant_text") respond({ text: "continued" });',
        '  else if (command.type === "get_messages") respond({ messages: [assistant] });',
        '  else if (command.type === "get_entries") respond({ entries: [], leafId: null });',
        "  else respond();",
        "});",
      ].join("\n"),
    );

    const continuationHandlers = {};
    const continuationEntries = [];
    const continuationTools = [];
    const continuationPi = {
      on(name, handler) {
        (continuationHandlers[name] ??= []).push(handler);
      },
      appendEntry(customType, data) {
        continuationEntries.push({ customType, data });
      },
      registerTool(tool) {
        continuationTools.push(tool);
      },
      registerCommand() {},
      sendMessage() {},
      sendUserMessage() {},
    };
    crewExt.default(continuationPi);
    const continuationCtx = {
      cwd: base,
      model: { provider: "faux", id: "faux-model" },
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "vinci-crew-helper",
            data: {
              id: 70,
              name: "parser",
              task: "fix the parser",
              status: "done",
              childSession: sourceSession,
            },
          },
        ],
        getSessionDir: () => sessionDir,
        getSessionId: () => "continuation-test",
      },
      ui: {
        theme: { fg: (_color, text) => text, bold: (text) => text },
        notify() {},
        setWidget() {},
      },
    };
    const originalCliPathForContinuation = process.argv[1];
    process.argv[1] = continuationRpc;
    try {
      for (const handler of continuationHandlers.session_start ?? []) {
        await handler({ type: "session_start", reason: "resume" }, continuationCtx);
      }
      const continueAgent = continuationTools.find((tool) => tool.name === "continue_agent");
      const result = await continueAgent.execute(
        "continue",
        { agent_id: 70, instruction: "Add the missing edge case." },
        undefined,
        undefined,
        continuationCtx,
      );
      await waitForCondition(
        () =>
          continuationEntries.some(
            (entry) =>
              entry.customType === "vinci-crew-helper" &&
              entry.data.id === 71 &&
              entry.data.status === "done",
          ),
        "continued helper completion",
        10_000,
      );
      const launch = JSON.parse(readFileSync(launchMarker, "utf8"));
      const continued = continuationEntries
        .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 71)
        .at(-1)?.data;
      check(
        "continue_agent forks the saved conversation into the fresh worktree instead of resuming its deleted cwd",
        result?.details?.continuedFrom === 70 &&
          launch.args.includes("--fork") &&
          !launch.args.includes("--session") &&
          launch.sourceSession === sourceSession &&
          launch.cwd !== sourceCwd &&
          continued?.childSession === continuedSession,
      );
    } finally {
      process.argv[1] = originalCliPathForContinuation;
      for (const handler of continuationHandlers.session_shutdown ?? []) {
        await handler({ type: "session_shutdown", reason: "quit" });
      }
    }
  }

  const spawnHelperTool = crewTools.find((tool) => tool.name === "spawn_helper");
  const dismissHelperTool = crewTools.find((tool) => tool.name === "dismiss_agent_work");
  const spawnHelperStart = crewSource.indexOf('name: "spawn_helper"');
  const spawnHelperEnd = crewSource.indexOf('name: "message_agent"', spawnHelperStart);
  const spawnHelperConstruct =
    spawnHelperStart >= 0 && spawnHelperEnd > spawnHelperStart
      ? crewSource.slice(spawnHelperStart, spawnHelperEnd)
      : "";
  const spawnExecuteStart = spawnHelperConstruct.indexOf("async execute");
  const spawnHelperSteer = spawnExecuteStart >= 0 ? spawnHelperConstruct.slice(spawnExecuteStart) : "";
  check(
    "dismiss_agent_work description tells the orchestrator when to dismiss unwanted or cluttering work",
    dismissHelperTool?.description.includes("orchestrator") &&
      dismissHelperTool.description.includes("user doesn't want") &&
      dismissHelperTool.description.includes("cluttering the list") &&
      !dismissHelperTool.description.includes("/agents"),
  );
  check(
    "spawn_helper description and bounded result steer tell the orchestrator to dismiss work itself",
    spawnHelperTool?.description.includes("call dismiss_agent_work yourself") &&
      spawnHelperSteer.includes("ORCHESTRATOR_DISMISS_GUIDANCE") &&
      spawnHelperTool.description.includes("Never direct the user to /agents"),
  );
  check(
    "finished-agent guidance dismisses unwanted work without exposing menus or status jargon to the user",
    waitingResultText.includes("call dismiss_agent_work yourself") &&
      waitingResultText.includes("Mention /agents only when the user asks to look at the agent's changes") &&
      waitingResultText.includes("do not mention internal states") &&
      waitingResultText.includes("implementation terms") &&
      waitingResultText.includes("Never direct the user to /agents"),
  );
  for (const handler of crewHandlers.agent_start ?? []) await handler({ type: "agent_start" }, crewCtx);
  const steerFinalizationHelper = {
    id: 15,
    name: "steer\nidle",
    task: "report a steering timeout",
    status: "blocked",
    reason: "still working\nafter steer",
  };
  const steerNotificationCount = crewNotifications.length;
  const steerDeliveryCount = crewDeliveries.length;
  if (typeof crewExt.finalizeHelper === "function") crewExt.finalizeHelper(crewPi, steerFinalizationHelper);
  check(
    "steer idle-timeout finalizes with one sanitized notification and one orchestrator delivery",
    // [^}] keeps this INSIDE the steer branch. An unbounded [\s\S]*? happily matched a
    // finalizeHelper() call from a different terminal path further down the file, so the check
    // passed even with the silent drop restored — verified by mutating the branch.
    /if \(h\.messagedDuringRun[^}]*?finalizeHelper\(pi, h[^}]*?return;/.test(crewSource) &&
      crewNotifications.length === steerNotificationCount + 1 &&
      crewNotifications.at(-1)?.message.includes('Agent "steer idle" couldn\'t finish: still working after steer.') &&
      !crewNotifications.at(-1)?.message.includes(" blocked:") &&
      crewDeliveries.length === steerDeliveryCount + 1 &&
      crewDeliveries.at(-1)?.message?.details?.agentId === 15 &&
      steerFinalizationHelper.result?.status === "blocked",
  );

  const duplicateNotificationCount = crewNotifications.length;
  const duplicateDeliveryCount = crewDeliveries.length;
  if (typeof crewExt.finalizeHelper === "function") {
    crewExt.finalizeHelper(crewPi, steerFinalizationHelper);
    crewExt.finalizeHelper(crewPi, steerFinalizationHelper);
  }
  check(
    "a second finalization does not notify or deliver twice",
    typeof steerFinalizationHelper.notifiedAt === "number" &&
      typeof steerFinalizationHelper.deliveredAt === "number" &&
      crewNotifications.length === duplicateNotificationCount &&
      crewDeliveries.length === duplicateDeliveryCount,
  );

  const restored9 = crewEntries.filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 9).at(-1);
  check(
    "a finalized but undelivered helper notifies and delivers once on restore",
    typeof restored9?.data.notifiedAt === "number" &&
      typeof restored9?.data.deliveredAt === "number" &&
      crewNotifications.filter((notification) => notification.message.includes('Agent "restore-undelivered"')).length === 1 &&
      crewDeliveries.filter((delivery) => delivery.message?.details?.agentId === 9).length === 1,
  );

  // [vinci] Raw roster navigation must yield terminal input while a modal overlay owns focus.
  check(
    "roster navigation yields to active modal overlays",
    // Assert the invariant, not one call's spelling: when a modal owns input the roster disarms and
    // returns WITHOUT consuming, so the key reaches the modal. How the repaint is scheduled is detail.
    /function handleNavKey[\s\S]*?if \(ctx\.ui\.isOverlayActive\?\.\(\)\) \{[\s\S]*?navActive = false;[\s\S]*?return undefined;/.test(
      crewSource,
    ),
  );
  check(
    "live Crew apply path records through the revision-guarded outcome helper",
    /const baselineRevision = getVinciVerificationState\(\)\.mutationRevision/.test(crewSource) &&
      /recordCrewIntegrationOutcome\(baselineRevision, h\.verification, ctx\.cwd, patch\.paths\)/.test(crewSource),
  );
  // [#187] The warranted-fact follows the PATCH's paths — behavioral pin on the exported helper,
  // not just the call-site regex: a docs-only integration must not record "warranted".
  {
    state.resetVinciVerificationState();
    const docsRevision = state.getVinciVerificationState().mutationRevision;
    crewExt.recordCrewIntegrationOutcome(docsRevision, { command: "npm test", summary: "ok" }, undefined, ["README.md"]);
    check(
      "#187 a docs-only crew integration records no warranted-fact",
      (state.getVinciVerificationState().checkWarrantedRevision ?? -1) === -1,
    );
    state.resetVinciVerificationState();
    const sourceRevision = state.getVinciVerificationState().mutationRevision;
    crewExt.recordCrewIntegrationOutcome(sourceRevision, { command: "npm test", summary: "ok" }, undefined, ["src/auth.ts"]);
    const afterSource = state.getVinciVerificationState();
    check(
      "#187 a source crew integration records the warranted-fact at the new revision",
      afterSource.checkWarrantedRevision === afterSource.mutationRevision && afterSource.mutationRevision > 0,
    );
    state.resetVinciVerificationState();
    check(
      "#187 all crew apply sites share one warranted expression",
      crewExt.crewPatchWarrantsCheck(["src/auth.ts", "README.md"]) === true &&
        crewExt.crewPatchWarrantsCheck(["README.md", "notes.txt"]) === false &&
        crewExt.crewPatchWarrantsCheck(undefined) === false &&
        (crewSource.match(/crewPatchWarrantsCheck\(/g) ?? []).length >= 4,
    );
  }
  check("live Crew has no Bozza model hardcode", !crewSource.includes('model: "vinci-bozza"'));
  check("live Crew uses the typed top-level RPC client", !crewSource.includes("await import("));
  check("live Crew has no fallback to the main checkout", !crewSource.includes("?? cwd"));
  // #185: crew answers no extension_ui_request, and rpc mode makes the child's ctx.hasUI true anyway.
  // The marker on the spawn is the only thing that lets a helper's scope guard know nobody is listening.
  check(
    "live Crew marks its helper children so their scope guard knows nobody is listening",
    crewSource.includes("new RpcClient({") &&
      /env: \{[^}]*\[VINCI_CREW_HELPER_ENV\]: "1"/.test(crewSource) &&
      scopeDrift.isUnanswerableVinciUI("rpc", { [scopeDrift.VINCI_CREW_HELPER_ENV]: "1" }) === true,
  );
  check(
    "restoreHelpers ties the no-patch downgrade to an orphan capture attempt",
    /findOrphanedHelperWorktree\(ctx\.cwd, restored\.id\)/.test(crewSource) && /captureCrewPatch\(orphan\)/.test(crewSource),
  );

  // --- untrusted-text rendering (agent name/task/transcript are all model- or tool-influenced) ---

  // Escapes must be stripped BEFORE masking. Masking first sees the fragmented secret, misses it,
  // and stripping then reassembles it intact on screen.
  check(
    "viewer text strips escapes before masking secrets, never after",
    /vinciMaskSecrets\(stripAnsiSequences\(/.test(crewSource) && !/stripAnsiSequences\(vinciMaskSecrets\(/.test(crewSource),
  );
  // Split a real masker-recognized token (sk- + 20 alnum) with an escape. Strip-then-mask must
  // rejoin it and THEN mask it; mask-then-strip would rejoin it after the masker had already
  // looked, printing the live key.
  {
    const secret = `sk-${"a".repeat(30)}`;
    const fragmented = `sk-${"a".repeat(10)}\x1b[0m${"a".repeat(20)}`;
    check("a plain secret is masked at all", !crewExt.sanitizeViewerText(secret).includes(secret));
    check(
      "an escape-fragmented secret cannot be reassembled onto the screen",
      !crewExt.sanitizeViewerText(fragmented).includes(secret),
    );
  }

  // A screen-clearing name must not survive on ANY rendered path.
  check(
    "a screen-clearing agent name is neutralized",
    !crewExt.sanitizeLine("agent\x1b[2J\x1b]0;pwned\x07name").includes("\x1b") &&
      crewExt.sanitizeLine("agent\x1b[2J\x1b]0;pwned\x07name") === "agentname",
  );
  // sanitizeViewerText keeps LF for the transcript, so single-line fields need the collapsing variant
  // or a newline in a model-chosen name breaks its row and forges UI chrome.
  check(
    "a newline in a single-line field cannot forge extra UI rows",
    !crewExt.sanitizeLine("agent\nEsc to close\nfake").includes("\n"),
  );
  check(
    "no user-facing string interpolates an unsanitized agent name",
    // setSessionName is the one allowed raw use: it names the child session, never rendered.
    crewSource
      .split("\n")
      .filter((line) => /\$\{h\.name\}/.test(line))
      .every((line) => line.includes("setSessionName")),
  );

  // The compose buffer IS the message sent to the agent: strip control chars, never mask it, or a
  // key the user deliberately typed is rewritten to <vinci-secret> and that gets sent instead.
  check(
    "the compose line is stripped but never masked",
    /stripAnsiSequences\(input\.getValue\(\)\)/.test(crewSource) && !/sanitizeViewerText\(input\.getValue\(\)\)/.test(crewSource),
  );

  // Sizes captured once go stale on resize, leaving the orchestrator visible around the view.
  check(
    "the agent view is sized against the current terminal, not a captured size",
    /width: "100%"/.test(crewSource) && /maxHeight: "100%"/.test(crewSource) && !/maxHeight: overlayHeight/.test(crewSource),
  );

  // Manual application must retain and use the helper's original path baselines after a restart.
  writeFileSync(join(base, "manual-stale.txt"), "original\n");
  writeFileSync(join(base, "manual-stable.txt"), "original\n");
  git(["add", "manual-stale.txt", "manual-stable.txt"]);
  git(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "manual apply fixtures"]);
  const staleManualWorktree = crew.createCrewWorktree(base, "30", "manual");
  worktrees.push(staleManualWorktree);
  writeFileSync(join(staleManualWorktree.root, "manual-stale.txt"), "agent edit\n");
  const staleManualPatch = crew.captureCrewPatch(staleManualWorktree);
  crew.removeCrewWorktree(base, staleManualWorktree);
  worktrees.splice(worktrees.indexOf(staleManualWorktree), 1);
  const stableManualWorktree = crew.createCrewWorktree(base, "31", "manual");
  worktrees.push(stableManualWorktree);
  writeFileSync(join(stableManualWorktree.root, "manual-stable.txt"), "agent edit\n");
  const stableManualPatch = crew.captureCrewPatch(stableManualWorktree);
  crew.removeCrewWorktree(base, stableManualWorktree);
  worktrees.splice(worktrees.indexOf(stableManualWorktree), 1);

  const staleManualDiffPath = join(sessionDir, "manual-stale.diff");
  const stableManualDiffPath = join(sessionDir, "manual-stable.diff");
  writeFileSync(staleManualDiffPath, staleManualPatch.diff);
  writeFileSync(stableManualDiffPath, stableManualPatch.diff);
  const manualHandlers = {};
  const manualEntries = [];
  const manualCommands = new Map();
  const manualNotifications = [];
  const manualPi = {
    on(name, handler) {
      (manualHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      manualEntries.push({ customType, data });
    },
    registerTool() {},
    registerCommand(name, command) {
      manualCommands.set(name, command);
    },
    sendMessage() {},
    sendUserMessage() {},
  };
  crewExt.default(manualPi);
  let selectedManualHelper = "manual-stable";
  let confirmAnswers = [];
  const manualConfirms = [];
  const manualCtx = {
    cwd: base,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: {
            id: 30,
            name: "manual-stale",
            task: "edit stale fixture",
            status: "waiting",
            diffPath: staleManualDiffPath,
            patchMetadata: {
              kind: staleManualPatch.kind,
              paths: staleManualPatch.paths,
              deletedPaths: staleManualPatch.deletedPaths,
              baselineFingerprints: staleManualPatch.baselineFingerprints,
            },
          },
        },
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: {
            id: 31,
            name: "manual-stable",
            task: "edit stable fixture",
            status: "waiting",
            diffPath: stableManualDiffPath,
            patchMetadata: {
              kind: stableManualPatch.kind,
              paths: stableManualPatch.paths,
              deletedPaths: stableManualPatch.deletedPaths,
              baselineFingerprints: stableManualPatch.baselineFingerprints,
            },
          },
        },
      ],
      getSessionDir: () => sessionDir,
      getSessionId: () => "manual-restore-test",
    },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      notify(message, level) {
        manualNotifications.push({ message, level });
      },
      setWidget() {},
      async select(title, options) {
        if (title === "Your agents") return options.find((option) => option.includes(selectedManualHelper));
        return options.find((option) => option === "Apply its changes");
      },
      async confirm(title, message) {
        manualConfirms.push({ title, message });
        return confirmAnswers.shift() ?? false;
      },
    },
  };
  for (const handler of manualHandlers.session_start ?? []) await handler({ type: "session_start", reason: "resume" }, manualCtx);
  const roundTrippedMetadata = manualEntries
    .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 31)
    .at(-1)?.data.patchMetadata;
  check(
    "patch metadata survives persist→restore round-trip",
    roundTrippedMetadata?.kind === stableManualPatch.kind &&
      JSON.stringify(roundTrippedMetadata.paths) === JSON.stringify(stableManualPatch.paths) &&
      JSON.stringify(roundTrippedMetadata.deletedPaths) === JSON.stringify(stableManualPatch.deletedPaths) &&
      JSON.stringify(roundTrippedMetadata.baselineFingerprints) === JSON.stringify(stableManualPatch.baselineFingerprints) &&
      restored7?.data.patchMetadata?.kind === "git" &&
      restored7.data.patchMetadata.paths.includes("README.md") &&
      typeof restored7.data.patchMetadata.baselineFingerprints?.["README.md"] === "string",
  );

  confirmAnswers = [true];
  await manualCommands.get("agents").handler("", manualCtx);
  check(
    "manual apply still succeeds normally when nothing changed",
    readFileSync(join(base, "manual-stable.txt"), "utf8") === "agent edit\n" && manualConfirms.length === 1,
  );

  writeFileSync(join(base, "manual-stale.txt"), "original\nmain changed after agent\n");
  selectedManualHelper = "manual-stale";
  manualConfirms.length = 0;
  confirmAnswers = [true, false];
  await manualCommands.get("agents").handler("", manualCtx);
  check(
    "manual apply is refused unless separately confirmed when a touched main-tree file changed after agent start",
    readFileSync(join(base, "manual-stale.txt"), "utf8") === "original\nmain changed after agent\n" &&
      manualConfirms.length === 2 &&
      manualConfirms[1].message.includes("manual-stale.txt") &&
      !manualNotifications.at(-1)?.message.includes('Applied "manual-stale"'),
  );

  // The orchestrator owns finished agent work: it can apply ordinary changes, request user consent
  // for consequential changes, refuse unsafe/stale work, or dismiss a row without losing it.
  const toolGit = (args) =>
    execFileSync("git", args, { cwd: toolRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(toolRepo, "ordinary.txt"), "original\n");
  writeFileSync(join(toolRepo, "secret.txt"), "original\n");
  writeFileSync(join(toolRepo, "package.json"), '{"private":true}\n');
  writeFileSync(join(toolRepo, "stale-tool.txt"), "original\n");
  writeFileSync(join(toolRepo, "dismissed.txt"), "original\n");
  toolGit(["init", "-q"]);
  toolGit(["add", "-A"]);
  toolGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);

  const toolPatchFixtures = [
    [50, "ordinary-agent", "ordinary.txt", "agent edit\n"],
    [51, "secret-agent", "secret.txt", `sk-${"a".repeat(30)}\n`],
    [52, "consequential-agent", "package.json", '{"private":true,"scripts":{"check":"node check.mjs"}}\n'],
    [53, "stale-agent", "stale-tool.txt", "agent edit\n"],
    [54, "dismiss-agent", "dismissed.txt", "agent edit\n"],
  ];
  const toolRecords = [];
  for (const [id, name, path, content] of toolPatchFixtures) {
    const worktree = crew.createCrewWorktree(toolRepo, String(id), "tool");
    writeFileSync(join(worktree.root, path), content);
    const fixturePatch = crew.captureCrewPatch(worktree);
    crew.removeCrewWorktree(toolRepo, worktree);
    const diffPath = join(sessionDir, `tool-${id}.diff`);
    writeFileSync(diffPath, fixturePatch.diff);
    toolRecords.push({
      type: "custom",
      customType: "vinci-crew-helper",
      data: {
        id,
        name,
        task: `edit ${path}`,
        status: "waiting",
        diffPath,
        patchPaths: fixturePatch.paths,
        patchMetadata: {
          kind: fixturePatch.kind,
          paths: fixturePatch.paths,
          deletedPaths: fixturePatch.deletedPaths,
          baselineFingerprints: fixturePatch.baselineFingerprints,
        },
      },
    });
  }
  writeFileSync(join(toolRepo, "stale-tool.txt"), "main changed after agent\n");

  const toolHandlers = {};
  const toolEntries = [];
  const toolTools = [];
  const toolCommands = new Map();
  const toolWidgets = [];
  const toolPi = {
    on(name, handler) {
      (toolHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      toolEntries.push({ customType, data });
    },
    registerTool(tool) {
      toolTools.push(tool);
    },
    registerCommand(name, command) {
      toolCommands.set(name, command);
    },
    sendMessage() {},
    sendUserMessage() {},
  };
  crewExt.default(toolPi);
  let dismissedOfferedInAgents = false;
  const toolCtx = {
    cwd: toolRepo,
    sessionManager: {
      getBranch: () => toolRecords,
      getSessionDir: () => sessionDir,
      getSessionId: () => "orchestrator-tools-test",
    },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      notify() {},
      setWidget(_name, lines) {
        toolWidgets.push(lines);
      },
      async select(title, options) {
        if (title === "Your agents") {
          const dismissed = options.find((option) => option.includes("dismiss-agent"));
          dismissedOfferedInAgents = !!dismissed;
          return dismissed;
        }
        return "Close";
      },
    },
  };
  for (const handler of toolHandlers.session_start ?? []) await handler({ type: "session_start", reason: "resume" }, toolCtx);
  const useAgentWork = toolTools.find((tool) => tool.name === "use_agent_work");
  const dismissAgentWork = toolTools.find((tool) => tool.name === "dismiss_agent_work");

  state.resetVinciVerificationState();
  const ordinaryResult = await useAgentWork?.execute("ordinary", { agent_id: 50 }, undefined, undefined, toolCtx);
  const ordinaryRecord = toolEntries
    .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 50)
    .at(-1)?.data;
  check(
    "use_agent_work applies an ordinary edit and records its mutation",
    ordinaryResult?.details?.applied === true &&
      readFileSync(join(toolRepo, "ordinary.txt"), "utf8") === "agent edit\n" &&
      ordinaryRecord?.applied === true &&
      ordinaryRecord.status === "done" &&
      state.getVinciVerificationState().mutationRevision === 1 &&
      toolEntries.some((entry) => entry.customType === state.VINCI_VERIFICATION_ENTRY),
  );

  const secretResult = await useAgentWork?.execute(
    "secret",
    { agent_id: 51, user_approved: true },
    undefined,
    undefined,
    toolCtx,
  );
  check(
    "use_agent_work refuses secret-bearing work even with user approval",
    secretResult?.details?.applied === false &&
      secretResult.content?.[0]?.text.includes("secret") &&
      readFileSync(join(toolRepo, "secret.txt"), "utf8") === "original\n" &&
      !toolEntries
        .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 51)
        .at(-1)?.data.applied,
  );

  const consequentialFirst = await useAgentWork?.execute(
    "consequential-first",
    { agent_id: 52 },
    undefined,
    undefined,
    toolCtx,
  );
  const consequentialStayedPut = readFileSync(join(toolRepo, "package.json"), "utf8") === '{"private":true}\n';
  const consequentialSecond = await useAgentWork?.execute(
    "consequential-second",
    { agent_id: 52, user_approved: true },
    undefined,
    undefined,
    toolCtx,
  );
  check(
    "use_agent_work asks the user before applying consequential work",
    consequentialFirst?.details?.applied === false &&
      consequentialFirst.content?.[0]?.text.includes("ask the user") &&
      consequentialStayedPut &&
      consequentialSecond?.details?.applied === true &&
      readFileSync(join(toolRepo, "package.json"), "utf8").includes('"scripts"'),
  );

  const staleResult = await useAgentWork?.execute("stale", { agent_id: 53 }, undefined, undefined, toolCtx);
  check(
    "use_agent_work refuses stale work and names the changed files",
    staleResult?.details?.applied === false &&
      staleResult.content?.[0]?.text.includes("stale-tool.txt") &&
      readFileSync(join(toolRepo, "stale-tool.txt"), "utf8") === "main changed after agent\n",
  );

  const dismissResult = await dismissAgentWork?.execute("dismiss", { agent_id: 54 }, undefined, undefined, toolCtx);
  await toolCommands.get("agents").handler("", toolCtx);
  const dismissedRecord = toolEntries
    .filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 54)
    .at(-1)?.data;
  const latestWidget = toolWidgets.at(-1) ?? [];
  check(
    "dismiss_agent_work hides the row but preserves the helper for /agents",
    dismissResult?.details?.dismissed === true &&
      typeof dismissedRecord?.dismissedAt === "number" &&
      !latestWidget.some((line) => line.includes("dismiss-agent")) &&
      dismissedOfferedInAgents &&
      readFileSync(join(sessionDir, "tool-54.diff"), "utf8").includes("agent edit"),
  );

  // A crashed non-Git helper leaves only its temp-copy and the persisted creation baseline.
  const crashedNonRepo = crew.createCrewWorktree(outside, "40", "dead");
  worktrees.push(crashedNonRepo);
  writeFileSync(join(crashedNonRepo.root, "page.html"), "<h1>crash recovered</h1>\n");
  const ambiguousNonRepoA = crew.createCrewWorktree(outside, "41", "first");
  const ambiguousNonRepoB = crew.createCrewWorktree(outside, "41", "second");
  worktrees.push(ambiguousNonRepoA, ambiguousNonRepoB);
  writeFileSync(join(ambiguousNonRepoA.root, "page.html"), "<h1>wrong first</h1>\n");
  writeFileSync(join(ambiguousNonRepoB.root, "page.html"), "<h1>wrong second</h1>\n");
  const tempHandlers = {};
  const tempEntries = [];
  const tempPi = {
    on(name, handler) {
      (tempHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      tempEntries.push({ customType, data });
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  crewExt.default(tempPi);
  const tempCtx = {
    cwd: outside,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: {
            id: 40,
            name: "temp-crash",
            task: "edit the page",
            status: "working",
            patchMetadata: {
              kind: "temp-copy",
              paths: Object.keys(crashedNonRepo.baselineFingerprints),
              deletedPaths: [],
              baselineFingerprints: crashedNonRepo.baselineFingerprints,
              ignorePatterns: crashedNonRepo.ignorePatterns,
            },
          },
        },
        {
          type: "custom",
          customType: "vinci-crew-helper",
          data: {
            id: 41,
            name: "temp-ambiguous",
            task: "edit the page ambiguously",
            status: "working",
            patchMetadata: {
              kind: "temp-copy",
              paths: Object.keys(ambiguousNonRepoA.baselineFingerprints),
              deletedPaths: [],
              baselineFingerprints: ambiguousNonRepoA.baselineFingerprints,
              ignorePatterns: ambiguousNonRepoA.ignorePatterns,
            },
          },
        },
      ],
      getSessionDir: () => sessionDir,
      getSessionId: () => "temp-restore-test",
    },
    ui: {
      theme: { fg: (_color, text) => text, bold: (text) => text },
      notify() {},
      setWidget() {},
    },
  };
  for (const handler of tempHandlers.session_start ?? []) await handler({ type: "session_start", reason: "resume" }, tempCtx);
  const restoredTemp = tempEntries.filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 40).at(-1);
  check(
    "crashed non-Git temp-copy helper restores as waiting with its real changed paths",
    restoredTemp?.data.status === "waiting" &&
      JSON.stringify(restoredTemp.data.patchPaths) === JSON.stringify(["page.html"]) &&
      !!restoredTemp.data.diffPath &&
      readFileSync(restoredTemp.data.diffPath, "utf8").includes("crash recovered"),
  );
  const restoredAmbiguous = tempEntries.filter((entry) => entry.customType === "vinci-crew-helper" && entry.data.id === 41).at(-1);
  check(
    "ambiguous temp-copy candidates recover nothing",
    restoredAmbiguous?.data.status === "blocked" &&
      !restoredAmbiguous.data.diffPath &&
      !restoredAmbiguous.data.patchPaths &&
      restoredAmbiguous.data.reason?.includes("did not leave exactly one temporary workspace"),
  );
} finally {
  for (const worktree of worktrees) crew.removeCrewWorktree(base, worktree);
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(toolRepo, { recursive: true, force: true });
  rmSync(printRepo, { recursive: true, force: true });
  rmSync(shutdownRepo, { recursive: true, force: true });
}

// #76's attestation gate, pinned. An unattested agent must never be credited with its OWN
// deviations — the gate existed but nothing failed when it was removed, so this locks it down.
// (#179 guard observations are a SEPARATE, labelled channel and are deliberately not gated.)
{
  const unattestedWithClaims = crewExt.buildAgentResult({
    id: 91,
    name: "unattested",
    task: "do the thing",
    status: "done",
    summary: "done",
    deviations: ["I quietly rewrote the config"],
    deferred: [{ item: "the tests", reason: "ran out of time" }],
    attestation: "missing",
    scopeDrift: ["Changed config/app.json, which the request did not mention"],
  });
  check(
    "#76 an unattested agent's OWN deviations are dropped, not reported",
    !unattestedWithClaims.deviations.some((d) => d.includes("quietly rewrote")),
  );
  check(
    "#76 an unattested agent's OWN deferred items are dropped too",
    unattestedWithClaims.deferred.length === 0,
  );
  check("#76 attestation stays missing", unattestedWithClaims.attestation === "missing");
  check(
    "#179 but an independent guard observation still surfaces, labelled",
    unattestedWithClaims.deviations.some((d) => d.startsWith("Scope guard: ")),
  );
}

// #191: teardown must never dereference the stale-guarded extension surface. A helper runs for
// minutes; when the main session was replaced mid-run, the `finally` cleanup's ctx.cwd read threw
// the runner's stale-ctx guard and crashed the whole process AFTER the helper's work had
// integrated (observed live on 0.0.44), leaking the worktree. And pi carries the SAME guard
// (loader.ts appendEntry/sendMessage call assertActive), so persistHelper in that finally was a
// second crash one line later. runHelper now captures cwd/sessionManager as plain values at
// entry, and persistHelper/finalizeHelper degrade to best-effort when the session is gone.
{
  // The runner invalidates ctx and pi TOGETHER (AgentSession.dispose tears down the shared
  // runtime), so the simulation stales both in lockstep: the session counts as replaced
  // immediately after runHelper's entry, and every guarded access past the first one throws.
  const makeStaleWorld = (repo) => {
    const world = { cwdReads: 0, sessionManagerReads: 0, appendEntryCalls: 0 };
    const staleError = () => new Error("This extension ctx is stale after session replacement or reload (simulated).");
    world.ctx = {
      get cwd() {
        world.cwdReads += 1;
        if (world.cwdReads > 1) throw staleError();
        return repo;
      },
      get sessionManager() {
        world.sessionManagerReads += 1;
        if (world.sessionManagerReads > 1) throw staleError();
        return { getSessionId: () => "stale-ctx-test", getSessionDir: () => repo };
      },
    };
    world.pi = {
      appendEntry: () => {
        world.appendEntryCalls += 1;
        if (world.appendEntryCalls > 1) throw staleError();
      },
      sendMessage: () => {
        throw staleError();
      },
    };
    return world;
  };
  const initRepo = (prefix) => {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    const repoGit = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    repoGit(["init", "-q"]);
    writeFileSync(join(repo, "README.md"), "stale ctx repro\n");
    repoGit(["add", "."]);
    repoGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);
    return { repo, repoGit };
  };

  // Scenario 1 — teardown with no child: a replay path that cannot exist fails the run fast,
  // after the worktree is created and before any child process spawns, driving straight through
  // the catch and finally teardown with client undefined.
  {
    const { repo, repoGit } = initRepo("crew-stale-ctx-");
    try {
      const world = makeStaleWorld(repo);
      const h = {
        id: 191,
        name: "stale-ctx",
        task: "repro",
        provider: "anthropic",
        model: "test-model",
        replayDiffPath: join(repo, "missing-replay.diff"),
      };
      let teardownError;
      try {
        await crewExt.runHelper(world.pi, world.ctx, h);
      } catch (error) {
        teardownError = error;
      }
      check("#191 runHelper survives ctx AND pi going stale right after entry", teardownError === undefined);
      check("#191 the run itself still fails honestly", h.status === "failed" && typeof h.error === "string");
      check("#191 the worktree was cleaned up despite the stale ctx", h.worktree === undefined);
      check(
        "#191 no worktree left registered on the repo",
        repoGit(["worktree", "list", "--porcelain"]).trim().split("\n\n").length === 1,
      );
      check(
        "#191 ctx is read exactly once at entry — cwd and sessionManager are captured values",
        world.cwdReads === 1 && world.sessionManagerReads === 1,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Scenario 2 — the incident shape: the helper HAS work in its worktree when the run dies.
  // A valid replay diff seeds the worktree with changes, then the child CLI path points at a
  // file that does not exist, so client.start() rejects with the client already constructed.
  // The catch must salvage the patch through the captured sessionManager (a stale throw there
  // was silently swallowed, losing the work), and the finally must survive the dead client.
  {
    const { repo, repoGit } = initRepo("crew-stale-ctx-salvage-");
    const originalCliPath = process.argv[1];
    try {
      writeFileSync(join(repo, "README.md"), "stale ctx repro\nsalvaged line\n");
      const replayDiffPath = join(repo, "replay.diff");
      writeFileSync(replayDiffPath, repoGit(["diff"]));
      writeFileSync(join(repo, "README.md"), "stale ctx repro\n");
      process.argv[1] = join(repo, "no-such-cli.js");

      const world = makeStaleWorld(repo);
      const h = {
        id: 192,
        name: "stale-ctx-salvage",
        task: "repro with work to save",
        provider: "anthropic",
        model: "test-model",
        replayDiffPath,
      };
      let teardownError;
      try {
        await crewExt.runHelper(world.pi, world.ctx, h);
      } catch (error) {
        teardownError = error;
      }
      check("#191 with a dead child and work on disk, teardown still completes", teardownError === undefined);
      check(
        "#191 the partial patch was salvaged through the captured sessionManager",
        typeof h.diff === "string" && h.diff.includes("salvaged line") && existsSync(h.diffPath),
      );
      check("#191 the run reports waiting — work preserved for review, not lost", h.status === "waiting");
      check("#191 salvage worktree was still cleaned up", h.worktree === undefined);
      check(
        "#191 no salvage worktree left registered on the repo",
        repoGit(["worktree", "list", "--porcelain"]).trim().split("\n\n").length === 1,
      );
      check(
        "#191 salvage path never re-read ctx — captures only",
        world.cwdReads === 1 && world.sessionManagerReads === 1,
      );
    } finally {
      process.argv[1] = originalCliPath;
      rmSync(repo, { recursive: true, force: true });
    }
  }
}

// #193: session_shutdown teardown with a stale ctx — the silent-leak variant of #191. The handler
// read context.mode/cwd/sessionManager after awaits; a session replacement racing shutdown made
// those getters throw INSIDE Promise.allSettled, so nothing crashed and the worktree silently
// leaked (observed live on 2026-08-05, wave-5 run 3). The handler now captures plain values at
// entry and falls back to the helper's own worktree cwd when even the entry reads are stale.
{
  const repo = mkdtempSync(join(tmpdir(), "crew-shutdown-stale-"));
  const originalCliPath = process.argv[1];
  let childPid;
  try {
    const repoGit = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    repoGit(["init", "-q"]);
    writeFileSync(join(repo, "README.md"), "shutdown stale repro\n");
    repoGit(["add", "."]);
    repoGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);

    // A fake RPC child that acknowledges every command but never completes the prompt: the helper
    // parks in-flight with a live client and a real worktree — the exact state shutdown tears down.
    const staleMarker = join(repo, "helper-inflight.json");
    const hangRpcPath = join(repo, "hang-rpc.mjs");
    writeKillRpc(hangRpcPath, staleMarker, "SHUTDOWN-STALE", false);
    process.argv[1] = hangRpcPath;

    let invalidated = false;
    const staleError = () => new Error("This extension ctx is stale after session replacement or reload (simulated).");
    const handlers = {};
    const tools = [];
    const pi = {
      on(name, handler) {
        (handlers[name] ??= []).push(handler);
      },
      appendEntry() {
        if (invalidated) throw staleError();
      },
      registerTool(tool) {
        tools.push(tool);
      },
      registerCommand() {},
      sendMessage() {
        if (invalidated) throw staleError();
      },
      sendUserMessage() {},
    };
    crewExt.default(pi);
    const ctx = {
      get mode() {
        if (invalidated) throw staleError();
        return "print";
      },
      get cwd() {
        if (invalidated) throw staleError();
        return repo;
      },
      get sessionManager() {
        if (invalidated) throw staleError();
        return { getBranch: () => [], getSessionDir: () => repo, getSessionId: () => "shutdown-stale" };
      },
      get model() {
        if (invalidated) throw staleError();
        return { provider: "faux", id: "faux-model" };
      },
      get ui() {
        if (invalidated) throw staleError();
        return { theme: { fg: (_c, t) => t, bold: (t) => t }, notify() {}, setWidget() {} };
      },
    };
    for (const handler of handlers.session_start ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
    const spawnTool = tools.find((tool) => tool.name === "spawn_helper");
    // Capacity 1 makes the queueing deterministic for the #194 checks below: the first helper runs,
    // the second sits queued and must STILL get a terminal record when shutdown ends the session.
    process.env.VINCI_CREW_CAPACITY = "1";
    await spawnTool.execute("shutdown-stale", { name: "stale-helper", task: "hang until stopped" }, undefined, undefined, ctx);
    const inflight = await waitForJson(staleMarker, (value) => Number.isInteger(value?.pid) && typeof value?.cwd === "string", 15_000);
    childPid = inflight.pid;

    // #194: the cross-extension status store reflects live helper state, and session_before_exit
    // holds a one-shot run open (bounded) — with a deliberately-hung helper it must time out,
    // publish the unresolved state, and pin exit 3 rather than let the run read as clean.
    const crewStatus = await loader.import(resolve(here, "../extensions/lib/crew-status.ts"), { default: false });
    check("#194 the status store shows the helper as active while it works", crewStatus.getVinciCrewStatus()?.active >= 1);
    await spawnTool.execute("shutdown-stale-2", { name: "queued-helper", task: "never gets to start" }, undefined, undefined, ctx);
    check("#194 a capacity-queued helper counts as active in the store", crewStatus.getVinciCrewStatus()?.active >= 2);
    const exitHints = [];
    ctx.declareHeadlessExitHint = (code) => exitHints.push(code);
    process.env.VINCI_CREW_BEFORE_EXIT_WAIT_MS = "400";
    for (const handler of handlers.session_before_exit ?? []) {
      await handler({ type: "session_before_exit", mode: "text" }, ctx);
    }
    check("#194 a timed-out before-exit wait pins headless exit 3", exitHints.includes(3));
    check("#194 the store still reports unresolved work after the timed-out wait", crewStatus.getVinciCrewStatus()?.active >= 2);

    // The invalidation: ctx and pi go stale TOGETHER, as the real runtime disposes them, while the
    // helper is mid-prompt. Then the session shuts down.
    invalidated = true;
    let shutdownError;
    try {
      for (const handler of handlers.session_shutdown ?? []) await handler({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      shutdownError = error;
    }
    check("#193 shutdown teardown completes when ctx and pi are stale", shutdownError === undefined);
    check("#193 the in-flight helper's worktree directory was reclaimed, not leaked", !existsSync(inflight.cwd));
    check(
      "#193 no worktree left registered on the repo",
      repoGit(["worktree", "list", "--porcelain"]).trim().split("\n\n").length === 1,
    );
    check(
      "#193 the helper branch was deleted too — the stale-cwd fallback must not trade a worktree leak for a branch leak",
      repoGit(["branch", "--list", "vinci/helper-*"]).trim() === "",
    );
    if (childPid !== undefined) {
      await waitForProcessDeath(childPid, 5_000).catch(() => {});
      check("#193 the helper child process was stopped", !processIsAlive(childPid));
    }
    // #194: after shutdown, EVERY spawned helper has a terminal record — the queued one included —
    // and the store names both as stopped-unfinished (the receipt reads this to floor the outcome).
    const afterShutdown = crewStatus.getVinciCrewStatus();
    check("#194 no helper is left active after shutdown", afterShutdown?.active === 0);
    check(
      "#194 both the stopped in-flight helper and the never-started queued helper are reported stopped-unfinished",
      afterShutdown?.stoppedUnfinished.includes("stale-helper") && afterShutdown?.stoppedUnfinished.includes("queued-helper"),
    );
    // Dismissal is the recovery path from the stopped-unfinished floor: without it the flag was a
    // PERMANENT cross-session exit-3 latch (persisted, restored, cleared by nothing). Dismissing
    // each stopped helper must drop it from the store so later runs stop flooring.
    invalidated = false;
    // Spawn ids come from a module-level counter the test can't read; sweeping the id space
    // dismisses exactly the terminal helpers in this roster (unknown ids are graceful no-ops,
    // and this is the suite's final block).
    const dismissTool = tools.find((tool) => tool.name === "dismiss_agent_work");
    for (let agentId = 1; agentId < 300; agentId++) {
      await dismissTool.execute("dismiss", { agent_id: agentId }, undefined, undefined, ctx);
    }
    check(
      "#194 dismissing stopped-unfinished agents clears them from the store — the floor is recoverable",
      crewStatus.getVinciCrewStatus()?.stoppedUnfinished.length === 0,
    );

    // The settled path: shutdown stopped everything, but the in-flight runHelper's own async
    // teardown may still be draining (pump decrements `running` when it settles). Give before-exit
    // a real budget — its whole job is to absorb exactly this — and it must come back with the
    // crew idle and pin nothing new. A wedge here would fail the check within the budget.
    process.env.VINCI_CREW_BEFORE_EXIT_WAIT_MS = "15000";
    const hintsBefore = exitHints.length;
    for (const handler of handlers.session_before_exit ?? []) {
      await handler({ type: "session_before_exit", mode: "text" }, ctx);
    }
    check("#194 a settled crew lets before-exit return without pinning an exit hint", exitHints.length === hintsBefore);
  } finally {
    delete process.env.VINCI_CREW_CAPACITY;
    delete process.env.VINCI_CREW_BEFORE_EXIT_WAIT_MS;
    process.argv[1] = originalCliPath;
    if (childPid !== undefined && processIsAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\ncrew-integration: ${pass}/${pass + fail} checks passed (snapshot isolation + verified integration)`);
if (fail) process.exitCode = 1;
