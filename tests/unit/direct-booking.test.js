'use strict';

// Enhetstester för direktbokning med kort: feature flag, tillgänglighet,
// atomisk nattreservation, Stripe Checkout, webhook-bekräftelse och
// avstämningsfall. Testerna använder en minneslagring och en fejkad
// Stripe-klient — inga riktiga Azure- eller Stripe-anrop görs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleDirectBooking,
  handleDirectBookingConfirmation
} = require('../../server/booking/direct-booking');
const { handleStripeWebhook } = require('../../server/booking/stripe-webhook');
const { signStripePayload } = require('../../server/booking/stripe');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SECRET = 'whsec_test_direct';
const RULES = { published: true, version: 'test-2026-11-10', text: '1. Regel ett.\n2. Regel två.' };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validBody(overrides = {}) {
  return {
    arrival: '2026-11-20',
    departure: '2026-11-23',
    firstName: 'Anna',
    lastName: 'Andersson',
    email: 'anna@example.com',
    phone: '+46 70 123 45 67',
    guests: 4,
    company: '',
    message: 'Hej!',
    addons: { slutstad: true, lakan: true, linenCount: 4, ved: false, tidigIncheckning: false, senUtcheckning: false },
    totalAddons: 2500 + 800,
    rulesVersion: 'test-2026-11-10',
    consentRules: true,
    consentContact: false,
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    body: validBody(),
    idempotencyKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ip: '10.0.0.1',
    ...overrides
  };
}

function createMemoryStore() {
  const records = new Map();
  const calendar = new Map();
  const history = [];
  let etagCounter = 0;
  const store = {
    type: 'memory',
    async save(record) {
      if (records.has(record.idempotencyKey)) {
        return { duplicate: true, record: clone(records.get(record.idempotencyKey).record) };
      }
      const etag = `etag-${++etagCounter}`;
      records.set(record.idempotencyKey, { record: clone(record), etag });
      return { duplicate: false, record: clone(record), etag };
    },
    async findByIdempotencyKey(key) {
      return records.get(key)?.record ?? null;
    },
    async findByReference(reference) {
      for (const entry of records.values()) {
        if (entry.record.reference === reference) return clone(entry.record);
      }
      return null;
    },
    async getByReference(reference) {
      for (const entry of records.values()) {
        if (entry.record.reference === reference) {
          return { record: clone(entry.record), etag: entry.etag };
        }
      }
      return null;
    },
    async updateRequest(next, { ifMatch } = {}) {
      const entry = [...records.values()].find((item) => item.record.reference === next.reference);
      if (!entry) throw new Error('Bokningen hittades inte');
      if (ifMatch && ifMatch !== '*' && ifMatch !== entry.etag) {
        const error = new Error('ETag-konflikt');
        error.status = 409;
        throw error;
      }
      entry.record = clone(next);
      entry.etag = `etag-${++etagCounter}`;
      return { record: clone(entry.record), etag: entry.etag };
    },
    async appendHistory(entry) {
      history.push(clone(entry));
    },
    async listCalendar(from, to) {
      return [...calendar.values()]
        .filter((row) => row.night >= from && row.night < to)
        .map(clone);
    },
    async listCalendarByReference(reference) {
      return [...calendar.values()]
        .filter((row) => row.reference === reference)
        .map(clone);
    },
    async createCalendarNight(night, data) {
      if (calendar.has(night)) {
        const error = new Error('Natten är redan blockerad');
        error.status = 409;
        throw error;
      }
      calendar.set(night, { night, ...clone(data), etag: `cal-${night}-1` });
    },
    async updateCalendarNight(night, data, { ifMatch } = {}) {
      const current = calendar.get(night);
      if (!current) throw new Error('Kalenderraden hittades inte');
      if (ifMatch && ifMatch !== '*' && ifMatch !== current.etag) {
        const error = new Error('ETag-konflikt');
        error.status = 409;
        throw error;
      }
      calendar.set(night, { ...current, ...clone(data), etag: `cal-${night}-2` });
    },
    async deleteCalendarNight(night, reference) {
      const current = calendar.get(night);
      if (!current) return;
      if (reference && current.reference !== reference) {
        const error = new Error('Natten tillhör en annan bokning');
        error.status = 409;
        throw error;
      }
      calendar.delete(night);
    },
    async listBlockingBookings(arrival, departure) {
      return [...records.values()]
        .map((entry) => entry.record)
        .filter((record) =>
          (record.statusCode === 'CONFIRMED' || record.statusCode === 'BLOCKED') &&
          record.arrival < departure && record.departure > arrival
        );
    }
  };
  return {
    store,
    records,
    calendar,
    history
  };
}

