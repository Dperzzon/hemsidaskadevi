'use strict';

// Enhetstester för Steg 15: köp av tillval till en befintlig bokning.
// Testerna använder en isolerad minneslagring och en fejkad Stripe-klient.
// Inga riktiga Azure-, Resend- eller Stripe-anrop görs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleAddonVerifyStart,
  handleAddonVerifyConfirm,
  handleAddonSession,
  handleAddonCheckout,
  handleAddonRequest,
  handleAddonStripeEvent,
  listAddonOrders,
  listAddonRequests,
  addonsAvailable
} = require('../../server/booking/existing-booking-addons');
const { handleStripeWebhook } = require('../../server/booking/stripe-webhook');
const { signStripePayload } = require('../../server/booking/stripe');

const NOW = new Date('2026-11-25T12:00:00.000Z');
const RULES = { published: true, version: 'test-tillval-2026-11-25', text: '1. Testregel.' };
const BOOKING_REFERENCE = 'SK-2027-AB123';
const EMAIL = 'anna@example.com';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStore(initialRecord) {
  const bookings = new Map();
  const calendar = new Map();
  const aux = new Map();
  const outbox = new Map();
  const history = [];
  let etagCounter = 0;
  bookings.set(initialRecord.reference, { record: clone(initialRecord), etag: 'etag-1' });

  const store = {
    type: 'memory',
    async save(record) {
      if (outbox.has(record.idempotencyKey)) {
        return { duplicate: true, record: clone(outbox.get(record.idempotencyKey)) };
      }
      outbox.set(record.idempotencyKey, clone(record));
      return { duplicate: false, record: clone(record) };
    },
    async getByReference(reference) {
      const entry = bookings.get(reference);
      return entry ? { record: clone(entry.record), etag: entry.etag } : null;
    },
    async updateRequest(next, { ifMatch } = {}) {
      const entry = bookings.get(next.reference);
      if (!entry) throw new Error('Bokningen hittades inte');
      if (ifMatch && ifMatch !== '*' && ifMatch !== entry.etag) {
        const error = new Error('ETag-konflikt');
        error.status = 409;
        throw error;
      }
      entry.record = clone(next);
      entry.etag = `etag-${++etagCounter + 1}`;
      return { record: clone(entry.record), etag: entry.etag };
    },
    async getAux(partition, rowKey) {
      const entry = aux.get(`${partition}:${rowKey}`);
      return entry ? { ...clone(entry.data), etag: entry.etag } : null;
    },
    async putAux(partition, rowKey, data, { ifMatch } = {}) {
      const key = `${partition}:${rowKey}`;
      const existing = aux.get(key);
      if (existing && ifMatch && ifMatch !== '*' && ifMatch !== existing.etag) {
        const error = new Error('Hjälpposten har ändrats');
        error.status = 409;
        throw error;
      }
      const etag = existing ? `aux-${Number(existing.etag.split('-')[1]) + 1}` : 'aux-1';
      aux.set(key, { data: clone(data), etag });
      return { record: clone(data), etag };
    },
    async listAux(partition, filter = {}) {
      return [...aux.entries()]
        .filter(([key, entry]) => key.startsWith(`${partition}:`) &&
          (!filter.reference || entry.data.reference === filter.reference) &&
          (!filter.status || entry.data.status === filter.status))
        .map(([, entry]) => ({ ...clone(entry.data), etag: entry.etag }));
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
    async listBlockingBookings() {
      return [];
    },
    async createCalendarNight(night, data, { resource = 'main' } = {}) {
      const key = `${resource}:${night}`;
      if (calendar.has(key)) {
        const error = new Error('Natten är redan blockerad');
        error.status = 409;
        throw error;
      }
      calendar.set(key, { night, resource, ...clone(data), etag: `cal-${key}-1` });
    },
    async updateCalendarNight(night, data, { ifMatch, resource = 'main' } = {}) {
      const key = `${resource}:${night}`;
      const current = calendar.get(key);
      if (!current) throw new Error('Kalenderraden hittades inte');
      if (ifMatch && ifMatch !== '*' && ifMatch !== current.etag) {
        const error = new Error('ETag-konflikt');
        error.status = 409;
        throw error;
      }
      calendar.set(key, { ...current, ...clone(data), night, resource, etag: `cal-${key}-2` });
    },
    async deleteCalendarNight(night, reference, { resource = 'main' } = {}) {
      const key = `${resource}:${night}`;
      const current = calendar.get(key);
      if (!current) return;
      if (checkReference(current, reference)) calendar.delete(key);
    },
    async appendHistory(entry) {
      history.push(clone(entry));
    }
  };
  store.outbox = outbox;
  store.calendar = calendar;
  return {
    store,
    outbox,
    history,
    calendar,
    addBooking(record) {
      bookings.set(record.reference, { record: clone(record), etag: `etag-${++etagCounter + 1}` });
    },
    getBooking(reference) {
      return bookings.get(reference)?.record ? clone(bookings.get(reference).record) : null;
    },
    setBooking(record) {
      const entry = bookings.get(record.reference);
      entry.record = clone(record);
      entry.etag = `etag-${++etagCounter + 1}`;
    }
  };
}

function checkReference(row, reference) {
  return !row.reference || row.reference === reference;
}

function booking(overrides = {}) {
  return {
    reference: BOOKING_REFERENCE,
    statusCode: 'CONFIRMED',
    status: 'Bekräftad',
    arrival: '2027-03-10',
    departure: '2027-03-13',
    nights: 3,
    guests: 4,
    totalGuests: 4,
    firstName: 'Anna',
    lastName: 'Andersson',
    email: EMAIL,
    phone: '+46 70 123 45 67',
    bookingSource: 'WEB',
    addons: {
      slutstad: true,
      lakan: true,
      linenCount: 2,
      ved: false,
      tidigIncheckning: false,
      senUtcheckning: false
    },
    addonLines: [
      { id: 'slutstad', label: 'Slutstädning', quantity: 1, unitPrice: 2500, amount: 2500 },
      { id: 'lakan', label: 'Lakan och handdukar', quantity: 2, unitPrice: 200, amount: 400 }
    ],
    totalAddons: 2900,
    lodgingBase: 11100,
    lodgingAfterDiscount: 11100,
    total: 14000,
    calculatedTotal: 14000,
    amountPaid: 14000,
    balance: 0,
    paymentStatus: 'PAID',
    payments: [{
      id: 'pay-original',
      type: 'PAYMENT',
      amountOre: 1400000,
      paymentDate: '2027-01-15',
      method: 'CARD',
      reference: 'Ursprunglig betalning',
      createdAt: '2027-01-15T10:00:00.000Z'
    }],
    bufferNightsMode: 'auto',
    bufferNights: [],
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides
  };
}

function createFakeStripe() {
  let counter = 0;
  const sessions = new Map();
  const stripe = {
    mode: 'test',
    async createCheckoutSession(params) {
      counter += 1;
      const id = `cs_test_addon_${counter}`;
      const session = {
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.com/c/pay/${id}`,
        amount_total: params.amountOre,
        currency: params.currency,
        mode: 'payment',
        livemode: false,
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: `pi_test_${counter}`,
        payment_method_types: ['card'],
        metadata: { ...params.metadata },
        created: Math.floor(NOW.getTime() / 1000),
        expires_at: params.expiresAt
      };
      sessions.set(id, session);
      return clone(session);
    },
    async retrieveCheckoutSession(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session hittades inte');
      return clone(session);
    },
    async expireCheckoutSession(id) {
      const session = sessions.get(id);
      if (session) {
        session.status = 'expired';
        session.payment_status = 'unpaid';
      }
    },
    markPaid(id, overrides = {}) {
      const session = sessions.get(id);
      Object.assign(session, { status: 'complete', payment_status: 'paid' }, overrides);
      return clone(session);
    },
    get(id) {
      return sessions.get(id) ? clone(sessions.get(id)) : null;
    }
  };
  return stripe;
}

function optionsFor(store, stripe, overrides = {}) {
  return {
    store,
    existingBookingAddonsEnabled: true,
    stripeEnabled: true,
    cardEnabled: true,
    stripeMode: 'test',
    stripeClient: stripe,
    outboxEnabled: true,
    rules: RULES,
    publicBaseUrl: 'https://www.skadeviherrgard.com',
    now: NOW,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } }),
    ...overrides
  };
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250 + 1}`;
}

async function verify(store, stripe, overrides = {}, identity = {}) {
  const reference = identity.reference ?? BOOKING_REFERENCE;
  const email = identity.email ?? EMAIL;
  const options = optionsFor(store, stripe, overrides);
  const ip = nextIp();
  const started = await handleAddonVerifyStart(
    { body: { reference, email }, ip },
    {},
    options
  );
  assert.equal(started.status, 202);
  const mail = [...store.outbox.values()].find((row) =>
    row.mailType === 'GUEST_ADDON_VERIFICATION_CODE' && row.reference === reference);
  assert.ok(mail, 'verifieringsmejl saknas');
  const match = /Verifieringskod:\s*(\d{6})/.exec(mail.mailText);
  assert.ok(match, 'koden kunde inte läsas från mejlet');
  const confirmed = await handleAddonVerifyConfirm(
    { body: { reference, email, code: match[1] }, ip },
    {},
    options
  );
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.jsonBody));
  return { token: confirmed.jsonBody.token, options, code: match[1] };
}

async function startCheckout(state, stripe, items, overrides = {}) {
  const { token, options } = await verify(state.store, stripe, overrides);
  const result = await handleAddonCheckout(
    {
      token,
      ip: '10.0.0.2',
      idempotencyKey: 'idem-addon-0001',
      body: {
        items,
        acceptTerms: true,
        termsVersion: RULES.version
      }
    },
    {},
    options
  );
  return { result, token, options };
}

function stripeSessionIdOf(stripe, checkoutResult) {
  const match = /cs_[A-Za-z0-9_]+/.exec(checkoutResult.jsonBody.checkoutUrl ?? '');
  return match ? match[0] : '';
}

test('feature flaggan är avstängd som standard och endpoint svarar 503', async () => {
  assert.equal(addonsAvailable({}), false);
  const state = createStore(booking());
  const response = await handleAddonVerifyStart(
    { body: { reference: BOOKING_REFERENCE, email: EMAIL }, ip: '10.0.0.9' },
    {},
    { store: state.store, existingBookingAddonsEnabled: false }
  );
  assert.equal(response.status, 503);
});

test('okänt bokningsnummer och fel e-post ger samma neutrala svar utan mejl', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const options = optionsFor(state.store, stripe);
  const unknown = await handleAddonVerifyStart(
    { body: { reference: 'SK-2027-ZZ999', email: EMAIL }, ip: '10.0.0.10' },
    {},
    options
  );
  assert.equal(unknown.status, 202);
  assert.match(unknown.jsonBody.message, /Om uppgifterna stämmer/);
  const wrongEmail = await handleAddonVerifyStart(
    { body: { reference: BOOKING_REFERENCE, email: 'fel@example.com' }, ip: '10.0.0.11' },
    {},
    options
  );
  assert.equal(wrongEmail.status, 202);
  assert.match(wrongEmail.jsonBody.message, /Om uppgifterna stämmer/);
  assert.equal(state.outbox.size, 0);
});

test('fel kod, utgången kod och för många försök ger neutralt fel', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const options = optionsFor(state.store, stripe);
  await handleAddonVerifyStart(
    { body: { reference: BOOKING_REFERENCE, email: EMAIL }, ip: '10.0.0.12' },
    {},
    options
  );
  const mail = [...state.outbox.values()].find((row) => row.mailType === 'GUEST_ADDON_VERIFICATION_CODE');
  const code = /Verifieringskod:\s*(\d{6})/.exec(mail.mailText)[1];
  for (let attempt = 0; attempt < 5; attempt++) {
    const wrong = await handleAddonVerifyConfirm(
      { body: { reference: BOOKING_REFERENCE, email: EMAIL, code: '000000' === code ? '111111' : '000000' }, ip: '10.0.0.12' },
      {},
      options
    );
    assert.equal(wrong.status, 400);
    assert.equal(wrong.jsonBody.code, 'VERIFICATION_FAILED');
  }
  const blocked = await handleAddonVerifyConfirm(
    { body: { reference: BOOKING_REFERENCE, email: EMAIL, code }, ip: '10.0.0.12' },
    {},
    options
  );
  assert.equal(blocked.status, 400);
  assert.equal(blocked.jsonBody.token, undefined);

  const expiredState = createStore(booking());
  const expiredOptions = optionsFor(expiredState.store, stripe);
  await handleAddonVerifyStart(
    { body: { reference: BOOKING_REFERENCE, email: EMAIL }, ip: '10.0.0.13' },
    {},
    expiredOptions
  );
  const expiredMail = [...expiredState.outbox.values()].find((row) => row.mailType === 'GUEST_ADDON_VERIFICATION_CODE');
  const expiredCode = /Verifieringskod:\s*(\d{6})/.exec(expiredMail.mailText)[1];
  const expired = await handleAddonVerifyConfirm(
    { body: { reference: BOOKING_REFERENCE, email: EMAIL, code: expiredCode }, ip: '10.0.0.13' },
    {},
    { ...expiredOptions, now: new Date(NOW.getTime() + 11 * 60 * 1000) }
  );
  assert.equal(expired.status, 400);
});

