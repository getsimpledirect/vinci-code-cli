# Vinci Crew — multi-agent sessions (design plan)

**Status:** Phases 1–4 built; restart-safe result persistence shipped. **Live steering is BUILT** (this
document called it deferred for weeks after it shipped — see Phase 5). A killed child's partial work is
now preserved. True child-session continuation remains the one genuinely unbuilt item. Updated
2026-07-29 after a doc-vs-code audit; every claim below was re-checked against the source.

> **Reading this document:** it drifted badly between 2026-07-12 and 2026-07-29 — three separate
> readers were misled by it in one session. If a claim here disagrees with the code, the code is right;
> fix the line rather than working around it.

## The vision (George)

A main session that acts as an **orchestrator**, plus named **helper** sessions — each a real Vinci
working its own task in the background. Below the input box: a `● main` tree with the helpers under
it, live status per helper, navigable by arrow/Tab. When a helper finishes, main gets a calm
notification ("*Chianti finished — drafting the README*") and the result flows back so the
orchestrator can summarise and act. As many helpers as the gateway allows.

Reference UX: Claude Code's agent tree — **but the Vinci way** (see "The Vinci way" below).

---

## Feasibility — the big result

**Almost all of this is our additive extension layer. Little or no core patch.** Two facts make that
true:

1. **The strip already has a home.** The interactive layout mounts a dedicated region *between the
   input box and the footer* — `widgetContainerBelow` (declared `interactive-mode.ts:378`, mounted
   `:706`). Extensions draw there with `ctx.ui.setWidget(key, (tui,theme)=>Component,
   {placement:"belowEditor"})` (`types.ts:99-104`, bound at `interactive-mode.ts:2120`): full
   `render(width)` control, refreshable, ≤10 lines (a 1–5 line tree is fine). **No core patch for the
   strip.**

2. **Child processes dodge the only architectural blocker.** Running many agents *in one process* is
   possible (`AgentSession` is instance-scoped — no singletons, no `chdir`, per-session
   Agent/tool-loop/abort/transcript, `createAgentSession(...)`), but the interactive fork assumes a
   *single active* session, so a second in-process runtime would need new core machinery. **We
   avoid all of it by making each helper a separate process:** `RpcClient.start()` already spawns
   `node <cli> --mode rpc` children and drives them with a typed API — `prompt()`, `waitForIdle()`
   (resolves on `agent_end`), `getLastAssistantText()`, `getMessages()`, `setSessionName()`,
   `abort()`, `newSession()` (`rpc-client.ts:93,197,447,411,426`). Each child is a **full Vinci with
   real tools (edit/bash), its own model+auth, its own session file, its own process** — naturally
   isolated, crash-safe, outlives main's turn. This is Pi's *intended* embedding path.

So "Vinci Crew" is, in essence, **one extension in main that: manages RpcClient children (the
engine), draws the tree via `setWidget` (the UI), routes arrow/Tab via `onTerminalInput` (the
switching), and reports back via `ctx.ui.notify` + `pi.sendMessage` (the loop closed).**

### What each piece needs

| Piece | How | Core patch? |
|---|---|---|
| Spawn background helper that runs to completion & reports back | `RpcClient` child (`node --mode rpc`) + `waitForIdle` | No |
| Helper-tree strip below the input | `ctx.ui.setWidget(..., {placement:"belowEditor"})` | No |
| Arrow / Tab navigation of the strip | `ctx.ui.onTerminalInput` (gated consume; runs before editor, `tui.ts:769`) or `registerShortcut` (`shift+tab` is free under `VINCI_CODE=1`) | No |
| "Helper finished" notification | `ctx.ui.notify` / `setStatus` (async-safe, `requestRender` coalesced 16ms) | No |
| Result → main's context (orchestrator summarises) | `pi.sendMessage({…},{deliverAs:"nextTurn"})` / `sendUserMessage` | No |
| Capacity backpressure (gateway 429 / local load) | a plan-agnostic semaphore in the extension | No |
| View a helper's live transcript inside main | subscribe to child RPC events / `getMessages`, render read-only | No (moderate work) |
| File isolation between helpers | git worktree per helper + reconcile back | No (real design work) |
| *Chat into* a helper (full two-way) | proxy keystrokes → child `steer`/`prompt`, stream events back | **BUILT** — no core patch was needed (`vinci-crew.ts:872-889`, `:915-1110`) |

