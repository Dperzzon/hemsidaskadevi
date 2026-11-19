'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleStripeWebhook } = require('../../server/booking/stripe-webhook');
const { signStripePayload } = require('../../server/booking/stripe');
const {
  buildOutboxRecord,
  queueNotification
} = require('../../server/booking/outbox');
const {
  buildBookingConfirmation,
  buildPaymentNotifications,
  buildCancellationNotification,
  buildPaymentFailedNotification
} = require('../../server/booking/booking-mail');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const { queueGuestConfirmation } = require('../../server/admin/booking-service');
const { normalizeBooking } = require('../../server/admin/domain');

const NOW = new Date('2026-11-19T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SECRET = 'whsec_test_skadevi';
const SESSION_ID = 'cs_test_direct11d';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function directRecord(overrides = {}) {
  const request = {
    provider: 'stripe',
    mode: 'test',
    status: 'OPEN',
    sessionId: SESSION_ID,
    url: `https://checkout.stripe.com/c/pay/${SESSION_ID}`,
    amountOre: 2000000,
    currency: 'sek',
    createdAt: '2026-11-19T11:00:00.000Z',
    expiresAt: '2026-11-20T11:00:00.000Z',
    createdBy: 'Gäst',
    createdById: 'guest',
    idempotencyKey: 'direct-request-11d'
  };
  return {
    reference: 'SK-2026-DIRECT1',
    statusCode: 'PENDING_PAYMENT',
    status: 'Väntar på betalning',
    bookingSource: 'DIRECT',
    arrival: '2027-02-10',
    departure: '2027-02-12',
    nights: 2,
    guests: 4,
    firstName: 'Direkt',
    lastName: 'Gäst',
    email: 'direkt@example.se',
    phone: '+46 70 111 22 33',
    total: 20000,
    totalAddons: 0,
    addonLines: [{ id: 'slutstad', label: 'Slutstädning', quantity: 1, unitPrice: 0, amount: 0 }],
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    payments: [],
    paymentRequests: [request],
    paymentRequest: request,
    reservation: {
      status: 'ACTIVE',
      reference: 'SK-2026-DIRECT1',
      expiresAt: '2026-11-19T13:00:00.000Z'
    },
    version: 1,
    createdAt: '2026-11-19T11:00:00.000Z',
    updatedAt: '2026-11-19T11:00:00.000Z',
    ...overrides
  };
}

function createDirectStore(record) {
  let current = clone(record);
  let etag = 'etag-1';
  const outbox = [];
  const history = [];
  const calendar = new Map();
  for (const night of ['2027-02-10', '2027-02-11']) {
    calendar.set(night, {
      night,
      type: 'RESERVATION',
      reference: record.reference,
      resource: 'main',
      createdAt: '2026-11-19T11:00:00.000Z',
      etag: `cal-${night}`
    });
  }
  return {
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
    async listCalendarByReference(reference) {
      return [...calendar.values()].filter((row) => row.reference === reference).map(clone);
    },
    async updateCalendarNight(night, data) {
      const row = calendar.get(night);
      if (!row) {
        const error = new Error('saknas');
        error.status = 404;
        throw error;
      }
      calendar.set(night, { ...row, ...clone(data) });
      return { record: clone(calendar.get(night)) };
    },
    async deleteCalendarNight(night) {
      calendar.delete(night);
    },
    get current() { return clone(current); },
    get outbox() { return clone(outbox); },
    get history() { return clone(history); }
  };
}

function session(overrides = {}) {
  return {
    id: SESSION_ID,
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 2000000,
    currency: 'sek',
    payment_method_types: ['card'],
    livemode: false,
    payment_intent: 'pi_test_11d',
    client_reference_id: 'SK-2026-DIRECT1',
    metadata: { reference: 'SK-2026-DIRECT1' },
    ...overrides
  };
}

function event(type = 'checkout.session.completed', object = session()) {
  return { id: `evt_${type}_11d`, type, livemode: false, data: { object } };
}

async function callWebhook(store, eventObject) {
  const payload = JSON.stringify(eventObject);
  return handleStripeWebhook(
    { rawBody: Buffer.from(payload), signature: signStripePayload(payload, SECRET, NOW_SECONDS) },
    { warn: () => {} },
    { enabled: true, webhookSecret: SECRET, store, now: NOW, outboxEnabled: true }
  );
}

test('utkorgsformatet kräver giltig mottagare och sätter alla sändningsfält', () => {
  const record = buildOutboxRecord({
    idempotencyKey: 'outbox-test-1',
    reference: 'SK-2026-TEST',
    notification: {
      mailType: 'GUEST_BOOKING_CONFIRMED',
      to: 'gast@example.se',
      replyTo: 'skadevigard@gmail.com',
      subject: 'Test',
      html: '<p>Test</p>',
      body: 'Test'
    },
    createdAt: NOW.toISOString()
  });
  assert.equal(record.dispatchEligible, 'true');
  assert.equal(record.outboxVersion, '1');
  assert.equal(record.deliveryStatus, 'Ej skickad');
  assert.equal(record.status, 'Utkorg');
  assert.throws(() => buildOutboxRecord({
    idempotencyKey: 'outbox-test-2',
    reference: 'SK-2026-TEST',
    notification: { mailType: 'GUEST_BOOKING_CONFIRMED', to: 'inte-en-adress', subject: 'x' }
  }), /Ogiltig mottagaradress/);
});

test('misslyckad köläggning loggas som EMAIL_QUEUE_FAILED utan mejlbody', async () => {
  const history = [];
  const result = await queueNotification(
    async () => { throw new Error('lagring nere'); },
    {
      idempotencyKey: 'outbox-fail-1',
      reference: 'SK-2026-FAIL',
      notification: {
        mailType: 'GUEST_PAYMENT_RECEIPT',
        to: 'gast@example.se',
        subject: 'Test',
        html: '<p>hemligt</p>',
        body: 'hemligt'
      },
      context: {
        warn: () => {},
        appendHistory: async (entry) => history.push(entry)
      }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'EMAIL_QUEUE_FAILED');
  assert.match(history[0].changes, /GUEST_PAYMENT_RECEIPT/);
  assert.doesNotMatch(history[0].changes, /hemligt/);
});

test('bokningsbekräftelsen visar alla uppgifter och skiljer delbetalning från fullbetalt', () => {
  const partial = {
    reference: 'SK-2026-CONF1',
    statusCode: 'CONFIRMED',
    arrival: '2027-03-01',
    departure: '2027-03-04',
    nights: 3,
    guests: 6,
    firstName: 'Anna',
    email: 'anna@example.se',
    total: 20000,
    paymentOpeningBalanceOre: 500000,
    addonLines: [{ label: 'Slutstädning', quantity: 1, unitPrice: 1500, amount: 1500 }]
  };
  const partialMail = buildBookingConfirmation(partial);
  assert.match(partialMail.html, /Bokningsreferens: SK-2026-CONF1/);
  assert.match(partialMail.html, /1 mars 2027/);
  assert.match(partialMail.html, /Antal gäster: 6/);
  assert.match(partialMail.html, /Slutstädning/);
  assert.match(partialMail.html, /5[\s\u00a0]000 kr/);
  assert.match(partialMail.html, /15[\s\u00a0]000 kr/);
  assert.match(partialMail.html, /inte fullbetald/);
  assert.match(partialMail.html, /Skoklostervägen 16/);
  assert.doesNotMatch(partialMail.html, /Hela bokningsbeloppet är betalt/);

  const fullMail = buildBookingConfirmation({
    ...partial,
    paymentOpeningBalanceOre: 2000000
  });
  assert.match(fullMail.html, /Hela bokningsbeloppet är betalt/);
  assert.doesNotMatch(fullMail.html, /inte fullbetald/);
});

test('betalningskvittot beskriver deposition, delbetalning och slutbetalning korrekt', () => {
  const base = {
    reference: 'SK-2026-PAY2',
    statusCode: 'CONFIRMED',
    arrival: '2027-03-01',
    departure: '2027-03-04',
    nights: 3,
    guests: 6,
    firstName: 'Anna',
    email: 'anna@example.se',
    total: 20000,
    addonLines: []
  };
  const depositPayment = { amountOre: 500000, method: 'CARD' };
  const deposit = buildPaymentNotifications(base, depositPayment, {
    totalOre: 2000000, paidOre: 500000, remainingOre: 1500000,
    overpaidOre: 0, paymentStatus: 'PARTIALLY_PAID', paymentLabel: 'Delbetalt'
  });
  assert.match(deposit.guest.html, /Deposition\/delbetalning/);
  assert.match(deposit.guest.html, /inte fullbetald/);
  assert.doesNotMatch(deposit.guest.html, /Hela bokningsbeloppet är nu betalt/);

  const finalPayment = { amountOre: 1500000, method: 'CARD' };
  const final = buildPaymentNotifications(base, finalPayment, {
    totalOre: 2000000, paidOre: 2000000, remainingOre: 0,
    overpaidOre: 0, paymentStatus: 'PAID', paymentLabel: 'Betald'
  });
  assert.match(final.guest.html, /Slutbetalning/);
  assert.match(final.guest.html, /Hela bokningsbeloppet är nu betalt/);
});

test('direktbokning efter verifierad betalning skickar en kombinerad bekräftelse utan separat kvitto', async () => {
  const store = createDirectStore(directRecord());
  const response = await callWebhook(store, event());
  assert.equal(response.status, 200);
  assert.equal(store.current.statusCode, 'CONFIRMED');
  assert.deepEqual(
    store.outbox.map((row) => row.mailType).sort(),
    ['GUEST_BOOKING_CONFIRMED', 'HOST_PAYMENT_RECEIVED']
  );
  for (const row of store.outbox) {
    assert.equal(row.dispatchEligible, 'true');
    assert.equal(row.outboxVersion, '1');
    assert.equal(row.deliveryStatus, 'Ej skickad');
  }
  const confirmation = store.outbox.find((row) => row.mailType === 'GUEST_BOOKING_CONFIRMED');
  assert.match(confirmation.mailHtml, /Din bokning är bekräftad/);
  assert.match(confirmation.mailHtml, /10 februari 2027/);
  assert.match(confirmation.mailHtml, /Hela bokningsbeloppet är betalt/);
  assert.doesNotMatch(confirmation.mailHtml, /pi_test_11d/);
});

test('dubbel direktbokningswebhook ger aldrig dubbla bekräftelser', async () => {
  const store = createDirectStore(directRecord());
  const first = await callWebhook(store, event());
  const second = await callWebhook(store, event());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.duplicate, true);
  assert.equal(store.outbox.length, 2);
  assert.equal(store.outbox.filter((row) => row.mailType === 'GUEST_BOOKING_CONFIRMED').length, 1);
});

test('utgången direktbetalning skickar ett säkert misslyckandemejl utan bekräftelse', async () => {
  const store = createDirectStore(directRecord());
  const response = await callWebhook(store, event('checkout.session.expired', session({
    status: 'expired',
    payment_status: 'unpaid'
  })));
  assert.equal(response.status, 200);
  assert.equal(store.current.statusCode, 'EXPIRED');
  assert.deepEqual(store.outbox.map((row) => row.mailType), ['GUEST_PAYMENT_FAILED']);
  const failed = store.outbox[0];
  assert.equal(failed.dispatchEligible, 'true');
  assert.equal(failed.outboxVersion, '1');
  assert.match(failed.mailHtml, /inte bekräftad/);
  assert.match(failed.mailHtml, /Ingen betalning har registrerats/);
  assert.doesNotMatch(failed.mailHtml, /Din bokning är bekräftad/);
});

test('avbokningsmejl och makulering av väntande länkar fungerar', async () => {
  const repository = createDemoRepository({ now: NOW });
  await repository.saveOutbox({
    idempotencyKey: 'old-link', reference: 'SK-2026-CANCEL', mailType: 'GUEST_PAYMENT_LINK',
    status: 'Utkorg', deliveryStatus: 'Ej skickad', createdAt: NOW.toISOString()
  });
  await repository.saveOutbox({
    idempotencyKey: 'old-confirm', reference: 'SK-2026-CANCEL', mailType: 'GUEST_BOOKING_CONFIRMED',
    status: 'Utkorg', deliveryStatus: 'Ej skickad', createdAt: NOW.toISOString()
  });
  await repository.saveOutbox({
    idempotencyKey: 'old-sent', reference: 'SK-2026-CANCEL', mailType: 'GUEST_PAYMENT_LINK',
    status: 'Skickad', deliveryStatus: 'delivered', createdAt: NOW.toISOString()
  });
  const cancelled = await repository.cancelPendingOutbox('SK-2026-CANCEL', {
    mailTypes: ['GUEST_PAYMENT_LINK', 'GUEST_BOOKING_CONFIRMED'],
    reason: 'Avbokad',
    now: NOW
  });
  assert.equal(cancelled, 2);
  const mail = buildCancellationNotification({
    reference: 'SK-2026-CANCEL',
    arrival: '2027-04-01',
    departure: '2027-04-03',
    nights: 2,
    guests: 2,
    firstName: 'Eva',
    email: 'eva@example.se',
    total: 5000,
    amountPaid: 1000
  });
  assert.match(mail.html, /Din bokning är avbokad/);
  assert.match(mail.html, /Eventuell återbetalning hanteras enligt bokningsvillkoren/);
  assert.doesNotMatch(mail.html, /Din bokning är bekräftad/);
});

test('misslyckandemejlet påstår aldrig att bokningen är bekräftad', () => {
  const mail = buildPaymentFailedNotification({
    reference: 'SK-2026-FAIL2',
    arrival: '2027-04-01',
    departure: '2027-04-03',
    nights: 2,
    guests: 2,
    firstName: 'Eva',
    email: 'eva@example.se'
  });
  assert.match(mail.html, /inte bekräftad/);
  assert.doesNotMatch(mail.html, /Din bokning är bekräftad\./);
});

test('en obekräftad bokning kan aldrig få ett bekräftelsemejl', async () => {
  const outbox = [];
  const result = await queueGuestConfirmation({
    async saveOutbox(entry) { outbox.push(entry); },
    async appendHistory() {}
  }, {
    reference: 'SK-2026-PENDING',
    statusCode: 'PENDING',
    version: 1,
    email: 'gast@example.se',
    arrival: '2027-05-01',
    departure: '2027-05-03',
    nights: 2,
    guests: 2,
    total: 5000
  }, { outboxEnabled: true }, { warn: () => {} });
  assert.equal(result.queued, false);
  assert.equal(result.skipped, 'not_confirmed');
  assert.equal(outbox.length, 0);
});

test('ogiltig mottagaradress stoppar inte bokningen men loggas som köfel', async () => {
  const history = [];
  const result = await queueNotification(
    async () => { throw new Error('ska inte anropas'); },
    {
      idempotencyKey: 'outbox-invalid-1',
      reference: 'SK-2026-INVALID',
      notification: {
        mailType: 'GUEST_PAYMENT_RECEIPT',
        to: 'inte-en-adress',
        subject: 'Test',
        html: '<p>Test</p>',
        body: 'Test'
      },
      context: { warn: () => {}, appendHistory: async (entry) => history.push(entry) }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(history[0].action, 'EMAIL_QUEUE_FAILED');
});

test('återbekräftelse efter avbokning får ny nyckel men återförsök ger ingen dubblett', async () => {
  const outbox = [];
  const repository = {
    async saveOutbox(entry) {
      if (outbox.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
        return { duplicate: true };
      }
      outbox.push(entry);
      return { duplicate: false };
    },
    async appendHistory() {}
  };
  const base = {
    reference: 'SK-2026-RECONFIRM',
    statusCode: 'CONFIRMED',
    version: 2,
    email: 'gast@example.se',
    arrival: '2027-06-01',
    departure: '2027-06-03',
    nights: 2,
    guests: 2,
    total: 5000
  };
  const first = await queueGuestConfirmation(repository, base, { outboxEnabled: true }, { warn: () => {} });
  const retry = await queueGuestConfirmation(repository, base, { outboxEnabled: true }, { warn: () => {} });
  const reconfirmed = await queueGuestConfirmation(
    repository,
    { ...base, version: 4 },
    { outboxEnabled: true },
    { warn: () => {} }
  );
  assert.equal(first.queued, true);
  assert.equal(retry.queued, false);
  assert.equal(retry.duplicate, true);
  assert.equal(reconfirmed.queued, true);
  assert.deepEqual(outbox.map((row) => row.idempotencyKey), [
    'outbox-confirmation-SK-2026-RECONFIRM-v2',
    'outbox-confirmation-SK-2026-RECONFIRM-v4'
  ]);
});

test('adminstatus använder GUEST_REQUEST_ACK och visar senaste värd-/gästmejl', () => {
  const booking = normalizeBooking({
    reference: 'SK-2026-STATUS',
    statusCode: 'CONFIRMED',
    arrival: '2027-04-01',
    departure: '2027-04-03',
    nights: 2,
    guests: 2,
    total: 5000,
    createdAt: NOW.toISOString()
  }, {
    outbox: [
      { mailType: 'HOST_NEW_REQUEST', status: 'Skickad', deliveryStatus: 'delivered', createdAt: '2026-11-19T10:00:00.000Z' },
      { mailType: 'GUEST_REQUEST_ACK', status: 'Skickad', deliveryStatus: 'delivered', createdAt: '2026-11-19T10:01:00.000Z' },
      { mailType: 'GUEST_BOOKING_CONFIRMED', status: 'Utkorg', deliveryStatus: 'Ej skickad', createdAt: '2026-11-19T11:00:00.000Z' }
    ]
  });
  assert.equal(booking.mailStatus.guest.mailType, 'GUEST_BOOKING_CONFIRMED');
  assert.equal(booking.mailStatus.guest.apiLabel, 'Köat');
  assert.equal(booking.mailStatus.guest.queued, true);
  assert.equal(booking.mailEvents.length, 3);
});
