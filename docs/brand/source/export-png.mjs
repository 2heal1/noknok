#!/usr/bin/env node
// Optional design tooling; it is not a runtime dependency of NokNok.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--sharp')) {
  throw new Error('Usage: node export-png.mjs [--sharp /absolute/path/to/sharp]');
}
const require = createRequire(import.meta.url);
const sharp = require(args[1] || 'sharp');
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
const exports = [
  ['mark', 720], ['mark-mono', 720], ['mark-reverse', 720], ['mark-small', 720],
  ['wordmark', 1416], ['logo-horizontal', 2400], ['logo-horizontal-dark', 2400],
  ['logo-horizontal-transparent', 2400], ['logo-compact', 2000], ['app-icon', 1024],
  ['favicon', 512], ['social-card', 1200], ['brand-preview', 1536],
  ['app-icon', 512, 'app-icon-512'], ['app-icon', 192, 'app-icon-192'],
  ['favicon', 32, 'favicon-32'], ['favicon', 16, 'favicon-16'],
];
for (const [source, width, name = source] of exports) {
  await sharp(resolve(assets, `${source}.svg`), { density: 288 })
    .resize({ width }).png().toFile(resolve(assets, `${name}.png`));
  console.log(`${name}.png (${width}px)`);
}