test('verifierad session ger endast åtkomst till sin egen bokning och visar rätt tillval', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { token } = await verify(state.store, stripe);
  const result = await handleAddonSession({ token }, {}, optionsFor(state.store, stripe));
  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.reference, BOOKING_REFERENCE);
  assert.equal(result.jsonBody.available.some((item) => item.id === 'slutstad'), false);
  const linen = result.jsonBody.available.find((item) => item.id === 'lakan');
  assert.equal(linen.max, 2, 'endast återstående linneset ska erbjudas');
  assert.equal(result.jsonBody.requestOnly.some((item) => item.id === 'extrahus'), true);

  const other = booking({ reference: 'SK-2027-CD456', email: 'bert@example.com', firstName: 'Bert' });
  state.addBooking(other);
  const otherToken = (await verify(state.store, stripe, {}, { reference: other.reference, email: other.email })).token;
  const otherResult = await handleAddonSession({ token: otherToken }, {}, optionsFor(state.store, stripe));
  assert.equal(otherResult.status, 200);
  assert.equal(otherResult.jsonBody.reference, other.reference, 'token får inte byta bokning');

  const denied = await handleAddonSession({ token: 'x'.repeat(40) }, {}, optionsFor(state.store, stripe));
  assert.equal(denied.status, 401);
});

