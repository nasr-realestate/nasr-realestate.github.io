#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/build-ai-artifacts.mjs
 *  مُولّد طبقة الذكاء الاصطناعي لموقع سمسار طلبك
 * ───────────────────────────────────────────────────────────────
 *  يُشغَّل **بعد** `jekyll build` (انظر .github/workflows/deploy.yml)
 *  ويكتب داخل مجلد المخرجات:
 *
 *    ai-feed.json                     ← التغذية الأساسية (مُعاد بناؤها من مصدر واحد)
 *    llms-full.txt                    ← الكتالوج الكامل Markdown
 *    api/index.json                   ← دليل الواجهة
 *    api/properties.json              ← كل الوحدات + الفهارس
 *    api/properties/<slug>.json       ← وحدة واحدة (JSON)
 *    api/properties/<slug>.md         ← وحدة واحدة (Markdown)
 *    api/openapi.json                 ← مواصفة OpenAPI 3.1
 *    search-data.json                 ← فهرس البحث الخفيف (كان مذكورًا وغير مُولّد)
 *    .well-known/ai.txt               ← سياسة استخدام المحتوى آليًا
 *    .well-known/mcp.json             ← بطاقة خادم MCP
 *    .well-known/mcp/server-card.json ← المسار البديل للبطاقة
 *
 *  الاستخدام:
 *    node scripts/build-ai-artifacts.mjs                 # يكتب داخل _site
 *    node scripts/build-ai-artifacts.mjs --out=.         # يكتب في الجذر (معاينة محلية)
 *    node scripts/build-ai-artifacts.mjs --check         # يتحقق فقط ولا يكتب
 *    node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json  # النشر الجذري
 * ═══════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProperties, buildFacets } from './lib/properties.mjs';
import {
  SITE,
  renderLlmsFull,
  renderPropertyMarkdown,
  renderAiTxt,
  renderMcpCard,
  renderOpenApi,
  renderSearchData,
  MCP_GATEWAY_STATUS,
} from './lib/ai-docs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const SCHEMA_VERSION = '3.0';
export const MCP_ENDPOINT = 'https://nasr-ai-gateway.footcai-555.workers.dev/mcp';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};

const OUT_DIR = path.resolve(ROOT, String(flag('out', '_site')));
const CHECK_ONLY = Boolean(flag('check', false));
// ملفات لا يُلمسها المولّد في وضع النشر إلى الجذر: `--skip=ai-feed.json`
// (المصدر الجذري لـ ai-feed.json قالبه Liquid يبنيه Jekyll، فلا يُستبدل بمخرج ثابت).
const SKIP = new Set(
  String(flag('skip', ''))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);

/* ─────────────────────────── أدوات ─────────────────────────── */

function write(relative, contents) {
  if (SKIP.has(relative) || SKIP.has(relative.split('/')[0])) return { relative, bytes: 0, skipped: true };
  const target = path.join(OUT_DIR, relative);
  const body = typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  if (CHECK_ONLY) return { relative, bytes: Buffer.byteLength(body) };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
  return { relative, bytes: Buffer.byteLength(body) };
}

/**
 * ai-feed.json — نفس أسماء الحقول التي يقرأها _worker/worker.js
 * (id, title, url, slug, transaction, propertyType, category, location,
 *  zone, price, priceNumeric, area, areaNumeric, rooms, roomsNumeric,
 *  baths, bathsNumeric, floor, finish, finishing, furnished, description,
 *  image, date, meta_title) — بدون أي حذف، مع حقول إضافية فقط.
 */
export function buildFeed(properties, generatedAt) {
  return {
    schema_version: SCHEMA_VERSION,
    brand: 'سمسار طلبك',
    generated_at: generatedAt,
    total_count: properties.length,
    last_updated: generatedAt.slice(0, 10),
    endpoints: {
      site: SITE,
      properties_page: `${SITE}/properties/`,
      catalog: `${SITE}/api/properties.json`,
      openapi: `${SITE}/api/openapi.json`,
      llms: `${SITE}/llms.txt`,
      llms_full: `${SITE}/llms-full.txt`,
      mcp: MCP_ENDPOINT,
    },
    facets: buildFacets(properties),
    properties: properties.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      slug: p.slug,
      // مسار ملف الـfront matter في المستودع + بصمة محتواه — يقرأهما
      // properties-sync-worker ليبني قائمة الملفات من الـfeed في طلب واحد.
      source_path: p.source_path,
      source_sha256: p.source_sha256,
      transaction: p.transaction,
      propertyType: p.propertyType,
      category: p.category,
      location: p.location,
      zone: p.zone,
      price: p.price,
      priceNumeric: p.priceNumeric,
      area: p.area,
      areaNumeric: p.areaNumeric,
      rooms: p.rooms,
      roomsNumeric: p.roomsNumeric,
      baths: p.baths,
      bathsNumeric: p.bathsNumeric,
      floor: p.floor,
      finish: p.finish,
      finishing: p.finish,
      furnished: p.furnished ?? '',
      description: p.description,
      image: p.image,
      date: p.date,
      meta_title: p.metaTitle,
    })),
  };
}

