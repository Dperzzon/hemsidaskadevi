'use strict';

// Kontrollerar att GTM/GA4-installationen är en enda gemensam implementation,
// att Consent Mode v2 är nekat som standard och att köpdata är säker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const { renderAnalyticsHead, renderPurchaseEvent, GTM_ID, GA4_MEASUREMENT_ID } =
  require('../../shared/analytics.js');

test('GTM-ID och GA4-ID är de beslutade', () => {
  assert.equal(GTM_ID, 'GTM-WN83FQXJ');
  assert.equal(GA4_MEASUREMENT_ID, 'G-NBQB2HKDYF');
});

test('head-innehållet laddar endast GTM-skriptet från egen domän', () => {
  const head = renderAnalyticsHead();
  assert.match(head, /data-gtm="GTM-WN83FQXJ"/);
  assert.match(head, /data-ga4="G-NBQB2HKDYF"/);
  assert.match(head, /<script src="\/js\/analytics\.js"/);
  assert.doesNotMatch(head, /<script>/);
  assert.doesNotMatch(head, /<\/?noscript/i);

  const runtime = fs.readFileSync(path.join(root, 'public', 'js', 'analytics.js'), 'utf8');
  assert.match(runtime, /googletagmanager\.com\/gtm\.js/);
  assert.match(runtime, /analytics_storage: 'denied'/);
  assert.match(runtime, /ad_storage: 'denied'/);
  assert.match(runtime, /ad_user_data: 'denied'/);
  assert.match(runtime, /ad_personalization: 'denied'/);
  assert.match(runtime, /if \(hasConsent\(\)\)/);
  // Ingen separat GA4-installation (gtag.js) och ingen direkt GA4-konfiguration.
  assert.doesNotMatch(runtime, /googletagmanager\.com\/gtag\/js/);
  assert.doesNotMatch(runtime, /gtag\('config'/);
});

test('köpdata begränsas till verifierade fält och kan inte injicera HTML', () => {
  const html = renderPurchaseEvent({
    transaction_id: 'SKD-2026-1234',
    value: 12500.5,
    currency: 'SEK',
    email: 'gast@example.com',
    name: 'Hemligt Namn'
  });
  assert.match(html, /"transaction_id":"SKD-2026-1234"/);
  assert.match(html, /"value":12500.5/);
  assert.match(html, /"currency":"SEK"/);
  assert.doesNotMatch(html, /gast@example\.com/);
  assert.doesNotMatch(html, /Hemligt Namn/);
});

test('köpdata avvisas utan giltig transaktion, belopp eller valuta', () => {
  assert.equal(renderPurchaseEvent(null), '');
  assert.equal(renderPurchaseEvent({ transaction_id: '<script>', value: 10 }), '');
  assert.equal(renderPurchaseEvent({ transaction_id: 'SKD-1', value: 0 }), '');
  assert.equal(renderPurchaseEvent({ transaction_id: 'SKD-1', value: 10, currency: 'EUR' }), '');
});

test('alla publika sidor har exakt en GTM-installation och ingen noscript-iframe', () => {
  const pages = [
    'src/index.html',
    'src/404.html',
    ...fs.readdirSync(path.join(root, 'src', 'pages'))
      .filter((name) => name.endsWith('.html'))
      .map((name) => `src/pages/${name}`)
  ];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /data-gtm="GTM-WN83FQXJ"/, `${page} saknar GTM`);
    assert.equal((html.match(/<script src="\/js\/analytics\.js"/g) || []).length, 1, `${page} har dubbel analytics.js`);
    assert.doesNotMatch(html, /googletagmanager\.com\/ns\.html/i, `${page} har noscript-iframe`);
    assert.ok(html.indexOf('<meta charset="UTF-8">') < html.indexOf('SKADEVI ANALYTICS START'), `${page} har analys före charset`);
  }
});

test('serverrenderade betalningssidor använder samma analysdel', () => {
  const { handlePaymentResult } = require('../../server/booking/payment-result.js');
  const { renderPaymentPage } = require('../../server/booking/payment-page.js');
  const { layout } = require('../../server/booking/payment-page.js');
  assert.equal(typeof handlePaymentResult, 'function');
  const page = renderPaymentPage(
    { reference: 'SKD-1', arrival: '2026-12-01', departure: '2026-12-03' },
    'x'.repeat(43),
    { totalOre: 1000, paidOre: 0, remainingOre: 1000 },
    { stripeEnabled: true, cardEnabled: true }
  );
  assert.match(page.html, /GTM-WN83FQXJ/);
  assert.match(page.html, /data-analytics-checkout="card"/);
  const custom = layout('Test', '<p>Test</p>', { purchase: { transaction_id: 'SKD-1', value: 10, currency: 'SEK' } });
  assert.match(custom, /data-analytics-purchase/);
});

test('purchase skickas bara för verifierad, bekräftad betalning', () => {
  const { renderSuccess, renderSuccessProcessing, renderSuccessUnknown } =
    require('../../server/booking/payment-result.js');
  const record = { reference: 'SKD-2026-1234', arrival: '2026-12-01', departure: '2026-12-03' };
  const verified = renderSuccess(record, { amount_total: 125000, payment_status: 'paid' });
  assert.match(verified.html, /data-analytics-purchase/);
  assert.match(verified.html, /"transaction_id":"SKD-2026-1234"/);
  assert.match(verified.html, /"value":1250/);
  assert.match(verified.html, /"currency":"SEK"/);

  assert.doesNotMatch(renderSuccessProcessing(record, true).html, /data-analytics-purchase/);
  assert.doesNotMatch(renderSuccessProcessing(record, false).html, /data-analytics-purchase/);
  assert.doesNotMatch(renderSuccessUnknown().html, /data-analytics-purchase/);
});
