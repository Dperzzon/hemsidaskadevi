'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handlePaymentPage,
  handlePaymentAction
} = require('../../server/booking/payment-page');
const {
  createPaymentAccess,
  nightKeys
} = require('../../server/booking/payment-access');
const { StripeError } = require('../../server/booking/stripe');

const NOW = new Date('2026-11-16T12:00:00.000Z');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRecord(overrides = {}) {
  const access = createPaymentAccess({
    now: NOW,
    ttlMs: 24 * 60 * 60 * 1000,
    createdBy: 'Anna Owner',
    createdById: 'oid-owner'
  });
  return {
    record: {
      reference: 'SK-2026-SWISH1',
      statusCode: 'CONFIRMED',
      status: 'Bekräftad',
      arrival: '2027-05-10',
      departure: '2027-05-13',
      nights: 3,
      guests: 4,
      firstName: 'Swish',
      lastName: 'Test',
      email: 'swish@example.se',
      company: '',
      total: 20000,
      amountPaid: 0,
      paymentStatus: 'UNPAID',
      balance: 20000,
      payments: [],
      paymentRequests: [],
      invoiceRequests: [],
      paymentAccess: access.access,
      paymentTokenHash: access.tokenHash,
      version: 1,
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T10:00:00.000Z',
      ...overrides
    },
    token: access.token,
    access: access.access
  };
}

function makeStore(record) {
  let current = clone(record);
  let etag = 'etag-1';
  const outbox = [];
  const history = [];
  return {
    async getByPaymentTokenHash(hash) {
      if (current.paymentTokenHash !== hash) return null;
      return { record: clone(current), etag };
    },
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
    async listCalendarByReference(reference) {
      if (current.reference !== reference) return null;
      return nightKeys(current.arrival, current.departure).map((night) => ({
        night,
        type: 'BOOKING',
        reference
      }));
    },
    async listCalendar(from, to) {
      return nightKeys(from, to).map((night) => ({
        night,
        type: 'BOOKING',
        reference: current.reference
      }));
    },
    async save(entry) {
      if (outbox.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
        return { duplicate: true, record: entry };
      }
      outbox.push(clone(entry));
      return { duplicate: false, record: entry };
    },
    async appendHistory(entry) {
      if (history.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
        const error = new Error('finns redan');
        error.status = 409;
        throw error;
      }
      history.push(clone(entry));
    },
    get current() { return clone(current); },
    outbox,
    history
  };
}

function fakeStripe(overrides = {}) {
  const calls = [];
  return {
    mode: overrides.mode ?? 'test',
    calls,
    async createCheckoutSession(input) {
      calls.push(input);
      if (overrides.error) throw overrides.error;
      return {
        id: overrides.id ?? 'cs_test_card1',
        url: overrides.url ?? 'https://checkout.stripe.com/c/pay/cs_test_card1',
        amount_total: overrides.amountTotal ?? input.amountOre,
        currency: overrides.currency ?? 'sek',
        mode: 'payment',
        payment_method_types: overrides.paymentMethodTypes ?? [input.paymentMethods?.[0] ?? 'card'],
        livemode: false,
        payment_intent: 'pi_test_card1',
        expires_at: Math.floor(NOW.getTime() / 1000) + 86400,
        client_reference_id: input.reference,
        metadata: { reference: input.reference },
        ...overrides.session
      };
    },
    async expireCheckoutSession() {
      return {};
    }
  };
}

function options(store, stripe, overrides = {}) {
  return {
    store,
    stripeEnabled: true,
    stripeClient: stripe,
    publicBaseUrl: 'https://www.skadeviherrgard.com',
    outboxEnabled: true,
    now: NOW,
    ...overrides
  };
}

test('betalningssidan visar endast kort och faktura med korrekt utestående belopp', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const response = await handlePaymentPage({ token, query: {} }, {}, options(store, fakeStripe()));
  assert.equal(response.status, 200);
  const html = response.html;
  assert.match(html, /Betala med kort/);
  assert.match(html, /Begär faktura/);
  assert.match(html, /Att betala/);
  assert.match(html, /20\s?000/);
  assert.doesNotMatch(html, /Betala med Swish/);
  assert.doesNotMatch(html, /Klarna/i);
  assert.match(html, /noindex/);
  assert.match(response.headers['Referrer-Policy'], /no-referrer/);
});

