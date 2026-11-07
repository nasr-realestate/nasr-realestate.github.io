/**
 * لوحة A5 التشغيلية — داخلية بحتة، عربية، تُقرأ على الموبايل.
 *
 * تغطي أربع لوحات: ملف العميل الموحَّد، طلبات العميل (شراء/إيجار)، قوائم العمل (المستحق والمتأخر والصامت
 * والطلبات بلا مطابق)، وشاشة مراجعة ملفات Drive مع قراراتها.
 *
 * قواعد مقصودة يستحسن أن يلاحظها المراجع:
 *  - لا شيء يُختَرع في المتصفح: التواريخ والمفاتيح والبصمات يحسبها الخادم، واللوحة تعرض ما يرجع فقط.
 *  - الرفض يُعرَض ولا يُخفى: أي CRMApiError يظهر كنص عربي مع رمز الخط واسم الحاجز (barrier) من قاعدة البيانات.
 *  - لا استدعاء لـDrive ولا قراءة لمحتوى ملف من هنا: المراجعة تُعرض من سجل 0011 فقط.
 *  - الأسماء والجزء من الهاتف للبحث فقط؛ لا يُدمَج عميلان تلقائيًا ولا تُنسَخ أرقام من مكان لآخر.
 *  - كل دالة render نقية تستقبل العنصر، حتى تُختبر بلا متصفح.
 */
import { CRMApiError } from '../crm-client.js';

const REQUEST_KIND_LABELS = { buy: 'شراء', rent: 'إيجار' };
const REQUEST_STATUS_LABELS = { new: 'جديد', active: 'قيد العمل', paused: 'موقوف', closed: 'مغلق', cancelled: 'ملغي' };
/** حالات نافذة السبعة أيام كما يعيدها الخادم (`window.state`) — لا حالة تُخترع هنا. */
const WINDOW_STATE_LABELS = { fresh: 'حيّ', closing: 'آخر فرصة', expired: 'انتهت', met: 'لُبّي', unknown: 'بلا تاريخ' };
const REQUEST_PROPERTY_LABELS = {
  apartment: 'شقة', penthouse: 'بنتهاوس', duplex: 'دوبلكس', villa: 'فيلا', office: 'مكتب', retail: 'محل', hq: 'مقر إداري',
};
const INTERACTION_KIND_LABELS = {
  call: 'مكالمة', whatsapp: 'واتساب', conversation: 'محادثة', followup: 'متابعة', viewing: 'معاينة',
  meeting: 'اجتماع', note: 'ملاحظة داخلية', status_change: 'تغيّر حالة',
};
/** مفردات 0011 نفسها — لا قرار «دمج» ولا «مطابقة تلقائية» في هذه اللوحة. */
const REVIEW_DECISION_LABELS = {
  noted: 'ملاحظة فقط — الحالة تبقى مفتوحة',
  request_content_read: 'طلب قراءة المحتوى (يتطلب موافقة منفصلة)',
  close_no_action: 'إغلاق بلا إجراء',
  recommend_registration: 'توصية بتسجيل الملف في الفهرس',
  schedule_rehash: 'جدولة إعادة حساب البصمة',
  reject_duplicate_claim: 'رفض ادّعاء تكرار — لا دمج ولا إلغاء سجل بقرار من الواجهة',
  link_proposed: 'اقتراح ربط بعميل (بلا تطبيق)',
  unlink_recorded: 'توثيق فك الربط',
  escalate_to_contact_review: 'تصعيد إلى مراجعة جهة اتصال',
  supersede: 'استبدال قرار سابق',
};
const REVIEW_STATUS_LABELS = {
  open: 'مفتوحة', awaiting_content: 'بانتظار قراءة المحتوى', decided: 'مُقرَّر', escalated: 'مُصعَّد',
  closed_no_action: 'مغلقة بلا إجراء', stale: 'قديم',
};
const FIELD_LABELS = {
  contact_id: 'العميل', request_id: 'الطلب', opportunity_id: 'الفرصة', listing_id: 'العقار المعروض',
  evidence_ref: 'الدليل', reason: 'السبب', summary: 'الملخص', reviewer: 'المراجع', actor: 'اسمك',
  due_at: 'الموعد', occurred_at: 'التوقيت', case_ref: 'رقم الحالة', decision: 'القرار',
};

const $ = selector => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
function empty(node, message) {
  clear(node);
  node.appendChild(el('p', 'muted', message));
}
function dateTime(value) {
  if (!value) return '—';
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat('ar-EG', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Cairo', numberingSystem: 'latn',
  }).format(parsed);
}
function number(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(Number(value));
}
function budgetText(row) {
  if (row.budget_min === null && row.budget_max === null) return 'بلا ميزانية محددة';
  if (row.budget_min !== null && row.budget_max !== null) return `${number(row.budget_min)} – ${number(row.budget_max)}`;
  return row.budget_min !== null ? `من ${number(row.budget_min)}` : `حتى ${number(row.budget_max)}`;
}
function areaText(row) {
  const parts = [row.area, row.sub_area].filter(Boolean);
  if (row.area_min_m2 || row.area_max_m2) parts.push(`${number(row.area_min_m2 || '—')}–${number(row.area_max_m2 || '—')} م²`);
  else if (row.area_m2) parts.push(`${number(row.area_m2)} م²`);
  if (row.rooms) parts.push(`${number(row.rooms)} غرف`);
  return parts.length ? parts.join(' · ') : 'غير محدد';
}

