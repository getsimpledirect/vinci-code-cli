// S03 generation identity, CONSUMER-TESTED end to end.
//
// The unit controls in worker-generation-identity.mjs stop at buildEconomicsSummary's return value.
// This drives the REAL worker daemon (`worker.mjs start --once`) against a fake bus and fixture
// binaries, and reads the identity chain back out of the artifact a consumer actually reads:
// `economics/<task>/economics-summary.json` on disk, whose sha256 is carried on the terminal post.
//
// The whole chain, every link asserted on the persisted artifact:
//
//     envelope `model:` header ....... requested -> route.initial_provider / initial_model
//     session usage entry ............ resolved  -> generation_identity.resolved_model
//     session usage entry ............ observed  -> generation_identity.observed_model
//     terminal bus post .............. used      -> economics digest + the usage[] actually billed
//
// The discriminating property: the fixture reports a served model that DIFFERS from the requested
// one, so an implementation that echoes the request back cannot pass.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "worker-test-tools");

const REQUESTED_MODEL = "requested/model-A";
const RESOLVED_MODEL = "resolved/model-B";
const OBSERVED_MODEL = "observed/model-C";

// A session the fixture `vinci` binary appends: one outcome plus one usage entry whose observed id
// is neither the requested id nor the resolved id.
function sessionFixture({ observed }) {
  const usageBlock = (models, observedModels) => ({
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0.01,
    providers: ["openrouter"],
    models,
    observedModels,
    resolvedModels: [RESOLVED_MODEL],
    observedModelCalls: observedModels.length > 0 ? 1 : 0,
  });
  const collapsed = [observed ?? RESOLVED_MODEL];
  const observedModels = observed ? [observed] : [];
  const outcome = {
    type: "custom",
    customType: "vinci-task-outcome",
    data: {
      schemaVersion: 1,
      taskId: "SESSION_ID",
      state: "DONE",
      reason: "fixture outcome",
      changedFiles: [],
      verificationStatus: "passed",
      verificationCommand: "fixture check",
      usage: usageBlock(collapsed, observedModels),
      recordedAt: "2026-09-10T00:00:00Z",
    },
  };
  const usage = {
    type: "custom",
    customType: "vinci-task-usage",
    data: {
      responseKey: "openrouter resp-1",
      usage: usageBlock(collapsed, observedModels),
    },
  };
  return [JSON.stringify(outcome), JSON.stringify(usage)].join("\n") + "\n";
}

