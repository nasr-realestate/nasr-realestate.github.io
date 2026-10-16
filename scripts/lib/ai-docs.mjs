/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/lib/ai-docs.mjs
 *  مُولّدات المستندات الموجّهة للذكاء الاصطناعي
 *  (llms-full.txt · صفحات Markdown لكل عقار · ai.txt · MCP · OpenAPI)
 * ═══════════════════════════════════════════════════════════════
 */

import { buildFacets } from './properties.mjs';

export const SITE = 'https://nasr-realestate.github.io';

/**
 * حالة بوابة MCP — مصدر حقيقة واحد ينعكس في mcp.json وai.txt وapi/index.json.
 * 2026-10-16: البوابة **لم تُنشَر بعد** (أسرار Cloudflare غير مضافة إلى المستودع)،
 * ورابطها المُعلَن يردّ 404 من workers.dev (تحقّق فعلي عبر الجلب المباشر).
 * لذلك تُنشَر البطاقة بحالة صريحة تُحيل النماذج إلى المسار المضمون (REST/Markdown)
 * بدل أن تعدها بأداة لا تعمل — امتدادًا لقاعدة «لا تلفّق» إلى واجهاتنا نفسها.
 * بعد نجاح .github/workflows/deploy-mcp-gateway.yml: بدّل status إلى 'live'،
 * وحدّث verified_at، ثم أعد التوليد:
 *   node scripts/build-ai-artifacts.mjs --out=. --skip=ai-feed.json
 */
export const MCP_GATEWAY_STATUS = {
  status: 'pending-deployment',
  verified_at: '2026-10-16',
  note: 'بوابة MCP تُنشر من _worker/ بمفاتيح Cloudflare، ولم تُضَف الأسرار بعد. استخدم المسار المضمون أدناه اليوم.',
  guaranteed_fallback: `${SITE}/api/properties.json`,
  guaranteed_paths: [
    `${SITE}/api/properties.json`,
    `${SITE}/api/properties/{slug}.json`,
    `${SITE}/api/properties/{slug}.md`,
    `${SITE}/llms-full.txt`,
    `${SITE}/search-data.json`,
  ],
};

const AR = {
  sale: 'للبيع',
  rent: 'للإيجار',
  apartment: 'شقة',
  villa: 'فيلا',
  shop: 'محل تجاري',
  office: 'مكتب إداري',
  warehouse: 'مخزن',
  clinic: 'عيادة',
};

const TYPE_ORDER = ['apartment', 'villa', 'shop', 'office', 'warehouse', 'clinic'];

export function typeLabel(t) {
  return AR[t] ?? t;
}

export function transactionLabel(t) {
  return AR[t] ?? t;
}

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : null;
}

/** سطر سعر مقروء + رقم صريح — الرقم الصريح أهم للنماذج */
export function priceLine(p) {
  if (!Number.isFinite(p.priceNumeric)) return `- **السعر**: ${p.price || 'للاستعلام'} (غير معلن رقميًا)`;
  const unit = p.transaction === 'rent' ? 'شهريًا' : '';
  const numeric = `${p.priceNumeric} EGP${unit ? ' / month' : ''}`;
  const human = `- **السعر**: ${fmt(p.priceNumeric)} ج.م${unit ? ` ${unit}` : ''}`;
  return `${human}\n- **priceNumeric**: ${numeric}`;
}

