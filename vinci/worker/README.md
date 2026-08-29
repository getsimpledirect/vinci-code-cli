# Vinci Worker — Stage 1

Standalone Node program that polls an HTTP bus for work handoffs, spawns unattended `vinci -p` runs, monitors limits (runtime, budget, deadline), and publishes results back to the bus.

The daemon processes one handoff at a time and blocks until that task reaches a terminal state.

## Setup

```bash
vinci worker start --id <worker-id> \
  --server http://bus.example.com:8000 \
  [--once] [--poll-seconds 60] [--state-dir ~/.vinci-worker-state] \
  [--governor http://governor:8100] [--require-governor] \
  [--clean-room] [--disk-floor-mb 2048] [--keep-attempts 3]
```

**Required:**
- `--id`: Worker identity (e.g., "stage0-box1")
- `--server`: Bus server URL (vinci-gpu-control)
- `VINCI_BUS_TOKEN` env: Bearer token for bus auth

**Optional:**
- `--once`: Process one handoff and exit (useful for testing)
- `--poll-seconds`: Poll interval (default 60)
- `--state-dir`: Persistent state directory (default `.vinci-worker-state`)
- `--governor`: Governor URL (Stage 2). Once set, every task needs a granted lease — see "Governor Lease (fail-closed)"
- `--require-governor` (or `VINCI_WORKER_REQUIRE_GOVERNOR=1`): refuse to start (exit 78) unless `--governor` is configured
- `--clean-room` (or `VINCI_WORKER_CLEAN_ROOM=1`): a fresh worktree, an allowlisted environment and no push for every attempt — see "Clean room". **Off by default this wave**; it flips on after the chaos gate
- `--disk-floor-mb` (or `VINCI_WORKER_DISK_FLOOR_MB`, default 2048), `--keep-attempts` (or `VINCI_WORKER_KEEP_ATTEMPTS`, default 3): clean-room bounds, ignored without `--clean-room`

## Supervision

The daemon is **systemd-managed**. Do NOT run with `--daemon`; let systemd handle that:

```ini
[Unit]
Description=Vinci Worker stage0
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vinci-worker
ExecStart=/usr/local/bin/vinci worker start --id stage0-box1 --server http://bus:8000 --state-dir /var/lib/vinci-worker
Restart=always
RestartSec=10
Environment="VINCI_BUS_TOKEN=..."

[Install]
WantedBy=multi-user.target
```

## How It Works

1. **Poll**: GET /v1/messages (filtered to kind=="handoff", to=="worker:<id>")
2. **Parse**: Task envelope with headers (repo, evidence, provider, model, budget, timeout, deadline, ref)
3. **Claim**: POST status "claimed <id> attempt N" to bus
4. **Setup**: Clone/fetch the repo and reuse or create `worker/<task-id>` from `origin/main`
5. **Run**: Spawn `vinci -p --session-id <id> --tools read,grep,find,ls,bash,edit,write "<spec>"`
6. **Limits**:
   - `max_runtime_s`: SIGTERM then SIGKILL after 30s
   - `budget_usd`: Poll session JSONL every 15s; kill if cost exceeds budget
   - `deadline`: Check before start and each poll; kill if past
