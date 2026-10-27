/*!
 * crm-app.js — واجهة «دفتر العملاء» (/crm.html) — 2026-10-27
 * ───────────────────────────────────────────────────────────────
 * التخزين: localStorage على جهاز المستخدم فقط (مفتاح simsar_crm_v1). الشبكة: قراءة
 * /assets/data/catalog.json العامة (إعلانات الموقع) للمطابقة — ولا شيء غيرها.
 * واتساب: روابط wa.me بنص جاهز يضغط عليها المستخدم بنفسه؛ لا إرسال تلقائي ولا جماعي.
 * الأمان: كل نص جاي من ملف مستورد يُعرض بـ textContent — بلا HTML ديناميكي إطلاقًا.
 */
(function () {
  'use strict';
  var C = window.SimsarCRM;
  var KEY = 'simsar_crm_v1';
  var CATALOG_URL = '/assets/data/catalog.json';
  var ORIGIN = location.origin && /^https?:/.test(location.origin) ? location.origin : 'https://nasr-realestate.github.io';
  var SOURCES = { import: 'استيراد ملف', whatsapp: 'واتساب', call: 'مكالمة', site: 'الموقع', referral: 'ترشيح', walkin: 'زيارة المكتب', other: 'أخرى' };
  var FILTERS = [['all', 'الكل'], ['recent', '🕒 اتكلمتوا قريب'], ['owner', 'ملاك'], ['seeker', 'طالبين'], ['doorman', 'حراس'],
    ['broker', 'سماسرة'], ['unit', 'غير محدد']];
  var RECENT_DAYS = 90;

  var state = {
    db: null, rows: [], rowsState: 'idle', tab: 'queue', qFilter: 'all', skipped: {}, undo: null,
    list: { q: '', role: 'all', status: 'all', limit: 60 }, matchCache: {}, editing: null,
  };

  // ─── أدوات DOM آمنة ───
  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'checked' || k === 'selected' || k === 'value') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function chip(text, cls) { return el('span', { class: 'chip' + (cls ? ' ' + cls : ''), text: text }); }
  function day(t) { return t ? new Date(t).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function isoDay(t) { return t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : ''; }
  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function safeHref(u) { return typeof u === 'string' && /^\/[^/]/.test(u) ? u : '#'; }

  // ─── التخزين ───
  function compact(db) {
    return JSON.stringify(db, function (k, v) {
      if (k === 'contacts' || k === 'id' || k === 'name' || k === 'status' || k === 'seq' || k === 'v') return v;
      if (v === '' || v === 0 || v === false || v === null) return undefined;
      if (Array.isArray(v) && !v.length) return undefined;
      if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return undefined;
      return v;
    });
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      state.db = raw ? C.restore(raw) : C.emptyDb();
    } catch (e) {
      state.db = C.emptyDb();
      notice('مقدرتش أقرا الدفتر المحفوظ على الجهاز. لو عندك نسخة احتياطية استرجعها من «البيانات».');
    }
  }
  function save() {
    state.db.meta.updatedAt = Date.now();
    try { localStorage.setItem(KEY, compact(state.db)); return true; }
    catch (e) {
      notice('مساحة التخزين في المتصفح امتلأت — نزّل نسخة احتياطية فورًا من «البيانات».');
      return false;
    }
  }
  function contacts() { return Object.keys(state.db.contacts).map(function (id) { return state.db.contacts[id]; }); }

  function notice(text, actionLabel, action) {
    var n = clear($('notice'));
    n.appendChild(document.createTextNode(text));
    if (actionLabel) n.appendChild(el('button', { class: 'btn small', type: 'button', text: actionLabel, on: { click: action } }));
    n.hidden = false;
  }
  var toastTimer = 0;
  function toast(text, undoFn) {
    var t = clear($('toast'));
    t.appendChild(el('span', { text: text }));
    if (undoFn) t.appendChild(el('button', { class: 'btn small', type: 'button', text: 'تراجع', on: { click: function () { undoFn(); t.hidden = true; } } }));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, undoFn ? 7000 : 3500);
  }

  // ─── إعلانات الموقع ───
  function loadRows() {
    if (state.rowsState === 'loading' || state.rowsState === 'ok') return;
    state.rowsState = 'loading';
    fetch(CATALOG_URL, { cache: 'no-cache', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (rows) {
        state.rows = Array.isArray(rows) ? rows.filter(function (r) { return r && r.u && r.t; }) : [];
        state.rowsState = 'ok';
        state.matchCache = {};
        render();
      })
      .catch(function () { state.rowsState = 'error'; render(); });
  }
  function matchesOf(c) {
    if (c.role !== 'seeker' || !state.rows.length) return [];
    var hit = state.matchCache[c.id];
    var key = c.updatedAt + ':' + state.rows.length;
    if (hit && hit.key === key) return hit.list;
    var list = C.matchListings(c, state.rows, 3);
    state.matchCache[c.id] = { key: key, list: list };
    return list;
  }
  function rowByUrl(u) { return state.rows.filter(function (r) { return r.u === u; })[0] || null; }

  // ─── التبويبات ───
  function setTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (s) { s.hidden = s.id !== 'tab-' + name; });
    if (name === 'listings') loadRows();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (state.tab === 'queue') renderQueue();
    else if (state.tab === 'list') renderList();
    else if (state.tab === 'listings') renderListings();
    else if (state.tab === 'data') renderData();
    else if (state.tab === 'add') renderAdd();
  }

  // ─── طابور التأكيد ───
  function todayCounts() {
    var from = startOfToday(), done = 0, tried = 0;
    contacts().forEach(function (c) {
      (c.history || []).forEach(function (h) {
        if (h.at < from) return;
        if (h.action === 'active' || h.action === 'closed') done++;
        else if (/^(noanswer|later|wrong|personal|stop)$/.test(h.action)) tried++;
      });
    });
    return { done: done, tried: tried };
  }

  function currentQueue() {
    var all = contacts(), counts = {};
    all.forEach(function (c) { if (c.role === 'seeker') counts[c.id] = matchesOf(c).length; });
    var q = C.buildQueue(all, { matchCounts: counts });
    var f = state.qFilter, since = Date.now() - RECENT_DAYS * C.DAY;
    if (f === 'recent') {
      // «الجهات الحديثة»: اللي سجل المكالمات بيقول اتكلمتوا خلال 90 يوم — الأحدث الأول، أيًّا كان دورها.
      return q.filter(function (x) { return !state.skipped[x.c.id] && x.c.lastCallAt >= since; })
        .sort(function (a, b) { return b.c.lastCallAt - a.c.lastCallAt; });
    }
    return q.filter(function (x) {
      if (state.skipped[x.c.id]) return false;
      if (f === 'all') return true;
      if (f === 'owner') return x.group === 'owner' || x.group === 'listing';
      if (f === 'seeker') return x.group === 'seeker' || x.group === 'seeker-match';
      return x.group === f;
    });
  }

  function renderQueue() {
    var empty = !Object.keys(state.db.contacts).length;
    $('qEmpty').hidden = !empty;
    $('qWrap').hidden = empty;
    if (empty) return;
    if (!state.rows.length && state.rowsState === 'idle') loadRows();
    var q = currentQueue(), t = todayCounts();
    var stats = clear($('qStats'));
    stats.appendChild(el('span', null, ['النهارده: ', el('b', { text: String(t.done) }), ' اتأكد']));
    stats.appendChild(el('span', null, ['· ', el('b', { text: String(t.tried) }), ' محاولة']));
    stats.appendChild(el('span', null, ['· فاضل ', el('b', { text: String(q.length) }), ' في الطابور']));
    var fbox = clear($('qFilter'));
    FILTERS.forEach(function (f) {
      fbox.appendChild(el('button', { type: 'button', class: 'chip', 'aria-pressed': state.qFilter === f[0] ? 'true' : 'false', text: f[1],
        on: { click: function () { state.qFilter = f[0]; renderQueue(); } } }));
    });
    var card = clear($('qCard'));
    if (!q.length && state.qFilter === 'recent' && !contacts().some(function (x) { return x.lastCallAt; })) {
      card.appendChild(el('h2', { text: 'محتاج سجل المكالمات' }));
      card.appendChild(el('p', { class: 'muted', text: 'عشان يظهر هنا اللي اتكلمت معاهم آخر 3 شهور (الأحدث الأول)، استورد ملف سجل المكالمات (xml) من تطبيق «SMS Backup & Restore» في «البيانات».' }));
      card.appendChild(el('button', { class: 'btn primary', type: 'button', text: '📥 استيراد سجل المكالمات', on: { click: function () { setTab('data'); } } }));
      return;
    }
    if (!q.length) {
      card.appendChild(el('h2', { text: 'خلصت الطابور ده 🎉' }));
      card.appendChild(el('p', { class: 'muted', text: 'مفيش جهات مستحقة للتأكيد هنا دلوقتي. الجهات اللي اتأكدت بترجع بعد 30 يوم، واللي مردّتش بترجع في ميعاد المتابعة.' }));
      if (Object.keys(state.skipped).length) {
        card.appendChild(el('button', { class: 'btn', type: 'button', text: 'رجّع الجهات اللي تخطيتها', on: { click: function () { state.skipped = {}; renderQueue(); } } }));
      }
      return;
    }
    var item = q[0], c = item.c;
    card.appendChild(el('div', { class: 'q-group', text: C.GROUP_AR[item.group] + (c.status === 'followup' ? ' · متابعة' : '') }));
    card.appendChild(el('h2', { id: 'qName', tabindex: '-1', text: c.name }));
    card.appendChild(infoChips(c));
    var d = C.describe(c);
    if (d) card.appendChild(el('div', { class: 'q-desc', text: d }));
    card.appendChild(el('div', { class: 'q-phones', text: (c.phones || []).map(C.displayPhone).join('  ·  ') }));
    var meta = [];
    if (c.lastCallAt) meta.push('آخر مكالمة: ' + day(c.lastCallAt));
    if (c.confirmedAt) meta.push('آخر تأكيد: ' + day(c.confirmedAt));
    if (c.attempts) meta.push('محاولات بدون رد: ' + c.attempts);
    if (c.listing) { var lr = rowByUrl(c.listing); meta.push('صاحب إعلان: ' + (lr ? lr.t : c.listing)); }
    if (meta.length) card.appendChild(el('p', { class: 'muted', text: meta.join(' · ') }));
    if ((c.labels || []).length || c.notes) {
      card.appendChild(el('p', { class: 'muted', text: [c.notes].concat(c.labels || []).filter(Boolean).join(' · ').slice(0, 220) }));
    }

    var phone = (c.phones || [])[0], text = C.messageFor(c);
    card.appendChild(el('div', { class: 'q-main' }, [
      el('a', { class: 'btn primary', href: C.telLink(phone), text: '📞 اتصال' }),
      el('a', { class: 'btn wa', href: C.waLink(phone, text), target: '_blank', rel: 'noopener noreferrer', text: '💬 واتساب' }),
    ]));
    if (text) card.appendChild(el('details', null, [el('summary', { text: 'نص رسالة واتساب (تقدر تعدّله قبل الإرسال)' }), el('div', { class: 'msg', text: text })]));

    var ms = matchesOf(c);
    if (ms.length) {
      var box = el('div', { class: 'box' }, [el('strong', { text: '🏠 يناسبه من إعلاناتك (بعد ما تتأكد إنه لسه بيدوّر):' })]);
      var ul = el('ul');
      ms.forEach(function (m) {
        ul.appendChild(el('li', null, [
          el('a', { href: safeHref(m.row.u), target: '_blank', rel: 'noopener', text: m.row.t }),
          m.row.p ? ' — ' + m.row.p + ' ' : ' ',
          el('a', { class: 'btn small wa', href: C.waLink(phone, C.offerMessage(c, m.row, ORIGIN)), target: '_blank', rel: 'noopener noreferrer', text: 'ابعت العرض' }),
        ]));
      });
      box.appendChild(ul);
      card.appendChild(box);
    }

    if (c.role === 'seeker') {
      card.appendChild(el('div', { class: 'box' }, [
        el('span', { text: 'وافق يستقبل عروض أول بأول؟ ' }),
        el('button', { type: 'button', class: 'btn small', 'aria-pressed': c.consent === 'yes' ? 'true' : 'false',
          text: c.consent === 'yes' ? '✅ وافق' : 'آه، وافق', on: { click: function () { consent(c, 'yes'); } } }),
        ' ',
        el('button', { type: 'button', class: 'btn small', 'aria-pressed': c.consent === 'no' ? 'true' : 'false',
          text: c.consent === 'no' ? '❌ رفض' : 'لأ', on: { click: function () { consent(c, 'no'); } } }),
      ]));
    }

    var out = el('div', { class: 'q-out', role: 'group', 'aria-label': 'نتيجة التواصل' });
    [['active', '✅ ' + (c.role === 'seeker' ? 'لسه بيدوّر' : c.role === 'owner' ? 'لسه متاح' : 'اتأكد'), 'ok'],
     ['noanswer', '⏰ مردّش'], ['later', '🗓️ كلّمه بعدين'],
     ['closed', '✔️ ' + (c.role === 'seeker' ? 'لقى/اشترى' : c.role === 'owner' ? 'اتباع/اتأجر' : 'خلص')],
     ['wrong', '🚫 رقم غلط'], ['personal', '👤 مش شغل'], ['stop', '🙅 مش عايز تواصل']].forEach(function (o) {
      out.appendChild(el('button', { type: 'button', class: 'btn' + (o[2] ? ' ' + o[2] : ''), text: o[1], on: { click: function () { outcome(c, o[0]); } } }));
    });
    card.appendChild(out);
    card.appendChild(el('div', { class: 'q-more' }, [
      el('button', { type: 'button', class: 'btn small', text: '✏️ تعديل البيانات', on: { click: function () { openEditor(c.id); } } }),
      el('button', { type: 'button', class: 'btn small', text: '⏭️ تخطي دلوقتي', on: { click: function () { state.skipped[c.id] = 1; renderQueue(); } } }),
    ]));
  }

  function infoChips(c) {
    var box = el('div', { class: 'chips' });
    box.appendChild(chip(C.ROLE_AR[c.role] || 'غير مصنّف', c.role === 'other' || c.role === 'unit' ? 'warn' : ''));
    if (c.deal) box.appendChild(chip(c.deal === 'rent' ? 'إيجار' : 'بيع'));
    (c.types || []).forEach(function (t) { box.appendChild(chip(C.TYPE_AR[t] || t)); });
    (c.zones || []).forEach(function (z) { box.appendChild(chip('📍 ' + z)); });
    if (c.size) box.appendChild(chip(c.size + 'م'));
    if (c.price) box.appendChild(chip((c.role === 'seeker' ? 'ميزانية ' : 'سعر ') + C.fmtMoney(c.price)));
    if (c.furnished) box.appendChild(chip('مفروش'));
    if (c.consent === 'yes') box.appendChild(chip('✅ موافق على العروض'));
    if (c.consent === 'no') box.appendChild(chip('رفض العروض', 'off'));
    box.appendChild(chip(C.STATUS_AR[c.status] || c.status, c.status === 'active' ? '' : c.status === 'new' ? 'warn' : 'off'));
    return box;
  }

  function snapshot(c) { return JSON.parse(JSON.stringify(c)); }
  function outcome(c, key) {
    var before = snapshot(c);
    C.recordOutcome(c, key, Date.now());
    save();
    state.undo = before;
    toast('اتسجل: ' + C.OUTCOMES[key].label, function () {
      state.db.contacts[before.id] = before;
      save();
      render();
    });
    renderQueue();
    var h = $('qName');
    if (h) h.focus();
  }
  function consent(c, value) {
    C.setConsent(c, c.consent === value ? '' : value, Date.now());
    save();
    toast(c.consent === 'yes' ? 'اتسجلت موافقته على العروض' : c.consent === 'no' ? 'اتسجل إنه مش عايز عروض' : 'اتلغى التسجيل');
    renderQueue();
  }

  // ─── جهاتي ───
  function fillSelect(sel, pairs, value) {
    if (!sel.options.length) pairs.forEach(function (p) { sel.appendChild(el('option', { value: p[0], text: p[1] })); });
    sel.value = value;
  }
  function renderList() {
    var roles = [['all', 'كل الأدوار']].concat(Object.keys(C.ROLE_AR).map(function (k) { return [k, C.ROLE_AR[k]]; }));
    var statuses = [['all', 'كل الحالات'], ['due', 'مستحق التأكيد']].concat(Object.keys(C.STATUS_AR).map(function (k) { return [k, C.STATUS_AR[k]]; }));
    fillSelect($('lRole'), roles, state.list.role);
    fillSelect($('lStatus'), statuses, state.list.status);
    var q = C.norm(state.list.q), digits = q.replace(/\D/g, '');
    var due = {};
    if (state.list.status === 'due') C.buildQueue(contacts(), {}).forEach(function (x) { due[x.c.id] = 1; });
    var found = contacts().filter(function (c) {
      if (state.list.role !== 'all' && c.role !== state.list.role) return false;
      if (state.list.status === 'due' ? !due[c.id] : state.list.status !== 'all' && c.status !== state.list.status) return false;
      if (!q) return true;
      if (digits.length >= 4 && (c.phones || []).some(function (p) { return p.indexOf(digits.replace(/^0/, '')) !== -1; })) return true;
      return C.norm([c.name, c.notes, (c.labels || []).join(' '), (c.zones || []).join(' '), C.describe(c)].join(' ')).indexOf(q) !== -1;
    }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.name).localeCompare(String(b.name), 'ar'); });
    $('lCount').textContent = found.length + ' جهة' + (found.length > state.list.limit ? ' — معروض أول ' + state.list.limit : '');
    var ul = clear($('lItems'));
    found.slice(0, state.list.limit).forEach(function (c) {
      ul.appendChild(el('li', null, [el('button', { type: 'button', class: 'item', on: { click: function () { openEditor(c.id); } } }, [
        el('div', { class: 't', text: c.name || '(بدون اسم)' }),
        el('div', { class: 's', text: [C.ROLE_AR[c.role], C.describe(c), (c.phones || []).map(C.displayPhone).join(' / ') || 'بدون رقم', C.STATUS_AR[c.status]].filter(Boolean).join(' · ') }),
      ])]));
    });
    $('lMore').hidden = found.length <= state.list.limit;
  }

  // ─── نموذج الجهة (إضافة/تعديل) ───
  function field(labelText, input, full) { return el('div', { class: full ? 'full' : '' }, [el('label', { for: input.id, text: labelText }), input]); }
  function select(id, pairs, value) {
    var s = el('select', { id: id });
    pairs.forEach(function (p) { s.appendChild(el('option', { value: p[0], text: p[1] })); });
    s.value = value == null ? '' : value;
    return s;
  }
  function buildForm(box, c, prefix) {
    clear(box);
    var grid = el('div', { class: 'grid' });
    grid.appendChild(field('الاسم (زي ما بتحب تشوفه)', el('input', { type: 'text', id: prefix + 'name', value: c.name || '', required: true, autocomplete: 'off' }), true));
    grid.appendChild(field('الأرقام (رقم في كل سطر)', el('textarea', { id: prefix + 'phones', rows: '2', dir: 'ltr', value: (c.phones || []).map(C.displayPhone).join('\n') }), true));
    grid.appendChild(field('الدور', select(prefix + 'role', Object.keys(C.ROLE_AR).map(function (k) { return [k, C.ROLE_AR[k]]; }), c.role || 'other')));
    grid.appendChild(field('المعاملة', select(prefix + 'deal', [['', 'غير محدد'], ['sale', 'بيع/شراء'], ['rent', 'إيجار']], c.deal || '')));
    var checks = el('div', { class: 'checks', id: prefix + 'types', role: 'group', 'aria-label': 'نوع الوحدة' });
    Object.keys(C.TYPE_AR).forEach(function (t) {
      checks.appendChild(el('label', null, [el('input', { type: 'checkbox', value: t, checked: (c.types || []).indexOf(t) !== -1 }), C.TYPE_AR[t]]));
    });
    grid.appendChild(el('div', { class: 'full' }, [el('label', { text: 'نوع الوحدة' }), checks]));
    var zl = el('datalist', { id: prefix + 'zonesList' });
    C.ZONE_NAMES.forEach(function (z) { zl.appendChild(el('option', { value: z })); });
    grid.appendChild(field('المنطقة (افصل بفاصلة)', el('input', { type: 'text', id: prefix + 'zones', list: prefix + 'zonesList', value: (c.zones || []).join('، ') }), true));
    grid.appendChild(zl);
    grid.appendChild(field('المساحة (م²)', el('input', { type: 'number', id: prefix + 'size', inputmode: 'numeric', min: '0', value: c.size ? String(c.size) : '' })));
    grid.appendChild(field('السعر أو الميزانية (جنيه)', el('input', { type: 'number', id: prefix + 'price', inputmode: 'numeric', min: '0', value: c.price ? String(c.price) : '' })));
    grid.appendChild(el('div', { class: 'full checks' }, [el('label', null, [el('input', { type: 'checkbox', id: prefix + 'furnished', checked: !!c.furnished }), 'مفروش'])]));
    var listings = [['', state.rows.length ? 'مش مربوط بإعلان' : 'إعلانات الموقع بتتحمّل…']].concat(state.rows.map(function (r) { return [r.u, r.t]; }));
    if (c.listing && !rowByUrl(c.listing)) listings.push([c.listing, c.listing]);
    grid.appendChild(field('صاحب إعلان على الموقع؟', select(prefix + 'listing', listings, c.listing || ''), true));
    grid.appendChild(field('الحالة', select(prefix + 'status', Object.keys(C.STATUS_AR).map(function (k) { return [k, C.STATUS_AR[k]]; }), c.status || 'new')));
    grid.appendChild(field('المتابعة القادمة', el('input', { type: 'date', id: prefix + 'nextAt', value: isoDay(c.nextAt) })));
    grid.appendChild(field('موافقة العروض', select(prefix + 'consent', [['', 'لسه متسألش'], ['yes', 'وافق'], ['no', 'رفض']], c.consent || '')));
    grid.appendChild(field('المصدر', select(prefix + 'source', Object.keys(SOURCES).map(function (k) { return [k, SOURCES[k]]; }), c.source || 'other')));
    grid.appendChild(field('ملاحظات', el('textarea', { id: prefix + 'notes', rows: '3', value: c.notes || '' }), true));
    box.appendChild(grid);
  }

  function readForm(prefix) {
    var v = function (k) { return $(prefix + k).value; };
    var types = Array.prototype.map.call(document.querySelectorAll('#' + prefix + 'types input:checked'), function (i) { return i.value; });
    var phones = [], bad = [];
    v('phones').split(/[\n,،]+/).forEach(function (raw) {
      if (!raw.trim()) return;
      var ph = C.normalizePhone(raw);
      if (ph.id) { if (phones.indexOf(ph.id) === -1) phones.push(ph.id); } else bad.push(raw.trim());
    });
    var next = v('nextAt') ? new Date(v('nextAt') + 'T09:00:00').getTime() : 0;
    return {
      name: v('name').trim(), phones: phones, bad: bad, role: v('role'), deal: v('deal'), types: types,
      zones: v('zones').split(/[,،]+/).map(function (z) { return z.trim(); }).filter(Boolean),
      size: Number(v('size')) || null, price: Number(v('price')) || null, furnished: $(prefix + 'furnished').checked,
      listing: v('listing'), status: v('status'), nextAt: next, consent: v('consent'), source: v('source'), notes: v('notes').trim(),
    };
  }

  function phoneOwner(phones, exceptId) {
    var all = contacts();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === exceptId) continue;
      for (var j = 0; j < phones.length; j++) if ((all[i].phones || []).indexOf(phones[j]) !== -1) return all[i];
    }
    return null;
  }

  /** يكتب قيم النموذج في الجهة، ويعلّم الحقول اللي اتغيرت يدويًا عشان الاستيراد الجاي ما يرجّعهاش. */
  function same(k, v) {
    if (k === 'furnished') return !!v;
    if (k === 'types' || k === 'zones') return v && v.length ? v : [];
    if (k === 'role' || k === 'deal') return v || '';
    return v ? v : null;
  }
  function applyForm(c, f, now) {
    c.manual = c.manual || {};
    C.AUTO_FIELDS.forEach(function (k) {
      if (JSON.stringify(same(k, c[k])) !== JSON.stringify(same(k, f[k]))) c.manual[k] = true;
      c[k] = f[k];
    });
    if (c.name !== f.name) c.manual.name = true;
    c.name = f.name;
    c.phones = f.phones;
    c.listing = f.listing;
    c.notes = f.notes;
    c.source = f.source;
    if (f.consent !== (c.consent || '')) C.setConsent(c, f.consent, now);
    if (f.status !== c.status) {
      c.history = c.history || [];
      c.history.push({ at: now, action: 'status-' + f.status });
      if (f.status === 'active' || f.status === 'closed') c.confirmedAt = now;
    }
    c.status = f.status;
    c.nextAt = f.nextAt;
    c.updatedAt = now;
  }

  // ─── المحرر ───
  function openEditor(id) {
    var c = state.db.contacts[id];
    if (!c) return;
    state.editing = id;
    if (!state.rows.length) loadRows();
    $('eTitle').textContent = 'تعديل: ' + (c.name || 'جهة');
    var phone = (c.phones || [])[0];
    clear($('eQuick'));
    if (phone) {
      $('eQuick').appendChild(el('a', { class: 'btn small', href: C.telLink(phone), text: '📞 اتصال' }));
      $('eQuick').appendChild(el('a', { class: 'btn small wa', href: C.waLink(phone, C.messageFor(c)), target: '_blank', rel: 'noopener noreferrer', text: '💬 واتساب' }));
    }
    buildForm($('eFields'), c, 'e_');
    var h = clear($('eHistory'));
    var names = { import: 'استيراد', active: 'اتأكد', noanswer: 'مردّش', later: 'بعدين', closed: 'خلص', wrong: 'رقم غلط', personal: 'شخصي', stop: 'مش عايز تواصل', 'consent-yes': 'وافق على العروض', 'consent-no': 'رفض العروض', create: 'إضافة يدوية' };
    (c.history || []).slice().reverse().forEach(function (x) {
      h.appendChild(el('li', { text: day(x.at) + ' — ' + (names[x.action] || x.action) + (x.note ? ' (' + x.note + ')' : '') }));
    });
    var d = $('editor');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeEditor() {
    var d = $('editor');
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
    state.editing = null;
  }

  // ─── إضافة ───
  var addDraft = null;
  function renderAdd() {
    if (!addDraft) addDraft = { name: '', phones: [], role: 'seeker', status: 'active', source: 'whatsapp', types: [], zones: [] };
    if (!state.rows.length) loadRows();
    buildForm($('aFields'), addDraft, 'a_');
  }

  // ─── الإعلانات ───
  function renderListings() {
    var st = $('rStatus');
    st.textContent = state.rowsState === 'loading' || state.rowsState === 'idle' ? 'بحمّل إعلانات الموقع…'
      : state.rowsState === 'error' ? 'مقدرتش أحمّل إعلانات الموقع — اتأكد من النت وارجع للتبويب ده.' : state.rows.length + ' إعلان داخل مدينة نصر';
    var q = C.norm($('rSearch').value);
    var all = contacts();
    var owners = {};
    all.forEach(function (c) { if (c.listing) (owners[c.listing] = owners[c.listing] || []).push(c); });
    var ul = clear($('rItems'));
    state.rows.filter(function (r) { return !q || C.norm(r.t + ' ' + (r.l || '')).indexOf(q) !== -1; }).forEach(function (r) {
      var own = owners[r.u] || [];
      var best = own.slice().sort(function (a, b) { return (b.confirmedAt || 0) - (a.confirmedAt || 0); })[0];
      var ownerText = !best ? 'المالك مش مربوط في الدفتر'
        : best.status === 'active' && best.confirmedAt ? '✅ متاح — اتأكد ' + day(best.confirmedAt)
        : best.status === 'closed' ? '❌ اتباع/اتأجر — ' + day(best.confirmedAt) + ' (شيله من الموقع)' : 'المالك: ' + best.name + ' — لسه مستني تأكيد';
      var seekers = C.matchSeekers(r, all, 30);
      var li = el('li', { class: 'card' }, [
        el('a', { href: safeHref(r.u), target: '_blank', rel: 'noopener', text: r.t }),
        el('div', { class: 'muted', text: [r.p, r.l].filter(Boolean).join(' · ') }),
        el('div', { class: 'chips' }, [chip(ownerText, best ? (best.status === 'closed' ? 'off' : best.status === 'active' ? '' : 'warn') : 'warn'),
          chip(seekers.length ? '👥 ' + seekers.length + ' طالب يناسبه' : 'مفيش طالب مطابق في الدفتر', seekers.length ? '' : 'warn')]),
      ]);
      if (best) li.appendChild(el('button', { type: 'button', class: 'btn small', text: '✏️ المالك', on: { click: function () { openEditor(best.id); } } }));
      if (seekers.length) {
        var det = el('details', null, [el('summary', { text: 'الطالبين اللي يناسبهم (الموافق على العروض الأول)' })]);
        var sl = el('ul', { class: 'list' });
        seekers.forEach(function (x) {
          var c = x.c, ph = c.phones[0];
          sl.appendChild(el('li', null, [
            el('div', { class: 'row split' }, [
              el('button', { type: 'button', class: 'item', on: { click: function () { openEditor(c.id); } } }, [
                el('div', { class: 't', text: c.name }),
                el('div', { class: 's', text: [C.describe(c), C.STATUS_AR[c.status], c.consent === 'yes' ? 'وافق على العروض' : c.consent === 'no' ? 'رفض العروض' : ''].filter(Boolean).join(' · ') }),
              ]),
              el('span', { class: 'row' }, [
                el('a', { class: 'btn small', href: C.telLink(ph), text: '📞' }),
                c.consent === 'no' ? null : el('a', { class: 'btn small wa', href: C.waLink(ph, C.offerMessage(c, r, ORIGIN)), target: '_blank', rel: 'noopener noreferrer', text: 'ابعت العرض' }),
              ]),
            ]),
          ]));
        });
        det.appendChild(sl);
        li.appendChild(det);
      }
      ul.appendChild(li);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = el('textarea', { value: text });
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  // ─── البيانات ───
  function renderData() {
    var all = contacts(), meta = state.db.meta || {};
    var withPhone = all.filter(function (c) { return (c.phones || []).length; }).length;
    var by = {};
    all.forEach(function (c) { by[c.role] = (by[c.role] || 0) + 1; });
    var st = {};
    all.forEach(function (c) { st[c.status] = (st[c.status] || 0) + 1; });
    var grid = el('div', { class: 'stat-grid' });
    [['جهات في الدفتر', all.length], ['بأرقام', withPhone], ['ملاك', by.owner || 0], ['طالبين', by.seeker || 0],
     ['حراس', by.doorman || 0], ['سماسرة', by.broker || 0], ['اتأكد', st.active || 0], ['خلص', st.closed || 0],
     ['متابعة', st.followup || 0], ['موافق على العروض', all.filter(function (c) { return c.consent === 'yes'; }).length]].forEach(function (x) {
      grid.appendChild(el('div', null, [el('b', { text: String(x[1]) }), x[0]]));
    });
    var stats = clear($('dStats'));
    stats.appendChild(grid);
    var size = 0;
    try { size = (localStorage.getItem(KEY) || '').length; } catch (e) { size = 0; }
    stats.appendChild(el('p', { class: 'muted', text: 'حجم الدفتر على الجهاز: ' + Math.round(size / 1024) + ' ك.ب' }));
    $('dBackupInfo').textContent = meta.lastBackupAt ? 'آخر نسخة احتياطية: ' + day(meta.lastBackupAt) : 'لسه ما نزّلتش أي نسخة احتياطية.';
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
  }

  function readFileText(file) {
    return file.arrayBuffer().then(function (buf) {
      var text = new TextDecoder('utf-8').decode(buf);
      if ((text.match(/\uFFFD/g) || []).length > 5) {
        try { text = new TextDecoder('windows-1256').decode(buf); } catch (e) { /* يبقى UTF-8 */ }
      }
      return text;
    });
  }

  function importFiles(files) {
    var box = clear($('dResult'));
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    box.appendChild(el('p', { class: 'muted', text: 'بقرا ' + list.length + ' ملف…' }));
    list.reduce(function (p, file) {
      return p.then(function () {
        return readFileText(file).then(function (text) {
          var parsed = C.parseFile(text, file.name);
          if (parsed.kind === 'calls') {
            var res = C.applyCallLog(state.db, parsed.calls);
            box.appendChild(el('p', { text: '📞 ' + file.name + ': ' + parsed.calls.length + ' مكالمة · ' + res.matched + ' جهة اتحدثت بآخر مكالمة · ' + res.unsaved.length + ' رقم متكرر مش متسجل.' }));
            renderUnsaved(res.unsaved);
          } else {
            var stt = C.mergeImport(state.db, parsed.contacts, { file: file.name, kind: parsed.kind });
            box.appendChild(el('p', { text: '👥 ' + file.name + ': اتقرا ' + stt.total + ' · اتضاف ' + stt.added + ' · اتحدّث ' + stt.updated +
              ' · بدون رقم ' + stt.noPhone + (stt.badPhones ? ' · أرقام شكلها غلط ' + stt.badPhones : '') }));
            if (stt.total && !stt.added && !stt.updated && !stt.unchanged) box.appendChild(el('p', { class: 'muted', text: 'الملف ده مفيهوش جهات مفهومة — جرّب تصدير VCF من contacts.google.com.' }));
          }
        });
      });
    }, Promise.resolve()).then(function () {
      state.matchCache = {};
      if (save()) {
        box.firstChild.textContent = '✅ اتحفظ على جهازك.';
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        if (!state.db.meta.lastBackupAt) notice('نزّل نسخة احتياطية بعد الاستيراد عشان البيانات متضيعش لو المتصفح اتمسح.', 'نزّل دلوقتي', doBackup);
      }
      renderData();
    }).catch(function (e) {
      box.appendChild(el('p', { class: 'muted', text: 'حصل خطأ في قراءة الملف: ' + (e && e.message ? e.message : e) }));
    });
  }

  function renderUnsaved(list) {
    var card = $('dUnsavedCard'), ul = clear($('dUnsaved'));
    card.hidden = !list.length;
    list.slice(0, 60).forEach(function (a) {
      ul.appendChild(el('li', { class: 'row split' }, [
        el('span', null, [el('span', { dir: 'ltr', text: C.displayPhone(a.phone) }), ' · ' + a.count + ' مكالمة · آخرها ' + day(a.last) + (a.name ? ' · ' + a.name : '')]),
        el('span', { class: 'row' }, [
          el('a', { class: 'btn small', href: C.telLink(a.phone), text: '📞' }),
          el('button', { type: 'button', class: 'btn small', text: '➕ أضف', on: { click: function () {
            addDraft = { name: a.name || '', phones: [a.phone], role: 'other', status: 'new', source: 'call', types: [], zones: [] };
            setTab('add');
          } } }),
        ]),
      ]));
    });
  }

  function doBackup() {
    var now = Date.now();
    state.db.meta.lastBackupAt = now;
    download('simsar-crm-backup-' + isoDay(now) + '.json', C.backup(state.db, now), 'application/json');
    save();
    $('notice').hidden = true;
    renderData();
  }

  // ─── ربط الأحداث ───
  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-goto')); });
    });
    var t = 0;
    $('lSearch').addEventListener('input', function (e) {
      clearTimeout(t);
      t = setTimeout(function () { state.list.q = e.target.value; state.list.limit = 60; renderList(); }, 150);
    });
    $('lRole').addEventListener('change', function (e) { state.list.role = e.target.value; state.list.limit = 60; renderList(); });
    $('lStatus').addEventListener('change', function (e) { state.list.status = e.target.value; state.list.limit = 60; renderList(); });
    $('lMore').addEventListener('click', function () { state.list.limit += 60; renderList(); });
    $('rSearch').addEventListener('input', function () { renderListings(); });
    $('rReport').addEventListener('click', function () {
      if (!state.rows.length) { toast('إعلانات الموقع لسه ما اتحمّلتش'); return; }
      copyText(C.listingReport(state.rows, contacts())).then(function () { toast('اتنسخ التقرير — ابعته لتحديث الموقع'); }, function () { toast('مقدرتش أنسخ — جرّب تاني'); });
    });

    $('aParse').addEventListener('click', function () {
      var text = $('aPaste').value;
      if (!text.trim()) { toast('الصق الرسالة الأول'); return; }
      var p = C.parseQuick(text);
      var cur = readForm('a_');
      addDraft = {
        name: cur.name, phones: cur.phones.length ? cur.phones : p.phones, role: p.role || cur.role, deal: p.deal || cur.deal,
        types: p.types.length ? p.types : cur.types, zones: p.zones.length ? p.zones : cur.zones, size: p.size || cur.size,
        price: p.price || cur.price, furnished: p.furnished || cur.furnished, status: cur.status, source: cur.source,
        consent: cur.consent, listing: cur.listing, notes: [cur.notes, text.trim()].filter(Boolean).join('\n').slice(0, 1000),
      };
      buildForm($('aFields'), addDraft, 'a_');
      toast('اتملت الخانات — راجعها وصحّح لو لزم');
    });
    $('aForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = readForm('a_'), now = Date.now();
      if (!f.name && !f.phones.length) { toast('اكتب اسم أو رقم على الأقل'); return; }
      if (f.bad.length) { toast('الرقم ده شكله غلط: ' + f.bad[0]); return; }
      var existing = phoneOwner(f.phones, null);
      var c;
      if (existing) {
        c = existing;
        f.phones = f.phones.concat((c.phones || []).filter(function (p) { return f.phones.indexOf(p) === -1; }));
        if (!f.name) f.name = c.name;
        if (c.notes && f.notes.indexOf(c.notes) === -1) f.notes = [c.notes, f.notes].filter(Boolean).join('\n');
        applyForm(c, f, now);
        c.history.push({ at: now, action: 'update', note: 'إضافة سريعة' });
      } else {
        var id = 'c' + (++state.db.seq);
        c = { id: id, name: '', phones: [], labels: [], status: 'new', manual: {}, history: [{ at: now, action: 'create' }], createdAt: now };
        applyForm(c, f, now);
        if (!c.name) c.name = C.displayPhone(c.phones[0]);
        if (c.status === 'active' && !c.confirmedAt) c.confirmedAt = now;
        state.db.contacts[id] = c;
      }
      save();
      state.matchCache = {};
      addDraft = null;
      $('aPaste').value = '';
      renderAdd();
      toast(existing ? 'اتحدّثت الجهة الموجودة: ' + c.name : 'اتضافت: ' + c.name);
    });

    $('eForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var c = state.db.contacts[state.editing];
      if (!c) { closeEditor(); return; }
      var f = readForm('e_');
      if (!f.name) { toast('الاسم مطلوب'); return; }
      if (f.bad.length) { toast('الرقم ده شكله غلط: ' + f.bad[0]); return; }
      var dup = phoneOwner(f.phones, c.id);
      if (dup) { toast('الرقم ده متسجل لجهة تانية: ' + dup.name); return; }
      applyForm(c, f, Date.now());
      save();
      state.matchCache = {};
      closeEditor();
      toast('اتحفظ');
      render();
    });
    $('eCancel').addEventListener('click', closeEditor);
    $('editor').addEventListener('close', function () { state.editing = null; });
    $('eDelete').addEventListener('click', function () {
      var c = state.db.contacts[state.editing];
      if (!c || !window.confirm('تحذف «' + c.name + '» من الدفتر؟')) return;
      var before = snapshot(c);
      delete state.db.contacts[c.id];
      save();
      closeEditor();
      toast('اتحذفت', function () { state.db.contacts[before.id] = before; save(); render(); });
      render();
    });

    $('dImport').addEventListener('change', function (e) { importFiles(e.target.files); e.target.value = ''; });
    $('dBackup').addEventListener('click', doBackup);
    $('dCsv').addEventListener('click', function () { download('simsar-crm-' + isoDay(Date.now()) + '.csv', C.toCsv(contacts()), 'text/csv;charset=utf-8'); });
    $('dRestore').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      readFileText(file).then(function (text) {
        var db = C.restore(text);
        var n = Object.keys(db.contacts).length;
        if (!window.confirm('النسخة فيها ' + n + ' جهة. استرجاعها هيستبدل الدفتر الحالي على الجهاز ده. أكمّل؟')) return;
        state.db = db;
        state.matchCache = {};
        save();
        toast('اترجعت النسخة: ' + n + ' جهة');
        render();
      }).catch(function () { toast('الملف ده مش نسخة احتياطية صالحة'); });
    });
    $('dWipe').addEventListener('click', function () {
      var answer = window.prompt('ده هيمسح كل الجهات من الجهاز ده نهائيًا. اكتب «امسح» للتأكيد:');
      if (answer == null || answer.trim() !== 'امسح') return;
      try { localStorage.removeItem(KEY); } catch (e) { /* لا شيء */ }
      state.db = C.emptyDb();
      state.skipped = {};
      state.matchCache = {};
      toast('اتمسح الدفتر من الجهاز ده');
      render();
    });
  }

  function backupReminder() {
    var meta = state.db.meta || {}, n = Object.keys(state.db.contacts).length;
    if (!n) return;
    var stale = !meta.lastBackupAt || Date.now() - meta.lastBackupAt > 7 * C.DAY;
    if (stale && (meta.updatedAt || 0) > (meta.lastBackupAt || 0)) {
      notice(meta.lastBackupAt ? 'آخر نسخة احتياطية من أكتر من أسبوع.' : 'لسه ما نزّلتش نسخة احتياطية من الدفتر.', 'نزّل نسخة', doBackup);
    }
  }

  function start() {
    if (!C) { notice('الأداة ما اتحمّلتش كويس — حدّث الصفحة.'); return; }
    load();
    bind();
    backupReminder();
    if (location.hash && /^#(queue|list|add|listings|data)$/.test(location.hash)) setTab(location.hash.slice(1));
    else setTab(Object.keys(state.db.contacts).length ? 'queue' : 'data');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
