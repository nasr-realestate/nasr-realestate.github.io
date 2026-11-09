// ═══════════════════════════════════════════════════════════════════════
// سلوك «المُضيف الذكي لسمسار طلبك» (V2) — اختبار تشغيلي كامل داخل VM
// ─────────────────────────────────────────────────────────────────────
// يشغّل assets/js/welcome-nudge.js فعليًا بمحاكاة ساعة المتصفح والتنقل بين الصفحات
// ويثبت السلوك الموعود:
//   • ٤ خطوات مرتبة تباعًا: S1 مداعبة ← S2 نية ← S3 طريق مخصص ← S4 تحفيز وخلاص.
//   • بقاء الرسالة وقتًا كافيًا للقراءة (16–20 ثانية) + إيقاف كامل للمؤقّت عند
//     اللمس أو الماوس أو إخفاء التبويب مع مهلة >= 9 ثوانٍ بعد انتهاء التفاعل.
//   • استمرارية السلسلة عبر الصفحات دون تكرار الخطوة السابقة ودون انقطاع مبكر.
//   • ترقية تلقائية لسجلات V1 القديمة مع احترام الكتم الصريح (muted: 1).
//   • توافق مع بانر الإشعارات، وحقل البحث الذكي #plSearch، وزر واتساب العائم.
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

function makeEnv({
  pathname = '/',
  search = '',
  storage = {},
  session = {},
  nav = {},
  opts = {},
  clockStart = 1000
} = {}) {
  const listeners = {};
  const store = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); }
  };
  const sessStore = {
    getItem: (k) => (k in session ? session[k] : null),
    setItem: (k, v) => { session[k] = String(v); }
  };

  const mkNode = (tag = 'div', attrs = {}) => {
    const n = {
      __a: { ...attrs },
      tagName: tag.toUpperCase(),
      children: [],
      listeners: {},
      textContent: '',
      focused: false,
      scrolled: false,
      style: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      get innerHTML() { return ''; },
      set innerHTML(v) { if (v === '') this.children = []; },
      get href() { return this.__a.href; },
      set href(v) { this.__a.href = v; },
      get target() { return this.__a.target; },
      set target(v) { this.__a.target = v; },
      get rel() { return this.__a.rel; },
      set rel(v) { this.__a.rel = v; },
      get type() { return this.__a.type; },
      set type(v) { this.__a.type = v; },
      get className() { return [...this.classList._s].join(' '); },
      set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
      setAttribute(k, v) { this.__a[k] = v; },
      getAttribute(k) { return k in this.__a ? this.__a[k] : null; },
      hasAttribute(k) { return k in this.__a; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      focus() { this.focused = true; },
      scrollIntoView() { this.scrolled = true; },
      fire(t, e = {}) { (this.listeners[t] || []).forEach((fn) => fn(e)); }
    };
    return n;
  };

  const root = opts.noRoot ? null : mkNode('div', opts.rootAttrs || {
    'data-wn-base': '',
    'data-wn-page': opts.pageKind || '',
    'data-wn-wa': 'https://wa.me/BUSINESS'
  });

  const extraById = opts.byId || {};
  const activeSelectors = new Set(opts.selectors || []);

  const doc = {
    readyState: opts.readyState || 'complete',
    activeElement: mkNode('body'),
    visibilityState: 'visible',
    getElementById: (id) => {
      if (id === 'wnNudge') return root;
      return extraById[id] || null;
    },
    createElement: (t) => mkNode(t),
    querySelector: (sel) => String(sel).split(',').map((x) => x.trim())
      .some((x) => activeSelectors.has(x)) ? mkNode('div') : null,
    addEventListener(t, fn) { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); }
  };

  const clock = { t: clockStart };
  const timers = [];
  const win = {
    location: { pathname, search, href: 'https://x.test' + pathname + search },
    navigator: { connection: nav.connection },
    localStorage: store,
    sessionStorage: sessStore,
    dataLayer: [],
    addEventListener(t, fn) { (listeners['win:' + t] = listeners['win:' + t] || []).push(fn); },
    setTimeout: (fn, ms) => {
      timers.push({ fn, due: clock.t + Math.max(0, ms), cancelled: false });
      return timers.length;
    },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    NASR_NUDGE: opts.NASR_NUDGE
  };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    navigator: win.navigator,
    location: win.location,
    localStorage: store,
    sessionStorage: sessStore,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    Date: { now: () => clock.t },
    console,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Math,
    encodeURIComponent,
    decodeURIComponent
  });
  vm.runInContext(SRC, ctx);

  const advance = (ms) => {
    const target = clock.t + ms;
    while (true) {
      let nextIdx = -1;
      for (let i = 0; i < timers.length; i += 1) {
        const tm = timers[i];
        if (!tm.cancelled && tm.due <= target) {
          if (nextIdx === -1 || tm.due < timers[nextIdx].due) nextIdx = i;
        }
      }
      if (nextIdx === -1) break;
      const chosen = timers[nextIdx];
      chosen.cancelled = true;
      clock.t = chosen.due;
      chosen.fn();
    }
    clock.t = target;
  };

  const fire = (k, e = {}) => (listeners[k] || []).forEach((fn) => fn(e));
  return { root, win, doc, storage, session, activeSelectors, advance, fire, clock, mkNode };
}

