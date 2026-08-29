// Wave 1B digest-form handoff (triple) against the real daemon. The fixture bus serves the
// Governor's pinned-contract registry (`GET /v1/governor/contracts/{work_order_id}`) so the
// digest form can run end to end: parse the triple, fetch the registry, recompute both digests
// and the binding, then clone/checkout/spawn. Every refusal — malformed triple, 404 registry,
// digest mismatch, binding mismatch, unknown model class, bad field — must BLOCK before a clone
// and before a vinci spawn, and each terminal post must name the refusal reason.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { executionSpecDigest, workOrderDigest } from "../worker/contracts/digest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = join(ROOT, "vinci/bin/vinci");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "fixtures/contract-vectors");
const ZERO64 = "0".repeat(64);

const f = new WorkerTestFixture("handoff-triple");
const run = () =>
  new Promise((resolve) => {
    const child = spawn(
      "bash",
      [LAUNCHER, "worker", "start", "--id", "w1", "--server", f.busUrl(), "--once", "--state-dir", f.tempDir],
      { env: f.getEnv(), stdio: ["ignore", "pipe", "pipe"] },
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

try {
  f.linkTools(TOOLS);
  // The digest repository (github.com/getsimpledirect/vinci-contracts → test fixture origin).
  f.createRepo("getsimpledirect", "vinci-contracts");
  const contractBare = join(f.reposDir, "getsimpledirect", "vinci-contracts.git");
  const baseCommit = execFileSync("git", ["--git-dir", contractBare, "rev-parse", "refs/heads/main"])
    .toString()
    .trim();
  assert.match(baseCommit, /^[0-9a-f]{40}$/, "fixture repo must expose a real main commit");
  // A separate repo for the legacy prose case so it stays independent of the digest checkout.
  f.createRepo("proseorg", "coderepo");

  // Golden-vector contract and spec, reloaded from the fixture directory (byte-pinned, never edited).
  const workOrder = JSON.parse(readFileSync(join(VECTORS, "work-order-1-minimal", "input.json"), "utf8"));
  const baseSpec = JSON.parse(readFileSync(join(VECTORS, "execution-spec-1-minimal", "input.json"), "utf8"));
  assert.equal(workOrderDigest(workOrder), "8ba697a58de4eae4ae5405c74659424ac878f5107700cbd0b0001638bca379e2");
  
  // Create a clean fixture spec for the happy-path test: deep-copy, clear capabilities,
  // set future deadlines, use a real non-tip ancestor commit, and recompute both digests.
  const futureDeadline = new Date(Date.now() + 3600 * 1000).toISOString();
  const happySpec = {
    ...JSON.parse(JSON.stringify(baseSpec)), // deep copy
    baseCommit,
    baseRef: "main",
    requiredCapabilities: [], // strip test-only capabilities
    resourceBounds: { 
      budgetMicrousd: baseSpec.resourceBounds.budgetMicrousd,
      maxRuntimeS: baseSpec.resourceBounds.maxRuntimeS,
      deadline: futureDeadline, // move deadline 1 hour into the future
    },
  };
  const happySpecDigest = executionSpecDigest(happySpec);
  const contractDigest = workOrderDigest(workOrder);

  // A spec that was compiled from a DIFFERENT work order, for the binding_mismatch case.
  const foreignSpec = { ...happySpec, workOrderId: "wo-other", workOrderDigest: ZERO64 };
  // A work order whose id matches its registry key so binding passes and the failure lands on
  // modelClass: an unknown model class must be refused by ITS code, not by an earlier id mismatch.
  const turboOrder = { ...workOrder, id: "wo-turbo" };
  const turboOrderDigest = workOrderDigest(turboOrder);
  const turboSpec = { ...happySpec, modelClass: "turbo", workOrderId: "wo-turbo", workOrderDigest: turboOrderDigest };
  // Same shape for an unusable field (non-plain targetBranch), so the failure lands on invalid_spec_field.
  const badBranchOrder = { ...workOrder, id: "wo-badbranch" };
  const badBranchOrderDigest = workOrderDigest(badBranchOrder);
  const badBranchSpec = { ...happySpec, targetBranch: "+oops", workOrderId: "wo-badbranch", workOrderDigest: badBranchOrderDigest };

  await f.startBus(
    [],
    {
      "wo-vec-1": { work_order: workOrder, execution_spec: happySpec },
      "wo-turbo": { work_order: turboOrder, execution_spec: turboSpec },
      "wo-badbranch": { work_order: badBranchOrder, execution_spec: badBranchSpec },
      // A matching execution_spec whose binding names this same work order id, so only the
      // binding assertion can fail. Reuse happySpec's digest of the foreign spec.
      "wo-vec-1-foreign": { work_order: workOrder, execution_spec: foreignSpec },
    },
  );

  // --- 7. malformed_extra_key --- (no registry interaction; refused before fetch)
  {
    f.busMessages.push({
      message_id: "m-extra",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "extra",
      body: JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: contractDigest, execution_spec_digest: happySpecDigest, extra: 1 }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "extra-key malformed triple must never spawn");
    assert.equal(f.contractRequests.length, 0, "malformed triple refused before the registry fetch");
    assert.match(postsFor("m-extra"), /malformed_handoff/, "extra key must be a malformed_handoff refusal");
  }

  // --- 8. malformed_missing_key --- (one of the three keys absent)
  {
    f.busMessages.push({
      message_id: "m-missing",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "missing",
      body: JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: contractDigest }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "missing-key malformed triple must never spawn");
    assert.equal(f.contractRequests.length, 0, "malformed triple refused before the registry fetch");
    assert.match(postsFor("m-missing"), /malformed_handoff/, "missing key must be a malformed_handoff refusal");
  }

  // --- 2. contract_digest_mismatch --- (the served order digests differently than the triple)
  {
    f.busMessages.push({
      message_id: "m-contract",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "contract",
      body: JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: ZERO64, execution_spec_digest: happySpecDigest }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "contract_digest_mismatch must never spawn");
    assert.match(postsFor("m-contract"), /contract_digest_mismatch/, "wrong contract digest must be refused by code");
  }

  // --- 3. execution_spec_digest_mismatch --- (no served spec reproduces the named digest)
  {
    f.busMessages.push({
      message_id: "m-spec",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "spec",
      body: JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: contractDigest, execution_spec_digest: ZERO64 }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "execution_spec_digest_mismatch must never spawn");
    assert.match(postsFor("m-spec"), /execution_spec_digest_mismatch/, "missing spec digest must be refused by code");
  }

  // --- 4. binding_mismatch --- (the spec was compiled from a different work order)
  {
    f.busMessages.push({
      message_id: "m-binding",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "binding",
      body: JSON.stringify({
        work_order_id: "wo-vec-1-foreign",
        contract_digest: contractDigest,
        execution_spec_digest: executionSpecDigest(foreignSpec),
      }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "binding_mismatch must never spawn");
    assert.match(postsFor("m-binding"), /binding_mismatch/, "foreign spec must be refused by binding code");
  }

  // --- 5. unknown_modelClass --- (spec.modelClass not in the closed table)
  {
    f.busMessages.push({
      message_id: "m-model",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "model",
      body: JSON.stringify({ work_order_id: "wo-turbo", contract_digest: turboOrderDigest, execution_spec_digest: executionSpecDigest(turboSpec) }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "unknown_model_class must never spawn");
    assert.match(postsFor("m-model"), /unknown_model_class/, "unknown model class must be refused by code");
  }

  // --- invalid_spec_field --- (a field that fails materialization, refused before clone)
  {
    f.busMessages.push({
      message_id: "m-field",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "field",
      body: JSON.stringify({
        work_order_id: "wo-badbranch",
        contract_digest: badBranchOrderDigest,
        execution_spec_digest: executionSpecDigest(badBranchSpec),
      }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "invalid_spec_field must never spawn");
    assert.match(postsFor("m-field"), /invalid_spec_field/, "unusable field must be refused by code");
  }

  // --- 6. 404 response --- (registry has no contract for the named work order)
  {
    f.busMessages.push({
      message_id: "m-404",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "not-found",
      body: JSON.stringify({ work_order_id: "wo-missing", contract_digest: contractDigest, execution_spec_digest: happySpecDigest }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 0, "404 registry must never spawn");
    assert.match(postsFor("m-404"), /work_order_not_found/, "404 registry fetch must be refused before clone");
    assert.ok(f.contractRequests.some((c) => c.workOrderId === "wo-missing"), "the 404 work order id must have been requested");
  }

  // --- 1. Happy path --- (materialize, clone, checkout baseCommit, record fields, contract= post)
  {
    f.busMessages.push({
      message_id: "m-happy",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "happy",
      body: JSON.stringify({ work_order_id: "wo-vec-1", contract_digest: contractDigest, execution_spec_digest: happySpecDigest }),
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 1, "the happy-path digest handoff must run exactly one vinci");
    const repoDir = join(f.tempDir, "repos", "vinci-contracts");
    const headSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"]).toString().trim();
    const headRef = execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    assert.equal(headSha, baseCommit, "checkout must sit exactly on the pinned baseCommit");
    assert.equal(headRef, "feat/vector-1", "checkout must create the spec's targetBranch from baseCommit");
    const posted = postsFor("m-happy");
    assert.match(posted, new RegExp(`contract=wo-vec-1@${contractDigest.slice(0, 8)}`), "terminal post must cite contract=work_order_id@digest8");
    assert.match(posted, /state=COMPLETED/, "happy-path digest task should complete");
  }

  // --- 9. legacy prose handoff still works ---
  {
    f.busMessages.push({
      message_id: "m-prose",
      to_agent: "worker:w1",
      kind: "handoff",
      subject: "prose",
      body: "repo: proseorg/coderepo\nevidence: none\n\nprose task",
      ts: new Date().toISOString(),
      posted_by: "x",
    });
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.getVinciCalls().length, 2, "the legacy prose handoff must run a second vinci");
    const posted = postsFor("m-prose");
    assert.match(posted, /state=UNVERIFIED/, "legacy prose handoff runs and reaches its terminal UNVERIFIED state");
    assert.ok(!/contract=/.test(posted), "a prose handoff must not carry a contract= tag");
  }

  console.log("PASS worker-handoff-triple");
} finally {
  await f.cleanup();
}
