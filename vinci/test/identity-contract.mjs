import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLauncherExtensions } from "./launcher-extensions.mjs";

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
assert.match(launcher, /export VINCI_TOOL_BOOTSTRAP="\$\{VINCI_TOOL_BOOTSTRAP:-0\}"/, "The launcher must default to no executable downloads");
assert.match(launcher, /VINCI_SOURCE_CLI/, "Internal qualification must be able to run the current source tree");
assert.match(toolsManager, /if \(offlineEnabled\) return false/, "Offline policy must override search-tool bootstrap");
assert.match(launcher, new RegExp(`VINCI_PROVIDER="\\$\\{VINCI_PROVIDER:-${identity.provider}\\}"`), "The default provider changed");
assert.match(launcher, /--provider "\$\{VINCI_PROVIDER\}"/, "The launcher must pass its explicit provider selection");
assert.match(launcher, new RegExp(`VINCI_MODEL="\\$\\{VINCI_MODEL:-${identity.defaultModel}\\}"`), "The default model changed");
assert.match(launcher, /--model "\$\{VINCI_MODEL\}"/, "The launcher must pass its explicit Vinci model selection");
assert.match(launcher, /if \[ "\$\{1:-\}" = "resume" \]/, "The Vinci task resume command is missing");
assert.match(launcher, /set -- --session "\$\{_vinci_resume_id\}"/, "Task resume must use Pi's durable session loader");
assert.match(provider, new RegExp(`registerProvider\\("${identity.provider}"`), "The Vinci provider registration is missing");
// Classes are registered by mapping VINCI_MODEL_NAMES through vinciClassModel(id, name).
// Check the catalogue entry and registration form together to keep the id and display name aligned.
const modelNames = read("vinci/extensions/lib/model-catalogue.ts").match(/\bVINCI_MODEL_NAMES\b[^=]*=\s*\{([^}]*)\}/)?.[1];
assert.ok(
  modelNames?.split("\n").some((entry) => entry.trim() === `${identity.defaultModel}: "${identity.defaultModelName}",`),
  "The default Vinci model is not registered",
);
assert.ok(
  provider.includes("Object.entries(VINCI_MODEL_NAMES).map(([id, name]) => vinciClassModel(id, name))"),
  "The Vinci provider must register its classes from VINCI_MODEL_NAMES",
);
assert.ok(launcher.toLowerCase().includes(identity.tagline.toLowerCase()), "The Vinci tagline is missing from the launcher sign-off");
assert.ok(header.includes("Choose a model: /model"), "An unset session model must not imply a configured provider route");
assert.match(header, /import \{[^}]*VINCI_VERSION[^}]*\} from "\.\/lib\/product-identity\.ts"/, "The header must read Vinci's authoritative product identity");
const productIdentity = read("vinci/extensions/lib/product-identity.ts");
assert.match(productIdentity, /readFileSync\(new URL\("identity\.json", VINCI_ROOT\)/, "The header identity must be loaded from vinci/identity.json");
assert.doesNotMatch(header, /VINCI_VERSION\s*=\s*["']\d+\.\d+\.\d+["']/, "The header must not duplicate a product version constant");
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

const launcherExtensions = parseLauncherExtensions(launcher);
assert.deepEqual(launcherExtensions, identity.extensions, "The launcher extension set drifted from vinci/identity.json");
for (const extension of identity.extensions) {
  assert.ok(existsSync(join(vinci, "extensions", extension)), `Required Vinci extension is missing: ${extension}`);
}

console.log("  identity contract: Vinci app, signed updater, provider, model, header, themes, and extensions are intact");
