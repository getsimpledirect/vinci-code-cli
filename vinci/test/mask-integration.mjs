// Integration check: exercise the REAL vinciMaskSecrets — the display-only masker that keeps API
// keys out of edit diffs / write previews so a secret is never painted across the screen in a café.
// Node 23 strips the type-only imports so we can load the core .ts directly.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const { vinciMaskJson, vinciMaskSecrets } = await import(resolve(here, "../../packages/coding-agent/src/core/vinci-mask-secrets.ts"));
const loader = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/dist/index.js"),
  },
});
const { redactSecrets } = await loader.import(resolve(here, "../extensions/lib/secrets.ts"), { default: false });
assert.equal(typeof vinciMaskSecrets, "function", "must export vinciMaskSecrets");
assert.equal(typeof vinciMaskJson, "function", "must export vinciMaskJson");
assert.equal(typeof redactSecrets, "function", "must export redactSecrets");

let pass = 0;
// Synthetic provider-shaped tokens; these must never be usable credentials.
const ANTH = "sk-ant-TESTONLY-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OPENAI = "sk-proj-TESTONLY_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GROQ = `gsk_TESTONLY${"a".repeat(44)}`; // gsk_ + 52 alphanumeric characters
const OPENROUTER = `sk-or-v1-${"a1".repeat(32)}`; // sk-or-v1- + 64 lowercase hex characters
const HUGGING_FACE = `hf_TESTONLY${"b".repeat(26)}`; // hf_ + 34 alphanumeric characters

// The exact secret body must never survive masking; a "leaks" helper is the real security assertion.
const bodyOf = (key) => key.slice(20); // a chunk from deep inside the secret, past any allowed head
const hidden = (name, text) => {
  assert.ok(!text.includes(ANTH), `${name}: full Anthropic key leaked`);
  console.log(`  ✓ ${name}`);
  pass++;
};

// 1. The .env edit-diff line George saw — the whole point of this feature.
{
  const line = `ANTHROPIC_API_KEY="${ANTH}"`;
  const masked = vinciMaskSecrets(line);
  assert.ok(!masked.includes(bodyOf(ANTH)), "env line: secret body must be gone");
  assert.ok(masked.includes("ANTHROPIC_API_KEY"), "env line: the key NAME stays (user still sees which key)");
  assert.ok(/redacted/i.test(masked), "env line: shows a redaction marker");
  hidden("env assignment masks the value, keeps the name", masked);
}

// 2. A full diff blob (removed + added, both carrying the key) — nothing leaks on either side.
{
  const diff = [
    ` 5 # Claude API`,
    `-6 ANTHROPIC_API_KEY="${ANTH}"`,
    `+6 # ANTHROPIC_API_KEY="${ANTH}"  # REMOVED`,
    ` 8 # OpenAI`,
    ` 9 OPENAI_API_KEY="${OPENAI}"`,
  ].join("\n");
  const masked = vinciMaskSecrets(diff);
  assert.ok(!masked.includes(bodyOf(ANTH)), "diff: anthropic body leaked");
  assert.ok(!masked.includes(bodyOf(OPENAI)), "diff: openai body leaked");
  assert.ok(masked.includes("# REMOVED"), "diff: non-secret text preserved");
  hidden("diff blob masks every occurrence, keeps structure", masked);
}

// 3. Bare tokens with NO telltale key name (pasted into code / a log line) still get caught.
hidden("bare anthropic token in prose", vinciMaskSecrets(`the key is ${ANTH} ok`));
hidden("bare token, no assignment", (() => {
  const m = vinciMaskSecrets(`return "${ANTH}";`);
  assert.ok(!m.includes(bodyOf(ANTH)), "bare token not masked");
  return m;
})());

// 4. Other provider shapes.
for (const [name, tok] of [
  ["github PAT", "ghp_TESTONLYabcdefghijklmnopqrstuvwxyz123456"],
  ["github fine-grained", "github_pat_TESTONLY_abcdefghijklmnopqrstuvwxyz1234567890"],
  ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
  ["google api key", "AIzaSyD-1234567890abcdefghijklmnopqrstuv"],
  ["slack token", "xoxb-TESTONLY-abcdefghijklmnopqrstuvwxyz123456"],
]) {
  const m = vinciMaskSecrets(`SECRET=${tok}`);
  assert.ok(!m.includes(tok.slice(10)), `${name}: body leaked`);
  console.log(`  ✓ ${name} masked`);
  pass++;
}

