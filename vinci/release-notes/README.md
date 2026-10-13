# Public release notes

One file per shipped version, named for that version: `0.0.36.md`, `0.0.37.md`, …

The sole product publisher is [getsimpledirect/vinci-code-cli](https://github.com/getsimpledirect/vinci-code-cli).
Its `vinci-release` workflow uses `vinci/release-notes/<version>.md` as the canonical GitHub Release
body when present, and falls back to generated notes otherwise.

The workflow also mirrors the user-facing notes to the existing public tracker,
[getsimpledirect/vinci-code-releases](https://github.com/getsimpledirect/vinci-code-releases).
That tracker is a notes mirror; installable artifacts and signed updates come from the canonical
publisher. A missing notes file skips mirroring with a warning.

## Why these are written by hand

Generated notes list merged pull requests. The maintained notes explain what changed for the
person using Vinci Code, in the language they would use:

> Copying is easier. `/copy` puts Vinci's last message, code block, or command output on your
> clipboard, so you don't have to select it in your terminal.

not

> feat(copy): add vinci-copy.ts with OSC 52 fallback (#112)

Skip anything a user can't observe — refactors, test coverage, internal renames.

## Setup this depends on

Publishing to the other repository needs a token with `contents: write` on
`getsimpledirect/vinci-code-releases`, stored as the `PUBLIC_RELEASES_TOKEN` secret. The workflow's
own `github.token` is scoped to this repository and cannot write to another one.

If a note exists but the token is unavailable, mirroring reports an error. If the note is absent,
mirroring reports a warning and exits cleanly. Check current GitHub configuration and read the
published mirror back before claiming mirroring works; historical configuration is not evidence
about the next run.

The step is `continue-on-error`, so none of this can undo a release: by the time it runs, the
signed artifacts are already uploaded. It fails loudly so the misconfiguration is visible, not so
it blocks shipping.
