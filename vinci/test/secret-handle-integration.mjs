import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// A secret the user TYPED is not the same object as a secret Vinci found by READING a file. The old
// renderer erased both to the same bare `<vinci-secret>`, so a credential the user deliberately
// supplied could never be used: the model shipped the literal placeholder to the real endpoint and
// got a 401 that reads as a broken API rather than as a masked view. User input now mints a vaulted
// HANDLE that the shell channel — and only the shell channel — resolves at execution time.

const here = dirname(fileURLToPath(import.meta.url));
// The guard and this test must share ONE lib/secrets.ts instance: the vault is module state, and an
// uncached second copy would give the guard a vault that never saw the handles minted here.
const loader = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
const secrets = await loader.import(resolve(here, "../extensions/lib/secrets.ts"), { default: false });
const guard = await loader.import(resolve(here, "../extensions/vinci-guard.ts"), { default: false });

const HANDLE = /<vinci-secret-[0-9a-f]{8}>/;
// Synthetic credentials, invented for this test — TESTONLY (repo convention for test vectors).
const FAKE = "sk-TESTONLYabc123def456ghi789";
const FAKE_OTHER = "sk-TESTONLYzzz999888777666555";

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

// ── The vault itself ─────────────────────────────────────────────────────────────────────────────
{
  secrets.resetSecretVault();
  const typed = `curl -X POST https://api.example.com/v1/chat -H "Authorization: Bearer ${FAKE}"`;
  const masked = secrets.redactUserInput(typed);

  check("the user's credential is replaced by a handle, not shown", HANDLE.test(masked) && !masked.includes(FAKE));
  check("a handle round-trips back to exactly what the user typed", secrets.rehydrateSecrets(masked).text === typed);

  // The payload hook re-redacts the WHOLE outgoing request, so a handle meets the masker again on
  // every single turn. If that pass mangles it, the handle dies and the command silently breaks.
  check("re-redacting a handle leaves it untouched", secrets.redactSecrets(masked) === masked);
  const deep = secrets.redactSecretsDeep({ messages: [{ role: "user", content: masked }] });
  check("the deep payload walk leaves it untouched too", deep.messages[0].content === masked);

  // Assignment position is the shape that actually reaches the masker's sentinel check, and it is
  // the commonest way a user hands over a credential. `API_KEY=<handle>` looks exactly like a secret
  // assignment, so without the sentinel grammar knowing the `-id` form the masker re-masks the
  // handle down to a bare `<vinci-secret>` — killing it on the very next turn, since the payload
  // hook re-redacts everything. The Bearer shape above does NOT exercise this: `<` is outside the
  // scheme pattern's character class, so it is skipped for an unrelated reason.
  for (const shape of [`API_KEY=${FAKE}`, `export TOKEN="${FAKE}"`, `{"apiKey": "${FAKE}"}`]) {
    const once = secrets.redactUserInput(shape);
    check(`a handle in assignment position survives re-redaction: ${shape.slice(0, 24)}`, HANDLE.test(once) && secrets.redactSecrets(once) === once);
  }

  check("the same value always gets the same handle", secrets.redactUserInput(`again ${typed}`).match(HANDLE)[0] === masked.match(HANDLE)[0]);

  // Constraint: only what the user typed is vaulted. A secret Vinci read stays a dead end.
  const fromFile = secrets.redactSecrets(`API_KEY=${FAKE_OTHER}`);
  check("a secret Vinci only READ gets no handle", fromFile.includes("<vinci-secret>") && !HANDLE.test(fromFile));
  check("and cannot be turned back into a value", secrets.rehydrateSecrets(fromFile).text === fromFile);

  const invented = secrets.rehydrateSecrets("curl -H 'Authorization: Bearer <vinci-secret-deadbeef>'");
  check("a handle the model invented resolves to nothing", invented.resolved.length === 0 && invented.unresolved.length === 1);

  secrets.resetSecretVault();
  check("resetting the vault kills every handle it issued", secrets.rehydrateSecrets(masked).unresolved.length === 1);
}

// ── The shell channel ────────────────────────────────────────────────────────────────────────────
function harness() {
  const handlers = {};
  const sent = [];
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    appendEntry() {},
  };
  guard.default(pi);

  const notices = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      setWidget() {},
      notify: (text) => notices.push(text),
      // Approve confirms: a curl is network-bound and a LATER guard asks about that. Declining here
      // would block the command for a reason that has nothing to do with handles.
      select: async (_q, options) => options[options.length - 1],
    },
  };

  const toolCall = async (event) => {
    for (const handler of handlers.tool_call ?? []) {
      const result = await handler(event, ctx);
      if (result?.block) return result;
    }
    return undefined;
  };

  return { handlers, sent, notices, ctx, toolCall };
}

