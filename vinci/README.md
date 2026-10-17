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
npm ci --ignore-scripts && bash vinci/build.sh
./vinci/bin/vinci
```

Then `/login` — it offers every provider Pi supports, plus Vinci. Use your own key and no
account is required; sign in to Vinci if you want managed inference. See
[`PRIVACY.md`](PRIVACY.md) for exactly what differs between the two.


## Releasing (increment slowly)

Vinci Code has its **own** version, separate from the underlying Pi version. To cut a release:

1. **Bump the product version** in [`identity.json`](identity.json). The header and packaged
   launcher read this authority; root and Pi package versions remain separate namespaces.
2. **Regenerate and review the UI snapshots**, add the matching release note, and run
   `npm run check` plus `VINCI_SKIP_SMOKE=1 bash vinci/test/run.sh`. The packaged checks unpack
   the exact archive and run its real launcher with a local faux provider outside the checkout.
   These offline checks do not establish live-provider usefulness or production activation.
3. **After review and explicit release authorization**, merge to public `main`, annotate that
   reviewed commit with the protected `vinci-vX.Y.Z` tag, and push the tag. Tags are immutable.

[`../.github/workflows/vinci-release.yml`](../.github/workflows/vinci-release.yml) in
`getsimpledirect/vinci-code-cli` is the sole release publisher. It checks tag/identity agreement,
builds and packages, tests those bytes, and carries that same archive to the protected publish
job. Publish signs it, writes the immutable artifact once, verifies the staged hash, activates
the signed manifest last, and verifies its read-back before creating the GitHub release.
Signing trust and key operations stay in the private operations home; they are not copied here.

[`../.github/workflows/vinci-rollback.yml`](../.github/workflows/vinci-rollback.yml) reuses an
existing immutable archive after checking its signed historical release receipt. It activates
a newly signed manifest with a higher sequence and ETag compare-and-swap. It never moves a tag
or rewrites the archive. Dispatching either workflow requires its own authorization.

## Layout

| Path | What |
|---|---|
| `themes/vinci-{dark,light}.json` | Brand palette as Pi themes (all 51 tokens) |
| `identity.json` | Canonical Vinci app/provider/model/theme/extension contract, enforced after upstream syncs |
| `updater/` | Stable signed-manifest updater, public trust root, atomic version activation, and rollback launcher |
| `extensions/vinci-provider.ts` | Managed Vinci gateway (`/api/v1`) + `/login` device pairing for Vinci. The product contract is the stable `forte` frontier class, initially GLM 5.2 on approved DeepInfra. The picker exposes only Forte; the direct DeepInfra lane is internal qualification only |
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
| `extensions/vinci-undo.ts` | Safety net — per-agent-step file checkpoints + `/undo` (no git needed) |
| `extensions/vinci-checkpoint.ts` | Durable task recovery — the session UUID is the task ID; write/edit/bash calls receive started/completed checkpoints, interrupted file state is inspected on resume, and exact completed or unsafe side effects are never blindly replayed; `/task-info` shows the resume command |
| `extensions/vinci-preview.ts` | **`/preview`** — opens what Vinci built: a static site in the browser, or starts the app's dev server + opens the local URL (so a non-programmer can actually *see* the result) |
| `extensions/vinci-receipt.ts` | Durable task handoff — explicit `DONE`, `DONE-UNVERIFIED`, `WAITING`, or `BLOCKED`; changed files, verifier-owned evidence, `/undo`, active duration, and a session-local model-call/token/cache/cost meter. `/usage` shows the same record and points to the Vinci app for authoritative account credits |
| `extensions/vinci-render.ts` | Friendly activity display — semantic action headers, outcome-first collapsed results, burst folding, and secret masking on expanded output |
| `extensions/vinci-compact.ts` | Calm compaction UX (reframe + "caught up, here's what I kept" resume) |
| `extensions/vinci-copy.ts` | Clipboard helper — `/copy` or Alt+C opens Vinci's last message, last code block, and last tool output without terminal text selection |
| `APPEND_SYSTEM.md` | Character pack (reinforcement; the gateway injects it server-side too) |
| `assets/` · `BRAND.md` | Brandmark + wordmark + palette (SVG) · palette hex |
| `bin/vinci` | Launcher — Pi + the brand layer + extensions via flags |
| `sync-upstream.sh` · `UPSTREAM.md` | Preserved private mirror/rebase maintenance workflow; unsupported on public product `main` until adapted |
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
  any harness refusal of a commit is a hard stop that outranks a closing "done" (or a remote pass)
  in the task record, and local `git add`/`git commit`/`git status`/`git diff` pass the action
  reserve, the action ceiling, and the latch because the commit is the deliverable (`git push`,
  `gh`, and network commands do not — the daemon publishes). See
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
- **Login without pasting a key** — `/login` opens Vinci browser pairing directly in the
  managed-default view. With other providers enabled, choose an authentication method, then
  a provider; choose "Use a subscription", then Vinci to pair in the browser.

## Before your first task

Choose the provider and authentication method in `/login` before starting work. Vinci browser
pairing uses Vinci's managed account. With your own provider enabled, choose its supported login or
API key explicitly and check which account will be charged.

- **OpenAI:** the supported ChatGPT/Codex sign-in and an OpenAI API key are separate billing
  choices. API-key usage is billed through the API Platform rather than your ChatGPT subscription;
  a subscription does not promise access to every third-party client or model. See
  [OpenAI authentication guidance](https://learn.chatgpt.com/docs/auth).
- **Anthropic:** use a Claude Console API key or a supported cloud-provider route for third-party
  tools. Do not assume a Claude subscription authorizes an arbitrary client. Anthropic also warns
  that `ANTHROPIC_API_KEY` takes precedence over subscription login in Claude Code and incurs API
  charges; check exported keys before choosing that route. See
  [Anthropic third-party authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
  and [Claude Code subscription/key precedence](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).

The task meter is a local estimate. Missing price or usage data means **unknown**, not zero; it is
not an account balance, a capacity promise, or a per-task spending cap. The provider's billing
surface, or Account → Usage for Vinci's managed service, remains authoritative.

For an installed copy, run `vinci doctor` to inspect the selected environment; `vinci update` and
`vinci rollback` use the signed update flow. Open a shell in the project you intend to change, then
launch `vinci`. Start with a bounded request such as "Fix this failing test, run its focused check,
and report the changed files." `/agents` opens helper status and reviewed changes.

Press **Escape** to abort active work. Use `/task-info` to record the task ID, then
`vinci resume <task-id>` to reopen an interrupted task. Ctrl+C clears the editor; pressing it twice
quits. Read the final receipt: `DONE` requires the required verification, `DONE-UNVERIFIED` records
unverified changes, `WAITING` names a needed decision, and `BLOCKED` gives the stopping reason.

## Run it

```bash
# 1. Build once from the REPO ROOT. vinci/build.sh compiles tui→ai→agent→coding-agent WITHOUT
#    re-fetching the ~1000 external model catalogs the stock `npm run build` pulls each time
#    — so it's network-free, faster, and leaves no git drift.
npm ci --ignore-scripts && bash vinci/build.sh

