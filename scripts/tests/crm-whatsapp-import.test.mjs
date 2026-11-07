import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseVcfContacts, resolveChatOwner, nameTokens, normalizeArabicName,
  buildBundle, batchBundle, summarize, readChatTextFromZip, conversationUidFrom,
} from '../crm/build-whatsapp-import.mjs';
import { canonSyncKey } from '../../_worker/crm-sync-and-match.js';

// Synthetic names only — this repository is public and holds no client data.
const VCF = [
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:حازم عبد العال', 'TEL;TYPE=CELL:+201000000001', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:راندا محمد', 'TEL;TYPE=CELL:+201000000002', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:محمد', 'TEL;TYPE=CELL:+201000000003', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:محمد صابر', 'TEL;TYPE=CELL:+201000000004', 'END:VCARD',
].join('\r\n');

const CHAT = [
  '7/11/26، 12:19 م - حازم عبد العال: مساء الخير، بسال على الشقة',
  '7/11/26، 12:25 م - أنا: أهلاً، فيه ١٦٥ متر دور تالت',
  '8/11/26، 10:02 ص - حازم عبد العال: تمام، نبعت صور؟',
].join('\r\n');

test('WA-1 the phone book is read as vCard, with phones in international form', () => {
  const contacts = parseVcfContacts(VCF, 'vcards_test.vcf');
  assert.equal(contacts.length, 4);
  assert.equal(contacts[0].fn, 'حازم عبد العال');
  assert.equal(contacts[0].phones[0].e164, '201000000001', 'normalizer returns digits with country code');
  assert.equal(contacts[0].phones[0].source_ref, 'vcards_test.vcf');
});

test('WA-2 Arabic that differs only in typing is the same name', () => {
  assert.equal(normalizeArabicName('أحمد'), normalizeArabicName('احمد'));
  assert.equal(normalizeArabicName('مصطفى'), normalizeArabicName('مصطفي'));
  assert.equal(normalizeArabicName('فاطمة'), normalizeArabicName('فاطمه'));
  // …but the display name is never rewritten.
  assert.equal(parseVcfContacts(VCF)[3].fn, 'محمد صابر');
});

test('WA-3 a renamed export resolves through the sender name printed in the chat', async () => {
  const contacts = parseVcfContacts(VCF);
  const r = resolveChatOwner({
    title: '‏دردشة في واتساب مع 🔴 حازم محل 80 م في جسر السويس خلف الميرلاند',
    peerSenderName: 'حازم عبد العال',
    peerPhoneNorm: null,
  }, contacts);
  assert.equal(r.contact?.fn, 'حازم عبد العال');
});

test('WA-4 a short first name is enough when only one contact carries it', () => {
  const contacts = parseVcfContacts(VCF);
  const r = resolveChatOwner({ title: 'حازم محل 80م', peerSenderName: 'حازم', peerPhoneNorm: null }, contacts);
  assert.equal(r.contact?.fn, 'حازم عبد العال');
});

test('WA-5 an ambiguous name is refused, not guessed', () => {
  // Two men share the first name and neither of them IS "محمد": the chat waits.
  const vcf = ['BEGIN:VCARD', 'FN:محمد صابر', 'TEL;TYPE=CELL:+201000000011', 'END:VCARD',
    'BEGIN:VCARD', 'FN:محمد كامل', 'TEL;TYPE=CELL:+201000000012', 'END:VCARD'].join('\r\n');
  const r = resolveChatOwner({ title: '‏دردشة في واتساب مع محمد', peerSenderName: 'محمد', peerPhoneNorm: null },
    parseVcfContacts(vcf));
  assert.equal(r.contact, null);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.candidates.length, 2);
});

test('WA-5b an exact phone-book name wins over a longer name that contains it', () => {
  const contacts = parseVcfContacts(VCF);
  const r = resolveChatOwner({ title: '‏دردشة في واتساب مع محمد', peerSenderName: 'محمد', peerPhoneNorm: null }, contacts);
  assert.equal(r.contact?.fn, 'محمد', 'exact beats partial — no ambiguity where an exact entry exists');
});

test('WA-6 an unknown phone number in the sender line matches the phone book directly', () => {
  const contacts = parseVcfContacts(VCF);
  const r = resolveChatOwner({ title: '‏دردشة في واتساب مع +201000000002', peerSenderName: '+201000000002', peerPhoneNorm: '201000000002' }, contacts);
  assert.equal(r.contact?.fn, 'راندا محمد');
});

test('WA-7 the wire title is the phone book spelling — this is what makes unknown reach zero', async () => {
  const { bundle, report } = await buildBundle({
    vcfTexts: [{ name: 'vcards_test.vcf', text: VCF }],
    chatSources: [{ label: '‏دردشة في واتساب مع 🔴 حازم محل 80 م في جسر السويس.txt', text: CHAT }],
  });
  assert.equal(report[0].resolved_to, 'حازم عبد العال');
  assert.equal(bundle.conversations[0].title, 'حازم عبد العال');
  // The worker matches with canonSyncKey on both sides; assert the equality it needs.
  assert.equal(canonSyncKey(bundle.conversations[0].title), canonSyncKey('حازم عبد العال'));
  assert.equal(summarize(report).unknown, 0);
});