---

## The hard constraints (non-negotiable design elements)

1. **Capacity backpressure, not a tier entitlement.** Concurrency is not part of the account plan
   table and the CLI must never reduce it by paid tier. Earlier tests observed provider-capacity 429s
   at three concurrent full sessions, so the orchestrator keeps a plan-agnostic semaphore (start at
   2, tune from capacity evidence) and queues helpers beyond it. Show queued helpers as `queued`, not
   "running".
2. **File isolation.** Two helpers editing the same file = logical conflict (Pi's path-keyed
   `file-mutation-queue` prevents *corruption*, not *conflict*). See decision #1.
3. **Result delivery is a new turn.** The only way back into main's model is a fresh turn
   (`sendMessage`/`sendUserMessage`) — must not clobber the user mid-type. Buffer results and deliver
   on idle, or badge the tree and let the orchestrator pull them.
4. **Per-child cost.** ~100ms startup, a full process + its own gateway auth each. Fine at N≈2–4.
5. **RPC timeouts.** Child defaults are 30s/60s (`rpc-client.ts:558,447`) — raise for long tasks.

---

## The Vinci way (UI spec)

Same structure as the reference, different character:

```
▶ AUTO · 2 helpers working · ← view · ↓ manage          (reuse the existing green AUTO indicator)

● main — you're here
  ◐ Fixing the failing tests · 1m 20s · working…
  ✓ Drafted the README · done
  ○ Refactoring the auth flow · queued
```

- **No token telemetry.** George stripped tokens/cost from the footer; helpers show *plain-language
  task + elapsed + a calm status word* (`working… / done ✓ / queued / needs you`), never "↓ 23.4k
  tokens".
  > **Resolved 2026-07-29.** The agent row had regressed to appending `` `↓ ${formatTokens(h.tokens)}` ``.
  > George confirmed that was a regression, not a relaxed spec, and it was removed along with the now
  > unused `formatTokens` helper. `h.tokens` is still tracked and persisted for usage accounting — it is
  > simply never rendered. UI snapshots re-baselined; the only change was dropping `· ↓ 0`.
- **Vinci palette** (#14161A / sage #B8C5B0), the pulsing-dot working glyph already built in
  `vinci-render`, calm wording.
- **"Helpers / teammates", not "agents"** — matches the character's *"lean on your teammates"*. (Naming
  is decision #3.)
- The mode line **reuses the `▶ AUTO / ◇ PLAN` indicator** from `vinci-plan.ts`, extended with the
  helper count + nav hints.
- Completion is a calm chat notification, not an alarm: *"Chianti finished — drafting the README. Want
  me to fold it in?"*

---

## Key decisions (resolved)

**1. File isolation for coding helpers.** Coding helpers use a private Git worktree seeded from the
caller's exact tracked and safe-untracked snapshot. They never share main's checkout. A helper patch
contains only changes after that private baseline.

**2. Interactivity.** ~~Live steering into a helper is deferred.~~ **Superseded — live steering SHIPPED.**
Main is still the only session you type into directly, but you can steer a running agent: child `steer`
routing (`vinci-crew.ts:872-889`), the editable live overlay (`:915-1110`), and the `message_agent` tool
(`:2006+`). What remains deferred is *continuing* a finished agent's own session.

**3. Naming.** ~~"Helpers" in the tree and tools.~~ **Superseded — the product says "agents".** Tools are
`spawn_helper` (internal name kept), `message_agent`, `use_agent_work`, `dismiss_agent_work`; the command
is `/agents` with `/helpers` retained as an alias. "Helper" survives in code identifiers and in this
document; user-facing copy says "agent". "Teammates" is still acceptable in prose.

**4. Who spawns.** The model uses `spawn_helper`; users inspect and decide waiting patches through
`/agents` (alias `/helpers`). A separate user `/spawn` command is not required for the first product
slice. Agent-targeting tools take an OPTIONAL id: when the user's reference is ambiguous the tool asks
which agent rather than letting the model guess one (`resolveAgentTarget`).

---

## Phased slices

**Phase 1 — Engine, headless (no strip yet). ✅ BUILT (2026-07-07).** `vinci-crew.ts`: `RpcClient`
child spawner + plan-agnostic capacity semaphore (default 2 active, queue rest) +
`spawn_helper(name, task)` tool +
`/helpers` command. Per George's call, helpers do **full coding in isolated git worktrees** (not
read-only): each helper is a child `vinci --mode rpc` in its own worktree with main's extension stack
(minus crew — no recursion). Completion fires
`ctx.ui.notify` + a hidden `pi.sendMessage(…, {triggerTurn: true, deliverAs: "followUp"})` so the
orchestrator has the result on its next turn (the API changed from the `sendUserMessage` originally
planned; see `vinci-crew.ts:1492-1497`). Proven end-to-end; isolation and reconciliation are covered by
`vinci/test/crew-integration.mjs` plus the full offline harness.

