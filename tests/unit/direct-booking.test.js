'use strict';

// Enhetstester för direktbokning med kort: feature flag, tillgänglighet,
// atomisk nattreservation, Stripe Checkout, webhook-bekräftelse och
// avstämningsfall. Testerna använder en minneslagring och en fejkad
// Stripe-klient — inga riktiga Azure- eller Stripe-anrop görs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleDirectBooking,
  handleDirectBookingConfirmation,
  checkDirectBookingAvailability
} = require('../../server/booking/direct-booking');
const { handleStripeWebhook } = require('../../server/booking/stripe-webhook');
const { signStripePayload } = require('../../server/booking/stripe');
const { createAnalyticsTransactionId } = require('../../shared/analytics');

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
  const directBooking = new Map();
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
    },
    async getDirectBookingNight(night) {
      return directBooking.get(night) ? clone(directBooking.get(night)) : null;
    },
    async listDirectBookingNights(from, to) {
      return [...directBooking.values()]
        .filter((row) => row.night >= from && row.night < to)
        .map(clone);
    },
    async upsertDirectBookingNight(night, data) {
      const existing = directBooking.get(night);
      directBooking.set(night, {
        ...clone(data),
        night,
        etag: existing ? `db-${night}-2` : `db-${night}-1`
      });
    },
    async deleteDirectBookingNight(night) {
      directBooking.delete(night);
    },
    async listDirectBookingNightsByApproval(approvalId) {
      return [...directBooking.values()]
        .filter((row) => row.approvalId === approvalId)
        .map(clone);
    },
    async listDirectBookingApprovals() {
      const groups = new Map();
      for (const row of directBooking.values()) {
        if (!row.approvalId) continue;
        if (!groups.has(row.approvalId)) {
          groups.set(row.approvalId, {
            approvalId: row.approvalId,
            from: row.from,
            to: row.to,
            nights: [],
            approvedBy: row.approvedBy,
            approvedAt: row.approvedAt,
            note: row.note,
            status: row.status,
            closedBy: row.closedBy,
            closedAt: row.closedAt
          });
        }
        const group = groups.get(row.approvalId);
        group.nights.push(row.night);
        if (row.status === 'OPEN') group.status = 'OPEN';
      }
      return [...groups.values()].map((group) => ({ ...group, nights: group.nights.sort() }));
    },
    async getDirectBookingSetting() {
      const row = directBooking.get('__setting__');
      if (!row) return null;
      return {
        enabled: row.enabled === '1' || row.enabled === true,
        updatedBy: row.updatedBy ?? '',
        updatedAt: row.updatedAt ?? '',
        note: row.note ?? '',
        etag: row.etag ?? ''
      };
    },
    async setDirectBookingSetting(data) {
      const existing = directBooking.get('__setting__');
      directBooking.set('__setting__', {
        night: '__setting__',
        enabled: data.enabled ? '1' : '0',
        updatedBy: data.updatedBy ?? '',
        updatedAt: data.updatedAt ?? new Date().toISOString(),
        note: data.note ?? '',
        etag: existing ? 'db-setting-2' : 'db-setting-1'
      });
    }
  };
  return {
    store,
    records,
    calendar,
    directBooking,
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
      availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } }),
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
  assert.equal(result.status, 503);
  assert.equal(result.jsonBody.manualReview, true);
  assert.match(result.jsonBody.error, /tillgängligheten/);
});

