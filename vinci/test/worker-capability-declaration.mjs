// IR-02 Lane B — the WorkerDeclaration's CAPABILITY_MATRIX, pinned to MEASURED behaviour.
//
// The matrix is the daemon's honest answer to "what can a CALLER make this worker do". The failure
// mode this test exists to prevent is a flag flipped because a MECHANISM now exists somewhere in
// the process — IR-02 adds steer, interrupt and a durable per-run event stream to the embedded
// adapter — while nothing a caller can send reaches that mechanism.
//
// WHAT IS MEASURED, AND WHAT IS NOT. The matrix has THIRTEEN entries. SEVEN of them are asserted
// equal to a value measured in this run; the other SIX are UNPINNED LITERALS that this file only
// proves are still `false`/`"none"` and still enumerated. Claiming more than that was itself the
// defect: an earlier header said "every flag here is asserted EQUAL TO A VALUE MEASURED IN THIS
// RUN", which was true of six flags and of nothing else.
//
//   MEASURED (7): steering, pause, abort, questions   — probe A, the daemon's real inbox
//                 activityStream                      — probe B, what the bus client may publish
//                 safeResume                          — probe D, which lane a handoff selects
//                 structuredEvidence                  — probe E, buildDeclaration's one config input
//   UNPINNED LITERALS (6): approvals, restrictToReadOnly, filesystemEnforcement,
//                 networkEnforcement, nativeReceipts, independentVerification.
//                 Each is `false` (or `"none"`) for reasons argued in lease.mjs's matrix comment,
//                 and each would need a real measurement this file cannot make cheaply or honestly:
//                 approvals/restrictToReadOnly/nativeReceipts/independentVerification name control-
//                 plane protocol this worker has no counterpart for at all, and the two
//                 ENFORCEMENT flags would have to demonstrate the ABSENCE of confinement over a
//                 whole process — an unbounded claim, and one whose honest negative (a granted bash
//                 reaching outside cwd or the network) is not something to execute in a unit test.
//                 A `false` needing no proof is not the same as a `false` that has one, so they are
//                 named here instead of being quietly counted as measured.
//   The two lists are asserted to PARTITION the matrix exactly: a fourteenth flag added to
//   CAPABILITY_MATRIX belongs to neither and fails here, so this header cannot silently go stale.
//
// The measured flags:
//
//   * steering / pause / abort / questions — measured by what the daemon's own inbox delivers. A
//     bus serving one `handoff` and one each of `steer`, `pause`, `abort` and `question`, all
//     addressed to this worker, is polled through the real BusClient: only the handoff comes back,
//     so no caller-issued command of any of those kinds can reach a running task. POSITIVE CONTROL:
//     the handoff IS delivered, so the empty result is not an artifact of a mis-addressed fixture.
//   * activityStream — measured by what the worker's bus client can PUBLISH: `post` accepts status
//     (positive control, against the same server) and refuses anything else, so the run's activity
//     has no transport. The embedded lane's event stream is durable but LOCAL.
//   * safeResume — measured by which lane the daemon actually runs. Phase 3 proves the EMBEDDED
//     lane resumes across a SIGKILL with no sequence gap or reuse, but a prose handoff selects no
//     runtime at all, so that proof is about a lane the daemon does not take, and it covers the
//     adapter's session + event sink rather than the task file, cursor, checkout and push the
//     matrix comment names.
//
// MECHANISM-EXISTS CONTROLS. For steering and pause the test also proves, through the adapter
// itself, that the mechanism is real and reachable IN-PROCESS (steer appends steer.received,
// interrupt appends run.paused). That is what makes the `false` honest and specific: the flag is
// false because no caller path reaches the mechanism, not because the mechanism is missing. If a
// later change wires a bus command to it, probe A flips and this test demands the matrix change.
//
// Offline: the SDK faux provider for the adapter, a loopback HTTP server for the bus.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { BusClient } from "../worker/bus.mjs";
import { CAPABILITY_MATRIX, buildDeclaration } from "../worker/lease.mjs";
import { createJsonlSink } from "../worker/run-events-sink.mjs";
import { createRunSession } from "../worker/runtime-adapter.mjs";
import { parseEnvelope } from "../worker/task.mjs";