{
  secrets.resetSecretVault();
  const { notices, toolCall } = harness();

  const typed = `curl -X POST https://api.example.com/v1/chat -H "Authorization: Bearer ${FAKE}"`;
  const handled = secrets.redactUserInput(typed);

  // What the model emits is the handle form — it never saw anything else.
  const input = { command: handled };
  const blocked = await toolCall({ toolName: "bash", input });

  check("a command carrying a live handle is not blocked", blocked === undefined);
  // A later guard prepends a signed network-grant header, so the command it will run ENDS with the
  // restored text rather than equalling it — and the grant is signed over the restored command.
  check("the real credential is substituted into the command that will run", input.command.endsWith(typed));
  check("the substituted command is no longer carrying the handle", !HANDLE.test(input.command));
  // The network grant is an HMAC over the command BODY. If the substitution landed after signing,
  // the grant would verify against the wrong text and the command would silently lose its network.
  const grant = input.command.match(/^# vinci-security-grant:[a-f0-9]{32}:([a-z,]+):[a-f0-9]{64}\n/);
  check("the network grant is signed over the RESTORED command, not the handle form", grant !== null && input.command.slice(grant[0].length) === typed);
  check("the user is told which handle was restored, and only the handle", notices.some((n) => HANDLE.test(n) && !n.includes(FAKE)));

  // A handle is NOT inert to the guards that run after it, so what RUNS is what gets classified.
  // (The original instance of this: every handle ends in `>`, which an older shell-file-write
  // heuristic read as a redirect and refused a plain `echo` over. Current main parses quoting
  // correctly, so this is now a positive control on that classifier rather than a regression pin —
  // the property it guards is still live for every other classifier.)
  const echoInput = { command: `echo '${handled}'` };
  const echoBlocked = await toolCall({ toolName: "bash", input: echoInput });
  check("a handle's trailing `>` is not mistaken for a shell redirect", echoBlocked?.block !== true);
  check("and that command still gets the real credential", echoInput.command.includes(FAKE));
}

{
  secrets.resetSecretVault();
  const { sent, toolCall } = harness();

  // A bare sentinel names a secret Vinci only READ. There is nothing to substitute, so it must still
  // be refused rather than sent to a real endpoint.
  const bare = { command: 'curl -H "Authorization: Bearer <vinci-secret>" https://api.example.com' };
  const bareResult = await toolCall({ toolName: "bash", input: bare });
  check("a bare sentinel is still refused on the shell channel", bareResult?.block === true);
  check("the refusal names the placeholder, not a generic shell risk", /secret-masking placeholder/i.test(String(bareResult?.reason ?? "")));
  check("the refused command is left exactly as the model wrote it", bare.command.includes("<vinci-secret>"));

  const invented = { command: 'curl -H "Authorization: Bearer <vinci-secret-deadbeef>" https://api.example.com' };
  const inventedResult = await toolCall({ toolName: "bash", input: invented });
  check("a handle the model invented is refused, never guessed at", inventedResult?.block === true);
  check("the invented handle is not substituted with some other secret", invented.command.includes("<vinci-secret-deadbeef>"));

  const coaching = String(sent.find((s) => s.message?.customType === "vinci-masked-command-block")?.message?.content ?? "");
  check("the coaching tells the model not to invent handles", /do not invent a handle/i.test(coaching));
  check("the coaching still forbids reveal/reconstruct/obtain", /do not attempt to reveal, reconstruct, or otherwise obtain the raw value/i.test(coaching));
}

// The always-allow store is written to DISK and keyed on the command text. It must be keyed on what
// the model wrote, never on the restored command — otherwise choosing "always allow" once writes a
// live credential into vinci-trust.json, where it outlives the session the vault is scoped to.
{
  secrets.resetSecretVault();
  const trustFile = join(mkdtempSync(join(tmpdir(), "vinci-trust-")), "vinci-trust.json");
  process.env.VINCI_TRUST_FILE = trustFile;
  const { toolCall, ctx } = harness();
  ctx.ui.select = async (_question, options) => options.find((o) => /always allow/i.test(o)) ?? options[options.length - 1];

  const handled = secrets.redactUserInput(`sudo deploy --token ${FAKE}`);
  const input = { command: handled };
  await toolCall({ toolName: "bash", input });

  const stored = existsSync(trustFile) ? readFileSync(trustFile, "utf8") : "";
  check("choosing always-allow records something", stored.length > 0);
  check("the on-disk always-allow store never receives the credential", !stored.includes(FAKE));
  check("it records the handle the model wrote instead", HANDLE.test(stored));
  delete process.env.VINCI_TRUST_FILE;
}

// ── Constraint: bash only. A handle must never become a real secret on disk. ─────────────────────
{
  secrets.resetSecretVault();
  const { toolCall } = harness();
  const handled = secrets.redactUserInput(`API_KEY=${FAKE}`);

  const write = { path: ".env.local", content: `${handled}\nPORT=3000\n` };
  const writeResult = await toolCall({ toolName: "write", input: write });
  check("writing a live handle to a file is refused", writeResult?.block === true);
  check("the file content is never rehydrated", write.content.includes("<vinci-secret-") && !write.content.includes(FAKE));

  const edit = { path: "config.js", edits: [{ oldText: "key: ''", newText: `key: '${handled}'` }] };
  const editResult = await toolCall({ toolName: "edit", input: edit });
  check("editing a live handle into a file is refused too", editResult?.block === true);
  check("the edit text is never rehydrated", !JSON.stringify(edit).includes(FAKE));
}

// Positive reachability: none of the above blocks ordinary work.
{
  secrets.resetSecretVault();
  const { toolCall } = harness();
  check("placeholder-free commands still run", (await toolCall({ toolName: "bash", input: { command: "echo ok" } })) === undefined);
  check(
    "ordinary edits still pass",
    (await toolCall({ toolName: "edit", input: { path: "src/index.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] } })) === undefined,
  );
}

console.log(`\nsecret-handle-integration: ${pass}/${pass} checks passed (a credential the user supplies reaches the shell, and nowhere else)`);