/** ترجمة الرفض إلى جملة داخلية واضحة، مع إبقاء رمز الخط واسم الحاجز مرئيين. */
export function refusalMessage(error) {
  if (error instanceof CRMApiError) {
    const code = error.code && error.code !== 'server_error' ? error.code : '';
    const barrier = error.detail && error.detail.barrier ? error.detail.barrier : (error.barrier || '');
    const known = {
      authentication_required: 'انتهت الجلسة أو لم تبدأ. سجّل الدخول أولًا.',
      csrf_invalid: 'رمز الحماية غير مطابق — أعد تحميل الصفحة ثم حاول مرة أخرى.',
      origin_not_allowed: 'الطلب جاء من نطاق غير مسموح.',
      duplicate_request: 'يوجد طلب مطابق لهذا العميل؛ افتحه وحدّث حالته بدل إنشاء نسخة.',
      duplicate_interaction: 'هذا الحدث مسجّل بالفعل في الخط الزمني؛ لم تُضَعَّف السجلات.',
      duplicate_record: 'السجل موجود مسبقًا — لم تُكرَر العملية.',
      already_exists: 'العلاقة مسجّلة بالفعل بهذه الصورة.',
      illegal_status_transition: 'هذا الانتقال في حالة الطلب غير مسموح. الانتقالات المشروعة مبيّنة في بطاقة الطلب.',
      closed_request_is_final: 'الطلب المُغلَق لا يُعاد فتحه من هنا؛ يسجَّل طلب جديد بسببه.',
      status_unchanged: 'الحالة كما هي بالفعل.',
      evidence_ref_required: 'لا يُربَط طلب بعقار без دليل (رسالة واتساب، أو ملف، أو مكالمة موثّقة).',
      followup_needs_request_or_opportunity: 'المتابعة لازم ترتبط بطلب أو بفرصة — لا متابعة في الهواء.',
      followup_already_open: 'فيه متابعة مفتوحة على نفس الهدف بالفعل.',
      followup_is_already_final: 'انتهت هذه المتابعة؛ لا تُعاد فتحها، تُسجَّل متابعة جديدة.',
      reason_contains_identifier_like_digits: 'لا يُكتب رقم هاتف أو رقم قومي داخل السبب؛ 0011 يرفض ذلك.',
      version_record_missing: 'لا قرار مراجعة بلا سجل إصدار موثَّق للملف.',
      case_stale_newer_version: 'ظهر إصدار أحدث من الملف؛ الحالة قديمة ولا تُغلَق عليها.',
      session_not_live: 'جلسة الدخول لا تُقبل عند الدفتر (وحدة الوقت في crm_sessions). راجع تقرير A5.',
      actor_not_human: 'اسم المنفّذ لازم يكون إنسانًا مسمّى، لا اسم أداة.',
      reviewer_not_human: 'المراجع لازم يكون إنسانًا مسمّى.',
      request_body_too_large: 'البيانات أكبر من الحد المسموح؛ اختصر النص.',
    };
    const lead = known[code] || error.message || 'رفضت الخادم الطلب.';
    const tags = [code ? `رمز الرفض: ${code}` : '', barrier ? `الحاجز: ${barrier}` : ''].filter(Boolean).join(' — ');
    return tags ? `${lead} (${tags})` : lead;
  }
  return 'حدث خطأ غير متوقع. لم يُحفظ شيء حتى تتأكد الخادم.';
}

function renderRefusal(container, error) {
  const box = el('div', 'a5-refusal');
  box.setAttribute('role', 'status');
  box.appendChild(el('strong', null, 'العملية لم تُنفَّذ'));
  box.appendChild(el('p', null, refusalMessage(error)));
  clear(container);
  container.appendChild(box);
  return box;
}

export function renderRequestCard(row, { onSelect, onOpen } = {}) {
  const card = el('article', 'a5-item');
  card.dataset.requestId = row.id;
  const head = el('div', 'a5-item-head');
  head.appendChild(el('h4', null, `${REQUEST_KIND_LABELS[row.kind] || row.kind} · ${REQUEST_PROPERTY_LABELS[row.property_type] || row.property_type || 'نوع غير محدد'}`));
  head.appendChild(el('span', `a5-chip a5-status-${row.status}`, REQUEST_STATUS_LABELS[row.status] || row.status));
  card.appendChild(head);
  const meta = el('p', 'a5-meta');
  meta.textContent = `${row.contact_name || row.contact_id} · ${areaText(row)} · ${budgetText(row)}${row.currency ? ` ${row.currency}` : ''}`;
  card.appendChild(meta);
  const links = row.listing_links || [];
  card.appendChild(el('p', 'a5-meta', links.length
    ? `مرشّحات معروضة: ${links.map(link => `${link.listing_title || link.listing_id} (${link.state})`).join('، ')}`
    : 'لا عقار مرتبط بعد — يبقى الطلب في قائمة «بلا مطابق».'));
  card.appendChild(el('p', 'a5-meta', `أُغلق بسبب: ${row.stop_reason || row.closed_at ? (row.stop_reason || '—') : '—'} · آخر تحديث ${dateTime(row.updated_at)}`));
  if (onOpen) {
    const button = el('button', 'a5-mini-button', 'فتح الملف');
    button.type = 'button';
    button.addEventListener('click', () => onOpen(row));
    card.appendChild(button);
  }
  if (onSelect) onSelect(card, row);
  return card;
}

