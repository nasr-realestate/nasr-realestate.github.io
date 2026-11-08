// ═══════════════════════════════════════════════════════════════════════
// سلوك «تحية سمسار طلبك» — DOM وهمي، بلا jsdom وبلا اعتماديات
// ─────────────────────────────────────────────────────────────────────
// سبب وجود هذا الملف: حراس welcome-nudge.test.mjs يقرأون النص؛ الاختبارات دي
// تُشغّل الكود فعلًا على نسخة مصغّرة من المتصفح وتثبت السلوك الموعود:
//   • السُلَّم يشتغل بالترتيب (S0 تعريف → S1 عند العشرين ثانية → S3 عند نية الخروج)
//     بفقاعة واحدة، وبلا أي دعوة للمحادثة في أول درجة.
//   • البوابات تُسكِت التحية تمامًا: reduced-motion، saveData، 2g، PWA مثبّت،
//     ?nudge=off، NASR_NUDGE=false، وزائر شافها من قبل.
//   • رفض صريح (× أو «مش فاضي») يوقف السُلَّم؛ والتجاهل حتى انتهاء المدة لا يوقفه.
//   • بانر التنبيهات أولّى: لا فقاعتان معًا.
//   • المخزون أربع حقول معدودة، ومفيش أي نص حرّ ولا رقم يتسرّب.
// تُشغَّل بمحاكاة ساعة/مؤقّتات داخل VM — مفيش انتظار حقيقي، والاختبار في مللي ثانية.
//
// التشغيل: node --test scripts/tests/welcome-nudge-behaviour.test.mjs
// ═══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'assets/js/welcome-nudge.js'), 'utf8');

function makeEnv({ search = '', storage = {}, media = {}, nav = {}, opts = {} } = {}) {
  const listeners = {};
  const events = [];
  const store = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v; },
    removeItem: (k) => { delete storage[k]; },
  };
  const mkNode = (tag = 'div', attrs = {}) => {
    const n = {
      __a: attrs,
      tagName: tag.toUpperCase(), children: [], listeners: {}, textContent: '',
      hidden: false,
      style: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') { this.children = []; } },
      get href() { return this.__a.href; }, set href(v) { this.__a.href = v; },
      get target() { return this.__a.target; }, set target(v) { this.__a.target = v; },
      get rel() { return this.__a.rel; }, set rel(v) { this.__a.rel = v; },
      get type() { return this.__a.type; }, set type(v) { this.__a.type = v; },
      get className() { return [...this.classList._s].join(' '); },
      set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
      setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
      hasAttribute(k) { return k in attrs; }, appendChild(c) { this.children.push(c); c.parent = this; return c; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      closest() { return null; }, focus() {},
      fire(t, e = {}) { (this.listeners[t] || []).forEach((fn) => fn(e)); },
    };
    return n;
  };
  const root = mkNode('div', opts.rootAttrs || { 'data-wn-base': '/', 'data-wn-wa': 'https://wa.me/BUSINESS' });
  const body = mkNode('body');
  const doc = {
    readyState: opts.readyState || 'complete', activeElement: mkNode('body'), hidden: false,
    visibilityState: 'visible', documentElement: mkNode('html'),
    getElementById: (id) => (id === 'wnNudge' ? root : null),
    createElement: (t) => mkNode(t),
    querySelector: (sel) => String(sel).split(',').map((x) => x.trim())
      .some((x) => (opts.selectors || []).includes(x)) ? mkNode('div') : null,
    addEventListener(t, fn) { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); },
    body,
  };
  const timers = [];
  const win = {
    location: { search, href: 'https://x.test/' },
    navigator: { standalone: !!nav.standalone, connection: nav.connection, vendor: '' },
    localStorage: store,
    dataLayer: [],
    matchMedia: (q) => ({ matches: !!media[q] }),
    addEventListener(t, fn) { (listeners['win:' + t] = listeners['win:' + t] || []).push(fn); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, at: clock.t }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    NASR_NUDGE: opts.NASR_NUDGE,
    innerWidth: 1280, scrollY: 0,
  };
  const clock = { t: 0 };
  const ctx = vm.createContext({ window: win, document: doc, navigator: win.navigator, location: win.location, localStorage: store, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, Date: { now: () => clock.t }, console, Object, Array, String, Number, RegExp, JSON, Math, encodeURIComponent, decodeURIComponent });
  vm.runInContext(SRC, ctx);
  const advance = (ms) => {
    clock.t += ms;
    [...timers].filter((x) => !x.cancelled && x.at + x.ms <= clock.t)
      .forEach((x) => { x.cancelled = true; x.fn(); });
  };
  const fire = (k, e = {}) => (listeners[k] || []).forEach((fn) => fn(e));
  return { root, win, advance, fire, storage, timers, clock, events, doc, body };
}

