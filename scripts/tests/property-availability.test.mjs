import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { once } from 'node:events';
import { app } from '../../server.js';
import { Liquid } from 'liquidjs';

const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const code = read('assets/js/property-availability.js');

function target() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener: (name, fn) => handlers.set(name, fn),
    removeEventListener: name => handlers.delete(name),
    fire: (name, e = {}) => handlers.get(name)?.(e),
  };
}
function boot({ stored = new Map(), property = 'unit-a', blockedStorage = false, io = true, missing = false } = {}) {
  let now = 0, id = 0, callback, disconnected = 0, focusCount = 0, options;
  const pending = new Map();
  const close = target(), inquiry = target(), message = { textContent: 'خلّينا نتأكد لك إنه ما زال متاحًا، وننسّق الخطوة الجاية.' };
  const description = { ...target(), attrs: new Map(),
    hasAttribute(name) { return this.attrs.has(name); },
    setAttribute(name, value) { this.attrs.set(name, value); },
    removeAttribute(name) { this.attrs.delete(name); },
    focus(opts) { focusCount++; assert.equal(opts.preventScroll, true); },
  };
  const classes = new Set();
  const prompt = { ...target(), hidden: false,
    getAttribute: name => name === 'data-property' ? property : null,
    classList: { add: name => classes.add(name) },
    querySelector: s => ({ '[data-availability-close]': close, '[data-availability-message]': message })[s],
    closest: () => description,
  };
  const document = { ...target(), visibilityState: 'visible', querySelector: () => missing ? null : prompt,
    querySelectorAll: () => [inquiry] };
  const window = {
    sessionStorage: {
      getItem: key => { if (blockedStorage) throw Error('denied'); return stored.get(key) ?? null; },
      setItem: (key, value) => { if (blockedStorage) throw Error('denied'); stored.set(key, value); },
    },
    setTimeout: (fn, delay) => { pending.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout: timer => pending.delete(timer),
  };
  if (io) window.IntersectionObserver = class {
    constructor(fn, opts) { callback = fn; options = opts; }
    observe(el) { assert.equal(el, prompt); }
    disconnect() { disconnected++; }
  };
  // No fetch, window.open, alerts or focus APIs are provided: auto-contact fails.
  vm.runInNewContext(code, { window, document });
  return {
    prompt, close, inquiry, description, document, pending, stored, classes,
    disconnected: () => disconnected, focused: () => focusCount,
    options: () => options,
    intersect: (visible, ratio = 1) => callback?.([{ target: prompt, isIntersecting: visible, intersectionRatio: ratio }]),
    advance(ms) {
      now += ms;
      for (const [timer, t] of [...pending]) if (t.at <= now) { pending.delete(timer); t.fn(); }
    },
  };
}

test('notification requires two uninterrupted seconds in view, no early timer or focus', () => {
  const a = boot();
  assert.equal(a.pending.size, 0);
  a.intersect(true, .2); a.advance(3000);
  assert.equal(a.classes.has('is-visible'), false);
  a.intersect(true); a.advance(1000); a.intersect(false); a.advance(5000);
  assert.equal(a.classes.has('is-visible'), false);
  a.intersect(true); a.advance(1999);
  assert.equal(a.classes.has('is-visible'), false);
  a.advance(1);
  assert.equal(a.classes.has('is-visible'), true);
  assert.equal(a.focused(), 0);
  assert.equal(a.stored.get('smsar:availability:unit-a'), '1');
  assert.equal(a.disconnected(), 1);
  assert.equal(a.document.handlers.has('visibilitychange'), false);
});

test('hidden tabs pause the delay rather than displaying on return immediately', () => {
  const a = boot(); a.intersect(true); a.advance(1000);
  a.document.visibilityState = 'hidden'; a.document.fire('visibilitychange'); a.advance(5000);
  assert.equal(a.classes.has('is-visible'), false);
  a.document.visibilityState = 'visible'; a.document.fire('visibilitychange'); a.advance(1999);
  assert.equal(a.classes.has('is-visible'), false);
  a.advance(1); assert.equal(a.classes.has('is-visible'), true);
});

test('per-property session flag suppresses repeats but not a different property', () => {
  const stored = new Map([['smsar:availability:unit-a', '1']]);
  const a = boot({ stored });
  assert.equal(a.prompt.hidden, true); assert.equal(a.pending.size, 0);
  const b = boot({ stored, property: 'unit-b' });
  b.intersect(true); b.advance(2000);
  assert.equal(b.classes.has('is-visible'), true);
});

test('closing and Escape hide the invitation and preserve keyboard context', () => {
  for (const keyboard of [true, false]) {
    const a = boot(); a.intersect(true); a.advance(2000);
    if (keyboard) {
      let prevented = false;
      a.prompt.fire('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    } else a.close.fire('click');
    assert.equal(a.prompt.hidden, true); assert.equal(a.focused(), 1);
    assert.equal(a.description.attrs.get('tabindex'), '-1');
    a.description.fire('blur'); assert.equal(a.description.attrs.has('tabindex'), false);
  }
});

test('text-only reminder works and can close when storage is denied', () => {
  const a = boot({ blockedStorage: true }); a.intersect(true); a.advance(2000);
  assert.equal(a.classes.has('is-visible'), true);
  a.close.fire('click');
  assert.equal(a.prompt.hidden, true); assert.equal(a.focused(), 1);
  a.intersect(true); a.advance(5000); assert.equal(a.pending.size, 0);
});

test('using the existing inquiry button suppresses a later reminder without cancelling navigation', () => {
  const a = boot({ blockedStorage: true });
  a.intersect(true); a.advance(1000);
  a.inquiry.fire('click', { preventDefault() { assert.fail('must preserve the native inquiry'); } });
  assert.equal(a.prompt.hidden, true);
  a.intersect(true); a.advance(5000);
  assert.equal(a.pending.size, 0);
  assert.equal(a.classes.has('is-visible'), false);
  const b = boot();
  b.inquiry.fire('click');
  const revisited = boot({ stored: b.stored });
  assert.equal(revisited.prompt.hidden, true);
});

test('no observer gets a static callout; pages without a prompt do nothing', () => {
  const a = boot({ io: false });
  assert.equal(a.classes.has('is-visible'), true); assert.equal(a.pending.size, 0);
  const b = boot({ missing: true }); assert.equal(b.pending.size, 0);
});

const engine = new Liquid({ strictFilters: false });
engine.registerFilter('relative_url', v => v);
engine.registerFilter('url_encode', v => encodeURIComponent(v));
const template = read('_includes/property-availability.html');
function context({ inArea = true, status = 'available', enabled = true } = {}) {
  return {
    site: { url: 'https://nasr-realestate.github.io', data: { listing_facets: { listings: { example: { in_area: inArea } } } } },
    page: { slug: 'example', title: 'شقة 200م & اختبار "العنوان"', url: '/properties/example/', status, availability_prompt: enabled },
  };
}

test('reminder is text only and directs users to the combined primary action', async () => {
  const h = await engine.parseAndRender(template, context());
  assert.equal((h.match(/data-availability-prompt/g) || []).length, 1);
  assert.match(h, /قبل ترتيب المعاينة/);
  assert.match(h, /اسأل عن التفاصيل والتوافر/);
  assert.match(h, /aria-live="polite"/);
  assert.doesNotMatch(h, /<a\b|wa\.me|data-availability-contact|aria-modal|role="dialog"|autofocus|window.open/);
  assert.match(h, /<noscript>/);
});

test('out-of-area, unavailable and opt-out pages are not promoted', async () => {
  for (const opts of [{ inArea: false }, { enabled: false }, { status: 'sold' }, { status: 'rented' }, { status: 'unavailable' }, { status: 'Sold' }, { status: ' RENTED ' }]) {
    const h = await engine.parseAndRender(template, context(opts));
    assert.doesNotMatch(h, /data-availability-prompt|property-availability.js/);
  }
});

test('prompt CSS stays in the property bundle, uses no overlay, respects print/motion', () => {
  const css = read('assets/css/route-property.min.css');
  assert.match(css, /\.pp-availability\{visibility:hidden;display:grid/);
  assert.match(css, /\.pp-availability\[hidden\]\{display:none\}/);
  assert.match(css, /prefers-reduced-motion:no-preference/);
  assert.match(css, /@media print\{body.layout-property_page .pp-availability\{display:none\}/);
  assert.doesNotMatch(read('assets/css/route-home.min.css'), /\.pp-availability/);
  assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|window.open|\.focus\(\)/);
});

test('rendered property has one invitation inside its description, other pages have none', async () => {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base + '/properties/apartment-sale-moussa-el-kazem-nasr-city-280m/')).text();
    assert.equal((html.match(/data-availability-prompt/g) || []).length, 1);
    assert.ok(html.indexOf('id="ppDescription"') < html.indexOf('data-availability-prompt'));
    assert.ok(html.indexOf('data-availability-prompt') < html.indexOf('class="pp-agent-card"'));
    assert.ok(html.includes('id="ppMainImage"'));
    const primary = html.match(/<a[^>]+id="ppWaBtn"[^>]*>[\s\S]*?<\/a>/)[0];
    assert.ok(primary.includes('اسأل عن التفاصيل والتوافر'));
    const href = primary.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&');
    const url = new URL(href);
    assert.equal(url.pathname, '/201147758857');
    const message = url.searchParams.get('text');
    assert.ok(message.includes('ما زال متاحًا'));
    assert.ok(message.includes('معرفة التفاصيل'));
    assert.ok(message.includes('موعد للمعاينة'));
    assert.ok(message.includes('https://nasr-realestate.github.io/properties/apartment-sale-moussa-el-kazem-nasr-city-280m/'));
    const inquiries = [...html.matchAll(/<a[^>]+href="(https:\/\/wa.me\/201147758857\?text=[^"]+)"[^>]+class="(?:pp-action-btn wa|pp-agent-btn|pp-floating-wa)"/g)];
    assert.equal(inquiries.length, 3);
    assert.ok(inquiries.every(m => m[1] === inquiries[0][1]));
    assert.doesNotMatch(html, /data-availability-contact|pp-availability-contact|استفسار واتساب/);
    for (const p of ['/', '/requests/', '/agent.html', '/properties/']) {
      const h = await (await fetch(base + p)).text();
      assert.doesNotMatch(h, /data-availability-prompt|property-availability.js/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
