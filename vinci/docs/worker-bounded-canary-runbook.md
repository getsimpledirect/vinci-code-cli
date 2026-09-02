# Worker bounded canary runbook (checkout path, boxes 1/2) — transcribed from msg_1da2556b

**Authorization.** George ruled `production_deploy` on 2026-09-02 in bus message **msg_326acf79**
(under autonomy-spine ruling msg_72d4330e section C): Option 1 of the worker deploy packet
(msg_50ba3e27 / msg_1da2556b / msg_88e90800) is authorized **only as the bounded canary** described
below — chaos gate run A on 604c428c, deploy per section 5 (D0–D4, box-2 first), acceptance A1–A4,
chaos gate run B, then **mandatory rollback to 604c428c the same day** via `restore_daemon`.
Finding 1 failures inside the window are counted in the ledger as the measurement, not repaired
in-window. Steady state is Option 2 (clean-room on, a `worker_feature` ask with the run A/B receipts
attached); Option 3 (debris-authority supervisor) is NOT authorized.

**Execution.** This runbook is executed by a **human-supervised step** (owner lane
projects-rc-worker executes; codex-coordinator assigns the independent observer of A1–A4). It is
NOT executed by lane ws-c-worker, which prepared this transcription under the hard limits
"no deploys, no SSM/aws commands, no restarts". Nothing below has been run by ws-c-worker.

**Scope note.** This is the CHECKOUT path (candidate main `0f7404d77fde08a2d8fa2511f9bfd2a213f1af60`
onto `/opt/vinci-code-cli`). It is distinct from the release-artifact canary in
`worker-canary-plan.md`, which msg_326acf79 point 4 requires for the post-#48 canary ("installs from
the RELEASE ARTIFACT, not a checkout"). msg_326acf79 covers the boxes' checkout path only for the
bounded canary below.

## George's decision, verbatim (msg_326acf79)

```
Decision by George, 2026-09-02, on packet msg_50ba3e27 / msg_1da2556b / msg_88e90800 (posted as kind handoff because the packet is a status thread with no ledger row to --ref; my principal on this post is the authority). Under autonomy-spine ruling msg_72d4330e section C.
1. Option 1 is authorized ONLY as the bounded canary the addendum describes: chaos gate run A on 604c428c, deploy per section 5 (D0-D4, box-2 first), acceptance A1-A4, chaos gate run B, then MANDATORY rollback to 604c428c the same day via restore_daemon. Finding 1 failures during the window are counted in the ledger as the measurement, not as defects to repair in-window.
2. Steady state is Option 2: amend F5 to turn clean-room mode ON (no shared trees; quarantineDirtyTree never called) once the chaos-gate evidence from step 1 exists. That amendment is a worker_feature ask; put it to the Governor with the run A/run B receipts attached.
3. Option 3 (build the debris-authority supervisor) is NOT authorized. Do not build it.
4. Per the autonomy-spine ruling section C, the canary after #48 merges installs from the RELEASE ARTIFACT, not a checkout. This decision covers the boxes' checkout path only for the bounded canary above.
Owner: projects-rc-worker executes; codex-coordinator assigns the independent observer of A1-A4.
```

## Sections 5–7 of msg_1da2556b, verbatim (D0–D4, rollback, A1–A4, five-row chaos canary)

