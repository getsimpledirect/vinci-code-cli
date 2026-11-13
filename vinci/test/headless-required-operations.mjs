// Exercise refused operations through the real launcher, compiled extensions, and print modes.
// Shell writers are refused; only the recovery cases reach the structured writer.
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
const selectedExtensions = ["vinci-receipt.js", "vinci-shell.js", "vinci-guard.js"].map((name) => join(targetRoot, "vinci/dist/extensions", name));
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
  if (values.some((value) => value.includes("sandbox-exec") || /\\bbwrap\\b/.test(value) || value.includes(process.env.VINCI_REFUSAL_TEST_TARGET) || value.includes("requested.txt"))) {
    const structured = process.env.VINCI_REFUSAL_TEST_STRUCTURED_WRITE === "1" &&
      values.some((value) => value.includes("/bin/cat > ") && value.includes(process.env.VINCI_REFUSAL_TEST_TARGET));
    if (!structured) {
      appendFileSync(process.env.VINCI_REFUSAL_TEST_EVENTS, JSON.stringify({ type: "unexpected_native_writer" }) + "\\n");
      throw new Error("The scripted refusal did not stop the native writer. Inspect the guard before retrying.");
    }
    appendFileSync(process.env.VINCI_REFUSAL_TEST_EVENTS, JSON.stringify({ type: "structured_native_writer" }) + "\\n");
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
  const redirect = process.env.VINCI_REFUSAL_TEST_REDIRECT;
  const callId = redirect ? "shell-write" : "headless-refused-write";
  const plan = process.env.VINCI_REFUSAL_TEST_PLAN === "1";
  const reason = redirect ? 'Vinci blocked a shell-based file write; write and edit can create or change files under ' + realpathSync(resolve(target, "..")) + '; a file outside it needs your approval through the write tool. Target "' + target + '" is inside the project; use write with that path.' : plan ? "Plan mode kept the project unchanged; no approval UI is available." : 'Scripted write refusal for "' + target + '": the operation did not run.';
  const registration = registerFauxProvider({ tokensPerSecond: 1000 });
  registration.setResponses([
    () => {
      audit({ type: "provider_write", callId, target });
      return fauxAssistantMessage(redirect
        ? fauxToolCall("bash", { command: "printf 'fixture bytes\\\\n' > requested.txt" }, { id: callId })
        : fauxToolCall("write", { path: target, content: "fixture bytes\\n" }, { id: callId }), { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
      assert.equal(result?.isError, true, "The scripted refusal must reach the provider as a correlated tool error.");
      assert.ok(result.content.some((part) => part.type === "text" && part.text.includes(reason)), "The correlated result must retain the scripted refusal reason.");
      audit({ type: "provider_close", callId });
      if (redirect) assert.equal(result.details?.vinciBlocked, true, "The real guard must mark the shell refusal.");
      if (redirect === "recover") return fauxAssistantMessage(fauxToolCall("write", { path: target, content: "fixture bytes\\n" }, { id: "structured-write" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(process.env.VINCI_REFUSAL_TEST_ASK === "1" ? ${JSON.stringify(closingAsk)} : ${JSON.stringify(noAsk)});
    },
  ]);
  if (redirect === "recover") registration.appendResponses([(context) => {
    const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "structured-write");
    assert.equal(result?.isError, false, "The structured recovery must complete successfully.");
    return fauxAssistantMessage("Created requested.txt with the requested content.");
  }]);
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
    if (redirect) {
      assert.equal(redirect, "recover", "The unresolved control must never request a write.");
      assert.equal(event.toolCallId, "structured-write");
      assert.equal(resolve(ctx.cwd, event.input.path), target);
      assert.equal(event.input.content, "fixture bytes\\n");
      process.env.VINCI_REFUSAL_TEST_STRUCTURED_WRITE = "1";
      return undefined;
    }
    assert.equal(event.toolCallId, callId, "Only the scripted write may reach the refusal guard.");
    assert.equal(resolve(ctx.cwd, event.input.path), target, "The refused operation must name the requested target.");
    audit({ type: "guard_refusal", callId, target, reason });
    return { block: true, reason };
  });
  pi.on("tool_result", (event) => {
    if (event.toolCallId === "structured-write") delete process.env.VINCI_REFUSAL_TEST_STRUCTURED_WRITE;
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
for (const { mode, ask, plan, redirect } of [
  ...["text", "json"].flatMap((mode) => [false, true].map((ask) => ({ mode, ask, plan: false }))),
  ...[false, true].map((ask) => ({ mode: "json", ask, plan: true })),
  ...["text", "json"].flatMap((mode) => ["recover", "unresolved"].map((redirect) => ({ mode, ask: false, plan: false, redirect }))),
]) {
    test(`headless ${mode} ${redirect ? `shell write ${redirect}` : plan ? "plan refusal" : "refused write"} ${ask ? "with a closing ask" : "without an ask"}${plan ? " preserves its outcome" : redirect === "recover" ? " exits 0" : " exits 3"}`, async () => {
      const home = join(owned, `${mode}-${redirect || (plan ? "plan" : "refusal")}-${ask ? "ask" : "no-ask"}`);
      const project = join(home, "project");
      const profile = join(home, "profile");
      const sessions = join(home, "sessions");
      const temporary = join(home, "temp");
      for (const path of [project, profile, sessions, temporary]) mkdirSync(path, { recursive: true });
      const target = join(realpathSync(project), "requested.txt");
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
        VINCI_REFUSAL_TEST_REDIRECT: redirect || "",
        NODE_OPTIONS: `--require=${JSON.stringify(offlinePreload)}`, JITI_FS_CACHE: "false",
        GIT_CEILING_DIRECTORIES: owned, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
        TERM: "dumb", NO_COLOR: "1",
      };
      const result = await invocation([
        "--session-dir", sessions, "--extension", providerExtension, "--tools", redirect ? "bash,write" : "write",
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
      assert.equal(audit.filter((event) => event.type === "structured_native_writer").length, redirect === "recover" ? 1 : 0, "Only the correlated structured recovery may reach the fixed native writer.");
      const loaded = audit.find((event) => event.type === "fixture_loaded");
      assert.ok(loaded, "The real launcher did not load the scripted fixture. Inspect extension loading before retrying.");
      assert.equal(loaded.cli, cli, "The launcher selected another CLI or a source fallback. Rebuild the selected runtime before retrying.");
      assert.equal(loaded.sandboxBypass, false, "The fixture must retain sandbox confinement.");
      assert.equal(loaded.verificationBypass, false, "The fixture must retain verification.");
      for (const extension of selectedExtensions) assert.ok(loaded.extensions.includes(extension), `The launcher did not select compiled extension "${extension}". Inspect extension loading before retrying.`);
      assert.equal(loaded.extensions.some((path) => path.startsWith(join(targetRoot, "vinci/extensions"))), false, "The launcher selected a source extension fallback. Rebuild the selected runtime before retrying.");
      const refusals = audit.filter((event) => event.type === "guard_refusal");
      assert.equal(refusals.length, plan || redirect ? 0 : 1, "An earlier guard prevented the scripted refusal. Inspect its result before counting this control.");
      assert.equal(audit.filter((event) => event.type === "provider_write").length, 1, "The provider must request the mutation exactly once.");
      assert.equal(audit.filter((event) => event.type === "provider_close").length, 1, "The provider must receive the correlated error before closing.");
      assert.equal(existsSync(target), redirect === "recover", "Only a successful structured recovery may create the requested file.");
      if (redirect === "recover") assert.equal(readFileSync(target, "utf8"), "fixture bytes\n");
      const sessionFiles = readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
      assert.equal(sessionFiles.length, 1, "The real invocation must persist exactly one session.");
      const entries = jsonLines(join(sessions, sessionFiles[0]));
      const refusal = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === (redirect ? "shell-write" : "headless-refused-write"))?.message;
      assert.equal(refusal?.isError, true, "The durable session must contain the correlated refused write.");
      if (redirect) {
        assert.deepEqual([refusal.details?.vinciBlocked, refusal.content], [true, [{ type: "text", text: `Vinci blocked a shell-based file write; write and edit can create or change files under ${realpathSync(project)}; a file outside it needs your approval through the write tool. Target "${target}" is inside the project; use write with that path.` }]], "The shell write must reach the real guard's redirect refusal with the resolved project and target paths.");
        const shellCalls = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").flatMap((entry) => entry.message.content.filter((part) => part.type === "toolCall" && part.name === "bash"));
        assert.deepEqual(shellCalls.map((call) => call.id), ["shell-write"], "The session must not retry through another shell writer.");
        const recovery = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "structured-write")?.message;
        if (redirect === "recover") assert.equal(recovery?.isError, false);
        else assert.equal(recovery, undefined, "The unresolved control must never attempt the structured write.");
      }
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
      if (redirect) {
        process.stdout.write(`Headless ${mode} shell write ${redirect} exited ${result.code}; saved outcome ${outcome?.state ?? "absent"}.\n`);
        if (redirect === "recover") {
          assert.equal(result.code, 0, "A successful structured recovery must exit 0.");
          assert.ok(["DONE", "DONE_UNVERIFIED"].includes(outcome?.state));
          assert.equal(outcome.requiredOperations?.length ?? 0, 0, "The recovered shell redirect must leave no required operations.");
        } else {
          assert.equal(result.code, 3, "An unrecovered shell redirect must exit 3.");
          assert.equal(outcome?.state, "BLOCKED");
          assert.equal(outcome.requiredOperations.length, 1);
          assert.equal(outcome.requiredOperations[0].tool, "bash");
        }
        return;
      }
      process.stdout.write(`Headless ${mode} refused write ${ask ? "with a closing ask" : "without an ask"} exited ${result.code}; saved outcome ${outcome?.state ?? "absent"}.\n`);
      if (plan) {
        process.stdout.write(`Plan refusal ${ask ? "ask" : "no-ask"} measurement: ${JSON.stringify({ exit: result.code, state: outcome?.state, reason: outcome?.reason })}\n`);
        assert.deepEqual([result.code, outcome?.state, outcome?.reason], ask
          ? [3, "WAITING", "The final reply asks for your go-ahead — the work is holding for your answer."]
          : [0, "DONE", noAsk], "A headless plan refusal must preserve its measured exit, state and reason.");
      } else assert.equal(result.code, 3, `Headless ${mode} refused write ${ask ? "with a closing ask" : "without an ask"} exited "${result.code}" instead of 3. Inspect the terminal outcome before retrying.`);
    });
}
