/* Local-only opportunity tracker. No network writes or remote storage. */
(function () {
  'use strict';
  var KEY = 'simsar-opportunities-v1', db;
  var $ = function (id) { return document.getElementById(id); };
  function load() { try { var v = JSON.parse(localStorage.getItem(KEY) || '{"contacts":{},"opportunities":[]}'); return v && v.contacts && Array.isArray(v.opportunities) ? v : { contacts: {}, opportunities: [] }; } catch (_) { return { contacts: {}, opportunities: [] }; } }
  function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
  function esc(value) { var d = document.createElement('span'); d.textContent = String(value || ''); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function safeProperty(value) { var raw=String(value||'').trim(); if (/^\/(?!\/)/.test(raw)) return raw; try { var u=new URL(raw); return u.protocol==='https:' && u.hostname==='nasr-realestate.github.io' ? u.href : ''; } catch (_) { return ''; } }
  function dueLabel(t) { return t ? new Date(t).toLocaleString('ar-EG') : 'لا يوجد موعد محدد'; }
  function render() {
    var now = Date.now(), rows = db.opportunities, active = rows.filter(function (x) { return !['won','lost','unqualified'].includes(x.status); });
    var overdue = active.filter(function (x) { return x.due && Date.parse(x.due) < now; });
    var localNow = new Date(), today = localNow.getFullYear()+'-'+String(localNow.getMonth()+1).padStart(2,'0')+'-'+String(localNow.getDate()).padStart(2,'0'), dueToday = active.filter(function (x) { return x.due && x.due.slice(0,10) === today; });
    $('stats').innerHTML = '<span>نشطة: <b>'+active.length+'</b></span><span>مستحقة اليوم: <b>'+dueToday.length+'</b></span><span>متأخرة: <b>'+overdue.length+'</b></span><span>مغلقة: <b>'+rows.filter(function(x){return x.status==='won'}).length+'</b></span>';
    var q = ($('search').value || '').toLowerCase();
    var filtered = rows.slice().sort(function(a,b){return (a.due||'9999').localeCompare(b.due||'9999');}).filter(function(x){var c=db.contacts[x.contactId];return !q || (c.phone+' '+c.name).toLowerCase().includes(q);});
    $('records').innerHTML = filtered.map(function(x){var c=db.contacts[x.contactId];return '<article class="item"><div class="row"><h3>'+esc(c.name||c.phone)+'</h3><span class="tag">'+esc(x.statusLabel)+'</span><span class="tag">'+esc(x.kind)+'</span></div><p><a href="tel:'+esc(c.phone)+'">اتصال</a> · <a target="_blank" rel="noopener noreferrer" href="https://wa.me/'+esc(c.phone)+'">واتساب</a> · '+esc(c.phone)+' · المصدر: '+esc(x.source)+'</p><p>المتابعة: <b>'+esc(dueLabel(x.due))+'</b> · '+(x.property?'<a href="'+esc(x.property)+'">العقار</a>':'لا عقار مرتبط')+'</p><p>'+esc(x.note)+'</p><p class="row"><button class="btn" data-activity="'+esc(x.id)+'">تسجيل نتيجة / متابعة</button></p><div id="activity-'+esc(x.id)+'" class="hidden"><label>ملخص جديد<textarea maxlength="1200"></textarea></label><label>الحالة<select><option value="active">نشطة</option><option value="visit">معاينة</option><option value="offer">عرض / تفاوض</option><option value="won">أُغلقت بنجاح</option><option value="lost">خسرت</option><option value="paused">مؤجلة</option><option value="unqualified">غير مؤهلة</option></select></label><label>موعد الخطوة التالية<input type="datetime-local"></label><button class="btn primary" data-save="'+esc(x.id)+'">حفظ</button></div></article>';}).join('') || '<p class="muted">لا توجد فرص بعد. ابدأ بتسجيل رقم جديد.</p>';
    var priority = overdue.concat(dueToday.filter(function(x){return !overdue.includes(x);}));
    $('followups').innerHTML = priority.length ? priority.map(function(x){var c=db.contacts[x.contactId];return '<p>🔔 <b>'+esc(c.name||c.phone)+'</b> — '+esc(c.phone)+' — '+esc(dueLabel(x.due))+' <button class="btn" data-activity="'+esc(x.id)+'">تسجيل نتيجة</button></p>';}).join('') : '<p class="muted">لا توجد متابعة مستحقة اليوم أو متأخرة.</p>';
  }
  function record(id, formData) {
    var x=db.opportunities.find(function(o){return o.id===id;}); if(!x)return;
    x.status=formData.get('status'); x.statusLabel=formData.get('statusLabel')||({active:'نشطة',visit:'معاينة',offer:'عرض / تفاوض',won:'أُغلقت بنجاح',lost:'خسرت',paused:'مؤجلة',unqualified:'غير مؤهلة'}[x.status]);
    x.due=formData.get('due')||''; x.note=[x.note,formData.get('note')].filter(Boolean).join('\n— '); x.updatedAt=new Date().toISOString();
  }
  document.addEventListener('click',function(e){var b=e.target.closest('[data-activity]');if(b){var panel=$('activity-'+b.dataset.activity);panel.classList.toggle('hidden');return;}var s=e.target.closest('[data-save]');if(s){var p=$('activity-'+s.dataset.save), f=new FormData();f.set('note',p.querySelector('textarea').value);f.set('status',p.querySelector('select').value);f.set('due',p.querySelector('input').value);record(s.dataset.save,f);save();render();}});
  $('form').addEventListener('submit',function(e){e.preventDefault();var f=new FormData(e.currentTarget), phone=window.SimsarCRM.normalizePhone(f.get('phone'));if(!phone.id){$('message').textContent='رقم الهاتف غير صالح أو غير مدعوم.';return;}var contact=db.contacts[phone.id]||(db.contacts[phone.id]={phone:phone.id,name:''});if(f.get('name'))contact.name=String(f.get('name')).slice(0,100);
    var due=f.get('due')||'',status=f.get('status'),note=String(f.get('note')||'').slice(0,1200);if(status==='active'&&!due&&!note){$('message').textContent='أضف موعد متابعة أو سببًا صريحًا لعدم الحاجة إليها.';return;}
    var id=(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)), labels={active:'نشطة',visit:'معاينة',offer:'عرض / تفاوض',won:'أُغلقت بنجاح',lost:'خسرت',paused:'مؤجلة',unqualified:'غير مؤهلة'};
    db.opportunities.push({id:id,contactId:phone.id,kind:f.get('kind'),source:f.get('source'),status:status,statusLabel:labels[status],due:due,property:safeProperty(String(f.get('property')||'').slice(0,300)),price:String(f.get('price')||'').slice(0,40),note:note,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});save();e.currentTarget.reset();$('message').textContent='تم الحفظ. الرقم الموحد: +'+phone.id;render();
  });
  $('search').addEventListener('input',render);$('export').addEventListener('click',function(){var a=document.createElement('a'),blob=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});a.href=URL.createObjectURL(blob);a.download='simsar-opportunities-backup.json';a.click();URL.revokeObjectURL(a.href);});
  $('import').addEventListener('change',async function(e){try{var data=JSON.parse(await e.target.files[0].text());if(!data||!data.contacts||!Array.isArray(data.opportunities))throw Error();db=data;save();render();$('message').textContent='تم استرجاع النسخة.';}catch(_){$('message').textContent='ملف النسخة غير صالح.';}e.target.value='';});
  db=load();render();
})();