test('Airbnb-upptagna nätter stoppar direktbetalning', async () => {
  const { options, context } = setup({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-11-21'] } })
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'AIRBNB_CONFLICT');
  assert.deepEqual(result.jsonBody.nights, ['2026-11-21']);
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

test('intern datumblockering stoppar direktbetalning', async () => {
  const { options, context, memory } = setup();
  await memory.store.createCalendarNight('2026-11-21', {
    type: 'BLOCK',
    reference: 'BLOCK-1',
    source: 'MANUAL'
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'INTERNAL_CONFLICT');
});

test('Owner kan stänga av automatisk direktbokning', async () => {
  const { options, context, memory } = setup();
  await memory.store.setDirectBookingSetting({
    enabled: false,
    updatedBy: 'Owner Test',
    updatedAt: NOW.toISOString()
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'AUTO_DIRECT_BOOKING_DISABLED');
});

test('tillgänglighetskontrollen ger directBooking true för lediga datum', async () => {
  const { options, memory } = setup();
  const availability = await checkDirectBookingAvailability(
    memory.store,
    '2026-11-20',
    '2026-11-23',
    NOW,
    options
  );
  assert.equal(availability.directBooking, true);
  assert.deepEqual(availability.nights, ['2026-11-20', '2026-11-21', '2026-11-22']);
});

test('tillgänglighetskontrollen nekar när iCal saknas', async () => {
  const { options, memory } = setup({
    availabilityHandler: async () => ({ status: 503, jsonBody: { error: 'nere' } })
  });
  const availability = await checkDirectBookingAvailability(
    memory.store,
    '2026-11-20',
    '2026-11-23',
    NOW,
    options
  );
  assert.equal(availability.directBooking, false);
  assert.equal(availability.code, 'AIRBNB_UNAVAILABLE');
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

test('Airbnb-bokning som tillkommer under Checkout ger avstämning i stället för bekräftelse', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';

  const response = await signedWebhook(memory.store, {
    id: 'evt_direct_checkout_conflict',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  }, {
    stripeClient: stripe,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-11-21'] } })
  });

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.reconciliation, true);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.statusCode, 'RECONCILIATION');
  assert.equal(record.reconciliation.code, 'AIRBNB_CONFLICT');
  assert.deepEqual(record.reconciliation.nights, ['2026-11-21']);
  assert.equal(record.payments.length, 1);
  assert.equal(record.reservation.status, 'ACTIVE');
  for (const row of memory.calendar.values()) {
    assert.equal(row.type, 'RESERVATION');
  }
});

test('Airbnb som inte kan verifieras i webhooken ger avstämning', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';

  const response = await signedWebhook(memory.store, {
    id: 'evt_direct_checkout_unavailable',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  }, {
    stripeClient: stripe,
    availabilityHandler: async () => ({ status: 503, jsonBody: { code: 'CALENDAR_EMPTY' } })
  });

  assert.equal(response.status, 200);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.statusCode, 'RECONCILIATION');
  assert.equal(record.reconciliation.code, 'CALENDAR_EMPTY');
});

test('dubbel webhook efter avstämning bekräftar inte bokningen automatiskt', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';
  const event = {
    id: 'evt_direct_reconcile_repeat',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  };

  await signedWebhook(memory.store, event, {
    stripeClient: stripe,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-11-21'] } })
  });
  const second = await signedWebhook(memory.store, event, { stripeClient: stripe });
  assert.equal(second.status, 200);
  const record = await memory.store.findByReference(reference);
  assert.equal(record.statusCode, 'RECONCILIATION');
  assert.equal(record.payments.length, 1);
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

test('bekräftelsesidan skickar purchase först när bokningen är CONFIRMED', async () => {
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
  assert.doesNotMatch(pending.html, /data-analytics-purchase/);

  const record = await memory.store.findByReference(reference);
  record.statusCode = 'CONFIRMED';
  record.status = 'Bekräftad';
  await memory.store.updateRequest(record, { ifMatch: '*' });

  const confirmed = await handleDirectBookingConfirmation(
    { query: { session_id: session.id } },
    context,
    { ...options, store: memory.store }
  );
  assert.match(confirmed.html, /data-analytics-purchase/);
  const transactionId = createAnalyticsTransactionId(reference);
  assert.match(confirmed.html, new RegExp(`"transaction_id":"${transactionId}"`));
  assert.doesNotMatch(confirmed.html, new RegExp(`"transaction_id":"${reference}"`));
  assert.match(confirmed.html, /"currency":"SEK"/);
});

test('bekräftelsesidan ger ingen purchase i fel Stripe-miljö', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request(), context, options);
  const reference = created.jsonBody.reference;
  const session = [...stripe.sessions.values()][0];
  session.payment_status = 'paid';
  session.status = 'complete';
  session.livemode = true;

  const record = await memory.store.findByReference(reference);
  record.statusCode = 'CONFIRMED';
  record.status = 'Bekräftad';
  await memory.store.updateRequest(record, { ifMatch: '*' });

  const confirmed = await handleDirectBookingConfirmation(
    { query: { session_id: session.id } },
    context,
    { ...options, store: memory.store }
  );
  assert.equal(confirmed.status, 409);
  assert.doesNotMatch(confirmed.html, /data-analytics-purchase/);
});

test('extrahus stoppar direktbetalning och hänvisar till manuell förfrågan', async () => {
  const { options, context } = setup();
  const body = validBody({
    addons: {
      ...validBody().addons,
      extrahus: true,
      extrahusNights: 2,
      extrahusGuests: 2
    }
  });
  const result = await handleDirectBooking(request({ body }), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'EXTRAHUS_DIRECT_UNAVAILABLE');
  assert.equal(result.jsonBody.manualReview, true);
});

test('konfigurerbar ledtidsgräns stoppar direktbetalning nära ankomst', async () => {
  const { options, context, memory, stripe } = setup({
    now: new Date('2026-11-19T12:00:00.000Z'),
    minimumLeadHours: 48
  });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'ARRIVAL_TOO_SOON');
  assert.equal(result.jsonBody.manualReview, true);
  assert.equal(result.jsonBody.minimumLeadHours, 48);
  assert.equal(memory.calendar.size, 0);
  assert.equal(stripe.sessions.size, 0);
});

