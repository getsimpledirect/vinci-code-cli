# Where your data goes

Written for Vinci Code specifically, and written to be checkable — every claim below
names the file that implements it, so you can verify rather than trust.

Vinci Code runs in one of two modes. **They differ substantially, and the difference
is the point of this document.**

## The short version

| | **Direct / BYOK** | **Managed** |
|---|---|---|
| Vinci account required | **no** | yes |
| Your prompts go to | **the provider you chose, directly** | Vinci's gateway, then a provider Vinci selects |
| Your provider key | stored on your machine; sent **only to the provider you chose**, never to Vinci | none — you have no provider key |
| Vinci can see your prompts | **no** | yes, in transit through the gateway |
| Usage metered by Vinci | no | yes |
| Guard, receipts, checkpoints, review | **yes — identical** | yes |

**Vinci account sign-in is the default.** `/login` opens Vinci pairing directly. To use your own
provider, run `/providers`, confirm enabling other providers, then use `/login`. No Vinci account
is required for BYOK. The preference persists globally; `showOtherProviders: true` or
`VINCI_SHOW_OTHER_PROVIDERS=1` also opts in. The environment overrides the saved setting in either direction.

## Managed mode

Your messages go to `https://vinci.getsimpledirect.com/api/v1`, which selects and
calls a model provider on your behalf, meters usage against your account, and returns
the result. Sign-in is device pairing — no key to paste
(`vinci/extensions/vinci-provider.ts`).

In this mode **Vinci is in the path** and necessarily processes your prompts to serve
them. That is what the managed service is.

## Direct / BYOK mode

You supply your own provider credential. After opting in through `/providers`, `/login` presents the providers Pi supports,
and the credential is stored by Pi in `~/.pi/agent/auth.json` on your machine. Vinci
Code adds **no second credential store**. Your key is transmitted to the provider you chose —
authenticating to them requires sending it — and to nobody else. Requests go from your machine
straight to that provider; Vinci is not in the path.

**In this mode Vinci's servers are outside the inference path.** Public model catalogue
discovery and optional update checks are separate outbound calls, described below. Your
relationship for retention and training is with the provider you chose, under their terms.

## Public model details

Opening `/model` in Vinci mode lazily attempts a public `GET <platform>/api/models`, at most
once per process, with a timeout of 1500 ms. The platform base comes from the existing links
module (`VINCI_PLATFORM_URL` override). This request sends no credentials, provider keys,
conversation content or repository content. It supplies the picker labels and underlying model
details, including when BYOK is enabled. The result is kept only in memory; failure shows plain
Vinci names and "model details unavailable offline". Implementation:
`vinci/extensions/lib/model-catalogue.ts` and `model-selector.ts`.

## What stays local in BOTH modes

Verified as network-free: the command guard (`vinci-guard.ts`), receipts
(`vinci-receipt.ts`, `vinci-completion-receipt.ts`), checkpoints
(`vinci-checkpoint.ts`), review/accept (`vinci-accept.ts`), and usage accounting
(`extensions/lib/usage-accumulator.ts`). Choosing BYOK does not cost you the features
that make this distribution worth using.

## What leaves your machine only when you ask

- **`/feedback`** posts to Vinci. **`/issue`** opens a GitHub issue. Both run your
  content through `redactSecrets()` first (`vinci/extensions/lib/secrets.ts`), but
  both send your text, so read what you are sending.
- **Update checks** fetch a release manifest. Disable with `PI_OFFLINE=1`.
- **Tool bootstrap** fetches `fd` and `ripgrep` from GitHub Releases on first run.
  Disable with `VINCI_TOOL_BOOTSTRAP=0`.

## Secret redaction, and its limits

Credentials are masked before reaching the terminal, edit diffs, write previews, model
prose, print mode, and the `/feedback` and `/issue` payloads. Covered formats are
listed in `packages/coding-agent/src/core/vinci-mask-secrets.ts` and include Anthropic,
OpenAI, OpenRouter, Groq, Hugging Face, AWS, GitHub, GitLab, Slack, Stripe and others.

🔴 **Two limits worth stating plainly:**

1. **Normal prompt input and tool results are masked before the session transcript is written.**
   The `!` shell shortcut is recorded outside those hooks, and large `bash` output can spill raw
   to `$TMPDIR/pi-bash-*.log` before masking runs. Anything the patterns miss is also stored
   verbatim, as are sessions recorded before this was in place. Treat both the temporary spill
   files and `~/.pi/agent/sessions/` as sensitive; delete records you do not need.
2. **It is pattern-based.** A credential with no distinctive shape — a bare password,
   an internal hostname — will not be recognised. If you find a format it misses,
   that is a security report ([`SECURITY.md`](../SECURITY.md)); please send the *format*, not a
   live key.

## Telemetry

There is no analytics or telemetry beacon in the Vinci layer. Managed mode meters
usage against your account, because that is how it bills. BYOK mode meters nothing,
because there is nothing to meter.