export function renderRequestDetail(detail, container, { onStatus, onLink, onDecide } = {}) {
  const request = detail.request || detail;
  clear(container);
  const card = el('article', 'card a5-detail');
  card.appendChild(el('h3', null, `${REQUEST_KIND_LABELS[request.kind] || request.kind} — ${request.contact_name || request.contact_id}`));
  const facts = el('dl', 'a5-facts');
  const fact = (label, value) => {
    facts.appendChild(el('dt', null, label));
    facts.appendChild(el('dd', null, value));
  };
  fact('المدينة', request.city || 'مدينة نصر');
  fact('المنطقة', `${request.area || 'غير محددة'}${request.sub_area ? ` · ${request.sub_area}` : ''}`);
  fact('المساحة', areaText(request));
  fact('الميزانية', `${budgetText(request)}${request.currency ? ` ${request.currency}` : ''}`);
  fact('الحالة', REQUEST_STATUS_LABELS[request.status] || request.status);
  fact('المصدر', request.source || '—');
  fact('مواصفات إضافية', request.requirements || '—');
  fact('سبب الإيقاف/الإغلاق', request.stop_reason || '—');
  fact('أُنشئ', dateTime(request.created_at));
  fact('حُدّث', dateTime(request.updated_at));
  card.appendChild(facts);

  const history = el('div', 'a5-block');
  history.appendChild(el('h4', null, 'سجل الحالة'));
  const list = el('ol', 'a5-list');
  (request.status_history || []).forEach(row => {
    list.appendChild(el('li', null, `${row.from_status ? `${REQUEST_STATUS_LABELS[row.from_status] || row.from_status} ← ` : ''}${REQUEST_STATUS_LABELS[row.to_status] || row.to_status} · ${dateTime(row.changed_at)}${row.reason ? ` · ${row.reason}` : ''}`));
  });
  if (!(request.status_history || []).length) list.appendChild(el('li', 'muted', 'لا انتقالات مسجّلة.'));
  history.appendChild(list);
  card.appendChild(history);

  const links = el('div', 'a5-block');
  links.appendChild(el('h4', null, 'العقارات المعروضة المرتبطة'));
  const linkList = el('ul', 'a5-list');
  (request.listing_links || []).forEach(link => {
    const item = el('li', 'a5-link-row');
    item.appendChild(el('span', null, `${link.listing_title || link.listing_id} — ${link.state === 'confirmed' ? 'مؤكَّد' : link.state === 'rejected' ? 'مرفوض' : 'مقترح'}`));
    item.appendChild(el('span', 'a5-meta', `دليل: ${link.evidence_ref || '—'}${link.decided_by ? ` · قرار: ${link.decided_by}` : ''}`));
    if (onDecide && link.state === 'proposed') {
      const actions = el('div', 'a5-actions');
      for (const [label, state] of [['تأكيد', 'confirmed'], ['رفض', 'rejected']]) {
        const button = el('button', 'a5-mini-button', label);
        button.type = 'button';
        button.addEventListener('click', () => onDecide(request.id, link.id, state));
        actions.appendChild(button);
      }
      item.appendChild(actions);
    }
    linkList.appendChild(item);
  });
  if (!(request.listing_links || []).length) linkList.appendChild(el('li', 'muted', 'لا ربط موثَّق. الربط يبدأ بدليل، لا بتوقّع.'));
  links.appendChild(linkList);
  if (onLink && request.status !== 'closed' && request.status !== 'cancelled') {
    const form = el('form', 'a5-inline-form');
    const listing = document.createElement('input');
    listing.name = 'listing_id'; listing.placeholder = 'معرّف العقار المعروض'; listing.required = true; listing.inputMode = 'numeric';
    const evidence = document.createElement('input');
    evidence.name = 'evidence_ref'; evidence.placeholder = 'دليل: wa:msg:… أو drive:file:…'; evidence.required = true;
    form.appendChild(listing);
    form.appendChild(evidence);
    const submit = el('button', 'button small', 'اقتراح ربط');
    submit.type = 'submit';
    form.appendChild(submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      onLink(request.id, { listing_id: Number(listing.value), evidence_ref: evidence.value.trim() });
    });
    links.appendChild(form);
  }
  card.appendChild(links);

  if (onStatus) {
    const picker = el('div', 'a5-actions');
    const allowed = { new: ['active', 'cancelled'], active: ['paused', 'closed', 'cancelled'], paused: ['active', 'closed', 'cancelled'], closed: [], cancelled: [] }[request.status] || [];
    for (const status of allowed) {
      const button = el('button', 'a5-mini-button', status === 'active' ? 'استئناف العمل' : status === 'paused' ? 'إيقاف مؤقت' : status === 'closed' ? 'إغلاق' : 'إلغاء');
      button.type = 'button';
      button.addEventListener('click', () => onStatus(request.id, status));
      picker.appendChild(button);
    }
    if (!allowed.length) picker.appendChild(el('p', 'muted', 'الحالة نهائية: لا تُعاد من هذه اللوحة.'));
    card.appendChild(picker);
  }
  container.appendChild(card);
  return card;
}

