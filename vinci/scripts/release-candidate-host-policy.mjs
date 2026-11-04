// Shared, dependency-neutral policy checks. No transport, release state or credentials.
import assert from "node:assert/strict";
import { isIP } from "node:net";

export function validateArtifactDownloadHostExclusions(host) {
  assert.ok(host.length <= 253);
  assert.ok(!host.endsWith(".localhost") && !host.endsWith(".local") && host !== "api.github.com");
}
export function validateArtifactDownloadHost(host) {
  assert.equal(typeof host, "string");
  assert.match(host, /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
  assert.equal(isIP(host), 0);
  validateArtifactDownloadHostExclusions(host);
}
export function compileArtifactDownloadHostPattern(pattern) {
  assert.equal(typeof pattern, "string");
  const parts = pattern.split("{digits}");
  assert.equal(parts.length, 2, "Exactly one {digits} placeholder required");
  const [before, after] = parts, literal = before + after;
  assert.ok(before.length > 0, "Literal prefix required before {digits}");
  assert.ok(!/[^a-z0-9.-]/.test(literal), "Only lowercase hostname literals and {digits} are allowed");
  assert.ok(!/[.-]$/.test(literal), "Host pattern must not end in a dot or hyphen");
  assert.ok((after.match(/\./g) ?? []).length >= 2, "Full domain required after {digits}");
  const escaped = parts.map((part) => [...part].map((char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
  return new RegExp(`^${escaped[0]}[0-9]{1,3}${escaped[1]}$`);
}
export function validateArtifactDownloadHosts(policy) {
  for (const name of ["artifactDownloadHosts", "artifactDownloadHostPatterns"]) {
    if (Object.hasOwn(policy, name)) assert.ok(Array.isArray(policy[name]), `Invalid ${name}`);
  }
  const hosts = policy.artifactDownloadHosts ?? [], patterns = policy.artifactDownloadHostPatterns ?? [];
  assert.ok(hosts.length + patterns.length >= 1 && hosts.length + patterns.length <= 8, "Ops-reviewed artifact redirect hosts required");
  assert.equal(new Set(hosts).size, hosts.length, "Duplicate artifact redirect host");
  assert.equal(new Set(patterns).size, patterns.length, "Duplicate artifact redirect template");
  for (const host of hosts) validateArtifactDownloadHost(host);
  return patterns.map((pattern) => {
    const compiled = compileArtifactDownloadHostPattern(pattern), [before, after] = pattern.split("{digits}");
    for (let width = 1; width <= 3; width++) {
      for (let value = 0; value < 10 ** width; value++) {
        validateArtifactDownloadHost(before + String(value).padStart(width, "0") + after);
      }
    }
    return compiled;
  });
}
