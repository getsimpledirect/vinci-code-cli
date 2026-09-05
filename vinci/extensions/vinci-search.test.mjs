// web_fetch SSRF guard regression tests. The IPv4-mapped IPv6 and NAT64 forms embed an IPv4 in
// the last 32 bits; WHATWG new URL() normalizes the dotted spelling to hex (::ffff:7f00:1), so
// isPrivateIp must decode and classify the embedded address in BOTH spellings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, preflightUrl } from "./vinci-search.ts";

// Negative: every private / loopback / link-local / NAT64 form must be classified PRIVATE.
const PRIVATE = [
  "127.0.0.1",
  "[::1]",
  "::1",
  "[::]",
  "[::ffff:7f00:1]", // IPv4-mapped, hex spelling (what new URL(href).hostname yields) -> 127.0.0.1
  "::ffff:7f00:1", // same, without brackets (what dns.lookup can return)
  "[::ffff:127.0.0.1]", // IPv4-mapped, dotted spelling
  "::ffff:127.0.0.1",
  "[::ffff:0:0]", // IPv4-mapped 0.0.0.0
  "[64:ff9b::7f00:1]", // NAT64 -> 127.0.0.1
  "64:ff9b::7f00:1",
  "[64:ff9b::127.0.0.1]",
  "64:ff9b::808", // one-group tail -> 0.0.8.8 (the omitted high group is zero)
  "64:ff9b::8088", // -> 0.0.128.136
  "64:ff9b::ffff", // -> 0.0.255.255
  "64:ff9b::100", // -> 0.0.1.0
  "[64:FF9B::808]", // bracketed, uppercase alternate spelling
  "::ffff", // mapped-prefix boundary with no 32-bit tail
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254", // cloud metadata
  "100.64.0.1", // CGNAT
  "100.127.255.255",
  "fe80::1",
  "fc00::1",
  "fd00::1",
  "0.0.0.0",
];

for (const ip of PRIVATE) {
  test(`isPrivateIp(${ip}) === true`, () => {
    assert.equal(isPrivateIp(ip), true, `${ip} must be classified private`);
  });
}

// Once a mapped/NAT64 prefix is recognized, a malformed embedded tail must not become an ordinary
// public IPv6 literal. These drive the parser directly because WHATWG rejects several before the
// SSRF predicate sees them.
const MALFORMED_EMBEDDED = [
  "64:ff9b::",
  "64:ff9b::gggg",
  "64:ff9b::10000",
  "64:ff9b::1:2:3",
  "64:ff9b::256.0.0.1",
  "64:ff9b::999.0.0.1",
  "::ffff:",
  "::ffff:gggg",
  "::ffff:10000",
  "::ffff:1:2:3",
  "::ffff:256.0.0.1",
  "::ffff:999.0.0.1",
];

for (const ip of MALFORMED_EMBEDDED) {
  test(`isPrivateIp(${ip}) fails closed`, () => {
    assert.equal(isPrivateIp(ip), true, `${ip} must fail closed`);
  });
}

// Positive control: genuinely public addresses must still be classified PUBLIC (without this,
// "return true always" would pass every negative test).
const PUBLIC = [
  "93.184.216.34",
  "[2606:2800:220:1:248:1893:25c8:1946]",
  "8.8.8.8",
  "172.32.0.1", // outside 172.16/12
  "100.128.0.1", // outside 100.64/10
  "[::ffff:5db8:d822]", // IPv4-mapped 93.184.216.34
  "::ffff:93.184.216.34", // IPv4-mapped, dotted spelling
  "[64:ff9b::5db8:d822]", // NAT64 to 93.184.216.34
  "2001:4860:4860::8888",
  "::ffff:ffff", // one tail group: ordinary IPv6, not an IPv4-mapped address
];

for (const ip of PUBLIC) {
  test(`isPrivateIp(${ip}) === false`, () => {
    assert.equal(isPrivateIp(ip), false, `${ip} must be classified public`);
  });
}

// End-to-end: preflightUrl must refuse the URL forms that exercise the hex normalization, and the
// decimal/octal/hex shorthand forms, while still allowing genuinely public hosts.
test("preflightUrl refuses IPv4-mapped and NAT64 hosts", () => {
  assert.equal(preflightUrl("http://[::ffff:127.0.0.1]/").ok, false); // URL normalizes to [::ffff:7f00:1]
  assert.equal(preflightUrl("http://[::ffff:7f00:1]/").ok, false);
  assert.equal(preflightUrl("http://[64:ff9b::7f00:1]/").ok, false);
  assert.equal(preflightUrl("http://[64:ff9b::808]/").ok, false);
  assert.equal(preflightUrl("http://[64:ff9b::8088]/").ok, false);
  assert.equal(preflightUrl("http://[64:ff9b::ffff]/").ok, false);
  assert.equal(preflightUrl("http://[64:ff9b::100]/").ok, false);
  assert.equal(preflightUrl("http://[::ffff]/").ok, false);
});

test("preflightUrl refuses decimal/octal/hex and shorthand loopback hosts", () => {
  assert.equal(preflightUrl("http://127.1/").ok, false); // -> 127.0.0.1
  assert.equal(preflightUrl("http://2130706433/").ok, false); // -> 127.0.0.1
  assert.equal(preflightUrl("http://0x7f000001/").ok, false); // -> 127.0.0.1
  assert.equal(preflightUrl("http://0177.0.0.1/").ok, false); // -> 127.0.0.1
});

test("preflightUrl still allows public mapped, NAT64, IPv4, and IPv6 hosts", () => {
  assert.equal(preflightUrl("http://93.184.216.34/").ok, true);
  assert.equal(preflightUrl("http://[::ffff:5db8:d822]/").ok, true);
  assert.equal(preflightUrl("http://[64:ff9b::5db8:d822]/").ok, true);
  assert.equal(preflightUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/").ok, true);
  assert.equal(preflightUrl("http://[::ffff:ffff]/").ok, true);
});
