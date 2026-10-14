# Editable brand source

`generate.py` is the source of truth for the vector assets. It contains the arched door frame, slightly ajar door panel, two knock lines, a small-size optical variant, custom rounded `noknok` lettering, color values, and layout positions. The small-size variant removes the door knob and widens the gaps while retaining both knock lines. English slogan/annotation text is outlined from the bundled Manrope font. Every exported SVG is self-contained and can render without an installed font, JavaScript, network access, or linked images.

The selected direction is **The Knock**: a charcoal arched frame, honey-colored door panel, and two knock lines. The original image-generation output is preserved in `../reference/concept-the-knock.png` (the third image in the original list, labeled `01 / THE KNOCK` within the image). The vector files are a manually drawn interpretation of that concept, rather than a pixel-identical trace. Edit the generator rather than editing generated SVG files independently, so monochrome, reversed, app, and lockup versions keep consistent geometry. Update the copy in both the generator and the brand guide if the slogan changes. The approved English copy is “Knock, knock. Agents talk.”; its Chinese localization is retained in [brand.json](../assets/brand.json); the brand colors are charcoal `#252823`, honey `#D89945`, and ivory `#F7F3EA`.

## Rebuild SVG and brand.json

From the repository root, with Python 3.9 or later:

```sh
python3 -m venv /tmp/noknok-brand-venv
/tmp/noknok-brand-venv/bin/pip install -r docs/brand/source/requirements.txt
/tmp/noknok-brand-venv/bin/python docs/brand/source/generate.py
```

This writes 13 SVG files and `assets/brand.json`. The fixed font file is included, so rebuilding the SVG files does not fetch fonts or use a machine-specific font. The dependency installation above needs package-registry access; generation itself is offline.

## Rebuild PNG

The optional PNG exporter requires Node.js and Sharp. Keep this design-only dependency outside the application's package manifest:

```sh
npm install --prefix /tmp/noknok-brand-render --no-save sharp@0.35.5
pnpm exec tsx docs/brand/source/export-png.ts --sharp /tmp/noknok-brand-render/node_modules/sharp
```

It writes 17 PNG files: a raster counterpart for every SVG, plus 512 px / 192 px app icons and 32 px / 16 px favicons. The main app icon export is 1024 px; the horizontal logo is 2400 × 800 px; the social card is 1200 × 630 px. Transparent SVGs retain transparency in PNG. `favicon.svg` uses the small-size optical variant; do not simply shrink the full logo to 16 px.

All checked-in assets are ready to use; consumers do not need either build tool. PNG byte-level output can vary between Sharp/libvips versions even when the design is unchanged.

## Font provenance and license

- Typeface: Manrope, variable weight font, used for the slogan and social-card descriptor; the export weights are specified in `generate.py`.
- Bundled file: [fonts/Manrope.ttf](fonts/Manrope.ttf), copied unmodified from [`Manrope[wght].ttf` in google/fonts](https://github.com/google/fonts/blob/main/ofl/manrope/Manrope%5Bwght%5D.ttf) on 2026-10-14.
- Font SHA-256: `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`.
- License: [SIL Open Font License 1.1](fonts/OFL.txt), included with the font; trailing whitespace is normalized. The font's license does not change the repository's license.
- The main wordmark is original rounded path lettering, not typeset Manrope; its arched `n` echoes the door frame. Chinese copy is supplied as editable text in the guide and `brand.json`, rather than a font-dependent image.

Original concept PNG SHA-256: `6b449ee5380076e39c28fd02f3fc0584456872a85d463565f9b8f6a8210da40a`.

## Verification for this handoff

Inspect `assets/brand-preview.png`, the light and dark horizontal logos, and the social card after rebuilding. Check 16 px and 32 px favicon exports at native size, including the separation of the two knock lines and the open gap around the door. Inspect the horizontal slogan lockup at its recommended minimum width of 400 px. Verify that SVG files contain accessible titles/descriptions and no external references, the PNG dimensions match the documented sizes, and transparent asset corners remain transparent. Do not change the reference concept image as part of a rebuild.