# 2. Launch branded (clears the screen so the welcome opens at the top)
vinci/bin/vinci

# 3. Connect (first run) — no API key to paste:
#    /login  → opens Vinci pairing directly in the managed-default view.
#    With other providers enabled, choose "Use a subscription", then Vinci.

# Resume an interrupted task using the ID from /task-info or the exit receipt:
vinci resume <task-id>

# Record a false completion locally without another model or network call:
vinci report-wrong <task-id> "optional note"
```

The Vinci device-pairing flow reached through `/login` (RFC 8628) is in `extensions/vinci-provider.ts` —
it opens the browser, you authorize, and the CLI gets its own revocable key (managed in
`~/.pi/agent/`). No key to copy. `VINCI_API_KEY` still works as a CI/fallback escape hatch.
Backend: vinci-chat `device_pairings` (#91) + vinci-platform `/api/device/*` (#2) — **must
be deployed for `/login` to work.** Symlink `vinci/bin/vinci` onto your PATH as `vinci`.

### Fullscreen (opt-in)

Regular mode remains the default. Start fullscreen with `vinci --tui-mode fullscreen`, or set
`"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project settings take precedence). Turn it off with the fullscreen `/settings` TUI mode row,
`vinci --tui-mode regular`, or by removing `tuiMode` from the settings files. A mode change in
`/settings` takes effect on the next start; the current screen does not switch.

Selecting text copies it to your clipboard. Use Shift+drag (Option+drag in iTerm2 and Terminal.app) to select without copying.

Turn automatic copying off with `"copyOnSelect": false` in settings or `VINCI_COPY_ON_SELECT=0 vinci`.

`VINCI_COPY_ON_SELECT=0` turns copy-on-select off only when you start Vinci with the `vinci` command. The `copyOnSelect` setting works however Vinci is started.

The fullscreen `/settings` copy-on-select row changes this setting immediately. When the environment
switch is `0`, the row reads `Off (VINCI_COPY_ON_SELECT=0)` and is read-only. Ctrl+X copies the
current selection even when automatic copying is off; with no selection it does nothing.

If Vinci is force-quit or your connection drops while in fullscreen mode, run `reset` to restore your terminal.

In fullscreen mode, if Vinci crashes or you suspend it with Ctrl+Z, the conversation is not printed to your terminal's scrollback; your session is still saved.

Scroll with the mouse wheel, Shift+PageUp/PageDown, or Ctrl+Home/End. Some terminals use these keys themselves; if they don't scroll Vinci, use the mouse wheel.

Device QA for these fullscreen controls, native Shift/Option-drag bypass, recovery and scroll keys:
**NOT_RUN** on Terminal.app, iTerm2, Ghostty, kitty, WezTerm and tmux. These instructions do not
establish compatibility with those terminals or whether Shift+PageUp/PageDown reaches Vinci.

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

### Local Work task client

`vinci runtime --help` exposes an explicitly configured local Work task client. Its
`VINCI_RUNTIME_CONFIG` must name an owned, mode-0600 JSON file containing the selected numeric
loopback origin and separately authorized Work task credential. It discovers no credentials
and does not borrow an inference key or a subscription login.

It can create an admitted saved task, inspect authorized state and replay, answer questions,
approve or correct an exact reviewed action, read receipts and selected artifacts, watch with
a deadline, report bounded metadata, and request cancellation. Use `--spec <file>` or
`--spec -` to keep task content and exact intent off the command line. Creation does not launch
a worker, and cancellation does not prove termination. Transport uncertainty requires explicit
reconciliation of the original command; mutations are never automatically retried.

Task listing, worker launch or resume, hosted schedules, publication, merging, and deployment
are outside this interface. The local fixture and faux-provider checks qualify this client
boundary; they do not establish Runtime deployment, subscription entitlement, real inference,
or a useful completed task. See [`docs/environment.md`](docs/environment.md).

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
tool were each absent from the stored session, with a placeholder in their place.

Since 0.0.53 the two cases carry *different* placeholders, because they are different objects. A
secret Vinci obtained by **reading** something becomes a bare `<vinci-secret>` that nothing can
turn back into a value. A secret **you typed** becomes a session-scoped handle,
`<vinci-secret-a1b2c3d4>`, that the shell — and only the shell — substitutes the real value for at
the moment a command runs, so a credential you deliberately supply still works. The model never
sees either value, and the handle rather than the value is what reaches the transcript. See
[`docs/secrets.md`](docs/secrets.md).

> 🔴 **Not every local persistence path crosses those hooks.** Output from the `!` shell shortcut
> is recorded directly in the session JSONL, and large `bash` outputs can spill unmasked to
> `$TMPDIR/pi-bash-*.log` before the tool-result hook runs. Credentials whose formats the patterns
> do not recognise and sessions recorded before these hooks existed may also remain verbatim.
> Treat both locations as sensitive and delete records you no longer need.

Shell network access and credential reads require approval for one exact invocation. Run
`/security` to inspect the active controls. `VINCI_NO_SANDBOX=1` is a developer bypass and weakens
these guarantees.

Local Bash, write and edit operations use an OS sandbox. Its default writable scope is the project,
narrow build caches and private temporary space; HOME, sibling projects and `/Volumes` are not
implicit grants. Cross-project edits ask for one specific directory. `/allow-directory <path>` grants
that directory for the session; `/allow-file <path>` permits one deliberate file edit, including a
protected startup or credential file. `/deny-writes` clears additional session grants, and a new
session also clears them. Running commands retain the permissions they started with. Launchers can
set `VINCI_SANDBOX_WRITE_ROOTS` or `VINCI_SANDBOX_WRITE_FILES` to JSON arrays of explicit absolute
paths; these configured grants survive the session reset. The filesystem root cannot be granted.

Directory grants leave startup and credential files independently protected. Cloud commands can
receive operational configuration/cache writes as part of their exact invocation approval. On Linux,
Bubblewrap refuses a broad directory grant if it contains an absent protected path, and an exact
file grant requires an existing file. Choose a narrower directory or prepare that file yourself.
Read-locked credential files also require a read grant for a Linux shell to access them. These limits
are enforced rather than silently widening the scope. Custom shell startup runs inside the native
wrapper; ambient shell hooks and grant-signing material are removed from local child environments.
Trusted extensions and explicitly supplied custom operations remain privileged code. The shell
classifier is a heuristic, and local IPC/loopback access can reach services that relay traffic; the
network policy is not a complete exfiltration boundary.

## Test it

```bash
bash vinci/test/run.sh
```

- **UNIT** (`vinci/test/units.mjs`) — pure logic in the extensions/patches (grader parse, escalation
  ladder, undo round-trip, guard path patterns, memory). Fast, offline. Also runs in CI on every
  push/PR to public `main` (`.github/workflows/vinci-tests.yml`).
- **UI** (`vinci/test/ui/`) — boots the real interactive mode with the faux model and xterm-backed
  virtual terminal, sends real key sequences, resizes the terminal, and runs deterministic journeys
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

**Run `VINCI_SKIP_SMOKE=1 bash vinci/test/run.sh` before finishing/merging a change.** Keep the
offline controls separate from authorized real-provider usefulness, installed-client recovery,
production release activation, and terminal-specific artwork review.

## Branch model & syncing with upstream Pi

The active product source is `getsimpledirect/vinci-code-cli/main`. Product changes and release
tags belong to its reviewed public lineage. Preserve public security fixes when reconciling
private patches; never merge private history or overwrite the public tree with an old export.

The retained private repository has a different legacy branch model:
its `main` mirrors upstream Pi and `vinci` carries the private product layer. Its operational
history and unresolved work remain private until their disposition is complete. This distinction
does not claim that consolidation or archival has finished.

### How to sync (pull the latest Pi)

`vinci/sync-upstream.sh` is preserved for that legacy private mirror/rebase workflow. It can
fast-forward and push `main`, then rebase `vinci`; it is **not a supported maintenance route for
public product `main`** until adapted and reviewed. Public Pi updates need a narrow reviewed
integration against the public product lineage and fresh identity, security, and packaged checks.

**Why this stays conflict-free:** ~everything Vinci is *additive* (the `vinci/` dir + new
`packages/**/vinci-*.ts` files) — additive files never conflict. The only conflict surface is a small
set of inline, env-gated core edits, each tagged `[vinci]` and inventoried in
[`PATCHES.md`](PATCHES.md). `git grep -n '\[vinci\]' -- packages/` lists them all; `rerere` remembers
each resolution so you never redo it. Full details + the recovery steps: [`UPSTREAM.md`](UPSTREAM.md).

## Status

The source contains truthfulness, checkpoint/resume, outcome/meter, model-provenance,
source-ownership, Crew reconciliation, and sealed-comparator work. Qualification belongs to the
dated check and harness outputs for the exact source and artifact under review, rather than a
test count or blanket passing claim maintained in this README.

The product target is **Vinci Forte**, initially GLM 5.2 on DeepInfra with confirmed ZDR approval.
The CLI requests the stable `forte` class and records requested/resolved provenance and route drift.
The remaining serving work is signed resolution metadata, complete capability/cost headers, repeated
production qualification, and a checked-in promotion/rollback gate. Do not replace that with BYOK, an
in-app local runtime, a per-task dollar cap, plan-based concurrency, or a paid priority lane.

Offline fixtures and packaged startup do not establish useful real-model execution. The tracked
launch report remains `not-qualified` until the required production outcomes and independent
comparison evidence are qualified and recorded by their owners.
