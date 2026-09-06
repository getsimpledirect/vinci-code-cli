// End-to-end, through the REAL artifact: the built dist, the real extension loader, the real
// ExtensionRunner, every extension declared in identity.json in its declared order, and a real
// shell. The unit test (secret-handle-integration.mjs) drives vinci-guard in isolation with a
// hand-built `pi` stub, which cannot see the one failure that matters most here: vinci-guard is the
// 8th of 11 input handlers, and vinci-scope, vinci-loopbreak and vinci-autoname all run AFTER it.
// Any of them transforming the text would silently destroy the handle, and every isolated test
// would still pass.
//
// The credential below is invented for this test. Nothing here touches the network.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
process.env.VINCI_CODE = "1";

// Synthetic credential, invented for this test — TESTONLY (repo convention for test vectors).
const FAKE_CREDENTIAL = "sk-TESTONLYe2e00000000000000";
const HANDLE = /<vinci-secret-[0-9a-f]{8}>/;

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

const loaderModule = await import(resolve(root, "packages/coding-agent/dist/core/extensions/loader.js"));
const runnerModule = await import(resolve(root, "packages/coding-agent/dist/core/extensions/runner.js"));

const identity = JSON.parse(readFileSync(resolve(root, "vinci/identity.json"), "utf8"));
const paths = identity.extensions.map((file) => join(root, "vinci/extensions", file));

const runtime = loaderModule.createExtensionRuntime();
const loaded = await loaderModule.loadExtensions(paths, root, undefined, runtime);
check(`every declared extension loads (${loaded.extensions.length}/${paths.length})`, loaded.extensions.length === paths.length && (loaded.errors ?? []).length === 0);

const runner = new runnerModule.ExtensionRunner(
  loaded.extensions,
  loaded.runtime ?? runtime,
  root,
  { getSessionId: () => "e2e", getMessages: () => [], getSessionPath: () => "/dev/null" },
  { registerProvider() {}, unregisterProvider() {} },
);
runner.bindCore(
  {
    sendMessage() {}, sendUserMessage() {}, appendEntry() {}, setSessionName() {}, getSessionName: () => "e2e",
    setLabel() {}, getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, refreshTools() {},
    getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel() {},
  },
  {
    getModel: () => undefined, isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined,
    abort() {}, hasPendingMessages: () => false, pendingMessageCount: () => 0, shutdown() {},
    getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "",
  },
);

const inputHandlerOrder = loaded.extensions
  .filter((ext) => (ext.handlers.get("input") ?? []).length > 0)
  .map((ext) => ext.path.split("/").pop());
check(
  "extensions with input handlers run after vinci-guard, so this test can see them mangle a handle",
  inputHandlerOrder.indexOf("vinci-guard.ts") < inputHandlerOrder.length - 1,
);

// ── 1. What the user types becomes a handle, through the whole real chain ────────────────────────
const typed = `Use this: curl -X POST https://api.example.com/v1/chat -H "Authorization: Bearer ${FAKE_CREDENTIAL}" -d @b.json`;
const transformed = await runner.emitInput(typed, undefined, "interactive", undefined);

check("the real input chain rewrites what the user typed", transformed.action === "transform");
check("the credential is gone from what the model will see", !transformed.text.includes(FAKE_CREDENTIAL));
check("and it was replaced by a live handle, not a bare sentinel", HANDLE.test(transformed.text));
check("no extension running after vinci-guard mangles the handle", transformed.text === typed.replace(FAKE_CREDENTIAL, transformed.text.match(HANDLE)[0]));

// ── 2. The handle resolves on the shell channel, and the shell gets the real value ───────────────
const handle = transformed.text.match(HANDLE)[0];
const input = { command: `echo '${handle}'` };
const blocked = await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "t1", input });

check("a command carrying the handle is not blocked", blocked?.block !== true);
check("the command that will run carries the real credential", input.command.includes(FAKE_CREDENTIAL) && !HANDLE.test(input.command));

const stdout = execFileSync("/bin/sh", ["-c", input.command], { encoding: "utf8" }).trim();
check("a REAL shell receives the real credential", stdout === FAKE_CREDENTIAL);

// ── 3. The constraints hold through the real chain too ───────────────────────────────────────────
const write = { path: ".env.local", content: `API_KEY=${handle}\n` };
const writeBlocked = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "t2", input: write });
check("writing the same handle to a file is still refused", writeBlocked?.block === true);
check("and the file content is never rehydrated", !write.content.includes(FAKE_CREDENTIAL));

// A secret Vinci only READ carries no handle, so there is nothing on the shell channel to resolve.
const readSecret = { command: "curl -H 'Authorization: Bearer <vinci-secret>' https://api.example.com" };
const readBlocked = await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "t3", input: readSecret });
check("a bare sentinel is still refused on the shell channel", readBlocked?.block === true);
check("the refusal is the placeholder rule, not a generic shell risk", /secret-masking placeholder/i.test(String(readBlocked?.reason ?? "")));

console.log(`\nsecret-handle-e2e: ${pass}/${pass} checks passed (real dist, real extension order, real shell)`);
