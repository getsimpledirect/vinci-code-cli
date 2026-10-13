/** Source and packaged extensions read the same Vinci product identity. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VINCI_ROOT = new URL(import.meta.url.endsWith(".js") ? "../../../" : "../../", import.meta.url);
const identity = JSON.parse(readFileSync(new URL("identity.json", VINCI_ROOT), "utf8")) as { version?: unknown };
if (typeof identity.version !== "string" || !/^\d+\.\d+\.\d+$/.test(identity.version)) {
  throw new Error(`Invalid Vinci version in "${fileURLToPath(new URL("identity.json", VINCI_ROOT))}". Restore the product identity before launching.`);
}
export const VINCI_VERSION = identity.version;
