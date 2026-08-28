import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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

export async function prepareRepository(stateDir, repo, taskId, branchOverride) {
  if (!REPO.test(repo)) throw new Error("repo must be in org/name form");
  const repoDir = join(stateDir, "repos", repo.split("/")[1]);
  const branch = branchOverride ?? `worker/${taskId}`;
  if (existsSync(repoDir)) {
    await command("git", ["-C", repoDir, "fetch", "origin"]);
    // Shared-tree quarantine: a prior run that ended without committing (honest BLOCKED/
    // UNVERIFIED, or a kill) leaves tracked modifications and untracked files that make every
    // later checkout fail ("would be overwritten"). Preserve, never discard — a failed task's
    // working tree can be the only copy of its work — then hand this task a clean tree.
    // -z: NUL-separated, UNQUOTED paths — the plain porcelain form quotes names with
    // spaces/specials, and a quoted path fails the rename while clean -fd then deletes
    // the real file: the exact loss this code exists to prevent.
    const dirty = await command("git", ["-C", repoDir, "status", "--porcelain", "-z"], { allowFailure: true });
    const entries = (dirty.stdout ?? "").split("\0").filter((l) => l.length > 1);
    if (entries.length > 0) {
      if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`unsafe taskId for debris path: ${taskId}`);
      const debrisDir = join(stateDir, "debris", taskId);
      mkdirSync(debrisDir, { recursive: true });
      writeFileSync(join(debrisDir, "status.txt"), entries.join("\n") + "\n");
      // Archive gates: a failed capture must abort BEFORE reset/clean destroys the source.
      // git apply also requires a trailing newline the harness's stdout handling can strip.
      const asPatch = (t) => (t && !t.endsWith("\n") ? t + "\n" : (t ?? ""));
      const patch = await command("git", ["-C", repoDir, "diff", "HEAD"], { allowFailure: true });
      if (patch.status !== 0) throw new Error("quarantine: tracked-diff capture failed; refusing to clean");
      writeFileSync(join(debrisDir, "tracked.patch"), asPatch(patch.stdout));
      const staged = await command("git", ["-C", repoDir, "diff", "--cached"], { allowFailure: true });
      if (staged.status !== 0) throw new Error("quarantine: staged-diff capture failed; refusing to clean");
      writeFileSync(join(debrisDir, "staged.patch"), asPatch(staged.stdout));
      for (const entry of entries) {
        if (!entry.startsWith("??")) continue;
        const rel = entry.slice(3);
        const from = join(repoDir, rel);
        const to = join(debrisDir, "untracked", rel);
        mkdirSync(dirname(to), { recursive: true });
        try { renameSync(from, to); } catch (e) {
          if (e?.code !== "ENOENT") throw e; // any other failure must abort BEFORE clean -fd deletes the file
        }
      }
      await command("git", ["-C", repoDir, "reset", "--hard", "HEAD"], { allowFailure: true });
      await command("git", ["-C", repoDir, "clean", "-fd"], { allowFailure: true });
    }
  } else {
    mkdirSync(dirname(repoDir), { recursive: true });
    const base = (process.env.VINCI_WORKER_GIT_BASE ?? "https://github.com/").replace(/\/+$/, "");
    await command("git", ["clone", `${base}/${repo}.git`, repoDir]);
  }

  if (branchOverride) {
    // Defense in depth: task.mjs validates too, but this function must be safe standalone.
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes("..") || /^refs[\/.]/.test(branch) || branch.includes("refs/") || branch.endsWith(".lock") || branch.endsWith("/") || branch === "HEAD") {
      throw new Error(`envelope branch ${branch} is not a plain git branch name`);
    }
    // git itself is the authority on ref-name legality; ask it rather than trusting our regex alone.
    const legal = await command("git", ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (legal.status !== 0) throw new Error(`envelope branch ${branch} is not a valid git branch name`);
    // The envelope pinned the branch (e.g. continuing a held PR). It must exist on origin NOW —
    // ls-remote asks origin live; a show-ref on refs/remotes/* would trust stale local copies
    // of branches deleted upstream. Silent fallback would strand work next to its target.
    const remote = await command(
      "git",
      ["-C", repoDir, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (remote.status !== 0) throw new Error(`envelope branch ${branch} not found on origin`);
    const remoteTip = remote.stdout.split("\n")[0].split(/\s/)[0];
    if (!/^[0-9a-f]{40}$/.test(remoteTip)) throw new Error(`unexpected ls-remote output for ${branch}`);
    const local = await command(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (local.status === 0) {
      // Never reset away local-only commits (a crashed prior attempt's work): -B is destructive.
      const anc = await command(
        "git",
        ["-C", repoDir, "merge-base", "--is-ancestor", branch, remoteTip],
        { allowFailure: true },
      );
      if (anc.status !== 0) throw new Error(`local branch ${branch} has commits not on origin; refusing to reset (divergence)`);
    }
    await command("git", ["-C", repoDir, "checkout", "-B", branch, remoteTip]);
    return { branch, repoDir };
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

export function runVinci({ envelope, repoDir, stateDir, taskId, sessionId }) {
  const sessionDir = join(stateDir, "sessions", taskId);
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
        sessionDir,
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

export async function publish({ envelope, repoDir, branch, taskId, limitTripped }) {
  // A BLOCKER.md at HEAD suppresses only the PR. The branch is still pushed so the agent's
  // work and its stated blocker are on the record (measured 2026-08-27: the first bus-dispatched
  // task committed a decision record + a blocker and nothing reached the remote).
  const blockerReason = await readHeadBlocker(repoDir);
  const push = await command("git", ["-C", repoDir, "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
    allowFailure: true,
  });
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (blockerReason) return { ...result, publish: push.status === 0 ? "blocked" : "push_failed", blocker_reason: blockerReason };
  if (limitTripped) return result;
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
  const createErr = `${created.stderr ?? ""}${created.stdout ?? ""}`;
  if (result.pr === null && (created.status === 0 || /already exists|already has|pull request for/i.test(createErr))) {
    // A PR may already exist for this branch (by-reference tasks continue held PRs); an
    // existing PR IS the evidence — creation failing must not classify the task UNVERIFIED.
    // Auth/network failures do NOT take this path: they stay visible as pr:null.
    const listed = await command("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url"], { cwd: repoDir, allowFailure: true });
    try {
      const parsed = JSON.parse(listed.stdout ?? "[]");
      if (Array.isArray(parsed) && parsed[0]?.url) result.pr = parsed[0].url;
    } catch { /* no JSON, no PR */ }
  }
  return result;
}

export function finalState({ envelope, exitCode, limitTripped, outcome, blocker, pr }) {
  if (exitCode !== 0 || limitTripped) return "FAILED";
  if (outcome?.state === "BLOCKED" || outcome?.state === "WAITING" || blocker) return "BLOCKED";
  if (outcome?.state === "DONE_UNVERIFIED") return "UNVERIFIED";
  if (envelope.evidence === "none" || pr) return "COMPLETED";
  return "UNVERIFIED";
}

export { command };
