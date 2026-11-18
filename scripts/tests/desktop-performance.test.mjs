import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const code = read('_includes/analytics.html').match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

function boot({ ready = 'loading', fonts = true, scheduler = false, idle = true } = {}) {
  const events = new Map();
  const frames = [], timers = [], idles = [], scripts = [], priorities = [];
  let resolveFonts, rejectFonts;
  const promise = new Promise((resolve, reject) => { resolveFonts = resolve; rejectFonts = reject; });
  const queue = [{ event: 'existing-event' }];
  const window = {
    dataLayer: queue,
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
    requestAnimationFrame: fn => frames.push(fn),
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); },
  };
  if (idle) window.requestIdleCallback = fn => idles.push(fn);
  if (scheduler) window.scheduler = { postTask: (fn, opts) => {
    priorities.push(opts.priority); idles.push(fn); return Promise.resolve();
  } };
  const document = {
    readyState: ready,
    fonts: fonts ? { ready: promise } : undefined,
    createElement: tag => ({ tagName: tag }),
    head: { appendChild: s => scripts.push(s) },
  };
  vm.runInNewContext(code, { window, document, Promise, Date });
  return {
    window, events, frames, timers, idles, scripts, priorities, queue,
    resolveFonts, rejectFonts,
    fire: name => events.get(name)?.(),
    paint: () => { frames.splice(0).forEach(fn => fn()); timers.splice(0).forEach(t => t.fn()); },
    runIdle: () => idles.splice(0).forEach(fn => fn()),
  };
}

test('analytics keeps existing events and queues its bootstrap before fonts load', async () => {
  const a = boot();
  assert.equal(a.window.dataLayer, a.queue);
  assert.equal(a.queue[0].event, 'existing-event');
  assert.equal(a.queue[1].event, 'gtm.js');
  a.fire('load'); a.fire('scroll'); a.fire('pointerdown');
  await tick();
  assert.equal(a.scripts.length, 0);
  assert.equal(a.frames.length, 0);
  a.queue.push({ event: 'contact-before-ready' });
  a.resolveFonts(); await tick();
  assert.equal(a.frames.length, 1);
  a.paint(); a.runIdle();
  assert.equal(a.scripts.length, 1);
  assert.equal(a.scripts[0].src, 'https://www.googletagmanager.com/gtm.js?id=GTM-5BTRF7NP');
  assert.equal(a.scripts[0].async, true);
  assert.equal(a.scripts[0].fetchPriority, 'low');
  assert.equal(a.queue[2].event, 'contact-before-ready');
  assert.ok(!a.events.has('pointerdown'));
  a.fire('load'); a.paint(); a.runIdle();
  assert.equal(a.scripts.length, 1, 'load and interactions cannot duplicate analytics');
});

test('already-loaded pages use native background task priority after paint', async () => {
  const a = boot({ ready: 'complete', scheduler: true });
  a.resolveFonts(); await tick();
  assert.equal(a.scripts.length, 0);
  a.paint();
  assert.equal(a.priorities[0], 'background');
  a.runIdle();
  assert.equal(a.scripts.length, 1);
});

test('font failure still schedules analytics; older browsers have a task fallback', async () => {
  const a = boot(); a.fire('load'); a.rejectFonts(new Error('blocked fonts')); await tick();
  a.paint(); a.runIdle(); assert.equal(a.scripts.length, 1);
  const b = boot({ ready: 'complete', fonts: false, idle: false });
  b.paint(); // first task schedules the background fallback task
  assert.equal(b.scripts.length, 0);
  assert.equal(b.timers[0].delay, 0);
  b.paint(); assert.equal(b.scripts.length, 1);
});

const luminance = hex => {
  const rgb = hex.match(/[\da-f]{2}/gi).map(v => parseInt(v, 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
test('credibility badge has AA text contrast on its actual green background', () => {
  const dark = luminance('050505'), green = luminance('42c541');
  assert.ok((green + .05) / (dark + .05) >= 4.5);
  assert.match(read('assets/css/route-home.min.css'), /body.homepage .hp-agent-badge\{color:#050505\}/);
});

test('hero width and minimum line height do not depend on font zero-glyph width', () => {
  // ⚠️ 2026-11-18: هذا الاختبار كان يثبّت `max-width: 7.2em` و`min-height: 3.6em`
  // على عنوان الهيرو — وهي بالضبط القيم التي كانت تقطع الكلمة العربية الواحدة
  // فتُظهر النص «بحروف مبعثرة». القيمة المقصودة ليست رقمًا بعينه بل **ألا يعتمد
  // العرض على عرض صفر-الحرف في الخط**: نستخدم clamp() بوحدة vw + عرضًا كاملًا
  // + ارتفاع سطر بوحدة em محسوبة من مقاس النص نفسه.
  const css = read('assets/css/style.css');
  const hero = css.split('body.homepage .hp-hero-title {');
  assert.ok(hero.length > 3, 'قواعد عنوان الهيرو');
  const joined = hero.slice(1).map((b) => b.split('}')[0]).join('\n');
  assert.match(joined, /font-size:\s*clamp\([^)]*vw/, 'عرض متجاوب بوحدة vw لا em ثابت');
  assert.match(joined, /max-width:\s*100%/, 'العنوان يأخذ عرض الحاوية كاملًا');
  assert.doesNotMatch(joined, /max-width:\s*\d+(\.\d+)?em/, 'عرض بالـem يقطع الكلمة العربية');
  assert.match(read('_includes/cairo.html'), /cairo-arabic-900-normal\.woff2/);
});

test('both layouts share the loader and preserve the noscript GTM fallback', () => {
  for (const f of ['_layouts/default.html', '_layouts/app.html']) {
    assert.match(read(f), /include analytics.html/);
    assert.match(read(f), /googletagmanager.com\/ns.html\?id=GTM-5BTRF7NP/);
  }
});

test('home preview manifest contains smaller local variants and a safe src fallback', () => {
  const manifest = JSON.parse(read('_data/home_previews.json'));
  assert.ok(Object.keys(manifest).length > 0);
  for (const [original, preview] of Object.entries(manifest)) {
    const a = fs.statSync(new URL(`../../${original.slice(1)}`, import.meta.url));
    const b = fs.statSync(new URL(`../../${preview.src.slice(1)}`, import.meta.url));
    assert.ok(b.size < a.size, `${original}: preview must be smaller`);
    assert.ok(preview.original_width >= 800);
  }
  const html = read('index.html');
  assert.match(html, /src="\{\{ f.card_image \| relative_url \}\}"/);
  assert.match(html, /\{% if preview %\}srcset=/);
  assert.match(html, /preview.original_width/);
});
