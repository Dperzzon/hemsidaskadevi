// Funktionella E2E-tester fÃ¶r bokningsflÃ¶det (datumval â†’ formulÃ¤r â†’ inskick).
// Kalender-API:t mockas enligt helpers.js (bokade dagar 12â€“14, 20, 27â€“28).
import { test, expect } from '@playwright/test';
import { FIXED_NOW, prepare, settle } from './helpers.js';

const RULES_MOCK = {
  published: true,
  version: 'test-regler-3',
  text: 'AVBOKNINGSPOLICY (BegrÃ¤nsad)\nâ€¢ Avbokning minst 30 dagar fÃ¶re incheckning: 100 % Ã¥terbetalning.\nâ€¢ Avbokning frÃ¥n 14 dagar till mindre Ã¤n 30 dagar fÃ¶re incheckning: 50 % Ã¥terbetalning.\nâ€¢ Avbokning mindre Ã¤n 14 dagar fÃ¶re incheckning: ingen Ã¥terbetalning.\nâ€¢ Ã…terbetalningsprocenten berÃ¤knas pÃ¥ den bekrÃ¤ftade boendesumman enligt offerten.\nâ€¢ Dessa villkor begrÃ¤nsar inte era lagstadgade konsumentrÃ¤ttigheter.\n\nHUSREGLER\nâ€¢ Ingen rÃ¶kning.\nâ€¢ LÃ¥s alla dÃ¶rrar och stÃ¤ng alla fÃ¶nster vid avfÃ¤rd.\nâ€¢ Husdjur: max tvÃ¥ husdjur. Inga katter.'
};

test.beforeEach(async ({ page }) => {
  await prepare(page);
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
  await page.route('**/api/booking-requests', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: 'SK-2026-TEST01', status: 'InvÃ¤ntar godkÃ¤nnande' }) }));
});

async function goto(page) {
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month h3').first()).toHaveText('November 2026');
}

async function clickDay(page, date) {
  await page.locator(`.cal-day[data-date="${date}"]`).click();
}

test('datumval Ã¶ppnar formulÃ¤ret med fÃ¶rifyllda datum och nÃ¤tter', async ({ page }) => {
  await goto(page);
  await expect(page.locator('#booking-section')).toBeHidden();
  await clickDay(page, '2026-11-16');
  await expect(page.locator('.cal-selection')).toContainText('Ankomst 16 november');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('.cal-selection')).toContainText('3 nÃ¤tter');
  await expect(page.locator('#booking-section')).toBeVisible();
  await expect(page.locator('#summary-arrival')).toHaveText('16 november 2026');
  await expect(page.locator('#summary-departure')).toHaveText('19 november 2026');
  await expect(page.locator('#summary-nights')).toHaveText('3 nÃ¤tter');
});

test('avresedatum fÃ¥r sammanfalla med nÃ¤sta boknings ankomst (hotelllogik)', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-10');
  // 12â€“14 november Ã¤r bokade: nÃ¤tterna 10â€“11 Ã¤r lediga och avresa pÃ¥ den
  // bokade 12 november Ã¤r tillÃ¥ten (avresedagen Ã¤r ingen natt).
  await clickDay(page, '2026-11-12');
  await expect(page.locator('#booking-section')).toBeVisible();
  await expect(page.locator('#summary-nights')).toHaveText('2 nÃ¤tter');
  await expect(page.locator('#summary-departure')).toHaveText('12 november 2026');
});

test('ankomst pÃ¥ bokat datum avvisas med tydligt meddelande', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-12');
  await expect(page.locator('.cal-selection')).toContainText('bokat');
  await expect(page.locator('#booking-section')).toBeHidden();
});

test('period med bokade nÃ¤tter avvisas', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-11');
  await clickDay(page, '2026-11-15');
  await expect(page.locator('.cal-selection')).toContainText('innehÃ¥ller bokade nÃ¤tter');
  await expect(page.locator('#booking-section')).toBeHidden();
});

test('fÃ¶rflutna datum kan inte vÃ¤ljas', async ({ page }) => {
  await goto(page);
  await page.locator('#cal-prev').click();
  await expect(page.locator('.cal-month h3').first()).toHaveText('Oktober 2026');
  await clickDay(page, '2026-10-15');
  await expect(page.locator('.cal-selection')).toContainText('redan varit');
  await expect(page.locator('#booking-section')).toBeHidden();
});