test('ledtidsgränsen är avstängd som standard', async () => {
  const { options, context } = setup({ now: new Date('2026-11-19T12:00:00.000Z') });
  const result = await handleDirectBooking(request(), context, options);
  assert.equal(result.status, 201);
});

test('Stripe Checkout skapas inte om reservationens ägarskap inte kan verifieras', async () => {
  const { options, context, memory, stripe } = setup();
  const base = memory.store;
  const store = {
    ...base,
    async listCalendarByReference() { return []; }
  };
  const result = await handleDirectBooking(request(), context, { ...options, store });
  assert.equal(result.status, 503);
  assert.equal(result.jsonBody.code, 'RESERVATION_UNVERIFIED');
  assert.equal(stripe.sessions.size, 0);
});
const { bufferNightsFor, lockedNightsFor } = require('../../server/booking/buffer-nights');
const { buildCalendar, collectNights } = require('../../server/calendar/export');
const { quote } = require('../../server/booking/pricing');

function bufferBody(overrides = {}) {
  return validBody({
    addons: {
      ...validBody().addons,
      tidigIncheckning: false,
      senUtcheckning: false,
      ...(overrides.addons ?? {})
    },
    ...overrides
  });
}

test('buffertnätter: bokning utan tillval får inga extra nätter', () => {
  const record = {
    arrival: '2027-05-22', departure: '2027-05-23',
    addons: { tidigIncheckning: false, senUtcheckning: false },
    bufferNightsMode: 'auto'
  };
  assert.deepEqual(bufferNightsFor(record), []);
  assert.deepEqual(lockedNightsFor(record), ['2027-05-22']);
});

test('buffertnätter: endast tidig incheckning blockerar natten före ankomst', () => {
  const record = {
    arrival: '2027-05-22', departure: '2027-05-24',
    addons: { tidigIncheckning: true, senUtcheckning: false },
    bufferNightsMode: 'auto'
  };
  assert.deepEqual(bufferNightsFor(record), ['2027-05-21']);
  assert.deepEqual(lockedNightsFor(record), ['2027-05-21', '2027-05-22', '2027-05-23']);
});

