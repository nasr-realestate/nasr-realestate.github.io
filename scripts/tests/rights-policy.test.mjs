// Tests: سياسة الملكية الفكرية وحقوق أصحابها الأصليين.
// تحرس التوثيق العام والمخرجات الآلية من العودة إلى إذن مفتوح أو صياغة ناقصة.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIGHTS, renderAiTxt, renderOpenApi, renderMcpCard } from '../lib/ai-docs.mjs';
import { buildFeed, buildPropertyDocument, buildApiIndex } from '../build-ai-artifacts.mjs';
import { loadProperties } from '../lib/properties.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const PROPS = loadProperties(path.join(ROOT, '_properties'));

test('الحقوق مصدر واحد والتزامها حماية أصحاب الحقوق الأصليين', () => {
  assert.deepEqual(json('_data/rights.json'), RIGHTS);
  assert.equal(RIGHTS.commitment, 'نلتزم بحماية الملكية الفكرية وحقوق أصحابها الأصليين، ونلزم جميع المستخدمين والمساهمين باحترامها.');
  assert.equal(RIGHTS.permissions.browse, true);
  assert.equal(RIGHTS.permissions.search_indexing, true);
  assert.equal(RIGHTS.permissions.limited_quotation_with_attribution, true);
  for (const key of ['ai_training', 'code_reuse', 'redistribution', 'commercial_reuse', 'remove_rights_notices']) {
    assert.equal(RIGHTS.permissions[key], false, `${key} must remain disabled`);
  }
  assert.match(RIGHTS.scope_note, /أصحابها الأصليين/);
});

test('LICENSE وREADME يوثقان ترخيصًا مملوكًا لا ترخيصًا مفتوح المصدر', () => {
  const license = read('LICENSE');
  assert.match(license, /جميع الحقوق محفوظة/);
  assert.match(license, /Proprietary License/);
  assert.match(license, /لا تُنشئ ترخيصًا مفتوح المصدر/);
  assert.match(license, /حقوق الغير والمكونات المرخّصة/);
  assert.match(license, /شروط المنصة/);
  const readme = read('README.md');
  assert.match(readme, /ليس مشروعًا مفتوح المصدر/);
  assert.match(readme, /\[`LICENSE`\]\(\.\/LICENSE\)/);
  assert.match(readme, /THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(readme, /git clone/);
  const pkg = json('package.json');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.equal(json('_worker/package.json').license, 'UNLICENSED');
});

test('الصفحة العامة والتذييل والقوالب تعلن سياسة الحقوق', () => {
  const page = read('intellectual-property.html');
  assert.match(page, /permalink: \/intellectual-property\.html/);
  assert.match(page, /site\.data\.rights\.commitment/);
  assert.match(page, /site\.data\.rights\.third_party_notices_url/);
  assert.match(read('_includes/footer.html'), /href=.*intellectual-property\.html/);
  for (const layout of ['_layouts/default.html', '_layouts/app.html']) {
    assert.match(read(layout), /include rights-meta\.html/);
  }
  const meta = read('_includes/rights-meta.html');
  assert.match(meta, /rel="license"/);
  assert.match(meta, /no-ai-training/);
  assert.match(meta, /no-code-reuse/);
  assert.match(read('properties.html'), /site\.data\.rights\.policy_url/);
});

test('سياسة الذكاء الاصطناعي تسمح بالإسناد ولا تمنح إذن تدريب أو إعادة استخدام', () => {
  const txt = renderAiTxt(PROPS, { stamp: '2026-11-12', mcpEndpoint: 'https://example.workers.dev/mcp' });
  assert.match(txt, /Allow-AI-Training: no/);
  assert.match(txt, /Allow-Code-Reuse: no/);
  assert.match(txt, /Allow-Commercial-Reuse: no/);
  assert.match(txt, /Allow-AI-Summarize: yes/);
  assert.match(txt, /Rights-Policy: https:\/\/nasr-realestate\.github\.io\/intellectual-property\.html/);
  assert.ok(txt.includes(RIGHTS.commitment));
  assert.equal(read('ai.txt'), read('.well-known/ai.txt'));
  assert.match(read('ai.txt'), /Allow-AI-Training: no/);
  assert.match(read('llms.txt'), /تدريب نماذج الذكاء الاصطناعي على الكود أو المحتوى/);
  assert.match(read('robots.txt'), /وليس ترخيصًا لإعادة استخدام الكود أو المحتوى أو تدريب النماذج/);
});

test('المخرجات المنشورة تحمل نفس الحقوق وسياسة الإسناد', () => {
  const stamp = '2026-11-12T00:00:00.000Z';
  assert.deepEqual(buildFeed(PROPS, stamp).rights, RIGHTS);
  assert.deepEqual(buildPropertyDocument(PROPS[0], stamp).rights, RIGHTS);
  assert.deepEqual(buildApiIndex(PROPS, stamp).rights, RIGHTS);
  assert.deepEqual(renderMcpCard({ endpoint: 'https://example.workers.dev/mcp', properties: PROPS, stamp }).rights, RIGHTS);
  assert.equal(renderOpenApi(PROPS).info.license.url, RIGHTS.policy_url);
  for (const rel of ['ai-feed.json', 'api/index.json', 'api/properties.json', 'search-data.json', 'mcp.json', '.well-known/mcp.json']) {
    assert.deepEqual(json(rel).rights, RIGHTS, `${rel} rights drifted`);
  }
  assert.equal(json('api/openapi.json').info.license.url, RIGHTS.policy_url);
  assert.match(read('llms-full.txt'), /إعادة استخدام الكود أو إعادة النشر أو التدريب الآلي تتطلب إذنًا كتابيًا/);
});

test('تراخيص المكونات الخارجية محفوظة ولا يعاد ترخيصها باسم المشروع', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /لا يعيد هذا السجل ترخيص أي مكون خارجي/);
  assert.match(notices, /Cairo-OFL\.txt/);
  assert.match(notices, /Font-Awesome-LICENSE\.txt/);
  assert.match(read('assets/fonts/Cairo-OFL.txt'), /SIL OPEN FONT LICENSE/);
  const fa = read('assets/fonts/Font-Awesome-LICENSE.txt');
  assert.match(fa, /Font Awesome Free License/);
  assert.match(fa, /Copyright \(c\) 2023 Fonticons, Inc\./);
  const upstream = path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free/LICENSE.txt');
  if (fs.existsSync(upstream)) assert.equal(fa, fs.readFileSync(upstream, 'utf8'));
});
