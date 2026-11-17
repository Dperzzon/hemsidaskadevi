'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handlePaymentResult } = require('../../server/booking/payment-result');

const REFERENCE = 'SK-2026-ABC234';

function makeRecord(overrides = {}) {
  return {
    reference: REFERENCE,
    statusCode: 'PENDING_PAYMENT',
    status: 'Väntar på betalning',
    arrival: '2027-05-10',
    departure: '2027-05-13',
    guests: 4,
    firstName: 'Hemlig',
    lastName: 'Gäst',
    email: 'hemlig.gast@example.se',
    phone: '0701234567',
    total: 20000,
    amountPaid: 0,
    paymentStatus: 'UNPAID',
    balance: 20000,
    payments: [],
    paymentRequests: [{
      provider: 'stripe',
      mode: 'test',
      paymentMethod: 'card',
      status: 'OPEN',
      sessionId: 'cs_test_card1',
      amountOre: 2000000,
      currency: 'sek',
      createdAt: '2026-11-10T10:00:00.000Z'
    }],
    ...overrides
  };
}

function makeStore(record) {
  return {
    calls: 0,
    async getByReference(reference) {
      this.calls += 1;
      return reference === record.reference ? { record, etag: 'etag-1' } : null;
    },
    async updateRequest() {
      throw new Error('Betalningsresultatet får aldrig skriva till bokningen');
    },
    async save() {
      throw new Error('Betalningsresultatet får aldrig skriva till bokningen');
    },
    async appendHistory() {
      throw new Error('Betalningsresultatet får aldrig skriva till historiken');
    }
  };
}

function makeStripe(sessions) {
  return {
    calls: [],
    async retrieveCheckoutSession(sessionId) {
      this.calls.push(sessionId);
      const session = sessions[sessionId];
      if (session instanceof Error) throw session;
      if (!session) throw new Error('Saknas');
      return session;
    }
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'cs_test_card1',
    mode: 'payment',
    livemode: false,
    status: 'open',
    payment_status: 'unpaid',
    amount_total: 2000000,
    currency: 'sek',
    created: 1762770000,
    client_reference_id: REFERENCE,
    metadata: { reference: REFERENCE },
    ...overrides
  };
}

function options(store, stripe, overrides = {}) {
  return { store, stripeClient: stripe, ...overrides };
}

