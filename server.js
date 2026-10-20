import express from 'express';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { Liquid } from 'liquidjs';
import { marked } from 'marked';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

// ═══ طبقة الذكاء الاصطناعي (2026-10-16) ═══
// نفس المُولّدات التي يستخدمها نشر GitHub Pages (scripts/build-ai-artifacts.mjs)
// تُشغَّل هنا في الذاكرة، حتى تُعاين المعاينة المحلية ما سيُنشر بالحرف:
//   /llms-full.txt · /api/** · /search-data.json · /.well-known/**
// بلا كتابة أي ملف على القرص وبلا تأخير بدء تشغيل.
import {
  renderLlmsFull, renderPropertyMarkdown, renderAiTxt,
  renderMcpCard, renderOpenApi, renderSearchData, SITE as AI_SITE,
} from './scripts/lib/ai-docs.mjs';
import { loadProperties as loadAiProperties, buildFacets as buildAiFacets } from './scripts/lib/properties.mjs';
import { buildFeed as buildAiFeed, buildPropertyDocument as buildAiPropertyDoc } from './scripts/build-ai-artifacts.mjs';

const AI_MCP_ENDPOINT = 'https://nasr-ai-gateway.footcai-555.workers.dev/mcp';
const AI_SCHEMA_VERSION = '3.0';
let _aiCache = { at: 0, props: null };
function aiProperties() {
  // كاش 10 ثوانٍ حتى تظهر أي إضافة جديدة في المعاينة فورًا تقريبًا
  if (_aiCache.props && Date.now() - _aiCache.at < 10_000) return _aiCache.props;
  _aiCache = { at: Date.now(), props: loadAiProperties(path.resolve('_properties')) };
  return _aiCache.props;
}

const app = express();
// لا نكشف إصدار الإطار في الترويسات (SonarCloud S5689)
app.disable('x-powered-by');
const PORT = 3000;
const HOST = '0.0.0.0';

// Setup LiquidJS template engine
const engine = new Liquid({
  root: [
    path.resolve('.'),
    path.resolve('_layouts'),
    path.resolve('_includes'),
  ],
  extname: '.html',
  dynamicPartials: false,
  strictFilters: false,
  strictVariables: false,
  jekyllInclude: true,
});

// Jekyll custom filters & tags
engine.registerFilter('relative_url', (v) => (v ? String(v) : ''));
engine.registerFilter('absolute_url', (v) => (v ? String(v) : ''));
engine.registerFilter('jsonify', (v) => JSON.stringify(v));
engine.registerFilter('date_to_xmlschema', (v) => {
  try {
    return new Date(v).toISOString();
  } catch {
    return '';
  }
});

engine.registerTag('seo', {
  render: (scope) => {
    const page = scope.environments.page || {};
    const site = scope.environments.site || {};
    const title = page.title || site.title || 'سمسار طلبك | طارق طنطاوي';
    const desc = page.description || site.description || '';
    const img = page.image || site.default_image || '/assets/img/social-home.png';
    const url = page.url || '/';
    return `
      <title>${title}</title>
      <meta name="description" content="${desc}">
      <meta property="og:title" content="${title}">
      <meta property="og:description" content="${desc}">
      <meta property="og:image" content="${img}">
      <meta property="og:url" content="${url}">
      <meta property="og:type" content="website">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:title" content="${title}">
      <meta name="twitter:description" content="${desc}">
      <meta name="twitter:image" content="${img}">
    `.trim();
  },
});

