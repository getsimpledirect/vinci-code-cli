import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vinci = join(root, "vinci");
const read = (path) => readFileSync(join(root, path), "utf8");
const identity = JSON.parse(read("vinci/identity.json"));
const launcher = read("vinci/bin/vinci");
const header = read("vinci/extensions/vinci-header.ts");
const provider = read("vinci/extensions/vinci-provider.ts");
const updater = read("vinci/updater/update.mjs");
const updaterShim = read("vinci/updater/vinci");
const installer = read("vinci/install.sh");
const toolsManager = read("packages/coding-agent/src/utils/tools-manager.ts");
const packageJson = JSON.parse(read("packages/coding-agent/package.json"));

assert.equal(identity.productName, "Vinci Code");
assert.match(identity.version, /^\d+\.\d+\.\d+$/, "The Vinci product version must be X.Y.Z");
assert.equal(packageJson.piConfig?.name, identity.command, "The packaged CLI must retain the Vinci app name");
assert.match(
  launcher,
  new RegExp(`export ${identity.environmentFlag}=1`),
  "The launcher must enable the Vinci compatibility layer",
);
assert.match(launcher, /export VINCI_TOOL_BOOTSTRAP=/, "The launcher must provision Vinci's required search tools");
assert.match(launcher, /VINCI_SOURCE_CLI/, "Internal qualification must be able to run the current source tree");
assert.match(toolsManager, /VINCI_TOOL_BOOTSTRAP/, "Offline Vinci startup no longer has a search-tool bootstrap exception");
assert.match(launcher, new RegExp(`VINCI_PROVIDER="\\$\\{VINCI_PROVIDER:-${identity.provider}\\}"`), "The default provider changed");
assert.match(launcher, /--provider "\$\{VINCI_PROVIDER\}"/, "The launcher must pass its explicit provider selection");
assert.match(launcher, new RegExp(`VINCI_MODEL="\\$\\{VINCI_MODEL:-${identity.defaultModel}\\}"`), "The default model changed");
assert.match(launcher, /--model "\$\{VINCI_MODEL\}"/, "The launcher must pass its explicit Vinci model selection");
assert.match(launcher, /if \[ "\$\{1:-\}" = "resume" \]/, "The Vinci task resume command is missing");
assert.match(launcher, /set -- --session "\$\{_vinci_resume_id\}"/, "Task resume must use Pi's durable session loader");
assert.match(provider, new RegExp(`registerProvider\\("${identity.provider}"`), "The Vinci provider registration is missing");
// Classes are registered through the vinciClassModel(id, name) helper rather than inline object
// literals, so the contract matches the call form. Asserting both arguments together also keeps the
// id and its display name from drifting apart, which two separate substring checks did not.
assert.ok(
  provider.includes(`vinciClassModel("${identity.defaultModel}", "${identity.defaultModelName}")`),
  "The default Vinci model is not registered",
);
assert.ok(header.includes(identity.tagline), "The Vinci tagline is missing from the header");
assert.ok(header.includes(identity.defaultModelName), "The header fallback model no longer matches the identity contract");
assert.ok(header.includes(`VINCI_VERSION = "${identity.version}"`), "The header version drifted from the identity contract");
assert.match(updater, /verifySignature/, "The commercial updater must verify signed release manifests");
assert.match(updater, /update\.lock/, "The commercial updater must serialize concurrent updates");
assert.match(updaterShim, /before-launch/, "The stable launcher must update before starting a task");
assert.match(updaterShim, /identity\.version/, "The installed launcher must report Vinci's product version");
assert.match(installer, /install-extracted/, "The installer must use versioned atomic activation");
assert.ok(existsSync(join(vinci, "updater", "public-key.pem")), "The update trust root is missing");

const launcherThemes = Array.from(launcher.matchAll(/--theme "\$\{VINCI\}\/themes\/([^"]+)"/g), (match) => match[1]);
assert.deepEqual(launcherThemes, identity.themes, "The launcher theme set drifted from vinci/identity.json");
for (const theme of identity.themes) {
  assert.ok(existsSync(join(vinci, "themes", theme)), `Required Vinci theme is missing: ${theme}`);
}

const launcherExtensions = Array.from(
  launcher.matchAll(/--extension "\$\{VINCI\}\/extensions\/([^"]+)"/g),
  (match) => match[1],
);
assert.deepEqual(launcherExtensions, identity.extensions, "The launcher extension set drifted from vinci/identity.json");
for (const extension of identity.extensions) {
  assert.ok(existsSync(join(vinci, "extensions", extension)), `Required Vinci extension is missing: ${extension}`);
}

console.log("  identity contract: Vinci app, signed updater, provider, model, header, themes, and extensions are intact");
