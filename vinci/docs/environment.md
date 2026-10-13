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

## What Would Extend This

A dev *release* channel — signed dev artifacts, a `manifest-dev.json`, a second trust
root, pre-release version grammar — was deliberately left out. Today the channel enum in
the updater is cosmetic and selection is by manifest URL only. If external testers ever
need pre-release builds, that is the work package to open.

## Local Work Task Client

`vinci runtime` uses Work's existing task authority through an explicitly configured
local listener. It does not launch a worker or introduce a hosted orchestration service.
Task enumeration, worker launch/resume, hosted schedules, remote-host admission, merging
and deployment are outside this interface. A successful fixture does not qualify those
features, subscription entitlement, real inference, isolation or useful output.

Set `VINCI_RUNTIME_CONFIG` to an absolute, owned private JSON file containing a loopback
`origin` and exactly one `cookie` or `token`. Group/world access, symlinks, redirects and
remote origins are refused. Obtain the profile from the existing Work owner; do not
copy unrelated credentials or configure a production service by assumption. Running
`vinci runtime --help` requires no profile and lists the supported commands.

Create input is explicit saved text with a stable `commandId`; bounded text/Markdown
attachments carry their SHA-256 digest. Inspect the current snapshot before answering a
scope question or approving/correcting an action. Decisions bind the current question or
approval, exact action digest and revision. The server retains final authority. After
observed cancellation or a terminal snapshot, retained question/approval IDs cannot send
new client decisions. `cancel` requests cancellation; it does not by itself prove that
execution stopped. Observe the host acknowledgement or terminal event separately.

`events` reads a bounded replay page; `watch` requires a timeout. Replay gaps, changed
snapshots and malformed responses require resynchronization. A transport error after a
mutation leaves its outcome unconfirmed. Inspect and reconcile that outcome before
retrying; the client does not automatically replay a mutation.

`receipt` validates the canonical Work receipt's task/scope/event bindings and covered
content digest. This is integrity and binding validation, not an independent assessment
or a signature trust claim. `export` retrieves an exact artifact version and checks its
recorded digest. `report` emits content-free recorded counters, separates missing usage
from recorded zero, and deduplicates canonical turn IDs. Its counters are not invoices:
provider quota, account debit, managed credits and total incurred cost remain unknown.

The local JavaScript facade is `vinci/scripts/runtime.mjs` with declarations in
`runtime.d.mts`. `createRuntime(configPath)` exposes the same bounded operations and
supports request deadlines and abort signals. It does not replace Work's approval,
policy, receipt or worker services. Routine tests use an owned synthetic listener;
Work/shared-task qualification requires separately selected fixtures and fresh positive
controls around each negative.

## Terminal Presentation

Vero uses the original approved artwork from the provenance manifest in `assets/vero/`.
The compact header and composer retain explicit task state and next action. The image
slot has a fixed height as poses change, and the receipt remains the evidence for any
completion or verification claim. Text output, transcripts, `/copy` and exports do not
contain presentation artwork.

Use `VINCI_REDUCED_MOTION=1` for a static indicator. `NO_COLOR`, `TERM=dumb`,
`VINCI_PLAIN=1` and `VINCI_SCREEN_READER=1` disable decorative images and the pulse and
select the plain compact header. `VINCI_ASCII_WORDMARK=1` retains its original font
fallback and suppresses images; it does not imply reduced motion. For plain logs use
the existing noninteractive text mode; JSON/JSONL remain machine output.