// Load site configuration
let siteConfig = {
  title: 'سمسار طلبك | طارق طنطاوي',
  title_separator: '|',
  description: 'خبير عقارات مدينة نصر منذ 2014: بيع وإيجار شقق، محلات، ومكاتب بأسعار السوق الواقعية.',
  url: '',
  baseurl: '',
  lang: 'ar',
  locale: 'ar_EG',
  default_image: '/assets/img/social-home.png',
  logo: '/assets/img/logo.webp',
  author: {
    name: 'طارق طنطاوي',
    phone: '+201147758857',
    twitter: 'tarekproptech',
    url: '/about-us.html',
    avatar: '/assets/img/team/tareq.webp',
  },
  contact: {
    whatsapp: '+201147758857',
    whatsapp_url: 'https://wa.me/201147758857',
    email: 'samsar.talabak@mailo.com',
    alaa_phone: '+201022171667',
    alaa_whatsapp_url: 'https://wa.me/201022171667',
  },
  office: {
    address: '16 شارع محمد حسن الجمل - المنطقة السادسة - مدينة نصر',
    map_url: 'https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7',
    hours: 'من 12 الضهر لحد 9 بالليل، ما عدا الجمعة',
    hours_exception: 'الجمعة إجازة',
  },
  social: {
    name: 'سمسار طلبك',
    links: [
      'https://www.facebook.com/Tarekonly',
      'https://www.linkedin.com/company/smsar-talabk-madinat-nasr/',
      'https://maps.app.goo.gl/jQBJvzfxA4vzo6Qe7',
    ],
  },
};

if (fs.existsSync('_config.yml')) {
  try {
    const yamlConfig = yaml.load(fs.readFileSync('_config.yml', 'utf8'));
    if (yamlConfig && typeof yamlConfig === 'object') {
      siteConfig = { ...siteConfig, ...yamlConfig, url: '', baseurl: '' };
    }
  } catch (err) {
    console.warn('Failed to parse _config.yml:', err.message);
  }
}

// Load properties collection
const properties = [];
const propertiesMap = new Map();
// خريطة slug الـ front matter → العقار.
// Jekyll ينشر العقار على /properties/<slug من الـfront matter>/ بينما
// هذا الخادم كان يطابق اسم الملف فقط. الخريطة تجعل رابط المعاينة المحلي
// مطابقًا تمامًا للرابط الإنتاجي. (أداة تطوير محلية فقط — لا تدخل بناء Jekyll.)
const propertiesByFrontSlug = new Map();
if (fs.existsSync('_properties')) {
  const files = fs.readdirSync('_properties');
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const fullPath = path.join('_properties', file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = matter(raw);
      const fileSlug = file.replace(/\.md$/, '');
      // Jekyll ينشر الوثيقة على /properties/<slug من الـfront matter>/ — اسم الملف
      // مجرد اسم تخزين. المعاينة كانت تطابق اسم الملف فقط، فتحوّل 58 رابطًا من
      // روابط الإنتاج إلى 404 محليًا. الآن الأولوية لـparsed.data.slug، واسم
      // الملف يبقى alias نشطًا للملفات القديمة.
      const slug = String(parsed.data.slug || '').trim() || fileSlug;
      const propData = {
        ...parsed.data,
        slug,
        relative_path: `_properties/${file}`,
        path: `_properties/${file}`,
        id: `/properties/${slug}`,
        url: `/properties/${slug}/`,
        collection: 'properties',
        date: parsed.data.date ? new Date(parsed.data.date) : new Date('2026-01-01'),
        rawContent: parsed.content,
        htmlContent: marked.parse(parsed.content),
      };
      properties.push(propData);
      propertiesMap.set(slug, propData);
      propertiesMap.set(fileSlug, propData);
      propertiesByFrontSlug.set(slug, propData);
    } catch (err) {
      console.warn(`Failed to load property ${file}:`, err.message);
    }
  }
}

// Sort properties by date reverse
properties.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

// Load requests collection
const requests = [];
const requestsMap = new Map();
if (fs.existsSync('_requests')) {
  const files = fs.readdirSync('_requests');
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const fullPath = path.join('_requests', file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = matter(raw);
      const fileSlug = file.replace(/\.md$/, '');
      const slug = String(parsed.data.slug || '').trim() || fileSlug;
      const reqData = {
        ...parsed.data,
        slug,
        id: `/requests/${slug}`,
        url: `/requests/${slug}/`,
        collection: 'requests',
        date: parsed.data.date ? new Date(parsed.data.date) : new Date('2026-10-01'),
        rawContent: parsed.content,
        htmlContent: marked.parse(parsed.content),
      };
      requests.push(reqData);
      requestsMap.set(slug, reqData);
      requestsMap.set(fileSlug, reqData);
    } catch (err) {
      console.warn(`Failed to load request ${file}:`, err.message);
    }
  }
}

