// Synthetic offline regressions for both structured masking paths.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const { vinciMaskJson, vinciMaskSecrets } = await import(resolve(here, "../../packages/coding-agent/src/core/vinci-mask-secrets.ts"));
const loader = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/dist/index.js"),
  },
});
const { redactSecretsDeep } = await loader.import(resolve(here, "../extensions/lib/secrets.ts"), { default: false });

const opaque = "z8Q4n2R7v5L9m3C6"; // fabricated text, never a usable credential
const shaped = "ghp_" + "TESTONLY" + "r".repeat(32);

test("paired control: scalar sensitive properties mask on both paths", () => {
  assert.equal(vinciMaskJson({ password: opaque }).password.includes(opaque), false);
  assert.equal(redactSecretsDeep({ password: opaque }).password, "<vinci-secret>");
});

test("sensitive array elements must retain property context on display", () => {
  assert.equal(JSON.stringify(vinciMaskJson({ password: [opaque] })).includes(opaque), false);
});

test("sensitive array elements must retain property context on model path", () => {
  assert.equal(JSON.stringify(redactSecretsDeep({ password: [[opaque]] })).includes(opaque), false);
});

test("shaped tokens nested in ordinary arrays remain masked without mutating input", () => {
  const input = { results: [[{ note: shaped, count: 3 }]], ok: true };
  const original = structuredClone(input);
  for (const masker of [vinciMaskJson, redactSecretsDeep]) {
    const masked = masker(input);
    assert.equal(JSON.stringify(masked).includes(shaped), false);
    assert.equal(masked.results[0][0].count, 3);
    assert.equal(masked.ok, true);
  }
  assert.deepEqual(input, original);
});

test("escaped malformed argument text masks after JSON decode and re-encode", () => {
  const decoded = JSON.parse(JSON.stringify({ diagnostic: `Unexpected end: {"content":"${shaped}` }));
  const masked = redactSecretsDeep(decoded);
  assert.equal(JSON.stringify(masked).includes(shaped), false);
  assert.equal(masked.diagnostic.includes("<vinci-secret>"), true);
});

test("path-like false positive control and empty arrays preserve shape", () => {
  const input = { allowed_paths: ["synthetic/token-handler.ts", "synthetic/password-guide.md"], findings: [] };
  assert.deepEqual(vinciMaskJson(input), input);
  assert.deepEqual(redactSecretsDeep(input), input);
});

test("documented residual: an unlabelled shapeless value has no detection promise", () => {
  assert.equal(vinciMaskSecrets(opaque), opaque);
  assert.equal(redactSecretsDeep({ ordinary: opaque }).ordinary, opaque);
});

test("existing sentinels and synthetic handles survive repeated structured masking", () => {
  const input = { password: "<vinci-secret-deadbeef>", results: ["<vinci-secret>"] };
  for (const masker of [vinciMaskJson, redactSecretsDeep]) {
    assert.deepEqual(masker(masker(input)), input);
  }
});

for (const [path, masker] of [["display", vinciMaskJson], ["model", redactSecretsDeep]]) {
  test(`sensitive array objects inherit property context on ${path}`, () => {
    assert.equal(JSON.stringify(masker({ password: [{ value: opaque }] })).includes(opaque), false);
  });

  test(`sensitive objects inherit property context on ${path}`, () => {
    assert.equal(JSON.stringify(masker({ credential: { value: opaque } })).includes(opaque), false);
  });

  test(`sensitive arrays below ordinary arrays and objects mask on ${path}`, () => {
    // Converter-shaped provider body (reachability packet N05): the sensitive key sits under ordinary keys.
    const input = { messages: [{ role: "assistant", content: [{ type: "tool_use", input: { password: [opaque], note: "plain" } }] }] };
    const masked = masker(input);
    assert.equal(JSON.stringify(masked).includes(opaque), false);
    assert.equal(masked.messages[0].content[0].input.note, "plain");
    assert.equal(masked.messages[0].role, "assistant");
  });

  test(`deep mixed descendants inherit property context on ${path}`, () => {
    assert.equal(JSON.stringify(masker({ password: [[{ nested: { values: [[opaque]] } }]] })).includes(opaque), false);
  });

  test(`sensitive array scalar rules match direct properties on ${path}`, () => {
    const input = { password: [37, true, false, null] };
    const output = masker(input).password;
    for (const [index, value] of input.password.entries()) {
      assert.equal(output[index], masker({ password: value }).password);
      if (value !== null) assert.notEqual(output[index], value);
    }
    assert.equal(output[3], null);
  });

  test(`sensitive array sentinels and handles remain idempotent on ${path}`, () => {
    const input = { password: ["<vinci-secret>", "<vinci-secret-deadbeef>", "‹redacted›"] };
    assert.deepEqual(masker(input), input);
    assert.deepEqual(masker(masker(input)), masker(input));
  });

  test(`sensitive array placeholders and references preserve scalar rules on ${path}`, () => {
    const values = ["<PASSWORD>", "CHANGE_ME", "${SYNTHETIC_TOKEN}", "${SECRET:-fallback}",
      "SYNTHETIC_TOKEN=SYNTHETIC_TOKEN:latest", "process.env.SYNTHETIC_TOKEN"];
    const input = { password: values };
    assert.deepEqual(masker(input).password, values.map((value) => masker({ password: value }).password));
    for (const value of values) assert.equal(masker({ password: value }).password, value);
  });

  test(`ordinary arrays and telemetry remain unchanged on ${path}`, () => {
    const input = { results: ["plain", 3, true], allowed_paths: ["synthetic/token-handler.ts", "synthetic/password-guide.md"] };
    assert.deepEqual(masker(input), input);
    assert.deepEqual(masker(input, "results"), input);
  });

  test(`structured masking never mutates its input on ${path}`, () => {
    const input = { password: [[{ value: opaque, enabled: true }]], ordinary: ["plain", null] };
    const original = structuredClone(input);
    const masked = masker(input);
    assert.deepEqual(input, original);
    assert.deepEqual(masker(masked), masked);
  });
}
