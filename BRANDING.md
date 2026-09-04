# Branding

The Lyraflow marks, colours and type, and the rules for using them. If you are
adding a header, favicon, social card or docs theme, everything you need is in
[`brand/`](brand/) — please use it rather than drawing something new.

## The files

| File | Use it for |
| --- | --- |
| `brand/mark.svg` | The mark alone. Favicon, avatar, anywhere the name is already present. |
| `brand/wordmark.svg` | "Lyraflow" set as outlines, no mark. |
| `brand/lockup.svg` | Mark and wordmark together. **The default choice.** |
| `brand/lockup-light.svg`, `brand/lockup-dark.svg` | The same lockup with its colour baked in. Use these, and only these, where CSS cannot reach the SVG. |
| `brand/favicon.svg` | The mark with tighter padding, tuned for a browser tab. |
| `brand/avatar-light.svg`, `-dark.svg`, `-accent.svg` | Square, with a background. Social profiles. |
| `brand/social-card-light.svg`, `-dark.svg` | 1280×640 preview card for links. |
| `brand/*.png` | The same avatars and social cards as raster. For the places that refuse SVG — GitHub's avatar and social-preview uploads are both raster-only, and so are most `og:image` consumers. |
| `brand/tokens.css`, `brand/tokens.json` | Every colour and type token, both modes. |
| `brand/contrast-report.txt` | The measured contrast ratio of every pairing. |

`mark.svg`, `wordmark.svg` and `lockup.svg` use `currentColor`, so one file
themes correctly in both modes — set `color` and they follow.

The `-light` / `-dark` pair exists because that trick fails in one specific
place: an SVG loaded through `<img>` gets its own document with no cascade from
the host page, so `currentColor` falls back to black and the mark disappears on
a dark background. A GitHub README is exactly this case. Pick the pair with
`<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
  <img src="brand/lockup-light.svg" alt="Lyraflow" width="200">
</picture>
```

Anywhere CSS *does* reach — a web page, an inlined SVG — use `lockup.svg` and
set the colour yourself. Do not add further colour variants.

## The mark

The five brightest stars of the constellation Lyra: Vega, Sulafat, Sheliak,
Delta and Zeta. The positions are not drawn by eye — they are real J2000
coordinates, projected the way a star atlas projects them, then rotated 15° so
the figure sits near-square. The proportions are reproducible from the
catalogue.

Vega is the large node at the top right. It is the anchor, and the figure has
no hierarchy without it.

**Rules:**

- **Do not add a sixth star.** Five is the selection rule, not a reduction to be
  undone at large sizes. Epsilon is the sixth brightest and is deliberately out.
- **Do not re-space the stars or straighten the parallelogram.** The geometry is
  a fact about the sky and it is checkable.
- **One mark at every size.** There is no simplified small variant.
- **Minimum clear space:** the diameter of Vega's node, on all four sides.
- **Do not set the mark on a photograph, a gradient, or a picture of a night
  sky.** The reference is a printed star atlas — drawn and precise.
- Do not stretch, rotate, outline, add effects to, or recolour it beyond setting
  a single `color`.

## Colour

**There is no single Lyraflow hex, and asking for one has no good answer.** The
accent is a different step of the same copper ramp in each mode, because no one
value clears WCAG AA against both a paper surface and an ink one. Shipping a
single value would mean shipping a failing pairing in one mode.

| Role | Light | Dark |
| --- | --- | --- |
| `surface` | `#FBFAF7` | `#121110` |
| `text` | `#121110` | `#F2F0EC` |
| `text-muted` | `#5F5A52` | `#A9A398` |
| `accent` | `#8C4421` | `#DDA07F` |
| `border-interactive` | `#807A70` | `#807A70` |

Take values from `brand/tokens.css` or `brand/tokens.json` rather than from this
table, which is a summary. Full ramps and semantic colours are in the tokens.

Every pairing in `brand/contrast-report.txt` carries a measured ratio. If you
introduce a new pairing, measure it — do not estimate it.

### Alternative accents in the product

The web UI can be switched, per browser, to one of six other accents — cobalt,
moss, plum, slate, wine and amber. Each is the copper ramp with its hue swapped
and its lightness held step for step, so the funnel chart's ordinal ramp keeps
its lightness gaps and every text pairing lands close to copper's — close, not
equal, which is why each palette is measured again in both modes; the ratios
are in `contrast-report.txt` under each palette's name, and the values are in
`tokens.css` as `[data-palette="…"]` blocks and in `tokens.json` under
`palettes`.

**They are for an operator's own instance, not for Lyraflow.** Copper is the
identity and the default. Do not represent Lyraflow — in a screenshot, a
listing, a talk — in any of the other six. The alternatives exist so that a
self-hoster can make their own deployment look like their own; they are not a
second brand.

## Type

**IBM Plex Sans** and **IBM Plex Mono**, both under the SIL Open Font License
1.1. That licence is a hard requirement, not a preference: you embed these fonts
into your own deployment when you self-host, and a commercial licence would make
that your legal problem.

The wordmark is set in IBM Plex Sans SemiBold with hand-adjusted spacing, and is
emitted as outlines, so the lockups carry no font dependency at all.

## The name

**Lyraflow.** One word, one capital. Not "LyraFlow", not "Lyra Flow", not
"lyraflow" mid-sentence.

Lyraflow is **fair-code** or **source-available**. It is never "open source" —
the Sustainable Use License is not OSI-approved, so the phrase is a factual
error about the licence rather than a matter of style. See [`LICENSE.md`](LICENSE.md).

## Using the marks yourself

You may use the Lyraflow name and marks to refer to Lyraflow: in a blog post, a
talk, a comparison, an integration listing, or a "works with Lyraflow" note. No
permission needed, and that includes writing critically about it.

Please do not use them as the identity of your own product or service, modify
them and keep calling them Lyraflow, or use them in a way that suggests Lyraflow
endorses or maintains something it does not. The Sustainable Use License covers
the source; it does not grant rights to the marks.

If you are self-hosting and want to re-brand your own deployment, that is fine —
replace the assets. The request is only that a modified mark not travel under
the Lyraflow name.

## Known limits

Stated so nobody rediscovers them the hard way:

- **16px is workable, not comfortable.** Stroke weight was tuned against the
  16px and 96px cases together, so neither is optimal alone. If the favicon
  disappoints in a real tab strip, the lever is stroke weight, not fewer stars.
- **The wordmark is set, not drawn.** It is carefully spaced, but it is not
  distinctive on its own and leans on the mark to carry recognition.
- **Copper's dark-mode step is pale.** `#DDA07F` clears contrast comfortably but
  reads closer to sand than to copper.
- **A palette can sit next to a status colour.** Cobalt is near `info`, moss
  near `success`, wine near `danger`, amber near `warning`. The status colours
  do not move per palette — they appear in three places and never beside an
  accent fill — so in those palettes the accent and one status colour are
  close relatives. Deliberate; noted so it is not reported as an oversight.

## These files are generated

Everything in `brand/` is output from a build script, including the geometry and
the contrast report. **Edits made directly to these files will be overwritten on
the next rebuild.** If something needs to change, please open an issue rather
than patching the asset.
