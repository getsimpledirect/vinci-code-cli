# Vinci brand — quick reference

Full guide: the official **Brand Style Guide** (Concept "Made, Not Generated"). Assets in
[`assets/`](assets/): the 12-segment aperture **logomark**, the serif **wordmark**
(`vinci`), and the **palette**.

## Which asset file to use

Every mark ships in two inks, taken byte-for-byte from the official kit. **Pick by the
background you are placing it on, not by your own theme.**

| File | Ink | Use on |
|---|---|---|
| `assets/logomark.svg` | `#14161a` | light backgrounds |
| `assets/logomark-inverse.svg` | `#f7f7f7` | dark backgrounds |
| `assets/logo-lockup.svg` | `#14161a` | light backgrounds |
| `assets/logo-lockup-inverse.svg` | `#f7f7f7` | dark backgrounds |
| `assets/vinci-logo-lockup.png` | light ink | dark backgrounds |

For anything rendered in **both** themes — a README, a docs page — use a `<picture>` with a
`prefers-color-scheme` source rather than picking one and hoping. The root `README.md` does
this; copy that pattern.

> A correction worth recording: `logo-lockup.svg` previously held the **light-ink** artwork
> under the default name, so placing it on a light background produced an invisible logo.
> Both files now match the kit and the names say which ink they carry.

## Palette (authoritative hex, from the kit)

| Token | Hex | Use |
|---|---|---|
| Sage (accent) | `#B8C5B0` | primary accent — the brand color; links, selection, the mark |
| Sage deep | `#586B48` | accent **text** on light backgrounds (sage is too light for small text) |
| Ink | `#14161A` | darkest — dark-mode base |
| Surface | `#262626` | dark gray — cards / raised surfaces |
| Cream | `#F4F1EC` | foreground on dark / light-mode base |
| Off-white | `#F7F7F7` | hairlines, light-on-dark accents |
| Muted (dark) | `#A3A39C` | secondary text on dark |
| Border (dark) | `#383838` | borders on dark |
| Border (light) | `#E2DED4` | borders on light |

Semantic (chosen to sit with the palette, not fight it): success `#9CBE8F`/`#4E7A3F`,
error `#E07A6E`/`#B5483C`, warning `#D9B48A`/`#8A5E12` (dark/light).

## Terminal header

The header displays **Vinci Code** in the terminal's font, followed by the version,
project and model, connection status and command hints. The composer border shows the
current work state. `VINCI_ASCII=1`, `TERM=linux` and non-UTF-8 locales select ASCII
punctuation and borders.

The welcome reads an explicit-disable check, not the default getter. It offers
`Use my own API key` unless `VINCI_SHOW_OTHER_PROVIDERS` is set to a value other
than `1`, or the variable is unset and the saved `showOtherProviders` setting is
`false`. The environment wins over the saved setting.

[`assets/vero/manifest.json`](assets/vero/manifest.json) retains the approved marketing
source commit, archive and guide hashes, and the original PNG/SVG hashes. Reimport with
`node vinci/scripts/import-vero-assets.mjs --source <Vero-folder> --approved-manifest <manifest.json>`.
Use the marketing manifest at its recorded commit. Do not redraw, stretch, recolour,
invert, add effects, or invent poses. A raster-to-cell or ASCII adaptation needs brand
approval.

The composer shows `Thinking` during work and `Thinking - Checking...` during observed
checks. It shows `Waiting for you` or `Needs your OK` when input is needed, `Blocked`
for an observed blocker, and `Done` or `Not sure` for the recorded outcome. The receipt
carries the evidence.
The receipt and `/usage` call `WAITING` “Waiting for you” and `BLOCKED` “Stopped — needs you”.
`WAITING` is a needed decision without an unresolved required operation. Required work that
remains refused or failed is `BLOCKED`, even when the final reply asks for a go-ahead.

`NO_COLOR` (including an empty value) and `--no-color` remove colour only. The
interactive layout and motion settings still apply.

`TERM=dumb`, `VINCI_PLAIN=1` and `VINCI_SCREEN_READER=1` use append-only plain text
in interactive sessions. Non-TTY streams, `-p`/`--print`, JSON and RPC use their
requested output without startup decoration or escape bytes.

`VINCI_REDUCED_MOTION=1` and enabled `CI` keep the rich activity mark steady, even
with a PTY. CI is enabled when its trimmed, case-insensitive value is anything other
than empty, `0`, `false`, `no` or `off`. Plain and non-TTY output have no animation.

## Voice

"Made, not generated." Warm, quiet confidence; craftsmanship over hype; honest over
agreeable. The coding voice lives in [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) and,
authoritatively, in the server-side character layer (vinci-chat).

## Fonts

The supplied Vinci style guide specifies **Geist Sans** for UI, body and display copy,
and **Geist Mono** for monospace copy. Use the original wordmark artwork. A terminal uses
the user's own monospace font; these fonts are not bundled here.
