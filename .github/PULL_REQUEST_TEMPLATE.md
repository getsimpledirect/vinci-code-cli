<!--
Most of packages/ is upstream Pi. If your change belongs upstream, send it to
https://github.com/badlogic/pi-mono instead - see CONTRIBUTING.md. Not sure?
Open an issue and ask; that costs a comment, guessing wrong costs a rewrite.
-->

## What this changes

<!-- One or two sentences. What was wrong or missing, and what does this do about it? -->

## Why

<!-- Link the issue if there is one: Fixes #123. If there is no issue and this is
     more than an obvious fix, say what prompted it. -->

## Layer

<!-- Tick one. -->

- [ ] `vinci/` - the Vinci layer
- [ ] `packages/**/vinci-*.ts` - a Vinci change inside an upstream package
- [ ] Something else in `packages/` - **this probably belongs upstream, see CONTRIBUTING.md**
- [ ] Docs, CI, or tooling only

## Checks

- [ ] `npm run check` is clean - errors, warnings and infos alike
- [ ] `./test.sh` passes (not vitest directly; it filters the e2e tests that need provider keys)
- [ ] Added a test for anything that could regress. Issue-specific regressions go in
      `packages/coding-agent/test/suite/regressions/` as `<issue-number>-<short-slug>.test.ts`
- [ ] Added a `## [Unreleased]` entry to the affected package's `CHANGELOG.md`
- [ ] No `package-lock.json` changes, unless the lockfile change is the point of this PR
- [ ] No emojis in commits, title, or comments

## Anything reviewers should know

<!-- Trade-offs you weighed, alternatives you rejected, parts you are unsure about.
     Saying "I am not sure about X" is useful, not a weakness. -->
