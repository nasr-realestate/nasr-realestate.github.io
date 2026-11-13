#!/usr/bin/env node
// Read-only, aggregate-only preflight. Never emits names, numbers or vCards.
// This is NOT a filter and must not be used to authorize upload.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseVcfContacts } from '../crm/build-whatsapp-import.mjs';

// Traverses the contact-number graph so exclusions propagate across aliases.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function audit(text) {
  const cards = parseVcfContacts(text);
  const excluded = [];
  const phoneCards = new Map();
  const prefix = (s, mark) => String(s || '').trimStart().startsWith(mark);
  const marker = ['🟢', '🔴', '🔵', '🟡', '✈'];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (prefix(c.fn, '🌀')) excluded.push(i);
    for (const { e164 } of c.phones) {
      if (!phoneCards.has(e164)) phoneCards.set(e164, []);
      phoneCards.get(e164).push(i);
    }
  }
  // Any card sharing a number with an excluded card is excluded too, including
  // transitive links through cards carrying multiple numbers.
  const closure = new Set(excluded);
  const queue = [...excluded];
  for (let j = 0; j < queue.length; j++) {
    for (const { e164 } of cards[queue[j]].phones) {
      for (const next of phoneCards.get(e164) || []) {
        if (!closure.has(next)) { closure.add(next); queue.push(next); }
      }
    }
  }
  return {
    cards: cards.length,
    marked_customer_cards: cards.filter(c => marker.some(m => prefix(c.fn, m))).length,
    excluded_marker_cards: excluded.length,
    excluded_marker_without_number: excluded.filter(i => !cards[i].phones.length).length,
    exclusion_closure_cards: closure.size,
    overlap_customer_exclusion_cards: [...closure].filter(i => marker.some(m => prefix(cards[i].fn, m))).length,
    cards_without_number: cards.filter(c => !c.phones.length).length,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node audit-address-book.mjs FILE.vcf');
    const file = fs.readFileSync(process.argv[2]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file);
    const result = audit(text);
    if (!result.cards) throw new Error('no readable cards');
    // MD5 is used only to compare the file with Google Drive's checksum, not for security.
    // eslint-disable-next-line sonarjs/hashing
    console.log(JSON.stringify({ bytes: file.length, md5: crypto.createHash('md5').update(file).digest('hex'), ...result }));
  } catch {
    console.error('ADDRESS_BOOK_AUDIT_FAILED: تعذّرت قراءة الدفتر بصيغة UTF-8 أو لم يُعثر على بطاقات صالحة');
    process.exitCode = 1;
  }
}
