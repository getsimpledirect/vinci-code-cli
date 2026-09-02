// IR-02 Lane B — the runVinci compatibility switch.
//
// One function now has two lanes, and the whole point of the switch is that the OLD lane is
// untouched. Both directions are exercised through the real runVinci:
//
//   * `runtime` ABSENT  -> the subprocess lane. Proven at the spawn seam runVinci actually uses:
//     `resolveBin("vinci")` walks PATH, so a stub `vinci` at the front of PATH records the exact
//     argv the daemon would have handed the real binary. The stub MUST be reached, the argv must
//     be the `-p --session-id … --session-dir … --provider … --model … --tools … <spec>` line, and
//     no run-events file may appear — the embedded lane must not have run.
//   * `runtime: "embedded"` -> the in-process lane. The SDK faux provider makes it offline. The
//     stub must NOT be reached, `<stateDir>/run-events.jsonl` must be written, and the resolved
//     value must carry the same keys the subprocess lane resolves with (worker.mjs spreads it
//     straight into the lifecycle record).
//
// The two lanes share one default tool grant (DEFAULT_GRANTED_TOOLS), asserted here against the
// CSV the subprocess lane passes, so they cannot drift apart.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { DEFAULT_GRANTED_TOOLS, runVinci } from "../worker/run.mjs";

const root = mkdtempSync(join(tmpdir(), "vinci-ir02-compat-"));
const binDir = join(root, "bin");
const repoDir = join(root, "repo");
const argvPath = join(root, "vinci-argv.json");
mkdirSync(binDir, { recursive: true });
mkdirSync(repoDir, { recursive: true });
writeFileSync(join(repoDir, "ir02-compat-target-5e19.txt"), "compat target\n", "utf8");

