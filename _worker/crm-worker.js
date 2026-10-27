// Private CRM API for the existing nasr-market-db. This Worker fails closed until
// Cloudflare Access is configured and its JWT settings are supplied as secrets.
const ALLOWED_ORIGIN = 'https://nasr-realestate.github.io';
const ACTIVE = "'active','visit_scheduled','viewing_done','offer','negotiating','near_close'";
// Live D1 areas 1–31 were read-only audited on 2026-10-27; all belong to Nasr City.
const NASR_AREA_ID_SQL = '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
});
const cors = origin => origin === ALLOWED_ORIGIN ? {
  'access-control-allow-origin': ALLOWED_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,idempotency-key',
  'vary': 'origin',
} : {};

function b64url(value) {
  const text = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(text + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
}
let jwksCache = { url: '', expiry: 0, keys: [] };
async function accessKeys(team) {
  const url = `https://${team}/cdn-cgi/access/certs`;
  if (jwksCache.url === url && jwksCache.expiry > Date.now()) return jwksCache.keys;
  const response = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtl: 300 } });
  if (!response.ok) throw new Error('access_jwks_unavailable');
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error('access_jwks_invalid');
  jwksCache = { url, expiry: Date.now() + 300_000, keys: data.keys };
  return data.keys;
}
async function verifyAccess(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https:\/\//, '').replace(/\/$/, '');
  const audience = String(env.ACCESS_AUD || '');
  const admin = String(env.ADMIN_EMAIL || '').toLowerCase();
  // Missing Access configuration is a deployment/configuration error, never an open mode.
  if (!team || !audience || !admin || !env.DB) return { ok: false, status: 503, code: 'auth_not_configured' };
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 12_000) return { ok: false, status: 401, code: 'authentication_required' };
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('jwt_shape');
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
    if (header.alg !== 'RS256' || !header.kid) throw new Error('jwt_algorithm');
    const issuer = `https://${team}`;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer || !aud.includes(audience) || claims.email?.toLowerCase() !== admin ||
      !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf && claims.nbf > now + 30)) throw new Error('jwt_claims');
    const jwk = (await accessKeys(team)).find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) throw new Error('jwt_key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, b64url(parts[2]), signed);
    return valid ? { ok: true, email: admin } : { ok: false, status: 401, code: 'invalid_access_token' };
  } catch (_) {
    return { ok: false, status: 401, code: 'invalid_access_token' };
  }
}
function digits(value) {
  return String(value || '').replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, d => String(d.charCodeAt(0) - 0x06f0));
}
export function normalizePhone(raw) {
  const value = digits(raw).trim();
  const international = /^\s*\+/.test(value) || value.startsWith('00');
  let number = value.replace(/\D/g, '');
  if (number.startsWith('00')) number = number.slice(2);
  if (/^01[0125]\d{8}$/.test(number)) number = `20${number.slice(1)}`;
  else if (/^1[0125]\d{8}$/.test(number) && !international) number = `20${number}`;
  else if (/^0201[0125]\d{8}$/.test(number)) number = number.slice(1);
  else if (/^0[2-9]\d{7,9}$/.test(number)) number = `20${number.slice(1)}`;
  if (number.length < 8 || number.length > 15 || !/^\d+$/.test(number)) return null;
  if (number.startsWith('20') && !/^20(?:1[0125]\d{8}|[2-9]\d{7,9})$/.test(number)) return null;
  if (!number.startsWith('20') && !international) return null;
  return number;
}
function boundedText(value, max = 1000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function normalizeName(value) { return boundedText(value,100).normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase('ar'); }
async function readJson(request, max = 10_000) {
  const length=Number(request.headers.get('content-length')||0);
  if (length>max) throw new Error('body_too_large');
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new SyntaxError('json_content_type_required');
  const raw = await request.arrayBuffer();
  if (raw.byteLength > max) throw new Error('body_too_large');
  const value = JSON.parse(new TextDecoder().decode(raw));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
  return value;
}
function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return { ok:true, value:null };
  if (typeof value !== 'number' && typeof value !== 'string') return { ok:false, value:null };
  const parsed = typeof value === 'string' && !value.trim() ? null : Number(value);
  return parsed === null ? {ok:true,value:null} : Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e15 ? {ok:true,value:parsed} : {ok:false,value:null};
}
function safeSitePath(value) {
  const raw=boundedText(value,500);
  if (/^\/(?!\/)[A-Za-z0-9_./?=#%&+-]*$/.test(raw)) return raw;
  try { const u=new URL(raw); return u.protocol==='https:' && u.hostname==='nasr-realestate.github.io' ? u.href : ''; } catch (_) { return ''; }
}
function id() { return crypto.randomUUID(); }
function sqlError(error) {
  const msg = String(error?.message || '');
  if (/UNIQUE constraint failed: crm_contacts\.phone_key/.test(msg)) return json({ error: 'duplicate_phone_review' }, 409);
  if (/CHECK constraint failed/.test(msg)) return json({ error: 'validation_failed' }, 400);
  if (/FOREIGN KEY constraint failed/.test(msg)) return json({ error: 'linked_record_not_found' }, 400);
  return json({ error: 'database_error' }, 500);
}
async function dashboard(db, url) {
  const now = new Date();
  const day = url.searchParams.get('day') || now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'invalid_day' }, 400);
  const start = `${day}T00:00:00.000Z`, end = `${day}T23:59:59.999Z`, current = now.toISOString();
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM crm_opportunities WHERE status IN (${ACTIVE})`).first();
  const today = await db.prepare(`SELECT o.id,c.name,c.phone_key,o.intent,o.status,o.next_action,o.next_followup_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.next_followup_at BETWEEN ? AND ? ORDER BY o.next_followup_at`).bind(start, end).all();
  const overdue = await db.prepare(`SELECT o.id,c.name,c.phone_key,o.intent,o.status,o.next_action,o.next_followup_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.next_followup_at < ? ORDER BY o.next_followup_at LIMIT 200`).bind(start).all();
  const noAction = await db.prepare(`SELECT o.id,c.name,c.phone_key,o.intent,o.status,o.no_followup_reason,o.updated_at
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND o.next_followup_at IS NULL AND COALESCE(o.no_followup_reason,'')='' ORDER BY o.updated_at LIMIT 200`).all();
  const stale = await db.prepare(`SELECT o.id,c.name,c.phone_key,o.intent,o.status,o.updated_at,
    (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id) AS last_activity
    FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id
    WHERE o.status IN (${ACTIVE}) AND COALESCE((SELECT MAX(a.created_at) FROM crm_activities a WHERE a.opportunity_id=o.id),o.updated_at) < ?
    ORDER BY COALESCE(last_activity,o.updated_at) LIMIT 200`).bind(new Date(Date.now() - 7 * 86400000).toISOString()).all();
  const visits = await db.prepare(`SELECT p.id,p.viewing_at,p.viewing_result,o.id AS opportunity_id,c.name,c.phone_key,l.title,l.url
    FROM crm_opportunity_properties p JOIN crm_opportunities o ON o.id=p.opportunity_id
    JOIN crm_contacts c ON c.id=o.contact_id JOIN listings l ON l.id=p.listing_id
    WHERE p.presentation_status='viewing_scheduled' AND p.viewing_at BETWEEN ? AND ? ORDER BY p.viewing_at`).bind(start,end).all();
  const outcomes = await db.prepare(`SELECT status, COUNT(*) AS count FROM crm_opportunities WHERE status IN ('won','lost','paused','unqualified') GROUP BY status`).all();
  return json({ day, generated_at: current, counts: { active: active?.count || 0, due_today: today.results.length, overdue: overdue.results.length, missing_next_step: noAction.results.length }, due_today: today.results, overdue: overdue.results, missing_next_step: noAction.results, stale_7_days: stale.results, scheduled_visits: visits.results, outcomes: outcomes.results });
}
async function listOpportunities(db, url) {
  const status = url.searchParams.get('status') || '';
  const q = boundedText(url.searchParams.get('q'), 80);
  const params = [], where = [];
  if (status) { where.push('o.status=?'); params.push(status); }
  if (q) { where.push('(c.name LIKE ? OR c.phone_key LIKE ? OR o.notes LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  const sql = `SELECT o.*,c.name AS contact_name,c.phone_key FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE WHEN o.next_followup_at IS NULL THEN 1 ELSE 0 END,o.next_followup_at DESC,o.updated_at DESC LIMIT 300`;
  const rows = await db.prepare(sql).bind(...params).all();
  return json({ opportunities: rows.results });
}
async function listListings(db, url) {
  const q=boundedText(url.searchParams.get('q'),80);
  const rows=await db.prepare(`SELECT l.id,l.external_id,l.url,l.title,l.property_type,l.transaction_type,l.area_id,a.name_ar AS area_name,l.area_m2,l.price,l.bedrooms,l.bathrooms,l.finishing
    FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.source_id=9 AND l.area_id IN (${NASR_AREA_ID_SQL}) AND (?='' OR l.title LIKE ? OR l.external_id LIKE ? OR a.name_ar LIKE ?)
    ORDER BY l.observed_at DESC LIMIT 100`).bind(q,q?`%${q}%`:'',q?`%${q}%`:'',q?`%${q}%`:'').all();
  return json({ listings:rows.results });
}
async function getOpportunity(db, opportunityId) {
  const opportunity=await db.prepare(`SELECT o.*,c.name AS contact_name,c.phone_key FROM crm_opportunities o JOIN crm_contacts c ON c.id=o.contact_id WHERE o.id=?`).bind(opportunityId).first();
  if (!opportunity) return json({error:'opportunity_not_found'},404);
  const [activities,properties]=await Promise.all([
    db.prepare('SELECT * FROM crm_activities WHERE opportunity_id=? ORDER BY created_at DESC LIMIT 100').bind(opportunityId).all(),
    db.prepare(`SELECT p.*,l.external_id,l.url,l.title,l.area_m2,l.price,l.area_id,a.name_ar AS area_name FROM crm_opportunity_properties p
      JOIN listings l ON l.id=p.listing_id JOIN areas a ON a.id=l.area_id WHERE p.opportunity_id=? ORDER BY p.created_at DESC`).bind(opportunityId).all(),
  ]);
  return json({opportunity,activities:activities.results,properties:properties.results});
}
async function linkProperty(request, env, opportunityId) {
  const body=await readJson(request), externalId=boundedText(body.external_id,160);
  const presentation=['presented','viewing_scheduled','viewed','offer_made','negotiating','rejected','selected'].includes(body.presentation_status)?body.presentation_status:'presented';
  const viewingAt=body.viewing_at?isoDate(body.viewing_at):null;
  const price=optionalNumber(body.presented_price);
  const objection=['price','location','size','financing','timing','no_response','other'].includes(body.objection_reason)?body.objection_reason:null;
  if(!externalId || (body.viewing_at&&!viewingAt) || !price.ok) return json({error:'invalid_property_link'},400);
  const opportunity=await env.DB.prepare('SELECT id FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if(!opportunity) return json({error:'opportunity_not_found'},404);
  const listing=await env.DB.prepare(`SELECT l.id FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.source_id=9 AND l.external_id=? AND l.area_id IN (${NASR_AREA_ID_SQL}) LIMIT 1`).bind(externalId).first();
  if(!listing) return json({error:'nasr_city_listing_not_found'},404);
  const linkId=id();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO crm_opportunity_properties(id,opportunity_id,listing_id,presentation_status,presented_price,viewing_at,viewing_result,objection_reason,notes)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(linkId,opportunityId,listing.id,presentation,price.value,viewingAt,boundedText(body.viewing_result,400),objection,boundedText(body.notes,700)),
      env.DB.prepare(`INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(id(),opportunityId,presentation==='viewing_scheduled'||presentation==='viewed'?'visit':presentation==='presented'||presentation==='offer_made'?'offer':'objection',boundedText(body.activity_summary,1200)||`تحديث عقار معروض: ${externalId}`,boundedText(body.viewing_result,200),null,null),
    ]);
    return json({ok:true,listing_id:listing.id,external_id:externalId});
  } catch(error) { return sqlError(error); }
}
async function createOpportunity(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body.phone);
  const intent = ['buy','rent','sell','lease','other'].includes(body.intent) ? body.intent : null;
  const source = ['call','missed_call','referral','website','whatsapp','other'].includes(body.source) ? body.source : null;
  const status = ['active','visit_scheduled','viewing_done','offer','negotiating','near_close','won','lost','paused','unqualified'].includes(body.status) ? body.status : 'active';
  const nextAction = boundedText(body.next_action, 180) || null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const reason = boundedText(body.no_followup_reason, 240) || null;
  const budgetMin=optionalNumber(body.budget_min), budgetMax=optionalNumber(body.budget_max), sizeMin=optionalNumber(body.size_min_m2), sizeMax=optionalNumber(body.size_max_m2);
  if (!phone || !intent || !source || (body.next_followup_at && !nextAt) || !budgetMin.ok || !budgetMax.ok || !sizeMin.ok || !sizeMax.ok ||
      (budgetMin.value!==null && budgetMax.value!==null && budgetMin.value>budgetMax.value) ||
      (sizeMin.value!==null && sizeMax.value!==null && sizeMin.value>sizeMax.value)) return json({ error: 'invalid_contact_or_opportunity' }, 400);
  if (['active','visit_scheduled','viewing_done','offer','negotiating','near_close'].includes(status) && ((!nextAction || !nextAt) && !reason)) return json({ error: 'next_action_required' }, 400);
  const allowedLoss=['price','location','size','financing','timing','no_response','competition','unsuitable','other'];
  if (status==='lost' && !allowedLoss.includes(body.loss_reason)) return json({error:'loss_reason_required'},400);
  const idem = request.headers.get('idempotency-key');
  if (!idem || !/^[A-Za-z0-9._:-]{12,128}$/.test(idem)) return json({ error: 'idempotency_key_required' }, 400);
  const existing = await env.DB.prepare('SELECT opportunity_id FROM crm_submission_receipts WHERE submission_key=?').bind(idem).first();
  if (existing) return json({ opportunity_id: existing.opportunity_id, duplicate_submission: true });
  const contactId = id(), opportunityId = id();
  const name = boundedText(body.name, 100);
  try {
    let contact = await env.DB.prepare(`INSERT INTO crm_contacts(id,phone_key,name) VALUES(?,?,?)
      ON CONFLICT(phone_key) DO NOTHING RETURNING id,name`).bind(contactId, phone, name).first();
    if (!contact) contact = await env.DB.prepare('SELECT id,name FROM crm_contacts WHERE phone_key=?').bind(phone).first();
    if (!contact) return json({ error: 'contact_resolution_failed' }, 409);
    if (normalizeName(contact.name) && normalizeName(name) && normalizeName(contact.name) !== normalizeName(name)) {
      return json({ error: 'duplicate_phone_review' }, 409);
    }
    if (!normalizeName(contact.name) && normalizeName(name)) {
      await env.DB.prepare('UPDATE crm_contacts SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(name,contact.id).run();
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO crm_opportunities(id,contact_id,intent,source,source_url,status,area_label,budget_min,budget_max,size_min_m2,size_max_m2,property_type,notes,next_action,next_followup_at,no_followup_reason,closed_at,loss_reason,loss_notes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(opportunityId,contact.id,intent,source,safeSitePath(body.source_url),status,boundedText(body.area_label,100),budgetMin.value,budgetMax.value,sizeMin.value,sizeMax.value,boundedText(body.property_type,80),boundedText(body.notes,1200),nextAction,nextAt,reason,status==='won'||status==='lost'?new Date().toISOString():null,body.loss_reason || null,boundedText(body.loss_notes,500)),
      env.DB.prepare('INSERT INTO crm_submission_receipts(submission_key,opportunity_id) VALUES(?,?)').bind(idem,opportunityId),
      env.DB.prepare(`INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)`).bind(id(),opportunityId,source==='call'?'call':source==='missed_call'?'missed_call':source==='whatsapp'?'whatsapp_note':'note',boundedText(body.notes,1200)||'تسجيل فرصة جديدة','',nextAction,nextAt),
    ]);
    return json({ contact_id: contact.id, opportunity_id: opportunityId, duplicate_submission: false }, 201);
  } catch (error) {
    if (/UNIQUE constraint failed: crm_submission_receipts\.submission_key/.test(String(error?.message))) {
      const replay = await env.DB.prepare('SELECT opportunity_id FROM crm_submission_receipts WHERE submission_key=?').bind(idem).first();
      if (replay) return json({ opportunity_id: replay.opportunity_id, duplicate_submission: true });
    }
    return sqlError(error);
  }
}
async function addActivity(request, env, opportunityId) {
  const body = await readJson(request);
  const summary = boundedText(body.summary, 1200);
  const activityType = ['call','missed_call','whatsapp_note','visit','offer','objection','note','status_change'].includes(body.activity_type) ? body.activity_type : null;
  const status = body.status;
  const allowedStatuses = ['active','visit_scheduled','viewing_done','offer','negotiating','near_close','won','lost','paused','unqualified'];
  const nextAction = boundedText(body.next_action,180)||null;
  const nextAt = body.next_followup_at ? isoDate(body.next_followup_at) : null;
  const reason = boundedText(body.no_followup_reason,240)||null;
  const current = await env.DB.prepare('SELECT id,status,closed_at,loss_reason,loss_notes FROM crm_opportunities WHERE id=?').bind(opportunityId).first();
  if (!current) return json({ error: 'opportunity_not_found' }, 404);
  if (!summary || !activityType || (status && !allowedStatuses.includes(status)) || (body.next_followup_at && !nextAt)) return json({ error: 'invalid_activity' }, 400);
  const nextStatus = status || current.status;
  if (['active','visit_scheduled','viewing_done','offer','negotiating','near_close'].includes(nextStatus) && ((!nextAction || !nextAt) && !reason)) return json({ error: 'next_action_required' }, 400);
  const closed = ['won','lost'].includes(nextStatus) ? (current.status===nextStatus && current.closed_at ? current.closed_at : new Date().toISOString()) : null;
  const allowedLoss=['price','location','size','financing','timing','no_response','competition','unsuitable','other'];
  const lossReason = nextStatus === 'lost' ? (allowedLoss.includes(body.loss_reason) ? body.loss_reason : current.status==='lost' ? current.loss_reason : null) : null;
  const lossNotes = nextStatus === 'lost' ? (boundedText(body.loss_notes,500)||current.loss_notes||'') : '';
  if (nextStatus === 'lost' && !lossReason) return json({ error: 'loss_reason_required' }, 400);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE crm_opportunities SET status=?,next_action=?,next_followup_at=?,no_followup_reason=?,closed_at=?,loss_reason=?,loss_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(nextStatus,nextAction,nextAt,reason,closed,lossReason,lossNotes,opportunityId),
      env.DB.prepare(`INSERT INTO crm_activities(id,opportunity_id,activity_type,summary,outcome,next_action,next_followup_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(id(),opportunityId,activityType,summary,boundedText(body.outcome,200),nextAction,nextAt),
    ]);
    return json({ ok: true, opportunity_id: opportunityId });
  } catch (error) { return sqlError(error); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('origin') || '';
    const headers = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: origin === ALLOWED_ORIGIN ? 204 : 403, headers });
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'nasr-crm-api' });
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: 'origin_not_allowed' }, 403);
    const auth = await verifyAccess(request, env);
    if (!auth.ok) return json({ error: auth.code }, auth.status, headers);
    try {
      const withCors = async response => { const h=new Headers(response.headers);Object.entries(headers).forEach(([k,v])=>h.set(k,v));return new Response(response.body,{status:response.status,headers:h}); };
      if (request.method === 'GET' && url.pathname === '/api/dashboard') return await withCors(await dashboard(env.DB,url));
      if (request.method === 'GET' && url.pathname === '/api/opportunities') return await withCors(await listOpportunities(env.DB,url));
      if (request.method === 'POST' && url.pathname === '/api/opportunities') return await withCors(await createOpportunity(request,env));
      if (request.method === 'GET' && url.pathname === '/api/listings') return await withCors(await listListings(env.DB,url));
      const detail=url.pathname.match(/^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})$/);
      if(request.method==='GET' && detail) return await withCors(await getOpportunity(env.DB,detail[1]));
      const activity = url.pathname.match(/^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/activities$/);
      if (request.method === 'POST' && activity) return await withCors(await addActivity(request,env,activity[1]));
      const property=url.pathname.match(/^\/api\/opportunities\/([a-zA-Z0-9_-]{8,80})\/properties$/);
      if (request.method==='POST' && property) return await withCors(await linkProperty(request,env,property[1]));
      return json({ error: 'not_found' }, 404, headers);
    } catch (error) {
      if (error?.message === 'body_too_large') return json({ error: 'body_too_large' }, 413, headers);
      if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400, headers);
      return json({ error: 'request_failed' }, 500, headers);
    }
  },
};
