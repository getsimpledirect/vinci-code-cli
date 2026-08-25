# Pi Architecture

A walkthrough of Pi's engine for people who did not design it.

Vinci Code is a thin fork of Pi (`badlogic/pi-mono`). This doc is a comprehensive, module-by-module
tour of Pi's actual architecture — not the `vinci/` layer (that's `vinci/README.md` +
`vinci/PATCHES.md`), but the ~113k lines underneath it. Goal: read this and you can point at any
file in `packages/` and say what it's for, why a bug would live there, and whether Vinci should
patch it or work around it from an extension.

Written incrementally as a session-long walkthrough (2026-07-10). Each module below is a checkpoint
— skim the headers to jump to what you need later.

**Strategy update 2026-07-12:** the product target is the stable managed `forte` class, initially
GLM 5.2. Bozza/Tela observations below remain historical architecture evidence, not the current model
roadmap. Crew now uses typed RPC, snapshot worktrees, durable results, verifier replay, independent
review, and fail-closed reconciliation.

---

## Module 1 — The Big Picture

**Five packages, one clean dependency chain.** No cycles, no surprises:

```
pi-ai (36k lines)        — provider abstraction: models, streaming, the wire protocol
    ↑
pi-agent-core (8k)       — the pure agent loop: message in, tool calls out, no UI/session/CLI
    ↑
pi-coding-agent (53k)    — the actual product: sessions, tools, extensions, TUI wiring, CLI
    ↑
pi-orchestrator (2k)     — a separate experimental multi-agent CLI (see caveat below)

pi-tui (12k)             — standalone terminal rendering framework, no dependency on the others
    ↑ (used by pi-coding-agent, not by anything below it)
```

Read that chain literally: `ai` knows nothing about agents or tools — it's "how do I talk to
Anthropic vs. OpenAI vs. our own gateway and get a stream of text/tool-call events back." `agent`
knows nothing about sessions, files on disk, or a terminal — it's "given a system prompt, messages,
and tools, run the loop: call the model, execute tool calls, feed results back, repeat until the
model stops." Everything session-shaped, tool-shaped, and terminal-shaped lives in `coding-agent` —
that's the package `vinci/bin/vinci` actually launches (`packages/coding-agent/dist/cli.js`).

**A trap worth knowing about:** `packages/orchestrator` is upstream Pi's *own* experimental
multi-agent CLI (`orchestrator --help`, its own IPC/supervisor/RPC-process machinery). It is
**completely unrelated** to `vinci/extensions/vinci-orchestrate.ts` — that's our `orchestrate`
tool, a normal extension. Same word, two unconnected things. `vinci/bin/vinci` never touches the
`orchestrator` package at all.

**Where Vinci actually lives:** `vinci/bin/vinci` is a shell script that runs the *unmodified*
`coding-agent` CLI with `--extension` flags pointing at every file in `vinci/extensions/*.ts`, plus
`--theme`, `--provider vinci`, and an explicit model. The launcher now requests the stable `forte`
class; the gateway owns its concrete provider/model occupant and currently resolves it to GLM 5.2. Zero
fork of the product — it's flags. The
only place Pi's own source is edited is the inline-patch inventory in `vinci/PATCHES.md`, every one gated
behind `if (process.env.VINCI_CODE === "1")`, so `main` stays a byte-identical Pi mirror and a
plain `pi` binary is unaffected.

**A third safety layer worth knowing about (pre-existing, not something we built today):**
`packages/coding-agent/src/core/vinci-sandbox.ts` is an OS-level filesystem sandbox —
`sandbox-exec` on macOS, `bwrap` on Linux — that confines every `bash` tool call's *writes* to the
project + its parent + temp/cache dirs, independent of whether the guard extensions
(`vinci-guard.ts`, `vinci-scope.ts`) caught anything. Its own comment cites "users approve ~93% of
prompts" (Claude Code's data) as the reason attention-based guards alone aren't enough. Shipped in
PR #55, its own 18-file review pass — real, load-bearing infrastructure.

**Entry point, concretely:** `coding-agent/src/main.ts` → `createAgentSession()` (the SDK surface,
`core/sdk.ts` — the file patched twice on 2026-07-09 for de-groove + blockImages filtering) →
returns an `AgentSession` → handed to either `InteractiveMode` (the TUI) or `runPrintMode` /
`runRpcMode` (the `-p` / `--mode json` headless paths used all day to probe bozza).

---

## Module 2 — The Request Lifecycle

One prompt, traced through every layer. Ten steps, each with a real file:line so you can go read
the actual code, not a paraphrase.

**1. Keystroke → submission.** You hit Enter in the TUI editor. `interactive-mode.ts:2594` sets
`this.defaultEditor.onSubmit = async (text) => { ... this.session.prompt(text, ...) ... }`. This is
the ONE bridge from "terminal input" to "the agent stack" — everything before this line is pure TUI
(cursor, history, autocomplete); everything after is the agent.

**2. `AgentSession.prompt()` (`core/agent-session.ts:1091`).** The session-layer entry point — not
to be confused with `Agent.prompt()` one layer down. Expands file-based prompt templates, builds the
user `AgentMessage`, and calls `this._runAgentPrompt(messages)` — the exact function we patched
twice today (auto-continue on threshold-compaction and on a length-cut reply,
`agent-session.ts:988`).