// 🔴 LENGTH AND ALPHABET VARIATION — the regression these exist to prevent.
// The BYOK patterns were first written with EXACT lengths (gsk_{52}, sk-or-v1-[a-f0-9]{64},
// hf_{34}). With the trailing negative lookahead, a key even one character longer matched
// NOTHING and passed through in clear, while every canonical-length test stayed green.
// Mutation testing could not catch it: mutating a pattern that IS load-bearing still fails a
// test, so the mutation passed and the fail-open shipped. Only feeding off-canonical shapes
// finds this. If someone re-tightens a quantifier, these are the tests that go red.
for (const [name, token] of [
  ["Groq canonical 52", `gsk_${"a".repeat(52)}`],
  ["Groq longer 53", `gsk_${"a".repeat(53)}`],
  ["Groq much longer 80", `gsk_${"a".repeat(80)}`],
  ["OpenRouter canonical 64 hex", `sk-or-v1-${"0".repeat(64)}`],
  ["OpenRouter longer 65 hex", `sk-or-v1-${"0".repeat(65)}`],
  ["OpenRouter UPPERCASE hex", `sk-or-v1-${"A".repeat(64)}`],
  ["OpenRouter mixed-case hex", `sk-or-v1-${"aF3b".repeat(16)}`],
  ["Hugging Face canonical 34", `hf_${"a".repeat(34)}`],
  ["Hugging Face longer 40", `hf_${"a".repeat(40)}`],
]) {
  const masked = vinciMaskSecrets(`KEY=${token}`);
  assert.ok(!masked.includes(token), `${name}: FAIL-OPEN — key passed through unmasked`);
  console.log(`  \u2713 variation: ${name} masked`);
  pass++;
}

// The other direction: shorter-than-minimum and prefix-only strings must NOT be mangled.
for (const [name, text] of [
  ["Groq below minimum", `gsk_${"a".repeat(12)}`],
  ["Hugging Face below minimum", `hf_${"a".repeat(8)}`],
  ["bare prefix in prose", "the hf_ prefix identifies Hugging Face tokens"],
  ["env var name", "export HF_HOME=/tmp/hf"],
  ["identifier", "const gsk_handler = fn;"],
]) {
  assert.equal(vinciMaskSecrets(text), text, `${name}: masker mangled ordinary text`);
  console.log(`  \u2713 no false positive: ${name}`);
  pass++;
}

// BYOK provider tokens with verified, provider-specific shapes must mask even without a secret-named
// assignment. Near-miss documentation/code examples stay unchanged to guard against false positives.
for (const [name, tok, nearMiss] of [
  ["Groq", GROQ, `const groqExample = "gsk_short";`],
  ["OpenRouter", OPENROUTER, `routeName = "sk-or-v1-short"`],
  ["Hugging Face", HUGGING_FACE, `const hubLabel = "hf_short";`],
]) {
  const masked = vinciMaskSecrets(`using ${tok} now`);
  assert.ok(!masked.includes(bodyOf(tok)), `${name}: key body leaked`);
  assert.ok(masked.includes("‹redacted›"), `${name}: redaction marker missing`);
  console.log(`  ✓ ${name} provider token masked`);
  pass++;

  assert.equal(vinciMaskSecrets(nearMiss), nearMiss, `${name}: ordinary near-miss text changed`);
  console.log(`  ✓ ${name} near-miss text untouched`);
  pass++;
}

// Capture the exact value sent to the renderer: the sk-or-v1-specific pattern must consume the full
// token in one replacement instead of allowing the later generic sk- pattern to consume a prefix.
{
  const rendered = [];
  const output = vinciMaskSecrets(`value: ${OPENROUTER}`, {
    render: (value) => {
      rendered.push(value);
      return "<captured-secret>";
    },
  });
  assert.deepEqual(rendered, [OPENROUTER], "OpenRouter pattern must capture the complete key exactly once");
  assert.equal(output, "value: <captured-secret>", "OpenRouter replacement must not leave a key suffix");
  console.log("  ✓ OpenRouter specific pattern precedes generic sk- matching");
  pass++;
}

// 5. Generic secret-named vars (not a known provider prefix) still masked by NAME.
for (const line of [
  `DATABASE_PASSWORD=hunter2supersecretvalue`,
  `AUTH_SECRET="256efefbae3c1a48f499669be98b7cfe0b5bb7242fa12ed1332d382aa37603f1"`,
  `client_secret: 'abcdef1234567890ghijkl'`,
]) {
  const m = vinciMaskSecrets(line);
  assert.ok(/redacted/i.test(m), `should redact: ${line.slice(0, 20)}`);
  console.log(`  ✓ generic secret var masked: ${line.split(/[=:]/)[0].trim()}`);
  pass++;
}

// 6. PEM private key block collapses.
{
  const pem = `-----BEGIN TESTONLY PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\nabcdefKEYMATERIAL==\n-----END TESTONLY PRIVATE KEY-----`;
  const m = vinciMaskSecrets(pem);
  assert.ok(!m.includes("KEYMATERIAL"), "PEM body leaked");
  assert.ok(m.includes("BEGIN TESTONLY PRIVATE KEY"), "PEM markers kept");
  console.log("  ✓ PEM private-key block collapsed");
  pass++;

  // A paginated read can split a key across chunks — each half must still be masked (audit P1-2).
  const half1 = vinciMaskSecrets(`reading key…\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\nabcdefKEYMATERIAL==`);
  assert.ok(!half1.includes("KEYMATERIAL"), "split PEM: BEGIN-half body leaked");
  const half2 = vinciMaskSecrets(`MIIEowIBAAKCAQEA1234567890\nabcdefKEYMATERIAL==\n-----END RSA PRIVATE KEY-----\nnext file: config.js`);
  assert.ok(!half2.includes("KEYMATERIAL"), "split PEM: END-half body leaked");
  assert.ok(half2.includes("next file: config.js"), "content after the END marker is preserved");
  console.log("  ✓ split PEM halves both masked, surrounding content kept");
  pass++;
}

