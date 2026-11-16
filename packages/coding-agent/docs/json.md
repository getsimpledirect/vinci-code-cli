# JSON Event Stream Mode

```bash
pi --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating pi into other tools or custom UIs.

## Exit Codes

- `0`: The provider transport succeeded and the persisted task outcome is final (`DONE` or `DONE_UNVERIFIED`).
- `1`: The provider transport, stream, abort handling, or liveness watchdog failed.
- `2`: No prompt was provided.
- `3`: The provider transport succeeded, but the persisted task outcome is non-final (`BLOCKED` or `WAITING`).

Transport failures and missing prompts take precedence over an extension-declared task outcome.

For Vinci tasks, scripts must receive exit `3` after a required write is refused, with or without
a closing ask for a go-ahead. This contract changes the no-ask case from exit `0` to exit `3`;
the ask case retains exit `3`. A question without an unresolved required operation can still be
`WAITING`. Text mode (`-p`) follows the same task-outcome exit contract.

## Event Types

Events are defined in [`AgentSessionEvent`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts#L102):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Base events from [`AgentEvent`](https://github.com/earendil-works/pi-mono/blob/main/packages/agent/src/types.ts#L179):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_hooks_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

`tool_hooks_start` is emitted between a tool's execution settling and its result-finalization hooks.

## Message Types

Base messages from [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts#L134):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts#L29):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

### Secret masking

With secret masking on (`VINCI_CODE=1`, as every Vinci run sets it), every string in the stream is masked, after terminal control strings and sequences (including DCS, APC and PM strings) and carriage returns are removed as the interactive view removes them. Bodies arrive at block or result end: intermediate `text_delta` and `thinking_delta` events carry an empty `delta`, the partial message keeps each text or thinking block at its last released state (empty until the block ends), and one delta carrying the whole masked body precedes `text_end` / `thinking_end` (or `done` / `message_end`, when a message that ended normally has no block end). With masking on, a block cut by an error, an abort or the length limit keeps its complete lines (masked) and ends with a placeholder for the unfinished part. (The complete lines are those no later text could still change; an open key block, an open `${` or an open angle value, an assignment value a later line could still extend (an environment lookup not yet closed, or a value a chained call could follow) and trailing lines a later END marker or a later line of an encoded run could claim stay in the placeholder.) A text or thinking block cut before its end in any other way (the run ends, is stopped, or a new message starts) is written as the placeholder `‹redacted›`, never as the masked text so far. The final events (the `error` event, `message_end`, `turn_end`, `agent_end`) show a cut block exactly as the stream wrote it. The session file and the interactive view are unchanged. Tool-call argument deltas are released in one delta when the call ends. `tool_execution_update` events are still emitted with an empty `partialResult`; the masked output arrives in `tool_execution_end`. The latest partial result of each tool call is kept: when the tool's end result does not carry all of it (its text within the end's text and its details and other fields equal, compared masked; an error-only result, for example), or the tool never ends (the run ends, or it is stopped), it is written once more as one `tool_execution_update` before that end. It never reached its end, so it is written as the placeholder `‹redacted›` with empty details, never as its masked text.

A held body (a text or thinking block, a tool call's argument text, a tool's partial result) is held for at most 1 MiB (1,048,576 bytes) and 10 minutes from its first held byte. The bytes are the UTF-8 bytes kept for that body: a block's text, a call's argument text, or a partial result's whole event (details, other strings and control bytes included). The deadline is checked on every event; a silent stream holds until the next event or the end. At either bound the body is written at once as the placeholder `‹redacted›`, never as a prefix; nothing more of that body is kept or written while it streams. Clients that need the complete text read the final message, which still carries the whole body, masked, when the block reached its own end (a block that never did is shown there as the stream wrote it).

A tool call that ends without its `toolcall_end` (an abort, an error, a cut stream, or a bound) shows, in the final events, each argument value that may have been cut as the placeholder, whole; no part of such a value is kept. String, Number and Boolean objects (from any realm) are written as their own values, read without calling an own `valueOf`. With masking off, events are written as they occur.

## Example

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