test('buffertnätter: endast sen utcheckning blockerar natten på avresedatumet', () => {
  const record = {
    arrival: '2027-05-22', departure: '2027-05-23',
    addons: { tidigIncheckning: false, senUtcheckning: true },
    bufferNightsMode: 'auto'
  };
  assert.deepEqual(bufferNightsFor(record), ['2027-05-23']);
});

test('buffertnätter: båda tillvalen blockerar båda nätterna', () => {
  const record = {
    arrival: '2027-05-22', departure: '2027-05-23',
    addons: { tidigIncheckning: true, senUtcheckning: true },
    bufferNightsMode: 'auto'
  };
  assert.deepEqual(bufferNightsFor(record), ['2027-05-21', '2027-05-23']);
});

test('buffertnätter: äldre/manuell bokning får aldrig automatiska buffertar', () => {
  const record = {
    arrival: '2027-05-22', departure: '2027-05-23',
    addons: { tidigIncheckning: true, senUtcheckning: true }
  };
  assert.deepEqual(bufferNightsFor(record), []);
  assert.deepEqual(lockedNightsFor(record), ['2027-05-22']);
});

test('upptagen buffertnatt nekar tillvalet men ordinarie vistelse kan bokas', async () => {
  const { options, context, memory, stripe } = setup();
  await memory.store.createCalendarNight('2026-11-19', {
    type: 'MANUAL', reference: 'BLOCK-OTHER', source: 'MANUAL', note: 'Upptagen'
  });

  const blocked = await handleDirectBooking(request({
    body: bufferBody({ addons: { tidigIncheckning: true } })
  }), context, options);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.jsonBody.code, 'BUFFER_UNAVAILABLE');
  assert.match(blocked.jsonBody.error, /ordinarie vistelse utan tillvalet/);
  assert.equal(stripe.sessions.size, 0);
  assert.equal(memory.calendar.size, 1);

  const ordinary = await handleDirectBooking(request({
    idempotencyKey: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    body: bufferBody({ addons: { tidigIncheckning: false } })
  }), context, options);
  assert.equal(ordinary.status, 201);
  assert.equal(stripe.sessions.size, 1);
});

test('två samtidiga bokningar kan inte reservera samma buffertnatt', async () => {
  const { options, context, memory, stripe } = setup();
  const early = handleDirectBooking(request({
    idempotencyKey: '11111111-1111-1111-1111-111111111111',
    body: bufferBody({
      arrival: '2026-11-20', departure: '2026-11-22',
      addons: { tidigIncheckning: true, senUtcheckning: false }
    })
  }), context, options);
  const late = handleDirectBooking(request({
    idempotencyKey: '22222222-2222-2222-2222-222222222222',
    body: bufferBody({
      arrival: '2026-11-18', departure: '2026-11-19',
      addons: { tidigIncheckning: false, senUtcheckning: true }
    })
  }), context, options);

  const results = await Promise.all([early, late]);
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  for (const row of memory.calendar.values()) {
    assert.ok(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].includes(row.night));
  }
  const nights = [...memory.calendar.keys()];
  assert.equal(new Set(nights).size, nights.length);
  assert.ok(memory.calendar.size === 2 || memory.calendar.size === 3);
  assert.equal(stripe.sessions.size, 1);
});

test('avbruten Stripe-betalning frigör både ordinarie och buffertnätter', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request({
    body: bufferBody({ addons: { tidigIncheckning: true, senUtcheckning: true } })
  }), context, options);
  assert.equal(created.status, 201);
  assert.equal(memory.calendar.size, 5);
  const session = [...stripe.sessions.values()][0];
  session.status = 'expired';
  session.payment_status = 'unpaid';
  const response = await signedWebhook(memory.store, {
    id: 'evt_buffer_expired', type: 'checkout.session.expired', livemode: false,
    data: { object: session }
  }, { stripeClient: stripe });
  assert.equal(response.status, 200);
  assert.equal(memory.calendar.size, 0);
});

