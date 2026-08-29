// Idempotent, fenced publisher (Wave 1).
//
// Publishing is the one place the worker mutates the outside world (origin + GitHub), so every
// effect here is keyed and re-runnable:
//   - idempotency key = (branch, task): one branch never owns two open PRs — an existing open PR
//     for the branch is ADOPTED (`pr_adopted: true`), never duplicated;
//   - the exact sha pushed is recorded (`pushed_sha`) together with what the remote held before
//     the push (`remote_sha_before`), so a crash between the push and the PR record still leaves
//     a findable trail and a retry adopts instead of re-pushing;
//   - the push is NEVER forced: if the remote branch moved to a commit that is not an ancestor of
//     our head, the push is refused (`publish: "remote_moved"`) and nothing is created;
//   - an optional fence (`{ check }`, supplied by the lease lane) is consulted immediately before
//     each effect; `valid: false` skips that effect and records `fenced_out: <reason>`.
//
// Interface: publish({ repoDir, branch, taskId, attempt, baseRef, limitTripped, promotion, fence?, exec? })
//   promotion: "pr" | "none" — "none" pushes the branch but never opens a PR.
//   baseRef:   PR base; the caller (envelope/handoff) supplies it, "main" only when nothing is passed.
//   exec:      optional command runner ({status, stdout, stderr}); defaults to a local spawn.
import { spawn } from "node:child_process";

import { resolveBin } from "./build.mjs";

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{7,64}$/;

export const DEFAULT_BASE_REF = "main";

