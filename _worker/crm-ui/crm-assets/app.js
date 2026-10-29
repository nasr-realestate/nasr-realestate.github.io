import { CRMApiError, CRMClient } from '../crm-client.js';

const PUBLIC_SITE_ORIGIN = 'https://nasr-realestate.github.io';
const $ = selector => document.querySelector(selector);
const state = {
  api: null,
  contactId: null,
  opportunityId: null,
  oppTrackFilter: 'live',
  oppRoleFilter: '',
  contactTrackFilter: '',
  contacts: [],
  opportunities: [],
  listings: [],
  pushPublicKey: '',
  pushEndpoint: '',
  deferredInstallPrompt: null,
  sheetHistoryPushed: false,
  lastActionToast: '',
};

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  const installBtn = $('#pwa-install-btn');
  if (installBtn && !isStandalonePwa()) installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  state.deferredInstallPrompt = null;
  const installBtn = $('#pwa-install-btn');
  if (installBtn) installBtn.hidden = true;
});

window.addEventListener('popstate', () => {
  const sheet = $('#record-sheet');
  if (sheet && !sheet.hidden) {
    state.sheetHistoryPushed = false;
    closeRecordSheet({ fromPopState: true });
  }
});

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeRecordSheet();
});

const STATUS_LABELS = {
  active: 'نشطة',
  visit_scheduled: 'معاينة مجدولة',
  viewing_done: 'تمت المعاينة',
  offer: 'عرض سعر',
  negotiating: 'تفاوض',
  near_close: 'قرب الإغلاق',
  won: 'تمت الصفقة',
  lost: 'لم تتم',
  paused: 'مؤجلة',
  unqualified: 'غير مؤهلة',
};
const INTENT_LABELS = { buy: 'مشتري', rent: 'مستأجر', sell: 'مالك بيع', lease: 'مالك إيجار', other: 'أخرى' };
const TRACK_ORDER = ['sale_apt', 'furnished_apt', 'new_rent_apt', 'admin_hq', 'transient'];
const TRACK_META = {
  sale_apt: { badge: '🟢', short: '🟢 بيع', label: '🟢 شقق للبيع', defaultProp: 'شقة', defaultIntent: 'sell' },
  furnished_apt: { badge: '🔴', short: '🔴 مفروش', label: '🔴 شقق مفروشة', defaultProp: 'شقة مفروشة', defaultIntent: 'lease' },
  new_rent_apt: { badge: '🔵', short: '🔵 إيجار جديد', label: '🔵 شقق إيجار جديد', defaultProp: 'شقة إيجار جديد', defaultIntent: 'lease' },
  admin_hq: { badge: '🟡', short: '🟡 إداري/تجاري', label: '🟡 مقرات ومكاتب إدارية', defaultProp: 'مقر إداري', defaultIntent: 'lease' },
  transient: { badge: '✈️', short: '✈️ طيارة', label: '✈️ طيارة (عميل عابر)', defaultProp: 'شقة', defaultIntent: 'buy' },
};

function trackBadge(code) {
  return TRACK_META[code]?.badge || '🟢';
}

function trackShort(code) {
  return TRACK_META[code]?.short || '🟢 بيع';
}

function formatContactTracks(tracksCsv) {
  const codes = String(tracksCsv || '').split(',').filter(Boolean);
  if (!codes.length) return '';
  return codes.map(trackBadge).join(' ');
}

function node(tag, text = '', className = '') {
  const element = document.createElement(tag);
  if (text !== '') element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function button(text, onClick, className = 'button') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

function telHref(phoneKey) {
  const digits = String(phoneKey || '').replaceAll(/\D/g, '');
  return digits ? `tel:+${digits}` : '';
}

function publicPropertyUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/properties/')) return `${PUBLIC_SITE_ORIGIN}${raw}`;
  if (raw.startsWith(`${PUBLIC_SITE_ORIGIN}/properties/`)) return raw;
  return '';
}

async function copyTextWithFeedback(btn, text, doneLabel = 'تم النسخ ✓') {
  const original = btn.textContent;
  try {
    await navigator.clipboard?.writeText?.(text);
    btn.textContent = doneLabel;
  } catch {
    btn.textContent = text;
  }
  setTimeout(() => { btn.textContent = original; }, 1800);
}

function buildReadyFollowupMessage(name, intent, areaLabel) {
  const cleanName = String(name || '').trim() || 'فندم';
  const area = String(areaLabel || '').trim() || 'مدينة نصر';
  if (intent === 'buy' || intent === 'rent') {
    return `السلام عليكم أ/ ${cleanName}، معك طارق طنطاوي (سمسار طلبك - مدينة نصر). تتوفر لدينا خيارات مطابقة لطلبك في ${area}، متى يناسبك استعراض التفاصيل أو ترتيب معاينة؟`;
  }
  return `السلام عليكم أ/ ${cleanName}، معك طارق طنطاوي (سمسار طلبك - مدينة نصر) بخصوص الوحدة المعروضة في ${area} — هل ما زالت متاحة حاليًا لترتيب معاينة مع عميل جاد؟`;
}

function setNotice(element, text, kind = 'info') {
  element.textContent = text;
  element.className = `notice ${kind}`;
  element.hidden = !text;
}

function errorText(error) {
  if (error instanceof CRMApiError) return error.message;
  if (error?.name === 'AbortError') return 'أُلغي الطلب.';
  return 'حدث خطأ غير متوقع. لم يتم تأكيد حفظ البيانات.';
}

function showRecordSheet(badgeText = 'ملف العميل') {
  const sheet = $('#record-sheet');
  if (!sheet) return;
  const badge = $('#record-sheet-badge');
  if (badge) badge.textContent = badgeText;
  const wasHidden = sheet.hidden;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  if (wasHidden && !state.sheetHistoryPushed && typeof window.history?.pushState === 'function') {
    window.history.pushState({ crmSheet: true }, '');
    state.sheetHistoryPushed = true;
  }
}

function closeRecordSheet({ fromPopState = false } = {}) {
  const sheet = $('#record-sheet');
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  state.lastActionToast = '';
  if (!fromPopState && state.sheetHistoryPushed && typeof window.history?.back === 'function') {
    state.sheetHistoryPushed = false;
    window.history.back();
  }
}

function markSelectedRecord(recordId) {
  for (const el of document.querySelectorAll('.record[data-record-id]')) {
    el.classList.toggle('selected', Boolean(recordId) && el.dataset.recordId === recordId);
  }
}

function clearWorkspaceDom() {
  closeRecordSheet({ fromPopState: true });
  state.contactId = null;
  state.opportunityId = null;
  state.contacts = [];
  state.opportunities = [];
  state.listings = [];
  state.pushPublicKey = '';
  state.pushEndpoint = '';
  $('#dashboard-metrics').replaceChildren();
  $('#track-hub-grid')?.replaceChildren();
  $('#due-list').replaceChildren();
  $('#overdue-list').replaceChildren();
  $('#contact-results').replaceChildren();
  $('#contact-detail').replaceChildren(node('p', 'اختر عميلًا لعرض ملفه وأرقامه وفرصه.', 'muted'));
  $('#opportunity-results').replaceChildren();
  $('#opportunity-detail').replaceChildren(node('p', 'اختر فرصة لعرض نشاطها والعقارات المرتبطة بها.', 'muted'));
  $('#record-sheet-body')?.replaceChildren();
  $('#opportunity-contact').replaceChildren(new Option('اختر عميلًا…', ''));
  const quickSelect = $('#quick-listing-select');
  if (quickSelect) quickSelect.replaceChildren(new Option('بدون ربط مباشر الآن…', ''));
  $('#due-count').textContent = '0';
  $('#overdue-count').textContent = '0';
  $('#contact-search-state').textContent = '';
}

function lockWorkspace(statusMessage = 'أدخل رمز الدخول للوصول إلى إدارة العملاء.', { clearInput = true } = {}) {
  clearWorkspaceDom();
  $('#crm-workspace').hidden = true;
  $('#refresh-all').hidden = true;
  $('#logout-button').hidden = true;
  $('#login-panel').hidden = false;
  if (clearInput) $('#access-code-input').value = '';
  $('#security-status').textContent = 'جلسة خاصة · يتطلب رمز الدخول';
  setNotice($('#app-status'), statusMessage, 'info');
}

function unlockWorkspace() {
  $('#login-panel').hidden = true;
  $('#crm-workspace').hidden = false;
  $('#refresh-all').hidden = false;
  $('#logout-button').hidden = false;
  $('#access-code-input').value = '';
  $('#login-feedback').textContent = '';
  $('#security-status').textContent = 'جلسة موثقة ومحمية';
}

function clearError() {
  setNotice($('#load-error'), '', 'error');
}

function showError(error) {
  if (error instanceof CRMApiError && error.status === 401) {
    lockWorkspace('انتهت الجلسة أو يلزم تسجيل الدخول مجددًا.');
  }
  setNotice($('#load-error'), errorText(error), 'error');
  if (!(error instanceof CRMApiError && error.status === 401)) {
    setNotice($('#app-status'), 'تعذّر تحديث بيانات CRM.', 'info');
    $('#security-status').textContent = 'الاتصال غير متاح';
  }
}

