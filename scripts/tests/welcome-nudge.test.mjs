// ═══════════════════════════════════════════════════════════════════════
// حراسات «تحية سمسار طلبك» (Welcome Nudge — V1)
// ─────────────────────────────────────────────────────────────────────
// سبب وجود هذا الملف: الفكرة دي كلها «لطف»، لكن اللطف بلا قواعد يتحوّل إزعاجًا،
// وأي خطأ هنا يمسّ الصفحة الأولى لكل زائر. الاختبارات دي تقفل الانحرافات اللي
// عرفناها من تاريخ المستودع:
//   • لا صوت تلقائي (نفس قاعدة _includes/property-audio.html) ولا TTS من الجهاز —
//     الهوية الصوتية لها مسار إنتاج مُلزِم في scripts/audio، والتحايل عليه ممنوع.
//   • لا نافذة معطِّلة، ولا التقاط focus، ولا overlay يبلع الصفحة.
//   • التخزين: مفتاح واحد بحقول معدودة، وكل عملية داخل try/catch (تصفح خاص).
//   • لا أرقام هواتف مكتوبة في الكود، ولا نص حرّ للزائر يُخزَّن.
//   • الأسلوب محصور بـ .wn- حتى لا يلمس أي صفحة أخرى (لا يُبنى في route-*.min.css).
//   • طارق هو «الخلاص»: رابط التواصل يظهر في درجات ما بعد التعريف فقط، لا في الأولى.
//   • الدرجة تُعرض مرة واحدة للجهاز، وموافةق مع بانر التنبيهات (لا فقاعتان معًا).
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
  .replace(/\{%-?\s*comment\s*-?%}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')   // تعليقات Liquid
  .replace(/\/\*[\s\S]*?\*\//g, '')                                             /* كتل JS */
  .replace(/^\s*\/\/.*$/gm, '');                                                 // أسطر JS معلقة
const JS = read('assets/js/welcome-nudge.js');
const INC = read('_includes/welcome-nudge.html');
const LAYOUT = read('_layouts/default.html');
const HOME = read('index.html');
const both = stripComments(JS) + '\n' + stripComments(INC);

// ─── 1) الإضافة مضبوطة بعلم، وعلى صفحة واحدة ─────────────────────────────
test('التحية مقيدة بصفحة واحدة عبر page.welcome_nudge ولا تُفرض على كل الموقع', () => {
  assert.match(LAYOUT, /\{%-?\s*if page\.welcome_nudge\s*%\}\s*\{%\s*include welcome-nudge\.html\s*%\}\s*\{%-?\s*endif\s*-?%\}/,
    'لازم يكون الإدراج مشروطًا بـ page.welcome_nudge في _layouts/default.html');
  const flagged = fs.readdirSync(ROOT, { recursive: true })
    .filter((f) => f.endsWith('.html'))
    .filter((f) => /^\s*welcome_nudge:\s*true\s*$/m.test(read(f)));
  assert.deepEqual(flagged, ['index.html'],
    'اليوم: index.html وحدها (تجربة على صفحة واحدة) — أي إضافة لصفحة أخرى لازم تكون بقرار');
});

// ─── 2) لا صوت إطلاقًا في V1 ──────────────────────────────────────────────
test('V1 بلا صوت: لا <audio>، لا autoplay، ولا speechSynthesis', () => {
  for (const banned of ['<audio', 'autoplay', 'speechSynthesis', 'SpeechSynthesisUtterance', 'new Audio(', '.play()']) {
    assert.ok(!both.includes(banned), `ممنوع في V1: ${banned}`);
  }
  assert.ok(!/assets\/audio\//.test(both), 'لا ملف صوتي من إنتاج الهوية الصوتية يُحمَّل هنا');
});

// ─── 3) لا حاجز فوق الصفحة ────────────────────────────────────────────────
test('فقاعة صغيرة فقط: لا modal ولا alert ولا قفل للتمرير', () => {
  for (const banned of ['alert(', 'confirm(', 'prompt(', '<dialog', 'role="dialog"', 'inset: 0', 'position: fixed;\n    inset: 0']) {
    assert.ok(!both.includes(banned), `ممنوع: ${banned} — الإزعاج مش حاجز`);
  }
  assert.doesNotMatch(JS, /document\.body\.style\.overflow/, 'لا قفل لتمرير الصفحة');
  assert.doesNotMatch(INC, /\.wn(-|\b)[^{}]*\{[^}]*\btop:\s*0[^}]*\}/, 'لا تغطية كاملة للشاشة');
  assert.ok(!/\.wn-overlay|\.wn-backdrop/.test(INC), 'لا خلفية معتمة');
});

// ─── 4) التخزين: مفتاح واحد بحقول معدودة، كله داخل try/catch ─────────────
test('المخزون: simsar_welcome_nudge_v1 بحقول v/seen/muted/stage فقط، وكل كتابة محمية', () => {
  assert.match(JS, /var KEY = 'simsar_welcome_nudge_v1';/, 'اسم المفتاح ثابت (نفس نمط simsar_gemini_consent_v1)');
  const writes = JS.match(/window\.localStorage\.setItem\([\s\S]*?\}\);/);
  assert.ok(writes, 'لازم الكتابة تمرّ عبر دالة واحدة تحصر الحقول');
  const fields = [...writes[0].matchAll(/^\s{8}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ['muted', 'seen', 'stage', 'v'],
    'أي حقل جديد في التخزين لازم يوثَّق في privacy-policy.html أولًا');
  const storageCalls = JS.match(/window\.localStorage\.\w+/g) || [];
  assert.deepEqual(storageCalls, ['window.localStorage.getItem', 'window.localStorage.setItem'],
    `التخزين محصور في قراءة وكتابة واحدات: ${storageCalls.join(', ')}`);
  assert.doesNotMatch(JS, /removeItem/, 'ممنوع مسح العلامة تلقائيًا — «مرة واحدة» تعني مرة واحدة');
  for (const m of storageCalls) {
    const at = JS.indexOf(m);
    const before = JS.slice(Math.max(0, at - 240), at);
    assert.match(before, /try \{/, `«${m}» لازم تبقى داخل try/catch`);
  }
  assert.doesNotMatch(JS, /localStorage\.setItem\([^)]*(input|value|innerText|textContent)/,
    'ممنوع تخزين أي نص كتبه الزائر');
});

// ─── 5) لا أرقام ولا بيانات في الكود ──────────────────────────────────────
test('لا أرقام هواتف مكتوبة في السكربت، والوصلة تجي من الإعدادات', () => {
  assert.doesNotMatch(JS, /\b\d{9,}\b/, 'لا رقم طويل في الكود (الوصلة من data-wn-wa)');
  assert.match(INC, /data-wn-wa="\{\{ site\.contact\.whatsapp_url/,
    'رابط واتساب يُقرأ من إعدادات الموقع في القالب، لا من السكربت');
  assert.match(JS, /var waUrl = root\.getAttribute\('data-wn-wa'\) \|\| '';/);
  assert.match(JS, /if \(copy\.escape && waHref\) \{/, 'بلا رابط ⇒ بلا سطر خلاص، ومفيش كسر');
});

// ─── 6) طارق = الخلاص، مش الافتتاحية ─────────────────────────────────────
test('درجة التعريف S0 بلا عرض محادثة، والخلاص يظهر بعدها فقط', () => {
  const s0 = JS.slice(JS.indexOf('S0: {'), JS.indexOf('S1: {'));
  const s1 = JS.slice(JS.indexOf('S1: {'), JS.indexOf('S3: {'));
  const s3 = JS.slice(JS.indexOf('S3: {'), JS.indexOf('};', JS.indexOf('S3: {')));
  assert.match(s0, /escape: false/, 'S0 تعريف بالشخص والكيان — لا «كلّم طارق» في أول ثانية');
  assert.doesNotMatch(s0, /wa|whatsapp|واتساب/i, 'ممنوع أي دعوة للمحادثة في S0');
  assert.match(s1, /escape: true/);
  assert.match(s3, /escape: true/);
  assert.match(s0, /طارق طنطاوي/, 'S0 لازم تربط الشخص بالكيان');
  assert.match(s0, /سمسار طلبك/, 'S0 لازم تذكر اسم الكيان');
  assert.match(s3, /مش لاقي|المناسب/, 'S3 تخاطب «جدّي بس مش لاقي»');
  assert.ok(s3.includes('ترشيح'), 'S3 تدعو لترشيح، مش لبيع');
  // الخلاص مش الزر الأساسي في أي درجة
  assert.doesNotMatch(s1 + s3, /primary:[^}]*wa/, 'واتساب يبقى سطر الخلاص، مش الزر الأساسي');
});

// ─── 7) البوابات: إمتى تظهرش خالص ─────────────────────────────────────────
test('البوابات: reduced-motion، saveData، شبكة بطيئة، PWA مثبّت، بانر التنبيهات، والكتابة', () => {
  const gates = JS.slice(JS.indexOf('function disabled()'), JS.indexOf('function busy()'));
  assert.match(gates, /prefers-reduced-motion: reduce/);
  assert.match(gates, /display-mode: standalone/);
  assert.match(gates, /saveData === true/);
  assert.match(gates, /effectiveType/, 'الشبكة البطيئة (2g) معفاة من التحية');
  assert.match(gates, /nudge=off/, 'إطفاء فوري بالرابط');
  assert.match(gates, /window\.NASR_NUDGE === false/, 'إطفاء فوري من الكود');
  assert.match(gates, /flag\.seen === 1 \|\| flag\.muted === 1/, 'مرة واحدة للجهاز للأبد');
  const busy = JS.slice(JS.indexOf('function busy()'), JS.indexOf('function idleFor'));
  assert.match(busy, /INPUT/, 'مفيش مقاطعة لكتابة');
  assert.match(busy, /\[aria-modal="true"\]/, 'مفيش مقاطعة لمودال مفتوح');
  assert.match(busy, /\.push-banner-visible/, 'بانر التنبيهات أولّى — لا فقاعتان معًا');
  assert.match(JS, /clickedCard = true/, 'دوس على بطاقة عقار = لا تحية');
});

// ─── 8) السلَّم نفسه ──────────────────────────────────────────────────────
test('التوقيتات: 1.2ث للتعريف، 20ث للهدوء، 25ث قبل نية الخروج، ودرجة واحدة في الجلسة', () => {
  assert.match(JS, /show\('S0'\);\s*\}, 1200\)/, 'S0 بعد أول رسم بثانية ونص');
  assert.match(JS, /\}, 20000\);/, 'S1 عند عتبة العشرين ثانية');
  assert.match(JS, /var EXIT_AFTER = 25000, IDLE_MS = 3000, EXIT_RETRY = 800;/,
    'التوقيتات مرقّمة في ثوابت، مش أرقام سحرية مبعثرة');
  assert.match(JS, /if \(!elapsedSinceLoad\(EXIT_AFTER\)\) return;/, 'S3 ما يسبقش 25 ثانية');
  assert.match(JS, /function maybeExitIntent\(minIdle\) \{\n    if \(off \|\| dismissed \|\| exitFired\) return;\n    if \(!elapsedSinceLoad\(EXIT_AFTER\)\) return;/,
    'بوابة العمر جوه الباب الوحيد ⇒ كل المسارات محكومة بيها (visibilitychange كان فلاتها)');
  assert.equal((JS.match(/elapsedSinceLoad\(/g) || []).length, 2,
    'استعمال واحد للبوابة + تعريفها — مفيش بوابات متكرّرة تتناقض');
  assert.match(JS, /maybeExitIntent\(EXIT_RETRY\)/, 'التفويت مش صامت: إعادة قياس بعد 800 مللي');
  assert.match(JS, /if \(off \|\| dismissed \|\| exitFired \|\| current \|\| !fired\.S1\) return;/,
    'مسار أعلى الصفحة: بعد S1 بس، ومفيش فقاعة ظاهرة حالّيًا');
  assert.match(JS, /> TOP_Y\) return;/, '«أعلى الصفحة» = 8 بكسل أو أقل، مش تقدير');
  assert.doesNotMatch(JS, /'(pointermove|mousemove|wheel)'/,
    'ممنوع مستمعات على حركة الماوس/العجلة — الأداء وأول شاشة');
  assert.match(JS, /if \(off \|\| dismissed \|\| fired\[stage\]\) return;/, 'فقاعة واحدة، وكل درجة مرة');
  assert.match(JS, /if \(current !== stage\) return;/, 'مفيش استبدال لدرجة سابقة بغلط');
  assert.match(JS, /if \(how === 'dismiss' \|\| how === 'x'\) dismissed = true;/, 'رفض صريح يوقف السلَّم');
  assert.match(JS, /writeFlag\(\{ seen: 1, stage: STAGES\[stage\] \|\| 0 \}\);\n    track\('nudge_shown'/,
    'الظهور نفسه يسجّل seen ⇒ مفيش إلحاح متكرر');
  assert.match(JS, /window\.addEventListener\('scroll', function \(\) \{ mark\(\); watchTopStillness\(\); \}, \{ passive: true \}\)/,
    'متابعة النشاط passive (بلا preventDefault) وبتشغّل عدّاد الثبات');
  // «وقف في الأعلى» لازم يُقاس مرتين: عند التسليح وعند انتهاء المؤقّت —
  // لو الزائر لفّ لنزول في النص المسار يتلغى (الفقاعة مش مقابل قراءة).
  assert.match(JS, /function topOffset\(\) \{ return \(window\.scrollY \|\| 0\)/);
  assert.equal((JS.match(/topOffset\(\) > TOP_Y/g) || []).length, 2, 'قياسين للموضع: التسليح ووقت المؤقّت');
  assert.match(JS, /if \(topOffset\(\) > TOP_Y\) return;\n\s*if \(topStillTimer\) return;/);
  assert.match(JS, /topStillTimer = window\.setTimeout\(function \(\) \{[\s\S]{0,140}if \(topOffset\(\) > TOP_Y\) return;/);
  assert.doesNotMatch(JS, /clearTimeout\(timers/, 'قفل الفقاعة ما يُلغيش السلَّم — كل مؤقّت له نطاقه');
  assert.match(JS, /e\.key === 'Escape'/, 'Esc يقفلها');
});

// ─── 9) لا إزعاج للأداء ولا تسريب للأنماط ──────────────────────────────────
test('الحجم والتحميل والتقييد: defer، بلا inline handler، وأنماط محصورة بـ .wn-', () => {
  assert.ok(JS.length < 20000, `حجم السكربت كبر: ${JS.length}`);
  assert.ok(INC.length < 8000, `حجم القالب كبر: ${INC.length}`);
  assert.match(INC, /<script src="\{\{ '\/assets\/js\/welcome-nudge\.js'/, 'سكربت منفصل');
  assert.match(INC, /welcome-nudge\.js' \| relative_url \}\}" defer><\/script>/, 'defer — لا يحجب الرسم');
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
  assert.deepEqual(leaked, [], `أنماط خارج نطاق .wn- هتلمس صفحات تانية: ${leaked.join(', ')}`);
  const z = style.match(/z-index:\s*(\d+)/);
  assert.ok(z && Number(z[1]) > 900 && Number(z[1]) < 1000,
    'z-index لازم فوق بانر التنبيهات (940) وتحت القائمة (99999)');
  assert.match(style, /prefers-reduced-motion: reduce/, 'الحركة تُطفأ لو الزائر طلب ذلك');
  assert.match(style, /@media print/, 'الطباعة تتخلص من الفقاعة');
});

// ─── 10) القياس بدون تتبّع جديد، والوثائق متسقة ───────────────────────────
test('القياس في dataLayer الموجود فقط، وprivacy-policy.html يصرّح بالمفتاح', () => {
  assert.match(JS, /window\.dataLayer = window\.dataLayer \|\| \[\];/, 'بلا مكتبة تحليلات جديدة');
  assert.doesNotMatch(both, /gtag\(|analytics\.js|plausible|fathom|cookie/i, 'لا cookie ولا محلل جديد');
  const evts = [...JS.matchAll(/track\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(evts)].sort(), ['nudge_close', 'nudge_shown', 'nudge_tap']);
  const pp = read('privacy-policy.html');
  assert.match(pp, /simsar_welcome_nudge_v1/, 'لازم المفتاح موثَّق في سياسة الخصوصية');
  assert.match(pp, /<code>localStorage<\/code> علامة واحدة/, 'تعداد ما يُخزَّن مش ادعاء عام');
  assert.match(pp, /لا صوت في هذه النسخة/, 'سياسة الخصوصية تقول صراحة: V1 بلا صوت');
  assert.match(HOME, /^welcome_nudge: true$/m, 'الصفحة الرئيسية ترفع العلم');
  assert.match(HOME, /<strong>سمسار طلبك<\/strong> هو طارق طنطاوي/,
    'البداية تربط الشخص بالكيان — مطلوب صراحة في الفروضة');
});

// ─── 11) «طارق هو الخلاص» في الهيرو: خلاص نصّي هادي، مش افتتاحية محادثة ─────
test('الصفحة الأولى تربط الشخص بالكيان، والمحادثة طريق خروج لا زر افتتاحي', () => {
  const hero = HOME.slice(HOME.indexOf('<section class="hp-hero">'), HOME.indexOf('hp-trust-strip'));
  assert.match(hero, /<strong>سمسار طلبك<\/strong> هو طارق طنطاوي/,
    'البداية تذكر اسم الشخص مع الكيان (طلب صريح في الفروضة)');
  assert.match(hero, /hp-hero-escape/, 'سطر الخلاص موجود في بلوك التواصل');
  assert.match(hero, /class="hp-btn primary"[\s\S]*تصفّح العروض/, 'الزر الأساسي خدمة ذاتية');
  assert.doesNotMatch(hero, /hp-btn[^"]*"[^>]*agent\.html/, 'ممنوع زر محادثة في صف أزرار الهيرو');
  assert.doesNotMatch(hero, /احكِ للوكيل|تحدث مع طارق|ابدأ المحادثة/, 'ولا صيغة «افتح محادثة» في أول شاشة');
  assert.match(hero, /rel="noopener noreferrer"/, 'رابط الخلاص الخارجي محمي');
  // الرابط نفسه يبقى موجودًا في العالم (القائمة + الزر العائم) — إحنا نقلّص الإلحاح مش النافذة
  assert.match(LAYOUT, /agent-float-btn[\s\S]{0,400}طارق طنطاوي/, 'زر طارق العائم يفضل كما هو');
  assert.match(read('_includes/floating-menu.html'), /agent\.html/, 'القائمة تحتفظ بطريق الوكيل');
  const css = read('assets/css/style.css');
  assert.match(css, /body\.homepage \.hp-hero-escape/, 'سطر الخلاص له قاعدة في style.css (لا أنماط مبعثرة)');
  assert.match(read('assets/css/route-home.min.css'), /\.hp-hero-escape/,
    'القاعدة مبنية في حزمة الرئيسية — وإلا npm run css:check سيسقط');
});

// ─── 12) سطر الخلاص مقياس بنفس الحدث الموجود (مقارنة مش اختراع) ──────────────
test('خلاص الهيرو يُقاس بـ whatsapp_inquiry القائم، وبلا ملف أو وسم جديد', () => {
  const hero = HOME.slice(HOME.indexOf('<section class="hp-hero">'), HOME.indexOf('hp-trust-strip'));
  assert.match(hero, /event: 'whatsapp_inquiry'/, 'نفس اسم الحدث المستعمل في _layouts/property_page.html');
  assert.match(hero, /call_source: 'home_hero_escape'/, 'المصدر مميز ⇒ نقارن بالرابط القديم بلا لبس');
  assert.match(hero, /typeof dataLayer === 'undefined'/, 'بلا GTM شغّال ⇒ سكربت صامت، مفيش خطأ');
  assert.match(hero, /\{%-\s*comment\s*-?%\}[\s\S]*?\{%-\s*endcomment\s*-?%\}/, 'التعليق موثَّق في المصدر ولا يتسرّب للمخرجات');
  assert.doesNotMatch(hero, /<script src=/, 'بلا طلب شبكة إضافي في أول شاشة');
});
