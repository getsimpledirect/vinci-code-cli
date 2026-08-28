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
7. **Outcome**: Read task-outcome from session JSONL (DONE, DONE-UNVERIFIED, WAITING, BLOCKED)
8. **Publish**: Push branch to origin; if evidence==pr and no BLOCKER.md, create a PR
9. **Report**: Post finding (COMPLETED), blocker (BLOCKED/FAILED), or status (UNVERIFIED)

## Task Envelope

Handoff message body (line-oriented headers, blank line, then spec):

```
repo: org/repo
evidence: pr|none                  (default: pr)
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
  "vinci_version": "0.42.0",
  "provider": "openrouter",
  "model": "z-ai/glm-5.2",
  "cost_usd": 2.15,
  "terminal": true,
  "lease": { "claimed_at": "...", "paths": ["."], "ttl": 3600, "effective_max_runtime_s": 3600 },
  "evidence_error": null
}
```

**Restart behavior:**
- If `terminal=true`: skip (already done)
- If `terminal=false`: increment `attempt`, keep same `session_id`, resume

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
3. **Governor unreachable, network error, invalid/non-JSON body, or any HTTP status other than 200 / 403 / 409 / 422**: the task is **BLOCKED**; the reason carries the status or the error (`Governor connection failed: ECONNREFUSED`, `Governor returned invalid JSON (status 200)`, `Governor error: unexpected status 500 ...`). Never "proceed".
4. **Refusal (403 / 409 / 422)**: the task is **BLOCKED**; the blocker carries the Governor's `reason` text verbatim.
5. **Granted (200)**: the lease (`claimed_at`, `paths`, `ttl`, and any `budget_usd` / `max_runtime_s` / `deadline` from the work order) is recorded in the lifecycle's `lease` field, and the limits are tightened before the run starts.
6. **Lease TTL is enforced**: the run's effective `max_runtime_s` is `min(envelope max_runtime_s, work-order max_runtime_s, lease ttl seconds)` — the task can never outlive its lease. The value actually used is recorded as `lease.effective_max_runtime_s` in the task snapshot. Smaller `budget_usd` and earlier `deadline` from the work order also replace the envelope's.

**Requiring a Governor.** By default the daemon still starts without `--governor` (the production Governor canary is currently off; Wave 1 flips this default). To make an ungoverned start impossible today, pass `--require-governor` or set `VINCI_WORKER_REQUIRE_GOVERNOR=1`: if no `--governor <url>` is configured the daemon refuses to start, writes the reason to stderr, and exits with code **78** (`EX_CONFIG`) before taking the daemon lock or polling the bus.

**Deployment prerequisite:** Governor URL must be reachable only from inside the dev-box network; Stage 2 boxes need network access to the local listener. Token is never logged or exposed.

### Evidence Upload

When `VINCI_EVIDENCE_URI_PREFIX` is set (e.g. `s3://bucket/vinci/evidence/`):

1. **After the run completes** (any terminal state): Build a deterministic bundle (session JSONL, git diff, result.json, runner log with last 200 lines)
2. **Upload to S3**: `aws s3 cp --no-progress {bundle.tgz} {prefix}{task-id}/{sha256}.tgz`
3. **For ledger refs (job_/exp_/bk_ prefix)**: POST evidence metadata to `{busUrl}/v1/evidence` with body `{job_ref, sha256, uri, kind: "bundle", bytes, produced_at}` using the worker's Bearer token
4. **For non-ledger refs**: Skip the evidence bus POST (the server would reject it with 422); caller can include uri+sha256 in the final message if desired
5. **Final bus post**: Carries `evidence_uri=...` and `evidence_sha256=...` in details (or `evidence_error=...` if upload failed); terminal state is never flipped to FAILED on evidence upload failure

**Data model:**
- Evidence bundle contains: session.jsonl (full session transcript), git.diff (origin/main...HEAD), result.json (lifecycle snapshot), runner.log (last 200 lines of daemon stderr)
- Evidence metadata is immutable; duplicate uploads return 200 OK without re-storing
- Non-ledger refs (e.g., "handoff:123") skip the evidence endpoint POST but their uri/sha256 still appear in the final status/blocker body

**Deployment prerequisite:** AWS CLI on PATH; S3 bucket role with PutObject-only permissions; no read access to other buckets.

### Envelope Headers (Stage 2)

- `claim:` — Path or glob to claim from Governor (default `.`). Unknown headers still → blocker.
- `evidence_ref:` — Alias for `ref` header; clarifies that this ref identifies evidence in the ledger.

Both hooks are independent: you can use Governor lease without evidence upload, or evidence upload without Governor lease. If neither is configured, Stage 2 has zero overhead; the daemon behaves identically to Stage 1.