requests.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

// ═══ Jekyll Data Files (_data/*.yml) — تدقيق الصور (2026-10-17) ═══
// كانت المعاينة المحلية تفتقد site.data بينما Jekyll الحقيقي يقرأه،
// فلا يمكن التحقق محليًا من أي قالب يستخدم _data (مثل image_dims.yml).
const siteData = {};
if (fs.existsSync('_data')) {
  for (const f of fs.readdirSync('_data')) {
    // 2026-10-20: ‏Jekyll يقرأ _data/*.json أيضًا (listing_facets.json، landing_segments.json)
    if (f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json')) {
      try {
        const raw = fs.readFileSync(path.join('_data', f), 'utf8');
        siteData[path.basename(f, path.extname(f))] = f.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      } catch (err) {
        console.warn(`_data/${f}: تعذر التحليل —`, err.message);
      }
    }
  }
}

const site = {
  ...siteConfig,
  data: siteData,
  properties,
  requests,
  time: new Date(),
};

// Render helper with nested layouts
async function renderPage(templateContent, pageData) {
  let content = await engine.parseAndRender(templateContent, {
    site,
    page: pageData,
  });

  let currentLayout = pageData.layout || 'default';
  let currentData = { ...pageData };

  while (currentLayout && currentLayout !== 'none') {
    const layoutPath = path.join('_layouts', `${currentLayout}.html`);
    if (!fs.existsSync(layoutPath)) break;
    const layoutRaw = fs.readFileSync(layoutPath, 'utf8');
    const parsedLayout = matter(layoutRaw);
    currentData = { ...currentData, ...parsedLayout.data };
    content = await engine.parseAndRender(parsedLayout.content, {
      site,
      page: currentData,
      content,
    });
    currentLayout = parsedLayout.data.layout;
  }

  return content;
}

async function renderFile(filePath, customPageData = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(raw);
  const pageData = {
    ...parsed.data,
    ...customPageData,
    url: customPageData.url || parsed.data.url || '/',
  };
  return renderPage(parsed.content, pageData);
}

// Middleware
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// 2026-10-20 — ملف بيانات البحث يُولَّد بـ Liquid في Jekyll (front matter)، فيُصيَّر هنا قبل الملفات الساكنة.
app.get('/assets/data/catalog.json', async (req, res, next) => {
  try {
    const raw = fs.readFileSync('assets/data/catalog.json', 'utf8');
    const parsed = matter(raw);
    const out = await engine.parseAndRender(parsed.content, { site, page: { ...parsed.data, url: req.path } });
    res.type('application/json; charset=utf-8').send(out);
  } catch (err) {
    next(err);
  }
});

// Static assets
app.use('/assets', express.static(path.resolve('assets')));

// Proxy for Cloudflare Workers (CORS & reliable backend connectivity)
app.use('/api/proxy/agent', async (req, res) => {
  try {
    const targetUrl = 'https://royal-snow-ea32.footcai-555.workers.dev' + req.url;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });
    const data = await response.text();
    res.status(response.status).set('Content-Type', response.headers.get('content-type') || 'application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
});

app.use('/api/proxy/valuation', async (req, res) => {
  try {
    const targetUrl = 'https://noisy-bush-fd84.footcai-555.workers.dev' + req.url;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });
    const data = await response.text();
    res.status(response.status).set('Content-Type', response.headers.get('content-type') || 'application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
});

// App routes
app.get('/', async (req, res, next) => {
  try {
    const html = await renderFile('index.html', { url: '/' });
    res.send(html);
  } catch (err) {
    next(err);
  }
});

