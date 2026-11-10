// Funktionella E2E-tester för bokningsflödet (datumval → formulär → inskick).
// Kalender-API:t mockas enligt helpers.js (bokade dagar 12–14, 20, 27–28).
import { test, expect } from '@playwright/test';
import { FIXED_NOW, prepare, settle } from './helpers.js';

const RULES_MOCK = {
  published: true,
  version: 'test-regler-1',
  text: '1. Testregel.\n2. Testregel två.'
};

test.beforeEach(async ({ page }) => {
  await prepare(page);
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
  await page.route('**/api/booking-requests', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: 'SK-2026-TEST01', status: 'Inväntar godkännande' }) }));
});

async function goto(page) {
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month h3').first()).toHaveText('November 2026');
}

async function clickDay(page, date) {
  await page.locator(`.cal-day[data-date="${date}"]`).click();
}

test('datumval öppnar formuläret med förifyllda datum och nätter', async ({ page }) => {
  await goto(page);
  await expect(page.locator('#booking-section')).toBeHidden();
  await clickDay(page, '2026-11-16');
  await expect(page.locator('.cal-selection')).toContainText('Ankomst 16 november');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('.cal-selection')).toContainText('3 nätter');
  await expect(page.locator('#booking-section')).toBeVisible();
  await expect(page.locator('#summary-arrival')).toHaveText('16 november 2026');
  await expect(page.locator('#summary-departure')).toHaveText('19 november 2026');
  await expect(page.locator('#summary-nights')).toHaveText('3 nätter');
});

test('avresedatum får sammanfalla med nästa boknings ankomst (hotelllogik)', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-10');
  // 12–14 november är bokade: nätterna 10–11 är lediga och avresa på den
  // bokade 12 november är tillåten (avresedagen är ingen natt).
  await clickDay(page, '2026-11-12');
  await expect(page.locator('#booking-section')).toBeVisible();
  await expect(page.locator('#summary-nights')).toHaveText('2 nätter');
  await expect(page.locator('#summary-departure')).toHaveText('12 november 2026');
});

test('ankomst på bokat datum avvisas med tydligt meddelande', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-12');
  await expect(page.locator('.cal-selection')).toContainText('bokat');
  await expect(page.locator('#booking-section')).toBeHidden();
});

test('period med bokade nätter avvisas', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-11');
  await clickDay(page, '2026-11-15');
  await expect(page.locator('.cal-selection')).toContainText('innehåller bokade nätter');
  await expect(page.locator('#booking-section')).toBeHidden();
});

test('förflutna datum kan inte väljas', async ({ page }) => {
  await goto(page);
  await page.locator('#cal-prev').click();
  await expect(page.locator('.cal-month h3').first()).toHaveText('Oktober 2026');
  await clickDay(page, '2026-10-15');
  await expect(page.locator('.cal-selection')).toContainText('redan varit');
  await expect(page.locator('#booking-section')).toBeHidden();
});

test('datumval fungerar över månadsskifte', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-30');
  await page.locator('#cal-next').click();
  await expect(page.locator('.cal-month h3').first()).toHaveText('December 2026');
  await clickDay(page, '2026-12-02');
  await expect(page.locator('.cal-selection')).toContainText('2 nätter');
  await expect(page.locator('#summary-arrival')).toHaveText('30 november 2026');
  await expect(page.locator('#summary-departure')).toHaveText('2 december 2026');
});

test('vald period markeras och kan ändras via Ändra datum', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('.cal-day.cal-arrival[data-date="2026-11-16"]')).toHaveCount(1);
  await expect(page.locator('.cal-day.cal-departure[data-date="2026-11-19"]')).toHaveCount(1);
  await expect(page.locator('.cal-day.cal-in-range[data-date="2026-11-17"]')).toHaveCount(1);
  await page.locator('#booking-change-dates').click();
  await expect(page.locator('#booking-section')).toBeHidden();
  // Nytt val öppnar formuläret igen.
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-18');
  await expect(page.locator('#summary-departure')).toHaveText('18 november 2026');
});

test('tangentbordsstyrning: Enter väljer datum', async ({ page }) => {
  await goto(page);
  await page.locator('.cal-day[data-date="2026-11-16"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cal-selection')).toContainText('Ankomst 16 november');
  await page.locator('.cal-day[data-date="2026-11-19"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#booking-section')).toBeVisible();
});

test('bokningsreglerna kan läsas utan att påbörjad förfrågan förloras', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#open-rules-label').click();
  const dialog = page.locator('#booking-rules-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Testregel.');
  await page.locator('#close-rules').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#field-firstname')).toHaveValue('Anna');
  await expect(page.locator('#summary-arrival')).toHaveText('16 november 2026');
});