// 7. SAFETY: ordinary code must NOT be mangled (no over-eager masking of normal text).
for (const ok of [
  `const total = price * quantity;`,
  `<div className="grid gap-4 sm:grid-cols-2">`,
  `import { useState } from "react";`,
  `# ANTHROPIC_API_KEY line removed`, // a comment ABOUT the key, no value → untouched
]) {
  assert.equal(vinciMaskSecrets(ok), ok, `normal code changed: ${ok}`);
  console.log(`  ✓ untouched: ${ok.slice(0, 32)}`);
  pass++;
}

// 8. Empty / falsy input is safe.
assert.equal(vinciMaskSecrets(""), "");
console.log("  ✓ empty input safe");
pass++;

// 9. Config-shape leaks the review flagged (review finding: JSON-quoted keys / auth headers / URL creds).
{
  // JSON: the key's closing quote sits between the name and the ':' — must still mask the value.
  const jsonPw = vinciMaskSecrets(`{ "password": "hunter2hunter2hunter2", "port": 5432 }`);
  assert.ok(!jsonPw.includes("hunter2hunter2hunter2"), "JSON password value leaked");
  assert.ok(/redacted/i.test(jsonPw) && jsonPw.includes('"port": 5432'), "JSON: value masked, rest intact");
  console.log("  ✓ JSON-quoted secret key masked"); pass++;

  const jsonClient = vinciMaskSecrets(`"client_secret": "abcdefghijklmnop1234"`);
  assert.ok(!jsonClient.includes("abcdefghijklmnop1234"), "JSON client_secret leaked");
  console.log("  ✓ JSON client_secret masked"); pass++;

  // URL-embedded credentials (a DATABASE_URL is the canonical .env leak).
  const dbUrl = vinciMaskSecrets(`DATABASE_URL=postgres://admin:MyP4ssw0rd@db.internal:5432/app`);
  assert.ok(!dbUrl.includes("MyP4ssw0rd"), "URL password leaked");
  assert.ok(dbUrl.includes("db.internal") && dbUrl.includes("admin"), "URL host/user kept");
  console.log("  ✓ URL-embedded password masked (host/user kept)"); pass++;

  // HTTP Authorization headers (Bearer / Basic), incl. a token no provider pattern would catch.
  const bearer = vinciMaskSecrets(`Authorization: Bearer aB3xYz90QwErTyUiOpZ1234567890`);
  assert.ok(!bearer.includes("aB3xYz90QwErTyUiOpZ1234567890"), "Bearer token leaked");
  assert.ok(bearer.includes("Bearer"), "Bearer scheme kept");
  console.log("  ✓ Authorization: Bearer token masked"); pass++;

  // Schemeless Authorization header (no Bearer/Basic/Token scheme) — the value must still mask (review).
  const schemeless = vinciMaskSecrets(`Authorization: aB3xYz90QwErTyUiOpZ1234567890`);
  assert.ok(!schemeless.includes("aB3xYz90QwErTyUiOpZ1234567890"), "schemeless Authorization token leaked");
  console.log("  ✓ schemeless Authorization masked"); pass++;
}

// 12. npm automation/publish tokens (npm_ + 36) have no telltale key name — caught by value shape (review).
{
  const npm = "npm_TESTONLYabcdefghijklmnopqrstuvwxyz12"; // npm_ + 36 chars
  const m = vinciMaskSecrets(`"artifact": "${npm}"`);
  assert.ok(!m.includes(npm.slice(10)), "npm token body leaked (no telltale name)");
  console.log("  ✓ npm token (no telltale name) masked"); pass++;
}

// 10. SAFETY: the ReDoS the review found — a long contiguous run of a secret keyword with NO trailing
//     ':'/'=' must NOT hang the UI. Pre-fix this froze for tens of seconds; bounded quantifiers → O(n).
{
  const evil = "secret".repeat(4000); // ~24KB, no operator → the catastrophic-backtracking trigger
  const t0 = process.hrtime.bigint();
  vinciMaskSecrets(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `masking a ${evil.length}-char keyword run took ${ms.toFixed(0)}ms (ReDoS regression)`);
  console.log(`  ✓ no ReDoS: 24KB keyword run masked in ${ms.toFixed(0)}ms`); pass++;
}

