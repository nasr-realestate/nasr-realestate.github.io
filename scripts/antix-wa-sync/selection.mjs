// Build a private index from the CRM's existing vCard parser. Never log contacts.
import fs from 'node:fs';
import { parseVcfContacts, decodeQuotedPrintable } from '../crm/build-whatsapp-import.mjs';
import { normalizeInternationalPhone } from '../../_worker/crm-chat-intel.js';
import { pathToFileURL } from 'node:url';

// Conservative graph traversal avoids leaking aliases of excluded contacts.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function buildIndex(text) {
  // Refuse formats the shared parser cannot read rather than silently losing an
  // exclusion number. These checks deliberately prefer a hold over a leak.
  const unfolded = String(text).replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const property = line.split(':', 1)[0].split(';', 1)[0].toUpperCase();
    if (property.endsWith('.FN') || property.endsWith('.TEL')) throw new Error('unsupported grouped property');
  }
  for (const block of unfolded.split(/END:VCARD/i)) {
    const parsed = parseVcfContacts(block + '\nEND:VCARD');
    if (parsed.length && parsed[0].fn.includes('🌀')) {
      const lines = [...block.matchAll(/^TEL[^:]*:(.*)$/gim)];
      if (!lines.length || lines.some(m => !normalizeInternationalPhone(decodeQuotedPrintable(m[1])))) {
        throw new Error('unusable excluded phone');
      }
    }
  }
  const cards = parseVcfContacts(text);
  const numbers = new Map();
  const excluded = new Set();
  const marked = ['🟢', '🔴', '🔵', '🟡', '✈'];
  const hasPrefix = (name, prefix) => String(name || '').trimStart().startsWith(prefix);
  for (const [i, c] of cards.entries()) {
    if (String(c.fn || '').includes('🌀')) excluded.add(i);
    for (const p of c.phones) {
      const n = p.e164.replace(/\D/g, '');
      if (!numbers.has(n)) numbers.set(n, []);
      numbers.get(n).push(i);
    }
  }
  if (!cards.length || !excluded.size || [...excluded].some(i => !cards[i].phones.length)) {
    throw new Error('invalid exclusion coverage');
  }
  const markerCount = excluded.size;
  const queue = [...excluded];
  for (let i = 0; i < queue.length; i++) {
    for (const p of cards[queue[i]].phones) {
      for (const index of numbers.get(p.e164.replace(/\D/g, '')) || []) {
        if (!excluded.has(index)) { excluded.add(index); queue.push(index); }
      }
    }
  }
  const index = {};
  for (const [number, indices] of numbers) {
    const blocked = indices.some(i => excluded.has(i));
    const names = [...new Set(indices.map(i => cards[i].fn).filter(Boolean))];
    index[number] = blocked ? { excluded: true } : {
      excluded: false,
      ambiguous: names.length !== 1,
      marked: indices.some(i => marked.some(m => hasPrefix(cards[i].fn, m))),
      name: names.length === 1 ? names[0] : null,
      candidates: names.length > 1 ? names : [],
    };
  }
  // Retain only phone groups for scope coverage; never send this private index remotely.
  const markedGroups = cards.flatMap((card, i) => {
    if (excluded.has(i) || !marked.some(m => hasPrefix(card.fn, m))) return [];
    return [card.phones.map(p => p.e164.replace(/\D/g, ''))];
  });
  return { index, card_count: cards.length, excluded_cards: excluded.size,
    excluded_marker_cards: markerCount, marked_phone_groups: markedGroups };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('invalid arguments');
    const data = fs.readFileSync(process.argv[2]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const result = buildIndex(text);
    fs.writeFileSync(process.argv[3], JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  } catch {
    console.error('SELECTION_INDEX_FAILED: تعذر تحليل دفتر العناوين أو تعذر تحديد أرقام الاستبعاد');
    process.exitCode = 1;
  }
}
