import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(root, "vinci/bin/vinci");
const providerExtension = join(root, "vinci/test/fixtures/checkpoint-faux-provider.ts");
const pauseExtension = join(root, "vinci/test/fixtures/checkpoint-pause.ts");
// Cold loading every product extension can be filesystem-bound on a busy host. These are watchdogs,
// not substitutes for the marker that proves the write landed inside the intended crash window.
const STARTUP_TIMEOUT_MS = 60_000;
const PROCESS_TIMEOUT_MS = 75_000;
const processGroups = new Set();

function killProcessGroup(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists(child) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processGroupExists(child)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Vinci process group ${child.pid} survived SIGKILL`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      killProcessGroup(child);
      reject(new Error(`child process did not exit within ${timeoutMs}ms`));
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

async function waitForFile(path, child, timeoutMs, outputPath) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").slice(-4000) : "no child output";
      throw new Error(`Vinci exited before reaching the post-write crash window:\n${output}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`marker did not appear within ${timeoutMs}ms`);
}

function startVinci(cwd, outputPath, args, env) {
  const outputFd = openSync(outputPath, "a");
  // The launcher waits on a background Node child. Give both a private process group so SIGKILL
  // cannot leave the runtime alive to race the resumed process against the same session file.
  const child = spawn("bash", [launcher, ...args], {
    cwd,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", outputFd, outputFd],
  });
  processGroups.add(child);
  child.once("exit", () => closeSync(outputFd));
  return child;
}

const temp = mkdtempSync(join(tmpdir(), "vinci-checkpoint-process-"));
try {
  const home = join(temp, "home");
  const sessions = join(temp, "sessions");
  const marker = join(temp, "kill-window.marker");
  const firstLog = join(temp, "first.log");
  const resumeLog = join(temp, "resume.log");
  const commonEnv = {
    HOME: home,
    VINCI_INTERNAL_PROVIDER_TEST: "1",
    VINCI_MODEL: "faux-1",
    VINCI_TOOL_BOOTSTRAP: "0",
    VINCI_NO_RESUME: "1",
    VINCI_NO_VERIFY: "1",
    VINCI_PROVIDER: "faux",
    VINCI_CHECKPOINT_KILL_MARKER: marker,
  };

  const first = startVinci(
    temp,
    firstLog,
    [
      "--session-dir",
      sessions,
      "--session-id",
      "lunch-test",
      "--extension",
      providerExtension,
      "--extension",
      pauseExtension,
      "--mode",
      "json",
      "-p",
      "Create interrupted.txt with the requested content.",
    ],
    commonEnv,
  );
  const firstExit = waitForExit(first, PROCESS_TIMEOUT_MS);
  await waitForFile(marker, first, STARTUP_TIMEOUT_MS, firstLog);
  const target = join(temp, "interrupted.txt");
  assert.equal(readFileSync(target, "utf8"), "written once before process death\n");
  const beforeResume = statSync(target, { bigint: true }).mtimeNs;
  killProcessGroup(first);
  const killed = await firstExit;
  assert.equal(killed.signal, "SIGKILL");
  await waitForProcessGroupExit(first, 2_000);
  processGroups.delete(first);

  const sessionFiles = readdirSync(sessions).filter((file) => file.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 1);
  const sessionPath = join(sessions, sessionFiles[0]);
  const beforeEntries = readFileSync(sessionPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    beforeEntries.some(
      (entry) => entry.type === "custom" && entry.customType === "vinci-tool-checkpoint" && entry.data.event === "started",
    ),
  );
  assert.equal(
    beforeEntries.some(
      (entry) => entry.type === "custom" && entry.customType === "vinci-tool-checkpoint" && entry.data.event === "completed",
    ),
    false,
  );
  assert.equal(
    beforeEntries.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
    false,
  );

  const resume = startVinci(
    temp,
    resumeLog,
    [
      "resume",
      "lunch-test",
      "--session-dir",
      sessions,
      "--extension",
      providerExtension,
      "--mode",
      "json",
      "-p",
      "Continue the interrupted task.",
    ],
    { ...commonEnv, VINCI_CHECKPOINT_KILL_MARKER: "" },
  );
  const resumed = await waitForExit(resume, PROCESS_TIMEOUT_MS);
  assert.equal(resumed.code, 0, readFileSync(resumeLog, "utf8").slice(-4000));
  await waitForProcessGroupExit(resume, 2_000);
  processGroups.delete(resume);
  assert.equal(readFileSync(target, "utf8"), "written once before process death\n");
  assert.equal(statSync(target, { bigint: true }).mtimeNs, beforeResume, "resume must not rewrite the completed file");

  const afterEntries = readFileSync(sessionPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    afterEntries.some(
      (entry) => entry.type === "custom" && entry.customType === "vinci-tool-checkpoint" && entry.data.event === "recovered",
    ),
  );
  assert.ok(
    afterEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.isError === true &&
        entry.message.content.some((part) => part.type === "text" && /already completed/.test(part.text)),
    ),
  );
  assert.match(readFileSync(resumeLog, "utf8"), /Resume completed without replaying the write/);
} finally {
  for (const child of processGroups) killProcessGroup(child);
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("  checkpoint process integration: SIGKILL resume does not replay a completed write\n");