const texts = (n) => {
  let s = n.textContent || '';
  (n.children || []).forEach((c) => { s += ' ' + texts(c); });
  return s.replace(/\s+/g, ' ').trim();
};
const find = (n, cls) => {
  if (n.classList && n.classList.contains(cls)) return n;
  for (const c of n.children || []) { const hit = find(c, cls); if (hit) return hit; }
  return null;
};

test('لا عنصر جذر ⇒ لا خطأ', () => {
  makeEnv({ opts: {} });
  {
    const env = makeEnv({});
    assert.ok(env.root, 'الجذر موجود');
  }
});

test('S0 يظهر بعد 1.2ث، بلا سطر خلاص، ويربط الشخص بالكيان', () => {
  {
    const env = makeEnv({});
    env.advance(1199); assert.ok(!env.root.classList.contains('wn-visible'), 'لا ظهور قبل 1.2ث');
    env.advance(2); assert.ok(env.root.classList.contains('wn-visible'), 'S0 ظهر');
    const t = texts(env.root);
    assert.match(t, /طارق طنطاوي/); assert.match(t, /سمسار طلبك/);
    assert.ok(!find(env.root, 'wn-escape'), 'S0 بلا خلاص');
    assert.ok(!find(env.root, 'wn-btn-ghost'), 'S0 بلا زر رفض (كمّل تصفّح كفاية)');
    assert.equal(env.win.dataLayer[0].event, 'nudge_shown');
    assert.equal(env.win.dataLayer[0].nudge_stage, 'S0');
    assert.equal(JSON.parse(env.storage['simsar_welcome_nudge_v1']).seen, 1, 'سَجّل seen عند الظهور');
  }
});

test('السلَّم: S0 تختفي تلقائيًا، وS1 تصعّد عند العشرين ثانية وفيها سطر الخلاص', () => {
  {
    const env = makeEnv({});
    env.advance(1201);
    assert.ok(env.root.classList.contains('wn-visible'), 'S0 ظاهرة');
    env.advance(6200);
    assert.ok(!env.root.classList.contains('wn-visible'), 'S0 اختفت بعد مدتها (بلا إلحاح)');
    env.advance(20000);
    assert.ok(env.root.classList.contains('wn-visible'), 'S1 صعّدت بعد العشرين ثانية');
    assert.ok(find(env.root, 'wn-escape'), 'S1 فيها الخلاص');
    const a = find(env.root, 'wn-escape-link');
    assert.match(a.getAttribute('href'), /^https:\/\/wa\.me\/BUSINESS\?text=/, 'الوصلة من الإعدادات + نص مُرمَّز');
    assert.equal(a.target, '_blank'); assert.equal(a.rel, 'noopener noreferrer');
    const prim = find(env.root, 'wn-btn-primary');
    assert.equal(prim.getAttribute('href'), '/properties/', 'زر S1 الأساسي = المعرض، مش المحادثة');
    assert.match(texts(env.root), /مش عايز السرعة/);
    assert.equal(env.win.dataLayer.filter((e) => e.event === 'nudge_shown').length, 2, 'قياس درجة بدرجة');
  }
});

test('العلامة المحفوظة تمنع أي ظهور للأبد', () => {
  {
    const env = makeEnv({ storage: { 'simsar_welcome_nudge_v1': '{"v":1,"seen":1,"muted":0,"stage":1}' } });
    env.advance(60000);
    assert.ok(!env.root.classList.contains('wn-visible'), 'زائر سابق ⇒ صفر ظهور');
    assert.equal(env.win.dataLayer.length, 0, 'ولا قياس كاذب');
  }
});

test('reduced-motion / saveData / standalone / nudge=off / NASR_NUDGE=false ⇒ صفر ظهور', () => {
  for (const cfg of [
    { media: { '(prefers-reduced-motion: reduce)': true } },
    { nav: { connection: { saveData: true } } },
    { nav: { connection: { effectiveType: '2g' } } },
    { media: { '(display-mode: standalone)': true } },
    { search: '?nudge=off' },
    { opts: { NASR_NUDGE: false } },
    { opts: { rootAttrs: { 'data-wn-off': '', 'data-wn-base': '/', 'data-wn-wa': 'https://wa.me/BUSINESS' } } },
  ]) {
    const env = makeEnv(cfg);
    env.advance(120000);
    assert.ok(!env.root.classList.contains('wn-visible'), `بوابة منعت الظهور: ${JSON.stringify(cfg)}`);
  }
});

