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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "worker-test-tools");

const REQUESTED_MODEL = "requested/model-A";
const RESOLVED_MODEL = "resolved/model-B";
const OBSERVED_MODEL = "observed/model-C";
const FALLBACK_MODEL = "fallback/provider-default-D";
// Deliberately NOT the requested provider ("openrouter"): if these matched, substituting one for
// the other would be undetectable and the provider assertions would false-green.
const RUNTIME_PROVIDER = "runtime-gateway-Z";

// A session the fixture `vinci` binary appends: one outcome plus one usage entry whose observed id
// is neither the requested id nor the resolved id.
function sessionFixture({
  observed,
  resolved = RESOLVED_MODEL,
  runtimeProvider = RUNTIME_PROVIDER,
  // These two exist so each arm of worker.mjs's `generationOccurred` disjunction can be driven
  // ALONE. With both always set together, deleting either arm changed nothing observable.
  modelCalls = 1,
  responseKey = "openrouter resp-1",
}) {
  const usageBlock = (models, observedModels) => ({
    modelCalls,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0.01,
    providers: runtimeProvider ? [runtimeProvider] : [],
    models,
    observedModels,
    resolvedModels: [resolved],
    observedModelCalls: observedModels.length > 0 ? 1 : 0,
  });
  const collapsed = [observed ?? resolved];
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
  // `responseKey` may be a single key, null (no key at all), or an ARRAY -- an array produces one
  // usage entry per key, which is how a multi-generation attempt is driven.
  const keys = Array.isArray(responseKey) ? responseKey : [responseKey];
  const usageEntries = keys.map((key) => ({
    type: "custom",
    customType: "vinci-task-usage",
    data: {
      ...(key ? { responseKey: key } : {}),
      usage: usageBlock(collapsed, observedModels),
    },
  }));
  return [JSON.stringify(outcome), ...usageEntries.map((e) => JSON.stringify(e))].join("\n") + "\n";
}

