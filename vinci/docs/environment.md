# Development Environment

Internal doc. How to test Vinci Code against the non-production backend, and which testing
lane to use for what. The *mechanics* of `VINCI_ENV=dev` (what it sets, what it isolates,
override precedence) are documented in the README's "Running against a non-production Vinci"
section — this doc covers the workflow around it. The dev box itself (instances, deploys,
secrets) is owned by vinci-chat `docs/DEPLOY.md` — details live there, not here.

## The Three Testing Lanes

| Lane | How | Use for |
|---|---|---|
| Local code → dev backend | `VINCI_ENV=dev vinci` from a checkout | The main development loop: CLI changes, backend-coordinated changes, anything a human should bang on before prod |
| Installed CLI → dev backend | `VINCI_ENV=dev vinci`, or `VINCI_ENV=dev` in `~/.vinci-code.env` to make a machine dev-by-default | Testing closer to what users run, without touching prod data |
| Installed CLI → prod | plain `vinci` | The release artifact and the update path themselves — there is no dev release channel, so these are only testable against prod |

`vinci doctor` is the ground truth for which environment a session is in; interactive
sessions also show the `▲ dev` header badge. If a bug report doesn't say which environment
it came from, get the doctor output before filing.

## First-Time Setup

Run `/login vinci` inside a `VINCI_ENV=dev` session. Device pairing goes against the dev
Platform instance and the key lands in the isolated dev config dir, so the prod credential
is untouched — after this one login, dev and prod sessions coexist with no further ceremony.
Your account must be on the dev box's signup allowlist (see vinci-chat `docs/DEPLOY.md`).

## Coordinated Backend and CLI Changes

When a CLI feature needs a gateway or Platform change:

1. Land the backend change on the backend repo's `dev` branch → it deploys to the dev box.
2. Test the CLI against it: `VINCI_ENV=dev vinci` (local checkout of the CLI branch).
3. Promote the backend to `main` (Platform's promotion gate already requires Vinci Code
   compatibility verified on dev first).
4. Merge the CLI side.

Never merge a CLI change that depends on a backend change still sitting on `dev` — prod
users would hit the gap between the two merges.

## What Testing on Dev Does Not Cover

Not exercisable on dev (by design of the dev box — see vinci-chat `docs/DEPLOY.md` for why):

- **Billing/entitlement flows** — the dev box has no Stripe. Structured billing-error
  handling is covered by the CLI's own test fixtures instead.
- **Full RAG** — no Qdrant on dev; retrieval silently degrades.
- **The install/update path** — dev mode disables auto-update, and no dev manifest exists.
  Update behavior is only testable against the prod channel.

Behavioral caveats while testing:

- Dev sends **real email** (it carries production sender credentials) — signups and
  verification mails from dev hit real inboxes and real deliverability reputation.
- Dev's provider spend pools with production's inference balance. Don't run large
  benchmarks against dev; use the dedicated benchmark lanes.
- Transitional: installs whose bootstrap predates payload-updater-version 0.0.42 perform
  one prod update check on the first dev launch, before self-heal refreshes the shim.

## Local Runtime Task Client

`vinci runtime --help` exposes additive commands over the existing Work task HTTP
boundary. It does not start an agent or change Pi session IDs. A task listener is
currently a local qualification fixture, not a deployed Runtime service.

Set `VINCI_RUNTIME_CONFIG` to an absolute, owned, non-symlink JSON file with mode
0600. It contains an exact numeric loopback `origin` and either `cookie` (current
personal session) or `token` (separately authorized Work task credential). Never
reuse a managed inference key as task authority. No credential discovery, login,
account linking or remote configuration is performed by this command.

Use `--spec <file>` or `--spec -` to avoid putting content/credentials on argv:

```sh
vinci runtime create --spec saved-task.json --json
vinci runtime inspect <run-id>
vinci runtime approvals <run-id>
vinci runtime approve <run-id> --spec exact-action.json
vinci runtime correct <run-id> --spec exact-correction.json
vinci runtime watch <run-id> --after 0 --timeout 60
vinci runtime receipt <run-id> --json
vinci runtime report <run-id> --json
vinci runtime export <run-id> <artifact-id> <version> > output.txt
vinci runtime cancel <run-id>
```

Creation requires `{ "saved": true, "input": "...", "commandId": "..." }`.
An answer needs `questionId`, `answer`, `expectedRevision`, and `humanSeconds`.
Approval needs `approvalId`, the reviewed `actionDigest`, stable `commandId`, and
`humanSeconds`. The client checks the exact current action before sending intent;
the service rechecks authorization and action binding. It never replaces stale
parameters or retries a mutation automatically. Specs retain their original JSON
bytes so the service can reject ambiguous duplicate fields.

Correction needs `approvalId`, the reviewed `actionDigest`, nonblank `text`, an
explicit `target`, stable `commandId`, and the reviewed snapshot's `expectedRevision`.
It sends those original spec bytes to the existing correction route. The service
checks the exact action and revision, expires the old approval and stores a new
feedback version. That returned `revision` is a content version, not the task's
event-sequence revision. A replacement draft and destination require a fresh review
and separate approval; correction itself authorizes no effect.

