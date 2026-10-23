# Minimal draft integration recommendation

Source inspected at commit `ee913a3406459110224b06d84440e57372b06707` in getsimpledirect/vinci-code-cli. The relevant fetched file blobs matched the default-branch reads on 2026-10-21. See EVIDENCE.md. This is not proof of installed client version or production model route.

## Proposed draft PR only

Add this pack under `vinci/workflows/security-review/` with its existing directory structure. Do not edit upstream `packages/`, core guards, provider routing or any owner branch. Add a short link from `vinci/README.md` to the workflow README identifying it as an unpublished/experimental opt-in review workflow. Keep source evidence snapshots in the review packet; the eventual PR can use EVIDENCE.md links rather than duplicate upstream source files.

The existing documented convention supports `--prompt-template <path>`, project `.pi/prompts/*.md` only after project trust, global `~/.pi/agent/prompts/*.md`, and explicit settings/package paths. Use an explicit opt-in file first, not a globally installed template:

```text
vinci --prompt-template /absolute/reviewed/path/vinci/workflows/security-review/prompts/security-review.md
```

This is a future qualified-client launch shape, NOT an offline validation command and NOT executed by this pack. It may start updater/bootstrap/provider behavior. The operator must complete route/security review before launching against private code. Once verified loaded, the filename convention would expose `/security-review <approved-scope-file>`. No such command is claimed installed today.

Do not use `/security`: it already reports active confidentiality and sandbox controls. Do not override `/review`: existing extensions use it for change grading. A prompt cannot enforce read-only or prevent network/model export. Do not treat natural-language scope as an execution sandbox. A stronger future integration needs enforced per-tool capabilities, immutable route binding and independent acceptance, in a separately reviewed implementation.

## Owner gate before PR implementation/distribution

1. Confirm active CLI owner, any concurrent security-workflow writer and exact target head. Search of open issues containing security returned no results, which is not proof of vacancy. Parent has a separate dependency inventory effort and source-to-shipped security audit; do not duplicate either.
2. Review this prompt/contract and retain no automatic installation, activation or hosted source transmission.
3. Add specific prompt-discovery/expansion test using existing faux-provider harness. Assert no collision with /security or /review, no source export on unknown route, and no active tools on this read-only task. This pack has not implemented runtime enforcement.
4. Validate exact CLI build, existing guard behavior and actual managed route. Managed class labels are not model identity. The source still documents GLM 5.2 for its internal DeepInfra qualification lane, while the user reports newer hosted GLM models. Resolve that difference with current runtime evidence, do not change model routing in this PR.
5. Follow repository AGENTS.md: focused offline harness, no live-provider suite, no credentials, no commit/merge/release without appropriate approval. All security product claims require separate evidence review.

This pack builder made no GitHub write. George subsequently asked the parent to open PRs; the parent owns review and draft-PR creation, not this child.