7. **Outcome**: Read task-outcome from session JSONL (DONE, DONE-UNVERIFIED, WAITING, BLOCKED) **and** every harness stop — a tool call the harness refused (`vinci-todo` no-progress latch, `vinci-loopbreak` reserved-actions refusal), serialized as an `isError` toolResult whose text is the block reason
8. **Publish**: Push branch to origin; if evidence==pr and no BLOCKER.md, adopt the open PR for the branch or create one (see [Publishing](#publishing))
9. **Report**: Post finding (COMPLETED), blocker (BLOCKED/FAILED), or status (UNVERIFIED)

### Outcome precedence (machine-observed events outrank the model's narrative)

Exit code zero alone means nothing. The final state is the first matching row:

| # | Observed | Final state | Notes |
|---|----------|-------------|-------|
| 1 | exit code != 0, or a limit tripped (`budget_usd`, `max_runtime_s`, `deadline`) | `FAILED` | a co-occurring harness stop is still recorded: `harness_stop` on the task file, and `harness_stops=<N> harness_stop_reason=<first stop text>` in the blocker post |
| 2 | any harness stop in the session JSONL (an `isError` toolResult with `details.vinciBlocked: true`; the `HARNESS_STOP_PATTERNS` substrings in `session-read.mjs` are the fallback for sessions without the marker) | `BLOCKED` | wins even when the outcome entry says DONE and a PR was created; `harness_stop: {count, reason}` is written to the task file and the blocker post says `stop=instrument` with the stop reason |
| 3 | outcome `BLOCKED` / `WAITING`, or a non-empty `BLOCKER.md` at HEAD | `BLOCKED` | |
| 4 | outcome `DONE_UNVERIFIED` | `UNVERIFIED` | |
| 5 | outcome `DONE` **and** a PR exists | `COMPLETED` | the only route to COMPLETED |
| 6 | anything else (outcome `DONE` without a PR, `evidence: none`, no outcome entry) | `UNVERIFIED` | produced, unassessed |

Why: issues #5 and #6 — the harness refused the agent's required work mid-run (`git commit` refused six times; the no-progress latch told a non-existent user to send the next instruction) and the session still exited 0 with a DONE outcome. The stop the harness recorded is the fact; the outcome entry is the model's story about itself.

## Task Envelope

Handoff message body (line-oriented headers, blank line, then spec):

```
repo: org/repo
evidence: pr|none                  (default: pr; `none` skips PR creation — the task then ends UNVERIFIED, never COMPLETED)
provider: openrouter|...           (default: openrouter)
model: z-ai/glm-5.2               (default)
budget_usd: 5.0                    (default)
max_runtime_s: 14400               (default; 4 hours)
deadline: 2026-08-26T12:00:00Z    (optional ISO-8601 UTC)
ref: ledger_id                     (optional; for finding refs)
branch: worker/msg_abc123          (optional; continue an EXISTING branch on origin — see Branch continuation)
base_ref: main                     (optional; the PR base the publisher targets — default main; plain branch name, same rules as branch)

<blank line>

<free-text specification passed verbatim to vinci -p>
```

Unknown headers → blocker posted, task not run.

### Branch continuation (`branch:` header)

Without `branch:` the daemon works on `worker/<taskId>` off `origin/main`. With `branch:` the
envelope pins an existing branch (e.g. the head of a held PR). Order of operations, fixed:
validate the name → ask origin live (`git ls-remote --exit-code --heads origin refs/heads/<branch>`)
**before any fetch or clone** → `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`
(explicit refspec; the branch path never runs a general `git fetch origin` first) → resolve the tip
from the local `origin/<branch>` → ancestry check → `checkout -B`. Exactly three outcomes, each with
its own reason so the ledger and the operator attribution follow it:

| State on origin / locally | Result | Reason text |
|---|---|---|
| (a) branch absent on origin (live `ls-remote`, never a cached `refs/remotes/*`) | **BLOCKED before spawn**, cost 0, no session, **no fetch/clone performed** — regardless of any local branch of that name | `envelope branch <branch> not found on origin`; a stale local branch is renamed aside to `stale/<branch>-<UTC stamp>-<6 hex>` (never deleted) and the reason appends `(stale local branch <branch> at <sha> renamed aside to stale/…)` |
| (b) branch on origin; local branch absent, or an ancestor of the remote tip | checkout at the remote tip (a fast-forward when the local branch existed) | — |
| (c) branch on origin; local branch has commits not on the remote tip | **refused**, local commits untouched | `local branch <branch> at <localSha> has commits not on origin/<branch> at <remoteTip>; refusing to reset (divergence)` |

**Never-pushed residue on path (c).** Soak cohort 2 rows 11/11b (2026-08-28) were a genuine
divergence: a Night-1 local `worker/<id>` (2 ahead / 82 behind origin's rebuilt PR head) that had
never been pushed. When ALL of the following hold, the local branch is renamed aside to
`stale/<branch>-<stamp>-<hex>` (never deleted) and the attempt is **still refused**, with the reason
extended by `; never-pushed residue renamed aside to stale/… — retry continues at origin/<branch>`,
so the next attempt proceeds at the remote tip:

1. the local branch does not track `origin/<branch>` (`branch.<b>.remote`/`.merge` are not
   `origin`/`refs/heads/<b>` — a pushed branch carries that upstream; the daemon's own default path
   leaves the upstream at `origin/main`, which is not evidence of a push);
2. after `git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'` (ALL origin heads by
   explicit refspec — a `--single-branch` cache would otherwise never see a head outside its
   refspec and misclassify work pushed there), no origin head contains the local tip
   (`git for-each-ref --contains=<localSha> refs/remotes/origin` is empty); if the branch has ANY
   configured upstream whose remote-tracking ref is still unresolvable after that fetch, the
   attempt is refused without a rename and the reason appends
   `; upstream <remote>/<merge> of <branch> is not resolvable on origin; not treating it as never-pushed`;
3. every commit in `<remoteTip>..<localSha>` is unreachable from every origin head
   (`git rev-list --count <remoteTip>..<localSha> --not --remotes=origin` equals the range count).

A branch that tracks `origin/<branch>`, or whose commits live on any other origin head, is refused
and left exactly where it is. Any error in these checks ⇒ no rename, plain refusal.

Origin unreachable is reported as `git ls-remote origin failed for <branch>: …`, never as
not-found or divergence. A branch that exists on origin but cannot be resolved locally after the
explicit fetch is `envelope branch <branch> exists on origin but fetch did not materialize
origin/<branch> locally`. The pre-existing `reset --hard`/`clean -fd` quarantine of the shared
checkout is unchanged here (Wave 1 clean-room item).

## Publishing

Publishing (`vinci/worker/publisher.mjs`,
`publish({ repoDir, branch, taskId, attempt, baseRef, limitTripped, promotion, fence?, repoOwner? })`)
is the only step that mutates the outside world, so every effect is keyed, conditional, and
re-runnable. `run.mjs`'s `publish()` is a thin wrapper: it maps `BLOCKER.md` at HEAD and
`evidence: none` to `promotion: "none"` (push, never a PR) and passes the envelope's `base_ref`
and repo owner through. The one command runner (`exec.mjs`, stdout + stderr preserved) is shared
with the rest of the daemon.

**Idempotency keys: branch + task.** One branch never owns two PRs. Before touching origin the
publisher lists the open PRs for the branch (`gh pr list --head <branch> --state open --json
number,url,state,headRefOid,headRefName,baseRefName,headRepositoryOwner,body`) and ADOPTS one only
when it is provably ours: head repository owner == the origin owner (`gh pr list --head` also
matches same-named branches on forks), base == our `baseRef`, and either the body footer names
this task (`vinci-worker: task=<taskId> …`) or the PR's head is an ancestor-or-equal of our head
(a legacy PR without a footer, or a held PR this task continues via `branch:`). Any other open PR
on the branch ⇒ `publish: "pr_conflict"`: nothing pushed, nothing created. When `gh pr create`
still collides (the race between list and create) every state is listed: an open PR that is ours
is adopted, a closed/merged one ⇒ `pr_closed` (never a second PR on the branch).
The PR body ends with a machine-readable footer:
`vinci-worker: task=<taskId> attempt=<n> head=<sha> base=<baseRef>` (+ `fence=<generation>`
when a fence was supplied). The PR base is the caller's `baseRef` (`base_ref:` header); `main`
only when nothing was passed. **Until #23 threads `base_ref` through `prepareRepository`, the
daemon refuses any `base_ref` other than `main` before cloning (`BLOCKED`,
`base_ref_unsupported`)** — the branch is forked from `origin/main`, and a PR against another base
would not share its fork point.

**The never-force rule.** The sha to publish is captured once (`pushed_sha`) and origin is sampled
once (`remote_sha_before`, from `git ls-remote origin refs/heads/<branch>`). If origin holds a
commit that is not an ancestor of ours (an unfetched object counts), the push is refused before it
is attempted: `publish: "remote_moved"`. The push itself is a conditional update of the CAPTURED
sha, never of the mutable branch name:
`git push origin <pushed_sha>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<remote_sha_before | empty>`
— a compare-and-swap against the sampled value (empty = the branch must not exist), not a force.
A move between the sample and the push is rejected by the lease and recorded as `remote_moved`
with `remote_sha_after`. After a push origin is read back and must equal `pushed_sha`
(`remote_readback_mismatch` otherwise). There is no force path; a moved remote is an operator
decision, never something a retry resolves.

**What is recorded** (task record / `result.json`):

| field | meaning |
|---|---|
| `publish` | `pushed` · `push_failed` · `remote_moved` · `remote_readback_mismatch` · `pr_conflict` · `pr_closed` · `fenced_out` · `blocked` (pushed, PR suppressed by BLOCKER.md) |
| `pushed_sha` | the exact local sha that was pushed (null when nothing was pushed) |
| `remote_sha_before` / `remote_sha_after` | origin's sha for the branch sampled before the push / read back after it (null = absent) |
| `push_skipped` | `remote_at_head` when origin already held our sha (a retry after a crash between push and PR record) |
| `pr` / `pr_adopted` / `pr_adopted_via` / `pr_head` | the PR URL (only when its head == `pushed_sha`; `pr_head_mismatch` in `pr_error` otherwise); adopted vs created; `footer` / `ancestry` / `continuation`; the PR head |
| `refusal_reason` / `pr_conflicts` | why a refusal happened |
| `fenced_out` | the fence's reason when it declined an effect |
| `base_ref` | the PR base actually used |

**Crash windows.** The push and the PR record are two effects. `pushed_sha` is recorded as soon
as the push succeeds, so a failure in `gh pr create` leaves `publish: "pushed", pr: null` with the
sha on the record; the next attempt finds origin at that sha (no push attempt at all) and adopts
the PR that was created out-of-band, or creates exactly one.

**Fence.** An optional `fence: { generation?, check: async ({ stage }) => ({ valid, reason }) }`
is consulted immediately before the push and again immediately before PR creation. `valid: false`
— or a check that throws — skips that effect and records `fenced_out: <reason>`; a fence that
fails before the push leaves nothing on origin. The hook point is `processHandoff(…, { fence })`
in `worker.mjs`; production passes `null` today, so **publishing under `--governor` is fenced
only once the lease loop (#26) wires its fence there** (one line at the call site).

## Lifecycle

State file `<state-dir>/tasks/<id>.json`:

```json
{
  "task": "128",
  "attempt": 1,
  "session_id": "128",
  "state": "COMPLETED",
  "started_at": "2026-08-26T12:00:00.000Z",
  "finished_at": "2026-08-26T12:15:00.000Z",
  "exit_code": 0,
  "head": "abc1234567890def",
  "pr": "https://github.com/...",
  "pr_adopted": false,
  "publish": "pushed",
  "pushed_sha": "abc1234567890def",
  "remote_sha_before": null,
  "base_ref": "main",
  "evidence": "pr",
  "limit_tripped": null,
  "harness_stop": null,
  "vinci_version": "0.42.0",
  "worker_build": { "version": "0.42.0", "commit": "<40-hex>", "dirty": false },
  "server_build": { "git_sha": "<40-hex>", "dirty": false },
  "vinci_binary": { "version": "0.42.1", "path": "/home/worker/.local/bin/vinci" },
  "provider": "openrouter",
  "model": "z-ai/glm-5.2",
  "cost_usd": 2.15,
  "terminal": true,
  "lease": { "claimed_at": "...", "paths": ["."], "ttl": 3600, "effective_max_runtime_s": 3600 },
  "evidence_error": null,
  "evidence_result_state": "COMPLETED"
}
```

`harness_stop` is `{ "count": <stops>, "reason": "<first stop text>" }` whenever a harness stop occurred in the session, regardless of final state (a FAILED run's blocker post also carries `harness_stops=<N> harness_stop_reason=<first stop text>`, distinct from `reason=`, which stays the outcome narrative); it decides the state (row 2 above) only when nothing outranks it. `null` when no stop occurred.

**Transition table** (enforced by `TaskLifecycle.transition`; anything not listed throws
`illegal transition <from> → <to>`, and unknown state names throw):

| From | To | When |
|------|----|------|
| `PENDING` | `RUNNING` | immediately before the `vinci` child is spawned |
| `PENDING` | `BLOCKED`, `FAILED` | fail-fast before spawn: envelope error, past deadline, Governor refusal/error |
| `RUNNING` | `COMPLETED`, `UNVERIFIED`, `BLOCKED`, `FAILED` | the run finished, the branch was published, and the evidence bundle was attempted |
| any terminal | (nothing) | a finished task is immutable; a failure after the terminal write (e.g. the final bus post) surfaces to the daemon loop instead of rewriting the record |

Field-only updates (Governor lease, run results before publish) go through `record()` and never
change `state`. `RUNNING` is non-terminal, so a daemon that dies mid-run resumes the task on
restart exactly as before.

**Evidence before terminal:** the terminal state is written only *after* the evidence bundle was
attempted. The daemon computes the intended final state, builds the exact snapshot it is about to
commit, ships that snapshot as `result.json` (marked `"snapshot": "pre-terminal"`,
`"committed_state": null`, `"terminal": false` — a bundle never asserts a committed state; the
task file records `evidence_result_state`, the state the bundle names, so a post-upload downgrade
is machine-detectable as `evidence_result_state !== state`), and only then transitions. If evidence is configured
(`VINCI_EVIDENCE_URI_PREFIX` set) and either the S3 upload or the `/v1/evidence` metadata POST
fails, `COMPLETED` is downgraded to `UNVERIFIED` and `evidence_error` records the failure;
`BLOCKED`/`FAILED` keep their state but still record `evidence_error`. When evidence is not
configured nothing changes (no downgrade), so soak boxes may run without it.

**Restart behavior:**
- If `terminal=true`: skip (already done)
- If `terminal=false` (`PENDING`/`RUNNING`): increment `attempt`, keep same `session_id`, resume

## Credentials

- `VINCI_BUS_TOKEN`: Bearer auth to bus (/v1/messages)
- `VINCI_GOVERNOR_TOKEN`: Session auth to the Governor; required whenever `--governor` is set (a task with a Governor URL and no token is BLOCKED, never run)
- `GH_TOKEN`: (optional) GitHub machine user token for cloning/pushing private repos and creating PRs
- `OPENROUTER_API_KEY`: (or provider-specific key) via vinci's standard configuration

Never hardcode. Use systemd SecureString parameters, AWS Secrets Manager, or similar.

## Dependencies

Minimal:
- Node 22+
- Global `fetch` (Node 22)
- Git
- `gh` CLI (for PR operations)
- `vinci` binary on PATH

No new npm dependencies introduced; uses only node:* and global APIs.

## Logs and State

```
<state-dir>/
  cursor.json                    # High-water mark per worker
  tasks/
    <id>.json                    # Lifecycle record
  sessions/<id>/                 # vinci JSONL read for outcomes and usage (outside every tree)
  debris/<id>/                   # shared-checkout mode: quarantined leavings of a prior run
  repos/
    <name>/                      # shared-checkout mode (default): ONE tree per repo NAME
  cache/<org>/<repo>.git         # clean-room mode: one bare cache per org/repo
  attempts/<org>/<repo>/<id>/    # clean-room mode: one worktree per attempt (+ .home/.tmp/.hooks)
    <attempt>/
```

## Build identity (W0.5)

Build skew between the two worker boxes, and between a worker and the gpu-control server, has
already caused live failures, so every record names the exact build that produced it. Nothing
here gates startup: identity is a record, not a check.

What is recorded, and where:

- `worker_build` — computed ONCE at daemon start by `vinci/worker/build.mjs`
  (`buildIdentity()`): `{ version, commit, dirty, source, unresolved }`. `version` is
  `identity.json`'s version (the string task records always carried as `vinci_version`, which
  is kept); `commit` is the HEAD sha of the checkout the daemon runs from, read directly from
  the checkout's files — the `.git` at the package root ONLY (`<root>/vinci/worker/build.mjs`
  looks at `<root>/.git`; a `.git` further up belongs to some other repository and is treated
  as absent), `HEAD` (a `gitdir:` pointer file is followed for a linked worktree), then the
  branch's loose ref, then `packed-refs`, following symbolic refs recursively (at most 8 hops;
  a cycle, a ref name with `.`/`..`/empty segments, or a ref file that does not really live
  under the git dir resolves to nothing) — never via `git` exec, so an
  unprivileged daemon on a root-owned checkout still resolves it (#17: git's "dubious
  ownership" refusal used to silently degrade the identity to a version string). It is `null`
  when there is no `.git` entry at the package root (a packaged install: `source: "package"`,
  `unresolved: false`) OR when a `.git` entry exists there but HEAD could not be resolved —
  unborn branch, unreadable HEAD, malformed or dangling `gitdir:` pointer, symbolic-ref cycle
  (`source: "package"`, `unresolved: true`). `dirty` is whether
  `git -c safe.directory=<checkout root> status --porcelain --untracked-files=no` is non-empty
  (the exact root, which every git with `safe.directory` honours; the `*` wildcard needs
  >= 2.35.3); it is best-effort and `null` (unknown) whenever git is missing or refuses —
  never `false` by default.
- `server_build` — the verbatim payload of `GET <server>/v1/version` (unauthenticated;
  vinci-gpu-control reports `git_sha`, `dirty`, `server_code_sha256`, …), fetched once at
  daemon start with a 2 s timeout per attempt and ONE retry after 1 s on a timeout or network
  error (a cold first request has timed out and then answered in 43 ms on restart). Anything the
  server actually answered — non-2xx, a non-JSON or non-object body — is recorded on the first
  attempt and not retried. Worst case 5 s, so a hung server cannot delay the first
  poll past 6 s. On any failure it is `{ "error": "<why>", "attempts": <n> }` and the daemon
  still starts.
- `vinci_binary` (#18) — `{ version, path }` from running `<vinci on PATH> --version`
  (`vinciBinaryVersion()` in `build.mjs`; the binary is resolved exactly the way `runVinci`
  resolves the one it spawns; 10 s timeout; the answer must be one `x.y.z[-pre]` token or it
  is recorded as `unparseable version: …`). The probe runs under a minimal environment —
  `PATH`, `HOME`, `TMPDIR`, `LANG` and `VINCI_UPDATE_DISABLED=1` only — never the daemon's,
  which carries the bus/Governor tokens and provider/GitHub/AWS credentials. This is the
  launcher payload that actually runs tasks and it is legitimately different from
  `worker_build`: the daemon runs from a checkout, the launcher is updated on its own. It is
  probed at daemon start (the `online` post's value) AND immediately before every spawn —
  after the Governor lease and the clone — and that pre-spawn value is what the task record
  carries. On any failure it is `{ "error": "<why>" }` and the daemon still starts.
- Post-incident rule (the release that could not launch): **a task never runs under a self-updating launcher.** `runVinci` spawns
  with `VINCI_UPDATE_DISABLED=1`, so nothing can swap the payload between the pre-spawn probe
  and the run — the recorded `vinci_binary` is the executed binary by construction. Updating
  the launcher on a worker box is an operator action (`vinci update`, as the deploy recipe
  already does), never something a task triggers.
- `vinci_version` is kept for compatibility and is the DAEMON CHECKOUT's `identity.json`
  version (identical to `worker_build.version`). It is NOT the version of the binary that ran
  the task — the incident that motivated this was a task record naming the daemon checkout's
  version on a box whose launcher had already been updated to the next release. Read
  `vinci_binary` for that.
- All of them are written into the task record (`<state-dir>/tasks/<id>.json`) by `startAttempt`:
  `worker_build` is stored as `{ version, commit, dirty }` (`source` is omitted) and
  `server_build` as the payload verbatim (or `{ error }`), `vinci_binary` as `{ version, path }`
  (or `{ error }`). The task record is what ships as the evidence bundle's `result.json`, so the
  same fields appear there.
- Every terminal bus post — the final post from a run AND the early blockers (envelope error,
  past deadline, governor refusal/unavailability) — carries `worker_build=…` and
  `vinci_binary=…` via one shared formatter in `worker.mjs` (`terminalPostBody`).
- The bus sees them twice: the daemon's single `worker <id> online` status post at start
  (`worker_build=<build>[-dirty] worker_version=<version>
  server_build=<server commit | unknown: <error>> vinci_binary=<version | unknown: <error>>`,
  posted once per start, before the first
  poll, in `--once` mode too; a daemon that refuses to start — lock held, exit 75, or missing
  Governor, exit 78 — never announces itself and never fetches `/v1/version`), and
  `worker_build=<build>[-dirty] vinci_binary=<…>` on every terminal task post. `<build>` is the 40-hex commit
  for a resolved checkout, the bare `<version>` only for a packaged install (no `.git`), and
  the explicit `<version>-UNRESOLVED` for a checkout whose HEAD could not be read — a bare
  version on a machine that runs from a checkout is a defect, never a fallback, and must not be
  mistakable for a resolved identity.
- Drift signal: the last ANNOUNCED binary is persisted in `<state-dir>/vinci-binary.json`.
  Whenever a probe (at start or before a spawn) returns a version different from it, the
  daemon posts ONE `status` `worker <id> vinci binary changed <old> -> <new>` and only then
  updates the file — so a failed post is retried before the next task or at the next start,
  and a change that lands while the daemon is down is still announced exactly once. Only
  version -> version changes are announced (A -> B -> A is two); a probe `{ error }` is
  recorded on the task but never announced and never resets the last-announced value. The
  first successful probe on a box is the baseline and is not announced. A cohort with such a
  post in it ran on two binaries.

The post-fix soak requires ONE exact build set: both worker boxes must show the same
`worker_build` (no `-dirty`), the same `server_build` AND the same `vinci_binary=` in their
`online` posts before the cohort counts, and no `vinci binary changed` post may appear while it
runs. A cohort whose task records carry two different `worker_build` or `vinci_binary` values
is two cohorts.

## Clean room (`--clean-room`, W1; default OFF this wave)

What the default (shared-checkout) mode does, measured in soak cohort 2: one working tree per
repo **name** under `<state-dir>/repos/<name>`, reused across attempts, tasks and orgs; stale local
branches from an earlier attempt blocked a real continuation (rows 11/11b); the quarantine copies a
prior run's residue aside (`debris/`) but the tree stays shared; and the spawned `vinci -p` inherits
the daemon's whole environment — bus token, Governor token, `GH_TOKEN`, every provider key, AWS —
so an agent could push from inside its sandbox. Publishing already happens in the daemon after the
run (good), but with that same environment.

`--clean-room` (`vinci/worker/cleanroom.mjs`) replaces the shared things with per-attempt ones. It
flips on by default after the chaos gate; until then it is opt-in and the shared-checkout path is
byte-for-byte what it was.

| | shared checkout (default) | clean room (`--clean-room`) |
|---|---|---|
| Repository cache | none: the tree IS the clone | `<state-dir>/cache/<org>/<repo>.git`, one bare cache per **org/repo**, all heads fetched (pruned) before every attempt; its origin URL is checked on every reuse, so `a/repo` and `b/repo` can never share one |
| Working tree | `<state-dir>/repos/<name>`, keyed by name only, reused by every attempt, task and org | `<state-dir>/attempts/<org>/<repo>/<task>/<attempt>/`, a fresh `git worktree add --detach <base>` for **every** attempt, never reused (a dir that already exists is an error) |
| Base of an attempt | whatever the shared tree was left at; a stale local branch is fast-forwarded, refused, or renamed aside | `origin/<branch>` for a `branch:` envelope; otherwise `origin/worker/<task>` **when origin already has it** (attempt N published, then crashed or was resumed) and `origin/main` only when it does not — so attempt N+1's publish is a fast-forward, never a rejected non-fast-forward. Recorded as `base_commit` / `cache_ref` on the task. A previous attempt's local branch is renamed aside under `stale/…` in the cache (`stale_ref`), never deleted; if it holds commits that are NOT on `origin/worker/<task>`, the attempt is refused with shared mode's divergence reason (never-pushed residue is renamed aside first, the retry continues at `origin/worker/<task>`) — nothing is ever forced |
| A crashed attempt | its residue is quarantined into `debris/` by the NEXT task | its dir is sealed read-only as evidence when the next attempt starts, and never re-entered; the resume of a RUNNING task is attempt N+1 in a new dir |
| Child environment | the daemon's entire env | an **allowlist** (below): no bus/Governor/GitHub/AWS credentials, only the provider key the envelope names; the daemon's agent slot (`VINCI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`) never passes through |
| Child HOME / TMPDIR | the daemon's | `<attempt>.home/` and `<attempt>.tmp/` beside the tree (never inside it, so they are neither in `git status` nor in the evidence diff); the child's agent slot is `<attempt>.home/agent`, empty unless `VINCI_WORKER_AUTH_FILE` opts one credential file in (below) |
| `git push` from inside | works, with the daemon's credentials | the **default publish path is dead**, in the worktree AND in the bare cache (the `git-common-dir` every worktree can name): `remote.origin.pushurl=/dev/null` refuses `git push`, `git push origin`, `git push --no-verify origin` and `git -C <cache> push origin`; a `core.hooksPath` pre-push hook that exits 1 refuses `git push <literal url>`. This removes the **ambient** credentials and the default path; it does **not** stop a same-uid child that supplies its own — `git push --no-verify <literal url>` and `git remote add x <url> && git push --no-verify x` reach origin whenever the transport needs no credential the child lacks. See "What is still NOT isolated" |
| Publishing | `git push` from the tree, `gh pr create` in the tree | `git push --no-verify <origin url> refs/heads/<branch>` **from the bare cache**, under the daemon's env (the literal URL sidesteps the cache's dead pushurl, `--no-verify` its hook — `-c remote.origin.pushurl=…` would not: pushurl is multi-valued, `-c` appends, and git still tries `/dev/null` first); `gh pr create -R <org>/<repo>` (no tree needed). The branch ref is shared between cache and worktree, so nothing is fetched, copied, unset or re-set anywhere to publish — the child never holds a working push at any point, and the cache's refusal is intact after every publish |
| Bounds | none | refuse to start an attempt when `<state-dir>` has less than `--disk-floor-mb` free (`0` disables the floor, on the flag and on `VINCI_WORKER_DISK_FLOOR_MB` alike; an unparsable or negative value refuses to start); keep the newest `--keep-attempts` (3) **evidence-uploaded** attempt dirs per task and prune older uploaded ones — never the newest, never the running one, and **never a dir without its `<attempt>.evidence_uploaded` marker** (a crashed or never-uploaded attempt's sealed dir is the only evidence there is, so it is not prunable by count; with no evidence configured nothing is ever pruned) |
| Task record | as before | plus `attempt_dir`, `cache_ref`, `base_commit`, `stale_ref` |
| Sessions, debris, evidence bundle | outside the tree | unchanged, outside the tree |

**The child's environment (exact allowlist).** Copied verbatim from the daemon when set:
`PATH`, `LANG`, `VINCI_ENV`, `VINCI_BASE_URL`, `VINCI_PLATFORM_URL`, `VINCI_NO_BOOTSTRAP_HEAL`,
`VINCI_TOOL_BOOTSTRAP`, `VINCI_SHOW_OTHER_PROVIDERS`, `VINCI_SOURCE_CLI` — the variables
`vinci/bin/vinci` and the install shim read to find the backend and the run mode. Plus **only** the
key the envelope's `provider:` authenticates with: `OPENROUTER_API_KEY` for `openrouter`,
`VINCI_API_KEY` for `vinci`, `VINCI_INTERNAL_DEEPINFRA_API_KEY` for `deepinfra` (an unknown provider
gets no key and the launcher refuses it, as today). Set by the daemon, never copied: `HOME` and
`TMPDIR` (per attempt), `VINCI_CODING_AGENT_DIR` and `PI_CODING_AGENT_DIR` (both spellings, both
`<attempt>.home/agent` — the daemon's own slot is **not** passed through: it holds `auth.json` for
every provider, every prior session and `bin/`), `VINCI_HOME` (the launcher's install root — the
shim derives it from `HOME`, which is now the empty per-attempt one, so it is passed explicitly from
the daemon's `VINCI_HOME` or `<daemon HOME>/.vinci-code`), `VINCI_UPDATE_DISABLED=1`. **Everything
else is dropped**, in particular `VINCI_BUS_TOKEN`, `VINCI_GOVERNOR_TOKEN`, `GH_TOKEN`, `AWS_*`,
`VINCI_EVIDENCE_URI_PREFIX` and every other provider's key.

**Giving the child a login (`VINCI_WORKER_AUTH_FILE`).** A task that authenticates through a
stored login rather than a provider key needs an `auth.json` in the child's slot, and the slot is
empty by construction. The narrow opt-in is `VINCI_WORKER_AUTH_FILE=<path>` in the daemon's
environment: before the spawn the clean room copies **that one file** (mode 0600) to
`<attempt>.home/agent/auth.json` — nothing else from the daemon's slot, no sessions, no `bin/`. A
set-but-missing path fails the attempt with `VINCI_WORKER_AUTH_FILE … does not exist` rather than
running it logged out. Prefer a file that holds only the provider the envelope names. Because the child's `HOME` has no `~/.gitconfig`, the attempt
worktree carries the daemon's `user.name`/`user.email` (or `vinci-worker <worker@vinci.invalid>`) in
its worktree config, so the agent's commits work; and `~/.vinci-code.env` is NOT sourced for the
child (a profile is a place to put secrets) — put what the child needs in the daemon's environment.

**What is still NOT isolated — say it plainly.** The clean room is a guardrail against the
measured failures (shared trees, stale branches, credential inheritance, pushing from inside), not
a security boundary:

- **No container, no VM, no user separation.** The child runs as the daemon's uid on the daemon's
  box. It can read the daemon's files (state dir, sessions, other attempts' trees, the cache), and
  it can run `git config --unset remote.origin.pushurl` or edit the hooks. The push refusals
  remove the **default publish path**, nothing more. Verified open from inside an attempt
  (`vinci/test/worker-clean-room.mjs` asserts each bypass's status, so closing one flips a test
  deliberately): `git push --no-verify <literal url> HEAD:refs/heads/x` succeeds, and so does
  `git remote add x <url> && git push --no-verify x` — a URL on the command line has no pushurl
  and `--no-verify` skips the hook. `git -C "$(git rev-parse --git-common-dir)" push origin` (the
  cache, i.e. the daemon's own publish path) is refused since the cache carries the same
  refusals. What decides whether an open bypass lands is the **transport's credential**, and that
  boundary is **HOME-keyed, not uid-keyed**: the clean room withholds the ambient env credentials
  and gives the child an empty HOME, but a same-uid child can point `GH_CONFIG_DIR` or
  `GIT_CONFIG_GLOBAL` at the daemon's HOME and reach the daemon's `gh auth` login or credential
  helper; an SSH agent socket or an instance profile is reachable regardless of HOME; and on
  **macOS the boundary is absent** — Apple git's system gitconfig sets
  `credential.helper=osxkeychain` for every HOME, so any credential in the keychain is the
  child's. A real boundary is a separate uid or a container; until then treat "push from inside
  refused" as a guardrail against accidents, not against intent.
- **`VINCI_HOME` is writable by the child.** The launcher's install root (`versions/`,
  `updater/`) is passed explicitly and shared with the daemon; a child can modify the binary the
  NEXT attempt runs under (`VINCI_UPDATE_DISABLED=1` stops the updater, not a write). Mitigation to
  come: a read-only bind of `VINCI_HOME` or a separate uid; until then the recorded
  `vinci_binary` version on every task is the tripwire, not a guard.
- **No network allowlist.** The child can reach anything the box can reach.
- **No CPU, memory or process limits** beyond the existing runtime/budget/deadline kills.
- **Disk and retention are bounds, not quotas.** The floor refuses to START an attempt; it does not
  stop a running one from filling the disk.

Verified by `vinci/test/worker-clean-room.mjs` (real git; two attempts ⇒ two dirs and the first kept
sealed; two tasks on one repo ⇒ no shared tree; `a/repo` vs `b/repo` ⇒ distinct caches; the
allowlist with five planted secrets, end to end through the daemon; `git push` from inside refused
on the default path — worktree and cache — while the daemon's publish still lands the branch and the
PR, and the two open bypasses asserted open; attempt N+1 continuing at `origin/worker/<task>` after
attempt N published, and the divergence refusal; the agent-slot cut-off and the one-file auth
opt-in; marker-gated retention; the disk floor and the `0`/unparsable env values) and by the
existing worker suite with the flag off.

## Network Access

- Outbound HTTPS to bus (`--server`)
- Outbound HTTPS to GitHub (clone, fetch, push, PR operations)
- NO inbound network required
- Runs with `--tools read,grep,find,ls,bash,edit,write` only (no network tools)

## See Also

- vinci-gpu-control: docs/CONTRACT.md §16 (bus message contract)
- vinci-code-cli: vinci/bin/vinci (main CLI, commands like `worker start`)

## Stage 2: Authority and Governance (Optional)

Stage 2 adds two opt-in hooks that enforce resource governance and audit trails. Both are inactive unless their environment variables are set; workers without Stage 2 configuration behave identically to Stage 1.

### Governor Lease (fail-closed)

The Governor is configured by `--governor <url>` plus the `VINCI_GOVERNOR_TOKEN` env. Once a
Governor URL is configured, **the only thing that lets a task clone a repository or spawn a
model is a granted lease.** There is no fail-open path. Exactly these rules apply:

1. **When to claim**: before the repository is cloned and before `vinci -p` is spawned, the daemon calls `POST {governor}/v1/governor/claim-paths` with the task's claim path(s) (envelope header `claim:`, default `.`), `Authorization: Session <token>`, `Idempotency-Key: <task-id>/<attempt>`.
2. **URL set, token missing**: the task is **BLOCKED** with reason `governor token missing (VINCI_GOVERNOR_TOKEN)`, a `blocker` is posted, and the Governor is not contacted. The task never runs ungoverned.
3. **Governor unreachable, network error, body that is not a JSON object, or any HTTP status other than 200 / 403 / 409 / 422**: the task is **BLOCKED**; the reason carries the status or the error (`Governor connection failed: ECONNREFUSED`, `Governor returned invalid JSON (status 200): ...`, `Governor returned a malformed body (status 200): ...`, `Governor error: unexpected status 500 ...`). The blocker post is prefixed `Governor unavailable/invalid:` and the task snapshot records `outcome.governor = "unavailable"`. Never "proceed".
4. **Refusal (403 / 409 / 422)**: the task is **BLOCKED**; the blocker post is prefixed `Governor refused the lease:` followed by the Governor's `reason` text verbatim, and the snapshot records `outcome.governor = "refused"`. Refusal and unavailability are never conflated.
5. **Granted (200)**: a 200 is a lease only if its body is a JSON object whose `ttl` is a JSON number that is finite and greater than 0. There is no default ttl: `0`, negative, a string such as `"60"`, `null`, or a missing `ttl` ⇒ **BLOCKED** with reason `Governor lease invalid: ttl=<value>` (no clone, no spawn). A valid lease (`claimed_at`, `paths`, `ttl`, and any `budget_usd` / `max_runtime_s` / `deadline` from the work order) is recorded in the lifecycle's `lease` field, and the limits are tightened before the run starts.
6. **Lease TTL is enforced**: the run's effective `max_runtime_s` is `min(envelope max_runtime_s, work-order max_runtime_s, lease ttl seconds)`; because every granted lease carries a validated ttl, the runtime timer that sends SIGTERM (then SIGKILL after the grace period) always fires no later than the lease ttl after the model is spawned. Time spent cloning before the spawn is not counted against the ttl. The value actually used is recorded as `lease.effective_max_runtime_s` in the task snapshot. Smaller `budget_usd` and earlier `deadline` from the work order also replace the envelope's.

**Requiring a Governor.** By default the daemon still starts without `--governor` (the production Governor canary is currently off; Wave 1 flips this default). To make an ungoverned start impossible today, pass `--require-governor` or set `VINCI_WORKER_REQUIRE_GOVERNOR=1`: if no `--governor <url>` is configured the daemon refuses to start, writes the reason to stderr, and exits with code **78** (`EX_CONFIG`). This is the first check after option parsing — it runs before the `VINCI_BUS_TOKEN` check, before the daemon lock is taken (an existing `daemon.lock` is not read or touched), and before any bus request — so the exit code is 78 regardless of what else is missing.

**Deployment prerequisite:** Governor URL must be reachable only from inside the dev-box network; Stage 2 boxes need network access to the local listener. Token is never logged or exposed.

### Evidence Upload

When `VINCI_EVIDENCE_URI_PREFIX` is set (e.g. `s3://bucket/vinci/evidence/`):

1. **After the run and publish, before the terminal state is written**: Build a deterministic bundle (session JSONL, git diff, result.json = the snapshot about to be committed, runner log with last 200 lines)
2. **Upload to S3**: `aws s3 cp --no-progress {bundle.tgz} {prefix}{task-id}/{sha256}.tgz`
3. **For ledger refs (job_/exp_/bk_ prefix)**: POST evidence metadata to `{busUrl}/v1/evidence` with body `{job_ref, sha256, uri, kind: "bundle", bytes, produced_at}` using the worker's Bearer token
4. **For non-ledger refs**: Skip the evidence bus POST (the server would reject it with 422); caller can include uri+sha256 in the final message if desired
5. **Terminal write**: an upload failure or a non-2xx metadata POST downgrades `COMPLETED` → `UNVERIFIED` and sets `evidence_error`; `BLOCKED`/`FAILED` keep their state and record `evidence_error` (see Lifecycle)
6. **Final bus post**: Carries `evidence_uri=...` and `evidence_sha256=...` only when `aws s3 cp` succeeded (`uploaded: true`; a failed upload never advertises its intended uri), plus `evidence_error=...` whenever evidence was attempted and did not fully land; a downgraded task posts `status`, never a ledger `finding`

**Data model:**
- Evidence bundle contains: session.jsonl (full session transcript), git.diff (origin/main...HEAD), result.json (lifecycle snapshot), runner.log (last 200 lines of daemon stderr)
- Evidence metadata is immutable; duplicate uploads return 200 OK without re-storing
- Non-ledger refs (e.g., "handoff:123") skip the evidence endpoint POST but their uri/sha256 still appear in the final status/blocker body

**Deployment prerequisite:** AWS CLI on PATH; S3 bucket role with PutObject-only permissions; no read access to other buckets.

### Envelope Headers (Stage 2)

- `claim:` — Path or glob to claim from Governor (default `.`). Unknown headers still → blocker.
- `evidence_ref:` — Alias for `ref` header; clarifies that this ref identifies evidence in the ledger.

Both hooks are independent: you can use Governor lease without evidence upload, or evidence upload without Governor lease. If neither is configured, Stage 2 has zero overhead; the daemon behaves identically to Stage 1.
