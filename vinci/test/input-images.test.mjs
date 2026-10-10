// Exercise the guard's real input hook, including an optional original-helper control.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "vinci-input-images-"));
const packageInfo = JSON.parse(readFileSync(resolve(here, "../../packages/coding-agent/package.json"), "utf8"));
const agentDirEnv = `${(packageInfo.piConfig?.name || "pi").toUpperCase()}_CODING_AGENT_DIR`;
const isolatedEnv = {
  [agentDirEnv]: join(workspace, "agent"),
  VINCI_HOME: join(workspace, "vinci-home"),
  VINCI_TRUST_FILE: join(workspace, "trust.json"),
};
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);

let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAILED ${name}: ${error.message} Recheck the guard input whitespace.`);
    failed++;
  }
}

try {
  const imageSource = resolve(here, "../extensions/lib/images.ts");
  // Redirect only the helper import; both runs load and fire the same real guard handler.
  const imageModule = process.env.VINCI_TEST_IMAGES_MODULE
    ? resolve(process.env.VINCI_TEST_IMAGES_MODULE)
    : imageSource;
  const loader = createJiti(import.meta.url, {
    // The guard and these assertions must share the same in-memory secret vault.
    moduleCache: true,
    fsCache: false,
    tryNative: false,
    alias: {
      "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/dist/index.js"),
      "./lib/images.ts": imageModule,
      [imageSource]: imageModule,
    },
  });
  const secrets = await loader.import(resolve(here, "../extensions/lib/secrets.ts"), { default: false });
  secrets.resetSecretVault();
  const guard = await loader.import(resolve(here, "../extensions/vinci-guard.ts"), { default: false });
  const handlers = {};
  const notifications = [];
  guard.default({
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand() {},
    sendMessage() {},
  });
  assert.equal(handlers.input?.length, 1, "the real guard must register its input handler");
  const ctx = {
    cwd: workspace,
    hasUI: false,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
  const input = (text, images = [], source = "interactive") =>
    handlers.input[0]({ type: "input", text, images, source }, ctx);
  const imagePath = join(workspace, "tiny screenshot.png");
  writeFileSync(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  console.log(`input-images helper: ${imageModule}`);

  await check("multiline code is byte-identical and continues", async () => {
    const text = "  Keep these instructions.\n\n```json\n{\n  \"nested\": {\n    \"value\":  1\n  }\n}\n```\n\n";
    const result = await input(text);
    assert.equal(result.text ?? text, text, "model-bound code must preserve newlines, indentation and spaces");
    assert.deepEqual(result, { action: "continue" });
  });
  await check("RPC task text preserves CRLF, tabs and boundary spaces", async () => {
    const text = "\tTask  text\r\n\r\n\t  Child  instructions\r\n  ";
    const result = await input(text, [], "rpc");
    assert.equal(result.text ?? text, text, "model-bound RPC text must preserve every whitespace byte");
    assert.deepEqual(result, { action: "continue" });
  });
  await check("empty and whitespace-only inputs continue", async () => {
    for (const text of ["", " \t\r\n\n  "]) assert.deepEqual(await input(text), { action: "continue" });
  });
  await check("existing attachments leave no-path text unchanged", async () => {
    const text = "Existing attachment.\n  Keep  this line.\n";
    const images = [{ type: "image", data: "", mimeType: "image/png" }];
    const result = await input(text, images);
    assert.equal(result.text ?? text, text, "existing attachments must not collapse prompt whitespace");
    assert.deepEqual(result, { action: "continue" });
  });
  await check("mid-paragraph PNG replacement tidies only adjacent spaces", async () => {
    const text = `  Intro  keeps   spacing.\n  Review   "${imagePath}"   alongside  notes.\n\n    Final   line.\n`;
    const result = await input(text);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1, "a real PNG must be attached through the guard");
    assert.equal(result.images[0].mimeType, "image/png");
    assert.ok(result.images[0].data.length > 0);
    assert.equal(result.text, "  Intro  keeps   spacing.\n  Review [Image #1] alongside  notes.\n\n    Final   line.\n");
  });
  await check("image on its own line preserves indentation and CRLF", async () => {
    const result = await input(`Before\r\n\t  "${imagePath}"  \r\n    After  text\r\n`);
    assert.equal(result.images.length, 1);
    assert.equal(result.text, "Before\r\n\t  [Image #1]  \r\n    After  text\r\n");
  });
  await check("literal markers elsewhere do not trigger whitespace cleanup", async () => {
    const result = await input(`Literal   [Image #9]   stays.\nReview "${imagePath}" here.`);
    assert.equal(result.text, "Literal   [Image #9]   stays.\nReview [Image #1] here.");
  });
  await check("bare image keeps its marker and inspection instruction", async () => {
    const result = await input(`  "${imagePath}"  `);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1);
    assert.equal(result.text, "[Image #1] Inspect the attached image.");
  });
  await check("markers-only multiline drop preserves inner line layout", async () => {
    const result = await input(`"${imagePath}"\n  "${imagePath}"`);
    assert.equal(result.images.length, 2);
    assert.equal(result.text, "[Image #1]\n  [Image #2] Inspect the attached image.");
  });
  await check("repeated image paths retain ordered markers", async () => {
    const result = await input(`Compare "${imagePath}" with "${imagePath}"`);
    assert.equal(result.images.length, 2);
    assert.equal(result.text, "Compare [Image #1] with [Image #2]");
  });
  await check("overflow retains six attachments, surplus markers and warning", async () => {
    const result = await input(`Compare ${Array.from({ length: 8 }, () => `"${imagePath}"`).join(" ")}`);
    assert.equal(result.images.length, 6);
    assert.equal(result.text, "Compare [Image #1] [Image #2] [Image #3] [Image #4] [Image #5] [Image #6] [Image not attached] [Image not attached]");
    assert.ok(notifications.some(({ message, level }) =>
      level === "warning" && message === "Only the first 6 images were attached — 2 more were left out."));
  });
  await check("secret redaction still transforms without image paths", async () => {
    const value = `vinci_live_${"a".repeat(32)}`;
    const text = `Use API_KEY=${value} for the request`;
    const result = await input(text);
    assert.equal(result.action, "transform");
    assert.deepEqual(result.images, []);
    const handle = result.text.match(/<vinci-secret-[0-9a-f]{8}>/)?.[0];
    assert.ok(handle && !result.text.includes(value), "typed credentials must become a handle without exposing their value");
    assert.equal(result.text, `Use API_KEY=${handle} for the request`);
    assert.deepEqual(secrets.rehydrateSecrets(result.text), { text, resolved: [handle], unresolved: [] });
  });
  await check("secret redaction preserves surrounding multiline whitespace", async () => {
    const value = `vinci_live_${"a".repeat(32)}`;
    const text = `Before  text\n  API_KEY=${value}\n\n    After  text\n`;
    const result = await input(text);
    assert.equal(result.action, "transform");
    const handle = result.text.match(/<vinci-secret-[0-9a-f]{8}>/)?.[0];
    assert.ok(handle && !result.text.includes(value), "typed credentials must become a handle without exposing their value");
    assert.equal(result.text, `Before  text\n  API_KEY=${handle}\n\n    After  text\n`);
    assert.deepEqual(secrets.rehydrateSecrets(result.text), { text, resolved: [handle], unresolved: [] });
  });
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`input-images: ${passed}/${passed + failed} checks passed (real guard input handler)`);
if (failed > 0) process.exitCode = 1;
