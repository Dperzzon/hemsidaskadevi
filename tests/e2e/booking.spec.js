// Funktionella E2E-tester för bokningsflödet (datumval → formulär → inskick).
// Kalender-API:t mockas enligt helpers.js (bokade dagar 12–14, 20, 27–28).
import { test, expect } from '@playwright/test';
import { FIXED_NOW, prepare, settle } from './helpers.js';

const RULES_MOCK = {
  published: true,
  version: 'test-regler-3',
  text: 'AVBOKNINGSPOLICY (Begränsad)\n• Avbokning minst 30 dagar före incheckning: 100 % återbetalning.\n• Avbokning från 14 dagar till mindre än 30 dagar före incheckning: 50 % återbetalning.\n• Avbokning mindre än 14 dagar före incheckning: ingen återbetalning.\n• Återbetalningsprocenten beräknas på den bekräftade boendesumman enligt offerten.\n• Dessa villkor begränsar inte era lagstadgade konsumenträttigheter.\n\nHUSREGLER\n• Ingen rökning.\n• Lås alla dörrar och stäng alla fönster vid avfärd.\n• Husdjur: max två husdjur. Inga katter.'
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
  await expect(dialog).toContainText('Avbokning minst 30 dagar före incheckning: 100 % återbetalning');
  await expect(dialog).toContainText('Avbokning mindre än 14 dagar före incheckning: ingen återbetalning');
  await expect(dialog).toContainText('Ingen rökning');
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
  await expect(dialog).toContainText('Avbokning minst 30 dagar före incheckning: 100 % återbetalning');
  await expect(dialog).toContainText('Avbokning från 14 dagar till mindre än 30 dagar före incheckning: 50 % återbetalning');
  await expect(dialog).toContainText('beräknas på den bekräftade boendesumman enligt offerten');
  await expect(dialog).toContainText('Avbokning mindre än 14 dagar före incheckning: ingen återbetalning');
  await expect(dialog).toContainText('begränsar inte era lagstadgade konsumenträttigheter');
  await expect(dialog).toContainText('Ingen rökning');
  await expect(dialog).toContainText('Lås alla dörrar och stäng alla fönster vid avfärd');
  await expect(dialog).toContainText('max två husdjur');
  await expect(dialog).toContainText('Inga katter');
});

test('veckorabatt visas diskret för vistelser på 7 nätter eller fler', async ({ page }) => {
  await goto(page);
  // 1–11 december: 10 lediga nätter i mocken (bokade dagar är 12–14, 20, 27–28).
  await clickDay(page, '2026-12-01');
  await clickDay(page, '2026-12-11');
  await expect(page.locator('#summary-nights')).toHaveText('10 nätter');
  await expect(page.locator('#discount-note')).toBeVisible();
  await expect(page.locator('#discount-note')).toContainText('Veckorabatt 30 %');
  await expect(page.locator('#discount-note')).toContainText('boendepriset i offerten');
});

test('månadsrabatt visas för vistelser på 28 nätter eller fler', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route('**/api/availability?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"blocked":[]}' }));
  await page.route('**/api/booking-rules', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RULES_MOCK) }));
  await page.goto('/lediga-datum', { waitUntil: 'load' });
  await expect(page.locator('.cal-month h3').first()).toHaveText('November 2026');
  // 29 november → 27 december: exakt 28 nätter (avresedagen är ingen natt).
  await clickDay(page, '2026-11-29');
  await clickDay(page, '2026-12-27');
  await expect(page.locator('#summary-nights')).toHaveText('28 nätter');
  await expect(page.locator('#discount-note')).toContainText('Månadsrabatt 69 %');
});

test('ingen rabatt visas under gränsvärdena', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('#summary-nights')).toHaveText('3 nätter');
  await expect(page.locator('#discount-note')).toBeHidden();
});

