import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const tools = await loader.import(resolve(here, "../../packages/coding-agent/src/utils/tools-manager.ts"), {
	default: false,
});

assert.equal(tools.shouldBootstrapTools({}), true);
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "1" }), false);
assert.equal(tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1" }), false);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "1" }),
	true,
);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "true", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "true" }),
	true,
);
assert.equal(
	tools.shouldBootstrapTools({ PI_OFFLINE: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "0" }),
	false,
);

process.stdout.write("  tool bootstrap: Vinci can provision fd/rg without enabling update or telemetry traffic\n");
