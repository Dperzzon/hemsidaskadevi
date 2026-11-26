'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  handleResendWebhook,
  verifySignature,
  classifyEvent
} = require('../../server/booking/resend-webhook');

const SECRET = `whsec_${Buffer.from('skadevi-test-webhook-secret').toString('base64')}`;
const NOW = new Date('2026-11-26T10:00:00.000Z');

function sign(id, timestamp, body, secret = SECRET) {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(raw, 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;
}

function event(type, overrides = {}) {
  return {
    type,
    created_at: NOW.toISOString(),
    data: {
      email_id: 'resend-message-1',
      to: ['guest@example.com'],
      subject: 'Test',
      ...overrides
    }
  };
}

function requestFor(body, { id = 'evt_1', timestamp = String(Math.floor(NOW.getTime() / 1000)), signature } = {}) {
  return {
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature ?? sign(id, timestamp, JSON.stringify(body))
    }
  };
}

function fakeStore(row = {
  idempotencyKey: 'outbox-1-guest',
  reference: 'SK-2026-TEST01',
  mailType: 'GUEST_BOOKING_CONFIRMED',
  resendId: 'resend-message-1',
  status: 'Skickad',
  deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
  lastEventAt: '',
  lastEventType: ''
}) {
  const state = {
    row: { ...row },
    events: new Set(),
    updates: [],
    history: []
  };
  return {
    state,
    async findOutboxByResendId(emailId) {
      return state.row && state.row.resendId === emailId
        ? { record: { ...state.row }, etag: 'etag-1' }
        : null;
    },
    async updateOutboxDelivery(rowKey, patch, options) {
      state.updates.push({ rowKey, patch, options });
      state.row = { ...state.row, ...patch };
      return { record: state.row, etag: 'etag-2' };
    },
    async recordWebhookEvent(eventId) {
      if (state.events.has(eventId)) return { duplicate: true };
      state.events.add(eventId);
      return { duplicate: false };
    },
    async getWebhookEvent(eventId) {
      return state.events.has(eventId) ? { eventId } : null;
    },
    async appendHistory(entry) {
      state.history.push(entry);
    }
  };
}

test('Resend-webhooken är avstängd som standard och svarar 404', async () => {
  const response = await handleResendWebhook(requestFor(event('email.delivered')), {}, {
    enabled: false,
    secret: SECRET,
    store: fakeStore()
  });
  assert.equal(response.status, 404);
});

test('aktiverad webhook utan hemlighet fail-closar med 503', async () => {
  const response = await handleResendWebhook(requestFor(event('email.delivered')), {}, {
    enabled: true,
    secret: '',
    store: fakeStore()
  });
  assert.equal(response.status, 503);
});

test('ogiltig eller gammal signatur avvisas utan att röra utkorgen', async () => {
  const store = fakeStore();
  const body = event('email.delivered');
  const oldTimestamp = String(Math.floor(NOW.getTime() / 1000) - 3600);
  const response = await handleResendWebhook(requestFor(body, {
    timestamp: oldTimestamp,
    signature: sign('evt_1', oldTimestamp, JSON.stringify(body))
  }), {}, { enabled: true, secret: SECRET, store, now: NOW });
  assert.equal(response.status, 401);
  assert.equal(store.state.updates.length, 0);

  const tampered = requestFor(body, { signature: sign('evt_1', String(Math.floor(NOW.getTime() / 1000)), '{"type":"email.bounced"}') });
  const rejected = await handleResendWebhook(tampered, {}, { enabled: true, secret: SECRET, store, now: NOW });
  assert.equal(rejected.status, 401);
  assert.equal(store.state.updates.length, 0);
});

test('levererad-händelse uppdaterar rätt utkorgspost och skriver historik', async () => {
  const store = fakeStore();
  const response = await handleResendWebhook(requestFor(event('email.delivered')), {}, {
    enabled: true,
    secret: SECRET,
    store,
    now: NOW
  });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.applied, true);
  assert.equal(store.state.updates.length, 1);
  const patch = store.state.updates[0].patch;
  assert.equal(patch.deliveryStatus, 'delivered');
  assert.equal(patch.deliveredAt, NOW.toISOString());
  assert.equal(patch.lastEventType, 'email.delivered');
  assert.equal(store.state.updates[0].options.ifMatch, 'etag-1');
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.history[0].action, 'EMAIL_DELIVERY_UPDATED');
  assert.equal(store.state.history[0].reference, 'SK-2026-TEST01');
  assert.doesNotMatch(JSON.stringify(store.state.history[0]), /guest@example\.com/);
});

test('samma Svix-ID behandlas idempotent och uppdaterar inte två gånger', async () => {
  const store = fakeStore();
  const request = requestFor(event('email.delivered'));
  const first = await handleResendWebhook(request, {}, { enabled: true, secret: SECRET, store, now: NOW });
  const second = await handleResendWebhook(request, {}, { enabled: true, secret: SECRET, store, now: NOW });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.duplicate, true);
  assert.equal(store.state.updates.length, 1);
});