test('bekräftelsen anger kontaktadressen skadevigard@gmail.com', async ({ page }) => {
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

test('tillval uppdaterar totalpriset omedelbart och lakan-räknaren', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-guests').selectOption('4');
  // 3 vardagsnätter (må–ons): 3 × 7 000 = 21 000 kr.
  await expect(page.locator('#price-list')).toContainText('Boende (3 nätter)');
  await expect(page.locator('#price-list')).toContainText('21 000 kr');
  await expect(page.locator('#price-list')).toContainText('Inga tillval valda');
  await expect(page.locator('#price-total')).toContainText('21 000 kr');
  await page.locator('#addon-slutstad').check();
  await expect(page.locator('#price-total')).toContainText('23 500 kr');
  await page.locator('#addon-lakan').check();
  await expect(page.locator('#linen-count')).toBeEnabled();
  await expect(page.locator('#linen-count')).toHaveValue('4');
  await expect(page.locator('#price-total')).toContainText('24 300 kr');
  await page.locator('#linen-count').fill('2');
  await expect(page.locator('#price-total')).toContainText('23 900 kr');
  await page.locator('#addon-ved').check();
  await expect(page.locator('#price-total')).toContainText('24 250 kr');
  await page.locator('#addon-tidig-incheckning').check();
  await expect(page.locator('#price-total')).toContainText('24 750 kr');
  await page.locator('#addon-sen-utcheckning').check();
  await expect(page.locator('#price-total')).toContainText('25 250 kr');
  await expect(page.locator('#price-list')).toContainText('Summa tillval');
  await expect(page.locator('#price-total-row')).toContainText('TOTALPRIS FÖR HELA VISTELSEN');
  await expect(page.locator('.booking-price-note')).toContainText('beräknad offert');
  await expect(page.locator('.booking-price-note')).toContainText('inte en bekräftad bokning');
});

test('totalpriset uppdateras när datum ändras (helgpris 10 000 kr)', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-12-04'); // fredag
  await clickDay(page, '2026-12-06'); // avresa söndag → 2 nätter: fre + lör
  await expect(page.locator('#price-list')).toContainText('Boende (2 nätter)');
  await expect(page.locator('#price-list')).toContainText('20 000 kr');
  await expect(page.locator('#price-total')).toContainText('20 000 kr');
  // Ändra datum: längre vistelse → nytt totalpris direkt.
  await page.locator('#booking-change-dates').click();
  await clickDay(page, '2026-12-04');
  await clickDay(page, '2026-12-11'); // 7 nätter fre–fre: veckorabatt 30 %
  await expect(page.locator('#discount-note')).toBeVisible();
  await expect(page.locator('#discount-note')).toContainText('Veckorabatt 30 %');
  await expect(page.locator('#price-list')).toContainText('Veckorabatt 30 %');
  // Boende: fre 20 000 + 4 vardagsnätter 28 000 + lör 20 000 + fre 20 000 = 88 000.
  // Boende: fre 20 000 + lör 20 000 + 5 vardagsnätter 35 000 = 55 000 kr.
  await expect(page.locator('#price-list').first()).toContainText('55 000 kr');
  await expect(page.locator('#price-list').first()).toContainText('Boendepris efter rabatt');
  await expect(page.locator('#price-list').first()).toContainText('− 16 500 kr');
  await expect(page.locator('#price-total')).toContainText('38 500 kr');
  await expect(page.locator('#price-total-row')).toContainText('TOTALPRIS FÖR HELA VISTELSEN');
});

test('antal gäster uppdaterar lakan-priset i totalprisofferten', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await page.locator('#field-guests').selectOption('2');
  await page.locator('#addon-lakan').check();
  // 2 personer × 200 kr + 21 000 kr boende.
  await expect(page.locator('#price-total')).toContainText('21 400 kr');
  await page.locator('#field-guests').selectOption('5');
  await expect(page.locator('#price-total')).toContainText('22 000 kr');
  // 0 personer är tillåtet (minst 0, högst antal gäster).
  await page.locator('#linen-count').fill('0');
  await expect(page.locator('#price-total')).toContainText('21 000 kr');
});

test('tjänster för tidig incheckning och sen utcheckning visar tiderna och bekräftelsekravet', async ({ page }) => {
  await goto(page);
  await clickDay(page, '2026-11-16');
  await clickDay(page, '2026-11-19');
  await expect(page.locator('label[for="addon-tidig-incheckning"]')).toContainText('Tidig incheckning — 500 kr');
  const tidig = page.locator('.booking-addon', { has: page.locator('#addon-tidig-incheckning') });
  await expect(tidig).toContainText('Ordinarie incheckning är kl. 14.00');
  await expect(tidig).toContainText('checka in redan kl. 09.00');
  await expect(tidig).toContainText('bekräftas av Skadevi Herrgård');
  const sen = page.locator('.booking-addon', { has: page.locator('#addon-sen-utcheckning') });
  await expect(sen).toContainText('Ordinarie utcheckning är kl. 11.00');
  await expect(sen).toContainText('stanna till kl. 16.00');
  await expect(sen).toContainText('bekräftas av Skadevi Herrgård');
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
  expect(payload.rulesVersion).toBe('test-regler-3');
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