function dateLabel(value) {
  if (!value) return 'غير محدد';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusLabel(value) {
  return STATUS_LABELS[value] || value || '—';
}

function intentLabel(value) {
  return INTENT_LABELS[value] || value || '—';
}

function money(value) {
  if (value === null || value === undefined || value === '') return '—';
  return `${new Intl.NumberFormat('ar-EG').format(Number(value))} ج.م`;
}

function formatBudgetRange(minVal, maxVal) {
  if (minVal && maxVal && Number(minVal) !== Number(maxVal)) return `${money(minVal)} – ${money(maxVal)}`;
  return money(maxVal ?? minVal);
}

function formatSizeRange(minVal, maxVal) {
  const v = maxVal ?? minVal;
  if (!v) return 'غير محدد';
  if (minVal && maxVal && Number(minVal) !== Number(maxVal)) return `${minVal} – ${maxVal} م²`;
  return `${v} م²`;
}

function isoFromLocal(value) {
  return value ? new Date(value).toISOString() : null;
}

function requireApi() {
  if (!state.api) throw new CRMApiError('configuration', 'واجهة API غير مهيأة. لا تُرسل أي بيانات.');
  return state.api;
}

function openPanel(panelId, { preserveScroll = false, keepSheet = false } = {}) {
  const target = document.getElementById(panelId);
  const wasAlreadyOpen = target && !target.hidden;
  if (!keepSheet) closeRecordSheet();
  document.querySelectorAll('.panel').forEach(panel => { panel.hidden = panel.id !== panelId; });
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.panel === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (!preserveScroll && !wasAlreadyOpen) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function setBusy(buttonElement, busy, label = 'جارٍ الحفظ…') {
  if (!buttonElement.dataset.originalLabel) buttonElement.dataset.originalLabel = buttonElement.textContent;
  buttonElement.disabled = busy;
  buttonElement.textContent = busy ? label : buttonElement.dataset.originalLabel;
}

function pushText(parent, label, value) {
  const p = node('p');
  const strong = node('strong', `${label}: `);
  const display = value === null || value === undefined || value === '' ? '—' : String(value);
  p.append(strong, document.createTextNode(display));
  parent.append(p);
}

function appendRecordTags(item, meta) {
  if (!meta.length) return;
  const tags = node('span', '', 'record-meta');
  for (const entry of meta) {
    if (entry && typeof entry === 'object') {
      tags.append(node('span', entry.text, entry.cls || 'pill'));
    } else if (entry) {
      tags.append(node('span', entry, 'pill'));
    }
  }
  item.append(tags);
}

function clickableRecord(title, subtitle, onClick, meta = [], recordId = '') {
  const item = button('', async () => {
    item.classList.add('loading');
    try {
      await onClick();
    } catch (error) {
      showError(error);
    } finally {
      item.classList.remove('loading');
    }
  }, 'record');
  if (recordId) {
    item.dataset.recordId = recordId;
    if (recordId === state.opportunityId || recordId === state.contactId) item.classList.add('selected');
  }
  const head = node('div', '', 'record-head');
  head.append(node('strong', title), node('span', 'فتح وإجراء ←', 'record-open-hint'));
  item.append(head, node('small', subtitle));
  appendRecordTags(item, meta);
  return item;
}

function buildPhoneRow({ phone = '', label = '', primary = false } = {}) {
  const fragment = $('#phone-row-template').content.cloneNode(true);
  const row = fragment.querySelector('.phone-row');
  row.querySelector('[data-phone]').value = phone;
  row.querySelector('[data-label]').value = label;
  row.querySelector('[data-primary]').checked = primary;
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  $('#new-contact-phones').append(fragment);
}

function renderTrackHub(tracksMap = {}) {
  const grid = $('#track-hub-grid');
  if (!grid) return;
  grid.replaceChildren();
  for (const code of TRACK_ORDER) {
    const meta = TRACK_META[code];
    const stats = tracksMap[code] || { total: 0, supply: 0, demand: 0 };
    const card = button('', () => selectOpportunityTrackFilter(code, { switchPanel: true }), `track-card track-card-${code}`);
    const subText = code === 'transient'
      ? 'محفوظ بالأرشيف خارج التنبيهات'
      : `${stats.supply || 0} ملاك · ${stats.demand || 0} باحثون`;
    card.append(
      node('span', meta.label, 'track-card-title'),
      node('b', String(stats.total ?? 0), 'track-card-count'),
      node('small', subText, 'track-card-sub'),
    );
    grid.append(card);
  }
}

async function loadDashboard() {
  const day = $('#dashboard-day').value || undefined;
  const result = await requireApi().getDashboard(day);
  const counts = result.counts || {};
  const metrics = $('#dashboard-metrics');
  metrics.replaceChildren();
  const cards = [
    ['فرص نشطة (بدون ✈️)', counts.active],
    ['مستحق اليوم', counts.due_today],
    ['متأخر', counts.overdue],
    ['تحتاج خطوة تالية', counts.missing_next_step],
  ];
  for (const [label, value] of cards) {
    const card = node('div', '', 'metric');
    card.append(node('span', label), node('b', value ?? 0));
    metrics.append(card);
  }
  renderTrackHub(result.tracks || {});
  renderDueList($('#due-list'), result.due_today || []);
  renderDueList($('#overdue-list'), result.overdue || []);
  $('#due-count').textContent = String(counts.due_today ?? 0);
  $('#overdue-count').textContent = String(counts.overdue ?? 0);
}

function renderDueList(container, rows) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(node('p', 'لا توجد متابعة في هذه القائمة.', 'muted'));
    return;
  }
  for (const row of rows) {
    const item = clickableRecord(
      `${trackBadge(row.track)} ${row.name || row.contact_name || 'عميل'}`,
      `${row.next_action || 'لا يوجد إجراء'} · ${dateLabel(row.next_followup_at)}`,
      () => openOpportunity(row.id),
      [intentLabel(row.intent), statusLabel(row.status)],
      row.id,
    );
    container.append(item);
  }
}

function prettyPhone(value) {
  return String(value || '').replace(/^20/, '+20 ');
}

function consentLabel(value) {
  if (value === 'marketing_yes') return 'موافقة عروض مسجلة';
  if (value === 'do_not_contact') return 'عدم التواصل';
  return 'متابعة الطلب فقط';
}

function syncOpportunityContactSelect(contacts) {
  const select = $('#opportunity-contact');
  const oldValue = select.value;
  select.replaceChildren(new Option('اختر عميلًا…', ''));
  for (const contact of contacts) {
    const phoneSuffix = contact.primary_phone ? ` · ${prettyPhone(contact.primary_phone)}` : '';
    select.add(new Option(`${contact.name || 'عميل'}${phoneSuffix}`, contact.id));
  }
  if (contacts.some(contact => contact.id === oldValue)) select.value = oldValue;
}

function renderSingleContactRow(contact) {
  const numbers = (contact.phone_numbers || '').split(',').filter(Boolean);
  const subtitle = numbers.length ? numbers.map(prettyPhone).join(' · ') : 'محادثة مسجلة بدون رقم هاتف بعد — اضغط لإضافته';
  const badges = formatContactTracks(contact.tracks);
  const titlePrefix = badges ? `${badges} ` : '';
  const metaTags = [`${contact.opportunity_count || 0} فرصة`];
  if (!numbers.length) metaTags.push({ text: 'بدون رقم محفوظ', cls: 'pill warn-pill' });
  if (contact.communication_consent === 'do_not_contact') metaTags.push('عدم التواصل');
  return clickableRecord(
    `${titlePrefix}${contact.name || 'عميل بلا اسم'}`,
    subtitle,
    () => openContact(contact.id),
    metaTags,
    contact.id,
  );
}

async function loadContacts(query = $('#contact-search')?.value?.trim() || '', track = state.contactTrackFilter) {
  $('#contact-search-state').textContent = 'جارٍ البحث…';
  const result = await requireApi().searchContacts(query, track);
  state.contacts = result.contacts || [];
  const list = $('#contact-results');
  list.replaceChildren();
  if (!state.contacts.length) {
    const emptyText = query || track ? 'لا توجد نتائج مطابقة.' : 'لا يوجد عملاء بعد. أضف أول عميل يدويًا.';
    list.append(node('p', emptyText, 'muted'));
  }
  for (const contact of state.contacts) list.append(renderSingleContactRow(contact));
  $('#contact-search-state').textContent = `${state.contacts.length} سجل`;
  if (!query && !track) syncOpportunityContactSelect(state.contacts);
}

async function syncBackgroundListsQuietly() {
  try {
    await Promise.all([
      loadDashboard(),
      loadOpportunities($('#opportunity-search').value, $('#opportunity-status').value),
      loadContacts($('#contact-search').value.trim(), state.contactTrackFilter),
    ]);
  } catch {
    // Keep sheet responsive even if background refresh fails momentarily.
  }
}

function buildPhoneCommRow(phone, contextInfo) {
  const row = node('div', '', 'comm-phone-row');
  const info = node('div');
  const labelSuffix = phone.is_primary ? ' · أساسي' : '';
  info.append(
    node('span', prettyPhone(phone.phone_key), 'phone-number'),
    node('small', `${phone.label || 'واتساب'}${labelSuffix}`, 'muted'),
  );
  const btns = node('div', '', 'comm-phone-btns');
  const callLink = node('a', '📞 اتصال الآن', 'button primary small');
  callLink.href = telHref(phone.phone_key);
  const copyNumBtn = button('📋 نسخ الرقم', () => {
    void copyTextWithFeedback(copyNumBtn, `+${phone.phone_key}`);
  }, 'button small');
  const copyMsgBtn = button('💬 نسخ رسالة متابعة', () => {
    const msg = buildReadyFollowupMessage(contextInfo.name, contextInfo.intent, contextInfo.areaLabel);
    void copyTextWithFeedback(copyMsgBtn, msg, 'تم نسخ الرسالة ✓');
  }, 'button small');
  btns.append(callLink, copyNumBtn, copyMsgBtn);
  row.append(info, btns);
  return row;
}

function buildInlineMissingPhoneBox(contactId, onSaved) {
  const box = node('div', '', 'missing-phone-box');
  box.append(node('strong', '📱 هذا العميل بدون رقم هاتف محفوظ — أضف رقمه بلمسة واحدة:'));
  const form = node('form', '', 'inline-phone-form');
  const input = node('input');
  input.type = 'tel';
  input.inputMode = 'tel';
  input.required = true;
  input.maxLength = 32;
  input.placeholder = '010... أو +20...';
  const saveBtn = node('button', 'حفظ الرقم فورًا', 'button primary small');
  saveBtn.type = 'submit';
  const feedback = node('span', '', 'muted');
  form.append(input, saveBtn);
  box.append(form, feedback);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(saveBtn, true);
    try {
      await requireApi().addPhone(contactId, { phone: input.value.trim(), label: 'أساسي', is_primary: true });
      state.lastActionToast = '✓ تم حفظ رقم الهاتف وتفعيل الاتصال المباشر';
      void syncBackgroundListsQuietly();
      await onSaved();
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(saveBtn, false);
    }
  });
  return box;
}

function buildSheetCommSection(contactId, phones, contextInfo, onSaved) {
  if (!phones.length) return buildInlineMissingPhoneBox(contactId, onSaved);
  const box = node('section', '', 'comm-box');
  for (const phone of phones) box.append(buildPhoneCommRow(phone, contextInfo));
  return box;
}

function nextSlotIso(daysOffset, hour24) {
  const d = new Date();
  d.setSeconds(0, 0);
  if (daysOffset === 0 && d.getHours() >= hour24) {
    d.setDate(d.getDate() + 1);
  } else {
    d.setDate(d.getDate() + daysOffset);
  }
  d.setHours(hour24, 0, 0, 0);
  return d.toISOString();
}