test('betalningssidan kräver en giltig, aktiv och bekräftad länk', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const invalid = await handlePaymentPage({ token: 'x'.repeat(43), query: {} }, {}, options(store, fakeStripe()));
  assert.equal(invalid.status, 404);
  assert.doesNotMatch(invalid.html, /SK-2026-SWISH1/);

  const expiredRecord = clone(record);
  expiredRecord.paymentAccess.expiresAt = '2026-11-15T12:00:00.000Z';
  const expiredStore = makeStore(expiredRecord);
  const expired = await handlePaymentPage({ token, query: {} }, {}, options(expiredStore, fakeStripe()));
  assert.equal(expired.status, 410);

  const revokedRecord = clone(record);
  revokedRecord.paymentAccess.revokedAt = '2026-11-15T12:00:00.000Z';
  const revokedStore = makeStore(revokedRecord);
  const revoked = await handlePaymentPage({ token, query: {} }, {}, options(revokedStore, fakeStripe()));
  assert.equal(revoked.status, 410);

  const preliminary = makeRecord({ statusCode: 'PRELIMINARY', status: 'Preliminär' });
  const preliminaryStore = makeStore(preliminary.record);
  const denied = await handlePaymentPage({ token: preliminary.token, query: {} }, {}, options(preliminaryStore, fakeStripe()));
  assert.equal(denied.status, 409);
  assert.match(denied.html, /inte bekräftad/);
});

test('kort startar endast en kort-session och sparar betalningsmetoden', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const stripe = fakeStripe();
  const response = await handlePaymentAction({ token, action: 'card', form: {} }, {}, options(store, stripe));
  assert.equal(response.status, 303);
  assert.equal(response.headers.Location, 'https://checkout.stripe.com/c/pay/cs_test_card1');
  assert.equal(stripe.calls.length, 1);
  assert.deepEqual(stripe.calls[0].paymentMethods, ['card']);
  assert.equal(stripe.calls[0].currency, 'sek');
  assert.equal(stripe.calls[0].amountOre, 2000000);
  assert.match(stripe.calls[0].successUrl, /\/betala\/.*\?payment=success/);
  assert.match(stripe.calls[0].cancelUrl, /\/betala\/.*\?payment=cancelled/);
  const stored = store.current;
  assert.equal(stored.paymentRequests.length, 1);
  assert.equal(stored.paymentRequests[0].paymentMethod, 'card');
  assert.equal(stored.paymentRequests[0].status, 'OPEN');
  assert.equal(stored.paymentRequests[0].amountOre, 2000000);
  assert.equal(stored.version, 2);
  assert.equal(store.history[0].action, 'CARD_CHECKOUT_STARTED');
});

test('Swish är avstängt som standard men kan slås på med flaggan', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const page = await handlePaymentPage({ token, query: {} }, {}, options(store, fakeStripe()));
  assert.doesNotMatch(page.html, /Betala med Swish/);

  const swish = makeRecord();
  const swishStore = makeStore(swish.record);
  const swishPage = await handlePaymentPage({ token: swish.token, query: {} }, {}, options(swishStore, fakeStripe(), {
    swishEnabled: true
  }));
  assert.match(swishPage.html, /Betala med kort/);
  assert.match(swishPage.html, /Betala med Swish/);

  const swishAction = await handlePaymentAction({ token: swish.token, action: 'swish', form: {} }, {}, options(swishStore, fakeStripe(), {
    swishEnabled: true
  }));
  assert.equal(swishAction.status, 303);
});

test('kort som inte är aktiverat visar tydligt fel och erbjuder faktura', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const stripe = fakeStripe({
    error: new StripeError(400, 'payment_method_not_available', 'Card is not enabled')
  });
  const response = await handlePaymentAction({ token, action: 'card', form: {} }, {}, options(store, stripe));
  assert.equal(response.status, 503);
  assert.match(response.html, /Kortbetalningen är inte aktiverad/);
  assert.match(response.html, /Begär faktura/);
  assert.doesNotMatch(response.html, /Klarna/i);
  assert.equal(store.current.paymentRequests.length, 0);
});

test('digital betalning är avstängd när funktionen är avstängd', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const response = await handlePaymentPage({ token, query: {} }, {}, options(store, fakeStripe(), {
    stripeEnabled: false
  }));
  assert.equal(response.status, 200);
  assert.match(response.html, /Digital betalning är inte tillgänglig/);
  assert.match(response.html, /Begär faktura/);
  assert.doesNotMatch(response.html, /Betala med kort/);
  assert.doesNotMatch(response.html, /Betala med Swish/);
});

