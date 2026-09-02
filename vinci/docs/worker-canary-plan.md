# Worker release-and-canary plan (release artifact, one clean canary)

Lane ws-c-worker, 2026-09-02. Authority: George's ruling msg_72d4330e section C (Workstream C) and his
`production_deploy` decision msg_326acf79 point 4 ("the canary after #48 merges installs from the
RELEASE ARTIFACT, not a checkout"). This document PREPARES; George or the deploy authority
(Workstream D consumer) EXECUTES. Nothing here was run by ws-c-worker. Hard limits observed: no
deploy, no SSM/aws, no restart, no release publishing, no npm publish, no merge.

State this plan starts from (verified 2026-09-02 ~21:30Z):

- PR getsimpledirect/vinci-code-cli#48 head `5145860e1f974b7151a0edd18bbfe24fb3d0c5ba` on base
  `0f7404d77fde08a2d8fa2511f9bfd2a213f1af60`; round-4 exact-head review requested (msg_da11676f).
  SPLIT fallback: draft PR #50 at `cf196e63c211c8faa36ef3df18d514076001284e` (1 commit on main).
- Installed-artifact evidence on both heads: `bash vinci/package.sh` tarballs carry 21 `vinci/worker/*`
  entries; install.sh + updater into an isolated VINCI_HOME reaches `vinci worker: Usage: vinci worker start ...`;
  tag vinci-v0.0.51 control has 0 worker entries and dies in node's module loader.
- Live beta manifest: version **0.0.52**, sequence **41**, published 2026-08-28T20:51Z, artifact
  `vinci-code-0.0.52.tgz` sha256 `f631123f…`. This repo's `vinci/identity.json` still says 0.0.51.
- `.github/workflows/vinci-release.yml` runs only when `github.repository == 'getsimpledirect/vinci-code'`.
  In THIS repository (`getsimpledirect/vinci-code-cli`) it was **skipped** on tags vinci-v0.0.50
  (run 32927642543) and vinci-v0.0.51 (run 33200015411). The 0.0.50 GitHub Release here was hand-made.
  The private sibling `getsimpledirect/vinci-code` is where the live 0.0.52 manifest came from.
- Worker build identity from a PACKAGED install is `{ version, commit: null, source: "package" }`
  (`vinci/worker/build.mjs`); the online post will say `worker_build=<version>`, not a 40-hex sha.
  The sha binding therefore comes from the release chain (tag → identity → signed manifest → tarball sha256),
  not from the worker's own post. See "Receipt fields".

## 0. Blockers this plan cannot clear itself (owner / unblock / pivot)

| # | Blocker | Owner | Unblock | Pivot if not unblocked |
|---|---|---|---|---|
| B1 | Release workflow is inert in vinci-code-cli (repository guard + OIDC trust + `vinci-release` environment + `VINCI_RELEASE_ROLE_ARN` var exist for `getsimpledirect/vinci-code` only). Credentials/protection = slow loop. | George (credentials) via Workstream B | Either (R1) extend the IAM trust `ref`/repo condition and the environment to vinci-code-cli and change the guard to accept both repos, or (R2) port the merged commit to getsimpledirect/vinci-code and tag there. | R2 is the <24h fallback: it needs no credential change, only a mirrored commit; the vinci-code-cli merge remains the reviewed source of truth and the port must be byte-identical for `vinci/`. |
| B2 | #48 round-4 verdict pending (msg_da11676f). | ws-e-review | REVIEW-ENVELOPE v1 on the bus. | New-class BLOCK → promote draft #50; closed-class BLOCK → descendant fix on #48. |
| B3 | Version collision: 0.0.52 is already live and its S3 key is write-once. | fast loop (ordinary) | Bump to **0.0.53** in `vinci/identity.json` AND `vinci/extensions/vinci-header.ts` (`VINCI_VERSION`), on the release branch (the tag check refuses a mismatch). | none needed |
| B4 | Merge needs a non-builder, non-asker exact-head GO (G-7); vinci-code-cli main has NO branch protection today (Workstream B is adding it). | codex-coordinator / Workstream B | GO envelope on the exact merge head. | Do not merge on a LEGACY review. |

## 1. Cut the release after 0.0.51 from the merged head

1. Merge #48 (or #50 if split) into main via the App path (Workstream B) once the GO envelope names the exact head.
2. Release branch `release/vinci-v0.0.53` from the merged main head: bump `vinci/identity.json` `version` → `0.0.53`
   and `vinci/extensions/vinci-header.ts` `VINCI_VERSION = "0.0.53"`; optional `vinci/release-notes/0.0.53.md`
   (one paragraph: "vinci worker ships in the tarball"). Merge it (same review rule; docs+version only → narrow CI class).
3. Tag the merged head: `git tag vinci-v0.0.53 <merged-40-hex> && git push origin vinci-v0.0.53` — a HUMAN pushes the tag
   (human_required: true). Record `release_commit` = that 40-hex.
4. `vinci-release.yml` build-and-verify: `npm ci`, `bash vinci/build.sh`, `bash vinci/package.sh`, offline harness,
   then `packaged-artifact-check.mjs` + `packaged-runtime-probe.mjs` on the unpacked tarball (both already assert the
   worker dispatch reaches its usage path). Artifact `vinci-release-payload` is uploaded once; publish never rebuilds.
5. `publish` job (environment `vinci-release`, maintainer approval = the human click): sign the TESTED archive with
   sequence = live+1 (**42**), verify locally, upload `vinci-code-0.0.53.tgz` + `.sha256` write-once, verify staged,
   publish `manifest-beta.json` LAST, verify live bytes, `gh release create vinci-v0.0.53`.
6. Machine check after publish (anyone, read-only):
   `curl -fsSL https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/manifest-beta.json` → `signed.version == 0.0.53`,
   `signed.sequence == 42`, `signed.artifact.sha256 == <sha256 of release/vinci-code-0.0.53.tgz from the run>`.
   `tar -tzf vinci-code-0.0.53.tgz | grep -c '^vinci/worker/'` → 21 (plus any files added since).
   If B1 forced path R2, the release_commit is the vinci-code sha AND the receipt records the vinci-code-cli
   merge sha it mirrors, with `git diff --stat` between the two `vinci/` trees empty.

## 2. Canary host: a FRESH EC2 instance (proposed), not a worker box

Proposal: one fresh EC2 in ca-central-1 (profile sd-admin; same VPC/subnet/security group and instance
profile as worker:box-2 so it reaches the bus and the OpenRouter secret; Ubuntu 24.04, Node 22.x as the
boxes run, t3.large, ~USD 0.10/h), worker id `worker:canary-1`, running as an unprivileged user
`canary`, state dir `/var/lib/vinci-worker-canary` (fresh, empty).

Why a fresh host and not a clean VINCI_HOME on box-1/box-2:
- The boxes' daemons run as root from `/opt/vinci-code-cli` with `/usr/local/bin/vinci` (0.0.52) on PATH; the
  worker probes `vinci --version` on PATH for `vinci_binary`, so a second install on the same box either shadows
  the production launcher or reports the wrong binary. A fresh host makes the installed artifact the ONLY vinci.
- Finding 1 (msg_88e90800): box-1's shared `vinci-code-cli` tree is dirty NOW and 20 debris entries sit where main
  expects its provisioned ledger; the first task there FAILS with the debris-root refusal. A fresh state dir has no
  shared tree, so the one signed work order clones fresh and Finding 1 cannot fire.
- The chaos-gate preflight refuses on build skew between box-1 and box-2; a third worker on a box would either be
  excluded from the fleet file or break the gate's invariant. A separate host with its own id is inventory-clean.
- Rollback is total and instant: stop the unit and terminate the instance. Nothing on box-1/box-2 changes.
Cost of being wrong: none of the boxes' state is touched; if the canary misbehaves the bus shows it under
`worker:canary-1` only.

Install FROM THE RELEASE ARTIFACT (never a checkout), as user `canary`:

```
curl -fsSL https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/install.sh | sh      # verifies the signed manifest, sha256, embedded key
~/.local/bin/vinci --version                                    # MUST print 0.0.53
readlink ~/.vinci-code/current                                  # MUST end in versions/0.0.53
ls ~/.vinci-code/current/vinci/worker/worker.mjs                # MUST exist (the fix under test)
~/.local/bin/vinci worker --help; echo rc=$?                    # MUST print "vinci worker: Usage: vinci worker start ..." rc=1
sha256sum ~/.vinci-code/downloads/vinci-code-0.0.53.tgz 2>/dev/null || true   # if kept: MUST equal manifest signed.artifact.sha256
```

Daemon (systemd, per `vinci/worker/README.md` "Supervision"; unit file written by the human step):

```
ExecStart=/home/canary/.local/bin/vinci worker start --id worker:canary-1 --server <VGC_SERVER> --state-dir /var/lib/vinci-worker-canary --once
Environment=WORKER_ID=worker:canary-1 VGC_SERVER=<bus url> VINCI_WORKER_ALLOWED_PROVIDERS=openrouter
Environment=VINCI_WORKER_MODEL_CLASSES=@/etc/vinci-worker/model-classes.json     # {"quick":{"provider":"openrouter","model":"<cheap model>"}} — enables the digest form
# bus/Governor/OpenRouter/GitHub credentials: from the same secret store as the boxes; never in the unit text
```

`--once` bounds the canary to a single claim. Expected `online` post: `worker worker:canary-1 online` carrying
`worker_build=0.0.53` (packaged install: version, no sha — see identity note), `worker_version=0.0.53`,
`vinci_binary=0.0.53`, `server_build=<prod git_sha>`, `branch_lease=off`, `allowed_providers=openrouter`.
Daemon stderr must show `provider allowlist ENFORCED (openrouter)` and `terminal outbox -- attempted 0`.

## 3. One signed work order + the four observations

Dispatch, in this order, to `worker:canary-1` (budget cap USD 0.50 for the whole canary):

- **O1 clone refusal (negative control, no spend):** a legacy envelope with `provider: anthropic`. Expected: terminal
  `status` with `outcome=BLOCKED`, reason `provider_not_allowed`, task record has no repo dir and no session
  (no clone, no spawn). Proves the guard is reachable through the installed artifact.
- **O2 digest handoff + typed terminal (the signed work order):** a digest triple
  `{"work_order_id":…,"contract_digest":…,"execution_spec_digest":…}` served by the registry, `evidence: none`,
  model class `quick`, `baseCommit` pinned to a 40-hex on a small public repo. Expected: the task record carries
  `work_order_id`, `contract_digest`, `execution_spec_digest`, `base_commit`; every post's first token is
  `contract=<work_order_id>@<digest8>`; the terminal post carries `outcome=UNVERIFIED` (evidence none never COMPLETEs)
  and `worker_build=0.0.53`. Negative control for the digest path (no spend): the same triple with one hex digit of
  `contract_digest` changed → `BLOCKED contract_digest_mismatch` BEFORE any model spawn.
- **O3 outbox replay after an interruption:** restart the daemon (drop `--once`, keep the unit) and dispatch a second
  `quick` legacy task; when the session JSONL shows the outcome line (or after `kill_after_artifact_creation`'s
  point), cut bus egress on the canary host only (`iptables -I OUTPUT -d <bus ip> -j DROP`) so the terminal post
  fails. Expected: `/var/lib/vinci-worker-canary/outbox/` gains ONE record; daemon stderr names the outbox write.
  Restore egress, `systemctl restart`, expect stderr `terminal outbox -- attempted 1` and the terminal post
  appearing with the ORIGINAL task id and outcome. Rollback of the rule is `iptables -D OUTPUT ...`.
- **Deliberate canary mutation (Demo 2's last step):** after O1–O3 pass, replace `~/.vinci-code/versions/0.0.53/vinci/worker/worker.mjs`
  with the tag-0.0.51 state (delete it) and restart: expected the online post never appears / `vinci worker` fails in
  the loader; the deploy authority's auto-rollback must fire (`vinci rollback` → `previous` version, or instance
  terminate). This is the "deliberate canary mutation rolls back" evidence.

## 4. Receipt fields (machine-written; no human in the transaction)

`DEPLOYED` (one record):
`receipt=DEPLOYED`, `repo=getsimpledirect/vinci-code-cli`, `merge_sha` (40-hex of the merged PR head on main),
`release_tag=vinci-v0.0.53`, `release_commit` (40-hex the tag points at; must be `merge_sha` or its version-bump child),
`release_run_id`, `version=0.0.53`, `artifact_url`, `artifact_sha256` (from the signed manifest), `manifest_sequence=42`,
`manifest_signature_verified=true` (by `update.mjs verify-manifest` on the host), `canary_host` (instance id + region),
`install_method=install.sh`, `vinci_home`, `installed_version` (`vinci --version` output), `installed_worker_entry_present=true`
(`vinci/worker/worker.mjs` exists), `online_msg_id`, `worker_build`, `vinci_binary`, `server_build`, `at` (ISO-8601 UTC),
`attested_by` (server-stamped principal of the deploy authority; NOT a lane's self-declared name), `rollback_target`
(`previous` version or "terminate").

`OBSERVED` (one record, references the DEPLOYED record by `artifact_sha256` + `canary_host`):
`receipt=OBSERVED`, `deployed_artifact_sha256`, `canary_host`, `o1={task_id, terminal_msg_id, outcome=BLOCKED, reason=provider_not_allowed, no_clone=true, no_spawn=true}`,
`o2={work_order_id, contract_digest, execution_spec_digest, base_commit, task_id, terminal_msg_id, outcome=UNVERIFIED, first_token=contract=…, negative={task_id, outcome=BLOCKED, reason=contract_digest_mismatch, spawned=false}}`,
`o3={interruption_at, outbox_records=1, replay_stderr="terminal outbox -- attempted 1", replayed_msg_id, original_task_id_matches=true}`,
`mutation={mutated_file, symptom, rollback_receipt_id}`, `spend_usd`, `deviations[]`, `at`, `attested_by`.
Tier rule (vpp PR #2): OBSERVED must name the same artifact as DEPLOYED; a MERGED sha is never written as DEPLOYED.

`ROLLBACK` (written whenever the authority rolls back, mutation step included):
`receipt=ROLLBACK`, `from_artifact_sha256`, `to` (`previous` version + its sha256, or `terminated`), `trigger`, `at`, `attested_by`.

## 5. What ws-c-worker recommends as the sequence

1. B2 verdict → merge (#48 or #50) under G-7 → 0.0.53 bump → tag by a human → release run (B1 decides which repo; R1 preferred, R2 <24h fallback).
2. Fresh EC2 canary from the release artifact; DEPLOYED receipt; O1–O3; OBSERVED receipt; mutation + ROLLBACK receipt; terminate.
3. Independently and only under msg_326acf79: the bounded checkout canary on box-1/box-2 (see `worker-bounded-canary-runbook.md`),
   same-day rollback mandatory. The two canaries answer different questions (artifact ships the worker vs. main's typed contract on the boxes) and must not be conflated in the ledger.
4. Follow-up work order (not this PR): stamp a `build-identity.json` (commit, tree) into the package at `vinci/package.sh` time so a packaged
   install reports a 40-hex `worker_build` like a checkout does; until then the receipt's sha binding is the release chain above.
