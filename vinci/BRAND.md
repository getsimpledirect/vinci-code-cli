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

The everyday `vinci-header.ts` header reserves a fixed compact slot for Vero beside the
Vinci identity and context. Image-capable terminals use the original PNG artwork on a
neutral cream surface with its aspect ratio preserved. The optional `VINCI_HERO_HEADER=1`
view retains the maker's mark and uses rich idle Vero. The ordinary view uses pixel Vero.

[`assets/vero/manifest.json`](assets/vero/manifest.json) retains the approved marketing
source commit, archive and guide hashes, and the original PNG/SVG hashes. Reimport with
`node vinci/scripts/import-vero-assets.mjs --source <Vero-folder> --approved-manifest <manifest.json>`.
Use the marketing manifest at its recorded commit. Do not redraw, stretch, recolour,
invert, add effects, or invent poses. A raster-to-cell or ASCII adaptation needs brand
approval; the supplied terminal integration uses readable text when images are unavailable.

Vero reflects activity, not proof: working means activity; review means checking or a
human decision; blocked means an observed blocker; done means completed activity. The
receipt carries the evidence. `DONE-UNVERIFIED`, `WAITING` and `BLOCKED` remain explicit.
The poses do not certify verification, approval, safety or security.

`VINCI_REDUCED_MOTION=1` keeps a static activity indicator. `NO_COLOR`, `TERM=dumb`,
`VINCI_PLAIN=1` and `VINCI_SCREEN_READER=1` select the compact text header and disable
decorative images and the pulse. Non-TUI output, transcripts, copied responses and exports
do not contain this presentation artwork.

## Voice

"Made, not generated." Warm, quiet confidence; craftsmanship over hype; honest over
agreeable. The coding voice lives in [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) and,
authoritatively, in the server-side character layer (vinci-chat).

## Fonts

The supplied Vinci style guide specifies **Geist Sans** for UI, body and display copy,
and **Geist Mono** for monospace copy. Use the original wordmark artwork. A terminal uses
the user's own monospace font; these fonts are not bundled here.
