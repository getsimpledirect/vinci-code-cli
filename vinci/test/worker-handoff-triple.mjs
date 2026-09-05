// Wave 1B digest-form handoff (triple) against the real daemon. The fixture bus serves the
// Governor's pinned-contract registry (`GET /v1/governor/contracts/{work_order_id}`) so the
// digest form can run end to end: parse the triple, fetch the registry, validate + recompute both
// digests and the binding, then fetch the base ref / prove ancestry / checkout / spawn. Every
// refusal — malformed triple, 404 registry, invalid record, digest mismatch, binding mismatch,
// unknown model class, bad field, unreachable base — must BLOCK before a clone and before a
// vinci spawn (ZERO git transfer calls, recorded by the fixture's git shim), and each terminal
// post must name the refusal reason and the `contract=<id>@<digest8>` tag.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, fstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "node:http";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { provisionWorkerDebrisAuthority } from "./lib/worker-debris-authority-fixture.mjs";
import { executionSpecDigest, recordDigest, workOrderDigest } from "../worker/contracts/digest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = join(ROOT, "vinci/bin/vinci");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "fixtures/contract-vectors");
const ZERO64 = "0".repeat(64);

const f = new WorkerTestFixture("handoff-triple");
const debrisAuthority = provisionWorkerDebrisAuthority(f.tempDir, "2".repeat(64));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
const gitFails = (cwd, ...args) => {
  try {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
};
// One daemon pass (--once). `args` are appended to the worker command line; `env` overrides the
// fixture env. git argv recording is reset before every run so each block reads only its own calls.
// `stateDir` defaults to the fixture's; a test that needs a COLD box (no cached clone, no task
// records, no local branches) passes a fresh one — see the WARN-2 cold case.
const run = ({ args = [], env = {}, stateDir = f.tempDir } = {}) =>
  new Promise((resolve) => {
    f.resetGitCalls();
    const capabilityFd = debrisAuthority.capabilityFd;
    const capabilityStat = fstatSync(capabilityFd);
    const forbiddenCapabilityIdentity = `${capabilityStat.dev}:${capabilityStat.ino}`;
    const child = spawn(
      "bash",
      [LAUNCHER, "worker", "start", "--id", "w1", "--server", f.busUrl(), "--once", "--state-dir", stateDir, ...args],
      {
        env: f.getEnv({
          VINCI_WORKER_ALLOWED_PROVIDERS: "openrouter,vinci",
          ...env,
          VINCI_WORKER_DEBRIS_AUTHORITY_CAPABILITY_FD: "3",
          FAKE_VINCI_FORBIDDEN_CAPABILITY_IDENTITY: forbiddenCapabilityIdentity,
        }),
        stdio: ["ignore", "pipe", "pipe", capabilityFd],
      },
    );
    debrisAuthority.releaseCapabilityToChild();
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      debrisAuthority.reopenCapability();
      resolve({ status, stderr });
    });
  });