function buildQuickActionSpecs() {
  return [
    {
      label: '📞 اتصلت — متابعة غدًا 1 ظ',
      payload: () => ({
        activity_type: 'call',
        status: 'active',
        summary: 'تم الاتصال بالعميل وتحديد متابعة غدًا',
        next_action: 'متابعة هاتفية مع العميل',
        next_followup_at: nextSlotIso(1, 13),
      }),
    },
    {
      label: '📵 لم يرد — محاولة غدًا 11 ص',
      payload: () => ({
        activity_type: 'missed_call',
        status: 'active',
        summary: 'محاولة اتصال — لم يرد العميل',
        next_action: 'إعادة الاتصال بالعميل',
        next_followup_at: nextSlotIso(1, 11),
      }),
    },
    {
      label: '📅 معاينة اليوم 6 مساءً',
      payload: () => ({
        activity_type: 'visit',
        status: 'visit_scheduled',
        summary: 'تم تحديد موعد معاينة الساعة 6 مساءً',
        next_action: 'موعد معاينة ميدانية',
        next_followup_at: nextSlotIso(0, 18),
      }),
    },
    {
      label: '📅 معاينة غدًا 2 ظهرًا',
      payload: () => ({
        activity_type: 'visit',
        status: 'visit_scheduled',
        summary: 'تم تحديد موعد معاينة غدًا الساعة 2 ظهرًا',
        next_action: 'موعد معاينة ميدانية',
        next_followup_at: nextSlotIso(1, 14),
      }),
    },
    {
      label: '📤 أرسلت عرضًا — بعد يومين',
      payload: () => ({
        activity_type: 'offer',
        status: 'offer',
        summary: 'تم إرسال تفاصيل/عرض عقار للعميل للمراجعة',
        next_action: 'معرفة رأي العميل في العرض المرسل',
        next_followup_at: nextSlotIso(2, 13),
      }),
    },
    {
      label: '🤝 دخلنا تفاوض جاد',
      payload: () => ({
        activity_type: 'offer',
        status: 'negotiating',
        summary: 'بدء التفاوض الفعلي على السعر والشروط',
        next_action: 'متابعة التفاوض وتقريب وجهات النظر',
        next_followup_at: nextSlotIso(1, 14),
      }),
    },
    {
      label: '⏳ تأجيل المتابعة أسبوعًا',
      payload: () => ({
        activity_type: 'note',
        status: 'active',
        summary: 'تأجيل المتابعة لمدة أسبوع بناءً على ظروف العميل',
        next_action: 'متابعة دورية بعد أسبوع',
        next_followup_at: nextSlotIso(7, 13),
      }),
    },
    {
      label: '✅ تمت الصفقة بنجاح',
      cls: 'button action-btn win-btn',
      payload: () => ({
        activity_type: 'status_change',
        status: 'won',
        summary: 'تم إتمام وتنفيذ الصفقة بنجاح',
        next_action: '',
        next_followup_at: null,
      }),
    },
  ];
}

function inferActiveTrackForOpportunity(opportunity) {
  const hay = `${opportunity.property_type || ''} ${opportunity.notes || ''}`;
  if (/مقر|إداري|اداري|مكتب|محل|تجاري|عيادة|عياده|مخزن/.test(hay)) return 'admin_hq';
  if (/مفروش/.test(hay)) return 'furnished_apt';
  if (opportunity.intent === 'rent' || opportunity.intent === 'lease') return 'new_rent_apt';
  return 'sale_apt';
}

function buildQuickActionPad(opportunity) {
  const pad = node('section', '', 'action-pad');
  pad.append(node('strong', '⚡ اتخذ إجراءً فوريًا بلمسة واحدة (يحفظ ويفعّل تنبيه الموبايل):'));
  const grid = node('div', '', 'action-pad-grid');
  const feedback = node('span', '', 'muted');
  feedback.setAttribute('aria-live', 'polite');
  for (const spec of buildQuickActionSpecs()) {
    const btn = button(spec.label, async () => {
      setBusy(btn, true, 'جارٍ الحفظ…');
      feedback.textContent = '';
      try {
        const body = spec.payload();
        if (opportunity.track === 'transient' && body.next_followup_at) {
          body.track = inferActiveTrackForOpportunity(opportunity);
        }
        await requireApi().addActivity(opportunity.id, body);
        state.lastActionToast = `✓ تم التنفيذ: ${spec.label}`;
        void syncBackgroundListsQuietly();
        await openOpportunity(opportunity.id);
      } catch (error) {
        feedback.textContent = errorText(error);
        setBusy(btn, false);
      }
    }, spec.cls || 'button action-btn');
    grid.append(btn);
  }
  pad.append(grid, feedback);
  return pad;
}

function buildUnitSiblingsBar(contactId, currentOppId, siblings) {
  const bar = node('div', '', 'unit-tabs');
  if (siblings.length > 1) {
    siblings.forEach((sib, idx) => {
      const active = sib.id === currentOppId;
      const lbl = `وحدة ${idx + 1}: ${trackShort(sib.track)} (${sib.area_label || 'مدينة نصر'})`;
      bar.append(button(lbl, () => {
        if (!active) void openOpportunity(sib.id);
      }, `chip small-chip${active ? ' active' : ''}`));
    });
  }
  bar.append(button('＋ إضافة فرصة/وحدة أخرى للعميل', () => {
    closeRecordSheet();
    openPanel('new-opportunity-panel');
    $('#opportunity-contact').value = contactId;
  }, 'button quiet small'));
  return bar;
}

function buildAddPhoneForm(contactId, onDone) {
  const addPhoneForm = node('form', '', 'activity-form');
  addPhoneForm.append(node('h3', 'إضافة رقم هاتف إضافي (حارس / ابن / معاينة)'));
  const phoneInput = node('input');
  phoneInput.type = 'tel';
  phoneInput.name = 'phone';
  phoneInput.required = true;
  phoneInput.placeholder = 'رقم الهاتف';
  phoneInput.autocomplete = 'tel';
  const labelInput = node('input');
  labelInput.name = 'label';
  labelInput.maxLength = 40;
  labelInput.placeholder = 'التسمية (مثال: الحارس، المعاينة، عمل)';
  const primaryLabel = node('label', '', 'primary-check');
  const primaryInput = node('input');
  primaryInput.type = 'checkbox';
  primaryInput.name = 'is_primary';
  primaryLabel.append(primaryInput, document.createTextNode('جعله الرقم الأساسي'));
  const submit = node('button', 'إضافة الرقم', 'button primary small');
  submit.type = 'submit';
  const feedback = node('span', '', 'muted');
  feedback.setAttribute('aria-live', 'polite');
  addPhoneForm.append(phoneInput, labelInput, primaryLabel, submit, feedback);
  addPhoneForm.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(submit, true);
    try {
      await requireApi().addPhone(contactId, {
        phone: phoneInput.value,
        label: labelInput.value,
        is_primary: primaryInput.checked,
      });
      state.lastActionToast = '✓ تمت إضافة الرقم الجديد بنجاح';
      void syncBackgroundListsQuietly();
      await onDone();
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(submit, false);
    }
  });
  return addPhoneForm;
}

function buildQuickContactUpdateForm(contact, onDone) {
  const form = node('form', '', 'activity-form');
  form.append(node('h3', 'تحديث الاسم أو الرقم الأساسي'));
  const nameInput = node('input');
  nameInput.name = 'name';
  nameInput.maxLength = 100;
  nameInput.required = true;
  nameInput.placeholder = 'اسم العميل أو المالك';
  nameInput.value = contact.name || '';
  const phoneInput = node('input');
  phoneInput.type = 'tel';
  phoneInput.name = 'phone';
  phoneInput.maxLength = 32;
  phoneInput.placeholder = 'رقم أساسي جديد (اختياري: 010...)';
  const submit = node('button', 'حفظ الاسم والرقم', 'button primary small');
  submit.type = 'submit';
  const feedback = node('span', '', 'muted');
  feedback.setAttribute('aria-live', 'polite');
  form.append(nameInput, phoneInput, submit, feedback);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(submit, true);
    try {
      await requireApi().updateContact(contact.id, {
        name: nameInput.value.trim(),
        phone: phoneInput.value.trim() || undefined,
        label: 'أساسي',
        is_primary: true,
      });
      state.lastActionToast = '✓ تم تحديث بيانات العميل';
      void syncBackgroundListsQuietly();
      await onDone();
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(submit, false);
    }
  });
  return form;
}

function appendUnifiedEditInputs(form, opportunity) {
  const nameInput = node('input');
  nameInput.name = 'contact_name';
  nameInput.maxLength = 100;
  nameInput.required = true;
  nameInput.value = opportunity.contact_name || '';
  const phoneInput = node('input');
  phoneInput.type = 'tel';
  phoneInput.name = 'phone';
  phoneInput.maxLength = 32;
  phoneInput.placeholder = 'تحديث الرقم الأساسي (اختياري)';
  const areaInput = node('input');
  areaInput.name = 'area_label';
  areaInput.maxLength = 100;
  areaInput.value = opportunity.area_label || '';
  const propInput = node('input');
  propInput.name = 'property_type';
  propInput.maxLength = 80;
  propInput.value = opportunity.property_type || '';
  const priceInput = node('input');
  priceInput.type = 'number';
  priceInput.name = 'price';
  priceInput.step = 'any';
  priceInput.min = '0';
  priceInput.value = opportunity.budget_max ?? opportunity.budget_min ?? '';
  const sizeInput = node('input');
  sizeInput.type = 'number';
  sizeInput.name = 'size';
  sizeInput.step = 'any';
  sizeInput.min = '0';
  sizeInput.value = opportunity.size_max_m2 ?? opportunity.size_min_m2 ?? '';
  const notesInput = node('textarea');
  notesInput.name = 'notes';
  notesInput.rows = 3;
  notesInput.maxLength = 1200;
  notesInput.value = opportunity.notes || '';

  const wrapField = (lbl, el, full = false) => {
    const l = node('label', lbl, full ? 'full' : '');
    l.append(el);
    return l;
  };
  form.append(
    wrapField('اسم العميل / المالك', nameInput),
    wrapField('رقم هاتف جديد (اختياري)', phoneInput),
    wrapField('المنطقة / الشارع', areaInput),
    wrapField('نوع العقار', propInput),
    wrapField('السعر أو الميزانية (ج.م)', priceInput),
    wrapField('المساحة (م²)', sizeInput),
    wrapField('الملاحظات والتفاصيل', notesInput, true),
  );
  return { nameInput, phoneInput, areaInput, propInput, priceInput, sizeInput, notesInput };
}