**3. `_runAgentPrompt` → `this.agent.prompt(messages)` (`packages/agent/src/agent.ts:337`).** This
crosses from `coding-agent` into the pure `agent-core` package. `Agent.prompt()` internally calls
the module-level `agentLoop()` / `runAgentLoop()` functions in `agent-loop.ts`, passing itself
(`this`) as the `AgentLoopConfig` — which is how the Agent instance's `streamFn`, `convertToLlm`,
`transformContext`, `beforeToolCall`, `afterToolCall` all get threaded through a loop that otherwise
has zero references to sessions, extensions, or the TUI. This is the actual architectural boundary:
**`agent-core` is configured by callbacks; it doesn't know who's calling it.**

**4. Per turn: assemble what the model sees (`agent-loop.ts:349`, `streamAssistantResponse`).**
Two transforms run on the message list, in this order:
   - `config.transformContext(messages)` — if set, this is literally the extension `"context"`
     hook (`extensions/types.ts:657`; `sdk.ts:363` wires `runner.emitContext(messages)` here).
     Any extension can rewrite the AgentMessage list before it's even converted for the wire.
   - `config.convertToLlm(messages)` — converts `AgentMessage[]` → `Message[]` (the wire-shaped
     type). In `sdk.ts:256` this is `convertToLlmWithBlockImages`, which now ALSO runs
     `vinciDegroove()` first (`sdk.ts` — the patch from `2026-07-09` that collapses repeated
     failed/no-progress rounds before the model ever sees them again).

**5. The actual model call (`streamFn`).** `sdk.ts:308` is the real `streamFn` passed into `Agent`
— it resolves auth via `ModelRegistry`, merges headers (extensions can inject more via the
`before_provider_headers` hook, `sdk.ts:326`), then calls `streamSimple()` — which is where we
cross into `packages/ai` (Module 4). That package returns an async-iterable stream of typed events
(`text_delta`, `toolcall_delta`, `thinking_delta`, ...).

**6. Assembling the response, live.** Back in `agent-loop.ts` (`streamAssistantResponse`, the loop
starting ~`agent-loop.ts:380`), every stream event mutates a `partialMessage` and re-emits it as an
`AgentEvent` (`message_start` once, then `message_update` per delta, `message_end` when the
provider stream closes). This is what makes the TUI feel live — the UI is rendering the SAME
partial object the loop is mutating, event by event.

