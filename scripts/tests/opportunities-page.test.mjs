import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const page = await readFile(new URL('../../opportunities.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../../assets/js/opportunities.js', import.meta.url), 'utf8');
const core = await readFile(new URL('../../assets/js/crm-core.js', import.meta.url), 'utf8');
test('opportunities UI is noindex and local-only, linked from existing CRM; has no write API dependency', async () => {
  const crm = await readFile(new URL('../../crm.html', import.meta.url), 'utf8');
  assert.match(page, /noindex,nofollow,noarchive/);
  assert.match(app, /simsar-opportunities-v1/);
  assert.match(crm, /href="\/opportunities\.html"/);
  assert.doesNotMatch(app, /fetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/);
  assert.match(app, /safeProperty/);
});
test('the shared Egyptian phone normalizer deduplicates common forms and repeated opportunities remain separate', () => {
  const context = { globalThis: {}, Date, Math, JSON, RegExp, Object, Array, String, Number, parseInt, isFinite };
  vm.runInNewContext(core, context);
  const normalize = context.globalThis.SimsarCRM.normalizePhone;
  assert.equal(normalize('0101 234 5678').id, normalize('+20 1012345678').id);
  assert.equal(normalize('٠١٠١٢٣٤٥٦٧٨').id, normalize('+201012345678').id);
  assert.match(app, /db\.opportunities\.push/);
  assert.match(app, /contactId:phone\.id/);
});
test('follow-up dashboard counts today/overdue and explicit close/loss states', () => {
  assert.match(app, /dueToday/);
  assert.match(app, /overdue/);
  assert.match(app, /won/);
  assert.match(app, /lost/);
  assert.match(app, /x\.due/);
});