function buildUnifiedQuickEditDetails(opportunity) {
  const details = node('details', '', 'drawer-details');
  details.append(node('summary', '✏️ تعديل سريع للاسم أو الرقم أو السعر أو المساحة أو الملاحظات'));
  const form = node('form', '', 'form-grid');
  const fields = appendUnifiedEditInputs(form, opportunity);
  const actions = node('div', '', 'full form-actions');
  const submit = node('button', 'حفظ التعديلات فورًا', 'button primary small');
  submit.type = 'submit';
  const feedback = node('span', '', 'muted');
  actions.append(submit, feedback);
  form.append(actions);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(submit, true);
    try {
      const priceVal = fields.priceInput.value ? Number(fields.priceInput.value) : null;
      const sizeVal = fields.sizeInput.value ? Number(fields.sizeInput.value) : null;
      await requireApi().updateContact(opportunity.contact_id, {
        name: fields.nameInput.value.trim(),
        phone: fields.phoneInput.value.trim() || undefined,
        label: 'أساسي',
        is_primary: true,
      });
      await requireApi().updateOpportunity(opportunity.id, {
        area_label: fields.areaInput.value.trim(),
        property_type: fields.propInput.value.trim(),
        budget_min: priceVal,
        budget_max: priceVal,
        size_min_m2: sizeVal,
        size_max_m2: sizeVal,
        notes: fields.notesInput.value.trim(),
      });
      state.lastActionToast = '✓ تم حفظ التعديلات بنجاح';
      void syncBackgroundListsQuietly();
      await openOpportunity(opportunity.id);
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(submit, false);
    }
  });

  details.append(form, buildAddPhoneForm(opportunity.contact_id, () => openOpportunity(opportunity.id)));
  return details;
}

function renderContactPhonesSection(contactId, phones, onDone) {
  const phoneSection = node('section', '', 'detail-section');
  phoneSection.append(node('h3', 'أرقام الهاتف'));
  const phoneList = node('ul', '', 'detail-list');
  for (const phone of phones) {
    const li = node('li');
    const primarySuffix = phone.is_primary ? ' · أساسي' : '';
    const callLink = node('a', '📞 اتصال', 'button primary small');
    callLink.href = telHref(phone.phone_key);
    const copyBtn = button('نسخ الرقم', () => {
      void copyTextWithFeedback(copyBtn, `+${phone.phone_key}`);
    }, 'button small');
    const actions = node('span', '', 'phone-actions');
    actions.append(callLink, copyBtn);
    li.append(
      node('span', prettyPhone(phone.phone_key), 'phone-number'),
      document.createTextNode(` · ${phone.label || 'بدون تسمية'}${primarySuffix}`),
      actions,
    );
    phoneList.append(li);
  }
  if (!phones.length) phoneList.append(node('li', 'لا توجد أرقام مسجلة.', 'muted'));
  phoneSection.append(phoneList, buildAddPhoneForm(contactId, onDone));
  return phoneSection;
}

function renderContactOpportunitiesSection(contactId, opportunities) {
  const oppSection = node('section', '', 'detail-section');
  const oppHeading = node('div', '', 'card-heading');
  const addOppBtn = button('＋ فرصة جديدة للعميل', () => {
    closeRecordSheet();
    openPanel('new-opportunity-panel');
    $('#opportunity-contact').value = contactId;
  }, 'button primary small');
  oppHeading.append(node('h3', 'الفرص المرتبطة'), addOppBtn);
  oppSection.append(oppHeading);
  const oppList = node('div', '', 'stack');
  for (const opportunity of opportunities) {
    const specParts = [opportunity.area_label || 'مدينة نصر'];
    if (opportunity.size_max_m2) specParts.push(`${opportunity.size_max_m2} م²`);
    if (opportunity.budget_max) specParts.push(money(opportunity.budget_max));
    oppList.append(clickableRecord(
      `${trackShort(opportunity.track)} · ${intentLabel(opportunity.intent)}`,
      specParts.join(' · '),
      () => openOpportunity(opportunity.id),
      [statusLabel(opportunity.status), opportunity.next_action || 'بدون موعد مجدول'],
      opportunity.id,
    ));
  }
  if (!opportunities.length) oppList.append(node('p', 'لا توجد فرص مسجلة بعد — اضغط «＋ فرصة جديدة للعميل» لإضافة طلبه أو وحدته.', 'muted'));
  oppSection.append(oppList);
  return oppSection;
}

function populateContactDetailDom(contact, phones, opportunities) {
  const detail = $('#contact-detail');
  detail.replaceChildren();
  const heading = node('div', '', 'card-heading');
  heading.append(
    node('h2', contact.name || 'عميل بلا اسم'),
    node('span', consentLabel(contact.communication_consent), 'pill'),
  );
  const reloadContact = () => openContact(contact.id);
  detail.append(
    heading,
    buildQuickContactUpdateForm(contact, reloadContact),
    renderContactPhonesSection(contact.id, phones, reloadContact),
    renderContactOpportunitiesSection(contact.id, opportunities),
  );
}

function renderContactOnlySheet(contact, phones) {
  const body = $('#record-sheet-body');
  if (!body) return;
  body.replaceChildren();
  if (state.lastActionToast) body.append(node('div', state.lastActionToast, 'notice info'));
  const hero = node('div', '', 'sheet-hero');
  const titleEl = node('h2', contact.name || 'عميل بلا اسم');
  titleEl.id = 'record-sheet-title';
  hero.append(titleEl, node('small', consentLabel(contact.communication_consent), 'muted'));
  const reloadContact = () => openContact(contact.id);
  const createOppBar = node('div', '', 'action-pad');
  createOppBar.append(
    node('strong', 'هذا العميل مسجل بدون فرصة عقارية بعد:'),
    button('⚡ إضافة فرصة / وحدة لهذا العميل الآن', () => {
      closeRecordSheet();
      openPanel('new-opportunity-panel');
      $('#opportunity-contact').value = contact.id;
    }, 'button primary'),
  );
  body.append(
    hero,
    buildSheetCommSection(contact.id, phones, { name: contact.name, intent: 'sell', areaLabel: 'مدينة نصر' }, reloadContact),
    createOppBar,
    buildQuickContactUpdateForm(contact, reloadContact),
  );
}

async function openContact(contactId) {
  state.contactId = contactId;
  markSelectedRecord(contactId);
  showRecordSheet('ملف العميل');
  const sheetBody = $('#record-sheet-body');
  if (sheetBody) sheetBody.replaceChildren(node('p', 'جارٍ فتح ملف العميل وإجراءاته…', 'muted'));
  const detail = $('#contact-detail');
  detail.replaceChildren(node('p', 'جارٍ تحميل ملف العميل…', 'muted'));

  const result = await requireApi().getContact(contactId);
  const { contact } = result;
  const phones = result.phones || [];
  const opportunities = result.opportunities || [];
  populateContactDetailDom(contact, phones, opportunities);

  if (opportunities.length > 0) {
    await openOpportunity(opportunities[0].id, { keepContactHighlight: true });
    return;
  }
  renderContactOnlySheet(contact, phones);
}

function selectOpportunityTrackFilter(trackCode, { switchPanel = false } = {}) {
  state.oppTrackFilter = trackCode;
  for (const chip of document.querySelectorAll('[data-opp-track]')) {
    chip.classList.toggle('active', chip.dataset.oppTrack === trackCode);
  }
  if (switchPanel) openPanel('opportunities-panel');
  void loadOpportunities().catch(showError);
}

function selectOpportunityRoleFilter(roleCode) {
  state.oppRoleFilter = roleCode;
  for (const chip of document.querySelectorAll('[data-opp-role]')) {
    chip.classList.toggle('active', chip.dataset.oppRole === roleCode);
  }
  void loadOpportunities().catch(showError);
}

function selectContactTrackFilter(trackCode) {
  state.contactTrackFilter = trackCode;
  for (const chip of document.querySelectorAll('[data-contact-track]')) {
    chip.classList.toggle('active', chip.dataset.contactTrack === trackCode);
  }
  void loadContacts($('#contact-search').value.trim(), trackCode).catch(showError);
}

function formatOpportunitySubtitle(opportunity) {
  const parts = [intentLabel(opportunity.intent), opportunity.area_label || 'مدينة نصر'];
  if (opportunity.size_max_m2) parts.push(`${opportunity.size_max_m2} م²`);
  if (opportunity.budget_max) parts.push(money(opportunity.budget_max));
  return parts.join(' · ');
}

async function loadOpportunities(query = $('#opportunity-search').value, status = $('#opportunity-status').value) {
  const container = $('#opportunity-results');
  container.replaceChildren(node('p', 'جارٍ البحث…', 'muted'));
  const result = await requireApi().searchOpportunities(query, status, {
    track: state.oppTrackFilter,
    role: state.oppRoleFilter,
  });
  state.opportunities = result.opportunities || [];
  const badgeEl = $('#opportunity-count-badge');
  if (badgeEl) badgeEl.textContent = `${state.opportunities.length} فرصة`;
  container.replaceChildren();
  if (!state.opportunities.length) container.append(node('p', 'لا توجد فرص مطابقة في هذا المسار.', 'muted'));
  for (const opportunity of state.opportunities) {
    const tags = [trackShort(opportunity.track), statusLabel(opportunity.status)];
    if (!opportunity.phone_key) tags.push({ text: 'بدون رقم محفوظ', cls: 'pill warn-pill' });
    else if (opportunity.next_followup_at) tags.push(`⏰ ${dateLabel(opportunity.next_followup_at)}`);
    container.append(clickableRecord(
      `${trackBadge(opportunity.track)} ${opportunity.contact_name || 'عميل'}`,
      formatOpportunitySubtitle(opportunity),
      () => openOpportunity(opportunity.id),
      tags,
      opportunity.id,
    ));
  }
}

function buildTrackSwitcherBar(opportunity) {
  const wrap = node('div', '', 'track-switcher');
  const feedback = node('span', '', 'muted');
  feedback.setAttribute('aria-live', 'polite');
  for (const code of TRACK_ORDER) {
    const isCurrent = (opportunity.track || 'sale_apt') === code;
    const cls = `chip small-chip track-chip-${code}${isCurrent ? ' active' : ''}`;
    const btn = button(TRACK_META[code].short, async () => {
      if (isCurrent) return;
      btn.disabled = true;
      feedback.textContent = 'جارٍ النقل…';
      try {
        await requireApi().switchOpportunityTrack(opportunity.id, code);
        state.lastActionToast = `✓ تم نقل العميل إلى مسار ${TRACK_META[code].label}`;
        void syncBackgroundListsQuietly();
        await openOpportunity(opportunity.id);
      } catch (error) {
        feedback.textContent = errorText(error);
        btn.disabled = false;
      }
    }, cls);
    wrap.append(btn);
  }
  wrap.append(feedback);
  return wrap;
}

function formatNextFollowupSummary(opportunity) {
  if (!opportunity.next_followup_at) {
    return opportunity.no_followup_reason || 'بدون تذكير مجدول';
  }
  const timePart = dateLabel(opportunity.next_followup_at);
  if (opportunity.next_action) return `${timePart} · ${opportunity.next_action}`;
  return timePart;
}