test('Stripe Checkout debiterar endast nya tillval och buffertnatten reserveras', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { result } = await startCheckout(state, stripe, {
    ved: true,
    senUtcheckning: true,
    lakan: true,
    linenCount: 2
  });
  assert.equal(result.status, 201, JSON.stringify(result.jsonBody));
  // 350 + 500 + 2 × 200 = 1250 kr – boendets 14 000 kr ingår inte.
  assert.equal(result.jsonBody.totalOre, 125000);
  const session = stripe.get(stripeSessionIdOf(stripe, result));
  assert.equal(session.amount_total, 125000);
  assert.equal(session.metadata.source, 'existing-booking-addons');
  assert.equal(session.metadata.reference, BOOKING_REFERENCE);
  assert.equal(state.getBooking(BOOKING_REFERENCE).total, 14000);
  assert.equal(state.getBooking(BOOKING_REFERENCE).addons.ved, false);
  const buffer = state.calendar.get('main:2027-03-13');
  assert.ok(buffer, 'sen utcheckning ska reservera natten efter avresa');
  assert.equal(buffer.source, 'ADDON');
  assert.equal(buffer.reference, BOOKING_REFERENCE);
  assert.equal(buffer.type, 'RESERVATION');
});

test('redan köpta tillval kan inte dubbelköpas och linnetaket gäller', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { token, options } = await verify(state.store, stripe);
  const duplicate = await handleAddonCheckout(
    { token, ip: '10.0.0.14', idempotencyKey: 'idem-addon-0002', body: { items: { slutstad: true }, acceptTerms: true, termsVersion: RULES.version } },
    {},
    options
  );
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.jsonBody.code, 'ALREADY_PURCHASED');
  const tooMany = await handleAddonCheckout(
    { token, ip: '10.0.0.15', idempotencyKey: 'idem-addon-0003', body: { items: { lakan: true, linenCount: 3 }, acceptTerms: true, termsVersion: RULES.version } },
    {},
    options
  );
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.jsonBody.code, 'LINEN_LIMIT');
});

