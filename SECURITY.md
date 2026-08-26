# Reporting a security issue in Vinci Code

This covers the **Vinci layer** — everything under `vinci/`, plus the Vinci-specific
changes inside `packages/`. For issues in upstream Pi itself, see
[`vinci/UPSTREAM-SECURITY.md`](vinci/UPSTREAM-SECURITY.md), which is Pi's own policy.

If you are not sure which applies, report it here. We would rather receive a
misrouted report than none.

## How to report

- Open a private report through **GitHub Security Advisories** on this repository, or
- Email **security@getsimpledirect.com**

Please do **not** open a public issue for a security-sensitive report.

Include what you need to make it reproducible: version (`vinci --version`), OS, the
steps, and what you expected instead. If a proof of concept involves a credential,
describe it — do not paste the credential itself.

## What we will do

We aim to acknowledge within **3 business days** and to give an initial assessment
within **10**. We will tell you plainly whether we consider it in scope, and we will
credit you in the advisory unless you ask us not to.

We are a small team. If a fix will take a while, we would rather say so than go quiet.

## Supported versions

Only the **latest released version** receives security fixes. There is no long-term
support branch. If you are pinned to an older version, the remedy is to upgrade.

## Especially in scope

Vinci Code executes commands and edits files on your machine, and can hold provider
credentials. The areas where a bug matters most:

- **Secret leakage.** `packages/coding-agent/src/core/vinci-mask-secrets.ts` redacts
  credentials before they reach the terminal, edit diffs, write previews, model prose,
  print mode, and — importantly — before `/feedback` and `/issue` send anything off
  your machine. A credential format it fails to recognise, or a sink it does not
  cover, is a real finding. **Report the format, never a live key.**
- **Guard bypass.** `vinci/extensions/vinci-guard.ts` classifies destructive commands
  and requires confirmation. A phrasing that slips a destructive command past it is in
  scope.
- **Sandbox escape.** `packages/coding-agent/src/core/vinci-sandbox.ts`.
- **BYOK credential handling.** With `showOtherProviders` enabled, your provider key
  is used locally and stored by Pi in `~/.pi/agent/auth.json`. Anything that causes it
  to be transmitted somewhere it should not be — including to Vinci — is in scope.

## Known limitations, so you do not spend time on them

These are understood and documented, not undiscovered:

- **Normal prompt input and tool results are masked before the session transcript is written.**
  The `!` shell shortcut is recorded outside those hooks, and large `bash` output can spill raw
  to `$TMPDIR/pi-bash-*.log` before masking runs. A credential the patterns do not match is also
  stored verbatim, as are sessions recorded before this existed. Treat both the temporary spill
  files and `~/.pi/agent/sessions/` as sensitive.
- **The masker is pattern-based** and cannot recognise a credential with no
  distinctive shape — a bare password, an internal hostname, a customer name. Its
  covered formats are listed in `vinci-mask-secrets.ts`.
- **An agent that runs commands can do what you can do.** Prompt injection from
  untrusted file or web content is a real risk class. The guard reduces blast radius;
  it does not eliminate it. Do not point it at content you do not trust and then
  approve actions without reading them.

## Out of scope

Vulnerabilities in your own shell, editor, dotfiles or MCP servers, unless the report
shows how Vinci Code itself grants the access. Also out of scope: findings that
require an attacker who already has local code execution as your user.
