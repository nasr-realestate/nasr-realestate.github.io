// Operational Smart Follow-up Queues, Untruncated WhatsApp Conversation Viewer & Unmatched Review Queue UI.
// Strictly uses createElement + textContent only — zero unsafe DOM APIs, zero browser storage.

import { buildReadyFollowupMessage, prettyPhoneFormat, whatsappHref } from './whatsapp-templates.js';

const ALERT_TYPE_LABELS = {
  needs_followup: '🔔 يحتاج متابعة',
  followup_approaching: '⏰ موعد متابعة يقترب',
  followup_overdue: '🚨 متابعة متأخرة',
  viewing_requested_unlogged: '🏠 طلب معاينة غير مسجل',
  offer_sent_no_followup: '📤 عرض مرسل بدون متابعة',
  request_specs_changed: '🔄 تغير في مواصفات الطلب',
  unanswered_question: '💬 سؤال عميل بدون رد',
  high_interest_stalled: '🔥 اهتمام مرتفع متوقف',
};

const QUEUE_TITLES = {
  today: '📅 مستحق اليوم (توقيت القاهرة)',
  overdue: '🚨 متابعات متأخرة (مقارنة بالوقت الفعلي)',
  upcoming: '⏭️ متابعات قادمة مجدولة',
  waiting_reply: '💬 عملاء ينتظرون ردك أو تأكيد معاينة',
  stalled_intervention: '⚠️ فرص ومحادثات متوقفة تحتاج تدخل',
  new_chat_alerts: '🧠 تنبيهات محادثات جديدة وتغير مواصفات',
  unmatched_review: '🔍 محادثات غير محسومة الهوية للمراجعة اليدوية',
  all_conversations: '📂 أرشيف المحادثات الكامل (النص الأصلي غير المقتطع)',
};