test('betalningswebhooken lägger till tillvalen en gång och skickar en bekräftelse', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { result, options } = await startCheckout(state, stripe, { ved: true, senUtcheckning: true });
  const session = stripe.markPaid(stripeSessionIdOf(stripe, result));
  const event = { id: 'evt_addon_1', type: 'checkout.session.completed' };
  const applied = await handleAddonStripeEvent(event, session, options, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.jsonBody));
  assert.equal(applied.jsonBody.applied, true);

  const updated = state.getBooking(BOOKING_REFERENCE);
  assert.equal(updated.arrival, '2027-03-10');
  assert.equal(updated.departure, '2027-03-13');
  assert.equal(updated.lodgingAfterDiscount, 11100);
  assert.equal(updated.addons.ved, true);
  assert.equal(updated.addons.senUtcheckning, true);
  assert.equal(updated.total, 14850);
  assert.equal(updated.amountPaid, 14850);
  assert.equal(updated.balance, 0);
  assert.equal(updated.paymentStatus, 'PAID');
  assert.equal(updated.payments.length, 2);
  assert.equal(updated.addonOrders.length, 1);
  assert.equal(updated.addonPayments.length, 1);
  const converted = state.calendar.get('main:2027-03-13');
  assert.equal(converted.type, 'BOOKING');
  assert.equal(converted.kind, 'BUFFER');

  const mails = [...state.outbox.values()].filter((row) => row.mailType.startsWith('GUEST_ADDON_PURCHASE') || row.mailType === 'HOST_ADDON_PURCHASE');
  assert.equal(mails.length, 2);

  const duplicate = await handleAddonStripeEvent(event, session, options, {});
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.jsonBody.duplicate, true);
  const after = state.getBooking(BOOKING_REFERENCE);
  assert.equal(after.payments.length, 2);
  assert.equal(after.addonOrders.length, 1);
  assert.equal([...state.outbox.values()].filter((row) => row.mailType.startsWith('GUEST_ADDON_PURCHASE') || row.mailType === 'HOST_ADDON_PURCHASE').length, 2);
});

