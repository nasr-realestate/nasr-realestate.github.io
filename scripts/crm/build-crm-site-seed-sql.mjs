#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BATCH_1_APARTMENT_SLUGS = [
  'apartment-sale-hassan-maamoun-220m-rented-2027',
  'apartment-sale-moussa-el-kazem-nasr-city-280m',
  'apartment-sale-ismail-wahby-9th-district-145m',
  'apartment-sale-bashar-ibn-burd-makram-ebeid-190m',
  'apartment-sale-hassan-hassanein-heikal-200m',
];

function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : 'NULL';
}

function deterministicListingId(slug, usedIds) {
  let salt = 0;
  while (salt < 100) {
    const hex = createHash('sha256').update(`${slug}:${salt}`).digest('hex');
    const candidate = 10_000_000 + (Number.parseInt(hex.slice(0, 7), 16) % 800_000_000);
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
    salt += 1;
  }
  throw new Error(`Unable to derive unique listing id for ${slug}`);
}

function deterministicEntityId(prefix, slug) {
  const digest = createHash('sha256').update(`${prefix}:${slug}`).digest('base64url').slice(0, 22);
  return `${prefix}_${digest}`;
}

export function generateCrmSiteSeedSql(feedInput) {
  const feedItems = Array.isArray(feedInput)
    ? feedInput
    : (feedInput?.properties || feedInput?.items || []);
  const cityItems = feedItems.filter(item => item && item.scope === 'city' && item.slug);
  const usedIds = new Set([900001, 900002]);
  const slugToListingId = new Map();
  const lines = [
    '-- Auto-generated from public ai-feed.json (zero PII). Safe & idempotent for nasr-crm-test-db.',
    "INSERT OR IGNORE INTO sources(id, name) VALUES (9009, 'TEST ONLY synthetic CRM source');",
    "INSERT OR IGNORE INTO areas(id, name_ar) VALUES (90001, 'مدينة نصر');",
  ];

  for (const item of cityItems) {
    const listingId = deterministicListingId(item.slug, usedIds);
    slugToListingId.set(item.slug, listingId);
    const relUrl = `/properties/${item.slug}/`;
    const propType = item.propertyType || 'apartment';
    const txType = item.transaction === 'rent' ? 'rent' : 'sale';
    const observedAt = typeof item.date === 'string' && item.date ? item.date : '2026-10-28T00:00:00.000Z';
    lines.push(
      `INSERT INTO listings(id, source_id, external_id, url, title, property_type, transaction_type, area_id, area_m2, price, bedrooms, bathrooms, finishing, observed_at) VALUES (${listingId}, 9009, ${sqlText(item.slug)}, ${sqlText(relUrl)}, ${sqlText(item.title || item.slug)}, ${sqlText(propType)}, ${sqlText(txType)}, 90001, ${sqlNumber(item.areaNumeric)}, ${sqlNumber(item.priceNumeric)}, ${sqlNumber(item.roomsNumeric)}, ${sqlNumber(item.bathsNumeric)}, ${sqlText(item.finishing || '')}, ${sqlText(observedAt)}) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, url=excluded.url, title=excluded.title, property_type=excluded.property_type, transaction_type=excluded.transaction_type, area_m2=excluded.area_m2, price=excluded.price, bedrooms=excluded.bedrooms, bathrooms=excluded.bathrooms, finishing=excluded.finishing, observed_at=excluded.observed_at;`,
    );
  }

  BATCH_1_APARTMENT_SLUGS.forEach((slug, idx) => {
    const item = cityItems.find(entry => entry.slug === slug);
    const listingId = slugToListingId.get(slug);
    if (!item || !listingId) {
      throw new Error(`Batch 1 apartment slug missing in city scope: ${slug}`);
    }
    const subKey = `seed-owner-slot:${slug}`;
    const contactId = deterministicEntityId('cnt', slug);
    const oppId = deterministicEntityId('opp', slug);
    const actId = deterministicEntityId('act', slug);
    const linkId = deterministicEntityId('prp', slug);
    const relUrl = `/properties/${slug}/`;
    const zoneLabel = (item.zone || item.location || 'مدينة نصر').slice(0, 95);
    const shortArea = item.areaNumeric ? `${item.areaNumeric}م` : '';
    const ownerPlaceholder = `مالك #${idx + 1} — شقة ${shortArea} ${zoneLabel} (بانتظار الرقم)`.replace(/\s+/g, ' ').trim().slice(0, 98);
    const priceSql = sqlNumber(item.priceNumeric);
    const areaSql = sqlNumber(item.areaNumeric);
    const noteText = `وحدة منشورة بالموقع (${item.title}). تم تجهيز سجل المالك وفرصة البيع بانتظار استكمال الاسم ورقم الهاتف الحقيقي من بطاقة العميل.`;
    const guard = `NOT EXISTS (SELECT 1 FROM crm_idempotency_receipts WHERE submission_key = ${sqlText(subKey)})`;

    lines.push(
      `INSERT INTO crm_contacts(id, name, communication_consent) SELECT ${sqlText(contactId)}, ${sqlText(ownerPlaceholder)}, 'request_only' WHERE ${guard};`,
      `INSERT INTO crm_opportunities(id, contact_id, intent, source, source_url, status, area_label, budget_min, budget_max, size_min_m2, size_max_m2, property_type, notes, next_action, next_followup_at, no_followup_reason) SELECT ${sqlText(oppId)}, ${sqlText(contactId)}, 'sell', 'website', ${sqlText(relUrl)}, 'active', ${sqlText(zoneLabel)}, ${priceSql}, ${priceSql}, ${areaSql}, ${areaSql}, 'شقة', ${sqlText(noteText)}, NULL, NULL, 'وحدة منشورة بالموقع — بانتظار استكمال رقم المالك' WHERE ${guard};`,
      `INSERT INTO crm_opportunity_properties(id, opportunity_id, listing_id, presentation_status, presented_price, notes) SELECT ${sqlText(linkId)}, ${sqlText(oppId)}, ${listingId}, 'selected', ${priceSql}, 'ربط تلقائي بالوحدة المنشورة على الموقع' WHERE ${guard};`,
      `INSERT INTO crm_activities(id, opportunity_id, activity_type, summary, outcome) SELECT ${sqlText(actId)}, ${sqlText(oppId)}, 'note', 'إنشاء سجل مالك مبدئي مرتبط بالوحدة المنشورة بانتظار استكمال رقم الهاتف', '' WHERE ${guard};`,
      `INSERT INTO crm_idempotency_receipts(submission_key, resource_type, resource_id) SELECT ${sqlText(subKey)}, 'opportunity', ${sqlText(oppId)} WHERE ${guard};`,
    );
  });

  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const feedPath = resolve(process.argv[2] || 'ai-feed.json');
  const outPath = process.argv[3] ? resolve(process.argv[3]) : null;
  const parsed = JSON.parse(readFileSync(feedPath, 'utf8'));
  const items = parsed.items || parsed.properties || parsed;
  const sql = generateCrmSiteSeedSql(items);
  if (outPath) {
    writeFileSync(outPath, sql, 'utf8');
  } else {
    process.stdout.write(sql);
  }
}
