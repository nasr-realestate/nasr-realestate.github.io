/*!
 * agent-request-core.js — deterministic request drafts for /agent.html (2026-10-26)
 * ───────────────────────────────────────────────────────────────
 * Pure functions on top of NasrSearch (catalog-search-core.js): no network, no storage,
 * no identity fields and no side effects. Every call returns a NEW draft; the caller owns
 * it in page memory only, so two conversations can never share slots.
 *
 *  • Two journeys: role "search" (buyer/tenant) and role "owner" (seller/landlord).
 *  • Slots: deal, types, area, price, rooms, furnished, location — each message patches only
 *    the slots it mentions. A budget change changes the budget only; a sale→rent change
 *    keeps the location/area/type and drops an old total price that no longer applies.
 *  • Conflicts (sale AND rent, «exactly» AND «more than») stop the flow with a question.
 *  • Unknown text never becomes a purchase or rental intent: the user is asked to rephrase.
 *  • Nothing here registers, sends or saves a request. The owner summary is a review only.
 */
(function (root) {
  'use strict';
  var S = root.NasrSearch;

  // Areas inside Nasr City (most specific first; the city itself is last).
  var LOCATIONS = ['عباس العقاد', 'مكرم عبيد', 'مصطفى النحاس', 'حسن المأمون', 'حسنين هيكل', 'حلمي عبد العاطي',
    'السراج مول', 'كابول', 'النزهة', 'شارع الطيران', 'الطيران', 'حي السفارات', 'زهراء مدينة نصر', 'رابعة العدوية',
    'المنطقة الأولى', 'المنطقة الثانية', 'المنطقة الثالثة', 'المنطقة الرابعة', 'المنطقة الخامسة', 'المنطقة السادسة',
    'المنطقة السابعة', 'المنطقة الثامنة', 'المنطقة التاسعة', 'المنطقة العاشرة', 'الحي الأول', 'الحي الثاني',
    'الحي الثالث', 'الحي الرابع', 'الحي الخامس', 'الحي السادس', 'الحي السابع', 'الحي الثامن', 'الحي التاسع',
    'الحي العاشر', 'مدينة نصر'];
  var EN_LOCATIONS = [['abbas el akkad', 'عباس العقاد'], ['abbas al akkad', 'عباس العقاد'], ['makram ebeid', 'مكرم عبيد'],
    ['mostafa el nahas', 'مصطفى النحاس'], ['hassan el maamoun', 'حسن المأمون'], ['nasr city', 'مدينة نصر']];
  var ZONE_ORD = ['', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة'];
  var DISTRICT_ORD = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
  var TYPE_NAME = { apartment: 'شقة', villa: 'فيلا/دوبلكس', shop: 'محل', office: 'مكتب/إداري', clinic: 'عيادة', warehouse: 'مخزن' };

  // Explicit ownership beats a generic «عايز» («عايز أبيع شقتي» is an owner).
  var OWNER_RE = /عندي\s+(?:شقه|محل|فيلا|مكتب|عقار|ارض|دوبلكس|مخزن|عياده|روف)|(?:^|\s)(?:ابيع|هبيع|اوجر|ااجر|هاجر|بيع\s+شقتي)(?=\s|$)|انا\s+(?:المالك|مالك|الموجر|موجر)|(?:^|\s)(?:شقتي|فيلتي)(?=\s|$)|(?:عقاري|محلي)\s+(?:للبيع|للايجار)|اطلب\s+فيها|i\s+own|my\s+(?:apartment|flat|shop|villa)/;
  var SEARCH_RE = /بدور|ابحث|بحث\s+عن|اشتري|استاجر|عايز|عاوز|محتاج|اريد|نفسي|ميزانيه|ميزانيتي|معايا|looking|i\s+want|\bbuy\b|\bneed\b/;
  var RENT_VERB_RE = /(?:^|\s)(?:استاجر|اوجر|ااجر|هاجر|rent)(?=\s|$)/;
  var SALE_VERB_RE = /(?:^|\s)(?:اشتري|ابيع|هبيع|buy)(?=\s|$)/;
  var NEGATED_SALE_RE = /(?:^|\s)(?:لا|مش|مو|بدل|بدلا\s+من|وليس|not)\s+(?:ال|لل)?(?:شراء|بيع|تمليك|اشتري|sale|buy)(?=\s|$)/g;
  var NEGATED_RENT_RE = /(?:^|\s)(?:لا|مش|مو|بدل|بدلا\s+من|وليس|not)\s+(?:ال|لل)?(?:ايجار|ايجارا|rent)(?=\s|$)/g;

  function fresh() {
    return { version: 1, role: null, criteria: {}, location: '', furnished: null, awaiting: null, conflicts: [] };
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function findLocation(n) {
    var zone = n.match(/(?:^|\s)(?:ال)?منطقه\s+(\d{1,2})(?=\s|$)/);
    if (zone && ZONE_ORD[+zone[1]]) return 'المنطقة ' + ZONE_ORD[+zone[1]];
    var district = n.match(/(?:^|\s)(?:ال)?حي\s+(\d{1,2})(?=\s|$)/);
    if (district && DISTRICT_ORD[+district[1]]) return 'الحي ' + DISTRICT_ORD[+district[1]];
    for (var i = 0; i < LOCATIONS.length; i++) {
      if ((' ' + n + ' ').indexOf(' ' + S.normalize(LOCATIONS[i]) + ' ') !== -1) return LOCATIONS[i];
    }
    for (var j = 0; j < EN_LOCATIONS.length; j++) if (n.indexOf(EN_LOCATIONS[j][0]) !== -1) return EN_LOCATIONS[j][1];
    return '';
  }

  function summary(d) {
    var c = d.criteria || {}, parts = [];
    parts.push(d.role === 'owner' ? 'مالك / مؤجر يعرض عقاره' : d.role === 'search' ? 'باحث عن عقار' : 'المسار غير محدد');
    if (c.types && c.types.length) parts.push(c.types.map(function (t) { return TYPE_NAME[t]; }).join(' أو '));
    if (c.deal) parts.push(c.deal === 'rent' ? 'إيجار شهري' : 'بيع — سعر إجمالي');
    if (c.price) parts.push((d.role === 'owner' ? 'السعر المطلوب: ' : 'الميزانية: ') + S.rangeLabel('price', c.price));
    if (c.area) parts.push('المساحة: ' + S.rangeLabel('area', c.area));
    if (c.rooms) parts.push(c.rooms.min + ' غرف أو أكثر');
    if (d.furnished === 'furnished') parts.push('مفروش');
    if (d.furnished === 'unfurnished') parts.push('غير مفروش (لا يُطبَّق كفلتر: الحقل غير موحّد في الكتالوج)');
    parts.push(d.location && d.location !== 'مدينة نصر' ? d.location + '، مدينة نصر' : 'مدينة نصر');
    return parts.join(' — ');
  }

  function missingField(d) {
    var c = d.criteria;
    if (!d.role) return 'role';
    if (!c.deal) return 'deal';
    if (!c.types || !c.types.length) return 'type';
    if (!d.location) return 'location';
    if (d.role === 'owner' && !c.area) return 'area';
    if (d.role === 'owner' && !c.price) return 'price';
    return null;
  }
  var QUESTIONS = {
    role: 'هل تبحث عن عقار للشراء أو الإيجار، أم لديك عقار تريد عرضه للبيع أو الإيجار؟',
    deal: 'للبيع أم للإيجار؟',
    type: 'ما نوع العقار: شقة أم فيلا/دوبلكس أم محل أم مكتب؟',
    location: 'في أي منطقة داخل مدينة نصر؟ (يمكنك كتابة «مدينة نصر» لأي منطقة فيها)',
    area: 'ما مساحة العقار بالمتر؟',
    price: 'ما السعر المطلوب؟',
  };

  function reduce(previous, input) {
    var d = previous && previous.version === 1 ? clone(previous) : fresh();
    var raw = String(input || '').slice(0, 1000);
    var n = S.normalize(raw);
    var options = [], ready = false, notes = [];
    function done(message) { return { draft: d, summary: summary(d), response: message, options: options, ready: ready }; }

    if (!n) return done('اكتب طلبك بكلماتك، مثل: «شقة للإيجار في عباس العقاد حتى 20 ألف شهريًا».');
    // Identity/contact data is not needed for a search or a draft — never parse or keep it.
    var compact = S.toWesternDigits(raw).replace(/[\s\-–—().]/g, '');
    if (/(?:\+?20|0)?1[0125]\d{8}/.test(compact) || /\d{14}/.test(compact) || /[^\s@]@[^\s@]/.test(raw) || /الرقم القومي|رقم قومي|national id/i.test(raw)) {
      return done('لا نحتاج اسمًا أو هاتفًا أو رقمًا قوميًا أو بريدًا هنا، ولم نحفظ ما كتبته. اكتب مواصفات العقار فقط.');
    }
    if (/(?:قبل|السابقه|السابق).{0,30}(?:رساله|محادثه|جلسه|كنت ابحث|كنت بدور)|(?:كنت ابحث|كنت بدور) عن ايه|ماذا كنت ابحث/.test(n)) {
      return done('لا أحتفظ بمحادثات أو جلسات سابقة. هذه مسودة جديدة في هذه الصفحة فقط، وتُحذف بتحديثها.');
    }
    if (/وصل طلبي|اتسجل|تم تسجيل|تسجيل طلبي|سجلت طلبي|تم ارسال|اتبعت/.test(n)) {
      return done('لا. ما تكتبه هنا مسودة داخل هذه الصفحة فقط: لم يُرسل طلب، ولم يصل للمكتب، ولم يُحفظ في أي قاعدة بيانات.');
    }
    if (/ترخيص|رخصه|عموله|سمسره|تامين|نموذج 8 مسجل/.test(n)) {
      // المنشور فعلًا على الموقع (الأسئلة الشائعة + llms.txt): عمولة البيع فقط — والباقي لا يُفترض.
      return done('العمولة المنشورة على الموقع: 2.5% من قيمة البيع، تُدفع فقط بعد إتمام الصفقة، ولا رسوم مبدئية. ' +
        'أما عمولة الإيجار والترخيص والتأمين فغير منشورة كبيانات مؤكدة هنا، ولا يمكن افتراضها؛ تحتاج تأكيدًا من المكتب لعقار محدد قبل أي قرار.');
    }
    if (/(?:هل|لسه|لسا|ما زال|مازال).{0,40}(?:متاح|موجود|متوفر)|متاح(?:ه)?\s+(?:اليوم|النهارده|الان|دلوقتي)|(?:توفر|توافر)\s+(?:العقار|الشقه|الوحده|المحل)/.test(n)) {
      return done('التوافر يحتاج إلى تأكيد من المالك. تاريخ الإعلان أو حالة «منشور» لا يثبتان أن العقار متاح اليوم، ولا نجري تحققًا لحظيًا من هنا.');
    }
    if (/راجع المسوده|اعرض الملخص|راجع الطلب|ملخص الطلب/.test(n)) {
      ready = d.role === 'owner' && !missingField(d);
      return done('ملخص للمراجعة فقط — لم يُرسل ولم يُحفظ:\n' + summary(d) +
        (d.role === 'owner' ? '\nللإرسال الفعلي استخدم صفحة «اعرض عقارك» بعد مراجعة البيانات: /add-your-property.html — لن نرسل شيئًا من هنا.' : '') +
        '\nيمكنك تعديل أي قيد برسالة واحدة دون إعادة كتابة الباقي.');
    }
    if (/تقييم|قيمه عقاري|قيم عقاري|تسوي كام|يسوي كام/.test(n)) {
      return done('التقييم مؤشر استرشادي من أسعار الإعلانات والبيانات المتاحة، وليس تقييمًا مهنيًا ولا سعر صفقة منجزة. أداة التقييم تعرض النطاق الفعلي وعدد العينات وتاريخها: /tools/valuation.html');
    }

    // Explicit removals: «بدون ميزانية»، «احذف المساحة».
    var removed = n.match(/(?:الغي|الغاء|احذف|امسح|شيل|بدون)\s+(?:شرط\s+)?(?:ال)?(ميزانيه|سعر|مساحه|غرف|منطقه|موقع)(?=\s|$)/);
    if (removed) {
      var key = { ميزانيه: 'price', سعر: 'price', مساحه: 'area', غرف: 'rooms' }[removed[1]];
      if (key) delete d.criteria[key];
      else d.location = '';
      d.awaiting = missingField(d);
      return done('أزلت هذا القيد فقط.\nفهمنا: ' + summary(d) + (d.awaiting ? '\n' + QUESTIONS[d.awaiting] : ''));
    }

    // A correction such as «إيجارًا لا شراء» keeps only the affirmed deal.
    var corrected = n.replace(NEGATED_SALE_RE, ' ').replace(NEGATED_RENT_RE, ' ');
    var parsed = S.parseQuery(corrected);
    if (parsed.outOfScope) {
      return done('ترشيحاتنا لعقارات مدينة نصر فقط. لا نرشح سجلات الرحاب أو التجمع أو القاهرة الجديدة أو مصر الجديدة، حتى لو كانت في الأرشيف العام. اذكر منطقة داخل مدينة نصر.');
    }
    var owner = OWNER_RE.test(corrected);
    // A stated ceiling («حتى 7 مليون») is a buyer's budget, not an owner's asking price.
    var budgetLike = parsed.price && parsed.price.max != null && parsed.price.min == null &&
      /حتي|لحد|اقل من|تحت|بحد اقصي|ميزاني|معايا|max|under|up to/.test(corrected);
    var search = !owner && (SEARCH_RE.test(corrected) || budgetLike);
    if (RENT_VERB_RE.test(corrected) && !parsed.deal) parsed.deal = 'rent';
    if (SALE_VERB_RE.test(corrected) && !parsed.deal) parsed.deal = 'sale';
    var location = findLocation(corrected);
    var furnished = /غير مفروش|مش مفروش|بدون فرش|فاضي|قانون جديد/.test(corrected) ? 'unfurnished'
      : /مفروش|furnished/.test(corrected) ? 'furnished' : null;
    var hasFacts = parsed.deal || parsed.types || parsed.price || parsed.area || parsed.rooms || location || furnished;

    // Answers to the pending question when the user replies with a bare number.
    if (!hasFacts && /^\d+(?:\.\d+)?$/.test(n) && (d.awaiting === 'area' || d.awaiting === 'price')) {
      var v = Number(n);
      if (d.awaiting === 'area' && v >= 15 && v <= 5000) parsed.area = { min: v, max: v, exact: v };
      if (d.awaiting === 'price' && v >= 1000) parsed.price = { min: v, max: v, exact: v };
      hasFacts = parsed.area || parsed.price;
    }
    if (!owner && !search && !hasFacts) {
      return done('لم أفهم طلبًا أو تعديلًا عقاريًا واضحًا، فلم أفترض شراءً أو إيجارًا. أعد الصياغة، مثل: «بدور على شقة للإيجار في عباس العقاد حتى 20 ألف شهريًا» أو «عندي شقة للبيع 180 متر بسعر 8 ملايين».');
    }

    if (parsed.conflicts.length) {
      ['types', 'area', 'rooms'].forEach(function (k) { if (parsed[k]) d.criteria[k] = clone(parsed[k]); });
      if (location) d.location = location;
      d.conflicts = parsed.conflicts.slice();
      d.awaiting = null;
      return done(parsed.conflicts.join('\n') + '\nلن نبحث أو نكمل قبل أن تحسم هذا الشرط.');
    }

    var newRole = owner ? 'owner' : search ? 'search' : null;
    if (newRole && d.role && newRole !== d.role) {
      notes.push('تم التحويل إلى ' + (newRole === 'owner' ? 'مسار المالك/المؤجر' : 'مسار الباحث') + '؛ احتفظنا بالنوع والموقع والمساحة.');
      if (!parsed.price) { delete d.criteria.price; notes.push('أزلت قيمة السعر السابقة لأن معناها تغيّر بين الميزانية والسعر المطلوب.'); }
    }
    if (newRole) d.role = newRole;
    // A buyer's maximum («معايا/ميزانيتي 7 مليون») is a ceiling; a bare number is too.
    if (parsed.price && parsed.price.approx != null && d.role !== 'owner' && !/حوالي|تقريبا|حدود|about|around/.test(corrected)) {
      parsed.price = { min: null, max: parsed.price.approx };
    }
    // An owner's stated value is a value, not a ±15% search window.
    if (d.role === 'owner') ['price', 'area'].forEach(function (k) {
      var r = parsed[k];
      if (r && r.approx != null && !/حوالي|تقريبا|حدود|about|around/.test(corrected)) parsed[k] = { min: r.approx, max: r.approx, exact: r.approx };
    });

    var priorDeal = d.criteria.deal;
    if (parsed.deal && priorDeal && parsed.deal !== priorDeal) {
      notes.push('تم تغيير المعاملة من ' + (priorDeal === 'rent' ? 'الإيجار' : 'البيع') + ' إلى ' +
        (parsed.deal === 'rent' ? 'الإيجار الشهري' : 'البيع') + ' مع حفظ النوع والموقع والمساحة.');
      if (!parsed.price && d.criteria.price) {
        delete d.criteria.price;
        notes.push('أزلت الميزانية السابقة لأنها كانت ' + (priorDeal === 'rent' ? 'إيجارًا شهريًا' : 'سعرًا إجماليًا') + '؛ حدد الحد الجديد.');
      }
    }
    ['deal', 'types', 'area', 'price', 'rooms', 'baths'].forEach(function (k) { if (parsed[k]) d.criteria[k] = clone(parsed[k]); });
    if (location) d.location = location;
    if (furnished) d.furnished = furnished;
    if (d.criteria.price) {
      if (d.criteria.deal === 'rent') d.criteria.price.monthly = true;
      else delete d.criteria.price.monthly;
    }
    d.conflicts = [];
    d.awaiting = missingField(d);
    var head = (notes.length ? notes.join('\n') + '\n' : '') + 'فهمنا: ' + summary(d);
    if (d.awaiting) {
      var q = QUESTIONS[d.awaiting];
      if (d.awaiting === 'price' && d.role !== 'owner') q = 'ما الحد الأقصى للميزانية؟';
      return done(head + '\n' + q);
    }
    if (d.role === 'owner') {
      options = ['راجع المسودة'];
      return done(head + '\nهذه مسودة محلية فقط: لم تُرسل ولم تُحفظ. يمكنك إضافة الغرف أو الدور أو التشطيب، أو طلب «راجع المسودة».');
    }
    ready = true;
    if (!d.criteria.price) head += '\nبدون حد للميزانية؛ أضفه لتضييق النتائج.';
    return done(head);
  }

  function criteria(d) {
    var text = d.location && d.location !== 'مدينة نصر' ? S.normalize(d.location).split(' ') : [];
    if (d.furnished === 'furnished') text.push('مفروش');
    return Object.assign({}, clone(d.criteria || {}), { text: text, conflicts: (d.conflicts || []).slice() });
  }

  /** Nasr City catalog only, even if an upstream list ever contains archive rows. */
  function inScope(rows) {
    return rows.filter(function (p) {
      return p && p.in_area !== false && p.in_nasr_city !== false && /^\/properties\/[a-z0-9-]+\/$/.test(p.u || '');
    });
  }
  function results(rows, d) { return S.search(inScope(rows), criteria(d)); }

  /** Zero results: concrete alternatives, each one changes exactly one stated condition. */
  function suggestions(rows, d) {
    var scoped = inScope(rows), out = [];
    var drops = [
      ['price', d.role === 'owner' ? 'السعر' : 'الميزانية'], ['area', 'المساحة'], ['rooms', 'عدد الغرف'],
      ['location', 'المنطقة'], ['types', 'نوع العقار'], ['furnished', 'شرط الفرش'],
    ];
    function withoutCondition(field) {
      var copy = clone(d);
      if (field === 'location') {
        if (!copy.location || copy.location === 'مدينة نصر') return null;
        copy.location = 'مدينة نصر';
      } else if (field === 'furnished') {
        if (copy.furnished !== 'furnished') return null;
        copy.furnished = null;
      } else {
        if (!copy.criteria[field]) return null;
        delete copy.criteria[field];
      }
      return copy;
    }
    drops.forEach(function (pair) {
      var copy = withoutCondition(pair[0]);
      if (!copy) return;
      var count = S.search(scoped, criteria(copy)).length;
      if (count > 0) out.push({ field: pair[0], count: count, label: 'تغيير شرط «' + pair[1] + '» من طلبك: إزالته يعطي ' + count + ' عرضًا' });
    });
    return out.sort(function (a, b) { return b.count - a.count; }).slice(0, 3);
  }

  root.NasrAgent = { fresh: fresh, reduce: reduce, summary: summary, criteria: criteria, results: results, suggestions: suggestions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