test('fel belopp, avbokad bokning och Airbnb-konflikt går till avstämning utan att ändra bokningen', async () => {
  for (const scenario of ['amount', 'cancelled', 'airbnb']) {
    const state = createStore(booking());
    const stripe = createFakeStripe();
    const checkoutItems = scenario === 'airbnb' ? { senUtcheckning: true } : { ved: true };
    const { result, options } = await startCheckout(state, stripe, checkoutItems);
    const sessionId = stripeSessionIdOf(stripe, result);
    let session = stripe.markPaid(sessionId, scenario === 'amount' ? { amount_total: 100 } : {});
    if (scenario === 'cancelled') {
      const cancelled = { ...state.getBooking(BOOKING_REFERENCE), statusCode: 'CANCELLED' };
      state.setBooking(cancelled);
    }
    const scenarioOptions = scenario === 'airbnb'
      ? { ...options, availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2027-03-13'] } }) }
      : options;
    const applied = await handleAddonStripeEvent({ id: `evt_${scenario}`, type: 'checkout.session.completed' }, session, scenarioOptions, {});
    assert.equal(applied.status, 200, scenario);
    assert.equal(applied.jsonBody.reconciliation, true, scenario);
    const current = state.getBooking(BOOKING_REFERENCE);
    assert.equal(current.addons.ved, false, scenario);
    assert.equal(current.total, scenario === 'cancelled' ? 14000 : 14000, scenario);
    const orders = await listAddonOrders(state.store, BOOKING_REFERENCE);
    assert.equal(orders[0].status, 'RECONCILIATION', scenario);
  }
});

test('avbruten eller utgången Checkout frigör endast sina egna buffertnätter', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { result, options } = await startCheckout(state, stripe, { senUtcheckning: true });
  const sessionId = stripeSessionIdOf(stripe, result);
  assert.ok(state.calendar.has('main:2027-03-13'));
  await stripe.expireCheckoutSession(sessionId);
  const expiredSession = stripe.get(sessionId);
  const expired = await handleAddonStripeEvent(
    { id: 'evt_addon_expired', type: 'checkout.session.expired' },
    expiredSession,
    options,
    {}
  );
  assert.equal(expired.status, 200, JSON.stringify(expired.jsonBody));
  assert.equal(state.calendar.has('main:2027-03-13'), false);
  const orders = await listAddonOrders(state.store, BOOKING_REFERENCE);
  assert.equal(orders[0].status, 'EXPIRED');
  assert.equal(state.getBooking(BOOKING_REFERENCE).total, 14000);
});

