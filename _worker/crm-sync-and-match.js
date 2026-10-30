// CRM Property/Counterparty Matching, Source Reconciliation Sync, Conversations & Smart Follow-up APIs.
// Self-contained Worker module — zero external AI calls, strict Nasr City CRM guardrails.

import {
  CURRENT_RULE_VERSION,
  cleanBidiControls,
  getCairoClock,
  getCairoDayBoundsUtc,
  normalizeInternationalPhone,
  parseFollowupInstantMs,
  toCairoDayKey,
  upsertConversationAndAnalyze,
} from './crm-chat-intel.js';

const ACTIVE_OPP_SQL = "'active','visit_scheduled','viewing_done','offer','negotiating','near_close'";

export function inferTrackFromText(propertyType = '', intent = '', notes = '') {
  const hay = `${propertyType || ''} ${notes || ''}`;
  if (/مقر|إداري|اداري|مكتب|محل|تجاري|عيادة|عياده|مخزن|مول/.test(hay)) return 'admin_hq';
  if (/مفروش/.test(hay)) return 'furnished_apt';
  if (intent === 'rent' || intent === 'lease') return 'new_rent_apt';
  return 'sale_apt';
}

function normalizeArabicText(value) {
  return cleanBidiControls(value)
    .replaceAll(/[أإآٱ]/g, 'ا')
    .replaceAll('ة', 'ه')
    .replaceAll('ى', 'ي')
    .replaceAll(/\s+/g, ' ')
    .toLowerCase();
}

export function canonSyncKey(value) {
  return cleanBidiControls(value)
    .replace(/^دردشة(?:\s+في)?\s+واتساب\s+مع\s*/, '')
    .replace(/\.zip$/i, '')
    .replace(/\.txt$/i, '')
    .replaceAll(/[\s/_؟?:]+/g, '')
    .toLowerCase();
}

export function canonLeadMatchKey(value) {
  return normalizeArabicText(cleanBidiControls(value))
    .replace(/^دردشه(?:\s+في)?\s+واتساب\s+مع\s*/, '')
    .replace(/\.zip$/i, '')
    .replace(/\.txt$/i, '')
    .replaceAll(/[🟢🔴🔵🟡✈\uFE0F]/gu, '')
    .replaceAll(/[\s/_؟?:().,\-–—~@]+/g, '');
}

function classifyUnitKind(propType = '', title = '', track = '') {
  const hay = normalizeArabicText(`${propType} ${title}`);
  if (track === 'admin_hq' || /اداري|مقر|مكتب|محل|تجاري|عياده|مخزن|مول/.test(hay) || /office|commercial|retail|clinic/i.test(hay)) {
    return 'commercial_admin';
  }
  if (/فيلا|توين|تاون|villa/i.test(hay)) return 'villa';
  if (/دوبلكس|duplex/i.test(hay)) return 'duplex';
  return 'apartment';
}

function extractAreaTokens(areaLabel = '') {
  const norm = normalizeArabicText(areaLabel);
  if (!norm || norm === 'مدينه نصر') return [];
  return norm
    .split(/[،,/|\-–—]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 3 && s !== 'مدينه نصر');
}

function checkAreaAlignment(oppAreaLabel, candidateText) {
  const tokens = extractAreaTokens(oppAreaLabel);
  if (tokens.length === 0) {
    return { exactArea: true, label: 'ضمن نطاق مدينة نصر' };
  }
  const candNorm = normalizeArabicText(candidateText);
  for (const tok of tokens) {
    if (candNorm.includes(tok)) {
      return { exactArea: true, label: `مطابق للمنطقة المطلوبة (${oppAreaLabel})` };
    }
  }
  return { exactArea: false, label: candidateText ? `منطقة داخل مدينة نصر (${candidateText})` : 'داخل مدينة نصر' };
}

function formatMoneyAr(val) {
  return `${Math.round(Number(val)).toLocaleString('en-US')} ج.م`;
}

async function inspectListingsColumns(db) {
  const info = await db.prepare('PRAGMA table_info(listings)').all();
  const cols = new Set((info?.results || []).map(r => r.name));
  return {
    hasStatus: cols.has('status'),
    hasPriceUpdatedAt: cols.has('price_updated_at'),
  };
}

async function inspectOpportunityLeadCols(db) {
  const info = await db.prepare('PRAGMA table_info(crm_opportunities)').all();
  const cols = new Set((info?.results || []).map(r => r.name));
  return {
    hasLeadLabel: cols.has('lead_label'),
    hasConversationId: cols.has('conversation_id'),
  };
}

function evaluateCatalogListingMatch(opp, item, targetTrack, { allowNearBounds = false } = {}) {
  const oppKind = classifyUnitKind(opp.property_type, '', targetTrack);
  const itemKind = classifyUnitKind(item.property_type, item.title, '');
  if (oppKind !== itemKind) {
    // Allow duplex when buyer asks for apartment only if size/budget fit, otherwise strict kind match
    if (!(oppKind === 'apartment' && itemKind === 'duplex')) return null;
  }
  if (targetTrack === 'furnished_apt' && !/مفروش/.test(`${item.title || ''} ${item.finishing || ''}`)) {
    return null;
  }

  const reasons = [];
  let score = 50;
  let withinStrictBounds = true;
  let outOfBoundsReason = null;

  const txAr = opp.intent === 'buy' ? 'شراء/تمليك' : 'إيجار';
  reasons.push(`متوافق مع اتجاه الطلب (${txAr}) ونوع الوحدة`);

  const price = item.price !== null && item.price !== undefined ? Number(item.price) : null;
  const bMin = opp.budget_min !== null && opp.budget_min !== undefined ? Number(opp.budget_min) : null;
  const bMax = opp.budget_max !== null && opp.budget_max !== undefined ? Number(opp.budget_max) : null;

  if (price !== null && Number.isFinite(price)) {
    if (bMax !== null && price > bMax) {
      const overRatio = bMax > 0 ? (price - bMax) / bMax : 1;
      if (!allowNearBounds || overRatio > 0.1) return null;
      withinStrictBounds = false;
      outOfBoundsReason = `السعر (${formatMoneyAr(price)}) يتجاوز الحد الأقصى للميزانية (${formatMoneyAr(bMax)}) بنسبة ${Math.round(overRatio * 100)}%`;
      reasons.push(`تنبيه فرق ميزانية معلن: ${outOfBoundsReason}`);
      score -= 20;
    } else if (bMin !== null && price < bMin) {
      const underRatio = bMin > 0 ? (bMin - price) / bMin : 1;
      if (!allowNearBounds || underRatio > 0.15) return null;
      withinStrictBounds = false;
      outOfBoundsReason = `السعر (${formatMoneyAr(price)}) أقل من الحد الأدنى المحدد (${formatMoneyAr(bMin)})`;
      reasons.push(`تنبيه نطاق سعري معلن: ${outOfBoundsReason}`);
      score -= 10;
    } else if (bMax !== null || bMin !== null) {
      reasons.push(`ضمن الميزانية المحددة (${formatMoneyAr(price)})`);
      score += 25;
    }
  } else if (bMax !== null || bMin !== null) {
    // Listing without a published numeric price cannot silently pass a strict budget filter
    if (!allowNearBounds) return null;
    withinStrictBounds = false;
    outOfBoundsReason = 'العقار بدون سعر رقمي منشور للمقارنة بالميزانية';
    reasons.push(outOfBoundsReason);
  }

  const areaM2 = item.area_m2 !== null && item.area_m2 !== undefined ? Number(item.area_m2) : null;
  const sMin = opp.size_min_m2 !== null && opp.size_min_m2 !== undefined ? Number(opp.size_min_m2) : null;
  const sMax = opp.size_max_m2 !== null && opp.size_max_m2 !== undefined ? Number(opp.size_max_m2) : null;

  if (areaM2 !== null && Number.isFinite(areaM2)) {
    if (sMin !== null && areaM2 < sMin) {
      const diffRatio = sMin > 0 ? (sMin - areaM2) / sMin : 1;
      if (!allowNearBounds || diffRatio > 0.1) return null;
      withinStrictBounds = false;
      outOfBoundsReason = outOfBoundsReason || `المساحة (${areaM2} م²) أقل من الحد الأدنى المطلوب (${sMin} م²)`;
      reasons.push(`تنبيه فرق مساحة معلن: المساحة ${areaM2} م² مقابل حد أدنى ${sMin} م²`);
      score -= 15;
    } else if (sMax !== null && areaM2 > sMax) {
      const diffRatio = sMax > 0 ? (areaM2 - sMax) / sMax : 1;
      if (!allowNearBounds || diffRatio > 0.1) return null;
      withinStrictBounds = false;
      outOfBoundsReason = outOfBoundsReason || `المساحة (${areaM2} م²) أكبر من الحد الأقصى المطلوب (${sMax} م²)`;
      reasons.push(`تنبيه فرق مساحة معلن: المساحة ${areaM2} م² مقابل حد أقصى ${sMax} م²`);
      score -= 15;
    } else if (sMin !== null || sMax !== null) {
      reasons.push(`ضمن المساحة المطلوبة (${areaM2} م²)`);
      score += 15;
    }
  } else if (sMin !== null || sMax !== null) {
    if (!allowNearBounds) return null;
    withinStrictBounds = false;
    outOfBoundsReason = outOfBoundsReason || 'المساحة غير محددة رقميًا على العقار';
  }

  const areaCheck = checkAreaAlignment(opp.area_label, `${item.title || ''} ${item.area_name || ''}`);
  if (extractAreaTokens(opp.area_label).length > 0) {
    if (areaCheck.exactArea) {
      reasons.push(areaCheck.label);
      score += 20;
    } else {
      if (!allowNearBounds) return null;
      withinStrictBounds = false;
      outOfBoundsReason = outOfBoundsReason || `منطقة مختلفة داخل مدينة نصر عن المنطقة المطلوبة (${opp.area_label})`;
      reasons.push(`تنبيه نطاق مكاني معلن: داخل مدينة نصر ولكن خارج (${opp.area_label})`);
      score -= 15;
    }
  } else {
    reasons.push(areaCheck.label);
  }

  return {
    ...item,
    match_kind: 'catalog_listing',
    match_score: score,
    within_strict_bounds: withinStrictBounds,
    out_of_bounds_reason: outOfBoundsReason,
    match_reasons: reasons,
    match_reason: reasons.join(' · '),
  };
}

