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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const run = ({ args = [], env = {} } = {}) =>
  new Promise((resolve) => {
    f.resetGitCalls();
    const child = spawn(
      "bash",
      [LAUNCHER, "worker", "start", "--id", "w1", "--server", f.busUrl(), "--once", "--state-dir", f.tempDir, ...args],
      { env: f.getEnv(env), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("exit", (status) => {
      clearTimeout(timer);
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
  const orderFor = (id, overrides = {}) => ({ ...workOrder, id, ...overrides });
  // Register a (order, spec) pair under the order's id; returns the triple body. `specDigest`
  // lets a test name a spec the validator refuses (recordDigest: the raw identity).
  const register = (order, spec, { orderDigest = workOrderDigest(order), specDigest = executionSpecDigest(spec) } = {}) => {
    f.contractRegistry[order.id] = { work_order: order, execution_spec: spec };
    return triple(order.id, orderDigest, specDigest);
  };

  const happySpec = specFor(workOrder);
  const happySpecDigest = executionSpecDigest(happySpec);
  const contractDigest = workOrderDigest(workOrder);

  await f.startBus([], {});
  const happyTriple = register(workOrder, happySpec);

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
    f.contractRegistry["wo-vec-1-foreign"] = { work_order: workOrder, execution_spec: foreignSpec };
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
    const host = orderFor("wo-host");
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

  // --- prose past-deadline: the early blocker post has NO contract= tag (byte-identical prose path) ---
  {
    f.busMessages.push(handoff("m-prose-late", "repo: proseorg/coderepo\nevidence: none\ndeadline: 2020-01-01T00:00:00Z\n\nprose task"));
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, vinciRuns, "a past deadline never spawns");
    const blocker = f.getPostedMessages().find((m) => m.kind === "blocker" && JSON.stringify(m).includes("m-prose-late"));
    assert.ok(blocker, "a blocker is posted for the past deadline");
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
    assert.match(postsFor("m-classes"), /state=BLOCKED/, "the m-classes handoff that the three refused daemons never touched is processed by this pass; it is BLOCKED as branch_diverged (its targetBranch now tracks origin)");
    assert.match(postsFor("m-classes"), /branch_diverged/);
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
      let blocker = f.getPostedMessages().find((m) => m.kind === "blocker" && m.in_reply_to === "m-gov-refused");
      assert.match(blocker.body, new RegExp(`^${tag} Governor refused the lease: rule: paths under / are frozen tonight worker_build=`), blocker.body);
      assert.equal(taskState("m-gov-refused").outcome.governor, "refused");

      f.busMessages.push(handoff("m-gov-down", happyTriple));
      r = await run({ args: ["--governor", closedUrl], env: { VINCI_GOVERNOR_TOKEN: "gov-token" } });
      assert.equal(r.status, 0, r.stderr);
      assertRefusedBeforeTransfer("m-gov-down", "Governor unavailable/invalid");
      blocker = f.getPostedMessages().find((m) => m.kind === "blocker" && m.in_reply_to === "m-gov-down");
      assert.match(blocker.body, new RegExp(`^${tag} Governor unavailable/invalid: Governor connection failed: `), blocker.body);
      assert.equal(taskState("m-gov-down").outcome.governor, "unavailable");

      // Prose path: same refusal, NO tag, body unchanged.
      f.busMessages.push(handoff("m-gov-prose", "repo: proseorg/coderepo\nevidence: none\n\nprose task"));
      r = await run({ args: ["--governor", governorUrl], env: { VINCI_GOVERNOR_TOKEN: "gov-token" } });
      assert.equal(r.status, 0, r.stderr);
      blocker = f.getPostedMessages().find((m) => m.kind === "blocker" && m.in_reply_to === "m-gov-prose");
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
    assert.equal(git(repoDir, "rev-parse", "feat/residue"), baseCommit, "the task branch was recreated from base_commit");
    assert.match(r.stderr, /never-pushed residue on feat\/residue .* renamed aside to stale\/feat\/residue-/);

    // (c) a local <targetBranch> that TRACKS origin/<targetBranch> and is ahead of base_commit
    //     is refused (branch_diverged) and left exactly where it is; no checkout -B ran.
    git(repoDir, "checkout", "-qb", "feat/tracked", baseCommit);
    writeFileSync(join(repoDir, "tracked.txt"), "pushed\n");
    git(repoDir, "add", "tracked.txt");
    git(repoDir, "commit", "-qm", "tracked");
    git(repoDir, "push", "-q", "-u", "origin", "feat/tracked");
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

  console.log("PASS worker-handoff-triple");
} finally {
  await f.cleanup();
  debrisAuthority.cleanup();
}
