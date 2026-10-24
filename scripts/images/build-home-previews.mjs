#!/usr/bin/env node
// Optional build-time 400px variants for the five supporting home cards. Original images
// and 800px cards are untouched; high-density mobile screens keep the 800px src.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const facets = JSON.parse(fs.readFileSync(path.join(root, '_data/listing_facets.json'), 'utf8'));
const targetDir = path.join(root, 'assets/img/home-previews');
fs.mkdirSync(targetDir, { recursive: true });
const manifest = {};
// The first card shares the hero URL; reuse its cached 800px image.
for (const slug of facets.catalog.order.slice(1, 6)) {
  const src = facets.listings[slug].card_image;
  if (!src) continue;
  const source = path.join(root, src.replace(/^\//, ''));
  const width = Number(execFileSync('identify', ['-format', '%w', source], { encoding: 'utf8' }));
  if (width < 800) continue; // Fallback to the original src if no useful variant.
  const dest = path.join(targetDir, path.basename(src));
  if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(source).mtimeMs) {
    execFileSync('convert', [source, '-resize', '400x', '-strip', '-quality', '80', dest]);
  }
  manifest[src] = { src: `/assets/img/home-previews/${path.basename(src)}`, original_width: width };
}
fs.writeFileSync(path.join(root, '_data/home_previews.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Home previews: ${Object.keys(manifest).length}`);
