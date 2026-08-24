# Step 2 — "Connect to Vinci" pairing (kill the API key + provider picker)

**Goal (George):** no "pick your provider / pick your subscription" menus, no API key to
copy. The user runs Vinci Code, it says *"Connect to Vinci"*, they authorize once in the
browser (one confirm button), and they're in — the token is paired on the back-end.

This is the **OAuth 2.0 Device Authorization Grant** (RFC 8628) — the standard "enter a
code on another device" flow every CLI uses. It reuses Vinci's existing auth spine; almost
nothing new is invented.

## What already exists (so we don't rebuild it)

**Gateway / vinci-chat**
- Dual auth already: the gateway accepts a Bearer `vinci_live_` key **or** a Better Auth
  session — `lib/auth/apikey.ts` + `getSession` in `app/api/v1/chat/completions/route.ts`.
- Key issuance already: `app/api/keys` (+ platform.getsimpledirect.com). Better Auth spine
  shared with vinci-platform.

**Pi / vinci-code**
- Custom providers do OAuth **via an extension** (`/login <provider>`), tokens stored +
  refreshed automatically in `~/.pi/agent/auth.json`. Reference implementation:
  `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/`.
- Vinci is the *only* provider (the launcher pins `--provider vinci`), so Pi's
  provider/subscription picker never appears — that friction is already gone by
  construction. `/login vinci` becomes the single onboarding step.

## The flow

```
  vinci  ──POST /api/v1/device/code──▶  gateway
         ◀── { user_code, verification_uri, device_code, interval, expires_in }
  CLI shows:  "Connect to Vinci → open  vinci.getsimpledirect.com/device  ·  code: WXYZ-1234"
             (opens the browser automatically, code pre-filled)

  user (already signed in to Vinci) clicks  [ Authorize this device ]      ← the one button

  vinci  ──POST /api/v1/device/token (poll)──▶  gateway
         ◀── { access_token }   once authorized   (else authorization_pending)
  → stored in ~/.pi/agent/auth.json; every call now carries it. No key ever shown.
```

## Backend to build (vinci-chat) — 3 small endpoints + 1 page

1. `POST /api/v1/device/code` — mint a `device_code` + short `user_code`, store pending
   (Postgres, TTL ~10 min), return RFC-8628 fields. No auth required.
2. `GET/POST /device` (a page) — behind the normal Better Auth session; shows the code and
   an **Authorize** button. On click, bind the `device_code` to `session.userId`. Reuse
   the existing account UI shell. (This is the confirm/authorize screen George described.)
3. `POST /api/v1/device/token` — the CLI polls `device_code`. Until authorized:
   `{ error: "authorization_pending" }`. Once authorized: **mint a scoped token bound to
   that account** and return it. Simplest: issue a normal `vinci_live_` key via the
   existing `app/api/keys` path (so verification is unchanged — `lib/auth/apikey.ts` just
   works) — labeled "Vinci Code (device)" and revocable from the account. (Cleaner later:
   a real OAuth access+refresh pair; start with the key to ship fast.)

ZDR/security: standard device-flow hygiene — short user_code TTL, one-time exchange,
rate-limit the poll, bind to `session.userId`, device tokens listed + revocable in the
account, log codes/counts only (never content). No new US infra (rule 4).

## CLI to build (vinci-code) — extend `vinci-provider.ts`

- Add the `oauth` block (device-flow variant) or, following gitlab-duo, implement the
  poll in the extension and register the provider without a static `apiKey`.
- On first run with no stored token, Pi prompts `/login vinci`; the extension runs the
  flow above, opens the browser, polls, and writes `auth.json`.
- Drop `apiKey: "$VINCI_API_KEY"` from the provider once the flow works (keep
  `VINCI_API_KEY` as a fallback/CI escape hatch only).
- Optionally a Vinci **preset** (`examples/extensions/preset.ts` pattern) so first-run goes
  straight to "Connect to Vinci" with zero menus.

## Open questions (George / David)
- **Token type:** ship with a minted `vinci_live_` device key (fast, reuses everything) vs.
  a real OAuth access/refresh pair (cleaner rotation). Recommend: key now, OAuth later.
- **Where the page lives:** vinci-chat `/device` vs. platform.getsimpledirect.com (the
  keys/account home). Platform is the more natural home for device management.
- **Free vs. paid gating:** the device token inherits the account's allowance/plan — no
  CLI-specific billing needed.