function el(tag, text = '', className = '') {
  const element = document.createElement(tag);
  if (text !== '') element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function actButton(label, onClick, className = 'button small') {
  const b = el('button', label, className);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function fmtDate(value) {
  if (!value) return 'غير محدد';
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return String(value);
  return new Intl.DateTimeFormat('ar-EG', {
    timeZone: 'Africa/Cairo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

function buildSafeExternalAnchor(url, labelText = '') {
  const str = String(url || '').trim();
  if (!/^https?:\/\//i.test(str) && !str.startsWith('/')) return null;
  const a = el('a', labelText || str, 'safe-chat-link');
  a.href = str;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function buildAlertOutcomeMiniForm(item, deps) {
  const details = el('details', '', 'drawer-details compact-details');
  details.append(el('summary', '✅ تسجيل نتيجة المتابعة / إغلاق التنبيه'));
  const form = el('form', '', 'activity-form');
  const noteInput = el('input');
  noteInput.name = 'outcome_summary';
  noteInput.placeholder = 'نتيجة المتابعة (مثال: تم الاتصال وتأكيد المعاينة غدًا 5 م)';
  noteInput.maxLength = 400;
  const nextAtInput = el('input');
  nextAtInput.type = 'datetime-local';
  nextAtInput.name = 'next_followup_at';
  const row = el('div', '', 'form-actions');
  const doneBtn = el('button', 'تمت المتابعة ✓', 'button primary small');
  doneBtn.type = 'submit';
  const dismissBtn = actButton('إخفاء (غير مطلوب)', async () => {
    dismissBtn.disabled = true;
    try {
      await deps.api().resolveSmartAlert(item.alert_id, {
        status: 'dismissed',
        resolution_note: noteInput.value.trim() || 'تمت المراجعة وإغلاق التنبيه يدويًا',
      });
      await deps.refreshFollowups();
    } catch (err) {
      deps.showError(err);
      dismissBtn.disabled = false;
    }
  }, 'button quiet small');
  const fb = el('span', '', 'muted');
  row.append(doneBtn, dismissBtn, fb);
  form.append(noteInput, nextAtInput, row);
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    doneBtn.disabled = true;
    try {
      const nextIso = nextAtInput.value ? new Date(nextAtInput.value).toISOString() : undefined;
      await deps.api().resolveSmartAlert(item.alert_id, {
        status: 'completed',
        outcome_summary: noteInput.value.trim() || `تمت متابعة العميل (${item.alert_reason})`,
        log_activity: Boolean(item.opportunity_id),
        opportunity_id: item.opportunity_id || undefined,
        activity_type: 'whatsapp_note',
        next_followup_at: nextIso,
        next_action: nextIso ? 'متابعة تالية مجدولة' : undefined,
      });
      await deps.refreshFollowups();
    } catch (err) {
      fb.textContent = deps.errorText(err);
      doneBtn.disabled = false;
    }
  });
  details.append(form);
  return details;
}

function renderFollowupQueueCard(item, deps) {
  const card = el('article', '', 'card followup-alert-card');
  const head = el('div', '', 'card-heading');
  const typeBadge = item.alert_type
    ? (ALERT_TYPE_LABELS[item.alert_type] || item.alert_type)
    : '📅 موعد مجدول';
  const confPct = Number.isFinite(Number(item.confidence)) ? `${Math.round(Number(item.confidence) * 100)}% ثقة` : '';
  head.append(
    el('strong', item.customer_name || 'عميل'),
    el('span', confPct ? `${typeBadge} · ${confPct}` : typeBadge, item.priority === 'high' ? 'pill danger-pill' : 'pill'),
  );
  card.append(head);

  card.append(el('p', `السبب: ${item.alert_reason || 'متابعة مطلوبة'}`, 'followup-reason'));
  if (item.area_label || item.property_type) {
    card.append(el('small', `الفرصة المرتبطة: ${item.property_type || 'عقار'} · ${item.area_label || 'مدينة نصر'}`, 'muted'));
  }
  if (item.source_message_at || item.due_at) {
    const timeInfo = [];
    if (item.source_message_at) timeInfo.push(`تاريخ الرسالة: ${fmtDate(item.source_message_at)}`);
    if (item.due_at) timeInfo.push(`الاستحقاق: ${fmtDate(item.due_at)}`);
    if (item.date_origin === 'customer') timeInfo.push('وعد من العميل');
    if (item.date_origin === 'broker') timeInfo.push('موعد محدد من طارق');
    card.append(el('small', timeInfo.join(' · '), 'muted'));
  }
  if (item.excerpt) {
    card.append(el('blockquote', `«${item.excerpt}»`, 'chat-excerpt'));
  }
  if (item.suggested_action) {
    card.append(el('p', `💡 الإجراء المقترح: ${item.suggested_action}`, 'suggested-action'));
  }

  const actions = el('div', '', 'form-actions');
  if (item.opportunity_id) {
    actions.append(actButton('📂 فتح الفرصة', () => { void deps.openOpportunity(item.opportunity_id); }, 'button primary small'));
  } else if (item.contact_id) {
    actions.append(actButton('👤 فتح العميل', () => { void deps.openContact(item.contact_id); }, 'button primary small'));
  }
  if (item.conversation_id) {
    actions.append(actButton('💬 المحادثة الأصلية', () => {
      void openConversationInViewer(item.conversation_id, deps);
    }, 'button small'));
  }
  if (item.phone_key) {
    const msg = buildReadyFollowupMessage(item.customer_name, item.intent || '', item.area_label || 'مدينة نصر', {
      track: item.track,
      propertyType: item.property_type,
    });
    const wa = el('a', `💬 واتساب (${prettyPhoneFormat(item.phone_key)})`, 'button wa-btn small');
    wa.href = whatsappHref(item.phone_key, msg);
    wa.target = '_blank';
    wa.rel = 'noopener noreferrer';
    actions.append(wa);
  }
  card.append(actions);

  if (item.alert_id) {
    card.append(buildAlertOutcomeMiniForm(item, deps));
  }
  return card;
}

function renderConversationSummaryCard(conv, deps) {
  const card = el('article', '', 'card followup-alert-card');
  const head = el('div', '', 'card-heading');
  const isUnmatched = conv.match_status === 'unmatched_review';
  head.append(
    el('strong', conv.chat_title || conv.contact_name || 'محادثة واتساب'),
    el('span', isUnmatched ? '🔍 مراجعة هوية مطلوبة' : '✓ مربوطة بعميل', isUnmatched ? 'pill warn-pill' : 'pill active-pill'),
  );
  card.append(head);
  card.append(el('small', `${conv.message_count || 0} رسالة · ${(conv.char_length || 0).toLocaleString('ar-EG')} حرف كامل · آخر تواصل: ${fmtDate(conv.last_message_at)}`, 'muted'));
  if (conv.review_reason) {
    card.append(el('p', conv.review_reason, 'muted'));
  }
  const actions = el('div', '', 'form-actions');
  actions.append(actButton('📖 عرض المحادثة الكاملة والروابط', () => {
    void openConversationInViewer(conv.id, deps);
  }, 'button primary small'));
  if (conv.contact_id) {
    actions.append(actButton('👤 ملف العميل', () => { void deps.openContact(conv.contact_id); }, 'button small'));
  }
  card.append(actions);
  return card;
}

function buildManualLinkForm(conv, contacts, deps) {
  const box = el('form', '', 'activity-form');
  box.append(el('h4', '🔗 ربط هذه المحادثة بعميل مؤكد بعد المراجعة اليدوية'));
  const sel = el('select');
  sel.required = true;
  sel.add(new Option('اختر العميل الصحيح من القائمة…', ''));
  for (const c of contacts) {
    const ph = c.primary_phone ? ` · ${prettyPhoneFormat(c.primary_phone)}` : '';
    sel.add(new Option(`${c.name || 'عميل'}${ph}`, c.id));
  }
  const btn = el('button', 'تأكيد الربط وإعادة التحليل الذكي', 'button primary small');
  btn.type = 'submit';
  const fb = el('span', '', 'muted');
  box.append(sel, btn, fb);
  box.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!sel.value) return;
    btn.disabled = true;
    try {
      await deps.api().linkConversationToContact(conv.id, { contact_id: sel.value });
      await deps.refreshFollowups();
      await openConversationInViewer(conv.id, deps);
    } catch (err) {
      fb.textContent = deps.errorText(err);
      btn.disabled = false;
    }
  });
  return box;
}

export async function openConversationInViewer(conversationId, deps) {
  const panel = document.getElementById('followups-panel');
  if (panel && panel.hidden) deps.openPanel('followups-panel');
  const viewer = document.getElementById('conversation-viewer');
  if (!viewer) return;
  viewer.replaceChildren(el('p', 'جارٍ تحميل النص الأصلي الكامل للمحادثة…', 'muted'));

  try {
    const detail = await deps.api().getConversation(conversationId);
    const { conversation, messages = [], insights } = detail;
    viewer.replaceChildren();

    const head = el('div', '', 'card-heading');
    head.append(
      el('h2', conversation.chat_title || 'محادثة واتساب'),
      el('span', `${messages.length} رسالة · ${(conversation.char_length || 0).toLocaleString('ar-EG')} حرف`, 'pill'),
    );
    viewer.append(head);
    viewer.append(el('small', `المصدر: ${conversation.source_ref || conversation.source_type} · التحليل: ${conversation.rule_version || '—'} (${fmtDate(conversation.analyzed_at)})`, 'muted'));

    if (Array.isArray(conversation.parse_warnings) && conversation.parse_warnings.length > 0) {
      const warnBox = el('div', `⚠️ تنبيهات قراءة التنسيق (${conversation.parse_warnings.length}): لم يُفقد أي سطر وتم حفظ النص الأصلي بالكامل.`, 'notice error');
      viewer.append(warnBox);
    }

    if (conversation.match_status === 'unmatched_review') {
      viewer.append(buildManualLinkForm(conversation, deps.getContacts(), deps));
    } else if (conversation.contact_id) {
      const openBtn = actButton(`👤 فتح ملف العميل (${conversation.contact_name || 'عميل'})`, () => {
        void deps.openContact(conversation.contact_id);
      }, 'button small');
      viewer.append(openBtn);
    }

    if (insights) {
      const insBox = el('div', '', 'notes-box');
      const parts = [];
      if (insights.inferred_intent) parts.push(`الاتجاه المستنتج: ${insights.inferred_intent}`);
      if (insights.inferred_area) parts.push(`المنطقة: ${insights.inferred_area}`);
      if (insights.inferred_property_type) parts.push(`النوع: ${insights.inferred_property_type}`);
      if (insights.inferred_budget) parts.push(`الميزانية المذكورة: ${Number(insights.inferred_budget).toLocaleString('ar-EG')} ج.م`);
      if (insights.inferred_size_m2) parts.push(`المساحة المذكورة: ${insights.inferred_size_m2} م²`);
      insBox.textContent = parts.length
        ? `🧠 ملخص استشاري من المحادثة (لا يغيّر بيانات العميل تلقائيًا): ${parts.join(' · ')}`
        : '🧠 تم تحليل المحادثة وحفظ سجل التواصل بالكامل.';
      viewer.append(insBox);
    }

    const msgStream = el('div', '', 'chat-stream');
    for (const msg of messages) {
      const bubble = el('div', '', `chat-bubble chat-role-${msg.sender_role || 'customer'}`);
      const meta = el('div', '', 'chat-bubble-meta');
      meta.append(
        el('strong', msg.sender_label || (msg.sender_role === 'broker' ? 'طارق (سمسار طلبك)' : 'الطرف الآخر')),
        el('small', msg.sent_at ? fmtDate(msg.sent_at) : (msg.raw_timestamp || ''), 'muted'),
      );
      bubble.append(meta, el('p', msg.body_text || '', 'chat-bubble-body'));
      if (Array.isArray(msg.links) && msg.links.length > 0) {
        const linkWrap = el('div', '', 'chat-links-row');
        for (const u of msg.links) {
          const a = buildSafeExternalAnchor(u, `🔗 فتح الرابط الخارجي`);
          if (a) linkWrap.append(a);
        }
        bubble.append(linkWrap);
      }
      if (msg.parse_warning) {
        bubble.append(el('small', `⚠️ تحذير تنسيق: ${msg.parse_warning}`, 'muted'));
      }
      msgStream.append(bubble);
    }
    viewer.append(msgStream);

    const rawDetails = el('details', '', 'drawer-details');
    rawDetails.append(el('summary', '📄 عرض النص الخام الأصلي الكامل (غير مقتطع)'));
    const pre = el('pre', conversation.raw_text || '', 'raw-chat-pre');
    rawDetails.append(pre);
    viewer.append(rawDetails);
  } catch (err) {
    viewer.replaceChildren(el('p', deps.errorText(err), 'muted'));
  }
}

export function renderInlineConversationsAndAlerts(conversations = [], alerts = [], deps) {
  const wrap = el('section', '', 'detail-section');
  wrap.append(el('h3', `💬 المحادثات الكاملة والتنبيهات الذكية (${conversations.length} محادثة · ${alerts.filter(a => a.status === 'open').length} تنبيه مفتوح)`));

  for (const a of alerts.filter(x => x.status === 'open')) {
    wrap.append(renderFollowupQueueCard({
      alert_id: a.id,
      alert_type: a.alert_type,
      priority: a.priority,
      contact_id: a.contact_id,
      opportunity_id: a.opportunity_id,
      conversation_id: a.conversation_id,
      customer_name: a.customer_name,
      alert_reason: a.alert_reason,
      source_message_at: a.source_message_at,
      due_at: a.due_at,
      date_origin: a.date_origin,
      excerpt: a.excerpt,
      suggested_action: a.suggested_action,
      confidence: a.confidence,
    }, deps));
  }

  for (const cv of conversations) {
    wrap.append(renderConversationSummaryCard(cv, deps));
  }
  if (!conversations.length && !alerts.length) {
    wrap.append(el('p', 'لا توجد محادثات مستوردة مرتبطة بهذا السجل بعد.', 'muted'));
  }
  return wrap;
}

export function createFollowupsController(deps) {
  let activeQueue = 'today';
  let latestFollowups = null;

  async function renderActiveQueue() {
    const listEl = document.getElementById('followups-list');
    const titleEl = document.getElementById('followups-queue-heading');
    if (!listEl) return;
    if (titleEl) titleEl.textContent = QUEUE_TITLES[activeQueue] || 'قائمة المتابعة';
    listEl.replaceChildren(el('p', 'جارٍ التحميل…', 'muted'));

    if (activeQueue === 'unmatched_review' || activeQueue === 'all_conversations') {
      const res = await deps.api().searchConversations({
        matchStatus: activeQueue === 'unmatched_review' ? 'unmatched_review' : '',
      });
      const convs = res.conversations || [];
      listEl.replaceChildren();
      if (!convs.length) {
        listEl.append(el('p', 'لا توجد محادثات في هذا القسم حاليًا.', 'muted'));
        return;
      }
      for (const cv of convs) listEl.append(renderConversationSummaryCard(cv, controllerDeps));
      return;
    }

    if (!latestFollowups) {
      latestFollowups = await deps.api().getFollowups();
    }
    const items = latestFollowups[activeQueue] || [];
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(el('p', 'لا توجد عناصر متابعة مفتوحة في هذه القائمة الآن ✓', 'muted'));
      return;
    }
    for (const item of items) {
      listEl.append(renderFollowupQueueCard(item, controllerDeps));
    }
  }

  async function refreshFollowups() {
    const metricsEl = document.getElementById('followups-metrics');
    latestFollowups = await deps.api().getFollowups();
    const c = latestFollowups.counts || {};
    if (metricsEl) {
      metricsEl.replaceChildren();
      const specs = [
        ['مستحق اليوم', c.today ?? 0],
        ['متأخر الآن', c.overdue ?? 0],
        ['بانتظار ردك', c.waiting_reply ?? 0],
        ['يحتاج تدخل', c.stalled_intervention ?? 0],
        ['تنبيهات محادثات', c.new_chat_alerts ?? 0],
        ['للمراجعة اليدوية', c.unmatched_review_chats ?? 0],
      ];
      for (const [lbl, val] of specs) {
        const m = el('div', '', 'metric');
        m.append(el('span', lbl), el('b', String(val)));
        metricsEl.append(m);
      }
    }
    const importContactSelect = document.getElementById('conv-import-contact');
    if (importContactSelect) {
      const prev = importContactSelect.value;
      importContactSelect.replaceChildren(new Option('تحديد تلقائي بالرقم أو إبقاء للمراجعة اليدوية…', ''));
      for (const contact of deps.getContacts()) {
        const ph = contact.primary_phone ? ` · ${prettyPhoneFormat(contact.primary_phone)}` : '';
        importContactSelect.add(new Option(`${contact.name || 'عميل'}${ph}`, contact.id));
      }
      importContactSelect.value = prev;
    }
    await renderActiveQueue();
  }

  const controllerDeps = {
    ...deps,
    refreshFollowups,
  };

  function bindEvents() {
    for (const chip of document.querySelectorAll('[data-followup-queue]')) {
      chip.addEventListener('click', () => {
        activeQueue = chip.dataset.followupQueue || 'today';
        for (const c of document.querySelectorAll('[data-followup-queue]')) {
          c.classList.toggle('active', c.dataset.followupQueue === activeQueue);
        }
        void renderActiveQueue().catch(deps.showError);
      });
    }

    const importForm = document.getElementById('conv-import-form');
    importForm?.addEventListener('submit', async ev => {
      ev.preventDefault();
      const submitBtn = document.getElementById('conv-import-submit');
      const fb = document.getElementById('conv-import-feedback');
      const titleInput = document.getElementById('conv-import-title');
      const contactInput = document.getElementById('conv-import-contact');
      const phoneInput = document.getElementById('conv-import-phone');
      const textInput = document.getElementById('conv-import-text');
      if (!textInput.value.trim()) {
        fb.textContent = 'الصق نص المحادثة الكامل أولًا.';
        return;
      }
      submitBtn.disabled = true;
      fb.textContent = 'جارٍ حفظ المحادثة الكاملة وتحليلها ذكيًا…';
      try {
        const res = await deps.api().importConversation({
          chat_title: titleInput.value.trim() || 'محادثة واتساب مستوردة',
          contact_id: contactInput.value || undefined,
          participant_phone: phoneInput.value.trim() || undefined,
          raw_text: textInput.value,
        });
        fb.textContent = `✓ حُفظت المحادثة بالكامل (${res.message_count} رسالة) وتولّد ${res.alerts_created} تنبيه جديد.`;
        textInput.value = '';
        await refreshFollowups();
        if (res.conversation_id) {
          await openConversationInViewer(res.conversation_id, controllerDeps);
        }
      } catch (err) {
        fb.textContent = deps.errorText(err);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  return { bindEvents, refreshFollowups, controllerDeps };
}