const WORKER_ID = "capability-probe-1";
const TOKEN = "capability-probe-token";
const COMMAND_KINDS = ["steer", "pause", "abort", "question"];

const root = mkdtempSync(join(tmpdir(), "vinci-ir02-capability-"));
const cwd = join(root, "cwd");
const sessionDir = join(root, "sessions");
const sinkPath = join(root, "state", "run-events.jsonl");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(cwd, "capability-target.txt"), "target\n", "utf8");

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const timer = setTimeout(() => {
  console.error("worker-capability-declaration: timed out after 60s");
  process.exit(1);
}, 60_000);

// A bus that serves one handoff plus one message of each command kind, ALL addressed to this
// worker, and records what the worker posts.
const messages = [
  { message_id: "msg_handoff", kind: "handoff", to_agent: `worker:${WORKER_ID}`, ts: "2026-09-02T00:00:00Z", subject: "task", body: "repo: test/repo\nevidence: none\n\nDo the thing", posted_by: "coordinator" },
  ...COMMAND_KINDS.map((kind, index) => ({
    message_id: `msg_${kind}`,
    kind,
    to_agent: `worker:${WORKER_ID}`,
    ts: `2026-09-02T00:00:0${index + 1}Z`,
    subject: `${kind} the running task`,
    body: `${kind} body`,
    posted_by: "coordinator",
  })),
];
const posted = [];
const server = createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messages, total: messages.length, limit: messages.length, offset: 0 }));
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    posted.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ message_id: `msg_posted_${posted.length}` }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const busUrl = `http://127.0.0.1:${server.address().port}`;

