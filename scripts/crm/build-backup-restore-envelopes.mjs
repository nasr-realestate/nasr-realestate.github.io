// Builds RSA-OAEP-4096 + AES-256-GCM sealed restore envelopes from read-only backup D1 JSON exports.
// Never logs customer names, phones, notes, or raw messages to stdout/stderr.

import { readFileSync, writeFileSync } from 'node:fs';
import { canonLeadMatchKey, canonSyncKey } from '../../_worker/crm-sync-and-match.js';
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

function findUniqueConversationForOpp(opp, liveConvs) {
  const label = String(opp?.lead_label || '').trim();
  if (!label) return null;
  const exactCk = canonSyncKey(label);
  if (exactCk) {
    const exactMatches = liveConvs.filter(c => canonSyncKey(c?.chat_title || '') === exactCk);
    if (exactMatches.length === 1) return exactMatches[0];
  }
  const strippedKey = canonLeadMatchKey(label);
  if (!strippedKey) return null;
  const strippedMatches = liveConvs.filter(c => canonLeadMatchKey(c?.chat_title || '') === strippedKey);
  return strippedMatches.length === 1 ? strippedMatches[0] : null;
}

async function main() {
  const [
    oppsPath,
    actsPath,
    propsPath,
    liveContactedOppsPath,
    liveConvsPath,
    pubPath,
    dryFlagRaw,
    outPath,
  ] = process.argv.slice(2);
  if (!oppsPath || !actsPath || !propsPath || !liveContactedOppsPath || !liveConvsPath || !pubPath || !outPath) {
    throw new Error('usage_missing_args');
  }
  const isDryRun = String(dryFlagRaw || '').trim() === 'true';
  const allBackupActiveOpps = extractD1Rows(readFileSync(oppsPath, 'utf8'));
  const acts = extractD1Rows(readFileSync(actsPath, 'utf8'));
  const props = extractD1Rows(readFileSync(propsPath, 'utf8'));
  const liveContactedOppIds = new Set(
    extractD1Rows(readFileSync(liveContactedOppsPath, 'utf8'))
      .map(r => String(r?.id || '').trim())
      .filter(Boolean),
  );
  const liveConvs = extractD1Rows(readFileSync(liveConvsPath, 'utf8'));
  const pubKey = extractPublicKey(readFileSync(pubPath, 'utf8'));

  const targetOpps = allBackupActiveOpps.filter(o => !liveContactedOppIds.has(String(o?.id || '').trim()));
  const actsByOpp = groupByOpportunityId(acts);
  const propsByOpp = groupByOpportunityId(props);

  let matchedConvsCount = 0;
  let totalActs = 0;
  let totalProps = 0;
  const enriched = targetOpps.map(opp => {
    const conv = findUniqueConversationForOpp(opp, liveConvs);
    if (conv?.id) matchedConvsCount += 1;
    const oppActs = actsByOpp.get(String(opp.id)) || [];
    const oppProps = propsByOpp.get(String(opp.id)) || [];
    totalActs += oppActs.length;
    totalProps += oppProps.length;
    return {
      ...opp,
      conversation_id: conv?.id || null,
      contact_id: conv?.contact_id || null,
      activities: oppActs,
      opportunity_properties: oppProps,
    };
  });

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
    matched_conversations: matchedConvsCount,
    activities: totalActs,
    properties: totalProps,
    envelopes: envelopes.length,
  })}\n`);
}

await main();