test('tillval uppdaterar prisöversikten och lakan-räknaren', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-guests').selectOption('4');
  await expect(page.locator('#price-total-row')).toBeHidden();
  await expect(page.locator('#price-list')).toContainText('Inga tillval valda');
  await page.locator('#addon-slutstad').check();
  await expect(page.locator('#price-total-row')).toBeVisible();
  await expect(page.locator('#price-total')).toContainText('2 500 kr');
  await page.locator('#addon-lakan').check();
  await expect(page.locator('#linen-count')).toBeEnabled();
  await expect(page.locator('#linen-count')).toHaveValue('4');
  await expect(page.locator('#price-total')).toContainText('3 300 kr');
  await page.locator('#linen-count').fill('2');
  await expect(page.locator('#price-total')).toContainText('2 900 kr');
  await page.locator('#addon-ved').check();
  await expect(page.locator('#price-total')).toContainText('3 250 kr');
  await page.locator('#addon-tidig-incheckning').check();
  await expect(page.locator('#price-total')).toContainText('3 750 kr');
  await page.locator('#addon-sen-utcheckning').check();
  await expect(page.locator('#price-total')).toContainText('4 250 kr');
  await expect(page.locator('.booking-price-note')).toContainText('Boendepris tillkommer');
});

test('skick är avstängt när bokningsreglerna inte är publicerade', async ({ page }) => {
  await page.unroute('**/api/booking-rules');
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ published: false, version: null, text: '' }) }));
  await goto(page);
  await expect(page.locator('#booking-submit')).toBeDisabled();
  await expect(page.locator('#submit-notice')).toContainText('publiceras inom kort');
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('#booking-submit')).toBeDisabled();
});

test('obligatoriskt godkännande av bokningsreglerna', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#booking-submit').click();
  await expect(page.locator('.field-error').filter({ hasText: 'godkänna bokningsreglerna' })).toBeVisible();
  // Ingen förfrågan skickades.
  let posts = 0;
  page.on('request', (req) => { if (req.url().includes('/api/booking-requests')) posts += 1; });
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#booking-confirmation')).toBeVisible();
  expect(posts).toBe(1);
});

test('lyckad inskick visar professionell bekräftelse med referens', async ({ page }) => {
  let payload = null;
  await page.route('**/api/booking-requests', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: 'SK-2026-TEST01', status: 'Inväntar godkännande' }) });
  });
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#addon-slutstad').check();
  await page.locator('#addon-lakan').check();
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#booking-confirmation')).toBeVisible();
  await expect(page.locator('#confirmation-reference')).toHaveText('SK-2026-TEST01');
  await expect(page.locator('#booking-confirmation')).toContainText('ännu inte bekräftad');
  await expect(page.locator('#booking-confirmation')).toContainText('Inväntar godkännande');
  expect(payload.arrival).toBe('2026-11-16');
  expect(payload.departure).toBe('2026-11-19');
  expect(payload.rulesVersion).toBe('test-regler-1');
  expect(payload.consentRules).toBe(true);
  expect(payload.consentContact).toBe(false);
  expect(payload.addons.slutstad).toBe(true);
  expect(payload.totalAddons).toBe(2500 + 400);
});

test('bokad period vid inskick ger tydligt fel och kalendern återställs', async ({ page }) => {
  await page.unroute('**/api/booking-requests');
  await page.route('**/api/booking-requests', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Några av de valda nätterna är inte längre tillgängliga. Vänligen välj andra datum i kalendern.' }) }));
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#form-error')).toContainText('inte längre tillgängliga');
  await expect(page.locator('#booking-confirmation')).toBeHidden();
});

test('okänd tillgänglighet vid inskick visas som fel, aldrig som ledigt', async ({ page }) => {
  await page.unroute('**/api/booking-requests');
  await page.route('**/api/booking-requests', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tillgängligheten kunde inte kontrolleras just nu. Vänligen försök igen om en stund — era datum har inte sparats.' }) }));
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#form-error')).toContainText('kunde inte kontrolleras');
  await expect(page.locator('#booking-confirmation')).toBeHidden();
});

test('formuläret skyddar mot dubbelklick med idempotensnyckel', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/booking-requests');
  await page.route('**/api/booking-requests', async (route) => {
    requests.push(route.request().headers()['idempotency-key']);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: 'SK-2026-TEST01', status: 'Inväntar godkännande' }) });
  });
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#booking-confirmation')).toBeVisible();
  expect(requests.length).toBe(1);
  expect(requests[0]).toMatch(/^[0-9a-f-]{36}$/);
});

test('@visual bokningsflöde: vald period och formulär med tillval', async ({ page }) => {
  await prepare(page);
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-guests').selectOption('4');
  await page.locator('#addon-slutstad').check();
  await page.locator('#addon-lakan').check();
  await settle(page);
  await page.waitForTimeout(400);
  await expect(page.locator('.booking-card')).toHaveScreenshot('bokningsformular.png', { fullPage: true });
});

test('@visual bokningsflöde: bekräftelse', async ({ page }) => {
  await prepare(page);
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#booking-confirmation')).toBeVisible();
  await settle(page);
  await page.waitForTimeout(400);
  await expect(page.locator('.booking-card')).toHaveScreenshot('bokningsbekraftelse.png', { fullPage: true });
});

test('okänd tillgänglighet (kalender-API fel) visar aldrig lediga datum', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route('**/api/availability?*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' }));
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month')).toHaveCount(0);
  await expect(page.locator('#booking-section')).toBeHidden();
  await expect(page.locator('.cal-notice')).toContainText('Tillgängligheten är okänd');
});