// 11. JSON event masking must preserve structure and numeric telemetry while masking nested secrets.
{
  const event = {
    type: "message_end",
    message: {
      usage: { input: 11950, output: 75, totalTokens: 12025, cost: { total: 0.00121 } },
      content: [{ type: "text", text: `AUTH_TOKEN=${ANTH}` }],
      details: { password: "TESTONLY_hunter2hunter2", access: "TESTONLY_vinci_live_abcdefghijklmnopqrstuvwxyz" },
    },
  };
  const serialized = JSON.stringify(vinciMaskJson(event));
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.message.usage.totalTokens, 12025, "numeric totalTokens must remain numeric");
  assert.equal(parsed.message.usage.cost.total, 0.00121, "unrelated numeric telemetry must remain unchanged");
  assert.ok(!serialized.includes(bodyOf(ANTH)), "nested tool text leaked a token");
  assert.ok(!serialized.includes("TESTONLY_hunter2hunter2"), "nested password property leaked");
  assert.ok(!serialized.includes("TESTONLY_vinci_live_abcdefghijklmnopqrstuvwxyz"), "nested access property leaked");
  console.log("  ✓ structured JSON masking stays parseable and preserves telemetry"); pass++;
}

// 12. Don't re-mask our own model-channel placeholder. The model reads a redacted view and echoes
//     `<vinci-secret>`; the display masker must leave that intact, not garble it to `<vin…‹redacted›`
//     (cli-breaker UX finding: the double-masked token reads as a rendering bug).
{
  for (const placeholder of ["<vinci-secret>", "<vinci-private-key>"]) {
    const line = `stripeSecretKey: ${placeholder}`;
    const masked = vinciMaskSecrets(line);
    assert.equal(masked, line, `placeholder ${placeholder} must pass through untouched, got: ${masked}`);
    assert.ok(!/redacted/.test(masked), `placeholder ${placeholder} must not be re-redacted`);
  }
  // …and the same through the JSON path, under a secret-named property.
  const j = JSON.parse(JSON.stringify(vinciMaskJson({ apiKey: "<vinci-secret>" })));
  assert.equal(j.apiKey, "<vinci-secret>", "JSON: placeholder under a secret-named key must pass through");
  console.log("  ✓ model-channel placeholder is never double-masked"); pass++;
}

// 13. An env-var REFERENCE is the safe pattern, not a secret — masking `process.env.X` to `proc…‹redacted›`
//     both misleads and looks broken. Same for import.meta.env.X and ${VAR}.
{
  for (const ref of ["process.env.STRIPE_SECRET_KEY", "import.meta.env.VITE_API_KEY", "${DATABASE_PASSWORD}"]) {
    const line = `apiKey: ${ref}`;
    const masked = vinciMaskSecrets(line);
    assert.equal(masked, line, `env reference ${ref} must pass through untouched, got: ${masked}`);
  }
  // Guard the guard: a REAL hardcoded value under the same key still gets masked.
  const real = vinciMaskSecrets('apiKey: "TESTONLY_sk_hardcoded_1234567890"');
  assert.ok(/redacted/.test(real), "a real hardcoded value must still be masked");
  assert.ok(!real.includes("hardcoded_1234567890"), "the real value body must be gone");
  console.log("  ✓ env-var references pass through; real hardcoded values still masked"); pass++;
}

// 14. The 0.0.11 non-secret exemption must never become a LEAK path. The exemption is anchored (^…$)
//     inside redact(), so anything more than the exact placeholder / env-reference still masks.
{
  const glued = vinciMaskSecrets(`apiKey: <vinci-secret>${OPENAI}`);
  assert.ok(/redacted/.test(glued), "a real secret glued to the placeholder must still be masked");
  assert.ok(!glued.includes(bodyOf(OPENAI)), "glued-secret body must be gone (no exemption bypass)");
  // `process.envXXXX` (no dot) is not a real env reference — it must NOT inherit the pass-through.
  const noDot = vinciMaskSecrets(`token: process.env${bodyOf(OPENAI)}`);
  assert.ok(!noDot.includes(bodyOf(OPENAI)), "process.env without a dot must not be exempted into a leak");
  console.log("  ✓ non-secret exemption cannot be abused as a leak path"); pass++;
}

// Cloud Run --set-secrets reference lists (ENV=SECRET_NAME) are NAMES, not values — must stay on screen
// so the deploy script is editable; a real secret under the same key still masks. Stripe whsec_ too.
{
  const refList = 'SVC_SECRETS="GHOST_API_URL=GHOST_API_URL,GHOST_ADMIN_API_KEY=GHOST_ADMIN_API_KEY:latest"';
  assert.equal(vinciMaskSecrets(refList), refList, "an exact --set-secrets reference list must stay visible (editable)");
  assert.equal(redactSecrets(refList), refList, "the model path must preserve the same exact reference-list grammar");
  // A leftover interpolation appended to a version is not NAME=VALUE[:version]. Both paths reject it
  // rather than weakening the exact grammar and accidentally admitting padded credentials.
  const crufty = 'SVC_SECRETS="ONEUP_API_KEY=ONEUP_API_KEY:latest,GHOST_ADMIN_API_KEY=GHOST_ADMIN_API_KEY:latest${VINCI_SECRET}"';
  assert.ok(vinciMaskSecrets(crufty).includes("‹redacted›"), "display rejects a non-grammar reference list");
  assert.ok(redactSecrets(crufty).includes("<vinci-secret>"), "model rejects a non-grammar reference list");
  const hiddenReal = 'SVC_SECRETS="GHOST_ADMIN_API_KEY=sk-proj-realkeyabcdefghij0123456789"';
  assert.ok(vinciMaskSecrets(hiddenReal).includes("‹redacted›"), "a REAL key in mount shape still masks (lowercase/hyphen RHS is not a name)");
  const whsec = "STRIPE_WEBHOOK_KEY=whsec_TESTONLYabcdefghijklmnop";
  assert.ok(vinciMaskSecrets(whsec).includes("‹redacted›") && !vinciMaskSecrets(whsec).includes("TESTONLYabcdefghijklmnop"), "a Stripe whsec_ webhook secret must mask");
  const realUnderRefKey = 'SVC_SECRETS="sk-proj-TESTONLYabcdefghijklmnopqrstuv"';
  assert.ok(vinciMaskSecrets(realUnderRefKey).includes("‹redacted›"), "a REAL secret under a *_SECRETS key still masks (not a reference list)");
  console.log("  ✓ secret-name reference lists stay editable; real values + whsec_ still mask"); pass++;
}

