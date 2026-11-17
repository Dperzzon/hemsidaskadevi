// Samtycke och GTM: ingen mätning före samtycke, valet kan ändras och
// dataLayer tar aldrig emot personuppgifter.
import { test, expect } from '@playwright/test';

const GTM_SCRIPT = 'https://www.googletagmanager.com/gtm.js**';

async function trackGtm(page) {
  const hits = [];
  await page.route(GTM_SCRIPT, async (route) => {
    hits.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: 'window.__gtmStubLoaded = true;'
    });
  });
  return hits;
}

test('ingen GTM laddas och inget skickas före samtycke', async ({ page }) => {
  const hits = await trackGtm(page);
  await page.goto('/', { waitUntil: 'load' });

  const banner = page.locator('.cookie-consent');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Acceptera statistik');
  await expect(banner).toContainText('Neka statistik');

  const state = await page.evaluate(() => ({
    consent: window.SkadeviAnalytics.readConsent(),
    defaults: window.dataLayer.filter((item) => item && item[0] === 'consent' && item[1] === 'default'),
    script: document.querySelector('script[src*="googletagmanager.com/gtm.js"]')
  }));
  expect(state.consent).toBeNull();
  expect(state.script).toBeNull();
  expect(state.defaults.length).toBe(1);
  expect(state.defaults[0][2]).toMatchObject({
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });
  expect(hits).toEqual([]);
});

test('accepterat samtycke laddar GTM exakt en gång och uppdaterar consent', async ({ page }) => {
  const hits = await trackGtm(page);
  await page.goto('/', { waitUntil: 'load' });
  await page.locator('[data-consent-accept]').click();

  await expect(page.locator('.cookie-consent')).toBeHidden();
  const state = await page.evaluate(() => ({
    consent: window.SkadeviAnalytics.readConsent(),
    scripts: document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]').length,
    updates: window.dataLayer.filter((item) => item && item[0] === 'consent' && item[1] === 'update')
  }));
  expect(state.consent).toBe(true);
  expect(state.scripts).toBe(1);
  expect(hits.length).toBe(1);
  expect(hits[0]).toContain('GTM-T5BNLGR7');
  expect(state.updates.at(-1)[2].analytics_storage).toBe('granted');
});

test('nekat samtycke respekteras och kan ändras via sidfoten', async ({ page }) => {
  const hits = await trackGtm(page);
  await page.goto('/', { waitUntil: 'load' });
  await page.locator('[data-consent-deny]').click();
  await expect(page.locator('.cookie-consent')).toBeHidden();
  expect(await page.evaluate(() => window.SkadeviAnalytics.readConsent())).toBe(false);
  expect(hits).toEqual([]);

  await page.locator('[data-cookie-settings]').click();
  await expect(page.locator('.cookie-consent')).toBeVisible();
  await page.locator('[data-consent-accept]').click();
  await expect(page.locator('.cookie-consent')).toBeHidden();
  expect(await page.evaluate(() => window.SkadeviAnalytics.readConsent())).toBe(true);
  expect(hits.length).toBe(1);
});

test('dataLayer-händelser skickar aldrig personuppgifter', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('skadevi-consent-v1', JSON.stringify({
      analytics: true, version: 1, updatedAt: new Date().toISOString()
    }));
  });
  await trackGtm(page);
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.SkadeviAnalytics && window.SkadeviAnalytics.gtmReady);

  await page.evaluate(() => {
    window.SkadeviAnalytics.track('purchase', {
      transaction_id: 'SKD-2026-1234',
      value: 9950,
      currency: 'SEK',
      email: 'gast@example.com',
      phone: '0700000000',
      name: 'Testperson'
    });
    window.SkadeviAnalytics.track('booking_started', { booking_nights: 2, email: 'x@example.com' });
  });
  await page.waitForTimeout(100);

  const events = await page.evaluate(() => window.dataLayer.filter((item) => item && item.event));
  const purchase = events.find((item) => item.event === 'purchase');
  expect(purchase).toMatchObject({ transaction_id: 'SKD-2026-1234', value: 9950, currency: 'SEK' });
  expect(purchase).not.toHaveProperty('email');
  expect(purchase).not.toHaveProperty('phone');
  expect(purchase).not.toHaveProperty('name');
  const started = events.find((item) => item.event === 'booking_started');
  expect(started).toMatchObject({ booking_nights: 2 });
  expect(started).not.toHaveProperty('email');
});
