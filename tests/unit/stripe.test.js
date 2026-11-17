'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStripeClient,
  verifyStripeSignature,
  parseStripeEvent,
  signStripePayload,
  stripeKeyMode,
  StripeSignatureError
} = require('../../server/booking/stripe');

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload)
  };
}

test('Stripe-nyckelns läge härleds och live blockeras utan uttryckligt godkännande', () => {
  assert.equal(stripeKeyMode('sk_test_123'), 'test');
  assert.equal(stripeKeyMode('rk_test_123'), 'test');
  assert.equal(stripeKeyMode('rkcs_test_123'), 'test');
  assert.equal(stripeKeyMode('sk_live_123'), 'live');
  assert.equal(stripeKeyMode('rk_live_123'), 'live');
  assert.equal(stripeKeyMode('pk_test_123'), '');
  assert.throws(
    () => createStripeClient({ secretKey: 'sk_live_123', fetchImpl: async () => fakeResponse({}) }),
    /Live-nyckel är blockerad/
  );
  assert.equal(
    createStripeClient({ secretKey: 'sk_live_123', allowLive: true, fetchImpl: async () => fakeResponse({}) }).mode,
    'live'
  );
  assert.throws(() => createStripeClient({ secretKey: 'pk_test_123' }), /okänt format/);
  assert.throws(() => createStripeClient({ secretKey: '' }), /inte konfigurerat/);
});

test('Checkout-session skickas med serverbelopp, metadata och idempotensnyckel', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return fakeResponse({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      amount_total: 250000,
      currency: 'sek',
      mode: 'payment',
      payment_status: 'unpaid',
      livemode: false,
      expires_at: 1800000000,
      metadata: { reference: 'SK-2026-TEST01' }
    });
  };
  const client = createStripeClient({ secretKey: 'sk_test_123', fetchImpl });
  const session = await client.createCheckoutSession({
    amountOre: 250000,
    currency: 'sek',
    reference: 'SK-2026-TEST01',
    customerEmail: 'gast@example.se',
    successUrl: 'https://www.skadeviherrgard.com/betalning-klar?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://www.skadeviherrgard.com/betalning-avbruten',
    idempotencyKey: 'idem-123',
    metadata: { source: 'skadevi-admin' }
  });
  assert.equal(session.id, 'cs_test_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_123');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'idem-123');
  const body = calls[0].init.body;
  assert.match(body, /mode=payment/);
  assert.match(body, /allowed_payment_method_types%5B0%5D=card/);
  assert.doesNotMatch(body, /(?:^|&)payment_method_types%5B0%5D/);
  assert.match(body, /unit_amount%5D=250000/);
  assert.match(body, /currency%5D=sek/);
  assert.match(body, /client_reference_id=SK-2026-TEST01/);
  assert.match(body, /metadata%5Breference%5D=SK-2026-TEST01/);
  assert.match(body, /metadata%5BpaymentMethod%5D=card/);
  assert.match(body, /customer_email=gast%40example.se/);
});

test('Checkout-session kräver HTTPS och ett positivt heltalsbelopp', async () => {
  const client = createStripeClient({
    secretKey: 'sk_test_123',
    fetchImpl: async () => fakeResponse({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' })
  });
  await assert.rejects(
    () => client.createCheckoutSession({
      amountOre: 0,
      reference: 'SK-2026-TEST',
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel'
    }),
    /Betalningsbeloppet är ogiltigt/
  );
  await assert.rejects(
    () => client.createCheckoutSession({
      amountOre: 100,
      reference: 'SK-2026-TEST',
      successUrl: 'http://example.com/ok',
      cancelUrl: 'https://example.com/cancel'
    }),
    /måste använda HTTPS/
  );
  await assert.rejects(
    () => client.createCheckoutSession({
      amountOre: 100,
      currency: 'sek',
      paymentMethods: ['klarna'],
      reference: 'SK-2026-TEST',
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel'
    }),
    /Betalmetoden är inte tillåten/
  );
  await assert.rejects(
    () => client.createCheckoutSession({
      amountOre: 100,
      currency: 'sek',
      paymentMethods: ['swish'],
      reference: 'SK-2026-TEST',
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel'
    }),
    /Swish är avstängt/
  );
  await assert.rejects(
    () => client.createCheckoutSession({
      amountOre: 100,
      currency: 'eur',
      paymentMethods: ['card'],
      reference: 'SK-2026-TEST',
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel'
    }),
    /Betalningen kräver valutan SEK/
  );
});

test('Swish kan aktiveras med funktionsflaggan och skickas då som tillåten metod', async () => {
  const calls = [];
  const client = createStripeClient({
    secretKey: 'sk_test_123',
    swishEnabled: true,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return fakeResponse({
        id: 'cs_test_swish',
        url: 'https://checkout.stripe.com/c/pay/cs_test_swish',
        amount_total: 100,
        currency: 'sek',
        mode: 'payment',
        payment_method_types: ['swish'],
        livemode: false,
        expires_at: 1800000000
      });
    }
  });
  const session = await client.createCheckoutSession({
    amountOre: 100,
    currency: 'sek',
    paymentMethods: ['swish'],
    reference: 'SK-2026-SWISH',
    successUrl: 'https://example.com/ok',
    cancelUrl: 'https://example.com/cancel'
  });
  assert.equal(session.id, 'cs_test_swish');
  assert.match(calls[0].init.body, /allowed_payment_method_types%5B0%5D=swish/);
});

test('Stripe-signaturen verifieras med HMAC, tidsfönster och flera v1-värden', () => {
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const secret = 'whsec_test';
  const nowSeconds = 1800000000;
  const header = signStripePayload(payload, secret, nowSeconds);
  assert.equal(verifyStripeSignature(payload, header, secret, { now: nowSeconds * 1000 }), true);
  assert.equal(verifyStripeSignature(payload, `t=${nowSeconds},v1=bad,v1=${header.split('v1=')[1]}`, secret, {
    now: nowSeconds * 1000
  }), true);
  assert.throws(
    () => verifyStripeSignature(payload, header, 'whsec_fel', { now: nowSeconds * 1000 }),
    StripeSignatureError
  );
  assert.throws(
    () => verifyStripeSignature(payload, header, secret, { now: (nowSeconds + 301) * 1000 }),
    /gått ut/
  );
  assert.throws(() => verifyStripeSignature(payload, 't=abc,v1=00', secret), /fel format/);
  assert.throws(() => verifyStripeSignature(payload, header, ''), /inte konfigurerad/);
});

test('parseStripeEvent kräver giltig signatur och ett event med id och typ', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
  const secret = 'whsec_test';
  const nowSeconds = 1800000000;
  const header = signStripePayload(payload, secret, nowSeconds);
  const event = parseStripeEvent(payload, header, secret, { now: nowSeconds * 1000 });
  assert.equal(event.id, 'evt_1');
  assert.equal(event.type, 'checkout.session.completed');
  assert.throws(
    () => parseStripeEvent('{}', header, secret, { now: nowSeconds * 1000 }),
    StripeSignatureError
  );
  assert.throws(
    () => parseStripeEvent(JSON.stringify({ type: 'x' }), signStripePayload('{"type":"x"}', secret, nowSeconds), secret, {
      now: nowSeconds * 1000
    }),
    /saknar id eller typ/
  );
});