test('bounced-händelse markerar leveransfel utan att lägga in personuppgifter', async () => {
  const store = fakeStore();
  const body = event('email.bounced', {
    bounce: { type: 'Permanent', subType: 'General', message: 'guest@example.com mailbox unavailable' }
  });
  const response = await handleResendWebhook(requestFor(body, { id: 'evt_bounce' }), {}, {
    enabled: true,
    secret: SECRET,
    store,
    now: NOW
  });
  assert.equal(response.status, 200);
  const patch = store.state.updates[0].patch;
  assert.equal(patch.deliveryStatus, 'bounced');
  assert.equal(patch.bouncedAt, NOW.toISOString());
  assert.equal(patch.deliveryError, 'Permanent/General');
  assert.doesNotMatch(JSON.stringify(patch), /guest@example\.com/);
  assert.match(patch.manualReviewReason, /studsade/);
});

test('äldre händelse i fel ordning skriver inte över en nyare terminal status', async () => {
  const store = fakeStore({
    idempotencyKey: 'outbox-1-guest',
    reference: 'SK-2026-TEST01',
    mailType: 'GUEST_BOOKING_CONFIRMED',
    resendId: 'resend-message-1',
    status: 'Skickad',
    deliveryStatus: 'bounced',
    bouncedAt: '2026-11-26T09:58:00.000Z',
    lastEventAt: '2026-11-26T09:58:00.000Z',
    lastEventType: 'email.bounced'
  });
  const older = event('email.delivered');
  older.created_at = '2026-11-26T09:50:00.000Z';
  const response = await handleResendWebhook(requestFor(older, { id: 'evt_old' }), {}, {
    enabled: true,
    secret: SECRET,
    store,
    now: NOW
  });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.applied, false);
  assert.equal(store.state.updates.length, 0);
});

test('tillfälligt lagrings fel gör att samma webhook kan köras igen och då appliceras', async () => {
  const base = fakeStore();
  let failOnce = true;
  const store = {
    ...base,
    async updateOutboxDelivery(rowKey, patch, options) {
      if (failOnce) {
        failOnce = false;
        const error = new Error('tillfälligt fel');
        error.status = 503;
        throw error;
      }
      return base.updateOutboxDelivery(rowKey, patch, options);
    }
  };
  const request = requestFor(event('email.delivered'));
  const first = await handleResendWebhook(request, {}, { enabled: true, secret: SECRET, store, now: NOW });
  assert.equal(first.status, 503);
  assert.equal(base.state.updates.length, 0);
  const second = await handleResendWebhook(request, {}, { enabled: true, secret: SECRET, store, now: NOW });
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.applied, true);
  assert.equal(base.state.updates.length, 1);
});

test('okänt meddelande-ID kvitteras utan matchning', async () => {
  const store = fakeStore();
  const body = event('email.delivered', { email_id: 'okant-meddelande' });
  const response = await handleResendWebhook(requestFor(body, { id: 'evt_unknown' }), {}, {
    enabled: true,
    secret: SECRET,
    store,
    now: NOW
  });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.matched, false);
  assert.equal(store.state.updates.length, 0);
});

test('signaturverifiering accepterar flera v1-värden och avvisar fel hemlighet', () => {
  const body = JSON.stringify(event('email.delivered'));
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const good = sign('evt_1', timestamp, body);
  assert.equal(verifySignature({
    id: 'evt_1',
    timestamp,
    signature: `v1,${Buffer.from('fel').toString('base64')} ${good}`,
    rawBody: body,
    secret: SECRET,
    now: NOW
  }), true);
  assert.equal(verifySignature({
    id: 'evt_1',
    timestamp,
    signature: good,
    rawBody: body,
    secret: `whsec_${Buffer.from('annan-hemlighet').toString('base64')}`,
    now: NOW
  }), false);
});

test('endast kända leveranshändelser klassas', () => {
  assert.equal(classifyEvent('email.delivered').deliveryStatus, 'delivered');
  assert.equal(classifyEvent('email.bounced').terminal, true);
  assert.equal(classifyEvent('email.opened'), null);
  assert.equal(classifyEvent('okand'), null);
});

test('fördröjd leverans följs av delivered utan att tappa historiken', async () => {
  const store = fakeStore();
  const delayed = event('email.delivery_delayed');
  const first = await handleResendWebhook(requestFor(delayed, { id: 'evt_delay' }), {}, {
    enabled: true, secret: SECRET, store, now: NOW
  });
  assert.equal(first.status, 200);
  assert.equal(store.state.updates[0].patch.deliveryStatus, 'delivery_delayed');

  const delivered = event('email.delivered');
  delivered.created_at = '2026-11-26T10:05:00.000Z';
  const second = await handleResendWebhook(requestFor(delivered, { id: 'evt_delivered' }), {}, {
    enabled: true, secret: SECRET, store, now: NOW
  });
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.applied, true);
  assert.equal(store.state.updates[1].patch.deliveryStatus, 'delivered');
  assert.equal(store.state.history.length, 2);
});

