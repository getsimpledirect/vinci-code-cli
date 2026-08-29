# Vinci Worker — Stage 1

Standalone Node program that polls an HTTP bus for work handoffs, spawns unattended `vinci -p` runs, monitors limits (runtime, budget, deadline), and publishes results back to the bus.

The daemon processes one handoff at a time and blocks until that task reaches a terminal state.

## Setup

```bash
vinci worker start --id <worker-id> \
  --server http://bus.example.com:8000 \
  [--once] [--poll-seconds 60] [--state-dir ~/.vinci-worker-state] \
  [--governor http://governor:8100] [--require-governor]
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
8. **Publish**: Push branch to origin; if evidence==pr and no BLOCKER.md, create a PR
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
  "publish": "pushed",
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
- `VINCI_DECLARATION_REFRESH_S`: how often (seconds) a governed daemon re-posts its capability declaration; default `3600`, and anything that is not a positive number falls back to the default. It must stay comfortably below the Governor's `VGC_DECLARATION_MAX_AGE_S` (default 86400), which is when a declaration expires and admission starts answering `eligible: false, reason: stale_declaration`
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
  repos/
    <name>/                      # Cloned repo
      sessions/                  # vinci JSONL read for outcomes and usage
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

1. **When to claim**: after the work-order lease below is granted (Wave 1B: lease first, because the Governor has no endpoint that releases a path claim, so a claim must never be held for a lease the worker does not get) and before the repository is cloned and `vinci -p` is spawned, the daemon calls `POST {governor}/v1/governor/claim-paths` with the task's claim path(s) (envelope header `claim:`, default `.`), `Authorization: Session <token>`, `Idempotency-Key: <task-id>/<attempt>`, and — required — `attempt_id` in the body, the SAME `<task-id>/<attempt>` string the lease acquire sent. The Governor's holder gate refuses any claim on a leased work order whose `attempt_id` is not the current holder's, and an absent `attempt_id` fails that comparison too; since the lease is acquired first, a claim without it would be refused `403 leased_by_other_attempt` for every governed task — blocked by a lease this very worker holds. The daemon computes the attempt id once and passes it to both calls; it is never derived twice. A missing `attempt_id` fails closed client-side (`claim attempt_id is missing`) rather than being sent.
2. **URL set, token missing**: the task is **BLOCKED** with reason `lease_unavailable: governor token missing (VINCI_GOVERNOR_TOKEN)` (the lease acquire is the first thing that needs the token), a `blocker` is posted (`Governor lease unavailable:`), and the Governor is not contacted. The task never runs ungoverned.
3. **Governor unreachable, network error, body that is not a JSON object, or any HTTP status other than 2xx / 403 / 409 / 422**: the task is **BLOCKED**; the reason carries the status or the error (`Governor connection failed: ECONNREFUSED`, `Governor returned invalid JSON (status 200): ...`, `Governor returned a malformed body (status 200): ...`, `Governor error: unexpected status 500 ...`). When the path claim is what failed, the blocker post is prefixed `Governor unavailable/invalid:` and the task snapshot records `outcome.governor = "unavailable"`; the lease held for it is released `blocked`. (An unreachable Governor is seen first by the lease acquire, whose blocker reads `Governor lease unavailable: lease_unavailable: Governor connection failed: ...` — same classification, no lease and no claim held.) Never "proceed".
4. **Refusal (403 / 409 / 422)**: the task is **BLOCKED**; the blocker post is prefixed `Governor refused the lease:` followed by the Governor's `reason` text verbatim, the snapshot records `outcome.governor = "refused"`, and the work-order lease held for the claim is released `blocked`. Refusal and unavailability are never conflated.
5. **Granted (200)**: a 200 is a lease only if its body is a JSON object whose `ttl` is a JSON number that is finite and greater than 0. **Known cross-repo disagreement:** the deployed server does not send `ttl` at all — its 200 body is `{ok, reason, claim_hash, paths}` (`app.py:2888-2893`) even though the handler computes the ttl and passes it into `governor_runtime.claim_paths` — so against today's server every governed task blocks here at `Governor lease invalid: ttl=undefined`. The server fix is dispatched on gpu-control #201; the client requirement stays, because the claim ttl is a runtime cap (rule 6) and accepting a ttl-less claim would silently delete it. Both sides are pinned by tests (`worker-lease-loop.mjs`: "claim-paths without ttl (the DEPLOYED server shape) blocks before any work" / "claim-paths WITH ttl (the fixed server) runs"). There is no default ttl: `0`, negative, a string such as `"60"`, `null`, or a missing `ttl` ⇒ **BLOCKED** with reason `Governor lease invalid: ttl=<value>` (no clone, no spawn). A valid lease (`claimed_at`, `paths`, `ttl`, and any `budget_usd` / `max_runtime_s` / `deadline` from the work order) is recorded in the lifecycle's `lease` field, and the limits are tightened before the run starts.
6. **Lease TTL is enforced**: the run's effective `max_runtime_s` is `min(envelope max_runtime_s, work-order max_runtime_s, lease ttl seconds)`; because every granted lease carries a validated ttl, the runtime timer that sends SIGTERM (then SIGKILL after the grace period) always fires no later than the lease ttl after the model is spawned. Time spent cloning before the spawn is not counted against the ttl. The value actually used is recorded as `lease.effective_max_runtime_s` in the task snapshot. Smaller `budget_usd` and earlier `deadline` from the work order also replace the envelope's.

**Requiring a Governor.** By default the daemon still starts without `--governor` (the production Governor canary is currently off; Wave 1 flips this default). To make an ungoverned start impossible today, pass `--require-governor` or set `VINCI_WORKER_REQUIRE_GOVERNOR=1`: if no `--governor <url>` is configured the daemon refuses to start, writes the reason to stderr, and exits with code **78** (`EX_CONFIG`). This is the first check after option parsing — it runs before the `VINCI_BUS_TOKEN` check, before the daemon lock is taken (an existing `daemon.lock` is not read or touched), and before any bus request — so the exit code is 78 regardless of what else is missing.

**Deployment prerequisite:** Governor URL must be reachable only from inside the dev-box network; Stage 2 boxes need network access to the local listener. Token is never logged or exposed.

### Work-order lease loop (Wave 1B)

With `--governor` set, every task holds a **work-order lease** (`vinci/worker/lease.mjs`) from before the path claim until its terminal state; without `--governor` none of this runs and the daemon is byte-identical to before. All lease calls go to `<governor>/v1/governor/leases…` with `Authorization: Session <VINCI_GOVERNOR_TOKEN>`, except `check`, which uses the bus token. Every lease request is bounded by a 10 s timeout (`LEASE_TIMEOUT_MS`): a Governor that accepts the connection and never answers is `Governor connection failed: timeout after 10000 ms` — the same class as a refused connection, so a hang can never hold a heartbeat, a fence or a release open.

1. **Acquire (L1)** — BEFORE the path claim and before the clone: `POST /v1/governor/leases` with `work_order_id` (the envelope `ref`, else the task id — `leaseSubject(task)` is the one place to change when digest handoffs carry the real id), `attempt_id` (`<task>/<attempt>`), `worker_build_digest` (the daemon's commit), `adapter_version` (identity.json) and `capability_declaration_digest`. **Any 2xx** with a string `lease_id`, a `fencing_generation` and a numeric `ttl_s` of at least 1 second is a lease and is recorded on the task (`lease.lease_id`, `fencing_generation`, `expires_at`, `ttl_s`); `ttl_s` below 1 (`0`, `0.3`, negative, a string, missing) ⇒ **BLOCKED** `lease_unavailable: Governor lease invalid: ttl_s=<value>`. `409 {reason:"leased"}` — or the older server's `403 {reason:"leased_by_other_attempt"}`, read as the same decision ⇒ **BLOCKED** `leased_by <holder_attempt_id> until <expires_at>` (`outcome.governor = "leased"`; the task is not ours — not a failure). Anything else ⇒ **BLOCKED** `lease_unavailable: <reason>` (fail closed).

   The two repos deploy independently, so this client assumes neither the Governor's status codes nor its rollout state. Concretely: (a) **any 2xx** with a well-formed body is a granted lease — the server's acquire is moving from `201` to `200` and a client pinned to one of them would refuse a lease it was actually granted, leaving the Governor holding a lease nobody renews or releases; (b) a **lease-state reason** is a **decision** — final, never retried — whether it arrives on the old `403` or the new `409`, and that applies at acquire (`leased` when it names another holder, otherwise `refused`) as well as at renew. The reasons are matched against the strings the server actually emits, not a plausible-looking set: `"work order expired"`, `"session not in a live state"` and the `"work order deadline rule: …"` family are **verified** in vinci-gpu-control main (`governor_runtime.py:530,843`, `:854`, `app.py:152`); `"unknown lease"`, `"lease not held by this session"` and the snake_case wire reasons (`stale_generation`, `expired`, `revoked`, `released`, `leased`, `leased_by_other_attempt`) are **relayed from the #201 review and not verifiable on main**, where the lease endpoints do not yet exist. Both spellings are carried so whichever set the deployed server emits is classified as a decision; (c) **anything else non-2xx** is a transport/unknown failure and fails closed on its own path (renew retries once, then loss of authority). (d) `fencing_generation` is validated as **an integer ≥ 1, or a non-empty string**. The number half is narrow because the server validates the generation on the way *in* (`app.py`, `type is int and >= 1`, else 400): accepting `0`, `-3` or `1.5` would not avoid the failure, it would move it past the point of no return — acquire succeeds, the clone runs, the child spawns, and then the first renew 400s, is filed `unreachable`, and the run is SIGTERMed mid-flight. The string half stays wide because the worker only echoes the fence back and never interprets it. Values the worker *does* interpret (`ttl_s` bounds the run, `lease_id` builds a URL) are type-checked hard. A refused or unavailable lease leaves no path claim held (the Governor cannot release one); a path claim refused after the lease was granted releases the lease `blocked`. No git runs before a lease is held.
2. **Heartbeat (L2)** — renew every `ttl_s/3` (unref'd timer) from acquire until release; a renew that serves `ttl_s` below 1 keeps the previous ttl. The first renew refused (`409 stale_generation|expired|revoked`) or unreachable after one retry (a timeout counts as a miss) is **loss of authority**: the child is SIGTERMed (SIGKILL after 10 s, `VINCI_WORKER_LEASE_KILL_GRACE_MS`), the task is **BLOCKED** `lease_lost:<reason>`, nothing is published — not even a branch push — and the evidence bundle is still attempted with `authority: "lost"` in result.json (its ledger POST is fenced out). A loss during the clone skips the spawn entirely.
3. **Fencing (L3)** — before `git push`, before `gh pr create` and before the evidence POST the publisher calls `POST /v1/governor/leases/{id}/check` with the bus token; `valid: false` (or no usable answer, including a timeout) skips that side effect and records `fenced_out:<reason>` (task **BLOCKED**, `outcome.reason = fenced_out:<reason>`, `lease.checks[]` lists every verdict). All three fences end the same way: a fence-out at the evidence POST — after a valid push and PR — is still **BLOCKED** `fenced_out:<reason>` with `evidence_error` set and `evidence_result_state` naming the state result.json was uploaded as, never a quiet UNVERIFIED. The PR body footer and the evidence metadata carry `fencing_generation`.
4. **Release (L4)** — on every terminal path, including the catch block, with the outcome matching the state (`completed|failed|blocked|unverified`; a lost or fenced-out lease releases `abandoned`). The heartbeat is stopped and a renew already in flight is awaited BEFORE the release is sent, so the Governor never sees a renew arrive after the release for the same generation. A release failure is logged and never changes the state.
5. **Declaration (D1)** — at startup, right after `online`, and re-posted every `VINCI_DECLARATION_REFRESH_S` seconds (default 3600) thereafter, the daemon posts `status` `worker <id> declaration` whose body is the canonical JSON of its WorkerDeclaration (vinci-contracts `worker-capabilities`, schemaVersion 1) filled with what this daemon actually does and nothing it cannot prove: `structuredEvidence` is true only when `VINCI_EVIDENCE_URI_PREFIX` is set at startup (no prefix, no bundle); `abort` is false (the daemon consumes only `kind: handoff` and has no abort handler — limits, lease loss and its own SIGTERM end a run, but nobody can command one); `safeResume` is false (a restart re-runs a RUNNING task as the next attempt, but no test proves a kill mid-write resumes without loss or duplication); activity stream, questions, steering, pause, read-only restriction, filesystem/network enforcement, native receipts and independent verification are false; approvals `none`; hence `controlLevel: inventoried`. `capability_declaration_digest` = sha256 of that body (vendored canonicalizer in `vinci/worker/contracts/`) and is recorded on every governed task. The re-post exists because the Governor **expires** a declaration at `VGC_DECLARATION_MAX_AGE_S` (default 86400 s) and then answers admission `eligible: false, reason: stale_declaration`: a daemon that declared only at startup would go silently inadmissible for all work after a day alive. Re-posts run the same code path as the startup post, so an unchanged daemon re-posts a byte-identical body under an identical digest. The refresh timer is unref'd (it never keeps the process alive; `--once` still exits) and a failed re-post is written to stderr and retried at the next tick — it never stops the poll loop or kills the daemon.
6. **Stop with a lease in flight** — on SIGTERM/SIGINT the daemon stops the heartbeat, waits for a renew in flight, releases the lease `abandoned` (the whole thing bounded by the 10 s timeout, logged if it does not complete), SIGTERMs the child so nothing keeps working under a released lease, and exits 0. The task record is left RUNNING and is resumed as the next attempt by the next daemon start (which acquires a fresh lease). Without an active lease a stop is the plain exit it always was.

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