function buildSpecsGrid(opportunity) {
  const grid = node('div', '', 'specs-grid');
  const nextSummary = formatNextFollowupSummary(opportunity);
  const tiles = [
    ['المنطقة / الموقع', `${opportunity.area_label || 'مدينة نصر'} · ${opportunity.property_type || 'شقة'}`],
    ['السعر / الميزانية', formatBudgetRange(opportunity.budget_min, opportunity.budget_max)],
    ['المساحة', formatSizeRange(opportunity.size_min_m2, opportunity.size_max_m2)],
    ['الموعد / الخطوة القادمة', nextSummary],
  ];
  for (const [lbl, val] of tiles) {
    const tile = node('div', '', 'spec-tile');
    tile.append(node('small', lbl), node('strong', val));
    grid.append(tile);
  }
  return grid;
}

function buildLinkedSitePropertyCard(opportunity, properties) {
  const linked = properties[0] || null;
  const siteUrl = publicPropertyUrl(linked?.url || opportunity.source_url);
  if (!linked && !siteUrl) return null;
  const card = node('div', '', 'site-unit-card');
  card.append(
    node('strong', `🏢 عقار مربوط بموقعك: ${linked?.title || linked?.external_id || opportunity.source_url}`),
  );
  if (linked) {
    card.append(node('small', `${linked.area_name || 'مدينة نصر'} · ${linked.area_m2 ?? '—'} م² · ${money(linked.price)}`, 'muted'));
  }
  if (siteUrl) {
    const actions = node('div', '', 'form-actions');
    const openLink = node('a', '🌐 فتح صفحة العقار على الموقع', 'button primary small');
    openLink.href = siteUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    const copyLinkBtn = button('🔗 نسخ رابط العقار لإرساله لعميل', () => {
      void copyTextWithFeedback(copyLinkBtn, siteUrl, 'تم نسخ الرابط ✓');
    }, 'button small');
    actions.append(openLink, copyLinkBtn);
    card.append(actions);
  }
  return card;
}

function buildMatchCounterpartyCard(m) {
  const card = node('div', '', 'match-card');
  const badgeText = m.track === 'transient' ? '✈️ من أرشيف الطيارة' : trackShort(m.track);
  card.append(
    node('strong', `${trackBadge(m.track)} ${m.contact_name || 'عميل'} (${badgeText})`),
    node('small', formatOpportunitySubtitle(m), 'muted'),
  );
  const actions = node('div', '', 'form-actions');
  if (m.phone_key) {
    const callLink = node('a', `📞 اتصال (${prettyPhone(m.phone_key)})`, 'button primary small');
    callLink.href = telHref(m.phone_key);
    actions.append(callLink);
  }
  actions.append(button('فتح ملفه ←', () => { void openOpportunity(m.id); }, 'button small'));
  card.append(actions);
  return card;
}

function renderMatchesSection(opportunityId) {
  const section = node('section', '', 'detail-section');
  section.append(node('h3', '🎯 مطابقات ذكية جاهزة للتنفيذ (عملاء وعقارات متوافقة)'));
  const body = node('div', '', 'stack');
  body.append(node('p', 'جارٍ فحص الطرف المقابل والوحدات المناسبة…', 'muted'));
  section.append(body);
  void (async () => {
    try {
      const res = await requireApi().getOpportunityMatches(opportunityId);
      body.replaceChildren();
      const opps = res.opportunities || [];
      const units = res.listings || [];
      if (!opps.length && !units.length) {
        body.append(node('p', 'لا توجد مطابقات مقابلة مسجلة حاليًا في هذا المسار.', 'muted'));
        return;
      }
      for (const m of opps) body.append(buildMatchCounterpartyCard(m));
      const feedback = node('span', '', 'muted');
      for (const unit of units) body.append(buildListingOption(opportunityId, unit, feedback));
      if (units.length) body.append(feedback);
    } catch {
      body.replaceChildren(node('p', 'تعذّر تحميل المطابقات حاليًا.', 'muted'));
    }
  })();
  return section;
}

function renderCustomActivityDetails(opportunity) {
  const details = node('details', '', 'drawer-details');
  details.append(node('summary', '📅 تسجيل ملاحظة مخصصة أو تحديد تاريخ وساعة بعينها'));
  details.append(activityForm(opportunity));
  return details;
}

function renderPropertyLinkDetails(opportunityId, properties) {
  const details = node('details', '', 'drawer-details');
  details.append(node('summary', `🏢 ربط عقار من كتالوج الموقع (${properties.length} مربوط حاليًا)`));
  const list = node('div', '', 'stack');
  for (const property of properties) {
    const item = node('div', '', 'property-option');
    item.append(
      node('strong', property.title || property.external_id),
      node('small', `${property.area_name || 'مدينة نصر'} · ${property.area_m2 ?? '—'} م² · ${money(property.price)}`),
    );
    list.append(item);
  }
  details.append(list, propertySearchForm(opportunityId));
  return details;
}

function renderHistoryDetails(activities) {
  const details = node('details', '', 'drawer-details');
  details.append(node('summary', `📜 سجل المتابعات والأنشطة السابقة (${activities.length})`));
  const activityList = node('ul', '', 'detail-list');
  for (const activity of activities) {
    const li = node('li');
    li.append(node('strong', dateLabel(activity.created_at)), document.createTextNode(` · ${activity.summary}`));
    if (activity.outcome) li.append(node('small', ` — ${activity.outcome}`));
    activityList.append(li);
  }
  if (!activities.length) activityList.append(node('li', 'لا توجد أنشطة سابقة.', 'muted'));
  details.append(activityList);
  return details;
}

function buildOpportunityCommandNodes(result) {
  const { opportunity } = result;
  const phones = result.phones || [];
  const siblings = result.sibling_opportunities || [];
  const activities = result.activities || [];
  const properties = result.properties || [];
  const nodes = [];

  if (state.lastActionToast) {
    nodes.push(node('div', state.lastActionToast, 'notice info'));
    state.lastActionToast = '';
  }

  const hero = node('div', '', 'sheet-hero');
  const titleEl = node('h2', `${trackBadge(opportunity.track)} ${opportunity.contact_name || 'عميل'}`);
  titleEl.id = 'record-sheet-title';
  const metaRow = node('div', '', 'record-meta');
  metaRow.append(
    node('span', intentLabel(opportunity.intent), 'pill active-pill'),
    node('span', statusLabel(opportunity.status), 'pill'),
    node('span', TRACK_META[opportunity.track]?.short || '🟢 بيع', 'pill'),
  );
  hero.append(titleEl, metaRow, buildUnitSiblingsBar(opportunity.contact_id, opportunity.id, siblings));
  nodes.push(hero);

  nodes.push(buildSheetCommSection(
    opportunity.contact_id,
    phones,
    { name: opportunity.contact_name, intent: opportunity.intent, areaLabel: opportunity.area_label },
    () => openOpportunity(opportunity.id),
  ));

  nodes.push(buildQuickActionPad(opportunity));
  nodes.push(buildTrackSwitcherBar(opportunity));
  nodes.push(buildSpecsGrid(opportunity));

  if (opportunity.notes) {
    const notesWrap = node('div', '', 'notes-box');
    notesWrap.textContent = opportunity.notes;
    nodes.push(notesWrap);
  }

  const siteCard = buildLinkedSitePropertyCard(opportunity, properties);
  if (siteCard) nodes.push(siteCard);

  nodes.push(
    buildUnifiedQuickEditDetails(opportunity),
    renderMatchesSection(opportunity.id),
    renderCustomActivityDetails(opportunity),
    renderPropertyLinkDetails(opportunity.id, properties),
    renderHistoryDetails(activities),
  );
  return nodes;
}

function mirrorOpportunityDetailDom(opportunity) {
  const detail = $('#opportunity-detail');
  if (!detail) return;
  detail.replaceChildren();
  detail.append(
    node('h2', `${trackBadge(opportunity.track)} ${intentLabel(opportunity.intent)} · ${opportunity.contact_name || 'عميل'}`),
    node('p', formatOpportunitySubtitle(opportunity), 'muted'),
    button('فتح غرفة عمليات العميل والإجراءات ←', () => { void openOpportunity(opportunity.id); }, 'button primary small'),
  );
}

async function openOpportunity(opportunityId, { keepContactHighlight = false } = {}) {
  state.opportunityId = opportunityId;
  if (!keepContactHighlight) markSelectedRecord(opportunityId);
  showRecordSheet('غرفة عمليات العميل');
  const sheetBody = $('#record-sheet-body');
  if (sheetBody) {
    sheetBody.replaceChildren(node('p', 'جارٍ تحميل بيانات العميل والإجراءات المتاحة…', 'muted'));
    sheetBody.scrollTop = 0;
  }
  const result = await requireApi().getOpportunity(opportunityId);
  const { opportunity } = result;
  state.contactId = opportunity.contact_id;
  const badge = $('#record-sheet-badge');
  if (badge) badge.textContent = `${trackShort(opportunity.track)} · ${statusLabel(opportunity.status)}`;
  mirrorOpportunityDetailDom(opportunity);
  if (sheetBody) {
    sheetBody.replaceChildren(...buildOpportunityCommandNodes(result));
    sheetBody.scrollTop = 0;
  }
}