**7. Tool calls, one at a time (`agent-loop.ts` around line 649).** For each `toolCall` in the
settled assistant message:
   - `vinciCoerceArguments(tool.parameters, toolCall.arguments)` — our 2026-07-10 patch, repairs
     double-encoded JSON-string arguments before anything else touches them.
   - `prepareToolCallArguments` → `validateToolArguments` (schema check — this is where "Validation
     failed for tool edit: edits required" gets thrown when coercion couldn't save it).
   - `config.beforeToolCall(...)` — and THIS is the extension `tool_call` hook. The wiring is one
     specific place: `AgentSession._installAgentToolHooks()` (`agent-session.ts:419`) does
     `this.agent.beforeToolCall = async ({toolCall, args}) => runner.emitToolCall({...})` —
     literally assigns a closure onto the `Agent` instance's public `beforeToolCall` property ONCE,
     which reads `this._extensionRunner` fresh on every call (so `/reload` doesn't need to
     reinstall it). Every `pi.on("tool_call", ...)` handler across every loaded extension —
     `vinci-loopbreak.ts`'s whole fixation ladder, `vinci-guard.ts`, `vinci-scope.ts` — fires HERE.
     Returning `{block: true, reason}` short-circuits execution; the tool never runs.
   - If not blocked: `execute()` runs, then `config.afterToolCall(...)` fires — same pattern,
     `agent-session.ts:441`, dispatches the `tool_result` event (this is what
     `vinci-loopbreak.ts`'s error-streak tracking and the invalid-call/truncated-write coaches
     read).
   - The result becomes a `ToolResultMessage` (with `isError: boolean` — the field PATCHES §15
     makes visible on the wire), appended to context.

**8. The loop repeats** (back to step 4) as long as `hasMoreToolCalls` is true — i.e., the model's
last message had tool calls and wasn't `stop`/`length` with no calls pending. This is the whole
"agent loop": read context → call model → maybe call tools → append results → repeat.

**9. AgentSession is a spectator with a notebook.** It never drives the loop directly — it
subscribes once: `this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent)`
(`agent-session.ts:356`, a plain pub-sub — `Agent.subscribe()` at `agent.ts:241`). Every single
`AgentEvent` (message_start/update/end, tool_execution_start/end, turn_end, agent_end...) funnels
through `_handleAgentEvent`, which fans out to three jobs: persist to the session JSONL
(`SessionManager`), run compaction checks after each assistant message (`_checkCompaction`,
`agent-session.ts:1908` — the 64k-operating-window math lives downstream of this), and forward to
whoever else is listening (the extension runner's `message_end`/`tool_result` events, and the UI).

**10. Render.** `interactive-mode.ts`'s own event handling (`message_start` case, ~line 2843) reacts
to `role === "assistant"` by creating a fresh `AssistantMessageComponent` and pushing it onto
`chatContainer`; `message_update` mutates that same component's content live. Tool calls get their
own `ToolExecutionComponent` (Module 7) — which is what `vinci-render.ts` re-registers per built-in
tool name to swap in friendly headers, folded bursts, and meaning-first summaries.

**The one-sentence version:** a keystroke becomes a session-level prompt call, which becomes an
agent-core loop that's *configured* (not owned) by the session — every extension hook is a callback
the session installed on the Agent instance before the loop ever started, and the UI is just another
subscriber to the same event stream the session itself listens to.

## Module 3 — The Message and Tool Protocol

**Three families of message types, one funnel.** `packages/ai/src/types.ts:408` defines the WIRE
type: `Message = UserMessage | AssistantMessage | ToolResultMessage` — that's literally what a
provider API accepts. `packages/agent/src/types.ts:314` defines `AgentMessage = Message |
CustomAgentMessages[keyof CustomAgentMessages]` — a SUPERSET, extended via TypeScript declaration
merging. `coding-agent/src/core/messages.ts` is where the merging happens: it declares
`CustomAgentMessages { bashExecution, custom, branchSummary, compactionSummary }` — extra
session-only roles that only make sense inside `coding-agent` (a `CustomMessage` from
`sendMessage()`, a branch-summary marker, a compaction-summary marker). `convertToLlm()`
(`messages.ts:148`) is the down-projection: it walks `AgentMessage[]` and turns every custom role
into a plain `role: "user"` message with prefixed/suffixed text (`COMPACTION_SUMMARY_PREFIX`, etc.)
before the wire type ever sees it. **This is exactly the function our de-groove patch wraps** — it
runs on the superset, right before the down-projection.

**`AssistantMessage` content is a mixed array**: `(TextContent | ThinkingContent | ToolCall)[]`
(`ai/types.ts:383`). `StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`
(`ai/types.ts:375`) — that `"length"` value is the exact field the auto-continue patch checks
(`message.stopReason === "length"` in `assistant-message.ts`), and `"toolUse"` is what a message
with pending tool calls reports.

**`ToolResultMessage.isError: boolean`** (`ai/types.ts:404`) is the field at the center of
PATCHES §15. It's a real field on the internal type — but the completions wire format has no slot
for it (unlike Anthropic's `is_error`), so before the patch, Pi's own `openai-completions.ts`
serializer just dropped it silently on the way out. The type was always truthful; the WIRE wasn't.

**Tools are a two-layer contract**, and the split matters:
- `Tool<TParameters>` (`ai/types.ts:433`) — the bare minimum: `name`, `description`, `parameters`
  (a TypeBox schema).
- `AgentTool<TParameters, TDetails> extends Tool` (`agent/types.ts:371`) — what `agent-core`
  actually calls: adds `label`, `execute()`, an optional `prepareArguments()` compat shim, and
  `executionMode` ("sequential" | "parallel"). No rendering, no prompt text — agent-core doesn't
  know what a terminal is.
- `ToolDefinition<TParams, TDetails, TState>` (`extensions/types.ts:437`) — what an EXTENSION
  registers via `pi.registerTool()`. Rich: everything `AgentTool` has, plus `promptSnippet` /
  `promptGuidelines` (injected into the system prompt) and `renderCall` / `renderResult` (TUI
  components — this is the extension point `vinci-render.ts` uses to draw friendly headers).
  `wrapToolDefinition()` (`core/tools/tool-definition-wrapper.ts:5`) is the adapter: it strips a
  `ToolDefinition` down to the lean `AgentTool` shape agent-core needs, dropping the rendering and
  prompt metadata (those get consumed elsewhere, by the system-prompt builder and the TUI).

**The validation pipeline, in the EXACT order it runs** (`agent-loop.ts`, inside the `try` at
line ~649):
```
vinciCoerceArguments(tool.parameters, toolCall.arguments)   // [vinci] repair double-encoding
        ↓
prepareToolCallArguments(tool, coercedToolCall)              // calls tool.prepareArguments if set
        ↓
validateToolArguments(tool, preparedToolCall)                // ai/utils/validation.ts:278
        ↓  (only if this doesn't throw)
config.beforeToolCall(...)                                   // the extension "tool_call" hook
```
`validateToolArguments` (`ai/src/utils/validation.ts:278`) uses **TypeBox**: `Value.Convert` first
(cheap type coercion — numeric strings to numbers, that kind of thing — NOT JSON-parsing a
stringified array), then `validator.Check(args)`, and throws the formatted `"Validation failed for
tool X: ..."` error you've seen all day if it still doesn't match the schema.

**The single most important sentence in this whole doc:** *validation happens entirely inside that
`try` block, and `config.beforeToolCall` — the extension hook every guard in `vinci/` is built on —
is only reached if validation SUCCEEDED.* An invalid call throws, gets caught by the `catch` two
lines below, and becomes an immediate error `ToolResultMessage` — no extension ever sees it. That's
the precise, code-level reason `vinci-loopbreak.ts` was "structurally blind" to the invalid-edit
loop on 2026-07-09: the loop-breaker's entire mechanism is a `tool_call` hook, and a call that fails
validation never reaches one.

**A genuinely interesting discovery while confirming this:** Pi's own `edit.ts` already has a
`prepareArguments` hook — `prepareEditArguments` (`tools/edit.ts:94`) — whose comment reads *"Some
models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array."* Upstream Pi's
maintainers hit the exact same double-encoding bug against OTHER large models and patched the
`edit` tool specifically. This means:
  - The bug class isn't a bozza quirk — it's apparently common enough across models that Pi
    shipped a fix for it independently, for two different frontier models.
  - `vinciCoerceArguments` (PATCHES §20) is still a real value-add: it's schema-generic (works for
    any tool with array/object parameters, not just `edit`), and it also unwraps the deeper case —
    an array whose ELEMENTS are individually stringified — which `prepareEditArguments` doesn't
    handle.
  - It did NOT save bozza from most of the invalid-edit loop, because most of those failures
    (`"edits: must have required properties edits"`) weren't a stringified payload to unwrap — the
    `edits` key was **entirely missing**, because the 256-token clamp cut the stream before that
    key ever appeared. No coercion layer, ours or Pi's, can reconstruct data that was never sent.
    That distinction — encoding bug (fixable client-side) vs. truncated data (only fixable at the
    source) — is the whole story of yesterday's debugging arc in one sentence.

**Worth a look later, not urgent:** whether `vinciCoerceArguments` and `prepareEditArguments` are
now doing overlapping work worth consolidating — flagged for Module 8.

## Module 4 — The Provider Layer

**Two different words that both sound like "provider," and the distinction matters.** `api`
(`Model.api`, `ai/types.ts:666`) names a WIRE PROTOCOL SHAPE — a small closed set:
`openai-completions`, `openai-responses`, `anthropic-messages`, `bedrock-converse`,
`google-generative-ai`, `mistral-conversations`, and a few more. `provider` (`Model.provider`)
names a specific COMPANY/ENDPOINT — dozens of them (`anthropic`, `openai`, `groq`, `cerebras`,
`fireworks`, `deepseek`, `vinci`, ...). Many different `provider`s share ONE `api` shape, because
most of the industry cloned OpenAI's chat-completions format. **Vinci is registered with
`api: "openai-completions"`** (`vinci/extensions/vinci-provider.ts`) — not because our gateway is
OpenAI, but because the vLLM serving layer happens to speak that same wire protocol.

**Two parallel directories inside `packages/ai/src/`, doing different jobs:**
- `providers/*.ts` (+ generated `*.models.ts` catalogs) — the KNOWN-PROVIDER registry: default
  `baseUrl`s and pre-populated model catalogs for the ~60 providers Pi ships out of the box
  (`providers/anthropic.ts`, `providers/groq.ts`, ...). This is the "59+ models" list `/model`
  used to show before the `VINCI_CODE` filter (PATCHES §4), and it's what `vinci/build.sh` skips
  regenerating (PATCHES §19's neighbor concern — the model-catalog sync policy in `UPSTREAM.md`).
- `api/*.ts` (+ `*.lazy.ts` wrappers) — the WIRE IMPLEMENTATIONS, one per protocol shape.
  `api/openai-completions.ts` is the file with every `[vinci]` wire patch we made (§15's error
  marker, the toolResult serialization block). The `.lazy.ts` wrapper next to each one exists so
  requiring a model doesn't pull in every provider SDK at startup — `lazyApi()` (`api/lazy.ts`)
  dynamically `import()`s the real implementation only the first time that `api` shape is used.

**Dispatch, precisely:** `streamSimple()` (`compat.ts:258`) calls `resolveApiProvider(model.api)`
(`compat.ts:229`) — a lookup table keyed on the `api` string — and hands off to that
implementation's own `streamSimple`. This is the function `sdk.ts`'s `streamFn` (Module 2, step 5)
calls into.

**The actual event vocabulary** every provider implementation must speak, and everything
`agent-loop.ts` consumes (`AssistantMessageEvent`, `ai/types.ts:453`): `start` once, then
`text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end` per content block,
and a terminal `done` (carrying the final `AssistantMessage`) or `error`. This is the SAME
vocabulary the `--mode json` probes I ran all day print directly — `message_update` events in that
output are this union, verbatim.

**The compat-flags system — how ONE implementation serves dozens of actually-different
backends.** `OpenAICompletionsCompat` (`ai/types.ts:471`) is a single interface with ~20 flags:
`maxTokensField` (`"max_tokens"` vs `"max_completion_tokens"` — the split that mattered when
checking whether Pi sends a token cap at all), `requiresToolResultName`, `thinkingFormat` (**ten**
named variants — `openai`, `qwen`, `qwen-chat-template`, `deepseek`, `zai`, ... — this is EXACTLY
what OPS_ASKS #1's open question about bozza's `reasoning_content` maps onto),
`cacheControlFormat`, `supportsStrictMode`, and more. Rather than fork `openai-completions.ts` per
provider, Pi encodes every provider's deviation as a flag and branches on it once.

**Those flags are usually AUTO-DETECTED, and this is the important operational detail:**
`detectCompat()` (`api/openai-completions.ts:1186`) is a big set of `baseUrl.includes(...)` /
`provider === ...` string matches against ~10 KNOWN providers (zai, together, moonshot,
openrouter, cloudflare, nvidia, cerebras, xai, deepseek, ant-ling). **Vinci's `baseUrl`
(`vinci.getsimpledirect.com`) matches none of these patterns** — so every auto-detected flag falls
through to its plain default for Vinci. The ONLY compat steering Vinci gets is what
`vinci-provider.ts` sets EXPLICITLY. Forte pins the system-role behavior, OpenAI reasoning format,
`max_tokens`, session-affinity headers, and unsupported strict/store capabilities instead of relying
on those defaults. Any
future wire quirk specific to the Vinci gateway has to be added to `vinci-provider.ts`'s own
`compat` block — Pi's detection table has zero built-in knowledge of it and never will, since it's
keyed on a domain string that isn't ours.

## Module 5 — AgentSession's Own Job

Module 2 already covered `AgentSession` as the thing that installs tool hooks and subscribes to
the `Agent`'s event stream. This module is what it does WITH those events: persistence, compaction,
and settings — plus the three different "modes" it can be handed to.

**Sessions are a TREE, not a log — this corrects a natural assumption.** Every session is an
append-only JSONL file (`SessionManager`, one file per session under a per-project directory in
`~/.pi/agent/sessions/...`, named `${timestamp}_${sessionId}.jsonl` — the exact files read all
week with Python one-liners). But `SessionManager.branch(branchFromId)` (`session-manager.ts:1289`)
means the file isn't a straight line: editing an old message, retrying, or forking creates a NEW
branch from an earlier entry — nothing is ever overwritten or deleted. `getBranch(fromId?)`
(`session-manager.ts:1189`) walks from a given leaf back to the root and returns the linear PATH
that constitutes "the current conversation" as seen from that leaf. Every place that says "walk the
branch" (compaction's boundary check, the de-groove pass) is walking one path through this tree, not
the whole file.

**Compaction, exactly.** Two functions matter:
- `shouldCompact(contextTokens, contextWindow, settings)` (`compaction/compaction.ts:225`) — the
  entire trigger predicate is one line: `contextTokens > contextWindow - settings.reserveTokens`.
  `reserveTokens` defaults to 16384 (`getCompactionReserveTokens()`, `settings-manager.ts:771`).
  **This is precisely why yesterday's 64k operating-window patch works**: bozza's `contextWindow`
  is now 65536 instead of the true 131072, so compaction fires once real usage crosses
  `65536 - 16384 = 49152` tokens — instead of waiting until ~115k on the untruncated window, by
  which point (per that session's own data) the model was already visibly duller.
- `findCutPoint(entries, startIndex, endIndex, keepRecentTokens)` (`compaction/compaction.ts:392`)
  — walks BACKWARDS from the newest entry, accumulating an estimated token count (a conservative
  chars/4 heuristic, `estimateTokens`) until it exceeds `keepRecentTokens`, then snaps to the
  nearest valid turn boundary. Everything older than that cut gets summarized via a model call
  (`generateSummary`, `compaction/compaction.ts:565`, using `SUMMARIZATION_SYSTEM_PROMPT`);
  everything newer stays verbatim. `keepRecentTokens` is exactly the value PATCHES §7 scales down
  for small context windows — and the summary itself isn't just prose: it tracks structured
  `readFiles`/`modifiedFiles` sets across compaction boundaries (`CompactionDetails`), so the model
  doesn't lose track of what it's touched just because the conversation got summarized.

**Settings are one surface, ~56 getters deep** (`settings-manager.ts`) — compaction knobs, retry
policy, steering/follow-up mode (`"all"` vs `"one-at-a-time"` queued-message delivery), transport,
theme, default provider/model, and more. `VINCI_SETTINGS` (PATCHES §6) is a Vinci-side filter over
WHICH of these ~56 surface in the `/settings` UI — the settings themselves are all still live and
respected underneath, just not shown.

**Three modes consume the same `AgentSession`**, all under `coding-agent/src/modes/`:
- `interactive/interactive-mode.ts` — the TUI (everything in Module 7).
- `print-mode.ts` — `pi -p "..."` (text) and `pi --mode json "..."` (the event-stream firehose
  used for every headless probe all week — its output IS the `AssistantMessageEvent` union from
  Module 4, printed one JSON object per line).
- `rpc/rpc-mode.ts` + `rpc/rpc-client.ts` — a newline-delimited-JSON RPC server/client pair for
  driving a coding-agent process programmatically. **This is the exact `RpcClient` class
  `vinci-crew.ts` imports at module scope** to launch every background helper — a "helper" is a whole
  second `coding-agent` process, in its own snapshot worktree, driven over this RPC protocol, not some
  lighter-weight in-process abstraction. It inherits main's active provider/model. Its patch is
  retained only after verifier replay and reconciliation policy; no worktree failure can fall back to
  main's cwd.

## Module 6 — The Extension System

Every `vinci/extensions/*.ts` file exports one function, `(pi: ExtensionAPI) => void`. That single
object — `ExtensionAPI` (`extensions/types.ts:1159`) — is 100% of the surface area `vinci/` has to
influence Pi. Two capability families, nothing else:

**Family 1 — `pi.on(event, handler)`, 24 hook types.** Grouped by what they observe:
- *Session lifecycle:* `session_start`, `session_info_changed`, `session_before_fork`,
  `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`,
  `session_tree`, `project_trust`, `resources_discover`.
- *The model call itself:* `context` (rewrite `AgentMessage[]` before `convertToLlm` — Module 2
  step 4), `before_provider_headers`, `after_provider_response`.
- *The agent/turn/message lifecycle:* `before_agent_start` (rewrite the system prompt — this is
  the ENTIRE mechanism `vinci-character.ts` and `vinci-memory.ts` use to inject their text),
  `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`,
  `message_end`.
- *The tool lifecycle:* `tool_call` (before execution — can `{block}`), `tool_result` (after
  execution — can rewrite the result), `tool_execution_start/update/end` (render-only, no
  blocking power).
- *Misc:* `model_select`, `thinking_level_select`, `user_bash`, `input` (fires on every submitted
  user message, before agent processing).

**Family 2 — `pi.register*`.** `registerTool` (a `ToolDefinition`, Module 3), `registerCommand`
(a `/slash` command), `registerShortcut` (a keybinding), `registerFlag` (a new CLI flag),
`registerProvider` (a whole `ProviderConfig` — this is `vinci-provider.ts`'s entire job),
`registerMessageRenderer` / `registerEntryRenderer` (custom rendering for a `CustomMessage`'s
`customType`).

**`ExtensionContext` (the `ctx` every handler and tool `execute()` receives)**
(`extensions/types.ts:302`): `ui`, `mode`, `hasUI`, `cwd`, `sessionManager` (read-only),
`modelRegistry`, `model`, `isIdle()`, `signal`, **`abort()`**, `hasPendingMessages()`,
`shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`. `ctx.abort()` is precisely
where the validated deferred turn-stop calls into — it's the SAME abort path as pressing Esc, just
triggered programmatically from inside a hook instead of a keypress.

**The dispatch mechanism, and a load-bearing detail most people wouldn't guess:**
`emitToolCall()` (`extensions/runner.ts:894`) iterates `this.extensions` **in the order they were
loaded** — which is the literal order of `--extension` flags in `vinci/bin/vinci` — and for each
extension's `tool_call` handlers, in order. **The instant any handler returns `{block: true}`, it
returns immediately** — extensions registered LATER never see that call at all. A handler that
returns a mutation WITHOUT `block` lets dispatch continue, and later handlers see the mutated
event ("later `tool_call` handlers see earlier mutations," per the type's own doc comment). This
means **`--extension` flag order in `bin/vinci` is a real priority list, not a formality.**
Concretely, today's order is `vinci-guard.ts` → `vinci-scope.ts` → `vinci-loopbreak.ts` — so a
catastrophic-command block from `guard` fires before `scope`'s drift check or `loopbreak`'s
fixation ladder ever run on that same call. Sensible as an order, but nothing enforces it
declaratively — reordering those three flags would silently change which safety net gets first
refusal on a given call. Worth knowing before anyone touches that file.

**The real map — every `vinci/` extension against what it actually uses**, verified by grepping
the files directly rather than from memory:

| Extension | Hooks | Registers |
|---|---|---|
| `vinci-provider.ts` | `message_end` | Provider |
| `vinci-character.ts` | `before_agent_start` | — |
| `vinci-memory.ts` | `before_agent_start` | Command, Tool |
| `vinci-plan.ts` | `before_agent_start`, `input`, `session_start`, `tool_call` | Shortcut, Tool |
| `vinci-guard.ts` | `tool_call`, `tool_result` | Command |
| `vinci-scope.ts` | `input`, `tool_call` | Tool |
| `vinci-loopbreak.ts` | `agent_start`, `input`, `message_end`, `tool_call`, `tool_result` | — |
| `vinci-undo.ts` | `tool_call`, `turn_start` | Command |
| `vinci-render.ts` | `agent_start`, `agent_end`, `message_end`, `session_start`, `session_shutdown`, `tool_call` (observation-only — tracks burst state, never blocks) | Tool |
| `vinci-compact.ts` | `session_before_compact`, `session_compact` | — |
| `vinci-crew.ts` | `agent_start`, `session_start`, `session_shutdown` | Command, Tool |
| `vinci-autoname.ts` | `agent_end`, `input`, `session_start` | — |
| `vinci-header.ts` | `session_start` | — |
| `vinci-preview.ts` | `session_shutdown` | Command |
| `vinci-council.ts` / `vinci-advisor.ts` / `vinci-orchestrate.ts` / `vinci-review.ts` / `vinci-todo.ts` / `vinci-search.ts` | — (pure tools, no lifecycle hooks) | Command/Tool |

**The closing insight, and it's the one worth carrying forward:** `vinci/` cannot reach INTO the
agent-core loop and change its control flow directly — no extension can skip a turn, rewrite the
provider dispatch, or alter the tool-execution order from first principles. Every single thing
Vinci does is one of exactly two shapes: *react* to something the loop was already going to do
(a hook, possibly blocking or mutating), or *offer* something the model/user can choose to invoke
(a registered tool or command). That constraint is WHY the thin-fork strategy works at all — the
whole product is additive because the extension surface was designed to make additive the only
option.

## Module 7 — The TUI

**The component model is deliberately minimal.** `Component` (`tui.ts:64`) is nearly the whole
contract: `render(width: number): string[]` — given a terminal width, produce an array of
already-ANSI-colored lines. Plus optional `handleInput(data)` for focused input, and `invalidate()`
to drop cached state (called on theme change or a forced repaint). That's it. Every visual thing in
Vinci — a tool call header, a diff, the header hero, the footer — is something implementing this
one method.

**`Container` (`tui.ts:256`) implements `Component` itself** and holds a list of child components,
rendering by concatenating their outputs. This is plain recursive composition — and
**`TUI extends Container`** (`tui.ts:295`): the entire screen is the ROOT of the exact same
component tree every extension's `addChild()` calls build into. There's no separate "app frame" vs
"content" distinction at the type level.

**Primitive components** (`tui/src/components/`): `Box` (padding + optional background function —
the exact primitive `tool-execution.ts` uses for panels, and what passing `undefined` as the bgFn
argument removes), `Text`, `Spacer`, `Image` (inline terminal graphics, kitty/iTerm protocols —
what the header logo and the crew-helper avatars use), `Markdown`, `SelectList` (the `/model`
picker, todo-style menus), `Editor` (the input box itself), `TruncatedText`.

**The render loop is request-based and diffed, not a fixed tick.** `requestRender()`
(`tui.ts:712`) sets a flag and schedules `doRender()` on `process.nextTick`, throttled by
`MIN_RENDER_INTERVAL_MS` so a burst of `text_delta` events during streaming collapses into far
fewer actual terminal writes than event count. It diffs against `previousLines` from the prior
paint rather than clearing and redrawing the whole screen — `requestRender(force=true)` is the
escape hatch that resets that diff state for a genuinely full repaint (theme switch, resize).

**The theme system** (`interactive/theme/theme.ts`) is a `Theme` class built from a JSON file —
`vinci/themes/vinci-{dark,light}.json` are exactly this format, validated against
`theme-schema.json` (a CLOSED set of named tokens — no adding arbitrary new ones, which is why
§18's diff-row-tint patch had to REPURPOSE the freed `toolSuccessBg`/`toolErrorBg` tokens rather
than invent new ones). Two-tier: `vars` (raw hex, e.g. `"sage": "#B8C5B0"`) then `colors` (named
roles pointing at a var name, or a literal hex, or `""` for "terminal default background" — the
mechanism §17 uses to remove panels entirely). `theme.fg(color, text)` / `theme.bg(color, text)` /
`theme.bold()` / `theme.inverse()` wrap ANSI codes around a string, auto-downgrading truecolor hex
to a 256-color approximation (`hexTo256`) when the terminal doesn't report truecolor support.

**The extension-facing UI surface is `ctx.ui`** (`ExtensionUIContext`, referenced from Module 6's
`ExtensionContext`), and this is where several Vinci features live entirely:
- `setHeader(factory)` — a factory returning a `Component`; this is `vinci-header.ts`'s WHOLE
  mechanism for the branded welcome screen. No core patch, just this one call on `session_start`.
- `setWorkingMessage(message)` / `setWorkingIndicator(options)` — the active-model working line and
  pulsing-dot animation; `vinci-render.ts`'s narration-in-the-working-line
  feature is a `setInterval` calling `setWorkingMessage` with the model's own latest text, every
  second, while a turn streams.
- `setToolsExpanded(expanded)` — the collapsed-by-default tool output Vinci ships (a non-programmer
  doesn't want every `grep` dump on screen; ctrl+o still expands one).
- `requestRender()` — extensions can force a repaint directly when they've mutated something a
  component reads outside the normal event flow.

**Closing the loop on two patches from this week, now with the exact mechanism named:** PATCHES
§17 (tight spacing, no panel background) works because `Box`'s constructor takes an optional
`bgFn: (text: string) => string` — passing `undefined` under `VINCI_CODE` means the panel simply
never calls `theme.bg()` on its content. PATCHES §18 (diff row tints) works because `diff.ts`'s
`vinciDiffRow()` wraps an ALREADY `theme.fg()`-colored line in `theme.bg()` a second time — text
color and background color are independent ANSI codes, so a red-foreground removed-line can also
sit on a red-background row without conflict; that's not a special trick, it's just how terminal
color codes compose.

## Module 8 — The Risk Map

The 20 patches aren't random — they cluster into five architectural bug classes, each pointing at
one layer from Modules 1–7. Grouping them shows the PATTERN, and the pattern is what predicts
where the next untested bug lives.

**Class 1 — wire-truthfulness (Module 3/4: the message/tool protocol, the compat layer).**
§15 (dropped `isError`), §20 (double-encoded arguments). Root cause: Pi was built and tested
against Anthropic's Messages API and real OpenAI — both well-behaved. The
`openai-completions`-via-third-party gateways are the corner nobody stress-tested, because until
Vinci, nobody was really living there. `thinkingFormat` and token-field behavior must be explicit
and live-tested against every new Forte occupant. The current GLM 5.2 contract pins those fields in
the CLI and gateway; the remaining risk is transport drift during a future config-only occupant swap.

**Class 2 — loop/repetition defense (Module 2/6: the extension hook system layered over an
agent-core loop that has NO concept of "stuck").** §7, §8, §19. Frontier models rarely loop; every
defense here compensates for something upstream doesn't need to solve, which means it was designed
and tuned against ONE small demo repo's failure modes, not a professional programmer's actual
workflow. **A concrete, previously unflagged risk found while writing this:**
`vinci-loopbreak.ts`'s fixation counter (`callKey(tool, input)`, `IDENTICAL_LIMIT = 3`) is keyed
ONLY on tool name + arguments — NOT on the result. An `edit`/`write` call resets it, but nothing
else does. So three `bash: npm test` calls in a row with the SAME command and DIFFERENT output —
polling for a background rebuild, checking whether a flaky test reproduces, re-running something
with a real side effect — reads identically to a stuck loop, because the detector never looks at
whether anything changed. Contrast this with `vinci-degroove.ts`, built one day later: its
signature explicitly includes normalized RESULT content, so it only ever collapses rounds that
were ACTUALLY identical outcome-for-outcome.

**RESOLVED 2026-07-10** (this was the first improvement acted on after the walkthrough):
`vinci-loopbreak.ts`'s `tool_result` hook now records each call's last result and, when a repeated
call returns a DIFFERENT result, deletes its fixation count so the ladder restarts — a `bash: npm
test` polled while output changes no longer reads as a loop. Deliberately conservative (any
difference counts as progress; only ever makes the blocker MORE lenient; the turn ceiling +
turn-stop still backstop a true runaway), and safe because a blocked call skips `afterToolCall` in
agent-core (`agent-loop.ts:487` immediate-branch) so `lastResultSig` only ever holds real tool
output, never a fixation block's own steer text. Units cover changing-output-never-trips,
identical-output-still-trips, and intervening-change-resets.

**Class 3 — small-model behavioral steering (Module 6: `before_agent_start`, the character
pack).** §16 (drop "Be concise"). This entire day optimized narration and warmth for someone who
can't read code. **A professional programmer will experience the exact same behavior as noise**:
"Let me see how the login page handles errors" before every read is exactly what Claude
Code/upstream Pi deliberately DON'T do, for good reason — a programmer wants dense, terse output,
not a running monologue. There is currently NO user-facing toggle for narration verbosity
(`VINCI_SETTINGS` trims `/settings` to theme only). This isn't a bug, it's a product-fit gap: if
Vinci ever serves programmer users too, "narrate everything" needs to become a settable dial, not
a constant.

**Class 4 — deliberate scope restriction (Module 6: the `/model`/`/login`/`/settings` filters).**
§1, §4, §5, §6. A programmer who already has their own Anthropic/OpenAI keys and wants Vinci's
narration/loop-defense/UX layer WITH a stronger model has no path to that — `/model` is hard-
filtered to `provider === "vinci"`. Deliberate, documented, correct for the current product —
but worth naming explicitly, because it's the single most likely thing a technical evaluator
files as "broken" when it's actually "by design." If Vinci ever opens up to power users, this is
the first wall they hit.

**Class 5 — the OS sandbox and guard extensions (Module 1's third safety layer, `vinci-sandbox.ts`
+ `vinci-guard.ts`/`vinci-scope.ts`) — not core patches, but the least-tested surface for a
professional workflow.** The sandbox confines bash WRITES to "the project + its workspace parent."
A professional programmer's actual habits routinely fall outside that boundary and have never been
exercised against it: a monorepo tool that writes to a workspace root ABOVE the parent (Turborepo/
Nx caches, a root-level `pnpm-lock.yaml` regeneration), a symlinked or content-addressable package
store (pnpm's global store lives outside both the project and its parent on most setups), Docker
builds needing broader mounts, or a genuinely multi-repo refactor touching a THIRD sibling
directory two levels up. None of today's testing exercised any of these — the demo repo is a
single small monorepo with no external tooling reaching outside its own tree. This is the highest-
value place to run one deliberate stress test before calling Vinci "production ready" for
programmer use: pick a real, larger, professionally-tooled repo and watch what the sandbox
silently blocks.

**The one-sentence summary of the whole day, now grounded in eight modules of real architecture:**
every bug found was Pi's reasonable assumption — a well-behaved wire, occasional loops, a developer
audience — breaking against Vinci's actual conditions (a custom managed gateway, model occupants that
can change behind Fort, and a non-programmer audience); the fixes make the harness tell the truth
independently of model quality. The same lens — "what does this layer assume, and who's the first user
to violate it" — is exactly how to keep finding the next one.
