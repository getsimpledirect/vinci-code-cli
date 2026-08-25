# Core patches

Vinci Code is a **thin fork** — almost everything lives additively in `vinci/` (extensions) and
in new `packages/**/vinci-*.ts` files, none of which can conflict on a sync. What *can* conflict is
this small set of **inline edits** to upstream core files: behaviors that genuinely can't be done
from an extension/config, plus one default-preserving test seam. Product behavior is gated on
`VINCI_CODE=1` (set by `vinci/bin/vinci`), so **upstream behavior is byte-identical when the env is
unset** — a plain `pi` is unaffected, and the edits are cheap to re-apply on rebase.

## The `[vinci]` marker (how sync stays safe)

**Every inline patch carries a `[vinci]` tag in a nearby comment.** That makes the whole conflict
surface greppable, so after a sync you can confirm nothing was dropped:

```bash
git grep -n '\[vinci\]' -- packages/          # every inline patch site
git grep -l '\[vinci\]' -- packages/ | grep -v /vinci-   # the patched FILES (should match the table below)
```

`vinci/sync-upstream.sh` enables **`git rerere`** (so each conflict is resolved once, then replayed
forever) and prints this file count after every rebase as a completeness check. **When you add a NEW
inline patch, tag it `[vinci]` and add its file to the table below** — that's the contract that keeps
syncing painless. (Rule of thumb: prefer a new `vinci-*.ts` file or an extension over an inline edit;
only patch core when there's no hook.)

## Complete inventory — every inline-patched file

| File | What the `[vinci]` edit does | § |
|---|---|---|
| `agent/src/agent-loop.ts` | Canonicalize tool-name synonyms (`editor`→`edit`); repair double-encoded arguments before validation; mark Vinci-blocked results for private display handling | 20,23 |
| `ai/src/api/openai-completions.ts` | Mark failed/blocked tool results with an explicit `ERROR —` prefix on the wire | 15 |
| `coding-agent/package.json` | `piConfig.name: "vinci"` — window title / `APP_NAME` (JSON, so no inline tag) | 9 |
| `coding-agent/src/cli/args.ts` | Hide provider/model/BYOK controls from Vinci help while preserving the full upstream Pi surface | 4 |
| `coding-agent/src/cli/list-models.ts` | Restrict Vinci's non-interactive model listing to the managed provider | 4 |
| `coding-agent/src/core/agent-session.ts` | Small-window compaction `keepRecentTokens`; auto-continue after threshold compaction AND after a length-cut reply; turn-end verification gate (Phase 2); default active tools incl. grep/find/ls | 7,8,10 |
| `coding-agent/src/core/extensions/runner.ts` | Default the extension overlay-focus query to false outside interactive UI | — |
| `coding-agent/src/core/extensions/types.ts` | Expose an optional overlay-focus query to extensions | — |
| `coding-agent/src/core/vinci-grader.ts` | Shared grader core (verification system): untracked-aware diff, skeptical prompt, verdict parse, completion-claim detector — one check for core + `vinci-review`/`vinci-todo` | 8 |
| `coding-agent/src/core/auth-guidance.ts` | Warm "not connected to Vinci" copy | 9 |
| `coding-agent/src/core/keybindings.ts` | Free `shift+tab` for the Auto/Plan cycle | 11 |
| `coding-agent/src/core/sdk.ts` | One-line call into `vinci-degroove.ts` — collapse identical failed-call loops in the model's context view | 19 |
| `coding-agent/src/core/system-prompt.ts` | Drop the blanket "Be concise" guideline — the Vinci pack owns the voice (narration) | 16 |
| `coding-agent/src/core/tools/bash.ts` | Mask secrets in on-screen command output (`cat .env`) | 13 |
| `coding-agent/src/core/tools/edit.ts` | No edit-panel background; keep atomic multi-edits source-local | 17,24 |
| `coding-agent/src/core/tools/edit-diff.ts` | On failed atomic edits, report per-entry matches and bounded current-file evidence | 24 |
| `coding-agent/src/core/tools/write.ts` | Mask secret-looking values in a write preview | 13 |
| `coding-agent/src/core/tools/vinci-result-budget.ts` | Tighter per-result truncation budget for a 9B (env-tunable) | 21 |
| `coding-agent/src/core/tools/read.ts`, `grep.ts`, `find.ts` | Apply the Vinci result budget; steer `read` to grep over offset-paging | 21 |
| `coding-agent/src/index.ts` | Export `vinciMaskEnabled`/`vinciMaskSecrets` for the render extension | 13 |
| `coding-agent/src/main.ts` | Auto-resume the recent session on interactive relaunch (TTY-gated; opens the validated session) | 14 |
| `coding-agent/src/modes/interactive/components/assistant-message.ts` | Friendly errors + display-mask prose/thinking | 12,13 |
| `coding-agent/src/modes/interactive/components/diff.ts` | Mask secrets in edit diffs on screen; GitHub-style row tints on added/removed lines | 13,18 |
| `coding-agent/src/modes/interactive/components/footer.ts` | Friendly model name; drop the provider badge | 10 |
| `coding-agent/src/modes/interactive/components/model-selector.ts` | Friendly model name in `/model` | 10 |
| `coding-agent/src/modes/interactive/components/session-selector.ts` | Time-first resume rows + calm header | 14 |
| `coding-agent/src/modes/interactive/components/settings-selector.ts` | Lean settings (theme only) | 6,9 |
| `coding-agent/src/modes/interactive/components/status-indicator.ts` | Reframe the compaction spinner label | 9 |
| `coding-agent/src/modes/interactive/components/tool-execution.ts` | Tight tool spacing, semantic fallback rows for custom tools, and private display handling for blocked control guidance | 17,23 |
| `coding-agent/src/modes/interactive/interactive-mode.ts` | `/login`→vinci, Ctrl+C window, clean launch, `/model` filter, lean `/` menu; injectable terminal/process-handler seam for offline UI tests; expose active overlay focus to extensions; post-login ecosystem pointer instead of the credentials path | 1–5,22,25 |
| `coding-agent/src/modes/rpc/rpc-client.ts` | Settle `waitForIdle`/`collectEvents` (and release their timers) when the agent process dies or is stopped — a pure upstream bugfix, not env-gated | — |
| `coding-agent/src/modes/rpc/rpc-mode.ts` | Default the extension overlay-focus query to false when no local overlay exists | — |
| `coding-agent/src/modes/print-mode.ts` | Mask secrets in `-p` text + `--mode json` output | 13 |

The `§` column points at the detailed rationale below (— = self-explanatory from the in-code
`[vinci]` comment). §13 is the cross-cutting display-only secret masking (the masker itself lives in
the new file `core/vinci-mask-secrets.ts`; these files just call it on their render path).

When `vinci/sync-upstream.sh` rebases and one of these conflicts, re-apply the marked block
(search the file for `[vinci]`).

## 1. `/login` goes straight to Vinci (no provider picker)

`packages/coding-agent/src/modes/interactive/interactive-mode.ts` → `showOAuthSelector()`.
The built-in OAuth providers (anthropic / openai-codex / github-copilot) are **sticky** —
`unregisterOAuthProvider` restores them and `resetOAuthProviders` re-seeds them — and the
`/login` handler is hardcoded, so there's no extension hook. Under `VINCI_CODE=1` we skip the
picker and open the Vinci login directly:

```ts
if (process.env.VINCI_CODE === "1") { void this.showLoginDialog("vinci", "Vinci"); return; }
```

## 2. Ctrl+C twice to exit — friendlier window

`interactive-mode.ts` → `handleCtrlC()`. Pi already exits on a double Ctrl+C, but the window
is 500ms (a fast double-tap). Under `VINCI_CODE=1` we widen it to 1500ms so a natural
"Ctrl+C, Ctrl+C" exits.

```ts
const windowMs = process.env.VINCI_CODE === "1" ? 1500 : 500;
```

## 3. Clean launch — hide the resource-listing dump

`interactive-mode.ts` → the `if (showListing)` block that prints
`[Context] / [Skills] / [Prompts] / [Extensions] / [Themes]` at startup. Fine for hacking on
Pi, clutter for a product launch. Gated off under `VINCI_CODE=1`:

```ts
if (showListing && process.env.VINCI_CODE !== "1") { … }
```

## 4. Model surfaces show only Vinci models

`interactive-mode.ts` → `getModelCandidates()` (the single choke point for the selector,
exact-match, and provider count). Pi's built-in catalog lists every provider's models;
Vinci Code is single-provider, so filter to `provider === "vinci"` under `VINCI_CODE=1`:

```ts
return process.env.VINCI_CODE === "1" ? models.filter((m) => m.provider === "vinci") : models;
```

The picker component and `--list-models` narrow this provider to the stable `forte` class.
`cli/args.ts` hides provider, model, API-key, and provider-credential help under `VINCI_CODE=1`;
plain Pi keeps the complete help. Finally, `vinci/bin/vinci` rejects user-supplied `--provider`,
`--model`, `--models`, and `--api-key` arguments. Internal source-qualification routes remain
environment-gated and are not user BYOK.

## 5. Lean `/` command menu

`interactive-mode.ts` → the `BUILTIN_SLASH_COMMANDS` autocomplete build. Pi ships 24 built-in
commands; most are power-user/session-management noise for an opinionated, automated tool.
Under `VINCI_CODE=1` the `/` dropdown shows only a lean set (`VINCI_MENU`: login/logout/model/
new/compact/resume/reload/quit/hotkeys) plus the always-shown extension commands
(`/council`, `/review`). **Hidden commands still WORK if typed** — this only declutters the
menu. Edit `VINCI_MENU` to tweak.

```ts
const VINCI_MENU = new Set(["login","logout","model","new","compact","resume","reload","quit","hotkeys","help"]);
const slashCommands = BUILTIN_SLASH_COMMANDS
  .filter((c) => process.env.VINCI_CODE !== "1" || VINCI_MENU.has(c.name))
  .map(...);
```

## 6. Lean `/settings`

`settings-selector.ts` → `SettingsSelectorComponent`. Pi surfaces ~20 settings, almost all
pro-programmer plumbing (transport, HTTP timeout, steering/follow-up modes, telemetry,
project trust, double-escape, tree filter, hardware cursor, output padding, …). Vinci's users
aren't tuning transport protocols — Vinci handles it. Under `VINCI_CODE=1` we show only genuine
user **preferences** (`VINCI_SETTINGS`: theme, show-images); everything else is Vinci-managed
and keeps its default (still respected, just not surfaced).

**Thinking is on by default, not a toggle.** `vinci/bin/vinci` passes `--thinking high`, so
thinking-capable models (tela) reason by default (no-op on piccolo/bozza — `reasoning:false`)
— better decisions, per the automation thesis. The **orchestrator** will manage thinking (and
other knobs) dynamically per task and tell the user, rather than exposing hard toggles.

```ts
const VINCI_SETTINGS = new Set(["theme","show-images"]);
const shownItems = process.env.VINCI_CODE === "1" ? items.filter((it) => VINCI_SETTINGS.has(it.id)) : items;
new SettingsList(shownItems, …);
```

## 7. Compaction that fits a small context window (auto-compact recovery)

`agent-session.ts` → `_runAutoCompaction()`. Pi's default `keepRecentTokens` is **20000** — tuned
for 128k-window models. Piccolo's window is only **32768**, so keeping 20k recent tokens + the
summary + system/tools + the output reservation can't fit: overflow recovery compacts, retries,
overflows *again*, and hard-errors with `context_length_exceeded` (what a user actually hit). Under
`VINCI_CODE=1` we scale `keepRecentTokens` to the model's real window so the post-compaction retry
fits. `min()` makes it a **no-op on large windows** (128k → `floor(0.3·128k)=39k` > the 20k default),
so bozza/tela are unaffected.

```ts
if (process.env.VINCI_CODE === "1" && this.model?.contextWindow) {
  settings.keepRecentTokens = Math.min(settings.keepRecentTokens, Math.floor(this.model.contextWindow * 0.3));
}
```

The *experience* around this (a calm reframe when compaction starts, a "caught up — here's what I
kept" resume when it finishes, and a proactive backstop before the limit) is additive in
`vinci/extensions/vinci-compact.ts` — no core edit.

## 8. Auto-continue after a threshold compaction

`agent-session.ts` → `_checkCompaction()` (flag) + `_runAgentPrompt()` (loop). When context crosses
the threshold, Pi compacts and **ends the turn**, waiting for the user to type "continue" — jarring
mid-task for a "just keep going" tool. Under `VINCI_CODE=1` we flag the threshold compaction and,
after the normal agent loop drains, auto-send a "continue" nudge.

**Safe by construction:** the loop only runs when `_vinciThresholdCompacted` was set this turn (else
it's a no-op → byte-identical to upstream behavior); it's bounded by a cap of 3 (can't loop); and
it's self-limiting — the flag only re-arms if the continue-turn is itself large enough to
threshold-compact (i.e. still doing heavy work), so it stops naturally when work winds down (a
done-task's short "continue" turn won't compact → flag stays false → loop exits after 1). Messages
persist via the agent's own event subscription, same as a typed "continue". **Kill switch:**
`VINCI_NO_AUTOCONTINUE=1`. Overflow-recovery compaction already auto-continues (`willRetry`); this
covers the threshold path.

```ts
// _checkCompaction, threshold branch:
if (process.env.VINCI_CODE === "1") this._vinciThresholdCompacted = true;
// _runAgentPrompt, after the normal `while (_handlePostAgentRun()) agent.continue()`:
if (process.env.VINCI_CODE === "1" && process.env.VINCI_NO_AUTOCONTINUE !== "1") {
  let autoContinues = 0;
  while (this._vinciThresholdCompacted && autoContinues < 3) {
    this._vinciThresholdCompacted = false; autoContinues++;
    await this.agent.prompt("continue");
    while (await this._handlePostAgentRun()) await this.agent.continue();
  }
}
```

**Length-cut variant (same block, same kill switch):** when the turn ends with `stopReason: "length"`
on a text answer (no tool calls — a cut mid-tool-call isn't resumable prose), auto-continue up to 3×
with a PRECISE resume nudge ("Continue EXACTLY where it stopped — don't repeat, don't call tools,
don't restate the plan"). A bare "continue" makes a small model re-run its habits instead of resuming
the text (observed live: three identical `todo` calls, then nothing). Observed cause of the cuts: the
gateway clamps some replies to exactly 256 output tokens (OPS_ASKS #4) — each continue buys another
budget until the answer completes. The `stopReason: "length"` notice in `assistant-message.ts` reads
"continuing the answer…" when this is armed, and falls back to "ask it to keep going" under
`VINCI_NO_AUTOCONTINUE=1`. Both auto-continue nudges (threshold + length) are sent as
`display: false` **custom messages** — the model reads them (`convertToLlm` maps custom → user) but
they never render in the transcript; the "continuing…" notice is the only visible seam.

**Approved-plan continuation (additive extension, same kill switch):** `vinci-todo.ts` closes the
other user-visible stop: a model emitting a progress paragraph while its live plan still has work.
On a tool-free `turn_end` in Auto mode, it queues a private follow-up before Pi settles, so the model
continues without the user typing "continue". A specific question, error, abort, completed plan, or
`VINCI_NO_AUTOCONTINUE=1` stops normally. No-progress recovery is capped at six; real plan progress
resets the cap. Independent-review recovery is separately bounded: one failed review may reopen the
last step for a repair pass; a second failed review freezes mutating tools until the next real user
input. This prevents the grader from becoming its own `done → reopen → rewrite → done` loop. The
headless UI suite covers automatic continuation, the intentional question stop, and this review
circuit breaker.

**Absolute turn budget (additive extension):** `vinci-loopbreak.ts` caps total tool calls per turn.
Helpful narration resets only the consecutive read-only streak; it never refunds this absolute
budget. A talkative migration/rewrite loop is still a loop and must terminate deterministically.
The exploration recovery steer is emitted once per streak: if the model ignores it and tries one
more read, that blocked read cannot queue a second post-answer turn and duplicate the final response.

**Plan-mode continuation (additive extension, same kill switch):** `vinci-plan.ts` owns the read-only
side of the same contract. A progress paragraph cannot end planning before `present_plan`; it queues
a private follow-up and keeps inspecting until the plan is presented or a specific material question,
error, abort, or bounded no-progress limit returns control. This works with or without a `todo` widget,
so users never have to type "continue" just to finish an audit.

**Verification gate (Phase 2, same block, separate kill switch `VINCI_NO_VERIFY=1`):** the
verification system's sticky, non-todo enforcement (see `vinci/docs/verification.md`). A 9B's
most dangerous move is announcing "done / all correct / up to date" on work it did **not** verify;
Phase 1 catches it only when a `todo` plan reaches all-done. Phase 2 catches it anywhere: after the
loop drains, if the turn settled on a **completion claim** (`looksLikeCompletionClaim`) with real
uncommitted changes, it runs the INDEPENDENT grader (`core/vinci-grader.ts` — the same untracked-aware
diff + skeptical prompt the `review_changes` tool uses) on the actual diff, and on a **"needs work"**
verdict injects the concrete findings as a `display: false` custom message and continues the turn so
the model must address them before it can finish. **Safe by construction:** only grades a *settled
text* claim (never a cut mid-tool-call or a `length` cut), only when a claim phrase is present AND
`gatherDiff` is non-empty (otherwise a no-op ≈ upstream), bounded to 2 re-prompts, and **fail-safe** —
any grader error or missing auth lets the turn end rather than blocking it. The grader primitives live
in core (`core/vinci-grader.ts`, re-exported from the package) so this gate and the
`vinci-review`/`vinci-todo` extensions all run **one** check. Set `VINCI_VERIFY_DEBUG=1` to print the
graded verdict to stderr (`[vinci-verify] completion claim graded → verdict=…`) when diagnosing the
gate. Verified live: a completion claim over a buggy `subtract` (returned `a+b`) graded `needs-work`,
the findings were injected, and the model made the real fix (`a-b`) before finishing.

Short referential approvals retain just enough prior conversation for that reviewer to understand
them. For example, `let's do 1 and 5` is graded with the preceding numbered recommendation and user
goal, while a standalone request stays compact. Assistant context is explicitly labeled as context,
not evidence, so the reviewer can reject an unsupported edit instead of inheriting its premise.

## 9. Brand + copy polish (from the UX audit)

Small, mostly env-gated edits so a non-programmer never sees raw "pi" or dev jargon:

- **`packages/coding-agent/package.json`** → `piConfig.name: "vinci"` (kept `configDir: ".pi"` so
  existing logins/sessions in `~/.pi/agent/` are untouched — `getAgentDir()` uses `configDir`, not
  the name). This flips `APP_NAME`→"vinci" and `APP_TITLE`→"vinci" everywhere the core prints them
  (the window title's "π", "Quit pi", etc.). Config, not code.
  **Trap:** it ALSO renames the derived env overrides — `ENV_AGENT_DIR` is now
  `VINCI_CODING_AGENT_DIR` and `ENV_SESSION_DIR` `VINCI_CODING_AGENT_SESSION_DIR`, while the default
  directory stays `~/.pi/agent`. Because the default is unchanged, any leftover `PI_CODING_AGENT_DIR`
  literal keeps *looking* right and only misbehaves once a user actually overrides the directory.
  Vinci-layer code must therefore call `getAgentDir()` (or read `ENV_AGENT_DIR`) from the package,
  never restate the name — see `vinci/test/agent-dir-env-integration.mjs`.
- **`auth-guidance.ts`** → under `VINCI_CODE=1`, the "not signed in / no model" messages become one
  warm line ("You're not connected to Vinci yet. Type /login…") — no provider IDs, "OAuth or API
  key", or doc paths.
- **`status-indicator.ts`** → the compaction spinner label reframes to "Tidying up our
  conversation…" (matches `vinci-compact.ts`) instead of "Context overflow detected, Auto-compacting"
  under `VINCI_CODE=1`.
- **`settings-selector.ts`** → `VINCI_SETTINGS` trimmed to `{"theme"}` (dropped the dead
  `show-images` knob — every Vinci model is text-only).

`vinci/bin/vinci` also `export PI_OFFLINE=1` — no pi.dev version check / npm-update nags / install
telemetry network calls (Vinci ships its own updates; off-brand for a ZDR product). A narrow
`VINCI_TOOL_BOOTSTRAP=1` exception in `tools-manager.ts` still provisions fd and ripgrep from their
official GitHub releases on a fresh machine; users can set it to `0` for completely offline startup.

## 10. Structured search tools on by default + friendly model names

- **`agent-session.ts`** → the default active built-in tools become
  `[read, bash, edit, write, grep, find, ls]` under `VINCI_CODE=1` (upstream is the first four). A
  4B model navigates a codebase far better with real grep/find/ls than by shelling out through bash,
  and `vinci-render.ts` already wraps them with friendly headers. Only the ACTIVE built-in set —
  extension tools are unaffected (and `--tools`, an allowlist, still overrides). NOTE: do **not** use
  `--tools read,bash,…` to achieve this — that allowlist also disables the Vinci extension tools.
- **`footer.ts`** + **`model-selector.ts`** → show the model's friendly `name` ("Vinci Piccolo (4B)")
  instead of the raw id ("vinci-piccolo"), and (VINCI_CODE) drop the always-"[vinci]" provider badge
  in the `/model` list. Footer empty state reads "connecting…".

## 11. Free `shift+tab` for the Auto/Plan mode cycle

`keybindings.ts` → `app.thinking.cycle`. Shift+Tab is the expected key for cycling agent modes
(auto/plan), but Pi binds it to "cycle thinking level". Vinci **auto-manages thinking** (on by
default, orchestrator-managed — no user toggle), so that binding is dead weight for us. Under
`VINCI_CODE=1` we unbind it (`defaultKeys: []`) so the `vinci-plan.ts` extension's
`registerShortcut("shift+tab", …)` can claim it without a "conflicts with built-in shortcut,
skipping" rejection. The Auto⇄Plan cycle itself is a **pure extension** (`vinci-plan.ts`) — this
one-line patch just frees the key.

```ts
defaultKeys: process.env.VINCI_CODE === "1" ? [] : "shift+tab",
```

## 12. Friendly errors — don't show raw provider JSON (overflow, 429, 5xx, network, auth)

`modes/interactive/components/assistant-message.ts`. Raw provider error JSON (`context_length_exceeded:
400: {…}`, `429: {…rate_limit…}`, a socket error) alarms a non-programmer for nothing. Under
`VINCI_CODE=1` we soften the KNOWN categories to a calm human line; a truly unknown error still shows
raw so real problems surface (and stay debuggable).

- **Context overflow** → `vinciCalmsOverflow` (canonical `isContextOverflow` — the same condition the
  #7/#8 auto-recovery keys on — plus our gateway's underscore form / aborted-mid-overflow). Recoverable,
  so a muted "Context filled up — condensing…". 
- **Transient / connection / auth** → `vinciFriendlyError` maps 429·rate-limit·"server busy" →
  "servers are busy, try again" (muted); 5xx·timeout·ECONNRESET·"fetch failed" → "couldn't reach its
  servers, check your connection" (muted); 401/403·invalid-key·"not signed in" → "Run /login vinci"
  (warning). Pi already retries 429s/5xx with backoff (`ai/utils/retry.ts`); this only softens what the
  user sees once retries are exhausted. Returns null for anything unrecognized → the raw error still shows.

```ts
if (vinciCalmsOverflow(message)) { …muted overflow line… }
else if (message.stopReason === "error") {
  const friendly = vinciFriendlyError(message.errorMessage);   // {text, tone} | null
  friendly ? addChild(theme.fg(friendly.tone, friendly.text)) : addChild(theme.fg("error", `Error: ${raw}`));
}
```

## 13. Display-only secret masking (café / screen-share safety)

The masker itself is a **new file** (`packages/coding-agent/src/core/vinci-mask-secrets.ts`) — no
conflict. But it has to be *called* on every render surface that can paint a `.env` / config value,
so a handful of upstream render paths get a one-line `[vinci]` call under `VINCI_CODE`:
`tools/write.ts` (write preview), `components/diff.ts` (edit diff), `tools/bash.ts` (command output),
`components/assistant-message.ts` (`vinciMaskOut` on prose/thinking), and `modes/print-mode.ts`
(`-p` text **and** `--mode json`). `src/index.ts` re-exports `vinciMaskEnabled`/`vinciMaskSecrets` so
the `vinci-render` extension can mask expanded (ctrl+o) tool output. **Display-only in all cases** —
the value written to disk and the value the model sees are never masked, so edits still land
byte-for-byte and the model can still match the real key. Kill switch: unset `VINCI_CODE`.

## 14. Auto-resume the recent session on interactive relaunch

`main.ts` → the session-resolution path. Under `VINCI_CODE=1`, a *genuinely interactive* relaunch
(real TTY, no `-p`/`--mode`/`--no-session`/`--session`) reopens the project's most recent session if
it's recent + substantial (`vinciWorthResuming`: <14d, >800 bytes) instead of starting cold — so a
non-programmer's work carries over without them learning `--continue`. It opens the exact validated
session (not `continueRecent`'s unfiltered pick) and sets `VINCI_RESUMED` so `vinci-render` can show a
one-line "picked up where you left off". Opt out: `VINCI_NO_RESUME=1`. The friendlier **resume picker**
itself (time-first rows, calm header) is the `[vinci]` block in `components/session-selector.ts`.

## 15. Failed tool results are visibly errors on the completions wire

`packages/ai/src/api/openai-completions.ts` → the `toolResult` serialization. Pi's internal
`ToolResultMessage` carries `isError: boolean`, and Anthropic's API sends it as `is_error: true` —
but the OpenAI-completions API (what the Vinci gateway speaks) has **no error field on tool
messages**, and Pi dropped the flag entirely: a failed edit, an invalid call, or a loop-breaker
`{block}` arrived as a normal-looking `role:"tool"` message. A small model can't tell that call
FAILED — observed live (bozza, 2026-07-09): the loop-breaker "blocked" a `read` 12+ times and the
model re-issued it every time, because each block *looked like a read that returned one line of
prose*. Under `VINCI_CODE=1` we prefix error results so failure is unmissable:

```ts
if (process.env.VINCI_CODE === "1" && toolMsg.isError) {
  toolResultText = `ERROR — this tool call FAILED. Do not repeat it unchanged.\n${toolResultText}`;
}
```

Display is unaffected (the TUI renders from the internal message, not the wire form). This is the
biggest single lever against tool-call doom-loops: every retry-forever spiral we've observed began
with the model treating a failure as a success.

## 16. Drop the blanket "Be concise" system-prompt guideline

`packages/coding-agent/src/core/system-prompt.ts` → the always-on guidelines. Pi's ENTIRE default
guidance on how to talk to the user is one line — `"Be concise in your responses"` — written for
developers who read the tool stream themselves. Vinci's character pack asks for the opposite
(narrate every step in plain language for non-programmers), and on a 4–9B model two conflicting
instructions means the wrong one wins half the time. Under `VINCI_CODE=1` the "Be concise" line is
dropped; the Vinci pack owns the voice (it still asks for short LINES — narration ≠ rambling).

```ts
if (process.env.VINCI_CODE !== "1") addGuideline("Be concise in your responses");
```

## 17. Tight tool-block spacing (pairs with the box-less theme)

`components/tool-execution.ts` → the constructor. Every tool block starts with a `Spacer(1)` and
wraps its content in a `Box(1, 1, bg)` — 1 line of vertical padding top AND bottom. With the
colored background panels that padding read as part of the panel; once Vinci's theme dropped the
panels (`tool*Bg: ""`), it became ~4 blank lines of dead air between consecutive tool rows (leading
spacer + bottom padding + chat spacer + next top padding). Under `VINCI_CODE=1` the leading spacer
is skipped and `paddingY` is 0 — the chat container's own spacer keeps exactly one line between
blocks. Upstream look is untouched when the env is unset. Additionally, no `bgFn` is attached to
the tool shells at all under `VINCI_CODE` — the `tool*Bg` tokens are repurposed by §18.

## 18. Diff row tints — color exactly what changed (GitHub-style)

`components/diff.ts`. With the tool panels gone (§17 + the theme), diffs were foreground-only:
red/green text, easy to skim past. Users want changed lines to be unmissable — a visible background
tint on added/removed rows, like GitHub / Claude Code. The theme schema is a closed set (no custom
tokens), so Vinci's themes **repurpose the freed panel tokens**: `toolSuccessBg` = diff-added row
tint, `toolErrorBg` = diff-removed row tint (`toolPendingBg` stays empty). §17 guarantees no panel
paints them anymore. Under `VINCI_CODE=1`, `diff.ts` wraps added/removed rows in those backgrounds;
context lines stay plain — so the ONLY background color on screen is on lines that actually changed.

```ts
function vinciDiffRow(kind: "added" | "removed", row: string): string {
  if (process.env.VINCI_CODE !== "1") return row;
  return theme.bg(kind === "added" ? "toolSuccessBg" : "toolErrorBg", row);
}
```

## 19. De-groove the model's context view (the "sees the issue, does it anyway" fix)

`core/sdk.ts` (one `[vinci]` line) + the new additive file `core/vinci-degroove.ts`. A model
continues its context — it doesn't act on its narration. Observed live: bozza wrote "I keep
forgetting the edits array. Let me do this properly:" and then re-sent the identical broken call,
nine times — because the context held six examples of the wrong call and zero of the right one, and
a small model imitates context far more strongly than it follows instructions. The fix is
subtractive: consecutive identical no-progress rounds — FAILED (the invalid-edit loop) and
SUCCESSFUL-but-identical (the todo loop) — are collapsed in the LLM-VISIBLE view only: first round
kept, repeats replaced by a hidden "you repeated this N times, the repeats were removed, do
something different" note at the generation point. Runs on every request, so a RESUMED session's
history is cleaned identically — old loops never re-poison a fresh start. Call args and assistant
text must match exactly; result text is digit-normalized so the loop-breaker's own attempt counters
can't camouflage a groove. Display, session files, and /undo see the raw messages; compaction
summaries flow through the same path. Collapses only ≥3 repeats; everything else byte-identical.

## 20. Repair double-encoded tool arguments before validation

`agent/src/agent-loop.ts` (one `[vinci]` call) + the new additive file `agent/src/vinci-coerce.ts`.
Observed live: bozza composed a COMPLETE, correct multi-part edit — thousands of tokens, every
oldText/newText present — but the `edits` array arrived as a JSON *string*
(`"edits": "\n[{\"oldText\": …"`), so a perfectly good call failed validation on a wrapper
technicality and the model spiraled on the failure. Whether the double-encoding is the model's or
the serving tool-parser's, the harness repairs it mechanically: when the tool schema expects an
array/object but a JSON-parseable string of that exact shape arrived, parse it; likewise
stringified elements of object-arrays. Schema-aware, so legitimate string args (a JSON document in
`write.content`) are never touched. No-op unless `VINCI_CODE=1`.

## 21. Per-tool-result context budget (read / grep / find)

`core/tools/vinci-result-budget.ts` (new) + `read.ts` / `grep.ts` / `find.ts`. Upstream truncates
tool output at a generous **2000 lines / 50KB** — but a single 50KB result is ~13k tokens, so a few
verbose `read`/`grep`/`find` results dominate a 9B's ~64k operating window and trigger the
compaction/thrash the loop-breaker fights (GAP_ANALYSIS #53). Under `VINCI_CODE=1` we pass a tighter
budget (**1200 lines / 24KB**, env-tunable via `VINCI_RESULT_MAX_LINES` / `VINCI_RESULT_MAX_BYTES`)
into each tool's existing `truncateHead` call — same machinery, smaller cap, so no ONE result floods
the context. `read`'s truncation footer also stops pushing pure offset-paging ("Use offset=N to
continue") and adds "or grep this file for what you need" — blind chunk-paging is a classic
small-model loop; searching a big file is the right move. The vast majority of real source files fit
under 24KB and come back whole; only the pathological dumps get trimmed. **No-op unless `VINCI_CODE=1`;
kill switch `VINCI_NO_RESULT_BUDGET=1`** (falls back to upstream 2000/50KB).

## 22. Deterministic interactive-UI test seam

`modes/interactive/interactive-mode.ts` accepts an optional `Terminal` and an optional switch for
process signal ownership. Normal callers pass neither, so Pi still creates `ProcessTerminal` and
registers the same handlers. Vinci's offline UI suite injects the existing xterm-backed virtual
terminal and owns test-process errors itself. This is the only core seam required by the scenario
harness; the harness, snapshots, and identity contract remain additive under `vinci/test/`.

## 23. Private blocked-tool guidance

Extension `tool_call` hooks sometimes block an action for a model-only reason, such as loop recovery
or Plan-mode control. The agent still needs that reason to choose a better next action, but rendering
it exposed system guidance in the user transcript. Under `VINCI_CODE=1`, `agent-loop.ts` adds a
`vinciBlocked` detail marker to blocked results. `tool-execution.ts` recognizes that marker and
renders “Vinci paused this action before it ran” while leaving the real result unchanged for the
model and session. A low-level agent test covers the marker and a component test covers display
sanitization.

## 24. Actionable atomic-edit failure diagnostics

`core/tools/edit-diff.ts` + one prompt guideline in `edit.ts`. The edit tool is deliberately atomic:
if one replacement misses, none apply. That protects files, but the old error only named the first
missing index and told the model to match whitespace. Live Execa evidence showed the real failure was
different: `edits[0]` correctly targeted `handle.js`, while later entries had been copied from an
imported sibling file. The 9B interpreted the generic error as whitespace trouble and repeated the
same multi-file call until the loop breaker stopped it.

Under the `[vinci]` patch, a not-found error now reports which entries matched, which did not, states
that no changes applied, reminds the model that one call can modify only one path, and includes at
most five nearby current-file lines selected by shared identifiers. Matching remains strict and
atomic—there is no automatic fuzzy write or partial application. The extra evidence only helps the
model form a smaller, source-local retry.

## 25. Post-login ecosystem pointer

`modes/interactive/interactive-mode.ts` → `completeProviderAuthentication()`. Upstream closes a
successful login with `Credentials saved to <path>` — a file path a non-programmer never needs and
can't act on. Under `VINCI_CODE=1` that tail becomes a short pointer at the rest of the ecosystem:
"You're connected. Vinci is also on the web and your phone — type /help for links." The
`Logged in to Vinci` / selected-model part is unchanged, and `/help` (the additive
`vinci/extensions/vinci-help.ts` extension) carries the actual URLs, so this patch stays one string.

```ts
const credentialsTail =
  process.env.VINCI_CODE === "1"
    ? "You're connected. Vinci is also on the web and your phone — type /help for links."
    : `Credentials saved to ${getAuthPath()}`;
```

---

Everything else (theme, welcome header, provider + device-login, character/behavior pack, tool
rendering, compaction UX, memory, web search, Auto/Plan mode) is additive in `vinci/` — no core edits.
