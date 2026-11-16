'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleStripeWebhook } = require('../../server/booking/stripe-webhook');
const { applyStripePayment } = require('../../server/booking/payment-ledger');
const { signStripePayload } = require('../../server/booking/stripe');

const NOW = new Date('2026-11-16T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SECRET = 'whsec_test_skadevi';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function paymentRequest(overrides = {}) {
  return {
    provider: 'stripe',
    mode: 'test',
    status: 'OPEN',
    sessionId: 'cs_test_pay01',
    url: 'https://checkout.stripe.com/c/pay/cs_test_pay01',
    amountOre: 2000000,
    currency: 'sek',
    createdAt: '2026-11-16T11:00:00.000Z',
    expiresAt: '2026-11-17T11:00:00.000Z',
    createdBy: 'Anna',
    createdById: 'oid-owner',
    idempotencyKey: 'pay-request-1',
    ...overrides
  };
}

function bookingRecord(overrides = {}) {
  const request = paymentRequest(overrides.paymentRequest);
  return {
    reference: 'SK-2026-PAY01',
    statusCode: 'CONFIRMED',
    status: 'Bekräftad',
    arrival: '2027-01-10',
    departure: '2027-01-12',
    nights: 2,
    guests: 4,
    firstName: 'Betal',
    lastName: 'Test',
    email: 'betal@example.se',
    phone: '+46 70 123 45 67',
    total: 20000,
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    balance: 20000,
    payments: [],
    paymentRequests: [request],
    paymentRequest: request,
    version: 1,
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
    paymentRequests: overrides.paymentRequests ?? [request],
    paymentRequest: overrides.paymentRequestValue ?? request
  };
}

function createMemoryStore(record) {
  let current = clone(record);
  let etag = 'etag-1';
  const history = [];
  const outbox = [];
  return {
    type: 'memory',
    async getByReference(reference) {
      if (current.reference !== reference) return null;
      return { record: clone(current), etag };
    },
    async updateRequest(next, { ifMatch } = {}) {
      if (ifMatch && ifMatch !== etag) {
        const error = new Error('ETag-konflikt');
        error.status = 409;
        throw error;
      }
      current = clone(next);
      etag = `etag-${Number(etag.split('-')[1]) + 1}`;
      return { record: clone(current), etag };
    },
    async appendHistory(entry) {
      if (history.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
        const error = new Error('finns redan');
        error.status = 409;
        throw error;
      }
      history.push(clone(entry));
    },
    async save(entry) {
      if (outbox.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
        return { duplicate: true, record: entry };
      }
      outbox.push(clone(entry));
      return { duplicate: false, record: entry };
    },
    get current() { return clone(current); },
    history,
    outbox
  };
}

function session(overrides = {}) {
  return {
    id: 'cs_test_pay01',
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 2000000,
    currency: 'sek',
    payment_method_types: ['swish'],
    livemode: false,
    payment_intent: 'pi_test_123',
    client_reference_id: 'SK-2026-PAY01',
    metadata: { reference: 'SK-2026-PAY01' },
    ...overrides
  };
}

function event(type = 'checkout.session.completed', object = session(), overrides = {}) {
  return {
    id: 'evt_test_1',
    type,
    livemode: false,
    data: { object },
    ...overrides
  };
}

async function callWebhook(store, eventObject, options = {}) {
  const payload = JSON.stringify(eventObject);
  const signature = signStripePayload(payload, SECRET, NOW_SECONDS);
  return handleStripeWebhook(
    { rawBody: Buffer.from(payload), signature },
    { warn: () => {} },
    {
      enabled: true,
      webhookSecret: SECRET,
      store,
      now: NOW,
      outboxEnabled: true,
      ...options
    }
  );
}