function activityForm(opportunity) {
  const form = node('form', '', 'activity-form');
  const type = node('select');
  type.name = 'activity_type';
  const types = [
    ['call', 'مكالمة'],
    ['missed_call', 'مكالمة فائتة'],
    ['whatsapp_note', 'ملاحظة واتساب'],
    ['visit', 'معاينة'],
    ['offer', 'عرض'],
    ['objection', 'اعتراض'],
    ['note', 'ملاحظة'],
    ['status_change', 'تغيير حالة'],
  ];
  for (const [value, label] of types) type.add(new Option(label, value));
  const summary = node('textarea');
  summary.name = 'summary';
  summary.required = true;
  summary.maxLength = 1200;
  summary.placeholder = 'ملخص ما تم';
  const outcome = node('input');
  outcome.name = 'outcome';
  outcome.maxLength = 200;
  outcome.placeholder = 'النتيجة (اختياري)';
  const status = node('select');
  status.name = 'status';
  status.add(new Option('اترك الحالة كما هي', ''));
  for (const [value, label] of Object.entries(STATUS_LABELS)) status.add(new Option(label, value));
  status.value = opportunity.status;
  const action = node('input');
  action.name = 'next_action';
  action.maxLength = 180;
  action.placeholder = 'الإجراء القادم';
  action.value = opportunity.next_action || '';
  const followup = node('input');
  followup.type = 'datetime-local';
  followup.name = 'next_followup_at';
  if (opportunity.next_followup_at) {
    const d = new Date(opportunity.next_followup_at);
    if (!Number.isNaN(d.valueOf())) {
      followup.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
  }
  const noFollow = node('input');
  noFollow.name = 'no_followup_reason';
  noFollow.maxLength = 240;
  noFollow.placeholder = 'سبب عدم تحديد متابعة (إن وجد)';
  noFollow.value = opportunity.no_followup_reason || '';
  const feedback = node('span', '', 'muted');
  feedback.setAttribute('aria-live', 'polite');
  const submit = node('button', 'حفظ المتابعة المخصصة', 'button primary small');
  submit.type = 'submit';
  form.append(type, summary, outcome, status, action, followup, noFollow, submit, feedback);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(submit, true);
    try {
      await requireApi().addActivity(opportunity.id, {
        activity_type: type.value,
        summary: summary.value,
        outcome: outcome.value,
        status: status.value || undefined,
        next_action: action.value,
        next_followup_at: isoFromLocal(followup.value),
        no_followup_reason: noFollow.value,
      });
      state.lastActionToast = '✓ تم حفظ المتابعة المخصصة';
      void syncBackgroundListsQuietly();
      await openOpportunity(opportunity.id);
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(submit, false);
    }
  });
  return form;
}

function buildListingOption(opportunityId, listing, feedback) {
  const item = node('div', '', 'property-option');
  item.append(
    node('strong', listing.title || listing.external_id),
    node('small', `${listing.area_name || 'مدينة نصر'} · ${listing.area_m2 ?? '—'} م² · ${money(listing.price)}`),
  );
  const actions = node('div', '', 'form-actions');
  const link = button('🔗 ربط بهذا العميل', async () => {
    link.disabled = true;
    try {
      await requireApi().linkProperty(opportunityId, {
        external_id: listing.external_id,
        presentation_status: 'presented',
        presented_price: listing.price ?? null,
        activity_summary: `تم عرض عقار ${listing.external_id}`,
      });
      state.lastActionToast = '✓ تم ربط العقار بالعميل بنجاح';
      await openOpportunity(opportunityId);
    } catch (error) {
      feedback.textContent = errorText(error);
      link.disabled = false;
    }
  }, 'button primary small');
  actions.append(link);
  const pubUrl = publicPropertyUrl(listing.url || `/properties/${listing.external_id}/`);
  if (pubUrl) {
    const copyUrlBtn = button('📋 نسخ رابط العقار', () => {
      void copyTextWithFeedback(copyUrlBtn, pubUrl, 'تم نسخ الرابط ✓');
    }, 'button small');
    actions.append(copyUrlBtn);
  }
  item.append(actions);
  return item;
}

function propertySearchForm(opportunityId) {
  const form = node('form', '', 'property-form');
  const query = node('input');
  query.type = 'search';
  query.name = 'q';
  query.placeholder = 'ابحث باسم العقار أو الشارع بمدينة نصر';
  query.maxLength = 80;
  const submit = node('button', 'بحث في عقارات الموقع', 'button small');
  submit.type = 'submit';
  const resultList = node('div', '', 'property-results');
  const feedback = node('span', '', 'muted');
  feedback.setAttribute('aria-live', 'polite');
  form.append(query, submit, resultList, feedback);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(submit, true, 'جارٍ البحث…');
    resultList.replaceChildren();
    try {
      const result = await requireApi().searchListings(query.value);
      const listings = result.listings || [];
      if (!listings.length) resultList.append(node('p', 'لا توجد عقارات مطابقة ضمن النطاق المسموح.', 'muted'));
      for (const listing of listings) resultList.append(buildListingOption(opportunityId, listing, feedback));
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(submit, false);
    }
  });
  return form;
}

async function loadQuickListings() {
  const select = $('#quick-listing-select');
  if (!select) return;
  const result = await requireApi().searchListings('');
  state.listings = (result.listings || []).filter(item => !String(item.external_id || '').startsWith('crm-test-only-'));
  const oldVal = select.value;
  select.replaceChildren(new Option('بدون ربط مباشر الآن…', ''));
  for (const item of state.listings) {
    const pricePart = item.price ? ` · ${money(item.price)}` : '';
    select.add(new Option(`${item.title || item.external_id}${pricePart}`, item.external_id));
  }
  if (state.listings.some(item => item.external_id === oldVal)) select.value = oldVal;
}

const KNOWN_NASR_AREAS = [
  'الحديقة الدولية', 'حسن المأمون', 'مكرم عبيد', 'عباس العقاد', 'مصطفى النحاس',
  'الحي السابع', 'الحي الثامن', 'الحي العاشر', 'المنطقة الأولى', 'المنطقة السادسة',
  'المنطقة التاسعة', 'المنطقة العاشرة', 'حي السفارات', 'زهراء مدينة نصر', 'الواحة',
  'الطيران', 'موسى الكاظم', 'حسنين هيكل', 'رابعة',
];

function asciiDigits(value) {
  return String(value || '')
    .replaceAll(/[\u0660-\u0669]/g, ch => String(ch.codePointAt(0) - 0x0660))
    .replaceAll(/[\u06f0-\u06f9]/g, ch => String(ch.codePointAt(0) - 0x06f0));
}

function extractPhoneFromChat(normalized) {
  const match = /(?:\+?20[\s.-]*)?0?1[0125](?:[\s.-]*\d){8}/.exec(normalized);
  return match ? match[0].replaceAll(/[^\d+]/g, '') : '';
}

function extractPriceFromChat(normalized) {
  const million = /(\d{1,3}(?:\.\d{1,3})?)\s*مليون/.exec(normalized);
  if (million) {
    let total = Math.round(Number(million[1]) * 1_000_000);
    if (/مليون\s*و\s*نص/.test(normalized) && !million[1].includes('.')) total += 500_000;
    return String(total);
  }
  const thousand = /(\d{2,4})\s*(?:ألف|الف)/.exec(normalized);
  if (thousand) return String(Number(thousand[1]) * 1_000);
  const plain = /\b(\d{6,8})\b/.exec(normalized.replaceAll(/(?:\+?20)?0?1[0125]\d{8}/g, ' '));
  return plain ? plain[1] : '';
}

function detectIntentFromChat(normalized) {
  if (/مطلوب\s*(?:شقة\s*)?(?:للإيجار|للايجار|إيجار|ايجار)/.test(normalized)) return 'rent';
  if (/مطلوب|أبحث|بدور\s*على|مشتري/.test(normalized)) return 'buy';
  if (/للإيجار|للايجار|مفروش/.test(normalized)) return 'lease';
  return 'sell';
}

function detectPropertyTypeFromChat(normalized) {
  for (const kind of ['دوبلكس', 'فيلا', 'محل', 'مكتب', 'عيادة', 'مقر إداري']) {
    if (normalized.includes(kind)) return kind;
  }
  return 'شقة';
}

function detectTrackFromChat(normalized) {
  if (normalized.includes('✈️') || normalized.includes('طيارة')) return 'transient';
  if (normalized.includes('🟡') || normalized.includes('🟠') || /مقر|إداري|اداري|مكتب|محل|تجاري|عيادة/.test(normalized)) return 'admin_hq';
  if (normalized.includes('🔴') || /مفروش/.test(normalized)) return 'furnished_apt';
  if (normalized.includes('🔵') || /إيجار جديد|ايجار جديد|قانون جديد/.test(normalized)) return 'new_rent_apt';
  return 'sale_apt';
}

function setQuickTrackChip(track, { syncDefaults = false } = {}) {
  const safeTrack = TRACK_META[track] ? track : 'sale_apt';
  const hidden = $('#quick-track-value');
  if (hidden) hidden.value = safeTrack;
  for (const chip of document.querySelectorAll('[data-quick-track]')) {
    chip.classList.toggle('active', chip.dataset.quickTrack === safeTrack);
  }
  if (syncDefaults) {
    const meta = TRACK_META[safeTrack];
    $('#quick-property-type').value = meta.defaultProp;
    setQuickIntentChip(meta.defaultIntent);
  }
}

function setQuickIntentChip(intent) {
  $('#quick-intent-value').value = intent;
  for (const chip of document.querySelectorAll('[data-quick-intent]')) {
    chip.classList.toggle('active', chip.dataset.quickIntent === intent);
  }
}

function setQuickFollowupChip(preset) {
  $('#quick-followup-preset').value = preset;
  for (const chip of document.querySelectorAll('[data-quick-followup]')) {
    chip.classList.toggle('active', chip.dataset.quickFollowup === preset);
  }
}

function handleQuickParseClick() {
  const raw = $('#quick-paste-input').value.trim();
  const feedback = $('#quick-parse-feedback');
  if (!raw) {
    feedback.textContent = 'الصق نص الرسالة أولًا.';
    return;
  }
  const normalized = asciiDigits(raw);
  const phone = extractPhoneFromChat(normalized);
  if (phone) $('#quick-phone').value = phone;
  const headerName = /^\[[^\]]{3,40}\]\s*([^:\n]{2,50}):/.exec(normalized);
  if (headerName && !/\d{5}/.test(headerName[1])) $('#quick-name').value = headerName[1].trim();
  const sizeMatch = /(\d{2,4})\s*(?:م2|م²|متر)/.exec(normalized);
  if (sizeMatch) $('#quick-size').value = sizeMatch[1];
  const price = extractPriceFromChat(normalized);
  if (price) $('#quick-budget').value = price;
  const foundArea = KNOWN_NASR_AREAS.find(area => normalized.includes(area));
  if (foundArea) $('#quick-area').value = foundArea;
  $('#quick-property-type').value = detectPropertyTypeFromChat(normalized);
  setQuickTrackChip(detectTrackFromChat(normalized));
  setQuickIntentChip(detectIntentFromChat(normalized));
  $('#quick-notes').value = raw.slice(0, 1200);
  feedback.textContent = phone ? 'تم استخراج الرقم والرمز والبيانات — راجع واضغط حفظ.' : 'تم استخراج التفاصيل والرمز؛ احفظ بالاسم أو أضف الرقم.';
}

function resolveQuickFollowupFields(preset) {
  if (preset === 'none') {
    return {
      next_action: null,
      next_followup_at: null,
      no_followup_reason: 'مسجل من المحادثة — المتابعة عند توافر طلب أو معاينة',
    };
  }
  const daysMap = { tomorrow: 1, '3days': 3, '7days': 7 };
  const days = daysMap[preset] || 1;
  return {
    next_action: 'متابعة العميل عبر الرسائل أو الهاتف',
    next_followup_at: nextSlotIso(days, 13),
    no_followup_reason: null,
  };
}