test('en senare studs efter levererat mejl registreras, men en äldre ignoreras', async () => {
  const baseRow = {
    idempotencyKey: 'outbox-1-guest',
    reference: 'SK-2026-TEST01',
    mailType: 'GUEST_BOOKING_CONFIRMED',
    resendId: 'resend-message-1',
    status: 'Skickad',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-26T09:58:00.000Z',
    lastEventAt: '2026-11-26T09:58:00.000Z',
    lastEventType: 'email.delivered'
  };

  const laterStore = fakeStore({ ...baseRow });
  const laterBounce = event('email.bounced');
  laterBounce.created_at = '2026-11-26T10:00:00.000Z';
  const applied = await handleResendWebhook(requestFor(laterBounce, { id: 'evt_late_bounce' }), {}, {
    enabled: true, secret: SECRET, store: laterStore, now: NOW
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.jsonBody.applied, true);
  assert.equal(laterStore.state.updates[0].patch.deliveryStatus, 'bounced');

  const olderStore = fakeStore({ ...baseRow });
  const olderBounce = event('email.bounced');
  olderBounce.created_at = '2026-11-26T09:50:00.000Z';
  const ignored = await handleResendWebhook(requestFor(olderBounce, { id: 'evt_old_bounce' }), {}, {
    enabled: true, secret: SECRET, store: olderStore, now: NOW
  });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.jsonBody.applied, false);
  assert.equal(olderStore.state.updates.length, 0);
  assert.equal(olderStore.state.row.deliveryStatus, 'delivered');
});

test('okänd händelsetyp kvitteras utan att röra utkorgen', async () => {
  const store = fakeStore();
  const response = await handleResendWebhook(requestFor(event('email.opened'), { id: 'evt_open' }), {}, {
    enabled: true, secret: SECRET, store, now: NOW
  });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.handled, false);
  assert.equal(store.state.updates.length, 0);
});

test('ogiltigt Resend-ID avvisas innan lagringsuppslag', async () => {
  const store = fakeStore();
  const body = event('email.delivered', { email_id: "x' or PartitionKey ne '" });
  const response = await handleResendWebhook(requestFor(body, { id: 'evt_inject' }), {}, {
    enabled: true, secret: SECRET, store, now: NOW
  });
  assert.equal(response.status, 400);
  assert.equal(store.state.updates.length, 0);
});

test('samtidig ETag-konflikt läses om och appliceras en gång', async () => {
  const base = fakeStore();
  let conflicts = 1;
  const store = {
    ...base,
    async updateOutboxDelivery(rowKey, patch, options) {
      if (conflicts > 0) {
        conflicts -= 1;
        const error = new Error('ETag-konflikt');
        error.status = 409;
        throw error;
      }
      return base.updateOutboxDelivery(rowKey, patch, options);
    }
  };
  const response = await handleResendWebhook(requestFor(event('email.delivered')), {}, {
    enabled: true, secret: SECRET, store, now: NOW
  });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.applied, true);
  assert.equal(base.state.updates.length, 1);
});

test('en senare delivered efter studs rensar felstatus så admin inte visar falskt fel', async () => {
  const store = fakeStore({
    idempotencyKey: 'outbox-1-guest',
    reference: 'SK-2026-TEST01',
    mailType: 'GUEST_BOOKING_CONFIRMED',
    resendId: 'resend-message-1',
    status: 'Skickad',
    deliveryStatus: 'bounced',
    bouncedAt: '2026-11-26T09:55:00.000Z',
    manualReviewReason: 'studs',
    deliveryError: 'Permanent/General',
    lastEventAt: '2026-11-26T09:55:00.000Z',
    lastEventType: 'email.bounced'
  });
  const delivered = event('email.delivered');
  delivered.created_at = '2026-11-26T10:00:00.000Z';
  const response = await handleResendWebhook(requestFor(delivered, { id: 'evt_after_bounce' }), {}, {
    enabled: true, secret: SECRET, store, now: NOW
  });
  assert.equal(response.status, 200);
  const patch = store.state.updates[0].patch;
  assert.equal(patch.deliveryStatus, 'delivered');
  assert.equal(patch.bouncedAt, '');
  assert.equal(patch.deliveryError, '');
  assert.equal(patch.manualReviewReason, '');
});

test('en ny handlerinstans (serveromstart) behandlar samma Svix-ID idempotent', async () => {
  const store = fakeStore();
  const request = requestFor(event('email.delivered'));
  const first = await handleResendWebhook(request, {}, { enabled: true, secret: SECRET, store, now: NOW });
  const afterRestart = await handleResendWebhook(request, {}, { enabled: true, secret: SECRET, store, now: NOW });
  assert.equal(first.jsonBody.applied, true);
  assert.equal(afterRestart.jsonBody.duplicate, true);
  assert.equal(store.state.updates.length, 1);
});
