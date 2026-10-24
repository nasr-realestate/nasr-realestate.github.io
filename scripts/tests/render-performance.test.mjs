// Safety checks for the rendering work (not a substitute for browser/PSI runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Cairo files and license match the pinned Fontsource package', () => {
  execFileSync(process.execPath, ['scripts/fonts/build-cairo.mjs', '--check'], { cwd: root, stdio: 'pipe' });
  const css = read('assets/css/cairo.css');
  for (const weight of [400, 600, 700, 900]) assert.ok(css.includes(`font-weight: ${weight}`));
  assert.match(css, /font-display: swap/);
  assert.match(css, /unicode-range:/);
  assert.doesNotMatch(css, /https?:/); // CSS cannot introduce a third-party request.
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
    const file = path.resolve(root, 'assets/css', m[1]);
    const font = fs.readFileSync(file);
    assert.equal(font.subarray(0, 4).toString(), 'wOF2', `Invalid woff2: ${file}`);
  }
  assert.match(read('assets/fonts/Cairo-OFL.txt'), /SIL OPEN FONT LICENSE/);
});

test('Every font entry point is self-hosted; agent does not duplicate layout links', () => {
  for (const file of ['_layouts/default.html', '_layouts/app.html', 'agent.html',
    'luxury-gallery.html', 'tools/valuation.html', 'og-generator.html']) {
    assert.doesNotMatch(read(file), /https:\/\/fonts\.(googleapis|gstatic)\.com/);
  }
  assert.match(read('_layouts/default.html'), /include cairo.html/);
  assert.match(read('_layouts/app.html'), /include cairo.html/);
  assert.doesNotMatch(read('agent.html'), /<link[^>]+(?:cairo\.css|fa-subset\.css)/);
  const head = read('_includes/cairo.html');
  assert.match(head, /as="font" type="font\/woff2" crossorigin/);
  assert.match(head, /cairo-arabic-400-normal\.woff2/);
});

test('Shared contact pulses animate only transform and opacity, not shadow', () => {
  const css = read('assets/css/style.css');
  assert.doesNotMatch(css, /animation:\s*(?:agentPulse|ppWaPulse|rqWaPulse)\b/);
  const ring = css.match(/@keyframes contactRing\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(ring);
  assert.doesNotMatch(ring, /(?:shadow|filter|width|height):/);
  assert.match(ring, /transform:/);
  assert.match(ring, /opacity:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*contactRing|contactRing[\s\S]*@media \(prefers-reduced-motion: reduce\)/);
});

test('Off-screen rendering is progressive and printing restores all content', () => {
  const css = read('assets/css/style.css');
  assert.match(css, /@supports \(content-visibility: auto\)/);
  assert.match(css, /contain-intrinsic-size: auto 900px/);
  assert.match(css, /@media print\s*\{[\s\S]*content-visibility: visible/);
  // All listing copy stays server-rendered, not moved behind JS placeholders.
  assert.match(read('index.html'), /for slug in site.data.listing_facets.catalog.order limit: 6/);
  assert.match(read('_layouts/property_page.html'), /\{\{ safe_content \}\}/);
});

test('css:check checks the full fallback stylesheet as well as route files', () => {
  execFileSync(process.execPath, ['scripts/build-css.mjs', '--check'], { cwd: root, stdio: 'pipe' });
  const build = read('scripts/build-css.mjs');
  assert.match(build, /stale.push\('style.min.css'\)/);
});

test('Mixed shared/scoped reduced-motion rule is retained in the home bundle', () => {
  const css = read('assets/css/route-home.min.css');
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.agent-float-btn::after[^}]*animation:none/);
});
