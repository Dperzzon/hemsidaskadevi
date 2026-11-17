'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdminRequestListener } = require('../../server/admin');
const { createAuth } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const {
  verifyPaymentToken,
  hashPaymentToken,
  nightKeys
} = require('../../server/booking/payment-access');
const { createInvoiceRequest } = require('../../server/booking/invoice-requests');

const FIXED_NOW = new Date('2026-11-16T12:00:00.000Z');

function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  server.closeAllConnections();
  server.close();
}

function request(port, pathname, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { ...(options.headers ?? {}) };
  let body = options.body;
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        if ((res.headers['content-type'] || '').includes('application/json')) {
          try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; }
        }
        resolve({ status: res.statusCode, headers: res.headers, buffer, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function principalHeader(roles, name) {
  return Buffer.from(JSON.stringify({
    auth_typ: 'aad',
    name,
    claims: [
      { typ: 'oid', val: `oid-${roles}` },
      { typ: 'name', val: name },
      { typ: 'preferred_username', val: `${roles.toLowerCase()}@example.com` },
      { typ: 'roles', val: roles }
    ]
  })).toString('base64');
}

function stripeServer(options = {}) {
  return createAdminRequestListener({
    auth: options.auth ?? createAuth({ demo: true }),
    repository: options.repository ?? createDemoRepository({ now: FIXED_NOW }),
    demo: options.demo ?? true,
    now: FIXED_NOW,
    writesEnabled: true,
    requireAirbnbCheck: false,
    stripeEnabled: options.stripeEnabled ?? true,
    stripeMode: options.stripeMode ?? 'test',
    publicBaseUrl: options.publicBaseUrl ?? 'https://www.skadeviherrgard.com',
    outboxEnabled: options.outboxEnabled ?? true
  });
}

async function csrfToken(port, headers = {}) {
  const session = await request(port, '/api/admin/session', { headers });
  return session.json.csrfToken;
}

async function createConfirmedBooking(port, csrf, overrides = {}) {
  const response = await request(port, '/api/admin/bookings', {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrf,
      'Idempotency-Key': `payment-link-test-${Date.now()}-${Math.random()}`
    },
    body: {
      mode: 'booking',
      firstName: 'Swish',
      lastName: 'Test',
      email: `swish-${Math.random()}@example.se`,
      phone: '+46 70 123 45 67',
      arrival: '2027-04-10',
      departure: '2027-04-13',
      guests: 4,
      bookingSource: 'PHONE',
      statusCode: 'CONFIRMED',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      latestNote: 'Swish-länktest',
      ...overrides
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.reference;
}

async function createLink(port, headers, reference, body = {}) {
  return request(port, `/api/admin/bookings/${reference}/payment-link`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `link-${Date.now()}-${Math.random()}` },
    body
  });
}

function tokenFromUrl(url) {
  const match = /\/betala\/([A-Za-z0-9_-]{43})$/.exec(String(url ?? ''));
  return match ? match[1] : '';
}

test('Owner skapar en säker betalningssida för bekräftad bokning med kalenderlås', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const outbox = [];
  const originalSaveOutbox = repository.saveOutbox.bind(repository);
  repository.saveOutbox = async (entry) => {
    outbox.push(entry);
    return originalSaveOutbox(entry);
  };
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(server.address().port, csrf);
    const raw = await repository.getRawBooking(reference);
    const response = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf, 'If-Match': raw.etag },
      reference,
      { expectedEtag: raw.etag }
    );
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json.reference, reference);
    assert.equal(response.json.emailQueued, true);
    assert.equal(response.json.paymentLink.status, 'OPEN');
    assert.equal(response.json.paymentLink.amountOre, Math.round(raw.record.total * 100));
    const token = tokenFromUrl(response.json.paymentLink.url);
    assert.equal(token.length, 43);
    assert.match(response.json.paymentLink.url, /^https:\/\/www\.skadeviherrgard\.com\/betala\//);

    const stored = await repository.getRawBooking(reference);
    assert.equal(stored.record.paymentTokenHash, hashPaymentToken(token));
    assert.equal(stored.record.paymentAccess.tokenHash, hashPaymentToken(token));
    assert.equal(stored.record.paymentAccess.revokedAt, '');
    assert.equal(stored.record.paymentRequests.length, 0);
    assert.equal(verifyPaymentToken(stored.record, token, FIXED_NOW).ok, true);
    assert.equal(stored.record.statusCode, 'CONFIRMED');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].mailType, 'GUEST_PAYMENT_LINK');
    assert.match(outbox[0].mailText, /\/betala\//);
    assert.doesNotMatch(outbox[0].mailText, /card|klarna/i);

    const history = await repository.listHistory(reference);
    assert.ok(history.some((entry) => entry.action === 'PAYMENT_LINK_CREATED'));
  } finally {
    close(server);
  }
});