test('betald Swish-session registreras idempotent som Swish-betalning', async () => {
  const store = createMemoryStore(bookingRecord());
  const response = await callWebhook(store, event());
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.received, true);
  assert.equal(response.jsonBody.duplicate, false);

  const record = store.current;
  assert.equal(record.payments.length, 1);
  assert.equal(record.payments[0].method, 'SWISH');
  assert.equal(record.payments[0].methodLabel, 'Swish');
  assert.equal(record.payments[0].amountOre, 2000000);
  assert.equal(record.payments[0].stripeSessionId, 'cs_test_pay01');
  assert.equal(record.payments[0].stripeEventId, 'evt_test_1');
  assert.equal(record.amountPaid, 20000);
  assert.equal(record.balance, 0);
  assert.equal(record.paymentStatus, 'PAID');
  assert.equal(record.paymentRequest.status, 'PAID');
  assert.equal(record.paymentRequest.reviewRequired, '');
  assert.equal(record.statusCode, 'CONFIRMED');
  assert.equal(record.version, 2);
  assert.equal(record.updatedBy, 'Stripe');

  assert.equal(store.history.length, 1);
  assert.equal(store.history[0].action, 'SWISH_PAYMENT_RECEIVED');
  assert.equal(store.history[0].actorName, 'Stripe');
  assert.equal(store.outbox.length, 2);
  assert.deepEqual(
    store.outbox.map((row) => row.mailType).sort(),
    ['GUEST_PAYMENT_RECEIPT', 'HOST_PAYMENT_RECEIVED']
  );
  assert.ok(store.outbox.every((row) => row.reference === 'SK-2026-PAY01'));
  assert.ok(store.outbox.every((row) => !row.mailHtml.includes('pi_test_123')));
});

test('samma Stripe-session och event skapar aldrig dubbel betalning eller dubbel utkorg', async () => {
  const store = createMemoryStore(bookingRecord());
  const first = await callWebhook(store, event());
  const second = await callWebhook(store, event());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.duplicate, true);
  assert.equal(store.current.payments.length, 1);
  assert.equal(store.current.amountPaid, 20000);
  assert.equal(store.history.length, 1);
  assert.equal(store.outbox.length, 2);
});

test('ogiltig signatur avvisas utan att röra bokningen', async () => {
  const store = createMemoryStore(bookingRecord());
  const response = await handleStripeWebhook(
    { rawBody: Buffer.from('{"id":"evt_bad","type":"checkout.session.completed"}'), signature: 't=1,v1=00' },
    { warn: () => {} },
    { enabled: true, webhookSecret: SECRET, store, now: NOW, outboxEnabled: true }
  );
  assert.equal(response.status, 400);
  assert.equal(store.current.payments.length, 0);
  assert.equal(store.history.length, 0);
  assert.equal(store.outbox.length, 0);
});

test('webhook är fail-closed när den är avstängd eller saknar hemlighet', async () => {
  const store = createMemoryStore(bookingRecord());
  const disabled = await callWebhook(store, event(), { enabled: false });
  assert.equal(disabled.status, 503);
  assert.equal(store.current.payments.length, 0);

  const missingSecret = await callWebhook(store, event(), { webhookSecret: '' });
  assert.equal(missingSecret.status, 503);
  assert.equal(store.current.payments.length, 0);
});

test('okänd referens ignoreras och fel belopp registreras med granskningsvarning', async () => {
  const unknownStore = createMemoryStore(bookingRecord());
  const unknown = await callWebhook(unknownStore, event('checkout.session.completed', session({
    client_reference_id: 'SK-2026-UNKNOWN',
    metadata: { reference: 'SK-2026-UNKNOWN' }
  })));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.jsonBody.ignored, 'unknown_reference');
  assert.equal(unknownStore.current.payments.length, 0);

  const amountStore = createMemoryStore(bookingRecord());
  const amount = await callWebhook(amountStore, event('checkout.session.completed', session({
    amount_total: 100
  })));
  assert.equal(amount.status, 200);
  assert.equal(amount.jsonBody.received, true);
  assert.equal(amountStore.current.payments.length, 1);
  assert.equal(amountStore.current.payments[0].amountOre, 100);
  assert.match(amountStore.current.paymentRequest.reviewRequired, /avviker/);
  assert.equal(amountStore.current.paymentStatus, 'PARTIALLY_PAID');

  const referenceStore = createMemoryStore(bookingRecord());
  const mismatch = await callWebhook(referenceStore, event('checkout.session.completed', session({
    client_reference_id: 'SK-2026-OTHER',
    metadata: { reference: 'SK-2026-OTHER' }
  })));
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.jsonBody.ignored, 'unknown_reference');
  assert.equal(referenceStore.current.payments.length, 0);

  const direct = applyStripePayment(bookingRecord(), session({
    client_reference_id: 'SK-2026-OTHER',
    metadata: { reference: 'SK-2026-OTHER' }
  }), { now: NOW, eventId: 'evt_direct' });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'reference_mismatch');
});