test('manuell tillvalsförfrågan sparas, notifierar och ändrar inte bokningen', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { token, options } = await verify(state.store, stripe);
  const before = state.getBooking(BOOKING_REFERENCE);
  const response = await handleAddonRequest(
    { token, ip: '10.0.0.16', body: { items: { extrahus: { nights: 2, guests: 4 }, otherText: 'Barnstol' } } },
    {},
    options
  );
  assert.equal(response.status, 201, JSON.stringify(response.jsonBody));
  const after = state.getBooking(BOOKING_REFERENCE);
  assert.equal(after.statusCode, before.statusCode);
  assert.equal(after.total, before.total);
  const requests = await listAddonRequests(state.store, BOOKING_REFERENCE);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].lines.some((line) => line.id === 'extrahus'), true);
  const mails = [...state.outbox.values()].filter((row) => row.mailType === 'GUEST_ADDON_REQUEST_RECEIVED' || row.mailType === 'HOST_ADDON_REQUEST');
  assert.equal(mails.length, 2);
});

test('manuella buffertar och fel villkor stoppar automatisk betalning', async () => {
  const manual = createStore(booking({ bufferNightsMode: 'manual', addons: { ...booking().addons, senUtcheckning: false } }));
  const stripe = createFakeStripe();
  const { token, options } = await verify(manual.store, stripe);
  const manualResult = await handleAddonCheckout(
    { token, ip: '10.0.0.17', idempotencyKey: 'idem-addon-manual', body: { items: { senUtcheckning: true }, acceptTerms: true, termsVersion: RULES.version } },
    {},
    options
  );
  assert.equal(manualResult.status, 409);
  assert.equal(manualResult.jsonBody.code, 'MANUAL_BUFFERS');

  const terms = createStore(booking());
  const termsVerify = await verify(terms.store, stripe);
  const termsResult = await handleAddonCheckout(
    { token: termsVerify.token, ip: '10.0.0.18', idempotencyKey: 'idem-addon-terms', body: { items: { ved: true }, acceptTerms: false, termsVersion: 'gammal' } },
    {},
    termsVerify.options
  );
  assert.equal(termsResult.status, 400);
  assert.equal(termsResult.jsonBody.code, 'TERMS_NOT_ACCEPTED');
});

