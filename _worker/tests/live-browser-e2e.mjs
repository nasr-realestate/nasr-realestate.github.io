import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = String(process.env.CRM_TEST_BASE_URL || '').trim().replace(/\/+$/, '');
const codeFile = String(process.env.CRM_LIVE_ACCESS_CODE_FILE || '').trim();

if (!baseUrl.startsWith('https://')) {
  throw new Error('CRM_TEST_BASE_URL must be an https:// origin');
}
if (!codeFile) {
  throw new Error('CRM_LIVE_ACCESS_CODE_FILE is required');
}

const accessCode = (await readFile(codeFile, 'utf8')).trim();
assert.ok(accessCode.length >= 24, 'Access code must be at least 24 chars');

let currentStep = 'browser-launch';
let browser;
let activePage = null;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'ar-EG',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  const pageErrors = [];
  const attachErrorListeners = page => {
    page.on('pageerror', err => pageErrors.push(String(err?.message || err)));
    page.on('console', msg => {
      if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) {
        pageErrors.push(msg.text());
      }
    });
  };

  // 1. Open CRM UI on mobile viewport — verify UI renders login screen and workspace is hidden
  currentStep = 'mobile-open-ui';
  const page1 = await context.newPage();
  activePage = page1;
  attachErrorListeners(page1);
  const navRes = await page1.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  assert.equal(navRes.status(), 200);
  await page1.locator('#login-panel').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page1.locator('#crm-workspace').isHidden(), true);

  // 2. Log in from mobile form
  currentStep = 'mobile-login';
  await page1.locator('#access-code-input').fill(accessCode);
  await page1.locator('#login-submit').tap();
  await page1.locator('#crm-workspace').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await page1.locator('#login-panel').isHidden(), true);
  assert.equal(await page1.locator('#logout-button').isVisible(), true);

  // 3. Add synthetic customer from mobile form
  currentStep = 'mobile-add-customer';
  await page1.locator('.tab[data-panel="new-contact-panel"]').tap();
  await page1.locator('#new-contact-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await page1.locator('#new-contact-form input[name="name"]').fill('TEST ONLY — عميل متصفح هاتف');
  await page1.locator('#new-contact-phones [data-phone]').first().fill('01099990088');
  await page1.locator('#new-contact-phones [data-label]').first().fill('موبايل');
  await page1.locator('#new-contact-form button[type="submit"]').tap();

  await page1.locator('#contact-detail h2').filter({ hasText: 'TEST ONLY — عميل متصفح هاتف' }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  const detailText1 = await page1.locator('#contact-detail').textContent();
  assert.match(detailText1 || '', /20\s*1099990088/);

  // 4. Close the mobile tab completely, open a brand-new tab, and retrieve the saved customer
  currentStep = 'mobile-reopen-and-retrieve';
  await page1.close();

  const page2 = await context.newPage();
  activePage = page2;
  attachErrorListeners(page2);
  await page2.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page2.locator('#crm-workspace').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await page2.locator('#login-panel').isHidden(), true);

  await page2.locator('.tab[data-panel="contacts-panel"]').tap();
  await page2.locator('#contacts-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await page2.locator('#contact-search').fill('01099990088');
  await page2.locator('#contact-search-form button[type="submit"]').tap();

  const resultCard = page2.locator('#contact-results .record').filter({ hasText: 'TEST ONLY — عميل متصفح هاتف' });
  await resultCard.first().waitFor({ state: 'visible', timeout: 15_000 });
  await resultCard.first().tap();
  await page2.locator('#contact-detail h2').filter({ hasText: 'TEST ONLY — عميل متصفح هاتف' }).waitFor({
    state: 'visible',
    timeout: 15_000,
  });

  // 5. Log out on mobile, close tab, reopen, and confirm workspace stays locked
  currentStep = 'mobile-logout-and-recheck';
  await page2.locator('#logout-button').tap();
  await page2.locator('#login-panel').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await page2.locator('#crm-workspace').isHidden(), true);
  await page2.close();

  const page3 = await context.newPage();
  attachErrorListeners(page3);
  await page3.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page3.locator('#login-panel').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page3.locator('#crm-workspace').isHidden(), true);
  await page3.close();

  assert.deepEqual(pageErrors, [], `browser-errors-${pageErrors.length}`);
  await browser.close();
  process.stdout.write(`${JSON.stringify({ ok: true, mobile_browser_verified: true })}\n`);
} catch (error) {
  let uiStatusHint = '';
  if (activePage && !activePage.isClosed()) {
    const fb = await activePage.locator('#login-feedback').textContent().catch(() => '');
    const errTxt = await activePage.locator('#load-error').textContent().catch(() => '');
    if (fb || errTxt) uiStatusHint = `-ui-${Boolean(fb)}-${Boolean(errTxt)}`;
  }
  if (browser) await browser.close().catch(() => {});
  const safeReason = `${String(error?.message || 'browser-assertion')}${uiStatusHint}`.replace(/[^A-Za-z0-9_:-]/g, '-').slice(0, 60);
  process.stdout.write(`${JSON.stringify({ ok: false, failed_step: currentStep, reason: safeReason })}\n`);
  process.exit(1);
}