const texts = (n) => {
  if (!n) return '';
  let s = n.textContent || '';
  (n.children || []).forEach((c) => { s += ' ' + texts(c); });
  return s.replace(/\s+/g, ' ').trim();
};

const find = (n, cls) => {
  if (!n) return null;
  if (n.classList && n.classList.contains(cls)) return n;
  for (const c of n.children || []) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
};

const findAll = (n, cls, acc = []) => {
  if (!n) return acc;
  if (n.classList && n.classList.contains(cls)) acc.push(n);
  for (const c of n.children || []) findAll(c, cls, acc);
  return acc;
};

test('لا عنصر جذر #wnNudge ⇒ لا خطأ ولا مؤقتات', () => {
  const env = makeEnv({ opts: { noRoot: true } });
  env.advance(30000);
  assert.equal(env.win.dataLayer.length, 0);
});

test('الخطوة ١ (مداعبة وترحيب): تظهر بعد 3.2ث، وتظل مقروءة 16 ثانية كاملة، ولا تقفل السلسلة', () => {
  const env = makeEnv({});
  env.advance(3199);
  assert.ok(!env.root.classList.contains('wn-visible'), 'لا استعجال قبل 3.2 ثانية');

  env.advance(2);
  assert.ok(env.root.classList.contains('wn-visible'), 'S1 ظهرت');
  const t = texts(env.root);
  assert.match(t, /طارق طنطاوي/);
  assert.match(t, /سمسار طلبك/);
  assert.match(t, /١ من ٤/);
  assert.ok(!find(env.root, 'wn-escape'), 'S1 بلا دعوة محادثة مبكرة');

  // بعد 10 ثوانٍ ما زالت ظاهرة أمام القارئ (عكس النسخة القديمة التي كانت تختفي سريعًا)
  env.advance(10000);
  assert.ok(env.root.classList.contains('wn-visible'), 'تبقى ظاهرة بعد 10 ثوانٍ ليقرأها الزائر براحته');

  // لا تقفل seen=1 من أول خطوة بل تحفظ stage=1 فقط لاستكمال السلسلة
  const saved = JSON.parse(env.storage.simsar_welcome_nudge_v1);
  assert.equal(saved.stage, 1);
  assert.equal(saved.seen, 0, 'لا تقفل السلسلة قبل اكتمال الخطوات الأربع');

  // تختفي بهدوء بعد اكتمال الـ 16 ثانية
  env.advance(6005);
  assert.ok(!env.root.classList.contains('wn-visible'), 'اختفت بهدوء بعد 16 ثانية');
});