test('WA-8 an unresolved chat is imported, not dropped, and says why', async () => {
  const strangerChat = [
    '7/11/26، 12:19 م - رقم غريب: بسال على المحل',
    '7/11/26، 12:25 م - أنا: أهلاً',
  ].join('\r\n');
  const { bundle, report } = await buildBundle({
    vcfTexts: [{ name: 'vcards_test.vcf', text: VCF }],
    chatSources: [{ label: '‏دردشة في واتساب مع زبون جديد.txt', text: strangerChat }],
  });
  const s = summarize(report);
  assert.equal(s.chats, 1);
  assert.equal(s.unknown, 1);
  assert.equal(bundle.conversations.length, 1, 'nothing may be silently dropped');
  assert.ok(report[0].reason);
});

test('WA-9 the transcript is parsed by the worker parser, not a second one', async () => {
  const { report, bundle } = await buildBundle({
    vcfTexts: [{ name: 'v.vcf', text: VCF }],
    chatSources: [{ label: 'x.txt', text: CHAT }],
  });
  assert.equal(report[0].messages, 3);
  assert.ok(bundle.conversations[0].first_message_at < bundle.conversations[0].last_message_at);
  assert.match(bundle.conversations[0].conversation_uid, /^wadrive:[0-9a-f]{40}$/);
});

test('WA-10 the same transcript always yields the same uid (re-import is a no-op)', async () => {
  const a = await buildBundle({ vcfTexts: [{ name: 'v.vcf', text: VCF }], chatSources: [{ label: 'x.txt', text: CHAT }] });
  const b = await buildBundle({ vcfTexts: [{ name: 'v.vcf', text: VCF }], chatSources: [{ label: 'renamed.txt', text: CHAT }] });
  assert.equal(a.bundle.conversations[0].conversation_uid, b.bundle.conversations[0].conversation_uid);
  assert.equal(conversationUidFrom('f'.repeat(64)), `wadrive:${'f'.repeat(40)}`);
});

test('WA-11 batches respect both the count and the dispatch byte budget', () => {
  const conv = (i) => ({ title: `c${i}`, raw_txt: 'x'.repeat(2000), sig: String(i) });
  const bundle = { vcf_contacts: [], conversations: Array.from({ length: 25 }, (_, i) => conv(i)) };
  const byCount = batchBundle(bundle, { batch: 10 });
  assert.deepEqual(byCount.map((b) => b.conversations.length), [10, 10, 5]);
  const bySize = batchBundle(bundle, { batch: 100, budgetBytes: 20_000 });
  assert.ok(bySize.length > 1);
  for (const b of bySize) assert.ok(Buffer.byteLength(JSON.stringify(b.conversations)) < 20_000);
});

test('WA-12 a real zip on disk is read without unpacking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  fs.writeFileSync(path.join(dir, '‏دردشة في واتساب مع حازم.txt'), CHAT, 'utf8');
  execFileSync('zip', ['-q', path.join(dir, 'chat.zip'), '‏دردشة في واتساب مع حازم.txt'], { cwd: dir });
  const { text, entry } = readChatTextFromZip(path.join(dir, 'chat.zip'));
  assert.match(entry, /\.txt$/);
  assert.ok(text.includes('بسال على الشقة'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WA-13 a zip with no transcript or several transcripts fails loudly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two', 'utf8');
  execFileSync('zip', ['-q', path.join(dir, 'two.zip'), 'a.txt', 'b.txt'], { cwd: dir });
  assert.throws(() => readChatTextFromZip(path.join(dir, 'two.zip')), /zip-with-many-txt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WA-14 a real exported vCard 2.1 (local numbers, embedded photo) is read correctly', () => {
  // Shape taken from the phone book actually exported to Drive: vCard 2.1,
  // `TEL;CELL:` with a local 01x number, and a base64 PHOTO block that must not
  // be mistaken for a phone or a name.
  const vcf21 = [
    'BEGIN:VCARD', 'VERSION:2.1', 'N:;Alaa2;;;', 'FN:Alaa2', 'TEL;CELL:01000000002',
    'TEL;CELL;PREF:0100 000 0002', 'PHOTO;ENCODING=BASE64;JPEG:/9j/4AAQSkZJRgABAQ', ' AAQEAAAHIAAAAAAQwAABtbnRyUkdC', 'END:VCARD',
  ].join('\r\n');
  const contacts = parseVcfContacts(vcf21, 'vcards_test.vcf');
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].fn, 'Alaa2');
  // The local form and the spaced form are one number, converted to +20.
  assert.equal(contacts[0].phones.length, 1);
  assert.equal(contacts[0].phones[0].e164, '201000000002');
});
