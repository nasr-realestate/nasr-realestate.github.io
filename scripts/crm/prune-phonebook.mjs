#!/usr/bin/env node
/**
 * A phone book is not a client list.
 *
 * He keeps thousands of cards because a name he saved in 2021 might be the name
 * on a chat today — that is why the dictionary exists. But the *phone* does not
 * need thousands of cards to be useful: it needs the people he actually works
 * with, each one carrying one number, one name, and the mark he thinks in.
 *
 * This file takes a full `.vcf` export and produces two files:
 *
 *   - `current-<stamp>.vcf`  what he wants in the phone now,
 *   - `archive-<stamp>.vcf`  everything else — kept, never destroyed,
 *   - `prune-report-<stamp>.csv`  one row per input card with the reason.
 *
 * Rules, in the order they apply:
 *   1. No number, no card. A card without a number is a note, not a contact.
 *   2. One person, one card. Duplicates are merged **by number**, not by name:
 *      the same man saved twice under two spellings is one man.
 *   3. A marked name outranks an unmarked one when the numbers agree, because the
 *      mark is the owner's own judgement and nothing here may overrule it.
 *   4. `--keep marked` (default) keeps only cards carrying one of the five marks;
 *      `--keep all` keeps every card that survived rule 1. Nothing is guessed
 *      about age: a vCard carries no date, so no date is invented.
 *   5. `--include MARK` treats an extra mark (one outside the five) as in-scope;
 *      `--only MARK` writes ONE complete group — every card carrying that mark,
 *      and nothing else. An unknown mark keeps its own symbol as its CATEGORIES
 *      label: this file does not invent a meaning for the owner's shorthand.
 *
 * Output is vCard 3.0, UTF-8, CRLF — read by Android and iOS alike — with the
 * number written as `+20…` and the mark repeated in `CATEGORIES` so it can be
 * filtered inside the phone.
 *
 * Usage:
 *   node scripts/crm/prune-phonebook.mjs --dir ~/phonebook --out ~/phonebook-out
 *   node scripts/crm/prune-phonebook.mjs --dir ~/phonebook --out ~/phonebook-out --keep all
 *
 * `--out` must live outside this repository: a `.vcf` inside the working tree
 * fails the privacy canary, and it is right to.
 */
import fs from 'node:fs';
import path from 'node:path';

import { cleanBidiControls } from '../../_worker/crm-chat-intel.js';
import { parseVcfContacts } from './build-whatsapp-import.mjs';
import { segmentsOf } from './segments.mjs';

export const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
export const KEEP_MODES = ['marked', 'all'];

/** Whitespace and bidi controls out; the name he typed, nothing else added. */
export function cleanName(value) {
  return cleanBidiControls(String(value ?? '')).replaceAll(/\s+/g, ' ').trim();
}

/** A card as this file reasons about it: one name, its numbers, its mark. */
function toCard(contact, sourceRef, extraMarks = []) {
  const fn = cleanName(contact?.fn);
  const phones = [];
  for (const phone of contact?.phones || []) {
    const e164 = String(phone?.e164 || '').replaceAll(/\D/g, '');
    if (e164 && !phones.includes(e164)) phones.push(e164);
  }
  const segment = segmentsOf(fn);
  const extra = extraMarks.filter((mark) => mark && fn.includes(mark));
  const marks = [...segment.codes, ...extra];
  return {
    fn,
    phones,
    marks,
    marked: segment.inScope || extra.length > 0,
    // A mark outside the five has no name this file can invent, so it becomes its own label.
    segment: segment.primary || (extra.length > 0 ? { code: extra[0], label: extra[0] } : null),
    sourceRef,
  };
}

/**
 * Cards that share ANY number are the same person. A union over phone numbers does
 * both cases at once: same number under two spellings, and two numbers under one
 * name, each end up as one card.
 */