An exact accepted correction retry returns the same content version without adding
events, including after replacement review begins. Changed parameters under that
command ID conflict; a new command against the old action is stale. The CLI performs
no fresh-state preflight for correction that would block an accepted exact retry,
and never changes parameters or retries a mutation automatically. Inspect and
review first when preparing a new correction; reconcile an unconfirmed result
using its original command identity and bytes.

JSON output preserves the canonical response and receipt limitations. Cancellation
requests do not prove termination. Watch emits ordered JSON lines, refuses a replay
gap, polls at most once per second, and requires an explicit deadline of at most
one hour. Stdin has a five-second deadline. Exit codes: 2 invalid input/unsupported
command; 69 unconfirmed transport/response; 75 stale/conflicting/service refusal;
77 authorization refusal; 78 configuration refusal; 124 bounded wait elapsed.
Failures have sanitized stderr diagnostics; private server error bodies are not
echoed. Output and exported copies can contain saved user content, so their
destination and retention remain the caller's responsibility. Task listing, worker
launch/resume, denial, schedules, patch publication, merging, and deployment remain
unavailable because the qualified boundary does not expose them.

`report` emits an allowlisted local summary with consumer `reportVersion: 1`
instead of saved task content. It reads
the current snapshot, complete event replay and receipt, then rechecks current
authority and stable revision before writing any output. Replay is bounded to
1,000 contiguous same-run/personal-scope events and the existing response byte
limit; incomplete, conflicting, unsupported or changing data refuses explicitly.
Its four reads retain the existing five-second request deadlines. It performs no
mutation, artifact export, inference, credential discovery or automatic resync.

Recorded `agent.turn_finished` input/output tokens and integer micro-USD counters
are deduplicated by canonical `turnId`; a conflicting repeat refuses. No finished
turn yields null usage, while an actual reported zero remains zero. Separately,
`eventCostMicrousd` sums every recorded finish event before deduplication, matching
the existing Work receipt's spend semantics. A repeated nonzero turn can make
these two reported totals differ; neither becomes an invoice or credit debit.
The bound
receipt must agree with the completion event, run, personal owner/requester,
objective, model/policy and recorded attention/cost counters. Execution,
assessment and reported publication tier remain separate; the report does not
independently assess work or observe publication. Known counters are provider/host
reports, not invoices or managed account debits. Total incurred cost, provider
quota, account debit, managed credits, native/BYO attribution and other human
supervision remain null. Neither objectives, answers, artifact text, receipt
narration, unresolved-condition text nor credentials are printed. Raw model
references are used only internally for binding and distinct-model counting.
The caller-selected run ID remains metadata from the authenticated task producer.
The current Work receipt route exposes only its completed DONE_UNVERIFIED receipt;
null/missing/unknown verdict on that completion refuses, since canonical v3 allows
null verdict only on WAITING/BLOCKED/FAILED/CANCELLED. Absent receipts produce a
null assessment; this command does not invent support for another receipt route
or claim an actual valid null-verdict terminal journey.

The offline launcher/transport regressions run with
`node vinci/test/runtime-integration.mjs` and in the normal harness against both
source and unpacked unsigned artifacts. Actual Work integration is a separate
`node vinci/test/runtime-work-integration.mjs` test. It requires an explicitly built
Work server root in `VINCI_RUNTIME_WORK_ROOT`, plus the Work fixture's exact
`VINCI_RUN_MODULE`, `VINCI_APPROVAL_MODULE`, `VINCI_RECEIPT_MODULE`, and
`VINCI_PI_FIXTURE` inputs. Follow Work's pinned local-task test guide to construct
those artifacts; the test refuses to invent a replacement service. It exercises
real SQLite/replay/HTTP/Pi paths with a deterministic provider and synthetic local
effect, without claiming live-provider, remote-host or deployment qualification.
That same actual test also exercises reports before any turn, while waiting and
after canonical completion; it persists a repeated turn identity through the
real store and checks that a 5-micro-USD unique-turn estimate remains distinct
from 10 micro-USD of recorded events/receipt spend. The nonzero kinded counters are explicitly synthetic and admitted through the
unchanged canonical store and current lease after a real Pi fixture turn. The
actual historical faux provider reports known zero, which has its own positive
control. These counters do not measure provider billing. Mutations of actual HTTP
responses cover foreign-run replay, sequence/revision gaps, missing/conflicting
usage/tagged-field shape, receipt/attention binding, changing state, event limits and revocation,
each with restored real-boundary positives. Fixture listener and child waits are
bounded; uncertain child/listener cleanup retains the owned evidence root with
an actionable diagnostic rather than treating a wrapper exit as proof. It does not substitute a fabricated
packet server for the successful canonical fixture.
The same entry exercises three fresh correction tasks with exact Unicode feedback,
raw duplicate-field refusal, wrong-action/digest/revision controls, accepted retries
before and after replacement review, changed-command refusal, and stale old approval.
Both original and replacement draft versions remain independently event-bound and
SHA-256 verified through actual export. The replacement requires a separate approval;
these correction journeys add no synthetic external effects.