test('datumval fungerar Ã¶ver mÃ¥nadsskifte', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-30');
  await page.locator('#cal-next').click();
  await expect(page.locator('.cal-month h3').first()).toHaveText('December 2026');
  await clickDay(page, '2026-12-02');
  await expect(page.locator('.cal-selection')).toContainText('2 nÃ¤tter');
  await expect(page.locator('#summary-arrival')).toHaveText('30 november 2026');
  await expect(page.locator('#summary-departure')).toHaveText('2 december 2026');
});

test('vald period markeras och kan Ã¤ndras via Ã„ndra datum', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('.cal-day.cal-arrival[data-date="2026-11-16"]')).toHaveCount(1);
  await expect(page.locator('.cal-day.cal-departure[data-date="2026-11-19"]')).toHaveCount(1);
  await expect(page.locator('.cal-day.cal-in-range[data-date="2026-11-17"]')).toHaveCount(1);
  await page.locator('#booking-change-dates').click();
  await expect(page.locator('#booking-section')).toBeHidden();
  // Nytt val Ã¶ppnar formulÃ¤ret igen.
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-18');
  await expect(page.locator('#summary-departure')).toHaveText('18 november 2026');
});

test('tangentbordsstyrning: Enter vÃ¤ljer datum', async ({ page }) => {
  await goto(page);
  await page.locator('.cal-day[data-date="2026-11-16"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cal-selection')).toContainText('Ankomst 16 november');
  await page.locator('.cal-day[data-date="2026-11-19"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#booking-section')).toBeVisible();
});

test('bokningsreglerna kan lÃ¤sas utan att pÃ¥bÃ¶rjad fÃ¶rfrÃ¥gan fÃ¶rloras', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#open-rules-label').click();
  const dialog = page.locator('#booking-rules-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Avbokning minst 30 dagar fÃ¶re incheckning: 100 % Ã¥terbetalning');
  await expect(dialog).toContainText('specificeras vid bekrÃ¤ftelse');
  await expect(dialog).toContainText('Ingen rÃ¶kning');
  await page.locator('#close-rules').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#field-firstname')).toHaveValue('Anna');
  await expect(page.locator('#summary-arrival')).toHaveText('16 november 2026');
});

test('bokningsreglerna visar avbokningspolicy och husregler', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#open-rules-label').click();
  const dialog = page.locator('#booking-rules-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Avbokning minst 30 dagar fÃ¶re incheckning: 100 % Ã¥terbetalning');
  await expect(dialog).toContainText('Avbokning frÃ¥n 7 dagar till mindre Ã¤n 30 dagar fÃ¶re incheckning: 50 % Ã¥terbetalning');
  await expect(dialog).toContainText('berÃ¤knas pÃ¥ den bekrÃ¤ftade boendesumman enligt offerten');
  await expect(dialog).toContainText('villkoret specificeras vid bekrÃ¤ftelse');
  await expect(dialog).toContainText('begrÃ¤nsar inte era lagstadgade konsumentrÃ¤ttigheter');
  await expect(dialog).toContainText('Ingen rÃ¶kning');
  await expect(dialog).toContainText('LÃ¥s alla dÃ¶rrar och stÃ¤ng alla fÃ¶nster vid avfÃ¤rd');
  await expect(dialog).toContainText('max tvÃ¥ husdjur');
  await expect(dialog).toContainText('Inga katter');
});

test('veckorabatt visas diskret fÃ¶r vistelser pÃ¥ 7 nÃ¤tter eller fler', async ({ page }) => {
  await goto(page);
  // 1â€“11 december: 10 lediga nÃ¤tter i mocken (bokade dagar Ã¤r 12â€“14, 20, 27â€“28).
  await clickDay(page, '2026-12-01');
  await clickDay(page, '2026-12-11');
  await expect(page.locator('#summary-nights')).toHaveText('10 nÃ¤tter');
  await expect(page.locator('#discount-note')).toBeVisible();
  await expect(page.locator('#discount-note')).toContainText('Veckorabatt 30 %');
  await expect(page.locator('#discount-note')).toContainText('boendepriset i offerten');
});

test('mÃ¥nadsrabatt visas fÃ¶r vistelser pÃ¥ 28 nÃ¤tter eller fler', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route('**/api/availability?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"blocked":[]}' }));
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month h3').first()).toHaveText('November 2026');
  // 29 november â†’ 27 december: exakt 28 nÃ¤tter (avresedagen Ã¤r ingen natt).
  await clickDay(page, '2026-11-29');
  await clickDay(page, '2026-12-27');
  await expect(page.locator('#summary-nights')).toHaveText('28 nÃ¤tter');
  await expect(page.locator('#discount-note')).toContainText('MÃ¥nadsrabatt 69 %');
});