export function renderTimeline(interactions, container) {
  const rows = (interactions || []).slice().sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  if (!rows.length) return empty(container, 'لا تفاعلات مسجّلة بعد.');
  clear(container);
  const list = el('ol', 'a5-timeline');
  for (const row of rows) {
    const item = el('li', 'a5-event');
    const head = el('div', 'a5-event-head');
    head.appendChild(el('span', `a5-chip a5-kind-${row.kind}`, INTERACTION_KIND_LABELS[row.kind] || row.kind));
    head.appendChild(el('time', null, dateTime(row.occurred_at)));
    item.appendChild(head);
    item.appendChild(el('p', null, row.summary || '—'));
    const meta = [];
    if (row.outcome) meta.push(`النتيجة: ${row.outcome}`);
    if (row.next_step) meta.push(`الخطوة التالية: ${row.next_step}`);
    if (row.next_followup_at) meta.push(`موعد المتابعة: ${dateTime(row.next_followup_at)}`);
    if (row.legacy_ref_table) meta.push(`مرجع أرشيفي: ${row.legacy_ref_table}#${row.legacy_ref_id}`);
    meta.push(`المصدر: ${row.source || 'manual'}${row.created_by ? ` · ${row.created_by}` : ''}`);
    item.appendChild(el('p', 'a5-meta', meta.join(' · ')));
    list.appendChild(item);
  }
  container.appendChild(list);
  return list;
}

export function renderCustomerFile(file, container) {
  clear(container);
  const card = el('article', 'card a5-detail');
  card.appendChild(el('h3', null, file.contact.name || file.contact.id));
  const phones = el('ul', 'a5-list');
  for (const phone of file.phones || []) {
    phones.appendChild(el('li', null, `${phone.phone_key}${phone.is_primary ? ' — أساسي' : ''}${phone.label ? ` (${phone.label})` : ''}`));
  }
  if (!(file.phones || []).length) phones.appendChild(el('li', 'muted', 'لا أرقام موثَّقة — يحتاج مراجعة.'));
  card.appendChild(el('h4', null, 'الأرقام'));
  card.appendChild(phones);
  const consent = el('p', 'a5-meta', `الحالة التسويقية: ${{ request_only: 'طلبات فقط', marketing_yes: 'موافق على التسويق', do_not_contact: 'ممنوع التواصل' }[file.contact.communication_consent] || file.contact.communication_consent || '—'}`);
  card.appendChild(consent);
  container.appendChild(card);

  const sections = [
    ['الطلبات', file.requests || [], (target, row) => {
      target.appendChild(el('li', null, `${REQUEST_KIND_LABELS[row.kind] || row.kind} · ${REQUEST_STATUS_LABELS[row.status] || row.status} · ${areaText(row)} · ${budgetText(row)}`));
    }],
    ['الفرص', file.opportunities || [], (target, row) => {
      target.appendChild(el('li', null, `${row.lead_label || row.id} · ${row.status}${row.next_action ? ` · الخطوة: ${row.next_action}` : ''}`));
    }],
  ];
  for (const [title, rows, push] of sections) {
    const block = el('section', 'card');
    block.appendChild(el('h4', null, title));
    const list = el('ul', 'a5-list');
    if (!rows.length) list.appendChild(el('li', 'muted', title === 'الطلبات' ? 'لا طلبات مسجّلة لهذا العميل.' : 'لا فرص مرتبطة.'));
    else rows.forEach(row => push(list, row));
    block.appendChild(list);
    container.appendChild(block);
  }
  const timelineCard = el('section', 'card');
  timelineCard.appendChild(el('h4', null, 'الخط الزمني الموحَّد'));
  const timelineHost = el('div', 'a5-timeline-host');
  renderTimeline(file.interactions || [], timelineHost);
  timelineCard.appendChild(timelineHost);
  container.appendChild(timelineCard);
  return container;
}

/** What is left of a request's seven days, in words — one place, so no screen invents its own. */
function windowWhen(win) {
  const left = win?.days_left;
  if (typeof left !== 'number') return 'بلا تاريخ';
  return left <= 0 ? 'انتهت مدته' : `بقيت ${number(left)} يومًا`;
}