test('fakturabegäran skapas en gång med spårbar status och utan automatisk betalning', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const form = {
    requestId: '33333333-3333-4333-8333-333333333333',
    invoiceName: 'Fakturabolaget AB',
    invoiceOrgNumber: '556677-8899',
    invoiceAddress: 'Storgatan 3',
    invoicePostalCode: '541 30',
    invoiceCity: 'Skövde',
    invoiceEmail: 'faktura@example.se',
    invoiceReference: 'PO-123',
    invoiceNotes: 'Faktureras månadsvis'
  };
  const response = await handlePaymentAction({ token, action: 'invoice', form }, {}, options(store, fakeStripe()));
  assert.equal(response.status, 303);
  assert.equal(response.headers.Location, `/betala/${token}?invoice=requested`);
  const stored = store.current;
  assert.equal(stored.invoiceRequests.length, 1);
  assert.equal(stored.invoiceRequests[0].status, 'REQUESTED');
  assert.equal(stored.invoiceRequests[0].amountOre, 2000000);
  assert.equal(stored.paymentStatus, 'UNPAID');
  assert.equal(stored.payments.length, 0);
  assert.equal(store.outbox.length, 2);
  assert.deepEqual(
    store.outbox.map((row) => row.mailType).sort(),
    ['GUEST_INVOICE_REQUEST_RECEIVED', 'HOST_INVOICE_REQUEST']
  );
  assert.ok(store.history.some((entry) => entry.action === 'INVOICE_REQUEST_CREATED'));

  const duplicate = await handlePaymentAction({ token, action: 'invoice', form }, {}, options(store, fakeStripe()));
  assert.equal(duplicate.status, 200);
  assert.match(duplicate.html, /redan registrerad/);
  assert.equal(store.current.invoiceRequests.length, 1);
  assert.equal(store.outbox.length, 2);
});

test('ogiltiga fakturauppgifter ger fältfel utan att spara', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  const response = await handlePaymentAction({
    token,
    action: 'invoice',
    form: {
      requestId: '44444444-4444-4444-8444-444444444444',
      invoiceName: 'A',
      invoiceAddress: '',
      invoicePostalCode: 'abc',
      invoiceCity: '',
      invoiceEmail: 'fel'
    }
  }, {}, options(store, fakeStripe()));
  assert.equal(response.status, 400);
  assert.match(response.html, /Ange fakturabetalarens namn/);
  assert.match(response.html, /Ange ett giltigt organisationsnummer|Ange postnummer/);
  assert.equal(store.current.invoiceRequests.length, 0);
});

test('delbetalning visar och debiterar endast återstående belopp', async () => {
  const { record, token } = makeRecord({
    amountPaid: 5000,
    paymentStatus: 'PARTIALLY_PAID',
    balance: 15000
  });
  const store = makeStore(record);
  const stripe = fakeStripe();
  const page = await handlePaymentPage({ token, query: {} }, {}, options(store, stripe));
  assert.equal(page.status, 200);
  assert.match(page.html, /15\s?000/);
  const response = await handlePaymentAction({ token, action: 'card', form: {} }, {}, options(store, stripe));
  assert.equal(response.status, 303);
  assert.equal(stripe.calls[0].amountOre, 1500000);
});

test('ny kalenderkonflikt blockerar betalningssidan', async () => {
  const { record, token } = makeRecord();
  const store = makeStore(record);
  store.listCalendar = async (from, to) => nightKeys(from, to).map((night) => ({
    night,
    type: 'BOOKING',
    reference: night === '2027-05-11' ? 'SK-2026-OTHER' : record.reference
  }));
  const response = await handlePaymentPage({ token, query: {} }, {}, options(store, fakeStripe()));
  assert.equal(response.status, 409);
  assert.match(response.html, /kalenderlås/);
});

test('en återkallad betalningslänk kan inte användas', async () => {
  const { record, token } = makeRecord();
  record.paymentAccess.revokedAt = NOW.toISOString();
  const store = makeStore(record);
  const response = await handlePaymentAction({ token, action: 'swish', form: {} }, {}, options(store, fakeStripe()));
  assert.equal(response.status, 410);
  assert.equal(store.current.paymentRequests.length, 0);
});
