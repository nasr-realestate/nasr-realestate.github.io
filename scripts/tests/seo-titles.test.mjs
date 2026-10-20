// Tests: عناوين الصفحات (2026-10-20)
// jekyll-seo-tag يُلحق « | site.title » بكل عنوان، ويحذف «|» من داخل العناوين:
// «شقق للبيع | سمسار طلبك | 0114…» كانت تظهر «شقق للبيع سمسار طلبك 0114… | سمسار طلبك طارق طنطاوي».
// node --test scripts/tests/seo-titles.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from '../lib/front-matter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function pagesWithTitles() {
  const files = execFileSync('git', ['ls-files', '*.html', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!raw.startsWith('---')) continue;
    const { data } = parseFrontMatter(raw);
    if (data && data.title) out.push({ f, title: String(data.title) });
  }
  return out;
}

test('اسم الموقع بلا «|» (يُحذف ويُلصق الاسمان)', () => {
  const cfg = fs.readFileSync(path.join(ROOT, '_config.yml'), 'utf8');
  const m = cfg.match(/^title:\s*"([^"]+)"/m);
  assert.ok(m);
  assert.doesNotMatch(m[1], /\|/);
});

test('عناوين الصفحات: بلا «|» وبلا تكرار اسم العلامة (يُلحقه jekyll-seo-tag)', () => {
  const pages = pagesWithTitles();
  assert.ok(pages.length > 100, `${pages.length}`);
  const bad = pages.filter((p) => /\|/.test(p.title) || p.title.includes('سمسار طلبك'));
  assert.deepEqual(bad, []);
});

test('الرئيسية: العنوان يذكر مدينة نصر والبيع والإيجار، والوصف بلا رموز تعبيرية', () => {
  const { data } = parseFrontMatter(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  assert.match(String(data.title), /مدينة نصر/);
  assert.match(String(data.title), /للبيع والإيجار/);
  assert.doesNotMatch(String(data.description), /\p{Extended_Pictographic}/u);
  assert.ok(String(data.description).length <= 170, `${String(data.description).length}`);
});
