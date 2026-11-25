import { test, expect } from '@playwright/test';
import { prepare } from './helpers.js';

const RULES_MOCK = {
  published: true,
  version: 'test-tillval-2026-11-25',
  text: 'AVBOKNINGSPOLICY\n• Testregel för tillvalsköp.'
};

const SESSION_MOCK = {
  reference: 'SK-2027-AB123',
  arrival: '2027-03-10',
  departure: '2027-03-13',
  nights: 3,
  guests: 4,
  existingAddons: [
    { id: 'slutstad', label: 'Slutstädning', quantity: 1, amount: 2500 },
    { id: 'lakan', label: 'Lakan och handdukar', quantity: 2, amount: 400 }
  ],
  available: [
    {
      id: 'lakan',
      label: 'Lakan och handdukar',
      description: 'Pris per person som behöver lakan och handdukar.',
      type: 'quantity',
      unit: 'per person',
      max: 2,
      existingCount: 2,
      priceOre: 20000,
      priceLabel: '200 kr per person'
    },
    {
      id: 'ved',
      label: 'Ved',
      description: 'Ett engångspris per beställning.',
      type: 'boolean',
      unit: 'per beställning',
      priceOre: 35000,
      priceLabel: '350 kr'
    }
  ],
  requestOnly: [
    {
      id: 'extrahus',
      label: 'Extrahus',
      reason: 'Kräver manuell bekräftelse.',
      priceLabel: '1 600 kr per natt',
      maxGuests: 6
    }
  ],
  termsVersion: 'test-tillval-2026-11-25',
  sessionExpiresAt: '2026-11-09T10:30:00.000Z'
};

async function prepareAddons(page) {
  await prepare(page);
  await page.route('**/api/booking-config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        directBookingEnabled: false,
        existingBookingAddonsEnabled: true,
        cardEnabled: true,
        manualRequestEnabled: true
      })
    }));
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
}

test('boka-sidan visar både ny bokning och komplettering av befintlig bokning', async ({ page }) => {
  await prepareAddons(page);
  await page.goto('/boka', { waitUntil: 'load' });
  await expect(page.locator('[data-booking-mode="new"]')).toBeVisible();
  await expect(page.locator('[data-booking-mode="addons"]')).toBeVisible();
  await expect(page.locator('.calendar-section')).toBeVisible();

  await page.locator('[data-booking-mode="addons"]').click();
  await expect(page.locator('#addon-section')).toBeVisible();
  await expect(page.locator('.calendar-section')).toBeHidden();
  await expect(page.locator('#addon-reference')).toBeVisible();
});

test('gästen verifierar sin bokning och kan bara köpa nya tillval', async ({ page }) => {
  await prepareAddons(page);
  await page.route('**/api/addons/verify/start', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        message: 'Om uppgifterna stämmer med en bekräftad bokning har vi skickat en verifieringskod till bokningens registrerade e-postadress. Koden gäller i 10 minuter.'
      })
    }));
  await page.route('**/api/addons/verify/confirm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'test-session-token-1234567890', expiresAt: SESSION_MOCK.sessionExpiresAt, reference: SESSION_MOCK.reference })
    }));
  await page.route('**/api/addons/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSION_MOCK) }));
  let checkoutBody = null;
  await page.route('**/api/addons/checkout', async (route) => {
    checkoutBody = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Test: betalningen stoppades av säkerhetsskäl.', code: 'TEST_STOP' })
    });
  });

  await page.goto('/boka', { waitUntil: 'load' });
  await page.locator('[data-booking-mode="addons"]').click();
  await page.locator('#addon-reference').fill('SK-2027-AB123');
  await page.locator('#addon-email').fill('anna@example.com');
  await page.locator('#addon-identify-submit').click();
  await expect(page.locator('#addon-code-form')).toBeVisible();
  await page.locator('#addon-code').fill('123456');
  await page.locator('#addon-code-submit').click();

  await expect(page.locator('#addon-booking-summary')).toContainText('SK-2027-AB123');
  await expect(page.locator('#addon-booking-summary')).toContainText('Ni kompletterar denna bokning');
  await expect(page.locator('#addon-existing')).toContainText('Slutstädning');
  await expect(page.locator('#addon-options')).toContainText('Ved');
  await expect(page.locator('#addon-options')).not.toContainText('Slutstädning');

  await page.locator('input[data-addon-id="ved"]').check();
  await expect(page.locator('#addon-total')).toContainText('350');
  await page.locator('#addon-terms').check();
  await page.locator('#addon-purchase-submit').click();

  await expect(page.locator('#addon-purchase-notice')).toContainText('stoppades');
  expect(checkoutBody).toBeTruthy();
  expect(checkoutBody.items).toEqual({ ved: true });
  expect(checkoutBody.termsVersion).toBe('test-tillval-2026-11-25');
  expect(JSON.stringify(checkoutBody)).not.toContain('14000');
});

test('tillvalsflödet fungerar på mobil och döljer den vanliga datumväljaren', async ({ page }) => {
  await prepareAddons(page);
  await page.goto('/boka', { waitUntil: 'load' });
  await page.locator('[data-booking-mode="addons"]').click();
  await expect(page.locator('#addon-section')).toBeVisible();
  await expect(page.locator('.calendar-section')).toBeHidden();
  const box = await page.locator('#addon-section').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(250);
  await expect(page.locator('#addon-identify-submit')).toBeVisible();
});