async function runWorker({ observed, taskId, name, workerId }) {
  const fixture = new WorkerTestFixture(name);
  try {
    fixture.createRepo("test", "repo");
    fixture.linkTools(TOOLS);
    const sessionPath = join(fixture.tempDir, `session-${taskId}.jsonl`);
    writeFileSync(sessionPath, sessionFixture({ observed }));

    await fixture.startBus([
      {
        message_id: taskId,
        kind: "handoff",
        to_agent: `worker:${workerId}`,
        subject: "generation identity",
        // The REQUESTED pair enters the system here and nowhere else.
        body: `repo: test/repo\nprovider: openrouter\nmodel: ${REQUESTED_MODEL}\nevidence: none\nbudget_usd: 20\nref: job_gi${taskId}\n\nDo the task`,
        ts: "2026-09-10T10:00:00Z",
        posted_by: "scheduler",
      },
    ]);

    const proc = spawn(
      "node",
      [
        join(ROOT, "vinci/worker/worker.mjs"),
        "start",
        "--id",
        workerId,
        "--server",
        fixture.busUrl(),
        "--once",
        "--state-dir",
        fixture.tempDir,
      ],
      {
        env: fixture.getEnv({ FAKE_VINCI_USAGE: "1", FAKE_VINCI_SESSION_FIXTURE: sessionPath }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    const code = await new Promise((r) => proc.on("close", r));
    assert.equal(code, 0, `worker exited ${code}: ${stderr.slice(-1200)}`);

    // A completed attempt writes economics into the ATTEMPT dir; only early terminals (no
    // repository) fall back to <state-dir>/economics/<task>. Discover it rather than guessing.
    const found = execFileSync("find", [fixture.tempDir, "-name", "economics-summary.json"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
    assert.equal(found.length > 0, true,
      `no economics summary anywhere under ${fixture.tempDir}\n${stderr.slice(-1500)}`);
    const file = found[0];
    const raw = readFileSync(file, "utf8");
    return { summary: JSON.parse(raw), raw, posts: fixture.getPostedMessages() };
  } finally {
    fixture.cleanup?.();
  }
}

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

// ---------------------------------------------------------------------------------------------
// The whole chain, through the real worker, with all three identities different.
// ---------------------------------------------------------------------------------------------
await check("the whole chain survives to the on-disk economics artifact", async () => {
  const { summary, raw, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    taskId: "91",
    name: "gen-identity-observed",
    workerId: "w6",
  });

  // requested -- from the envelope header, through the daemon, onto the artifact.
  assert.equal(summary.route.initial_provider, "openrouter", "requested provider missing from the artifact");
  assert.equal(summary.route.initial_model, REQUESTED_MODEL, "requested model missing from the artifact");

  const gi = summary.generation_identity;
  assert.ok(gi, "generation_identity absent from the persisted artifact");
  assert.equal(gi.resolved_model, RESOLVED_MODEL, "resolved model missing from the artifact");
  assert.equal(gi.observed_model, OBSERVED_MODEL, "observed model missing from the artifact");
  assert.equal(gi.observation, "observed");
  assert.equal(gi.observation_source, "response-stream");
  assert.equal(gi.matches_requested, false, "a served model different from the request must not read as a match");

  // All three pairwise distinct ON THE ARTIFACT, not merely in memory.
  assert.equal(
    new Set([summary.route.initial_model, gi.resolved_model, gi.observed_model]).size,
    3,
    "the three identities collapsed somewhere on the way to disk",
  );

  // used -- what was actually billed, and the digest a consumer binds the evidence by.
  assert.ok(Array.isArray(summary.usage) && summary.usage.length > 0, "no usage rows: nothing was actually consumed");
  assert.equal(gi.observed_model_calls, 1, "the observed call was not counted");
  assert.equal(gi.unobserved_model_calls, 0);

  const digest = createHash("sha256").update(raw).digest("hex");
  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes(digest));
  assert.ok(
    terminal,
    `no terminal bus post carries the artifact digest ${digest.slice(0, 12)} -- ` +
      "the consumer cannot bind the identity evidence to this attempt",
  );
});

// ---------------------------------------------------------------------------------------------
// The refusal, end to end. The provider reported nothing; both wrong answers are present in the
// same artifact and neither may be substituted.
// ---------------------------------------------------------------------------------------------
await check("an unobserved run stays unknown on the artifact", async () => {
  const { summary } = await runWorker({ observed: null, taskId: "92", name: "gen-identity-unknown", workerId: "w7" });

  // Control preconditions: the two values a lazy implementation would copy ARE present here.
  assert.equal(summary.route.initial_model, REQUESTED_MODEL, "precondition: requested present and copyable");
  assert.equal(
    summary.generation_identity.resolved_model,
    RESOLVED_MODEL,
    "precondition: resolved present and copyable",
  );

  const gi = summary.generation_identity;
  assert.equal(gi.observed_model, null, "unknown served identity was back-filled on the artifact");
  assert.notEqual(gi.observed_model, REQUESTED_MODEL);
  assert.notEqual(gi.observed_model, RESOLVED_MODEL);
  assert.equal(gi.observation, "unavailable");
  assert.equal(gi.matches_requested, null, "unknown collapsed into a matched/mismatched boolean on the artifact");
  assert.equal(gi.unobserved_model_calls >= 1, true, "an unobserved call was not counted as unobserved");

  // And the run really happened -- this is a refusal to CLAIM, not an absence of work.
  assert.ok(
    Array.isArray(summary.usage) && summary.usage.length > 0,
    "no usage rows: this would be a vacuous pass, since a run with no calls trivially observes nothing",
  );
});

console.log(results.join("\n"));
if (process.exitCode === 1) console.error("worker-generation-identity-consumer: FAILURES above");
else console.log(`worker-generation-identity-consumer: ${results.length} checks passed`);
