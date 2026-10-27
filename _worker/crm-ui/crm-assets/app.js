import { CRMApiError, CRMClient } from '../crm-client.js';

const $ = selector => document.querySelector(selector);
const state = { api: null, contactId: null, opportunityId: null, contacts: [], opportunities: [] };

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
function showError(error) {
  setNotice($('#load-error'), errorText(error), 'error');
  setNotice($('#app-status'), error instanceof CRMApiError && error.kind === 'authentication' ? 'يلزم تسجيل الدخول عبر Cloudflare Access.' : 'تعذّر تحديث بيانات CRM.', 'info');
  $('#security-status').textContent = error instanceof CRMApiError && error.kind === 'authentication' ? 'تحقق من جلسة الدخول' : 'الاتصال غير متاح';
}
function clearError() { setNotice($('#load-error'), '', 'error'); }
function dateLabel(value) {
  if (!value) return 'غير محدد';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function statusLabel(value) {
  return ({active:'نشطة',visit_scheduled:'معاينة مجدولة',viewing_done:'تمت المعاينة',offer:'عرض سعر',negotiating:'تفاوض',near_close:'قرب الإغلاق',won:'تمت الصفقة',lost:'لم تتم',paused:'مؤجلة',unqualified:'غير مؤهلة'})[value] || value || '—';
}
function intentLabel(value) { return ({buy:'شراء',rent:'إيجار',sell:'بيع',lease:'تأجير',other:'أخرى'})[value] || value || '—'; }
function sourceLabel(value) { return ({call:'مكالمة',missed_call:'مكالمة فائتة',referral:'ترشيح',website:'الموقع',whatsapp:'ملاحظة واتساب',other:'أخرى'})[value] || value || '—'; }
function money(value) { return value === null || value === undefined || value === '' ? '—' : `${new Intl.NumberFormat('ar-EG').format(Number(value))} ج.م`; }
function isoFromLocal(value) { return value ? new Date(value).toISOString() : null; }
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
  p.append(strong, document.createTextNode(value === null || value === undefined || value === '' ? '—' : String(value)));
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
  for (const [label, value] of [['فرص نشطة',counts.active],['مستحق اليوم',counts.due_today],['متأخر',counts.overdue],['تحتاج خطوة تالية',counts.missing_next_step]]) {
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
  if (!rows.length) { container.append(node('p','لا توجد متابعة في هذه القائمة.','muted')); return; }
  for (const row of rows) {
    const item = clickableRecord(row.name || row.contact_name || 'عميل', `${row.next_action || 'لا يوجد إجراء'} · ${dateLabel(row.next_followup_at)}`, () => openOpportunity(row.id), [intentLabel(row.intent), statusLabel(row.status)]);
    container.append(item);
  }
}
async function loadContacts(query = '') {
  $('#contact-search-state').textContent = 'جارٍ البحث…';
  const result = await requireApi().searchContacts(query);
  state.contacts = result.contacts || [];
  const list = $('#contact-results'); list.replaceChildren();
  if (!state.contacts.length) {
    list.append(node('p',query ? 'لا توجد نتائج مطابقة.' : 'لا يوجد عملاء بعد. أضف أول عميل يدويًا.','muted'));
  }
  for (const contact of state.contacts) {
    const numbers = (contact.phone_numbers || '').split(',').filter(Boolean);
    list.append(clickableRecord(contact.name || 'عميل بلا اسم', numbers.length ? numbers.map(prettyPhone).join(' · ') : 'لا يوجد رقم هاتف', () => openContact(contact.id), [`${contact.opportunity_count || 0} فرصة`, contact.communication_consent === 'do_not_contact' ? 'عدم التواصل' : 'متابعة الطلب فقط']));
  }
  $('#contact-search-state').textContent = `${state.contacts.length} سجل`;
  const select = $('#opportunity-contact');
  const oldValue = select.value;
  select.replaceChildren(new Option('اختر عميلًا…',''));
  for (const contact of state.contacts) {
    const phoneSuffix = contact.primary_phone ? ` · ${prettyPhone(contact.primary_phone)}` : '';
    select.add(new Option(`${contact.name || 'عميل'}${phoneSuffix}`, contact.id));
  }
  if (state.contacts.some(contact => contact.id === oldValue)) select.value = oldValue;
}
function prettyPhone(value) { return String(value || '').replace(/^20/, '+20 '); }
function consentIsBlocked(value) { return value === 'do_not_contact'; }
function consentLabel(value) {
  if (value === 'marketing_yes') return 'موافقة عروض مسجلة';
  if (consentIsBlocked(value)) return 'عدم التواصل';
  return 'متابعة الطلب فقط';
}
async function openContact(contactId) {
  state.contactId = contactId;
  openPanel('contacts-panel');
  const detail = $('#contact-detail');
  detail.replaceChildren(node('p','جارٍ تحميل ملف العميل…','muted'));
  const result = await requireApi().getContact(contactId);
  const contact = result.contact;
  detail.replaceChildren();
  const heading = node('div','', 'card-heading');
  heading.append(node('h2',contact.name || 'عميل بلا اسم'),node('span',consentLabel(contact.communication_consent),'pill'));
  detail.append(heading);
  const phoneSection=node('section','','detail-section');
  phoneSection.append(node('h3','أرقام الهاتف'));
  const phoneList=node('ul','','detail-list');
  for(const phone of result.phones || []) {
    const li=node('li');
    li.append(node('span',prettyPhone(phone.phone_key),'phone-number'),document.createTextNode(` · ${phone.label || 'بدون تسمية'}${phone.is_primary ? ' · أساسي' : ''}`));
    phoneList.append(li);
  }
  if(!(result.phones||[]).length) phoneList.append(node('li','لا توجد أرقام مسجلة.','muted'));
  phoneSection.append(phoneList);
  const addPhoneForm=node('form','','activity-form');
  addPhoneForm.append(node('h3','إضافة رقم هاتف'));
  const phoneInput=node('input'); phoneInput.type='tel'; phoneInput.name='phone'; phoneInput.required=true; phoneInput.placeholder='رقم الهاتف'; phoneInput.autocomplete='tel';
  const labelInput=node('input'); labelInput.name='label'; labelInput.maxLength=40; labelInput.placeholder='التسمية (مثال: عمل)';
  const primaryLabel=node('label','','primary-check'); const primaryInput=node('input'); primaryInput.type='checkbox'; primaryInput.name='is_primary'; primaryLabel.append(primaryInput,document.createTextNode('جعله الرقم الأساسي'));
  const submit=node('button','إضافة الرقم','button primary'); submit.type='submit';
  const feedback=node('span','','muted'); feedback.setAttribute('aria-live','polite');
  addPhoneForm.append(phoneInput,labelInput,primaryLabel,submit,feedback);
  addPhoneForm.addEventListener('submit',async event=>{
    event.preventDefault(); setBusy(submit,true);
    try { await requireApi().addPhone(contactId,{phone:phoneInput.value,label:labelInput.value,is_primary:primaryInput.checked}); await openContact(contactId); }
    catch(error) { feedback.textContent=errorText(error); }
    finally { setBusy(submit,false); }
  });
  phoneSection.append(addPhoneForm);
  detail.append(phoneSection);
  const oppSection=node('section','','detail-section');
  const oppHeading=node('div','','card-heading'); oppHeading.append(node('h3','الفرص المرتبطة'),button('＋ فرصة',()=>{openPanel('new-opportunity-panel');$('#opportunity-contact').value=contactId;},'button small'));
  oppSection.append(oppHeading);
  const oppList=node('div','','stack');
  for(const opportunity of result.opportunities || []) {
    oppList.append(clickableRecord(intentLabel(opportunity.intent),`${opportunity.area_label || 'مدينة نصر'} · ${statusLabel(opportunity.status)}` ,()=>openOpportunity(opportunity.id),[opportunity.next_action || 'لا يوجد إجراء',dateLabel(opportunity.next_followup_at)]));
  }
  if(!(result.opportunities||[]).length) oppList.append(node('p','لا توجد فرص مرتبطة بهذا العميل.','muted'));
  oppSection.append(oppList); detail.append(oppSection);
}
async function loadOpportunities(query = $('#opportunity-search').value, status = $('#opportunity-status').value) {
  const container=$('#opportunity-results'); container.replaceChildren(node('p','جارٍ البحث…','muted'));
  const result=await requireApi().searchOpportunities(query,status);
  state.opportunities=result.opportunities||[]; container.replaceChildren();
  if(!state.opportunities.length) container.append(node('p','لا توجد فرص مطابقة.','muted'));
  for(const opportunity of state.opportunities) {
    container.append(clickableRecord(opportunity.contact_name || 'عميل',`${intentLabel(opportunity.intent)} · ${opportunity.area_label || 'مدينة نصر'}` ,()=>openOpportunity(opportunity.id),[statusLabel(opportunity.status),dateLabel(opportunity.next_followup_at)]));
  }
}
async function openOpportunity(opportunityId) {
  state.opportunityId=opportunityId;
  openPanel('opportunities-panel');
  const detail=$('#opportunity-detail'); detail.replaceChildren(node('p','جارٍ تحميل الفرصة…','muted'));
  const result=await requireApi().getOpportunity(opportunityId); const opportunity=result.opportunity;
  detail.replaceChildren();
  detail.append(node('h2',`${intentLabel(opportunity.intent)} · ${opportunity.contact_name || 'عميل'}`));
  pushText(detail,'الحالة',statusLabel(opportunity.status));
  pushText(detail,'المنطقة',opportunity.area_label || 'مدينة نصر');
  pushText(detail,'الميزانية',`${money(opportunity.budget_min)} – ${money(opportunity.budget_max)}`);
  pushText(detail,'المساحة',`${opportunity.size_min_m2 ?? '—'} – ${opportunity.size_max_m2 ?? '—'} م²`);
  pushText(detail,'الإجراء القادم',opportunity.next_action || '—');
  pushText(detail,'موعد المتابعة',dateLabel(opportunity.next_followup_at));
  if(opportunity.notes) pushText(detail,'ملاحظات',opportunity.notes);
  const activitySection=node('section','','detail-section'); activitySection.append(node('h3','سجل المتابعة'));
  const activityList=node('ul','','detail-list');
  for(const activity of result.activities||[]) {
    const li=node('li'); li.append(node('strong',dateLabel(activity.created_at)),document.createTextNode(` · ${activity.summary}`));
    if(activity.outcome) li.append(node('small',` — ${activity.outcome}`));
    activityList.append(li);
  }
  if(!(result.activities||[]).length) activityList.append(node('li','لا توجد أنشطة مسجلة.','muted'));
  activitySection.append(activityList,activityForm(opportunity)); detail.append(activitySection);
  const propertySection=node('section','','detail-section'); propertySection.append(node('h3','العقارات المرتبطة بمدينة نصر'));
  const propertyList=node('div','','stack');
  for(const property of result.properties||[]) {
    const item=node('div','','property-option'); item.append(node('strong',property.title || property.external_id),node('small',`${property.area_name || 'مدينة نصر'} · ${property.area_m2 ?? '—'} م² · ${money(property.price)}`),node('small',`حالة العرض: ${property.presentation_status || '—'}`)); propertyList.append(item);
  }
  if(!(result.properties||[]).length) propertyList.append(node('p','لم يتم ربط عقار بهذه الفرصة.','muted'));
  propertySection.append(propertyList,propertySearchForm(opportunityId)); detail.append(propertySection);
}
function activityForm(opportunity) {
  const form=node('form','','activity-form'); form.append(node('h3','تسجيل متابعة'));
  const type=node('select'); type.name='activity_type';
  for(const [value,label] of [['call','مكالمة'],['missed_call','مكالمة فائتة'],['whatsapp_note','ملاحظة واتساب'],['visit','معاينة'],['offer','عرض'],['objection','اعتراض'],['note','ملاحظة'],['status_change','تغيير حالة']]) type.add(new Option(label,value));
  const summary=node('textarea'); summary.name='summary'; summary.required=true; summary.maxLength=1200; summary.placeholder='ملخص ما تم';
  const outcome=node('input'); outcome.name='outcome'; outcome.maxLength=200; outcome.placeholder='النتيجة (اختياري)';
  const status=node('select'); status.name='status'; status.add(new Option('اترك الحالة كما هي',''));
  for(const [value,label] of [['active','نشطة'],['visit_scheduled','معاينة مجدولة'],['viewing_done','تمت المعاينة'],['offer','عرض سعر'],['negotiating','تفاوض'],['near_close','قرب الإغلاق'],['won','تمت الصفقة'],['lost','لم تتم'],['paused','مؤجلة'],['unqualified','غير مؤهلة']]) status.add(new Option(label,value));
  status.value=opportunity.status;
  const action=node('input'); action.name='next_action'; action.maxLength=180; action.placeholder='الإجراء القادم'; action.value=opportunity.next_action||'';
  const followup=node('input'); followup.type='datetime-local'; followup.name='next_followup_at'; if(opportunity.next_followup_at){const d=new Date(opportunity.next_followup_at);if(!Number.isNaN(d.valueOf()))followup.value=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  const noFollow=node('input'); noFollow.name='no_followup_reason'; noFollow.maxLength=240; noFollow.placeholder='سبب عدم تحديد متابعة (إن وجد)'; noFollow.value=opportunity.no_followup_reason||'';
  const feedback=node('span','','muted'); feedback.setAttribute('aria-live','polite'); const submit=node('button','حفظ المتابعة','button primary'); submit.type='submit';
  form.append(type,summary,outcome,status,action,followup,noFollow,submit,feedback);
  form.addEventListener('submit',async event=>{event.preventDefault();setBusy(submit,true);try{await requireApi().addActivity(opportunity.id,{activity_type:type.value,summary:summary.value,outcome:outcome.value,status:status.value||undefined,next_action:action.value,next_followup_at:isoFromLocal(followup.value),no_followup_reason:noFollow.value});await openOpportunity(opportunity.id);}catch(error){feedback.textContent=errorText(error);}finally{setBusy(submit,false);}});
  return form;
}
function propertySearchForm(opportunityId) {
  const form=node('form','','property-form'); form.append(node('h3','البحث عن عقار لربطه'));
  const query=node('input'); query.type='search'; query.name='q'; query.placeholder='اسم العقار أو المنطقة'; query.maxLength=80;
  const submit=node('button','بحث في عقارات مدينة نصر','button'); submit.type='submit';
  const resultList=node('div','','property-results'); const feedback=node('span','','muted'); feedback.setAttribute('aria-live','polite');
  form.append(query,submit,resultList,feedback);
  form.addEventListener('submit',async event=>{
    event.preventDefault();setBusy(submit,true,'جارٍ البحث…');resultList.replaceChildren();
    try {
      const result=await requireApi().searchListings(query.value);
      if(!(result.listings||[]).length) resultList.append(node('p','لا توجد عقارات مطابقة ضمن النطاق المسموح.','muted'));
      for(const listing of result.listings||[]) {
        const item=node('div','','property-option'); item.append(node('strong',listing.title||listing.external_id),node('small',`${listing.area_name||'مدينة نصر'} · ${listing.area_m2??'—'} م² · ${money(listing.price)}`));
        const link=node('button','ربط بهذه الفرصة','button small'); link.type='button';
        link.addEventListener('click',async()=>{link.disabled=true;try{await requireApi().linkProperty(opportunityId,{external_id:listing.external_id,presentation_status:'presented',presented_price:listing.price??null,activity_summary:`تم عرض عقار ${listing.external_id}`});await openOpportunity(opportunityId);}catch(error){feedback.textContent=errorText(error);link.disabled=false;}});
        item.append(link); resultList.append(item);
      }
    } catch(error){feedback.textContent=errorText(error);} finally{setBusy(submit,false);}
  });
  return form;
}
async function refreshAll() {
  clearError(); setNotice($('#app-status'),'جارٍ تحميل CRM…','info'); $('#security-status').textContent='التحقق من جلسة الوصول…';
  try {
    await Promise.all([loadDashboard(),loadContacts(),loadOpportunities('','')]);
    $('#security-status').textContent='جلسة موثقة · عبر Access';
    setNotice($('#app-status'),'تم الاتصال بالخدمة. البيانات لا تُحفظ في هذا المتصفح.','info');
  } catch(error) { showError(error); }
}
function addPrimaryRequiredValidation(form) {
  const consent=form.elements.communication_consent;
  consent.addEventListener('change',()=>{
    const existing=form.querySelector('[name="consent-confirm"]');
    if(consent.value==='marketing_yes'&&!existing){
      const label=node('label','','full'); const check=node('input'); check.type='checkbox'; check.name='consent-confirm'; check.required=true; check.style.width='auto';
      label.append(check,document.createTextNode(' أؤكد أن موافقة العميل على استقبال العروض سُجلت صراحةً.'));
      form.querySelector('.form-actions').before(label);
    } else if(consent.value!=='marketing_yes'&&existing) existing.closest('label').remove();
  });
}

for(const tab of document.querySelectorAll('.tab')) tab.addEventListener('click',()=>openPanel(tab.dataset.panel));
for(const trigger of document.querySelectorAll('[data-open-panel]')) trigger.addEventListener('click',()=>openPanel(trigger.dataset.openPanel));
$('#add-contact-phone-row').addEventListener('click',()=>buildPhoneRow());
$('#contact-search-form').addEventListener('submit',async event=>{event.preventDefault();try{await loadContacts($('#contact-search').value.trim());}catch(error){showError(error);}});
$('#opportunity-search-form').addEventListener('submit',async event=>{event.preventDefault();try{await loadOpportunities();}catch(error){showError(error);}});
$('#refresh-all').addEventListener('click',refreshAll);
$('#dashboard-day').addEventListener('change',async()=>{try{await loadDashboard();}catch(error){showError(error);}});
$('#new-contact-form').addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.currentTarget, submit=form.querySelector('[type="submit"]'), feedback=$('#new-contact-feedback');
  const phoneRows=[...form.querySelectorAll('.phone-row')].map(row=>({phone:row.querySelector('[data-phone]').value.trim(),label:row.querySelector('[data-label]').value.trim(),is_primary:row.querySelector('[data-primary]').checked})).filter(item=>item.phone);
  const consent=form.elements.communication_consent.value;
  const confirmation=form.querySelector('[name="consent-confirm"]');
  if(consent==='marketing_yes'&&!confirmation?.checked){feedback.textContent='سجّل تأكيد موافقة العميل أولًا.';return;}
  const body={name:form.elements.name.value.trim(),phones:phoneRows,communication_consent:consent};
  if(consent==='marketing_yes') body.consent_captured_at=new Date().toISOString();
  setBusy(submit,true);feedback.textContent='جارٍ الحفظ…';
  try{const created=await requireApi().createContact(body);feedback.textContent=created.duplicate_contact?'هذا الرقم مسجل بالفعل؛ افتح السجل الموجود.':'تم حفظ العميل.';await loadContacts($('#contact-search').value.trim());if(created.contact_id)await openContact(created.contact_id);}
  catch(error){feedback.textContent=errorText(error);showError(error);}finally{setBusy(submit,false);}
});
$('#new-opportunity-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,submit=form.querySelector('[type="submit"]'),feedback=$('#new-opportunity-feedback');
  const v=Object.fromEntries(new FormData(form));
  const followup=isoFromLocal(v.next_followup_at);
  if(['active','visit_scheduled','viewing_done','offer','negotiating','near_close'].includes(v.status)&&(!v.next_action?.trim()||!followup)&&!v.no_followup_reason?.trim()){feedback.textContent='أدخل الإجراء وموعد المتابعة، أو سبب عدم تحديدها.';return;}
  const body={contact_id:v.contact_id,intent:v.intent,source:v.source,status:v.status,area_label:v.area_label,property_type:v.property_type,notes:v.notes,next_action:v.next_action,next_followup_at:followup,no_followup_reason:v.no_followup_reason};
  for(const key of ['budget_min','budget_max','size_min_m2','size_max_m2']) body[key]=v[key]?Number(v[key]):null;
  setBusy(submit,true);feedback.textContent='جارٍ حفظ الفرصة…';
  try{const created=await requireApi().createOpportunity(body);feedback.textContent='تم حفظ الفرصة.';form.reset();await loadContacts();await loadOpportunities('','');if(created.opportunity_id)await openOpportunity(created.opportunity_id);}
  catch(error){feedback.textContent=errorText(error);showError(error);}finally{setBusy(submit,false);}
});

try {
  const configuredBase=document.documentElement.dataset.crmApi || '/api';
  state.api=new CRMClient({apiBase:configuredBase});
  $('#dashboard-day').value=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
  addPrimaryRequiredValidation($('#new-contact-form'));
  buildPhoneRow({primary:true});
  $('#new-contact-form').querySelector('[data-primary]').checked=false;
  await refreshAll();
} catch(error) { showError(error); }
