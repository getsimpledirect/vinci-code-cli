// Exercise refused operations through the real launcher, compiled extensions, and print modes.
// The synthetic provider and tool-call guard finish before any native writer can run.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targetRoot = realpathSync(resolve(process.argv[2] ?? process.env.VINCI_TEST_ROOT ?? fixtureRoot));
const sourceRoot = realpathSync(resolve(process.argv[3] ?? process.env.VINCI_TEST_SOURCE_ROOT ?? fixtureRoot));
const launcher = join(targetRoot, "vinci/bin/vinci");
const cli = join(targetRoot, "packages/coding-agent/dist/cli.js");
const selectedExtensions = ["vinci-receipt.js", "vinci-shell.js"].map((name) => join(targetRoot, "vinci/dist/extensions", name));
const compat = join(targetRoot, "packages/ai/dist/compat.js");
const identity = join(targetRoot, "vinci/dist/source-identity.json");
for (const path of [launcher, cli, compat, identity, ...selectedExtensions]) {
  assert.ok(existsSync(path), `Required built file "${path}" is missing. Provision the selected runtime before retrying.`);
  assert.equal(realpathSync(path), path, `Selected built file "${path}" resolves elsewhere. Inspect its source identity before retrying.`);
  process.stdout.write(`Headless fixture selected ${path}, SHA-256 ${createHash("sha256").update(readFileSync(path)).digest("hex")}.\n`);
}
process.stdout.write(execFileSync(process.execPath, [
  join(sourceRoot, "vinci/scripts/build-source-identity.mjs"), "check", sourceRoot, identity,
], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }));

const owned = mkdtempSync(join(process.env.VINCI_HEADLESS_TEST_TMP || tmpdir(), ".headless-refusal-"));
after(() => rmSync(owned, { recursive: true, force: true }));
const closingAsk = "Please confirm and I'll apply it.";
const noAsk = "No files changed: the attempted change did not go through.";
const providerExtension = join(owned, "provider.mjs");
const offlinePreload = join(owned, "offline.cjs");
writeFileSync(offlinePreload, `
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const deny = () => {
  appendFileSync(process.env.VINCI_REFUSAL_TEST_EVENTS, JSON.stringify({ type: "network_denied" }) + "\\n");
  throw new Error("Network access is forbidden in the headless refusal fixture");
};
globalThis.fetch = deny;
for (const name of ["node:http", "node:https"]) {
  require(name).request = deny;
  require(name).get = deny;
}
require("node:net").Socket.prototype.connect = deny;
require("node:tls").connect = deny;
const childProcess = require("node:child_process");
const nativeSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const values = [command, ...(Array.isArray(args) ? args : [])].filter((value) => typeof value === "string");
  if (values.some((value) => value.includes("sandbox-exec") || /\\bbwrap\\b/.test(value) || value.includes(process.env.VINCI_REFUSAL_TEST_TARGET))) {
    appendFileSync(process.env.VINCI_REFUSAL_TEST_EVENTS, JSON.stringify({ type: "unexpected_native_writer" }) + "\\n");
    throw new Error("The scripted refusal did not stop the native writer. Inspect the guard before retrying.");
  }
  return nativeSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();
`);
writeFileSync(providerExtension, `
import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from ${JSON.stringify(pathToFileURL(compat).href)};
export default function (pi) {
  const audit = (event) => appendFileSync(process.env.VINCI_REFUSAL_TEST_EVENTS, JSON.stringify(event) + "\\n");
  const target = process.env.VINCI_REFUSAL_TEST_TARGET;
  const callId = "headless-refused-write";
  const plan = process.env.VINCI_REFUSAL_TEST_PLAN === "1";
  const reason = plan ? "Plan mode kept the project unchanged; no approval UI is available." : 'Scripted write refusal for "' + target + '": the operation did not run.';
  const registration = registerFauxProvider({ tokensPerSecond: 1000 });
  registration.setResponses([
    () => {
      audit({ type: "provider_write", callId, target });
      return fauxAssistantMessage(fauxToolCall("write", { path: target, content: "fixture bytes\\n" }, { id: callId }), { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
      assert.equal(result?.isError, true, "The scripted refusal must reach the provider as a correlated tool error.");
      assert.ok(result.content.some((part) => part.type === "text" && part.text.includes(reason)), "The correlated result must retain the scripted refusal reason.");
      audit({ type: "provider_close", callId });
      return fauxAssistantMessage(process.env.VINCI_REFUSAL_TEST_ASK === "1" ? ${JSON.stringify(closingAsk)} : ${JSON.stringify(noAsk)});
    },
  ]);
  if (plan) registration.appendResponses(Array.from({ length: 6 }, () =>
    fauxAssistantMessage(process.env.VINCI_REFUSAL_TEST_ASK === "1" ? ${JSON.stringify(closingAsk)} : ${JSON.stringify(noAsk)})));
  pi.registerProvider("faux", {
    name: "Headless refusal fixture",
    baseUrl: "http://localhost:0",
    apiKey: "headless-refusal-fixture",
    api: registration.api,
    models: registration.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({ id, name, reasoning, input, cost, contextWindow, maxTokens })),
  });
  pi.on("session_start", () => {
    const extensions = process.argv.flatMap((value, index, args) => value === "--extension" ? [args[index + 1]] : []);
    audit({ type: "fixture_loaded", cli: realpathSync(process.argv[1]), extensions, sandboxBypass: process.env.VINCI_NO_SANDBOX === "1", verificationBypass: process.env.VINCI_NO_VERIFY === "1" });
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write" || plan) return undefined;
    assert.equal(event.toolCallId, callId, "Only the scripted write may reach the refusal guard.");
    assert.equal(resolve(ctx.cwd, event.input.path), target, "The refused operation must name the requested target.");
    audit({ type: "guard_refusal", callId, target, reason });
    return { block: true, reason };
  });
  pi.on("session_shutdown", () => registration.unregister());
}
`);

