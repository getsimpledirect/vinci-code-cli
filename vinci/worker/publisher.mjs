// Idempotent, fenced publisher (Wave 1).
//
// Publishing is the one place the worker mutates the outside world (origin + GitHub), so every
// effect here is keyed, conditional, and re-runnable:
//   - idempotency key = (branch, task): one branch never owns two PRs. An open PR for the branch
//     is ADOPTED only when it is provably ours — same repository owner (a same-named fork branch
//     is not ours; `gh pr list --head` matches those too), same base, and either the body footer
//     names this task or the PR's head is an ancestor-or-equal of our head (a legacy PR without a
//     footer, or a held PR this task continues). Anything else on the branch ⇒ `pr_conflict`,
//     nothing pushed, nothing created;
//   - the push is a conditional update of the CAPTURED sha, never of the mutable branch name:
//     `git push origin <sha>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<T0 sha>`
//     where T0 is what `ls-remote` sampled first (empty = must not exist). The lease is a
//     compare-and-swap against the sampled value; there is no plain --force path. After the push
//     the remote is read back and must equal the pushed sha;
//   - what is recorded: `pushed_sha`, `remote_sha_before`, `remote_sha_after`, `pr`, `pr_adopted`,
//     `pr_head`, `fenced_out`, `base_ref` — so a crash between push and PR record leaves a trail
//     and a retry adopts instead of re-pushing;
//   - the PR recorded must be AT the pushed sha (`pr_head_mismatch` otherwise, pr stays null);
//   - an optional fence (`{ generation?, check }`, the lease lane's) is consulted immediately
//     before each effect; `valid: false` (or a throwing check) skips it, `fenced_out: <reason>`.
//
// Interface:
//   publish({ repoDir, branch, taskId, attempt, baseRef, limitTripped, promotion, fence?, repoOwner?, exec? })
//   promotion: "pr" | "none" — "none" pushes the branch and never touches gh.
//   baseRef:   the PR base from the caller; "main" only when nothing is passed.
//   repoOwner: the GitHub owner of origin (the envelope's repo); derived from the origin URL if absent.
//   exec:      the structured runner (exec.mjs `command` with allowFailure); injectable for tests.
import { command } from "./exec.mjs";

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{7,64}$/;
const FOOTER_TASK = /^vinci-worker: task=(\S+)/m;
const PR_JSON_FIELDS = "number,url,state,headRefOid,headRefName,baseRefName,headRepositoryOwner,body";

export const DEFAULT_BASE_REF = "main";

const defaultExec = (name, args, options = {}) => command(name, args, { ...options, allowFailure: true });

function shaOrNull(value) {
  const candidate = (value ?? "").trim().split(/\s+/)[0] ?? "";
  return SHA.test(candidate) ? candidate : null;
}

export function prBodyFooter({ taskId, attempt, head, baseRef, fence }) {
  const generation = fence && fence.generation !== undefined && fence.generation !== null ? ` fence=${fence.generation}` : "";
  return `vinci-worker: task=${taskId} attempt=${attempt ?? 1} head=${head ?? "unknown"} base=${baseRef}${generation}`;
}

// Exported so every consequential side effect in the worker asks a fence the SAME way — the
// publisher's push and PR, and the evidence POST (evidence.mjs). One implementation means one
// answer to "what does a throwing check mean" (fail closed) rather than two that can drift.
export async function checkFence(fence, stage) {
  if (!fence || typeof fence.check !== "function") return { valid: true };
  try {
    const verdict = await fence.check({ stage });
    if (verdict && verdict.valid === true) return { valid: true };
    return { valid: false, reason: verdict?.reason ?? `fence invalid before ${stage}` };
  } catch (error) {
    return { valid: false, reason: `fence check failed before ${stage}: ${error.message}` };
  }
}

function parsePrs(stdout) {
  try {
    const parsed = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.url === "string" && PR_URL.test(entry.url)) : [];
  } catch {
    return [];
  }
}

async function listPrs({ repoDir, branch, state, exec }) {
  const listed = await exec("gh", ["pr", "list", "--head", branch, "--state", state, "--json", PR_JSON_FIELDS], { cwd: repoDir });
  return listed.status === 0 ? parsePrs(listed.stdout) : [];
}