test('obetald, fel valuta och fel läge ignoreras', async () => {
  const unpaidStore = createMemoryStore(bookingRecord());
  const unpaid = await callWebhook(unpaidStore, event('checkout.session.completed', session({
    payment_status: 'unpaid'
  })));
  assert.equal(unpaid.status, 200);
  assert.equal(unpaid.jsonBody.ignored, 'not_paid');
  assert.equal(unpaidStore.current.payments.length, 0);

  const currencyStore = createMemoryStore(bookingRecord());
  const currency = await callWebhook(currencyStore, event('checkout.session.completed', session({
    currency: 'eur'
  })));
  assert.equal(currency.status, 200);
  assert.equal(currency.jsonBody.ignored, 'currency_mismatch');
  assert.equal(currencyStore.current.payments.length, 0);

  const modeStore = createMemoryStore(bookingRecord());
  const mode = await callWebhook(modeStore, event('checkout.session.completed', session({
    livemode: true
  })));
  assert.equal(mode.status, 200);
  assert.equal(mode.jsonBody.ignored, 'mode_mismatch');
  assert.equal(modeStore.current.payments.length, 0);
});

test('annan betalmetod registreras med granskningsvarning', async () => {
  const store = createMemoryStore(bookingRecord());
  const response = await callWebhook(store, event('checkout.session.completed', session({
    payment_method_types: ['card']
  })));
  assert.equal(response.status, 200);
  assert.equal(store.current.payments.length, 1);
  assert.equal(store.current.payments[0].method, 'OTHER');
  assert.match(store.current.paymentRequest.reviewRequired, /annan betalmetod än Swish/);
  assert.match(
    store.outbox.find((row) => row.mailType === 'HOST_PAYMENT_RECEIVED').mailText,
    /VARNING/
  );
});

test('utgången Checkout-session markerar betalningsbegäran som utgången', async () => {
  const store = createMemoryStore(bookingRecord());
  const response = await callWebhook(store, event('checkout.session.expired', session({
    payment_status: 'unpaid',
    status: 'expired'
  })));
  assert.equal(response.status, 200);
  assert.equal(store.current.paymentRequest.status, 'EXPIRED');
  assert.equal(store.current.payments.length, 0);
  assert.equal(store.history.length, 1);
  assert.equal(store.history[0].action, 'STRIPE_PAYMENT_REQUEST_EXPIRED');
});

test('betalning på avbokad bokning registreras med granskningsvarning', async () => {
  const store = createMemoryStore(bookingRecord({
    statusCode: 'CANCELLED',
    status: 'Avbokad',
    cancelledAt: '2026-11-15T10:00:00.000Z'
  }));
  const response = await callWebhook(store, event());
  assert.equal(response.status, 200);
  assert.equal(store.current.paymentStatus, 'PAID');
  assert.match(store.current.paymentRequest.reviewRequired, /CANCELLED/);
  assert.ok(store.outbox.some((row) => row.mailType === 'HOST_PAYMENT_RECEIVED'));
  assert.match(
    store.outbox.find((row) => row.mailType === 'HOST_PAYMENT_RECEIVED').mailText,
    /VARNING/
  );
});