export function renderQueues(payload, container, { onCompleteFollowup } = {}) {
  clear(container);
  const counts = payload.counts || {};
  const strip = el('div', 'a5-counts');
  for (const [key, label] of [['expiring', 'تنتهي قريبًا'], ['due', 'مستحق'], ['overdue', 'متأخر'], ['unmatched', 'طلبات بلا مطابق'], ['stale', 'فرص صامتة']]) {
    const box = el('div', `a5-count a5-count-${key}`);
    box.appendChild(el('span', 'a5-count-number', String(counts[key] ?? 0)));
    box.appendChild(el('span', 'a5-count-label', label));
    strip.appendChild(box);
  }
  container.appendChild(strip);

  const group = (title, rows, render) => {
    const block = el('section', 'card');
    block.appendChild(el('h3', null, title));
    const list = el('ul', 'a5-list');
    if (!rows || !rows.length) list.appendChild(el('li', 'muted', 'لا شيء في هذه القائمة الآن.'));
    else rows.forEach(row => render(list, row));
    block.appendChild(list);
    container.appendChild(block);
    return block;
  };

  group('طلبات تنتهي — اعرض أو ودّع', payload.expiring_requests, (list, row) => {
    const state = row.window?.state || 'unknown';
    const item = el('li', `a5-item a5-window a5-window-${state}`);
    item.appendChild(el('p', null, `${row.contact_name || row.contact_id} — ${REQUEST_KIND_LABELS[row.kind] || row.kind || 'طلب'} · ${areaText(row)} · ${budgetText(row)}`));
    const action = row.window?.action ? ` · ${row.window.action}` : '';
    item.appendChild(el('p', 'a5-meta', `${WINDOW_STATE_LABELS[state] || state} · ${windowWhen(row.window)}${action}`));
    list.appendChild(item);
  });
  group('مستحق اليوم', payload.due, (list, row) => {
    const item = el('li', 'a5-item');
    item.appendChild(el('p', null, `${row.contact_name || row.contact_id} — ${row.target_kind === 'opportunity' ? 'فرصة' : 'طلب'} ${row.target_label ? `· ${row.target_label}` : ''}`));
    item.appendChild(el('p', 'a5-meta', `الموعد: ${dateTime(row.due_at)}`));
    if (onCompleteFollowup) {
      const actions = el('div', 'a5-actions');
      const done = el('button', 'a5-mini-button', 'إنهاء بنتيجة');
      done.type = 'button';
      done.addEventListener('click', () => onCompleteFollowup(row));
      actions.appendChild(done);
      item.appendChild(actions);
    }
    list.appendChild(item);
  });
  group('متأخر', payload.overdue, (list, row) => {
    const item = el('li', 'a5-item a5-overdue');
    item.appendChild(el('p', null, `${row.contact_name || row.contact_id} — ${row.target_kind === 'opportunity' ? 'فرصة' : 'طلب'}${row.target_label ? ` · ${row.target_label}` : ''}`));
    item.appendChild(el('p', 'a5-meta', `تأخّر ${number(row.overdue_days ?? '—')} يومًا · الموعد ${dateTime(row.due_at)}`));
    if (onCompleteFollowup) {
      const actions = el('div', 'a5-actions');
      const done = el('button', 'a5-mini-button', 'إنهاء بنتيجة');
      done.type = 'button';
      done.addEventListener('click', () => onCompleteFollowup(row));
      const missed = el('button', 'a5-mini-button ghost', 'فاتت');
      missed.type = 'button';
      missed.addEventListener('click', () => onCompleteFollowup(row, 'missed'));
      actions.appendChild(done);
      actions.appendChild(missed);
      item.appendChild(actions);
    }
    list.appendChild(item);
  });
  group('طلبات نشطة بلا عقار مناسب', payload.unmatched_requests, (list, row) => {
    list.appendChild(el('li', null, `${row.contact_name || row.contact_id} — ${REQUEST_KIND_LABELS[row.kind] || row.kind} · ${areaText(row)} · ${budgetText(row)}`));
  });
  group('فرص صامتة', payload.stale_opportunities, (list, row) => {
    list.appendChild(el('li', null, `${row.contact_name || row.contact_id || row.id} — ${number(row.days_silent)} يومًا بلا تواصل · آخر نشاط ${dateTime(row.last_interaction_at)}`));
  });
  group('مراحل الفرص المفتوحة', payload.opportunity_stages, (list, row) => {
    list.appendChild(el('li', null, `${row.status} · ${number(row.count)} فرصة · معاينات ${number(row.viewings)}${row.closed_with_reason ? ` · مغلقة بسبب مبيَّن ${number(row.closed_with_reason)}` : ''}`));
  });
  return container;
}

export function renderReviewCase(detail, container, { onDecide, onProposeLink } = {}) {
  clear(container);
  const reviewCase = detail.case || detail;
  const card = el('article', 'card a5-detail');
  card.appendChild(el('h3', null, reviewCase.case_ref));
  const facts = el('dl', 'a5-facts');
  const fact = (label, value) => {
    facts.appendChild(el('dt', null, label));
    facts.appendChild(el('dd', null, value));
  };
  fact('الملف', reviewCase.file_name || reviewCase.drive_ref);
  fact('الحالة', REVIEW_STATUS_LABELS[reviewCase.status] || reviewCase.status);
  fact('التصنيف', reviewCase.review_disposition || '—');
  fact('الإصدار المرتبط', `#${reviewCase.bound_version_seq ?? '—'} · رأس الملف #${reviewCase.head_version_seq ?? '—'}`);
  fact('ربط العميل', reviewCase.crm_contact_id ? `${reviewCase.crm_contact_id} (${reviewCase.link_state || '—'})` : 'لا ربط — الربط اقتراحٌ يقرره إنسان، لا مطابقة آلية');
  fact('فُتحت', `${dateTime(reviewCase.opened_at)} · ${reviewCase.opened_by || '—'}`);
  card.appendChild(facts);
  const chain = detail.chain || {};
  card.appendChild(el('p', `a5-chain ${chain.intact ? 'ok' : 'danger'}`,
    chain.intact === false
      ? 'سلسلة القرار غير متطابقة مع مرساة الدفتر — أوقف أي إجراء وبلّغ.'
      : `سلسلة القرارات سليمة · عدد القرارات ${number(chain.decision_count ?? 0)}`));
  container.appendChild(card);

  const decisions = el('section', 'card');
  decisions.appendChild(el('h4', null, 'القرارات المسجّلة'));
  const list = el('ol', 'a5-list');
  for (const row of detail.decisions || []) {
    const item = el('li', 'a5-event');
    item.appendChild(el('p', null, `#${row.decision_seq} · ${REVIEW_DECISION_LABELS[row.decision] || row.decision} — ${row.reviewer}`));
    item.appendChild(el('p', 'a5-meta', `${dateTime(row.occurred_at)} · السبب: ${row.reason || '—'}`));
    list.appendChild(item);
  }
  if (!(detail.decisions || []).length) list.appendChild(el('li', 'muted', 'لا قرارات بعد.'));
  decisions.appendChild(list);
  container.appendChild(decisions);
  if (onDecide) onDecide(reviewCase, container);
  if (onProposeLink) onProposeLink(reviewCase, container);
  return container;
}