test('en ny betalningslänk återkallar den gamla token', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(server.address().port, csrf);
    const first = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      reference
    );
    const second = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      reference
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const firstToken = tokenFromUrl(first.json.paymentLink.url);
    const secondToken = tokenFromUrl(second.json.paymentLink.url);
    assert.notEqual(firstToken, secondToken);
    const stored = await repository.getRawBooking(reference);
    assert.equal(verifyPaymentToken(stored.record, firstToken, FIXED_NOW).ok, false);
    assert.equal(verifyPaymentToken(stored.record, secondToken, FIXED_NOW).ok, true);
  } finally {
    close(server);
  }
});

test('Owner kan återkalla betalningslänken', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(server.address().port, csrf);
    const created = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      reference
    );
    const token = tokenFromUrl(created.json.paymentLink.url);
    const response = await request(server.address().port, `/api/admin/bookings/${reference}/payment-link/revoke`, {
      method: 'POST',
      headers: { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      body: { reason: 'Test' }
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.revoked, true);
    const stored = await repository.getRawBooking(reference);
    assert.equal(stored.record.paymentTokenHash, '');
    assert.ok(stored.record.paymentAccess.revokedAt);
    assert.equal(verifyPaymentToken(stored.record, token, FIXED_NOW).ok, false);
  } finally {
    close(server);
  }
});

test('endast CONFIRMED med kalenderlås får betalningslänk', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });

    const preliminary = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      'DEMO-2026-C3'
    );
    assert.equal(preliminary.status, 422);
    assert.equal(preliminary.json.code, 'PAYMENT_REQUIRES_CONFIRMED');

    const pending = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      'DEMO-2026-A1'
    );
    assert.equal(pending.status, 422);
    assert.equal(pending.json.code, 'PAYMENT_REQUIRES_CONFIRMED');

    const confirmed = await createConfirmedBooking(server.address().port, csrf);
    const raw = await repository.getRawBooking(confirmed);
    for (const night of nightKeys(raw.record.arrival, raw.record.departure)) {
      await repository.deleteCalendarNight(night, confirmed);
    }
    const missingLock = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      confirmed
    );
    assert.equal(missingLock.status, 409);
    assert.equal(missingLock.json.code, 'CALENDAR_LOCK_MISSING');
  } finally {
    close(server);
  }
});

test('betalningslänk kräver Owner och aktiverad funktion', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({
    repository,
    auth: createAuth({ trustEasyAuth: true }),
    demo: false
  }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const staff = principalHeader('Staff', 'Stina Staff');
    const staffCsrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': staff });
    const staffResponse = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': staff, 'X-CSRF-Token': staffCsrf },
      'DEMO-2026-F6'
    );
    assert.equal(staffResponse.status, 403);

    const disabled = await listen(stripeServer({
      repository,
      auth: createAuth({ trustEasyAuth: true }),
      demo: false,
      stripeEnabled: false
    }));
    try {
      const csrf = await csrfToken(disabled.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
      const response = await createLink(
        disabled.address().port,
        { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
        'DEMO-2026-F6'
      );
      assert.equal(response.status, 503);
      assert.equal(response.json.code, 'PAYMENT_LINKS_DISABLED');
    } finally {
      close(disabled);
    }
  } finally {
    close(server);
  }
});