**Phase 2 — The tree strip. ✅ BUILT (2026-07-07).** `ctx.ui.setWidget("vinci-crew", <colored string[]>,
{placement:"belowEditor"})` renders `● main — you're here` + the crew below the input box, above the
footer (proven via PTY): `◐ name · 1m 20s · working…` / `! name · waiting for review` /
`○ name · queued` / `✗ name · blocked`. Vinci palette, **no telemetry**.
A 1s heartbeat ticks the elapsed time only while a helper is working; helpers drop off the strip once
applied or done-with-no-changes. Replaced the Phase-1 footer status line. Visual regression locked in
`run.sh`. Next: extend the `▶ AUTO` footer indicator with a live helper count.

**Phase 3 — Navigation + viewing. ✅ BUILT (2026-07-07).** `ctx.ui.onTerminalInput` (gated) drives the
tree: **↓ on an empty input line arms navigation** (a `›` cursor appears), **↑↓ move**, **Enter/→ opens**
the selected helper, **Esc/← exits** — everything else passes straight through (verified live). Opening
a helper shows its session like its own Vinci terminal: if it's still **working**, the view is LIVE
(polls the child's `getMessages()` every 1.2s) and **auto-returns to main the moment it finishes**; if
done, a scrollable read-only view. `/agents` also gained a "View what it did" action.

> **Correction (2026-07-29):** the viewer no longer polls every 1.2s and no longer auto-returns to main
> on completion. It subscribes to the child's RPC events (`vinci-crew.ts:1004`, `:1731`); `agent_end`
> only clears repaint state, and the overlay stays open until you close it.

**Orchestrator flow fix (2026-07-07):** spawning no longer ends main's turn — the `spawn_helper` result
+ character pack tell main to keep doing the REST of the request itself, and on completion
`pi.sendUserMessage(…, {deliverAs:"followUp"})` WAKES main (triggers a turn when idle, queues when busy)
to report the result and continue anything unfinished. Validated by the module e2e. NOTE: helpers work
in a worktree off MAIN's cwd — run Vinci IN the project you want worked on (cross-repo tasks aren't
targeted yet).

**Phase 4 — Orchestration + file reconciliation. ✅ BUILT AND HARDENED (2026-07-12).** Worktree setup
fails closed; there is no fallback to main's cwd. Each helper inherits main's active provider/model,
sees the caller's dirty tracked and safe-untracked snapshot, commits a private baseline, and returns
only its own patch. Ordinary patches auto-integrate only when: the helper left a current passed direct
check; the same check passes in a disposable integration worktree; an independent reviewer returns
`ships`; no touched main path changed; and the patch contains no secret-looking or consequential
delete/dependency/config/infra change. Everything else is `WAITING` in `/agents`, with main unchanged.
Landing is serial. Helper dependencies remain deliberately unsupported: spawn only independent work.

