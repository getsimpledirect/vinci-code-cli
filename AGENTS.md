# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- `packages/tui` does NOT use vitest — it uses the Node built-in runner (`node:test`). Vitest against a tui test file reports `No test files found, exiting with code 1`, which looks like a broken runner but is just the wrong tool. Run tui tests with `npm test -w @earendil-works/pi-tui`, or a single file with `cd packages/tui && node --test test/specific.test.ts`. Every other package (`agent`, `ai`, `coding-agent`) uses vitest.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Commit headers and PR titles use `type(scope): description` (optional scope; optional `!` before `:` for breaking changes), at most 100 characters, without emojis. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `revert`. Scopes are lowercase area names, such as `vinci`, `worker`, `provider`, `release`, `updater`, `ai`, `tui`, `agent`, `coding-agent`, `orchestrator`, or `deps`; hyphens and `/` separators are supported. The activated Husky hook checks new local commits; PR titles follow the convention during review. Historical upstream messages are not rewritten or checked. Generated Git merge/revert and valid autosquash messages remain supported locally. See `CONTRIBUTING.md` for explicit hook setup after an install with scripts disabled.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for which layer a change belongs in, the quality bar, and PR expectations.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/getsimpledirect/vinci-code-cli/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/getsimpledirect/vinci-code-cli/pull/456) by [@username](https://github.com/username))`

## Releasing

Vinci Code does **not** release the way upstream Pi does. Pi publishes npm packages under
`@earendil-works/*`; Vinci ships a signed binary. Do not run `npm run release:*`,
`npm run publish`, or `scripts/publish.mjs` - they target upstream's npm scope.

A release is cut by pushing a protected `vinci-v*` tag, which triggers
`.github/workflows/vinci-release.yml`:

1. **build-and-verify** - refuses any tag that is not `vinci-v*`, checks the tag matches the
   built identity, packages an unsigned payload, and runs the offline harness against the
   packaged artifact.
2. **publish** - carries the *tested* payload forward (never a rebuild), assumes the release
   role via OIDC, signs the tested archive, uploads the immutable artifact write-once,
   verifies the staged object and the signed manifest, and publishes the manifest last as
   the single activation point.

Clients verify updates against the pinned public key in `vinci/updater/public-key.pem`.

Release notes live in `vinci/release-notes/` and are mirrored to the public
`getsimpledirect/vinci-code-releases` repository.

Signing-key handling and the operational runbook are documented in the internal ops
repository, not here.

### Cutting a release

The product version is authoritative in `vinci/identity.json`; the header and packaged launcher
read it. UI snapshots render that version and must be regenerated and reviewed:

1. Branch `release/vinci-v<version>` off `main`.
2. Prepare maintained user-facing notes outside the clean release checkout, then run
   `node vinci/scripts/prepare-release.mjs <version> --notes-file <path> --dry-run`.
   Run again without `--dry-run` to update only the product identity, copy the notes, and regenerate
   UI snapshots. The helper checks both local and live remote tags for a spent version; it does not
   commit, tag, push, or publish. Root and Pi package versions retain their own namespaces.
3. Review every changed UI frame. To repair a partial preparation, rerun the `ui-scenarios` command
   from `vinci/test/run.sh` with `UPDATE_VINCI_UI_SNAPSHOTS=1`, using its root-or-workspace Vitest
   resolution and exclusions.
   Confirm the intended version and UI state in each frame; do not use a stale
   snapshot count as evidence that nothing else changed.
4. Review the copied `vinci/release-notes/<version>.md`. If preparation fails, the helper leaves its
   partial diff for review and names the failed step; repair that step without resetting other work.
5. Run `npm run check`, the offline harness, and the exact packaged-launch gates. After explicit
   release authorization, merge, annotate-tag the reviewed public commit, and push the tag.

`build-and-verify` asserts the tag matches `vinci/identity.json`, so a tag pushed before the
bump merges will fail.

**Release tags are protected and immutable.** They cannot be moved or deleted. Tagging the
wrong commit burns that version - cut the next one instead. `vinci-v0.0.52` was spent this
way, which is why 0.0.51 and 0.0.52 exist as tags with nothing published under them.

### When a release appears to succeed but ships nothing

Both jobs are gated on `if: github.repository == '<owner>/<repo>'`, which makes forks
structurally inert. A skipped job reports **green**, so a guard naming a stale repository
produces a passing run that builds, signs and publishes nothing. That state persisted across
two versions unnoticed. Before believing a release shipped, check the artifacts, not the
checkmarks:

- `gh release list` - the new version should be `Latest`
- the live manifest should carry the new `version` and a fresh `publishedAt`
- the `.tgz` at the manifest's `artifact.url` should return 200

If `publish` fails at *Assume the release role* with `Not authorized to perform
sts:AssumeRoleWithWebIdentity`, the role's trust policy rejected the token. Do not guess at
the claim shape - read what was actually presented:

```
aws cloudtrail lookup-events --region <region> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 1 --query 'Events[0].CloudTrailEvent' --output text
```

`userIdentity.userName` is the literal `sub` GitHub sent. This organization has GitHub's
immutable-identifier subject claim enabled, so that subject embeds numeric org and repository
ids (`repo:<owner>@<id>/<repo>@<id>:environment:<env>`) rather than names. A trust policy
written in the `repo:<owner>/<repo>:...` form can never match it, whichever name it carries.
The id form is rename-proof, which is the point.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