function createFakeStripe(overrides = {}) {
  const sessions = new Map();
  let counter = 0;
  return {
    mode: 'test',
    async createCheckoutSession(input) {
      const id = `cs_test_direct_${++counter}`;
      const session = {
        id,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'unpaid',
        status: 'open',
        amount_total: input.amountOre,
        currency: input.currency,
        payment_method_types: input.paymentMethods,
        livemode: false,
        payment_intent: `pi_test_direct_${counter}`,
        client_reference_id: input.reference,
        metadata: input.metadata,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: input.expiresAt,
        ...overrides.session
      };
      sessions.set(id, session);
      return session;
    },
    async retrieveCheckoutSession(id) {
      return sessions.get(id) ?? null;
    },
    async expireCheckoutSession(id) {
      const session = sessions.get(id);
      if (session) session.status = 'expired';
      return session;
    },
    sessions
  };
}

function setup(overrides = {}) {
  const memory = createMemoryStore();
  const stripe = createFakeStripe();
  const options = {
    rules: RULES,
    store: memory.store,
    rateLimiter: () => true,
    directBookingEnabled: true,
    stripeEnabled: true,
    cardEnabled: true,
    stripeClient: stripe,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } }),
    now: NOW,
    publicBaseUrl: 'https://www.skadeviherrgard.com',
    requireDurableStore: false,
    ...overrides
  };
  const warn = [];
  const context = { warn: (message) => warn.push(message) };
  return { options, context, warn, memory, stripe };
}

function signedWebhook(store, eventObject, options = {}) {
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
      outboxEnabled: false,
      ...options
    }
  );
}

test('direktbokning är avstängd som standard', async () => {
  const { options, context } = setup();
  const result = await handleDirectBooking(request(), context, {
    ...options,
    directBookingEnabled: false
  });
  assert.equal(result.status, 503);
  assert.equal(result.jsonBody.code, 'DIRECT_BOOKING_DISABLED');
});

test('Airbnb som inte kan hämtas stoppar direktbetalning och hänvisar till manuell kontroll', async () => {
  const { options, context } = setup({
    availabilityHandler: async () => ({ status: 503, jsonBody: { error: 'nere' } })
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.manualReview, true);
  assert.match(result.jsonBody.error, /manuellt/);
});

test('Airbnb-blockerade nätter stoppar direktbetalning', async () => {
  const { options, context } = setup({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-11-21'] } })
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'AIRBNB_CONFLICT');
  assert.deepEqual(result.jsonBody.blockedNights, ['2026-11-21']);
});

test('intern kalenderkonflikt stoppar direktbetalning', async () => {
  const { options, context, memory } = setup();
  await memory.store.createCalendarNight('2026-11-21', {
    type: 'BOOKING',
    reference: 'SK-OTHER',
    source: 'MANUAL'
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'INTERNAL_CONFLICT');
});

test('lyckad direktbokning skapar atomisk reservation och Stripe Checkout', async () => {
  const { options, context, memory, stripe } = setup();
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 201);
  assert.ok(result.jsonBody.checkoutUrl.startsWith('https://checkout.stripe.com/'));
  assert.equal(result.jsonBody.status, 'PENDING_PAYMENT');

  const record = await memory.store.findByReference(result.jsonBody.reference);
  assert.equal(record.statusCode, 'PENDING_PAYMENT');
  assert.equal(record.bookingSource, 'DIRECT');
  assert.equal(record.reservation.status, 'ACTIVE');
  assert.equal(record.paymentRequest.status, 'OPEN');
  assert.equal(memory.calendar.size, 3);
  for (const row of memory.calendar.values()) {
    assert.equal(row.type, 'RESERVATION');
    assert.equal(row.reference, record.reference);
  }

  const session = [...stripe.sessions.values()][0];
  assert.equal(session.amount_total, Math.round(record.total * 100));
  assert.equal(session.currency, 'sek');
  assert.deepEqual(session.payment_method_types, ['card']);
  assert.equal(session.metadata.reference, record.reference);
});

test('klientens belopp kan inte manipulera Stripe-beloppet', async () => {
  const { options, context, memory, stripe } = setup();
  const result = await handleDirectBooking(
    request({ body: validBody({ total: 1, totalAddons: 1 }) }),
    context,
    options
  );
  assert.equal(result.status, 201);
  const record = await memory.store.findByReference(result.jsonBody.reference);
  const session = [...stripe.sessions.values()][0];
  assert.equal(session.amount_total, Math.round(record.total * 100));
  assert.notEqual(session.amount_total, 100);
});

test('konflikt på en natt rullar tillbaka hela reservationen', async () => {
  const { options, context, memory } = setup();
  const base = memory.store;
  const store = {
    ...base,
    async createCalendarNight(night, data) {
      if (night === '2026-11-21') {
        const error = new Error('Natten är redan blockerad');
        error.status = 409;
        throw error;
      }
      return base.createCalendarNight(night, data);
    }
  };
  const result = await handleDirectBooking(request(), context, { ...options, store });
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'RESERVATION_CONFLICT');
  assert.equal(memory.calendar.size, 0);
});

test('webhook bekräftar direktbokningen och omvandlar reservationen till bokning', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  assert.equal(created.status, 201);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';

  const response = await signedWebhook(memory.store, {
    id: 'evt_direct_paid_1',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  }, { stripeClient: stripe });

  assert.equal(response.status, 200);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.statusCode, 'CONFIRMED');
  assert.equal(record.paymentStatus, 'PAID');
  assert.equal(record.payments.length, 1);
  assert.equal(record.payments[0].method, 'CARD');
  assert.equal(record.payments[0].stripeSessionId, session.id);
  assert.equal(record.reservation.status, 'CONFIRMED');
  for (const row of memory.calendar.values()) {
    assert.equal(row.type, 'BOOKING');
  }
});

