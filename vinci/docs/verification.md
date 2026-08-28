# Verification System

Making a small model's claims trustworthy.

Vinci's first acceptance traces used a 9B; Fort now raises the model ceiling without changing the
runtime problem. The recurring failure across real sessions is **overclaiming**: the model does
*some* work, then asserts a broad conclusion it didn't earn — "all actions are up to date" (two were
2–3 majors stale), "the AWS workflow is correct" (it can't host an SSR app on S3), "done" (the
grader said needs-work and it was dismissed). Prompting does not fix this — a guideline aimed
straight at it ("verify versions evenly") was added and the failure recurred the same day.

This doc is the design we build against. The principle: **trust the check, not the claim** — and make
the check one the model cannot see-around or narrate-past.

## The Three Flaws

The `review_changes` grader (`vinci-review.ts`) is the right idea with three concrete holes, and they
map 1:1 to observed failures:

1. **It reads the wrong artifact.** Its diff is `git diff HEAD` + `git diff --cached` — **untracked
   files are invisible**. The `.github/` workflows were untracked, so it graded leftover
   README/package.json and said "doesn't match the task." Correct verdict, wrong input.
2. **The grader is the same weak model that did the work** (`complete(currentModel, …)` — a 9B
   grading a 9B). It won't catch "S3 can't host SSR" when the worker didn't. The check's ceiling is
   the checker's ability.
3. **The verdict is advisory.** It's a tool the model calls and can ignore — dismissed twice with a
   rationalization. A check you can narrate past is not a check.

## Principles

1. Trust the check, not the claim — completion/correctness claims must be backed by an independent check.
2. The check reads the REAL state — untracked + staged + unstaged, and build/test where possible.
3. The checker should be stronger than the worker — escalate grading to the strongest serving tier,
   or have the grader use the tools (`library_docs`/`web_answer`/GitHub API) to fact-check.
4. The verdict is sticky — "needs work" is cleared by a fix + re-check, never by re-assertion.
5. Match cost to stakes — gate "done / up to date / correct", not "I read the file".
6. Ground checkable facts in tools — "v4 is latest" is a lookup, not an opinion.

## The Loop

```
claim (done / all up to date / correct)
  → detect (todo all-done transition, or overclaim language at message_end)
  → run an INDEPENDENT check on the REAL state
        ├─ diff grader over untracked + staged + unstaged   (fixes flaw #1)
        ├─ graded by strongest tier / grounded with tools   (fixes flaw #2)
        └─ optionally: build / test signal
  → passes → claim stands
  → needs-work → STICKY: inject the concrete failure, reopen, require fix + re-check  (fixes flaw #3)
```

The three fixes are the three flaws, in order. The shape is right; it leaks at each stage.

## Where Each Piece Lives

- **Flaw #1** — `lib/grader.ts` `gatherDiff()` includes untracked files
  (`git ls-files --others --exclude-standard`, content inlined as new-file blocks).
- **Flaw #2** — `GRADER_SYSTEM` instructs the grader to fact-check version/factual claims with the
  tools rather than judge from memory; escalate to a stronger tier when one is serving (tela).
- **Flaw #3** — two enforcement points, both system-run so the model can't skip them:
  - the todo "all-done" gate AUTO-RUNS the grader on the real state and reopens the task on "needs
    work" (Phase 1, `vinci-todo.ts`);
  - the **turn-end verification gate** (Phase 2, `agent-session.ts` §8): when a turn settles on a
    completion claim with real uncommitted changes, it grades the actual diff and, on "needs work",
    injects the findings and continues the turn — sticky even OUTSIDE the todo flow.
  The grader primitives are shared from core (`core/vinci-grader.ts`, re-exported), so both points and
  the explicit `review_changes` tool use one implementation. The tool is not a second automatic final
  check; core owns normal completion review, while `/review` and `review_changes` remain explicit.
- **Runtime evidence state** — `vinci-verification.ts` records code mutations, concrete failed edits,
  and direct project checks independently of assistant prose. A failed check or unapplied edit remains
  `failed`, and a later successful edit becomes `stale`, until a direct post-edit check passes. Piped
  checks are never accepted as proof because their exit status can be hidden. Direct package scripts
  and local `node_modules/.bin` test runners are accepted, so a focused Mocha/Ava/Vitest-style command
  is not mistaken for exploration. Filtered or compound checks immediately append a safe direct
  command when one can be extracted, while unrelated chains such as `git stash && test` remain
  untrusted. Tool-free success prose
  while state is failed/stale is replaced by a bounded recovery turn; after two unsuccessful
  recoveries Vinci emits a deterministic `Blocked:` receipt instead of inventing success.
  `vinci-receipt.ts` renders and persists the terminal contract directly: verified code is `DONE`,
  changed code without a direct pass is `DONE-UNVERIFIED`, a named decision is `WAITING`, and a
  provider/check/runtime stop is `BLOCKED`. The same non-context task record carries model-call,
  token, cache, provider/model, and locally estimated cost telemetry for `/usage` and `/task-info`.
- **Bounded-stop ownership** — loop breaking, plan continuation, goal continuation, todo continuation,
  and verification recovery share one process-wide latch in `lib/control.ts`. Once a no-progress
  boundary is reached, no other extension can silently restart the job; only the next real user
  instruction releases it.
