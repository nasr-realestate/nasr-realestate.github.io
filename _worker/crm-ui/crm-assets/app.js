import { CRMApiError, CRMClient } from '../crm-client.js';

const $ = selector => document.querySelector(selector);
const state = { api: null, contactId: null, opportunityId: null, contacts: [], opportunities: [] };

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
const INTENT_LABELS = { buy: 'شراء', rent: 'إيجار', sell: 'بيع', lease: 'تأجير', other: 'أخرى' };

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

function clearWorkspaceDom() {
  state.contactId = null;
  state.opportunityId = null;
  state.contacts = [];
  state.opportunities = [];
  $('#dashboard-metrics').replaceChildren();
  $('#due-list').replaceChildren();
  $('#overdue-list').replaceChildren();
  $('#contact-results').replaceChildren();
  $('#contact-detail').replaceChildren(node('p', 'اختر عميلًا لعرض ملفه وأرقامه وفرصه.', 'muted'));
  $('#opportunity-results').replaceChildren();
  $('#opportunity-detail').replaceChildren(node('p', 'اختر فرصة لعرض نشاطها والعقارات المرتبطة بها.', 'muted'));
  $('#opportunity-contact').replaceChildren(new Option('اختر عميلًا…', ''));
  $('#due-count').textContent = '0';
  $('#overdue-count').textContent = '0';
  $('#contact-search-state').textContent = '';
}