async function viewPr({ repoDir, url, exec }) {
  const viewed = await exec("gh", ["pr", "view", url, "--json", PR_JSON_FIELDS], { cwd: repoDir });
  if (viewed.status !== 0) return null;
  try {
    const parsed = JSON.parse(viewed.stdout || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function isAncestorOrEqual({ repoDir, ancestor, descendant, exec }) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  // An unknown object (a commit never fetched) fails here too — refusing is the safe read.
  const check = await exec("git", ["-C", repoDir, "merge-base", "--is-ancestor", ancestor, descendant]);
  return check.status === 0;
}

// origin's GitHub owner, from the envelope when the caller has it, else from the origin URL.
async function resolveRepoOwner({ repoDir, repoOwner, exec }) {
  if (typeof repoOwner === "string" && repoOwner.trim()) return repoOwner.trim();
  const url = await exec("git", ["-C", repoDir, "remote", "get-url", "origin"]);
  if (url.status !== 0) return null;
  const match = /github\.com[:/]([^/\s]+)\/[^/\s]+?(?:\.git)?$/.exec(url.stdout.trim());
  return match ? match[1] : null;
}

// P1 (hardened): is this open PR ours? Returns { adopt: true, via } or { adopt: false, reason }.
async function classifyCandidate({ pr, repoDir, branch, base, taskId, head, owner, exec }) {
  const prOwner = pr.headRepositoryOwner?.login ?? pr.headRepositoryOwner?.name ?? null;
  if (!owner || !prOwner || prOwner !== owner) return { adopt: false, reason: `PR #${pr.number ?? "?"} head owner ${prOwner ?? "unknown"} is not ${owner ?? "the origin owner"} (fork)` };
  if (pr.headRefName !== branch) return { adopt: false, reason: `PR #${pr.number ?? "?"} head ref ${pr.headRefName ?? "unknown"} is not ${branch}` };
  if (pr.baseRefName !== base) return { adopt: false, reason: `PR #${pr.number ?? "?"} base ${pr.baseRefName ?? "unknown"} is not ${base}` };
  const footerTask = FOOTER_TASK.exec(pr.body ?? "")?.[1] ?? null;
  if (footerTask === taskId) return { adopt: true, via: "footer" };
  if (await isAncestorOrEqual({ repoDir, ancestor: pr.headRefOid, descendant: head, exec })) return { adopt: true, via: footerTask ? "continuation" : "ancestry" };
  return {
    adopt: false,
    reason: footerTask
      ? `PR #${pr.number ?? "?"} belongs to task ${footerTask} and its head ${pr.headRefOid ?? "unknown"} is not an ancestor of ${head ?? "our head"}`
      : `PR #${pr.number ?? "?"} has no worker footer and its head ${pr.headRefOid ?? "unknown"} is not an ancestor of ${head ?? "our head"}`,
  };
}

async function findOurOpenPr(context) {
  const open = await listPrs({ ...context, state: "open" });
  const conflicts = [];
  for (const pr of open) {
    const verdict = await classifyCandidate({ ...context, pr });
    if (verdict.adopt) return { pr, via: verdict.via, conflicts };
    conflicts.push(verdict.reason);
  }
  return { pr: null, via: null, conflicts };
}

// P2: what origin holds for the branch right now; null sha when the branch is absent.
export async function remoteBranchSha({ repoDir, branch, exec }) {
  const probe = await exec("git", ["-C", repoDir, "ls-remote", "origin", `refs/heads/${branch}`]);
  if (probe.status !== 0) return { sha: null, error: probe.stderr || `ls-remote exited ${probe.status}` };
  return { sha: shaOrNull(probe.stdout), error: null };
}

// B5: the PR we are about to record must be AT the pushed sha.
async function verifyPrHead({ repoDir, url, pushedSha, exec }) {
  const view = await viewPr({ repoDir, url, exec });
  const prHead = view?.headRefOid ?? null;
  return { ok: Boolean(prHead) && prHead === pushedSha, prHead, number: view?.number ?? null };
}

// A PR title a human can triage without opening it. The task id stays because it is the join key
// between a PR, its branch (`worker/<id>`) and its bus record -- but it is no longer the WHOLE
// title, which is what made 235 of 236 worker PRs unreadable and turned one repo into an inbox.
export function prTitle({ taskId, objective, outcome, head, ref }) {
  const words = typeof objective === "string" ? objective.replace(/\s+/g, " ").trim() : "";
  // First sentence or clause, so a multi-paragraph spec does not become a multi-line title.
  const first = words.split(/(?<=[.!?])\s|\n/)[0] ?? "";
  const trimmed = first.length > 72 ? `${first.slice(0, 69).trimEnd()}...` : first;
  const shortHead = typeof head === "string" && head.length >= 7 ? head.slice(0, 7) : null;
  const tail = [taskId, shortHead ? `@${shortHead}` : null, ref ?? null].filter(Boolean).join(" ");
  const lead = outcome ? `${outcome}: ` : "";
  // Never emit a bare `Worker task <id>` again: with no objective the outcome and refs still carry
  // more than the id alone did.
  return trimmed ? `${lead}${trimmed} [${tail}]` : `${lead}worker task [${tail}]`;
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
  repoOwner = null,
  objective = null,
  outcome = null,
  ref = null,
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
    remote_sha_after: null,
    base_ref: base,
  };

  // The sha we publish is captured ONCE; every later step refers to it, never to the branch name.
  const localHead = await exec("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const head = localHead.status === 0 ? shaOrNull(localHead.stdout) : null;
  if (!head) return { ...record, publish: "push_failed", push_error: `local refs/heads/${branch} does not resolve to a commit` };

  // --- P2: remote SHA discipline (sample T0) --------------------------------------------------
  const remote = await remoteBranchSha({ repoDir, branch, exec });
  if (remote.error) return { ...record, publish: "push_failed", push_error: `could not read origin/${branch}: ${remote.error}` };
  record.remote_sha_before = remote.sha;
  const alreadyOnRemote = remote.sha === head;
  if (remote.sha && !alreadyOnRemote && !(await isAncestorOrEqual({ repoDir, ancestor: remote.sha, descendant: head, exec }))) {
    return { ...record, publish: "remote_moved", refusal_reason: `origin/${branch} is at ${remote.sha}, not an ancestor of local ${head}; never force-pushing` };
  }

  // --- P1: find our PR BEFORE touching origin (a foreign PR on the branch refuses everything) --
  const wantPr = promotion === "pr" && !limitTripped;
  const owner = wantPr ? await resolveRepoOwner({ repoDir, repoOwner, exec }) : null;
  const prContext = { repoDir, branch, base, taskId, head, owner, exec };
  let adopted = null;
  if (wantPr) {
    const found = await findOurOpenPr(prContext);
    if (!found.pr && found.conflicts.length > 0) {
      return { ...record, publish: "pr_conflict", refusal_reason: found.conflicts.join("; "), pr_conflicts: found.conflicts };
    }
    adopted = found;
  }

  // --- push: fenced, conditional on the sampled sha, read back --------------------------------
  if (alreadyOnRemote) {
    // A retry after a crash between push and PR record: origin already holds our sha — no push.
    record.publish = "pushed";
    record.pushed_sha = head;
    record.remote_sha_after = head;
    record.push_skipped = "remote_at_head";
  } else {
    const gate = await checkFence(fence, "push");
    if (!gate.valid) return { ...record, publish: "fenced_out", fenced_out: gate.reason };
    const push = await exec("git", [
      "-C", repoDir, "push", "origin", `${head}:refs/heads/${branch}`,
      `--force-with-lease=refs/heads/${branch}:${remote.sha ?? ""}`,
    ]);
    if (push.status !== 0) {
      const text = `${push.stderr ?? ""}\n${push.stdout ?? ""}`;
      if (/stale info|rejected|fetch first|non-fast-forward/i.test(text)) {
        const after = await remoteBranchSha({ repoDir, branch, exec });
        return { ...record, publish: "remote_moved", remote_sha_after: after.sha, refusal_reason: `origin/${branch} moved after it was sampled at ${remote.sha ?? "absent"}; lease rejected the push, nothing forced` };
      }
      return { ...record, publish: "push_failed", push_error: push.stderr || `git push exited ${push.status}` };
    }
    record.pushed_sha = head;
    // The branch now tracks itself on origin (what `push --set-upstream` used to record; the
    // never-pushed residue classifier reads exactly these two keys). Best effort, never fatal.
    await exec("git", ["-C", repoDir, "config", `branch.${branch}.remote`, "origin"]);
    await exec("git", ["-C", repoDir, "config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    const readback = await remoteBranchSha({ repoDir, branch, exec });
    record.remote_sha_after = readback.sha;
    if (readback.error || readback.sha !== head) {
      return { ...record, publish: "remote_readback_mismatch", refusal_reason: `origin/${branch} reads ${readback.sha ?? readback.error ?? "absent"} after pushing ${head}` };
    }
    record.publish = "pushed";
  }

  if (!wantPr) return record;

  // --- PR: adopt (verified at the pushed sha) or create exactly one -----------------------------
  const recordPr = async (url, viaAdoption) => {
    const check = await verifyPrHead({ repoDir, url, pushedSha: record.pushed_sha, exec });
    if (!check.ok) {
      return { ...record, pr: null, pr_adopted: false, pr_head: check.prHead, pr_error: `pr_head_mismatch: ${url} is at ${check.prHead ?? "unknown"}, pushed ${record.pushed_sha}` };
    }
    return { ...record, pr: url, pr_adopted: Boolean(viaAdoption), pr_head: check.prHead, ...(viaAdoption ? { pr_adopted_via: viaAdoption } : {}) };
  };

  if (adopted?.pr) return recordPr(adopted.pr.url, adopted.via);

  const gate = await checkFence(fence, "pr");
  if (!gate.valid) return { ...record, fenced_out: gate.reason };

  const body = `Unattended Vinci worker result for task ${taskId}.\n\n${prBodyFooter({ taskId, attempt, head: record.pushed_sha, baseRef: base, fence })}`;
  const created = await exec(
    "gh",
    ["pr", "create", "--base", base, "--head", branch,
     "--title", prTitle({ taskId, objective, outcome, head: record.pushed_sha, ref }),
     "--body", body],
    { cwd: repoDir },
  );
  const createdUrl = created.status === 0 ? created.stdout.split("\n").find((line) => PR_URL.test(line)) ?? null : null;
  if (createdUrl) return recordPr(createdUrl, null);

  const createErr = `${created.stderr ?? ""}${created.stdout ?? ""}`;
  if (created.status === 0 || /already exists|already has|pull request for/i.test(createErr)) {
    // W1: lost the race between list and create, or gh printed nothing parseable. List EVERY
    // state: an open PR that is ours is adopted; a closed/merged one on the branch means the
    // branch's PR history is spent — refuse, never open a second. Auth/network failures do NOT
    // take this path: they stay visible as pr:null.
    const all = await listPrs({ repoDir, branch, state: "all", exec });
    const conflicts = [];
    for (const pr of all) {
      const state = String(pr.state ?? "OPEN").toUpperCase();
      if (state === "OPEN") {
        const verdict = await classifyCandidate({ ...prContext, pr });
        if (verdict.adopt) return recordPr(pr.url, verdict.via);
        conflicts.push(verdict.reason);
      } else if ((pr.headRepositoryOwner?.login ?? pr.headRepositoryOwner?.name ?? owner) === owner && pr.headRefName === branch) {
        return { ...record, publish: "pr_closed", pr: null, refusal_reason: `${pr.url} for ${branch} is ${state.toLowerCase()}; never opening a second PR on the branch` };
      }
    }
    if (conflicts.length > 0) return { ...record, publish: "pr_conflict", refusal_reason: conflicts.join("; "), pr_conflicts: conflicts };
  }
  return { ...record, pr_error: created.stderr || `gh pr create exited ${created.status} without a PR URL` };
}