**Phase 5 — Full interactivity + persistence. ⚠ PARTIAL.** Rewritten 2026-07-29 against the code; the
previous wording both understated what shipped and overstated what is durable.

*Built:* **live steering** — steer a running agent from the overlay or via `message_agent`
(`vinci-crew.ts:872-889`, `:915-1110`, `:2006+`). Terminal transitions, bounded transcript, child session
path, review, verification and the patch artifact persist in main's session (`:237-296`, `:1760+`).
Graceful shutdown stops children, preserves a partial patch as `WAITING`, and reload restores terminal
state (`:356-445`). A hard-killed *main* leaves an orphan whose patch reload can salvage and terminalize
as `WAITING` (`:326-435`, `crew-worktree.ts:453-486`). A hard-killed *child* no longer loses its work:
`runHelper`'s catch captures the partial patch before teardown removes the worktree.

*Not built:* **true child-session continuation** — resuming an interrupted agent's own conversation.
Generic plumbing exists (`RpcClient.switchSession` `rpc-client.ts:361`, RPC `switch_session`), but normal
completion deletes the private worktree while the child session header still points at that deleted cwd,
and noninteractive startup rejects such sessions (`main.ts:619-631`). **Decide what a continued agent
should see — its old worktree, its patch replayed onto a fresh snapshot, or current project state —
before touching any interface.**

*Known durability limits (do not overstate these again):* `childSession` is assigned at `:1695` without
an immediate `persistHelper`, the live transcript of an in-flight agent is deliberately not persisted
(`:147-160`), and custom entries may stay unflushed until the first assistant entry exists
(`session-manager.ts:1329-1351`). What is durable is terminal snapshots plus orphan patch salvage — not a
background job that keeps running after the parent dies.

---

## Risks / open questions

- **Provider and local capacity are the ceiling, not the customer tier.** The feature must degrade
  cleanly through a capacity queue and 429 recovery. Do not add plan-based concurrency limits;
  coordinate only on capacity signals and queue behavior.
- **Reconciling helper edits back to the user's project** now fails closed: changed main paths,
  conflicts, risky patches, missing proof, and failed review/check all become `WAITING`. There is no
  automatic merge or dependency graph.
- **Non-programmer clarity.** The whole thing must stay calm and legible: "Vinci spun up a helper for
  X; it's done; here's what it found." Never expose process/RPC/worktree mechanics.
- **`sendMessage` mid-type collision — still unfixed, and not what you might think.** This is about
  PARENT result delivery, not child steering (which is built and unrelated). `finalizeHelper`
  (`vinci-crew.ts:1492-1501`) delivers via `pi.sendMessage` with `triggerTurn: true` /
  `deliverAs: "followUp"` and does not check whether the user has unsent editor text. The proposed
  "buffer + deliver on idle" fix has NOT been implemented. Note the API also changed from the
  `sendUserMessage(…)` this document describes elsewhere.
- **Result delivery is at-least-once.** A crash after `sendMessage` succeeds but before the timestamps
  persist can redeliver on reload (`vinci-crew.ts:1492-1505`, `:441-443`).
- **Model capability** — autonomous helpers on hard tasks hit the same loop/ceiling issues we just
  fixed; `vinci-loopbreak` + escalate-on-stuck apply inside each child.

## Key seams (file:line)

Re-verified 2026-07-29. These drift every time the files move — re-check before trusting them.

Layout `interactive-mode.ts:700-708` (`widgetContainerBelow` declared `:378`) · `setWidget` bound
`:2120`, `WidgetPlacement` `types.ts:99-104` · input dispatch `tui.ts:761-834` · `ctx.ui` surface
`types.ts:126-277` · child driver `rpc-client.ts` `start:73`, `prompt:197`, `steer:204`,
`switchSession:361`, `getLastAssistantText:411` · RPC surface `rpc-types.ts:20-72` · session construct
`sdk.ts` `createAgentSession` · agent disambiguation `vinci-crew.ts` `resolveAgentTarget` · today's
orchestration `vinci/extensions/vinci-orchestrate.ts`.
