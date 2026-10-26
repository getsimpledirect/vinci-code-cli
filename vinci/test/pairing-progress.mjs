// Fully mocked device pairing: no sockets, real credentials, or wall-clock waits.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provider = await loader.import(fileURLToPath(new URL("../extensions/vinci-provider.ts", import.meta.url)), {
  default: false,
});
let login;
provider.default({
  registerProvider(name, config) {
    if (name === "vinci") login = config.oauth.login;
  },
  on() {},
});
assert.equal(typeof login, "function");

const originalFetch = globalThis.fetch;
const originalTimeout = globalThis.setTimeout;
const originalNow = Date.now;
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    let now = 0;
    const waits = [];
    const progress = [];
    const events = [];
    const responses = ["authorization_pending", "authorization_pending", "slow_down", "authorization_pending", "success"];
    Date.now = () => now;
    globalThis.setTimeout = (callback, ms) => {
      waits.push(ms);
      now += ms;
      queueMicrotask(callback);
      return 0;
    };
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, "POST");
      if (new URL(url).pathname === "/api/device/code") {
        events.push("start");
        return new Response(JSON.stringify({
          device_code: "[filtered]",
          user_code: "[filtered]",
          verification_uri: "https://example.invalid/device",
          interval: 1,
          expires_in: 60,
        }));
      }
      assert.equal(new URL(url).pathname, "/api/device/token");
      assert.deepEqual(JSON.parse(options.body), { device_code: "[filtered]" });
      const status = responses.shift();
      assert.ok(status, "unexpected extra poll");
      events.push(status);
      return status === "success"
        ? new Response(JSON.stringify({ access_token: "[filtered]" }))
        : new Response(JSON.stringify({ error: status }), { status: 400 });
    };
    const credentials = await login({
      onDeviceCode() { events.push("prompt"); },
      onProgress(message) { progress.push(message); },
    });
    assert.equal(credentials.access, "[filtered]");
    assert.deepEqual(events, ["start", "prompt", "authorization_pending", "authorization_pending", "slow_down", "authorization_pending", "success"]);
    assert.deepEqual(waits, [1000, 1000, 1000, 6000, 6000], "slow_down must retain its polling delay");
    assert.deepEqual(progress, ["Waiting for you to authorize in the browser…"], "one waiting line per login");
  }
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalTimeout;
  Date.now = originalNow;
}
console.log("pairing-progress: one waiting line per login; polling and slow_down preserved");
