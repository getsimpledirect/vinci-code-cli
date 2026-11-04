// Serialize sanitized QA results once; the digest and workflow input bind those exact bytes.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { digest } from "./release-candidate.mjs";

export function makeQaReceipt(fields) {
  for (const name of ["candidateReceiptSha256", "manifestSha256", "archiveSha256"]) assert.match(fields[name], /^[a-f0-9]{64}$/, `Invalid ${name}`);
  assert.match(fields.source, /^[a-f0-9]{40}$/, "Invalid source commit");
  assert.match(fields.artifactId, /^[1-9][0-9]{0,17}$/, "Invalid artifact ID");
  assert.equal(typeof fields.completedAt, "string");
  assert.ok(Number.isFinite(Date.parse(fields.completedAt)), "Invalid completedAt timestamp");
  for (const name of ["cleanInstall", "upgrade", "rollback"]) assert.ok(["PASS", "FAIL"].includes(fields.results?.[name]), `Invalid ${name} result`);
  const receipt = { schemaVersion: 1, owner: "thegeorgepu", completedAt: fields.completedAt,
    candidateReceiptSha256: fields.candidateReceiptSha256, manifestSha256: fields.manifestSha256,
    archiveSha256: fields.archiveSha256, source: fields.source, artifactId: fields.artifactId,
    results: { cleanInstall: fields.results.cleanInstall, upgrade: fields.results.upgrade, rollback: fields.results.rollback }, noModelCalls: true };
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}
function main() {
  const names = ["candidate-receipt-sha256", "manifest-sha256", "archive-sha256", "source", "artifact-id", "completed-at", "clean-install", "upgrade", "rollback", "output"];
  const { values } = parseArgs({ options: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  for (const name of names) assert.ok(typeof values[name] === "string" && values[name].length > 0, `Missing --${name}`);
  const bytes = makeQaReceipt({ candidateReceiptSha256: values["candidate-receipt-sha256"], manifestSha256: values["manifest-sha256"], archiveSha256: values["archive-sha256"],
    source: values.source, artifactId: values["artifact-id"], completedAt: values["completed-at"],
    results: { cleanInstall: values["clean-install"], upgrade: values.upgrade, rollback: values.rollback } });
  writeFileSync(values.output, bytes, { flag: "wx", mode: 0o600 });
  console.log(`sha256=${digest(bytes)}`);
  console.log(`base64=${bytes.toString("base64")}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`QA receipt refused: "${error.message}". Correct the fields and use a new output path.`); process.exitCode = 1; }
}