function evaluateCounterpartyOpportunityMatch(opp, cand, targetTrack) {
  const candInferredTrack = cand.track === 'transient'
    ? inferTrackFromText(cand.property_type, cand.intent, cand.notes)
    : cand.track;
  if (candInferredTrack !== targetTrack) return null;

  const oppKind = classifyUnitKind(opp.property_type, opp.notes, targetTrack);
  const candKind = classifyUnitKind(cand.property_type, cand.notes, candInferredTrack);
  if (oppKind !== candKind) return null;

  const isOppSupply = opp.intent === 'sell' || opp.intent === 'lease';
  const supply = isOppSupply ? opp : cand;
  const demand = isOppSupply ? cand : opp;

  const reasons = [];
  let score = 50;

  if (isOppSupply) {
    reasons.push(opp.intent === 'sell' ? 'طلب مشتري متوافق مع الوحدة المعروضة للبيع' : 'طلب مستأجر متوافق مع الوحدة المعروضة للإيجار');
  } else {
    reasons.push(opp.intent === 'buy' ? 'عرض مالك بيع متوافق مع طلب الشراء' : 'عرض مالك إيجار متوافق مع طلب الإيجار');
  }

  // Budget overlap check between supply price and demand budget
  const supplyMin = supply.budget_min !== null && supply.budget_min !== undefined ? Number(supply.budget_min) : null;
  const supplyMax = supply.budget_max !== null && supply.budget_max !== undefined ? Number(supply.budget_max) : null;
  const supplyAsk = supplyMin ?? supplyMax;
  const demandMin = demand.budget_min !== null && demand.budget_min !== undefined ? Number(demand.budget_min) : null;
  const demandMax = demand.budget_max !== null && demand.budget_max !== undefined ? Number(demand.budget_max) : null;

  if (supplyAsk !== null && (demandMin !== null || demandMax !== null)) {
    if (demandMax !== null && supplyAsk > demandMax) return null;
    if (demandMin !== null && (supplyMax ?? supplyAsk) < demandMin) return null;
    reasons.push(`متوافق مع الميزانية (${formatMoneyAr(supplyAsk)})`);
    score += 25;
  } else if (demandMax === null && demandMin === null) {
    reasons.push('مشتري بدون سقف ميزانية مقيد (يُراجع السعر عند التواصل)');
  }

  // Size overlap check
  const supSizeMin = supply.size_min_m2 !== null && supply.size_min_m2 !== undefined ? Number(supply.size_min_m2) : null;
  const supSizeMax = supply.size_max_m2 !== null && supply.size_max_m2 !== undefined ? Number(supply.size_max_m2) : null;
  const supSize = supSizeMax ?? supSizeMin;
  const demSizeMin = demand.size_min_m2 !== null && demand.size_min_m2 !== undefined ? Number(demand.size_min_m2) : null;
  const demSizeMax = demand.size_max_m2 !== null && demand.size_max_m2 !== undefined ? Number(demand.size_max_m2) : null;

  if (supSize !== null && (demSizeMin !== null || demSizeMax !== null)) {
    if (demSizeMin !== null && supSize < demSizeMin) return null;
    if (demSizeMax !== null && (supSizeMin ?? supSize) > demSizeMax) return null;
    reasons.push(`متوافق مع المساحة (${supSize} م²)`);
    score += 15;
  }

  // Area alignment
  if (opp.area_label && cand.area_label) {
    const areaAlign = checkAreaAlignment(opp.area_label, cand.area_label);
    if (areaAlign.exactArea) {
      reasons.push(`تطابق المنطقة (${cand.area_label})`);
      score += 20;
    } else if (demand.budget_max !== null && extractAreaTokens(demand.area_label).length > 0 && extractAreaTokens(supply.area_label).length > 0) {
      // Both sides specified explicit distinct neighborhoods AND explicit budget constraints -> do not cross-nominate silently
      return null;
    } else {
      reasons.push(`داخل مدينة نصر (منطقة الطرف المقابل: ${cand.area_label})`);
    }
  } else {
    reasons.push('ضمن نطاق مدينة نصر');
  }

  return {
    ...cand,
    match_kind: isOppSupply ? 'buyer_request' : 'seller_offer',
    match_score: score,
    within_strict_bounds: true,
    match_reasons: reasons,
    match_reason: reasons.join(' · '),
  };
}

export async function computeOpportunityMatches(db, opportunityId, scope, { allowNearBounds = false } = {}) {
  const opp = await db.prepare(
    'SELECT id,track,intent,status,property_type,area_label,budget_min,budget_max,size_min_m2,size_max_m2,notes FROM crm_opportunities WHERE id=?',
  ).bind(opportunityId).first();
  if (!opp) return null;

  const targetTrack = opp.track === 'transient'
    ? inferTrackFromText(opp.property_type, opp.intent, opp.notes)
    : opp.track;

  const isSupply = opp.intent === 'sell' || opp.intent === 'lease';
  let oppositeIntentsSql = "'sell','lease'";
  if (isSupply) {
    oppositeIntentsSql = opp.intent === 'sell' ? "'buy'" : "'rent'";
  } else if (opp.intent === 'buy') {
    oppositeIntentsSql = "'sell'";
  } else if (opp.intent === 'rent') {
    oppositeIntentsSql = "'lease'";
  }

  const oppLeadCols = await inspectOpportunityLeadCols(db);
  const nameExpr = oppLeadCols.hasLeadLabel
    ? "COALESCE(c.name, NULLIF(o.lead_label, ''), cv_link.chat_title, 'فرصة قيد استكمال جهة الاتصال')"
    : "COALESCE(c.name, 'عميل')";
  const convJoin = oppLeadCols.hasConversationId
    ? 'LEFT JOIN crm_conversations cv_link ON cv_link.id = o.conversation_id'
    : '';
  const candidatesRes = await db.prepare(
    `SELECT o.id,o.track,o.intent,o.status,o.area_label,o.budget_min,o.budget_max,o.size_min_m2,o.size_max_m2,o.property_type,o.notes,
        c.id AS contact_id, ${nameExpr} AS contact_name,
        (SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key
     FROM crm_opportunities o
     LEFT JOIN crm_contacts c ON c.id=o.contact_id
     ${convJoin}
     WHERE o.id != ?
       AND o.intent IN (${oppositeIntentsSql})
       AND o.status NOT IN ('won','lost','unqualified')
       AND (o.track = ? OR o.track = 'transient')
     ORDER BY CASE WHEN o.track='transient' THEN 1 ELSE 0 END, o.updated_at DESC
     LIMIT 60`,
  ).bind(opportunityId, targetTrack).all();

  const matchingOpportunities = (candidatesRes?.results || [])
    .map(cand => evaluateCounterpartyOpportunityMatch(opp, cand, targetTrack))
    .filter(Boolean)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 12);

  let matchingListings = [];
  if (scope && (opp.intent === 'buy' || opp.intent === 'rent')) {
    const txType = opp.intent === 'buy' ? 'sale' : 'rent';
    const cols = await inspectListingsColumns(db);
    const statusWhere = cols.hasStatus ? "AND COALESCE(l.status, 'active') = 'active'" : '';
    const orderExpr = cols.hasPriceUpdatedAt
      ? 'COALESCE(l.price_updated_at, l.observed_at) DESC, l.id DESC'
      : 'l.observed_at DESC, l.id DESC';
    const rowsRes = await db.prepare(
      `SELECT l.id,l.external_id,l.title,l.url,l.property_type,l.transaction_type,l.price,l.area_m2,l.bedrooms,l.bathrooms,l.finishing,
          a.name_ar AS area_name
       FROM listings l JOIN areas a ON a.id = l.area_id
       WHERE l.source_id = ? AND l.area_id IN (${scope.areaSql}) ${statusWhere} AND l.transaction_type = ?
       ORDER BY ${orderExpr}
       LIMIT 120`,
    ).bind(scope.sourceId, txType).all();

    matchingListings = (rowsRes?.results || [])
      .filter(item => !String(item.external_id || '').startsWith('crm-test-only-'))
      .map(item => evaluateCatalogListingMatch(opp, item, targetTrack, { allowNearBounds }))
      .filter(Boolean)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 10);
  }

  return {
    opportunity_id: opp.id,
    intent: opp.intent,
    direction: isSupply ? 'supply_to_buyer_requests' : 'demand_to_catalog_and_supply',
    target_track: targetTrack,
    opportunities: matchingOpportunities,
    listings: matchingListings,
  };
}

function chunkArray(items, size = 35) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function runChunkedSql(db, ids, sqlBuilder) {
  for (const part of chunkArray(ids, 35)) {
    const placeholders = part.map(() => '?').join(',');
    await db.prepare(sqlBuilder(placeholders)).bind(...part).run();
  }
}

async function queryIdsInChunks(db, ids, sqlBuilder) {
  const found = new Set();
  for (const part of chunkArray(ids, 35)) {
    const placeholders = part.map(() => '?').join(',');
    const res = await db.prepare(sqlBuilder(placeholders)).bind(...part).all();
    for (const row of res?.results || []) {
      if (row?.id) found.add(row.id);
    }
  }
  return [...found];
}

function normalizeVcfSyncItem(vc) {
  const fn = cleanBidiControls(vc?.fn || vc?.name || '');
  const ck = canonSyncKey(fn);
  const normPhones = [];
  const seenPh = new Set();
  for (const rawPh of vc?.phones || []) {
    const e164 = normalizeInternationalPhone(rawPh?.e164 || rawPh?.phone || rawPh?.raw || '');
    if (e164 && !seenPh.has(e164)) {
      seenPh.add(e164);
      normPhones.push({
        e164,
        raw: cleanBidiControls(rawPh?.raw || rawPh?.e164 || e164),
        label: cleanBidiControls(rawPh?.label || 'أساسي (VCF)').slice(0, 40),
        source_ref: cleanBidiControls(rawPh?.source_ref || rawPh?.vcf_file || (vc?.vcf_files || []).join(',') || 'vcf'),
      });
    }
  }
  const hasTransientMarker = fn.includes('✈');
  const isComplete = Boolean(fn && fn.length >= 2 && ck && normPhones.length > 0 && !hasTransientMarker);
  return { fn, ck, normPhones, hasTransientMarker, isComplete };
}

function collectKeptFoundationIds(preparedVcf, { contactsById, phoneOwnerMap, phonelessContactsByCanon, allContactsByCanon }) {
  const keptIds = new Set();
  for (const item of preparedVcf) {
    const nonTransientOwners = [...new Set(item.normPhones.map(p => phoneOwnerMap.get(p.e164)).filter(Boolean))]
      .filter(cid => !String(contactsById.get(cid)?.name || '').includes('✈'));
    if (nonTransientOwners.length >= 1) {
      for (const cid of nonTransientOwners) keptIds.add(cid);
      continue;
    }
    const phoneless = (phonelessContactsByCanon.get(item.ck) || []).filter(c => !String(c.name || '').includes('✈'));
    if (phoneless.length === 1) {
      keptIds.add(phoneless[0].id);
      continue;
    }
    const sameLabel = (allContactsByCanon.get(item.ck) || []).filter(c => c.phones.length > 0 && !String(c.name || '').includes('✈'));
    if (sameLabel.length > 0) {
      keptIds.add(sameLabel[0].id);
    }
  }
  return keptIds;
}

