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
| `assets/vinci-logo-lockup.png` | light ink | the terminal header — terminals are dark |

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
error `#E07A6E`/`#B5483C`, warning `#D9B48A`/`#9A6B1E` (dark/light).

## Terminal header

The `vinci-header.ts` extension draws the aperture mark + `vinci code` lockup in sage.
It's an approximation of the 12-petal logomark at terminal scale — a starting point;
refine the glyphs against `assets/logomark.svg`.

## Voice

"Made, not generated." Warm, quiet confidence; craftsmanship over hype; honest over
agreeable. The coding voice lives in [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) and,
authoritatively, in the server-side character layer (vinci-chat).

## Fonts

The brand type is **Fraunces** (wordmark serif) / **Newsreader** (reading serif) /
**Geist** + **Geist Mono** (UI/mono) — all open-source (Google Fonts). A terminal uses
the user's own monospace font, so fonts don't apply to the TUI; they matter for the docs
site, marketing, and any rendered output. Not bundled here.