test('الرحلة التفاعلية الكاملة بالترتيب: S1 ← S2 (فهم النية) ← S3 (رسم الطريق) ← S4 (تحفيز وخلاص)', () => {
  const env = makeEnv({});
  env.advance(3201);
  assert.match(texts(env.root), /١ من ٤/);

  // نقرة على «يلا نبدأ الجولة» في S1 تفتح S2 بسلاسة
  find(env.root, 'wn-btn-primary').fire('click');
  env.advance(460);
  assert.ok(env.root.classList.contains('wn-visible'), 'S2 ظهرت');
  assert.match(texts(env.root), /٢ من ٤/);
  const chips = findAll(env.root, 'wn-chip');
  assert.equal(chips.length, 3, '٣ خيارات واضحة لفهم نية الزائر');

  // الزائر يختار «تمليك» (الخيار الأول)
  chips[0].fire('click');
  env.advance(430);
  assert.ok(env.root.classList.contains('wn-visible'), 'S3 ظهرت مخصصة للتمليك');
  assert.match(texts(env.root), /٣ من ٤/);
  assert.match(texts(env.root), /أقصر طريق للتمليك/);
  assert.equal(find(env.root, 'wn-btn-primary').getAttribute('href'), '/properties/?deal=sale');
  const wa3 = find(env.root, 'wn-escape-link');
  assert.ok(wa3, 'سطر الخلاص يظهر في S3');
  assert.match(decodeURIComponent(wa3.getAttribute('href')), /تمليك/);

  // بعد انتهاء قراءة S3 وفترة الاستراحة، تظهر S4 كختام لطيف وتغلق الجولة seen=1
  env.advance(18005);
  assert.ok(!env.root.classList.contains('wn-visible'), 'S3 أُغلقت بعد مدة القراءة');
  env.advance(15005);
  assert.ok(env.root.classList.contains('wn-visible'), 'S4 ظهرت');
  assert.match(texts(env.root), /٤ من ٤/);
  assert.equal(find(env.root, 'wn-btn-primary').getAttribute('href'), '/agent.html');

  const finalFlag = JSON.parse(env.storage.simsar_welcome_nudge_v1);
  assert.deepEqual(finalFlag, { v: 2, seen: 1, muted: 0, stage: 4, intent: 1 });

  // بعد انتهاء S4 لا يتكرر أي إشعار
  env.advance(90000);
  assert.ok(!env.root.classList.contains('wn-visible'), 'انتهت الجولة بلا إلحاح');
});

test('تخصيص رسم الطريق (S3) لمالك العقار والمستأجر بدقة', () => {
  // مسار المالك (تقييم + عرض عقار)
  const sellerEnv = makeEnv({
    storage: { simsar_welcome_nudge_v1: JSON.stringify({ v: 2, seen: 0, muted: 0, stage: 1, intent: 0 }) }
  });
  sellerEnv.advance(3805);
  const chips = findAll(sellerEnv.root, 'wn-chip');
  chips[2].fire('click'); // عندي عقار أقيّمه أو أعرضه
  sellerEnv.advance(430);
  assert.equal(find(sellerEnv.root, 'wn-btn-primary').getAttribute('href'), '/tools/valuation.html');
  assert.equal(find(sellerEnv.root, 'wn-btn-ghost').getAttribute('href'), '/add-your-property.html');

  // مسار الإيجار والتجاري
  const rentEnv = makeEnv({
    storage: { simsar_welcome_nudge_v1: JSON.stringify({ v: 2, seen: 0, muted: 0, stage: 1, intent: 0 }) }
  });
  rentEnv.advance(3805);
  findAll(rentEnv.root, 'wn-chip')[1].fire('click');
  rentEnv.advance(430);
  assert.equal(find(rentEnv.root, 'wn-btn-primary').getAttribute('href'), '/properties/?deal=rent');
  assert.equal(find(rentEnv.root, 'wn-btn-ghost').getAttribute('href'), '/properties/commercial/');
});

