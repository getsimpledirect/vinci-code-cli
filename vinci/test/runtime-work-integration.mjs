import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function observedProcess(file, args, options, milliseconds, evidenceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options), stdout = [], stderr = [];
    let size = 0, refusal = null, killTimer, closeTimer;
    const stop = message => {
      if (refusal) return;
      refusal = message; child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        closeTimer = setTimeout(() => {
          const error = new Error(`Owned child close is unconfirmed for PID ${child.pid}; retain ${evidenceRoot} and stop that exact child before cleanup.`);
          error.retainEvidence = true; reject(error);
          child.unref(); child.stdout?.destroy(); child.stderr?.destroy();
        }, 3000);
      }, 3000);
    };
    const deadline = setTimeout(() => stop("Owned fixture deadline elapsed; reconcile the exact child before retrying."), milliseconds);
    child.on("error", () => stop("Owned fixture launch failed; restore the exact executable before retrying."));
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", bytes => {
      size += bytes.length;
      if (size > 262144) stop("Owned fixture output limit exceeded; bound the exact child output before retrying.");
      else chunks.push(bytes);
    });
    child.stdin.end();
    child.once("close", (code, signal) => {
      clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(closeTimer);
      resolve({ status: refusal ? 124 : code ?? signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") + (refusal ? refusal + "\n" : ""), pid: child.pid });
    });
  });
}

