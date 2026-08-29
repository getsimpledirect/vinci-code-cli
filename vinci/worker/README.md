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
4b. **RE-RUN of a published spec.** `git ls-remote origin refs/heads/<targetBranch>`: if origin
   already has that branch and it DESCENDS from this spec's `baseCommit` (and is not simply
   sitting at it), the run is **BLOCKED `already_published`** — before the spawn, and on a cold
   box as well as a warm one. `targetBranch` and `baseCommit` are both fixed by the execution
   spec, so a branch of that name built on that base is that spec's own output; a re-run needs a
   new spec or a new `targetBranch`. Previously only a warm box noticed, and called it
   `branch_diverged` — false, because the commits it refused to reset were this contract's own
   output; on a cold box nothing refused at all and the model was spawned and paid for before
   the push failed;
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
| `base_ref_unavailable` / `base_commit_unreachable` / `already_published` / `branch_diverged` | the base checkout (see above) |

A successful digest handoff stamps the task record with `work_order_id`, `contract_digest`
(long form), `execution_spec_digest`, `base_commit`, `base_ref`, `promotion`, `output`,
`model_class`, `tools`, `input_artifacts`, `required_capabilities`. EVERY terminal post of a
digest-form task — the final state AND every early blocker (refusal, invalid bounds, Governor
refusal/unavailability, base checkout) — carries `contract=<work_order_id>@<digest8>` as its first
token (`contract=malformed` when the triple itself could not be parsed, and also when the
handoff's `message_id` is not a valid task id, which refuses before the body is read); prose-form
posts never carry the tag.

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
