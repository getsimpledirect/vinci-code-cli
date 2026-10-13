# Vinci Code handoff

## Repository roles

Product source, tests, versions, issues, pull requests and releases belong in the public `getsimpledirect/vinci-code-cli` repository. The private `vinci-code` repository remains the private operations and historical reference home. Its product release and manifest rollback workflows were disabled and read back as `disabled_manually` on 2026-10-13 UTC. Other operations workflows retain their enabled configuration; this is a configuration measurement, not evidence of running workloads. Keep private history, operational payloads and credentials private.

George authorized public consolidation and the next product release, and requested matching README/AGENTS routing in the private repository. He reserves the protected `vinci-release` environment approval for his workflow click. Do not approve that deployment on his behalf, move an immutable release tag, overwrite a versioned archive, or change update trust roots.

## Source checkpoint

Checkpoint: 2026-10-13T22:03:30Z, owned public branch `codex/handoff-consolidation-20261013`, [PR #91](https://github.com/getsimpledirect/vinci-code-cli/pull/91). Ten implementation/documentation commits through `1d4ed46f471ef2233cd03abdf77fe0c261c511c2` are pushed. All six required current-head CI contexts passed, including offline Node 22 and Node 24. The PR has not merged at this checkpoint; the real-provider negative controls described below require a further correction before release.

Pinned source references: public base `f839dce66ddfb1f87aab612a62a3ef2c1d907476`; private product `vinci` at `7eb30ac1f9172b9c9b71bcf5bfc8a5217b69896e`; private Pi mirror `main` at `244f1deaf1ae0fc1a242d9df5cddf457cf3d36a7`; approved marketing assets at `ee968ae96f32856ae25925779d2b44ffc5f2f7f8`.

The generated migration audit and the remaining-delta review give every selected row a disposition. Images and prompt-whitespace handling are ported with real input-hook regressions; public publishing references and workflow guards are reconciled. Private token/permission plumbing is rejected. Historical private release notes stay private. Product 0.0.55 and fresh user-facing notes are prepared separately after consolidation; root 0.0.3 and Pi 0.80.3 remain separate namespaces. Private operations remain maintained in their existing home, so archival is deferred.

Public dependency lockfiles, undici 8.10.2 and selected Forge security bytes are preserved. Private history and its historical operational key were not imported. The shared grading API change is additive. Source checks do not establish hosted Work admission, independent receipt-signature trust or remote cancellation.

Retained PR decisions: public [#72](https://github.com/getsimpledirect/vinci-code-cli/pull/72) needs downstream ownership for its unwired resolver; [#86](https://github.com/getsimpledirect/vinci-code-cli/pull/86) is superseded and awaits maintainer closure; [#87](https://github.com/getsimpledirect/vinci-code-cli/pull/87) supplied selective sanitized changes and must not be merged wholesale over newer public security. Private protocol/export PR review evidence remains private. This task does not claim those PRs were closed.

## Exact development archive

The clean macOS Node 22.19.0 candidate is unsigned product 0.0.54, archive SHA-256 `f4c45baa900a4db91f22b442b01a01f15a0dff61d426f1c15498e9ef06e551b5`, 15,682,644 bytes, 9,074 file/link entries and zero AppleDouble headers. These numbers come from the package producer, native tar listing and Python tar metadata on 2026-10-13 UTC. Its embedded source is clean `1d4ed46f471ef2233cd03abdf77fe0c261c511c2`, with input digest `98bee8b61acea5dc01a44e6b846d4f43996105feb04976e131d364adffc448a1` over 610 selected inputs. Do not relabel it as built from a later documentation or correction commit.

The artifact's actual launcher printed 0.0.54. Native imports of all 66 compiled extension/helper modules, five relative workspace aliases, 12 approved PNG/SVG hashes, 123 legal-notice files, Runtime CLI/SDK consumer controls and paired native source-data-denial startup passed. All 9,074 extracted file/link bytes, modes and targets matched the unchanged archive, with no unexpected files. Native denial permits ancestor metadata and the verified Node executable; it refuses source data through paired real consumers. Its startup reply uses a faux provider, separately from subscription calls. Legal-byte preservation does not grant artwork rights.

A prior archive contained 10,159 AppleDouble regular headers that native macOS tar handled transparently but Python extraction materialized as files. Its bytes are preserved; the selected new archive was created with `COPYFILE_DISABLE=1` and both consumers agreed on the file count. The production tar invocation now sets that variable directly; the next committed-source package must qualify the default without an outer override.

## Measured checks

At this checkpoint:

- Full `npm run check` passed all eleven required checks under a freshly constructed Node 22.19.0 environment. The tracked pre-commit script was run explicitly because ignore-scripts setup had not created Husky's generated dispatcher.
- Fresh Node 22 upstream `./test.sh` passed at 2026-10-13T21:56:21Z: agent 176 passed; AI 463 passed and 746 skipped; coding-agent 1,736 passed and 50 skipped; TUI completed successfully without a numeric summary. The initial fresh run failed 33 coding-agent fixtures because offline mode suppressed mocked update paths and the empty profile lacked fd. The corrected instrument used the actual pinned fd downloader/find consumer and an owned fixture Git boundary; all 33 then passed. This is macOS agent evidence, separately from CI.
- Actual image-input hook passed 13/13 in three fresh trials; the original helper failed the eight intended whitespace cases in each trial.
- Request-scope and verifier/grader consumers passed 41/41 in three Node 26 trials and one Node 22 trial. Original-parser controls reached the intended completed-failure assertion in all four trials.
- Actual workflow-shell conditional manifest controls passed 9/9 on Node 22 and Node 26. Removing the conditional PUT argument failed the concurrent-writer assertion; the unchanged positive passed again. These controls use local command fixtures and a generated test key, not production AWS activation.
- Actual path consumers accepted the selected useful model patch 16/16; pre-fix consumers failed the two intended sibling cases. Vero state/protocol and interactive UI controls passed, with reviewed terminal viewports and unchanged state snapshots.
- Secret scanning covered all ten pushed commits with no findings at the October 13 checkpoint.

An earlier complete Node 26 offline exact-archive harness passed at 2026-10-13T20:13:45Z. The current Node 22 full offline harness is held for the final-report correction and a new clean source-bound candidate. Do not use older-archive or different-environment results as its substitute.

Ignored evidence retains earlier fixture failures, the corrected short TMP/Git ceiling, worker readiness/signal controls, a rejected contaminated archive and an excluded clock-discontinuity sample. The final worker fixture passed 52/52 in three timing-admissible trials without changing production worker code. Process-bound idle-sleep prevention is used; no persistent power setting changed.

## Real-provider qualification

The selected clean archive requested `openai-codex` / `gpt-5.5` / medium with George's authorized private subscription profile. One read-only verification run completed its ordinary TODO/review flow: 16/16 named tests passed, the scoped diff check passed, independent review returned ships and recognized that the patch predated the request. Reopening that same durable session faithfully retained those results and completed. Both calls had zero canonical protocol errors, unchanged four selected file hashes and unchanged Git state. Served model identity and authoritative billing remain unqualified.

Two failing-patch controls exercised an isolated tiny Git fixture and the actual named Node spec reporter. The first recorded 7/8 passing with the intended sibling failure and kept a needs-work assessment/exit 3, but appended false claims about making an edit and having no automated test. The second independently reviewed the actual failure as needs-work, then automatic plan recovery prompted an unauthorized repair despite the explicit read-only request. Only that isolated fixture changed; it is not a successful read-only negative control.

The measured causes are the static-project fallback and repair recovery's missing request constraint. Source correction qualified at 2026-10-13T22:13:10Z through actual final hooks (63/63), existing review integration (30/30) and session/grader consumers (43/43), each in one admissible fresh Node 22 trial. The failed read-only assessment retains needs-work, normal/failed state, a completed behavioral check, zero mutations/recoveries and exit 3; TODO still independently grades and refuses a subsequent valid-schema repair attempt. A new repair-authorized request restores normal recovery. Genuine static edits without an attempted check retain their manual-check note. These source controls still require a fresh committed package and real-provider negative qualification before merge.

Earlier useful coding runs produced the adopted formatter patch and two regression files but encountered two distinct encrypted-item errors. No measured adapter defect justified rewriting opaque reasoning, disabling thinking or stripping protocol items. The clean positive/reconnect above is narrow successful replay evidence, not proof that every earlier protocol failure is resolved.

## Remaining release checkpoint

Merge reviewed consolidation only after the correction and current checks pass. Prepare `release/vinci-v0.0.55` from merged public `main`: bump the authoritative product identity, regenerate and inspect every changed UI frame, add user-facing release notes, and run the required checks and exact packaged-launch gates. Preserve root/Pi versions. Merge through protections, annotate-tag the reviewed public commit once, and let the release workflow build and test its own exact archive. Give George the actual Actions run URL when build-and-verify passes and publish waits for his approval click.

At the previous live-manifest verification on 2026-10-13 UTC, production was signed version 0.0.54, sequence 43. That manifest's artifact hash/size were verified signed claims, not a complete production archive download/execution measurement. After approval, measure the new signed manifest, served exact artifact and GitHub release before claiming publication.

Gateway smoke, operator-selected Work/private fixtures, physical Kitty/iTerm image decoding, true child-session continuation/worktree semantics, hosted Work admission and remote compute/billing termination remain unqualified. Local RPC cancellation was independently observed with durable aborted state and no tools/project changes; it does not establish remote termination.

Implementation and evidence live in the owned public worktree. Reusable source/tests/docs are committed to the intended repository; credentials, runtime snapshots, captures and archives remain ignored. Owned processes and temporary directories must be cleaned before final handback; retained extraction leases are tracked in ignored evidence until their owner releases them.