test('الاستمرارية عبر الصفحات (تباعاً في الموقع): الانتقال لصفحة عقار يستكمل الخطوة التالية ولا يعيد الأولى', () => {
  const sharedStorage = {};
  const sharedSession = {};

  // ١) الزائر يفتح الرئيسية، يرى S1 لخمس ثوانٍ ثم ينتقل لصفحة عقار
  const p1 = makeEnv({ pathname: '/', storage: sharedStorage, session: sharedSession, clockStart: 1000 });
  p1.advance(3205);
  assert.match(texts(p1.root), /١ من ٤/);
  p1.advance(5000); // قرأ 5 ثوانٍ ثم انتقل دون نقر

  // ٢) يفتح صفحة عقار أولى ⇒ تظهر له S2 (وليس S1 مجددًا، ولا تنقطع السلسلة!)
  const p2 = makeEnv({
    pathname: '/properties/apartment-sale-mahmoud-elbadry-8th-district-380m/',
    storage: sharedStorage,
    session: sharedSession,
    opts: { pageKind: 'property_page', selectors: ['.pp-floating-wa'] },
    clockStart: p1.clock.t + 500
  });
  p2.advance(3810);
  assert.ok(p2.root.classList.contains('wn-visible'), 'استمرت السلسلة على صفحة العقار');
  assert.ok(p2.root.classList.contains('wn-high'), 'ارتفعت البطاقة تلقائيًا فوق زر واتساب العائم');
  assert.match(texts(p2.root), /٢ من ٤/, 'انتقل للخطوة الثانية بالترتيب');
  findAll(p2.root, 'wn-chip')[0].fire('click'); // يختار تمليك
  p2.advance(430);
  assert.match(texts(p2.root), /٣ من ٤/, 'ظهرت الخطوة الثالثة');

  // ٣) يفتح صفحة عقار ثانية للمقارنة ⇒ تظهر S4 بتوقيت مقارنة لطيف (5.5ث) وتختم السلسلة
  const p3 = makeEnv({
    pathname: '/properties/apartment-sale-abbas-el-akkad-200m/',
    storage: sharedStorage,
    session: sharedSession,
    opts: { pageKind: 'property_page' },
    clockStart: p2.clock.t + 4000
  });
  p3.advance(5510);
  assert.ok(p3.root.classList.contains('wn-visible'), 'ظهرت الخطوة الرابعة عند مقارنة العقار الثاني');
  assert.match(texts(p3.root), /٤ من ٤/);
  assert.equal(JSON.parse(sharedStorage.simsar_welcome_nudge_v1).seen, 1);
});

test('في صفحة المعرض /properties/: زر البحث الذكي يوجّه المؤشر مباشرة إلى #plSearch', () => {
  let dummy = null;
  const env = makeEnv({
    pathname: '/properties/',
    storage: { simsar_welcome_nudge_v1: JSON.stringify({ v: 2, seen: 0, muted: 0, stage: 2, intent: 1 }) },
    opts: { byId: {} }
  });
  dummy = env.mkNode('input', { id: 'plSearch' });
  env.doc.getElementById = (id) => (id === 'wnNudge' ? env.root : (id === 'plSearch' ? dummy : null));

  env.advance(3810);
  assert.match(texts(env.root), /٣ من ٤/);
  const btn = find(env.root, 'wn-btn-primary');
  assert.equal(btn.tagName, 'BUTTON', 'زر مباشر داخل المعرض بلا إعادة تحميل');
  btn.fire('click');
  assert.ok(dummy.focused, 'تم وضع المؤشر داخل حقل البحث الذكي #plSearch');
  assert.ok(dummy.scrolled, 'تم التمرير السلس إلى حقل البحث');
});

test('إيقاف المؤقّت أثناء القراءة (hover / touch) يمنع اختفاء الرسالة تمامًا ويعطي مهلة >= 9 ثوانٍ بعدها', () => {
  const env = makeEnv({});
  env.advance(3205);
  assert.ok(env.root.classList.contains('wn-visible'), 'S1 ظهرت');

  // بعد 14 ثانية يضع الزائر الماوس أو إصبعه ليقرأ بتأنٍّ لمدة 40 ثانية متواصلة!
  env.advance(14000);
  env.root.fire('pointerenter');
  assert.ok(env.root.classList.contains('wn-paused'), 'توقّف شريط العد التنازلي');

  env.advance(40000);
  assert.ok(env.root.classList.contains('wn-visible'), 'لم تختفِ الرسالة طوال فترة وضع اليد/الماوس!');

  // يرفع الماوس ⇒ يحصل على 9 ثوانٍ كاملة إضافية قبل الاختفاء
  env.root.fire('pointerleave');
  assert.ok(!env.root.classList.contains('wn-paused'), 'استؤنف المؤقّت');
  env.advance(8500);
  assert.ok(env.root.classList.contains('wn-visible'), 'ما زالت ظاهرة خلال مهلة الـ 9 ثوانٍ');
  env.advance(600);
  assert.ok(!env.root.classList.contains('wn-visible'), 'أُغلقت بهدوء بعد انتهاء المهلة');
});