function defaultExec(commandName, args, options = {}) {
  return new Promise((resolveCommand) => {
    let executable;
    try {
      executable = resolveBin(commandName);
    } catch (error) {
      resolveCommand({ status: null, signal: null, stdout: "", stderr: error.message });
      return;
    }
    const child = spawn(executable, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    child.once("error", (error) => {
      settled = true;
      resolveCommand({ status: null, signal: null, stdout: "", stderr: error.message });
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      resolveCommand({ status, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function shaOrNull(value) {
  const candidate = (value ?? "").trim().split(/\s+/)[0] ?? "";
  return SHA.test(candidate) ? candidate : null;
}

export function prBodyFooter({ taskId, attempt, head, baseRef, fence }) {
  const generation = fence && fence.generation !== undefined && fence.generation !== null ? ` fence=${fence.generation}` : "";
  return `vinci-worker: task=${taskId} attempt=${attempt ?? 1} head=${head ?? "unknown"} base=${baseRef}${generation}`;
}

async function checkFence(fence, stage) {
  if (!fence || typeof fence.check !== "function") return { valid: true };
  try {
    const verdict = await fence.check({ stage });
    if (verdict && verdict.valid === true) return { valid: true };
    return { valid: false, reason: verdict?.reason ?? `fence invalid before ${stage}` };
  } catch (error) {
    return { valid: false, reason: `fence check failed before ${stage}: ${error.message}` };
  }
}

function parsePrList(stdout) {
  try {
    const parsed = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) return null;
    const open = parsed.find((entry) => entry && typeof entry.url === "string" && PR_URL.test(entry.url));
    return open ?? null;
  } catch {
    return null;
  }
}

// P1: the open PR for a branch, if any. Non-JSON / failed output reads as "none known" — the
// create step still runs and its own "already exists" path re-lists (race between list and create).
export async function findOpenPr({ repoDir, branch, exec }) {
  const listed = await exec("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,headRefOid"], { cwd: repoDir });
  if (listed.status !== 0) return null;
  return parsePrList(listed.stdout);
}

// P2: what origin holds for the branch right now; null when the branch is absent or unreadable.
export async function remoteBranchSha({ repoDir, branch, exec }) {
  const probe = await exec("git", ["-C", repoDir, "ls-remote", "origin", `refs/heads/${branch}`]);
  if (probe.status !== 0) return { sha: null, error: probe.stderr || `ls-remote exited ${probe.status}` };
  return { sha: shaOrNull(probe.stdout), error: null };
}

export async function publish({
  repoDir,
  branch,
  taskId,
  attempt = 1,
  baseRef,
  limitTripped = null,
  promotion = "pr",
  fence = null,
  exec = defaultExec,
}) {
  if (!repoDir || !branch || !taskId) throw new Error("publish requires repoDir, branch and taskId");
  const base = typeof baseRef === "string" && baseRef.trim() ? baseRef.trim() : DEFAULT_BASE_REF;

  const record = {
    publish: null,
    pr: null,
    pr_adopted: false,
    pushed_sha: null,
    remote_sha_before: null,
    base_ref: base,
  };

  const localHead = await exec("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const head = localHead.status === 0 ? shaOrNull(localHead.stdout) : null;

  // --- P2: remote SHA discipline -------------------------------------------------------------
  const remote = await remoteBranchSha({ repoDir, branch, exec });
  record.remote_sha_before = remote.sha;
  if (remote.error) record.remote_probe_error = remote.error;

  let alreadyOnRemote = false;
  if (remote.sha) {
    if (head && remote.sha === head) {
      alreadyOnRemote = true;
    } else {
      // The remote commit must be an ancestor of what we are about to push. An unknown object
      // (someone pushed a commit we never fetched) fails this check too — refusing is the safe read.
      const ancestry = await exec("git", ["-C", repoDir, "merge-base", "--is-ancestor", remote.sha, `refs/heads/${branch}`]);
      if (ancestry.status !== 0) {
        return { ...record, publish: "remote_moved", refusal_reason: `origin/${branch} is at ${remote.sha}, not an ancestor of local ${head ?? "head"}; never force-pushing` };
      }
    }
  }

  // --- push (fenced) ----------------------------------------------------------------------------
  if (alreadyOnRemote) {
    // A retry after a crash between push and PR record: the sha is already there — adopt, don't re-push.
    record.publish = "pushed";
    record.pushed_sha = head;
    record.push_skipped = "remote_at_head";
  } else {
    const gate = await checkFence(fence, "push");
    if (!gate.valid) return { ...record, publish: "fenced_out", fenced_out: gate.reason };
    const push = await exec("git", ["-C", repoDir, "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    if (push.status !== 0) return { ...record, publish: "push_failed", push_error: push.stderr || null };
    record.publish = "pushed";
    record.pushed_sha = head;
  }

  // --- PR (idempotent, fenced) ------------------------------------------------------------------
  if (limitTripped || promotion !== "pr") return record;

  const existing = await findOpenPr({ repoDir, branch, exec });
  if (existing) {
    return { ...record, pr: existing.url, pr_adopted: true, pr_head: existing.headRefOid ?? null };
  }

  const gate = await checkFence(fence, "pr");
  if (!gate.valid) return { ...record, fenced_out: gate.reason };

  const body = `Unattended Vinci worker result for task ${taskId}.\n\n${prBodyFooter({ taskId, attempt, head: record.pushed_sha ?? head, baseRef: base, fence })}`;
  const created = await exec(
    "gh",
    ["pr", "create", "--base", base, "--head", branch, "--title", `Worker task ${taskId}`, "--body", body],
    { cwd: repoDir },
  );
  if (created.status === 0) record.pr = created.stdout.split("\n").find((line) => PR_URL.test(line)) ?? null;
  const createErr = `${created.stderr ?? ""}${created.stdout ?? ""}`;
  if (record.pr === null && (created.status === 0 || /already exists|already has|pull request for/i.test(createErr))) {
    // Lost the race between list and create (or gh printed nothing parseable): the existing PR
    // IS the evidence. Auth/network failures do NOT take this path: they stay visible as pr:null.
    const raced = await findOpenPr({ repoDir, branch, exec });
    if (raced) {
      record.pr = raced.url;
      record.pr_adopted = true;
      record.pr_head = raced.headRefOid ?? null;
    }
  }
  if (record.pr === null && created.status !== 0) record.pr_error = created.stderr || `gh pr create exited ${created.status}`;
  return record;
}
