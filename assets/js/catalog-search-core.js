/*!
 * catalog-search-core.js — نواة البحث العربي لمعرض العقارات (2026-10-20)
 * ───────────────────────────────────────────────────────────────
 * دوال صافية بلا DOM ولا مكتبات (~6KB مضغوطة قبل gzip). تُستعمل في المتصفح
 * عبر window.NasrSearch، وتُختبر في Node (scripts/tests/catalog-search.test.mjs).
 *
 *  • normalize: تشكيل/تطويل، أ إ آ ٱ ← ا، ى ← ي، ة ← ه، ؤ ← و، ئ ← ي،
 *    أرقام ٠-٩ و۰-۹ ← 0-9، فواصل الآلاف (، ٬ ,) وعلامة العشري (٫).
 *  • parseQuery: يفهم «شقه للبيع»، «3 غرف»، «شقة 150 متر»، «أقل من 5 مليون»،
 *    «من 2 إلى 3 مليون»، «إيجار تحت 20 ألف»، «غرفتين»، «مليون ونص»...
 *  • حدود صارمة (2026-10-25، من التدقيق العملي): «أقل من/تحت/دون» حصرية
 *    (maxExclusive) و«أكبر من/فوق» حصرية (minExclusive)، و«حتى/لحد/بحد أقصى»
 *    شاملة. «بالضبط/تمامًا» تعني مساواة تامة (exact) لا كلمة بحث، و«شهريًا»
 *    وحدة سعر (monthly) تعني إيجارًا ولا تصفّر النتائج. كل لفظ يبقى ظاهرًا في
 *    understood بلغة المستخدم: «أقل من 20 ألف شهريًا» لا «حتى 20 ألف».
 *    والرقم بلا وحدة (مثل «عمارة 12» أو «المنطقة 10») لا يتحول إلى فلتر:
 *    يبقى نصًا، إلا لو كان واضحًا أنه سعر (≥ 20,000).
 *  • كل ما فُهم يُعاد في understood[] مع النص الأصلي (src) لعرضه كشرائح قابلة للحذف.
 */