// 15. Angle-bracket exemptions are positive, bounded placeholder syntax — opaque values must not
//     become visible merely because documentation sometimes uses angle brackets.
{
  for (const opaque of [
    "<abc123def456ghi789012>",
    "<abc123def456ghi7890123>",
    "<passwordsecrettoken123>",
    "<PASSWORDSECRETTOKEN123>",
    "<12345678901234567890123>",
    "<secret-key-value-here-123>",
    "<pässwörd_secret_токен_12>",
  ]) {
    const line = `password=${opaque}`;
    const masked = vinciMaskSecrets(line);
    assert.ok(!masked.includes(opaque), `opaque bracket value must be masked: ${opaque}`);
    assert.ok(masked.includes("‹redacted›"), `opaque bracket value needs a redaction marker: ${opaque}`);
    pass++;
  }

  for (const placeholder of [
    "<PASSWORD>",
    "<API_KEY>",
    "<username>",
    "<region>",
    "<bucket-name>",
    "<project-id>",
    "<YOUR_API_KEY_HERE>",
    "<changeme>",
    "<vinci-secret>",
    "<vinci-private-key>",
  ]) {
    const line = `password=${placeholder}`;
    assert.equal(redactSecrets(line), line, `documented placeholder must stay visible: ${placeholder}`);
    pass++;
  }
  console.log("  ✓ bracket exemptions admit only bounded placeholder syntax");
}

// 16. Shell interpolation operands are literal content and receive the same positive-placeholder
//     validation as angle-bracket contents. A bare variable reference carries no literal value.
{
  const opaque = "abc123def456ghi789012";
  for (const interpolation of [
    `\${VAR:-${opaque}}`,
    `\${VAR:=${opaque}}`,
    `\${VAR:?${opaque}}`,
    `\${VAR=${opaque}}`,
  ]) {
    const line = `password=${interpolation}`;
    const masked = redactSecrets(line);
    assert.ok(!masked.includes(opaque), `interpolation literal must be masked: ${interpolation}`);
    assert.ok(masked.includes("<vinci-secret>"), `interpolation literal needs a redaction marker: ${interpolation}`);
    pass++;
  }

  for (const interpolation of [
    "${VAR}",
    "${PASSWORD:-password}",
    "${VAR:-${INNER}}",
    "${PASSWORD:-fallback}",
  ]) {
    const line = `password=${interpolation}`;
    assert.equal(redactSecrets(line), line, `benign interpolation must stay visible: ${interpolation}`);
    pass++;
  }

  const unbalanced = "password=${UNCLOSED";
  assert.equal(redactSecrets(unbalanced), "password=<vinci-secret>", "unbalanced interpolation must be masked");
  pass++;
  console.log("  ✓ interpolation grammar validates literal operands and nesting");
}

