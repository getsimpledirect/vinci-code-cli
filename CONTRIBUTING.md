# Contributing to Vinci Code

Contributions are welcome. This is a small project, so a short note about how it works
will save you time.

## Know which layer you are changing

Vinci Code is a **thin fork of [Pi](https://github.com/badlogic/pi-mono)** (MIT). The split
matters for where your change belongs:

| You are changing | Where it goes |
|---|---|
| Vinci behaviour — guard, receipts, checkpoints, BYOK, branding | `vinci/`, or an env-gated patch in `packages/` |
| The agent engine, tools, TUI, provider runtime | **upstream Pi** — send it there, we will pick it up |

Anything general enough to help every Pi user is better contributed upstream. We track Pi
closely and rebase often, so an upstream fix reaches Vinci users anyway — and stays fixed,
instead of becoming a patch we carry forever.

Upstream's own contributing guide is kept at
[`vinci/UPSTREAM-CONTRIBUTING.md`](vinci/UPSTREAM-CONTRIBUTING.md) for reference; it is Pi's
policy, not ours.

## Before you open a PR

```sh
npm install
bash vinci/build.sh          # the offline build — no external catalog refresh
npm run check                # biome, tsgo, lockfile gates, secret scan
bash vinci/test/run.sh       # the full harness
```

`npm run check` must pass. It includes a **secret scanner** over staged content — if it flags
a test fixture that is a deliberate look-alike, mark that line rather than weakening the
scanner:

```js
const FAKE = "sk-ant-TESTONLY-aaaa…";   // pragma: allowlist secret
```

🔴 **Never commit a real credential, not even to a test.** This repository has done it once —
a live API key sat in a masking fixture for four days in July 2026 — which is exactly why the
scanner exists.

## What makes a change easy to accept

- **A test that fails without your change.** Not a test that merely covers the area — one
  that goes red if the change is reverted. If you are fixing a guard or a filter, revert it
  locally and confirm a named test fails.
- **Feed the off-canonical case.** A pattern pinned to one exact input passes its own tests
  and still fails open. This is not hypothetical here: BYOK key patterns were first written
  with exact lengths and leaked any key a single character longer, with a fully green suite.
- **Say what you did not verify.** A PR that states its limits is easier to trust than one
  that implies completeness.

## Style

TypeScript, tabs, biome-formatted (`npm run check` fixes formatting). Match the file you are
editing. Vinci-layer patches inside `packages/` are marked `[vinci]` in a comment and gated on
an env var, so upstream merges stay clean — follow that convention.

## Reporting bugs and vulnerabilities

Bugs: open an issue. Security issues: **do not** open a public issue — see
[`SECURITY.md`](SECURITY.md).
