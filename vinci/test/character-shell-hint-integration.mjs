// Vinci Code — the model harness knows about the user-owned !command shell escape.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const extension = await loader.import(resolve(here, "../extensions/vinci-character.ts"), { default: false });

const handlers = {};
extension.default({
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  sendMessage() {},
});

const beforeStart = handlers.before_agent_start?.[0];
assert.ok(beforeStart, "character extension must augment the model harness");
const result = await beforeStart({ systemPrompt: "base" }, {});
assert.match(result.systemPrompt, /type an exact `!command` directly into the input box/i);
assert.match(result.systemPrompt, /user-owned shell escape/i);
assert.match(result.systemPrompt, /never .*recommend broad[\s\S]*`sudo chown -R`/i);
assert.match(result.systemPrompt, /distinguish "installed", "installed but not on PATH", "partially[\s\S]*"not yet verified"/i);
assert.match(result.systemPrompt, /current installation guidance[\s\S]*vendor's official documentation/i);
assert.match(result.systemPrompt, /give one concise[\s\S]*do not repeat or rephrase it/i);

console.log("character-shell-hint-integration: 6/6 passed");