async function detachContactsWithoutCascade(db, contactsToPurge, oppLeadCols) {
  if (contactsToPurge.length === 0) return;
  if (oppLeadCols.hasLeadLabel) {
    await runChunkedSql(
      db,
      contactsToPurge,
      ph => `UPDATE crm_opportunities
             SET lead_label = COALESCE(NULLIF(lead_label, ''), (SELECT c.name FROM crm_contacts c WHERE c.id = crm_opportunities.contact_id), ''),
                 contact_id = NULL
             WHERE contact_id IN (${ph})`,
    );
  }
  await runChunkedSql(
    db,
    contactsToPurge,
    ph => `UPDATE crm_conversations
           SET contact_id = NULL,
               match_status = CASE WHEN match_status IN ('matched', 'resolved_manual') THEN 'unmatched_review' ELSE match_status END,
               review_reason = CASE WHEN COALESCE(review_reason, '') = '' THEN 'تم فصل سجل جهة الاتصال مع الاحتفاظ بالمحادثة كاملة للمراجعة' ELSE review_reason END
           WHERE contact_id IN (${ph})`,
  );
  await runChunkedSql(db, contactsToPurge, ph => `UPDATE crm_conversation_insights SET contact_id = NULL WHERE contact_id IN (${ph})`);
  await runChunkedSql(db, contactsToPurge, ph => `UPDATE crm_smart_alerts SET contact_id = NULL WHERE contact_id IN (${ph})`);
  await runChunkedSql(db, contactsToPurge, ph => `DELETE FROM crm_contact_phones WHERE contact_id IN (${ph})`);
  await runChunkedSql(db, contactsToPurge, ph => `UPDATE crm_contact_audit_log SET contact_id = NULL WHERE contact_id IN (${ph})`);
  await runChunkedSql(
    db,
    contactsToPurge,
    ph => `DELETE FROM crm_idempotency_receipts WHERE resource_type = 'contact' AND resource_id IN (${ph})`,
  );
  await runChunkedSql(db, contactsToPurge, ph => `DELETE FROM crm_contacts WHERE id IN (${ph})`);
}

async function purgeIncompleteFoundationRecords(db, { contactsById, keptIds, dryRun }) {
  const oppLeadCols = await inspectOpportunityLeadCols(db);
  const contactsToPurge = [...contactsById.keys()].filter(cid => !keptIds.has(cid));
  const detachedOpps = await queryIdsInChunks(
    db,
    contactsToPurge,
    ph => `SELECT id FROM crm_opportunities WHERE contact_id IN (${ph}) AND COALESCE(track, 'sale_apt') != 'transient'`,
  );
  const detachedConvs = await queryIdsInChunks(
    db,
    contactsToPurge,
    ph => `SELECT id FROM crm_conversations WHERE contact_id IN (${ph}) AND chat_title NOT LIKE 'TEST ONLY%'`,
  );
  const transientOppsRes = await db.prepare(
    `SELECT o.id FROM crm_opportunities o
     LEFT JOIN crm_contacts c ON c.id = o.contact_id
     WHERE o.track = 'transient' AND COALESCE(c.name, '') NOT LIKE 'TEST ONLY%'`,
  ).all();
  const oppIdsToPurge = (transientOppsRes?.results || []).map(r => r.id).filter(Boolean);

  if (!dryRun) {
    if (oppIdsToPurge.length > 0) {
      await runChunkedSql(
        db,
        oppIdsToPurge,
        ph => `UPDATE crm_smart_alerts SET resolved_by_activity_id = NULL WHERE resolved_by_activity_id IN (SELECT id FROM crm_activities WHERE opportunity_id IN (${ph}))`,
      );
      await runChunkedSql(db, oppIdsToPurge, ph => `UPDATE crm_smart_alerts SET opportunity_id = NULL WHERE opportunity_id IN (${ph})`);
      await runChunkedSql(db, oppIdsToPurge, ph => `UPDATE crm_conversations SET opportunity_id = NULL WHERE opportunity_id IN (${ph})`);
      await runChunkedSql(db, oppIdsToPurge, ph => `UPDATE crm_conversation_insights SET opportunity_id = NULL WHERE opportunity_id IN (${ph})`);
      await runChunkedSql(db, oppIdsToPurge, ph => `DELETE FROM crm_opportunity_properties WHERE opportunity_id IN (${ph})`);
      await runChunkedSql(db, oppIdsToPurge, ph => `DELETE FROM crm_activities WHERE opportunity_id IN (${ph})`);
      await runChunkedSql(
        db,
        oppIdsToPurge,
        ph => `DELETE FROM crm_idempotency_receipts WHERE resource_type = 'opportunity' AND resource_id IN (${ph})`,
      );
      await runChunkedSql(db, oppIdsToPurge, ph => `DELETE FROM crm_opportunities WHERE id IN (${ph})`);
    }
    await detachContactsWithoutCascade(db, contactsToPurge, oppLeadCols);
  }

  return {
    contactsToPurge,
    purgedContactsCount: contactsToPurge.length,
    purgedOpportunitiesCount: oppIdsToPurge.length,
    purgedConversationsCount: 0,
    detachedOpportunitiesCount: detachedOpps.length,
    detachedConversationsCount: detachedConvs.length,
  };
}

async function syncExistingOwnerPhones(db, existingId, existingRec, normPhones, ctx) {
  const { dryRun, nowIso, phoneOwnerMap, diff } = ctx;
  for (const ph of normPhones) {
    const alreadyHas = existingRec.phones.find(ep => ep.phone_key === ph.e164);
    if (alreadyHas) {
      if (!dryRun && (!alreadyHas.source_ref || alreadyHas.source_type === 'manual')) {
        await db.prepare(
          "UPDATE crm_contact_phones SET source_type='vcf', source_ref=?, raw_input=COALESCE(NULLIF(raw_input,''), ?), verified_at=? WHERE id=?",
        ).bind(ph.source_ref, ph.raw, nowIso, alreadyHas.id).run();
      }
      continue;
    }
    if (!phoneOwnerMap.has(ph.e164)) {
      diff.additional_phones_for_existing += 1;
      if (!dryRun) {
        await db.batch([
          db.prepare(
            "INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary,raw_input,source_type,source_ref,verified_at) VALUES(?,?,?,?,0,?,'vcf',?,?)",
          ).bind(crypto.randomUUID(), existingId, ph.e164, ph.label || 'إضافي', ph.raw, ph.source_ref, nowIso),
          db.prepare(
            "INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor,created_at) VALUES(?,?,'phone_added','secondary_phone',NULL,?,?,'source_sync',?)",
          ).bind(crypto.randomUUID(), existingId, ph.e164, ph.source_ref, nowIso),
        ]);
        phoneOwnerMap.set(ph.e164, existingId);
      }
    }
  }
}

async function backfillPhonelessContact(db, target, normPhones, ctx) {
  const { dryRun, nowIso, phoneOwnerMap } = ctx;
  if (dryRun) return;
  const stmts = [];
  normPhones.forEach((ph, idx) => {
    stmts.push(
      db.prepare(
        "INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary,raw_input,source_type,source_ref,verified_at) VALUES(?,?,?,?,?,?,'vcf',?,?)",
      ).bind(crypto.randomUUID(), target.id, ph.e164, ph.label || 'واتساب', idx === 0 ? 1 : 0, ph.raw, ph.source_ref, nowIso),
    );
    phoneOwnerMap.set(ph.e164, target.id);
  });
  stmts.push(
    db.prepare('UPDATE crm_contacts SET updated_at=? WHERE id=?').bind(nowIso, target.id),
    db.prepare(
      "INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor,created_at) VALUES(?,?,'source_synced','primary_phone',NULL,?,?,'source_sync',?)",
    ).bind(crypto.randomUUID(), target.id, normPhones[0].e164, normPhones[0].source_ref, nowIso),
  );
  await db.batch(stmts);
  target.phones.push({ phone_key: normPhones[0].e164, is_primary: 1 });
}

async function createMissingVcfContact(db, fn, ck, normPhones, ctx) {
  const { dryRun, nowIso, phoneOwnerMap, resolvedContactIdByCanon, touchedCrmContactIds } = ctx;
  if (dryRun) {
    resolvedContactIdByCanon.set(ck, `dryrun:${ck}`);
    return;
  }
  const newContactId = crypto.randomUUID();
  const stmts = [
    db.prepare('INSERT INTO crm_contacts(id,name,communication_consent,created_at,updated_at) VALUES(?,?,?, ?, ?)')
      .bind(newContactId, fn.slice(0, 100), 'request_only', nowIso, nowIso),
  ];
  normPhones.forEach((ph, idx) => {
    stmts.push(
      db.prepare(
        "INSERT INTO crm_contact_phones(id,contact_id,phone_key,label,is_primary,raw_input,source_type,source_ref,verified_at) VALUES(?,?,?,?,?,?,'vcf',?,?)",
      ).bind(crypto.randomUUID(), newContactId, ph.e164, ph.label || 'أساسي', idx === 0 ? 1 : 0, ph.raw, ph.source_ref, nowIso),
    );
    phoneOwnerMap.set(ph.e164, newContactId);
  });
  stmts.push(
    db.prepare(
      "INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor,created_at) VALUES(?,?,'source_synced','contact_created',NULL,?,?,'source_sync',?)",
    ).bind(crypto.randomUUID(), newContactId, normPhones[0].e164, normPhones[0].source_ref, nowIso),
  );
  await db.batch(stmts);
  resolvedContactIdByCanon.set(ck, newContactId);
  touchedCrmContactIds.add(newContactId);
}