// بيانات المصدر (source_path/source_sha256) عقد خاص بمزامنة D1 داخل ai-feed.json،
// وليست جزءًا من واجهات القراءة العامة — تُنزع من كل مخرجات /api.
function publicProperty(p) {
  const { source_path, source_sha256, ...rest } = p;
  return rest;
}

export function buildPropertyDocument(p, generatedAt) {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    type: 'RealEstateListing',
    source: SITE,
    citation: {
      required: true,
      text: 'سمسار طلبك — طارق طنطاوي (مدينة نصر، القاهرة)',
      url: p.url,
      note: 'السعر المعروض سعر طلب، وليس سعر إتمام؛ لا تُفترض قابلية التفاوض إلا إذا ذكرها نص الوحدة صراحةً.',
    },
    broker: {
      name: 'طارق طنطاوي',
      brand: 'سمسار طلبك',
      whatsapp: '+201147758857',
      whatsapp_url: 'https://wa.me/201147758857',
      email: 'samsar.talabak@mailo.com',
      address: '16 شارع محمد حسن الجمل - المنطقة السادسة - مدينة نصر - القاهرة - مصر',
      hours: 'السبت–الخميس 12:00–21:00 (الجمعة إجازة)',
    },
    property: {
      ...publicProperty(p),
      _derived: undefined,
      markdown_url: `${SITE}/api/properties/${p.slug}.md`,
      json_url: `${SITE}/api/properties/${p.slug}.json`,
    },
  };
}

export function buildApiIndex(properties, generatedAt) {
  const facets = buildFacets(properties);
  return {
    schema_version: SCHEMA_VERSION,
    name: 'سمسار طلبك — واجهة العقارات',
    description:
      'واجهة قراءة فقط بلا مصادقة لكل الوحدات المعروضة على موقع سمسار طلبك (مدينة نصر والقاهرة الجديدة). مناسبة للنماذج والوكلاء: كل الاستجابات JSON ثابتة وقابلة للتخزين المؤقت.',
    generated_at: generatedAt,
    total_count: properties.length,
    base_url: SITE,
    contact: { email: 'samsar.talabak@mailo.com', whatsapp: '+201147758857' },
    endpoints: [
      { path: '/llms.txt', method: 'GET', format: 'text/markdown', description: 'دليل الموقع للنماذج (مختصر)' },
      { path: '/llms-full.txt', method: 'GET', format: 'text/markdown', description: 'الكتالوج الكامل: كل الوحدات في ملف واحد' },
      { path: '/ai-feed.json', method: 'GET', format: 'application/json', description: 'التغذية الأساسية (يستهلكها وكيل الموقع)' },
      { path: '/api/properties.json', method: 'GET', format: 'application/json', description: 'كل الوحدات + الفهارس والإحصاءات' },
      { path: '/api/properties/{slug}.json', method: 'GET', format: 'application/json', description: 'وحدة واحدة' },
      { path: '/api/properties/{slug}.md', method: 'GET', format: 'text/markdown', description: 'وحدة واحدة بصيغة Markdown' },
      { path: '/api/openapi.json', method: 'GET', format: 'application/json', description: 'مواصفة OpenAPI 3.1' },
      { path: '/search-data.json', method: 'GET', format: 'application/json', description: 'فهرس بحث خفيف' },
      { path: '/.well-known/ai.txt', method: 'GET', format: 'text/plain', description: 'سياسة استخدام المحتوى بواسطة AI' },
      { path: '/.well-known/mcp.json', method: 'GET', format: 'application/json', description: 'بطاقة خادم MCP' },
      { path: '/sitemap.xml', method: 'GET', format: 'application/xml', description: 'خريطة الموقع' },
      { path: '/feed.xml', method: 'GET', format: 'application/rss+xml', description: 'تغذية RSS' },
    ],
    mcp: {
      endpoint: MCP_ENDPOINT,
      transport: 'streamable-http',
      card: `${SITE}/.well-known/mcp.json`,
      status: MCP_GATEWAY_STATUS.status,
      fallback: MCP_GATEWAY_STATUS.guaranteed_fallback,
    },
    filters: {
      transaction: ['sale', 'rent'],
      propertyType: ['apartment', 'villa', 'shop', 'office', 'warehouse', 'clinic'],
      zone: Object.keys(facets.by_zone),
      priceRange: {
        sale: facets.overall_sale_price,
        rent: facets.overall_rent_price,
      },
    },
    facets,
    citation_policy: 'اذكر المصدر «سمسار طلبك» وأرفق رابط الوحدة. الأسعار أسعار طلب وليست أسعار إتمام؛ لا تفترض قابلية التفاوض إلا إذا ذكرها نص الوحدة صراحةً.',
  };
}

