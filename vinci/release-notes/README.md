# Public release notes

One file per shipped version, named for that version: `0.0.36.md`, `0.0.37.md`, …

At release time the `vinci-release` workflow looks for `vinci/release-notes/<version>.md`. If it
finds one, it publishes that text as the release body in the **public** tracker,
[getsimpledirect/vinci-code-releases](https://github.com/getsimpledirect/vinci-code-releases). If
there is no file for the version, the step is skipped and the release proceeds normally — writing
notes is optional, and forgetting to never blocks a release.

## Why these are written by hand

The GitHub Release cut in *this* repo uses `--generate-notes`, which lists merged pull requests and
links to them. Those links point at a private repository: they 404 for everyone outside the org, and
they expose internal PR titles. They are useful to us and useless — or worse — to a user.

So the public notes are a different document with a different audience. Write what changed **for the
person using Vinci Code**, in the language they'd use:

> Copying is easier. `/copy` puts Vinci's last message, code block, or command output on your
> clipboard, so you don't have to select it in your terminal.

not

> feat(copy): add vinci-copy.ts with OSC 52 fallback (#112)

Skip anything a user can't observe — refactors, test coverage, internal renames.

## Setup this depends on

Publishing to the other repository needs a token with `contents: write` on
`getsimpledirect/vinci-code-releases`, stored as the `PUBLIC_RELEASES_TOKEN` secret. The workflow's
own `github.token` is scoped to this repository and cannot write to another one.

Until that secret exists the step logs why it skipped and does nothing else. Releases are unaffected.