function handleQuickListingSelection() {
  const selectedId = $('#quick-listing-select').value;
  const listing = state.listings.find(item => item.external_id === selectedId);
  if (!listing) return;
  if (!$('#quick-budget').value && listing.price) $('#quick-budget').value = String(listing.price);
  if (!$('#quick-size').value && listing.area_m2) $('#quick-size').value = String(listing.area_m2);
  if (!$('#quick-area').value && listing.title) $('#quick-area').value = listing.title.slice(0, 80);
}

function buildQuickEntryPayload(v, selectedListing) {
  const track = v.track || 'sale_apt';
  const followup = track === 'transient'
    ? { next_action: null, next_followup_at: null, no_followup_reason: 'عميل عابر (طيارة ✈️) — محفوظ بالأرشيف' }
    : resolveQuickFollowupFields(v.followup_preset || 'none');
  const budgetVal = v.budget_max ? Number(v.budget_max) : null;
  const sizeVal = v.size_max_m2 ? Number(v.size_max_m2) : null;
  return {
    track,
    phone: v.phone?.trim() || undefined,
    name: v.name?.trim() || '',
    intent: v.intent || 'sell',
    source: 'whatsapp',
    source_url: selectedListing?.url || '',
    status: track === 'transient' ? 'paused' : 'active',
    area_label: v.area_label?.trim() || '',
    property_type: v.property_type?.trim() || 'شقة',
    budget_min: budgetVal,
    budget_max: budgetVal,
    size_min_m2: sizeVal,
    size_max_m2: sizeVal,
    notes: v.notes?.trim() || 'تسجيل سريع من المحادثة',
    ...followup,
  };
}

async function handleQuickEntrySubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('#quick-entry-submit');
  const feedback = $('#quick-entry-feedback');
  const v = Object.fromEntries(new FormData(form));
  if (!v.phone?.trim() && !v.name?.trim()) {
    feedback.textContent = 'أدخل رقم الهاتف أو اسم العميل على الأقل.';
    return;
  }
  const selectedListing = state.listings.find(item => item.external_id === v.external_id);
  const payload = buildQuickEntryPayload(v, selectedListing);
  setBusy(submit, true);
  feedback.textContent = 'جارٍ حفظ العميل والفرصة…';
  try {
    const created = await requireApi().createOpportunity(payload);
    if (v.external_id && created.opportunity_id) {
      await requireApi().linkProperty(created.opportunity_id, {
        external_id: v.external_id,
        presentation_status: 'selected',
        presented_price: payload.budget_max,
        activity_summary: `ربط بالوحدة المنشورة: ${v.external_id}`,
      });
    }
    feedback.textContent = 'تم حفظ العميل والفرصة بنجاح.';
    form.reset();
    $('#quick-property-type').value = 'شقة';
    setQuickTrackChip('sale_apt');
    setQuickIntentChip('sell');
    setQuickFollowupChip('none');
    $('#quick-paste-input').value = '';
    await refreshAll();
    if (created.opportunity_id) {
      state.lastActionToast = '✓ تم حفظ العميل وفتح غرفة عملياته مباشرة';
      await openOpportunity(created.opportunity_id);
    }
  } catch (error) {
    feedback.textContent = errorText(error);
    showError(error);
  } finally {
    setBusy(submit, false);
  }
}

function isIosDevice() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalonePwa() {
  return window.navigator.standalone === true || Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches);
}

function supportsBrowserPush() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function detectDeviceLabel() {
  if (isIosDevice()) return 'iPhone / iPad PWA';
  if (/Android/i.test(navigator.userAgent || '')) return 'هاتف Android';
  return 'متصفح المكتب';
}

function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, ch => ch.codePointAt(0));
}

function renderPushCardView({ pill, active = false, text, canEnable = false, subscribed = false }) {
  const pillEl = $('#push-status-pill');
  if (!pillEl) return;
  pillEl.textContent = pill;
  pillEl.className = active ? 'pill active-pill' : 'pill';
  $('#push-status-text').textContent = text;
  $('#push-enable-btn').hidden = !canEnable;
  $('#push-test-btn').hidden = !subscribed;
  $('#push-check-btn').hidden = !subscribed;
  $('#push-disable-btn').hidden = !subscribed;
}

async function ensureCrmServiceWorker() {
  if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker.register !== 'function') return null;
  try {
    return await navigator.serviceWorker.register('/crm-sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

async function handlePwaInstallClick() {
  const promptEvent = state.deferredInstallPrompt;
  if (!promptEvent) return;
  const btn = $('#pwa-install-btn');
  setBusy(btn, true, 'جارٍ التثبيت…');
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === 'accepted') {
      state.deferredInstallPrompt = null;
      btn.hidden = true;
    }
  } catch {
    // User dismissed or browser aborted prompt.
  } finally {
    setBusy(btn, false);
  }
}

async function readBrowserPushSubscription() {
  if (!supportsBrowserPush() || typeof navigator.serviceWorker.getRegistration !== 'function') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg?.pushManager) return null;
  return reg.pushManager.getSubscription();
}

function checkPushEnvironmentGuard(cfg) {
  if (!cfg.enabled || !state.pushPublicKey) {
    renderPushCardView({ pill: 'غير مهيأة بعد', text: 'مفاتيح إشعارات الخادم قيد التهيئة التلقائية.' });
    return true;
  }
  if (isIosDevice() && !isStandalonePwa()) {
    renderPushCardView({
      pill: 'يلزم التثبيت على الشاشة الرئيسية',
      text: 'على iPhone/iPad: اضغط زر المشاركة (⬆︎) في Safari ← اختر «إضافة إلى الشاشة الرئيسية» (Add to Home Screen)، ثم افتح التطبيق من الشاشة الرئيسية لتفعيل رنين الإشعارات.',
    });
    return true;
  }
  if (!supportsBrowserPush()) {
    renderPushCardView({ pill: 'غير مدعوم هنا', text: 'هذا المتصفح لا يدعم Web Push؛ افتح الرابط من Chrome على Android أو أضفه للشاشة الرئيسية على iPhone.' });
    return true;
  }
  if (Notification.permission === 'denied') {
    renderPushCardView({ pill: 'محظورة من المتصفح', text: 'الإشعارات محظورة لهذا الموقع في إعدادات المتصفح؛ اسمح بها من أيقونة القفل بجانب العنوان ثم حدّث الصفحة.' });
    return true;
  }
  return false;
}

async function loadPushCardState() {
  if (!$('#push-card')) return;
  $('#push-feedback').textContent = '';
  try {
    const cfg = await requireApi().getPushConfig();
    state.pushPublicKey = cfg.public_key || '';
    if (checkPushEnvironmentGuard(cfg)) return;
    const existingSub = await readBrowserPushSubscription();
    if (existingSub?.endpoint) {
      state.pushEndpoint = existingSub.endpoint;
      await requireApi().subscribePush({
        subscription: existingSub.toJSON(),
        device_label: detectDeviceLabel(),
        morning_digest: true,
      });
      renderPushCardView({
        pill: 'مفعّلة على هذا الجهاز ✓',
        active: true,
        subscribed: true,
        text: 'الإشعارات نشطة تلقائيًا لمواعيد المتابعة والمعاينات وملخص الصباح (9:30 ص بتوقيت القاهرة) دون كشف أرقام العملاء على شاشة القفل.',
      });
      return;
    }
    state.pushEndpoint = '';
    const countNote = cfg.subscriptions_count > 0 ? ` (مفعّلة حاليًا على ${cfg.subscriptions_count} جهاز آخر)` : '';
    renderPushCardView({
      pill: 'جاهزة للتفعيل',
      canEnable: true,
      text: `فعّل الإشعارات ليصلك تنبيه تلقائي بمواعيد المتابعة والمعاينات وملخص الصباح على هذا الجهاز${countNote}.`,
    });
  } catch {
    renderPushCardView({ pill: 'غير متاح مؤقتًا', text: 'تعذّر التحقق من حالة الإشعارات حاليًا.' });
  }
}

async function handleEnablePushClick() {
  const btn = $('#push-enable-btn');
  const feedback = $('#push-feedback');
  if (!state.pushPublicKey || !supportsBrowserPush()) return;
  setBusy(btn, true, 'جارٍ التفعيل…');
  feedback.textContent = 'اطلب السماح بالإشعارات من نافذة المتصفح…';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      feedback.textContent = 'لم يُمنح إذن الإشعارات.';
      await loadPushCardState();
      return;
    }
    await navigator.serviceWorker.register('/crm-sw.js', { scope: '/' });
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.pushPublicKey),
    });
    state.pushEndpoint = sub.endpoint;
    await requireApi().subscribePush({
      subscription: sub.toJSON(),
      device_label: detectDeviceLabel(),
      morning_digest: true,
    });
    await loadPushCardState();
    $('#push-feedback').textContent = 'تم تفعيل الإشعارات بنجاح ✓ يمكنك تجربة زر الإشعار التجريبي الآن.';
  } catch (error) {
    feedback.textContent = errorText(error);
  } finally {
    setBusy(btn, false);
  }
}

async function handleTestPushClick() {
  const btn = $('#push-test-btn');
  const feedback = $('#push-feedback');
  setBusy(btn, true, 'جارٍ الإرسال…');
  feedback.textContent = 'جارٍ إرسال إشعار تجريبي إلى جهازك…';
  try {
    const res = await requireApi().sendTestPush(state.pushEndpoint);
    feedback.textContent = res.delivered > 0 ? 'وصلك الإشعار التجريبي الآن ✓' : 'تعذّر التسليم؛ أعد تفعيل الإشعارات.';
  } catch (error) {
    feedback.textContent = errorText(error);
  } finally {
    setBusy(btn, false);
  }
}

async function handleCheckDuePushClick() {
  const btn = $('#push-check-btn');
  const feedback = $('#push-feedback');
  setBusy(btn, true, 'جارٍ الفحص…');
  feedback.textContent = 'جارٍ فحص المواعيد المستحقة…';
  try {
    const res = await requireApi().checkDuePushNow();
    const sent = Number(res.followup_alerts || 0) + Number(res.viewing_alerts || 0);
    feedback.textContent = sent > 0
      ? `تم إرسال ${sent} تنبيه مستحق إلى أجهزتك المفعّلة ✓`
      : 'لا توجد مواعيد مستحقة جديدة لم يُرسل تنبيهها بعد.';
  } catch (error) {
    feedback.textContent = errorText(error);
  } finally {
    setBusy(btn, false);
  }
}