// 17. Short opaque values and interpolation defaults must not inherit placeholder exemptions in the
//     display masker. Its exact sentinel must remain stable across repeated masking.
{
  const interpolationCases = [
    ["${SECRET}", true],
    ["${SECRET:-fallback}", true],
    ["${SECRET:=fallback}", true],
    ["${SECRET:?fallback}", true],
    ["${SECRET:+fallback}", true],
    ["${SECRET=fallback}", true],
    ["${SECRET#fallback}", true],
    ["${SECRET%fallback}", true],
    ["${SECRET:-${INNER}}", true],
    ["${SECRET:-<PLACEHOLDER>}", true],
    ["${SECRET:-S3cr3tP4ss}", false],
    ["${SECRET:=S3cr3tP4ss}", false],
    ["${SECRET:?S3cr3tP4ss}", false],
    ["${SECRET:+hunter2}", false],
    ["${SECRET=hunter2}", false],
    ["${SECRET#hunter2}", false],
    ["${SECRET%hunter2}", false],
    ["${SECRET:-${INNER:-hunter2}}", false],
    ["${SECRET:-fallback", false],
    [`\${SECRET:-${"x".repeat(257)}}`, false],
    [`\${SECRET:-${"${INNER:-".repeat(17)}fallback${"}".repeat(17)}}`, false],
  ];
  for (const [interpolation, preserved] of interpolationCases) {
    const line = `password=${interpolation}`;
    const modelMasked = redactSecrets(line);
    const displayMasked = vinciMaskSecrets(line);
    assert.equal(
      vinciMaskSecrets(displayMasked),
      displayMasked,
      `display masking must be idempotent for interpolation: ${interpolation}`,
    );
    console.log(
      `    interpolation ${JSON.stringify(interpolation)}: model=${JSON.stringify(modelMasked)} display=${JSON.stringify(displayMasked)}`,
    );
    if (preserved) {
      assert.equal(modelMasked, line, `model masker must preserve benign interpolation: ${interpolation}`);
      assert.equal(displayMasked, line, `display masker must preserve benign interpolation: ${interpolation}`);
    } else {
      assert.ok(modelMasked.includes("<vinci-secret>"), `model masker must redact: ${interpolation}`);
      assert.ok(displayMasked.includes("‹redacted›"), `display masker must redact: ${interpolation}`);
    }
  }
  for (const interpolation of [
    "${SECRET:-fallback}",
    "${SECRET:=fallback}",
    "${SECRET:?fallback}",
    "${SECRET:+fallback}",
    "${SECRET=fallback}",
  ]) {
    const line = `const s = ${interpolation}`;
    assert.equal(redactSecrets(line), line, `model masker must preserve neutral-code interpolation: ${interpolation}`);
    assert.equal(vinciMaskSecrets(line), line, `display masker must preserve neutral-code interpolation: ${interpolation}`);
  }

  for (const value of ["<hunter2>", "<S3cr3tP4ss>", "<abc123>", "${SECRET:-S3cr3tP4ss}", "${VAR:-hunter2}"]) {
    const line = `password=${value}`;
    const masked = vinciMaskSecrets(line);
    assert.ok(masked.includes("‹redacted›"), `display masker must redact: ${value}`);
    assert.ok(!masked.includes(value), `display masker leaked: ${value}`);
    pass++;
  }

  const once = vinciMaskSecrets("password=hunter2");
  assert.equal(vinciMaskSecrets(once), once, "display masking must be idempotent");
  pass++;

  assert.ok(vinciMaskSecrets("password=${VAR:+hunter2}").includes("‹redacted›"), "display masker must redact a :+ literal");
  assert.equal(
    vinciMaskSecrets("password=${VAR:+<PLACEHOLDER>}"),
    "password=${VAR:+<PLACEHOLDER>}",
    "display masker must preserve a :+ placeholder",
  );
  pass++;

  for (const line of ["path=<path/to/file>", "email=<email@example.com>", "version=<1.2.3>"]) {
    assert.equal(vinciMaskSecrets(line), line, `structural placeholder must not be over-masked: ${line}`);
    pass++;
  }
  console.log("  ✓ short values, :+ operands, idempotence, and structural placeholders");
}

console.log(`\nmask-integration: ${pass}/${pass} checks passed (real vinciMaskSecrets module)`);

