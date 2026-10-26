/*!
 * catalog.js — بحث وفلاتر معرض العقارات (2026-10-20)
 * يعتمد على catalog-search-core.js (window.NasrSearch). بلا مكتبات.
 *
 * الحالة كلها في الرابط (?q=&deal=&type=&pmin=&pmax=&amin=&amax=&rooms=&sort=)
 * فتُشارك وتُحفظ، والروابط القديمة (?type=rent، ?q=العاشرة) تعمل كما هي.
 * بلا فلتر نشط: تبقى شريحة HTML والترقيم كما بناها Jekyll (لا تغيير).
 * مع فلتر نشط: تُحمَّل assets/data/catalog.json مرة واحدة وتُعرض كل النتائج
 * المطابقة من كل الصفحات، ويتزامن: العدّاد + عنوان الصفحة + العنوان h2 +
 * القائمة + الشرائح + الرابط، مع إعلان النتيجة لقارئات الشاشة (role=status).
 */
(function () {
  'use strict';
  var S = window.NasrSearch;
  var script = document.currentScript || document.querySelector('script[data-catalog]');
  var form = document.getElementById('plForm');
  if (!S || !form || !script) return;

  var $ = function (id) { return document.getElementById(id); };
  var grid = $('plGrid'), pager = $('plPager'), empty = $('plEmpty'), status = $('plStatus');
  var input = $('plSearch'), sortSel = $('plSort'), reset = $('plReset'), understoodBox = $('plUnderstood');
  var count = $('plCount'), headText = $('plHeadingText'), headCount = $('plHeadingCount');
  var fields = { pmin: $('plPmin'), pmax: $('plPmax'), amin: $('plAmin'), amax: $('plAmax'), rooms: $('plRooms') };
  var more = $('plMore');
  var dealChips = form.querySelectorAll('[data-deal]');
  var typeChips = form.querySelectorAll('[data-type]');
  var DATA_URL = script.getAttribute('data-catalog');
  var WA = script.getAttribute('data-whatsapp') || 'https://wa.me/201147758857';
  var baseTitle = document.title;
  var serverCards = null; // شريحة Jekyll الأصلية لاستعادتها عند المسح
  var data = null, loading = null, seq = 0;
  function done() { grid.setAttribute('data-rendered', String(++seq)); }
  var state = { q: '', deal: '', type: '', pmin: '', pmax: '', amin: '', amax: '', rooms: '', sort: 'newest' };
  var TYPE_SETS = { apartment: ['apartment'], villa: ['villa'], shop: ['shop'], office: ['office', 'clinic'] };
  var TYPE_NAMES = { apartment: 'شقق', villa: 'دوبلكس وفيلات', shop: 'محلات', office: 'مكاتب وإداري' };

  // ─── الرابط ⇄ الحالة ─────────────────────────────────────
  function readURL() {
    var p = new URLSearchParams(window.location.search);
    Object.keys(state).forEach(function (k) { if (p.has(k)) state[k] = p.get(k) || ''; });
    // توافق خلفي: ?type=rent (شريحة «شقق إيجار» القديمة)، ?type=apartment (كانت تشمل الفيلات)
    if (state.type === 'rent' || state.type === 'sale') { state.deal = state.type; state.type = ''; }
    if (!TYPE_SETS[state.type]) state.type = '';
    if (state.deal !== 'sale' && state.deal !== 'rent') state.deal = '';
    if (!/^(newest|price-asc|price-desc|area-desc|area-asc|rooms-desc)$/.test(state.sort)) state.sort = 'newest';
  }
  function writeURL() {
    var p = new URLSearchParams();
    Object.keys(state).forEach(function (k) {
      if (state[k] && !(k === 'sort' && state[k] === 'newest')) p.set(k, state[k]);
    });
    var qs = p.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
  }
  function syncControls() {
    input.value = state.q;
    sortSel.value = state.sort;
    Object.keys(fields).forEach(function (k) { if (fields[k]) fields[k].value = state[k]; });
    if (state.pmin || state.pmax || state.amin || state.amax || state.rooms) more.open = true;
    setChips(dealChips, 'deal', state.deal);
    setChips(typeChips, 'type', state.type);
  }
  function setChips(list, key, val) {
    for (var i = 0; i < list.length; i++) {
      var on = list[i].getAttribute('data-' + key) === val;
      list[i].classList.toggle('active', on);
      list[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // ─── المعايير ───────────────────────────────────────────
  function num(v) { var n = S.parseAmount(v); return n != null && n > 0 ? n : null; }
  function uiCriteria() {
    var pr = (num(state.pmin) || num(state.pmax)) ? { min: num(state.pmin), max: num(state.pmax) } : null;
    var ar = (num(state.amin) || num(state.amax)) ? { min: num(state.amin), max: num(state.amax) } : null;
    var rm = num(state.rooms) ? { min: num(state.rooms), max: null } : null;
    return { deal: state.deal || null, types: state.type ? TYPE_SETS[state.type] : null, price: pr, area: ar, rooms: rm };
  }
  function isActive() {
    return Boolean(state.q.trim() || state.deal || state.type || state.pmin || state.pmax ||
      state.amin || state.amax || state.rooms || state.sort !== 'newest');
  }

  // ─── البيانات ───────────────────────────────────────────
  function loadData() {
    if (data) return Promise.resolve(data);
    if (!loading) {
      loading = fetch(DATA_URL, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (rows) { data = rows.map(S.prepare); return data; })
        .catch(function (e) { loading = null; throw e; });
    }
    return loading;
  }

  // ─── العرض ──────────────────────────────────────────────
  var TL = { apartment: 'شقة', villa: 'دوبلكس/فيلا', shop: 'محل', office: 'مكتب/إداري', clinic: 'عيادة', warehouse: 'مخزن' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** نسخة JS من _includes/property-card.html — نفس البنية والأصناف. */
  function renderCard(it) {
    var bc = it.d === 'rent' ? 'rent' : (it.y === 'shop' || it.y === 'warehouse') ? 'shop' : (it.y === 'office' || it.y === 'clinic') ? 'office' : 'sale';
    var img = it.i
      ? '<img src="' + esc(it.i) + '" alt="' + esc(it.t) + '" class="pl-card-img" width="400" height="300" loading="lazy" decoding="async"' +
        (it.f ? ' data-fallback="' + esc(it.f) + '"' : '') + '>'
      : '<div class="pl-card-img img-ph" role="img" aria-label="لا توجد صورة لهذا العرض"><i class="fas fa-building img-ph-ico" aria-hidden="true"></i></div>';
    var specs = (it.an ? '<span><i class="fas fa-ruler-combined" aria-hidden="true"></i> ' + it.an + ' م²</span>' : '') +
      (it.rn ? '<span><i class="fas fa-bed" aria-hidden="true"></i> ' + it.rn + ' غرف</span>' : '') +
      (it.bn ? '<span><i class="fas fa-bath" aria-hidden="true"></i> ' + it.bn + ' حمام</span>' : '');
    return '<a href="' + esc(it.u) + '" class="pl-card" data-slug="' + esc(it.u.split('/').filter(Boolean).pop()) + '">' +
      '<div class="pl-card-img-wrap">' + img +
      '<span class="pl-card-badge ' + bc + '">' + (TL[it.y] || 'شقة') + ' ' + (it.d === 'rent' ? 'للإيجار' : 'للبيع') + '</span></div>' +
      '<div class="pl-card-body"><h3 class="pl-card-title">' + esc(it.t) + '</h3>' +
      '<div class="pl-card-specs">' + specs + '</div>' +
      '<div class="pl-card-location"><i class="fas fa-map-marker-alt" aria-hidden="true"></i><span>' + esc(it.l) + '</span></div>' +
      '<div class="pl-card-footer"><span class="pl-card-price">' + esc(it.p) + '</span>' +
      '<span class="pl-card-arrow" aria-hidden="true"><i class="fas fa-arrow-left"></i></span></div></div></a>';
  }
  // احتياط الصورة بلا onerror مضمّن (CSP-friendly): مستمع واحد على الشبكة.
  grid.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.getAttribute('data-fallback')) {
      t.src = t.getAttribute('data-fallback');
      t.removeAttribute('data-fallback');
    }
  }, true);

  function chipButton(label, onClick, extra) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pl-uchip' + (extra ? ' ' + extra : '');
    b.innerHTML = esc(label) + ' <i class="fas fa-times" aria-hidden="true"></i>';
    b.setAttribute('aria-label', 'إزالة: ' + label);
    b.addEventListener('click', onClick);
    return b;
  }

  // ألفاظ فهمناها وليست جزءًا من وصف الإعلان: تُزال مع الشرط الذي أنتجته (أول الجملة أو وسطها).
  var DROPPED_WORDS = /(^|\s)(?:بالضبط|بالظبط|تماما|exactly)(?=\s|$)/g;

  /** يحذف جزءًا فهمه المحلل من نص البحث (يعمل على النص بعد التطبيع). */
  function removeFromQuery(src, dropExact) {
    var n = S.normalize(state.q);
    if (dropExact) n = n.replace(DROPPED_WORDS, ' ');
    n = n.replace(/\s+/g, ' ').trim();
    var cands = [src, src.replace(/^1 /, '')];
    for (var i = 0; i < cands.length; i++) {
      var at = (' ' + n + ' ').indexOf(' ' + cands[i] + ' ');
      if (at !== -1) {
        n = (' ' + n + ' ').slice(0, at) + ' ' + (' ' + n + ' ').slice(at + cands[i].length + 2);
        return n.replace(/\s+/g, ' ').trim();
      }
    }
    return n;
  }

  /** كل قيد نشط مع طريقة إزالته — للشرائح ولاقتراحات «بدون هذا الشرط». */
  function constraints(parsed) {
    var list = [];
    parsed.understood.forEach(function (u) {
      list.push({ label: u.label, drop: function () { state.q = removeFromQuery(u.src, /^بالضبط/.test(u.label)); } });
    });
    if (parsed.text.length) {
      list.push({ label: '«' + parsed.text.join(' ') + '»', drop: function () {
        parsed.text.forEach(function (tok) { state.q = removeFromQuery(tok); });
      } });
    }
    if (state.deal) list.push({ label: state.deal === 'rent' ? 'للإيجار' : 'للبيع', drop: function () { state.deal = ''; } });
    if (state.type) list.push({ label: TYPE_NAMES[state.type], drop: function () { state.type = ''; } });
    if (state.pmin || state.pmax) list.push({ label: 'نطاق السعر', drop: function () { state.pmin = state.pmax = ''; } });
    if (state.amin || state.amax) list.push({ label: 'نطاق المساحة', drop: function () { state.amin = state.amax = ''; } });
    if (state.rooms) list.push({ label: state.rooms + '+ غرف', drop: function () { state.rooms = ''; } });
    return list;
  }

  function criteriaFor(st) {
    var saved = state; state = st;
    var parsed = S.parseQuery(st.q);
    var c = S.combine(parsed, uiCriteria());
    state = saved;
    return { parsed: parsed, criteria: c };
  }

  function waLink(parsed) {
    var parts = [];
    if (state.q.trim()) parts.push('«' + state.q.trim() + '»');
    if (state.deal) parts.push(state.deal === 'rent' ? 'للإيجار' : 'للبيع');
    if (state.type) parts.push(TYPE_NAMES[state.type]);
    if (state.pmin || state.pmax) parts.push('السعر ' + (state.pmin || '…') + ' – ' + (state.pmax || '…'));
    if (state.amin || state.amax) parts.push('المساحة ' + (state.amin || '…') + ' – ' + (state.amax || '…') + ' م²');
    if (state.rooms) parts.push(state.rooms + '+ غرف');
    var text = 'السلام عليكم أ. طارق، بحثت في معرض سمسار طلبك عن عقار في مدينة نصر (' + parts.join('، ') +
      ') ولم أجد عرضًا مناسبًا. هل يتوفر لديك ما يطابق؟\n' + window.location.href;
    return WA + '?text=' + encodeURIComponent(text);
  }

  /** تمييز العدد بالعربية: عرض واحد، عرضان، 3–10 عروض، 11+ عرضًا. */
  function offers(n) {
    return n === 1 ? 'عرض واحد' : n === 2 ? 'عرضان' : n <= 10 ? n + ' عروض' : n + ' عرضًا';
  }
  function render() {
    var active = isActive();
    reset.hidden = !active;
    writeURL();
    if (!active) {
      if (serverCards) { grid.innerHTML = ''; grid.appendChild(serverCards.cloneNode(true)); }
      grid.hidden = false; empty.hidden = true; understoodBox.hidden = true;
      if (pager) pager.hidden = false;
      status.textContent = '';
      count.textContent = count.getAttribute('data-default');
      headText.textContent = headText.getAttribute('data-default');
      headCount.textContent = headCount.getAttribute('data-default');
      document.title = baseTitle;
      done();
      return;
    }
    status.textContent = 'جارٍ البحث…';
    loadData().then(function (rows) {
      var pc = criteriaFor(state);
      var results = S.search(rows, pc.criteria, state.sort);
      var issues = (pc.criteria.conflicts || []).join(' ');
      if (pc.criteria.outOfScope) issues += ' الترشيحات لمدينة نصر فقط؛ المناطق الأخرى أرشيف وليست بدائل محلية.';
      if (!serverCards) {
        serverCards = document.createDocumentFragment();
        Array.prototype.forEach.call(grid.children, function (n) { serverCards.appendChild(n.cloneNode(true)); });
      }
      // الشرائح: ما فهمه البحث من النص (قابل للحذف)
      understoodBox.innerHTML = '';
      if (pc.parsed.understood.length || issues || state.deal || state.type) {
        var lab = document.createElement('span');
        lab.className = 'pl-ulabel';
        lab.textContent = 'فهمنا (مدينة نصر فقط):';
        understoodBox.appendChild(lab);
        if (issues) {
          var warn = document.createElement('span');
          warn.className = 'pl-ulabel';
          warn.setAttribute('role', 'alert');
          warn.textContent = issues.trim();
          understoodBox.appendChild(warn);
        }
        pc.parsed.understood.forEach(function (u) {
          understoodBox.appendChild(chipButton(u.label, function () {
            state.q = removeFromQuery(u.src, /^بالضبط/.test(u.label));
            syncControls(); render(); input.focus();
          }));
        });
        if (state.deal) understoodBox.appendChild(chipButton(state.deal === 'rent' ? 'فلتر: إيجار شهري' : 'فلتر: بيع', function () { state.deal = ''; syncControls(); render(); }));
        if (state.type) understoodBox.appendChild(chipButton(TYPE_NAMES[state.type], function () { state.type = ''; syncControls(); render(); }));
        understoodBox.hidden = false;
      } else understoodBox.hidden = true;

      grid.innerHTML = results.map(renderCard).join('');
      grid.hidden = results.length === 0;
      if (pager) pager.hidden = true;
      var total = rows.length;
      status.textContent = results.length === 0 ? 'لا توجد نتائج مطابقة.'
        : offers(results.length) + ' مطابقة من أصل ' + total + ' في مدينة نصر.';
      count.textContent = results.length + ' من ' + total + ' عرضًا';
      headText.textContent = 'نتائج البحث';
      headCount.textContent = '(' + results.length + ')';
      document.title = (state.q.trim() ? '«' + state.q.trim() + '» — ' : 'نتائج الفلترة — ') +
        offers(results.length) + ' في مدينة نصر | سمسار طلبك';

      empty.hidden = results.length !== 0;
      if (results.length === 0) { renderEmpty(rows, pc.parsed); if (issues) $('plEmptyText').textContent = issues + ' لم نغيّر شروطك أو نوسّع البحث.'; }
      done();
    }).catch(function () {
      status.textContent = 'تعذّر تحميل بيانات البحث. تحقّق من الاتصال ثم أعد المحاولة — الصفحات أدناه ما زالت تعمل.';
      if (pager) pager.hidden = false;
      done();
    });
  }

  /** حالة «لا نتائج» المفيدة: كم نتيجة لو حذفت كل شرط على حدة + واتساب بسياق البحث. */
  function renderEmpty(rows, parsed) {
    var box = $('plSuggest');
    box.innerHTML = '';
    var options = [];
    constraints(parsed).forEach(function (c) {
      var copy = {}; Object.keys(state).forEach(function (k) { copy[k] = state[k]; });
      var saved = state; state = copy; c.drop(); state = saved;
      var n = S.search(rows, criteriaFor(copy).criteria, 'newest').length;
      if (n > 0) options.push({ c: c, n: n, st: copy });
    });
    // لا يكفي حذف شرط واحد؟ نقترح الإبقاء على شرط واحد فقط (مثل «للإيجار فقط ← 18»).
    if (!options.length) {
      var all = constraints(parsed);
      all.forEach(function (keep, ki) {
        var copy = {}; Object.keys(state).forEach(function (k) { copy[k] = state[k]; });
        var saved = state; state = copy;
        all.forEach(function (c, ci) { if (ci !== ki) c.drop(); });
        state = saved;
        var n = S.search(rows, criteriaFor(copy).criteria, 'newest').length;
        if (n > 0) options.push({ c: keep, n: n, st: copy, only: true });
      });
    }
    options.sort(function (a, b) { return b.n - a.n; }).slice(0, 4).forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-suggest-btn';
      b.textContent = (o.only ? 'تغيير شروط: الإبقاء على ' + o.c.label + ' فقط' : 'تغيير شرط: حذف ' + o.c.label) + ' ← ' + offers(o.n);
      b.addEventListener('click', function () { state = o.st; syncControls(); render(); });
      box.appendChild(b);
    });
    $('plEmptyText').textContent = options.length
      ? 'لم نجد عرضًا منشورًا يطابق كل الشروط معًا. جرّب:'
      : 'لم نجد عرضًا منشورًا بهذه المواصفات في مدينة نصر حاليًا.';
    $('plEmptyWa').href = waLink(parsed);
  }

  // ─── الأحداث ────────────────────────────────────────────
  var timer;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { state.q = input.value; readFields(); render(); }, 250);
  });
  function readFields() {
    Object.keys(fields).forEach(function (k) { if (fields[k]) state[k] = fields[k].value.trim(); });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearTimeout(timer);
    state.q = input.value;
    readFields();
    render();
  });
  sortSel.addEventListener('change', function () { state.sort = sortSel.value; render(); });
  Object.keys(fields).forEach(function (k) {
    var el = fields[k];
    if (!el) return;
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { readFields(); render(); }, el.tagName === 'SELECT' ? 0 : 400);
    });
  });
  function chipHandler(list, key) {
    Array.prototype.forEach.call(list, function (chip) {
      chip.addEventListener('click', function () {
        state[key] = chip.getAttribute('data-' + key);
        setChips(list, key, state[key]);
        render();
      });
    });
  }
  chipHandler(dealChips, 'deal');
  chipHandler(typeChips, 'type');
  function resetAll() {
    state = { q: '', deal: '', type: '', pmin: '', pmax: '', amin: '', amax: '', rooms: '', sort: 'newest' };
    syncControls();
    render();
  }
  reset.addEventListener('click', function () { resetAll(); input.focus(); });
  $('plEmptyReset').addEventListener('click', function () { resetAll(); input.focus(); });

  // جلب مبكر خامل للبيانات حتى يكون أول بحث فوريًا (≈ ملف واحد صغير مُخزَّن)
  input.addEventListener('focus', function () { loadData().catch(function () {}); }, { once: true });

  readURL();
  syncControls();
  if (isActive()) render();
})();