async function syncSingleVcfItem(db, item, ctx) {
  const { fn, ck, normPhones } = item;
  const { contactsById, phoneOwnerMap, phonelessContactsByCanon, allContactsByCanon, resolvedContactIdByCanon, touchedCrmContactIds, diff } = ctx;
  const ownerIds = [...new Set(normPhones.map(p => phoneOwnerMap.get(p.e164)).filter(Boolean))];
  if (ownerIds.length > 1) {
    diff.conflicting_or_duplicate_phones += 1;
    return;
  }
  if (ownerIds.length === 1) {
    const existingId = ownerIds[0];
    touchedCrmContactIds.add(existingId);
    resolvedContactIdByCanon.set(ck, existingId);
    diff.existing_contacts_with_valid_phones += 1;
    await syncExistingOwnerPhones(db, existingId, contactsById.get(existingId), normPhones, ctx);
    return;
  }
  const phonelessMatches = phonelessContactsByCanon.get(ck) || [];
  if (phonelessMatches.length === 1) {
    const target = phonelessMatches[0];
    touchedCrmContactIds.add(target.id);
    resolvedContactIdByCanon.set(ck, target.id);
    diff.existing_contacts_phone_backfilled += 1;
    await backfillPhonelessContact(db, target, normPhones, ctx);
    return;
  }
  const sameLabelWithDifferentPhone = (allContactsByCanon.get(ck) || []).filter(c => c.phones.length > 0);
  if (sameLabelWithDifferentPhone.length > 0) {
    diff.conflicting_or_duplicate_phones += 1;
    resolvedContactIdByCanon.set(ck, sameLabelWithDifferentPhone[0].id);
    touchedCrmContactIds.add(sameLabelWithDifferentPhone[0].id);
    return;
  }
  diff.missing_contacts_to_add += 1;
  await createMissingVcfContact(db, fn, ck, normPhones, ctx);
}

async function syncSingleConversationItem(db, conv, ctx) {
  const { strictCompleteOnly, dryRun, now, resolvedContactIdByCanon, matchedVcfCanons, diff, intelStats } = ctx;
  const title = cleanBidiControls(conv?.title || conv?.chat_title || '');
  const ck = canonSyncKey(title);
  const matchedContactId = (!strictCompleteOnly || !title.includes('✈'))
    ? (resolvedContactIdByCanon.get(ck) || null)
    : null;

  if (matchedContactId) {
    diff.conversations_matched += 1;
    matchedVcfCanons.add(ck);
    if (!dryRun) {
      const res = await upsertConversationAndAnalyze(db, {
        conversationUid: conv.conversation_uid || `wa:${conv.sig || ck}`,
        contactId: matchedContactId,
        sourceType: 'whatsapp_export',
        sourceRef: cleanBidiControls(conv.source_ref || 'google_drive_whatsapp_zip'),
        chatTitle: title,
        rawText: conv.raw_txt || conv.raw_text || '',
        matchStatus: 'matched',
        matchMethod: 'exact_vcf_fn_and_phone',
        reviewReason: '',
        now,
      });
      if (res.created) intelStats.conversations_created += 1;
      if (res.incremental_skipped) intelStats.conversations_incremental_skipped += 1;
      intelStats.messages_stored += res.message_count;
      intelStats.smart_alerts_created += res.alerts_created;
    }
    return;
  }

  diff.conversations_unmatched_review += 1;
  if (!dryRun) {
    const res = await upsertConversationAndAnalyze(db, {
      conversationUid: conv.conversation_uid || `wa:${conv.sig || ck}`,
      contactId: null,
      sourceType: 'whatsapp_export',
      sourceRef: cleanBidiControls(conv.source_ref || 'google_drive_whatsapp_zip'),
      chatTitle: title,
      rawText: conv.raw_txt || conv.raw_text || '',
      matchStatus: 'unmatched_review',
      matchMethod: 'none',
      reviewReason: 'لا يوجد تطابق مؤكد مع سجل هاتف في ملفات VCF؛ أُبقيت في قائمة المراجعة دون إنشاء عميل تلقائي أو نسب أرقام داخل النص',
      now,
    });
    if (res.created) intelStats.conversations_created += 1;
    if (res.incremental_skipped) intelStats.conversations_incremental_skipped += 1;
    intelStats.messages_stored += res.message_count;
    intelStats.smart_alerts_created += res.alerts_created;
  }
}

async function findConversationForRestoredOpp(db, item, ck) {
  if (item?.conversation_id) {
    const byId = await db.prepare('SELECT id, contact_id FROM crm_conversations WHERE id = ? LIMIT 1')
      .bind(String(item.conversation_id)).first();
    if (byId?.id) return byId;
  }
  const candUid = cleanBidiControls(item?.conversation_uid || (ck ? `wa:${ck}` : ''));
  if (candUid) {
    const byUid = await db.prepare('SELECT id, contact_id FROM crm_conversations WHERE conversation_uid = ? LIMIT 1')
      .bind(candUid).first();
    if (byUid?.id) return byUid;
  }
  if (!ck) return null;
  const allConvs = await db.prepare('SELECT id, contact_id, chat_title FROM crm_conversations').all();
  const rows = allConvs?.results || [];
  const exact = rows.find(r => canonSyncKey(r.chat_title || '') === ck);
  if (exact) return exact;
  const leadKey = canonLeadMatchKey(item?.lead_label || item?.customer_label || item?.contact_name || '');
  if (!leadKey) return null;
  const strippedMatches = rows.filter(r => canonLeadMatchKey(r.chat_title || '') === leadKey);
  return strippedMatches.length === 1 ? strippedMatches[0] : null;
}

async function findVerifiedContactForRestoredOpp(db, item, ck, ctx) {
  if (item?.contact_id) {
    const live = await db.prepare(
      `SELECT c.id FROM crm_contacts c
       WHERE c.id = ? AND EXISTS(SELECT 1 FROM crm_contact_phones p WHERE p.contact_id = c.id)
       LIMIT 1`,
    ).bind(String(item.contact_id)).first();
    if (live?.id) return live.id;
  }
  const normPhone = normalizeInternationalPhone(item?.verified_phone || '');
  if (normPhone) {
    const phOwner = ctx.phoneOwnerMap.get(normPhone);
    if (phOwner) return phOwner;
    const dbPh = await db.prepare('SELECT contact_id FROM crm_contact_phones WHERE phone_key = ? LIMIT 1')
      .bind(normPhone).first();
    if (dbPh?.contact_id) return dbPh.contact_id;
  }
  if (ck && ctx.resolvedContactIdByCanon.has(ck)) {
    return ctx.resolvedContactIdByCanon.get(ck);
  }
  return null;
}

const ALLOWED_RESTORE_PRESENTATION = new Set([
  'presented', 'viewing_scheduled', 'viewed', 'offer_made', 'negotiating', 'rejected', 'selected',
]);
const ALLOWED_RESTORE_OPP_STATUS = new Set([
  'active', 'visit_scheduled', 'viewing_done', 'offer', 'negotiating', 'near_close', 'won', 'lost', 'paused', 'unqualified',
]);
const ACTIVE_RESTORE_OPP_STATUS = new Set([
  'active', 'visit_scheduled', 'viewing_done', 'offer', 'negotiating', 'near_close',
]);

