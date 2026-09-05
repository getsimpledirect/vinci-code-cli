// web_fetch SSRF guard regression tests. The IPv4-mapped IPv6 and NAT64 forms embed an IPv4 in
// the last 32 bits; WHATWG new URL() normalizes the dotted spelling to hex (::ffff:7f00:1), so
// isPrivateIp must decode and classify the embedded address in BOTH spellings.
import { test } from "node:test";
import assert from "node:assert/strict";
import registerVinciSearch, {
  fetchPublicPage,
  isPrivateIp,
  preflightUrl,
  WEB_FETCH_MAX_REDIRECTS,
} from "./vinci-search.ts";

const publicAddress = "93.184.216.34";
const signal = new AbortController().signal;

function response(status, location, body = "public page") {
  const values = new Map([
    ["content-type", "text/plain"],
    ...(location === undefined ? [] : [["location", location]]),
  ]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => values.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

function dependencies(responses, addresses = new Map()) {
  const requests = [];
  const resolutions = [];
  return {
    requests,
    resolutions,
    value: {
      fetch: async (url, init) => {
        requests.push({ url: url.href, redirect: init?.redirect });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        assert.ok(next, `unexpected fetch of ${url.href}`);
        return next;
      },
      lookup: async (hostname) => {
        resolutions.push(hostname);
        const next = addresses.get(hostname);
        if (next instanceof Error) throw next;
        return addresses.has(hostname) ? next : [{ address: publicAddress }];
      },
    },
  };
}

function registeredWebFetch() {
  const tools = [];
  registerVinciSearch({ registerTool: (tool) => tools.push(tool) });
  const webFetch = tools.find((tool) => tool.name === "web_fetch");
  assert.ok(webFetch, "production extension must register web_fetch");
  return webFetch;
}

function resultText(result) {
  return result.content.map((part) => part.text ?? "").join("\n");
}

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

test("web_fetch production registration refuses a private redirect before a second request", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: url.href, redirect: init?.redirect });
    return response(302, "http://127.0.0.1/private");
  };
  try {
    const result = await registeredWebFetch().execute("call", { url: `https://${publicAddress}/start` }, signal);
    assert.match(resultText(result), /internal server/);
    assert.deepEqual(requests, [{ url: `https://${publicAddress}/start`, redirect: "manual" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public relative and absolute redirects are fetched after URL and DNS validation at every hop", async () => {
  const deps = dependencies([
    response(302, "/relative"),
    response(307, "https://final.example/page"),
    response(200, undefined, "arrived"),
  ]);
  const result = await fetchPublicPage("https://start.example/root", signal, deps.value);
  assert.equal(result.ok, true);
  assert.equal(result.url.href, "https://final.example/page");
  assert.deepEqual(deps.resolutions, ["start.example", "start.example", "final.example"]);
  assert.deepEqual(deps.requests, [
    { url: "https://start.example/root", redirect: "manual" },
    { url: "https://start.example/relative", redirect: "manual" },
    { url: "https://final.example/page", redirect: "manual" },
  ]);
});

test("a later-hop hostname resolving private is refused before that hop is fetched", async () => {
  const addresses = new Map([
    ["start.example", [{ address: publicAddress }]],
    ["private.example", [{ address: "10.0.0.8" }]],
  ]);
  const deps = dependencies([response(302, "https://private.example/secret")], addresses);
  const result = await fetchPublicPage("https://start.example/", signal, deps.value);
  assert.equal(result.ok, false);
  assert.match(result.reason, /resolves to an internal server/);
  assert.deepEqual(deps.resolutions, ["start.example", "private.example"]);
  assert.deepEqual(deps.requests, [{ url: "https://start.example/", redirect: "manual" }]);
});

test("a later-hop mixed public/private DNS answer is refused before that hop is fetched", async () => {
  const addresses = new Map([
    ["start.example", [{ address: publicAddress }]],
    ["mixed.example", [{ address: publicAddress }, { address: "10.0.0.8" }]],
  ]);
  const deps = dependencies([response(302, "https://mixed.example/secret")], addresses);
  const result = await fetchPublicPage("https://start.example/", signal, deps.value);
  assert.equal(result.ok, false);
  assert.match(result.reason, /resolves to an internal server/);
  assert.deepEqual(deps.resolutions, ["start.example", "mixed.example"]);
  assert.deepEqual(deps.requests, [{ url: "https://start.example/", redirect: "manual" }]);
});

test("missing, empty, and wrong-shaped DNS evidence is refused before fetch", async (t) => {
  const invalidAnswers = [
    ["missing", undefined, /Couldn't resolve/],
    ["null", null, /Couldn't resolve/],
    ["empty array", [], /Couldn't resolve/],
    ["object instead of array", { address: publicAddress }, /Couldn't resolve/],
    ["string instead of array", publicAddress, /Couldn't resolve/],
    ["null row", [null], /Couldn't resolve/],
    ["array row", [[{ address: publicAddress }]], /Couldn't resolve/],
    ["missing address", [{}], /Couldn't resolve/],
    ["null address", [{ address: null }], /Couldn't resolve/],
    ["empty address", [{ address: "" }], /Couldn't resolve/],
    ["wrong-type address", [{ address: 7 }], /Couldn't resolve/],
    ["malformed IPv4 address", [{ address: "999.1.1.1" }], /invalid DNS address/],
    ["malformed IPv6 address", [{ address: "2001:::1" }], /invalid DNS address/],
  ];
  for (const [name, answer, expected] of invalidAnswers) {
    await t.test(name, async () => {
      const deps = dependencies([], new Map([["invalid-dns.example", answer]]));
      const result = await fetchPublicPage("https://invalid-dns.example/", signal, deps.value);
      assert.equal(result.ok, false);
      assert.match(result.reason, expected);
      assert.deepEqual(deps.resolutions, ["invalid-dns.example"]);
      assert.equal(deps.requests.length, 0, "invalid resolver evidence must be rejected before fetch");
    });
  }
});

test("a nonempty all-public DNS answer is accepted", async () => {
  const addresses = new Map([
    [
      "public.example",
      [
        { address: publicAddress },
        { address: "2606:2800:220:1:248:1893:25c8:1946" },
        { address: "::ffff:5db8:d822" },
        { address: "64:ff9b::5db8:d822" },
      ],
    ],
  ]);
  const deps = dependencies([response(200)], addresses);
  const result = await fetchPublicPage("https://public.example/", signal, deps.value);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.resolutions, ["public.example"]);
  assert.deepEqual(deps.requests, [{ url: "https://public.example/", redirect: "manual" }]);
});

test("all redirect Location status and shape failures are typed and mechanism-reaching", async (t) => {
  const badLocations = [
    ["missing", undefined, /without a valid Location/],
    ["null", null, /without a valid Location/],
    ["empty", "   ", /without a valid Location/],
    ["wrong type", 42, /without a valid Location/],
    ["malformed", "http://[", /malformed Location/],
    ["unsupported protocol", "file:///etc/passwd", /Only http\(s\)/],
  ];
  for (const [name, location, expected] of badLocations) {
    await t.test(name, async () => {
      const deps = dependencies([response(302, location)]);
      const result = await fetchPublicPage("https://start.example/", signal, deps.value);
      assert.equal(result.ok, false);
      assert.match(result.reason, expected);
      assert.equal(deps.requests.length, 1, "the redirect target must not be requested");
    });
  }
});

test("only defined redirect statuses consume Location", async () => {
  for (const status of [200, 201, 300, 304, 305, 306]) {
    const deps = dependencies([response(status, "http://127.0.0.1/private")]);
    const result = await fetchPublicPage("https://start.example/", signal, deps.value);
    assert.equal(result.ok, true, `HTTP ${status} is not a followed redirect`);
    assert.equal(result.response.status, status);
    assert.equal(deps.requests.length, 1);
  }
  for (const status of [301, 302, 303, 307, 308]) {
    const deps = dependencies([response(status, "http://127.0.0.1/private")]);
    const result = await fetchPublicPage("https://start.example/", signal, deps.value);
    assert.equal(result.ok, false, `HTTP ${status} must enter redirect validation`);
    assert.match(result.reason, /internal server/);
    assert.equal(deps.requests.length, 1);
  }
});

test("redirect loops and redirects beyond the explicit cap are refused", async () => {
  const loopDeps = dependencies([response(302, "/b"), response(302, "/")]);
  const loop = await fetchPublicPage("https://loop.example/", signal, loopDeps.value);
  assert.equal(loop.ok, false);
  assert.match(loop.reason, /redirect loop/);
  assert.equal(loopDeps.requests.length, 2);

  const excessResponses = Array.from({ length: WEB_FETCH_MAX_REDIRECTS + 1 }, (_, index) => response(302, `/hop-${index + 1}`));
  const excessDeps = dependencies(excessResponses);
  const excess = await fetchPublicPage("https://many.example/", signal, excessDeps.value);
  assert.equal(excess.ok, false);
  assert.match(excess.reason, new RegExp(`more than ${WEB_FETCH_MAX_REDIRECTS} times`));
  assert.equal(excessDeps.requests.length, WEB_FETCH_MAX_REDIRECTS + 1);
});

test("a non-initial start-to-a-to-b-to-a redirect cycle is refused", async () => {
  const deps = dependencies([
    response(302, "https://a.example/one"),
    response(302, "https://b.example/two"),
    response(302, "https://a.example/one"),
  ]);
  const result = await fetchPublicPage("https://start.example/", signal, deps.value);
  assert.equal(result.ok, false);
  assert.match(result.reason, /redirect loop/);
  assert.deepEqual(deps.resolutions, ["start.example", "a.example", "b.example"]);
  assert.deepEqual(deps.requests, [
    { url: "https://start.example/", redirect: "manual" },
    { url: "https://a.example/one", redirect: "manual" },
    { url: "https://b.example/two", redirect: "manual" },
  ]);
});

test("the redirect cap still permits a public final response at its boundary", async () => {
  const responses = Array.from({ length: WEB_FETCH_MAX_REDIRECTS }, (_, index) => response(302, `/hop-${index + 1}`));
  responses.push(response(200));
  const deps = dependencies(responses);
  const result = await fetchPublicPage("https://bounded.example/", signal, deps.value);
  assert.equal(result.ok, true);
  assert.equal(deps.requests.length, WEB_FETCH_MAX_REDIRECTS + 1);
});

test("DNS and fetch failures return stable tool errors", async () => {
  const dnsDeps = dependencies([], new Map([["dns-fails.example", new Error("offline")]]));
  const dns = await fetchPublicPage("https://dns-fails.example/", signal, dnsDeps.value);
  assert.equal(dns.ok, false);
  assert.equal(dns.reason, "Couldn't resolve that web address.");
  assert.equal(dnsDeps.requests.length, 0);

  const fetchDeps = dependencies([new Error("offline")]);
  const unreachable = await fetchPublicPage("https://fetch-fails.example/", signal, fetchDeps.value);
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.reason, "Couldn't reach that page right now.");

  const timeout = new Error("slow");
  timeout.name = "TimeoutError";
  const timeoutDeps = dependencies([timeout]);
  const timedOut = await fetchPublicPage("https://timeout.example/", signal, timeoutDeps.value);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "That page took too long to load.");
});

test("web_fetch handles missing, null, empty, malformed, and wrong-type input without reaching fetch", async () => {
  const webFetch = registeredWebFetch();
  for (const params of [{}, { url: null }, { url: "" }, { url: "not a URL" }, { url: 7 }, { url: [] }]) {
    const result = await webFetch.execute("call", params, signal);
    assert.match(resultText(result), /valid web address/);
  }
});