function lockWorkspace(statusMessage = 'أدخل رمز الدخول للوصول إلى إدارة العملاء.') {
  clearWorkspaceDom();
  $('#crm-workspace').hidden = true;
  $('#refresh-all').hidden = true;
  $('#logout-button').hidden = true;
  $('#login-panel').hidden = false;
  $('#access-code-input').value = '';
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

function isoFromLocal(value) {
  return value ? new Date(value).toISOString() : null;
}

function requireApi() {
  if (!state.api) throw new CRMApiError('configuration', 'واجهة API غير مهيأة. لا تُرسل أي بيانات.');
  return state.api;
}

function openPanel(panelId) {
  document.querySelectorAll('.panel').forEach(panel => { panel.hidden = panel.id !== panelId; });
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.panel === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

function clickableRecord(title, subtitle, onClick, meta = []) {
  const item = button('', onClick, 'record');
  item.append(node('strong', title), node('small', subtitle));
  if (meta.length) {
    const tags = node('span', '', 'record-meta');
    for (const text of meta) tags.append(node('span', text, 'pill'));
    item.append(tags);
  }
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

async function loadDashboard() {
  const day = $('#dashboard-day').value || undefined;
  const result = await requireApi().getDashboard(day);
  const counts = result.counts || {};
  const metrics = $('#dashboard-metrics');
  metrics.replaceChildren();
  const cards = [
    ['فرص نشطة', counts.active],
    ['مستحق اليوم', counts.due_today],
    ['متأخر', counts.overdue],
    ['تحتاج خطوة تالية', counts.missing_next_step],
  ];
  for (const [label, value] of cards) {
    const card = node('div', '', 'metric');
    card.append(node('span', label), node('b', value ?? 0));
    metrics.append(card);
  }
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
      row.name || row.contact_name || 'عميل',
      `${row.next_action || 'لا يوجد إجراء'} · ${dateLabel(row.next_followup_at)}`,
      () => openOpportunity(row.id),
      [intentLabel(row.intent), statusLabel(row.status)],
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

async function loadContacts(query = '') {
  $('#contact-search-state').textContent = 'جارٍ البحث…';
  const result = await requireApi().searchContacts(query);
  state.contacts = result.contacts || [];
  const list = $('#contact-results');
  list.replaceChildren();
  if (!state.contacts.length) {
    const emptyText = query ? 'لا توجد نتائج مطابقة.' : 'لا يوجد عملاء بعد. أضف أول عميل يدويًا.';
    list.append(node('p', emptyText, 'muted'));
  }
  for (const contact of state.contacts) {
    const numbers = (contact.phone_numbers || '').split(',').filter(Boolean);
    const subtitle = numbers.length ? numbers.map(prettyPhone).join(' · ') : 'لا يوجد رقم هاتف';
    const consentTag = contact.communication_consent === 'do_not_contact' ? 'عدم التواصل' : 'متابعة الطلب فقط';
    list.append(clickableRecord(
      contact.name || 'عميل بلا اسم',
      subtitle,
      () => openContact(contact.id),
      [`${contact.opportunity_count || 0} فرصة`, consentTag],
    ));
  }
  $('#contact-search-state').textContent = `${state.contacts.length} سجل`;
  syncOpportunityContactSelect(state.contacts);
}

function buildAddPhoneForm(contactId) {
  const addPhoneForm = node('form', '', 'activity-form');
  addPhoneForm.append(node('h3', 'إضافة رقم هاتف'));
  const phoneInput = node('input');
  phoneInput.type = 'tel';
  phoneInput.name = 'phone';
  phoneInput.required = true;
  phoneInput.placeholder = 'رقم الهاتف';
  phoneInput.autocomplete = 'tel';
  const labelInput = node('input');
  labelInput.name = 'label';
  labelInput.maxLength = 40;
  labelInput.placeholder = 'التسمية (مثال: عمل)';
  const primaryLabel = node('label', '', 'primary-check');
  const primaryInput = node('input');
  primaryInput.type = 'checkbox';
  primaryInput.name = 'is_primary';
  primaryLabel.append(primaryInput, document.createTextNode('جعله الرقم الأساسي'));
  const submit = node('button', 'إضافة الرقم', 'button primary');
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
      await openContact(contactId);
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      setBusy(submit, false);
    }
  });
  return addPhoneForm;
}

function renderContactPhonesSection(contactId, phones) {
  const phoneSection = node('section', '', 'detail-section');
  phoneSection.append(node('h3', 'أرقام الهاتف'));
  const phoneList = node('ul', '', 'detail-list');
  for (const phone of phones) {
    const li = node('li');
    const primarySuffix = phone.is_primary ? ' · أساسي' : '';
    li.append(
      node('span', prettyPhone(phone.phone_key), 'phone-number'),
      document.createTextNode(` · ${phone.label || 'بدون تسمية'}${primarySuffix}`),
    );
    phoneList.append(li);
  }
  if (!phones.length) phoneList.append(node('li', 'لا توجد أرقام مسجلة.', 'muted'));
  phoneSection.append(phoneList, buildAddPhoneForm(contactId));
  return phoneSection;
}

function renderContactOpportunitiesSection(contactId, opportunities) {
  const oppSection = node('section', '', 'detail-section');
  const oppHeading = node('div', '', 'card-heading');
  const addOppBtn = button('＋ فرصة', () => {
    openPanel('new-opportunity-panel');
    $('#opportunity-contact').value = contactId;
  }, 'button small');
  oppHeading.append(node('h3', 'الفرص المرتبطة'), addOppBtn);
  oppSection.append(oppHeading);
  const oppList = node('div', '', 'stack');
  for (const opportunity of opportunities) {
    oppList.append(clickableRecord(
      intentLabel(opportunity.intent),
      `${opportunity.area_label || 'مدينة نصر'} · ${statusLabel(opportunity.status)}`,
      () => openOpportunity(opportunity.id),
      [opportunity.next_action || 'لا يوجد إجراء', dateLabel(opportunity.next_followup_at)],
    ));
  }
  if (!opportunities.length) oppList.append(node('p', 'لا توجد فرص مرتبطة بهذا العميل.', 'muted'));
  oppSection.append(oppList);
  return oppSection;
}

async function openContact(contactId) {
  state.contactId = contactId;
  openPanel('contacts-panel');
  const detail = $('#contact-detail');
  detail.replaceChildren(node('p', 'جارٍ تحميل ملف العميل…', 'muted'));
  const result = await requireApi().getContact(contactId);
  const { contact } = result;
  detail.replaceChildren();
  const heading = node('div', '', 'card-heading');
  heading.append(
    node('h2', contact.name || 'عميل بلا اسم'),
    node('span', consentLabel(contact.communication_consent), 'pill'),
  );
  detail.append(
    heading,
    renderContactPhonesSection(contactId, result.phones || []),
    renderContactOpportunitiesSection(contactId, result.opportunities || []),
  );
}

async function loadOpportunities(query = $('#opportunity-search').value, status = $('#opportunity-status').value) {
  const container = $('#opportunity-results');
  container.replaceChildren(node('p', 'جارٍ البحث…', 'muted'));
  const result = await requireApi().searchOpportunities(query, status);
  state.opportunities = result.opportunities || [];
  container.replaceChildren();
  if (!state.opportunities.length) container.append(node('p', 'لا توجد فرص مطابقة.', 'muted'));
  for (const opportunity of state.opportunities) {
    container.append(clickableRecord(
      opportunity.contact_name || 'عميل',
      `${intentLabel(opportunity.intent)} · ${opportunity.area_label || 'مدينة نصر'}`,
      () => openOpportunity(opportunity.id),
      [statusLabel(opportunity.status), dateLabel(opportunity.next_followup_at)],
    ));
  }
}

function renderOpportunityActivities(opportunity, activities) {
  const activitySection = node('section', '', 'detail-section');
  activitySection.append(node('h3', 'سجل المتابعة'));
  const activityList = node('ul', '', 'detail-list');
  for (const activity of activities) {
    const li = node('li');
    li.append(node('strong', dateLabel(activity.created_at)), document.createTextNode(` · ${activity.summary}`));
    if (activity.outcome) li.append(node('small', ` — ${activity.outcome}`));
    activityList.append(li);
  }
  if (!activities.length) activityList.append(node('li', 'لا توجد أنشطة مسجلة.', 'muted'));
  activitySection.append(activityList, activityForm(opportunity));
  return activitySection;
}

function renderOpportunityProperties(opportunityId, properties) {
  const propertySection = node('section', '', 'detail-section');
  propertySection.append(node('h3', 'العقارات المرتبطة بمدينة نصر'));
  const propertyList = node('div', '', 'stack');
  for (const property of properties) {
    const item = node('div', '', 'property-option');
    item.append(
      node('strong', property.title || property.external_id),
      node('small', `${property.area_name || 'مدينة نصر'} · ${property.area_m2 ?? '—'} م² · ${money(property.price)}`),
      node('small', `حالة العرض: ${property.presentation_status || '—'}`),
    );
    propertyList.append(item);
  }
  if (!properties.length) propertyList.append(node('p', 'لم يتم ربط عقار بهذه الفرصة.', 'muted'));
  propertySection.append(propertyList, propertySearchForm(opportunityId));
  return propertySection;
}

async function openOpportunity(opportunityId) {
  state.opportunityId = opportunityId;
  openPanel('opportunities-panel');
  const detail = $('#opportunity-detail');
  detail.replaceChildren(node('p', 'جارٍ تحميل الفرصة…', 'muted'));
  const result = await requireApi().getOpportunity(opportunityId);
  const { opportunity } = result;
  detail.replaceChildren();
  detail.append(node('h2', `${intentLabel(opportunity.intent)} · ${opportunity.contact_name || 'عميل'}`));
  pushText(detail, 'الحالة', statusLabel(opportunity.status));
  pushText(detail, 'المنطقة', opportunity.area_label || 'مدينة نصر');
  pushText(detail, 'الميزانية', `${money(opportunity.budget_min)} – ${money(opportunity.budget_max)}`);
  pushText(detail, 'المساحة', `${opportunity.size_min_m2 ?? '—'} – ${opportunity.size_max_m2 ?? '—'} م²`);
  pushText(detail, 'الإجراء القادم', opportunity.next_action || '—');
  pushText(detail, 'موعد المتابعة', dateLabel(opportunity.next_followup_at));
  if (opportunity.notes) pushText(detail, 'ملاحظات', opportunity.notes);
  detail.append(
    renderOpportunityActivities(opportunity, result.activities || []),
    renderOpportunityProperties(opportunityId, result.properties || []),
  );
}

function activityForm(opportunity) {
  const form = node('form', '', 'activity-form');
  form.append(node('h3', 'تسجيل متابعة'));
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
  const submit = node('button', 'حفظ المتابعة', 'button primary');
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
  const link = node('button', 'ربط بهذه الفرصة', 'button small');
  link.type = 'button';
  link.addEventListener('click', async () => {
    link.disabled = true;
    try {
      await requireApi().linkProperty(opportunityId, {
        external_id: listing.external_id,
        presentation_status: 'presented',
        presented_price: listing.price ?? null,
        activity_summary: `تم عرض عقار ${listing.external_id}`,
      });
      await openOpportunity(opportunityId);
    } catch (error) {
      feedback.textContent = errorText(error);
      link.disabled = false;
    }
  });
  item.append(link);
  return item;
}

function propertySearchForm(opportunityId) {
  const form = node('form', '', 'property-form');
  form.append(node('h3', 'البحث عن عقار لربطه'));
  const query = node('input');
  query.type = 'search';
  query.name = 'q';
  query.placeholder = 'اسم العقار أو المنطقة';
  query.maxLength = 80;
  const submit = node('button', 'بحث في عقارات مدينة نصر', 'button');
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

async function refreshAll() {
  clearError();
  setNotice($('#app-status'), 'جارٍ تحميل بيانات CRM…', 'info');
  $('#security-status').textContent = 'جارٍ التحميل…';
  try {
    await Promise.all([loadDashboard(), loadContacts(), loadOpportunities('', '')]);
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
    if (created.contact_id) await openContact(created.contact_id);
  } catch (error) {
    feedback.textContent = errorText(error);
    showError(error);
  } finally {
    setBusy(submit, false);
  }
}

async function handleNewOpportunitySubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const feedback = $('#new-opportunity-feedback');
  const v = Object.fromEntries(new FormData(form));
  const followup = isoFromLocal(v.next_followup_at);
  const activeStatuses = ['active', 'visit_scheduled', 'viewing_done', 'offer', 'negotiating', 'near_close'];
  if (activeStatuses.includes(v.status) && (!v.next_action?.trim() || !followup) && !v.no_followup_reason?.trim()) {
    feedback.textContent = 'أدخل الإجراء وموعد المتابعة، أو سبب عدم تحديدها.';
    return;
  }
  const body = {
    contact_id: v.contact_id,
    intent: v.intent,
    source: v.source,
    status: v.status,
    area_label: v.area_label,
    property_type: v.property_type,
    notes: v.notes,
    next_action: v.next_action,
    next_followup_at: followup,
    no_followup_reason: v.no_followup_reason,
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
    if (created.opportunity_id) await openOpportunity(created.opportunity_id);
  } catch (error) {
    feedback.textContent = errorText(error);
    showError(error);
  } finally {
    setBusy(submit, false);
  }
}

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => openPanel(tab.dataset.panel));
for (const trigger of document.querySelectorAll('[data-open-panel]')) trigger.addEventListener('click', () => openPanel(trigger.dataset.openPanel));
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

async function bootstrap() {
  try {
    const configuredBase = document.documentElement.dataset.crmApi || '/api';
    state.api = new CRMClient({ apiBase: configuredBase });
    $('#dashboard-day').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    addConsentValidation($('#new-contact-form'));
    buildPhoneRow({ primary: true });
    $('#new-contact-form').querySelector('[data-primary]').checked = false;
    const session = await state.api.getSession();
    if (session?.authenticated) {
      unlockWorkspace();
      await refreshAll();
    } else {
      lockWorkspace();
    }
  } catch (error) {
    if (error instanceof CRMApiError && error.status === 401) {
      lockWorkspace('أدخل رمز الدخول للوصول إلى إدارة العملاء.');
    } else {
      lockWorkspace('يتعذر بدء الجلسة الآن.');
      showError(error);
    }
  }
}

await bootstrap();
