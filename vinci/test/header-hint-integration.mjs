// Vinci Code — durable one-time thinking-hint regression test.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const extension = await loader.import(resolve(here, "../extensions/vinci-header.ts"), { default: false });
// The override name is derived from piConfig, not a fixed string — take it from the core config so a
// piConfig rename moves the test and the extension together instead of quietly decoupling them.
const { ENV_AGENT_DIR } = await loader.import(resolve(here, "../../packages/coding-agent/src/config.ts"), {
  default: false,
});

const agentDir = mkdtempSync(join(tmpdir(), "vinci-header-hint-"));
const previousAgentDir = process.env[ENV_AGENT_DIR];
process.env[ENV_AGENT_DIR] = agentDir;

const handlers = [];
extension.default({ on(name, handler) { if (name === "session_start") handlers.push(handler); } });
assert.equal(handlers.length, 1);

const notifications = [];
const ctx = {
  mode: "tui",
  cwd: agentDir,
  ui: {
    notify(message, level) { notifications.push({ message, level }); },
    setHeader() {},
  },
};

await handlers[0]({}, ctx);
await handlers[0]({}, ctx);
assert.deepEqual(notifications, [{
  message: "Thinking is collapsed by default. Press Ctrl+T anytime to show or hide it.",
  level: "info",
}]);

const secondProcessHandlers = [];
const secondLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const secondExtension = await secondLoader.import(resolve(here, "../extensions/vinci-header.ts"), { default: false });
secondExtension.default({ on(name, handler) { if (name === "session_start") secondProcessHandlers.push(handler); } });
await secondProcessHandlers[0]({}, ctx);
assert.equal(notifications.length, 1, "the marker must suppress the hint across extension reloads");

if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
else process.env[ENV_AGENT_DIR] = previousAgentDir;

console.log("header-hint-integration: 2/2 passed");