export function renderReviewCases(payload, container, { onOpen } = {}) {
  const rows = payload.cases || [];
  if (!rows.length) return empty(container, 'لا حالات مراجعة مفتوحة لهذا الملف أو لهذه المرشِّحات.');
  clear(container);
  for (const row of rows) {
    const item = el('button', 'a5-item a5-case');
    item.type = 'button';
    item.appendChild(el('strong', null, row.case_ref));
    item.appendChild(el('p', 'a5-meta', `${REVIEW_STATUS_LABELS[row.status] || row.status} · ${row.review_disposition} · ${number(row.decision_count)} قرار · آخر قرار ${dateTime(row.last_decision_at)}`));
    item.appendChild(el('p', 'a5-meta', row.file_name || row.drive_ref));
    if (onOpen) item.addEventListener('click', () => onOpen(row));
    container.appendChild(item);
  }
  return container;
}

/** أسماء الحقول المرشَّحة تُعرَب، والرسائل الخام لا تظهر للمستخدم. */
export function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

const STATUS_WORDS = ['الميزانية قيد المراجعة', 'تم الحجز', 'اشترى من مصدر آخر', 'أجل الطلب', 'لم يرد'];

export function createCrmA5Controller(deps = {}) {
  const api = () => deps.api();
  const promptImpl = deps.prompt || (typeof window !== 'undefined' ? (text => window.prompt(text)) : () => '');
  const notify = deps.showError || (() => {});
  const view = { requestId: null, caseRef: null, contactId: null, queues: null };

  const nodes = {
    custSearch: $('#a5-cust-search'), custResults: $('#a5-cust-results'), custFile: $('#a5-cust-file'), custError: $('#a5-cust-error'),
    reqList: $('#a5-req-list'), reqDetail: $('#a5-req-detail'), reqError: $('#a5-req-error'),
    reqKind: $('#a5-req-kind'), reqStatus: $('#a5-req-status'), reqUnmatched: $('#a5-req-unmatched'),
    reqForm: $('#a5-request-form'), reqActor: $('#a5-req-actor'),
    queues: $('#a5-queues'), fuForm: $('#a5-followup-form'), workError: $('#a5-work-error'),
    reviewList: $('#a5-review-list'), reviewDetail: $('#a5-review-detail'), reviewError: $('#a5-review-error'),
    reviewStatus: $('#a5-review-status'), reviewDisposition: $('#a5-review-disposition'),
    reviewDecision: $('#a5-review-decision'), reviewReason: $('#a5-review-reason'), reviewActor: $('#a5-review-actor'),
    reviewLinkContact: $('#a5-review-link-contact'), reviewLinkBasis: $('#a5-review-link-basis'),
  };

  function actorPayload(extra = {}) {
    const name = (nodes.reqActor?.value || '').trim();
    return name ? { ...extra, actor: name } : extra;
  }
  function guard(host) {
    return async operation => {
      try {
        await operation();
        clear(host);
        host.appendChild(el('p', 'a5-ok', 'تم.'));
      } catch (error) {
        renderRefusal(host, error);
        notify(error);
      }
    };
  }

  async function loadCustomers() {
    const host = nodes.custResults;
    if (!host) return;
    const query = (nodes.custSearch?.value || '').trim();
    if (!query) {
      empty(host, 'ابحث باسم العميل أو برقم هاتفه (٩ أرقام تكفي للبحث).');
      return;
    }
    let payload;
    try {
      payload = await api().searchContacts(query);
    } catch (error) {
      renderRefusal(nodes.custError, error);
      return;
    }
    clear(host);
    for (const contact of payload.contacts || []) {
      const button = el('button', 'a5-item', '');
      button.type = 'button';
      button.appendChild(el('strong', null, contact.name || contact.id));
      button.appendChild(el('p', 'a5-meta', `${contact.primary_phone || 'بلا رقم أساسي'} · ${number(contact.opportunity_count)} فرصة · ${contact.completeness === 'complete' ? 'ملف مكتمل' : 'ناقص'}`));
      button.addEventListener('click', () => openCustomer(contact.id));
      host.appendChild(button);
    }
    if (!(payload.contacts || []).length) empty(host, 'لا عميل مطابق. الاسم وحده أو جزء من رقم لا يثبتان الهوية — لا تُنشئ عميلًا على تخمين.');
  }

  async function openCustomer(contactId) {
    view.contactId = contactId;
    const host = nodes.custFile;
    if (!host) return;
    empty(host, 'جارٍ التحميل…');
    const run = guard(nodes.custError);
    await run(async () => {
      const [contact, requests, interactions, followups] = await Promise.all([
        api().getContact(contactId),
        api().listRequests({ contact_id: contactId }),
        api().listInteractions({ contact_id: contactId, limit: 50 }),
        api().contactsNeedingFollowup({ limit: 50 }),
      ]);
      const file = {
        contact: contact.contact || contact,
        phones: contact.phones || [],
        requests: requests.requests || [],
        opportunities: contact.opportunities || [],
        interactions: interactions.interactions || [],
      };
      file.needFollowup = (followups.contacts || []).some(row => row.contact_id === contactId);
      renderCustomerFile(file, host);
      if (requests.requests?.length) renderRequestsInto(requests.requests, nodes.reqList);
      // الطلب الجديد يُسند إلى هذا العميل لا إلى اسم يشبهه: الاسم يُعرض للتأكيد فقط.
      const hint = $('#a5-request-form-target');
      if (hint) hint.textContent = `الطلب الجديد سيُسند إلى: ${file.contact.name || contactId}`;
      if (nodes.reqForm) {
        nodes.reqForm.dataset.contactId = contactId;
        const actorField = nodes.reqActor;
        if (actorField && !actorField.value) actorField.placeholder = 'اتركه فارغًا ليُنسب إلى جلسة الدخول';
      }
    });
  }

  function renderRequestsInto(rows, host) {
    if (!host) return;
    clear(host);
    for (const row of rows) host.appendChild(renderRequestCard(row, { onOpen: detail => openRequest(detail.id) }));
    if (!rows.length) empty(host, 'لا طلبات مطابقة للفلتر.');
  }

  async function loadRequests() {
    const host = nodes.reqList;
    if (!host) return;
    const run = guard(nodes.reqError);
    await run(async () => {
      const params = { limit: 100 };
      if (nodes.reqKind?.value) params.kind = nodes.reqKind.value;
      if (nodes.reqStatus?.value) params.status = nodes.reqStatus.value;
      if (nodes.reqUnmatched?.checked) params.unmatched = '1';
      const payload = await api().listRequests(params);
      renderRequestsInto(payload.requests || [], host);
    });
  }

  async function openRequest(requestId) {
    view.requestId = requestId;
    const host = nodes.reqDetail;
    if (!host) return;
    empty(host, 'جارٍ التحميل…');
    const run = guard(nodes.reqError);
    await run(async () => {
      const detail = await api().getRequest(requestId);
      renderRequestDetail(detail, host, {
        onStatus: (id, status) => run(async () => {
          const reason = status === 'active' ? '' : (promptImpl(`سبب ${REQUEST_STATUS_LABELS[status]} — يظهر في سجل الحالة`) || '');
          await api().setRequestStatus(id, actorPayload(reason ? { status, reason } : { status }));
          await openRequest(id);
        }),
        onLink: (id, payload) => run(async () => {
          await api().linkRequestListing(id, actorPayload(payload));
          await openRequest(id);
        }),
        onDecide: (id, linkId, state) => run(async () => {
          await api().decideRequestListingLink(id, linkId, actorPayload({ state }));
          await openRequest(id);
        }),
      });
    });
  }

  async function submitRequestForm(event) {
    event.preventDefault();
    const form = nodes.reqForm;
    if (!form || !view.contactId) {
      renderRefusal(nodes.reqError, new CRMApiError('validation', 'اختر العميل من قائمة «ملف العميل» أولًا — الطلب لازم يكون لعميل معروف.', 400, 'contact_id_required'));
      return;
    }
    const data = new FormData(form);
    const payload = {
      contact_id: view.contactId,
      kind: data.get('kind'),
      property_type: data.get('property_type'),
      area: data.get('area') || undefined,
      sub_area: data.get('sub_area') || undefined,
      rooms: data.get('rooms') ? Number(data.get('rooms')) : undefined,
      area_min_m2: data.get('area_min') ? Number(data.get('area_min')) : undefined,
      area_max_m2: data.get('area_max') ? Number(data.get('area_max')) : undefined,
      budget_min: data.get('budget_min') ? Number(data.get('budget_min')) : undefined,
      budget_max: data.get('budget_max') ? Number(data.get('budget_max')) : undefined,
      requirements: data.get('requirements') || undefined,
      source: data.get('source') || 'manual',
    };
    await guard(nodes.reqError)(async () => {
      const created = await api().createRequest(actorPayload(payload));
      form.reset();
      await openRequest(created.request.id);
    });
  }

  async function loadQueues() {
    const host = nodes.queues;
    if (!host) return;
    empty(host, 'جارٍ التحميل…');
    await guard(nodes.workError)(async () => {
      const payload = await api().operationalQueues({ limit: 50 });
      view.queues = payload;
      renderQueues(payload, host, {
        onCompleteFollowup: (row, status = 'done') => {
          const outcome = status === 'done'
            ? (promptImpl('النتيجة كما حدثت — تظهر في الخط الزمني:') || '')
            : 'لم يستجب العميل بعد محاولات موثَّقة';
          if (!outcome) return;
          run(async () => {
            await api().completeFollowup(row.id, actorPayload({ status, outcome }));
            await loadQueues();
          });
        },
      });
    });
  }

  async function submitFollowupForm(event) {
    event.preventDefault();
    const form = nodes.fuForm;
    if (!form) return;
    const data = new FormData(form);
    const targetKind = data.get('target_kind');
    const payload = {
      contact_id: view.contactId || data.get('contact_id') || '',
      due_at: data.get('due_at') ? new Date(data.get('due_at')).toISOString() : '',
    };
    if (targetKind === 'opportunity') payload.opportunity_id = data.get('target_id');
    else payload.request_id = view.requestId || data.get('target_id');
    await guard(nodes.workError)(async () => {
      await api().createFollowup(actorPayload(payload));
      form.reset();
      await loadQueues();
    });
  }

  async function loadReviews() {
    const host = nodes.reviewList;
    if (!host) return;
    await guard(nodes.reviewError)(async () => {
      const params = { limit: 50 };
      if (nodes.reviewStatus?.value) params.status = nodes.reviewStatus.value;
      if (nodes.reviewDisposition?.value) params.disposition = nodes.reviewDisposition.value;
      renderReviewCases(await api().listDriveReviews(params), host, { onOpen: row => openReviewCase(row.case_ref) });
    });
  }

  async function openReviewCase(caseRef) {
    view.caseRef = caseRef;
    const host = nodes.reviewDetail;
    if (!host) return;
    empty(host, 'جارٍ التحميل…');
    await guard(nodes.reviewError)(async () => {
      const detail = await api().getDriveReview(caseRef);
      renderReviewCase(detail, host, {
        onDecide: () => {
          const form = $('#a5-review-form');
          if (form) form.hidden = false;
        },
        onProposeLink: reviewCase => {
          if (reviewCase.link_state) return;
          const form = $('#a5-review-link-form');
          if (form) form.hidden = false;
        },
      });
    });
  }

  async function submitReviewDecision(event) {
    event.preventDefault();
    const decision = nodes.reviewDecision?.value;
    const reason = (nodes.reviewReason?.value || '').trim();
    if (!view.caseRef || !decision || !reason) return;
    await guard(nodes.reviewError)(async () => {
      await api().recordDriveReviewDecision({
        case_ref: view.caseRef, decision, reason,
        ...((nodes.reviewActor?.value || '').trim() ? { reviewer: nodes.reviewActor.value.trim() } : {}),
      });
      if (nodes.reviewReason) nodes.reviewReason.value = '';
      await openReviewCase(view.caseRef);
    });
  }

  async function submitLinkProposal(event) {
    event.preventDefault();
    if (!view.caseRef) return;
    const contactId = (nodes.reviewLinkContact?.value || '').trim();
    const basis = nodes.reviewLinkBasis?.value;
    const reason = (nodes.reviewReason?.value || '').trim() || 'الربط بعد مطابقة يدوية من المراجع';
    await guard(nodes.reviewError)(async () => {
      await api().proposeDriveReviewLink({
        case_ref: view.caseRef, contact_id: contactId, link_basis: basis, reason,
        evidence_ref: `manual:review:${view.caseRef}`,
        ...((nodes.reviewActor?.value || '').trim() ? { reviewer: nodes.reviewActor.value.trim() } : {}),
      });
      await openReviewCase(view.caseRef);
    });
  }

  return {
    view,
    bindEvents() {
      nodes.reqForm?.addEventListener('submit', submitRequestForm);
      nodes.fuForm?.addEventListener('submit', submitFollowupForm);
      $('#a5-review-form')?.addEventListener('submit', submitReviewDecision);
      $('#a5-review-link-form')?.addEventListener('submit', submitLinkProposal);
      nodes.custSearch?.addEventListener('change', loadCustomers);
      $('#a5-cust-submit')?.addEventListener('click', event => { event.preventDefault(); void loadCustomers(); });
      $('#a5-req-refresh')?.addEventListener('click', event => { event.preventDefault(); void loadRequests(); });
      for (const filter of [nodes.reqKind, nodes.reqStatus, nodes.reqUnmatched]) filter?.addEventListener('change', loadRequests);
      $('#a5-queues-refresh')?.addEventListener('click', event => { event.preventDefault(); void loadQueues(); });
      $('#a5-review-refresh')?.addEventListener('click', event => { event.preventDefault(); void loadReviews(); });
      for (const filter of [nodes.reviewStatus, nodes.reviewDisposition]) filter?.addEventListener('change', loadReviews);
      for (const tab of document.querySelectorAll('.tab')) {
        tab.addEventListener('click', () => {
          const panel = tab.dataset.panel;
          if (panel === 'a5-requests-panel') void loadRequests();
          if (panel === 'a5-work-panel') void loadQueues();
          if (panel === 'a5-review-panel') void loadReviews();
        });
      }
      return this;
    },
    /** تُستدعى بعد فتح الجلسة؛ اللوحات لا تعرض بيانات قبلها. */
    async unlock() {
      await Promise.all([loadRequests().catch(() => {}), loadReviews().catch(() => {})]);
    },
    loadCustomers, loadRequests, loadQueues, loadReviews, openRequest, openCustomer,
    renderRefusal,
  };
}

export { STATUS_WORDS, REQUEST_STATUS_LABELS, REQUEST_KIND_LABELS, INTERACTION_KIND_LABELS, REVIEW_DECISION_LABELS, REVIEW_STATUS_LABELS };