test('webhook upptäcker ny Airbnb-konflikt även på buffertnatten', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request({
    body: bufferBody({ addons: { tidigIncheckning: true, senUtcheckning: false } })
  }), context, options);
  assert.equal(created.status, 201);
  const session = [...stripe.sessions.values()][0];
  session.status = 'complete';
  session.payment_status = 'paid';
  const response = await signedWebhook(memory.store, {
    id: 'evt_buffer_airbnb_conflict', type: 'checkout.session.completed', livemode: false,
    data: { object: session }
  }, {
    stripeClient: stripe,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-11-19'] } })
  });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.reconciliation, true);
  const record = await memory.store.findByReference(created.jsonBody.reference);
  assert.equal(record.statusCode, 'RECONCILIATION');
  assert.deepEqual(record.reconciliation.nights, ['2026-11-19']);
});

test('Airbnb-exporten visar buffertdatum som en del av samma bokning', () => {
  const rows = [
    { night: '2027-05-21', type: 'BOOKING', kind: 'BUFFER', reference: 'SK-LEGACY', source: 'WEB' },
    { night: '2027-05-22', type: 'BOOKING', kind: 'STAY', reference: 'SK-LEGACY', source: 'WEB' },
    { night: '2027-05-23', type: 'BOOKING', kind: 'BUFFER', reference: 'SK-LEGACY', source: 'WEB' }
  ];
  assert.deepEqual(
    collectNights(rows, []).map((item) => item.night),
    ['2027-05-21', '2027-05-22', '2027-05-23']
  );
  const result = buildCalendar({ rows, blockingBookings: [], now: new Date('2027-05-01T12:00:00Z') });
  const text = result.body ?? result;
  assert.match(String(text), /DTSTART;VALUE=DATE:20270521/);
  assert.match(String(text), /DTEND;VALUE=DATE:20270524/);
  assert.doesNotMatch(String(text), /Anna|Andersson|example\.com/);
});

test('dubbla webhooks skapar aldrig dubbla buffertrader', async () => {
  const { options, context, memory, stripe } = setup();
  const created = await handleDirectBooking(request({
    body: bufferBody({ addons: { tidigIncheckning: true, senUtcheckning: true } })
  }), context, options);
  const session = [...stripe.sessions.values()][0];
  session.status = 'complete';
  session.payment_status = 'paid';
  const event = {
    id: 'evt_buffer_duplicate', type: 'checkout.session.completed', livemode: false,
    data: { object: session }
  };
  await signedWebhook(memory.store, event, { stripeClient: stripe });
  await signedWebhook(memory.store, event, { stripeClient: stripe });
  const record = await memory.store.findByReference(created.jsonBody.reference);
  assert.equal(record.payments.length, 1);
  assert.equal(memory.calendar.size, 5);
  assert.equal([...memory.calendar.values()].filter((row) => row.type === 'BOOKING').length, 5);
});

test('buffertnätter ändrar varken pris eller antal debiterade nätter', async () => {
  const { options, context, memory } = setup();
  const body = bufferBody({ addons: { tidigIncheckning: true, senUtcheckning: true } });
  const created = await handleDirectBooking(request({ body }), context, options);
  assert.equal(created.status, 201);
  const record = await memory.store.findByReference(created.jsonBody.reference);
  const expected = quote({
    arrival: '2026-11-20', departure: '2026-11-23', guests: 4, addons: body.addons
  });
  assert.equal(record.nights, 3);
  assert.equal(record.lodgingBase, expected.lodgingBase);
  assert.equal(record.total, expected.total);
  assert.deepEqual(record.bufferNights, ['2026-11-19', '2026-11-23']);
});