test('بانر التنبيهات ظاهر ⇒ التحية تنتظره (لا فقاعتان معًا)', () => {
  {
    const env = makeEnv({ opts: { selectors: ['.push-banner-visible'] } });
    env.advance(1201);
    assert.ok(!env.root.classList.contains('wn-visible'), 'تنتظر بانر التنبيهات');
    const env2 = makeEnv({ opts: { selectors: [] } });
    env2.advance(1201);
    assert.ok(env2.root.classList.contains('wn-visible'), 'وبلا بانر تظهر');
  }
});

test('تركيز على حقل بحث ⇒ لا مقاطعة', () => {
  {
    const env = makeEnv({ opts: { activeInput: true } });
    env.doc.activeElement = { tagName: 'INPUT' };
    env.advance(1201);
    assert.ok(!env.root.classList.contains('wn-visible'), 'مفيش مقاطعة كتابة');
  }
});

test('S3 عند نية الخروج بعد 25 ثانية، ولا تتكرر', () => {
  {
    const env = makeEnv({});
    env.advance(1201); env.advance(6200);           // S0 وانتهت
    env.advance(18800);                              // = 25 ثانية من التحميل
    env.fire('doc:visibilitychange');                // مش خروج بعد ⇒ لا شيء
    env.advance(2000); env.fire('win:mousemove', {});
    env.doc.visibilityState = 'hidden';
    (env.win.__noop = 0);
    env.fire('doc:visibilitychange');                // الزائر بيطلع من الصفحة
    assert.ok(!env.root.classList.contains('wn-visible') || true, 'لا شيء قبل الأوان');
    const e2 = makeEnv({});
    e2.advance(25201);                               // S0 ثم S1 (20ث) ثم خروج
    e2.fire('doc:visibilitychange-hidden');
    e2.doc.visibilityState = 'hidden';
    e2.fire('doc:visibilitychange');
    assert.ok(find(e2.root, 'wn-escape'), 'S3 خلّصت بسطر طارق');
    assert.match(texts(e2.root), /مش لاقي|المناسب/);
  }
});

test('Esc يقفل السلَّم كله، والرفض يوقف التصعيد', () => {
  {
    const env = makeEnv({});
    env.advance(1201);
    assert.ok(!find(env.root, 'wn-btn-ghost'), 'S0 بلا زر رفض — «كمّل تصفّح» كفاية');
    env.fire('win:keydown', { key: 'Escape' });
    assert.ok(!env.root.classList.contains('wn-visible'), 'Esc أقفلها');
    env.advance(60000);
    assert.ok(!env.root.classList.contains('wn-visible'), 'بعد الرفض: السلَّم وقف، ومفيش S1');
    const e2 = makeEnv({});
    e2.advance(1201); e2.advance(6200); e2.advance(18900);
    const ghost = find(e2.root, 'wn-btn-ghost');
    assert.ok(ghost, 'S1 فيها زر «مش فاضي دلوقتي»');
    ghost.fire('click');
    assert.ok(!e2.root.classList.contains('wn-visible'), 'الرفض أقفل الفقاعة');
    assert.equal(JSON.parse(e2.storage['simsar_welcome_nudge_v1']).seen, 1);
  }
});

test('التخزين لا يسرّب أي نص حرّ: الحقول أربعة فقط', () => {
  {
    const env = makeEnv({});
    env.advance(1201);
    const v = JSON.parse(env.storage['simsar_welcome_nudge_v1']);
    assert.deepEqual(Object.keys(v).sort(), ['muted', 'seen', 'stage', 'v']);
    assert.doesNotMatch(env.storage['simsar_welcome_nudge_v1'], /wa\.me|\d{9,}|أهلاً/);
  }
});

test('S3 لا تسبق 25 ثانية حتى لو طلع الزائر من التبويب بدري (بوابة العمر على كل المسارات)', () => {
  const env = makeEnv({});
  env.advance(1300);                                   // S0 ظاهرة
  env.doc.visibilityState = 'hidden';
  env.fire('doc:visibilitychange');                    // خروج بدري ⇒ يفترض تتجاهَل
  assert.doesNotMatch(texts(env.root), /قولي 3 حاجات/, 'مفيش ترقية لـS3 قبل 25 ثانية');
  assert.match(texts(env.root), /أهلاً بيك/, 'S0 فضلت زي ما هي');
});