test('föråldrad ETag och ogiltig publik bas-URL spärrar länken', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(server.address().port, csrf);
    const stale = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf, 'If-Match': 'stale' },
      reference
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'STALE');
  } finally {
    close(server);
  }

  const repository2 = createDemoRepository({ now: FIXED_NOW });
  const invalid = await listen(stripeServer({
    repository: repository2,
    publicBaseUrl: 'http://evil.example.com'
  }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(invalid.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(invalid.address().port, csrf);
    const response = await createLink(
      invalid.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      reference
    );
    assert.equal(response.status, 500);
    assert.equal(response.json.code, 'PAYMENT_LINK_CONFIGURATION');
    const stored = await repository2.getRawBooking(reference);
    assert.equal(stored.record.paymentAccess, undefined);
  } finally {
    close(invalid);
  }
});

test('detaljvyn visar kortpanel, Swish-status och fakturabegäranden', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const raw = await repository.getRawBooking('DEMO-2026-F6');
  const created = createInvoiceRequest(raw.record, {
    requestId: '11111111-1111-4111-8111-111111111111',
    invoiceName: 'Testbolaget AB',
    invoiceOrgNumber: '556677-8899',
    invoiceAddress: 'Storgatan 1',
    invoicePostalCode: '541 30',
    invoiceCity: 'Skövde',
    invoiceEmail: 'faktura@example.se'
  }, { now: FIXED_NOW, amountOre: 100000 });
  assert.equal(created.ok, true);
  await repository.updateRequest(created.record, { ifMatch: raw.etag });

  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const page = await request(server.address().port, '/admin/bookings/DEMO-2026-F6', {
      headers: { 'X-MS-CLIENT-PRINCIPAL': owner }
    });
    assert.equal(page.status, 200);
    const html = page.buffer.toString('utf8');
    assert.match(html, /Betalningssida/);
    assert.match(html, /data-stripe-payment-link/);
    assert.match(html, /Kortbetalning är i Stripe testläge/);
    assert.match(html, /Swish är avstängt/);
    assert.match(html, /Fakturabegäranden/);
    assert.match(html, /Testbolaget AB/);
    assert.match(html, /data-admin-form="invoice-status"/);
  } finally {
    close(server);
  }
});

test('detaljvyn visar att betalningar är inaktiva när funktionen är avstängd', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository, stripeEnabled: false }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const page = await request(server.address().port, '/admin/bookings/DEMO-2026-F6', {
      headers: { 'X-MS-CLIENT-PRINCIPAL': owner }
    });
    assert.equal(page.status, 200);
    const html = page.buffer.toString('utf8');
    assert.match(html, /Betalningslänkar är inte aktiverade/);
    assert.doesNotMatch(html, /data-stripe-payment-link/);
  } finally {
    close(server);
  }
});

test('avbokning återkallar betalningslänken och makulerar öppna fakturabegäranden', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(server.address().port, csrf);
    const created = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      reference
    );
    const token = tokenFromUrl(created.json.paymentLink.url);
    const raw = await repository.getRawBooking(reference);
    const invoice = createInvoiceRequest(raw.record, {
      requestId: '55555555-5555-4555-8555-555555555555',
      invoiceName: 'Avbokning AB',
      invoiceAddress: 'Storgatan 5',
      invoicePostalCode: '541 30',
      invoiceCity: 'Skövde',
      invoiceEmail: 'faktura@example.se'
    }, { now: FIXED_NOW, amountOre: 100000 });
    await repository.updateRequest(invoice.record, { ifMatch: raw.etag });
    const current = await repository.getRawBooking(reference);

    const response = await request(server.address().port, `/api/admin/bookings/${reference}/status`, {
      method: 'POST',
      headers: {
        'X-MS-CLIENT-PRINCIPAL': owner,
        'X-CSRF-Token': csrf,
        'If-Match': current.etag
      },
      body: { action: 'cancel', reason: 'Test av avbokning' }
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const stored = await repository.getRawBooking(reference);
    assert.equal(stored.record.statusCode, 'CANCELLED');
    assert.equal(stored.record.paymentTokenHash, '');
    assert.ok(stored.record.paymentAccess.revokedAt);
    assert.equal(verifyPaymentToken(stored.record, token, FIXED_NOW).ok, false);
    assert.equal(stored.record.invoiceRequests[0].status, 'CANCELLED');
  } finally {
    close(server);
  }
});

