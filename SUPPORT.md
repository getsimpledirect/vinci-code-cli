# Support

Where to go depends on what you have.

## Something is broken

Open an issue on this repository using the **Bug report** template. Include the
version (`vinci --version`), your OS, what you did, what happened, and what you
expected instead.

You can also file one without leaving the terminal:

```
/issue
```

Credentials are redacted before anything is sent.

## A bug in Pi itself

Vinci Code is a distribution of [Pi](https://github.com/badlogic/pi-mono).
Everything under `packages/` is upstream's, except the `vinci-*` files. A bug in
Pi's engine affects Pi's users too, so it is better reported upstream, where a
fix reaches everyone — and it reaches us on the next sync.

If you cannot tell which applies, **open it here** and we will route it. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the layer split.

## A security vulnerability

**Do not open a public issue.** Follow [`SECURITY.md`](SECURITY.md), which routes
to GitHub Security Advisories or `security@getsimpledirect.com`.

## Feedback you would rather not make public

```
/feedback
```

Sends private feedback without uploading your transcript.

## Questions about your account, billing, or the managed service

These are not repository matters — use
[Vinci support](https://vinci.getsimpledirect.com/support?source=code).

## Response expectations

This is maintained by a small team. Issues and pull requests are read, but not
always quickly. Silence on a thread is a queue, not a verdict — feel free to
ping it.

There is no LTS branch: fixes land in the latest release, and the remedy for a
bug in an older version is to upgrade.
