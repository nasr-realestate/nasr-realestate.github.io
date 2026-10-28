#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

export function generateCrmSiteSeedSql(feedInput) {
  const feedItems = Array.isArray(feedInput)
    ? feedInput
    : (feedInput?.properties || feedInput?.items || []);
  const cityItems = feedItems.filter(item => item && item.scope === 'city' && item.slug);
  const usedIds = new Set([900001, 900002]);
  const lines = [
    '-- Auto-generated from public ai-feed.json (zero PII). Syncs Nasr City catalog listings only.',
    "INSERT OR IGNORE INTO sources(id, name) VALUES (9009, 'TEST ONLY synthetic CRM source');",
    "INSERT OR IGNORE INTO areas(id, name_ar) VALUES (90001, 'مدينة نصر');",
  ];

  for (const item of cityItems) {
    const listingId = deterministicListingId(item.slug, usedIds);
    const relUrl = `/properties/${item.slug}/`;
    const propType = item.propertyType || 'apartment';
    const txType = item.transaction === 'rent' ? 'rent' : 'sale';
    const observedAt = typeof item.date === 'string' && item.date ? item.date : '2026-10-28T00:00:00.000Z';
    lines.push(
      `INSERT INTO listings(id, source_id, external_id, url, title, property_type, transaction_type, area_id, area_m2, price, bedrooms, bathrooms, finishing, observed_at) VALUES (${listingId}, 9009, ${sqlText(item.slug)}, ${sqlText(relUrl)}, ${sqlText(item.title || item.slug)}, ${sqlText(propType)}, ${sqlText(txType)}, 90001, ${sqlNumber(item.areaNumeric)}, ${sqlNumber(item.priceNumeric)}, ${sqlNumber(item.roomsNumeric)}, ${sqlNumber(item.bathsNumeric)}, ${sqlText(item.finishing || '')}, ${sqlText(observedAt)}) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, url=excluded.url, title=excluded.title, property_type=excluded.property_type, transaction_type=excluded.transaction_type, area_m2=excluded.area_m2, price=excluded.price, bedrooms=excluded.bedrooms, bathrooms=excluded.bathrooms, finishing=excluded.finishing, observed_at=excluded.observed_at;`,
    );
  }

  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const feedPath = resolve(process.argv[2] || 'ai-feed.json');
  const outPath = process.argv[3] ? resolve(process.argv[3]) : null;
  const parsed = JSON.parse(readFileSync(feedPath, 'utf8'));
  const sql = generateCrmSiteSeedSql(parsed);
  if (outPath) {
    writeFileSync(outPath, sql, 'utf8');
  } else {
    process.stdout.write(sql);
  }
}