/* ─────────────────────────── التشغيل ─────────────────────────── */

function main() {
  const generatedAt = new Date().toISOString();
  const properties = loadProperties(path.join(ROOT, '_properties'));
  if (!properties.length) {
    console.error('[ai-artifacts] ✖ لم يتم العثور على أي وحدة في _properties — لا شيء ليُبنى.');
    process.exit(1);
  }
  if (!CHECK_ONLY) fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  const feed = buildFeed(properties, generatedAt);
  written.push(write('ai-feed.json', feed));
  written.push(write('llms-full.txt', renderLlmsFull(properties)));
  written.push(write('api/index.json', buildApiIndex(properties, generatedAt)));
  written.push(write('api/properties.json', {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    total_count: properties.length,
    base_url: SITE,
    facets: buildFacets(properties),
    // بيانات المصدر خاصة بالمزامنة وتُبقي في ai-feed.json فقط، حتى لا يتغير
    // عقد /api/properties.json المنشور.
    properties: properties.map((p) => ({ ...publicProperty(p), _derived: undefined })),
  }));
  written.push(write('api/openapi.json', renderOpenApi(properties)));
  written.push(write('search-data.json', renderSearchData(properties)));
  written.push(write('.well-known/ai.txt', renderAiTxt(properties, { stamp: generatedAt.slice(0, 10), mcpEndpoint: MCP_ENDPOINT })));

  const card = renderMcpCard({ endpoint: MCP_ENDPOINT, properties, stamp: generatedAt });
  written.push(write('.well-known/mcp.json', card));
  written.push(write('.well-known/mcp/server-card.json', card));

  // ⚠️ نسخ جذرية موازية (mirrors) — ليست تكرارًا عبثيًا:
  //   • actions/upload-pages-artifact@v3 يحتفظ بالمجلدات النقطية، لكن
  //     الإصدار v4 يحجب كل ما يبدأ بنقطة افتراضيًا (`--exclude=.[^/]*`).
  //     لو رُفع الإصدار يومًا، تختفي .well-known بالكامل بلا أي خطأ ظاهر.
  //   • عدد من الزواحف والأدوات يقرأ /ai.txt و /mcp.json من الجذر فقط.
  //   المصدر واحد، والمحتوى متطابق، والاختبارات تتحقق من التطابق.
  written.push(write('ai.txt', renderAiTxt(properties, { stamp: generatedAt.slice(0, 10), mcpEndpoint: MCP_ENDPOINT })));
  written.push(write('mcp.json', card));

  for (const p of properties) {
    written.push(write(`api/properties/${p.slug}.json`, buildPropertyDocument(p, generatedAt)));
    written.push(write(`api/properties/${p.slug}.md`, renderPropertyMarkdown(p)));
  }

  const bytes = written.reduce((sum, w) => sum + w.bytes, 0);
  const kb = (bytes / 1024).toFixed(1);
  console.log(`[ai-artifacts] ${CHECK_ONLY ? 'تحقق' : 'كتابة'}: ${written.length} ملف · ${kb} كيلوبايت · ${properties.length} وحدة`);
  console.log(`[ai-artifacts] الهدف: ${path.relative(ROOT, OUT_DIR) || '.'}`);
  if (CHECK_ONLY) console.log('[ai-artifacts] --check: لم يُكتب أي ملف.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