test('prisändring återkallar betalningslänken', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const reference = await createConfirmedBooking(server.address().port, csrf);
    const created = await createLink(
      server.address().port,
      { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
      reference
    );
    const token = tokenFromUrl(created.json.paymentLink.url);
    const raw = await repository.getRawBooking(reference);
    const response = await request(server.address().port, `/api/admin/bookings/${reference}/addons`, {
      method: 'PATCH',
      headers: {
        'X-MS-CLIENT-PRINCIPAL': owner,
        'X-CSRF-Token': csrf,
        'If-Match': raw.etag
      },
      body: {
        addons: {
          slutstad: true,
          lakan: false,
          linenCount: 0,
          ved: true,
          tidigIncheckning: false,
          senUtcheckning: false
        },
        reason: 'Test av prisändring'
      }
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const stored = await repository.getRawBooking(reference);
    assert.equal(stored.record.paymentTokenHash, '');
    assert.ok(stored.record.paymentAccess.revokedAt);
    assert.equal(verifyPaymentToken(stored.record, token, FIXED_NOW).ok, false);
  } finally {
    close(server);
  }
});

test('Owner kan uppdatera fakturabegäran men inte markera den betald', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const raw = await repository.getRawBooking('DEMO-2026-F6');
  const created = createInvoiceRequest(raw.record, {
    requestId: '22222222-2222-4222-8222-222222222222',
    invoiceName: 'Fakturabolaget AB',
    invoiceAddress: 'Storgatan 2',
    invoicePostalCode: '541 30',
    invoiceCity: 'Skövde',
    invoiceEmail: 'faktura@example.se'
  }, { now: FIXED_NOW, amountOre: 100000 });
  await repository.updateRequest(created.record, { ifMatch: raw.etag });
  const requestId = created.request.id;

  const server = await listen(stripeServer({ repository }));
  try {
    const owner = principalHeader('Owner', 'Anna Owner');
    const csrf = await csrfToken(server.address().port, { 'X-MS-CLIENT-PRINCIPAL': owner });
    const response = await request(
      server.address().port,
      `/api/admin/bookings/DEMO-2026-F6/invoice-requests/${requestId}`,
      {
        method: 'PATCH',
        headers: { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
        body: { status: 'IN_PROGRESS' }
      }
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.request.status, 'IN_PROGRESS');
    const stored = await repository.getRawBooking('DEMO-2026-F6');
    assert.equal(stored.record.invoiceRequests[0].status, 'IN_PROGRESS');
    assert.equal(stored.record.paymentStatus, 'PARTIALLY_PAID');

    const paidAttempt = await request(
      server.address().port,
      `/api/admin/bookings/DEMO-2026-F6/invoice-requests/${requestId}`,
      {
        method: 'PATCH',
        headers: { 'X-MS-CLIENT-PRINCIPAL': owner, 'X-CSRF-Token': csrf },
        body: { status: 'PAID' }
      }
    );
    assert.equal(paidAttempt.status, 422);
    assert.equal(paidAttempt.json.code, 'INVOICE_STATUS_INVALID');
  } finally {
    close(server);
  }
});