/** بطاقة عقار مختصرة — تُستخدم في llms-full.txt وفي Markdown الخاص بالعقار */
export function propertyBlock(p, { detailed = false } = {}) {
  const lines = [];
  lines.push(`### ${p.title}`);
  lines.push('');
  lines.push(`- **المعرّف (slug)**: \`${p.slug}\``);
  lines.push(`- **الرابط**: ${p.url}`);
  lines.push(priceLine(p));
  if (Number.isFinite(p.priceNumeric)) {
    lines.push(`- **transaction**: ${p.transaction}`);
    lines.push(`- **propertyType**: ${p.propertyType}`);
  }
  if (Number.isFinite(p.areaNumeric)) lines.push(`- **المساحة**: ${fmt(p.areaNumeric)} م²`);
  else if (p.area) lines.push(`- **المساحة**: ${p.area}`);
  if (Number.isFinite(p.roomsNumeric)) lines.push(`- **الغرف**: ${p.roomsNumeric}`);
  if (Number.isFinite(p.bathsNumeric)) lines.push(`- **الحمامات**: ${p.bathsNumeric}`);
  if (p.finish) lines.push(`- **التشطيب**: ${p.finish}`);
  if (p.floor) lines.push(`- **الدور**: ${p.floor}`);
  if (p.furnished) lines.push(`- **الفرش**: ${p.furnished === 'furnished' ? 'مفروش' : 'غير مفروش'}`);
  if (p.location) lines.push(`- **الموقع**: ${p.location}`);
  if (p.zone) lines.push(`- **المنطقة**: ${p.zone}`);
  if (p.image) lines.push(`- **الصورة**: ${p.image}`);
  if (p.datePosted) lines.push(`- **تاريخ النشر**: ${p.datePosted}`);
  if (detailed && p.description) {
    lines.push('');
    lines.push(p.description);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * llms-full.txt — الكتالوج الكامل وفق اتفاقية llms.txt:
 * فهرس أولًا (ليتوقف النموذج مبكرًا)، ثم كل العقارات مقسّمة ومُرقّمة.
 */
export function renderLlmsFull(properties) {
  const facets = buildFacets(properties);
  const stamp = new Date().toISOString().slice(0, 10);
  const out = [];

  out.push('# سمسار طلبك — الكتالوج الكامل (llms-full.txt)');
  out.push('');
  out.push(`> النسخة الكاملة من llms.txt: كل العقارات المعروضة (${properties.length} وحدة) في ملف واحد، بصيغة Markdown تُقرأ مباشرة. الوسيط: طارق طنطاوي — مدينة نصر، القاهرة — منذ 2014. المصدر الرقمي: ${SITE}/api/properties.json`);
  out.push('');
  out.push('## بيانات الملف');
  out.push('');
  out.push(`- **آخر تحديث**: ${stamp}`);
  out.push(`- **إجمالي الوحدات**: ${properties.length}`);
  out.push(`- **للبيع**: ${facets.by_transaction.sale ?? 0} · **للإيجار**: ${facets.by_transaction.rent ?? 0}`);
  out.push(`- **العملة**: الجنيه المصري (EGP)`);
  out.push('- **طبيعة الأسعار**: أسعار طلب قابلة للتفاوض — وليست أسعار إتمام صفقات');
  out.push(`- **الملفات المكمّلة**: [llms.txt](${SITE}/llms.txt) · [ai-feed.json](${SITE}/ai-feed.json) · [api/properties.json](${SITE}/api/properties.json)`);
  out.push('');

  out.push('## تنبيه للنماذج (اقرأ أولًا)');
  out.push('');
  out.push('1. لكل وحدة صفحة مفردة على الموقع، ورابطها مذكور في بطاقتها. لاقتباس وحدة محددة، استخدم رابطها وبطاقتها كما هي.');
  out.push('2. لا تُلفّق أرقامًا: إن لم يوجد حقل `priceNumeric` فالوحدة «للاستعلام». وإن لم يوجد عدد غرف فالمساحة مفتوحة/غير مقسّمة.');
  out.push('3. للتواصل أو المعاينة: واتساب +201147758857 (طارق طنطاوي).');
  out.push('4. الوحدات المنشورة متاحة حتى إزالتها من الموقع؛ لا تفترض التوافر دون تحقق.');
  out.push('');

  // فهرس سريع
  out.push('## فهرس حسب النوع والمعاملة');
  out.push('');
  for (const type of TYPE_ORDER) {
    for (const tx of ['sale', 'rent']) {
      const rows = properties.filter((p) => p.propertyType === type && p.transaction === tx);
      if (!rows.length) continue;
      out.push(`- **${typeLabel(type)} ${transactionLabel(tx)}** (${rows.length}): ${rows.map((p) => `\`${p.slug}\``).join(' · ')}`);
    }
  }
  out.push('');
  out.push('## فهرس حسب المنطقة');
  out.push('');
  for (const [zone, n] of Object.entries(facets.by_zone)) {
    if (n < 2) continue;
    out.push(`- **${zone}** (${n})`);
  }
  out.push(`- _و${Object.values(facets.by_zone).filter((n) => n === 1).length} منطقة/شارع بوحدة واحدة — التفاصيل داخل البطاقات._`);
  out.push('');

  // ملخص الأسعار
  out.push('## ملخص الأسعار (استرشادي من الأسعار المعروضة)');
  out.push('');
  out.push('| النوع | المعاملة | العدد | أقل سعر | الوسيط | أعلى سعر |');
  out.push('|---|---|---|---|---|---|');
  for (const type of TYPE_ORDER) {
    const s = facets.price_by_type[type];
    if (!s) continue;
    for (const tx of ['sale', 'rent']) {
      const st = s[tx];
      if (!st) continue;
      out.push(`| ${typeLabel(type)} | ${tx} | ${st.count} | ${fmt(st.min)} | ${fmt(st.median)} | ${fmt(st.max)} |`);
    }
  }
  out.push('');
  out.push('> الأرقام أعلاه مشتقة من الأسعار المعروضة فعليًا على الموقع، وليست تقييمًا عقاريًا معتمدًا.');
  out.push('');

  // الكتالوج الكامل
  out.push('---');
  out.push('');
  out.push('# الكتالوج الكامل');
  out.push('');
  let counter = 0;
  for (const type of TYPE_ORDER) {
    const byType = properties.filter((p) => p.propertyType === type);
    if (!byType.length) continue;
    for (const tx of ['sale', 'rent']) {
      const rows = byType.filter((p) => p.transaction === tx);
      if (!rows.length) continue;
      out.push(`## ${typeLabel(type)} ${transactionLabel(tx)} — ${rows.length} وحدة`);
      out.push('');
      for (const p of rows) {
        counter += 1;
        out.push(propertyBlock(p));
      }
    }
  }
  // أي نوع غير مصنّف
  const known = new Set(TYPE_ORDER);
  const others = properties.filter((p) => !known.has(p.propertyType));
  if (others.length) {
    out.push(`## وحدات أخرى — ${others.length}`);
    out.push('');
    for (const p of others) out.push(propertyBlock(p));
  }

  out.push('---');
  out.push('');
  out.push(`_نسخة Markdown كاملة — ${counter} وحدة. حقوق النشر © ${new Date().getFullYear()} سمسار طلبك. الاقتباس مسموح مع ذكر المصدر ورابط الصفحة._`);
  out.push('');
  return out.join('\n');
}

/**
 * صفحة Markdown مستقلة لكل عقار — تُخدم على المسار /api/properties/<slug>.md
 *
 * ⚠️ لا تُعد إلى front matter بين علامتي `---`:
 *    ناشر الموقع (بناء الفرع على GitHub Pages) يعدّ Jekyll أي ملف `.md`
 *    يبدأ بـ`---` «صفحة»، فيحذف الـfront matter ويحوّل النص
 *    إلى HTML — أي يختفي الوصف الميكانيكي وتتغير صيغة الخدمة.
 *    التعليق أدناه يحفظ نفس الحقول بـJSON واحد يقرأه الجهاز والنموذج،
 *    ويُبقي الملف «ملفًا ثابتًا» يُخدم كما هو.
 */
export function renderPropertyMarkdown(p) {
  const meta = {
    title: p.title,
    slug: p.slug,
    transaction: p.transaction,
    propertyType: p.propertyType,
    ...(Number.isFinite(p.priceNumeric) ? { price: p.priceNumeric } : {}),
    currency: 'EGP',
    ...(Number.isFinite(p.areaNumeric) ? { area_sqm: p.areaNumeric } : {}),
    ...(Number.isFinite(p.roomsNumeric) ? { rooms: p.roomsNumeric } : {}),
    ...(Number.isFinite(p.bathsNumeric) ? { baths: p.bathsNumeric } : {}),
    ...(p.location ? { location: p.location } : {}),
    ...(p.zone ? { zone: p.zone } : {}),
    ...(p.datePosted ? { date_posted: p.datePosted } : {}),
  };
  // مانع إغلاق التعليق مبكرًا: `--` لا تظهر في JSON إلا داخل النصوص، فنُهرّبها.
  const metaJson = JSON.stringify(meta).replace(/--/g, '\\u002d\\u002d');
  const out = [];
  out.push(`<!-- ai-property ${metaJson} -->`);
  out.push('');
  out.push(`# ${p.title}`);
  out.push('');
  out.push(p.description || p.metaTitle);
  out.push('');
  out.push('## التفاصيل');
  out.push('');
  out.push(`- **المعرّف**: \`${p.slug}\``);
  out.push(`- **النوع**: ${typeLabel(p.propertyType)} — ${transactionLabel(p.transaction)}`);
  out.push(`- **السعر**: ${p.price || 'للاستعلام'}${Number.isFinite(p.priceNumeric) ? ` (${p.priceNumeric} EGP)` : ''}`);
  if (p.area) out.push(`- **المساحة**: ${p.area}`);
  if (p.rooms) out.push(`- **الغرف**: ${p.rooms}`);
  if (p.baths) out.push(`- **الحمامات**: ${p.baths}`);
  if (p.floor) out.push(`- **الدور**: ${p.floor}`);
  if (p.finish) out.push(`- **التشطيب**: ${p.finish}`);
  if (p.location) out.push(`- **الموقع**: ${p.location}`);
  out.push('');
  out.push('## الوصول للوحدة');
  out.push('');
  out.push(`- **صفحة الوحدة**: ${p.url}`);
  out.push(`- **نسخة JSON**: ${SITE}/api/properties/${p.slug}.json`);
  if (p.image) out.push(`- **الصورة**: ${p.image}`);
  out.push('');
  out.push('## التواصل');
  out.push('');
  out.push('- **الوسيط**: طارق طنطاوي — سمسار طلبك');
  out.push('- **واتساب**: +201147758857 · https://wa.me/201147758857');
  out.push('- **المكتب**: 16 شارع محمد حسن الجمل، المنطقة السادسة، مدينة نصر، القاهرة');
  out.push('');
  out.push('---');
  out.push('');
  out.push('> الأسعار المعروضة أسعار طلب قابلة للتفاوض وليست أسعار إتمام صفقات. الاقتباس مسموح مع ذكر المصدر «سمسار طلبك» ورابط الصفحة.');
  out.push('');
  return out.join('\n');
}

/** /.well-known/ai.txt — سياسة الاستخدام الآلي للمحتوى */
export function renderAiTxt(properties, { stamp, mcpEndpoint } = {}) {
  const date = stamp ?? new Date().toISOString().slice(0, 10);
  return `# ai.txt — سياسة استخدام المحتوى بواسطة الذكاء الاصطناعي
# الموقع: ${SITE}
# المالك: سمسار طلبك — طارق طنطاوي (وساطة واستشارات عقارية، مدينة نصر، القاهرة)
# آخر تحديث: ${date}

User-Agent: *
Allow: /
Disallow: /_site/
Disallow: /scripts/
Disallow: /tools/

# ── الإذن بالاستخدام ─────────────────────────────
Allow-AI-Training: yes
Allow-AI-Summarize: yes
Allow-AI-Search-Display: yes
Allow-AI-Agent-Use: yes
Allow-Redistribution-Full-Text: no

# ── واجهات مقروءة آليًا ──────────────────────────
AI-Discovery: ${SITE}/llms.txt
AI-Catalog: ${SITE}/llms-full.txt
AI-JSON-API: ${SITE}/api/properties.json
AI-OpenAPI: ${SITE}/api/openapi.json
AI-MCP-Endpoint: ${mcpEndpoint}
AI-MCP-Card: ${SITE}/.well-known/mcp.json
AI-MCP-Status: ${MCP_GATEWAY_STATUS.status}
AI-MCP-Fallback: ${MCP_GATEWAY_STATUS.guaranteed_fallback}
RSS: ${SITE}/feed.xml
Sitemap: ${SITE}/sitemap.xml

# ── شروط الاقتباس ────────────────────────────────
Cite-As: سمسار طلبك (Semsar Talabk) — ${SITE}
Cite-Policy: اذكر المصدر «سمسار طلبك» وأرفق رابط الصفحة الأصلية. للأسعار استخدم حقل priceNumeric كما هو واذكر أنه سعر طلب قابل للتفاوض.
Attribution-Required: yes
Data-Freshness: ${properties.length} وحدة معروضة حتى ${date}
Contact: samsar.talabak@mailo.com · +201147758857
License: البيانات متاحة للفهرسة والاقتباس مع الإسناد؛ إعادة النشر الكامل أو الاستخدام التجاري غير مسموح دون إذن.

# ── ملاحظات ─────────────────────────────────────
# 1) الأسعار أسعار طلب قابلة للتفاوض، وليست أسعار إتمام.
# 2) لا توجد أرقام اعتماد رسمية معتمدة؛ أي تقييم منشور استرشادي فقط.
# 3) للتواصل مع الوسيط: واتساب +201147758857.
`;
}

/** وصف أدوات MCP — مصدر واحد يستخدمه العامل والملفات الثابتة */
export function mcpToolDefinitions() {
  return [
    {
      name: 'search_properties',
      title: 'البحث في العقارات',
      description:
        'ابحث في الوحدات المعروضة بموقع سمسار طلبك (مدينة نصر والقاهرة الجديدة). يدعم التصفية بنوع المعاملة (sale/rent)، نوع العقار (apartment/villa/shop/office/warehouse)، المنطقة، نطاق السعر، نطاق المساحة، عدد الغرف، والتشطيب. يُعيد قائمة مضغوطة قابلة للاقتباس مع رابط كل وحدة.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction: { type: 'string', enum: ['sale', 'rent'], description: 'بيع أو إيجار' },
          property_type: { type: 'string', enum: ['apartment', 'villa', 'shop', 'office', 'warehouse', 'clinic'], description: 'نوع العقار' },
          zone: { type: 'string', description: 'اسم المنطقة أو الشارع، مثل: المنطقة السادسة، عباس العقاد، مكرم عبيد' },
          min_price: { type: 'number', description: 'أقل سعر بالجنيه المصري' },
          max_price: { type: 'number', description: 'أعلى سعر بالجنيه المصري' },
          min_area: { type: 'number', description: 'أقل مساحة بالمتر المربع' },
          max_area: { type: 'number', description: 'أعلى مساحة بالمتر المربع' },
          min_rooms: { type: 'integer', description: 'أقل عدد غرف' },
          furnished: { type: 'boolean', description: 'مفروش فقط عندما true' },
          query: { type: 'string', description: 'بحث نصي حر في العنوان والوصف والموقع' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'أقصى عدد نتائج' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_property',
      title: 'تفاصيل وحدة',
      description: 'يُرجع البيانات الكاملة لوحدة واحدة بمعرّفها (slug) أو برابطها.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'معرّف الوحدة (slug) أو الرابط الكامل' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'market_summary',
      title: 'ملخص السوق',
      description: 'إحصاءات مجمّعة من الأسعار المعروضة: العدد، الوسيط، الأقل والأعلى لكل نوع ومعاملة، وتوزيع المناطق. مشتقة من الأسعار المعروضة وليست تقييمًا معتمدًا.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction: { type: 'string', enum: ['sale', 'rent'] },
          property_type: { type: 'string', enum: ['apartment', 'villa', 'shop', 'office', 'warehouse', 'clinic'] },
          zone: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_zones',
      title: 'المناطق المخدومة',
      description: 'قائمة المناطق والشوارع المخدومة مع عدد الوحدات المتاحة في كل منطقة.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_contact',
      title: 'بيانات التواصل',
      description: 'بيانات التواصل الرسمية مع الوسيط طارق طنطاوي: واتساب، هاتف، بريد، عنوان المكتب، ومواعيد العمل.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

/** بطاقة MCP — تُخدَم على /.well-known/mcp.json و /.well-known/mcp/server-card.json */
export function renderMcpCard({ endpoint, properties, stamp }) {
  const date = stamp ?? new Date().toISOString();
  return {
    schema_version: '1.0',
    name: 'semsar-talabk',
    title: 'سمسار طلبك — بوابة عقارات مدينة نصر',
    description:
      'خادم MCP للقراءة فقط يعرض الوحدات المعروضة على موقع سمسار طلبك (مدينة نصر والقاهرة الجديدة) ويسمح لأي نموذج أو وكيل بالبحث فيها واسترجاع تفاصيلها واقتباسها بالإسناد.',
    version: '1.0.0',
    homepage: SITE,
    documentation: `${SITE}/llms.txt`,
    updated_at: date,
    transport: {
      type: 'streamable-http',
      endpoint,
      protocol_version: '2025-06-18',
      methods: ['initialize', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list'],
      supports_get_sse: false,
    },
    availability: MCP_GATEWAY_STATUS,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    },
    tools: mcpToolDefinitions().map((t) => ({ name: t.name, title: t.title, description: t.description })),
    resources: [
      { uri: 'semsar://catalog', name: 'كتالوج الوحدات', mimeType: 'application/json' },
      { uri: 'semsar://llms-full', name: 'الكتالوج الكامل (Markdown)', mimeType: 'text/markdown' },
      { uri: 'semsar://contact', name: 'بيانات التواصل', mimeType: 'application/json' },
    ],
    rest: {
      properties: `${SITE}/api/properties.json`,
      property: `${SITE}/api/properties/{slug}.json`,
      markdown: `${SITE}/api/properties/{slug}.md`,
      openapi: `${SITE}/api/openapi.json`,
    },
    counts: { properties: properties.length },
    contact: { email: 'samsar.talabak@mailo.com', whatsapp: '+201147758857' },
  };
}

/** مواصفة OpenAPI 3.1 — تجعل الواجهة قابلة للاستدعاء من أي أداة/وكيل */
export function renderOpenApi(properties) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'سمسار طلبك — واجهة العقارات',
      version: '1.0.0',
      summary: 'واجهة قراءة فقط لكل الوحدات المعروضة على موقع سمسار طلبك.',
      description:
        'واجهة ثابتة (static JSON) بلا مصادقة، مبنية من مجموعة _properties في مستودع الموقع. كل الاستجابات JSON وتتضمّن دائمًا schema_version. الأسعار أسعار طلب قابلة للتفاوض بالجنيه المصري.',
      contact: { name: 'طارق طنطاوي — سمسار طلبك', email: 'samsar.talabak@mailo.com', url: SITE },
      license: { name: 'الاقتباس مسموح مع الإسناد', url: `${SITE}/llms.txt` },
    },
    servers: [{ url: SITE }],
    tags: [
      { name: 'properties', description: 'الوحدات المعروضة' },
      { name: 'meta', description: 'بيانات وصفية وفهارس' },
    ],
    paths: {
      '/ai-feed.json': {
        get: {
          tags: ['properties'],
          operationId: 'getAiFeed',
          summary: 'التغذية الكاملة للعقارات',
          description: 'المصدر الأساسي الذي يستهلكه وكيل الموقع. يتضمّن كل الوحدات مع السعر الرقمي والمساحة والغرف.',
          responses: { 200: { description: 'التغذية', content: { 'application/json': { schema: { $ref: '#/components/schemas/Feed' } } } } },
        },
      },
      '/api/properties.json': {
        get: {
          tags: ['properties'],
          operationId: 'listProperties',
          summary: 'كل الوحدات + الفهارس',
          responses: { 200: { description: 'الكتالوج', content: { 'application/json': { schema: { $ref: '#/components/schemas/Catalog' } } } } },
        },
      },
      '/api/properties/{slug}.json': {
        get: {
          tags: ['properties'],
          operationId: 'getProperty',
          summary: 'وحدة واحدة',
          parameters: [
            {
              name: 'slug',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'معرّف الوحدة',
              example: properties[0]?.slug ?? 'example',
            },
          ],
          responses: {
            200: { description: 'الوحدة', content: { 'application/json': { schema: { $ref: '#/components/schemas/Property' } } } },
            404: { description: 'غير موجودة' },
          },
        },
      },
      '/api/properties/{slug}.md': {
        get: {
          tags: ['properties'],
          operationId: 'getPropertyMarkdown',
          summary: 'وحدة واحدة بصيغة Markdown (مناسبة للنماذج)',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Markdown', content: { 'text/markdown': { schema: { type: 'string' } } } } },
        },
      },
      '/api/index.json': {
        get: { tags: ['meta'], operationId: 'getApiIndex', summary: 'دليل الواجهة ونقاط الوصول', responses: { 200: { description: 'الدليل' } } },
      },
      '/llms.txt': { get: { tags: ['meta'], operationId: 'getLlmsTxt', summary: 'دليل الموقع للنماذج', responses: { 200: { description: 'نص' } } } },
      '/llms-full.txt': { get: { tags: ['meta'], operationId: 'getLlmsFull', summary: 'الكتالوج الكامل كنص Markdown', responses: { 200: { description: 'نص' } } } },
    },
    components: {
      schemas: {
        Property: {
          type: 'object',
          required: ['id', 'slug', 'title', 'url', 'transaction', 'propertyType'],
          properties: {
            id: { type: 'string' },
            slug: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string', format: 'uri' },
            transaction: { type: 'string', enum: ['sale', 'rent'] },
            propertyType: { type: 'string', enum: ['apartment', 'villa', 'shop', 'office', 'warehouse', 'clinic'] },
            category: { type: 'string' },
            location: { type: 'string' },
            zone: { type: ['string', 'null'] },
            price: { type: 'string' },
            priceNumeric: { type: ['integer', 'null'] },
            priceIsMonthly: { type: 'boolean' },
            currency: { type: 'string', const: 'EGP' },
            area: { type: 'string' },
            areaNumeric: { type: ['integer', 'null'] },
            rooms: { type: 'string' },
            roomsNumeric: { type: ['integer', 'null'] },
            baths: { type: 'string' },
            bathsNumeric: { type: ['integer', 'null'] },
            floor: { type: 'string' },
            finish: { type: 'string' },
            furnished: { type: ['string', 'null'], enum: ['furnished', 'unfurnished', null] },
            description: { type: 'string' },
            image: { type: ['string', 'null'], format: 'uri' },
            status: { type: 'string' },
            date: { type: ['string', 'null'], format: 'date-time' },
            datePosted: { type: ['string', 'null'], format: 'date' },
          },
        },
        Catalog: {
          type: 'object',
          properties: {
            schema_version: { type: 'string' },
            generated_at: { type: 'string', format: 'date-time' },
            total_count: { type: 'integer' },
            properties: { type: 'array', items: { $ref: '#/components/schemas/Property' } },
            facets: { type: 'object' },
          },
        },
        Feed: { allOf: [{ $ref: '#/components/schemas/Catalog' }] },
      },
    },
  };
}

/** search-data.json — فهرس بحث خفيف كان مذكورًا في robots.txt ولم يكن مُولّدًا */
export function renderSearchData(properties) {
  return {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    total_count: properties.length,
    fields: ['id', 't', 'u', 'tx', 'pt', 'z', 'p', 'a', 'r'],
    properties: properties.map((p) => ({
      id: p.slug,
      t: p.title,
      u: `/properties/${p.slug}/`,
      tx: p.transaction,
      pt: p.propertyType,
      z: p.zone,
      p: p.priceNumeric,
      a: p.areaNumeric,
      r: p.roomsNumeric,
    })),
  };
}
