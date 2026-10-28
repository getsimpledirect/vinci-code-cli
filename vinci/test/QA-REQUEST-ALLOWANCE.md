# Bounded owner QA request allowance

This opt-in harness guard needs a new, explicit operator approval before live QA. A file,
account credit balance, cost estimate, previous approval, or test pass grants no spending authority.
Do not reuse George's completed 10-call allowance. Dollar estimates and actual billing are separate;
this implementation enforces a request ceiling, not a dollar ceiling.

Set `VINCI_TOOL_BOOTSTRAP=0` explicitly in offline owner-QA launch environments. An allowance path
also disables tool provisioning before transport, even when bootstrap is enabled or the allowance
has not yet been armed. This includes direct downloader calls. Use already installed fd/ripgrep or
record their unavailable functionality; a model-request allowance never authorizes binary downloads.
Offline mode also disables provisioning regardless of bootstrap opt-in, for direct, installed and
helper launches. Existing cached/PATH tools remain usable. Only non-offline, non-QA core consumers
can bootstrap pinned tools; they can opt out with `VINCI_TOOL_BOOTSTRAP=0`.

Before any native QA that can copy a link, select terminal text or paste an image, the owner must
privately preserve their clipboard or explicitly manage its replacement themselves. Keep contents
out of evidence. Do not attempt historical recovery or substitute another clipboard mechanism after
an OS denial. Record owner confirmation before mutation, and leave clipboard cases untested when
that prerequisite is missing. Likewise, an OS-denied process inspection leaves cleanup unverified;
ask the owner to close the identified fixture normally without an alternate process inspection.

After approval, an operator initializes one new absolute allowance path outside the disposable
model workspace using `initializeQaRequestAllowance` from
`packages/coding-agent/dist/core/qa-request-allowance.js`. Its configuration is:

```json
{
  "schemaVersion": 1,
  "id": "unique-approval-receipt-id",
  "maxRequests": 10,
  "expiresAt": "REPLACE_WITH_APPROVED_EXPIRY",
  "allowedOrigins": ["https://qa.invalid"],
  "allowedModels": ["forte"]
}
```

The invalid expiry and synthetic origin above must be replaced only from that approval.
The initializer refuses to overwrite files. Set `VINCI_QA_ALLOWANCE_FILE` to that path in the
isolated CLI environment. Keep HOME, XDG config and the agent directory isolated as in the owner
QA packet; finish sign-in before arming unless its HTTP origins/attempts are also explicitly allowed.
Keep the configuration, `.state.json` and `.closed.json` together as evidence. Never reset, delete,
restore an earlier copy, or automatically recover a stale `.lock`. Stop and review an uncertain run.

The CLI installs an Undici dispatch interceptor before providers load. Each managed HTTP attempt
reserves and fsyncs a slot before transport, including SDK retries, foreground calls, grader/scope
calls, crew children inheriting the environment, auth and metadata. Counting non-model HTTP requests
is deliberately conservative. Errors, timeouts, response IDs, stream cancellation and missing
responses never refund. Atomic exclusive creation serializes reservations between processes;
contention fails closed. The durable state binds to the authorization's complete configuration hash,
not a task/session ID, and is checked on every attempt. Restarts do not replenish it.

Both compatibility stream APIs, Models dispatch, provider factories and the Vinci OpenAI completion
client check admission before provider execution. This mode admits only the listed Vinci models
using `openai-completions` and listed HTTPS origins. Unarmed AI consumers with the allowance
environment set fail closed. A replaced managed global fetch, changed configuration, invalid or
missing state, unknown origin, exhausted ceiling, expired or closed allowance blocks requests.

The top-level completion receipt closes on DONE or DONE_UNVERIFIED; a helper's completion or a
WAITING receipt does not independently renew or close the parent's authorization. Closure writes
a durable independent tombstone even if a reservation lock is held. Explicit revocation uses
`new QaRequestGuard(path).close("revoked")`. Closure blocks new reservations; already reserved or
in-flight work can finish. After a completed run, another task requires a newly approved allowance.

This is a bounded harness for trusted Vinci-managed HTTP on one machine and a local filesystem.
It is not an OS network sandbox, a signed spending token, semantic enforcement of which task a
prompt describes, or protection from arbitrary shell tools, hostile extensions, direct native
sockets/SDKs, replacing the dispatcher or editing/restoring the counter files. Crew's managed RPC
children inherit the same path; external launchers must propagate it and install the guard.
Do not claim a machine-wide or adversary-resistant cap. Independent review and a newly approved
isolated live retest remain release gates.

Offline evidence: `test/qa-request-allowance.test.ts` uses network-disabled MockAgent and real SDK
retry/stream code, independent child processes, and a no-transport CLI startup probe.
`packages/ai/test/qa-request-admission.test.ts` checks both public APIs and registry dispatch.
These synthetic completions establish routing/counting behavior, not real-model task quality.