async function handleDisablePushClick() {
  const btn = $('#push-disable-btn');
  const feedback = $('#push-feedback');
  setBusy(btn, true, 'جارٍ الإيقاف…');
  try {
    const sub = await readBrowserPushSubscription();
    const endpoint = sub?.endpoint || state.pushEndpoint;
    if (sub) await sub.unsubscribe();
    if (endpoint) await requireApi().unsubscribePush(endpoint);
    state.pushEndpoint = '';
    await loadPushCardState();
    $('#push-feedback').textContent = 'تم إيقاف الإشعارات على هذا الجهاز.';
  } catch (error) {
    feedback.textContent = errorText(error);
  } finally {
    setBusy(btn, false);
  }
}

async function refreshAll() {
  clearError();
  setNotice($('#app-status'), 'جارٍ تحميل بيانات CRM…', 'info');
  $('#security-status').textContent = 'جارٍ التحميل…';
  try {
    await Promise.all([loadDashboard(), loadContacts(), loadOpportunities('', ''), loadQuickListings(), loadPushCardState()]);
    $('#security-status').textContent = 'جلسة موثقة ومحمية';
    setNotice($('#app-status'), 'الجلسة نشطة. البيانات لا تُحفظ في هذا المتصفح.', 'info');
  } catch (error) {
    showError(error);
  }
}

function addConsentValidation(form) {
  const consent = form.elements.communication_consent;
  consent.addEventListener('change', () => {
    const existing = form.querySelector('[name="consent-confirm"]');
    if (consent.value === 'marketing_yes' && !existing) {
      const label = node('label', '', 'full');
      const check = node('input');
      check.type = 'checkbox';
      check.name = 'consent-confirm';
      check.required = true;
      check.className = 'inline-check';
      label.append(check, document.createTextNode(' أؤكد أن موافقة العميل على استقبال العروض سُجلت صراحةً.'));
      form.querySelector('.form-actions').before(label);
    } else if (consent.value !== 'marketing_yes' && existing) {
      existing.closest('label').remove();
    }
  });
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const submit = $('#login-submit');
  const feedback = $('#login-feedback');
  const code = $('#access-code-input').value.trim();
  if (!code) {
    feedback.textContent = 'أدخل رمز الدخول أولًا.';
    return;
  }
  clearError();
  setBusy(submit, true, 'جارٍ التحقق…');
  feedback.textContent = 'جارٍ التحقق من رمز الدخول…';
  try {
    await requireApi().login(code);
    unlockWorkspace();
    await refreshAll();
  } catch (error) {
    $('#access-code-input').value = '';
    feedback.textContent = errorText(error);
  } finally {
    setBusy(submit, false);
  }
}

async function handleLogoutClick() {
  const logoutBtn = $('#logout-button');
  setBusy(logoutBtn, true, 'جارٍ الخروج…');
  try {
    await requireApi().logout();
    clearError();
    lockWorkspace('تم تسجيل الخروج وإنهاء الجلسة.');
  } catch (error) {
    requireApi().clearSession();
    lockWorkspace('تم إغلاق الواجهة محليًا؛ سجّل الدخول مجددًا.');
    showError(error);
  } finally {
    setBusy(logoutBtn, false);
  }
}

async function handleNewContactSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const feedback = $('#new-contact-feedback');
  const phoneRows = [...form.querySelectorAll('.phone-row')]
    .map(row => ({
      phone: row.querySelector('[data-phone]').value.trim(),
      label: row.querySelector('[data-label]').value.trim(),
      is_primary: row.querySelector('[data-primary]').checked,
    }))
    .filter(item => item.phone);
  const consent = form.elements.communication_consent.value;
  const confirmation = form.querySelector('[name="consent-confirm"]');
  if (consent === 'marketing_yes' && !confirmation?.checked) {
    feedback.textContent = 'سجّل تأكيد موافقة العميل أولًا.';
    return;
  }
  const body = { name: form.elements.name.value.trim(), phones: phoneRows, communication_consent: consent };
  if (consent === 'marketing_yes') body.consent_captured_at = new Date().toISOString();
  setBusy(submit, true);
  feedback.textContent = 'جارٍ الحفظ…';
  try {
    const created = await requireApi().createContact(body);
    feedback.textContent = created.duplicate_contact ? 'هذا الرقم مسجل بالفعل؛ افتح السجل الموجود.' : 'تم حفظ العميل.';
    await loadContacts($('#contact-search').value.trim());
    if (created.contact_id) {
      openPanel('contacts-panel', { keepSheet: true });
      await openContact(created.contact_id);
    }
  } catch (error) {
    feedback.textContent = errorText(error);
    showError(error);
  } finally {
    setBusy(submit, false);
  }
}

function validateNewOpportunityFollowup(isTransient, effectiveStatus, v, followup) {
  const activeStatuses = ['active', 'visit_scheduled', 'viewing_done', 'offer', 'negotiating', 'near_close'];
  return isTransient || !activeStatuses.includes(effectiveStatus) || Boolean(v.next_action?.trim() && followup) || Boolean(v.no_followup_reason?.trim());
}

async function handleNewOpportunitySubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const feedback = $('#new-opportunity-feedback');
  const v = Object.fromEntries(new FormData(form));
  const followup = isoFromLocal(v.next_followup_at);
  const isTransient = v.track === 'transient';
  const effectiveStatus = isTransient && v.status === 'active' ? 'paused' : v.status;
  if (!validateNewOpportunityFollowup(isTransient, effectiveStatus, v, followup)) {
    feedback.textContent = 'أدخل الإجراء وموعد المتابعة، أو سبب عدم تحديدها.';
    return;
  }
  const body = {
    contact_id: v.contact_id,
    track: v.track || 'sale_apt',
    intent: v.intent,
    source: v.source,
    status: effectiveStatus,
    area_label: v.area_label,
    property_type: v.property_type,
    notes: v.notes,
    next_action: v.next_action,
    next_followup_at: followup,
    no_followup_reason: v.no_followup_reason || (isTransient ? 'عميل عابر (طيارة ✈️) — محفوظ بالأرشيف' : ''),
  };
  for (const key of ['budget_min', 'budget_max', 'size_min_m2', 'size_max_m2']) {
    body[key] = v[key] ? Number(v[key]) : null;
  }
  setBusy(submit, true);
  feedback.textContent = 'جارٍ حفظ الفرصة…';
  try {
    const created = await requireApi().createOpportunity(body);
    feedback.textContent = 'تم حفظ الفرصة.';
    form.reset();
    await loadContacts();
    await loadOpportunities('', '');
    if (created.opportunity_id) {
      openPanel('opportunities-panel', { keepSheet: true });
      await openOpportunity(created.opportunity_id);
    }
  } catch (error) {
    feedback.textContent = errorText(error);
    showError(error);
  } finally {
    setBusy(submit, false);
  }
}

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => openPanel(tab.dataset.panel));
for (const trigger of document.querySelectorAll('[data-open-panel]')) trigger.addEventListener('click', () => openPanel(trigger.dataset.openPanel));
$('#record-sheet-close')?.addEventListener('click', () => closeRecordSheet());
$('#record-sheet')?.addEventListener('click', event => {
  if (event.target.id === 'record-sheet') closeRecordSheet();
});
$('#add-contact-phone-row').addEventListener('click', () => buildPhoneRow());
$('#contact-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await loadContacts($('#contact-search').value.trim()); } catch (error) { showError(error); }
});
$('#opportunity-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await loadOpportunities(); } catch (error) { showError(error); }
});
$('#refresh-all').addEventListener('click', refreshAll);
$('#logout-button').addEventListener('click', handleLogoutClick);
$('#login-form').addEventListener('submit', handleLoginSubmit);
$('#dashboard-day').addEventListener('change', async () => {
  try { await loadDashboard(); } catch (error) { showError(error); }
});
$('#new-contact-form').addEventListener('submit', handleNewContactSubmit);
$('#new-opportunity-form').addEventListener('submit', handleNewOpportunitySubmit);
$('#quick-parse-btn')?.addEventListener('click', handleQuickParseClick);
$('#quick-listing-select')?.addEventListener('change', handleQuickListingSelection);
$('#quick-entry-form')?.addEventListener('submit', handleQuickEntrySubmit);
$('#push-enable-btn')?.addEventListener('click', handleEnablePushClick);
$('#push-test-btn')?.addEventListener('click', handleTestPushClick);
$('#push-check-btn')?.addEventListener('click', handleCheckDuePushClick);
$('#push-disable-btn')?.addEventListener('click', handleDisablePushClick);
$('#pwa-install-btn')?.addEventListener('click', handlePwaInstallClick);
for (const chip of document.querySelectorAll('[data-quick-track]')) {
  chip.addEventListener('click', () => setQuickTrackChip(chip.dataset.quickTrack, { syncDefaults: true }));
}
for (const chip of document.querySelectorAll('[data-quick-intent]')) {
  chip.addEventListener('click', () => setQuickIntentChip(chip.dataset.quickIntent));
}
for (const chip of document.querySelectorAll('[data-quick-followup]')) {
  chip.addEventListener('click', () => setQuickFollowupChip(chip.dataset.quickFollowup));
}
for (const chip of document.querySelectorAll('[data-opp-track]')) {
  chip.addEventListener('click', () => selectOpportunityTrackFilter(chip.dataset.oppTrack));
}
for (const chip of document.querySelectorAll('[data-opp-role]')) {
  chip.addEventListener('click', () => selectOpportunityRoleFilter(chip.dataset.oppRole));
}
for (const chip of document.querySelectorAll('[data-contact-track]')) {
  chip.addEventListener('click', () => selectContactTrackFilter(chip.dataset.contactTrack));
}

async function bootstrap() {
  try {
    const configuredBase = document.documentElement.dataset.crmApi || '/api';
    state.api = new CRMClient({ apiBase: configuredBase });
    void ensureCrmServiceWorker();
    $('#dashboard-day').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    addConsentValidation($('#new-contact-form'));
    buildPhoneRow({ primary: true });
    $('#new-contact-form').querySelector('[data-primary]').checked = false;
    const session = await state.api.getSession();
    if (session?.authenticated) {
      unlockWorkspace();
      await refreshAll();
    } else {
      lockWorkspace('أدخل رمز الدخول للوصول إلى إدارة العملاء.', { clearInput: false });
    }
  } catch (error) {
    if (error instanceof CRMApiError && error.status === 401) {
      lockWorkspace('أدخل رمز الدخول للوصول إلى إدارة العملاء.', { clearInput: false });
    } else {
      lockWorkspace('يتعذر بدء الجلسة الآن.', { clearInput: false });
      showError(error);
    }
  } finally {
    document.documentElement.dataset.crmReady = 'true';
  }
}

await bootstrap();