(function (root) {
  'use strict';

  var TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

  function toWesternDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[\u06F0-\u06F9]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }

  function normalize(s) {
    var t = toWesternDigits(s).toLowerCase()
      .replace(TASHKEEL, '')
      .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ ٱ ← ا
      .replace(/\u0649/g, '\u064A')                     // ى ← ي
      .replace(/\u0629/g, '\u0647')                     // ة ← ه
      .replace(/\u0624/g, '\u0648')                     // ؤ ← و
      .replace(/\u0626/g, '\u064A')                     // ئ ← ي
      .replace(/\u066B/g, '.')                          // ٫ عشري
      .replace(/[\u066C\u060C]/g, ',')                  // ٬ ، فاصل
      .replace(/\u00B2/g, '2');                         // م² ← م2
    // فواصل الآلاف: 5,000,000 ← 5000000 ؛ ثم 3,5 ← 3.5
    t = t.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
    t = t.replace(/(\d),(\d)/g, '$1.$2');
    t = t.replace(/[^\u0621-\u064A0-9a-z.\s-]+/g, ' ').replace(/(^|\s)[.-]+|[.-]+(?=\s|$)/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  // ─── المفردات (بعد التطبيع) ───────────────────────────────────
  var DEAL_WORDS = [
    [/^(لل)?(بيع|تمليك|شراء)$/, 'sale'],
    [/^(لل|ل)?(ايجار|ايجارات|الايجار|ايجاري|اجار)$/, 'rent'],
  ];
  var TYPE_WORDS = [
    [/^(ال)?(شقه|شقق|شقتين)$/, ['apartment'], 'شقة'],
    [/^(ال)?(سكني|سكنيه)$/, ['apartment', 'villa'], 'سكني'],
    [/^(ال)?(فيلا|فيلات|فلل|فيله|دوبلكس|دوبليكس|تاون)$/, ['villa'], 'فيلا/دوبلكس'],
    [/^(ال)?(محل|محلات|صيدليه|معرض|شوروم)$/, ['shop'], 'محل'],
    [/^(ال)?(تجاري|تجاريه|تجارى)$/, ['shop', 'office', 'clinic', 'warehouse'], 'تجاري/إداري'],
    [/^(ال)?(مكتب|مكاتب|اداري|اداريه|مقر|مقرات)$/, ['office'], 'مكتب/إداري'],
    [/^(ال)?(عياده|عيادات)$/, ['clinic'], 'عيادة'],
    [/^(ال)?(مخزن|مخازن|مستودع)$/, ['warehouse'], 'مخزن'],
  ];
  var STOPWORDS = new Set(('في ب من الي عن او و ال علي مع عايز عاوز اريد ابحث محتاج نفسي ' +
    'مدينه نصر بمدينه شارع بشارع شقه_dummy جنيه ج جم egp متر م فقط حوالي تقريبا').split(' '));
  STOPWORDS.delete('شقه_dummy');

  var WORD_NUM = { 'واحد': 1, 'واحده': 1, 'اتنين': 2, 'اثنين': 2, 'ثلاث': 3, 'ثلاثه': 3, 'تلات': 3, 'تلاته': 3,
    'اربع': 4, 'اربعه': 4, 'خمس': 5, 'خمسه': 5, 'ست': 6, 'سته': 6 };
  var ORD_F = { 1: 'الاولي', 2: 'الثانيه', 3: 'الثالثه', 4: 'الرابعه', 5: 'الخامسه', 6: 'السادسه', 7: 'السابعه', 8: 'الثامنه', 9: 'التاسعه', 10: 'العاشره', 11: 'الحاديه عشر' };
  var ORD_M = { 1: 'الاول', 2: 'الثاني', 3: 'الثالث', 4: 'الرابع', 5: 'الخامس', 6: 'السادس', 7: 'السابع', 8: 'الثامن', 9: 'التاسع', 10: 'العاشر' };

  var N = '(\\d+(?:\\.\\d+)?)';
  // وحدة المال: مليون (+ ونص/وربع) | ألف | k | جنيه
  var MONEY = '(?:\\s*(مليون|ملايين|مليار|الف|الاف|k|ك)(?:\\s*(?:و\\s*)?(نص|نصف|ربع))?|\\s*(جنيه|ج|جم|egp))';
  // ─── حدود صارمة (2026-10-25): «أقل من/تحت/دون» و«أكبر من/فوق» حصرية،
  //     و«حتى/لحد/بحد أقصى/ميزانية» شاملة — لأن المستخدم يقصد الاثنين مختلفين.
  var EXC_MAX = '(?:اقل\\s+من|تحت|دون)';
  var INC_MAX = '(?:حتي|لحد|بحد\\s+اقصي|اقصاه|اقصي|ميزانيه|ميزانيتي|max|لا\\s+يزيد\\s+عن|مايزيدش\\s+عن)';
  var EXC_MIN = '(?:اكثر\\s+من|اكبر\\s+من|اعلي\\s+من|فوق|min)';
  var INC_MIN = '(?:لا\\s+يقل\\s+عن|علي\\s+الاقل|من\\s+اول)';
  var MAX_W = '(?:' + EXC_MAX + '|' + INC_MAX + ')';
  var MIN_W = '(?:' + EXC_MIN + '|' + INC_MIN + ')';
  var AROUND_W = '(?:في\\s+حدود|حدود|حوالي|تقريبا|بحوالي)';
  // «بالضبط» تعني مساواة تامة، و«شهريًا» وحدة سعر لا كلمة بحث نصية.
  var EXACT_W = '(?:بالضبط|بالظبط|تماما|exactly)';
  var MONTHLY_W = '(?:شهريا|شهري|بالشهر|كل\\s+شهر|في\\s+الشهر|ل\\s*\\/\\s*شهر|\\/\\s*شهر|monthly)';
  var AREA_U = '\\s*(?:م2|متر\\s*مربع|مترمربع|متر|م|m2|sqm|m)(?![\\u0621-\\u064Aa-z0-9])';
  var ROOM_U = '\\s*(?:غرف|غرفه|اوض|اوضه|حجرات|حجره|اوضات)(?:\\s+نوم)?(?![\\u0621-\\u064A])';
  var BATH_U = '\\s*(?:حمام|حمامات)(?![\\u0621-\\u064A])';

  function moneyValue(num, unit, frac, plainUnit) {
    var v = parseFloat(num);
    if (!isFinite(v)) return null;
    var mul = 1;
    if (unit === 'مليون' || unit === 'ملايين') mul = 1e6;
    else if (unit === 'مليار') mul = 1e9;
    else if (unit === 'الف' || unit === 'الاف' || unit === 'k' || unit === 'ك') mul = 1e3;
    var f = frac === 'ربع' ? 0.25 : frac ? 0.5 : 0;
    if (!unit && !plainUnit) return null;
    return Math.round((v + f) * mul);
  }

  /** قيمة مالية من نص حر: «5 مليون»، «٥٬٠٠٠٬٠٠٠»، «مليون ونص»، «20 الف»، «15000». */
  function parseAmount(text) {
    var t = normalize(text);
    if (!t) return null;
    var m = t.match(new RegExp('^' + N + MONEY + '?$'));
    if (m) {
      var unit = m[2], plain = m[4];
      if (!unit && !plain) { var v = parseFloat(m[1]); return isFinite(v) ? v : null; }
      return moneyValue(m[1], unit, m[3], plain);
    }
    m = t.match(/^(مليون|الف)(?:\s*(?:و\s*)?(نص|نصف|ربع))?$/);
    if (m) return moneyValue('1', m[1], m[2], null);
    return null;
  }

  function fmtMoney(v) {
    if (v >= 1e6) return (Math.round(v / 1e5) / 10).toString().replace(/\.0$/, '') + ' مليون';
    if (v >= 1e3) return (Math.round(v / 100) / 10).toString().replace(/\.0$/, '') + ' ألف';
    return String(v);
  }

  function rangeLabel(kind, r) {
    var f = kind === 'price' ? fmtMoney : function (v) { return v + 'م²'; };
    var label;
    if (r.exact) label = 'بالضبط ' + f(r.exact);
    else if (r.approx) label = 'حوالي ' + f(r.approx);
    else if (r.min != null && r.max != null && r.min === r.max) label = 'بالضبط ' + f(r.min);
    else if (r.min != null && r.max != null) label = 'من ' + f(r.min) + ' إلى ' + f(r.max);
    else if (r.max != null) label = (r.maxExclusive ? 'أقل من ' : 'حتى ') + f(r.max);
    else label = (r.minExclusive ? 'أكبر من ' : 'من ') + f(r.min) + (r.minExclusive ? '' : ' فأكثر');
    // السعر الشهري يُعلن وحدته صراحةً: «حتى 20 ألف شهريًا» لا «حتى 20 ألف».
    if (kind === 'price' && r.monthly) label += ' شهريًا';
    return label;
  }

  /**
   * يحلل استعلامًا حرًا إلى معايير. يعيد:
   * { text:[...], deal, types, rooms:{min,max}, baths:{min}, area:{min,max,approx}, price:{...}, understood:[{kind,label,src}] }
   */
  function parseQuery(q) {
    var src = normalize(q);
    var out = { text: [], deal: null, types: null, rooms: null, baths: null, area: null, price: null, understood: [] };
    if (!src) return out;
    var s = ' ' + src + ' ';

    function take(re, fn) {
      s = s.replace(re, function () {
        var r = fn.apply(null, arguments);
        return r === false ? arguments[0] : ' ';
      });
    }
    function setRange(kind, r, raw) {
      if (out[kind]) return false;
      if (kind === 'price' && monthly) r.monthly = true;
      out[kind] = r;
      out.understood.push({ kind: kind, label: rangeLabel(kind, r), src: raw.trim() });
    }
    function around(v) { return { min: Math.round(v * 0.85), max: Math.round(v * 1.15), approx: v }; }
    function exactRange(v) { return { min: v, max: v, exact: v }; }
    /** حد من كلمة مقارنة: «أقل من/تحت/دون» و«أكبر من/فوق» حصرية، «حتى/لحد/ميزانية» شاملة. */
    function cmpRange(cmp, v) {
      if (new RegExp('^' + EXC_MAX + '$').test(cmp)) return { min: null, max: v, maxExclusive: true };
      if (new RegExp('^' + INC_MAX + '$').test(cmp)) return { min: null, max: v };
      if (new RegExp('^' + EXC_MIN + '$').test(cmp)) return { min: v, max: null, minExclusive: true };
      if (new RegExp('^' + INC_MIN + '$').test(cmp)) return { min: v, max: null };
      return exact ? exactRange(v) : around(v);
    }

    // ── «شهريًا» وحدة سعر لا كلمة بحث (2026-10-25): تُفهم كإيجار شهري وتُزال من
    //    نص البحث، بدل أن تصير tokenًا إلزاميًا فيعنوان الإعلان فتصفّر النتائج.
    var monthly = false;
    var mm = s.match(new RegExp('(?:^|\\s)(' + MONTHLY_W + ')(?=\\s|$)'));
    if (mm) {
      monthly = true;
      s = s.replace(new RegExp('(^|\\s)' + MONTHLY_W + '(?=\\s|$)', 'g'), ' ');
      out.understood.push({ kind: 'period', label: 'إيجار شهري', src: mm[1] });
      if (!out.deal) out.deal = 'rent';
    }

    // ── «بالضبط/تمامًا» مساواة تامة لا كلمة بحث (C09): تُزال ويُعلَّم النطاق exact.
    var exact = false;
    if (new RegExp('(?:^|\\s)' + EXACT_W + '(?=\\s|$)').test(s)) {
      exact = true;
      s = s.replace(new RegExp('(^|\\s)' + EXACT_W + '(?=\\s|$)', 'g'), ' ');
    }

    // «مليون ونص» بلا رقم ← 1.5 مليون
    s = s.replace(/(\s)(مليون|الف)(?=\s*(?:و\s*)?(?:نص|نصف|ربع)?\s)/g, function (m0, sp, u, off, all) {
      return /\d\s*$/.test(all.slice(0, off + sp.length)) ? m0 : sp + '1 ' + u;
    });

    // ── السعر: نطاق «من X الي Y مليون» / «بين X و Y مليون»
    take(new RegExp('\\s(?:من|بين)\\s+' + N + '(?:' + MONEY + ')?\\s*(?:الي|ل|لحد|-|و)\\s*' + N + MONEY + '(?=\\s)', 'g'),
      function (raw, a, ua, fa, pa, b, ub, fb, pb) {
        var vb = moneyValue(b, ub, fb, pb);
        var va = moneyValue(a, ua || ub, fa, pa || pb);
        if (va == null || vb == null) return false;
        return setRange('price', { min: Math.min(va, vb), max: Math.max(va, vb) }, raw);
      });
    // ── السعر مع مقارنة (حصرية/شاملة كما في cmpRange)
    take(new RegExp('\\s(' + MAX_W + '|' + MIN_W + '|' + AROUND_W + ')\\s+' + N + MONEY + '(?=\\s)', 'g'),
      function (raw, cmp, a, u, f, p) {
        var v = moneyValue(a, u, f, p);
        if (v == null) return false;
        return setRange('price', cmpRange(cmp, v), raw);
      });

    // ── المساحة: نطاق ثم مقارنة ثم رقم+وحدة
    take(new RegExp('\\s(?:من|بين)\\s+' + N + '\\s*(?:م|متر)?\\s*(?:الي|ل|لحد|-|و)\\s*' + N + AREA_U, 'g'),
      function (raw, a, b) {
        return setRange('area', { min: Math.min(+a, +b), max: Math.max(+a, +b) }, raw);
      });
    take(new RegExp('\\s(' + MAX_W + '|' + MIN_W + '|' + AROUND_W + ')\\s+' + N + AREA_U, 'g'),
      function (raw, cmp, a) {
        return setRange('area', cmpRange(cmp, +a), raw);
      });
    take(new RegExp('\\s(?:مساحه\\s+)?' + N + AREA_U, 'g'), function (raw, a) {
      var v = +a;
      if (!(v >= 15 && v <= 5000)) return false;
      return setRange('area', exact ? exactRange(v) : around(v), raw);
    });

    // ── الغرف
    take(new RegExp('\\s' + N + ROOM_U + '(\\s+(?:او\\s+اكثر|فاكثر|فما\\s+فوق|واكثر))?', 'g'), function (raw, a, more) {
      var v = Math.round(+a);
      if (!(v >= 1 && v <= 12) || out.rooms) return false;
      out.rooms = more ? { min: v, max: null } : { min: v, max: v };
      out.understood.push({ kind: 'rooms', label: v + (more ? '+ ' : ' ') + 'غرف', src: raw.trim() });
    });
    take(/\s(?:(غرفتين|اوضتين|حجرتين)|(?:(واحده|واحد|اتنين|اثنين|ثلاث|ثلاثه|تلات|تلاته|اربع|اربعه|خمس|خمسه|ست|سته)\s+(?:غرف|غرفه|اوض|اوضه|حجرات)|(?:غرفه|اوضه)\s+(واحده)))(?:\s+نوم)?(?=\s)/g,
      function (raw, two, word, one) {
        if (out.rooms) return false;
        var v = two ? 2 : one ? 1 : WORD_NUM[word];
        out.rooms = { min: v, max: v };
        out.understood.push({ kind: 'rooms', label: v + ' غرف', src: raw.trim() });
      });
    // ── الحمامات
    take(new RegExp('\\s' + N + BATH_U, 'g'), function (raw, a) {
      var v = Math.round(+a);
      if (!(v >= 1 && v <= 8) || out.baths) return false;
      out.baths = { min: v };
      out.understood.push({ kind: 'baths', label: v + '+ حمام', src: raw.trim() });
    });

    // ── رقم مالي صريح بلا مقارنة: «5 مليون»، «20 ألف»، «15000 جنيه»، أو رقم كبير ≥ 20,000
    take(new RegExp('\\s' + N + MONEY + '(?=\\s)', 'g'), function (raw, a, u, f, p) {
      var v = moneyValue(a, u, f, p);
      if (v == null) return false;
      return setRange('price', exact ? exactRange(v) : around(v), raw);
    });
    take(/\s(\d{5,})(?=\s)/g, function (raw, a) {
      var v = +a;
      if (v < 20000) return false;
      return setRange('price', exact ? exactRange(v) : around(v), raw);
    });

    // ── «المنطقه 7» ← «المنطقه السابعه» ؛ «الحي 7» ← «الحي السابع»
    s = s.replace(/\s(المنطقه|منطقه|الحي|حي)\s+(\d{1,2})(?=\s)/g, function (m0, w, d) {
      var fem = /منطقه/.test(w);
      var o = (fem ? ORD_F : ORD_M)[+d];
      return o ? ' ' + w + ' ' + o + ' ' : m0;
    });

    // ── الكلمات: معاملة/نوع/نص
    var words = s.split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var hit = false;
      for (var d = 0; d < DEAL_WORDS.length && !hit; d++) {
        if (DEAL_WORDS[d][0].test(w)) {
          hit = true;
          if (!out.deal) {
            out.deal = DEAL_WORDS[d][1];
            out.understood.push({ kind: 'deal', label: out.deal === 'sale' ? 'للبيع' : 'للإيجار', src: w });
          }
        }
      }
      for (var t = 0; t < TYPE_WORDS.length && !hit; t++) {
        if (TYPE_WORDS[t][0].test(w)) {
          hit = true;
          if (!out.types) {
            out.types = TYPE_WORDS[t][1].slice();
            out.understood.push({ kind: 'type', label: TYPE_WORDS[t][2], src: w });
          }
        }
      }
      if (hit || STOPWORDS.has(w) || w.length < 2 || /^[.-]+$/.test(w)) continue;
      out.text.push(w);
    }
    return out;
  }

  // ─── المطابقة ───────────────────────────────────────────────
  var TYPE_LABEL = { apartment: 'شقه', villa: 'فيلا دوبلكس', shop: 'محل تجاري', office: 'مكتب اداري', clinic: 'عياده', warehouse: 'مخزن' };

  /** يجهّز سجل العقار للبحث مرة واحدة (hay = عنوان + موقع + نوع + معاملة). */
  function prepare(item) {
    item._hay = ' ' + normalize([item.t, item.l, TYPE_LABEL[item.y] || '', item.d === 'rent' ? 'ايجار' : 'بيع'].join(' ')) + ' ';
    return item;
  }

  function tokenMatches(hay, tok) {
    if (hay.indexOf(tok) !== -1) return true;
    var m = tok.match(/^(?:وال|بال|لل|ال|و|ب|ل)(.{3,})$/);
    if (m && hay.indexOf(m[1]) !== -1) return true;
    return false;
  }

  function inRange(v, r) {
    if (!r) return true;
    if (v == null || !(v > 0)) return false; // قيمة مجهولة لا تُحسب مطابقة لفلتر رقمي
    // الحد الحصري يستبعد القيمة المساوية نفسها: «أكبر من 150م» لا يعرض 150م.
    if (r.min != null && (r.minExclusive ? v <= r.min : v < r.min)) return false;
    if (r.max != null && (r.maxExclusive ? v >= r.max : v > r.max)) return false;
    return true;
  }

  /**
   * criteria: { text[], deal, types[], rooms, baths, area, price } — اتحاد ما فُهم من النص
   * وما اختاره المستخدم في الفلاتر (منطق AND).
   */
  function matches(item, c) {
    if (!item._hay) prepare(item);
    if (c.deal && item.d !== c.deal) return false;
    if (c.types && c.types.length && c.types.indexOf(item.y) === -1) return false;
    if (!inRange(item.pn, c.price)) return false;
    // «شهريًا» تعني إيجارًا: سعر شهري لا يطابق وحدة بيع أبدًا (C11a/C11b).
    if (c.price && c.price.monthly && item.d !== 'rent') return false;
    // سعر بمقياس البيع (حد أعلى ≥ مليون أو حد أدنى ≥ 200 ألف) لا يطابق إيجارًا شهريًا
    // صادف أنه «أقل من 5 مليون» حرفيًا — هذا ليس ما يقصده الباحث.
    if (c.price && !c.price.monthly && item.d === 'rent' && !c.deal &&
      ((c.price.max != null && c.price.max >= 1e6) || (c.price.min != null && c.price.min >= 2e5))) return false;
    if (!inRange(item.an, c.area)) return false;
    if (!inRange(item.rn, c.rooms)) return false;
    if (c.baths && !inRange(item.bn, c.baths)) return false;
    var text = c.text || [];
    for (var i = 0; i < text.length; i++) if (!tokenMatches(item._hay, text[i])) return false;
    return true;
  }

  function sortItems(items, sort) {
    var key = { 'price-asc': ['pn', 1], 'price-desc': ['pn', -1], 'area-desc': ['an', -1], 'area-asc': ['an', 1], 'rooms-desc': ['rn', -1] }[sort];
    return items.slice().sort(function (a, b) {
      if (key) {
        var va = a[key[0]] > 0 ? a[key[0]] : null, vb = b[key[0]] > 0 ? b[key[0]] : null;
        if (va !== null || vb !== null) {
          if (va === null) return 1;   // المجهول في النهاية دائمًا
          if (vb === null) return -1;
          if (va !== vb) return (va - vb) * key[1];
        }
      }
      if (typeof a.o === 'number' && typeof b.o === 'number' && a.o !== b.o) return a.o - b.o; // ترتيب المعرض (الأحدث)
      if ((b.ts || 0) !== (a.ts || 0)) return (b.ts || 0) - (a.ts || 0);
      return a.u < b.u ? -1 : a.u > b.u ? 1 : 0; // ترتيب ثابت
    });
  }

  /** دمج معايير النص مع الفلاتر: الفلتر الصريح والنص كلاهما يُطبّق. */
  function combine(parsed, ui) {
    /** تقاطع نطاقين مع الحفاظ على الحصرية: عند تساوي الحدَّين يفوز الحصري. */
    function both(a, b) {
      if (!a) return b || null;
      if (!b) return a;
      var lo = a.min, loX = a.minExclusive === true, hi = a.max, hiX = a.maxExclusive === true;
      if (b.min != null) {
        if (lo == null || b.min > lo) { lo = b.min; loX = b.minExclusive === true; }
        else if (b.min === lo) loX = loX || b.minExclusive === true;
      }
      if (b.max != null) {
        if (hi == null || b.max < hi) { hi = b.max; hiX = b.maxExclusive === true; }
        else if (b.max === hi) hiX = hiX || b.maxExclusive === true;
      }
      var r = { min: lo == null ? null : lo, max: hi == null ? null : hi };
      if (loX) r.minExclusive = true;
      if (hiX) r.maxExclusive = true;
      if (a.monthly || b.monthly) r.monthly = true;
      if (a.exact != null) r.exact = a.exact;
      else if (b.exact != null && lo != null && hi != null && lo !== hi) r.exact = b.exact;
      if (a.approx != null && lo != null && hi != null && a.exact == null) r.approx = a.approx;
      return r;
    }
    var types = parsed.types;
    if (ui.types && ui.types.length) {
      types = types ? types.filter(function (t) { return ui.types.indexOf(t) !== -1; }) : ui.types.slice();
    }
    return {
      text: parsed.text || [],
      deal: ui.deal && parsed.deal && ui.deal !== parsed.deal ? '__none__' : (ui.deal || parsed.deal || null),
      types: types,
      price: both(parsed.price, ui.price),
      area: both(parsed.area, ui.area),
      rooms: both(parsed.rooms, ui.rooms),
      baths: parsed.baths || null,
    };
  }

  function search(items, criteria, sort) {
    return sortItems(items.filter(function (it) { return matches(it, criteria); }), sort || 'newest');
  }

  var api = {
    normalize: normalize, toWesternDigits: toWesternDigits, parseAmount: parseAmount, parseQuery: parseQuery,
    prepare: prepare, matches: matches, sortItems: sortItems, combine: combine, search: search,
    fmtMoney: fmtMoney, rangeLabel: rangeLabel, TYPE_LABEL: TYPE_LABEL,
  };
  root.NasrSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