- **Unattended mode (#5, #6)** — a `vinci -p` / `--mode json` run has no user to answer. Every
  extension that behaves differently without one detects it the same way, `isVinciUnattended(ctx)`
  in `lib/unattended.ts` (Pi's `ctx.hasUI`, false in print mode). Three consequences: (1) the
  no-progress latch blocks with an *unattended stop* reason ("… (unattended run: ending the task as
  BLOCKED)") instead of asking for an instruction nobody can give; (2) a latch block — or the action
  reserve refusing a finalization step — is recorded as a **hard stop** in `lib/hard-stop.ts`, keyed
  by task, and `buildVinciTaskOutcome` then refuses to close that task as `DONE` / `DONE_UNVERIFIED`
  in any mode: the record becomes `BLOCKED` with the stop text as its reason, whatever the closing
  message claims; (3) unattended, finalization-shaped bash commands — `git add`, `git commit`,
  `git status`, `git diff`, local git only (`isVinciFinalizationCommand`) — are exempt from both
  action reserves because the commit *is* the deliverable; `git push`, `gh`, and anything
  network-shaped stay reserved (the worker daemon publishes). Interactively the reserve is unchanged.
- **Source ownership** — `vinci-scope.ts` treats `node_modules` as read-only diagnostic evidence,
  blocks direct edits there, and mechanically appends bounded `git grep` evidence for tracked project
  imports, wrappers, and configuration before a project-level fix. A mutation is blocked until every
  surfaced source candidate has been inspected; metadata and test references remain evidence but do
  not become mandatory reads. `vinci-loopbreak.ts`
  adds an ownership checkpoint when 16 tool calls have elapsed without a successful mutation, then
  allows two grace calls before reserving the remaining runway for an owning edit, one focused check,
  or an honest answer.
- **Edit recovery evidence** — the core edit tool remains strict and atomic, but a failed multi-edit
  now names matched and missing entries, states that nothing applied, and returns a bounded nearest
  current-file excerpt. This converts “whitespace trouble” guessing into a source-local retry without
  risking fuzzy or partial writes.
- **Current-fact evidence gate** — `vinci-factcheck.ts` detects settled assertions whose answer
  depends on current versions, releases, support status, recommendations, dates, or pricing. The
  current user request must contain successful `library_docs`, `web_fetch`, or `web_answer` evidence,
  and the final answer must visibly attribute the URL/live source. `web_search` is discovery-only
  because snippets can be stale. Missing evidence gets one bounded continuation; a second unsupported
  assertion is replaced with a deterministic uncertainty statement. A separate short-context Fort
  call then grades the proposed answer against bounded live-evidence excerpts as `supported`,
  `unsupported`, or `unclear`; an unsupported verdict gets one correction turn and remains sticky on
  repetition. The checker receives evidence as untrusted JSON data, shares the session affinity, and
  records its response model as non-context provenance. Kill switches:
  `VINCI_NO_FACT_GROUNDING=1` and `VINCI_NO_FACT_GRADER=1`.

## Honest Boundary

Reliably catches: claimed-done-but-diff/build-fails, graded-the-wrong-artifact, dismissed-the-check.
Does NOT by itself catch deep architectural wrongness (S3-can't-host-SSR) unless the checker in flaw
#2 is genuinely capable — so the ceiling is the grader's ability, which is why "stronger tier /
tool-grounded" is load-bearing and why this ultimately leans on the serving-side reasoning parser.
**This makes overclaiming expensive and mostly caught; it does not make any model infallible.**

The current-fact gate now checks retrieval, visible attribution, and semantic support against the
retrieved excerpts. Its ceiling is still the Fort checker's judgment and the coverage of the source
material supplied to it. If the independent checker is unavailable, Vinci warns and degrades to the
Phase 3a retrieval-plus-attribution gate instead of blocking an otherwise grounded answer; the TUI
shows the warning and the session retains the unavailable verdict. Sealed live calibration is still
required for multi-claim coverage, false positives, latency, and cost.

## Build Phases

- **Phase 1 (done):** flaw #1 (untracked) + flaw #2 (tool-grounded grader prompt) + flaw #3
  auto-run-on-done + reopen. Shared grader used by both `vinci-review` and `vinci-todo`.
- **Phase 2 (done):** sticky turn-blocking outside the todo flow — the turn-end gate in
  `agent-session.ts` §8 detects a completion claim (`looksLikeCompletionClaim`) with uncommitted
  changes, grades the real diff, and on "needs work" injects the findings and continues the turn so it
  can't be narrated past (kill switch `VINCI_NO_VERIFY=1`). Grader primitives moved to core
  (`core/vinci-grader.ts`, re-exported) so core + both extensions share ONE implementation without
  stacking a redundant model-invoked final review.
- **Phase 2b (done):** command-result ownership — `vinci-verification.ts` makes real check outcomes
  and unapplied edit failures sticky across mutations, rejects output-filtering pipelines as evidence,
  and allows only a direct pass or a precise blocker to settle a changed-code turn.
  `vinci-workspace.ts` supplies the bounded dirty-tree snapshot that the Express acceptance run showed
  was missing.
- **Phase 2c (done):** bounded recovery ownership + source ownership — one shared stop latch prevents
  autonomous layers from restarting a stopped turn, installed dependency code is mechanically
  read-only evidence rather than an editable target, and tracked dependency source candidates must be
  inspected before mutation.
- **Phase 3a (done):** current/version-sensitive answer gate — live docs/page/answer evidence plus
  visible attribution, one bounded recovery, and deterministic withholding when it cannot be
  grounded.
- **Phase 3b (done):** a bounded, independent Fort call grades the proposed answer against only the
  current request and live-evidence excerpts. Unsupported or unclear claims get one correction and
  then deterministic withholding; checker unavailability degrades visibly to Phase 3a. Focused faux
  provider tests cover support, contradiction, ambiguity, prompt injection, payload bounds, recovery,
  and checker-model provenance. Remaining work is sealed live calibration, not gate implementation.
