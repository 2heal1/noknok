# Editable brand source

`generate.py` is the source of truth for the vector assets. It contains the two doorway paths, a small-size optical variant, custom geometric `noknok` lettering, color values, and layout positions. English slogan/annotation text is outlined from the bundled Manrope font. Every exported SVG is self-contained and can render without an installed font, JavaScript, network access, or linked images.

The original image-generation output is preserved in `../reference/concept-03.png`; the vector files are a manually drawn interpretation of that selected direction. Edit the generator rather than editing generated SVG files independently, so monochrome, reversed, app, and lockup versions keep consistent geometry. Update the copy in both the generator and the brand guide if the slogan changes.

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
node docs/brand/source/export-png.mjs --sharp /tmp/noknok-brand-render/node_modules/sharp
```

It writes 17 PNG files: a raster counterpart for every SVG, plus 512 px / 192 px app icons and 32 px / 16 px favicons. The main app icon export is 1024 px; the horizontal logo is 2400 × 800 px; the social card is 1200 × 630 px. Transparent SVGs retain transparency in PNG. `favicon.svg` uses the small-size optical variant; do not simply shrink the full logo to 16 px.

All checked-in assets are ready to use; consumers do not need either build tool. PNG byte-level output can vary between Sharp/libvips versions even when the design is unchanged.

## Font provenance and license

- Typeface: Manrope, variable weight font, used at weight 500 for the slogan and 600 for the social-card descriptor.
- Bundled file: [fonts/Manrope.ttf](fonts/Manrope.ttf), copied unmodified from [`Manrope[wght].ttf` in google/fonts](https://github.com/google/fonts/blob/main/ofl/manrope/Manrope%5Bwght%5D.ttf) on 2026-10-14.
- Font SHA-256: `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`.
- License: [SIL Open Font License 1.1](fonts/OFL.txt), included with the font; trailing whitespace is normalized. The font's license does not change the repository's license.
- The main wordmark is original geometric path lettering, not typeset Manrope. Chinese copy is supplied as editable text in the guide and `brand.json`, rather than a font-dependent image.

Original concept PNG SHA-256: `207a11c6a646904353d55b97ce9de5d62ed4b61da398886c3be46c6ac1258e78`.

## Verification for this handoff

Inspect `assets/brand-preview.png`, the light and dark horizontal logos, and the social card after rebuilding. Check 16 px and 32 px favicon exports at native size. Verify that SVG files contain accessible titles/descriptions and no external references, the PNG dimensions match the documented sizes, and transparent asset corners remain transparent. Do not change the reference concept image as part of a rebuild.
