/*!
 * crm-core.js — نواة «دفتر العملاء» لصفحة /crm.html (2026-10-27)
 * ───────────────────────────────────────────────────────────────
 * دوال صافية بلا DOM ولا شبكة ولا تخزين. تُستعمل في المتصفح عبر window.SimsarCRM
 * وتُختبر في Node (scripts/tests/crm-core.test.mjs).
 *
 *  • قراءة ملفات جهات الاتصال: TXT («Contact Directory»)، VCF (2.1/3.0/4.0 مع
 *    QUOTED-PRINTABLE العربي من أندرويد)، CSV (Google Contacts/Outlook)،
 *    وسجل المكالمات XML (تطبيق SMS Backup & Restore).
 *  • توحيد الأرقام المصرية (+20) وكشف الأرقام الغلط والدولية.
 *  • تصنيف الجهة من اسمها وملاحظاتها: مالك/طالب/سمسار/حارس/صنايعي، والمعاملة،
 *    ونوع الوحدة، والمنطقة، والمساحة، والسعر/الميزانية.
 *  • دمج الاستيراد بدون ضياع حالة أو تاريخ، وطابور التأكيد، والمطابقة مع
 *    إعلانات الموقع (assets/data/catalog.json)، ونصوص متابعة جاهزة.
 *
 * ⚠️ الخصوصية: لا شيء هنا يرسل أو يرفع أو يخزّن. الصفحة تحفظ على جهاز المستخدم
 * فقط، وروابط واتساب (wa.me) يضغط عليها هو بنفسه — لا إرسال تلقائي أبدًا.
 */
