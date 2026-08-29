/* Re-derives native-admission.json's source_digests from the files on disk.
 *
 * Run after any change under native/:  node test/derive-native-manifest.mjs
 *
 * This rewrites ONLY source_digests, which pin source identity. It never
 * touches `admitted` or the binary/build/test receipt fields, which are what
 * actually refuse launch — those are granted by review and real-host evidence,
 * never by a script. Hand-editing a digest is how a manifest silently stops
 * describing the tree it claims to describe. */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const manifestUrl = new URL("../native/native-admission.json", import.meta.url);
const nativeDirectory = new URL("../native/", import.meta.url);

const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const sources = readdirSync(nativeDirectory)
  .filter((name) => name !== "native-admission.json")
  .sort();

if (sources.length === 0) throw new Error("native/ contains no sources to pin");

const digests = {};
for (const name of sources) {
  digests[name] = createHash("sha256").update(readFileSync(new URL(name, nativeDirectory))).digest("hex");
}

const changed = JSON.stringify(manifest.source_digests) !== JSON.stringify(digests);
manifest.source_digests = digests;
writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${changed ? "updated" : "unchanged"}: ${sources.length} native sources pinned`);
console.log(`admitted=${manifest.admitted} binary_sha256=${manifest.binary_sha256} ` +
  `linux_build_receipt=${manifest.linux_build_receipt} linux_test_receipt=${manifest.linux_test_receipt}`);
