// Integration check: the REAL vinci-guard graduated-trust store — "always allow this exact command in
// this project" persists so we stop re-asking, but ONLY that exact command and ONLY that project.
import assert from "node:assert";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Point the store at a throwaway file BEFORE importing (the module reads VINCI_TRUST_FILE per call).
const store = join(tmpdir(), `vinci-trust-it-${process.pid}.json`);
process.env.VINCI_TRUST_FILE = store;
const { isTrusted, addTrust, clearTrust } = await import(resolve(here, "../extensions/vinci-guard.ts"));

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log(`  ✓ ${name}`); pass++; };

const projA = "/Users/x/projA";
const projB = "/Users/x/projB";
try {
  check("nothing trusted initially", !isTrusted(projA, "npm publish"));

  addTrust(projA, "npm publish");
  check("after 'always allow', the exact command is trusted", isTrusted(projA, "npm publish"));
  check("whitespace is normalized (trim)", isTrusted(projA, "  npm publish  "));

  // Exact-match only — a variation must still confirm (safety: broad patterns would be dangerous).
  check("a VARIATION is NOT trusted (still confirms)", !isTrusted(projA, "npm publish --tag beta"));
  check("a different command is NOT trusted", !isTrusted(projA, "rm -rf build"));

  // Per-project isolation — trusting in A doesn't leak to B.
  check("trust does NOT leak to another project", !isTrusted(projB, "npm publish"));
  addTrust(projB, "vercel deploy");
  check("project B has its own trust", isTrusted(projB, "vercel deploy"));
  check("project A still doesn't have B's command", !isTrusted(projA, "vercel deploy"));

  // Idempotent add.
  addTrust(projA, "npm publish");
  check("adding the same command twice is fine (still trusted)", isTrusted(projA, "npm publish"));

  // Clear one project only.
  clearTrust(projA);
  check("clearing project A removes its trust", !isTrusted(projA, "npm publish"));
  check("clearing project A leaves project B intact", isTrusted(projB, "vercel deploy"));
} finally {
  rmSync(store, { force: true });
}

console.log(`\ntrust-integration: ${pass}/${pass} checks passed (real graduated-trust store)`);
