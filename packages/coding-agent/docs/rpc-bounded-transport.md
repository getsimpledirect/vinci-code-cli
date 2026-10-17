# Bounded Vinci RPC transport (Q2)

This is an additive **opt-in** for the existing `RpcClient`, not a worker or a new
orchestrator. Existing clients retain their startup/wire tolerance and inherited
environment defaults. `get_protocol` is a side-effect-free additive server command;
old clients need not issue it. Bounded clients require `{ version: 1 }` and reject
an old, incompatible or unresponsive peer before `start()` succeeds.

```ts
const client = new RpcClient({
  cliPath: reviewedEntryPoint,
  cwd: isolatedWorkingDirectory,
  completeEnv: true,
  env: explicitlySelectedEnvironment,
  boundedTransport: {},
});
await client.start();
```

`completeEnv` uses exactly the supplied environment instead of merging the parent
environment. It uses the current executable to avoid PATH lookup in that mode;
the caller must select and qualify its actual Node runtime. This is environment
hygiene, not a filesystem, network, process or credential-isolation boundary.
No production caller is enabled by this patch.

## Default bounds

- Negotiation deadline: 5 seconds. Ordinary request timeout remains 30 seconds.
- Frame and queued stdin bytes: 4 MiB each. LF framing is mandatory, including
  the final record. CRLF and Unicode separators inside strings remain supported.
- Retained stderr: 64 KiB. Bounded mode does not mirror raw stderr to the parent.
- Pending requests, event waiters and outstanding UI dialogs: 128 each.
- Event collection: 10,000 events or 16 MiB. Streaming listeners need not collect.
- Shutdown: TERM, wait up to 1 second, KILL, wait up to 1 second. Failure to confirm
  direct-child exit is an error, not successful cleanup. Repeated stop calls share
  the same teardown. Child streams are destroyed after confirmed exit.

Each bound can be overridden with a positive, finite safe integer through
`boundedTransport`. These are resource limits, not model token budgets.

Malformed/wrong-shaped envelopes, response-command mismatches and oversized
frames/stderr fail the transport and settle outstanding requests/waiters. Unknown,
duplicate or late response IDs never settle another request or become progress
events. Top-level response collections and lifecycle fields are checked; nested
model, tool-result and extensible session payloads are not a universal JSON schema
validator or independently accepted work evidence.

`onUIRequest` receives correlated extension dialogs separately from progress.
`respondToUI` requires an outstanding matching dialog ID and a method-appropriate
explicit reply. There is no automatic approval. Advertised dialog timeouts retire
the local ID without sending any reply. The server remains authoritative about
its earlier timeout or cancellation; a stale response is not permission to act.

## Qualification boundaries

Q2 tests use local synthetic child processes, a synthetic parent-only environment
sentinel, and the real built RPC server dispatcher with a synthetic session. No
provider, model, paid call, installed AWS worker, host credential, deployment or
customer data is used. The real-dispatcher test requires `bash vinci/build.sh`
first, as do existing CI build/check jobs.

Direct-child exit is not descendant-tree cleanup. The existing worker's process
group/lease-loss handling must remain in place when Q3 integrates this client.
Durable cancellation, restart authority, root-budget admission, permission policy,
artifact acceptance and cross-host recovery remain separate tasks. `agent_end`
and exit zero do not imply accepted task completion.
