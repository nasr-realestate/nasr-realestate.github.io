import express from 'express';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { Liquid } from 'liquidjs';
import { marked } from 'marked';
import yaml from 'js-yaml';

const app = express();
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
  description: 'خبير عقارات مدينة نصر والقاهرة الجديدة منذ 2014. شقق، محلات، ومكاتب بأسعار السوق الواقعية.',
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
if (fs.existsSync('_properties')) {
  const files = fs.readdirSync('_properties');
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const fullPath = path.join('_properties', file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = matter(raw);
      const slug = file.replace(/\.md$/, '');
      const propData = {
        ...parsed.data,
        slug,
        id: `/properties/${slug}`,
        url: `/properties/${slug}/`,
        collection: 'properties',
        date: parsed.data.date ? new Date(parsed.data.date) : new Date('2026-01-01'),
        rawContent: parsed.content,
        htmlContent: marked.parse(parsed.content),
      };
      properties.push(propData);
      propertiesMap.set(slug, propData);
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
      const slug = file.replace(/\.md$/, '');
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
    } catch (err) {
      console.warn(`Failed to load request ${file}:`, err.message);
    }
  }
}

requests.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

const site = {
  ...siteConfig,
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

app.get(['/properties/:slug', '/properties/:slug/'], async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const prop = propertiesMap.get(slug);
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
      res.setHeader('Content-Type', 'application/json');
    }
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

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
