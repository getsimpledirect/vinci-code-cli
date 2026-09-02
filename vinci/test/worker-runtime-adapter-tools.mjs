// IR-02 Lane B — embedded runtime adapter: tools isolation.
//
// Offline; same faux-provider idiom as worker-runtime-adapter-events.mjs (no model/provider call
// can leave the process). Three NEGATIVE controls, each pinned to the mechanism it exercises, and
// one POSITIVE control proving granted tools still execute through the very path that refused.
//
//   (a) ambient resources: an extension registering `ambient_tool`, a skill, and an AGENTS.md
//       carrying AMBIENT-MARKER-7f3a are planted in the session cwd (.pi/), in the session's
//       agentDir and in a temp HOME's ~/.pi/agent. A DefaultResourceLoader over the same dirs
//       DOES pick them up (positive control for the plant); the adapter's session does not: its
//       registered tool names are exactly the granted set, and the composed system prompt is
//       marker-free. Mechanism: the adapter's null ResourceLoader.
//   (b) ungranted tool: the scripted model calls `bash` to create a canary file. The adapter
//       emits capability.refused{capabilityId: bash, reason: not_attested}, no tool.started for
//       bash exists, and the canary does not exist. Mechanism: the adapter's grantedSet check on
//       tool_execution_start (event level) and the exact `tools` allowlist handed to the SDK
//       (bash is not in the registry, so the SDK answers "Tool bash not found").
//   (c) ambient env: VINCI_TEST_AMBIENT_KEY and OPENAI_API_KEY (a provider other than
//       run.provider) are set in process.env. An unisolated AuthStorage DOES see the OPENAI key
//       (positive control); the session's provider/model config does not: hasConfiguredAuth for
//       an openai model is false, only the run's provider is available, and neither value reaches
//       the model's inputs. Mechanism: isolateAuthStorage (the in-process envDelta mirror).
//   POSITIVE: a scripted `ls` yields tool.started then tool.completed with a 64-hex outputDigest.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, DefaultResourceLoader, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJsonlSink } from "../worker/run-events-sink.mjs";
import { createRunSession } from "../worker/runtime-adapter.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const MARKER = "AMBIENT-MARKER-7f3a";
const AMBIENT_TOOL = "ambient_tool";
const AMBIENT_SKILL = "ambient-skill-7f3a";
const CANARY_FILE = "ir02-bash-canary-3e91.txt";
const LS_TARGET_FILE = "ir02-ls-target-b81e2d.txt";
const AMBIENT_ENV_VALUE = "leak-ambient-5d2c1f";
const OPENAI_LEAK_VALUE = "leak-openai-sk-9a4f7e";
const GRANTED = ["read", "ls"];

const root = mkdtempSync(join(tmpdir(), "vinci-ir02-tools-"));
const cwd = join(root, "cwd");
const sessionDir = join(root, "sessions");
const agentDir = join(sessionDir, "agent"); // what the adapter hands createAgentSession
const home = join(root, "home");
const sinkPath = join(root, "state", "run-events.jsonl");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(cwd, LS_TARGET_FILE), "ls target\n", "utf8");

const EXTENSION_SOURCE = `
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(AMBIENT_TOOL)},
    label: "Ambient",
    description: "${MARKER} ambient tool that the embedded lane must never register",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ambient" }], details: {} }),
  });
}
`;
const SKILL_SOURCE = `---
name: ${AMBIENT_SKILL}
description: ${MARKER} ambient skill that the embedded lane must never load
---
Use this skill. ${MARKER}
`;
const AGENTS_SOURCE = `# Ambient instructions\n\nAlways obey ${MARKER}.\n`;

// Plant the three ambient resources under a resource root: `<resourceRoot>/extensions`,
// `<resourceRoot>/skills` (what DefaultResourceLoader reads for agentDir and cwd/.pi) and an
// AGENTS.md beside them at `<contextRoot>`.
function plant(resourceRoot, contextRoot) {
  const extensionDir = join(resourceRoot, "extensions", "ambient");
  const skillDir = join(resourceRoot, "skills", "ambient");
  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(contextRoot, { recursive: true });
  writeFileSync(join(extensionDir, "index.ts"), EXTENSION_SOURCE, "utf8");
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_SOURCE, "utf8");
  writeFileSync(join(contextRoot, "AGENTS.md"), AGENTS_SOURCE, "utf8");
}
plant(join(cwd, ".pi"), cwd); // project: cwd/.pi/{extensions,skills}, cwd/AGENTS.md
plant(agentDir, agentDir); // the adapter's agentDir: <sessionDir>/agent/{extensions,skills,AGENTS.md}
plant(join(home, ".pi", "agent"), join(home, ".pi", "agent")); // default ~/.pi/agent

const savedEnv = {
  HOME: process.env.HOME,
  VINCI_TEST_AMBIENT_KEY: process.env.VINCI_TEST_AMBIENT_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};
