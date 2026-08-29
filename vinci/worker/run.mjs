import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveBin } from "./build.mjs";
import { command } from "./exec.mjs";
import { publish as publishBranch } from "./publisher.mjs";
import { readSessionState } from "./session-read.mjs";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

function validateBranchName(branch) {
  // Defense in depth: task.mjs validates too, but this function must be safe standalone.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes("..") || /^refs[\/.]/.test(branch) || branch.includes("refs/") || branch.endsWith(".lock") || branch.endsWith("/") || branch === "HEAD") {
    throw new Error(`envelope branch ${branch} is not a plain git branch name`);
  }
}

// Move a local branch out of the way under stale/<branch>-<UTC stamp>-<6 hex>. Never deletes: a
// stale branch can be the only copy of an earlier attempt's work. The nonce keeps two renames in
// the same second apart; the destination is verified absent before `branch -m` (which would
// otherwise refuse, or with -M clobber). `stamp`/`nonce` are injectable for tests only.
export async function renameBranchAside(repoDir, branch, { stamp, nonce } = {}) {
  const stampText = stamp ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let candidateNonce = nonce;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const asideName = `stale/${branch}-${stampText}-${candidateNonce ?? randomBytes(3).toString("hex")}`;
    const taken = await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${asideName}`], { allowFailure: true });
    if (taken.status === 0) {
      candidateNonce = null; // collision: draw a fresh nonce, never overwrite
      continue;
    }
    await command("git", ["-C", repoDir, "branch", "-m", branch, asideName]);
    return asideName;
  }
  throw new Error(`could not find a free stale/ name for ${branch}`);
}

// Never-pushed residue classification (divergence path). Returns { residue: true } only when ALL
// hold: (ii) the local branch does not track origin/<branch> (a branch that was pushed carries that
// upstream from `push --set-upstream`; the daemon's own default path `checkout -b worker/<id>
// origin/main` leaves the upstream at origin/MAIN, which is not evidence of a push), (iii) no live
// origin head contains its tip and no commit in <remoteTip>..<localSha> is reachable from any
// origin head. ALL origin heads are fetched by explicit full refspec first: a narrow-refspec cache
// (--single-branch) would otherwise leave a head outside its refspec invisible and misclassify
// work pushed there as never-pushed. If the branch has ANY configured upstream whose
// remote-tracking ref is still unresolvable after that fetch, fail closed: { residue: false,
// note } naming it. Any check error ⇒ { residue: false } (refuse as before, rename nothing).
async function classifyDivergedLocal(repoDir, branch, localSha, remoteTip) {
  const upstreamRemote = await command("git", ["-C", repoDir, "config", "--get", `branch.${branch}.remote`], { allowFailure: true });
  const upstreamMerge = await command("git", ["-C", repoDir, "config", "--get", `branch.${branch}.merge`], { allowFailure: true });
  for (const probe of [upstreamRemote, upstreamMerge]) if (probe.status !== 0 && probe.status !== 1) return { residue: false };
  const hasUpstream = upstreamRemote.status === 0 || upstreamMerge.status === 0;
  const tracksItself = upstreamRemote.status === 0 && upstreamMerge.status === 0 && upstreamRemote.stdout === "origin" && upstreamMerge.stdout === `refs/heads/${branch}`;
  if (tracksItself) return { residue: false };
  const refresh = await command("git", ["-C", repoDir, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], { allowFailure: true });
  if (refresh.status !== 0) return { residue: false };
  if (hasUpstream) {
    const upstreamLabel = `${upstreamRemote.stdout || "?"}/${upstreamMerge.stdout || "?"}`;
    const trackingRef = upstreamRemote.stdout === "origin" && upstreamMerge.stdout.startsWith("refs/heads/")
      ? `refs/remotes/origin/${upstreamMerge.stdout.slice("refs/heads/".length)}`
      : null;
    const resolvable = trackingRef
      ? await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", trackingRef], { allowFailure: true })
      : { status: 1 };
    if (resolvable.status !== 0) return { residue: false, note: `upstream ${upstreamLabel} of ${branch} is not resolvable on origin; not treating it as never-pushed` };
  }
  const containing = await command("git", ["-C", repoDir, "for-each-ref", `--contains=${localSha}`, "refs/remotes/origin"], { allowFailure: true });
  if (containing.status !== 0 || containing.stdout) return { residue: false };
  const range = await command("git", ["-C", repoDir, "rev-list", "--count", `${remoteTip}..${localSha}`], { allowFailure: true });
  const unreachable = await command("git", ["-C", repoDir, "rev-list", "--count", `${remoteTip}..${localSha}`, "--not", "--remotes=origin"], { allowFailure: true });
  if (range.status !== 0 || unreachable.status !== 0) return { residue: false };
  const rangeCount = Number(range.stdout);
  if (!Number.isInteger(rangeCount) || rangeCount < 1) return { residue: false };
  return { residue: unreachable.stdout === range.stdout };
}

export async function prepareRepository(stateDir, repo, taskId, branchOverride) {
  if (!REPO.test(repo)) throw new Error("repo must be in org/name form");
  const repoDir = join(stateDir, "repos", repo.split("/")[1]);
  const branch = branchOverride ?? `worker/${taskId}`;
  const base = (process.env.VINCI_WORKER_GIT_BASE ?? "https://github.com/").replace(/\/+$/, "");
  const cloneUrl = `${base}/${repo}.git`;
  const cached = existsSync(repoDir);

  if (branchOverride) {
    validateBranchName(branch);
    // git itself is the authority on ref-name legality; ask it rather than trusting our regex alone.
    const legal = await command("git", ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (legal.status !== 0) throw new Error(`envelope branch ${branch} is not a valid git branch name`);
    // The envelope pinned the branch (e.g. continuing a held PR). Three cases, three different
    // reasons — the ledger and the operator attribution follow the reason (issue #19):
    //   (a) absent on origin       ⇒ "not found on origin" (BLOCKED before spawn, cost 0), regardless
    //       of any stale local branch of that name, which is renamed aside and named, never deleted;
    //   (b) local is an ancestor    ⇒ fast-forward to the remote tip;
    //   (c) local has commits not on the remote tip ⇒ refuse (divergence), naming both SHAs.
    // Existence is asked of origin LIVE (ls-remote) and BEFORE any fetch or clone: a fetch failure
    // must not mask case (a), and case (a) performs no transfer at all. A show-ref on refs/remotes/*
    // would trust stale local copies of branches deleted upstream.
    const remote = await command(
      "git",
      cached
        ? ["-C", repoDir, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]
        : ["ls-remote", "--exit-code", "--heads", cloneUrl, `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (remote.status !== 0) {
      // ls-remote --exit-code: 2 = ref not found; anything else is origin unreachable, a different fact.
      if (remote.status !== 2) throw new Error(`git ls-remote origin failed for ${branch}: ${remote.stderr || remote.status}`);
      let aside = "";
      const local = cached
        ? await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true })
        : { status: 1, stdout: "" };
      if (local.status === 0) {
        // Case (a) with a stale local branch (an earlier attempt's work): preserve it under a name
        // the record can cite, so the next attempt of this task does not trip over it.
        const asideName = await renameBranchAside(repoDir, branch);
        aside = ` (stale local branch ${branch} at ${local.stdout} renamed aside to ${asideName})`;
      }
      throw new Error(`envelope branch ${branch} not found on origin${aside}`);
    }
  }

  if (cached) {
    // The default path works off origin/main and needs it fresh. The branch path fetches its
    // branch explicitly below (after the not-found gate) and never runs a general fetch first.
    if (!branchOverride) await command("git", ["-C", repoDir, "fetch", "origin"]);
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
    await command("git", ["clone", cloneUrl, repoDir]);
  }

  if (branchOverride) {
    // Materialize the branch explicitly, by full refspec, BEFORE resolving its tip, and resolve
    // the tip from the LOCAL clone: ls-remote's SHA is a name origin knows, not necessarily an
    // object this clone has (a general fetch is only as wide as remote.origin.fetch).
    await command("git", ["-C", repoDir, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const fetched = await command(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { allowFailure: true },
    );
    if (fetched.status !== 0 || !/^[0-9a-f]{40}$/.test(fetched.stdout)) {
      throw new Error(`envelope branch ${branch} exists on origin but fetch did not materialize origin/${branch} locally`);
    }
    const remoteTip = fetched.stdout;
    const local = await command(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    const localSha = local.status === 0 ? local.stdout : null;
    if (localSha) {
      // Never reset away local-only commits (a crashed prior attempt's work): -B is destructive.
      const anc = await command(
        "git",
        ["-C", repoDir, "merge-base", "--is-ancestor", `refs/heads/${branch}`, remoteTip],
        { allowFailure: true },
      );
      if (anc.status === 1) {
        const reason = `local branch ${branch} at ${localSha} has commits not on origin/${branch} at ${remoteTip}; refusing to reset (divergence)`;
        // Never-pushed residue (soak cohort 2 rows 11/11b: a Night-1 local branch, 2 ahead / 82
        // behind origin's rebuilt PR head, no upstream, on no origin head): move it aside so the
        // NEXT attempt can continue at origin/<branch>. This attempt is still refused — the rename
        // is a fact the record must carry, not something to paper over.
        const verdict = await classifyDivergedLocal(repoDir, branch, localSha, remoteTip);
        if (verdict.residue) {
          const asideName = await renameBranchAside(repoDir, branch);
          throw new Error(`${reason}; never-pushed residue renamed aside to ${asideName} — retry continues at origin/${branch}`);
        }
        throw new Error(verdict.note ? `${reason}; ${verdict.note}` : reason);
      }
      if (anc.status !== 0) throw new Error(`ancestry check failed for ${branch} (${localSha} vs origin/${branch} ${remoteTip}): ${anc.stderr || anc.status}`);
      // Case (b): local is an ancestor (or equal) ⇒ -B is a fast-forward to the remote tip.
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
      // Post-0.0.51 rule (#18): a task NEVER runs under a self-updating launcher. The daemon
      // probes `vinci --version` immediately before this spawn and records it as the task's
      // `vinci_binary`; with VINCI_UPDATE_DISABLED=1 the launcher cannot swap its payload between
      // that probe and this run, so the recorded version IS the executed version by construction.
      // Updates are an operator action (`vinci update`, as the deploy recipe already does).
      {
        cwd: repoDir,
        detached: true,
        env: { ...process.env, VINCI_UPDATE_DISABLED: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      },
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
        harness_stops: session.harnessStops,
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

// Publishing itself lives in publisher.mjs (idempotent PR adoption, remote-sha discipline,
// never-force, optional fence). This wrapper keeps the envelope-level rules: BLOCKER.md at HEAD
// and `evidence: none` both map to promotion "none" (push, never a PR).
export async function publish({ envelope, repoDir, branch, taskId, attempt, limitTripped, fence }) {
  // A BLOCKER.md at HEAD suppresses only the PR. The branch is still pushed so the agent's
  // work and its stated blocker are on the record (measured 2026-08-27: the first bus-dispatched
  // task committed a decision record + a blocker and nothing reached the remote).
  const blockerReason = await readHeadBlocker(repoDir);
  const promotion = blockerReason || envelope.evidence !== "pr" ? "none" : "pr";
  const result = await publishBranch({
    repoDir,
    branch,
    taskId,
    attempt,
    baseRef: envelope.base_ref,
    limitTripped,
    promotion,
    fence,
    repoOwner: typeof envelope.repo === "string" ? envelope.repo.split("/")[0] : null,
  });
  if (blockerReason) {
    return { ...result, publish: result.publish === "pushed" ? "blocked" : result.publish, blocker_reason: blockerReason };
  }
  return result;
}

// Outcome precedence — machine-observed events outrank the model's narrative about itself
// (issues #5/#6: the harness refused the required work mid-run and the outcome entry still said DONE).
//   1. non-zero exit or a tripped limit                         => FAILED
//   2. any harness stop in the session (see HARNESS_STOP_PATTERNS) => BLOCKED, even over DONE + PR
//   3. outcome BLOCKED/WAITING, or BLOCKER.md at HEAD            => BLOCKED
//   4. outcome DONE_UNVERIFIED                                    => UNVERIFIED
//   5. outcome DONE and a PR exists                               => COMPLETED
//   6. anything else (incl. evidence: none, exit 0 alone)         => UNVERIFIED (produced, unassessed)
export function finalState({ exitCode, limitTripped, outcome, blocker, pr, harnessStops }) {
  if (exitCode !== 0 || limitTripped) return "FAILED";
  if (Array.isArray(harnessStops) && harnessStops.length > 0) return "BLOCKED";
  if (outcome?.state === "BLOCKED" || outcome?.state === "WAITING" || blocker) return "BLOCKED";
  if (outcome?.state === "DONE_UNVERIFIED") return "UNVERIFIED";
  if (outcome?.state === "DONE" && pr) return "COMPLETED";
  return "UNVERIFIED";
}

export { command, resolveBin };