test('dubbel webhook registrerar betalningen exakt en gång', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';
  const event = {
    id: 'evt_direct_paid_2',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  };

  const first = await signedWebhook(memory.store, event, { stripeClient: stripe });
  const second = await signedWebhook(memory.store, event, { stripeClient: stripe });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.payments.length, 1);
  assert.equal(record.statusCode, 'CONFIRMED');
});

test('utgången Checkout-session frigör reservationen', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.status = 'expired';
  session.payment_status = 'unpaid';

  const response = await signedWebhook(memory.store, {
    id: 'evt_direct_expired_1',
    type: 'checkout.session.expired',
    livemode: false,
    data: { object: session }
  }, { stripeClient: stripe });

  assert.equal(response.status, 200);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.statusCode, 'EXPIRED');
  assert.equal(memory.calendar.size, 0);
});

test('betalning som lyckas men inte kan bekräftas blir ett avstämningsärende', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';

  let updateCalls = 0;
  const originalUpdate = memory.store.updateRequest.bind(memory.store);
  memory.store.updateRequest = async (record, opts) => {
    updateCalls += 1;
    if (updateCalls === 2) {
      const error = new Error('Databasen svarade inte');
      error.status = 500;
      throw error;
    }
    return originalUpdate(record, opts);
  };

  const response = await signedWebhook(memory.store, {
    id: 'evt_direct_reconcile_1',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  }, { stripeClient: stripe });

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.reconciliation, true);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.statusCode, 'RECONCILIATION');
  assert.equal(record.payments.length, 1);
  assert.equal(record.reconciliation.sessionId, session.id);
});

test('bekräftelsesidan visar inte bekräftat enbart från Stripe-redirect', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';

  const pending = await handleDirectBookingConfirmation(
    { query: { session_id: session.id } },
    context,
    { ...options, store: memory.store }
  );
  assert.equal(pending.status, 200);
  assert.match(pending.html, /Bokningen behandlas/);
  assert.doesNotMatch(pending.html, /Bokningen är bekräftad/);

  const record = await memory.store.findByReference(reference);
  record.statusCode = 'CONFIRMED';
  record.status = 'Bekräftad';
  await memory.store.updateRequest(record, { ifMatch: '*' });

  const confirmed = await handleDirectBookingConfirmation(
    { query: { session_id: session.id } },
    context,
    { ...options, store: memory.store }
  );
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.html, /Bokningen är bekräftad/);
  assert.match(confirmed.html, new RegExp(reference));
});
