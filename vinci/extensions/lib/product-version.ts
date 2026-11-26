/** Source and packaged extensions read the same Vinci product identity. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const extensionRoot = new URL("../../", import.meta.url);
export const VINCI_ROOT = extensionRoot.pathname.endsWith("/dist/") ? new URL("../", extensionRoot) : extensionRoot;
let version: string | undefined;

export function getVinciVersion(): string {
  if (version) return version;
  const path = new URL("identity.json", VINCI_ROOT);
  const identity = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof identity.version !== "string" || !/^\d+\.\d+\.\d+$/.test(identity.version)) {
    throw new Error(`Invalid Vinci version in "${fileURLToPath(path)}". Restore the product identity before launching.`);
  }
  version = identity.version;
  return version;
}
