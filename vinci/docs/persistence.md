# Session Persistence

What the session JSONL guarantees, what it deliberately does not, and why. Ruled 2026-08-03
(issue #38). Read this before proposing durability, framing, or checksum work — the cheap version
was chosen on purpose.

## The Format

One JSON object per line. The first line is the session header; every subsequent record carries a
`__vinci_record_start` framing marker. Records are appended with `appendFileSync`; an existing
valid session file is never rewritten in place.

**The file is strict JSONL and must stay that way.** `vinci/scripts/report-wrong.mjs`,
`packages/coding-agent/src/migrations.ts`, HTML/JSONL export, and the process-resume tests all
parse lines with a bare `JSON.parse`. Anything that appends a checksum suffix, a binary frame, or
any non-JSON text to a line breaks every one of those consumers at once.

## What Is Guaranteed

- **Process-kill survival.** `appendFileSync` returns after the data is in the page cache, so a
  `SIGKILL` — including the CLI being killed mid-turn — does not lose already-appended records.
  The kernel writes them out regardless of what happens to the process.
- **Truncated-tail detection.** A kill *during* a write leaves a partial final line. The framing
  marker makes that detectable rather than ambiguous: the loader classifies it as
  `truncated_tail` (versus `malformed_line` for damage mid-file).
- **Recovery, not refusal.** `loadSessionFile` streams the file, skips unreadable records, keeps
  every valid record before and after the damage, and reports what it skipped via
  `getParsingErrors()`. A corrupt tail costs you the tail, not the session.
- **Disclosure.** A resumed session that skipped records says so in the TUI (#169). Silent
  shortening was the actual user-facing defect behind #38.
- **Fail-closed verification.** When corruption is newer than the newest valid verification
  snapshot, the shared scanner returns `terminal-unverifiable` rather than trusting stale state.

## What Is Deliberately Not Guaranteed

- **Power-loss / kernel-panic durability.** No write path calls `fsync`. Adding one would put a
  disk flush on a path that fires on every message, tool result, checkpoint, and extension entry —
  a permanent latency cost on every turn — to protect against an event whose worst case is losing
  the last few seconds of one conversation. If this is ever wanted, the honest design is a
  session-boundary flush, not per-append.
- **Detection of silent, syntactically-valid corruption.** There is no checksum or sequence chain,
  so a record whose bytes were altered but still parse as valid JSON is undetectable. This is bit
  rot / deliberate tampering, not a failure mode the product has encountered.
- **Concurrent writers.** **One writer per session file.** `report-wrong.mjs` appending to a
  *closed* session is supported; appending to a live one is out of contract. Two `SessionManager`
  instances on one file hold independent in-memory snapshots and will diverge.

## Changing This Contract

The framing already catches what a kill actually produces, and the disclosure gap is closed. Before
adding fsync, checksums, or a sidecar, bring a concrete incident that the current contract failed to
handle — the format's raw-JSONL compatibility is load-bearing for four consumers and is not worth
spending on a hypothetical.
