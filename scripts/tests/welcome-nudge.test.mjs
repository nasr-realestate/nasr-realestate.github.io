// ═══════════════════════════════════════════════════════════════════════
// حراسات «المُضيف الذكي لسمسار طلبك» (Welcome Nudge — V2)
// ─────────────────────────────────────────────────────────────────────
// هذه الحراسات تضمن تحقيق رؤية «المُضيف الذكي» بلا إزعاج ولا مساس بالخصوصية:
//   • شمول رحلة تصفح العقارات (الرئيسية، المعرض، الهبوط، صفحات العقارات، الطلبات)
//     مع استثناء صفحات المحادثة والـCRM والأدوات والسياسات.
//   • لا صوت تلقائي ولا TTS من المتصفح (الهوية الصوتية لها مسار إنتاج مستقل).
//   • بطاقة عائمة صغيرة في الزاوية: بلا modal ولا قفل تمرير ولا خلفية معتمة.
//   • تخزين محدود وموثّق في privacy-policy.html داخل try/catch، بلا بيانات شخصية.
//   • ٤ خطوات مرتبة بروح مصرية دافئة: مداعبة ← فهم نية ← رسم طريق ← تحفيز وخلاص.
//   • طارق هو «الخلاص»: لا دعوة للمحادثة في S1 أو S2، وواتساب ليس الزر الأساسي أبدًا.
//   • قراءة مريحة (16–20 ثانية) مع إيقاف المؤقّت عند اللمس أو الماوس أو إخفاء التبويب.
//   • توافق كامل مع بانر التنبيهات والقائمة العائمة واللايتبوكس وأزرار واتساب العائمة.
//
// التشغيل: node --test scripts/tests/welcome-nudge.test.mjs
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const stripComments = (src) => src
  .replace(/\{%-?\s*comment\s*-?%}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const JS = read('assets/js/welcome-nudge.js');
const INC = read('_includes/welcome-nudge.html');
const LAYOUT = read('_layouts/default.html');
const HOME = read('index.html');
const PUSH_JS = read('assets/js/push-notifications.js');
const both = stripComments(JS) + '\n' + stripComments(INC);

// ─── 1) التغطية الذكية لرحلة التصفح واستثناء الصفحات الخدمية ──────────────
test('المُضيف الذكي يغطي رحلة تصفح العقارات ويستثني الوكيل والـCRM والسياسات', () => {
  assert.match(
    LAYOUT,
    /if page\.welcome_nudge or page\.layout == "property_page" or page\.layout == "landing" or page\.layout == "request_page" or page\.body_class contains "page-properties" or page\.body_class contains "page-requests"/,
    'لازم _layouts/default.html يفعّل المُضيف الذكي عبر رحلة التصفح العقاري'
  );
  assert.match(HOME, /^welcome_nudge: true$/m, 'الصفحة الرئيسية ترفع العلم صراحة');

  // التأكد من عدم رفع welcome_nudge على الصفحات الخدمية المستثناة
  for (const excluded of [
    'agent.html',
    'crm.html',
    'tools/valuation.html',
    'add-your-property.html',
    'notifications.html',
    'privacy-policy.html',
    '404.html'
  ]) {
    const content = read(excluded);
    assert.doesNotMatch(content, /^\s*welcome_nudge:\s*true\s*$/m, `لا يُفعَّل المُضيف الذكي في ${excluded}`);
  }
});

// ─── 2) لا صوت إطلاقًا في المُضيف النصّي ───────────────────────────────────
test('بلا صوت تلقائي: لا <audio>، لا autoplay، ولا speechSynthesis', () => {
  for (const banned of ['<audio', 'autoplay', 'speechSynthesis', 'SpeechSynthesisUtterance', 'new Audio(', '.play()']) {
    assert.ok(!both.includes(banned), `ممنوع في المُضيف الذكي: ${banned}`);
  }
  assert.ok(!/assets\/audio\//.test(both), 'لا ملف صوتي يُحمَّل في بطاقة الترحيب');
});

// ─── 3) لا حاجز فوق الصفحة ────────────────────────────────────────────────
test('بطاقة عائمة غير معطِّلة: لا modal ولا alert ولا قفل للتمرير', () => {
  for (const banned of ['alert(', 'confirm(', 'prompt(', '<dialog', 'role="dialog"', 'inset: 0', 'position: fixed;\n    inset: 0']) {
    assert.ok(!both.includes(banned), `ممنوع: ${banned} — التوجيه تحفيز لا حاجز`);
  }
  assert.doesNotMatch(JS, /document\.body\.style\.overflow/, 'لا قفل لتمرير الصفحة');
  assert.doesNotMatch(INC, /\.wn(-|\b)[^{}]*\{[^}]*\btop:\s*0[^}]*\}/, 'لا تغطية كاملة للشاشة');
  assert.ok(!/\.wn-overlay|\.wn-backdrop/.test(INC), 'لا خلفية معتمة');
});

