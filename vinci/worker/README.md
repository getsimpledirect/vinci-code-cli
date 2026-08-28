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

<blank line>

<free-text specification passed verbatim to vinci -p>
```

Unknown headers → blocker posted, task not run.

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
  (`buildIdentity()`): `{ version, commit, dirty, source }`. `version` is `identity.json`'s
  version (the string task records always carried as `vinci_version`, which is kept);
  `commit` is `git rev-parse HEAD` of the checkout the daemon runs from (`null` when not a git
  checkout or git is unavailable, then `source` is `"package"` instead of `"git"`); `dirty`
  is whether `git status --porcelain --untracked-files=no` is non-empty (`null` when unknown).
- `server_build` — the verbatim payload of `GET <server>/v1/version` (unauthenticated; 3 s
  timeout; vinci-gpu-control reports `git_sha`, `dirty`, `server_code_sha256`, …), fetched once
  at daemon start. On any failure it is `{ "error": "<why>" }` and the daemon still starts.
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
- Post-0.0.51 rule: **a task never runs under a self-updating launcher.** `runVinci` spawns
  with `VINCI_UPDATE_DISABLED=1`, so nothing can swap the payload between the pre-spawn probe
  and the run — the recorded `vinci_binary` is the executed binary by construction. Updating
  the launcher on a worker box is an operator action (`vinci update`, as the deploy recipe
  already does), never something a task triggers.
- `vinci_version` is kept for compatibility and is the DAEMON CHECKOUT's `identity.json`
  version (identical to `worker_build.version`). It is NOT the version of the binary that ran
  the task — the 0.0.51 incident was a task record saying `vinci_version: "0.0.51"` on a box
  whose launcher was verified at 0.0.52. Read `vinci_binary` for that.
- All of them are written into the task record (`<state-dir>/tasks/<id>.json`) by `startAttempt`:
  `worker_build` is stored as `{ version, commit, dirty }` (`source` is omitted),
  `server_build` as the payload verbatim (or `{ error }`), `vinci_binary` as `{ version, path }`
  (or `{ error }`). The task record is what ships as the evidence bundle's `result.json`, so the
  same fields appear there.
- Every terminal bus post — the final post from a run AND the early blockers (envelope error,
  past deadline, governor refusal/unavailability) — carries `worker_build=…` and
  `vinci_binary=…` via one shared formatter in `worker.mjs` (`terminalPostBody`).
- The bus sees them twice: the daemon's single `worker <id> online` status post at start
  (`worker_build=<commit or version>[-dirty] worker_version=<version>
  server_build=<server commit | unknown: <error>> vinci_binary=<version | unknown: <error>>`,
  posted once per start, before the first poll, in `--once` mode too; a daemon that refuses to
  start — lock held, exit 75, or missing Governor, exit 78 — never announces itself and never
  fetches `/v1/version`), and `worker_build=<commit or version>[-dirty] vinci_binary=<…>` on
  every terminal task post.
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