const faux = registerFauxProvider();
try {
  // ---- PROBE A: what the daemon's inbox delivers ------------------------------------------------
  const bus = new BusClient(busUrl, TOKEN, 100, join(root, "outbox"));
  const delivered = await bus.poll(WORKER_ID);
  const deliveredKinds = delivered.map((message) => message.kind);
  // POSITIVE CONTROL first: the fixture is addressed correctly and the poll works.
  assert.deepEqual(deliveredKinds, ["handoff"], `only handoffs reach the daemon, got ${JSON.stringify(deliveredKinds)}`);
  passed += 1;
  const commandReachable = Object.fromEntries(
    COMMAND_KINDS.map((kind) => [kind, deliveredKinds.includes(kind)]),
  );
  for (const kind of COMMAND_KINDS) {
    check(commandReachable[kind] === false, `no caller-issued "${kind}" command reaches a running task`);
  }

  // ---- PROBE B: what the worker can publish -----------------------------------------------------
  await assert.rejects(
    () => bus.post("run_event", "run activity", "{}"),
    /worker cannot post message kind run_event/,
    "the worker's bus client refuses to publish a run-event stream",
  );
  await assert.rejects(
    () => bus.post("activity", "run activity", "{}"),
    /worker cannot post message kind activity/,
    "the worker's bus client refuses to publish an activity stream",
  );
  passed += 2;
  // POSITIVE CONTROL through the same client and server: a permitted kind really does post.
  await bus.post("status", "capability probe", "body");
  assert.deepEqual(posted.map((entry) => entry.kind), ["status"], "the permitted kind posts through the same client");
  passed += 1;
  const activityStreamPublished = posted.some((entry) => entry.kind !== "status" && entry.kind !== "finding" && entry.kind !== "blocker");

  // ---- PROBE C: the mechanisms DO exist in-process ----------------------------------------------
  const model = faux.getModel();
  faux.setResponses([fauxAssistantMessage("Idle.")]);
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "faux-key");
  const sink = createJsonlSink(sinkPath);
  const handle = await createRunSession({
    run: {
      runId: "run_ir02_capability_0001",
      workOrderId: "wo_ir02_capability_0001",
      workOrderDigest: "0".repeat(64),
      attemptId: "attempt_ir02_capability_0001",
      workspaceId: "ws_ir02_capability_0001",
      contextManifestDigest: null,
      provider: model.provider,
      model: model.id,
    },
    grantedTools: ["read", "ls"],
    cwd,
    sessionDir,
    sink,
    authStorage,
    model,
  });
  await handle.steer("redirect this run");
  await handle.interrupt("manual");
  await handle.dispose();
  const events = readFileSync(sinkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const eventTypes = events.map((event) => event.type);
  const steerMechanism = eventTypes.includes("steer.received");
  const pauseMechanism = eventTypes.includes("run.paused");
  check(steerMechanism, `the adapter's steer mechanism appends steer.received in-process, got ${JSON.stringify(eventTypes)}`);
  check(pauseMechanism, `the adapter's interrupt mechanism appends run.paused in-process, got ${JSON.stringify(eventTypes)}`);
  // The stream is durable and LOCAL: it exists on disk and nothing carried it anywhere.
  check(events.length >= 3, "the embedded run's activity is a durable local event stream");
  check(activityStreamPublished === false, "none of the run's activity was published to the bus");

  // ---- PROBE D: which lane the daemon actually runs ---------------------------------------------
  const handoffEnvelope = parseEnvelope(delivered[0].body);
  const embeddedLaneSelected = handoffEnvelope.runtime === "embedded";
  check(
    embeddedLaneSelected === false,
    `a handoff selects no embedded runtime, got ${JSON.stringify(handoffEnvelope.runtime ?? null)}`,
  );

  // ---- PROBE E: buildDeclaration's ONE config-derived flag ---------------------------------------
  // structuredEvidence is the only entry the daemon computes rather than copies: it passes
  // Boolean(VINCI_EVIDENCE_URI_PREFIX) as read at startup. Measured by driving buildDeclaration
  // itself in both directions — the flag must FOLLOW the argument, not the matrix literal. (The
  // matrix's own `structuredEvidence: false` is never what a running daemon publishes; the argument
  // is. Asserting the declaration equals the matrix, which is what this file used to do, compared
  // buildDeclaration's output with buildDeclaration's own input expression and could not fail.)
  const structuredEvidenceOff = buildDeclaration({ workerId: WORKER_ID, workerVersion: "0.0.0", adapterVersion: "0.0.0" })
    .supports.structuredEvidence;
  const structuredEvidenceOn = buildDeclaration({
    workerId: WORKER_ID,
    workerVersion: "0.0.0",
    adapterVersion: "0.0.0",
    structuredEvidence: true,
  }).supports.structuredEvidence;
  check(structuredEvidenceOff === false, "with no evidence prefix configured, the declaration says structuredEvidence false");
  check(structuredEvidenceOn === true, "POSITIVE CONTROL: configuring the evidence prefix flips the published flag to true");

  // ---- THE PINNING --------------------------------------------------------------------------
  // Each flag below equals a value measured above. A flag flipped without the measurement flipping
  // fails here, naming the measurement that contradicts it.
  const measured = {
    // A caller command of this kind reaches a running task.
    steering: commandReachable.steer,
    pause: commandReachable.pause,
    abort: commandReachable.abort,
    questions: commandReachable.question,
    // The run's activity is published to the control plane.
    activityStream: activityStreamPublished,
    // The lane whose kill-mid-write resume is proven is the lane the daemon runs.
    safeResume: embeddedLaneSelected,
    // The matrix's own entry is what a daemon started with no evidence prefix publishes.
    structuredEvidence: structuredEvidenceOff,
  };
  const why = {
    steering: "the adapter can steer in-process (steer.received observed here) but no bus command kind reaches it",
    pause: "the adapter can pause a turn in-process (run.paused observed here) but no bus command kind reaches it",
    abort: "no abort command is delivered; limits, lease loss and SIGTERM are not caller-issued aborts",
    questions: "no question command is delivered; the run is unattended",
    activityStream: "the run-event stream is a durable LOCAL file; the worker's bus client cannot publish it",
    safeResume: "the embedded lane's SIGKILL resume proof does not cover the lane a handoff selects, nor the task file/cursor/checkout/push",
    structuredEvidence: "buildDeclaration publishes Boolean(VINCI_EVIDENCE_URI_PREFIX); with none configured the matrix entry is what ships",
  };
  for (const [flag, value] of Object.entries(measured)) {
    assert.equal(
      CAPABILITY_MATRIX[flag],
      value,
      `CAPABILITY_MATRIX.${flag} must equal what this run measured (${value}): ${why[flag]}`,
    );
    passed += 1;
  }

  // ---- THE UNPINNED SIX, NAMED --------------------------------------------------------------
  // These are NOT measured here. Naming them is the honest half of the claim: the header says
  // exactly which flags carry a measurement, and this block is what keeps that list true.
  const UNPINNED = {
    approvals: "none",
    restrictToReadOnly: false,
    filesystemEnforcement: false,
    networkEnforcement: false,
    nativeReceipts: false,
    independentVerification: false,
  };
  for (const [flag, value] of Object.entries(UNPINNED)) {
    assert.equal(
      CAPABILITY_MATRIX[flag],
      value,
      `CAPABILITY_MATRIX.${flag} is an UNPINNED literal this file only records as ${JSON.stringify(value)}; ` +
        "changing it needs a measurement, and this file has none to offer",
    );
    passed += 1;
  }
  // The two lists PARTITION the matrix: every entry is either measured or explicitly unpinned, and
  // no entry is both. A fourteenth flag lands in neither list and fails here rather than joining
  // the six silently — this is what stops the header's population claim from going stale.
  assert.deepEqual(
    Object.keys(CAPABILITY_MATRIX).sort(),
    [...Object.keys(measured), ...Object.keys(UNPINNED)].sort(),
    `every CAPABILITY_MATRIX entry is either measured here or named as unpinned, got ${JSON.stringify(Object.keys(CAPABILITY_MATRIX))}`,
  );
  assert.equal(
    Object.keys(measured).filter((flag) => flag in UNPINNED).length,
    0,
    "no flag is counted as both measured and unpinned",
  );
  assert.equal(Object.keys(measured).length, 7, `seven flags are measured, got ${Object.keys(measured).length}`);
  assert.equal(Object.keys(UNPINNED).length, 6, `six flags are unpinned literals, got ${Object.keys(UNPINNED).length}`);
  passed += 4;

  // controlLevel is a HAND-WRITTEN literal in buildDeclaration, not a derivation (lease.mjs says so
  // now; it used to say "DERIVED", which claimed a mechanism no function implements). What IS
  // checkable is that the hand-written rung agrees with the measurement: nothing observes the run,
  // so the lowest rung is the only honest one.
  const declaration = buildDeclaration({ workerId: WORKER_ID, workerVersion: "0.0.0", adapterVersion: "0.0.0" });
  assert.equal(
    measured.activityStream,
    false,
    "the rung check below is conditioned on the measured activityStream, not on the literal",
  );
  assert.equal(
    declaration.controlLevel,
    "inventoried",
    "activityStream is false (measured above), so the hand-written controlLevel must be the lowest rung",
  );
  assert.deepEqual(
    Object.keys(declaration.supports).sort(),
    Object.keys(CAPABILITY_MATRIX).sort(),
    "the declaration publishes every matrix entry and invents none",
  );
  passed += 3;

  console.log(`worker-capability-declaration: ${passed} checks passed (measured: ${JSON.stringify(measured)}, unpinned: ${JSON.stringify(Object.keys(UNPINNED))})`);
} finally {
  clearTimeout(timer);
  faux.unregister();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