test('avbruten sida visar verifierat "Inget belopp" endast när Stripe-sessionen är obetald', async () => {
  const record = makeRecord();
  const store = makeStore(record);
  const stripe = makeStripe({ cs_test_card1: makeSession() });
  const response = await handlePaymentResult(
    { page: 'cancel', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.equal(response.status, 200);
  assert.match(response.html, /Betalningen avbröts/);
  assert.match(response.html, /Inget belopp har dragits/);
  assert.match(response.html, /Ingen betalning genomförd/);
  assert.match(response.html, /href="tel:\+46702730422"/);
  assert.match(response.html, /href="mailto:skadevigard@gmail.com"/);
  assert.match(response.html, /href="\/boka"/);
  assert.match(response.html, /class="header"/);
  assert.match(response.html, /class="footer"/);
  assert.match(response.html, /\/images\/logo\.png/);
  assert.doesNotMatch(response.html, /Hemlig|hemlig\.gast@example\.se|0701234567/);
  assert.equal(store.calls, 1);
});

test('avbruten sida visar neutral status när betalning kan ha genomförts', async () => {
  const record = makeRecord();
  const store = makeStore(record);
  const stripe = makeStripe({
    cs_test_card1: makeSession({ status: 'complete', payment_status: 'paid' })
  });
  const response = await handlePaymentResult(
    { page: 'cancel', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.equal(response.status, 200);
  assert.match(response.html, /Vi kunde inte bekräfta betalningens status/);
  assert.doesNotMatch(response.html, /Inget belopp har dragits/);
  assert.doesNotMatch(response.html, /Ingen betalning genomförd/);
});

test('avbruten sida visar neutral status när Stripe-sessionen behandlas', async () => {
  const record = makeRecord();
  const store = makeStore(record);
  const stripe = makeStripe({
    cs_test_card1: makeSession({ status: 'complete', payment_status: 'unpaid' })
  });
  const response = await handlePaymentResult(
    { page: 'cancel', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.match(response.html, /Vi kunde inte bekräfta betalningens status/);
  assert.doesNotMatch(response.html, /Inget belopp har dragits/);
});

test('avbruten sida visar neutral status utan referens eller vid Stripe-fel', async () => {
  const record = makeRecord();
  const store = makeStore(record);
  const withoutReference = await handlePaymentResult(
    { page: 'cancel', query: {} },
    {},
    options(store, makeStripe({}))
  );
  assert.match(withoutReference.html, /Vi kunde inte bekräfta betalningens status/);
  assert.doesNotMatch(withoutReference.html, /Inget belopp har dragits/);

  const failed = await handlePaymentResult(
    { page: 'cancel', query: { ref: REFERENCE } },
    {},
    options(store, makeStripe({ cs_test_card1: new Error('Stripe nere') }))
  );
  assert.match(failed.html, /Vi kunde inte bekräfta betalningens status/);
});

test('avbruten sida visar neutral status när bokningen redan är bekräftad', async () => {
  const record = makeRecord({ statusCode: 'CONFIRMED', paymentStatus: 'PAID', amountPaid: 20000, balance: 0 });
  const store = makeStore(record);
  const stripe = makeStripe({ cs_test_card1: makeSession() });
  const response = await handlePaymentResult(
    { page: 'cancel', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.match(response.html, /Vi kunde inte bekräfta betalningens status/);
  assert.doesNotMatch(response.html, /Inget belopp har dragits/);
});

test('klar-sida visar bokningsuppgifter först efter verifierad betalning och bekräftad bokning', async () => {
  const record = makeRecord({
    statusCode: 'CONFIRMED',
    status: 'Bekräftad',
    paymentStatus: 'PAID',
    amountPaid: 20000,
    balance: 0,
    paymentRequests: [{
      provider: 'stripe',
      mode: 'test',
      paymentMethod: 'card',
      status: 'PAID',
      sessionId: 'cs_test_card1',
      amountOre: 2000000,
      currency: 'sek',
      createdAt: '2026-11-10T10:00:00.000Z'
    }]
  });
  const store = makeStore(record);
  const stripe = makeStripe({
    cs_test_card1: makeSession({ status: 'complete', payment_status: 'paid' })
  });
  const response = await handlePaymentResult(
    { page: 'success', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.equal(response.status, 200);
  assert.match(response.html, /Tack för din bokning/);
  assert.match(response.html, /Din betalning är genomförd/);
  assert.match(response.html, new RegExp(REFERENCE));
  assert.match(response.html, /10 maj 2027/);
  assert.match(response.html, /13 maj 2027/);
  assert.match(response.html, /20\s?000 kr/);
  assert.match(response.html, /Tillbaka till hemsidan/);
  assert.doesNotMatch(response.html, /Hemlig|hemlig\.gast@example\.se|0701234567/);
});

test('klar-sida visar neutral behandling när betalningen ännu inte är genomförd', async () => {
  const record = makeRecord();
  const store = makeStore(record);
  const stripe = makeStripe({ cs_test_card1: makeSession() });
  const response = await handlePaymentResult(
    { page: 'success', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.match(response.html, /Betalningen behandlas/);
  assert.match(response.html, /Uppdatera sidan om en stund/);
  assert.doesNotMatch(response.html, /Tack för din bokning/);
  assert.doesNotMatch(response.html, /Din betalning är genomförd/);
});

test('klar-sida påstår inte att bokningen är bekräftad vid avstämning', async () => {
  const record = makeRecord({ statusCode: 'RECONCILIATION', status: 'Avstämning' });
  const store = makeStore(record);
  const stripe = makeStripe({
    cs_test_card1: makeSession({ status: 'complete', payment_status: 'paid' })
  });
  const response = await handlePaymentResult(
    { page: 'success', query: { ref: REFERENCE } },
    {},
    options(store, stripe)
  );
  assert.match(response.html, /Tack för din betalning/);
  assert.match(response.html, /bokningen är inte bekräftad ännu/i);
  assert.doesNotMatch(response.html, /Tack för din bokning/);
  assert.doesNotMatch(response.html, /Din betalning är genomförd/);
});

test('klar-sida visar neutral status utan referens eller vid felaktig session', async () => {
  const record = makeRecord();
  const store = makeStore(record);
  const missing = await handlePaymentResult(
    { page: 'success', query: {} },
    {},
    options(store, makeStripe({}))
  );
  assert.match(missing.html, /Vi kunde inte bekräfta betalningen/);

  const mismatched = await handlePaymentResult(
    { page: 'success', query: { ref: REFERENCE } },
    {},
    options(store, makeStripe({
      cs_test_card1: makeSession({ amount_total: 1999900 })
    }))
  );
  assert.match(mismatched.html, /Vi kunde inte bekräfta betalningen/);
  assert.doesNotMatch(mismatched.html, /Tack för din bokning/);

  const wrongReference = await handlePaymentResult(
    { page: 'success', query: { ref: REFERENCE } },
    {},
    options(store, makeStripe({
      cs_test_card1: makeSession({
        status: 'complete',
        payment_status: 'paid',
        metadata: { reference: 'SK-2026-WRONG1' },
        client_reference_id: 'SK-2026-WRONG1'
      })
    }))
  );
  assert.match(wrongReference.html, /Vi kunde inte bekräfta betalningen/);
});

test('betalningsresultatet sätter no-store och no-referrer', async () => {
  const response = await handlePaymentResult({ page: 'cancel', query: {} }, {}, {});
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
  assert.match(response.headers['X-Robots-Tag'], /noindex/);
});