// Read BOTH result.json and session.jsonl out of the one tarball the worker handed the uploader.
// They must agree: the generations the evidence claims were used are exactly the generations
// present in the session that produced it. Reading them from the same bundle is the point -- a
// claim checked against a different artifact than the one shipped proves nothing.
function uploadedBundle(fixture) {
  const awsCalls = join(fixture.tempDir, "aws-calls.txt");
  if (!existsSync(awsCalls)) return { result: null, sessionKeys: null };
  const calls = readFileSync(awsCalls, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  if (calls.length === 0) return { result: null, sessionKeys: null };
  const out = mkdtempSync(join(tmpdir(), "gi-bundle-"));
  try {
    const tar = spawnSync("tar", ["xzf", calls[0].argv[3], "-C", out], { encoding: "utf8" });
    if (tar.status !== 0) return { result: null, sessionKeys: null };
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    // The immutable identities actually present in the consumed session.
    const sessionPath = join(out, "session.jsonl");
    const sessionKeys = existsSync(sessionPath)
      ? readFileSync(sessionPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter((e) => e && e.type === "custom" && e.customType === "vinci-task-usage")
          .map((e) => e?.data?.responseKey)
          .filter((k) => typeof k === "string" && k)
          .sort()
      : null;
    return { result, sessionKeys };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function uploadedResultJson(fixture) {
  const awsCalls = join(fixture.tempDir, "aws-calls.txt");
  if (!existsSync(awsCalls)) return null;
  const calls = readFileSync(awsCalls, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  if (calls.length === 0) return null;
  const tarPath = calls[0].argv[3];
  const out = mkdtempSync(join(tmpdir(), "gi-bundle-"));
  try {
    const tar = spawnSync("tar", ["xzf", tarPath, "-C", out], { encoding: "utf8" });
    if (tar.status !== 0) return null;
    return JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

async function runWorker({
  observed,
  resolved,
  runtimeProvider,
  modelCalls,
  responseKey,
  taskId,
  name,
  workerId,
  evidence,
  env = {},
}) {
  const fixture = new WorkerTestFixture(name);
  try {
    fixture.createRepo("test", "repo");
    fixture.linkTools(TOOLS);
    const sessionPath = join(fixture.tempDir, `session-${taskId}.jsonl`);
    writeFileSync(sessionPath, sessionFixture({ observed, resolved, runtimeProvider, modelCalls, responseKey }));

    await fixture.startBus([
      {
        message_id: taskId,
        kind: "handoff",
        to_agent: `worker:${workerId}`,
        subject: "generation identity",
        // The REQUESTED pair enters the system here and nowhere else.
        body: `repo: test/repo\nprovider: openrouter\nmodel: ${REQUESTED_MODEL}\nevidence: ${evidence ?? "none"}\nbudget_usd: 20\nref: job_gi${taskId}\n\nDo the task`,
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
        env: fixture.getEnv({
          FAKE_VINCI_USAGE: "1",
          FAKE_VINCI_SESSION_FIXTURE: sessionPath,
          // Without a prefix uploadEvidence returns before building a bundle, so result.json --
          // the artifact the downstream consumer reads -- would never exist.
          VINCI_EVIDENCE_URI_PREFIX: "s3://bucket/vinci-evidence/",
          // The fake `aws` only records when told where to.
          FAKE_AWS_RECORD: join(fixture.tempDir, "aws-calls.txt"),
          ...env,
        }),
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
    const taskFile = join(fixture.tempDir, "tasks", `${taskId}.json`);
    const task = existsSync(taskFile) ? JSON.parse(readFileSync(taskFile, "utf8")) : null;
    // The fake `aws` records `s3 cp --no-progress <bundle.tgz> <uri>`. Read result.json back out of
    // the tarball the worker ACTUALLY handed the uploader -- that is the artifact a downstream
    // consumer of the evidence bundle receives, not a local copy we arranged for the test.
    const { result, sessionKeys } = uploadedBundle(fixture);
    return { summary: JSON.parse(raw), raw, task, result, sessionKeys, posts: fixture.getPostedMessages() };
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

// ---------------------------------------------------------------------------------------------
// DOWNSTREAM CONSUMER. Producing the field is not the deliverable -- something has to READ it and
// carry the distinction into what it emits. Two real downstream surfaces do:
//   * the terminal bus post, which a scheduler/human reads without opening the bundle
//   * result.json inside the evidence bundle
// Both must show `used_model` as a machine observation or as `unknown`, and must never print the
// requested or resolved string in that slot.
// ---------------------------------------------------------------------------------------------
await check("a downstream consumer preserves the distinction in emitted evidence", async () => {
  const { result, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    taskId: "93",
    name: "gen-identity-downstream",
    workerId: "w4",
  });

  // Consumer 1: the evidence bundle's result.json.
  assert.ok(result, "no result.json in the evidence bundle");
  const ri = result.generation_identity;
  assert.ok(ri, "result.json does not carry the identity interface -- the consumer dropped the field");
  assert.equal(ri.requested_model, REQUESTED_MODEL, "requested lost crossing into result.json");
  assert.equal(ri.resolved_model, RESOLVED_MODEL, "resolved lost crossing into result.json");
  assert.equal(ri.observed_model, OBSERVED_MODEL, "observed lost crossing into result.json");
  assert.equal(new Set([ri.requested_model, ri.resolved_model, ri.observed_model]).size, 3,
    "the consumer collapsed the three identities");

  // STAGE 4, actually_used. The consumer must be able to say WHICH generation it used by an
  // immutable event id, not by a copied model string. Assert the id exists, is not any of the
  // three model strings, and is the id the observation itself came from.
  assert.ok(ri.used_generation_id || ri.used_generation_ids?.length > 0,
    "no generation id: the lineage references only a model string");
  for (const modelString of [REQUESTED_MODEL, RESOLVED_MODEL, OBSERVED_MODEL]) {
    assert.notEqual(ri.used_generation_id, modelString,
      `used_generation_id is a model string (${modelString}), not an event identity`);
  }
  assert.deepEqual(ri.observed_generation_ids, [ri.used_generation_id],
    "the observed identity is not bound to the generation event it came from");
  // All FOUR stages distinct as observable values.
  assert.equal(
    new Set([ri.requested_model, ri.resolved_model, ri.observed_model, ri.used_generation_id]).size,
    4,
    "the four stages are not four distinct observable values",
  );

  // Observation provenance survived downstream.
  assert.equal(ri.observation_source, "response-stream", "observation provenance lost crossing into the bundle");
  // Provider is NEVER observed: no adapter reads a served provider off the wire. The field stays
  // present and null so a consumer can see that, and what the runtime actually ran on is carried
  // separately under its own name.
  assert.equal(ri.observed_provider, null, "observed_provider claims provider provenance that does not exist");
  assert.equal(ri.runtime_provider, RUNTIME_PROVIDER, "runtime provider lost crossing into the bundle");
  assert.notEqual(ri.runtime_provider, ri.requested_provider,
    "runtime provider was taken from the requested provider");
  assert.equal(ri.requested_provider, "openrouter", "precondition: requested provider is present and copyable");

  // Consumer 2: the terminal bus post, read as fields.
  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal, "no terminal post carries used_model= -- the distinction never reached the bus");
  const fields = Object.fromEntries(
    terminal.body.split(/\s+/).filter((t) => t.includes("=")).map((t) => {
      const i = t.indexOf("=");
      return [t.slice(0, i), t.slice(i + 1)];
    }),
  );
  assert.equal(fields.used_model, OBSERVED_MODEL, "the post reports a used_model that was not observed");
  assert.equal(fields.observation, "observed");
  assert.equal(fields.requested_model, REQUESTED_MODEL);
  assert.equal(fields.identity_matches_requested, "false");
  assert.equal(fields.observation_source, "response-stream", "observation provenance never reached the bus");
  assert.equal(fields.observed_provider, undefined, "an unobservable provider was posted as observed");
  assert.equal(fields.runtime_provider, RUNTIME_PROVIDER, "runtime provider never reached the bus");
  assert.notEqual(fields.runtime_provider, fields.requested_model, "provider/model confusion on the post");
  // A real generation id is `provider\0responseId` and is not field-safe, so the post carries a
  // digest of it rather than truncating the body. The binding must still be checkable: the digest
  // has to be the digest OF the id the bundle carries verbatim.
  const safe = /^[A-Za-z0-9._:@+-]+$/.test(ri.used_generation_id);
  if (safe) {
    assert.equal(fields.used_generation_id, ri.used_generation_id,
      "the post's lineage id disagrees with the bundle's");
  } else {
    const expected = createHash("sha256").update(ri.used_generation_id).digest("hex").slice(0, 12);
    assert.equal(fields.used_generation_id_sha256, expected,
      "the post's lineage digest does not bind to the generation id in the bundle");
    assert.equal(fields.used_generation_id, undefined,
      "an unsafe generation id was printed raw and truncated the field list");
    // And the truncation this guards against did not happen: fields after it survived.
    assert.equal(fields.observation, "observed", "the field list was corrupted by the id");
  }
});

await check("a downstream consumer reports unknown, not the requested model", async () => {
  const { result, posts } = await runWorker({
    observed: null,
    taskId: "94",
    name: "gen-identity-downstream-unknown",
    workerId: "w5",
  });

  const ri = result?.generation_identity;
  assert.ok(ri, "result.json does not carry the identity interface");
  // Control precondition: both wrong answers are present in the very object the consumer reads.
  assert.equal(ri.requested_model, REQUESTED_MODEL, "precondition: requested present and copyable");
  assert.equal(ri.resolved_model, RESOLVED_MODEL, "precondition: resolved present and copyable");
  assert.equal(ri.observed_model, null, "the consumer back-filled an unobservable identity");

  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal, "no terminal post carries used_model=");
  const fields = Object.fromEntries(
    terminal.body.split(/\s+/).filter((t) => t.includes("=")).map((t) => {
      const i = t.indexOf("=");
      return [t.slice(0, i), t.slice(i + 1)];
    }),
  );
  assert.equal(fields.used_model, "unknown", `the post printed used_model=${fields.used_model} for an unobserved run`);
  assert.notEqual(fields.used_model, REQUESTED_MODEL, "the requested string was printed as the served model");
  assert.notEqual(fields.used_model, RESOLVED_MODEL, "the resolved string was printed as the served model");
  assert.equal(fields.observation, "unavailable");
  // Not measured, so nothing is claimed either way.
  assert.equal(fields.identity_matches_requested, undefined,
    "an unmeasured comparison was printed as a match verdict");
});

// ---------------------------------------------------------------------------------------------
// FALLBACK. `buildFallbackModel` returns the provider default's ENTIRE configuration with only
// `id`/`name` overwritten by the requested string -- a different model wearing the right name. The
// interface must show the fallback for what it is and must never relabel it as the requested model.
// ---------------------------------------------------------------------------------------------
await check("a fallback is not relabelled as the requested model", async () => {
  // The fallback case as it reaches this layer: the resolver produced a DIFFERENT model
  // (FALLBACK_MODEL) while the caller asked for REQUESTED_MODEL, and the provider confirmed the
  // fallback on the wire.
  const { summary, result, posts } = await runWorker({
    observed: FALLBACK_MODEL,
    resolved: FALLBACK_MODEL,
    taskId: "95",
    name: "gen-identity-fallback",
    workerId: "w3",
  });

  const gi = summary.generation_identity;
  assert.equal(gi.requested_model, REQUESTED_MODEL, "the request was lost");
  assert.equal(gi.observed_model, FALLBACK_MODEL, "the fallback was not reported as what served the call");
  assert.notEqual(gi.observed_model, REQUESTED_MODEL, "the fallback was relabelled as the requested model");
  assert.equal(gi.matches_requested, false, "a fallback must not read as a match for the request");

  assert.equal(result.generation_identity.observed_model, FALLBACK_MODEL);
  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal);
  assert.ok(terminal.body.includes(`used_model=${FALLBACK_MODEL}`),
    "the terminal post did not name the fallback as the served model");
  assert.ok(terminal.body.includes("identity_matches_requested=false"),
    "a fallback was posted as matching the request");
});

// ---------------------------------------------------------------------------------------------
// The FAITHFUL fallback shape, and the one that matters most.
//
// `buildFallbackModel` returns `{...baseModel, id: modelId, name: modelId}` -- the provider
// default's entire configuration (baseUrl, api, cost, contextWindow, maxTokens, reasoning, compat)
// with only the NAME overwritten by what the caller asked for. So downstream, `message.model` is
// the REQUESTED string: resolved == requested, and every identity keyed on `model.id` reports the
// request back as though it were an observation. The wire report is the only thing that can
// discriminate, and it must not be allowed to agree by default.
// ---------------------------------------------------------------------------------------------
await check("a relabelled fallback is exposed even though resolved == requested", async () => {
  const { summary, result, posts } = await runWorker({
    // The relabel: the resolver reports the REQUESTED id back, because that is what it wrote onto
    // the object. Only the provider knows a different model actually served the call.
    resolved: REQUESTED_MODEL,
    observed: FALLBACK_MODEL,
    taskId: "96",
    name: "gen-identity-relabelled-fallback",
    workerId: "w2",
    evidence: "none",
  });

  const gi = summary.generation_identity;
  // The trap: these two agreeing is exactly what the relabel manufactures, and it must NOT be
  // read as confirmation that the request was honoured.
  assert.equal(gi.requested_model, REQUESTED_MODEL);
  assert.equal(gi.resolved_model, REQUESTED_MODEL, "precondition: the relabel makes resolved == requested");

  assert.equal(gi.observed_model, FALLBACK_MODEL, "the served model was not exposed");
  assert.notEqual(gi.observed_model, REQUESTED_MODEL, "the fallback was relabelled as the requested model");
  assert.equal(gi.matches_requested, false,
    "resolved == requested was taken as agreement while a different model actually served the call");

  assert.equal(result.generation_identity.observed_model, FALLBACK_MODEL, "the bundle hid the fallback");
  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal.body.includes(`used_model=${FALLBACK_MODEL}`),
    "the terminal post named the requested model as the served one");
  assert.ok(terminal.body.includes("identity_matches_requested=false"),
    "a relabelled fallback was posted as matching the request");
});

// ---------------------------------------------------------------------------------------------
// POSITIVE CONTROL at the consumer, A -> A -> A. Without this the strictness above is satisfiable
// by a downstream that prints `unknown` unconditionally. The unit-level control proves the
// aggregation can represent a match; this proves the match survives all the way to emitted
// evidence.
// ---------------------------------------------------------------------------------------------
await check("a fully-agreeing run reports a match end to end, not unknown", async () => {
  const { summary, result, posts } = await runWorker({
    resolved: REQUESTED_MODEL,
    observed: REQUESTED_MODEL,
    taskId: "97",
    name: "gen-identity-agreement",
    workerId: "w1",
  });

  const gi = summary.generation_identity;
  assert.equal(gi.observation, "observed", "an observed agreement read as unavailable");
  assert.equal(gi.observed_model, REQUESTED_MODEL);
  assert.equal(gi.matches_requested, true, "agreement was not reported as a match");
  assert.equal(gi.observed_model_calls, 1);
  assert.equal(gi.unobserved_model_calls, 0);
  // Still bound to the event, even when every string agrees -- this is the case where a model
  // string is least able to identify anything.
  assert.ok(gi.used_generation_id, "no event identity on an agreeing run");

  assert.equal(result.generation_identity.matches_requested, true, "the bundle lost the match");
  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal.body.includes(`used_model=${REQUESTED_MODEL}`));
  assert.ok(terminal.body.includes("identity_matches_requested=true"),
    "an observed agreement was not posted as a match");
  assert.ok(terminal.body.includes("observation=observed"));
});

// ---------------------------------------------------------------------------------------------
// THE BINDING CONTROL. A copied model string is not evidence that a particular generation was
// consumed. The consumer must be able to PROVE which generation it used, and this must fail if the
// evidence claims a generation other than the one actually consumed.
//
// Both artifacts come out of the SAME shipped tarball: result.json's claim is checked against
// session.jsonl's immutable response keys -- the generations that actually produced the run.
// ---------------------------------------------------------------------------------------------
await check("evidence claims exactly the generations the run actually consumed", async () => {
  const { result, sessionKeys } = await runWorker({
    observed: OBSERVED_MODEL,
    taskId: "98",
    name: "gen-identity-binding",
    workerId: "w8",
  });

  assert.ok(Array.isArray(sessionKeys), "no session.jsonl in the bundle: the claim cannot be checked");
  assert.ok(sessionKeys.length > 0,
    "the consumed session carries no generation identities -- every claim below would be vacuous");

  const claimed = [...(result.generation_identity.used_generation_ids ?? [])].sort();
  assert.deepEqual(claimed, sessionKeys,
    `evidence claims generations ${JSON.stringify(claimed)} but the session it shipped ` +
      `actually contains ${JSON.stringify(sessionKeys)}`);

  // And the observed identity is attributed to a generation that is really in that set, not to a
  // free-floating id.
  for (const id of result.generation_identity.observed_generation_ids ?? []) {
    assert.ok(sessionKeys.includes(id),
      `observed identity attributed to generation ${id}, which the consumed session does not contain`);
  }
});

// ---------------------------------------------------------------------------------------------
// NON-COMPLETED TERMINALS. Every case above drives the task to DONE/COMPLETED. A run that actually
// ran, actually spent, and actually observed a divergent served model, but then terminates FAILED
// (post-run git/network/evidence errors are routine) must not lose the identity on the way to the
// bus -- that is precisely the run most in need of an accurate trail, and it is the one the
// happy-path tests could never see.
// ---------------------------------------------------------------------------------------------
await check("a FAILED run that actually observed a divergence still reports it on the bus", async () => {
  const { summary, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    taskId: "99",
    name: "gen-identity-failed-terminal",
    workerId: "w6",
    env: { FAKE_VINCI_EXIT: "1" },
  });

  // Precondition: the run really happened and the divergence really was computed. Without this the
  // assertion below could pass vacuously on a task that never ran.
  const gi = summary.generation_identity;
  assert.equal(gi.observation, "observed", "precondition: the divergence must have been observed");
  assert.equal(gi.observed_model, OBSERVED_MODEL, "precondition: the served model was identified");
  assert.equal(gi.matches_requested, false, "precondition: this run diverged from the request");

  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("state=FAILED"));
  assert.ok(terminal, "no FAILED terminal post");
  assert.ok(
    terminal.body.includes("used_model="),
    "the FAILED terminal post carries no generation identity at all -- the divergence was computed " +
      "and then dropped on the way to the bus, which is the one consumer an operator reads without " +
      "opening the bundle",
  );
  assert.ok(terminal.body.includes(`used_model=${OBSERVED_MODEL}`),
    "the FAILED post does not name the model that actually served the run");
  assert.ok(terminal.body.includes("identity_matches_requested=false"),
    "a diverged FAILED run was not posted as diverging");
});

// ---------------------------------------------------------------------------------------------
// UNVERIFIED is where a run that SPENT and DIVERGED most often lands: the session ran, tokens were
// paid for, a different model served the call, and then publication or evidence failed. It is a
// different terminal path from COMPLETED and a different one again from the early aborts, and it
// must not lose the identity. An independent review found this whole class; this is the
// fixture-reachable member of it.
// ---------------------------------------------------------------------------------------------
for (const [label, extraEnv, evidence] of [
  ["gh failure after the run", { FAKE_GH_EXIT: "1" }, "pr"],
  ["no commit produced", { FAKE_VINCI_NO_COMMIT: "1" }, "pr"],
]) {
  await check(`an UNVERIFIED run (${label}) still reports the served model`, async () => {
    const { summary, posts } = await runWorker({
      observed: OBSERVED_MODEL,
      taskId: label.startsWith("gh") ? "201" : "203",
      name: `gen-identity-unverified-${label.startsWith("gh") ? "gh" : "nocommit"}`,
      workerId: label.startsWith("gh") ? "w1" : "w3",
      evidence,
      env: extraEnv,
    });

    // Preconditions: the run really spent and really diverged, so the assertion cannot pass on a
    // task that never reached a provider.
    const gi = summary.generation_identity;
    assert.equal(gi.observation, "observed", "precondition: the divergence must have been observed");
    assert.equal(gi.matches_requested, false, "precondition: this run diverged from the request");
    assert.ok(summary.usage?.length > 0, "precondition: the run must actually have spent");

    const terminal = posts.find((m) => typeof m.body === "string" && /state=(UNVERIFIED|FAILED|BLOCKED)/.test(m.body));
    assert.ok(terminal, "no non-COMPLETED terminal post");
    assert.ok(
      terminal.body.includes("used_model="),
      `the ${(terminal.body.match(/state=(\w+)/) || [])[1]} terminal post carries no generation identity -- ` +
        "the divergence was computed and then dropped before the bus",
    );
    assert.ok(terminal.body.includes(`used_model=${OBSERVED_MODEL}`),
      "the terminal post does not name the model that actually served this run");
    assert.ok(terminal.body.includes("identity_matches_requested=false"),
      "a diverged run was not posted as diverging");
  });
}

// ---------------------------------------------------------------------------------------------
// PRE-RUN REFUSAL, via the BLOCKER post path.
//
// 🔴 READ THE NAME CAREFULLY: this case does NOT exercise the `generationOccurred` gate, and it
// cannot fail if that gate is removed. A deadline refusal terminates through `blockerPostBody` /
// `terminalPostBody`, which structurally never carry identity fields at all -- so these assertions
// hold whether or not the gate exists. An independent review flagged exactly this, and it is
// correct.
//
// It is kept, and relabelled, rather than deleted: it pins a real and different property -- that
// the blocker path stays free of identity fields as that path evolves -- which nothing else covers.
// The gate itself is proven by "a postFinal terminal with no generation asserts no identity"
// below, which drives a branch-lease refusal through `postFinal` and DOES fail when the gate is
// removed. Do not read this case as the discriminating one.
// ---------------------------------------------------------------------------------------------
await check("the blocker post path carries no identity fields (does NOT test the gate)", async () => {
  const fixture = new WorkerTestFixture("gen-identity-prerun");
  try {
    fixture.createRepo("test", "repo");
    fixture.linkTools(TOOLS);
    await fixture.startBus([
      {
        message_id: "205",
        kind: "handoff",
        to_agent: "worker:w7",
        subject: "pre-run refusal",
        // A deadline already in the past: refused before anything is spawned.
        body: `repo: test/repo\nprovider: openrouter\nmodel: ${REQUESTED_MODEL}\ndeadline: 2020-01-01T00:00:00Z\n\nTask`,
        ts: "2026-09-10T10:00:00Z",
        posted_by: "scheduler",
      },
    ]);
    const proc = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w7", "--server", fixture.busUrl(),
       "--once", "--state-dir", fixture.tempDir],
      { env: fixture.getEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((r) => proc.on("close", r));
    const posts = fixture.getPostedMessages();
    // Reachability control: the task must actually have been claimed and refused, otherwise the
    // absence assertions below are vacuous -- a worker that never saw the task trivially asserts
    // nothing about it. Pre-run refusals post via blockerPostBody, not postFinal.
    const about = posts.filter((m) => m.subject !== undefined && !/online/.test(String(m.subject)));
    assert.ok(about.length > 0,
      `the task was never claimed or refused, so this proves nothing. posts: ${posts.map((m) => m.subject).join(" | ")}`);

    // Nothing ran, so nothing may be claimed about what served it -- on ANY post, not just one.
    for (const m of about) {
      const body = String(m.body ?? "");
      assert.ok(!body.includes("used_model="),
        `a pre-run refusal asserted a served model: ${body.slice(0, 180)}`);
      assert.ok(!body.includes("observation="),
        "a pre-run refusal asserted an observation status for a generation that never happened");
      assert.ok(!body.includes("used_generation_id"),
        "a pre-run refusal invented a generation identity");
    }
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// PROVIDER PROVENANCE ABSENT. With no provider recorded anywhere in the session, neither the
// observed nor the runtime provider may be conjured from the requested one.
// ---------------------------------------------------------------------------------------------
await check("absent provider provenance stays absent, not requested", async () => {
  const { summary, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    runtimeProvider: null,
    taskId: "206",
    name: "gen-identity-no-provider",
    workerId: "w4",
  });
  const gi = summary.generation_identity;
  // Control precondition: the requested provider is present and copyable.
  assert.equal(gi.requested_provider, "openrouter", "precondition: requested provider present");
  assert.equal(gi.observation, "observed", "precondition: a model WAS observed, so only provider is missing");

  assert.equal(gi.observed_provider, null, "provider provenance was invented");
  assert.equal(gi.runtime_provider, null, "runtime provider was back-filled from the request");
  assert.deepEqual(gi.runtime_providers, [], "a provider appeared from nowhere");

  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal, "no terminal post");
  assert.ok(!terminal.body.includes("runtime_provider="),
    "the post asserted a runtime provider that the session never recorded");
});

// ---------------------------------------------------------------------------------------------
// A postFinal PATH WHERE NO GENERATION OCCURRED. Pre-run refusals never reach postFinal, so the
// "did a generation happen" gate needs a path that does: a branch-lease refusal terminates through
// postFinal before any session is spawned. It must not assert an observation status.
// ---------------------------------------------------------------------------------------------
await check("a postFinal terminal with no generation asserts no identity", async () => {
  const fixture = new WorkerTestFixture("gen-identity-no-generation");
  try {
    fixture.createRepo("test", "repo");
    fixture.linkTools(TOOLS);
    await fixture.startBus([
      {
        message_id: "207",
        kind: "handoff",
        to_agent: "worker:w2",
        subject: "no generation",
        body: `repo: test/repo\nprovider: openrouter\nmodel: ${REQUESTED_MODEL}\nevidence: none\nbudget_usd: 20\nref: job_207\n\nTask`,
        ts: "2026-09-10T10:00:00Z",
        posted_by: "scheduler",
      },
    ]);
    const proc = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "w2", "--server", fixture.busUrl(),
       "--once", "--state-dir", fixture.tempDir],
      // Branch leases ON with no governor reachable: refused before anything is spawned.
      { env: fixture.getEnv({ VINCI_BRANCH_LEASE: "1" }), stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((r) => proc.on("close", r));
    const posts = fixture.getPostedMessages().filter((m) => !/online/.test(String(m.subject)));
    assert.ok(posts.length > 0, "the task was never claimed, so this proves nothing");
    for (const m of posts) {
      const body = String(m.body ?? "");
      assert.ok(!body.includes("observation="),
        `a terminal with no generation asserted an observation status: ${body.slice(0, 180)}`);
      assert.ok(!body.includes("used_model="),
        "a terminal with no generation asserted a served model");
    }
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// EACH ARM OF THE `generationOccurred` GATE, ALONE (worker.mjs).
//
// The gate is `(model_calls > 0) || (used_generation_ids.length > 0)`. An independent review
// deleted each arm on its own and the whole suite stayed green, because every fixture produced the
// two together -- so neither arm was ever load-bearing in a test. These two cases drive exactly one
// arm each. Both describe real partial-usage records: a response key whose call count was lost, and
// a counted call that carried no key to name it. In both, spend happened, so identity must be
// reported rather than suppressed.
// ---------------------------------------------------------------------------------------------
await check("a generation id with zero counted calls still reports identity", async () => {
  const { summary, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    modelCalls: 0,
    taskId: "208",
    name: "gen-identity-arm-ids-only",
    workerId: "w6",
  });
  const gi = summary.generation_identity;
  // Preconditions isolate the arm: no counted calls, but a generation id IS present.
  assert.equal(gi.model_calls, 0, "precondition: this case must have NO counted calls");
  assert.ok((gi.used_generation_ids?.length ?? 0) > 0,
    "precondition: it must still carry a generation id, else the arm is not isolated");

  const terminal = posts.find((m) => typeof m.body === "string" && /state=/.test(m.body));
  assert.ok(terminal, "no terminal post");
  assert.ok(terminal.body.includes("used_model="),
    "identity was suppressed for a run that produced a generation id -- the used_generation_ids arm " +
      "of the gate is not doing its job");
});

await check("counted calls with no generation id still report identity", async () => {
  const { summary, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    responseKey: null,
    taskId: "209",
    name: "gen-identity-arm-calls-only",
    workerId: "w7",
  });
  const gi = summary.generation_identity;
  // The mirror precondition: calls counted, but nothing to name them by.
  assert.ok((gi.model_calls ?? 0) > 0, "precondition: this case must have counted calls");
  assert.deepEqual(gi.used_generation_ids, [],
    "precondition: it must carry NO generation id, else the arm is not isolated");

  const terminal = posts.find((m) => typeof m.body === "string" && /state=/.test(m.body));
  assert.ok(terminal, "no terminal post");
  assert.ok(terminal.body.includes("used_model="),
    "identity was suppressed for a run that actually spent -- the model_calls arm of the gate is " +
      "not doing its job");
  // Spend with no id to bind it to is unknown lineage, and must be visible as such rather than omitted.
  assert.ok(!terminal.body.includes("used_generation_id="),
    "a generation id was asserted for a run that never recorded one");
});

// ---------------------------------------------------------------------------------------------
// MULTI-GENERATION ON THE BUS POST. `generationIdFields`'s `ids.length > 1` branch had zero
// coverage: an independent review deleted it entirely and every test stayed green, because no
// fixture ever drove more than one generation. That branch exists so a multi-generation attempt is
// never summarised by one id standing for all of them -- which is the exact case the lineage was
// built for -- so it must not be the dark corner.
// ---------------------------------------------------------------------------------------------
await check("two generations reach the bus post as a count and a digest, not one id", async () => {
  const { summary, posts } = await runWorker({
    observed: OBSERVED_MODEL,
    responseKey: ["openrouter resp-1", "openrouter resp-2"],
    taskId: "210",
    name: "gen-identity-multi-generation",
    workerId: "w8",
  });

  // Precondition: two generations actually reached the summary, else the post assertions are vacuous.
  const gi = summary.generation_identity;
  assert.equal(gi.used_generation_ids.length, 2,
    `precondition: expected 2 generations, got ${JSON.stringify(gi.used_generation_ids)}`);
  assert.equal(gi.used_generation_id, null, "the singular field must stay null for a 2-generation attempt");

  const terminal = posts.find((m) => typeof m.body === "string" && m.body.includes("used_model="));
  assert.ok(terminal, "no terminal post carrying identity");
  assert.ok(terminal.body.includes("used_generation_count=2"),
    `the post did not report the generation COUNT: ${terminal.body.slice(0, 220)}`);
  assert.ok(/used_generation_ids_sha256=[0-9a-f]{12}\b/.test(terminal.body),
    "the post did not carry a digest binding the set of generations");
  // 🔴 The substitution this branch exists to prevent: one id standing for several.
  assert.ok(!terminal.body.includes("used_generation_id="),
    "a single generation id was posted for an attempt that consumed two");
});

console.log(results.join("\n"));
if (process.exitCode === 1) console.error("worker-generation-identity-consumer: FAILURES above");
else console.log(`worker-generation-identity-consumer: ${results.length} checks passed`);