// ─── 4) التخزين: حقول رقمية محدودة داخل try/catch وترقية V1 تلقائيًا ──────
test('المخزون: simsar_welcome_nudge_v1 بحقول v/seen/muted/stage/intent فقط، وكل عملية محمية', () => {
  assert.match(JS, /var KEY = 'simsar_welcome_nudge_v1';/, 'اسم المفتاح الدائم ثابت وموثّق');
  assert.match(JS, /var SKEY = 'simsar_welcome_session_v2';/, 'عداد الجلسة المؤقت منفصل في sessionStorage');
  assert.match(JS, /if \(parsed\.v !== 2\)/, 'ترقية سجلات V1 تلقائيًا حتى لا يُحرم الزوار القدامى من السلسلة');

  const flagBlock = JS.slice(JS.indexOf('function writeFlag'), JS.indexOf('var memSess'));
  const fields = [...flagBlock.matchAll(/^\s{6}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ['intent', 'muted', 'seen', 'stage', 'v'],
    'حقول localStorage الخمسة المحدودة فقط');

  const storageCalls = JS.match(/window\.localStorage\.\w+/g) || [];
  assert.deepEqual(storageCalls, ['window.localStorage.getItem', 'window.localStorage.setItem'],
    `التخزين الدائم محصور في قراءة وكتابة واحدة: ${storageCalls.join(', ')}`);
  assert.doesNotMatch(JS, /removeItem/, 'لا مسح عشوائي للتخزين');

  for (const m of storageCalls) {
    const at = JS.indexOf(m);
    const before = JS.slice(Math.max(0, at - 240), at);
    assert.match(before, /try \{/, `«${m}» لازم تبقى داخل try/catch`);
  }
  assert.doesNotMatch(JS, /localStorage\.setItem\([^)]*(input|value|innerText|textContent)/,
    'ممنوع تخزين أي نص كتبه الزائر');
});

// ─── 5) لا أرقام هواتف مكتوبة في الكود ────────────────────────────────────
test('لا أرقام هواتف مكتوبة في السكربت، والوصلة تُقرأ من إعدادات الموقع', () => {
  assert.doesNotMatch(JS, /\b\d{9,}\b/, 'لا رقم طويل في الكود (الوصلة من data-wn-wa)');
  assert.match(INC, /data-wn-wa="\{\{ site\.contact\.whatsapp_url/,
    'رابط واتساب يُقرأ من إعدادات الموقع في القالب، لا من السكربت');
  assert.match(JS, /var waUrl = root\.getAttribute\('data-wn-wa'\) \|\| '';/);
  assert.match(JS, /if \(copy\.escape && waHref\) \{/, 'بلا رابط ⇒ بلا سطر خلاص، ومفيش كسر');
});

// ─── 6) روح الخطوات الأربع المرتبة وطارق كخلاص ───────────────────────────
test('الخطوات الأربع بالترتيب (S1 مداعبة → S2 نية → S3 طريق → S4 تحفيز)، وطارق خلاص لا افتتاحية', () => {
  assert.match(JS, /var ORDER = \['S1', 'S2', 'S3', 'S4'\];/, 'ترتيب السلسلة ثابت من 4 خطوات');

  const s1 = JS.slice(JS.indexOf('function copyS1'), JS.indexOf('function copyS2'));
  const s2 = JS.slice(JS.indexOf('function copyS2'), JS.indexOf('var S3_BY_INTENT'));
  const s3 = JS.slice(JS.indexOf('var S3_BY_INTENT'), JS.indexOf('function copyS4'));
  const s4 = JS.slice(JS.indexOf('function copyS4'), JS.indexOf('function stepCopy'));

  assert.match(s1, /escape: false/, 'S1 مداعبة وترحيب بلا دعوة محادثة');
  assert.doesNotMatch(s1, /wa|whatsapp|واتساب/i, 'ممنوع أي دعوة للمحادثة في S1');
  assert.match(s1, /طارق طنطاوي/, 'S1 تربط الشخص بالكيان');
  assert.match(s1, /سمسار طلبك/, 'S1 تذكر اسم الكيان');

  assert.match(s2, /escape: false/, 'S2 لفهم النية بنقرة هادئة بلا ضغط محادثة');
  assert.match(s2, /INTENTS\.BUY[\s\S]*INTENTS\.RENT[\s\S]*INTENTS\.SELL/, 'S2 تغطي النوايا الثلاث');

  assert.match(s3, /escape: true/, 'S3 تتيح سطر خلاص هادئ لمن يرغب في الاختصار');
  assert.match(s4, /escape: true/, 'S4 تتيح سطر خلاص هادئ مع طارق');
  assert.match(s4, /مش لاقي|المناسب/, 'S4 تخاطب المحتار أو من لم يجد مقاس طلبه');
  assert.ok(s4.includes('ترشيح'), 'S4 تدعو للترشيح الذكي لا للإلحاح البيعي');

  assert.doesNotMatch(s3 + s4, /primary:[^}]*wa/i, 'واتساب يبقى سطر الخلاص في التذييل وليس الزر الأساسي');
});

// ─── 7) البوابات وعدم التعارض مع بانر التنبيهات والعناصر العائمة ─────────
test('البوابات وحالة الانشغال وإصلاح تعارض بانر التنبيهات', () => {
  const gates = JS.slice(JS.indexOf('function isPreviewMode'), JS.indexOf('function busy()'));
  assert.match(gates, /saveData === true/, 'إعفاء وضع توفير البيانات');
  assert.match(gates, /effectiveType/, 'الشبكة البطيئة (2g) معفاة');
  assert.match(gates, /nudge=off/, 'إطفاء فوري بالرابط');
  assert.match(gates, /nudge=preview/, 'وضع معاينة فوري للاختبار الحي');
  assert.match(gates, /window\.NASR_NUDGE === false/, 'إطفاء فوري من الكود');
  assert.match(gates, /st\.muted === 1 \|\| st\.seen === 1/, 'احترام الكتم واكتمال الجولة');
  // مهم: لا نكتم الإشعارات النصية بسبب prefers-reduced-motion في JS (تُعالج حركيًا في CSS فقط)
  assert.doesNotMatch(gates, /prefers-reduced-motion/, 'تقليل الحركة يعطّل الأنيميشن في CSS ولا يكتم النص');

  const busy = JS.slice(JS.indexOf('function busy()'), JS.indexOf('function track('));
  assert.match(busy, /INPUT/, 'لا مقاطعة أثناء الكتابة');
  assert.match(busy, /\[aria-modal="true"\]/, 'لا مقاطعة لمودال مفتوح');
  assert.match(busy, /\.push-banner-visible:not\(\.push-banner-hidden\)/, 'انتظار بانر التنبيهات الفعلي فقط');
  assert.match(busy, /\.pp-lightbox\.show/, 'لا ظهور فوق معرض الصور المكبّر');

  // ضمان إزالة push-banner-visible عند إخفاء بانر الإشعارات حتى لا يحجب المُضيف الذكي للأبد
  assert.match(PUSH_JS, /el\.classList\.remove\('push-banner-visible'\)/,
    'push-notifications.js يزيل push-banner-visible عند الإغلاق أو التفعيل');
});

// ─── 8) أزمنة قراءة إنسانية وإيقاف المؤقّت عند التفاعل ────────────────────
test('وقت قراءة مريح (16–20 ثانية) وإيقاف كامل للمؤقّت عند اللمس أو الماوس', () => {
  for (const ttl of ['ttl: 16000', 'ttl: 20000', 'ttl: 18000']) {
    assert.ok(JS.includes(ttl), `مدة القراءة المريحة موجودة: ${ttl}`);
  }
  assert.doesNotMatch(JS, /ttl:\s*[1-9]\d{0,3}\b/, 'ممنوع أي مدة قراءة أقل من 10 ثوانٍ تخطف الرسالة');
  assert.match(JS, /var RESUME_MIN_TTL = 9000;/, 'مهلة مريحة لا تقل عن 9 ثوانٍ بعد رفع الماوس أو اليد');
  assert.match(JS, /function pauseCountdown\(\)/, 'دالة إيقاف العد التنازلي أثناء القراءة');
  assert.match(JS, /function resumeCountdown\(\)/, 'دالة استئناف العد التنازلي بعد القراءة');
  assert.match(JS, /root\.addEventListener\('pointerenter', pauseCountdown\)/);
  assert.match(JS, /root\.addEventListener\('touchstart', pauseCountdown/);
  assert.doesNotMatch(JS, /'(pointermove|mousemove|wheel)'/, 'لا مستمعات ثقيلة على حركة الماوس أو العجلة');
  assert.match(JS, /e\.key === 'Escape'/, 'زر Escape يغلق الرسالة الحالية بهدوء');
});

// ─── 9) الحجم والتقييد والتباين البصري وعدم تسريب الأنماط ─────────────────
test('الحجم والتحميل والتقييد: defer، بلا inline handler، وأنماط محصورة بـ .wn-', () => {
  assert.ok(JS.length < 25000, `حجم السكربت تجاوز السقف: ${JS.length}`);
  assert.ok(INC.length < 8000, `حجم القالب تجاوز السقف: ${INC.length}`);
  assert.match(INC, /<script src="\{\{ '\/assets\/js\/welcome-nudge\.js(\?v=[a-z0-9-]+)?'/, 'سكربت منفصل');
  assert.match(INC, /welcome-nudge\.js(\?v=[a-z0-9-]+)?' \| relative_url \}\}" defer><\/script>/, 'defer — لا يحجب الرسم');
  assert.doesNotMatch(INC, /onclick=|onload=/, 'ممنوع معالج مضمَّن في HTML');

  const style = INC.slice(INC.indexOf('<style>') + 7, INC.indexOf('</style>'));
  const selectors = style.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('{') && !l.startsWith('@') && !l.startsWith('}'))
    .map((l) => l.split('{')[0].trim())
    .filter((l) => l && l !== '}');
  const leaked = selectors.filter((sel) => {
    const parts = sel.split(/[\s>+,]+/).filter(Boolean);
    return !parts.every((p) => /^\.wn([-a-z0-9]|$)/i.test(p) || /^from$/i.test(p) || /^to$/i.test(p));
  });
  assert.deepEqual(leaked, [], `أنماط خارج نطاق .wn- قد تؤثر على صفحات أخرى: ${leaked.join(', ')}`);

  const z = style.match(/z-index:\s*(\d+)/);
  assert.ok(z && Number(z[1]) > 900 && Number(z[1]) < 1000,
    'z-index فوق بانر التنبيهات (940) وتحت القائمة العائمة (99999)');
  assert.match(style, /\.wn-btn-primary\s*\{\s*background:\s*#238636;\s*color:\s*#ffffff;/,
    'تباين نص أبيض ناصع مقروء على الزر الأساسي');
  assert.match(style, /\.wn-high/, 'إزاحة ذكية فوق أزرار واتساب العائمة في صفحات العقارات والطلبات');
  assert.match(style, /prefers-reduced-motion: reduce/, 'إيقاف الأنيميشن لمن يفضل تقليل الحركة');
  assert.match(style, /@media print/, 'إخفاء البطاقة عند الطباعة');
});

// ─── 10) القياس في dataLayer الموجود وتوثيق الخصوصية ──────────────────────
test('القياس في dataLayer الموجود فقط، وprivacy-policy.html يوثّق التخزين بدقة', () => {
  assert.match(JS, /window\.dataLayer = window\.dataLayer \|\| \[\];/, 'بلا مكتبة تحليلات جديدة');
  assert.doesNotMatch(both, /gtag\(|analytics\.js|plausible|fathom|cookie/i, 'لا كوكيز ولا محلل جديد');
  const evts = [...JS.matchAll(/track\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(evts)].sort(), ['nudge_close', 'nudge_shown', 'nudge_tap']);

  const pp = read('privacy-policy.html');
  assert.match(pp, /simsar_welcome_nudge_v1/, 'المفتاح الدائم موثَّق في سياسة الخصوصية');
  assert.match(pp, /simsar_welcome_session_v2/, 'عداد الجلسة المؤقت موثَّق في سياسة الخصوصية');
  assert.match(pp, /لا صوت في هذه الرسائل/, 'سياسة الخصوصية تؤكد غياب الصوت وأذونات الميكروفون');
});

// ─── 11) «طارق هو الخلاص» في الهيرو: خلاص نصّي هادي، مش افتتاحية محادثة ─────
test('الصفحة الأولى تربط الشخص بالكيان، والمحادثة طريق خروج لا زر افتتاحي', () => {
  const hero = HOME.slice(HOME.indexOf('<section class="hp-hero">'), HOME.indexOf('hp-trust-strip'));
  assert.match(hero, /<strong>سمسار طلبك<\/strong> هو طارق طنطاوي/,
    'البداية تذكر اسم الشخص مع الكيان');
  assert.match(hero, /hp-hero-escape/, 'سطر الخلاص موجود في بلوك التواصل');
  assert.match(hero, /class="hp-btn primary"[\s\S]*تصفّح العروض/, 'الزر الأساسي خدمة ذاتية');
  assert.doesNotMatch(hero, /hp-btn[^"]*"[^>]*agent\.html/, 'ممنوع زر محادثة في صف أزرار الهيرو');
  assert.doesNotMatch(hero, /احكِ للوكيل|تحدث مع طارق|ابدأ المحادثة/, 'ولا صيغة «افتح محادثة» في أول شاشة');
  assert.match(hero, /rel="noopener noreferrer"/, 'رابط الخلاص الخارجي محمي');
  assert.match(LAYOUT, /agent-float-btn[\s\S]{0,400}طارق طنطاوي/, 'زر طارق العائم يفضل كما هو');
  assert.match(read('_includes/floating-menu.html'), /agent\.html/, 'القائمة تحتفظ بطريق الوكيل');
  const css = read('assets/css/style.css');
  assert.match(css, /body\.homepage \.hp-hero-escape/, 'سطر الخلاص له قاعدة في style.css');
  assert.match(read('assets/css/route-home.min.css'), /\.hp-hero-escape/,
    'القاعدة مبنية في حزمة الرئيسية');
});

// ─── 12) سطر الخلاص مقياس بنفس الحدث الموجود ──────────────────────────────
test('خلاص الهيرو يُقاس بـ whatsapp_inquiry القائم، وبلا ملف أو وسم جديد', () => {
  const hero = HOME.slice(HOME.indexOf('<section class="hp-hero">'), HOME.indexOf('hp-trust-strip'));
  assert.match(hero, /event: 'whatsapp_inquiry'/, 'نفس اسم الحدث المستعمل في _layouts/property_page.html');
  assert.match(hero, /call_source: 'home_hero_escape'/, 'المصدر مميز للمقارنة');
  assert.match(hero, /typeof dataLayer === 'undefined'/, 'بلا GTM شغّال ⇒ سكربت صامت');
  assert.match(hero, /\{%-\s*comment\s*-?%\}[\s\S]*?\{%-\s*endcomment\s*-?%\}/, 'التعليق موثَّق في المصدر');
  assert.doesNotMatch(hero, /<script src=/, 'بلا طلب شبكة إضافي في أول شاشة');
});