app.get(['/properties', '/properties/'], async (req, res, next) => {
  try {
    const html = await renderFile('properties.html', { url: '/properties/' });
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// 2026-10-20 — صفحات ترقيم المعرض (properties/page/N.html بـ permalink /properties/page/N/)
app.get(['/properties/page/:n', '/properties/page/:n/'], async (req, res, next) => {
  try {
    const n = String(req.params.n);
    const file = path.join('properties', 'page', `${n}.html`);
    if (!/^\d+$/.test(n) || !fs.existsSync(file)) return next();
    const html = await renderFile(file, { url: `/properties/page/${n}/` });
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// 2026-10-20 — صفحات الهبوط (properties/<key>.html بـ permalink /properties/<key>/) قبل صفحات العقارات.
app.get(['/properties/:key', '/properties/:key/'], async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const file = path.join('properties', `${key}.html`);
    if (!/^[a-z0-9-]+$/.test(key) || !fs.existsSync(file)) return next();
    const html = await renderFile(file, { url: `/properties/${key}/` });
    res.send(html);
  } catch (err) {
    next(err);
  }
});

app.get(['/properties/:slug', '/properties/:slug/'], async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const prop = propertiesMap.get(slug) || propertiesByFrontSlug.get(slug);
    if (!prop) {
      return res.status(404).send(await renderFile('404.html', { url: req.path }));
    }
    const pageData = {
      ...prop,
      layout: prop.layout || 'property_page',
      content: prop.htmlContent,
    };
    const html = await renderPage(prop.rawContent, pageData);
    res.send(html);
  } catch (err) {
    next(err);
  }
});

app.get(['/requests', '/requests/'], async (req, res, next) => {
  try {
    const html = await renderFile('requests.html', { url: '/requests/' });
    res.send(html);
  } catch (err) {
    next(err);
  }
});

app.get(['/requests/:slug', '/requests/:slug/'], async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const reqItem = requestsMap.get(slug);
    if (!reqItem) {
      return res.status(404).send(await renderFile('404.html', { url: req.path }));
    }
    const pageData = {
      ...reqItem,
      layout: reqItem.layout || 'request_page',
      content: reqItem.htmlContent,
    };
    const html = await renderPage(reqItem.rawContent, pageData);
    res.send(html);
  } catch (err) {
    next(err);
  }
});

app.get(['/agent', '/agent.html'], async (req, res, next) => {
  try {
    const html = await renderFile('agent.html', { url: '/agent.html' });
    res.send(html);
  } catch (err) {
    next(err);
  }
});

app.get(['/tools/valuation', '/tools/valuation.html', '/assets/tools/valuation.html'], (req, res) => {
  const filePath = path.resolve('tools/valuation.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Valuation tool not found');
  }
});

// ═══════════════════════════════════════════════════════════
//  مسارات طبقة الذكاء الاصطناعي (معاينة محلية فقط)
//  الإنتاج يُنتج نفس الملفات ثابتةً داخل _site عبر
//  scripts/build-ai-artifacts.mjs — راجع .github/workflows/deploy.yml
// ═══════════════════════════════════════════════════════════
const aiJson = (res, body) => res.type('application/json; charset=utf-8').send(JSON.stringify(body, null, 2));

// ai-feed.json: القالب في الجذر (ai-feed.json) مصدر Liquid خام. في الإنتاج
// يكتب المُولّد النسخة النهائية داخل _site، وهنا نبنيها في الذاكرة بنفس
// الدالة تمامًا حتى تُعاين المعاينة المحلية الملف الحقيقي لا مصدره.
app.get('/ai-feed.json', (req, res) => {
  aiJson(res, buildAiFeed(aiProperties(), new Date().toISOString()));
});

app.get('/llms-full.txt', (req, res) => {
  res.type('text/markdown; charset=utf-8').send(renderLlmsFull(aiProperties()));
});

app.get('/search-data.json', (req, res) => aiJson(res, renderSearchData(aiProperties())));

