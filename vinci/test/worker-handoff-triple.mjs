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

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { executionSpecDigest, recordDigest, workOrderDigest } from "../worker/contracts/digest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = join(ROOT, "vinci/bin/vinci");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "fixtures/contract-vectors");
const ZERO64 = "0".repeat(64);

const f = new WorkerTestFixture("handoff-triple");
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
    // A readable @file works and is equivalent to the inline form.
    const classesFile = join(f.tempDir, "classes.json");
    writeFileSync(classesFile, JSON.stringify({ forte: { provider: "vinci", model: "forte" } }));
    let r = await run({ env: { VINCI_WORKER_MODEL_CLASSES: `@${classesFile}` } });
    assert.equal(r.status, 0, r.stderr);
    vinciRuns += 1;
    assert.equal(f.getVinciCalls().length, vinciRuns, "@file table: the digest handoff runs");
    assert.doesNotMatch(postsFor("m-classes"), /state=BLOCKED/, "@file table: the class resolves and the task is not refused");
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

  console.log("PASS worker-handoff-triple");
} finally {
  await f.cleanup();
}
