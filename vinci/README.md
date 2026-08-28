# Vinci Code — the `vinci/` layer

Vinci Code is a **thin fork of Pi** (`badlogic/pi-mono`, MIT). Almost everything Vinci lives
additively in this one `vinci/` directory; the only upstream edits are a few small,
**env-gated** core patches (see [`PATCHES.md`](PATCHES.md)) — so pulling Pi's (frequent)
updates almost never conflicts. See [`UPSTREAM.md`](UPSTREAM.md) for maintenance.

## Project status

**Actively maintained**, by a small team. Practically, that means:

| | |
|---|---|
| Security fixes | latest released version only — there is no LTS branch |
| Issues | read, triaged, and answered honestly, including "not planned" |
| Pull requests | welcome; see [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| API stability | **not guaranteed before 1.0** — settings and extension interfaces may change |
| Upstream | tracks [Pi](https://github.com/badlogic/pi-mono) closely; expect frequent rebases |

Two things stated up front rather than discovered:

- **You do not need a Vinci account.** Run it, `/login`, pick any provider Pi supports and use
  your own key. The guard, receipts, checkpoints and review all work identically. Signing in to
  Vinci is offered, never required — `VINCI_SHOW_OTHER_PROVIDERS=0` restores the managed-only view. See [`PRIVACY.md`](PRIVACY.md) for exactly
  what changes between the two modes — in BYOK, Vinci's servers are not in the path.
- **Recognised secrets in normal prompts and tool results are masked before the session
  transcript is written.** The `!` shell shortcut is recorded outside those hooks, and large
  bash output can spill raw to `$TMPDIR/pi-bash-*.log` before masking runs. Unrecognised formats
  also persist verbatim. Treat both `~/.pi/agent/sessions/` and those temporary files as sensitive.

Security reports: [`../SECURITY.md`](../SECURITY.md).

## Install

One command, no clone, no build (needs Node v22.19+):

```sh
curl -fsSL https://vinci.getsimpledirect.com/install | sh
```

That installs a stable updater plus a signed, versioned payload with atomic activation; later
signed releases install themselves before the next task. No version is named here on purpose —
this line once said `0.0.20` through five shipped releases. `vinci --version` is authoritative.

**From source** (contributors, and anyone who would rather read what they run):

```sh
npm install && bash vinci/build.sh
./vinci/bin/vinci
```

Then `/login` — it offers every provider Pi supports, plus Vinci. Use your own key and no
account is required; sign in to Vinci if you want managed inference. See
[`PRIVACY.md`](PRIVACY.md) for exactly what differs between the two.


## Releasing (increment slowly)

Vinci Code has its **own** version, separate from the underlying Pi version. To cut a release:

1. **Bump the version** — `version` in [`identity.json`](identity.json) and `VINCI_VERSION` in
   [`extensions/vinci-header.ts`](extensions/vinci-header.ts). The identity test requires equality.
2. **Verify** — `bash vinci/test/run.sh` must be green.
3. **Commit + tag** — tag with the **`vinci-` prefix** (its own namespace — a bare `vX.Y.Z`
   collides with Pi's ~300 mirrored tags):
   ```sh
   git tag -a vinci-vX.Y.Z -m "Vinci Code X.Y.Z"
   git push origin main && git push origin vinci-vX.Y.Z
   gh release create vinci-vX.Y.Z --title "Vinci Code X.Y.Z" --notes "…"
   ```

> **Signing happens elsewhere, on purpose.** Signed release artifacts are produced by a workflow
> in Vinci's internal repository, which holds the only AWS OIDC trust permitted to read the
> update-signing key. That path is deliberately NOT reproduced here: a second signing path is a
> second thing to compromise. This repository publishes source and release notes; the signed
> `.tgz` and manifest that `curl … /install` consumes are produced and verified internally, then
> mirrored here with identical bytes and checksums. Release signing is documented in the internal
> ops repository.

`main` is a protected, fast-forward-only mirror of upstream Pi — **never merge `vinci` → `main`**
(see [Branch model & syncing](#branch-model--syncing-with-upstream-pi) below).

## Layout

| Path | What |
|---|---|
| `themes/vinci-{dark,light}.json` | Brand palette as Pi themes (all 51 tokens) |
| `identity.json` | Canonical Vinci app/provider/model/theme/extension contract, enforced after upstream syncs |
| `updater/` | Stable signed-manifest updater, public trust root, atomic version activation, and rollback launcher |
| `extensions/vinci-provider.ts` | Managed Vinci gateway (`/api/v1`) + `/login vinci` device pairing. The product contract is the stable `forte` frontier class, initially GLM 5.2 on approved DeepInfra. The picker exposes only Forte; the direct DeepInfra lane is internal qualification only |
| `extensions/vinci-shell.ts` | Vinci-owned framed composer and status shell — a spacious raised input surface with breathing room above it, one slow `· → • → ● → •` pulse, semantic phase copy, honest connection state, Auto/Plan, model, project/branch, and context orientation |
| `extensions/vinci-character.ts` | Coding behavior — own the user's goal, explore freely, use a high permission bar, **narrate every step in plain language**, and finish the task |
| `extensions/vinci-memory.ts` | Transparent project memory — `remember` tool + `/memory`, local `.vinci/memory.md` |
| `extensions/vinci-search.ts` | **Web access** (4 grounding tools) — `web_search` (Brave/gateway, cite URLs) · `web_fetch` (read a page's real content; SSRF-guarded) · `web_answer` (Brave Answers: distilled cited answer) · `library_docs` (Context7: current version-specific framework/library docs) — so a small model grounds answers instead of guessing from stale snippets |
| `extensions/vinci-header.ts` | Compact everyday welcome with Vinci identity, model/project, honest auth state, `/undo`, and help; optional image/braille hero through `VINCI_HERO_HEADER=1` |
| `extensions/vinci-council.ts` | **Council** — `convene_council` tool + `/council` (multi-angle; stronger-model chair) |
| `extensions/vinci-advisor.ts` | **Advisor** — `advisor` tool: quick single second opinion from the strongest tier |
| `extensions/vinci-orchestrate.ts` | **Orchestrator** — `orchestrate` tool + `/orchestrate` (decompose→work→review→synthesize) |
| `extensions/vinci-crew.ts` | **Agents** (multi-agent) — `spawn_helper` + `/agents` (`/helpers` still works as an alias): each child inherits the active Vinci model and works from an isolated snapshot worktree. Verified ordinary patches auto-integrate after exact-check replay and independent review; stale, risky, conflicting, or unverified patches become `WAITING`. Capacity is operational, never plan-tier gated. See `AGENTS_PLAN.md` |
| `extensions/vinci-review.ts` | **Grader/Outcomes** — `review_changes` tool + `/review` |
| `extensions/vinci-todo.ts` | Stateful plan widget — progress, current step, and next step stay above the composer; approved work auto-continues unless Vinci has a real question; a repeated failed independent review pauses further mutations instead of reopening forever; `/todos` shows full detail |
| `extensions/vinci-guard.ts` | Safety hook — blocks catastrophic commands and shell-based file writes; confirms destructive actions, **database schema changes/resets**, wholesale file overwrites that lose content, **reaches-the-real-world** actions, system changes, committing secrets, and protected-path writes |
| `extensions/vinci-scope.ts` | Scope guardian — pauses Auto mode on consequential out-of-scope drift with Go-ahead / Skip / Explain: deletes, dependency/config changes, a lenient **LLM "is this in scope?" judge**, and broad-refactor volume. Its `ask_user` tool is reserved for material, destructive, external, costly, or sensitive decisions—not routine exploration |
| `extensions/vinci-loopbreak.ts` | **Loop defense** — the fixation ladder (nudge → stronger teammate → stop-and-report) over identical repeats incl. edits/writes/meta-tools, carrying across bare-"continue" turns; narration may reset the consecutive exploration streak but never the absolute per-turn action ceiling; invalid-call + truncated-write coaches; and a validated turn-stop (kill switch `VINCI_NO_TURNSTOP=1`) |
| `extensions/vinci-undo.ts` | Safety net — per-turn file checkpoints + `/undo` (no git needed) |
| `extensions/vinci-checkpoint.ts` | Durable task recovery — the session UUID is the task ID; write/edit/bash calls receive started/completed checkpoints, interrupted file state is inspected on resume, and exact completed or unsafe side effects are never blindly replayed; `/task-info` shows the resume command |
| `extensions/vinci-preview.ts` | **`/preview`** — opens what Vinci built: a static site in the browser, or starts the app's dev server + opens the local URL (so a non-programmer can actually *see* the result) |
| `extensions/vinci-receipt.ts` | Durable task handoff — explicit `DONE`, `DONE-UNVERIFIED`, `WAITING`, or `BLOCKED`; changed files, verifier-owned evidence, `/undo`, active duration, and a session-local model-call/token/cache/cost meter. `/usage` shows the same record and points to the Vinci app for authoritative account credits |
| `extensions/vinci-render.ts` | Friendly activity display — semantic action headers, outcome-first collapsed results, burst folding, and secret masking on expanded output |
| `extensions/vinci-compact.ts` | Calm compaction UX (reframe + "caught up, here's what I kept" resume) |
| `extensions/vinci-copy.ts` | Clipboard helper — `/copy` or Alt+C opens Vinci's last message, last code block, and last tool output without terminal text selection |
| `APPEND_SYSTEM.md` | Character pack (reinforcement; the gateway injects it server-side too) |
| `assets/` · `BRAND.md` | Brandmark + wordmark + palette (SVG) · palette hex |
| `bin/vinci` | Launcher — Pi + the brand layer + extensions via flags |
| `sync-upstream.sh` · `UPSTREAM.md` | Pull Pi maintenance updates (ff main, rebase vinci) |
| `PATCHES.md` | The inventoried env-gated core patches — login/model/UX, small-model truth-telling, private controls, auto-continue, de-groove, and tight box-less rendering |
| `AUTH_PAIRING_PLAN.md` | The "Connect to Vinci" pairing design (shipped + deployed) |

## Features

- **Talks as it works** — narration is Vinci's #1 rule: one plain sentence before each step,
  findings as it goes, and periodic current/next check-ins. The composer pairs a slow pulse with the
  real phase—Contemplating, Looking, Considering, Making changes, Checking, or Reviewing—and elapsed
  time; a mechanical nudge fires if it goes quiet. Built for people who can't read code or tool logs.
- **Keeps going after approval** — an unfinished live plan continues through progress updates
  without asking the user to type "continue". Vinci pauses only for a specific question, an error,
  or a bounded stuck-state recovery.
- **Finishes planning too** — read-only Plan mode keeps inspecting after progress updates until Vinci
  presents the plan or reaches a real material question; planning no longer requires typed nudges.
- **Explores without nagging** — read-only investigation, local verification, reversible in-scope
  edits, and ordinary implementation choices proceed without permission prompts. Generic "want me
  to keep looking?" questions are turned back into progress; consequential decisions still pause.
- **A calm screen** — no background panels; color only on what changed (GitHub-style diff row
  tints); tool-call bursts fold to one header + quiet `·` lines; results say what they mean
  ("found 12 matches", not "12 lines").
- **Loops die fast** — layered defense (see `vinci-loopbreak.ts` + PATCHES §15/§19/§20): failures
  look like failures on the wire, identical repeats climb an escalation ladder, the model never
  re-reads its own loops (even after resume), narration cannot replenish the absolute action ceiling,
  an exploration-limit steer is queued only once, and a repeated failed review freezes mutations
  instead of starting another repair cycle.
- **Interrupted work resumes safely** — `vinci resume <task-id>` reopens Pi's durable JSONL session.
  Vinci records mutation checkpoints around write/edit/bash execution, proves landed file changes from
  current state, and refuses to blindly replay an interrupted shell command. `/task-info` shows the
  current task ID and recovery status.
- **Finishes with an explicit state and meter** — changed work ends as `DONE` only with the required
  direct verification, `DONE-UNVERIFIED` when code changed without it, `WAITING` for a named user
  decision, or `BLOCKED` with the concrete reason. The durable task record includes model calls,
  active duration, input/output/cache tokens, provider/model provenance, and a clearly labeled local
  cost estimate. `/usage` shows it again; `vinci report-wrong <task-id>` records a false completion
  locally; Account → Usage in a Vinci app remains authoritative for account credits.
- **Unattended mode** — in `vinci -p` (no TTY) the harness never asks for an instruction nobody can
  give: the no-progress latch ends the task as `BLOCKED` with an unattended-stop reason, any such
  hard stop outranks a closing "done" in the task record, and local `git add`/`git commit`/`git
  status`/`git diff` are exempt from the action reserve because the commit is the deliverable
  (`git push`, `gh`, and network commands are not — the daemon publishes). See
  `docs/verification.md` → "Unattended mode".
- **Vinci Council** — for a hard decision, weighs it from 4 independent lenses in parallel,
  then combines them (agree/disagree/confidence). Automatic (the model calls
  `convene_council`) or manual (`/council <question>`).
- **Grader / self-review** — an independent reviewer grades the **real git diff** against the
  task: concrete problems + a verdict. Completion claims are reviewed automatically; `/review`
  remains available for an explicit manual review.
- **Safety guard** — hard-blocks catastrophic shell commands (`rm -rf /`, fork bomb, `dd` to
  disk, force-push to main), routes file-content changes through structured tools, and asks before
  applying database migrations or other consequential actions.
- **Project brain** — Pi natively reads a project-root `AGENTS.md` (or `CLAUDE.md`): put your
  architecture, conventions, and "never do X" there and Vinci reads it every session.
- **Login without pasting a key** — `/login vinci` pairs in the browser. `/login` and `/model`
  also offer every provider Pi supports, with Vinci's own classes listed first.

## Run it

```bash
# 1. Build once from the REPO ROOT. vinci/build.sh compiles tui→ai→agent→coding-agent WITHOUT
#    re-fetching the ~1000 external model catalogs the stock `npm run build` pulls each time
#    — so it's network-free, faster, and leaves no git drift.
npm install && bash vinci/build.sh

# 2. Launch branded (clears the screen so the welcome opens at the top)
vinci/bin/vinci

# 3. Connect (first run) — no API key to paste:
#    /login vinci  → opens platform.getsimpledirect.com/device, authorize with one click.

# Resume an interrupted task using the ID from /task-info or the exit receipt:
vinci resume <task-id>

# Record a false completion locally without another model or network call:
vinci report-wrong <task-id> "optional note"
```

The `/login vinci` device-pairing flow (RFC 8628) is in `extensions/vinci-provider.ts` —
it opens the browser, you authorize, and the CLI gets its own revocable key (managed in
`~/.pi/agent/`). No key to copy. `VINCI_API_KEY` still works as a CI/fallback escape hatch.
Backend: vinci-chat `device_pairings` (#91) + vinci-platform `/api/device/*` (#2) — **must
be deployed for `/login` to work.** Symlink `vinci/bin/vinci` onto your PATH as `vinci`.

### Running against a non-prod Vinci (internal)

`VINCI_ENV=dev` is the supported one-variable way to run against the Chat+Platform dev box:

```bash
VINCI_ENV=dev vinci        # or put VINCI_ENV=dev in ~/.vinci-code.env
```

It resolves in the launcher (after `~/.vinci-code.env` is sourced) and sets, **only where you
have not already set them yourself** — an explicitly exported variable always wins:

- `VINCI_BASE_URL` → the dev gateway, `VINCI_PLATFORM_URL` → the dev platform;
- `VINCI_CODING_AGENT_DIR=~/.pi-dev/agent` — dev credentials and sessions are ISOLATED from the
  prod slot: `~/.pi/agent/auth.json` has one slot per provider, so a dev `/login` would
  otherwise overwrite your prod credential;
- `VINCI_UPDATE_DISABLED=1` — auto-update is off in dev mode (there is no dev update channel,
  and a dev session must never touch prod update state).

The header shows a warning-colored environment badge whenever a session is not on the prod
gateway, and `vinci doctor` prints the effective environment, gateway/platform URLs, and agent
config dir. Any other `VINCI_ENV` value is rejected at launch. Fine-grained overrides
(`VINCI_BASE_URL=…` / `VINCI_PLATFORM_URL=…` alone) still work, but manage none of the
isolation above — prefer `VINCI_ENV=dev`.

Note for EXISTING installs: the no-auto-update guarantee is enforced by the installed updater,
and a bootstrap older than 0.0.42 predates the dev gate — so the very first dev launch on such
an install may still run one prod update check before the self-heal refreshes the bootstrap.
The guarantee holds from the first completed update cycle onward.

Vinci Code works with your own provider key or with Vinci's managed service. When you supply your
own, the credential is stored on your machine by the underlying agent (`~/.pi/agent/auth.json`) and
sent only to the provider you chose — never to Vinci. There is no in-app local-model runtime; users
may run local-model tooling independently.

## Privacy and security

Vinci does not bundle or upload a repository or its Git history. Where prompts and attached content
go depends on the provider you picked: to that provider directly if it is your own, or to Vinci's
managed services if you signed in to Vinci. In managed mode images go to Vinci Vision and the
text-only Forte model receives a visual-evidence description rather than the raw image.

Detected credentials are redacted before they reach the terminal, edit diffs, write previews, and
the `/feedback` and `/issue` payloads that leave your machine.

Redaction also runs *before* the session transcript is written for normal prompt input and tool
results. `vinci-guard` transforms prompt text at the `input` boundary, masks tool results — files
read and shell-tool output alike — at the hook its own comment calls the "persistence/model
boundary", and redacts the provider request as a last line of defence. Measured on 0.0.49: a
synthetic key typed into the prompt, one read via the `read` tool, and one printed by the `bash`
tool were each absent from the stored session, with `<vinci-secret>` in their place.

> 🔴 **Not every local persistence path crosses those hooks.** Output from the `!` shell shortcut
> is recorded directly in the session JSONL, and large `bash` outputs can spill unmasked to
> `$TMPDIR/pi-bash-*.log` before the tool-result hook runs. Credentials whose formats the patterns
> do not recognise and sessions recorded before these hooks existed may also remain verbatim.
> Treat both locations as sensitive and delete records you no longer need.

Shell network access and credential reads require approval for one exact invocation. Run
`/security` to inspect the active controls. `VINCI_NO_SANDBOX=1` is a developer bypass and weakens
these guarantees.

## Test it

```bash
bash vinci/test/run.sh
```

- **UNIT** (`vinci/test/units.mjs`) — pure logic in the extensions/patches (grader parse, escalation
  ladder, undo round-trip, guard path patterns, memory). Fast, offline. Also runs in CI on every
  push/PR to `vinci` (`.github/workflows/vinci-tests.yml`).
- **UI** (`vinci/test/ui/`) — boots the real interactive mode with the faux model and xterm-backed
  virtual terminal, sends real key sequences, resizes the terminal, and runs 30 critical journeys
  with reviewed plain-text viewport snapshots for visual cases. No login, network, tmux, or model cost.
- **IDENTITY** (`vinci/identity.json`) — the canonical Vinci name/provider/model/extension contract.
  Both CI and `sync-upstream.sh` fail if an upstream rebase drops or replaces part of the product.
- **UPDATES** (`vinci/test/update-integration.mjs`) — signed install, automatic activation, mandatory
  failure, manual and remote rollback, signature rejection, and installation health checks.
- **CHECKPOINT/RESUME** — focused state tests plus a real `SIGKILL` child-process lane stop after a
  write lands but before its tool result, resume by task ID, and assert that contents and nanosecond
  modification time do not change.
- **TASK OUTCOME/METER** — focused and terminal-UI tests prove verifier failures become `BLOCKED`,
  unverified code cannot become `DONE`, provider errors remain actionable, usage totals survive in a
  non-context session entry, `/usage` identifies the authoritative account-credit surface, and
  false-completion reports are local, durable, and idempotent.
- **SEALED REPOSITORY CORPUS** — immutable public-repository fixtures remove accepted fixes, erase
  the accepted Git history, independently rerun focused verification, enforce changed-file bounds,
  and score correctness, closure, action efficiency, errors, latency, cache, and cost separately.
  The seven coding fixtures span Node.js, TypeScript, Go, and Python. Scored runs disable web tools,
  retain raw evidence privately, and expose only redacted metrics. Stock Codex and Claude Code
  adapters normalize the same metrics; repeated coding baselines remain required.
- **VISUAL** — one native PTY packaging smoke check confirms the built CLI still renders its header
  and footer. It is intentionally thin; interaction coverage lives in the deterministic UI suite.
- **SMOKE** — runs the real CLI headlessly (`pi -p`, which auto-activates with no TTY): proves every
  extension + core patch **loads**, auth/gateway works, the agent responds, and **tools fire** end
  to end. Needs a Vinci login; makes ~2 gateway calls; skipped (not failed) if not signed in.

**Run `bash vinci/test/run.sh` before finishing/merging a change.** Manual release review is now
limited to subjective aesthetics, animation feel, and terminal-specific image rendering.

## Branch model & syncing with upstream Pi

Vinci Code is a **thin fork** of Pi. The branch model is what keeps it easy to pull Pi's updates
without disturbing the Vinci layer:

- `main` — **pristine**, tracks upstream Pi (`badlogic/pi-mono`). Never commit Vinci work here; its
  only job is to be a clean mirror we can fast-forward.
- `vinci` — **the trunk** (the released code; the installer builds from it). This is where all Vinci
  work lives, rebased on top of `main` on each sync.

**Golden rule: `vinci` is the trunk — never merge `vinci` → `main`.** That would put the whole layer
on `main` and permanently break the fast-forward-main / rebase-vinci flow. `main` is protected on
GitHub (linear history, no force-push, no deletions) to enforce this. For a stable release pointer,
tag a commit on `vinci` with the `vinci-` prefix (`git tag vinci-X.Y.Z`) — its own namespace, distinct
from Pi's `vX.Y.Z` tags, and tags survive the rebase force-push.

### How to sync (pull the latest Pi)

```bash
vinci/sync-upstream.sh            # → latest upstream/main
vinci/sync-upstream.sh v0.81.0    # → a specific Pi release tag (recommended: pin releases)
```

It enables `git rerere`, fast-forwards `main` to Pi, rebases `vinci` on top, verifies the canonical
identity contract, and prints a completeness check. Then:
`bash vinci/test/run.sh && git push --force-with-lease origin vinci`.

**Why this stays conflict-free:** ~everything Vinci is *additive* (the `vinci/` dir + new
`packages/**/vinci-*.ts` files) — additive files never conflict. The only conflict surface is a small
set of inline, env-gated core edits, each tagged `[vinci]` and inventoried in
[`PATCHES.md`](PATCHES.md). `git grep -n '\[vinci\]' -- packages/` lists them all; `rerere` remembers
each resolution so you never redo it. Full details + the recovery steps: [`UPSTREAM.md`](UPSTREAM.md).

## Status

The current working tree has the truthfulness, checkpoint/resume, outcome/meter, model-provenance,
source-ownership, Crew reconciliation, and sealed-comparator slices. `npm run check` and the complete
offline harness pass, including 365 units, 30 UI scenarios, real SIGKILL recovery, and native PTY
rendering.

The product target is **Vinci Forte**, initially GLM 5.2 on DeepInfra with confirmed ZDR approval.
The CLI requests the stable `forte` class and records requested/resolved provenance and route drift.
The remaining serving work is signed resolution metadata, complete capability/cost headers, repeated
production qualification, and a checked-in promotion/rollback gate. Do not replace that with BYOK, an
in-app local runtime, a per-task dollar cap, plan-based concurrency, or a paid priority lane.

Current quality evidence is strong but not complete. All ten pinned scenarios and seven reverse
patches pass inventory validation, but the five-repetition production campaign has not run. The
tracked launch report remains `not-qualified` until all Vinci outcomes pass and the secondary Codex
and Claude Code comparison evidence is aggregated.