async function restoreSingleActivityChild(db, oppId, convId, act, nowIso) {
  const actId = String(act?.id || '').trim() || crypto.randomUUID();
  const summary = cleanBidiControls(act?.summary || 'سجل نشاط مستعاد').slice(0, 1200) || 'سجل نشاط مستعاد';
  const res = await db.prepare(
    `INSERT OR IGNORE INTO crm_activities(
      id, opportunity_id, activity_type, summary, outcome, next_action, next_followup_at,
      created_at, full_text, source_ref, original_sent_at, external_links_json, conversation_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    actId,
    oppId,
    String(act?.activity_type || 'note'),
    summary,
    String(act?.outcome ?? ''),
    act?.next_action ?? null,
    act?.next_followup_at ?? null,
    act?.created_at || nowIso,
    act?.full_text ?? null,
    String(act?.source_ref ?? 'backup_restore'),
    act?.original_sent_at ?? null,
    String(act?.external_links_json || '[]'),
    act?.conversation_id || convId || null,
  ).run();
  return (res?.meta?.changes ?? res?.changes ?? 0) > 0 ? 1 : 0;
}

async function restoreSinglePropertyChild(db, oppId, prop, nowIso) {
  const listingId = Number(prop?.listing_id);
  if (!Number.isInteger(listingId) || listingId <= 0) return 0;
  const listingExists = await db.prepare('SELECT id FROM listings WHERE id = ? LIMIT 1').bind(listingId).first();
  if (!listingExists?.id) return 0;
  const propId = String(prop?.id || '').trim() || `op:${oppId}:${listingId}`;
  const pres = ALLOWED_RESTORE_PRESENTATION.has(prop?.presentation_status) ? prop.presentation_status : 'presented';
  const res = await db.prepare(
    `INSERT OR IGNORE INTO crm_opportunity_properties(
      id, opportunity_id, listing_id, presentation_status, presented_price,
      viewing_at, viewing_result, objection_reason, notes, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    propId,
    oppId,
    listingId,
    pres,
    prop?.presented_price ?? null,
    prop?.viewing_at ?? null,
    String(prop?.viewing_result ?? ''),
    prop?.objection_reason ?? null,
    String(prop?.notes ?? ''),
    prop?.created_at || nowIso,
  ).run();
  return (res?.meta?.changes ?? res?.changes ?? 0) > 0 ? 1 : 0;
}

async function restoreOpportunityChildren(db, oppId, convId, resolvedContactId, item, nowIso) {
  let actsRestored = 0;
  let propsRestored = 0;
  for (const act of item?.activities || []) {
    actsRestored += await restoreSingleActivityChild(db, oppId, convId, act, nowIso);
  }
  for (const prop of item?.opportunity_properties || []) {
    propsRestored += await restoreSinglePropertyChild(db, oppId, prop, nowIso);
  }
  if (convId) {
    await db.batch([
      db.prepare('UPDATE crm_conversations SET opportunity_id = COALESCE(opportunity_id, ?) WHERE id = ?').bind(oppId, convId),
      db.prepare('UPDATE crm_conversation_insights SET opportunity_id = COALESCE(opportunity_id, ?) WHERE conversation_id = ?').bind(oppId, convId),
      db.prepare("UPDATE crm_smart_alerts SET opportunity_id = COALESCE(opportunity_id, ?) WHERE conversation_id = ? AND status = 'open'").bind(oppId, convId),
    ]);
  }
  if (resolvedContactId && convId) {
    await db.prepare('UPDATE crm_conversations SET contact_id = COALESCE(contact_id, ?) WHERE id = ?')
      .bind(resolvedContactId, convId).run();
  }
  return { actsRestored, propsRestored };
}

function normalizeRestoredOppRecord(item, nowIso) {
  const status = ALLOWED_RESTORE_OPP_STATUS.has(item?.status) ? item.status : 'active';
  const rawNextAction = cleanBidiControls(item?.next_action || '');
  const rawNextAt = item?.next_followup_at || null;
  const rawNoReason = cleanBidiControls(item?.no_followup_reason || '');
  const needsFallback = ACTIVE_RESTORE_OPP_STATUS.has(status) && !(rawNextAction && rawNextAt) && !rawNoReason;
  return {
    track: String(item?.track || 'sale_apt'),
    intent: String(item?.intent || 'buy'),
    source: String(item?.source || 'whatsapp'),
    sourceUrl: String(item?.source_url ?? ''),
    status,
    areaLabel: String(item?.area_label ?? ''),
    budgetMin: item?.budget_min ?? null,
    budgetMax: item?.budget_max ?? null,
    sizeMin: item?.size_min_m2 ?? null,
    sizeMax: item?.size_max_m2 ?? null,
    propertyType: String(item?.property_type ?? ''),
    notes: String(item?.notes ?? ''),
    nextAction: rawNextAction || null,
    nextFollowupAt: rawNextAt,
    noFollowupReason: rawNoReason || (needsFallback ? 'فرصة مستعادة من النسخة الاحتياطية — بانتظار جدولة المتابعة' : null),
    closedAt: item?.closed_at ?? null,
    lossReason: item?.loss_reason ?? null,
    lossNotes: String(item?.loss_notes ?? ''),
    createdAt: item?.created_at || nowIso,
    updatedAt: item?.updated_at || nowIso,
  };
}

function recordRestoreLinkageManifest(manifest, hasConv, hasContact) {
  if (hasConv) manifest.opportunities_linked_to_conversation += 1;
  if (hasContact) manifest.opportunities_linked_to_contact += 1;
  else manifest.opportunities_contactless_independent += 1;
}

async function restoreSingleOpportunityItem(db, item, ctx, manifest) {
  const oppId = String(item?.id || '').trim();
  const leadLabel = cleanBidiControls(item?.lead_label || item?.customer_label || item?.contact_name || '');
  if (!oppId) {
    manifest.unrestored_records.push({ id: null, reason: 'missing_original_opportunity_id' });
    return;
  }
  const ck = canonSyncKey(leadLabel);
  const convRow = await findConversationForRestoredOpp(db, item, ck);
  const resolvedContactId = (await findVerifiedContactForRestoredOpp(db, item, ck, ctx)) || convRow?.contact_id || null;
  const resolvedConvId = convRow?.id || null;

  const existingOpp = await db.prepare('SELECT id, contact_id, conversation_id FROM crm_opportunities WHERE id = ? LIMIT 1')
    .bind(oppId).first();

  if (existingOpp?.id) {
    manifest.opportunities_already_present += 1;
    recordRestoreLinkageManifest(manifest, Boolean(resolvedConvId || existingOpp.conversation_id), Boolean(resolvedContactId || existingOpp.contact_id));
    if (ctx.dryRun) return;
    await db.prepare(
      `UPDATE crm_opportunities
       SET contact_id = COALESCE(contact_id, ?),
           conversation_id = COALESCE(conversation_id, ?),
           lead_label = CASE WHEN COALESCE(lead_label, '') = '' THEN ? ELSE lead_label END
       WHERE id = ?`,
    ).bind(resolvedContactId, resolvedConvId, leadLabel, oppId).run();
    const childCounts = await restoreOpportunityChildren(db, oppId, resolvedConvId, resolvedContactId, item, ctx.nowIso);
    manifest.opportunity_activities_restored += childCounts.actsRestored;
    manifest.opportunity_properties_restored += childCounts.propsRestored;
    return;
  }

  manifest.opportunities_restored += 1;
  recordRestoreLinkageManifest(manifest, Boolean(resolvedConvId), Boolean(resolvedContactId));
  if (ctx.dryRun) return;

  const norm = normalizeRestoredOppRecord(item, ctx.nowIso);
  await db.prepare(
    `INSERT INTO crm_opportunities(
      id, contact_id, conversation_id, lead_label, track, intent, source, source_url, status,
      area_label, budget_min, budget_max, size_min_m2, size_max_m2, property_type,
      notes, next_action, next_followup_at, no_followup_reason,
      closed_at, loss_reason, loss_notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    oppId, resolvedContactId, resolvedConvId, leadLabel, norm.track, norm.intent, norm.source, norm.sourceUrl, norm.status,
    norm.areaLabel, norm.budgetMin, norm.budgetMax, norm.sizeMin, norm.sizeMax, norm.propertyType,
    norm.notes, norm.nextAction, norm.nextFollowupAt, norm.noFollowupReason,
    norm.closedAt, norm.lossReason, norm.lossNotes, norm.createdAt, norm.updatedAt,
  ).run();

  const childCounts = await restoreOpportunityChildren(db, oppId, resolvedConvId, resolvedContactId, item, ctx.nowIso);
  manifest.opportunity_activities_restored += childCounts.actsRestored;
  manifest.opportunity_properties_restored += childCounts.propsRestored;
}

async function restoreOpportunitiesBundle(db, restoreList, ctx) {
  const manifest = {
    opportunities_requested: restoreList.length,
    opportunities_restored: 0,
    opportunities_already_present: 0,
    opportunities_linked_to_conversation: 0,
    opportunities_linked_to_contact: 0,
    opportunities_contactless_independent: 0,
    opportunity_activities_restored: 0,
    opportunity_properties_restored: 0,
    unrestored_records: [],
  };
  for (const item of restoreList) {
    await restoreSingleOpportunityItem(db, item, ctx, manifest);
  }
  return manifest;
}

function buildInMemoryContactIndexes(contactsById) {
  const phonelessContactsByCanon = new Map();
  const allContactsByCanon = new Map();
  const phoneOwnerMap = new Map();
  for (const c of contactsById.values()) {
    for (const p of c.phones || []) {
      phoneOwnerMap.set(p.phone_key, c.id);
    }
    const ck = canonSyncKey(c.name);
    if (!ck) continue;
    const arr = allContactsByCanon.get(ck) || [];
    arr.push(c);
    allContactsByCanon.set(ck, arr);
    if ((c.phones || []).length === 0) {
      const pl = phonelessContactsByCanon.get(ck) || [];
      pl.push(c);
      phonelessContactsByCanon.set(ck, pl);
    }
  }
  return { phonelessContactsByCanon, allContactsByCanon, phoneOwnerMap };
}

export async function runSourceSyncBundle(db, bundle, opts = {}) {
  const normalizedOpts = opts instanceof Date ? { now: opts } : (opts || {});
  const dryRun = Boolean(normalizedOpts.dryRun ?? bundle?.dry_run ?? false);
  const cleanPolicy = String(normalizedOpts.cleanFoundationPolicy ?? bundle?.clean_foundation_policy ?? '').trim();
  const strictCompleteOnly = cleanPolicy === 'strict_complete_contacts_only';
  const backupRef = cleanBidiControls(normalizedOpts.backupVerifiedRef ?? bundle?.backup_verified_ref ?? '');
  if (strictCompleteOnly && !dryRun && !backupRef) {
    return { ok: false, error: 'backup_verified_ref_required_before_foundation_cleanup' };
  }

  const now = normalizedOpts.now || new Date();
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const vcfContacts = Array.isArray(bundle?.vcf_contacts)
    ? bundle.vcf_contacts
    : (Array.isArray(bundle?.contacts) ? bundle.contacts : []);
  const conversations = Array.isArray(bundle?.conversations)
    ? bundle.conversations
    : (Array.isArray(bundle?.unique_chats) ? bundle.unique_chats : []);
  const restoreOpportunities = Array.isArray(bundle?.restore_opportunities)
    ? bundle.restore_opportunities
    : [];

  const existingContactsRes = await db.prepare(
    "SELECT id, name, communication_consent FROM crm_contacts WHERE name NOT LIKE 'TEST ONLY%'",
  ).all();
  const existingPhonesRes = await db.prepare(
    `SELECT p.id, p.contact_id, p.phone_key, p.label, p.is_primary, p.source_type, p.source_ref
     FROM crm_contact_phones p
     JOIN crm_contacts c ON c.id = p.contact_id
     WHERE c.name NOT LIKE 'TEST ONLY%'`,
  ).all();

  const contactsById = new Map();
  for (const c of existingContactsRes?.results || []) {
    contactsById.set(c.id, { ...c, phones: [] });
  }
  for (const p of existingPhonesRes?.results || []) {
    const owner = contactsById.get(p.contact_id);
    if (owner) owner.phones.push(p);
  }
  let { phonelessContactsByCanon, allContactsByCanon, phoneOwnerMap } = buildInMemoryContactIndexes(contactsById);

  const rawPreparedVcf = vcfContacts.map(normalizeVcfSyncItem);
  const effectiveVcf = strictCompleteOnly
    ? rawPreparedVcf.filter(item => item.isComplete)
    : rawPreparedVcf.filter(item => item.fn && item.normPhones.length > 0);

  const diff = {
    source_vcf_contacts_total: vcfContacts.length,
    source_conversations_total: conversations.length,
    clean_foundation_policy: strictCompleteOnly ? 'strict_complete_contacts_only' : 'preserve_all',
    incomplete_or_transient_vcf_skipped: strictCompleteOnly ? (vcfContacts.length - effectiveVcf.length) : 0,
    purged_incomplete_contacts: 0,
    purged_incomplete_opportunities: 0,
    purged_incomplete_conversations: 0,
    incomplete_conversations_skipped: 0,
    existing_contacts_with_valid_phones: 0,
    existing_contacts_phone_backfilled: 0,
    missing_contacts_to_add: 0,
    additional_phones_for_existing: 0,
    conflicting_or_duplicate_phones: 0,
    conversations_matched: 0,
    conversations_unmatched_review: 0,
    chatless_vcf_contacts_retained: 0,
    existing_crm_only_contacts_preserved: 0,
    detached_incomplete_opportunities: 0,
    detached_incomplete_conversations: 0,
    opportunities_restored: 0,
    opportunities_already_present: 0,
  };

  if (strictCompleteOnly) {
    const keptIds = collectKeptFoundationIds(effectiveVcf, {
      contactsById,
      phoneOwnerMap,
      phonelessContactsByCanon,
      allContactsByCanon,
    });
    const purgeSummary = await purgeIncompleteFoundationRecords(db, { contactsById, keptIds, dryRun });
    diff.purged_incomplete_contacts = purgeSummary.purgedContactsCount;
    diff.purged_incomplete_opportunities = purgeSummary.purgedOpportunitiesCount;
    diff.purged_incomplete_conversations = purgeSummary.purgedConversationsCount;
    diff.detached_incomplete_opportunities = purgeSummary.detachedOpportunitiesCount || 0;
    diff.detached_incomplete_conversations = purgeSummary.detachedConversationsCount || 0;
    for (const purgedId of purgeSummary.contactsToPurge) {
      contactsById.delete(purgedId);
    }
    ({ phonelessContactsByCanon, allContactsByCanon, phoneOwnerMap } = buildInMemoryContactIndexes(contactsById));
  }

  const resolvedContactIdByCanon = new Map();
  const touchedCrmContactIds = new Set();
  const matchedVcfCanons = new Set();
  const intelStats = {
    conversations_created: 0,
    conversations_incremental_skipped: 0,
    messages_stored: 0,
    smart_alerts_created: 0,
  };

  const syncCtx = {
    strictCompleteOnly,
    dryRun,
    now,
    nowIso,
    contactsById,
    phoneOwnerMap,
    phonelessContactsByCanon,
    allContactsByCanon,
    resolvedContactIdByCanon,
    touchedCrmContactIds,
    matchedVcfCanons,
    diff,
    intelStats,
  };

  for (const item of effectiveVcf) {
    await syncSingleVcfItem(db, item, syncCtx);
  }

  diff.existing_crm_only_contacts_preserved = [...contactsById.keys()].filter(cid => !touchedCrmContactIds.has(cid)).length;

  for (const conv of conversations) {
    await syncSingleConversationItem(db, conv, syncCtx);
  }

  const restorationManifest = restoreOpportunities.length > 0
    ? await restoreOpportunitiesBundle(db, restoreOpportunities, syncCtx)
    : null;
  if (restorationManifest) {
    diff.opportunities_restored = restorationManifest.opportunities_restored;
    diff.opportunities_already_present = restorationManifest.opportunities_already_present;
  }

  for (const item of effectiveVcf) {
    if (item.ck && resolvedContactIdByCanon.has(item.ck) && !matchedVcfCanons.has(item.ck)) {
      diff.chatless_vcf_contacts_retained += 1;
    }
  }

  let openAlertsByType = {};
  if (!dryRun) {
    const alertCountsRes = await db.prepare(
      "SELECT alert_type, COUNT(*) AS cnt FROM crm_smart_alerts WHERE status='open' GROUP BY alert_type",
    ).all();
    openAlertsByType = Object.fromEntries((alertCountsRes?.results || []).map(r => [r.alert_type, Number(r.cnt || 0)]));
  }

  return {
    ok: true,
    dry_run: dryRun,
    rule_version: CURRENT_RULE_VERSION,
    diff,
    intelligence: intelStats,
    restoration_manifest: restorationManifest,
    open_alerts_by_type: openAlertsByType,
  };
}

export async function buildFollowupWorkspaceData(db, { now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const cairo = getCairoClock(nowDate);
  const todayBounds = getCairoDayBoundsUtc(cairo.dayKey);
  const oppLeadCols = await inspectOpportunityLeadCols(db);
  const nameExpr = oppLeadCols.hasLeadLabel
    ? "COALESCE(c.name, NULLIF(o.lead_label, ''), cv_link.chat_title, 'فرصة قيد استكمال جهة الاتصال')"
    : "COALESCE(c.name, 'عميل')";
  const convIdExpr = oppLeadCols.hasConversationId
    ? 'COALESCE(o.conversation_id, (SELECT id FROM crm_conversations cv WHERE (cv.opportunity_id=o.id OR (c.id IS NOT NULL AND cv.contact_id=c.id)) ORDER BY cv.last_message_at DESC LIMIT 1))'
    : '(SELECT id FROM crm_conversations cv WHERE cv.contact_id=c.id ORDER BY cv.last_message_at DESC LIMIT 1)';
  const convJoin = oppLeadCols.hasConversationId
    ? 'LEFT JOIN crm_conversations cv_link ON cv_link.id = o.conversation_id'
    : '';

  const [oppRowsRes, alertRowsRes, unmatchedCountRow, staleRowsRes] = await Promise.all([
    db.prepare(
      `SELECT o.id, o.contact_id, o.track, o.intent, o.status, o.area_label, o.property_type,
              o.next_action, o.next_followup_at, o.updated_at, ${nameExpr} AS contact_name,
              (SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,
              ${convIdExpr} AS conversation_id
       FROM crm_opportunities o
       LEFT JOIN crm_contacts c ON c.id = o.contact_id
       ${convJoin}
       WHERE o.status IN (${ACTIVE_OPP_SQL}) AND COALESCE(o.track,'sale_apt') != 'transient' AND o.next_followup_at IS NOT NULL
       ORDER BY o.next_followup_at ASC LIMIT 250`,
    ).all(),
    db.prepare(
      `SELECT a.*, o.track AS opportunity_track, o.intent AS opportunity_intent, o.area_label AS opportunity_area,
              o.property_type AS opportunity_property_type,
              (SELECT phone_key FROM crm_contact_phones p WHERE p.contact_id = a.contact_id AND p.is_primary = 1 LIMIT 1) AS phone_key
       FROM crm_smart_alerts a
       LEFT JOIN crm_opportunities o ON o.id = a.opportunity_id
       WHERE a.status = 'open'
       ORDER BY CASE WHEN a.priority='high' THEN 0 ELSE 1 END, COALESCE(a.due_at, a.source_message_at, a.created_at) DESC
       LIMIT 300`,
    ).all(),
    db.prepare("SELECT COUNT(*) AS cnt FROM crm_conversations WHERE match_status IN ('unmatched_review', 'conflict_review')").first(),
    db.prepare(
      `SELECT o.id, o.contact_id, o.track, o.intent, o.status, o.area_label, o.property_type, o.updated_at,
              ${nameExpr} AS contact_name,
              (SELECT phone_key FROM crm_contact_phones WHERE contact_id=c.id AND is_primary=1 LIMIT 1) AS phone_key,
              ${convIdExpr} AS conversation_id,
              (SELECT MAX(ac.created_at) FROM crm_activities ac WHERE ac.opportunity_id=o.id) AS last_activity
       FROM crm_opportunities o
       LEFT JOIN crm_contacts c ON c.id=o.contact_id
       ${convJoin}
       WHERE o.status IN (${ACTIVE_OPP_SQL}) AND COALESCE(o.track,'sale_apt') != 'transient'
         AND o.next_followup_at IS NULL
         AND COALESCE((SELECT MAX(ac.created_at) FROM crm_activities ac WHERE ac.opportunity_id=o.id), o.updated_at) < ?
       ORDER BY o.updated_at ASC LIMIT 80`,
    ).bind(new Date(nowMs - 7 * 86_400_000).toISOString()).all(),
  ]);

  const today = [];
  const overdue = [];
  const upcoming = [];
  const waitingReply = [];
  const stalledIntervention = [];
  const newChatAlerts = [];

  for (const opp of oppRowsRes?.results || []) {
    const dueMs = parseFollowupInstantMs(opp.next_followup_at);
    const dueDayCairo = toCairoDayKey(opp.next_followup_at);
    const entry = {
      item_kind: 'opportunity_schedule',
      opportunity_id: opp.id,
      contact_id: opp.contact_id,
      conversation_id: opp.conversation_id || null,
      customer_name: opp.contact_name || 'عميل',
      phone_key: opp.phone_key || '',
      track: opp.track,
      intent: opp.intent,
      area_label: opp.area_label,
      property_type: opp.property_type,
      due_at: opp.next_followup_at,
      alert_reason: opp.next_action || 'متابعة مجدولة',
      suggested_action: opp.next_action || 'التواصل مع العميل وتسجيل النتيجة',
      confidence: 1,
    };
    if (dueMs !== null && dueMs < nowMs) {
      overdue.push(entry);
    } else if (dueDayCairo === cairo.dayKey) {
      today.push(entry);
    } else if (dueMs !== null && dueMs > Date.parse(todayBounds.endUtcIso)) {
      upcoming.push(entry);
    }
  }

  for (const alert of alertRowsRes?.results || []) {
    const dueMs = alert.due_at ? parseFollowupInstantMs(alert.due_at) : null;
    const dueDayCairo = alert.due_at ? toCairoDayKey(alert.due_at) : '';
    const item = {
      item_kind: 'smart_alert',
      alert_id: alert.id,
      alert_type: alert.alert_type,
      priority: alert.priority,
      status: alert.status,
      contact_id: alert.contact_id,
      opportunity_id: alert.opportunity_id,
      conversation_id: alert.conversation_id,
      message_id: alert.message_id,
      customer_name: alert.customer_name,
      phone_key: alert.phone_key || '',
      track: alert.opportunity_track || 'sale_apt',
      intent: alert.opportunity_intent || '',
      area_label: alert.opportunity_area || '',
      property_type: alert.opportunity_property_type || '',
      alert_reason: alert.alert_reason,
      source_message_at: alert.source_message_at,
      excerpt: alert.excerpt,
      suggested_action: alert.suggested_action,
      confidence: alert.confidence,
      due_at: alert.due_at,
      due_precision: alert.due_precision,
      date_origin: alert.date_origin,
      rule_version: alert.rule_version,
    };

    if (alert.alert_type === 'unanswered_question' || alert.alert_type === 'viewing_requested_unlogged') {
      waitingReply.push(item);
    }
    if (alert.alert_type === 'high_interest_stalled' || alert.alert_type === 'offer_sent_no_followup') {
      stalledIntervention.push(item);
    }
    if (alert.alert_type === 'followup_overdue' || (dueMs !== null && dueMs < nowMs && alert.alert_type === 'followup_approaching')) {
      overdue.push(item);
    } else if (alert.alert_type === 'followup_approaching' || (dueDayCairo && dueDayCairo === cairo.dayKey)) {
      today.push(item);
    } else if (dueMs !== null && dueMs > Date.parse(todayBounds.endUtcIso)) {
      upcoming.push(item);
    }
    if (alert.alert_type === 'request_specs_changed' || alert.alert_type === 'needs_followup' || alert.conversation_id) {
      newChatAlerts.push(item);
    }
  }

  for (const st of staleRowsRes?.results || []) {
    stalledIntervention.push({
      item_kind: 'stale_opportunity',
      opportunity_id: st.id,
      contact_id: st.contact_id,
      conversation_id: st.conversation_id || null,
      customer_name: st.contact_name || 'عميل',
      phone_key: st.phone_key || '',
      track: st.track,
      intent: st.intent,
      area_label: st.area_label,
      property_type: st.property_type,
      source_message_at: st.last_activity || st.updated_at,
      alert_reason: 'فرصة نشطة بدون تحديث أو متابعة منذ أكثر من 7 أيام',
      suggested_action: 'التواصل لتحديث حالة الفرصة أو جدولتها أو نقلها للأرشيف',
      confidence: 0.9,
    });
  }

  const unmatchedRowsRes = await db.prepare(
    `SELECT cv.id, cv.chat_title, cv.peer_sender_name, cv.opportunity_id, cv.source_ref, cv.review_reason,
            length(cv.raw_text) AS char_length, cv.message_count, cv.last_message_at,
            o.track AS opportunity_track, o.status AS opportunity_status
     FROM crm_conversations cv
     LEFT JOIN crm_opportunities o ON o.id = cv.opportunity_id
     WHERE cv.match_status IN ('unmatched_review', 'conflict_review')
     ORDER BY COALESCE(cv.last_message_at, cv.updated_at) DESC
     LIMIT 150`,
  ).all();
  const unmatchedReview = unmatchedRowsRes?.results || [];

  return {
    timezone: 'Africa/Cairo',
    cairo_day: cairo.dayKey,
    generated_at: nowIso,
    counts: {
      today: today.length,
      overdue: overdue.length,
      upcoming: upcoming.length,
      waiting_reply: waitingReply.length,
      stalled_intervention: stalledIntervention.length,
      needs_intervention: stalledIntervention.length,
      new_chat_alerts: newChatAlerts.length,
      unmatched_review_chats: Number(unmatchedCountRow?.cnt || unmatchedReview.length),
      unmatched_review: unmatchedReview.length,
    },
    today,
    overdue,
    upcoming,
    waiting_reply: waitingReply,
    stalled_intervention: stalledIntervention,
    new_chat_alerts: newChatAlerts,
    unmatched_review: unmatchedReview,
    queues: {
      today,
      overdue,
      upcoming,
      waiting_reply: waitingReply,
      needs_intervention: stalledIntervention,
      stalled_intervention: stalledIntervention,
      new_chat_alerts: newChatAlerts,
    },
  };
}

export async function refreshTimeBasedSmartAlerts(db, now = new Date()) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  // Re-open expired snoozed alerts when their snoozed_until has arrived
  await db.prepare(
    `UPDATE crm_smart_alerts
     SET status = 'open', snoozed_until = NULL, updated_at = ?
     WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND datetime(snoozed_until) <= datetime(?)`,
  ).bind(nowIso, nowIso).run();

  // Promote approaching alerts whose due_at has passed into followup_overdue (unless an overdue row already exists for same dedupe tuple)
  const expiredApproaching = await db.prepare(
    `SELECT id, dedupe_conversation_key, dedupe_message_key, dedupe_contact_key, alert_reason
     FROM crm_smart_alerts
     WHERE status = 'open' AND alert_type = 'followup_approaching'
       AND due_at IS NOT NULL AND datetime(due_at) < datetime(?)
     LIMIT 50`,
  ).bind(nowIso).all();

  for (const row of expiredApproaching?.results || []) {
    const existingOverdue = await db.prepare(
      `SELECT id FROM crm_smart_alerts
       WHERE dedupe_conversation_key=? AND dedupe_message_key=? AND dedupe_contact_key=? AND alert_type='followup_overdue'`,
    ).bind(row.dedupe_conversation_key, row.dedupe_message_key, row.dedupe_contact_key).first();

    if (existingOverdue) {
      await db.prepare(
        "UPDATE crm_smart_alerts SET status='completed', resolved_at=?, resolution_note='promoted_to_overdue', updated_at=? WHERE id=?",
      ).bind(nowIso, nowIso, row.id).run();
    } else {
      const updatedReason = String(row.alert_reason || '').replace('موعد متابعة يقترب', 'تأخر موعد المتابعة المتفق عليه');
      await db.prepare(
        "UPDATE crm_smart_alerts SET alert_type='followup_overdue', priority='high', alert_reason=?, updated_at=? WHERE id=?",
      ).bind(updatedReason || 'تأخر موعد المتابعة المتفق عليه', nowIso, row.id).run();
    }
  }
}

export async function listConversationsData(db, url) {
  const statusFilter = (url.searchParams.get('match_status') || '').trim();
  const contactId = (url.searchParams.get('contact_id') || '').trim();
  const q = cleanBidiControls(url.searchParams.get('q') || '').slice(0, 80);
  const oppLeadCols = await inspectOpportunityLeadCols(db);

  const clauses = ['1=1'];
  const params = [];
  if (statusFilter === 'matched') {
    clauses.push("cv.match_status IN ('matched', 'resolved_manual')");
  } else if (statusFilter === 'unmatched_review') {
    clauses.push("cv.match_status IN ('unmatched_review', 'conflict_review')");
  } else if (statusFilter === 'resolved_manual') {
    clauses.push("cv.match_status = 'resolved_manual'");
  }
  if (contactId) {
    clauses.push('cv.contact_id = ?');
    params.push(contactId);
  }
  if (q) {
    const like = `%${q}%`;
    if (oppLeadCols.hasLeadLabel) {
      clauses.push('(cv.chat_title LIKE ? OR cv.peer_sender_name LIKE ? OR c.name LIKE ? OR o.lead_label LIKE ? OR cv.raw_text LIKE ?)');
      params.push(like, like, like, like, like);
    } else {
      clauses.push('(cv.chat_title LIKE ? OR cv.peer_sender_name LIKE ? OR c.name LIKE ? OR cv.raw_text LIKE ?)');
      params.push(like, like, like, like);
    }
  }

  const rowsRes = await db.prepare(
    `SELECT cv.id, cv.conversation_uid, cv.contact_id, cv.opportunity_id, cv.source_type, cv.source_ref,
            cv.chat_title, cv.peer_sender_name, cv.match_status, cv.match_method, cv.review_reason,
            length(cv.raw_text) AS char_length, cv.message_count, cv.first_message_at, cv.last_message_at,
            cv.analyzed_at, cv.analyzed_rule_version AS rule_version, c.name AS contact_name,
            o.track AS opportunity_track, o.status AS opportunity_status,
            (SELECT phone_key FROM crm_contact_phones p WHERE p.contact_id = cv.contact_id AND p.is_primary = 1 LIMIT 1) AS phone_key,
            (SELECT COUNT(*) FROM crm_smart_alerts a WHERE a.conversation_id = cv.id AND a.status = 'open') AS open_alerts_count
     FROM crm_conversations cv
     LEFT JOIN crm_contacts c ON c.id = cv.contact_id
     LEFT JOIN crm_opportunities o ON o.id = cv.opportunity_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY COALESCE(cv.last_message_at, cv.updated_at) DESC
     LIMIT 150`,
  ).bind(...params).all();

  return { conversations: rowsRes?.results || [] };
}

export async function getConversationDetailData(db, conversationId) {
  const conv = await db.prepare(
    `SELECT cv.*, length(cv.raw_text) AS char_length, cv.analyzed_rule_version AS rule_version, c.name AS contact_name,
            (SELECT phone_key FROM crm_contact_phones p WHERE p.contact_id = cv.contact_id AND p.is_primary = 1 LIMIT 1) AS phone_key
     FROM crm_conversations cv
     LEFT JOIN crm_contacts c ON c.id = cv.contact_id
     WHERE cv.id = ?`,
  ).bind(conversationId).first();
  if (!conv) return null;

  const [msgsRes, insightsRow, alertsRes] = await Promise.all([
    db.prepare(
      `SELECT id, seq_no, message_uid, sent_at, raw_timestamp_text AS raw_timestamp, sender_role, sender_label,
              body_text, length(body_text) AS char_length, links_json
       FROM crm_conversation_messages
       WHERE conversation_id = ?
       ORDER BY seq_no ASC`,
    ).bind(conversationId).all(),
    db.prepare('SELECT * FROM crm_conversation_insights WHERE conversation_id = ?').bind(conversationId).first(),
    db.prepare(
      `SELECT * FROM crm_smart_alerts
       WHERE conversation_id = ?
       ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, created_at DESC`,
    ).bind(conversationId).all(),
  ]);

  const messages = (msgsRes?.results || []).map(m => {
    let links = [];
    try { links = JSON.parse(m.links_json || '[]'); } catch { links = []; }
    return { ...m, links };
  });

  let parseWarnings = [];
  try { parseWarnings = JSON.parse(conv.parse_warnings_json || '[]'); } catch { parseWarnings = []; }

  let parsedReq = null;
  if (insightsRow?.last_confirmed_request_json) {
    try { parsedReq = JSON.parse(insightsRow.last_confirmed_request_json); } catch { parsedReq = null; }
  }

  return {
    conversation: { ...conv, parse_warnings: parseWarnings },
    messages,
    insights: insightsRow ? {
      ...insightsRow,
      inferred_intent: parsedReq?.intent || null,
      inferred_area: parsedReq?.area_label || null,
      inferred_property_type: parsedReq?.property_type || null,
      inferred_budget: parsedReq?.budget_max || parsedReq?.budget_min || null,
      inferred_size_m2: parsedReq?.size_max_m2 || parsedReq?.size_min_m2 || null,
    } : null,
    alerts: alertsRes?.results || [],
  };
}

export async function importConversationPayload(db, body, now = new Date()) {
  const rawText = typeof body?.raw_text === 'string' ? body.raw_text : '';
  if (!rawText.trim()) return { error: 'raw_text_required', status: 400 };
  if (rawText.length > 500_000) return { error: 'conversation_too_large', status: 400 };

  const chatTitle = cleanBidiControls(body?.chat_title || body?.title || 'محادثة واتساب مستوردة').slice(0, 140);
  const sourceRef = cleanBidiControls(body?.source_ref || 'manual_whatsapp_import').slice(0, 180);
  const explicitContactId = typeof body?.contact_id === 'string' && body.contact_id.trim() ? body.contact_id.trim() : null;
  const explicitOppId = typeof body?.opportunity_id === 'string' && body.opportunity_id.trim() ? body.opportunity_id.trim() : null;

  let resolvedContactId = null;
  let matchMethod = 'none';
  if (explicitContactId) {
    const c = await db.prepare('SELECT id FROM crm_contacts WHERE id = ?').bind(explicitContactId).first();
    if (!c) return { error: 'contact_not_found', status: 404 };
    resolvedContactId = c.id;
    matchMethod = 'manual_operator';
  } else if (body?.participant_phone) {
    const pk = normalizeInternationalPhone(body.participant_phone);
    if (pk) {
      const ph = await db.prepare('SELECT contact_id FROM crm_contact_phones WHERE phone_key = ?').bind(pk).first();
      if (ph) {
        resolvedContactId = ph.contact_id;
        matchMethod = 'verified_participant_phone';
      }
    }
  }

  const conversationUid = cleanBidiControls(body?.conversation_uid || `import:${canonSyncKey(chatTitle) || crypto.randomUUID()}`);
  const matchStatus = resolvedContactId ? 'matched' : 'unmatched_review';
  const reviewReason = resolvedContactId
    ? ''
    : 'استيراد محادثة بدون عميل محدد — وُضعت في قائمة المراجعة اليدوية دون إنشاء عميل تلقائي';

  const result = await upsertConversationAndAnalyze(db, {
    conversationUid,
    contactId: resolvedContactId,
    opportunityId: explicitOppId,
    sourceType: cleanBidiControls(body?.source_type || 'whatsapp_import').slice(0, 40),
    sourceRef,
    chatTitle,
    rawText,
    matchStatus,
    matchMethod,
    reviewReason,
    now,
  });

  return { ok: true, status: 201, ...result, match_status: matchStatus, contact_id: resolvedContactId };
}

async function attachVerifiedPhoneToContact(db, contactId, rawPhone, label, nowIso) {
  const norm = normalizeInternationalPhone(rawPhone);
  if (!norm) return { error: 'invalid_phone', status: 400 };
  const existingPhone = await db.prepare('SELECT id, contact_id FROM crm_contact_phones WHERE phone_key = ? LIMIT 1')
    .bind(norm).first();
  if (existingPhone && existingPhone.contact_id !== contactId) {
    return { error: 'phone_already_assigned_to_other_contact', status: 409, owner_contact_id: existingPhone.contact_id };
  }
  if (!existingPhone) {
    const cntRow = await db.prepare('SELECT COUNT(*) AS cnt FROM crm_contact_phones WHERE contact_id = ?')
      .bind(contactId).first();
    const isPrimary = Number(cntRow?.cnt || 0) === 0 ? 1 : 0;
    await db.batch([
      db.prepare(
        `INSERT INTO crm_contact_phones(id, contact_id, phone_key, raw_input, label, is_primary, source_type, source_ref, created_at)
         VALUES (?,?,?,?,?,?,'manual_operator','manual_review_link',?)`,
      ).bind(crypto.randomUUID(), contactId, norm, cleanBidiControls(rawPhone), label, isPrimary, nowIso),
      db.prepare(
        "INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor,created_at) VALUES(?,?,'phone_added','phone_key',NULL,?,'manual_review_link','broker',?)",
      ).bind(crypto.randomUUID(), contactId, norm, nowIso),
    ]);
  }
  return { ok: true, phone_key: norm };
}

async function resolveTargetContactForManualLink(db, conv, body, nowIso) {
  const explicitId = typeof body?.contact_id === 'string' ? body.contact_id.trim() : '';
  const createPayload = body?.create_contact && typeof body.create_contact === 'object' ? body.create_contact : null;
  const inlinePhone = cleanBidiControls(createPayload?.phone || body?.verified_phone || body?.phone || '');
  const inlineLabel = cleanBidiControls(createPayload?.label || body?.phone_label || 'أساسي (موثق)').slice(0, 40);

  if (explicitId) {
    const contact = await db.prepare('SELECT id, name FROM crm_contacts WHERE id = ?').bind(explicitId).first();
    if (!contact) return { error: 'contact_not_found', status: 404 };
    if (inlinePhone) {
      const phRes = await attachVerifiedPhoneToContact(db, contact.id, inlinePhone, inlineLabel, nowIso);
      if (phRes.error) return phRes;
    }
    const phCnt = await db.prepare('SELECT COUNT(*) AS cnt FROM crm_contact_phones WHERE contact_id = ?')
      .bind(contact.id).first();
    if (Number(phCnt?.cnt || 0) === 0 && !body?.allow_incomplete_contact) {
      return { error: 'verified_phone_required_before_linking', status: 400 };
    }
    return { contact };
  }

  if (!inlinePhone) return { error: 'contact_id_or_verified_phone_required', status: 400 };
  const norm = normalizeInternationalPhone(inlinePhone);
  if (!norm) return { error: 'invalid_phone', status: 400 };
  const existingOwner = await db.prepare(
    'SELECT c.id, c.name FROM crm_contact_phones p JOIN crm_contacts c ON c.id = p.contact_id WHERE p.phone_key = ? LIMIT 1',
  ).bind(norm).first();
  if (existingOwner?.id) return { contact: existingOwner };

  const newName = cleanBidiControls(createPayload?.name || body?.contact_name || conv.chat_title || 'عميل موثق').slice(0, 120);
  if (newName.length < 2) return { error: 'invalid_name', status: 400 };
  const newContactId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      "INSERT INTO crm_contacts(id, name, communication_consent, created_at, updated_at) VALUES (?, ?, 'unknown', ?, ?)",
    ).bind(newContactId, newName, nowIso, nowIso),
    db.prepare(
      `INSERT INTO crm_contact_phones(id, contact_id, phone_key, raw_input, label, is_primary, source_type, source_ref, created_at)
       VALUES (?,?,?,?,?,1,'manual_operator','manual_review_link',?)`,
    ).bind(crypto.randomUUID(), newContactId, norm, inlinePhone, inlineLabel, nowIso),
    db.prepare(
      "INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor,created_at) VALUES(?,?,'contact_created','phone_key',NULL,?,'manual_review_link','broker',?)",
    ).bind(crypto.randomUUID(), newContactId, norm, nowIso),
  ]);
  return { contact: { id: newContactId, name: newName } };
}

export async function linkConversationToContactPayload(db, conversationId, body, now = new Date()) {
  const conv = await db.prepare('SELECT * FROM crm_conversations WHERE id = ?').bind(conversationId).first();
  if (!conv) return { error: 'conversation_not_found', status: 404 };

  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const target = await resolveTargetContactForManualLink(db, conv, body, nowIso);
  if (target.error) return target;
  const { contact } = target;

  let oppId = typeof body?.opportunity_id === 'string' && body.opportunity_id.trim()
    ? body.opportunity_id.trim()
    : (conv.opportunity_id || null);
  const oppLeadCols = await inspectOpportunityLeadCols(db);
  if (!oppId && oppLeadCols.hasConversationId) {
    const byConv = await db.prepare('SELECT id FROM crm_opportunities WHERE conversation_id = ? LIMIT 1')
      .bind(conv.id).first();
    if (byConv?.id) oppId = byConv.id;
  }

  if (oppId) {
    await db.prepare(
      'UPDATE crm_opportunities SET contact_id = COALESCE(contact_id, ?), updated_at = ? WHERE id = ?',
    ).bind(contact.id, nowIso, oppId).run();
  }

  const result = await upsertConversationAndAnalyze(db, {
    conversationUid: conv.conversation_uid,
    contactId: contact.id,
    opportunityId: oppId || null,
    sourceType: conv.source_type,
    sourceRef: conv.source_ref,
    chatTitle: conv.chat_title,
    rawText: conv.raw_text,
    matchStatus: 'resolved_manual',
    matchMethod: 'manual_review_link',
    reviewReason: '',
    forceAnalyze: true,
    now,
  });

  try {
    await db.prepare(
      "INSERT INTO crm_contact_audit_log(id,contact_id,action_type,field_name,old_value,new_value,source_ref,actor,created_at) VALUES(?,?,'conversation_linked','conversation_id',?,?,?,'broker',?)",
    ).bind(crypto.randomUUID(), contact.id, conv.contact_id || null, conv.id, 'manual_review_link', nowIso).run();
  } catch {
    // Pre-0006 audit action check constraint fallback.
  }

  return {
    ok: true,
    status: 200,
    contact_id: contact.id,
    contact_name: contact.name,
    opportunity_id: result.opportunity_id || oppId || null,
    ...result,
  };
}

export async function resolveSmartAlertPayload(db, alertId, body, now = new Date()) {
  const alert = await db.prepare('SELECT * FROM crm_smart_alerts WHERE id = ?').bind(alertId).first();
  if (!alert) return { error: 'alert_not_found', status: 404 };

  const nextStatus = body?.status || 'completed';
  if (!['completed', 'dismissed', 'snoozed', 'open'].includes(nextStatus)) {
    return { error: 'invalid_alert_status', status: 400 };
  }

  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const note = cleanBidiControls(body?.resolution_note || body?.outcome_summary || '').slice(0, 500);
  let snoozedUntil = null;
  if (nextStatus === 'snoozed') {
    const parsedSnooze = parseFollowupInstantMs(body?.snoozed_until || '');
    snoozedUntil = parsedSnooze !== null
      ? new Date(parsedSnooze).toISOString()
      : new Date(Date.parse(nowIso) + 24 * 3600_000).toISOString();
  }

  const resolvedAt = nextStatus === 'completed' || nextStatus === 'dismissed' ? nowIso : null;
  const targetOppId = (typeof body?.opportunity_id === 'string' && body.opportunity_id.trim()) || alert.opportunity_id || null;
  let activityId = null;
  const stmts = [];

  if (body?.log_activity && targetOppId) {
    const oppRow = await db.prepare('SELECT id FROM crm_opportunities WHERE id = ?').bind(targetOppId).first();
    if (oppRow) {
      activityId = crypto.randomUUID();
      const actType = ['call', 'missed_call', 'whatsapp_note', 'visit', 'offer', 'objection', 'note'].includes(body?.activity_type)
        ? body.activity_type
        : 'whatsapp_note';
      const fullText = cleanBidiControls(body?.outcome_summary || note || `تمت معالجة تنبيه المتابعة الذكية: ${alert.alert_reason}`);
      const summary = fullText.slice(0, 1200);
      stmts.push(
        db.prepare(
          `INSERT INTO crm_activities(id, opportunity_id, activity_type, summary, full_text, source_ref, conversation_id, created_at)
           VALUES(?, ?, ?, ?, ?, 'smart_alert_resolution', ?, ?)`,
        ).bind(activityId, oppRow.id, actType, summary, fullText, alert.conversation_id || null, nowIso),
      );
      if (body?.next_followup_at !== undefined) {
        const nextFollowupMs = body.next_followup_at ? parseFollowupInstantMs(body.next_followup_at) : null;
        const nextFollowupIso = nextFollowupMs !== null ? new Date(nextFollowupMs).toISOString() : null;
        stmts.push(
          db.prepare(
            `UPDATE crm_opportunities
             SET next_followup_at = ?, next_action = COALESCE(?, next_action), updated_at = ?
             WHERE id = ?`,
          ).bind(nextFollowupIso, cleanBidiControls(body?.next_action || '').slice(0, 220) || null, nowIso, oppRow.id),
        );
      } else {
        stmts.push(db.prepare('UPDATE crm_opportunities SET updated_at = ? WHERE id = ?').bind(nowIso, oppRow.id));
      }
    }
  }

  stmts.push(
    db.prepare(
      `UPDATE crm_smart_alerts
       SET status = ?, snoozed_until = ?, resolved_at = ?,
           resolution_note = CASE WHEN ? != '' THEN ? ELSE resolution_note END,
           resolved_by_activity_id = COALESCE(?, resolved_by_activity_id),
           updated_at = ?
       WHERE id = ?`,
    ).bind(nextStatus, snoozedUntil, resolvedAt, note, note, activityId, nowIso, alertId),
  );

  await db.batch(stmts);
  return {
    ok: true,
    status: 200,
    alert_id: alertId,
    new_status: nextStatus,
    resolved_at: resolvedAt,
    snoozed_until: snoozedUntil,
    activity_id: activityId,
  };
}