test('samma idempotensnyckel återanvänder en pågående Checkout', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { token, options } = await verify(state.store, stripe);
  const body = { items: { ved: true }, acceptTerms: true, termsVersion: RULES.version };
  const first = await handleAddonCheckout({ token, ip: '10.0.0.19', idempotencyKey: 'idem-addon-same', body }, {}, options);
  assert.equal(first.status, 201);
  const second = await handleAddonCheckout({ token, ip: '10.0.0.19', idempotencyKey: 'idem-addon-same', body }, {}, options);
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.checkoutUrl, first.jsonBody.checkoutUrl);
  const orders = await listAddonOrders(state.store, BOOKING_REFERENCE);
  assert.equal(orders.length, 1);
});

test('den signerade Stripe-webhooken dirigerar tillvalsk�p till r�tt order', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { result, options } = await startCheckout(state, stripe, { ved: true });
  const session = stripe.markPaid(stripeSessionIdOf(stripe, result));
  const payload = Buffer.from(JSON.stringify({
    id: 'evt_addon_signed',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session }
  }), 'utf8');
  const timestamp = Math.floor(NOW.getTime() / 1000);
  const response = await handleStripeWebhook(
    {
      rawBody: payload,
      signature: signStripePayload(payload, 'whsec_test_addon', timestamp)
    },
    {},
    {
      ...options,
      enabled: true,
      webhookSecret: 'whsec_test_addon',
      store: state.store
    }
  );
  assert.equal(response.status, 200, JSON.stringify(response.jsonBody));
  assert.equal(response.jsonBody.applied, true);
  assert.equal(state.getBooking(BOOKING_REFERENCE).addons.ved, true);
});

test('under- och �verbetalning bevarar bokningen och g�r till avst�mning', async () => {
  for (const [label, amount] of [['under', 100], ['over', 999999]]) {
    const state = createStore(booking());
    const stripe = createFakeStripe();
    const { result, options } = await startCheckout(state, stripe, { ved: true });
    const session = stripe.markPaid(stripeSessionIdOf(stripe, result), { amount_total: amount });
    const applied = await handleAddonStripeEvent({ id: `evt_${label}`, type: 'checkout.session.completed' }, session, options, {});
    assert.equal(applied.status, 200, label);
    assert.equal(applied.jsonBody.reconciliation, true, label);
    const current = state.getBooking(BOOKING_REFERENCE);
    assert.equal(current.addons.ved, false, label);
    assert.equal(current.total, 14000, label);
    assert.equal(current.payments.length, 1, label);
  }
});

test('intern buffertkonflikt och Airbnb-fel stoppar Checkout utan att skapa order', async () => {
  const conflictState = createStore(booking());
  const conflictStripe = createFakeStripe();
  conflictState.calendar.set('main:2027-03-13', {
    night: '2027-03-13',
    resource: 'main',
    type: 'BOOKING',
    kind: 'BOOKING',
    reference: 'SK-2027-OTHER'
  });
  const conflict = await startCheckout(conflictState, conflictStripe, { senUtcheckning: true });
  assert.equal(conflict.result.status, 409);
  assert.equal(conflict.result.jsonBody.code, 'BUFFER_UNAVAILABLE');
  assert.equal((await listAddonOrders(conflictState.store, BOOKING_REFERENCE)).length, 0);
  assert.equal(conflictState.getBooking(BOOKING_REFERENCE).total, 14000);

  const downState = createStore(booking());
  const downStripe = createFakeStripe();
  const down = await startCheckout(downState, downStripe, { senUtcheckning: true }, {
    availabilityHandler: async () => { throw new Error('Airbnb nere'); }
  });
  assert.equal(down.result.status, 503);
  assert.equal(down.result.jsonBody.code, 'BUFFER_UNAVAILABLE');
  assert.equal(downState.calendar.has('main:2027-03-13'), false);
  assert.equal((await listAddonOrders(downState.store, BOOKING_REFERENCE)).length, 0);
});

