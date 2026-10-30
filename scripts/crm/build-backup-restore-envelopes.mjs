// Builds RSA-OAEP-4096 + AES-256-GCM sealed restore envelopes from read-only backup D1 JSON exports.
// Never logs customer names, phones, notes, or raw messages to stdout/stderr.

import { readFileSync, writeFileSync } from 'node:fs';
import { sealIngestPayload } from '../../_worker/crm-worker.js';

function extractD1Rows(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (Array.isArray(parsed)) {
    const out = [];
    for (const entry of parsed) {
      if (Array.isArray(entry?.results)) out.push(...entry.results);
    }
    return out;
  }
  if (Array.isArray(parsed?.results)) return parsed.results;
  return [];
}

function extractPublicKey(rawJson) {
  const rows = extractD1Rows(rawJson);
  for (const r of rows) {
    const cand = String(r?.pub || r?.resource_id || '').trim();
    if (cand.length > 100) return cand;
  }
  throw new Error('public_key_missing_in_d1_output');
}

function groupByOpportunityId(rows) {
  const map = new Map();
  for (const row of rows) {
    const oppId = String(row?.opportunity_id || '').trim();
    if (!oppId) continue;
    const list = map.get(oppId) || [];
    list.push(row);
    map.set(oppId, list);
  }
  return map;
}

async function main() {
  const [oppsPath, actsPath, propsPath, pubPath, dryFlagRaw, outPath] = process.argv.slice(2);
  if (!oppsPath || !actsPath || !propsPath || !pubPath || !outPath) {
    throw new Error('usage_missing_args');
  }
  const isDryRun = String(dryFlagRaw || '').trim() === 'true';
  const opps = extractD1Rows(readFileSync(oppsPath, 'utf8'));
  const acts = extractD1Rows(readFileSync(actsPath, 'utf8'));
  const props = extractD1Rows(readFileSync(propsPath, 'utf8'));
  const pubKey = extractPublicKey(readFileSync(pubPath, 'utf8'));

  const actsByOpp = groupByOpportunityId(acts);
  const propsByOpp = groupByOpportunityId(props);

  const enriched = opps.map(opp => ({
    ...opp,
    activities: actsByOpp.get(String(opp.id)) || [],
    opportunity_properties: propsByOpp.get(String(opp.id)) || [],
  }));

  const chunkSize = 10;
  const envelopes = [];
  for (let i = 0; i < enriched.length; i += chunkSize) {
    const slice = enriched.slice(i, i + chunkSize);
    const envStr = await sealIngestPayload(
      {
        dry_run: isDryRun,
        sync_bundle: {
          restore_opportunities: slice,
        },
      },
      pubKey,
    );
    envelopes.push(envStr);
  }

  writeFileSync(outPath, `${envelopes.join('\n')}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dry_run: isDryRun,
    opportunities: enriched.length,
    activities: acts.length,
    properties: props.length,
    envelopes: envelopes.length,
  })}\n`);
}

await main();
