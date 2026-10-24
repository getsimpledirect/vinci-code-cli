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
npm install --ignore-scripts
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

## Commit messages and PR titles

Use `type(scope): description`, with an optional lowercase scope and `!` before `:` for a
breaking change. Headers are at most 100 characters, without emojis. Types are `feat`, `fix`,
`docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, and `revert`. Use an area scope such as
`vinci`, `worker`, `provider`, `release`, `updater`, `ai`, `tui`, `agent`, `coding-agent`,
`orchestrator`, or `deps`; scope names may use hyphens or `/` separators.

For example: `fix(worker): preserve partial output` or `ci: check packaged imports`.
The activated Husky `commit-msg` hook checks new local commits; PR titles follow the convention
during review. Generated Git merge/revert messages and valid `fixup!`, `squash!`, and `amend!`
messages remain supported locally. This does not validate or rewrite historical upstream commits.

An install with `--ignore-scripts` does not initialize Husky. To activate the repository hooks,
run this explicit setup command from the repository root:

```sh
node node_modules/husky/bin.js
```

This configures the repository's local `core.hooksPath`, which also applies to its worktrees.
To check a message file directly, run `node scripts/check-commit-message.mjs <message-file>`.

## Preparing a Vinci release

On a clean `release/vinci-v<version>` branch created from current `main`, prepare maintained
user-facing notes outside the checkout and run:

```sh
node vinci/scripts/prepare-release.mjs <version> --notes-file <path> --dry-run
node vinci/scripts/prepare-release.mjs <version> --notes-file <path>
```

The helper checks local and live remote tags, updates the authoritative `vinci/identity.json`,
copies notes to `vinci/release-notes/<version>.md`, and runs the existing UI snapshot scenarios.
Review every changed frame and the notes, then run the documented checks and open a release PR.
A failed snapshot step leaves a reviewable partial diff and reports the failed step.

Vinci, root and Pi package versions are separate. The helper does not commit, tag, push or publish.
After the release PR merges and release authorization is granted, the maintainer tags the reviewed
public commit; the protected workflow signs and publishes the exact tested artifact. See
[`AGENTS.md`](AGENTS.md#cutting-a-release) for the release checks and immutable-tag rules.

## Reporting bugs and vulnerabilities

Bugs: open an issue. Security issues: **do not** open a public issue — see
[`SECURITY.md`](SECURITY.md).

## Code of conduct

Participating here means agreeing to the [Code of Conduct](CODE_OF_CONDUCT.md).
Concerns go to conduct@getsimpledirect.com, which is read privately.