app.get('/api/index.json', (req, res) => {
  const props = aiProperties();
  const facets = buildAiFacets(props);
  aiJson(res, {
    schema_version: AI_SCHEMA_VERSION,
    name: 'سمسار طلبك — واجهة العقارات',
    generated_at: new Date().toISOString(),
    total_count: props.length,
    base_url: AI_SITE,
    mcp: { endpoint: AI_MCP_ENDPOINT, transport: 'streamable-http' },
    facets,
    endpoints: [
      { path: '/llms.txt', format: 'text/markdown' },
      { path: '/llms-full.txt', format: 'text/markdown' },
      { path: '/ai-feed.json', format: 'application/json' },
      { path: '/api/properties.json', format: 'application/json' },
      { path: '/api/properties/{slug}.json', format: 'application/json' },
      { path: '/api/properties/{slug}.md', format: 'text/markdown' },
      { path: '/api/openapi.json', format: 'application/json' },
      { path: '/search-data.json', format: 'application/json' },
      { path: '/.well-known/ai.txt', format: 'text/plain' },
      { path: '/.well-known/mcp.json', format: 'application/json' },
    ],
  });
});

app.get('/api/openapi.json', (req, res) => aiJson(res, renderOpenApi(aiProperties())));

app.get('/api/properties.json', (req, res) => {
  const props = aiProperties();
  aiJson(res, {
    schema_version: AI_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    total_count: props.length,
    base_url: AI_SITE,
    facets: buildAiFacets(props),
    properties: props,
  });
});

app.get('/api/properties/:slug.json', (req, res) => {
  const slug = req.params.slug;
  const prop = aiProperties().find((p) => p.slug === slug);
  if (!prop) return res.status(404).json({ error: 'NOT_FOUND', id: slug });
  aiJson(res, buildAiPropertyDoc(prop, new Date().toISOString()));
});

app.get('/api/properties/:slug.md', (req, res) => {
  const prop = aiProperties().find((p) => p.slug === req.params.slug);
  if (!prop) return res.status(404).type('text/plain').send('NOT_FOUND');
  res.type('text/markdown; charset=utf-8').send(renderPropertyMarkdown(prop));
});

app.get('/.well-known/ai.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(renderAiTxt(aiProperties(), { stamp: new Date().toISOString().slice(0, 10), mcpEndpoint: AI_MCP_ENDPOINT }));
});


app.get(['/.well-known/mcp.json', '/.well-known/mcp/server-card.json', '/mcp.json'], (req, res) => {
  aiJson(res, renderMcpCard({ endpoint: AI_MCP_ENDPOINT, properties: aiProperties() }));
});

// نسخة جذرية موازية — للتغطية لو حجب ناشر ما المجلدات النقطية
app.get('/ai.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(renderAiTxt(aiProperties(), { stamp: new Date().toISOString().slice(0, 10), mcpEndpoint: AI_MCP_ENDPOINT }));
});

// Dynamic handler for any other top-level HTML page (about-us, contact-us, add-your-property, etc.)
app.get('/:page', async (req, res, next) => {
  try {
    const pageParam = req.params.page;
    const pageName = pageParam.endsWith('.html') ? pageParam : `${pageParam}.html`;
    const filePath = path.resolve(pageName);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const html = await renderFile(pageName, { url: `/${pageParam}` });
      return res.send(html);
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Serve root static files (manifest, favicon, robots.txt, etc.)
app.use(express.static(path.resolve('.'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } else if (filePath.endsWith('.txt') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    // المعاينة تُحاكي GitHub Pages، وهي تُخدِم بترويسة CORS مفتوحة.
    // بدونها يبدو أن الواجهة غير قابلة للاستدعاء من وكيل خارجي أثناء التجربة.
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

// 404 handler
app.use(async (req, res) => {
  try {
    if (fs.existsSync('404.html')) {
      const html = await renderFile('404.html', { url: req.path });
      res.status(404).send(html);
    } else {
      res.status(404).send('Page Not Found');
    }
  } catch {
    res.status(404).send('Page Not Found');
  }
});

// Start server — عند الاستيراد من الاختبارات لا نفتح منفذًا تلقائيًا.
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
  });
}

export { app };