For a same-store client journey, `vinci/test/runtime-shared-task-conformance.mjs`
attaches read-only to an existing terminal synthetic task through the actual Bash
launcher. Set the same private `VINCI_RUNTIME_CONFIG`, the measured canonical
`VINCI_RUNTIME_SHARED_RUN`, and `VINCI_RUNTIME_SHARED_FIXTURE=local-synthetic-task`.
It checks three reads of the contiguous event sequence, exact receipt/owner/goal
binding and every receipt artifact's actual version and content digest. It prints
metadata and hashes, not task content or credentials. The marker is an operator
assertion for QA, not an authentication or production trust boundary.

After the service owner revokes that same fixture identity, pass `--revoked` and
set `VINCI_RUNTIME_SHARED_ARTIFACT` to a previously measured bound artifact ID.
Inspect, events, receipt and exact export must then refuse current authority in
three trials. This command creates no tasks and issues no decisions or effects;
coordinate the single service owner and preserve separate native/UI evidence.

## Local Runtime SDK

`vinci/scripts/runtime.mjs` also exports `createRuntime(absolutePrivateConfigPath)`.
The CLI uses that same facade for all supported operations. Its adjacent
`runtime.d.mts` declares validated local task/event/spec/result projections;
unprojected producer fields remain `unknown`. The existing unsigned tarball list
includes both adjacent files, so the same relative import resolves local types
from an unpacked artifact. This is a local file import, not a registry package or
public interoperability claim; the package adds no compiler or development SDK.
No agent SDK, provider resources, login, profiles or credential discovery load.

```ts
import { createRuntime, RuntimeError } from "./vinci/scripts/runtime.mjs";

const runtime = await createRuntime(privateConfigPath);
const created = await runtime.create({ saved: true, input: selectedInput, commandId });
const task = await runtime.inspect(created.runId);
const page = await runtime.events(created.runId, { after: 0 });
// Original JSON strings are also accepted and preserved for exact intent/retries.
await runtime.correct(created.runId, originalCorrectionJson);
```

The facade exposes create, inspect, events, questions, approvals, answer, approve,
correct, cancel, receipt, artifact, report and bounded watch. It accepts no owner,
workspace, grants, host or child authority. Creation is admission, not worker
startup. `answer` returns the durable task view containing its replay snapshot; correction returns a
content version. Raw response envelopes and CLI JSON output remain unchanged.
Object specs serialize once; retain the resulting original intent for retries.
Raw JSON strings preserve duplicate fields for service refusal. Approval retains
the exact current preflight; correction retains server-ledger accepted retries
without a fresh-action preflight. Neither retries automatically.

Per-request `signal` and a positive `timeoutMs` of at most 5,000 milliseconds stop
observation. A pre-aborted signal sends no request. `RuntimeError` has sanitized
`code`, `exitCode` and `mutationUnconfirmed`: any dispatched POST refusal,
interrupted request/response or invalid mutation response is conservatively
unconfirmed. An HTTP status does not prove the absence of a persisted command or
partial approval delivery. This flag claims uncertainty, not acceptance. Inspect
current state and reconcile the original command identity and bytes explicitly;
an abort never issues cancellation or proves worker/process death. A successful
cancel response remains a cancellation request, with a separate acknowledgment.

`watch(runId, { after, timeoutMs, signal }, onEvent)` polls the existing authorized
HTTP event pages, with an explicit overall deadline of at most one hour and at
most one request per second. It refuses sequence gaps and repeated event/key
identities; it does not silently sort, skip or resync. Reconnect explicitly from
the last consumed sequence after reconciling current authority. This is bounded
polling, not a new stream or worker-quiescence proof. Artifact reads verify the
selected immutable version, actual SHA-256 and canonical artifact event, and
revalidate unchanged task state/current authority before returning content.

The actual pinned Work integration exercises the facade directly and through the
real Bash CLI. Accepted-but-held response aborts are reconciled with original
bytes against the real canonical store; read aborts preserve task state and send
no cancel. Accepted creates followed by substituted 503/409 responses require
the same explicit reconciliation, while a failed read remains non-mutating.
Declaration examples compile with positive and rejected spec/result types.
The normal `packaged-artifact-check.mjs <unpacked-root>` gate loads the actual
unpacked facade and legacy exports, then uses the source checkout's compiler to
check a strict consumer of that exact artifact import. The real Bash transport
gate also runs against the same unsigned unpacked tree. These checks do not
qualify installed profiles, live providers, devices, remote endpoints or package
publication, signing or updater activation.

## What Would Extend This

A dev *release* channel — signed dev artifacts, a `manifest-dev.json`, a second trust
root, pre-release version grammar — was deliberately left out. Today the channel enum in
the updater is cosmetic and selection is by manifest URL only. If external testers ever
need pre-release builds, that is the work package to open.