// An explicitly supplied build of the real Work boundary is required. No fallback server.
const work = process.env.VINCI_RUNTIME_WORK_ROOT;
assert.ok(work && isAbsolute(work), "Set VINCI_RUNTIME_WORK_ROOT to the exact compiled Work server root.");
const root = fileURLToPath(new URL("../..", import.meta.url));
const temporary = await mkdtemp(join(root, ".runtime-work-test-"));
const fixtureUrl = pathToFileURL(join(work, "script/durable-task-local.fixture.js")).href;
const httpUrl = pathToFileURL(join(work, "src/durable-task-http.js")).href;
const runtimeUrl = pathToFileURL(join(root, "vinci/scripts/runtime.mjs")).href;
const harness = `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer as createReservation } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntime, RuntimeError } from ${JSON.stringify(runtimeUrl)};
import { createLocalTaskFixture, policy } from ${JSON.stringify(fixtureUrl)};
import { createDurableTaskHttpServer } from ${JSON.stringify(httpUrl)};
${observedProcess.toString()}
const root = ${JSON.stringify(root)}, temporary = ${JSON.stringify(temporary)};
const directory = await mkdtemp(join(temporary, "state-")); await chmod(directory, 0o700);
const ownerId = "runtime-owner", scope = { ownerId, workspaceId: ownerId, organizationId: null };
let retainEvidence = false;
let active = true, verified = () => null, reportMode = "normal", selectedRun, foreignRun, detailReads = 0, reportReads = 0, reportWrites = 0; const expiresAt = new Date(Date.now() + 60000);
let sdkMode = "normal", sdkRequests = 0, sdkMutations = 0, sdkAccepted = null, sdkAbortController = null;
let bindingRun, bindingMutation = null, bindingPosts = 0;
let expectedInputPrompt = null, inputProviderContexts = 0, inputProviderExact = true;
const observeInput = context => {
  if (expectedInputPrompt === null) return;
  const message = context.messages.filter(item => item.role === "user").at(-1);
  inputProviderExact = inputProviderExact && message?.content?.length === 1 && message.content[0].type === "text" && message.content[0].text === expectedInputPrompt;
  inputProviderContexts += 1;
};
const bindingNames = ["actionId", "runId", "ownerId", "workspaceId", "organizationId", "contentRevision", "actionClass", "target", "contentDigest", "toolId", "accountId", "toolVersion", "expiresAt"];
const fixtureVerify = credential => credential.kind === "worker" ? Promise.resolve(active && credential.grant === "runtime-worker" ? { principalId: ownerId, scope } : null) : verified(credential);
const s = await createLocalTaskFixture({ root: directory, ownerId, verify: fixtureVerify, policyActive: () => active, readStep: true, observeProviderContext: observeInput });
function callbackWait(server, action, label) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); server.removeListener("error", onError); error ? reject(error) : resolve(); };
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error(label + " did not complete within three seconds. Stop the exact owned fixture before retrying.")), 3000);
    server.once("error", onError);
    try { action(finish); } catch (error) { finish(error); }
  });
}
const reservation = createReservation();
await callbackWait(reservation, done => reservation.listen(0, "127.0.0.1", done), "Port reservation");
const port = reservation.address().port; await callbackWait(reservation, done => reservation.close(done), "Port reservation close");
const origin = "http://127.0.0.1:" + port;
const logRefusal = () => {};
const server = createDurableTaskHttpServer({
  serviceOrigin: origin, allowLoopbackHttp: true,
  authorityPorts: { credential: async () => null, membership: async () => null, logRefusal },
  sessionAuthorityPorts: {
    getSession: async ({ headers }) => active && headers.get("cookie") === "synthetic-runtime-session=owner" ? { session: { id: "runtime-session", userId: ownerId, expiresAt }, user: { id: ownerId } } : null,
    taskPolicy: async () => active ? scope : null, logRefusal,
  },
  createIntegration: verify => {
    verified = verify;
    return { approveUserIntent: request => {
      if (new URL(request.url).pathname === "/tasks/" + bindingRun + "/approve") bindingPosts += 1;
      return s.bridge.approveUserIntent(request);
    }, handle: async request => {
      if (sdkMode !== "normal") { sdkRequests += 1; if (request.method === "POST") sdkMutations += 1; }
      const response = await s.bridge.handle(request), path = new URL(request.url).pathname;
      if (bindingMutation && path === "/tasks/" + bindingRun + "/approvals" && response.ok) {
        const value = await response.json(), approval = value.approval;
        if (bindingMutation.kind === "field") approval.binding[bindingMutation.name] = bindingMutation.value;
        else if (bindingMutation.kind === "missing") delete approval.binding[bindingMutation.name];
        else if (bindingMutation.kind === "extra") approval.binding.unreviewed = "synthetic-unreviewed-metadata";
        else if (bindingMutation.kind === "null") approval.binding = null;
        else if (bindingMutation.kind === "array") approval.binding = [];
        if (bindingMutation.rehash) approval.actionDigest = createHash("sha256").update(JSON.stringify(bindingNames.map(name => approval.binding[name]))).digest("hex");
        return Response.json(value);
      }
      if (["create-503", "create-409"].includes(sdkMode) && request.method === "POST" && path === "/tasks" && response.ok) {
        sdkAccepted = await response.json();
        return Response.json({ code: "synthetic_response_failure" }, { status: sdkMode === "create-503" ? 503 : 409 });
      }
      if (sdkMode === "inspect-503" && request.method === "GET" && response.ok) return Response.json({ code: "synthetic_response_failure" }, { status: 503 });
      if (sdkMode === "hold-create" && request.method === "POST" && path === "/tasks" && response.ok || sdkMode === "hold-inspect" && request.method === "GET" && response.ok) {
        sdkAccepted = await response.clone().json();
        sdkAbortController.abort();
        await delay(25);
      }
      if (["create-shape", "inspect-shape", "event-gap", "artifact-bytes", "receipt-run", "approval-owner"].includes(sdkMode) && response.ok) {
        const value = await response.json();
        if (sdkMode === "create-shape" && request.method === "POST" && path === "/tasks") { sdkAccepted = structuredClone(value); value.view.cancellationRequested = "false"; }
        if (sdkMode === "inspect-shape" && value.view) value.view.snapshot.run.attemptId = 7;
        if (sdkMode === "event-gap" && value.events) value.events[0].sequence += 1;
        if (sdkMode === "artifact-bytes" && path.includes("/artifacts/")) value.content += "Synthetic transport mutation";
        if (sdkMode === "receipt-run" && value.receipt) value.receipt.runId = "foreign-sdk-run";
        if (sdkMode === "approval-owner" && value.approval) { value.approval.binding.ownerId = "foreign-sdk-owner"; value.approval.binding.workspaceId = "foreign-sdk-owner"; }
        return Response.json(value);
      }
      if (selectedRun && path.startsWith("/tasks/" + selectedRun) && reportMode !== "normal") {
        if (request.method !== "GET") reportWrites += 1;
        else reportReads += 1;
        if (request.method !== "GET" || !response.ok) return response;
        const value = await response.json();
        const events = value.events ?? value.view?.events;
        if (path === "/tasks/" + selectedRun) detailReads += 1;
        if (events && reportMode === "foreign-run") for (const event of events) event.runId = foreignRun;
        if (events && reportMode === "extra-field") events.find(event => event.type === "agent.turn_finished").payload.costMicrousd.privateMetadata = "private-extra-field-canary";
        if (events && reportMode === "missing-cost") delete events.find(event => event.type === "agent.turn_finished").payload.costMicrousd;
        if (events && reportMode === "conflicting-turn") {
          const seen = new Set();
          for (const event of events) if (event.type === "agent.turn_finished") {
            const id = event.payload.turnId.value;
            if (seen.has(id)) { event.payload.inputTokens.value += 1; break; }
            seen.add(id);
          }
        }
        if (path.endsWith("/events") && reportMode === "gap") value.events.pop();
        if (path.endsWith("/events") && reportMode === "revision") value.revision += 1;
        if (path.endsWith("/receipt") && reportMode === "receipt-run") value.receipt.runId = foreignRun;
        if (path.endsWith("/receipt") && reportMode === "receipt-digest") value.receipt.digest = "ab".repeat(32);
        if (path.endsWith("/receipt") && reportMode === "receipt-null") value.receipt = null;
        if (path.endsWith("/receipt") && reportMode === "verdict-null") value.receipt.verdict = null;
        if (path.endsWith("/receipt") && reportMode === "verdict-missing") delete value.receipt.verdict;
        if (path.endsWith("/receipt") && reportMode === "verdict-invalid") value.receipt.verdict = "UNAVAILABLE";
        if (path.endsWith("/receipt") && reportMode === "receipt-attention") value.receipt.humanAttention.seconds += 1;
        if (path.endsWith("/receipt") && reportMode === "revoked") active = false;
        if (value.view && reportMode === "changed" && detailReads === 2) value.view.snapshot.revision += 1;
        if (value.view && reportMode === "too-many") value.view.snapshot.revision = 1001;
        return Response.json(value);
      }
      return response;
    } };
  }, logRefusal,
});
await callbackWait(server, done => server.listen(port, "127.0.0.1", done), "Canonical HTTP listener");
const config = join(directory, "config.json"), spec = join(directory, "spec.json");
await writeFile(config, JSON.stringify({ origin, cookie: "synthetic-runtime-session=owner" }), { mode: 0o600 });
async function command(args, value, expected = 0, assertion) {
  if (value !== undefined) await writeFile(spec, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  let result;
  try { result = await observedProcess("bash", [join(root, "vinci/bin/vinci"), "runtime", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: directory, VINCI_RUNTIME_CONFIG: config, VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_UPDATE_DISABLED: "1" },
  }, 25000, directory); } catch (error) { if (error.retainEvidence) retainEvidence = true; throw error; }
  assert.equal(result.status, expected, assertion ?? (reportMode === "normal" ? result.stderr : 'Report must refuse "' + reportMode + '" with the expected status; restore exact canonical state before retrying.'));
  if (expected !== 0) { assert.equal(result.stdout, ""); return result; }
  return args.includes("--json") ? JSON.parse(result.stdout) : result.stdout;
}
try {
  const api = await createRuntime(config);
  const sha = value => createHash("sha256").update(value).digest("hex");
  for (let trial = 0; trial < 3; trial++) {
    const content = "Synthetic input text — café " + String.fromCodePoint(0x1f4ce) + String.fromCharCode(10) + "Untrusted data, without path resolution";
    const attachments = [{ name: "notes.md", mediaType: "text/markdown", content, digest: sha(content) }, ...Array.from({ length: 7 }, (_, index) => ({ name: "empty-" + index + ".txt", mediaType: "text/plain", content: "", digest: sha("") }))];
    const submitted = { saved: true, input: "Synthetic task with explicit text input", commandId: "runtime-input-" + trial, attachments };
    const raw = JSON.stringify(submitted, null, 2);
    const attached = await command(["create", "--spec", spec, "--json"], raw), attachedRun = attached.runId;
    const initial = s.store.read(scope, attachedRun);
    assert.equal(initial.snapshot.revision, 1); assert.equal(initial.snapshot.run.contextManifestDigest.length, 64);
    const metadata = JSON.parse(s.readContent(scope, attachedRun, "input"));
    assert.equal(JSON.stringify(metadata.attachments) === JSON.stringify(attachments), true, "The accepted immutable input must preserve exact admitted text bytes.");
    assert.equal(sha(JSON.stringify({ input: submitted.input, budget: metadata.budget, attachments })) === initial.snapshot.run.workOrderDigest, true);
    assert.equal((await api.create(raw)).runId, attachedRun); assert.equal(s.store.read(scope, attachedRun).snapshot.revision, 1);
    const changed = { ...attachments[0], content: content + " changed", digest: sha(content + " changed") };
    await command(["create", "--spec", spec, "--json"], { ...submitted, attachments: [changed] }, 75, "Changed attachment bytes under an accepted command must conflict without a new event.");
    assert.equal(s.store.read(scope, attachedRun).snapshot.revision, 1);
    expectedInputPrompt = JSON.stringify({ input: submitted.input, answers: [], attachments });
    const beforeContexts = inputProviderContexts;
    await s.host.runOne("runtime-worker", "input-producer-" + trial, attachedRun, async (_adapter, context) => {
      await context.artifact("draft", 1, "Synthetic attachment-backed draft");
      await context.question("input-question-" + trial, "Choose the synthetic text task answer");
    });
    assert.equal(inputProviderExact, true, "Actual pinned Pi provider context must receive the exact admitted text attachment bytes and names.");
    assert.equal(inputProviderContexts - beforeContexts, 2, "Actual provider context observations must qualify both pinned Pi CPU requests.");
    const loaded = s.store.read(scope, attachedRun).events.filter(event => event.type === "context.loaded");
    assert.equal(loaded.length, 1); assert.equal(loaded[0].payload.contextManifestDigest.value, initial.snapshot.run.contextManifestDigest); assert.equal(loaded[0].payload.entryCount.value, 8);
    const question = await api.questions(attachedRun), answering = await api.inspect(attachedRun);
    const answer = "Synthetic saved text input answer";
    await api.answer(attachedRun, { questionId: question.questionId, answer, expectedRevision: answering.view.snapshot.revision, humanSeconds: 0 });
    const peer = await createLocalTaskFixture({ root: directory, ownerId, verify: fixtureVerify, policyActive: () => active, readStep: true, observeProviderContext: observeInput });
    try {
      assert.equal(peer.store.read(scope, attachedRun).snapshot.run.contextManifestDigest, initial.snapshot.run.contextManifestDigest);
      expectedInputPrompt = JSON.stringify({ input: submitted.input, answers: [answer], attachments });
      const reopenedContexts = inputProviderContexts;
      await peer.host.runOne("runtime-worker", "input-reopened-" + trial, attachedRun);
      assert.equal(inputProviderExact, true, "A reopened actual provider context must retain exact admitted input bytes.");
      assert.equal(inputProviderContexts - reopenedContexts, 2, "A real reopened task must redeliver its exact saved text inputs to pinned Pi.");
    } finally { peer.close(); }
    expectedInputPrompt = null;
    await s.bridge.requestApproval("runtime-worker", "input-review-" + trial, attachedRun, { revision: 1, target: "synthetic-text-target", expiresAt: Date.now() + 60000 });
    const review = (await api.approvals(attachedRun)).approval;
    assert.equal((await api.approve(attachedRun, { approvalId: review.approvalId, actionDigest: review.actionDigest, commandId: "input-approval-" + trial, humanSeconds: 0 })).effective, true);
    assert.equal(s.store.action(scope, attachedRun, review.approvalId).execution, null); assert.equal(s.measure("sends"), 0);
    for (const [kind, candidate] of [
      ["digest", [{ ...attachments[0], digest: "ab".repeat(32) }]], ["media", [{ ...attachments[0], mediaType: "image/png" }]],
      ["path", [{ ...attachments[0], name: "../notes.md" }]], ["url", [{ ...attachments[0], url: "https://synthetic.invalid/input" }]],
      ["trust", [{ ...attachments[0], trust: "authoritative" }]], ["duplicate", [attachments[0], attachments[0]]],
      ["count", Array.from({ length: 9 }, (_, index) => ({ ...attachments[0], name: "notes-" + index }))],
      ["limit", [{ ...attachments[0], content: content.repeat(1500), digest: sha(content.repeat(1500)) }]],
      ["empty", []], ["shape", null], ["unicode", [{ ...attachments[0], content: String.fromCharCode(0xd800), digest: sha(String.fromCharCode(0xd800)) }]],
    ]) {
      const rejected = { ...submitted, commandId: "input-refusal-" + kind + "-" + trial, attachments: candidate };
      const files = await readdir(s.contentRoot), before = { providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") };
      await assert.rejects(api.create(rejected), error => error instanceof RuntimeError && error.exitCode === 2 && !error.mutationUnconfirmed, "Unsupported text input must refuse before dispatch.");
      const response = await fetch(origin + "/tasks", { method: "POST", headers: { origin, cookie: "synthetic-runtime-session=owner", "x-vinci-task-intent": "1", "content-type": "application/json" }, body: JSON.stringify(rejected) });
      assert.equal(response.status, kind === "limit" ? 413 : 409, "The real host/HTTP bound must independently refuse the unsupported input DTO.");
      await response.body.cancel(); assert.deepEqual(await readdir(s.contentRoot), files);
      assert.deepEqual({ providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") }, before);
    }
    const guarded = (await api.create({ ...submitted, commandId: "input-integrity-" + trial })).runId;
    const inputPath = join(s.contentRoot, sha(JSON.stringify([ownerId, ownerId, null, guarded, "input"])) + ".json");
    const originalBytes = await readFile(inputPath), originalView = s.store.read(scope, guarded), tampered = JSON.parse(originalBytes);
    tampered.attachments[0].name = "changed.md";
    await writeFile(inputPath, JSON.stringify(tampered), { mode: 0o600 });
    const beforeGuard = { providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") };
    await assert.rejects(s.host.runOne("runtime-worker", "input-integrity-" + trial, guarded), /input_integrity_failed/, "Saved attachment metadata changes must refuse before actual provider delivery.");
    assert.deepEqual(s.store.read(scope, guarded).events, originalView.events);
    assert.deepEqual({ providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") }, beforeGuard);
    await writeFile(inputPath, originalBytes, { mode: 0o600 });
    expectedInputPrompt = JSON.stringify({ input: submitted.input, answers: [], attachments });
    await s.host.runOne("runtime-worker", "input-restored-" + trial, guarded); expectedInputPrompt = null;
    const cancelledInput = (await api.create({ ...submitted, commandId: "input-cancelled-" + trial })).runId;
    await api.cancel(cancelledInput); const cancelProviders = s.measure("providers");
    assert.equal((await s.host.runOne("runtime-worker", "input-cancelled-" + trial, cancelledInput)).claimed, false); assert.equal(s.measure("providers"), cancelProviders);
    assert.equal(s.measure("sends"), 0);
    assert.equal(s.logs.join("").includes(content), false, "Saved text input bytes must not enter refusal logs.");
    assert.equal(JSON.stringify(s.store.read(scope, attachedRun).events).includes(content), false, "Canonical events must carry only context digests and counts.");
    console.log("Text input trial " + (trial + 1) + " passed: actual Bash/HTTP/host/Pi delivery, idempotent retry/reopen, eleven independent DTO refusals, metadata integrity and cancellation with zero effects.");
  }
  for (let trial = 0; trial < 3; trial++) {
    const raw = JSON.stringify({ saved: true, input: "Synthetic SDK abort reconciliation — café", commandId: "sdk-abort-" + trial });
    sdkRequests = 0; sdkMutations = 0; sdkMode = "count";
    const preAbort = new AbortController(); preAbort.abort();
    await assert.rejects(api.create(raw, { signal: preAbort.signal }), error => error instanceof RuntimeError && error.code === "observation_aborted" && !error.mutationUnconfirmed, "Pre-dispatch SDK abort must send no request and claim no accepted mutation.");
    assert.equal(sdkRequests, 0); assert.equal(sdkMutations, 0);
    sdkMode = "hold-create"; sdkAbortController = new AbortController(); sdkAccepted = null;
    await assert.rejects(api.create(raw, { signal: sdkAbortController.signal }), error => error instanceof RuntimeError && error.code === "observation_aborted" && error.mutationUnconfirmed, "Aborted accepted create must remain explicitly unconfirmed until original-byte reconciliation.");
    assert.equal(sdkRequests, 1); assert.equal(sdkMutations, 1);
    assert.ok(sdkAccepted && typeof sdkAccepted.runId === "string", "The unchanged canonical service must actually accept the held mutation before its abort qualifies.");
    const acceptedRun = sdkAccepted.runId, acceptedRevision = s.store.read(scope, acceptedRun).snapshot.revision;
    sdkMode = "normal";
    assert.equal((await api.create(raw)).runId, acceptedRun, "The original SDK bytes must reconcile through the actual service's idempotent creation ledger.");
    assert.equal(s.store.read(scope, acceptedRun).snapshot.revision, acceptedRevision, "Explicit reconciliation must not append another creation event.");
    const inspected = await api.inspect(acceptedRun);
    assert.equal(inspected.view.snapshot.run.state, "CREATED");
    assert.equal((await api.events(acceptedRun)).events.length, acceptedRevision);
    assert.equal((await api.questions(acceptedRun)).questionId, null);
    assert.equal((await api.approvals(acceptedRun)).approval, null);
    assert.equal((await api.receipt(acceptedRun)).receipt, null);
    sdkMode = "hold-inspect"; sdkRequests = 0; sdkMutations = 0; sdkAbortController = new AbortController(); sdkAccepted = null;
    await assert.rejects(api.inspect(acceptedRun, { signal: sdkAbortController.signal }), error => error instanceof RuntimeError && error.code === "observation_aborted" && !error.mutationUnconfirmed, "Read abort must stop only observation, without claiming or issuing task cancellation.");
    assert.equal(sdkRequests, 1); assert.equal(sdkMutations, 0);
    sdkMode = "normal";
    const unchanged = await api.inspect(acceptedRun);
    assert.equal(unchanged.view.snapshot.revision, acceptedRevision); assert.equal(unchanged.view.cancellationRequested, false);
    assert.deepEqual(unchanged.view.events, inspected.view.events);
    sdkMode = "inspect-shape";
    await assert.rejects(api.inspect(acceptedRun), { code: "invalid_identity", mutationUnconfirmed: false }, "A typed task projection must refuse malformed actual response fields.");
    sdkMode = "event-gap";
    await assert.rejects(api.events(acceptedRun), { code: "replay_gap_requires_resync", mutationUnconfirmed: false }, "A typed event page must refuse a canonical transport sequence gap.");
    sdkMode = "create-shape"; sdkAccepted = null; sdkMutations = 0;
    const changedRaw = JSON.stringify({ saved: true, input: "Synthetic SDK shape reconciliation", commandId: "sdk-shape-" + trial });
    await assert.rejects(api.create(changedRaw), { code: "response_refused", mutationUnconfirmed: true }, "An accepted mutation with an invalid response projection must remain explicitly unconfirmed.");
    assert.equal(sdkMutations, 1); const shapeRun = sdkAccepted.runId;
    const shapeRevision = s.store.read(scope, shapeRun).snapshot.revision;
    sdkMode = "normal";
    assert.equal((await api.create(changedRaw)).runId, shapeRun);
    assert.equal(s.store.read(scope, shapeRun).snapshot.revision, shapeRevision);
    for (const status of [503, 409]) {
      const failedRaw = JSON.stringify({ saved: true, input: "Synthetic SDK accepted HTTP failure", commandId: "sdk-status-" + status + "-" + trial });
      sdkMode = "create-" + status; sdkAccepted = null; sdkRequests = 0; sdkMutations = 0;
      await assert.rejects(api.create(failedRaw), error => error instanceof RuntimeError && error.code === (status === 409 ? "stale_or_conflicting_command" : "service_refused") && error.exitCode === 75 && error.mutationUnconfirmed, "An actual accepted mutation followed by an HTTP failure must remain unconfirmed.");
      assert.equal(sdkRequests, 1); assert.equal(sdkMutations, 1);
      assert.ok(sdkAccepted && typeof sdkAccepted.runId === "string", "A substituted HTTP failure must follow real canonical acceptance, rather than a fabricated packet.");
      const failedRun = sdkAccepted.runId, failedView = s.store.read(scope, failedRun);
      sdkMode = "normal";
      assert.equal((await api.create(failedRaw)).runId, failedRun, "The same original bytes must reconcile an accepted HTTP failure through the canonical command ledger.");
      assert.deepEqual(s.store.read(scope, failedRun).events, failedView.events, "Reconciliation after a refused response must append no duplicate event.");
    }
    sdkMode = "inspect-503"; sdkRequests = 0; sdkMutations = 0;
    await assert.rejects(api.inspect(acceptedRun), error => error instanceof RuntimeError && error.code === "service_refused" && error.exitCode === 75 && !error.mutationUnconfirmed, "A failed read response must not claim a task mutation.");
    assert.equal(sdkRequests, 1); assert.equal(sdkMutations, 0); sdkMode = "normal";
  }
  for (let trial = 0; trial < 3; trial++) {
    bindingRun = (await api.create({ saved: true, input: "Synthetic complete binding review", commandId: "sdk-binding-" + trial })).runId;
    for (let attempt = 0; attempt < 2; attempt++) await s.host.runOne("runtime-worker", "binding-producer-" + trial + "-" + attempt, bindingRun, async (_adapter, context) => {
      await context.artifact("comparison", 1, "Synthetic unchanged comparison");
      await context.artifact("draft", 1, "Synthetic unchanged draft — café");
    });
    await s.bridge.requestApproval("runtime-worker", "binding-review-" + trial, bindingRun, { revision: 1, target: "synthetic-original-target", expiresAt: Date.now() + 600000 });
    const ordinary = (await api.approvals(bindingRun)).approval;
    assert.equal((await command(["approvals", bindingRun, "--json"])).approval.actionDigest, ordinary.actionDigest, "Actual Bash and SDK review must admit the same complete canonical binding.");
    const original = s.store.action(scope, bindingRun, ordinary.approvalId), originalView = s.store.read(scope, bindingRun);
    const counts = { providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") };
    assert.equal(originalView.events.filter(event => event.type === "artifact.persisted" && event.payload.artifactId.value === "draft:v1").length, 2, "Two genuine permitted producer attempts must remain a valid review positive.");
    assert.equal(original.execution, null); assert.equal(counts.sends, 0);
    const decision = { approvalId: ordinary.approvalId, actionDigest: ordinary.actionDigest, commandId: "binding-decision-" + trial, humanSeconds: 0 };
    const changed = { actionId: ordinary.binding.actionId + "-changed", runId: bindingRun + "-changed", ownerId: ownerId + "-changed", workspaceId: ownerId + "-changed", organizationId: "foreign-organization", contentRevision: ordinary.binding.contentRevision + 1, actionClass: ordinary.binding.actionClass + " changed", target: ordinary.binding.target + " changed", contentDigest: "ab".repeat(32), toolId: ordinary.binding.toolId + " changed", accountId: ordinary.binding.accountId + " changed", toolVersion: ordinary.binding.toolVersion + " changed", expiresAt: ordinary.binding.expiresAt + 1 };
    const cases = [
      ...["target", ...bindingNames.filter(name => name !== "target")].map(name => ({ kind: "field", name, value: changed[name] })),
      ...bindingNames.map(name => ({ kind: "missing", name, rehash: true })),
      { kind: "extra", rehash: true }, { kind: "null" }, { kind: "array" },
      ...[["actionId", "constructor"], ["actionClass", ""], ["target", ""], ["toolId", ""], ["accountId", ""], ["toolVersion", ""], ["contentRevision", 0], ["contentRevision", "1"], ["expiresAt", 0], ["expiresAt", "1"], ["organizationId", 7]].map(([name, value]) => ({ kind: "field", name, value, rehash: true })),
    ];
    for (const mutation of cases) {
      bindingMutation = mutation;
      const code = ["null", "array"].includes(mutation.kind) ? "invalid_record" : "response_refused";
      await assert.rejects(api.approvals(bindingRun), { code, mutationUnconfirmed: false }, "Initial review must refuse the intended complete-binding mutation: " + mutation.kind + ":" + (mutation.name ?? "shape"));
      const beforePosts = bindingPosts;
      await assert.rejects(api.approve(bindingRun, decision), { code, mutationUnconfirmed: false }, "Fresh preflight must refuse the intended complete-binding mutation before any approval POST.");
      assert.equal(bindingPosts, beforePosts, "A refused binding must send zero real approval POSTs.");
      if (mutation.name === "target" && !mutation.rehash) {
        await command(["approvals", bindingRun, "--json"], undefined, 69, "Actual Bash initial review must refuse target-only response alteration.");
        await command(["approve", bindingRun, "--spec", spec, "--json"], decision, 69, "Actual Bash approval must refuse target-only alteration before POST.");
        assert.equal(bindingPosts, beforePosts);
      }
      assert.deepEqual(s.store.action(scope, bindingRun, ordinary.approvalId), original, "Refused reviews must preserve the actual canonical action ledger.");
      assert.deepEqual(s.store.read(scope, bindingRun).events, originalView.events, "Refused reviews must preserve the actual canonical event prefix.");
      assert.deepEqual({ providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") }, counts);
      bindingMutation = null;
      assert.deepEqual((await api.approvals(bindingRun)).approval.binding, ordinary.binding, "Restored original bytes must remain a same-consumer positive after each refusal.");
    }
    const beforePosts = bindingPosts;
    assert.equal((await api.approve(bindingRun, decision)).effective, true);
    assert.equal(bindingPosts - beforePosts, 1);
    const effective = (await api.approvals(bindingRun)).approval;
    assert.equal(effective.effective, true); assert.deepEqual(effective.binding, ordinary.binding);
    assert.equal(s.store.action(scope, bindingRun, ordinary.approvalId).execution, null);
    assert.deepEqual({ providers: s.measure("providers"), reads: s.measure("reads"), sends: s.measure("sends") }, counts);
    bindingRun = (await api.create({ saved: true, input: "Synthetic expired approval history", commandId: "sdk-expired-binding-" + trial })).runId;
    await s.host.runOne("runtime-worker", "expired-binding-producer-" + trial, bindingRun, async (_adapter, context) => { await context.artifact("draft", 1, "Synthetic historical draft"); });
    const expiration = Date.now() + 500;
    await s.bridge.requestApproval("runtime-worker", "expired-binding-review-" + trial, bindingRun, { revision: 1, target: "synthetic-historical-target", expiresAt: expiration });
    const history = (await api.approvals(bindingRun)).approval;
    assert.equal(history.stale, false);
    await delay(Math.max(0, expiration - Date.now()) + 25);
    const expired = (await api.approvals(bindingRun)).approval;
    assert.deepEqual(expired.binding, history.binding); assert.equal(expired.stale, true);
    const expiredView = s.store.read(scope, bindingRun), expiredAction = s.store.action(scope, bindingRun, history.approvalId), expiredPosts = bindingPosts;
    await assert.rejects(api.approve(bindingRun, { approvalId: history.approvalId, actionDigest: history.actionDigest, commandId: "expired-binding-decision-" + trial, humanSeconds: 0 }), { code: "stale_approval", mutationUnconfirmed: false }, "Historical expiry may be read but must not become fresh approval authority.");
    assert.equal(bindingPosts, expiredPosts); assert.deepEqual(s.store.action(scope, bindingRun, history.approvalId), expiredAction); assert.deepEqual(s.store.read(scope, bindingRun).events, expiredView.events);
    assert.equal(s.measure("sends"), 0);
    console.log("Complete-binding review trial " + (trial + 1) + " passed: all 13 raw fields and exact shape refused in initial/preflight reads, real repeated producers and restored/effective history admitted, zero effect execution.");
  }
  bindingRun = undefined;
  const create = ["create", "--spec", spec, "--json"];
  const saved = { saved: true, input: "Synthetic supplier comparison", commandId: "runtime-create" };
  const created = await command(create, saved); const runId = created.runId;
  const emptyReport = await command(["report", runId, "--json"]);
  assert.equal(emptyReport.reportedUsage.costMicrousd, null, "No finished turn must not invent known-zero cost.");
  assert.equal(emptyReport.reportedUsage.inputTokens, null); assert.equal(emptyReport.assessment.verdict, null);
  assert.equal(emptyReport.execution.terminalState, null); assert.equal(emptyReport.publication.tierReported, null);
  foreignRun = (await command(create, { ...saved, commandId: "runtime-other-run" })).runId;
  await s.host.runOne("runtime-worker", "runtime-zero-worker", foreignRun);
  const zeroReport = await command(["report", foreignRun, "--json"]);
  assert.equal(zeroReport.reportedUsage.finishedTurns, 2);
  assert.equal(zeroReport.reportedUsage.costMicrousd, 0, "Actual faux-provider known zero must remain distinct from missing usage.");
  assert.equal((await command(create, saved)).runId, runId, "same idempotency key returns same task");
  await command(create, { ...saved, input: "changed input" }, 75);
  await command(create, '{"saved":true,"input":"one","input":"two","commandId":"duplicate"}', 75);
  const unsafe = await command(create, { ...saved, saved: false }, 2); assert.match(unsafe.stderr, /explicit_saved_input_required/);
  await s.host.runOne("runtime-worker", "runtime-comparison-worker", runId, async (_adapter, context) => {
    await context.artifact("comparison", 1, "Synthetic comparison: supplier A=100; supplier B=120.");
    const view = s.store.read(scope, runId), event = view.events.find(event => event.type === "agent.turn_finished");
    // Admit synthetic numeric metadata through the unchanged canonical store/lease.
    // The real historical faux provider reports zero; these counters are not provider billing.
    const turnId = { kind: "id", value: "runtime-synthetic-counter-turn" };
    function append(type, payload, suffix) {
      const current = s.store.read(scope, runId);
      s.store.append(scope, runId, { ...event, type, payload, eventId: runId + suffix,
        sequence: current.snapshot.revision + 1, occurredAt: new Date().toISOString(), idempotencyKey: runId + suffix }, current.snapshot.revision, current.lease);
    }
    append("agent.turn_started", { turnId }, ":counter-start");
    const counters = { turnId, inputTokens: { kind: "count", value: 3 }, outputTokens: { kind: "count", value: 4 }, costMicrousd: { kind: "count", value: 5 }, modelId: event.payload.modelId };
    append("agent.turn_finished", counters, ":counter-finish");
    append("agent.turn_finished", counters, ":counter-repeat");
    await context.question("runtime-question", "Choose the synthetic supplier");
  });
  const question = await command(["questions", runId, "--json"]); assert.equal(question.questionId, "runtime-question");
  const view = await command(["inspect", runId, "--json"]);
  const waitingReport = await command(["report", runId, "--json"]);
  assert.equal(waitingReport.reportedUsage.finishedTurns, 3, "Repeated canonical turn identities must not inflate counters.");
  assert.equal(waitingReport.reportedUsage.costMicrousd, 5, "Repeated admitted synthetic nonzero counters must not double the unique-turn estimate.");
  assert.equal(waitingReport.reportedUsage.eventCostMicrousd, 10, "All recorded finish-event cost remains distinct from the deduplicated estimate.");
  assert.equal(waitingReport.assessment.verdict, null); assert.equal(waitingReport.recordedAttention.interruptions, 1);
  await command(["answer", runId, "--spec", spec, "--json"], { questionId: question.questionId, answer: "Synthetic supplier A", expectedRevision: view.view.snapshot.revision - 1, humanSeconds: 1 }, 75);
  await command(["answer", runId, "--spec", spec, "--json"], { questionId: question.questionId, answer: "Synthetic supplier A", expectedRevision: view.view.snapshot.revision, humanSeconds: 1 });
  await s.host.runOne("runtime-worker", "runtime-draft-worker", runId, async (_adapter, context) => { await context.artifact("draft", 1, "Synthetic exact draft: accept supplier A at 100."); });
  await s.bridge.requestApproval("runtime-worker", "approval-worker", runId, { revision: 1, target: "synthetic-local-target", expiresAt: Date.now() + 60000 });
  const review = await command(["approvals", runId, "--json"]);
  sdkMode = "approval-owner";
  await assert.rejects(api.approvals(runId), { code: "response_refused" }, "A typed review must bind its owner to the actual selected canonical task.");
  sdkMode = "normal";
  assert.equal((await api.approvals(runId)).approval.actionDigest, review.approval.actionDigest);
  const exact = { approvalId: review.approval.approvalId, actionDigest: review.approval.actionDigest, commandId: "runtime-decision", humanSeconds: 1 };
  await command(["approve", runId, "--spec", spec, "--json"], { ...exact, actionDigest: "ab".repeat(32) }, 75);
  await command(["approve", runId, "--spec", spec, "--json"], JSON.stringify(exact).replace('"humanSeconds":', '"humanSeconds":0,"humanSeconds":'), 75, "Original duplicate approval fields must reach the canonical refusal unchanged.");
  await command(["approve", runId, "--spec", spec, "--json"], exact);
  const action = await s.bridge.execute("runtime-worker", "effect-worker", runId, exact.approvalId, exact.actionDigest);
  await s.bridge.execute("runtime-worker", "readback-worker", runId, exact.approvalId, exact.actionDigest);
  await s.bridge.completeFromHost("runtime-worker", "completion-worker", runId, cutoff => s.receipt(action, cutoff));
  const receipt = await command(["receipt", runId, "--json"]); assert.equal(receipt.receipt.finalState, "DONE_UNVERIFIED"); assert.equal(receipt.receipt.verdict, "CONDITIONAL");
  assert.equal(s.measure("sends"), 1); assert.ok(s.measure("providers") > 0, "real Pi faux-provider path executed");
  const completeReport = await command(["report", runId, "--json"]);
  assert.equal(completeReport.runId, runId); assert.equal(completeReport.revision, s.store.read(scope, runId).snapshot.revision);
  assert.equal(completeReport.reportVersion, 1);
  assert.equal(completeReport.reportedUsage.finishedTurns, 5, "Canonical turn identities must be deduplicated through the real report entry.");
  assert.equal(completeReport.reportedUsage.costMicrousd, 5); assert.equal(completeReport.reportedUsage.eventCostMicrousd, 10); assert.equal(receipt.receipt.spend, 10);
  assert.equal(completeReport.reportedUsage.authoritativeForBilling, false);
  assert.equal(completeReport.execution.terminalState, "DONE_UNVERIFIED"); assert.equal(completeReport.execution.outcome, "SUCCEEDED");
  assert.equal(completeReport.assessment.verdict, "CONDITIONAL"); assert.equal(completeReport.assessment.receiptDigest, receipt.receipt.digest);
  assert.equal(completeReport.publication.tierReported, "OBSERVED"); assert.equal(completeReport.publication.independentlyConfirmed, null);
  assert.equal(completeReport.recordedAttention.seconds, 2); assert.equal(completeReport.recordedAttention.decisions, 2);
  assert.ok(Object.values(completeReport.unknown).every(value => value === null));
  assert.doesNotMatch(JSON.stringify(completeReport), /Synthetic supplier|Synthetic exact draft|proposal-content-canary|unverified|synthetic-runtime-session|Document content/);
  assert.ok(!("modelIds" in completeReport.reportedUsage), "Raw model references must not be exported as content-free counters.");
  selectedRun = runId;
  for (let trial = 0; trial < 3; trial++) {
    for (const [mode, code] of [["foreign-run", "report_replay_incomplete"], ["gap", "report_replay_incomplete"], ["revision", "report_replay_incomplete"], ["missing-cost", "report_field_refused"], ["extra-field", "report_field_refused"], ["conflicting-turn", "report_turn_conflict"], ["receipt-run", "report_receipt_binding_refused"], ["receipt-digest", "report_receipt_binding_refused"], ["receipt-null", "report_receipt_binding_refused"], ["verdict-null", "report_receipt_binding_refused"], ["verdict-missing", "report_receipt_binding_refused"], ["verdict-invalid", "report_receipt_binding_refused"], ["receipt-attention", "report_receipt_binding_refused"], ["changed", "report_state_changed"], ["too-many", "report_replay_incomplete"]]) {
      reportMode = mode; detailReads = 0;
      const refused = await command(["report", runId, "--json"], undefined, 75);
      assert.match(refused.stderr, new RegExp(code), "The report must refuse the intended actual-response mutation.");
    }
    reportMode = "revoked"; detailReads = 0;
    const revokedReport = await command(["report", runId, "--json"], undefined, 77); assert.match(revokedReport.stderr, /authority_refused/);
    active = true; reportMode = "normal";
    assert.equal((await command(["report", runId, "--json"])).reportedUsage.finishedTurns, 5, "Restored authority and original canonical bytes remain a same-entry positive.");
  }
  assert.ok(reportReads > 0); assert.equal(reportWrites, 0); assert.equal(s.measure("sends"), 1);
  const exported = await command(["export", runId, "draft", "1", "--json"]); assert.equal(exported.digest, review.approval.draft.digest);
  await command(["watch", runId, "--timeout", "2"]);
  for (let trial = 0; trial < 3; trial++) {
    const correctedRun = (await command(create, { ...saved, commandId: "runtime-correction-task-" + trial })).runId;
    await s.host.runOne("runtime-worker", "runtime-correction-draft-" + trial, correctedRun, async (_adapter, context) => {
      await context.artifact("comparison", 1, "Synthetic comparison for correction");
      await context.artifact("draft", 1, "Synthetic original draft");
    });
    await s.bridge.requestApproval("runtime-worker", "runtime-correction-review-" + trial, correctedRun, { revision: 1, target: "synthetic-original-target", expiresAt: Date.now() + 60000 });
    const first = (await command(["approvals", correctedRun, "--json"])).approval;
    const firstRevision = (await command(["inspect", correctedRun, "--json"])).view.snapshot.revision;
    const correction = { approvalId: first.approvalId, actionDigest: first.actionDigest, text: "Synthetic revised draft — café" + String.fromCharCode(10) + "Keep the quoted destination", target: "synthetic-revised-target", commandId: "runtime-correction-" + trial, expectedRevision: firstRevision };
    const correct = ["correct", correctedRun, "--spec", spec, "--json"];
    await command(correct, { ...correction, text: "  " }, 2, "Blank correction must refuse before sending feedback.");
    await command(correct, { ...correction, target: "" }, 2, "An explicit correction target is required.");
    await command(correct, JSON.stringify(correction).replace('"text":', '"text":"ambiguous duplicate","text":'), 75, "Original duplicate correction fields must reach the canonical refusal unchanged.");
    for (const [suffix, changes] of [["foreign", { approvalId: review.approval.approvalId }], ["digest", { actionDigest: "ab".repeat(32) }], ["revision", { expectedRevision: firstRevision - 1 }]]) {
      await command(correct, { ...correction, ...changes, commandId: correction.commandId + ":" + suffix }, 75, "The canonical correction route must refuse the wrong exact action or stale revision.");
      assert.equal(s.store.read(scope, correctedRun).snapshot.revision, firstRevision, "Refused corrections must not append canonical events.");
    }
    assert.equal((await command(correct, correction)).revision, 2);
    const accepted = await s.bridge.correction(scope, correctedRun);
    assert.equal(accepted.text, correction.text); assert.equal(accepted.target, correction.target); assert.equal(accepted.revision, 2);
    const acceptedRevision = s.store.read(scope, correctedRun).snapshot.revision;
    assert.equal((await api.correct(correctedRun, JSON.stringify(correction))).revision, 2, "The source SDK must preserve accepted correction retry semantics through the same facade.");
    assert.equal(s.store.read(scope, correctedRun).snapshot.revision, acceptedRevision);
    assert.equal((await command(correct, correction)).revision, 2, "An exact accepted correction retry must return its original content version.");
    assert.equal(s.store.read(scope, correctedRun).snapshot.revision, acceptedRevision, "An exact retry must not append another event.");
    for (const changes of [{ text: correction.text + " changed" }, { target: "synthetic-other-target" }, { commandId: correction.commandId + ":new" }]) {
      await command(correct, { ...correction, ...changes }, 75, "Changed command parameters and a new stale-action command must refuse.");
    }
    await command(["approve", correctedRun, "--spec", spec, "--json"], { approvalId: first.approvalId, actionDigest: first.actionDigest, commandId: "runtime-old-approval-" + trial, humanSeconds: 1 }, 75);
    assert.equal(s.store.read(scope, correctedRun).snapshot.revision, acceptedRevision);
    await s.host.runOne("runtime-worker", "runtime-correction-replacement-" + trial, correctedRun, async (_adapter, context) => { await context.artifact("draft", accepted.revision, accepted.text); });
    await s.bridge.requestApproval("runtime-worker", "runtime-correction-new-review-" + trial, correctedRun, { revision: accepted.revision, target: accepted.target, expiresAt: Date.now() + 60000 });
    const replacement = (await command(["approvals", correctedRun, "--json"])).approval;
    assert.notEqual(replacement.approvalId, first.approvalId); assert.notEqual(replacement.actionDigest, first.actionDigest);
    assert.equal(replacement.binding.target, correction.target); assert.equal(replacement.draft.version, 2); assert.equal(replacement.draft.content, correction.text);
    assert.equal(replacement.pending, true); assert.equal(replacement.effective, false); assert.equal(replacement.stale, false);
    const replacementRevision = s.store.read(scope, correctedRun).snapshot.revision;
    assert.equal((await command(correct, correction)).revision, 2, "An exact correction retry must remain valid after a replacement review exists.");
    assert.equal(s.store.read(scope, correctedRun).snapshot.revision, replacementRevision);
    assert.equal(s.store.read(scope, correctedRun).snapshot.pendingApprovalId, replacement.approvalId);
    for (const [version, content, digest] of [[1, "Synthetic original draft", first.draft.digest], [2, correction.text, replacement.draft.digest]]) {
      const artifact = await command(["export", correctedRun, "draft", String(version), "--json"]);
      assert.equal(artifact.version, version); assert.equal(artifact.content, content); assert.equal(artifact.digest, digest);
      assert.equal(createHash("sha256").update(artifact.content).digest("hex"), digest);
      assert.ok(s.store.read(scope, correctedRun).events.some(event => event.type === "artifact.persisted" && event.payload.artifactId.value === "draft:v" + version && event.payload.contentDigest.value === digest));
    }
    assert.notEqual(first.draft.digest, replacement.draft.digest);
    await command(["approve", correctedRun, "--spec", spec, "--json"], { approvalId: replacement.approvalId, actionDigest: replacement.actionDigest, commandId: "runtime-replacement-approval-" + trial, humanSeconds: 1 });
    assert.equal((await command(["approvals", correctedRun, "--json"])).approval.effective, true);
    assert.equal(s.measure("sends"), 1, "Correction, replacement review and its separate approval must not execute an effect themselves.");
  }
  const cancelled = await command(create, { ...saved, commandId: "runtime-cancel" });
  assert.match(await command(["cancel", cancelled.runId]), /termination is unconfirmed/);
  assert.equal((await api.report(runId)).reportVersion, 1);
  for (let trial = 0; trial < 3; trial++) {
    sdkMode = "artifact-bytes";
    await assert.rejects(api.artifact(runId, "draft", 1), { code: "artifact_content_refused" }, "Actual artifact bytes must match the selected version and canonical digest before typed output.");
    sdkMode = "receipt-run";
    await assert.rejects(api.receipt(runId), { code: "response_refused" }, "The typed receipt must bind the same actual selected run and completion.");
    sdkMode = "normal";
    assert.equal((await api.artifact(runId, "draft", 1)).digest, review.approval.draft.digest);
    assert.equal((await api.receipt(runId)).receipt.digest, receipt.receipt.digest);
  }
  const observed = []; const watched = await api.watch(runId, { timeoutMs: 2000 }, event => observed.push(event));
  assert.equal(watched.terminalObserved, true); assert.equal(observed.length, s.store.read(scope, runId).snapshot.revision);
  active = false;
  await command(["inspect", runId, "--json"], undefined, 77);
  console.log("Actual Work HTTP + canonical SQLite/replay + real Pi faux-provider + shared SDK/CLI passed: complete 13-field approval binding and task/report/correction operations, three accepted-mutation/read abort reconciliations, sixteen report refusals each three trials, and independently digest-bound versions without additional effects. Local synthetic evidence only.");
} catch (error) {
  if (error.retainEvidence) retainEvidence = true;
  throw error;
} finally {
  let listenerClosed = false;
  server.closeAllConnections();
  try { await callbackWait(server, done => server.close(done), "Canonical HTTP listener close"); listenerClosed = true; }
  finally { s.close(); }
  if (!retainEvidence && listenerClosed) {
    await rm(directory, { recursive: true, force: true });
    process.stderr.write("Owned fixture cleanup confirmed after all tracked CLI children and the canonical listener closed.\\n");
  } else process.stderr.write("Owned fixture cleanup is unconfirmed; retain " + directory + " and reconcile the reported exact child or listener before cleanup.\\n");
}
`;
const path = join(temporary, "harness.mjs");
let removalConfirmed = true;
try {
  const types = join(temporary, "source-consumer.mts");
  await writeFile(types, `
import { createRuntime, RuntimeError } from "../vinci/scripts/runtime.mjs";
const runtime = await createRuntime("/synthetic-config-never-executed.json");
const created = await runtime.create({ saved: true, input: "selected input", commandId: "caller-command", attachments: [{ name: "notes.md", mediaType: "text/markdown", content: "selected text", digest: "a".repeat(64) }] });
const task = await runtime.inspect(created.runId);
const revision: number = task.view.snapshot.revision;
const state: string = task.view.snapshot.run.state;
const page = await runtime.events(created.runId, { after: revision, signal: new AbortController().signal });
const sequence: number | undefined = page.events[0]?.sequence;
await runtime.correct(created.runId, { approvalId: "review", actionDigest: "a".repeat(64), text: "feedback", target: "reviewed target", commandId: "correction", expectedRevision: revision });
await runtime.correct(created.runId, "original caller JSON");
const outcome = await runtime.report(created.runId);
const unknownDebit: null = outcome.unknown.accountDebit;
const unconfirmed: boolean = new RuntimeError("synthetic").mutationUnconfirmed;
// @ts-expect-error Image media is not admitted by this text-only DTO.
await runtime.create({ saved: true, input: "input", commandId: "command", attachments: [{ name: "image.png", mediaType: "image/png", content: "bytes", digest: "a".repeat(64) }] });
// @ts-expect-error Saved mode must be explicit true.
await runtime.create({ saved: false, input: "private", commandId: "caller-command" });
// @ts-expect-error Revision counters are numbers, not strings.
await runtime.answer(created.runId, { questionId: "question", answer: "selected answer", expectedRevision: "1", humanSeconds: 0 });
// @ts-expect-error Authority is not a caller-supplied SDK operation field.
await runtime.create({ saved: true, input: "input", commandId: "command", ownerId: "other" });
// @ts-expect-error Unprojected producer fields remain unknown.
const lease: string = task.view.lease;
// @ts-expect-error A reported estimate cannot become billing authority.
const invoice: true = outcome.reportedUsage.authoritativeForBilling;
// @ts-expect-error The facade exposes no generic request operation.
await runtime.request("POST", "/arbitrary");
`);
  removalConfirmed = false;
  const checkedTypes = await observedProcess(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022", "--types", "node", "--skipLibCheck", types], { cwd: root, env: { PATH: process.env.PATH } }, 15000, temporary);
  assert.equal(checkedTypes.status, 0, "The source SDK declarations must admit validated projections and refuse unsupported spec/authority/billing types: " + checkedTypes.stdout + checkedTypes.stderr);
  removalConfirmed = true;
  await writeFile(path, harness);
  removalConfirmed = false;
  const result = await observedProcess(process.execPath, [path], { cwd: root, env: {
      PATH: process.env.PATH,
      VINCI_RUN_MODULE: process.env.VINCI_RUN_MODULE,
      VINCI_APPROVAL_MODULE: process.env.VINCI_APPROVAL_MODULE,
      VINCI_RECEIPT_MODULE: process.env.VINCI_RECEIPT_MODULE,
      VINCI_PI_FIXTURE: process.env.VINCI_PI_FIXTURE,
    } }, 60000, temporary);
  removalConfirmed = result.stderr.split("\n").includes("Owned fixture cleanup confirmed after all tracked CLI children and the canonical listener closed.");
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0, "The actual canonical fixture must pass; inspect its bounded refusal before retrying.");
} finally {
  if (removalConfirmed) await rm(temporary, { recursive: true, force: true });
  else process.stderr.write(`Owned fixture exit is unconfirmed; retain ${temporary} and reconcile the reported exact child before cleanup.\n`);
}