// All terminal posts whose payload mentions the given message id, joined.
function postsFor(messageId) {
  return f
    .getPostedMessages()
    .filter((m) => JSON.stringify(m).includes(messageId))
    .map((m) => JSON.stringify(m))
    .join("\n");
}
const handoff = (id, body) => ({ message_id: id, to_agent: "worker:w1", kind: "handoff", subject: id, body, ts: new Date().toISOString(), posted_by: "x" });
const triple = (work_order_id, contract_digest, execution_spec_digest) => JSON.stringify({ work_order_id, contract_digest, execution_spec_digest });
const taskState = (id) => JSON.parse(readFileSync(join(f.tempDir, "tasks", `${id}.json`), "utf8"));
const ghCalls = () => {
  try {
    return readFileSync(join(f.tempDir, "gh-calls.txt"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv);
  } catch {
    return [];
  }
};
const pushes = () => f.getGitCalls().filter((a) => (a[0] === "-C" ? a[2] : a[0]) === "push");
// git calls made FOR THE TASK: everything except the daemon's own startup build-identity probe,
// which runs `git status` against the daemon checkout (not the task repo) before any poll.
const taskGitCalls = () => f.getGitCalls().filter((a) => !a.includes(join(ROOT, "vinci/worker")));
// A refusal that happened before any git transfer: no fetch/clone/ls-remote/push at all.
function assertRefusedBeforeTransfer(id, code) {
  assert.equal(f.getVinciCalls().length, vinciRuns, `${id}: ${code} must never spawn`);
  assert.equal(f.gitTransferCalls().length, 0, `${id}: ${code} must perform ZERO git transfer calls, got ${JSON.stringify(f.gitTransferCalls())}`);
  assert.match(postsFor(id), new RegExp(code), `${id}: terminal post must name ${code}`);
  assert.equal(taskState(id).state, "BLOCKED", `${id}: task record must be BLOCKED`);
}
let vinciRuns = 0;

try {
  f.linkTools(TOOLS);
  f.recordGit();
  // The digest repository (github.com/getsimpledirect/vinci-contracts → test fixture origin) with
  // TWO commits on main, so the pinned baseCommit (the root) is a genuine non-tip ancestor, and a
  // `release` branch at the tip so a non-main baseRef can be exercised (F7).
  f.createRepo("getsimpledirect", "vinci-contracts");
  const contractBare = join(f.reposDir, "getsimpledirect", "vinci-contracts.git");
  const baseCommit = git(contractBare, "rev-parse", "refs/heads/main");
  const tipCommit = f.commitToRepo("getsimpledirect", "vinci-contracts", { "second.txt": "second commit\n" }, { message: "second" });
  f.commitToRepo("getsimpledirect", "vinci-contracts", { "release.txt": "release\n" }, { branch: "release", from: "main", message: "release" });
  assert.match(baseCommit, /^[0-9a-f]{40}$/, "fixture repo must expose a real main commit");
  assert.notEqual(baseCommit, tipCommit, "precondition: baseCommit is not the tip of main");
  assert.equal(git(contractBare, "merge-base", "--is-ancestor", baseCommit, "refs/heads/release"), "", "precondition: baseCommit is an ancestor of release");
  // A separate repo for the legacy prose case so it stays independent of the digest checkout.
  f.createRepo("proseorg", "coderepo");

  // Golden-vector contract and spec, reloaded from the fixture directory (byte-pinned, never edited).
  const workOrder = JSON.parse(readFileSync(join(VECTORS, "work-order-1-minimal", "input.json"), "utf8"));
  const baseSpec = JSON.parse(readFileSync(join(VECTORS, "execution-spec-1-minimal", "input.json"), "utf8"));
  assert.equal(workOrderDigest(workOrder), "8ba697a58de4eae4ae5405c74659424ac878f5107700cbd0b0001638bca379e2");

  // A valid spec for the happy path: deep copy of the vector, capabilities cleared (the worker
  // advertises none), a future deadline, the real non-tip baseCommit, baseRef=release.
  const futureDeadline = new Date(Date.now() + 3600 * 1000).toISOString();
  // CONTAINMENT (step 3.5): `resourceBounds.deadline` may not be later than the order's
  // `expiresAt`. The golden order expires 2026-08-23+1d, so an order whose spec carries a
  // deadline an hour from now must carry an expiry later still, or every task here would refuse
  // as execution_exceeds_contract. `expiresAt` is the ONE field orderFor moves off the vector;
  // deadline_exceeds_contract itself is pinned in worker-within-order.mjs.
  const futureExpiry = new Date(Date.now() + 7200 * 1000).toISOString();
  // The raw identity of an order the validator refuses (F3 cases) still binds its spec.
  const anyOrderDigest = (order) => {
    try {
      return workOrderDigest(order);
    } catch {
      return recordDigest(order);
    }
  };
  const specFor = (order, overrides = {}) => ({
    ...JSON.parse(JSON.stringify(baseSpec)),
    workOrderId: order.id,
    workOrderDigest: anyOrderDigest(order),
    baseCommit,
    baseRef: "release",
    requiredCapabilities: [],
    resourceBounds: { ...baseSpec.resourceBounds, deadline: futureDeadline },
    ...overrides,
  });
  const orderFor = (id, overrides = {}) => ({ ...workOrder, id, expiresAt: futureExpiry, ...overrides });
  // Register a (order, spec) pair under the order's id; returns the triple body. `specDigest`
  // lets a test name a spec the validator refuses (recordDigest: the raw identity).
  const register = (order, spec, {
    orderDigest = workOrderDigest(order),
    specDigest = executionSpecDigest(spec),
    programId = f.evidenceProgramId,
  } = {}) => {
    f.contractRegistry[order.id] = { work_order: order, execution_spec: spec };
    if (programId === null) delete f.workOrderPrograms[order.id];
    else f.workOrderPrograms[order.id] = programId;
    return triple(order.id, orderDigest, specDigest);
  };

  // The happy-path order is the golden vector with a live expiry (see futureExpiry); its id and
  // every other field are the vector's. The pristine record's digest stays pinned above.
  const happyOrder = orderFor("wo-vec-1");
  const happySpec = specFor(happyOrder);
  const happySpecDigest = executionSpecDigest(happySpec);
  const contractDigest = workOrderDigest(happyOrder);

  await f.startBus([], {});
  const happyTriple = register(happyOrder, happySpec);

  // --- malformed: extra key --- (no registry interaction; refused before fetch)
  {
    f.busMessages.push(handoff("m-extra", JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: contractDigest, execution_spec_digest: happySpecDigest, extra: 1 })));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.contractRequests.length, 0, "malformed triple refused before the registry fetch");
    assertRefusedBeforeTransfer("m-extra", "malformed_handoff");
    assert.match(postsFor("m-extra"), /contract=malformed/, "an unparseable triple carries contract=malformed");
  }

  // --- malformed: missing key ---
  {
    f.busMessages.push(handoff("m-missing", JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: contractDigest })));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.contractRequests.length, 0, "malformed triple refused before the registry fetch");
    assertRefusedBeforeTransfer("m-missing", "malformed_handoff");
  }

  // --- contract_digest_mismatch --- (the served order digests differently than the triple)
  {
    f.busMessages.push(handoff("m-contract", triple("wo-vec-1", ZERO64, happySpecDigest)));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-contract", "contract_digest_mismatch");
    assert.match(postsFor("m-contract"), /contract=wo-vec-1@00000000/, "a parsed triple carries its own contract tag even when refused");
  }

  // --- execution_spec_digest_mismatch --- (no served spec reproduces the named digest)
  {
    f.busMessages.push(handoff("m-spec", triple("wo-vec-1", contractDigest, ZERO64)));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-spec", "execution_spec_digest_mismatch");
  }

  // --- binding_mismatch --- (the spec was compiled from a different work order)
  {
    const foreignSpec = { ...happySpec, workOrderId: "wo-other", workOrderDigest: ZERO64 };
    f.contractRegistry["wo-vec-1-foreign"] = { work_order: happyOrder, execution_spec: foreignSpec };
    f.busMessages.push(handoff("m-binding", triple("wo-vec-1-foreign", contractDigest, executionSpecDigest(foreignSpec))));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-binding", "binding_mismatch");
  }

  // --- unknown_model_class --- (spec.modelClass not in the configured table)
  {
    const order = orderFor("wo-turbo");
    f.busMessages.push(handoff("m-model", register(order, specFor(order, { modelClass: "turbo" }))));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-model", "unknown_model_class");
  }

  // --- provider_mismatch --- (a provider pin that disagrees with the configured class)
  {
    const order = orderFor("wo-provider");
    f.busMessages.push(handoff("m-provider", register(order, specFor(order, { provider: "openrouter" }))));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-provider", "provider_mismatch");
  }

  // --- unsupported_repository_host / no_tools --- (valid records the worker cannot serve)
  {
    // The order GRANTS the gitlab repository, so containment (step 3.5) is satisfied and the
    // refusal under test is the worker's own materialization limit — not repository_not_granted.
    const host = orderFor("wo-host", { grantedAuthority: [...workOrder.grantedAuthority, "repo:gitlab.com/o/r"] });
    f.busMessages.push(handoff("m-host", register(host, specFor(host, { repository: { host: "gitlab.com", owner: "o", name: "r" } }))));
    let r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-host", "unsupported_repository_host");
    const tools = orderFor("wo-notools");
    f.busMessages.push(handoff("m-notools", register(tools, specFor(tools, { tools: [] }))));
    r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-notools", "no_tools");
  }

  // --- F3: only VALIDATED records are hashed. A served record that reproduces the handed digest
  // byte for byte is still refused when the upstream validator would refuse it. Each triple names
  // the raw identity (recordDigest) of the invalid record, so the ONLY thing standing between the
  // handoff and a spawn is validation — a mutant that hashes unvalidated records spawns here.
  {
    const cases = [
      ["m-wo-noauth", (() => { const o = orderFor("wo-noauth"); delete o.grantedAuthority; return o; })(), null, "invalid_work_order", /grantedAuthority required_field/],
      ["m-wo-noschema", (() => { const o = orderFor("wo-noschema"); delete o.schemaVersion; return o; })(), null, "invalid_work_order", /schemaVersion/],
      ["m-wo-schema2", orderFor("wo-schema2", { schemaVersion: 2 }), null, "invalid_work_order", /schemaVersion invalid_schema_version/],
      ["m-wo-extra", orderFor("wo-extra", { note: "smuggled" }), null, "invalid_work_order", /note unknown_field/],
      ["m-wo-nocontractv", (() => { const o = orderFor("wo-nocv"); delete o.contractVersion; return o; })(), null, "invalid_work_order", /contractVersion/],
      ["m-wo-noscope", (() => { const o = orderFor("wo-noscope"); delete o.scope; return o; })(), null, "invalid_work_order", /scope required_field/],
      ["m-sp-extra", orderFor("wo-sp-extra"), { note: "smuggled" }, "invalid_execution_spec", /note unknown_field/],
      ["m-sp-schema", orderFor("wo-sp-schema"), { schemaVersion: 2 }, "invalid_execution_spec", /schemaVersion invalid_schema_version/],
      ["m-sp-nobase", orderFor("wo-sp-nobase"), { baseRef: undefined }, "invalid_execution_spec", /baseRef/],
      ["m-sp-badbranch", orderFor("wo-sp-badbranch"), { targetBranch: "+oops" }, "invalid_execution_spec", /targetBranch invalid_ref/],
      ["m-sp-longbranch", orderFor("wo-sp-longbranch"), { targetBranch: "a".repeat(256) }, "invalid_execution_spec", /targetBranch invalid_ref/],
      ["m-sp-lockcomponent", orderFor("wo-sp-lockcomponent"), { targetBranch: "foo.lock/bar" }, "invalid_execution_spec", /targetBranch invalid_ref/],
      ["m-sp-double-separator", orderFor("wo-sp-double-separator"), { targetBranch: "feature//topic" }, "invalid_execution_spec", /targetBranch invalid_ref/],
      ["m-sp-dotcomponent", orderFor("wo-sp-dotcomponent"), { targetBranch: "feature/.hidden/topic" }, "invalid_execution_spec", /targetBranch invalid_ref/],
      ["m-sp-nobounds", orderFor("wo-sp-nobounds"), { resourceBounds: undefined }, "invalid_execution_spec", /resourceBounds/],
      ["m-sp-boundsextra", orderFor("wo-sp-be"), { resourceBounds: { ...happySpec.resourceBounds, extra: 1 } }, "invalid_execution_spec", /resourceBounds\/extra unknown_field/],
    ];
    for (const [id, order, specOverrides, code, detail] of cases) {
      const spec = specFor(order, specOverrides ?? {});
      for (const key of Object.keys(spec)) if (spec[key] === undefined) delete spec[key];
      f.busMessages.push(handoff(id, register(order, spec, { orderDigest: recordDigest(order), specDigest: recordDigest(spec) })));
      const r = await run();
      assert.equal(r.status, 0, r.stderr);
      assertRefusedBeforeTransfer(id, code);
      assert.match(postsFor(id), detail, `${id}: the refusal names the failing field`);
    }
  }

  // The digest path accepts the same nested branch boundary as prose. The invalid matrix above
  // pins the four symmetric refusals; this handoff proves a valid nested targetBranch survives
  // validation, reaches checkout/spawn, and is published under that exact name.
  {
    const nestedOrder = orderFor("wo-sp-nested", {
      grantedAuthority: [...workOrder.grantedAuthority, "branch:feature/*"],
    });
    f.busMessages.push(handoff(
      "m-sp-nested",
      register(nestedOrder, specFor(nestedOrder, { targetBranch: "feature/nested/topic", promotion: "none" })),
    ));
    const r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "nested.txt" } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "valid nested digest targetBranch reaches the child exactly once");
    assert.equal(taskState("m-sp-nested").state, "UNVERIFIED");
    assert.match(postsFor("m-sp-nested"), /state=UNVERIFIED/);
    assert.match(git(contractBare, "rev-parse", "refs/heads/feature/nested/topic"), /^[0-9a-f]{40}$/);
  }

  // --- 404 response --- (registry has no contract for the named work order)
  {
    f.busMessages.push(handoff("m-404", triple("wo-missing", contractDigest, happySpecDigest)));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-404", "work_order_not_found");
    assert.ok(f.contractRequests.some((c) => c.workOrderId === "wo-missing"), "the 404 work order id must have been requested");
  }

  // --- invalid_bounds: a materialized deadline already in the past BLOCKs before ANY git call ---
  {
    const order = orderFor("wo-past");
    // Valid upstream (deadline strictly after issuedAt) but already elapsed at run time.
    f.busMessages.push(handoff("m-past", register(order, specFor(order, { resourceBounds: { ...happySpec.resourceBounds, deadline: "2026-08-23T14:00:00.000Z" } }))));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-past", "invalid_bounds");
    assert.equal(taskGitCalls().length, 0, `invalid_bounds must fire before ANY git call, got ${JSON.stringify(taskGitCalls())}`);
    assert.match(postsFor("m-past"), new RegExp(`contract=wo-past@${workOrderDigest(order).slice(0, 8)}`), "invalid_bounds post carries the contract tag");
    assert.equal(taskState("m-past").limit_tripped, "deadline");
  }

  // --- Happy path --- (fetch base ref, prove ancestry, checkout baseCommit, spawn, push, PR on baseRef)
  {
    f.busMessages.push(handoff("m-happy", happyTriple));
    const r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "happy.txt" } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "the happy-path digest handoff must run exactly one vinci");
    const repoDir = join(f.tempDir, "repos", "vinci-contracts");
    const headRef = git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
    assert.equal(headRef, "feat/vector-1", "checkout must create the spec's targetBranch from baseCommit");
    assert.equal(git(repoDir, "rev-parse", "HEAD~1"), baseCommit, "the task branch must be rooted exactly at the pinned baseCommit");
    assert.notEqual(git(repoDir, "rev-parse", "HEAD~1"), tipCommit, "the pinned baseCommit is NOT the tip of the base ref");
    assert.equal(git(repoDir, "rev-parse", "refs/heads/feat/vector-1^{}"), git(repoDir, "rev-parse", "HEAD"));
    const state = taskState("m-happy");
    assert.equal(state.base_commit, baseCommit);
    const posted = postsFor("m-happy");
    assert.match(posted, new RegExp(`contract=wo-vec-1@${contractDigest.slice(0, 8)}`), "terminal post must cite contract=work_order_id@digest8");
    assert.match(posted, /state=COMPLETED/, "happy-path digest task should complete");
    assert.equal(pushes().length, 1, `output=branch pushes exactly once, got ${JSON.stringify(pushes())}`);
    assert.equal(git(contractBare, "rev-parse", "refs/heads/feat/vector-1"), git(repoDir, "rev-parse", "HEAD"), "the branch reached origin");
    assert.ok(ghCalls().find((a) => a[0] === "pr" && a[1] === "create"), "promotion=pull_request opens a PR");
  }

  // --- legacy prose handoff still works; its posts carry NO contract= tag ---
  {
    f.busMessages.push(handoff("m-prose", "repo: proseorg/coderepo\nevidence: none\n\nprose task"));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "the legacy prose handoff must run a second vinci");
    const posted = postsFor("m-prose");
    assert.match(posted, /state=UNVERIFIED/, "legacy prose handoff runs and reaches its terminal UNVERIFIED state");
    assert.ok(!/contract=/.test(posted), "a prose handoff must not carry a contract= tag");
    const create = ghCalls().filter((a) => a[0] === "pr" && a[1] === "create");
    assert.equal(create.length, 1, "evidence: none opens no PR");
    // F7: the prose path's evidence diff is unchanged (origin/main...HEAD).
    assert.ok(f.getGitCalls().some((a) => a[0] === "-C" && a[2] === "diff" && a[3] === "origin/main...HEAD"), `prose evidence diff is origin/main...HEAD: ${JSON.stringify(f.getGitCalls().filter((a) => a[2] === "diff"))}`);
  }

  // --- prose past-deadline: the typed terminal post has NO contract= tag ---
  {
    f.busMessages.push(handoff("m-prose-late", "repo: proseorg/coderepo\nevidence: none\ndeadline: 2020-01-01T00:00:00Z\n\nprose task"));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a past deadline never spawns");
    const blocker = f.getPostedMessages().find((m) => m.outcome === "BLOCKED" && JSON.stringify(m).includes("m-prose-late"));
    assert.ok(blocker, "a typed BLOCKED terminal is posted for the past deadline");
    assert.match(blocker.body, /^deadline is in the past worker_build=/, `prose deadline body is unchanged: ${blocker.body}`);
    assert.doesNotMatch(blocker.body, /contract=/, "a prose deadline post carries NO contract= tag");
    assert.equal(f.gitTransferCalls().length, 0, "a past deadline performs no transfer");
  }

  // --- F2: VINCI_WORKER_MODEL_CLASSES is validated ONCE at startup ---
  // invalid inline JSON ⇒ exit 78 with the reason, before the lock / version fetch / online post;
  // unreadable @file ⇒ exit 78; unset ⇒ the daemon starts, and every digest handoff BLOCKs
  // `unknown_model_class` per task (never a crash).
  {
    const onlineBefore = f.getPostedMessages().filter((p) => / online$/.test(p.subject)).length;
    const versionBefore = f.versionRequests;
    f.busMessages.push(handoff("m-classes", happyTriple));
    for (const [label, value, reason] of [
      ["invalid inline", "{not json", /invalid VINCI_WORKER_MODEL_CLASSES: .*; refusing to start/],
      ["wrong shape", JSON.stringify({ forte: { provider: "vinci" } }), /class forte must be \{ provider, model \}; refusing to start/],
      ["unreadable @file", `@${join(f.tempDir, "no-such-classes.json")}`, /invalid VINCI_WORKER_MODEL_CLASSES: ENOENT.*; refusing to start/],
    ]) {
      const r = await run({ env: { VINCI_WORKER_MODEL_CLASSES: value } });
      assert.equal(r.status, 78, `${label}: daemon must refuse to start with EX_CONFIG (78), got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, reason, `${label}: stderr names the reason: ${r.stderr}`);
      assert.equal(f.getPostedMessages().filter((p) => / online$/.test(p.subject)).length, onlineBefore, `${label}: must not post online`);
      assert.equal(f.versionRequests, versionBefore, `${label}: must not fetch /v1/version`);
      assert.equal(existsSync(join(f.tempDir, "daemon.lock")), false, `${label}: must refuse before taking the daemon lock`);
      assert.equal(existsSync(join(f.tempDir, "tasks", "m-classes.json")), false, `${label}: no task may be touched`);
    }
    // A readable @file works and is equivalent to the inline form (a fresh targetBranch: the
    // happy path's branch now tracks origin and would be refused as diverged, see F5).
    const classesOrder = orderFor("wo-classes");
    f.busMessages.push(handoff("m-classes-file", register(classesOrder, specFor(classesOrder, { targetBranch: "feat/classes" }))));
    const classesFile = join(f.tempDir, "classes.json");
    writeFileSync(classesFile, JSON.stringify({ forte: { provider: "vinci", model: "forte" } }));
    let r = await run({ env: { VINCI_WORKER_MODEL_CLASSES: `@${classesFile}` } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "@file table: the digest handoff runs");
    assert.match(postsFor("m-classes-file"), /state=COMPLETED/, "@file table: the class resolves and the task completes");

    // F5: a CUSTOM class mapping must actually reach the child. Everything above
    // proves the REFUSALS -- unknown_model_class when the table is unset,
    // provider_mismatch when a pin disagrees -- and every other digest test runs
    // with the fixture default, which maps forte to the MANAGED provider
    // ({provider:"vinci"}). So nothing here demonstrated the property F5 asks
    // for: "worker boxes are OpenRouter-only; forte/fortissimo must not hardwire
    // to the managed provider". A mechanism that is configurable and never shown
    // to deliver is indistinguishable from one that ignores its config.
    //
    // This asserts the ARGV the worker spawned, not the task's state. A task can
    // reach COMPLETED while the class silently resolved to the default; only the
    // child's --provider/--model says where the work would really have gone.
    {
      const remapped = orderFor("wo-remap");
      f.busMessages.push(handoff("m-remap", register(remapped, specFor(remapped, { targetBranch: "feat/remap" }))));
      const before = f.getVinciCalls().length;
      const rr = await run({ env: { VINCI_WORKER_MODEL_CLASSES: JSON.stringify({
        forte: { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
      }) } });
      assert.equal(rr.status, 0, rr.stderr);
      vinciRuns += 1;
      assert.equal(f.getVinciCalls().length, vinciRuns, "custom class mapping: the digest handoff runs");
      assert.equal(f.getVinciCalls().length, before + 1, "custom class mapping: exactly one spawn");
      const argv = f.getVinciCalls().at(-1).argv ?? [];
      const provider = argv[argv.indexOf("--provider") + 1];
      const model = argv[argv.indexOf("--model") + 1];
      assert.equal(provider, "openrouter",
        `custom class mapping: the child must be spawned with the CONFIGURED provider, got ${provider}`);
      assert.equal(model, "deepseek/deepseek-v4-flash-0731",
        `custom class mapping: the child must be spawned with the CONFIGURED model, got ${model}`);
    }
    // WARN-2: m-classes carries the HAPPY PATH's triple — the same execution spec, already run
    // and already pushed. The refusal must report the OBSERVATION (origin/feat/vector-1 has moved
    // past the base_commit this spec pins) and not `branch_diverged`, whose commits may be this
    // contract's own output. It names both the base and the spec digest so the operator can tell
    // which reading applies; it does NOT assert that the branch is this spec's output — see the
    // human-pushed case below, which is byte-identical to the worker.
    assert.match(postsFor("m-classes"), /state=BLOCKED/, "the m-classes handoff that the three refused daemons never touched is processed by this pass");
    assert.match(postsFor("m-classes"), new RegExp(`target_branch_ahead_of_base: origin/feat/vector-1 has advanced past base_commit ${baseCommit.slice(0, 8)}, which spec ${happySpecDigest.slice(0, 8)} pins; if that is this spec's own output the run is already published, otherwise the branch is in use — either way a re-run needs a new spec or a new targetBranch`));
    assert.doesNotMatch(postsFor("m-classes"), /branch_diverged/, "a branch that has moved on origin is NOT a local divergence");
    assert.doesNotMatch(postsFor("m-classes"), /already carries the output of/, "the record must not claim an authorship the worker never checked");
    assert.equal(f.getVinciCalls().length, vinciRuns, "target_branch_ahead_of_base must never spawn");
    // Unset ⇒ prose-only: start, but BLOCK every digest handoff before any transfer.
    f.busMessages.push(handoff("m-noclasses", happyTriple));
    r = await run({ env: { VINCI_WORKER_MODEL_CLASSES: "" } });
    assert.equal(r.status, 0, `unset table: the daemon must start and finish the pass: ${r.stderr}`);
    assertRefusedBeforeTransfer("m-noclasses", "unknown_model_class");
    assert.match(postsFor("m-noclasses"), /MODEL_CLASSES not configured/);
  }

  // --- F1: the registry body is streamed under one deadline with a byte cap ---
  // (a) a body that trickles past the timeout ⇒ registry_unavailable (the deadline covers the
  //     body, not just the headers); (b) an oversized CHUNKED body (no Content-Length) ⇒
  //     registry_unavailable at the cap. Both answers are otherwise VALID registries for a spec
  //     the worker would run, so a daemon that waited for / swallowed the body would spawn.
  {
    const trickleOrder = orderFor("wo-trickle");
    const trickleSpec = specFor(trickleOrder);
    const bigOrder = orderFor("wo-big");
    const bigSpec = specFor(bigOrder);
    const pending = [];
    f.contractRespond = (id, request, response) => {
      if (id === "wo-trickle") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"work_order":');
        const timer = setTimeout(() => {
          try {
            response.end(`${JSON.stringify(trickleOrder)},"execution_specs":[${JSON.stringify(trickleSpec)}],"digests":{},"handoffs":[]}`);
          } catch {}
        }, 2500);
        pending.push(timer);
        return true;
      }
      if (id === "wo-big") {
        // Chunked: several writes, never a Content-Length. ~300 KiB of padding in a top-level
        // key the worker ignores, around a registry answer that is otherwise exactly right.
        response.writeHead(200, { "content-type": "application/json" });
        response.write(`{"work_order":${JSON.stringify(bigOrder)},"execution_specs":[${JSON.stringify(bigSpec)}],"digests":{"pad":"`);
        for (let i = 0; i < 30; i += 1) response.write("x".repeat(10_240));
        response.end('"},"handoffs":[]}');
        return true;
      }
      return false;
    };
    f.busMessages.push(handoff("m-trickle", triple("wo-trickle", workOrderDigest(trickleOrder), executionSpecDigest(trickleSpec))));
    const started = Date.now();
    let r = await run({ env: { VINCI_WORKER_REGISTRY_TIMEOUT_MS: "500" } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - started < 2400, "the daemon must give up at its deadline, not wait for the trickle to finish");
    assertRefusedBeforeTransfer("m-trickle", "registry_unavailable");
    assert.match(postsFor("m-trickle"), /timed out after 500 ms/, "the reason names the deadline");
    for (const timer of pending) clearTimeout(timer);

    f.busMessages.push(handoff("m-big", triple("wo-big", workOrderDigest(bigOrder), executionSpecDigest(bigSpec))));
    r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-big", "registry_unavailable");
    assert.match(postsFor("m-big"), /exceeds 256 KiB/, "the reason names the cap");
    f.contractRespond = null;
  }

  // --- F8: Governor refusal / unavailability on the digest path carry contract=<id>@<digest8> ---
  // The tag is the FIRST token of the body (one formatter for every early terminal post); the
  // prose path's Governor posts stay byte-identical (no tag).
  {
    const governor = createServer((request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ reason: "rule: paths under / are frozen tonight" }));
    });
    await new Promise((r) => governor.listen(0, "127.0.0.1", r));
    const governorUrl = `http://127.0.0.1:${governor.address().port}`;
    // A closed port: the connection is refused ⇒ "Governor unavailable/invalid".
    const closed = createServer(() => {});
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    const closedUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((r) => closed.close(r));
    try {
      const tag = `contract=wo-vec-1@${contractDigest.slice(0, 8)}`;
      f.busMessages.push(handoff("m-gov-refused", happyTriple));
      let r = await run({ args: ["--governor", governorUrl], env: { VINCI_GOVERNOR_TOKEN: "gov-token" } });
      assert.equal(r.status, 0, r.stderr);
      assertRefusedBeforeTransfer("m-gov-refused", "Governor refused the lease");
      let blocker = f.getPostedMessages().find((m) => m.outcome === "BLOCKED" && m.in_reply_to === "m-gov-refused");
      assert.match(blocker.body, new RegExp(`^${tag} Governor refused the lease: rule: paths under / are frozen tonight worker_build=`), blocker.body);
      assert.equal(taskState("m-gov-refused").outcome.governor, "refused");

      f.busMessages.push(handoff("m-gov-down", happyTriple));
      r = await run({ args: ["--governor", closedUrl], env: { VINCI_GOVERNOR_TOKEN: "gov-token" } });
      assert.equal(r.status, 0, r.stderr);
      assertRefusedBeforeTransfer("m-gov-down", "Governor lease unavailable");
      blocker = f.getPostedMessages().find((m) => m.outcome === "BLOCKED" && m.in_reply_to === "m-gov-down");
      assert.match(blocker.body, new RegExp(`^${tag} Governor lease unavailable: lease_unavailable: Governor connection failed: `), blocker.body);
      assert.equal(taskState("m-gov-down").outcome.governor, "unavailable");

      // Prose path: same refusal, NO tag, body unchanged.
      f.busMessages.push(handoff("m-gov-prose", "repo: proseorg/coderepo\nevidence: none\n\nprose task"));
      r = await run({ args: ["--governor", governorUrl], env: { VINCI_GOVERNOR_TOKEN: "gov-token" } });
      assert.equal(r.status, 0, r.stderr);
      blocker = f.getPostedMessages().find((m) => m.outcome === "BLOCKED" && m.in_reply_to === "m-gov-prose");
      assert.match(blocker.body, /^Governor refused the lease: rule: paths under \/ are frozen tonight worker_build=/, blocker.body);
      assert.doesNotMatch(blocker.body, /contract=/);
    } finally {
      await new Promise((r) => governor.close(r));
    }
  }

  // --- F4: base checkout — origin is the only authority for base_ref / base_commit ---
  {
    const repoDir = join(f.tempDir, "repos", "vinci-contracts");
    const sub = (a) => (a[0] === "-C" ? a[2] : a[0]);
    // (a) a base_ref origin does not have ⇒ base_ref_unavailable; the explicit fetch was attempted
    //     and nothing was checked out.
    const noRef = orderFor("wo-noref");
    f.busMessages.push(handoff("m-noref", register(noRef, specFor(noRef, { baseRef: "no-such-branch", targetBranch: "feat/noref" }))));
    let r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "base_ref_unavailable must never spawn");
    assert.match(postsFor("m-noref"), /base_ref_unavailable/);
    assert.equal(taskState("m-noref").state, "BLOCKED");
    const fetches = f.getGitCalls().filter((a) => sub(a) === "fetch");
    assert.deepEqual(fetches.map((a) => a.slice(-2)), [["origin", "+refs/heads/no-such-branch:refs/remotes/origin/no-such-branch"]], `exactly one explicit fetch of the base ref: ${JSON.stringify(fetches)}`);
    assert.equal(f.getGitCalls().filter((a) => sub(a) === "checkout").length, 0, "nothing is checked out on a base refusal");
    assert.equal(gitFails(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/feat/noref"), true, "the target branch was never created");

    // (b) a commit that EXISTS LOCALLY (cached clone) but is not on origin/<baseRef> ⇒
    //     base_commit_unreachable. The local object is real: a checkout from it would succeed,
    //     so only the ancestry proof against the fetched origin ref stands between this handoff
    //     and a spawn on a base origin never vouched for.
    git(repoDir, "checkout", "-q", "--detach", baseCommit);
    writeFileSync(join(repoDir, "local-only.txt"), "never pushed\n");
    git(repoDir, "config", "user.email", "t@t");
    git(repoDir, "config", "user.name", "t");
    git(repoDir, "add", "local-only.txt");
    git(repoDir, "commit", "-qm", "local only");
    const localOnly = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "branch", "-q", "keep/local-only", localOnly); // keep the object reachable
    git(repoDir, "checkout", "-q", "keep/local-only");
    assert.equal(gitFails(repoDir, "cat-file", "-e", `${localOnly}^{commit}`), false, "precondition: the commit object exists in the cached clone");
    assert.equal(gitFails(contractBare, "cat-file", "-e", `${localOnly}^{commit}`), true, "precondition: origin has never seen it");
    const localBase = orderFor("wo-localbase");
    f.busMessages.push(handoff("m-localbase", register(localBase, specFor(localBase, { baseCommit: localOnly, targetBranch: "feat/localbase" }))));
    r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a base_commit origin does not vouch for must never spawn");
    assert.match(postsFor("m-localbase"), /base_commit_unreachable/);
    assert.match(postsFor("m-localbase"), new RegExp(`contract=wo-localbase@${workOrderDigest(localBase).slice(0, 8)}`));
    assert.equal(taskState("m-localbase").state, "BLOCKED");
    assert.equal(f.getGitCalls().filter((a) => sub(a) === "checkout").length, 0, "nothing is checked out on a base refusal");
    assert.equal(gitFails(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/feat/localbase"), true, "the target branch was never created");
  }

  // --- F5: the digest path quarantines a dirty tree and applies PR #22's branch handling BEFORE checkout -B ---
  {
    const repoDir = join(f.tempDir, "repos", "vinci-contracts");
    const sub = (a) => (a[0] === "-C" ? a[2] : a[0]);
    const staleRefs = () => git(repoDir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/stale/");
    // (a) dirty tree: a tracked modification + an untracked file left by a prior run are
    //     preserved under <state>/debris/<task> and the task runs on a clean tree.
    git(repoDir, "checkout", "-q", "feat/classes");
    writeFileSync(join(repoDir, "README.md"), "half-finished\n");
    writeFileSync(join(repoDir, "leftover.txt"), "only copy\n");
    const dirtyOrder = orderFor("wo-dirty");
    debrisAuthority.reserveTask("m-dirty");
    f.busMessages.push(handoff("m-dirty", register(dirtyOrder, specFor(dirtyOrder, { targetBranch: "feat/dirty" }))));
    let r = await run();
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "the task runs after quarantine");
    assert.match(postsFor("m-dirty"), /state=COMPLETED/);
    const ledger = join(f.tempDir, "debris", "m-dirty", "ledger-v1");
    const debrisReceipt = JSON.parse(readFileSync(join(ledger, "current.json"), "utf8"));
    const debris = join(ledger, "generations", debrisReceipt.generation);
    assert.ok(existsSync(join(debris, "COMMITTED")), "the dirty tree must be durably QUARANTINED before checkout -B");
    assert.match(readFileSync(join(debris, "tracked.patch"), "utf8"), /half-finished/, "the tracked modification is preserved as a patch");
    assert.equal(readFileSync(join(debris, "untracked", "leftover.txt"), "utf8"), "only copy\n", "the untracked file is copied before the source is cleaned");
    assert.equal(git(repoDir, "status", "--porcelain"), "", "the task received a clean tree");
    const calls = f.getGitCalls().map(sub);
    assert.ok(calls.indexOf("reset") < calls.indexOf("checkout"), `quarantine runs before checkout -B: ${calls.join(",")}`);

    // (b) an existing local <targetBranch> with never-pushed commits (no upstream, on no origin
    //     head) is renamed aside to stale/<branch>-<stamp>-<hex> — never deleted — and the task
    //     continues from base_commit.
    git(repoDir, "checkout", "-qb", "feat/residue", baseCommit);
    writeFileSync(join(repoDir, "residue.txt"), "night-1 work\n");
    git(repoDir, "add", "residue.txt");
    git(repoDir, "commit", "-qm", "residue");
    const residueTip = git(repoDir, "rev-parse", "HEAD");
    assert.equal(gitFails(repoDir, "config", "--get", "branch.feat/residue.remote"), true, "precondition: no upstream");
    const residueOrder = orderFor("wo-residue");
    f.busMessages.push(handoff("m-residue", register(residueOrder, specFor(residueOrder, { targetBranch: "feat/residue" }))));
    r = await run();
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "the task runs after the residue is set aside");
    assert.match(staleRefs(), new RegExp(`^stale/feat/residue-\\d{8}T\\d{6}Z-[0-9a-f]{6} ${residueTip}$`, "m"), `residue must survive at its tip under stale/: ${staleRefs()}`);
    assert.equal(git(repoDir, "rev-parse", "feat/residue^"), baseCommit, "the task branch was recreated from base_commit before the fixture's work commit");
    assert.match(r.stderr, /never-pushed residue on feat\/residue .* renamed aside to stale\/feat\/residue-/);

    // (c) a local <targetBranch> that TRACKS origin/<targetBranch> and is ahead of base_commit
    //     is refused (branch_diverged) and left exactly where it is; no checkout -B ran.
    //     origin/feat/tracked is pushed AT base_commit and left there, so this stays a pure
    //     local-divergence case: WARN-2's target_branch_ahead_of_base probe (which fires only
    //     when the ORIGIN branch has moved past base_commit) must not be what refuses it.
    git(repoDir, "checkout", "-qb", "feat/tracked", baseCommit);
    git(repoDir, "push", "-q", "-u", "origin", "feat/tracked");
    assert.equal(git(contractBare, "rev-parse", "refs/heads/feat/tracked"), baseCommit, "precondition: origin/feat/tracked sits AT base_commit");
    writeFileSync(join(repoDir, "tracked.txt"), "pushed\n");
    git(repoDir, "add", "tracked.txt");
    git(repoDir, "commit", "-qm", "tracked");
    writeFileSync(join(repoDir, "tracked2.txt"), "ahead\n");
    git(repoDir, "add", "tracked2.txt");
    git(repoDir, "commit", "-qm", "ahead");
    const trackedTip = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "checkout", "-q", "--detach", baseCommit);
    const trackedOrder = orderFor("wo-tracked");
    f.busMessages.push(handoff("m-tracked", register(trackedOrder, specFor(trackedOrder, { targetBranch: "feat/tracked" }))));
    r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a diverged tracked branch must never spawn");
    assert.match(postsFor("m-tracked"), /branch_diverged: local branch feat\/tracked at .* has commits not on base_commit .*; refusing to reset \(divergence\)/);
    assert.doesNotMatch(postsFor("m-tracked"), /target_branch_ahead_of_base/, "origin has not moved past base_commit: this is a local divergence, not a moved branch");
    assert.equal(taskState("m-tracked").state, "BLOCKED");
    assert.equal(git(repoDir, "rev-parse", "feat/tracked"), trackedTip, "the tracked branch is left in place");
    assert.doesNotMatch(staleRefs(), /feat\/tracked/, "a tracked branch is never renamed aside");
    assert.equal(f.getGitCalls().filter((a) => sub(a) === "checkout").length, 0, "no checkout -B on a divergence refusal");
  }

  // --- F6/F7: output modes decide what publish does; the pinned base threads into PR + evidence ---
  {
    const repoDir = join(f.tempDir, "repos", "vinci-contracts");
    const awsRecord = join(f.tempDir, "aws-calls.txt");
    const evidenceEnv = { VINCI_EVIDENCE_URI_PREFIX: "s3://evidence-bucket/worker/", FAKE_AWS_RECORD: awsRecord };
    const bundleOf = (taskId) => {
      const calls = readFileSync(awsRecord, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv);
      const upload = calls.find((a) => a[0] === "s3" && a[1] === "cp" && a.at(-1).includes(`/${taskId}/`));
      assert.ok(upload, `an evidence bundle was uploaded for ${taskId}: ${JSON.stringify(calls)}`);
      const tgz = upload[3];
      const listing = execFileSync("tar", ["tzf", tgz]).toString().split("\n").map((l) => l.replace(/^\.\//, "")).filter(Boolean);
      const read = (name) => execFileSync("tar", ["xzOf", tgz, `./${name}`]).toString();
      return { listing, read };
    };
    const modeRun = async (id, output, promotion, env) => {
      const order = orderFor(`wo-${id}`);
      debrisAuthority.reserveTask(`m-${id}`);
      f.busMessages.push(handoff(`m-${id}`, register(order, specFor(order, { output, promotion, targetBranch: `feat/${id}` }))));
      const r = await run({ env: { FAKE_VINCI_COMMIT_FILE: `${id}.txt`, ...evidenceEnv, ...env } });
      assert.equal(r.status, 0, r.stderr);
      vinciRuns += 1;
      assert.equal(f.getVinciCalls().length, vinciRuns, `${id}: the task ran`);
      return { order, state: taskState(`m-${id}`) };
    };

    // none: no push at all, no PR, nothing extra in the bundle.
    {
      const { state } = await modeRun("none", "none", "none");
      assert.equal(pushes().length, 0, `output=none must not push: ${JSON.stringify(pushes())}`);
      assert.equal(state.publish, "none");
      assert.equal(state.pr, null);
      assert.equal(ghCalls().filter((a) => a[0] === "pr" && a[1] === "create" && a.includes("feat/none")).length, 0, "output=none opens no PR");
      assert.equal(gitFails(contractBare, "rev-parse", "--verify", "--quiet", "refs/heads/feat/none"), true, "origin never receives the branch");
      const { listing } = bundleOf("m-none");
      assert.ok(!listing.some((n) => /\.patch$|artifacts\.json/.test(n)), `no patch/artifacts in the bundle: ${listing}`);
    }
    // patch: <attempt>.patch (format-patch against baseCommit) in the bundle; no push.
    {
      const { state } = await modeRun("patch", "patch", "none");
      assert.equal(pushes().length, 0, `output=patch must not push: ${JSON.stringify(pushes())}`);
      assert.equal(state.publish, "patch");
      assert.equal(gitFails(contractBare, "rev-parse", "--verify", "--quiet", "refs/heads/feat/patch"), true, "origin never receives the branch");
      const { listing, read } = bundleOf("m-patch");
      assert.ok(listing.includes("1.patch"), `bundle carries <attempt>.patch: ${listing}`);
      const patch = read("1.patch");
      assert.match(patch, /^From [0-9a-f]{40} /m, "format-patch output");
      assert.match(patch, /\+\+\+ b\/patch\.txt/, "the patch carries the produced file");
      assert.doesNotMatch(patch, /second\.txt|release\.txt/, "the patch is against baseCommit, not against the tip of the base ref");
      assert.ok(f.getGitCalls().some((a) => a[2] === "format-patch" && a.at(-1) === `${baseCommit}..HEAD`), "format-patch range is <baseCommit>..HEAD");
    }
    // artifact: artifacts.json lists the produced files (committed + untracked); no push.
    {
      const { state } = await modeRun("artifact", "artifact", "none", { FAKE_VINCI_UNTRACKED_FILE: "report.md" });
      assert.equal(pushes().length, 0, `output=artifact must not push: ${JSON.stringify(pushes())}`);
      assert.equal(state.publish, "artifact");
      assert.deepEqual(state.artifacts, ["artifact.txt", "report.md"], "the record lists the produced files");
      const { listing, read } = bundleOf("m-artifact");
      assert.ok(listing.includes("artifacts.json"), `bundle carries artifacts.json: ${listing}`);
      assert.deepEqual(JSON.parse(read("artifacts.json")), { base_commit: baseCommit, files: ["artifact.txt", "report.md"] });
      assert.ok(!listing.some((n) => /\.patch$/.test(n)), "no patch in an artifact bundle");
    }
    // branch + promotion none: exactly one push, NO PR.
    {
      const { state } = await modeRun("branchonly", "branch", "none");
      assert.equal(pushes().length, 1, `output=branch pushes exactly once: ${JSON.stringify(pushes())}`);
      assert.equal(state.publish, "pushed");
      assert.equal(state.pr, null, "promotion=none opens no PR");
      assert.equal(ghCalls().filter((a) => a[0] === "pr" && a[1] === "create" && a.includes("feat/branchonly")).length, 0);
      assert.equal(git(contractBare, "rev-parse", "refs/heads/feat/branchonly"), git(repoDir, "rev-parse", "HEAD"), "the branch reached origin");
    }
    // branch + pull_request: one push, a PR with --base <baseRef>; the evidence diff is <baseCommit>...HEAD.
    {
      const { state } = await modeRun("branchpr", "branch", "pull_request");
      assert.equal(pushes().length, 1, `output=branch pushes exactly once: ${JSON.stringify(pushes())}`);
      assert.equal(state.publish, "pushed");
      assert.match(state.pr ?? "", /^https:\/\/github\.com\//, "promotion=pull_request opens a PR");
      const create = ghCalls().find((a) => a[0] === "pr" && a[1] === "create" && a.includes("feat/branchpr"));
      assert.ok(create, "gh pr create ran for feat/branchpr");
      assert.equal(create[create.indexOf("--base") + 1], "release", `PR base is the pinned baseRef (never main): ${JSON.stringify(create)}`);
      const diffs = f.getGitCalls().filter((a) => a[0] === "-C" && a[2] === "diff");
      assert.ok(f.getGitCalls().some((a) => a[0] === "-C" && a[2] === "diff" && a[3] === `${baseCommit}...HEAD`), `evidence diff is <baseCommit>...HEAD: ${JSON.stringify(diffs)}`);
      assert.ok(!f.getGitCalls().some((a) => a[2] === "diff" && a[3] === "origin/main...HEAD"), "the digest path never diffs against a hardcoded main");
      const { listing, read } = bundleOf("m-branchpr");
      assert.ok(listing.includes("git.diff"));
      assert.match(read("git.diff"), /\+\+\+ b\/branchpr\.txt/, "the evidence diff carries the produced file");
      assert.doesNotMatch(read("git.diff"), /second\.txt/, "the evidence diff is against baseCommit, not the tip");
    }
    // The happy path earlier also promoted by pull_request: its PR base was the pinned baseRef.
    const happyCreate = ghCalls().find((a) => a[0] === "pr" && a[1] === "create" && a.includes("feat/vector-1"));
    assert.equal(happyCreate[happyCreate.indexOf("--base") + 1], "release");
  }

  // --- BLOCK-1: CONTAINMENT — a correctly-bound spec that asks for MORE than the order grants ---
  // Binding proves which order the spec was compiled from; it says nothing about what the spec
  // then asks for. This is the exact record the W1B review demonstrated running to COMPLETED and
  // PUSHING: an order granting only prose, and a spec naming a different repository, `main`, a
  // pull request, three ungranted tools and a 500 USD budget. It must refuse before any transfer
  // and before any spawn, and the reason must name every dimension it exceeded.
  {
    const order = orderFor("wo-exceeds", { grantedAuthority: ["edit files under src/api"] });
    const spec = specFor(order, {
      repository: { host: "github.com", owner: "someone-else", name: "production" },
      targetBranch: "main",
      promotion: "pull_request",
      tools: ["bash", "write", "edit"],
      resourceBounds: { ...happySpec.resourceBounds, budgetMicrousd: 500000000 },
    });
    f.busMessages.push(handoff("m-exceeds", register(order, spec)));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-exceeds", "execution_exceeds_contract");
    const posted = postsFor("m-exceeds");
    for (const code of ["tool_not_granted", "repository_not_granted", "branch_not_granted", "promotion_not_granted"]) {
      assert.match(posted, new RegExp(code), `the reason names ${code}: ${posted}`);
    }
    assert.match(posted, new RegExp(`contract=wo-exceeds@${workOrderDigest(order).slice(0, 8)}`), "the refusal carries the contract tag");
    assert.equal(existsSync(join(f.tempDir, "repos", "production")), false, "the repository the order never granted was never cloned");

    // One dimension is enough on its own: the same order, a spec that differs ONLY in landing on
    // main. Everything else about it is granted, so branch_not_granted is what refuses it.
    const okOrder = orderFor("wo-mainonly");
    f.busMessages.push(handoff("m-mainonly", register(okOrder, specFor(okOrder, { targetBranch: "main" }))));
    const r2 = await run();
    assert.equal(r2.status, 0, r2.stderr);
    assertRefusedBeforeTransfer("m-mainonly", "execution_exceeds_contract");
    assert.match(postsFor("m-mainonly"), /\/targetBranch branch_not_granted/);
    assert.equal(git(contractBare, "rev-parse", "refs/heads/main"), tipCommit, "the branch the order never granted was never written to");
  }

  // --- WARN-2 (cold box): a re-run of a published spec on a machine with NO local state ---
  // The warm case is m-classes above. Here the worker has never seen this repository: no cached
  // clone, no local branch, no task record — the state the review said nothing refused, so the
  // model was spawned and paid for and only the push failed. origin/<targetBranch> is the only
  // authority that can answer, and it is asked BEFORE the spawn.
  {
    const coldState = join(f.tempDir, "cold-state");
    mkdirSync(coldState, { recursive: true });
    // The daemon's first run starts its cursor at NOW; the fixture seeds an ancient one per
    // state dir (see WorkerTestFixture), so a fresh state dir needs the same seed or the
    // historical handoff is skipped as history rather than processed.
    writeFileSync(join(coldState, "cursor.json"), JSON.stringify({ w1: { ts: "2000-01-01T00:00:00.000Z", message_ids: [] } }));
    assert.equal(existsSync(join(coldState, "repos")), false, "precondition: the cold box has no clone");
    assert.equal(git(contractBare, "rev-parse", "refs/heads/feat/vector-1") !== baseCommit, true, "precondition: origin/feat/vector-1 carries the published output");

    // A cold state dir holds no task records, so it would re-process every handoff this suite
    // has already posted. The bus is narrowed to the cold cases for the duration of the block.
    const warmMessages = f.busMessages;
    f.busMessages = [handoff("m-cold", happyTriple)];
    const r = await run({ stateDir: coldState });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a cold-box re-run of a published spec must never spawn");
    assert.equal(pushes().length, 0, `and must never push: ${JSON.stringify(pushes())}`);
    const coldPosts = postsFor("m-cold");
    assert.match(coldPosts, new RegExp(`target_branch_ahead_of_base: origin/feat/vector-1 has advanced past base_commit ${baseCommit.slice(0, 8)}, which spec ${happySpecDigest.slice(0, 8)} pins; if that is this spec's own output the run is already published, otherwise the branch is in use — either way a re-run needs a new spec or a new targetBranch`));
    assert.doesNotMatch(coldPosts, /branch_diverged/, "there is no local branch to diverge on a cold box");
    assert.doesNotMatch(coldPosts, /already carries the output of/, "the record must not claim an authorship the worker never checked");
    assert.match(coldPosts, new RegExp(`contract=wo-vec-1@${contractDigest.slice(0, 8)}`), "the refusal carries the contract tag");
    assert.equal(JSON.parse(readFileSync(join(coldState, "tasks", "m-cold.json"), "utf8")).state, "BLOCKED");
    // The probe is not a general veto: a FRESH targetBranch on the same cold box still runs.
    const coldOrder = orderFor("wo-cold-ok");
    f.busMessages.push(handoff("m-cold-ok", register(coldOrder, specFor(coldOrder, { targetBranch: "feat/cold-ok" }))));
    const r2 = await run({ stateDir: coldState, env: { FAKE_VINCI_COMMIT_FILE: "cold.txt" } });
    assert.equal(r2.status, 0, r2.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "an unpublished targetBranch still runs");
    assert.match(postsFor("m-cold-ok"), /state=COMPLETED/);
    f.busMessages = warmMessages;
  }

  // --- WARN-2 (honesty): the SAME ref topology, produced by a HUMAN ---------------------------
  // The reviewer's repro for the follow-up WARN. No worker has ever run this spec: a person
  // pushed a commit to the branch name it pins, from the base it pins, before the handoff was
  // processed. To the worker this is byte-identical to its own earlier output — it authors no
  // commits, so there is no trailer or footer of its own to read back — and the first version of
  // this refusal called it `already_published`, i.e. asserted an authorship nothing had checked.
  //
  // The behaviour is right (refuse before spend; that push would have failed anyway). What must
  // hold is that the RECORD says only what was observed.
  {
    const order = orderFor("wo-human");
    const spec = specFor(order, { targetBranch: "feat/human" });
    const specDigest8 = executionSpecDigest(spec).slice(0, 8);
    // A person, not the worker: pushed straight to origin from the spec's baseCommit.
    const human = join(f.tempDir, "human-clone");
    execFileSync("git", ["clone", "-q", `file://${contractBare}`, human], { stdio: "pipe" });
    git(human, "config", "user.email", "someone@example.com");
    git(human, "config", "user.name", "Someone Else");
    git(human, "checkout", "-qb", "feat/human", baseCommit);
    writeFileSync(join(human, "hand-written.txt"), "not a worker\n");
    git(human, "add", "hand-written.txt");
    git(human, "commit", "-qm", "hand-written change");
    git(human, "push", "-q", "origin", "feat/human");
    const humanTip = git(human, "rev-parse", "HEAD");
    assert.notEqual(humanTip, baseCommit, "precondition: origin/feat/human has moved past base_commit");
    assert.equal(git(contractBare, "rev-parse", "refs/heads/feat/human"), humanTip, "precondition: the human commit is on origin");

    f.busMessages.push(handoff("m-human", register(order, spec)));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a moved targetBranch must never spawn, whoever moved it");
    assert.equal(pushes().length, 0, `and must never push: ${JSON.stringify(pushes())}`);
    assert.equal(taskState("m-human").state, "BLOCKED");
    const posted = postsFor("m-human");
    // The observation, and both readings of it — never one of them as a fact.
    assert.match(posted, new RegExp(`target_branch_ahead_of_base: origin/feat/human has advanced past base_commit ${baseCommit.slice(0, 8)}, which spec ${specDigest8} pins; if that is this spec's own output the run is already published, otherwise the branch is in use — either way a re-run needs a new spec or a new targetBranch`));
    assert.doesNotMatch(posted, /already carries the output of/, "the worker did not write this branch and must not say it did");
    assert.doesNotMatch(posted, /already_published/, "no authorship claim: the retired reason must not come back");
    assert.doesNotMatch(posted, /branch_diverged/);
    // The human's commit is untouched: refusing costs the branch nothing.
    assert.equal(git(contractBare, "rev-parse", "refs/heads/feat/human"), humanTip, "the human's branch is left exactly where it was");
  }

  // --- WARN-1 / NOTE-1: how a registry fetch that never answers is reported ---
  {
    // (a) the connection is reset before a single header. `??` binds tighter than `?:`, so the
    //     old expression reported EVERY connection failure — ECONNREFUSED included — as
    //     "timed out after N ms". The reason must name what actually happened.
    f.contractRespond = (id, request) => {
      if (id !== "wo-reset") return false;
      request.socket.destroy();
      return true;
    };
    const reset = orderFor("wo-reset");
    f.busMessages.push(handoff("m-reset", register(reset, specFor(reset, { targetBranch: "feat/reset" }))));
    let r = await run({ env: { VINCI_WORKER_REGISTRY_TIMEOUT_MS: "30000" } });
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-reset", "registry_unavailable");
    assert.doesNotMatch(postsFor("m-reset"), /timed out after/, "a connection failure is NOT a timeout and must not say so");
    assert.match(postsFor("m-reset"), /governor contracts fetch failed: (UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED)/, `the reason names the connection error: ${postsFor("m-reset")}`);

    // (b) NOTE-1: the registry is a PINNED endpoint. A 3xx would move the contract fetch — and
    //     the bearer token — to a host nobody named, so `redirect: "error"` makes it a refusal.
    f.contractRespond = (id, request, response) => {
      if (id !== "wo-redirect") return false;
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      response.end();
      return true;
    };
    const redirect = orderFor("wo-redirect");
    f.busMessages.push(handoff("m-redirect", register(redirect, specFor(redirect, { targetBranch: "feat/redirect" }))));
    r = await run();
    assert.equal(r.status, 0, r.stderr);
    assertRefusedBeforeTransfer("m-redirect", "registry_unavailable");
    assert.doesNotMatch(postsFor("m-redirect"), /timed out after/);
    f.contractRespond = null;
  }

  // --- WARN-3: invalid_bounds names the field that tripped -----------------------------------
  // budgetMicrousd: 0 is a VALID execution spec upstream (a non-negative integer) and blocks
  // here. The old reason listed all three bounds and left the operator to guess which to fix.
  {
    const order = orderFor("wo-zerobudget");
    f.busMessages.push(handoff("m-zerobudget", register(order, specFor(order, { targetBranch: "feat/zerobudget", resourceBounds: { ...happySpec.resourceBounds, budgetMicrousd: 0 } }))));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a zero budget never spawns");
    assert.equal(taskState("m-zerobudget").state, "BLOCKED");
    assert.equal(taskState("m-zerobudget").limit_tripped, "budget_usd");
    assert.match(taskState("m-zerobudget").outcome.reason, /^invalid_bounds: budget_usd must be greater than zero, got 0$/, taskState("m-zerobudget").outcome.reason);
    assert.match(postsFor("m-zerobudget"), /invalid_bounds budget_usd=0/);
  }

  // --- NOTE-4: a digest handoff whose message_id is not a task id still carries a contract tag --
  // The refusal fires before the body is read, so there is no triple to name — but a reader
  // filtering the ledger for `contract=` posts must not silently lose the row. The prose path's
  // untagged body is unchanged.
  {
    f.busMessages.push(handoff("m bad id", happyTriple));
    f.busMessages.push(handoff("m bad prose", "repo: proseorg/coderepo\nevidence: none\n\nprose task"));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    const digestPost = f.getPostedMessages().find((m) => m.in_reply_to === "m bad id");
    assert.ok(digestPost, "the invalid digest handoff is answered");
    assert.match(digestPost.body, /^contract=malformed invalid task id: m bad id worker_build=/, digestPost.body);
    const prosePost = f.getPostedMessages().find((m) => m.in_reply_to === "m bad prose");
    assert.ok(prosePost, "the invalid prose handoff is answered");
    assert.match(prosePost.body, /^invalid task id: m bad prose worker_build=/, prosePost.body);
    assert.doesNotMatch(prosePost.body, /contract=/, "a prose handoff still carries NO contract tag");
    assert.equal(f.getVinciCalls().length, vinciRuns, "neither invalid handoff spawns");
  }

  // --- CCM-v0: governed evidence and its terminal share the validated WorkOrder identity ---
  //
  // task.mjs builds a contract envelope with `ref: undefined`. Before #53 that meant no evidence
  // POST; before #54 the new durable row still disagreed with an unreferenced terminal. The #295
  // ruling keeps WorkOrder canonical, admits validated `wo-` refs, and leaves WorkOrder existence
  // plus program binding to the evidence server. Backlog identity is never substituted.
  {
    const awsRecord = join(f.tempDir, "aws-ccm-calls.txt");
    const evidenceEnv = { VINCI_EVIDENCE_URI_PREFIX: "s3://evidence-bucket/worker/", FAKE_AWS_RECORD: awsRecord };
    const postsBefore = f.getEvidencePosts().length;

    // A validated contract id outside both admitted namespaces still posts nothing and cannot
    // borrow a plausible bk_ row from anywhere else.
    const unfilableOrder = orderFor("contract-ccm-control");
    debrisAuthority.reserveTask("m-ccm-control");
    f.busMessages.push(handoff("m-ccm-control", register(
      unfilableOrder,
      specFor(unfilableOrder, { targetBranch: "feat/ccm-control" }),
    )));
    let r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "ccm-control.txt", ...evidenceEnv } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(
      f.getEvidencePosts().length, postsBefore,
      "an inadmissible WorkOrder id must post no evidence",
    );
    const unfilableTerminal = f.getPostedMessages().filter((m) => m.in_reply_to === "m-ccm-control").at(-1);
    assert.equal(unfilableTerminal.kind, "status");
    assert.equal(unfilableTerminal.refs, undefined);

    // Positive: the exact `wo-` id came from the registry-validated order/spec pair. The fake
    // server independently sees that the WorkOrder exists and is bound to its configured program.
    const woOrder = orderFor("wo-ccm7");
    debrisAuthority.reserveTask("m-ccm-governed");
    f.busMessages.push(handoff("m-ccm-governed", register(
      woOrder,
      specFor(woOrder, { targetBranch: "feat/ccm-governed" }),
    )));
    r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "ccm-governed.txt", ...evidenceEnv } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;

    assert.deepEqual(f.rejectedPosts, [], `the bus refused a post the worker should never have sent: ${JSON.stringify(f.rejectedPosts)}`);
    const posts = f.getEvidencePosts();
    assert.equal(posts.length, postsBefore + 1, `exactly one evidence POST, from the governed run: ${JSON.stringify(posts)}`);
    const post = posts.at(-1);
    assert.equal(post.job_ref, "wo-ccm7", "the bundle is filed under the WorkOrder, never a backlog surrogate");
    assert.equal(post.kind, "bundle");

    // WorkOrder + run + attempt are all explicit in the durable row. The terminal is a finding
    // under that same ref, replying to the exact handoff message that names this run.
    assert.ok(post.economics_summary, "the POST carries the economics summary");
    assert.equal(post.economics_summary.work_order_id, post.job_ref, "summary key == evidence key");
    assert.equal(post.economics_summary.attempt_label, "m-ccm-governed/1");
    assert.match(post.economics_sha256 ?? "", /^[0-9a-f]{64}$/);

    const completedPost = f.getPostedMessages().filter((m) => m.in_reply_to === "m-ccm-governed").at(-1);
    assert.ok(completedPost, "the governed attempt posts a terminal");
    assert.equal(completedPost.kind, "finding");
    assert.equal(completedPost.outcome, "COMPLETED");
    assert.deepEqual(completedPost.refs, [post.job_ref], "terminal ref == durable evidence ref");
    const publicEvidenceRecords = JSON.stringify({ post, completedPost });
    assert.equal(publicEvidenceRecords.includes(woOrder.request), false, "bus metadata must not disclose the WorkOrder request");
    assert.equal(publicEvidenceRecords.includes(woOrder.scope), false, "bus metadata must not disclose the WorkOrder scope");

    // Replaying the same bus page is idempotent: the cursor/lifecycle pair emits no second row or
    // terminal for the already-terminal attempt.
    const evidenceAfterSuccess = f.getEvidencePosts().length;
    const terminalsAfterSuccess = f.getPostedMessages().filter((m) => m.in_reply_to === "m-ccm-governed").length;
    r = await run({ env: evidenceEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getEvidencePosts().length, evidenceAfterSuccess);
    assert.equal(f.getPostedMessages().filter((m) => m.in_reply_to === "m-ccm-governed").length, terminalsAfterSuccess);

    // The worker cannot self-assert program binding. An existing, locally valid WorkOrder whose
    // server-side binding is absent or stale reaches the one ingress, gets 422, downgrades to
    // UNVERIFIED, and does not attach the refused ref to its terminal.
    for (const [id, programId] of [["unbound", null], ["stale", "prog-stale"]]) {
      const order = orderFor(`wo-ccm-${id}`);
      const taskId = `m-ccm-${id}`;
      debrisAuthority.reserveTask(taskId);
      f.busMessages.push(handoff(taskId, register(
        order,
        specFor(order, { targetBranch: `feat/ccm-${id}` }),
        { programId },
      )));
      const rejectedBefore = f.rejectedPosts.length;
      r = await run({ env: { FAKE_VINCI_COMMIT_FILE: `ccm-${id}.txt`, ...evidenceEnv } });
      assert.equal(r.status, 0, r.stderr);
      vinciRuns += 1;
      assert.equal(f.rejectedPosts.length, rejectedBefore + 1, `${id}: server must refuse the wo- evidence ref`);
      assert.equal(taskState(taskId).state, "UNVERIFIED");
      const terminal = f.getPostedMessages().filter((m) => m.in_reply_to === taskId).at(-1);
      assert.equal(terminal.kind, "status");
      assert.equal(terminal.refs, undefined);
      assert.match(terminal.body, /evidence_error=Bus POST failed: 422/);
    }

    // A transport/server failure on an otherwise valid WorkOrder follows the same truthful
    // downgrade. It is not retried as a second ingress and never claims a finding ref.
    const woFail = orderFor("wo-ccm8");
    debrisAuthority.reserveTask("m-ccm-postfail");
    f.busMessages.push(handoff("m-ccm-postfail", register(woFail, specFor(woFail, { targetBranch: "feat/ccm-postfail" }))));
    f.evidencePostStatus = 500;
    try {
      r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "ccm-postfail.txt", ...evidenceEnv } });
    } finally {
      f.evidencePostStatus = null;
    }
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    const failState = taskState("m-ccm-postfail");
    assert.equal(failState.state, "UNVERIFIED", `a governed attempt whose evidence POST fails is not COMPLETED: ${JSON.stringify(failState)}`);
    assert.ok(failState.evidence_error, "the failure is recorded, not swallowed");
    // The LAST post in the thread is the terminal; the first is `claimed`.
    const failPost = f.getPostedMessages().filter((m) => m.in_reply_to === "m-ccm-postfail").at(-1);
    assert.ok(failPost, "the governed attempt still posts a terminal");
    assert.equal(failPost.kind, "status");
    assert.equal(failPost.refs, undefined);
    assert.match(failPost.body, /evidence_error=/, failPost.body);

    // Runtime failure still emits one governed bundle under the canonical WorkOrder. FAILED is
    // deliberately a status terminal (the finding contract remains COMPLETED-only), so it never
    // advertises a successful evidence ref even though the diagnostic row is durable.
    const runtimeFailOrder = orderFor("wo-ccm-runtime-fail");
    debrisAuthority.reserveTask("m-ccm-runtime-fail");
    f.busMessages.push(handoff("m-ccm-runtime-fail", register(
      runtimeFailOrder,
      specFor(runtimeFailOrder, { targetBranch: "feat/ccm-runtime-fail" }),
    )));
    const runtimeFailBefore = f.getEvidencePosts().length;
    r = await run({ env: { FAKE_VINCI_EXIT: "3", ...evidenceEnv } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    const runtimeFailPosts = f.getEvidencePosts().slice(runtimeFailBefore);
    assert.equal(runtimeFailPosts.length, 1);
    assert.equal(runtimeFailPosts[0].job_ref, runtimeFailOrder.id);
    assert.equal(runtimeFailPosts[0].economics_summary.attempt_label, "m-ccm-runtime-fail/1");
    assert.equal(taskState("m-ccm-runtime-fail").state, "FAILED");
    const runtimeFailTerminal = f.getPostedMessages().filter((m) => m.in_reply_to === "m-ccm-runtime-fail").at(-1);
    assert.equal(runtimeFailTerminal.kind, "status");
    assert.equal(runtimeFailTerminal.outcome, "FAILED");
    assert.equal(runtimeFailTerminal.refs, undefined);

    // A resumed non-terminal record keeps the same WorkOrder key while advancing the attempt
    // identity. This is the retry side of the same invariant; the lifecycle table and restart
    // integration suites separately exercise the real interruption/cancellation mechanics.
    const retryOrder = orderFor("wo-ccm-retry");
    const retryTaskId = "m-ccm-retry";
    mkdirSync(join(f.tempDir, "tasks"), { recursive: true });
    writeFileSync(
      join(f.tempDir, "tasks", `${retryTaskId}.json`),
      `${JSON.stringify({ task: retryTaskId, attempt: 1, session_id: "ccm-retry-session", state: "RUNNING", terminal: false })}\n`,
    );
    debrisAuthority.reserveTask(retryTaskId);
    f.busMessages.push(handoff(retryTaskId, register(
      retryOrder,
      specFor(retryOrder, { targetBranch: "feat/ccm-retry" }),
    )));
    const retryBefore = f.getEvidencePosts().length;
    r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "ccm-retry.txt", ...evidenceEnv } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    const retryPost = f.getEvidencePosts().slice(retryBefore);
    assert.equal(retryPost.length, 1);
    assert.equal(retryPost[0].job_ref, retryOrder.id);
    assert.equal(retryPost[0].economics_summary.attempt_label, `${retryTaskId}/2`);
    assert.equal(taskState(retryTaskId).attempt, 2);
    assert.deepEqual(
      f.getPostedMessages().filter((m) => m.in_reply_to === retryTaskId).at(-1).refs,
      [retryOrder.id],
    );

    // Two runs under one WorkOrder retain one canonical ref while preserving distinct run and
    // attempt identities. Each spec is selected by its recomputed digest.
    const multiOrder = orderFor("wo-ccm-multi");
    const multiSpecs = [
      specFor(multiOrder, { targetBranch: "feat/ccm-multi-a" }),
      specFor(multiOrder, { targetBranch: "feat/ccm-multi-b" }),
    ];
    f.contractRegistry[multiOrder.id] = { work_order: multiOrder, execution_specs: multiSpecs };
    f.workOrderPrograms[multiOrder.id] = f.evidenceProgramId;
    for (const [suffix, spec] of [["a", multiSpecs[0]], ["b", multiSpecs[1]]]) {
      const taskId = `m-ccm-multi-${suffix}`;
      debrisAuthority.reserveTask(taskId);
      f.busMessages.push(handoff(
        taskId,
        triple(multiOrder.id, workOrderDigest(multiOrder), executionSpecDigest(spec)),
      ));
    }
    const multiBefore = f.getEvidencePosts().length;
    r = await run({ env: { FAKE_VINCI_COMMIT_FILE: "ccm-multi.txt", ...evidenceEnv } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 2;
    const multiPosts = f.getEvidencePosts().slice(multiBefore);
    assert.equal(multiPosts.length, 2);
    assert.deepEqual(multiPosts.map((p) => p.job_ref), [multiOrder.id, multiOrder.id]);
    assert.deepEqual(
      multiPosts.map((p) => p.economics_summary.attempt_label).sort(),
      ["m-ccm-multi-a/1", "m-ccm-multi-b/1"],
    );
    assert.notEqual(multiPosts[0].sha256, multiPosts[1].sha256, "distinct runs retain distinct durable bundles");
    for (const taskId of ["m-ccm-multi-a", "m-ccm-multi-b"]) {
      const terminal = f.getPostedMessages().filter((m) => m.in_reply_to === taskId).at(-1);
      assert.deepEqual(terminal.refs, [multiOrder.id]);
    }
  }

  console.log("PASS worker-handoff-triple");
} finally {
  await f.cleanup();
  debrisAuthority.cleanup();
}
