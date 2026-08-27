import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

import { readSessionState } from "./session-read.mjs";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

function resolveBin(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Executable not found on PATH: ${name}`);
}

function command(commandName, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    let executable;
    try {
      executable = resolveBin(commandName);
    } catch (error) {
      if (options.allowFailure) {
        resolveCommand({ status: null, signal: null, stdout: "", stderr: error.message });
      } else {
        rejectCommand(error);
      }
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    let settled = false;
    child.once("error", (error) => {
      settled = true;
      if (options.allowFailure) resolveCommand({ status: null, signal: null, stdout: "", stderr: error.message });
      else rejectCommand(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      const result = { status, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (status === 0 || options.allowFailure) resolveCommand(result);
      else rejectCommand(new Error(`${commandName} ${args.join(" ")} failed: ${stderr.trim() || signal || status}`));
    });
  });
}

function signalExitCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}

function terminateProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export async function prepareRepository(stateDir, repo, taskId) {
  if (!REPO.test(repo)) throw new Error("repo must be in org/name form");
  const repoDir = join(stateDir, "repos", repo.split("/")[1]);
  const branch = `worker/${taskId}`;
  if (existsSync(repoDir)) {
    await command("git", ["-C", repoDir, "fetch", "origin"]);
  } else {
    mkdirSync(dirname(repoDir), { recursive: true });
    const base = (process.env.VINCI_WORKER_GIT_BASE ?? "https://github.com/").replace(/\/+$/, "");
    await command("git", ["clone", `${base}/${repo}.git`, repoDir]);
  }

  const localBranch = await command(
    "git",
    ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowFailure: true },
  );
  if (localBranch.status === 0) await command("git", ["-C", repoDir, "checkout", branch]);
  else await command("git", ["-C", repoDir, "checkout", "-b", branch, "origin/main"]);
  return { branch, repoDir };
}

export function runVinci({ envelope, repoDir, sessionId }) {
  const sessionDir = join(repoDir, "sessions");
  const pollMs = Number(process.env.VINCI_WORKER_LIMIT_POLL_MS) || 15_000;
  const killGraceMs = Number(process.env.VINCI_WORKER_KILL_GRACE_MS) || 30_000;
  mkdirSync(sessionDir, { recursive: true });

  return new Promise((resolveRun) => {
    const child = spawn(
      resolveBin("vinci"),
      [
        "-p",
        "--session-id",
        sessionId,
        "--session-dir",
        "sessions",
        "--provider",
        envelope.provider,
        "--model",
        envelope.model,
        "--tools",
        "read,grep,find,ls,bash,edit,write",
        envelope.spec,
      ],
      { cwd: repoDir, detached: true, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
    );
    let limitTripped = null;
    let killTimer;
    let settled = false;

    const tripLimit = (limit) => {
      if (limitTripped || settled) return;
      limitTripped = limit;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), killGraceMs);
      killTimer.unref();
    };

    const runtimeTimer = setTimeout(() => tripLimit("max_runtime_s"), envelope.max_runtime_s * 1000);
    runtimeTimer.unref();
    const pollTimer = setInterval(() => {
      if (envelope.deadline && Date.now() >= Date.parse(envelope.deadline)) {
        tripLimit("deadline");
        return;
      }
      if (readSessionState(sessionDir, sessionId).costUsd >= envelope.budget_usd) tripLimit("budget_usd");
    }, pollMs);
    pollTimer.unref();

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(runtimeTimer);
      clearInterval(pollTimer);
      if (killTimer) clearTimeout(killTimer);
      const session = readSessionState(sessionDir, sessionId);
      if (!limitTripped && session.costUsd >= envelope.budget_usd) limitTripped = "budget_usd";
      if (!limitTripped && envelope.deadline && Date.now() >= Date.parse(envelope.deadline)) limitTripped = "deadline";
      resolveRun({
        exit_code: signalExitCode(code, signal),
        limit_tripped: limitTripped,
        cost_usd: session.costUsd,
        outcome: session.outcome,
      });
    };
    child.once("error", () => finish(1, null));
    child.once("close", finish);
  });
}

export async function readHead(repoDir) {
  const result = await command("git", ["-C", repoDir, "rev-parse", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

export async function readHeadBlocker(repoDir) {
  const exists = await command("git", ["-C", repoDir, "cat-file", "-e", "HEAD:BLOCKER.md"], {
    allowFailure: true,
  });
  if (exists.status !== 0) return null;
  const contents = await command("git", ["-C", repoDir, "show", "HEAD:BLOCKER.md"], { allowFailure: true });
  return contents.status === 0 && contents.stdout.trim() ? "BLOCKER.md at HEAD is non-empty" : null;
}

export async function publish({ envelope, repoDir, branch, taskId }) {
  const blockerReason = await readHeadBlocker(repoDir);
  if (blockerReason) return { publish: "blocked", pr: null, blocker_reason: blockerReason };
  const push = await command("git", ["-C", repoDir, "push", "--set-upstream", "origin", branch], {
    allowFailure: true,
  });
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (push.status !== 0 || envelope.evidence !== "pr") return result;

  const created = await command(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `Worker task ${taskId}`,
      "--body",
      `Unattended Vinci worker result for task ${taskId}.`,
    ],
    { cwd: repoDir, allowFailure: true },
  );
  if (created.status === 0) result.pr = created.stdout.split("\n").find((line) => PR_URL.test(line)) ?? null;
  return result;
}

export function finalState({ envelope, exitCode, limitTripped, outcome, blocker, pr }) {
  if (exitCode !== 0 || limitTripped) return "FAILED";
  if (outcome?.state === "BLOCKED" || outcome?.state === "WAITING" || blocker) return "BLOCKED";
  if (outcome?.state === "DONE_UNVERIFIED") return "UNVERIFIED";
  if (envelope.evidence === "none" || pr) return "COMPLETED";
  return "UNVERIFIED";
}