// The stub the subprocess lane must reach. It records argv and exits 0 — no session file, so the
// lane's own accounting reports the honest zeros for a run that produced nothing.
const stub = join(binDir, "vinci");
writeFileSync(
  stub,
  `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
  "utf8",
);
chmodSync(stub, 0o755);
const originalPath = process.env.PATH;
process.env.PATH = `${binDir}${delimiter}${originalPath}`;

const SPEC = "Do the compat thing. ir02-compat-spec-marker-77c1";
function baseEnvelope() {
  return {
    repo: "vinci/ir02-compat",
    evidence: "none",
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    budget_usd: 5,
    max_runtime_s: 600,
    deadline: undefined,
    branch: "ir02-compat",
    claim: ".",
    spec: SPEC,
    output: "none",
  };
}
function recordedArgv() {
  if (!existsSync(argvPath)) return [];
  return readFileSync(argvPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const timer = setTimeout(() => {
  console.error("worker-runtime-adapter-compat: timed out after 60s");
  process.exit(1);
}, 60_000);

let faux;
try {
  // ---- (1) runtime ABSENT -> subprocess lane, unchanged ---------------------------------------
  const legacyStateDir = join(root, "state-legacy");
  mkdirSync(legacyStateDir, { recursive: true });
  const legacyEnvelope = baseEnvelope();
  check(!("runtime" in legacyEnvelope), "the legacy envelope carries no runtime field at all");
  const legacy = await runVinci({
    envelope: legacyEnvelope,
    repoDir,
    stateDir: legacyStateDir,
    taskId: "ir02-compat-legacy",
    sessionId: "ir02-compat-legacy-session",
    env: { ...process.env },
  });

  const argv = recordedArgv();
  assert.equal(argv.length, 1, `the subprocess lane spawned the stub exactly once, got ${argv.length}`);
  passed += 1;
  const [spawned] = argv;
  assert.equal(spawned[0], "-p", "argv[0] is -p");
  assert.equal(spawned[spawned.length - 1], SPEC, "the spec text is the final argument");
  const flag = (name) => spawned[spawned.indexOf(name) + 1];
  assert.equal(flag("--session-id"), "ir02-compat-legacy-session", "--session-id");
  assert.equal(flag("--session-dir"), join(legacyStateDir, "sessions", "ir02-compat-legacy"), "--session-dir");
  assert.equal(flag("--provider"), "openrouter", "--provider");
  assert.equal(flag("--model"), "z-ai/glm-5.2", "--model");
  assert.equal(flag("--tools"), DEFAULT_GRANTED_TOOLS.join(","), "--tools is the shared default grant");
  passed += 6;

  // The embedded lane must not have run: no run-events file anywhere under the legacy state dir.
  check(
    !existsSync(join(legacyStateDir, "run-events.jsonl")),
    "the subprocess lane wrote NO run-events.jsonl (the embedded branch was not taken)",
  );
  assert.deepEqual(
    Object.keys(legacy).sort(),
    ["cost_usd", "exit_code", "harness_stops", "limit_tripped", "outcome", "unattended_policy"],
    `subprocess result keys, got ${JSON.stringify(Object.keys(legacy))}`,
  );
  assert.equal(legacy.exit_code, 0, "the stub exited 0");
  passed += 2;

  // A runtime value that is not "embedded" is ALSO the subprocess lane (the switch is exact-match).
  const otherEnvelope = { ...baseEnvelope(), runtime: "subprocess" };
  await runVinci({
    envelope: otherEnvelope,
    repoDir,
    stateDir: legacyStateDir,
    taskId: "ir02-compat-legacy",
    sessionId: "ir02-compat-legacy-session-2",
    env: { ...process.env },
  });
  assert.equal(recordedArgv().length, 2, "runtime: 'subprocess' also reaches the stub");
  passed += 1;

  // ---- (2) runtime: "embedded" -> the in-process lane -------------------------------------------
  faux = registerFauxProvider();
  const model = faux.getModel();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "call_compat_ls" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Compat run finished."),
  ]);
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "faux-key");

  const embeddedStateDir = join(root, "state-embedded");
  mkdirSync(embeddedStateDir, { recursive: true });
  const argvBefore = recordedArgv().length;
  const embeddedResult = await runVinci({
    envelope: { ...baseEnvelope(), runtime: "embedded", provider: model.provider, model: model.id },
    repoDir,
    stateDir: embeddedStateDir,
    taskId: "ir02-compat-embedded",
    sessionId: "ir02-compat-embedded-session",
    env: { ...process.env },
    embedded: { authStorage, model },
  });

  assert.equal(recordedArgv().length, argvBefore, "the embedded lane spawned NO subprocess");
  passed += 1;
  const eventsPath = join(embeddedStateDir, "run-events.jsonl");
  check(existsSync(eventsPath), "the embedded lane wrote <stateDir>/run-events.jsonl");
  const events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const types = events.map((event) => event.type);
  assert.deepEqual(
    types,
    ["run.started", "agent.turn_started", "tool.started", "tool.completed", "agent.turn_finished", "run.completed"],
    `embedded run-event types, got ${JSON.stringify(types)}`,
  );
  passed += 1;
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index + 1),
    "embedded sequences are 1..N contiguous",
  );
  passed += 1;
  for (const event of events) {
    assert.equal(event.runId, "ir02-compat-embedded", `${event.type}: runId is the taskId`);
    assert.equal(event.workspaceId, "vinci/ir02-compat", `${event.type}: workspaceId is the repo`);
  }
  assert.equal(events[0].payload.attemptId.value, "ir02-compat-embedded-session", "run.started carries the sessionId as attemptId");
  assert.deepEqual(
    events[events.length - 1].payload,
    { outcome: { kind: "enum", value: "SUCCEEDED" }, tierReached: { kind: "enum", value: "NONE" } },
    "the embedded lane closed the run with run.completed{SUCCEEDED, NONE}",
  );
  passed += 3;
  check(faux.getPendingResponseCount() === 0, "the scripted model was driven to completion in-process");

  // The resolved value is the shape worker.mjs consumes.
  assert.deepEqual(
    Object.keys(embeddedResult).sort(),
    ["cost_usd", "exit_code", "harness_stops", "limit_tripped", "outcome", "unattended_policy"],
    `embedded result keys, got ${JSON.stringify(Object.keys(embeddedResult))}`,
  );
  assert.equal(embeddedResult.exit_code, 0, "embedded exit_code");
  assert.equal(embeddedResult.limit_tripped, null, "embedded limit_tripped");
  assert.equal(typeof embeddedResult.cost_usd, "number", "embedded cost_usd is a number");
  assert.ok(Array.isArray(embeddedResult.harness_stops), "embedded harness_stops is a list");
  assert.ok(Array.isArray(embeddedResult.unattended_policy), "embedded unattended_policy is a list");
  passed += 6;

  // The embedded lane really ran the tool in repoDir: the transcript names the file, the sink does not.
  const sessionText = readFileSync(
    join(embeddedStateDir, "sessions", "ir02-compat-embedded", readdirOne(join(embeddedStateDir, "sessions", "ir02-compat-embedded"))),
    "utf8",
  );
  check(sessionText.includes("ir02-compat-target-5e19.txt"), "the embedded ls listed repoDir");
  check(!JSON.stringify(events).includes("ir02-compat-target-5e19.txt"), "the sink stayed content-free");
  check(!JSON.stringify(events).includes(SPEC), "the sink does not carry the spec text");

  console.log(`worker-runtime-adapter-compat: ${passed} checks passed (subprocess lane intact, embedded lane wired)`);
} finally {
  clearTimeout(timer);
  if (faux) faux.unregister();
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}

function readdirOne(directory) {
  const entries = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  assert.equal(entries.length, 1, `exactly one session file in ${directory}, got ${entries.length}`);
  return entries[0];
}