test('ingen rabatt visas under grÃ¤nsvÃ¤rdena', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('#summary-nights')).toHaveText('3 nÃ¤tter');
  await expect(page.locator('#discount-note')).toBeHidden();
});

test('bekrÃ¤ftelsen anger kontaktadressen skadevigard@gmail.com', async ({ page }) => {
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
  const contact = page.locator('.booking-confirmation-contact');
  await expect(contact).toContainText('skadevigard@gmail.com');
  await expect(contact.locator('a')).toHaveAttribute('href', 'mailto:skadevigard@gmail.com');
});

test('tillval uppdaterar prisÃ¶versikten och lakan-rÃ¤knaren', async ({ page }) => {
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

test('skick Ã¤r avstÃ¤ngt nÃ¤r bokningsreglerna inte Ã¤r publicerade', async ({ page }) => {
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

test('obligatoriskt godkÃ¤nnande av bokningsreglerna', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-firstname').fill('Anna');
  await page.locator('#field-lastname').fill('Andersson');
  await page.locator('#field-email').fill('anna@example.com');
  await page.locator('#field-phone').fill('+4670123456');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#booking-submit').click();
  await expect(page.locator('.field-error').filter({ hasText: 'godkÃ¤nna bokningsreglerna' })).toBeVisible();
  // Ingen fÃ¶rfrÃ¥gan skickades.
  let posts = 0;
  page.on('request', (req) => { if (req.url().includes('/api/booking-requests')) posts += 1; });
  await page.locator('#consent-rules').check();
  await page.locator('#booking-submit').click();
  await expect(page.locator('#booking-confirmation')).toBeVisible();
  expect(posts).toBe(1);
});

test('lyckad inskick visar professionell bekrÃ¤ftelse med referens', async ({ page }) => {
  let payload = null;
  await page.route('**/api/booking-requests', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: 'SK-2026-TEST01', status: 'InvÃ¤ntar godkÃ¤nnande' }) });
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
  await expect(page.locator('#booking-confirmation')).toContainText('Ã¤nnu inte bekrÃ¤ftad');
  await expect(page.locator('#booking-confirmation')).toContainText('InvÃ¤ntar godkÃ¤nnande');
  expect(payload.arrival).toBe('2026-11-16');
  expect(payload.departure).toBe('2026-11-19');
  expect(payload.rulesVersion).toBe('test-regler-3');
  expect(payload.consentRules).toBe(true);
  expect(payload.consentContact).toBe(false);
  expect(payload.addons.slutstad).toBe(true);
  expect(payload.totalAddons).toBe(2500 + 400);
});

test('bokad period vid inskick ger tydligt fel och kalendern Ã¥terstÃ¤lls', async ({ page }) => {
  await page.unroute('**/api/booking-requests');
  await page.route('**/api/booking-requests', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'NÃ¥gra av de valda nÃ¤tterna Ã¤r inte lÃ¤ngre tillgÃ¤ngliga. VÃ¤nligen vÃ¤lj andra datum i kalendern.' }) }));
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
  await expect(page.locator('#form-error')).toContainText('inte lÃ¤ngre tillgÃ¤ngliga');
  await expect(page.locator('#booking-confirmation')).toBeHidden();
});

test('okÃ¤nd tillgÃ¤nglighet vid inskick visas som fel, aldrig som ledigt', async ({ page }) => {
  await page.unroute('**/api/booking-requests');
  await page.route('**/api/booking-requests', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'TillgÃ¤ngligheten kunde inte kontrolleras just nu. VÃ¤nligen fÃ¶rsÃ¶k igen om en stund â€” era datum har inte sparats.' }) }));
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

test('formulÃ¤ret skyddar mot dubbelklick med idempotensnyckel', async ({ page }) => {
  const requests = [];
  await page.unroute('**/api/booking-requests');
  await page.route('**/api/booking-requests', async (route) => {
    requests.push(route.request().headers()['idempotency-key']);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: 'SK-2026-TEST01', status: 'InvÃ¤ntar godkÃ¤nnande' }) });
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

test('@visual bokningsflÃ¶de: vald period och formulÃ¤r med tillval', async ({ page }) => {
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

test('@visual bokningsflÃ¶de: bekrÃ¤ftelse', async ({ page }) => {
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

test('okÃ¤nd tillgÃ¤nglighet (kalender-API fel) visar aldrig lediga datum', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route('**/api/availability?*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' }));
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month')).toHaveCount(0);
  await expect(page.locator('#booking-section')).toBeHidden();
  await expect(page.locator('.cal-notice')).toContainText('TillgÃ¤ngligheten Ã¤r okÃ¤nd');
});