```
== 5. EXACT COMMAND TEXT (per box, root via SSM, AWS-RunShellScript, region ca-central-1, profile sd-admin) ==
Instances: box-1 i-06272d1b9c0ff9826, box-2 i-021c9d7b662ec3e65 (chaos/fleet.example.json).
The chaos harness has checkout_daemon()/restore_daemon() but NO fetch builder; the candidate sha is not on
the box yet, so step D1 is hand-written and must run first.
  D0 preflight (read-only): git -C /opt/vinci-code-cli rev-parse HEAD  -> MUST print 604c428cc4907460059cf7eb0268f878c2873966
                            systemctl is-active vinci-worker-daemon; no task record in state RUNNING/PENDING
                            (grep -l '"state": *"RUNNING"' /var/lib/vinci-worker/tasks/*.json | wc -l -> 0)
  D1 fetch:      git -C '/opt/vinci-code-cli' fetch --quiet origin 0f7404d77fde08a2d8fa2511f9bfd2a213f1af60
  D2 checkout:   git -C '/opt/vinci-code-cli' checkout --quiet --detach '0f7404d77fde08a2d8fa2511f9bfd2a213f1af60'
  D3 restart:    systemctl restart vinci-worker-daemon ; sleep 2 ; systemctl is-active vinci-worker-daemon
  D4 verify:     git -C '/opt/vinci-code-cli' rev-parse HEAD  -> MUST equal the candidate sha
  (D2–D4 are exactly chaos.ssm_payloads.checkout_daemon('0f7404d7…') ; D1 is the missing prerequisite.)
Order: box-2 first (it has been silent since Aug 31 04:09Z and carries the worker_build_skew row), observe
acceptance A1–A3, then box-1. Chaos preflight refuses on build skew between boxes, so the gate can only run
with both boxes on the same sha (before: both 604c428c; after: both 0f7404d7).
ROLLBACK (exact, no ambiguity): chaos.ssm_payloads.restore_daemon('604c428cc4907460059cf7eb0268f878c2873966'):
  git -C '/opt/vinci-code-cli' checkout --quiet '604c428cc4907460059cf7eb0268f878c2873966'
  systemctl restart vinci-worker-daemon ; sleep 2 ; git -C '/opt/vinci-code-cli' rev-parse HEAD
Rollback leaves /var/lib/vinci-worker/outbox in place (harmless to the old build, which never reads it).
Nothing in this packet removes anything under /var/lib/vinci-worker.

== 6. ACCEPTANCE PER BOX (artifacts only) ==
  A1 new `worker <id> online` post whose body carries worker_build=0f7404d77fde08a2d8fa2511f9bfd2a213f1af60
     (40-hex, no -dirty, no -UNRESOLVED), worker_version=0.0.51, vinci_binary=0.0.52, branch_lease=off,
     allowed_providers=openrouter, and server_build=6495847ed7ac… (prod).
  A2 daemon stderr shows "provider allowlist ENFORCED (openrouter)" and "terminal outbox -- attempted 0".
  A3 one dispatched short-task (evidence: none, model quick, budget <= $0.15) reaches a terminal `status`
     post carrying outcome=UNVERIFIED and worker_build=<candidate>; console shows the typed badge (PR245).
  A4 NEGATIVE CONTROL (proves the guard is reachable, checklist Q3): one envelope with provider: anthropic ->
     terminal status outcome=BLOCKED reason provider_not_allowed, with NO clone and NO spawn (task record has
     no repo dir, no session).

== 7. FIVE-CASE CANARY = chaos gate runnable_now rows, run TWICE (README rule: gate on the fleet as it is,
   change, gate again). Never run live before; the only prior evidence is harness self-tests. ==
  fleet.json: copy chaos/fleet.example.json; skew_ref for row 5 = 604c428c… (the sha, not HEAD~1, so the skew
  row doubles as the rollback rehearsal). --budget-cap 5 (rows sum $1.50).
  Run A (baseline, both boxes on 604c428c) then deploy per section 5, then Run B (both on 0f7404d7).
  Row                          boxes   $     required (from injections.json)                     new-build expectation
  duplicate_handoff            1+2     0.30  both run (known W1 dedup gap), 2 branches, 0 PRs      identical; terminals now typed UNVERIFIED
  kill_before_model_start      1       0.20  same builds after restart, 1 claimed, attempt=2       online post now carries branch_lease/allowed_providers
  kill_after_artifact_creation 1       0.50  attempt-1 commits + JSONL survive, <=1 PR             PR only if COMPLETED (typed gate); UNVERIFIED pushes, no PR
  evidence_store_unavailable   2       0.30  UNVERIFIED, pr non-null, evidence_error set           identical, plus outbox record if the terminal post fails
  worker_build_skew            2       0.20  record + post name the OLD sha; agree after restore   old sha = 604c428c: this IS the rollback path, measured
  PASS requires every counter 0 AND verify_counters accepting each counter; INCONCLUSIVE is not PASS.
  A dirty shared tree during Run B will surface Finding 1 as unexplained_terminal (FAILED with the debris
  reason) — that is the measurement of Finding 1's frequency, not a harness defect.
```

## Receipt fields to write after the window (machine-written, one per box)

- `DEPLOYED` (per box, after D4): `box`, `instance_id`, `ssm_command_id`, `before_sha=604c428cc4907460059cf7eb0268f878c2873966`,
  `after_sha` (D4 output, must equal the candidate), `unit_active` (D3 output), `online_msg_id` (A1 post),
  `worker_build`, `worker_version`, `vinci_binary`, `server_build`, `branch_lease`, `allowed_providers`, `at` (ISO-8601 UTC), `attested_by`.
- `OBSERVED` (per box): `a1_msg_id`, `a2_stderr_excerpt` (the two quoted lines), `a3_task_id` + `a3_terminal_msg_id` + `outcome=UNVERIFIED`,
  `a4_task_id` + `a4_terminal_msg_id` + `outcome=BLOCKED` + `reason=provider_not_allowed` + `no_clone=true` + `no_spawn=true`,
  `chaos_run_a` / `chaos_run_b` (harness receipt ids, every counter, PASS/INCONCLUSIVE), `finding1_events` (count of
  "debris root identity" FAILED terminals in the window), `at`, `attested_by`.
- `ROLLBACK` (per box, same day): `restore_ssm_command_id`, `restored_sha` (must be 604c428c…), `unit_active`,
  `online_msg_id` after restore carrying `worker_build=604c428c…`, `outbox_left_in_place=true`, `at`, `attested_by`.
