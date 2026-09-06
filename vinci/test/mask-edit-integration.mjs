import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// Regression: secret masking replaces sensitive-looking strings with <vinci-secret> in everything
// the model sees, while edit matches against the raw file. Observed live 2026-07-14: a masked token
// in a generated test file made three successive edits fail ("could not find the exact text"), the
// retry coaching ("re-read and copy it exactly") re-read masked content — a guaranteed dead end —
// and the only escape was a wholesale file rewrite. Worse, a rewrite built from the masked view
// would land the literal placeholder on disk, destroying the real value. The guard now fails both
// shapes fast with guidance that can actually work.

const here = dirname(fileURLToPath(import.meta.url));
const guardPath = resolve(here, "../extensions/vinci-guard.ts");
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const guard = await loader.import(guardPath, { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

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
  return { handlers, sent, pi };
}

async function firstBlock(handlers, event, context) {
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler(event, context);
    if (result?.block) return result;
  }
  return undefined;
}

const context = {
  cwd: process.cwd(),
  hasUI: true,
  ui: {
    setWidget() {},
    notify() {},
  },
};

const { handlers, sent, pi } = harness();
guard.default(pi);

const maskedOldText = await firstBlock(
  handlers,
  {
    toolName: "edit",
    input: {
      path: "test.js",
      edits: [{ oldText: "test('renders a basic <vinci-secret> table', () => {", newText: "test('renders a basic table', () => {" }],
    },
  },
  context,
);
check("an edit whose oldText carries the masking placeholder is blocked", maskedOldText?.block === true);
check(
  "the block explains the placeholder can never match the raw file",
  String(maskedOldText?.reason ?? "").includes("never matches"),
);
check(
  "the model is coached toward unmasked anchors, not another doomed re-read",
  sent.some((s) => s.message?.customType === "vinci-masked-edit-block"),
);
// #18: the coaching must converge the model in one step, not send it hunting for the raw value.
// Live day-2 finding — with softer coaching the model burned ~2.5min/$0.10 trying cat/sed/xxd/awk
// workarounds before falling back to "ask the user". The message now names those as futile and says
// so explicitly, plus the ask-the-user fallback, so a single read decides the next action.
const maskedEditCoaching = String(
  sent.find((s) => s.message?.customType === "vinci-masked-edit-block")?.message?.content ?? "",
);
// Direction-aware (not keyword-presence): the coaching must EXPLICITLY forbid obtaining the value and
// exploring workarounds, AND give BOTH affirmative decision-path actions (edit placeholder-free lines
// + ask the user). It must NOT solicit the secret ("paste"), must NOT claim specific tools mask it
// (xxd/od hex/octal dumps bypass the pattern redactor — see #19), and must NOT assert impossibility.
check(
  "the masked-edit coaching forbids the full reveal/reconstruct/obtain set and further workarounds",
  /do not attempt to reveal, reconstruct, or otherwise obtain the raw value/i.test(maskedEditCoaching) &&
    /do not keep exploring workarounds/i.test(maskedEditCoaching),
);
check(
  // Match the whole positive "do exactly one of: (a)… or (b)…" structure, so a negated mutation
  // ("Do not make the edit…", "do not ask the user…") no longer satisfies the assertion.
  "the masked-edit coaching states both affirmative decision paths as a positive one-of directive",
  /do exactly one of: \(a\) make the edit anchored only on nearby lines that contain no placeholder, or \(b\) stop and ask the user to make this one change/i.test(
    maskedEditCoaching,
  ),
);
check(
  "the masked-edit coaching avoids secret solicitation, tool names, impossibility claims, and the verify-after over-promise",
  !/paste/i.test(maskedEditCoaching) &&
    !/xxd|\bod\b|hexdump|base64|\bcat\b|\bsed\b/i.test(maskedEditCoaching) &&
    !/not available|cannot be reconstructed|masked in every tool/i.test(maskedEditCoaching) &&
    !/verify the result afterward/i.test(maskedEditCoaching),
);

const legacyMaskedOldText = await firstBlock(
  handlers,
  {
    toolName: "edit",
    input: { path: "config.js", oldText: "apiKey: '<vinci-secret>'", newText: "apiKey: ''" },
  },
  context,
);
check("the legacy flat oldText shape is covered too", legacyMaskedOldText?.block === true);