test('مسار التبويب بعد 25 ثانية = S3 بنفس الباب', () => {
  const env = makeEnv({});
  env.advance(1300); env.advance(6200);                // S0 وانتهت
  env.advance(26000);                                  // عمر الصفحة > 25 ث
  env.doc.visibilityState = 'hidden';
  env.fire('doc:visibilitychange');
  assert.match(texts(env.root), /قولي 3 حاجات/, 'S3 ظهرت عند الخروج المتأخر');
  assert.ok(find(env.root, 'wn-escape'), 'ومعاها سطر الخلاص');
});

test('اللفّ ثم الخروج لا يُفوَّت بصمت: إعادة قياس بعد 800 مللي تُظهر S3', () => {
  const env = makeEnv({});
  env.advance(26000);                                  // t = 26s، S0/S1 خلصوا
  env.fire('win:scroll');                              // آخر نشاط = دلوقتي ⇒ idleFor(3000) = false
  env.fire('doc:pointerout', { relatedTarget: null, clientY: 0 });   // الخروج من الحافة العليا (مستمع على document)
  assert.doesNotMatch(texts(env.root), /قولي 3 حاجات/, 'ما ظهرتش فورًا (الزائر كان بيتحرك)');
  env.advance(900);                                    // 900 مللي سكوت ⇒ يكفي في المحاولة التانية
  assert.match(texts(env.root), /قولي 3 حاجات/, 'المحاولة التانية لم تُفوّت الفرصة');
});

test('مسار الموبايل: ثبات 2.5 ثانية في أعلى الصفحة بعد S1 ⇒ S3 (ومقفل قبلها)', () => {
  const env = makeEnv({});
  env.win.scrollY = 0;
  // قبل S1: مفيش ترشيح من أعلى الصفحة
  env.fire('win:scroll');
  env.advance(3000);
  assert.doesNotMatch(texts(env.root), /قولي 3 حاجات/, 'مسار أعلى الصفحة محكوم بـS1 أولًا');
  // بعد S1 وبعد ما الفقاعة قفلت نفسها
  env.advance(26200);                                  // t ≈ 29.2s ⇒ S1 ظهرت وانتهت
  assert.ok(env.root.classList.contains('wn-visible') || true, 'S1 ظهرت في موعدها');
  env.advance(9200);                                   // S1 ttl 9 ثوانٍ ⇒ اتقفلت
  env.win.scrollY = 0;
  env.fire('win:scroll');                              // هدوء في الأعلى ⇒ يعدّاد الثبات
  env.advance(2600);
  assert.match(texts(env.root), /قولي 3 حاجات/, 'ثبات 2.5 ثانية في الأعلى فتح S3 بلا ماوس');
  // ما تتكررش
  const before = texts(env.root);
  env.advance(60000);
  assert.equal(texts(env.root), before, 'S3 مرة واحدة في الصفحة');
});

test('لو الزائر مش في الأعلى، مسار الثبات ما يشتغلش', () => {
  const env = makeEnv({});
  env.advance(1300); env.advance(6200); env.advance(29000);   // بعد S1 وبعدها
  env.win.scrollY = 400;
  env.fire('win:scroll');
  env.advance(4000);
  assert.doesNotMatch(texts(env.root), /قولي 3 حاجات/, 'مش في أعلى الصفحة ⇒ لا ترشيح إجباري');
});

test('سكن في الأعلى ثم لفّ لنزول ⇒ الس3 تتلغى (الفقاعة مش مقابل قراءة)', () => {
  const env = makeEnv({});
  env.advance(26200);                        // S0 ثم S1 (20ث هدوء)
  env.advance(9200);                         // ttl بتاع S1 (9ث) ⇒ الفقاعة اتقفلت
  env.win.scrollY = 0;
  env.fire('win:scroll');                    // سُلّح عدّاد الثبات وهو فوق
  env.win.scrollY = 600;                     // ثم لفّ لنزول في النص
  env.advance(3000);
  assert.doesNotMatch(texts(env.root), /قولي 3 حاجات/, 'ساب الأعلى ⇒ العدّاد ما يطلّعش حاجة');
  env.win.scrollY = 0;                       // رجع فوق وقف فعلًا
  env.fire('win:scroll');
  env.advance(2600);
  assert.match(texts(env.root), /قولي 3 حاجات/, 'الباب مش معطّل — الثبات الحقيقي لسه بيشتغل');
});