function groupByNumber(cards) {
  const parent = cards.map((_, i) => i);
  const find = (i) => {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const owner = new Map();
  cards.forEach((card, i) => {
    for (const phone of card.phones) {
      if (owner.has(phone)) union(owner.get(phone), i);
      else owner.set(phone, i);
    }
  });
  const groups = new Map();
  cards.forEach((card, i) => {
    const root = find(i);
    const group = groups.get(root) || { cards: [], phones: [] };
    group.cards.push(card);
    for (const phone of card.phones) if (!group.phones.includes(phone)) group.phones.push(phone);
    groups.set(root, group);
  });
  return [...groups.values()];
}

/** The marked spelling wins; otherwise the longest one, which is the fuller name. */
function pickDisplayName(cards) {
  const marked = cards.filter((card) => card.marked);
  const pool = marked.length > 0 ? marked : cards;
  return pool.reduce((best, card) => (card.fn.length > best.fn.length ? card : best), pool[0]);
}

/** One person, ready to be written: display name, numbers, mark, and what was folded in. */
export function mergePeople(cards) {
  return groupByNumber(cards).map((group) => {
    const display = pickDisplayName(group.cards);
    const names = [...new Set(group.cards.map((card) => card.fn).filter((fn) => fn && fn !== display.fn))];
    return {
      fn: display.fn,
      phones: group.phones.filter(Boolean),
      marks: [...new Set(group.cards.flatMap((card) => card.marks))],
      marked: display.marked,
      segment: display.segment,
      mergedNames: names,
    };
  });
}

const CSV_ESCAPE = /[",\r\n]/;

function csvField(value) {
  const text = String(value ?? '');
  return CSV_ESCAPE.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 2426 text escaping: backslash, semicolon, comma — and newlines as `\n`. */
function vcardText(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r?\n/g, '\\n');
}

/** vCard 3.0: the one dialect Android and iOS both read without help. */
export function toVcard3(people) {
  const blocks = people.map((person) => {
    const name = vcardText(person.fn);
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:;${name};;;`,
      `FN:${name}`,
      ...person.phones.map((phone) => `TEL;TYPE=CELL:+${phone}`),
    ];
    if (person.segment) lines.push(`CATEGORIES:${vcardText(person.segment.label)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  });
  return blocks.length > 0 ? `${blocks.join('\r\n')}\r\n` : '';
}

/** Splits the merged people into what stays and what is archived — never a deletion. */
export function splitPeople(people, { keep = 'marked', only = '' } = {}) {
  if (!KEEP_MODES.includes(keep)) throw new Error(`unknown-keep-mode:${keep}`);
  const current = [];
  const archive = [];
  for (const person of people) {
    // `only` takes ONE complete group — every card carrying that mark, and nothing else.
    const take = only ? person.marks.includes(only) : (keep === 'all' || person.marked);
    if (take) current.push(person);
    else archive.push(person);
  }
  return { current, archive };
}

/**
 * The whole decision, without a database and without a file write: input text in,
 * three artifacts out. Kept separate so the rules can be tested on synthetic cards.
 */
export function buildPruneReport({ vcfTexts = [], keep = 'marked', include = [], only = '' } = {}) {
  const extraMarks = [...new Set([...include, only].filter(Boolean))];
  const cards = vcfTexts.flatMap(({ name, text }) =>
    parseVcfContacts(text, name).map((c) => toCard(c, name, extraMarks)));
  const withNumber = cards.filter((card) => card.phones.length > 0);
  const people = mergePeople(withNumber).sort((a, b) => a.fn.localeCompare(b.fn, 'ar'));
  const { current, archive } = splitPeople(people, { keep, only });
  const kept = new Set(current);
  const personByPhone = new Map();
  for (const person of people) for (const phone of person.phones) personByPhone.set(phone, person);
  const rows = cards.map((card) => {
    if (card.phones.length === 0) {
      return { name: card.fn, phones: '', result: 'بلا رقم — مستبعد', reason: 'no_number' };
    }
    const person = card.phones.map((phone) => personByPhone.get(phone)).find(Boolean);
    const keptCard = person ? kept.has(person) : false;
    const merged = person && person.fn !== card.fn ? `دُمج في: ${person.fn}` : '';
    return {
      name: card.fn,
      phones: card.phones.join(' | '),
      result: keptCard ? 'بقي' : 'أُرشف',
      reason: merged || (keptCard ? 'marked' : 'no_mark'),
    };
  });
  return {
    current,
    archive,
    rows,
    stats: {
      only: only || null,
      include: include.join(' ') || null,
      cards: cards.length,
      with_number: withNumber.length,
      without_number: cards.length - withNumber.length,
      people: people.length,
      kept: current.length,
      archived: archive.length,
      marked: people.filter((p) => p.marked).length,
    },
  };
}

export function toCsv(rows) {
  const head = 'name,phones,result,reason';
  const body = rows.map((row) => [row.name, row.phones, row.result, row.reason].map(csvField).join(','));
  return `${[head, ...body].join('\r\n')}\r\n`;
}

/** A `.vcf` inside the repository fails the privacy canary — refuse before writing. */
export function assertOutDirOutsideRepo(outDir) {
  const resolved = path.resolve(outDir);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`refusing-to-write-inside-repository:${resolved}`);
  }
  return resolved;
}

function stamp(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll('-', '');
}

function readVcfFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /\.vcf$/i.test(name))
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const dir = get('--dir');
  const out = get('--out');
  const keep = get('--keep', 'marked');
  const only = get('--only', '');
  const include = get('--include', '').split(/[\s,]+/).filter(Boolean);
  if (!dir || !out) {
    console.error('usage: prune-phonebook.mjs --dir <dir> --out <dir-outside-repo> [--keep marked|all] [--include 🌀] [--only 🌀]');
    process.exit(2);
  }
  const outDir = assertOutDirOutsideRepo(out);
  const inputs = readVcfFiles(dir);
  if (inputs.length === 0) {
    console.error(`no .vcf files in ${dir}`);
    process.exit(2);
  }
  const { current, archive, rows, stats } = buildPruneReport({ vcfTexts: inputs, keep, include, only });
  fs.mkdirSync(outDir, { recursive: true });
  const day = stamp();
  const written = {
    current: path.join(outDir, `current-${day}.vcf`),
    archive: path.join(outDir, `archive-${day}.vcf`),
    report: path.join(outDir, `prune-report-${day}.csv`),
  };
  fs.writeFileSync(written.current, toVcard3(current), 'utf8');
  fs.writeFileSync(written.archive, toVcard3(archive), 'utf8');
  fs.writeFileSync(written.report, toCsv(rows), 'utf8');
  console.log(JSON.stringify({ keep, only: only || null, inputs: inputs.map((f) => f.name), stats, files: written }, null, 2));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) await main();