// #43: both channels must make every secret/placeholder decision from one shared implementation.
// Keep this as one matrix parameterized over the two public maskers so a future hardening case cannot
// land in only one path again. Outputs are printed for every row to make base-commit failures auditable.
{
  const nested17 = `${"${N:-".repeat(17)}fallback${"}".repeat(17)}`;
  const longYourPlaceholder = `<your-${"x".repeat(256)}>`;
  const longOpaque = "aB3xYz90".repeat(20);
  const cases = [
    { name: "Perl bare ENV read", input: "password = $ENV{X}", masked: false },
    { name: "Perl single-quoted ENV read", input: "password = $ENV{'X'}", masked: false },
    { name: "Perl double-quoted ENV read", input: 'password = $ENV{"X"}', masked: false },
    { name: "bare getenv read", input: 'password = getenv("X")', masked: false },
    { name: "C++ std::getenv read", input: 'password = std::getenv("X")', masked: false },
    { name: "Go Getenv read", input: 'password = os.Getenv("X")', masked: false },
    { name: "Go LookupEnv read", input: 'password = os.LookupEnv("X")', masked: false },
    { name: "bare shell variable read", input: "password = $VAR", masked: false },
    { name: "Node dotted env read", input: "password = process.env.X", masked: false },
    { name: "Node bracket env read", input: "password = process.env['X']", masked: false },
    { name: "Python environ read", input: "password = os.environ['X']", masked: false },
    { name: "Python environ get read", input: "password = os.environ.get('X')", masked: false },
    { name: "Python getenv read", input: "password = os.getenv('X')", masked: false },
    { name: "Ruby ENV bracket read", input: "password = ENV['X']", masked: false },
    { name: "Ruby ENV fetch read", input: "password = ENV.fetch('X')", masked: false },
    { name: "Java System getenv read", input: 'password = System.getenv("X")', masked: false },
    { name: "shell interpolation read", input: "password = ${SECRET}", masked: false },
    { name: "shell interpolation fallback read", input: "password = ${SECRET:-fallback}", masked: false },
    { name: "truncated Node bracket read", input: "password = process.env['KEY", masked: false },
    { name: "truncated Python getenv read", input: "password = os.getenv('KEY", masked: false },
    {
      name: "accepted opaque env-name residual",
      input: "password = os.getenv('HUNTER2')",
      masked: false,
    },
    {
      name: "complete accessor does not apply truncated-placeholder grammar",
      input: "password = os.getenv('database_url')",
      masked: false,
    },
    { name: "generic accessor call", input: "password = getSecret()", masked: true, leak: "getSecret()" },
    {
      name: "generic member chain",
      input: "password = config.authToken",
      masked: true,
      leak: "config.authToken",
    },
    {
      name: "lowercase dollar-prefixed literal",
      input: "password = $upersecretvalue",
      masked: true,
      leak: "$upersecretvalue",
    },
    {
      name: "quoted literal",
      input: 'password = "secret_value"',
      masked: true,
      leak: "secret_value",
    },
    {
      name: "unterminated quoted getenv credential",
      input: "password = os.getenv('hunter2CorrectHorseBatteryStapleXY",
      masked: true,
      leak: "hunter2CorrectHorseBatteryStapleXY",
    },
    {
      name: "unterminated unquoted getenv credential",
      input: "password = os.getenv(sk_live_51H8xQ2eZvKYlo2CkFmNpQrStUvWxYz01",  // pragma: allowlist secret (published vendor example vector)
      masked: true,
      leak: "sk_live_51H8xQ2eZvKYlo2CkFmNpQrStUvWxYz01",  // pragma: allowlist secret (published vendor example vector)
    },
    {
      name: "unterminated process env bracket credential",
      input: "password = process.env[ghp_16C7e42F292c6912E7710c838347Ae178B4a",  // pragma: allowlist secret (published vendor example vector)
      masked: true,
      leak: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",  // pragma: allowlist secret (published vendor example vector)
    },
    {
      name: "credential after accessor whitespace",
      input: "password = os.getenv( correctHorseBatteryStaple42",
      masked: true,
      leak: "correctHorseBatteryStaple42",
    },
    {
      name: "credential after accessor newline",
      input: "password = os.getenv(\n  correctHorseBatteryStaple42",
      masked: true,
      leak: "correctHorseBatteryStaple42",
    },
    {
      name: "chained access after allowlisted accessor",
      input: "password = os.Getenv.call(SECRET)",
      masked: true,
      leak: "os.Getenv.call(SECRET)",
    },
    {
      name: "chained access after completed call",
      input: "password = os.getenv('X').strip()",
      masked: true,
      leak: "os.getenv('X').strip()",
    },
    {
      name: "chained access after completed bracket",
      input: "password = process.env['X'].trim()",
      masked: true,
      leak: "process.env['X'].trim()",
    },
    {
      name: "whitespace before chained call access",
      input: "password = os.getenv('X') .strip()",
      masked: true,
      leak: "os.getenv('X') .strip()",
    },
    {
      name: "whitespace before chained dotted access",
      input: "password = process.env.X .trim()",
      masked: true,
      leak: "process.env.X .trim()",
    },
    { name: "short bracket secret", input: "password=<hunter2>", masked: true, leak: "hunter2" },
    { name: "mixed-case bracket secret", input: "password=<S3cr3tP4ss>", masked: true, leak: "S3cr3tP4ss" },
    { name: "short opaque bracket secret", input: "password=<abc>", masked: true, leak: "abc" },
    { name: "spaced bracket secret", input: "password=< PASSWORD>", masked: true, leak: " PASSWORD" },
    { name: "long opaque value", input: `password=${longOpaque}`, masked: true, leak: longOpaque },
    {
      name: "Stripe wrapped token",
      input: "value=sk_live_TESTONLYabcdefghijklmnopqrstuv",
      masked: true,
      leak: "TESTONLYabcdefghijklmnopqrstuv",
    },
    {
      name: "GitHub wrapped token",
      input: "value=ghp_TESTONLYabcdefghijklmnopqrstuvwxyz123456",
      masked: true,
      leak: "TESTONLYabcdefghijklmnopqrstuvwxyz123456",
    },
    { name: "AWS AKIA token", input: "value=AKIAIOSFODNN7EXAMPLE", masked: true, leak: "IOSFODNN7EXAMPLE" },
    { name: "AWS ASIA token", input: "value=ASIAIOSFODNN7EXAMPLE", masked: true, leak: "IOSFODNN7EXAMPLE" },
    {
      name: "interpolation default secret",
      input: "password=${SECRET:-S3cr3tP4ss}",
      masked: true,
      leak: "S3cr3tP4ss",
    },
    {
      name: "interpolation alternate secret",
      input: "password=${SECRET:+hunter2}",
      masked: true,
      leak: "hunter2",
    },
    {
      name: "spaced interpolation secret",
      input: "password=${VAR:- hunter2}",
      masked: true,
      leak: "hunter2",
    },
    {
      name: "quoted interpolation secret",
      input: 'password=${VAR:-"hunter2"}',
      masked: true,
      leak: "hunter2",
    },
    {
      name: "padded credential is not a reference list",
      input: "password=RLZQHIQS8A==",
      masked: true,
      leak: "RLZQHIQS8A==",
    },
    {
      name: "overlong your-placeholder",
      input: `password=${longYourPlaceholder}`,
      masked: true,
      leak: longYourPlaceholder,
    },
    {
      name: "17-level interpolation",
      input: `password=${nested17}`,
      masked: true,
      leak: nested17,
    },
    { name: "uppercase example placeholder", input: "password=EXAMPLE_VALUE", masked: false },
    { name: "uppercase change-me placeholder", input: "password=CHANGE_ME", masked: false },
    { name: "uppercase your-token placeholder", input: "password=YOUR_TOKEN", masked: false },
    { name: "password placeholder", input: "password=<PASSWORD>", masked: false },
    { name: "api-key placeholder", input: "password=<API_KEY>", masked: false },
    { name: "username placeholder", input: "password=<username>", masked: false },
    { name: "region placeholder", input: "password=<region>", masked: false },
    { name: "token placeholder", input: "password=<token>", masked: false },
    { name: "key placeholder", input: "password=<key>", masked: false },
    { name: "id placeholder", input: "password=<id>", masked: false },
    { name: "host placeholder", input: "password=<host>", masked: false },
    { name: "path placeholder", input: "password=<path/to/file>", masked: false },
    { name: "email placeholder", input: "password=<email@example.com>", masked: false },
    { name: "version placeholder", input: "password=<1.2.3>", masked: false },
    { name: "your-api-key placeholder", input: "password=<YOUR_API_KEY_HERE>", masked: false },
    { name: "bare interpolation reference", input: "password=${SECRET}", masked: false },
    { name: "placeholder interpolation default", input: "password=${SECRET:-fallback}", masked: false },
    {
      name: "exact secret reference list",
      input: 'SVC_SECRETS="GHOST_API_URL=GHOST_API_URL,GHOST_ADMIN_API_KEY=GHOST_ADMIN_API_KEY:latest"',
      masked: false,
    },
  ];
  const maskers = [
    { name: "model", mask: redactSecrets, marker: "<vinci-secret>", sentinel: "<vinci-secret>" },
    { name: "display", mask: vinciMaskSecrets, marker: "‹redacted›", sentinel: "‹redacted›" },
  ];
  const failures = [];
  let checks = 0;
  for (const testCase of cases) {
    for (const masker of maskers) {
      const output = masker.mask(testCase.input);
      console.log(`    shared ${testCase.name} [${masker.name}]: ${JSON.stringify(output)}`);
      if (testCase.masked) {
        if (!output.includes(masker.marker)) failures.push(`${testCase.name} [${masker.name}] has no marker`);
        if (testCase.leak && output.includes(testCase.leak)) {
          failures.push(`${testCase.name} [${masker.name}] leaked ${JSON.stringify(testCase.leak)}`);
        }
      } else if (output !== testCase.input) {
        failures.push(`${testCase.name} [${masker.name}] changed preserved input`);
      }
      if (masker.mask(output) !== output) failures.push(`${testCase.name} [${masker.name}] is not idempotent`);
      checks++;
    }

    const modelDecision = redactSecrets(testCase.input) !== testCase.input;
    const displayDecision = vinciMaskSecrets(testCase.input) !== testCase.input;
    if (modelDecision !== displayDecision) failures.push(`${testCase.name} diverged between maskers`);
  }

  for (const masker of maskers) {
    const sentinelLine = `password=${masker.sentinel}`;
    const output = masker.mask(sentinelLine);
    console.log(`    shared sentinel idempotence [${masker.name}]: ${JSON.stringify(output)}`);
    if (output !== sentinelLine) failures.push(`sentinel idempotence [${masker.name}] changed its own sentinel`);
    checks++;
  }

  const exactSecret = "vinci_live_abcdefghijklmnopqrstuvwxyz123456";
  const exactInput = `Use API_KEY=${exactSecret} for the request`;
  const exactModelOutput = redactSecrets(exactInput);
  const exactDisplayOutput = vinciMaskSecrets(exactInput);
  assert.equal(
    exactModelOutput,
    "Use API_KEY=<vinci-secret> for the request",
    "model rendering must replace the complete secret with its contract sentinel",
  );
  assert.ok(!exactModelOutput.includes(exactSecret) && !exactModelOutput.includes("vinc…"));
  assert.equal(
    exactDisplayOutput,
    "Use API_KEY=vinc…‹redacted› for the request",
    "display rendering must keep its identifying head and display sentinel",
  );

  const adversarial = `value = process.env${".a".repeat(80_000)}`;
  for (const masker of maskers) {
    const started = process.hrtime.bigint();
    masker.mask(adversarial);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`    shared #26 timing [${masker.name}]: ${elapsedMs.toFixed(1)}ms`);
    if (elapsedMs >= 1_000) failures.push(`#26 timing [${masker.name}] took ${elapsedMs.toFixed(1)}ms`);
    checks++;
  }

  console.log(`shared-mask matrix: ${checks - failures.length}/${checks} checks passed`);
  assert.deepEqual(failures, [], `shared-mask failures:\n${failures.join("\n")}`);
}