test('ترقية سجلات V1 القديمة تلقائيًا مع احترام قرار الكتم الصريح', () => {
  // زائر قديم علقت عنده V1 بسبب seen=1 المبكر ⇒ يحصل على جولة V2 كاملة
  const v1Visitor = makeEnv({
    storage: { simsar_welcome_nudge_v1: '{"v":1,"seen":1,"muted":0,"stage":1}' }
  });
  v1Visitor.advance(3205);
  assert.ok(v1Visitor.root.classList.contains('wn-visible'), 'حصل الزائر القديم على تجربة المُضيف الذكي V2');

  // زائر قديم اختار الكتم صراحة muted=1 ⇒ يُحترم قراره ولا يظهر شيء
  const v1Muted = makeEnv({
    storage: { simsar_welcome_nudge_v1: '{"v":1,"seen":1,"muted":1,"stage":1}' }
  });
  v1Muted.advance(60000);
  assert.ok(!v1Muted.root.classList.contains('wn-visible'), 'الكتم الصريح محفوظ ومُحترم');
});

test('الفرق بين إغلاق فقاعة واحدة (×) وبين الكتم النهائي («إيقاف نصائح الجولة»)', () => {
  // إغلاق فقاعة بـ × يمنح استراحة طويلة (35ث) ثم يستكمل بهدوء دون كتم دائم
  const polite = makeEnv({});
  polite.advance(3205);
  find(polite.root, 'wn-close').fire('click');
  assert.ok(!polite.root.classList.contains('wn-visible'));
  polite.advance(20000);
  assert.ok(!polite.root.classList.contains('wn-visible'), 'يحترم فترة الاستراحة بعد ×');
  polite.advance(15100);
  assert.ok(polite.root.classList.contains('wn-visible'), 'استكمل الخطوة الثانية بعد الاستراحة');

  // أما «إيقاف نصائح الجولة» فيكتم السلسلة للأبد
  find(polite.root, 'wn-mute').fire('click');
  assert.ok(!polite.root.classList.contains('wn-visible'));
  assert.equal(JSON.parse(polite.storage.simsar_welcome_nudge_v1).muted, 1);
  polite.advance(120000);
  assert.ok(!polite.root.classList.contains('wn-visible'), 'لا يظهر شيء بعد الكتم الدائم');
});

test('توافق بانر التنبيهات وحقل الكتابة وأوضاع الإطفاء والمعاينة والخصوصية', () => {
  // ١) بانر التنبيهات الظاهر يؤجّل البطاقة، وبمجرد اختفائه تظهر
  const pushEnv = makeEnv({ opts: { selectors: ['.push-banner-visible:not(.push-banner-hidden)'] } });
  pushEnv.advance(3205);
  assert.ok(!pushEnv.root.classList.contains('wn-visible'), 'ينتظر بانر التنبيهات');
  pushEnv.activeSelectors.clear();
  pushEnv.advance(2100);
  assert.ok(pushEnv.root.classList.contains('wn-visible'), 'ظهر فور إخفاء بانر التنبيهات');

  // ٢) الكتابة في INPUT تؤجّل الظهور فلا تقاطع الزائر
  const inputEnv = makeEnv({});
  inputEnv.doc.activeElement = { tagName: 'INPUT' };
  inputEnv.advance(3205);
  assert.ok(!inputEnv.root.classList.contains('wn-visible'), 'لا مقاطعة أثناء الكتابة');

  // ٣) أوضاع الإطفاء والشبكة البطيئة
  for (const cfg of [
    { nav: { connection: { saveData: true } } },
    { nav: { connection: { effectiveType: '2g' } } },
    { search: '?nudge=off' },
    { opts: { NASR_NUDGE: false } },
    { opts: { rootAttrs: { 'data-wn-off': '', 'data-wn-base': '', 'data-wn-wa': 'https://wa.me/BUSINESS' } } }
  ]) {
    const offEnv = makeEnv(cfg);
    offEnv.advance(60000);
    assert.ok(!offEnv.root.classList.contains('wn-visible'));
  }

  // ٤) ?nudge=preview يفتح الجولة حتى لو كانت مكتملة سابقًا
  const prevEnv = makeEnv({
    search: '?nudge=preview',
    storage: { simsar_welcome_nudge_v1: '{"v":2,"seen":1,"muted":1,"stage":4,"intent":2}' }
  });
  prevEnv.advance(3205);
  assert.ok(prevEnv.root.classList.contains('wn-visible'), '?nudge=preview يعمل للمعاينة الحية');

  // ٥) فحص الخصوصية الصارم على ما يُخزَّن
  const raw = pushEnv.storage.simsar_welcome_nudge_v1;
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['intent', 'muted', 'seen', 'stage', 'v']);
  assert.doesNotMatch(raw, /wa\.me|\d{9,}|طارق|مدينة/);
});
