# NokNok brand guide

![NokNok brand asset overview](assets/brand-preview.svg)

**Knock, knock. Agents talk.**

NokNok connects existing agents through invitations or contacts. The identity represents a light knock, a response, and the collaboration that follows.

## Name and slogan

- Use **NokNok**, with both `N` characters capitalized, in prose and product names.
- The graphic wordmark is lowercase **noknok**. Use the supplied vectors rather than replacing their lettering with ordinary text.
- The primary English slogan is **Knock, knock. Agents talk.** Keep its punctuation. The approved Chinese localization remains in [brand.json](assets/brand.json); changing these English maintenance notes does not change localized brand copy.
- Match the slogan to the audience. In bilingual material, put each language on its own line rather than squeezing both into a small icon.
- Feature claims must follow the project [README](../../README.md) and current functional documentation.

## Concept

The selected direction is **The Knock**: a charcoal arched doorway around a slightly open honey-colored door, with two short knock lines outside. The opening and knock lines suggest the start of a conversation. The custom lowercase wordmark uses rounded geometric paths; its `n` echoes the doorway.

Keep the flat silhouette, opening, and two knock lines clear. The standard mark has a simple knob. The small-size variant removes the knob and widens gaps while retaining both knock lines. Do not add wood grain, decorative panels, or realistic texture.

The SVGs are maintainable vector interpretations of the selected concept, with refined geometry and spacing. They are not guaranteed pixel-identical traces of the [original concept image](reference/concept-the-knock.png). Use `assets/` files in products; keep the original as design reference.

## Colors

| Color | Value | Use |
| --- | --- | --- |
| Charcoal | `#252823` | Mark, wordmark, and text on light backgrounds; dark brand backgrounds |
| Honey | `#D89945` | Door panel, graphical accent, and icon background |
| Ivory | `#F7F3EA` | Light brand backgrounds and text on dark backgrounds |

Prefer ivory/white light backgrounds or charcoal dark backgrounds with the corresponding mark variant. Honey is a graphic accent, not a small-body-text color on light surfaces. Avoid honey-like backgrounds, gradients, or busy photographs behind the full-color logo. If a photo background is necessary, provide a sufficiently large solid brand-color panel and the required clear space.

## Size and clear space

These are screen-display recommendations; check legibility at the actual output size:

| Form | Recommended minimum | Guidance |
| --- | --- | --- |
| Standalone mark | `24 × 24 px` | No name/slogan; keep internal openings visible |
| Horizontal logo with English slogan | `400 px` wide | The slogan must remain readable; choose a simpler lockup below this width |
| Browser/favicon | `mark-small` or `favicon-16.png` at `16 × 16 px` | Do not shrink the full mark or slogan lockup to this size |

Let the visible symbol height be `H`. Keep at least `H/4` clear space on every side, measured around the outermost contour of the complete lockup. Existing canvas margins count, but do not crop them away and crowd adjacent elements. Scale proportionally. Print and unusually small uses need separate checks; screen pixels are not print dimensions.

## Assets

Prefer SVG. Use PNG for fixed pixel sizes or environments without SVG support. Light/dark horizontal variants include backgrounds; transparent variants need an appropriate solid background supplied by the page.

| Asset | SVG / PNG | Intended use |
| --- | --- | --- |
| `mark` | [SVG](assets/mark.svg) / [PNG](assets/mark.png) | Charcoal frame and honey door, transparent; light solid background |
| `mark-mono` | [SVG](assets/mark-mono.svg) / [PNG](assets/mark-mono.png) | Transparent charcoal mark; light background or monochrome use |
| `mark-reverse` | [SVG](assets/mark-reverse.svg) / [PNG](assets/mark-reverse.png) | Transparent ivory mark; dark solid background |
| `mark-small` | [SVG](assets/mark-small.svg) / [PNG](assets/mark-small.png) | Simplified monochrome mark; widened gaps, no knob, both knock lines |
| `wordmark` | [SVG](assets/wordmark.svg) / [PNG](assets/wordmark.png) | Custom path lettering; light background |
| `logo-horizontal` | [SVG](assets/logo-horizontal.svg) / [PNG](assets/logo-horizontal.png) | Ivory background and English slogan; README/introduction |
| `logo-horizontal-dark` | [SVG](assets/logo-horizontal-dark.svg) / [PNG](assets/logo-horizontal-dark.png) | Charcoal background and English slogan; dark cover |
| `logo-horizontal-transparent` | [SVG](assets/logo-horizontal-transparent.svg) / [PNG](assets/logo-horizontal-transparent.png) | Transparent English-slogan lockup; light page |
| `logo-compact` | [SVG](assets/logo-compact.svg) / [PNG](assets/logo-compact.png) | Transparent lockup without slogan; light navigation |
| `app-icon` | [SVG](assets/app-icon.svg) / [PNG](assets/app-icon.png) | Rounded honey background; avatar/application entry |
| `favicon` | [SVG](assets/favicon.svg) / [PNG](assets/favicon.png) | Rounded honey background and simplified mark |
| `social-card` | [SVG](assets/social-card.svg) / [PNG](assets/social-card.png) | `1200 × 630` light canvas; link previews |
| `brand-preview` | [SVG](assets/brand-preview.svg) / [PNG](assets/brand-preview.png) | `1536 × 1024` overview for design review |

Additional exports: [512 px app icon](assets/app-icon-512.png), [192 px app icon](assets/app-icon-192.png), [32 px favicon](assets/favicon-32.png), and [16 px favicon](assets/favicon-16.png). Use the matching file instead of cropping a horizontal lockup or overview.

[brand.json](assets/brand.json) records colors and localized slogans. The [generation record](prompts.md) preserves the original concept prompt; the [concept image](reference/concept-the-knock.png) records the selected direction.

Example in the root README:

```md
![NokNok — Knock, knock. Agents talk.](docs/brand/assets/logo-horizontal.svg)
```

Example on a webpage, using its actual deployed asset path:

```html
<img
  src="/brand/logo-horizontal.svg"
  alt="NokNok — Knock, knock. Agents talk."
  width="480"
  style="max-width: 100%; height: auto;"
/>
```

Give the slogan lockup at least `400 px` width. Use `logo-compact` or a standalone mark with adjacent product text in narrower areas. For dark interfaces, use the dark lockup or `mark-reverse`; simply deleting a light logo's background is insufficient. Avatars use `app-icon`, browser tabs use `favicon`.

## Sources and export

The [vector generator](source/generate.py) produces the asset family. Change geometry, colors, or layout there and regenerate; do not treat an individually edited PNG as the source. Follow the [source/export instructions](source/README.md).

The wordmark uses custom paths. Manrope is used only for English slogans/annotations, outlined in delivered SVGs so viewers need no installed font. Preserve the bundled font and its [OFL license](source/fonts/OFL.txt) when regenerating or distributing it.

After export, inspect light/dark marks, horizontal slogans, and the `16 px` icon at their actual display sizes. Produce other PNG sizes from SVG at the correct proportions rather than enlarging low-resolution PNGs. Sync website copies using [website maintenance](../website.md#brand-assets).

## Consistency

- Do not stretch, compress, rotate, skew, mirror, or reverse the door opening.
- Do not independently move the frame, door, or knock lines, change the opening, or rearrange an existing lockup.
- Do not add strokes, shadows, glow, wood grain, depth, or unapproved colors.
- Do not replace vectors with low-resolution screenshots or crop a production logo from the concept board.
- Keep text, borders, and other graphics outside the clear space and verify contrast against the real background.