(function (root) {
  'use strict';

  var VERSION = 1;
  var DAY = 86400000;

  // ─── توحيد النص ───────────────────────────────────────────────
  var TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

  function asciiDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[\u06F0-\u06F9]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }

  function norm(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) { /* محركات قديمة */ }
    return asciiDigits(t).replace(TASHKEEL, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** نص مُطبَّع بكلمات مفصولة بمسافة واحدة ومحاط بمسافتين — للمطابقة بالكلمة كاملة. */
  function pad(s) {
    return ' ' + norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
  }

  // كلمة كاملة مع سوابق عربية اختيارية: افتراضيًا (ال، و، ب، لل، وال، بال، فال)،
  // و'waw' = «و» فقط (للقوائم اللي فيها صيغ ال/لل صريحة)، و'none' = بلا سوابق.
  function W(alts, mode) {
    var pre = mode === 'none' ? '' : mode === 'waw' ? '(?:و)?' : '(?:ال|و|ب|لل|وال|بال|فال)?';
    return new RegExp(' ' + pre + '(?:' + alts + ')(?= )');
  }
  function S(alts) { return new RegExp('(?:' + alts + ')'); }

  // ─── الأرقام ─────────────────────────────────────────────────
  var COUNTRY = { '966': 'السعودية', '971': 'الإمارات', '965': 'الكويت', '974': 'قطر', '968': 'عُمان',
    '973': 'البحرين', '249': 'السودان', '211': 'جنوب السودان', '962': 'الأردن', '218': 'ليبيا', '964': 'العراق',
    '967': 'اليمن', '961': 'لبنان', '963': 'سوريا', '970': 'فلسطين', '212': 'المغرب', '213': 'الجزائر',
    '216': 'تونس', '44': 'بريطانيا', '49': 'ألمانيا', '33': 'فرنسا', '39': 'إيطاليا', '46': 'السويد',
    '61': 'أستراليا', '90': 'تركيا', '234': 'نيجيريا', '1': 'أمريكا/كندا' };
  var CC_KEYS = Object.keys(COUNTRY).sort(function (a, b) { return b.length - a.length; });

  /**
   * يوحّد رقمًا خامًا إلى أرقام دولية بلا «+» (للروابط tel:/wa.me).
   * kind: eg-mobile | eg-landline | intl | short | invalid
   */
  function normalizePhone(raw) {
    var s = asciiDigits(raw).trim();
    var plus = /^\s*\+/.test(s);
    var d = s.replace(/\D/g, '');
    if (!d) return { id: null, kind: 'invalid', raw: String(raw == null ? '' : raw) };
    if (d.indexOf('00') === 0) { d = d.slice(2); plus = true; }
    if (/^0201[0125]\d{8}$/.test(d)) d = d.slice(1);                 // +020 1x…
    else if (/^2001[0125]\d{8}$/.test(d)) d = '20' + d.slice(3);     // +20 01x…
    else if (/^01[0125]\d{8}$/.test(d)) d = '20' + d.slice(1);       // 01x…
    else if (!plus && /^1[0125]\d{8}$/.test(d)) d = '20' + d;        // 1x… بلا صفر
    else if (!plus && /^0[2-9]\d{7,8}$/.test(d)) d = '20' + d.slice(1); // أرضي 02…
    if (/^201[0125]\d{8}$/.test(d)) return { id: d, kind: 'eg-mobile', raw: String(raw) };
    if (/^20[2-9]\d{7,8}$/.test(d)) return { id: d, kind: 'eg-landline', raw: String(raw) };
    if (d.length < 7) return { id: null, kind: 'short', raw: String(raw) };
    if (d.length <= 15) {
      for (var i = 0; i < CC_KEYS.length; i++) {
        var cc = CC_KEYS[i];
        if (d.indexOf(cc) === 0) {
          if (cc === '1' && d.length !== 11) break;
          if (d.length - cc.length < 6) break;
          return { id: d, kind: 'intl', country: COUNTRY[cc], raw: String(raw) };
        }
      }
      if (plus && d.length >= 8) return { id: d, kind: 'intl', country: '', raw: String(raw) };
    }
    return { id: null, kind: 'invalid', raw: String(raw) };
  }

  /** عرض مقروء: موبايل مصري «0101 234 5678»، غير ذلك «+…». */
  function displayPhone(id) {
    var d = String(id || '');
    if (/^201[0125]\d{8}$/.test(d)) { var l = '0' + d.slice(2); return l.slice(0, 4) + ' ' + l.slice(4, 7) + ' ' + l.slice(7); }
    if (/^20[2-9]\d{7,8}$/.test(d)) return '0' + d.slice(2);
    return d ? '+' + d : '';
  }

  // ─── قراءة الملفات ───────────────────────────────────────────
  function lines(text) { return String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/); }

  function looksLikePhone(s) {
    var t = asciiDigits(s).trim();
    return /^[+\d\s\-().]{7,}$/.test(t) && t.replace(/\D/g, '').length >= 7;
  }

  /** ملف «Contact Directory» النصي (اسم بلا مسافة بادئة، ثم تفاصيل بمسافة بادئة). */
  function parseContactDirectory(text) {
    var out = [], cur = null, L = lines(text);
    for (var i = 0; i < L.length; i++) {
      var line = L[i];
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) {
        if (line.trim() === 'Contact Directory' && !out.length && !cur) continue;
        cur = { name: line.trim(), phones: [], emails: [], labels: [], notes: '', address: '', noDetails: false };
        if (looksLikePhone(cur.name)) { cur.phones.push(cur.name); cur.name = ''; }
        out.push(cur);
        continue;
      }
      if (!cur) continue;
      var t = line.trim();
      if (t === 'No contact details provided.') { cur.noDetails = true; continue; }
      var m = t.match(/^(Phone|Mobile|Tel|Email|E-mail|Address|Website|Note|Notes|Organization|Company|Title|Birthday)[^:]*:\s*(.*)$/i);
      if (m) {
        var k = m[1].toLowerCase(), v = m[2].trim();
        if (!v) continue;
        if (k === 'phone' || k === 'mobile' || k === 'tel') cur.phones.push(v);
        else if (k === 'email' || k === 'e-mail') cur.emails.push(v);
        else if (k === 'address') { if (v.toLowerCase() !== 'egypt') cur.address = cur.address ? cur.address + ' | ' + v : v; }
        else if (k === 'note' || k === 'notes') cur.notes = cur.notes ? cur.notes + ' | ' + v : v;
        else if (k === 'organization' || k === 'company' || k === 'title') cur.labels.push(v);
        continue;
      }
      cur.labels.push(t);
    }
    return out;
  }

  function qpDecode(s) {
    var bytes = String(s).replace(/=\r?\n/g, '').replace(/%/g, '%25').replace(/=([0-9A-Fa-f]{2})/g, '%$1');
    try { return decodeURIComponent(bytes); } catch (e) { return String(s); }
  }
  function vUnescape(s) { return String(s).replace(/\\n/gi, ' ').replace(/\\([,;:\\])/g, '$1'); }

  /** vCard 2.1/3.0/4.0 — يشمل QUOTED-PRINTABLE وطيّ الأسطر وخصائص itemN. */
  function parseVcf(text) {
    var raw = lines(text), L = [];
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^[ \t]/.test(line) && L.length) { L[L.length - 1] += line.slice(1); continue; }
      // QUOTED-PRINTABLE: سطر ينتهي بـ«=» يكمل في السطر التالي
      while (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/i.test(line.split(':')[0]) && /=$/.test(line) && i + 1 < raw.length) {
        line = line.slice(0, -1) + raw[++i];
      }
      L.push(line);
    }
    var out = [], cur = null;
    for (var j = 0; j < L.length; j++) {
      var ln = L[j];
      if (/^BEGIN:VCARD/i.test(ln)) { cur = { name: '', phones: [], emails: [], labels: [], notes: '', address: '', _n: '' }; continue; }
      if (/^END:VCARD/i.test(ln)) {
        if (cur) { if (!cur.name) cur.name = cur._n; delete cur._n; out.push(cur); }
        cur = null; continue;
      }
      if (!cur) continue;
      var c = ln.indexOf(':');
      if (c < 1) continue;
      var head = ln.slice(0, c), value = ln.slice(c + 1);
      var params = head.split(';');
      var prop = params[0].replace(/^item\d+\./i, '').toUpperCase();
      if (/ENCODING=QUOTED-PRINTABLE|^QUOTED-PRINTABLE$/i.test(params.slice(1).join(';')) ||
          params.slice(1).some(function (p) { return /^QUOTED-PRINTABLE$/i.test(p); })) value = qpDecode(value);
      value = vUnescape(value).trim();
      if (!value) continue;
      if (prop === 'FN') cur.name = value;
      else if (prop === 'N') cur._n = value.split(';').filter(Boolean).reverse().join(' ').trim();
      else if (prop === 'TEL') cur.phones.push(value.replace(/^tel:/i, ''));
      else if (prop === 'EMAIL') cur.emails.push(value);
      else if (prop === 'NOTE') cur.notes = cur.notes ? cur.notes + ' | ' + value : value;
      else if (prop === 'ORG' || prop === 'TITLE') cur.labels.push(value.replace(/;/g, ' ').trim());
      else if (prop === 'CATEGORIES') {
        value.split(',').forEach(function (g) {
          g = g.trim();
          if (g && !/^(mycontacts|starred|my contacts)$/i.test(g)) cur.labels.push(g);
        });
      } else if (prop === 'ADR') {
        var a = value.split(';').filter(Boolean).join(' ').trim();
        if (a && a.toLowerCase() !== 'egypt') cur.address = a;
      }
    }
    return out;
  }

  /** CSV بقواعد RFC 4180 (علامات تنصيص، فواصل وأسطر داخل الحقل). */
  function csvRows(text) {
    var s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    var first = s.split(/\r?\n/, 1)[0] || '';
    var delim = [',', ';', '\t'].map(function (d) { return [d, first.split(d).length]; })
      .sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], field = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
    return rows;
  }

  /** CSV من Google Contacts أو Outlook — يتعرّف على الأعمدة من العناوين. */
  function parseCsv(text) {
    var rows = csvRows(text);
    if (rows.length < 2) return [];
    var h = rows[0].map(function (x) { return String(x).trim(); });
    function idx(re) { var r = []; h.forEach(function (x, i) { if (re.test(x)) r.push(i); }); return r; }
    var nameCols = idx(/^(name|full name|display name|الاسم|الإسم|اسم)$/i);
    var partCols = idx(/^(first name|middle name|last name|given name|additional name|family name|الاسم الأول|اسم العائلة)$/i);
    var phoneCols = idx(/phone|mobile|tel|هاتف|موبايل|جوال|رقم/i).filter(function (i) { return !/type|label|نوع/i.test(h[i]); });
    var noteCols = idx(/^notes?$|ملاحظ/i);
    var labelCols = idx(/labels|group membership|categories|organization.*(name|title)|^company$|^job title$|^title$/i);
    var mailCols = idx(/e-?mail/i).filter(function (i) { return !/type|label/i.test(h[i]); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var get = function (i) { return String(row[i] == null ? '' : row[i]).trim(); };
      var name = nameCols.map(get).filter(Boolean)[0] || partCols.map(get).filter(Boolean).join(' ');
      var phones = [];
      phoneCols.forEach(function (i) { get(i).split(/\s*:::\s*|\n/).forEach(function (p) { if (p.trim()) phones.push(p.trim()); }); });
      var labels = [];
      labelCols.forEach(function (i) {
        get(i).split(/\s*:::\s*/).forEach(function (g) {
          g = g.replace(/^\*\s*/, '').trim();
          if (g && !/^(mycontacts|starred|my contacts)$/i.test(g)) labels.push(g);
        });
      });
      var c = { name: name, phones: phones, emails: mailCols.map(get).filter(Boolean), labels: labels,
        notes: noteCols.map(get).filter(Boolean).join(' | '), address: '' };
      if (c.name || c.phones.length) out.push(c);
    }
    return out;
  }

  /** سجل المكالمات XML (SMS Backup & Restore): <call number date type duration contact_name/>. */
  function parseCallLogXml(text) {
    var out = [], re = /<call\b([^>]*)\/?>/gi, m;
    var s = String(text == null ? '' : text);
    function attr(a, k) {
      var r = new RegExp('\\b' + k + '="([^"]*)"').exec(a);
      return r ? r[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    }
    while ((m = re.exec(s))) {
      var a = m[1];
      var date = Number(attr(a, 'date'));
      if (!attr(a, 'number') || !(date > 0)) continue;
      out.push({ number: attr(a, 'number'), date: date, type: Number(attr(a, 'type')) || 0,
        duration: Number(attr(a, 'duration')) || 0, name: attr(a, 'contact_name') === '(Unknown)' ? '' : attr(a, 'contact_name') });
    }
    return out;
  }

  function detectFormat(text, filename) {
    var f = String(filename || '').toLowerCase(), s = String(text || '').slice(0, 4000);
    if (/<calls\b|<call\b/i.test(s)) return 'calls';
    if (/BEGIN:VCARD/i.test(s) || /\.vcf$/.test(f)) return 'vcf';
    if (/Contact Directory|No contact details provided\./.test(s)) return 'txt';
    if (/\.csv$/.test(f) || /^\uFEFF?[^\n]*(phone|name|e-mail|الاسم)[^\n]*,/i.test(s)) return 'csv';
    return 'txt';
  }

  function parseFile(text, filename) {
    var kind = detectFormat(text, filename);
    if (kind === 'calls') return { kind: kind, calls: parseCallLogXml(text) };
    if (kind === 'vcf') return { kind: kind, contacts: parseVcf(text) };
    if (kind === 'csv') return { kind: kind, contacts: parseCsv(text) };
    return { kind: kind, contacts: parseContactDirectory(text) };
  }

  // ─── التصنيف ─────────────────────────────────────────────────
  var R = {
    broker: W('سمسار|سماسره|السمسار|عقارات|عقاري|العقاري|عقاريه|تسويق عقاري|real estate|realestate|broker|realtor', 'waw'),
    doorman: W('حارس|بواب|بوابه|البواب|الحارس', 'waw'),
    seeker: W('مشتري|مشترين|شراء|للشراء|طلب|طلبات|طالب|طالبه|مطلوب|عايز|عايزه|عاوز|عاوزه|محتاج|محتاجه|يبحث|بيدور|بتدور|مستاجر|مستاجره|ساكن جديد', 'waw'),
    owner: W('للبيع|للايجار|بيع|البيع|عرض|مالك|مالكه|المالك|ملاك|اونر|owner|عنده|عندها|عندهم|مفروش|مفروشه|بالفرش', 'waw'),
    ownerOf: /(?:^| )صاحب(?:ه)? (?:ال)?(?:شقه|محل|مكتب|ارض|عماره|مفروش|استوديو|فيلا|عقار|مخزن|بيت|وحده|برج|الشقه)(?= )/,
    trades: S('مقاول|تشطيب|نقاش|دهان|سباك|كهربا|نجار|الوميتال|المونيوم|سيراميك|رخام|جبس|تكييف|ستائر|نقل اثاث|ونش|حداد|زجاج|اسانسير|مصعد|صيانه'),
    legal: S('محامي|محاماه|شهر عقاري|توثيق|موثق'),
    finance: W('بنك|البنك|تمويل|التمويل', 'waw'),
    rent: W('ايجار|الايجار|للايجار|بالايجار|ايجارات|مستاجر|مستاجره|مؤجر|موجر|مفروش|مفروشه|قانون جديد', 'waw'),
    sale: W('بيع|للبيع|البيع|شراء|للشراء|مشتري|مشترين|تمليك|التمليك', 'waw'),
    furnished: W('مفروش|مفروشه|فرش'),
  };

  var TYPES = [
    ['apartment', W('شقه|شقق|شقتين|روف|استوديو|بنتهاوس|سكني')],
    ['villa', W('فيلا|فيلات|فلل|دوبلكس')],
    ['shop', W('محل|محلات|معرض|تجاري|سنتر')],
    ['office', W('مكتب|مكاتب|اداري|اداريه|مقر')],
    ['clinic', W('عياده|عيادات|طبي')],
    ['warehouse', W('مخزن|مخازن|جراج|مصنع|ورشه')],
    ['land', W('ارض|اراضي')],
  ];
  var TYPE_AR = { apartment: 'شقة', villa: 'فيلا/دوبلكس', shop: 'محل', office: 'مكتب/إداري', clinic: 'عيادة', warehouse: 'مخزن', land: 'أرض' };

  // [الاسم المعروض، نمط على النص المُبطَّن، داخل مدينة نصر؟]
  var ZONES = [
    ['عباس العقاد', / عباس العقاد | العقاد /, true],
    ['مكرم عبيد', / مكرم /, true],
    ['مصطفى النحاس', / (?:مصطفي )?النحاس /, true],
    ['حسن المأمون', / حسن المامون | المامون /, true],
    ['حسنين هيكل', / هيكل /, true],
    ['الطيران', / (?:شارع )?الطيران /, true],
    ['النزهة', / النزهه /, true],
    ['يوسف عباس', / يوسف عباس /, true],
    ['ذاكر حسين', / ذاكر /, true],
    ['أحمد فخري', / فخري /, true],
    ['حلمي عبد العاطي', / عبد العاطي /, true],
    ['كابول', / كابول /, true],
    ['حي السفارات', / السفارات /, true],
    ['رابعة العدوية', / رابعه /, true],
    ['زهراء مدينة نصر', / زهراء /, true],
    ['الواحة', / الواحه /, true],
    ['السراج مول', / السراج /, true],
    ['سيتي ستارز', / سيتي ستارز | ستي ستارز /, true],
    ['النادي الأهلي', / النادي الاهلي | امتداد الاهلي /, true],
    ['الحديقة الدولية', / الحديقه الدوليه /, true],
    ['جرين هيلز', / جرين هيلز | green hills /, true],
    ['رابعة الاستثماري', / الاستثماري | الاستثمار /, true],
    ['المنطقة السادسة', / المنطقه (?:السادسه|6) | (?:حسن )?الجمل /, true],
    ['مدينة نصر', / مدينه نصر | م نصر | nasr city /, true],
    ['مصر الجديدة', / مصر الجديده | هليوبوليس | الكوربه | الميرغني | روكسي | الماظه | شيراتون /, false],
    ['التجمع', / التجمع | القاهره الجديده | النرجس | اللوتس | الياسمين | بيت الوطن /, false],
    ['الرحاب', / الرحاب /, false],
    ['مدينتي', / مدينتي /, false],
    ['الشروق', / الشروق /, false],
    ['العبور', / العبور /, false],
    ['العاصمة الإدارية', / العاصمه /, false],
    ['6 أكتوبر', / اكتوبر /, false],
    ['الشيخ زايد', / زايد /, false],
    ['المقطم', / المقطم /, false],
    ['المعادي', / المعادي /, false],
  ];
  var ORD = { 'الاول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4, 'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9, 'العاشر': 10 };
  var ORD_F = { 'الاولي': 1, 'الثانيه': 2, 'الثالثه': 3, 'الرابعه': 4, 'الخامسه': 5, 'السادسه': 6, 'السابعه': 7, 'الثامنه': 8, 'التاسعه': 9, 'العاشره': 10 };
  var DIST_AR = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
  var ZONE_AR = ['', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة'];
  var NASR_ZONES = {};
  ZONES.forEach(function (z) { NASR_ZONES[z[0]] = z[2]; });
  for (var zi = 1; zi <= 10; zi++) { NASR_ZONES['الحي ' + DIST_AR[zi]] = true; NASR_ZONES['المنطقة ' + ZONE_AR[zi]] = true; }

  function findZones(p) {
    var out = [];
    var m, re = / (?:ال)?حي (الاول|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع|العاشر|\d{1,2})(?= )/g;
    while ((m = re.exec(p))) { var n = ORD[m[1]] || +m[1]; if (n >= 1 && n <= 10) out.push('الحي ' + DIST_AR[n]); }
    re = / (?:ال)?منطقه (الاولي|الثانيه|الثالثه|الرابعه|الخامسه|السادسه|السابعه|الثامنه|التاسعه|العاشره|\d{1,2})(?= )/g;
    while ((m = re.exec(p))) { var k = ORD_F[m[1]] || +m[1]; if (k >= 1 && k <= 10) out.push('المنطقة ' + ZONE_AR[k]); }
    // «السابع/الثامن/…» وحدها = الحي (عرف أهل مدينة نصر) — إلا بعد «الدور».
    var tokens = p.trim().split(' ');
    for (var ti = 0; ti < tokens.length; ti++) {
      var o = ORD[tokens[ti]];
      if (o >= 6 && !/^(?:ال)?(?:دور|حي)$/.test(tokens[ti - 1] || '')) {
        var dz = 'الحي ' + DIST_AR[o];
        if (out.indexOf(dz) === -1) out.push(dz);
      }
    }
    ZONES.forEach(function (z) { if (z[1].test(p) && out.indexOf(z[0]) === -1) out.push(z[0]); });
    // «مدينة نصر» عامة: لا تُذكر لو فيه منطقة أدق داخلها
    if (out.length > 1 && out.indexOf('مدينة نصر') !== -1) out.splice(out.indexOf('مدينة نصر'), 1);
    return out.filter(function (z, i) { return out.indexOf(z) === i; });
  }
  function isNasrZone(z) { return NASR_ZONES[z] === true; }

  function parseMoney(n) {
    var m = n.match(/(\d+(?:[.,]\d+)?)\s?(مليون|ملايين|الف|الاف|ك)(?:\s?و\s?(نص|ربع))?(?![\u0621-\u064A])/);
    if (!m) return null;
    var v = parseFloat(m[1].replace(',', '.'));
    var unit = /مليون|ملايين/.test(m[2]) ? 1e6 : 1e3;
    if (m[3]) v += m[3] === 'نص' ? 0.5 : 0.25;
    var out = Math.round(v * unit);
    return out > 0 ? out : null;
  }

  function parseSize(n) {
    var k = n.match(/(\d{1,2})\s?الف\s?متر/);
    if (k) return +k[1] * 1000;
    var m = n.match(/(?:^|[^\d.,])(\d{2,4})\s?(?:م2|م²|متر|مترا|م)(?![\u0621-\u064A\d])/);
    if (!m) return null;
    var v = +m[1];
    return v >= 15 && v <= 9999 ? v : null;
  }

  /**
   * يصنّف جهة من اسمها وتسمياتها وملاحظاتها.
   * role: owner | seeker | broker | doorman | trade | legal | finance | unit | other
   *   (unit = فيه نوع وحدة/منطقة/مساحة بلا دور واضح)
   */
  function classify() {
    var text = Array.prototype.slice.call(arguments).map(function (x) { return Array.isArray(x) ? x.join(' | ') : (x || ''); }).join(' | ');
    var p = pad(text), n = norm(text);
    var types = [];
    TYPES.forEach(function (t) { if (t[1].test(p)) types.push(t[0]); });
    var zones = findZones(p);
    var size = parseSize(n);
    var price = parseMoney(n.replace(/(\d{1,2})\s?الف\s?متر/g, ' '));
    var isSeeker = R.seeker.test(p), isOwner = R.owner.test(p) || R.ownerOf.test(p);
    var role = 'other';
    if (R.broker.test(p)) role = 'broker';
    else if (R.doorman.test(p)) role = 'doorman';
    else if (isSeeker) role = 'seeker';
    else if (isOwner) role = 'owner';
    else if (R.trades.test(n)) role = 'trade';
    else if (R.legal.test(n)) role = 'legal';
    else if (R.finance.test(p)) role = 'finance';
    else if (types.length || zones.length || size) role = 'unit';
    var rent = R.rent.test(p), sale = R.sale.test(p);
    var deal = rent && !sale ? 'rent' : sale && !rent ? 'sale' : '';
    if (!deal && price) deal = price >= 200000 ? 'sale' : 'rent';
    return { role: role, deal: deal, types: types, zones: zones, size: size, price: price, furnished: R.furnished.test(p) };
  }

  // ─── الاسم في التحية ─────────────────────────────────────────
  var STOP = {};
  ('مالك مالكه المالك صاحب صاحبه ملاك مشتري شراء للشراء طلب مطلوب عايز عايزه عاوز عاوزه محتاج محتاجه طالب طالبه مستاجر ' +
   'مستاجره ايجار للايجار الايجار بيع للبيع عرض سمسار عقارات عقاري حارس بواب شقه شقق شقتين محل محلات مكتب اداري اداريه ' +
   'مقر فيلا دوبلكس روف استوديو ارض مخزن عياده مفروش مفروشه تبع في عند عن من علي جديد جديده قديم vip مكرم النحاس التجمع ' +
   'الحي حي المنطقه منطقه زهراء السفارات رابعه الطيران النزهه ذاكر فخري مدينه العقاد الشروق الرحاب مدينتي اكتوبر زايد ' +
   'نقاش سباك نجار مقاول كهربائي زجاج تمليك مشاركه شركه للتسويق تسويق الاستثمار الاستثماري ابراج عماره ' +
   'عنده عندها عندهم اونر owner بنك البنك اول ثاني دور الدور ارضي المنيل المعادي الزمالك الدقي المهندسين شبرا ' +
   'حلوان المقطم العباسيه الجمل التسعين ايجارات بيت وحده').split(' ')
    .forEach(function (w) { STOP[w] = true; });

  function greetingName(name) {
    var cleaned = String(name || '')
      .replace(/[\p{Extended_Pictographic}\u2600-\u27BF\uFE0F\u200D\u{1F1E6}-\u{1F1FF}]/gu, ' ')
      .replace(/[#*+_=~^|<>{}[\]()"“”«»%¥$@!?؟]/g, ' ');
    var toks = cleaned.split(/[\s,،؛:;/\\.\-]+/).filter(Boolean), out = [];
    for (var i = 0; i < toks.length && out.length < 3; i++) {
      var t = norm(toks[i]);
      if (!t) continue;
      if (/\d/.test(t) || STOP[t]) break;
      out.push(toks[i]);
    }
    // لقب وحده («أبو»، «أم»، حرف واحد) مش اسم يتنادى بيه
    if (out.length === 1 && (/^(ابو|ام|ابن|بنت|ا|د|م|حاج|الحاج|استاذ|الاستاذ|اللواء|العميد)$/.test(norm(out[0])) || norm(out[0]).length < 2)) out = [];
    var g = out.join(' ').trim();
    return g.length > 28 ? g.slice(0, 28).trim() : g;
  }

  // ─── عرض ونصوص ──────────────────────────────────────────────
  function fmtMoney(v) {
    if (!(v > 0)) return '';
    if (v >= 1e6) return String(Math.round(v / 1e5) / 10).replace(/\.0$/, '') + ' مليون';
    if (v >= 1e3) return String(Math.round(v / 100) / 10).replace(/\.0$/, '') + ' ألف';
    return v + ' جنيه';
  }

  var ROLE_AR = { owner: 'مالك/عرض', seeker: 'طالب (مشتري/مستأجر)', broker: 'سمسار/شركة', doorman: 'حارس/بواب',
    trade: 'صنايعي/مقاول', legal: 'قانوني', finance: 'بنك/تمويل', unit: 'وحدة بلا دور واضح', other: 'غير مصنّف' };

  function describe(c) {
    var parts = [];
    var t = (c.types || [])[0];
    if (t) parts.push(TYPE_AR[t]);
    if (c.furnished) parts.push('مفروش');
    if (c.size) parts.push(c.size + 'م');
    if (c.zones && c.zones.length) parts.push('في ' + c.zones[0]);
    if (c.deal) parts.push(c.deal === 'rent' ? 'للإيجار' : c.role === 'seeker' ? 'للشراء' : 'للبيع');
    if (c.price) parts.push((c.role === 'seeker' ? 'بميزانية ' : 'بسعر ') + fmtMoney(c.price));
    return parts.join(' ');
  }

  var SIGN = 'معاك طارق طنطاوي من «سمسار طلبك».';
  function hello(c) { var g = greetingName(c.name); return 'أهلًا' + (g ? ' ' + g : '') + '، ' + SIGN; }

  /** نص متابعة (خدمة، مش إعلان) — يُفتح في واتساب ويرسله المستخدم بنفسه. */
  function messageFor(c) {
    var d = describe(c);
    switch (c.role) {
      case 'owner':
        return hello(c) + ' بحدّث بيانات الوحدات اللي معايا: ' + (d || 'الوحدة اللي كلمتني عنها') +
          ' — لسه متاحة؟ ولو فيه أي تغيير في السعر أو الحالة قولّي.';
      case 'seeker':
        return hello(c) + ' كنت بتدوّر على ' + (d || 'عقار') + ' — لسه بتدوّر؟ لو آه ابعتلي المنطقة والميزانية المناسبة دلوقتي.' +
          ' وتحب أبعتلك المتاح المناسب أول بأول هنا على واتساب؟';
      case 'doorman':
        return hello(c) + ' عندكم شقق أو محلات فاضية للبيع أو الإيجار دلوقتي؟';
      case 'broker':
        return hello(c) + ' لو عندك وحدات أو طلبات في مدينة نصر نتعاون فيها ابعتلي، وأنا كمان أبعتلك اللي عندي.';
      case 'unit':
        return hello(c) + ' بحدّث بياناتي عن ' + (d || 'العقار اللي اتكلمنا عنه') + ' — لسه الموضوع قائم؟ ولو فيه جديد قولّي.';
      default:
        return '';
    }
  }

  function offerMessage(c, row, origin) {
    return hello(c) + ' عندي ' + row.t + (row.p ? ' بسعر ' + row.p : '') + ' — شايفها مناسبة لطلبك.' +
      ' التفاصيل والصور: ' + String(origin || 'https://nasr-realestate.github.io') + row.u;
  }

  function waLink(id, text) { return id ? 'https://wa.me/' + id + (text ? '?text=' + encodeURIComponent(text) : '') : ''; }
  function telLink(id) { return id ? 'tel:+' + id : ''; }

  // ─── قاعدة البيانات والدمج ──────────────────────────────────
  function emptyDb() {
    return { v: VERSION, seq: 0, contacts: {}, meta: { createdAt: Date.now(), updatedAt: 0, lastBackupAt: 0, imports: [] } };
  }

  var AUTO_FIELDS = ['role', 'deal', 'types', 'zones', 'size', 'price', 'furnished'];

  /** يعيد التصنيف الآلي على الحقول اللي المستخدم ما عدّلهاش بإيده (c.manual). */
  function autoOf(c) { return classify(c.name, c.labels, c.notes, c.address); }
  function applyAuto(c) {
    var a = autoOf(c);
    c.manual = c.manual || {};
    AUTO_FIELDS.forEach(function (f) { if (!c.manual[f]) c[f] = Array.isArray(a[f]) ? a[f].slice() : a[f]; });
    return c;
  }

  function uniq(list) { return list.filter(function (x, i) { return x && list.indexOf(x) === i; }); }

  function indexes(db) {
    var byPhone = {}, byName = {};
    Object.keys(db.contacts).forEach(function (id) {
      var c = db.contacts[id];
      (c.phones || []).forEach(function (p) { byPhone[p] = id; });
      var k = norm(c.name);
      if (k) (byName[k] = byName[k] || []).push(id);
    });
    return { byPhone: byPhone, byName: byName };
  }

  function pushHistory(c, at, action, note) {
    c.history = c.history || [];
    c.history.push(note ? { at: at, action: action, note: String(note).slice(0, 200) } : { at: at, action: action });
    if (c.history.length > 40) c.history = c.history.slice(-40);
  }

  /**
   * يدمج جهات مستوردة بدون ضياع الحالة أو التاريخ أو التعديلات اليدوية.
   * المطابقة: بأي رقم مشترك، وإلا (للجهة اللي في الأرشيف بلا رقم) بالاسم المطبَّع بالضبط.
   */
  function mergeImport(db, items, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), src = opts.source || 'import';
    var ix = indexes(db);
    var st = { total: items.length, added: 0, updated: 0, unchanged: 0, noPhone: 0, badPhones: 0, phonesAdded: 0 };
    items.forEach(function (it) {
      var phones = [], bad = [];
      (it.phones || []).forEach(function (raw) {
        var ph = normalizePhone(raw);
        if (ph.id) phones.push(ph.id); else if (ph.kind !== 'short') bad.push(String(raw).trim());
      });
      phones = uniq(phones);
      st.badPhones += bad.length;
      var name = String(it.name || '').trim();
      var id = null;
      for (var i = 0; i < phones.length && !id; i++) id = ix.byPhone[phones[i]] || null;
      var nk = norm(name);
      if (!id && nk.length >= 6 && nk.indexOf(' ') !== -1) {
        var same = (ix.byName[nk] || []).filter(function (x) {
          var e = db.contacts[x];
          return !phones.length || !(e.phones || []).length;
        });
        if (same.length === 1) id = same[0];
      }
      if (!phones.length) st.noPhone++;
      if (!id) {
        if (!name && !phones.length) return;
        id = 'c' + (++db.seq);
        var c = { id: id, name: name || displayPhone(phones[0]), phones: phones, badPhones: bad, emails: uniq(it.emails || []),
          labels: uniq(it.labels || []), notes: it.notes || '', address: it.address || '', status: 'new', source: src,
          consent: '', createdAt: now, updatedAt: now, confirmedAt: 0, nextAt: 0, attempts: 0, listing: '',
          lastCallAt: 0, calls: 0, manual: {}, history: [] };
        applyAuto(c);
        pushHistory(c, now, 'import', opts.file || src);
        db.contacts[id] = c;
        phones.forEach(function (p) { ix.byPhone[p] = id; });
        if (name) (ix.byName[norm(name)] = ix.byName[norm(name)] || []).push(id);
        st.added++;
        return;
      }
      var e = db.contacts[id], before = JSON.stringify([e.name, e.phones, e.labels, e.notes, e.emails]);
      var newPhones = phones.filter(function (p) { return (e.phones || []).indexOf(p) === -1; });
      e.phones = uniq((e.phones || []).concat(phones));
      st.phonesAdded += newPhones.length;
      newPhones.forEach(function (p) { ix.byPhone[p] = id; });
      // نفس الرقم باسمين (متسجل مرتين أو اتغيّر اسمه): الاسم الأوصف يفضل للعرض، والتاني
      // يتحفظ كتسمية — عشان ولا وصف («مالك شقة…»، «عايز…») يضيع من التصنيف.
      var aliases = [];
      if (name && name !== e.name) {
        var keep = e.manual.name || norm(e.name).length >= norm(name).length ? e.name : name;
        aliases.push(keep === e.name ? name : e.name);
        e.name = keep;
      }
      e.labels = uniq((e.labels || []).concat(it.labels || [], aliases).filter(function (l) { return l !== e.name; }));
      e.emails = uniq((e.emails || []).concat(it.emails || []));
      if (it.notes && String(e.notes || '').indexOf(it.notes) === -1) e.notes = e.notes ? e.notes + ' | ' + it.notes : it.notes;
      if (it.address && !e.address) e.address = it.address;
      e.badPhones = uniq((e.badPhones || []).concat(bad));
      if (JSON.stringify([e.name, e.phones, e.labels, e.notes, e.emails]) === before) { st.unchanged++; return; }
      applyAuto(e);
      e.updatedAt = now;
      st.updated++;
    });
    db.meta.imports.push({ at: now, file: String(opts.file || '').slice(0, 80), kind: opts.kind || '', added: st.added, updated: st.updated });
    if (db.meta.imports.length > 30) db.meta.imports = db.meta.imports.slice(-30);
    db.meta.updatedAt = now;
    return st;
  }

  /** سجل المكالمات: آخر مكالمة لكل جهة + أرقام اتكلمت معاها كتير ومش متسجلة. */
  function applyCallLog(db, calls, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), minCalls = opts.minCalls || 2;
    var agg = {};
    calls.forEach(function (k) {
      var ph = normalizePhone(k.number);
      if (!ph.id) return;
      var a = agg[ph.id] || (agg[ph.id] = { phone: ph.id, count: 0, last: 0, type: 0, name: '', talked: 0 });
      a.count++;
      if (k.duration > 0) a.talked++;
      if (k.date > a.last) { a.last = k.date; a.type = k.type; if (k.name) a.name = k.name; }
    });
    var ix = indexes(db), matched = 0, unsaved = [];
    Object.keys(agg).forEach(function (p) {
      var a = agg[p], id = ix.byPhone[p];
      if (id) {
        var c = db.contacts[id];
        if (a.last > (c.lastCallAt || 0)) { c.lastCallAt = a.last; c.lastCallType = a.type; }
        c.calls = Math.max(c.calls || 0, a.count);
        matched++;
      } else if (a.count >= minCalls) unsaved.push(a);
    });
    unsaved.sort(function (x, y) { return y.last - x.last; });
    db.meta.updatedAt = now;
    return { numbers: Object.keys(agg).length, matched: matched, unsaved: unsaved };
  }

  // ─── المطابقة مع إعلانات الموقع ──────────────────────────────
  function rowPad(row) { return row._pad || (row._pad = pad([row.t, row.l].join(' '))); }
  function zoneTest(zone, hay) {
    var z = ZONES.filter(function (x) { return x[0] === zone; })[0];
    if (z) return z[1].test(hay);
    return hay.indexOf(pad(zone)) !== -1 || hay.indexOf(' ' + norm(zone) + ' ') !== -1;
  }

  /**
   * درجة توافق جهة (طالب) مع إعلان — 0 يعني لا يناسب. شروط صارمة: المعاملة والنوع والمنطقة
   * والميزانية لو معروفة، ولازم إشارة محددة واحدة على الأقل (منطقة/مفروش/ميزانية/مساحة):
   * «شقة للشراء» وحدها عامة جدًا ومش هتطلع لها مطابقة.
   */
  function scoreListing(c, row) {
    if (!row || row.in_nasr_city === false) return 0;
    var hay = rowPad(row), s = 0, specific = false;
    if (c.deal) { if (row.d !== c.deal) return 0; s += 1; }
    var types = c.types || [];
    if (types.length) {
      var ok = types.indexOf(row.y) !== -1 || (types.indexOf('clinic') !== -1 && / عياده /.test(hay));
      if (!ok) return 0;
      s += 2;
    }
    var zones = c.zones || [], nz = zones.filter(isNasrZone).filter(function (z) { return z !== 'مدينة نصر'; });
    if (zones.length && !zones.filter(isNasrZone).length) return 0;
    if (nz.length) { if (!nz.some(function (z) { return zoneTest(z, hay); })) return 0; s += 3; specific = true; }
    if (c.furnished) { if (!/مفروش/.test(hay)) return 0; s += 2; specific = true; }
    if (c.price && row.pn > 0) {
      if (c.price >= 200000 && row.d === 'rent') return 0;
      if (c.price < 200000 && row.d === 'sale') return 0;
      if (row.pn > c.price * 1.15) return 0;
      if (row.pn >= c.price * 0.5) { s += 2; specific = true; }
    }
    if (c.size && row.an > 0 && Math.abs(row.an - c.size) <= c.size * 0.25) { s += 1; specific = true; }
    if (!specific || !(types.length || nz.length || c.furnished)) return 0;
    return s >= 3 ? s : 0;
  }

  function matchListings(c, rows, limit) {
    if (!rows || !rows.length || c.role !== 'seeker') return [];
    return rows.map(function (r) { return { row: r, score: scoreListing(c, r) }; })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score || (a.row.o || 0) - (b.row.o || 0); })
      .slice(0, limit || 3);
  }

  var CLOSED = { closed: 1, stop: 1, personal: 1, wrong: 1 };

  function matchSeekers(row, contacts, limit) {
    var rank = { active: 0, followup: 1, new: 2 };
    return contacts.filter(function (c) { return c.role === 'seeker' && !CLOSED[c.status] && (c.phones || []).length; })
      .map(function (c) { return { c: c, score: scoreListing(c, row) }; })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) {
        var ca = a.c.consent === 'yes' ? 0 : 1, cb = b.c.consent === 'yes' ? 0 : 1;
        return ca - cb || (rank[a.c.status] || 3) - (rank[b.c.status] || 3) || b.score - a.score || (b.c.lastCallAt || 0) - (a.c.lastCallAt || 0);
      })
      .slice(0, limit || 50);
  }

  // ─── طابور التأكيد ───────────────────────────────────────────
  var GROUPS = [
    ['listing', 'أصحاب إعلانات الموقع'],
    ['owner', 'ملاك ووحدات'],
    ['seeker-match', 'طالبين يناسبهم إعلان عندك'],
    ['seeker', 'طالبين'],
    ['doorman', 'حراس وبوابين'],
    ['broker', 'سماسرة وشركات'],
    ['unit', 'وحدة أو منطقة بلا دور واضح'],
  ];
  var GROUP_AR = {};
  GROUPS.forEach(function (g) { GROUP_AR[g[0]] = g[1]; });

  function groupOf(c, matchCount) {
    if (c.role === 'owner' && c.listing) return 'listing';
    if (c.role === 'owner') return 'owner';
    if (c.role === 'seeker') return matchCount > 0 ? 'seeker-match' : 'seeker';
    if (c.role === 'doorman' || c.role === 'broker' || c.role === 'unit') return c.role;
    return '';
  }

  function richness(c) {
    return (c.size ? 1 : 0) + (c.price ? 1 : 0) + ((c.zones || []).length ? 1 : 0) + ((c.types || []).length ? 1 : 0) + (c.deal ? 1 : 0);
  }

  /**
   * الجهات المستحقة للتأكيد اليوم بالترتيب. يستبعد: بلا رقم، المغلق/الشخصي/الغلط/«مش عايز تواصل»،
   * المتابعة المؤجلة لموعد لم يأتِ، ومن اتأكد خلال recheckDays.
   */
  function buildQueue(contacts, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), recheck = (opts.recheckDays || 30) * DAY, counts = opts.matchCounts || {};
    var order = {};
    GROUPS.forEach(function (g, i) { order[g[0]] = i; });
    return contacts.filter(function (c) {
      if (!(c.phones || []).length || CLOSED[c.status]) return false;
      if (c.status === 'followup' && c.nextAt > now) return false;
      if (c.status === 'active' && c.confirmedAt && now - c.confirmedAt < recheck) return false;
      return groupOf(c, counts[c.id] || 0) !== '';
    }).map(function (c) { return { c: c, group: groupOf(c, counts[c.id] || 0) }; })
      .sort(function (a, b) {
        return order[a.group] - order[b.group] ||
          (a.c.status === 'followup' ? 0 : 1) - (b.c.status === 'followup' ? 0 : 1) ||
          (b.c.lastCallAt || 0) - (a.c.lastCallAt || 0) ||
          richness(b.c) - richness(a.c) ||
          String(a.c.name).localeCompare(String(b.c.name), 'ar');
      });
  }

  // ─── نتائج المكالمة ─────────────────────────────────────────
  var OUTCOMES = {
    active: { label: 'لسه متاح / لسه بيدوّر', status: 'active' },
    noanswer: { label: 'مردّش', status: 'followup', days: 3 },
    later: { label: 'كلّمه بعدين', status: 'followup', days: 14 },
    closed: { label: 'خلص (اتباع/اتأجر/لقى)', status: 'closed' },
    wrong: { label: 'رقم غلط', status: 'wrong' },
    personal: { label: 'مش شغل (شخصي)', status: 'personal' },
    stop: { label: 'مش عايز تواصل', status: 'stop' },
  };

  function recordOutcome(c, key, now, note) {
    var o = OUTCOMES[key];
    if (!o) throw new Error('outcome: ' + key);
    now = now || Date.now();
    c.status = o.status;
    if (key === 'noanswer') {
      c.attempts = (c.attempts || 0) + 1;
      c.nextAt = now + (c.attempts >= 3 ? 14 : o.days) * DAY;
    } else if (o.days) { c.nextAt = now + o.days * DAY; }
    else c.nextAt = 0;
    if (key === 'active' || key === 'closed') { c.confirmedAt = now; c.attempts = 0; }
    if (key === 'stop') c.consent = 'no';
    c.updatedAt = now;
    pushHistory(c, now, key, note);
    return c;
  }

  function setConsent(c, value, now) {
    now = now || Date.now();
    c.consent = value === 'yes' ? 'yes' : value === 'no' ? 'no' : '';
    c.consentAt = now;
    c.updatedAt = now;
    pushHistory(c, now, 'consent-' + (c.consent || 'reset'));
    return c;
  }

  /** نص قصير لصاحب الموقع: نتيجة تأكيد كل إعلان مربوط بمالكه. */
  function listingReport(rows, contacts, now) {
    now = now || Date.now();
    var byListing = {};
    contacts.forEach(function (c) { if (c.listing) (byListing[c.listing] = byListing[c.listing] || []).push(c); });
    var ok = [], gone = [], waiting = 0, unlinked = 0;
    rows.forEach(function (r) {
      var owners = byListing[r.u] || [];
      if (!owners.length) { unlinked++; return; }
      var best = owners.slice().sort(function (a, b) { return (b.confirmedAt || 0) - (a.confirmedAt || 0); })[0];
      var day = best.confirmedAt ? new Date(best.confirmedAt).toISOString().slice(0, 10) : '';
      if (best.status === 'active' && best.confirmedAt) ok.push('✅ متاح: ' + r.t + ' (' + day + ') ' + r.u);
      else if (best.status === 'closed') gone.push('❌ اتباع/اتأجر: ' + r.t + ' (' + day + ') ' + r.u);
      else waiting++;
    });
    return ['تقرير تأكيد إعلانات «سمسار طلبك» — ' + new Date(now).toISOString().slice(0, 10)]
      .concat(ok, gone, ['— لسه مستني رد المالك: ' + waiting, '— إعلانات مش مربوطة بمالك في الدفتر: ' + unlinked]).join('\n');
  }

  // ─── إضافة سريعة من رسالة ───────────────────────────────────
  /** يلقط الأرقام من نص حر بأي تجميع (4-3-4 أو 3-4-4 أو +20 أو متلزقة) حتى لو جنبها سعر. */
  function findPhones(text) {
    var s = asciiDigits(text || ''), out = [], runs = s.match(/\+?\d[\d\s\-().]{6,}\d/g) || [];
    runs.forEach(function (run) {
      var whole = normalizePhone(run);
      if (whole.id && (whole.kind !== 'intl' || /^\s*\+/.test(run))) { if (out.indexOf(whole.id) === -1) out.push(whole.id); return; }
      var toks = run.split(/[\s\-().]+/).filter(Boolean);
      for (var i = 0; i < toks.length; i++) {
        var acc = '';
        for (var j = i; j < toks.length; j++) {
          acc += toks[j];
          var digitsOnly = acc.replace(/\D/g, '');
          if (digitsOnly.length > 13) break;
          if (digitsOnly.length >= 10) {
            var ph = normalizePhone(acc);
            if (ph.id && ph.kind !== 'intl') { if (out.indexOf(ph.id) === -1) out.push(ph.id); i = j; break; }
          }
        }
      }
    });
    return out;
  }

  function parseQuick(text) {
    var s = asciiDigits(text || ''), phones = findPhones(s);
    var rest = s.replace(/\+?\d[\d\s\-().]{8,}\d/g, function (run) { return findPhones(run).length ? ' ' : run; });
    var a = classify(rest);
    return { phones: phones, role: a.role === 'unit' || a.role === 'other' ? '' : a.role, deal: a.deal, types: a.types,
      zones: a.zones, size: a.size, price: a.price, furnished: a.furnished };
  }

  // ─── نسخ احتياطي وتصدير ─────────────────────────────────────
  function backup(db, now) {
    return JSON.stringify({ app: 'simsar-crm', v: VERSION, exportedAt: now || Date.now(), db: db });
  }

  function restore(json) {
    var o = typeof json === 'string' ? JSON.parse(json) : json;
    var db = o && o.app === 'simsar-crm' ? o.db : o;
    if (!db || typeof db !== 'object' || typeof db.contacts !== 'object' || db.contacts === null) throw new Error('ملف غير صالح');
    db.v = db.v || VERSION;
    db.seq = db.seq || Object.keys(db.contacts).length;
    db.meta = db.meta || {};
    db.meta.imports = db.meta.imports || [];
    Object.keys(db.contacts).forEach(function (id) {
      var c = db.contacts[id];
      c.id = id; c.phones = c.phones || []; c.labels = c.labels || []; c.history = c.history || [];
      c.manual = c.manual || {}; c.types = c.types || []; c.zones = c.zones || []; c.status = c.status || 'new';
    });
    return db;
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // حماية من حقن الصيغ في Excel/Sheets
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var STATUS_AR = { new: 'جديد (مش متأكد)', active: 'اتأكد', followup: 'متابعة', closed: 'خلص', wrong: 'رقم غلط',
    personal: 'شخصي', stop: 'مش عايز تواصل' };

  function toCsv(contacts) {
    var day = function (t) { return t ? new Date(t).toISOString().slice(0, 10) : ''; };
    var head = ['الاسم', 'الأرقام', 'الدور', 'المعاملة', 'النوع', 'المنطقة', 'المساحة', 'السعر/الميزانية', 'مفروش',
      'الحالة', 'آخر تأكيد', 'المتابعة القادمة', 'موافقة العروض', 'آخر مكالمة', 'الإعلان المرتبط', 'المصدر', 'ملاحظات'];
    var rows = contacts.map(function (c) {
      return [c.name, (c.phones || []).map(displayPhone).join(' / '), ROLE_AR[c.role] || '', c.deal === 'rent' ? 'إيجار' : c.deal === 'sale' ? 'بيع' : '',
        (c.types || []).map(function (t) { return TYPE_AR[t]; }).join('، '), (c.zones || []).join('، '), c.size || '', c.price || '',
        c.furnished ? 'نعم' : '', STATUS_AR[c.status] || c.status, day(c.confirmedAt), day(c.nextAt),
        c.consent === 'yes' ? 'وافق' : c.consent === 'no' ? 'رفض' : '', day(c.lastCallAt), c.listing || '', c.source || '',
        [c.notes, (c.labels || []).join(' | ')].filter(Boolean).join(' | ')];
    });
    return '\uFEFF' + [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  root.SimsarCRM = {
    VERSION: VERSION, DAY: DAY, norm: norm, pad: pad, asciiDigits: asciiDigits,
    normalizePhone: normalizePhone, displayPhone: displayPhone,
    parseContactDirectory: parseContactDirectory, parseVcf: parseVcf, parseCsv: parseCsv, csvRows: csvRows,
    parseCallLogXml: parseCallLogXml, detectFormat: detectFormat, parseFile: parseFile,
    classify: classify, greetingName: greetingName, describe: describe, fmtMoney: fmtMoney,
    messageFor: messageFor, offerMessage: offerMessage, waLink: waLink, telLink: telLink,
    emptyDb: emptyDb, applyAuto: applyAuto, autoOf: autoOf, mergeImport: mergeImport, applyCallLog: applyCallLog,
    scoreListing: scoreListing, matchListings: matchListings, matchSeekers: matchSeekers, isNasrZone: isNasrZone,
    buildQueue: buildQueue, recordOutcome: recordOutcome, setConsent: setConsent, listingReport: listingReport,
    parseQuick: parseQuick, findPhones: findPhones, backup: backup, restore: restore, toCsv: toCsv,
    OUTCOMES: OUTCOMES, GROUPS: GROUPS, GROUP_AR: GROUP_AR, ROLE_AR: ROLE_AR, TYPE_AR: TYPE_AR, STATUS_AR: STATUS_AR,
    ZONE_NAMES: ZONES.map(function (z) { return z[0]; }), AUTO_FIELDS: AUTO_FIELDS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
