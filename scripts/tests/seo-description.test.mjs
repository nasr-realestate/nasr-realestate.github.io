// Tests: meta_description → <head> + API (المحور د) + وسوم agent.html
// لا يشغّل Jekyll: يفحص المصدر الذي يقرأه jekyll-seo-tag والمولّد، والمخرجات
// المولّدة التي تُنشر على /api.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontMatter } from '../lib/front-matter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function frontMatterFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.md'))
    .map((file) => ({ file, data: parseFrontMatter(read(`${dir}/${file}`)).data }));
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

test("كل ملف فيه meta_description له description مطابق (وإلا الـ<head> يفقد الوصف)", () => {
  const all = [...frontMatterFiles('_properties'), ...frontMatterFiles('_requests')];
  const withMeta = all.filter(({ data }) => String(data.meta_description || '').trim());
  assert.ok(withMeta.length >= 9, `عدد الملفات ذات meta_description غير متوقع: ${withMeta.length}`);
  for (const { file, data } of withMeta) {
    assert.ok(String(data.description || '').trim(), `${file}: description مفقود رغم meta_description`);
    assert.equal(norm(data.description), norm(data.meta_description), `${file}: description ≠ meta_description`);
  }
});

test("كل عقار من الثمانية: وصف /api منشور كامل وليس العنوان", () => {
  const props = frontMatterFiles('_properties').filter(({ data }) => String(data.meta_description || '').trim());
  // المجموعة المعلنة في التدقيق كانت 8 عقارات؛ كل عقار جديد يحمل meta_description
  // (مثل بشار بن برد 2026-10-19) يدخل نفس الفحص بدل أن يكسر عدًّا ثابتًا.
  assert.ok(props.length >= 8, `المجموعة المعلنة في التدقيق ≥ 8 عقارات (الحالي ${props.length})`);
  for (const { file, data } of props) {
    const slug = String(data.slug || '').trim() || file.replace(/\.md$/, '');
    const jsonPath = path.join(ROOT, 'api', 'properties', `${slug}.json`);
    assert.ok(fs.existsSync(jsonPath), `${file}: أثر API مفقود (${slug}.json)`);
    const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(norm(doc.property.description), norm(data.description), `${file}: وصف API لا يطابق الـfront matter`);
    assert.notEqual(norm(doc.property.description), norm(data.title), `${file}: وصف API سقط إلى العنوان`);
    assert.ok(norm(doc.property.description).length > 40, `${file}: الوصف المنشور قصير جدًا`);
  }
});

test("الطلب الحالي: description في المصدر + JSON-LD لا يسقط إلى العنوان", () => {
  const files = frontMatterFiles('_requests');
  assert.equal(files.length, 1);
  const { data } = files[0];
  assert.ok(String(data.description || '').trim());
  const layout = read('_layouts/request_page.html');
  assert.match(layout, /"description":\s*\{\{\s*page\.description\s*\|\s*default:\s*page\.title\s*\|\s*jsonify\s*\}\}/);
});

test("agent.html: og:image:type = image/webp ويطابق امتداد الصورة", () => {
  const html = read('agent.html');
  const type = html.match(/<meta property="og:image:type" content="([^"]+)">/);
  assert.equal(type?.[1], 'image/webp');
  const img = html.match(/^image:\s*"([^"]+)"/m);
  assert.equal(path.extname(img?.[1] || ''), '.webp');
});

test("agent.html: viewport-fit + interactive-widget بلا تعطيل التكبير (WCAG 1.4.4)", () => {
  const html = read('agent.html');
  const viewport = html.match(/<meta name="viewport" content="([^"]+)">/);
  assert.ok(viewport, 'وسم viewport مفقود');
  assert.match(viewport[1], /viewport-fit=cover/);
  assert.match(viewport[1], /interactive-widget=resizes-content/);
  assert.doesNotMatch(viewport[1], /maximum-scale=1(?:\.0)?(?:,|$)/);
  assert.doesNotMatch(viewport[1], /user-scalable=no/);
});

test("add-your-property.html: لا extra_head مكرر، والوصف والصورة في الـfront matter", () => {
  const html = read('add-your-property.html');
  const fm = html.slice(0, html.indexOf('\n---', 4));
  assert.doesNotMatch(fm, /^extra_head:/m, 'extra_head يعيد تكرار OG/Twitter خارج {% seo %}');
  assert.match(fm, /^description:\s*\S/m);
  assert.match(fm, /^image:\s*"\/assets\/img\/social-add-property\.png"/m);
  assert.doesNotMatch(html, /<meta name="description"/i, 'يجب أن يبقى {% seo %} هو مصدر وسم الوصف الوحيد');
});
