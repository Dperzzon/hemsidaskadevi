'use strict';

// Kontrollerar att GTM/GA4-installationen är en enda gemensam implementation,
// att Consent Mode v2 är nekat som standard och att köpdata är säker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const {
  renderAnalyticsHead,
  renderPurchaseEvent,
  buildPurchaseEvent,
  createAnalyticsTransactionId,
  GTM_ID,
  GA4_MEASUREMENT_ID
} = require('../../shared/analytics.js');

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
  const record = {
    reference: 'SK-2026-1234',
    statusCode: 'CONFIRMED',
    total: 1250,
    arrival: '2026-12-01',
    departure: '2026-12-03'
  };
  const verified = renderSuccess(record, { amount_total: 125000, payment_status: 'paid', currency: 'sek', mode: 'payment' });
  assert.match(verified.html, /data-analytics-purchase/);
  const transactionId = createAnalyticsTransactionId(record.reference);
  assert.match(verified.html, new RegExp(`"transaction_id":"${transactionId}"`));
  assert.doesNotMatch(verified.html, new RegExp(`"transaction_id":"${record.reference}"`));
  assert.match(verified.html, /"value":1250/);
  assert.match(verified.html, /"currency":"SEK"/);

  assert.doesNotMatch(renderSuccessProcessing(record, true).html, /data-analytics-purchase/);
  assert.doesNotMatch(renderSuccessProcessing(record, false).html, /data-analytics-purchase/);
  assert.doesNotMatch(renderSuccessUnknown().html, /data-analytics-purchase/);
});

test('transaktions-ID är stabilt, icke-reversibelt och innehåller ingen referens', () => {
  const reference = 'SK-2026-ABC234';
  const first = createAnalyticsTransactionId(reference);
  const second = createAnalyticsTransactionId(reference);
  assert.equal(first, second);
  assert.match(first, /^skd-[0-9a-f]{40}$/);
  assert.notEqual(first, reference);
  assert.doesNotMatch(first, /SK-2026|ABC234/i);
  assert.notEqual(createAnalyticsTransactionId('SK-2026-OTHER1'), first);
  assert.equal(createAnalyticsTransactionId('x'), '');
});

test('buildPurchaseEvent kräver CONFIRMED, betald SEK-session och rimligt belopp', () => {
  const record = { reference: 'SK-2026-ABC234', statusCode: 'CONFIRMED', total: 16000 };
  const paid = {
    id: 'cs_test_1',
    mode: 'payment',
    livemode: false,
    payment_status: 'paid',
    amount_total: 1600000,
    currency: 'sek',
    metadata: { reference: record.reference }
  };
  const event = buildPurchaseEvent(record, paid);
  assert.deepEqual(event, {
    transaction_id: createAnalyticsTransactionId(record.reference),
    value: 16000,
    currency: 'SEK'
  });

  assert.equal(buildPurchaseEvent({ ...record, statusCode: 'RECONCILIATION' }, paid), null);
  assert.equal(buildPurchaseEvent({ ...record, statusCode: 'PENDING_PAYMENT' }, paid), null);
  assert.equal(buildPurchaseEvent(record, { ...paid, payment_status: 'unpaid' }), null);
  assert.equal(buildPurchaseEvent(record, { ...paid, currency: 'eur' }), null);
  assert.equal(buildPurchaseEvent(record, { ...paid, mode: 'subscription' }), null);
  assert.equal(buildPurchaseEvent(record, { ...paid, amount_total: 0 }), null);
  assert.equal(buildPurchaseEvent(record, { ...paid, amount_total: 1600001 }), null);
  assert.equal(buildPurchaseEvent(record, { ...paid, metadata: { reference: 'SK-2026-WRONG1' } }), null);
});

test('buildPurchaseEvent använder bokningens totalbelopp en gång per bokning', () => {
  const record = { reference: 'SK-2026-ABC234', statusCode: 'CONFIRMED', total: 20000 };
  const deposit = {
    id: 'cs_test_deposit',
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 500000,
    currency: 'sek',
    metadata: { reference: record.reference }
  };
  const finalPayment = { ...deposit, id: 'cs_test_final', amount_total: 1500000 };
  const first = buildPurchaseEvent(record, deposit);
  const second = buildPurchaseEvent(record, finalPayment);
  assert.equal(first.transaction_id, second.transaction_id);
  assert.equal(first.value, 20000);
  assert.equal(second.value, 20000);
});

test('buildPurchaseEvent faller tillbaka på Stripe-beloppet när total saknas', () => {
  const record = { reference: 'SK-2026-ABC234', statusCode: 'CONFIRMED' };
  const event = buildPurchaseEvent(record, {
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 1600050,
    currency: 'sek',
    metadata: { reference: record.reference }
  });
  assert.equal(event.value, 16000.5);
});