const maskedWrite = await firstBlock(
  handlers,
  {
    toolName: "write",
    input: { path: ".env.local", content: "API_KEY=<vinci-secret>\nPORT=3000\n" },
  },
  context,
);
check("a write whose content carries the placeholder is blocked", maskedWrite?.block === true);
check(
  "the write block names the data-loss consequence",
  String(maskedWrite?.reason ?? "").includes("destroy"),
);
// #18: the write-block coaching converges in one step too, and — like the edit path — never solicits
// the secret or claims a per-tool masking guarantee that hex/octal dumps would break.
const maskedWriteCoaching = String(
  sent.find((s) => s.message?.customType === "vinci-masked-write-block")?.message?.content ?? "",
);
check(
  "the masked-write coaching forbids reveal/reconstruct/obtain, whole-file rewrite, and workarounds",
  /do not attempt to reveal, reconstruct, or otherwise obtain the raw value/i.test(maskedWriteCoaching) &&
    /do not rewrite the whole file/i.test(maskedWriteCoaching) &&
    /do not keep exploring workarounds/i.test(maskedWriteCoaching),
);
check(
  // Match the whole positive "Instead, make a targeted edit …, or ask the user …" sentence, so a
  // negated mutation ("Do not make a targeted edit", "do not ask the user") fails the assertion.
  "the masked-write coaching states both affirmative decision paths as a positive directive",
  /Instead, make a targeted edit anchored only on nearby placeholder-free lines, or ask the user to update that value/i.test(
    maskedWriteCoaching,
  ),
);
check(
  "the masked-write coaching avoids 'write around it', solicitation, tool names, impossibility claims, and verify-after",
  !/write around it/i.test(maskedWriteCoaching) &&
    !/paste/i.test(maskedWriteCoaching) &&
    !/xxd|\bod\b|hexdump|base64|\bcat\b|\bsed\b/i.test(maskedWriteCoaching) &&
    !/not available|cannot be reconstructed|masked in every tool/i.test(maskedWriteCoaching) &&
    !/verify the result afterward/i.test(maskedWriteCoaching),
);

const maskedNewText = await firstBlock(
  handlers,
  {
    toolName: "edit",
    input: { path: "settings.json", edits: [{ oldText: '"port": 3000', newText: '"key": "<vinci-secret>", "port": 3000' }] },
  },
  context,
);
check("an edit that would land the placeholder on disk is blocked", maskedNewText?.block === true);

const privateKeyWrite = await firstBlock(
  handlers,
  {
    toolName: "write",
    input: { path: "deploy/key.pem", content: "<vinci-private-key>\n" },
  },
  context,
);
check("the private-key placeholder is covered too", privateKeyWrite?.block === true);