test('injektionsf�rs�k i bokningsnummer ger neutralt svar och skapar ingen verifiering', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const response = await handleAddonVerifyStart(
    { body: { reference: '<script>alert(1)</script>', email: "anna@example.com' OR 1=1" }, ip: '10.0.0.200' },
    {},
    optionsFor(state.store, stripe)
  );
  assert.equal(response.status, 202);
  assert.equal(response.jsonBody.message.startsWith('Om uppgifterna'), true);
  assert.equal(state.outbox.size, 0);
  assert.equal((await state.store.listAux('addonverification')).length, 0);
});

test('databasfel vid verifieringsstart ger neutralt svar utan krasch', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  state.store.getByReference = async () => { throw new Error('databasfel'); };
  const response = await handleAddonVerifyStart(
    { body: { reference: BOOKING_REFERENCE, email: EMAIL }, ip: '10.0.0.201' },
    {},
    optionsFor(state.store, stripe)
  );
  assert.equal(response.status, 202);
  assert.equal(response.jsonBody.message.startsWith('Om uppgifterna'), true);
});

test('mejlfel efter verifierad betalning bevarar k�pet och kan �terh�mtas', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { result, options } = await startCheckout(state, stripe, { ved: true });
  const session = stripe.markPaid(stripeSessionIdOf(stripe, result));
  const originalSave = state.store.save.bind(state.store);
  state.store.save = async (record) => {
    if (record.mailType === 'GUEST_ADDON_PURCHASE_CONFIRMATION') {
      throw new Error('Resend/utkorg nere');
    }
    return originalSave(record);
  };
  const first = await handleAddonStripeEvent({ id: 'evt_mail_fail', type: 'checkout.session.completed' }, session, options, {});
  assert.equal(first.status, 503);
  const afterFailure = state.getBooking(BOOKING_REFERENCE);
  assert.equal(afterFailure.addons.ved, true, 'k�pet ska inte f�rloras');
  assert.equal(afterFailure.addonOrders.length, 1);

  state.store.save = originalSave;
  const retry = await handleAddonStripeEvent({ id: 'evt_mail_retry', type: 'checkout.session.completed' }, session, options, {});
  assert.equal(retry.status, 200, JSON.stringify(retry.jsonBody));
  assert.equal(state.getBooking(BOOKING_REFERENCE).addonOrders.length, 1);
  const mails = [...state.outbox.values()].filter((row) => row.mailType === 'GUEST_ADDON_PURCHASE_CONFIRMATION' || row.mailType === 'HOST_ADDON_PURCHASE');
  assert.equal(mails.length, 2);
});

test('avbruten Checkout kan avslutas explicit och frig�r buffertnatten', async () => {
  const state = createStore(booking());
  const stripe = createFakeStripe();
  const { handleAddonAbandon } = require('../../server/booking/existing-booking-addons');
  const { token, options } = await verify(state.store, stripe);
  const checkout = await handleAddonCheckout(
    { token, ip: '10.0.0.202', idempotencyKey: 'idem-addon-abandon', body: { items: { senUtcheckning: true }, acceptTerms: true, termsVersion: RULES.version } },
    {},
    options
  );
  assert.equal(checkout.status, 201);
  assert.ok(state.calendar.has('main:2027-03-13'));
  const abandoned = await handleAddonAbandon(
    { token, ip: '10.0.0.202', body: { orderId: checkout.jsonBody.orderId } },
    {},
    options
  );
  assert.equal(abandoned.status, 200, JSON.stringify(abandoned.jsonBody));
  assert.equal(state.calendar.has('main:2027-03-13'), false);
  const orders = await listAddonOrders(state.store, BOOKING_REFERENCE);
  assert.equal(orders[0].status, 'EXPIRED');
});
