# Secrets: what Vinci hides, and what it can hand back

Vinci replaces secrets with placeholders before they reach the model, so a real credential is
never painted across your screen and never written into a session file. Two kinds of secret get
two different treatments, and the difference is the whole design.

## A secret Vinci read is a dead end

Anything Vinci obtains by reading — a `.env`, a diff, tool output — is replaced with a bare
sentinel:

```
API_KEY=<vinci-secret>
-----BEGIN PRIVATE KEY-----<vinci-private-key>
```

Nothing turns that back into a value. It is a hole in the model's view, not a reference to
anything. The model has no business round-tripping a value it only saw because it opened one of
your files, so every channel refuses it: `write` and `edit` refuse content containing it, and
the shell refuses a command carrying it.

That refusal exists because the alternative is worse than an error. A command built from the
masked view — `curl -H "Authorization: Bearer <vinci-secret>"` — is a syntactically valid
command that sends a literal placeholder to a real endpoint and comes back 401. It reads like a
broken API rather than a masked view. Refusing it up front says what actually happened.

The model is told, in its system prompt, that its view is masked, so it reports honestly instead
of claiming the placeholder is your file's real content.

## A secret you typed is a handle

A credential you type or paste is a different object: you supplied it so that Vinci would use
it. Erasing it to the same dead sentinel means you cannot hand Vinci a working credential at
all. So your input mints a **handle** instead:

```
you type:    curl -H "Authorization: Bearer sk-live-abc..."
model sees:  curl -H "Authorization: Bearer <vinci-secret-a1b2c3d4>"
shell runs:  curl -H "Authorization: Bearer sk-live-abc..."
```

The model still never sees the value. It sees a name it can carry around, and the real value is
substituted back at the moment the command runs. Three limits, deliberately:

- **Shell only.** `write` and `edit` still refuse handles, so a credential is never written to
  disk on the model's initiative.
- **Only what you typed.** A secret Vinci read stays a bare sentinel and stays unresolvable.
- **Visible.** Vinci tells you which handles it restored into a command, naming the handles and
  never the values.

A handle that names nothing — a bare sentinel, or an id the model invented — is refused rather
than guessed at.

The vault holding these lives in memory for one session, is cleared when the session starts, and
never touches disk. Handle ids are random rather than derived from the value; deriving them
would make a handle a verifiable oracle for a low-entropy secret. Because substitution happens
after the model has spoken, on the argument object the tool is about to execute, the transcript
and the session file keep the handle rather than the value.

## Working on this

Four invariants are load-bearing and each is easy to break without any test going red. All four
were found by mutation control rather than by review.

**The handle id joins with `-`, not `:`.** A colon puts the substring `secret:` inside the
sentinel, which the masker's own assignment matcher reads as a secret assignment and re-masks —
nesting one sentinel inside another and destroying the handle.

**`KNOWN_SENTINEL` must know the handle form.** The outgoing provider payload is re-redacted in
full on every turn, so a handle meets the masker again constantly. An unrecognised handle in
assignment position (`API_KEY=<handle>`) is re-masked down to a bare sentinel and dies after one
turn. The `Bearer <handle>` shape does **not** exercise this — `<` falls outside the scheme
pattern's character class, so it is skipped for an unrelated reason and looks like it works.

**Substitution must happen before the network grant is signed.** The grant is an HMAC over the
command body. Signing the handle form and substituting afterwards voids the grant and silently
costs the command its network access.

**What runs is what gets classified; what the model wrote is what gets displayed and stored.**
The risk of a command is a property of the text that executes, and a handle is not inert to a
classifier. The always-allow store is written to disk and keyed on the command, so keying it on
the restored command writes a live credential into that file, where it outlives the session the
vault is scoped to.

A related trap sits one layer out: extension `input` handlers **chain**, each seeing the previous
handler's transformed text, and the session expands slash commands and prompt templates after all
of them. No extension ever sees the text that is finally delivered. Any extension correlating an
`input` event with a later `message_start` by comparing message text is broken by construction —
reconcile against session state instead.

Extensions import the built package, not `src`. Rebuild before testing a change to the shared
masker, or the test runs against the previous build and its result means nothing.