function invocation(args, environment, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", [launcher, ...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); kill(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      kill();
      resolveResult({ code, signal, timedOut, stdout, stderr });
    });
  });
}
function jsonLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
for (const { mode, ask, plan } of [
  ...["text", "json"].flatMap((mode) => [false, true].map((ask) => ({ mode, ask, plan: false }))),
  ...[false, true].map((ask) => ({ mode: "json", ask, plan: true })),
]) {
    test(`headless ${mode} ${plan ? "plan refusal" : "refused write"} ${ask ? "with a closing ask" : "without an ask"}${plan ? " preserves its outcome" : " exits 3"}`, async () => {
      const home = join(owned, `${mode}-${plan ? "plan-" : ""}${ask ? "ask" : "no-ask"}`);
      const project = join(home, "project");
      const profile = join(home, "profile");
      const sessions = join(home, "sessions");
      const temporary = join(home, "temp");
      for (const path of [project, profile, sessions, temporary]) mkdirSync(path, { recursive: true });
      const target = join(project, "requested.txt");
      const events = join(home, "events.jsonl");
      writeFileSync(events, "");
      writeFileSync(join(profile, "trust.json"), JSON.stringify({ [project]: true }));
      const environment = {
        PATH: process.env.PATH, HOME: home, TMPDIR: temporary,
        PI_CODING_AGENT_DIR: profile, VINCI_CODING_AGENT_DIR: profile,
        PI_OFFLINE: "1", PI_TELEMETRY: "0", VINCI_TOOL_BOOTSTRAP: "0",
        VINCI_NO_RESUME: "1", VINCI_UPDATE_DISABLED: "1", VINCI_NO_BOOTSTRAP_HEAL: "1",
        VINCI_INTERNAL_PROVIDER_TEST: "1", VINCI_PROVIDER: "faux", VINCI_MODEL: "faux-1",
        VINCI_REFUSAL_TEST_EVENTS: events, VINCI_REFUSAL_TEST_TARGET: target,
        VINCI_REFUSAL_TEST_ASK: ask ? "1" : "0",
        VINCI_REFUSAL_TEST_PLAN: plan ? "1" : "0",
        NODE_OPTIONS: `--require=${JSON.stringify(offlinePreload)}`, JITI_FS_CACHE: "false",
        GIT_CEILING_DIRECTORIES: owned, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
        TERM: "dumb", NO_COLOR: "1",
      };
      const result = await invocation([
        "--session-dir", sessions, "--extension", providerExtension, "--tools", "write",
        "--mode", mode, "-p", plan ? "Plan the requested change to requested.txt." : "Create requested.txt containing fixture bytes.",
      ], environment, project);
      writeFileSync(join(home, "stdout.txt"), result.stdout);
      writeFileSync(join(home, "stderr.txt"), result.stderr);
      assert.equal(result.timedOut, false, "The real launcher exceeded 45 seconds. Inspect its lifecycle before retrying.");
      assert.equal(result.signal, null, `The launcher ended on signal "${result.signal}". Inspect its output before retrying.`);
      assert.doesNotMatch(result.stdout + result.stderr, /Failed to load extension|ERR_MODULE_NOT_FOUND|Cannot find package/);
      const audit = jsonLines(events);
      assert.equal(audit.some((event) => event.type === "network_denied"), false, "The offline fixture attempted network access. Stop this check and inspect the caller.");
      assert.equal(audit.some((event) => event.type === "unexpected_native_writer"), false, "The scripted refusal reached native execution. Stop this check and inspect the guard.");
      const loaded = audit.find((event) => event.type === "fixture_loaded");
      assert.ok(loaded, "The real launcher did not load the scripted fixture. Inspect extension loading before retrying.");
      assert.equal(loaded.cli, cli, "The launcher selected another CLI or a source fallback. Rebuild the selected runtime before retrying.");
      assert.equal(loaded.sandboxBypass, false, "The fixture must retain sandbox confinement.");
      assert.equal(loaded.verificationBypass, false, "The fixture must retain verification.");
      for (const extension of selectedExtensions) assert.ok(loaded.extensions.includes(extension), `The launcher did not select compiled extension "${extension}". Inspect extension loading before retrying.`);
      assert.equal(loaded.extensions.some((path) => path.startsWith(join(targetRoot, "vinci/extensions"))), false, "The launcher selected a source extension fallback. Rebuild the selected runtime before retrying.");
      const refusals = audit.filter((event) => event.type === "guard_refusal");
      assert.equal(refusals.length, plan ? 0 : 1, "An earlier guard prevented the scripted refusal. Inspect its result before counting this control.");
      assert.equal(audit.filter((event) => event.type === "provider_write").length, 1, "The provider must request the mutation exactly once.");
      assert.equal(audit.filter((event) => event.type === "provider_close").length, 1, "The provider must receive the correlated error before closing.");
      assert.equal(existsSync(target), false, "The refused native writer created a file. Stop this check and inspect confinement.");
      const sessionFiles = readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
      assert.equal(sessionFiles.length, 1, "The real invocation must persist exactly one session.");
      const entries = jsonLines(join(sessions, sessionFiles[0]));
      assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "headless-refused-write" && entry.message.isError === true), "The durable session must contain the correlated refused write.");
      if (ask) {
        if (mode === "text") {
          const start = result.stdout.indexOf(closingAsk);
          assert.ok(start >= 0, `Headless text stdout "${result.stdout.slice(-4000)}" hid the closing ask. Stop this check and inspect its display.`);
          process.stdout.write(`Headless text closing ask appeared in stdout: ${result.stdout.slice(start, start + closingAsk.length)}\n`);
        } else {
          const records = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
          const eventNames = [...new Set(records.filter((event) => JSON.stringify(event).includes(closingAsk)).map((event) => event.type))];
          assert.ok(eventNames.length > 0, "Headless JSON events hid the closing ask. Stop this check and inspect its display.");
          process.stdout.write(`Headless JSON closing ask appeared in events: ${eventNames.join(", ")}.\n`);
        }
      }
      if (plan) {
        const refusal = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "headless-refused-write")?.message;
        assert.deepEqual([refusal?.details?.vinciBlocked, refusal?.content], [true, [{ type: "text", text: "Plan mode kept the project unchanged; no approval UI is available." }]], "The planning prompt must reach plan mode's own headless refusal.");
      }
      const outcome = entries.findLast((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome")?.data;
      process.stdout.write(`Headless ${mode} refused write ${ask ? "with a closing ask" : "without an ask"} exited ${result.code}; saved outcome ${outcome?.state ?? "absent"}.\n`);
      if (plan) {
        process.stdout.write(`Plan refusal ${ask ? "ask" : "no-ask"} measurement: ${JSON.stringify({ exit: result.code, state: outcome?.state, reason: outcome?.reason })}\n`);
        assert.deepEqual([result.code, outcome?.state, outcome?.reason], ask
          ? [3, "WAITING", "The final reply asks for your go-ahead — the work is holding for your answer."]
          : [0, "DONE", noAsk], "A headless plan refusal must preserve its measured exit, state and reason.");
      } else assert.equal(result.code, 3, `Headless ${mode} refused write ${ask ? "with a closing ask" : "without an ask"} exited "${result.code}" instead of 3. Inspect the terminal outcome before retrying.`);
    });
}
