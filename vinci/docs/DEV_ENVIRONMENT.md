# Dev-environment workflow

Internal doc. How to test Vinci Code against the non-production backend, and which testing
lane to use for what. The *mechanics* of `VINCI_ENV=dev` (what it sets, what it isolates,
override precedence) are documented in the README's "Running against a non-production Vinci"
section — this doc covers the workflow around it. The dev box itself (instances, deploys,
secrets) is owned by vinci-chat `docs/DEPLOY.md` — details live there, not here.

## The three testing lanes

| Lane | How | Use for |
|---|---|---|
| Local code → dev backend | `VINCI_ENV=dev vinci` from a checkout | The main development loop: CLI changes, backend-coordinated changes, anything a human should bang on before prod |
| Installed CLI → dev backend | `VINCI_ENV=dev vinci`, or `VINCI_ENV=dev` in `~/.vinci-code.env` to make a machine dev-by-default | Testing closer to what users run, without touching prod data |
| Installed CLI → prod | plain `vinci` | The release artifact and the update path themselves — there is no dev release channel, so these are only testable against prod |

`vinci doctor` is the ground truth for which environment a session is in; interactive
sessions also show the `▲ dev` header badge. If a bug report doesn't say which environment
it came from, get the doctor output before filing.

## First-time setup (once per machine)

Run `/login vinci` inside a `VINCI_ENV=dev` session. Device pairing goes against the dev
Platform instance and the key lands in the isolated dev config dir, so the prod credential
is untouched — after this one login, dev and prod sessions coexist with no further ceremony.
Your account must be on the dev box's signup allowlist (see vinci-chat `docs/DEPLOY.md`).

## Coordinated backend + CLI changes

When a CLI feature needs a gateway or Platform change:

1. Land the backend change on the backend repo's `dev` branch → it deploys to the dev box.
2. Test the CLI against it: `VINCI_ENV=dev vinci` (local checkout of the CLI branch).
3. Promote the backend to `main` (Platform's promotion gate already requires Vinci Code
   compatibility verified on dev first).
4. Merge the CLI side.

Never merge a CLI change that depends on a backend change still sitting on `dev` — prod
users would hit the gap between the two merges.

## What testing on dev does and doesn't cover

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

## What would extend this (not built)

A dev *release* channel — signed dev artifacts, a `manifest-dev.json`, a second trust
root, pre-release version grammar — was deliberately left out. Today the channel enum in
the updater is cosmetic and selection is by manifest URL only. If external testers ever
need pre-release builds, that is the work package to open.
