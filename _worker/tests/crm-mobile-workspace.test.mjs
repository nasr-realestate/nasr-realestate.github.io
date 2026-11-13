import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../crm-ui/crm.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../crm-ui/crm-assets/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../crm-ui/crm-assets/app.css', import.meta.url), 'utf8');

test('mobile dock targets existing authenticated panels and has an active state', () => {
  const dock = html.split('<nav class="mobile-dock"')[1].split('</nav>')[0];
  for (const id of ['dashboard-panel', 'followups-panel', 'quick-entry-panel', 'contacts-panel', 'opportunities-panel']) {
    assert.ok(dock.includes(`data-mobile-panel="${id}"`));
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.match(js, /item\.addEventListener\('click', \(\) => openPanel\(item\.dataset\.mobilePanel\)\)/);
  assert.match(js, /item\.setAttribute\('aria-current', 'page'\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('daily shortcuts use real panels and do not invent WhatsApp sync state', () => {
  const actions = html.split('<div class="daily-actions"')[1].split('<div class="section-label">')[0];
  for (const id of ['followups-panel', 'contacts-panel', 'a5-requests-panel', 'quick-entry-panel']) {
    assert.ok(actions.includes(`data-open-panel="${id}"`));
  }
  assert.doesNotMatch(actions, /95|116|مزامنة تلقائية/);
});