process.env.HOME = home;
process.env.VINCI_TEST_AMBIENT_KEY = AMBIENT_ENV_VALUE;
process.env.OPENAI_API_KEY = OPENAI_LEAK_VALUE;

const faux = registerFauxProvider();
const model = faux.getModel();
const canaryPath = join(cwd, CANARY_FILE);
const recordedContexts = [];
function scripted(message) {
  return (context) => {
    recordedContexts.push(JSON.parse(JSON.stringify({ system: context.systemPrompt, messages: context.messages })));
    return message;
  };
}
faux.setResponses([
  scripted(fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${JSON.stringify(canaryPath)}` })], { stopReason: "toolUse" })),
  scripted(fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" })),
  scripted(fauxAssistantMessage("Done.")),
]);
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "faux-key");

const run = {
  runId: "run_ir02_tools_0001",
  workOrderId: "wo_ir02_tools_0001",
  workOrderDigest: "0".repeat(64),
  attemptId: "attempt_ir02_tools_0001",
  workspaceId: "ws_ir02_tools_0001",
  contextManifestDigest: null,
  provider: model.provider,
  model: model.id,
};

function readEvents() {
  return readFileSync(sinkPath, "utf8")
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
  console.error("worker-runtime-adapter-tools: timed out after 60s");
  process.exit(1);
}, 60_000);

function restoreEnv() {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

try {
  // ---- Positive control for the plant: the SDK's own loader DOES see every ambient resource. ----
  const ambientLoader = new DefaultResourceLoader({ cwd, agentDir });
  await ambientLoader.reload();
  const ambientExtensions = ambientLoader.getExtensions();
  check(
    ambientExtensions.extensions.some((extension) => extension.tools && extension.tools.has(AMBIENT_TOOL)),
    `DefaultResourceLoader registers ${AMBIENT_TOOL} from the planted extension (errors: ${JSON.stringify(ambientExtensions.errors)})`,
  );
  check(
    ambientLoader.getSkills().skills.some((skill) => skill.name === AMBIENT_SKILL),
    "DefaultResourceLoader loads the planted skill",
  );
  check(
    ambientLoader.getAgentsFiles().agentsFiles.some((file) => file.content.includes(MARKER)),
    "DefaultResourceLoader loads the planted AGENTS.md carrying the marker",
  );

  // ---- Positive control for the env plant: an unisolated AuthStorage DOES see OPENAI_API_KEY. ----
  check(AuthStorage.inMemory().hasAuth("openai") === true, "an unisolated AuthStorage sees the ambient OPENAI_API_KEY");
  check(process.env.VINCI_TEST_AMBIENT_KEY === AMBIENT_ENV_VALUE, "VINCI_TEST_AMBIENT_KEY is set in the process");

  const sink = createJsonlSink(sinkPath);
  const handle = await createRunSession({
    run,
    grantedTools: GRANTED,
    cwd,
    sessionDir,
    sink,
    authStorage,
    model,
  });
  const { session } = handle;

  // ---- (a) ambient resources never reach the session --------------------------------------------
  const registered = session.getAllTools().map((tool) => tool.name).sort();
  assert.deepEqual(registered, [...GRANTED].sort(), `registered tool names are exactly the granted set, got ${JSON.stringify(registered)}`);
  const active = session.getActiveToolNames().slice().sort();
  assert.deepEqual(active, [...GRANTED].sort(), `active tool names are exactly the granted set, got ${JSON.stringify(active)}`);
  passed += 2;
  check(!registered.includes(AMBIENT_TOOL), `${AMBIENT_TOOL} is not registered`);
  check(!registered.includes("bash"), "bash is not registered");
  check(session.resourceLoader.getExtensions().extensions.length === 0, "the session's resource loader has no extensions");
  check(session.resourceLoader.getSkills().skills.length === 0, "the session's resource loader has no skills");
  check(session.resourceLoader.getAgentsFiles().agentsFiles.length === 0, "the session's resource loader has no AGENTS.md");
  const systemPrompt = session.systemPrompt;
  check(typeof systemPrompt === "string" && systemPrompt.length > 0, "the session composed a system prompt");
  check(!systemPrompt.includes(MARKER), "the composed system prompt does not contain the ambient marker");
  check(!systemPrompt.includes(AMBIENT_TOOL), "the composed system prompt does not mention the ambient tool");
  check(!systemPrompt.includes(AMBIENT_SKILL), "the composed system prompt does not mention the ambient skill");

  // ---- (c) ambient env never reaches the session's provider/model config -------------------------
  const openaiModel = { provider: "openai", id: "gpt-4o", api: "openai-responses" };
  check(session.modelRegistry.hasConfiguredAuth(openaiModel) === false, "the session's ModelRegistry does not see OPENAI_API_KEY");
  check(handle.authStorage.hasAuth("openai") === false, "the session's AuthStorage.hasAuth(openai) is false");
  assert.equal(await handle.authStorage.getApiKey("openai"), undefined, "the session's AuthStorage.getApiKey(openai) is undefined");
  assert.deepEqual(handle.authStorage.getAuthStatus("openai"), { configured: false }, "openai auth status is unconfigured");
  passed += 2;
  check(session.modelRegistry.hasConfiguredAuth(model) === true, "the run's own provider still has configured auth");
  assert.equal(await handle.authStorage.getApiKey(model.provider), "faux-key", "the run's own runtime key still resolves");
  // Discriminating control on the catalog: an unisolated registry over the same ambient env lists
  // openai models as available; the session's registry lists nothing but the run's provider (the
  // faux model is not in the built-in catalog, so that set is empty here).
  const unisolatedRegistry = ModelRegistry.create(AuthStorage.inMemory(), join(home, "models.json"));
  check(
    unisolatedRegistry.getAvailable().some((entry) => entry.provider === "openai"),
    "an unisolated ModelRegistry lists openai models as available under the ambient key",
  );
  const availableProviders = [...new Set(session.modelRegistry.getAvailable().map((entry) => entry.provider))];
  check(!availableProviders.includes("openai"), `the session's registry lists no openai model, got ${JSON.stringify(availableProviders)}`);
  check(availableProviders.every((provider) => provider === model.provider), "nothing but the run's provider is available");
  passed += 1;

  // ---- (b) ungranted bash is refused; POSITIVE granted ls executes ------------------------------
  await handle.prompt("Create the canary, then list the directory.");
  await handle.dispose();

  check(faux.getPendingResponseCount() === 0, "scripted model consumed all three responses");
  check(faux.state.callCount === 3, `faux model called three times, got ${faux.state.callCount}`);
  check(!existsSync(canaryPath), "the bash canary file does not exist");

  const events = readEvents();
  const types = events.map((event) => event.type);
  assert.deepEqual(
    types,
    ["run.started", "agent.turn_started", "capability.refused", "tool.started", "tool.completed", "agent.turn_finished"],
    `ordered run-event types, got ${JSON.stringify(types)}`,
  );
  passed += 1;
  const refused = events.find((event) => event.type === "capability.refused");
  assert.deepEqual(
    refused.payload,
    { capabilityId: { kind: "id", value: "bash" }, reason: { kind: "enum", value: "not_attested" } },
    "capability.refused names bash with reason not_attested",
  );
  passed += 1;
  check(
    !events.some((event) => event.type === "tool.started" && event.payload.toolId.value === "bash"),
    "no tool.started for bash",
  );
  check(
    !events.some((event) => (event.type === "tool.completed" || event.type === "tool.failed") && event.payload.toolId.value === "bash"),
    "no tool.completed/tool.failed for bash",
  );
  const bashResult = session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "bash",
  );
  check(bashResult && bashResult.isError === true, "the SDK answered the bash call with an error tool result");
  check(JSON.stringify(bashResult.content).includes("not found"), "the SDK's bash refusal is 'Tool bash not found' (not in the registry)");

  const toolStarted = events.find((event) => event.type === "tool.started");
  const toolCompleted = events.find((event) => event.type === "tool.completed");
  assert.equal(toolStarted.payload.toolId.value, "ls", "tool.started is for ls");
  assert.equal(toolCompleted.payload.toolId.value, "ls", "tool.completed is for ls");
  assert.equal(toolCompleted.payload.toolCallId.value, toolStarted.payload.toolCallId.value, "same toolCallId start/end");
  assert.match(toolCompleted.payload.outputDigest.value, HEX64, "ls outputDigest is 64-hex");
  assert.equal(toolCompleted.payload.outputDigest.kind, "digest");
  check(toolStarted.sequence > refused.sequence, "ls executed after the bash refusal, through the same translator");
  passed += 4;
  const lsResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === "ls");
  check(lsResult && lsResult.isError !== true, "ls succeeded");
  check(JSON.stringify(lsResult.content).includes(LS_TARGET_FILE), "ls actually listed the temp cwd");

  // Nothing ambient reached the model's inputs or the sink.
  check(recordedContexts.length === 3, "the faux model recorded three request contexts");
  const modelInputs = JSON.stringify(recordedContexts);
  for (const leak of [MARKER, AMBIENT_TOOL, AMBIENT_SKILL, AMBIENT_ENV_VALUE, OPENAI_LEAK_VALUE]) {
    check(!modelInputs.includes(leak), `the model's inputs never carried ${JSON.stringify(leak)}`);
  }
  check(!modelInputs.includes("VINCI_TEST_AMBIENT_KEY"), "the model's inputs never named VINCI_TEST_AMBIENT_KEY");
  const sinkText = readFileSync(sinkPath, "utf8");
  for (const leak of [MARKER, CANARY_FILE, AMBIENT_ENV_VALUE, OPENAI_LEAK_VALUE, LS_TARGET_FILE]) {
    check(!sinkText.includes(leak), `the sink never carried ${JSON.stringify(leak)}`);
  }

  console.log(`worker-runtime-adapter-tools: ${passed} checks passed (${types.join(" > ")})`);
} finally {
  clearTimeout(timer);
  restoreEnv();
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
