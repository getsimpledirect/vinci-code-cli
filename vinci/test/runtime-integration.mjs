import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, runRuntime, runtimeClient } from "../scripts/runtime.mjs";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(fileURLToPath(new URL("../..", import.meta.url)));
const directory = await mkdtemp(join(root, ".runtime-test-"));
await chmod(directory, 0o700);
const config = join(directory, "connection.json"), spec = join(directory, "spec.json");
const artifactContent = "exact exported artifact", artifactDigest = createHash("sha256").update(artifactContent).digest("hex");
const binding = { actionId: "supplier-send", runId: "run-1", ownerId: "owner-1", workspaceId: "owner-1", organizationId: null, target: "selected target", contentRevision: 1, contentDigest: artifactDigest, actionClass: "send", toolId: "synthetic-tool", accountId: "synthetic-account", toolVersion: "1", expiresAt: 9999999999999 };
const digest = createHash("sha256").update(JSON.stringify([binding.actionId, binding.runId, binding.ownerId, binding.workspaceId, binding.organizationId, binding.contentRevision, binding.actionClass, binding.target, binding.contentDigest, binding.toolId, binding.accountId, binding.toolVersion, binding.expiresAt])).digest("hex");
const calls = [];
let mode = "normal", retainRoot = false;
const server = createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk;
  calls.push({ method: request.method, route: request.url, body, headers: request.headers });
  response.setHeader("content-type", "application/json");
  if (mode === "error") { response.writeHead(409); response.end(JSON.stringify({ error: "private-server-canary", token: "credential-canary" })); return; }
  if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/private" }); response.end(); return; }
  if (mode === "large") { response.end(JSON.stringify({ content: "x".repeat(270000) })); return; }
  if (mode === "hold-headers") return;
  if (mode === "unauthorized") { response.writeHead(401); response.end("{}"); return; }
  if (mode === "stall") { response.writeHead(200); response.flushHeaders(); return; }
  const event = (sequence, type, payload = {}) => ({ schemaVersion: 4, eventId: `event-${sequence}`, idempotencyKey: `event-key-${sequence}`, runId: "run-1", workspaceId: "owner-1", organizationId: null, actor: { kind: "user", userId: "owner-1" }, sequence, type, occurredAt: "2026-10-07T00:00:00.000Z", payload });
  let value = { view: { snapshot: { revision: 2, run: { schemaVersion: 1, runId: "run-1", attemptId: "attempt-1", state: "CREATED" }, pendingQuestionId: "question-1", pendingApprovalId: mode === "changed" ? "approval-2" : "approval-1" }, cancellationRequested: false, events: [event(1, "run.created", { workspaceId: { kind: "id", value: "owner-1" } }), event(2, "artifact.persisted", { artifactId: { kind: "id", value: "draft:v1" }, contentDigest: { kind: "digest", value: artifactDigest } })] }, input: "saved input" };
  if (request.url === "/tasks") value = { runId: "run-1", view: value.view, retention: "Explicitly saved fixture only" };
  if (request.url?.endsWith("/approvals")) value = { approval: { approvalId: mode === "changed" ? "approval-2" : "approval-1", actionDigest: digest, pending: true, effective: false, stale: mode === "stale", binding: { ...binding }, draft: { version: 1, digest: artifactDigest, content: artifactContent } } };
  if (request.url?.endsWith("/approve")) value = { approvalId: "approval-1", effective: true };
  if (request.url?.endsWith("/answers")) value = value.view;
  if (request.url?.endsWith("/cancel")) value = { view: value.view, acknowledged: false };
  if (request.url?.endsWith("/questions")) value = { questionId: "question-1", question: "Choose the output" };
  if (request.url?.endsWith("/receipt")) value = { receipt: null };
  if (request.url?.includes("/artifacts/")) value = { artifactId: "draft", version: 1, digest: artifactDigest, content: artifactContent };
  if (request.url?.includes("/events")) {
    const cursor = Number(new URL(request.url, "http://local").searchParams.get("after"));
    value = { revision: 1, events: cursor === 1 ? [] : [event(mode === "gap" ? 2 : 1, mode === "working" ? "run.created" : "run.completed")] };
  }
  response.end(JSON.stringify(value));
});
function listenerWait(action) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); server.removeListener("error", finish); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { retainRoot = true; server.unref(); finish(new Error(`Transport fixture listener is unconfirmed; retain ${directory} and stop its exact listener before cleanup.`)); }, 3000);
    server.once("error", finish); try { action(finish); } catch (error) { finish(error); }
  });
}
await listenerWait(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
async function configuration(value = { origin, cookie: "synthetic-session=runtime-owner" }) { await writeFile(config, JSON.stringify(value), { mode: 0o600 }); }
async function specification(value) { await writeFile(spec, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }
function cli(args, stdin, connectionPath = config, launcherRoot = root) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [join(launcherRoot, "vinci/bin/vinci"), "runtime", ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, VINCI_RUNTIME_CONFIG: connectionPath, VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_UPDATE_DISABLED: "1" },
    });
    const stdout = [], stderr = []; let size = 0, refusal = null, killTimer, closeTimer;
    const stop = message => {
      if (refusal) return; refusal = message; child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); closeTimer = setTimeout(() => {
        retainRoot = true; child.unref(); child.stdout.destroy(); child.stderr.destroy();
        reject(new Error(`Transport fixture child close is unconfirmed for PID ${child.pid}; retain ${directory} and stop that exact child before cleanup.`));
      }, 3000); }, 3000);
    };
    const timer = setTimeout(() => stop("Transport fixture deadline elapsed. Inspect its exact child before retrying."), 10000);
    child.once("error", () => stop("Transport fixture launch failed. Restore the exact launcher before retrying."));
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", chunk => { size += chunk.length; if (size > 262144) stop("Transport fixture output exceeded its bound. Reduce the selected output before retrying."); else chunks.push(chunk); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
      resolve({ status: refusal ? 124 : code ?? signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") + (refusal ? refusal + "\n" : "") });
    });
    child.stdin.end(stdin);
  });
}
async function refused(args, code) { const result = await cli(args); assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(code)); assert.equal(result.stdout, ""); }
try {
  await configuration();
  const helpResult = await cli(["--help"]); assert.equal(helpResult.status, 0); assert.match(helpResult.stdout, /Usage: vinci runtime/);
  const payloadLink = join(directory, "payload"); await symlink(root, payloadLink);
  const linkedHelp = await cli(["--help"], undefined, config, payloadLink);
  assert.equal(linkedHelp.status, 0); assert.match(linkedHelp.stdout, /Usage: vinci runtime/);
  assert.equal((await cli(["inspect", "run-1", "--json"])).status, 0);
  assert.equal(calls.at(-1).headers.origin, origin);
  assert.equal(calls.at(-1).headers.cookie, "synthetic-session=runtime-owner");
  await specification({ saved: true, input: "Unicode report café", commandId: "stable-create-1" });
  const created = await cli(["create", "--spec", spec, "--json"]);
  assert.equal(created.status, 0); assert.equal(JSON.parse(created.stdout).runId, "run-1");
  assert.equal(calls.at(-1).headers["x-vinci-task-intent"], "1");
  const textContent = "Synthetic inline text café";
  const textAttachment = { name: "notes.md", mediaType: "text/markdown", content: textContent, digest: createHash("sha256").update(textContent).digest("hex") };
  const rawAttachment = JSON.stringify({ saved: true, input: "Text input task", commandId: "text-create", attachments: [textAttachment] }, null, 2);
  await specification(rawAttachment);
  assert.equal((await cli(["create", "--spec", spec, "--json"])).status, 0);
  assert.equal(calls.at(-1).body === rawAttachment, true, "Attachment specs must reach the existing create route with original caller JSON bytes.");
  await specification({ saved: true, input: "Text input task", commandId: "text-invalid", attachments: [{ ...textAttachment, digest: "ab".repeat(32) }] });
  const priorTextRequests = calls.length; await refused(["create", "--spec", spec], "attachment_integrity_failed"); assert.equal(calls.length, priorTextRequests);
  const raw = '{"saved":true,"input":"one","input":"two","commandId":"duplicate"}';
  assert.equal((await cli(["create", "--spec", "-"], raw)).status, 0);
  assert.equal(calls.at(-1).body, raw, "the transport must preserve bytes for the real server duplicate-field refusal");
  await specification({ saved: false, input: "private input", commandId: "private" });
  const before = calls.length; await refused(["create", "--spec", spec], "explicit_saved_input_required"); assert.equal(calls.length, before);
  await specification({ questionId: "question-1", answer: "approved scope", expectedRevision: 1, humanSeconds: 2 });
  assert.equal((await cli(["answer", "run-1", "--spec", spec])).status, 0);
  assert.equal(calls.at(-1).route, "/tasks/run-1/answers");
  await specification({ approvalId: "approval-1", actionDigest: digest, commandId: "stable-approval", humanSeconds: 3 });
  assert.equal((await cli(["approve", "run-1", "--spec", spec])).status, 0);
  assert.equal(calls.at(-1).route, "/tasks/run-1/approve");
  for (const unsafe of ["changed", "stale"]) {
    mode = unsafe; const writes = calls.filter(call => call.method === "POST").length;
    await refused(["approve", "run-1", "--spec", spec], "stale_approval");
    assert.equal(calls.filter(call => call.method === "POST").length, writes);
  }
  mode = "normal";
  const cancelled = await cli(["cancel", "run-1"]); assert.equal(cancelled.status, 0); assert.match(cancelled.stdout, /termination is unconfirmed/);
  assert.equal((await cli(["export", "run-1", "draft", "1"])).stdout, "exact exported artifact");
  assert.equal((await cli(["watch", "run-1", "--timeout", "1"])).status, 0);
  mode = "gap"; await refused(["watch", "run-1", "--timeout", "1"], "replay_gap_requires_resync");
  mode = "working"; const deadline = await cli(["watch", "run-1", "--timeout", "1"]); assert.equal(deadline.status, 124); assert.match(deadline.stderr, /watch_deadline_reached/);
  const deadlineReads = [];
  for (const held of ["hold-headers", "stall"]) {
    mode = held; const result = await cli(["watch", "run-1", "--timeout", "1"]);
    deadlineReads.push(result); assert.equal(result.stdout, "", "A held watch response must emit no invented event.");
  }
  assert.deepEqual(deadlineReads.map(result => result.status), [124, 124], "The actual CLI watch deadline must remain exit 124 when it expires during response headers or body.");
  for (const result of deadlineReads) assert.match(result.stderr, /watch_deadline_reached/);
  const watchedApi = await createRuntime(config);
  for (const held of ["hold-headers", "stall"]) {
    mode = held; const interrupted = new AbortController(), timer = setTimeout(() => interrupted.abort(), 50);
    try { await assert.rejects(watchedApi.watch("run-1", { timeoutMs: 1000, signal: interrupted.signal }, () => {}), { code: "observation_aborted", exitCode: 124, mutationUnconfirmed: false }); }
    finally { clearTimeout(timer); }
  }
  mode = "working"; const pauseAbort = new AbortController();
  await assert.rejects(watchedApi.watch("run-1", { timeoutMs: 1000, signal: pauseAbort.signal }, () => pauseAbort.abort()), { code: "observation_aborted", exitCode: 124, mutationUnconfirmed: false }, "Caller abort during the watch pause must remain an observation abort.");
  const preAbort = new AbortController(); preAbort.abort(); const requestsBeforeAbort = calls.length;
  await assert.rejects(watchedApi.watch("run-1", { timeoutMs: 1000, signal: preAbort.signal }, () => {}), { code: "observation_aborted", exitCode: 124, mutationUnconfirmed: false });
  assert.equal(calls.length, requestsBeforeAbort, "A pre-aborted watch must send zero requests.");
  for (const [held, code] of [["hold-headers", "transport_unconfirmed"], ["stall", "response_unconfirmed"]]) {
    mode = held;
    await assert.rejects(watchedApi.watch("run-1", { timeoutMs: 6000 }, () => {}), { code, exitCode: 69, mutationUnconfirmed: false }, "The earlier five-second request failure must remain distinct from the overall watch deadline.");
  }
  for (const [refusal, code, exitCode] of [["error", "stale_or_conflicting_command", 75], ["unauthorized", "authority_refused", 77], ["large", "response_limit_exceeded", 69], ["gap", "replay_gap_requires_resync", 75]]) {
    mode = refusal;
    await assert.rejects(watchedApi.watch("run-1", { timeoutMs: 1000 }, () => {}), { code, exitCode, mutationUnconfirmed: false }, "A watch deadline must not replace an actual authority, response-limit or replay refusal.");
  }
  mode = "normal"; const restoredEvents = [];
  assert.equal((await watchedApi.watch("run-1", { timeoutMs: 1000 }, event => restoredEvents.push(event))).terminalObserved, true);
  assert.equal(restoredEvents.length, 1, "Restored terminal bytes remain a same-watch positive after every held/refused response.");

  for (const args of [["list"], ["merge", "run-1"], ["inspect", "../run-1"], ["watch", "run-1"], ["events", "run-1", "--after", "-1"], ["inspect", "run-1", "--token", "argv-canary"]]) {
    const prior = calls.length; assert.notEqual((await cli(args)).status, 0); assert.equal(calls.length, prior);
  }
  for (const value of [{ origin: "https://external.example", cookie: "credential-canary" }, { origin: origin + "/", cookie: "credential-canary" }, { origin, cookie: "one", token: "vinci_live_test" }]) {
    await configuration(value); await refused(["inspect", "run-1"], "refused"); assert.doesNotMatch((await cli(["inspect", "run-1"])).stderr, /credential-canary|external.example/);
  }
  await configuration(); await chmod(config, 0o644); await refused(["inspect", "run-1"], "file_refused"); await chmod(config, 0o600);
  const link = join(directory, "link.json"); await symlink(config, link); await assert.rejects(runtimeClient(link), { code: "file_unavailable" });
  const fifo = join(directory, "fifo"); execFileSync("mkfifo", [fifo], { timeout: 5000 });
  for (let trial = 0; trial < 3; trial++) {
    const prior = calls.length;
    const fifoConfig = await cli(["inspect", "run-1"], undefined, fifo);
    assert.equal(fifoConfig.status, 78); assert.match(fifoConfig.stderr, /file_refused/);
    const fifoSpec = await cli(["create", "--spec", fifo]);
    assert.equal(fifoSpec.status, 78); assert.match(fifoSpec.stderr, /file_refused/);
    assert.equal(calls.length, prior);
    assert.equal((await cli(["inspect", "run-1"])).status, 0, "regular-file positive control through same launcher");
  }
  await configuration({ origin, token: "vinci_live_runtime_fixture" }); assert.equal((await cli(["inspect", "run-1"])).status, 0); assert.equal(calls.at(-1).headers.authorization, "Bearer vinci_live_runtime_fixture");
  for (const unsafe of ["error", "redirect", "large"]) {
    mode = unsafe; const result = await cli(["inspect", "run-1"]); assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /private-server-canary|credential-canary/);
  }
  mode = "stall"; const client = await runtimeClient(config); await assert.rejects(client("GET", "/tasks/run-1", undefined, 50), { code: "response_unconfirmed" });
  let help = ""; await runRuntime(["--help"], undefined, value => { help += value; }); assert.match(help, /Only an explicitly configured local/);
  console.log("Runtime CLI real-launcher consumer checks passed: exact intent, byte preservation, stale refusal, privacy, bounded replay, cancellation, and sanitized errors; this transport fixture is not provider or deployed qualification.");
} finally {
  server.closeAllConnections();
  try { await listenerWait(done => server.close(done)); }
  catch (error) { retainRoot = true; throw error; }
  finally {
    if (!retainRoot) await rm(directory, { recursive: true, force: true });
    else process.stderr.write(`Transport fixture cleanup is unconfirmed; retain ${directory} and reconcile its exact child/listener before cleanup.\n`);
  }
}