const cleanEdit = await firstBlock(
  handlers,
  {
    toolName: "edit",
    input: { path: "src/index.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
  },
  context,
);
check("ordinary edits still pass the guard untouched", cleanEdit === undefined);

// A TEMPLATE/placeholder value must NOT be masked. Masking it to <vinci-secret> makes the file
// uneditable — every edit anchor the model builds collides with the placeholder (observed live: Vinci
// couldn't edit .env.example, whose values are all placeholders) — and a placeholder protects nothing.
// Real values under the same key still mask.
{
  const r = guard.redactSecrets;
  for (const line of [
    "GHOST_ADMIN_API_KEY=your_admin_api_key_here",
    "SD_GHOST_ADMIN_API_KEY=<your-key>",
    "API_KEY=changeme",
    "TOKEN=placeholder",
    "SECRET=replace-with-your-secret",
    "GHOST_CONTENT_API_KEY=",
  ]) {
    check(`placeholder value stays editable, not masked: ${line}`, !r(line).includes("<vinci-secret>"));
  }
  check(
    "a REAL key under a template-looking name still masks",
    r("STRIPE_SECRET_KEY=sk_live_TESTONLYabcdefghij1234567").includes("<vinci-secret>"),
  );
}

// Regression (#queue/#redaction, 2026-09-06): the same placeholder guard was missing on the one
// channel that fires REAL requests. Observed live: the user pasted a working curl carrying a bearer
// token, the input redactor rewrote it to `Bearer <vinci-secret>` before the model saw it, and the
// model then ran that command for real — a 401 that reads as a broken API, not a masked view. The
// `KEY=<vinci-secret>` shape is worse: the literal placeholder lands in a real process environment.
{
  const { handlers, sent, pi } = harness();
  guard.default(pi);

  // A shell command that reaches the network is confirmed by a LATER rule. Declining that confirm
  // is what makes this control discriminating: with the placeholder rule removed the command is
  // still blocked, just for the wrong reason, so an assertion on the reason is the only thing that
  // can tell the two apart.
  const shellContext = { ...context, ui: { ...context.ui, select: async (_q, options) => options[0] } };

  const maskedRequest = await firstBlock(
    handlers,
    {
      toolName: "bash",
      input: {
        command:
          'curl -X POST https://api.example.com/v1/chat -H "Authorization: Bearer <vinci-secret>" -d @body.json',
      },
    },
    shellContext,
  );
  check("a command that would send the placeholder as a credential is blocked", maskedRequest?.block === true);
  check(
    "the block names the placeholder as the reason, not a generic shell risk",
    /secret-masking placeholder/i.test(String(maskedRequest?.reason ?? "")),
  );
  check(
    "the block explains the request would actually fail rather than be masked",
    /real endpoint|real environment variable/i.test(String(maskedRequest?.reason ?? "")),
  );

  const envAssignment = await firstBlock(
    handlers,
    { toolName: "bash", input: { command: "API_KEY=<vinci-secret> node scripts/deploy.js" } },
    shellContext,
  );
  check("the env-variable shape is covered too", envAssignment?.block === true);

  const privateKeyCommand = await firstBlock(
    handlers,
    { toolName: "bash", input: { command: "ssh -i <(echo '<vinci-private-key>') user@host" } },
    shellContext,
  );
  check("the private-key placeholder is covered on the shell channel too", privateKeyCommand?.block === true);

  // Discriminating control: this must be the placeholder rule answering, not the shell-file-write
  // rule that sits immediately after it. A redirect carrying the placeholder hits both; the reason
  // proves which one fired.
  const placeholderBeatsShellWrite = await firstBlock(
    handlers,
    { toolName: "bash", input: { command: "echo 'API_KEY=<vinci-secret>' > .env" } },
    shellContext,
  );
  check(
    "the placeholder rule answers before the shell-file-write rule, so the reason is actionable",
    /secret-masking placeholder/i.test(String(placeholderBeatsShellWrite?.reason ?? "")),
  );

  const coaching = String(
    sent.find((s) => s.message?.customType === "vinci-masked-command-block")?.message?.content ?? "",
  );
  check(
    "the coaching forbids reveal/reconstruct/obtain and re-smuggling the placeholder",
    /do not attempt to reveal, reconstruct, or otherwise obtain the raw value/i.test(coaching) &&
      /do not retry with the placeholder in a variable, a file, or a heredoc/i.test(coaching),
  );
  check(
    // Positive one-of directive, so a negated mutation ("do not reference the value indirectly")
    // no longer satisfies the assertion.
    "the coaching states the runtime-reference path and the ask-the-user fallback affirmatively",
    /Instead reference the value indirectly so the shell resolves it at runtime[^.]*, or ask the user to run this one command themselves/i.test(
      coaching,
    ),
  );
  check(
    "the coaching does not solicit the secret or name dump tools that bypass the redactor",
    !/paste/i.test(coaching) && !/xxd|hexdump|\bod\b/i.test(coaching),
  );

  // Positive reachability control: the guarded operation is still reachable. A placeholder-free
  // command runs the same path and is not blocked by this rule.
  const cleanCommand = await firstBlock(handlers, { toolName: "bash", input: { command: "echo ok" } }, shellContext);
  check("placeholder-free commands still reach the shell untouched", cleanCommand === undefined);

  const indirectReference = await firstBlock(
    handlers,
    { toolName: "bash", input: { command: 'node -e "console.log(process.env.API_KEY.length)"' } },
    shellContext,
  );
  check("the runtime-reference path the coaching recommends is itself reachable", indirectReference === undefined);
}

console.log(`\nmask-edit-integration: ${pass}/${pass} checks passed (masked content cannot poison edits, clobber real values, or reach a real request)`);
