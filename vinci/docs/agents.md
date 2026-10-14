# How agents work here

Reliable multi-agent work means more verified work reaching users with less human
intervention. These practices come from fleet operations and the source-control
review of 2026-10-14. They describe how to use existing tools; they do not establish
that a feature is deployed or that a particular run passed.

## Give each seat one task

A seat is one agent session with one written task, a project directory, allowed
paths, constraints, and acceptance criteria. Coordinate with the existing owner
before starting; do not duplicate another lane. Finish with a hand-off and stop.
Give unrelated follow-up work to a fresh session.

Crew's `spawn_helper` runs coding agents in isolated snapshot worktrees. Assign
independent tasks: isolation prevents shared-file overwrites, but it does not make
overlapping changes agree. Use `/agents` to inspect results and waiting patches.
See the [Crew design and interface](../AGENTS_PLAN.md).

For published branches, reuse the Worker [branch leases](../worker/branch-lease.mjs)
and its [publisher](../worker/publisher.mjs). A work lease permits an attempt to
work; a branch lease protects a branch writer. Neither grants permission to disclose
data or deploy. These are Worker facilities, not a claim that every Crew agent or
external Git writer holds a lease.

## Write a hand-off that a fresh seat can use

Record what is done, what is in flight, and the next authorized actions. Include
the repository, base and exact head commit, changed paths, artifact SHA-256 hashes,
verification commands and results, unresolved decisions, and who owns the next step.
Read the reviewed task or artifact in full and recompute its hash before using it.
A hash identifies bytes; it does not prove those bytes are correct or authorized.

If work must outlive the session, detach it and record its PID and log path.
Successors start from this written record and verify current state themselves.
Crew preserves patch/result records for reconciliation; this does not replace a
clear hand-off or guarantee that background work survives a lost parent.

Commit a worker's verified output before further edits at those files. Stage only
that task's paths and preserve other workers' changes. When `.git` is read-only,
hand the output and checks to the authorized host for the commit; do not route
around the boundary. Distinguish local commits, pushed branches, merged changes,
released artifacts, and healthy deployments in the hand-off.

## Review intent and the exact head

Use a fresh independent reviewer with a self-contained brief, not the builder's
conversation. Give it the intended behavior, current base, exact candidate head,
full patch including new files, and the checks and controls. It should ask whether
the change solves the intended problem and preserves later work, not just whether
the diff looks reasonable. An approval of an old head cannot approve a replacement.

Crew already replays the agent's exact verifier in a disposable integration
worktree and requests an independent review. Ordinary patches integrate only with
a current passed check, successful replay, a `ships` review, and unchanged touched
paths. Risky, conflicting, stale, or unverified work becomes `WAITING`.
This automated patch review complements the fresh seat review used for PRs;
it is not proof of a separate reviewer session or production readiness.

Merge only on green required checks plus an independent GO for that exact head,
through the existing authorized merge path and merge queue. Keep security, custody,
signing, release approval, and exact-tree checks. A merge is not a deployment:
report released artifact identity and successful health evidence separately.

## Make tests distinguish the repair

A behavioral fix needs a test that fails on the old code and passes on the repair.
For a new guard, restore the defect or use a targeted mutation and show the intended
assertion fails. Pair the negative case with a positive control through the same
real entry point so an earlier refusal cannot masquerade as the guard being tested.
Exercise the installed or deployed artifact when that is the boundary being claimed.

Record the actual command, artifact, environment, and result. A test in an agent's
environment says nothing by itself about a fresh user shell, CI, or production.
For documentation-only changes, use content, link, provenance, and scope checks;
do not invent behavioral mutation evidence.

Use the existing [verification states](verification.md): `DONE` needs required
direct verification; `DONE-UNVERIFIED` records changed code without it; `WAITING`
names a needed decision; `BLOCKED` records a concrete stop. Failed checks stay
failed until repaired and checked again; later edits make old evidence stale.
Label measured facts, attributed reports, and inference separately. Unknown stays
unknown, and a skipped check is not qualification.

## Surface every denial

Stop the denied item and take the exact refusal, attempted action, and required
decision to the human through the coordinator. Never retry it through another
agent, tool, account, path, or permission mode. Unrelated authorized work may
continue. Human approval must address the refused action before it resumes.
Record the outcome so a successor cannot mistake a refusal for unfinished routine
work. A security refusal is not a reason to weaken the check to get green.

## Bound commands and keep evidence readable

Put a timeout on searches, waits, and commands. On macOS, for example:

```sh
perl -e 'alarm 600; exec @ARGV' <command> <arguments>
```

Scope searches to the needed source paths; avoid recursive run/checkpoint scans,
full control-server ledger drains, and tight polling. Run shell argument loops
under Bash or use arrays. Take record timestamps from `date -u`, never memory.
Read the tool's own result: exit zero alone does not prove a submission or effect.
Logs should say what happened, with units and context, and give a next step on
failure. Preserve immutable evidence; keep credentials and private runtime data
out of source commits and shared messages.

## Use typed records and only real-damage gates

Reuse Crew, worktrees, leases, verification, and the existing coordination APIs.
Prefer structured hand-offs, appointments, and receipts that consumers can parse
over rules about subject words or how to post. Typed records are the direction
for replacing remaining text conventions as consumers migrate; this guide does
not claim that migration is complete. Preserve compatible consumer contracts.
There is no need for another VCS or orchestration bus.

A new gate must name the real damage it prevents. For GPU entry, keep live memory
fit, a healthy sampler/OOM guard, disk safety, exclusion of foreign processes on
the run's own cards, data custody, spend caps and a PERMITTED verdict for paid
calls, the appointed submitter, and research clearance once per run.
Builders prepare and verify job texts; only the appointed submitter submits.
Keep useful work queued on existing prepaid capacity; new paid capacity needs
authorization.

Review generic entry code once. Do not add per-run hand-built guards or helper
byte reviews, hard-coded role holders or sampler identities, multi-hop receipt
chains, or second-level timing windows as entry conditions. Read current role and
runtime facts from one current source. Measure science-quality conditions and
use them to label the result's claim tier after the run. Fix paperwork in the
paperwork. These rules preserve the security, release, and merge gates above.

## Keep VGC a free space

VGC should be a smooth free space with basic guardrails. Commons is optional
conversation: agents may use it or ignore it, with no posting quota, engagement
score, or mandatory reading. Discussion is not authority; verify decisions through
the existing authoritative records. Exposure and privacy boundaries still apply.

The Commons plan is an operations experiment, not evidence of model capability.
Treat its proposed phases and measures as a plan until observed. Share useful
lessons without turning participation into another gate.
