'use strict';

// Tester för bokningsportalen: domänlogik, auth/CSRF, skyddade API:er,
// demodata, XSS-escaping, read-only Table-adapter och admin-Bicep.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  createAdminRequestListener
} = require('../../server/admin');
const { createAuth, decodeClientPrincipal, easyAuthEnforced } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const { createTableAdminRepository } = require('../../server/admin/repository/table');
const {
  normalizeBooking,
  filterBookings,
  sortBookings,
  dashboardData,
  escapeHtml
} = require('../../server/admin/domain');
const { DEMO_BOOKINGS } = require('../../server/admin/demo-data');
const { renderBookingDetail } = require('../../server/admin/views/booking-detail');

function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
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
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        if ((res.headers['content-type'] || '').includes('application/json')) {
          try { json = JSON.parse(text); } catch { json = null; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function close(server) {
  server.closeAllConnections();
  server.close();
}

function principalHeader(roles = 'Owner', name = 'Test Owner') {
  return Buffer.from(JSON.stringify({
    auth_typ: 'aad',
    name,
    claims: [
      { typ: 'oid', val: 'oid-test-1' },
      { typ: 'name', val: name },
      { typ: 'preferred_username', val: 'owner@example.com' },
      { typ: 'roles', val: roles }
    ]
  })).toString('base64');
}

function demoServer(options = {}) {
  const auth = options.auth ?? createAuth({ demo: true });
  const repository = options.repository ?? createDemoRepository({ now: new Date() });
  return createAdminRequestListener({
    auth,
    repository,
    demo: options.demo ?? true,
    now: options.now
  });
}

function bookingRecord(overrides = {}) {
  return {
    reference: 'SK-2026-TEST01',
    statusCode: 'PENDING',
    arrival: '2026-12-10',
    departure: '2026-12-13',
    nights: 3,
    guests: 4,
    firstName: 'Test',
    lastName: 'Gäst',
    email: 'test@example.se',
    phone: '+46 70 000 00 00',
    company: '',
    message: 'Ett meddelande',
    bookingSource: 'WEB',
    createdAt: '2026-11-10T10:00:00.000Z',
    lodgingBase: 24000,
    discount: { label: 'Veckorabatt', percent: 10, amount: 2400 },
    discountAmount: 2400,
    lodgingAfterDiscount: 21600,
    addonLines: [{ id: 'slutstad', label: 'Slutstädning', quantity: 1, unitPrice: 2500, amount: 2500 }],
    totalAddons: 2500,
    total: 24100,
    priceVersion: 'test-version',
    pricing: { addonLines: [{ id: 'slutstad', label: 'Slutstädning', quantity: 1, unitPrice: 2500, amount: 2500 }] },
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    balance: 24100,
    actionFlags: {},
    isDemo: false,
    ...overrides
  };
}

test('decodeClientPrincipal läser oid, namn och approll', () => {
  const principal = decodeClientPrincipal({
    headers: { 'x-ms-client-principal': principalHeader('Owner') }
  });
  assert.equal(principal.id, 'oid-test-1');
  assert.equal(principal.name, 'Test Owner');
  assert.equal(principal.email, 'owner@example.com');
  assert.deepEqual(principal.roles, ['Owner']);
  assert.equal(principal.isDemo, false);
});

test('auth kräver principal för API och roller för admin', () => {
  const auth = createAuth({ trustEasyAuth: true });
  assert.throws(
    () => auth.requirePrincipal({ headers: {} }, { api: true }),
    (error) => error.status === 401
  );
  assert.throws(
    () => auth.requirePrincipal({ headers: {} }, { api: false, returnTo: '/admin/bookings' }),
    (error) => error.status === 302 && /\/\.auth\/login\/aad/.test(error.redirect)
  );
  const withoutRole = decodeClientPrincipal({
    headers: { 'x-ms-client-principal': principalHeader('') }
  });
  assert.throws(
    () => auth.requirePrincipal({ headers: { 'x-ms-client-principal': principalHeader('') } }, { api: true }),
    (error) => error.status === 403
  );
  assert.ok(withoutRole);
});

test('auth litar inte på principal utan verifierad Easy Auth', () => {
  assert.throws(() => createAuth({ trustEasyAuth: false }), /Easy Auth/);
  assert.equal(easyAuthEnforced({ trustEasyAuth: true }), true);
  assert.equal(easyAuthEnforced({ trustEasyAuth: false }), false);
});

test('demo-auth ger Owner och CSRF-token som kan verifieras', () => {
  const auth = createAuth({ demo: true });
  const principal = auth.requirePrincipal({ headers: {} }, { api: true });
  assert.equal(principal.isDemo, true);
  assert.deepEqual(principal.roles, ['Owner']);
  const token = auth.getCsrfToken(principal);
  assert.equal(token.length, 64);
  assert.equal(auth.verifyCsrf({ headers: { 'x-csrf-token': token } }, principal), true);
  assert.equal(auth.verifyCsrf({ headers: { 'x-csrf-token': 'fel' } }, principal), false);
  const repository = createDemoRepository({ now: new Date() });
  assert.equal(repository.save, undefined);
  assert.equal(repository.delete, undefined);
  assert.equal(repository.update, undefined);
});

test('normalisering mappar äldre status och bevarar sparat totalpris', () => {
  const booking = normalizeBooking(bookingRecord({
    statusCode: undefined,
    status: 'Inväntar godkännande',
    total: 12345,
    pricing: { addonLines: [] }
  }));
  assert.equal(booking.statusCode, 'PENDING');
  assert.equal(booking.statusLabel, 'Inväntar godkännande');
  assert.equal(booking.total, 12345);
  assert.equal(booking.lodgingAfterDiscount, 21600);
  assert.equal(booking.addonLines[0].unitPrice, 2500);
});

test('sökning, statusfilter och sortering fungerar på normaliserade poster', () => {
  const bookings = [
    normalizeBooking(bookingRecord({ reference: 'SK-A', statusCode: 'PENDING', arrival: '2026-12-20' })),
    normalizeBooking(bookingRecord({ reference: 'SK-B', statusCode: 'CONFIRMED', arrival: '2026-12-10', total: 50000 })),
    normalizeBooking(bookingRecord({ reference: 'SK-C', statusCode: 'CONFIRMED', arrival: '2026-12-15', total: 10000 }))
  ];
  assert.equal(filterBookings(bookings, { q: 'SK-B' }).length, 1);
  assert.equal(filterBookings(bookings, { q: 'test@example.se' }).length, 3);
  assert.equal(filterBookings(bookings, { status: 'CONFIRMED' }).length, 2);
  assert.deepEqual(
    sortBookings(bookings, 'amount', 'desc').map((booking) => booking.reference),
    ['SK-B', 'SK-A', 'SK-C']
  );
  assert.deepEqual(
    sortBookings(bookings, 'arrival', 'asc').map((booking) => booking.reference),
    ['SK-B', 'SK-C', 'SK-A']
  );
});

test('dashboard räknar nya, kommande, gäster, värde och åtgärder', () => {
  const now = new Date();
  const bookings = DEMO_BOOKINGS.map((record) => normalizeBooking(record, { now }));
  const data = dashboardData(bookings, now);
  assert.equal(data.newRequestCount, 2);
  assert.equal(data.upcomingCount, 3);
  assert.equal(data.upcomingGuests, 22);
  assert.equal(data.actionCount, 4);
  assert.ok(data.upcomingValue > 0);
  assert.ok(data.nextCheckIn);
  assert.ok(data.nextCheckOut);
});

test('XSS-escaping tar bort skript och attributbrytning', () => {
  const escaped = escapeHtml('<script>alert("x")</script>');
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);
  assert.match(escaped, /&quot;/);
});

test('detaljvyn visar samtliga tillval och prissnapshot', () => {
  const principal = { name: 'Test', roles: ['Owner'], email: 'test@example.se', isDemo: true };
  const booking = normalizeBooking(bookingRecord({
    message: '<script>alert(1)</script>',
    emailStatus: {
      host: { status: 'Skickad', deliveryStatus: 'delivered', resendId: 'resend-1' },
      guest: { status: 'Kräver manuell kontroll', deliveryStatus: 'unknown', resendId: 'resend-2' }
    }
  }));
  const html = renderBookingDetail({ booking, principal, demo: true, csrfToken: 'csrf' });
  assert.match(html, /Slutstädning/);
  assert.match(html, /Sparat prissnapshot/);
  assert.match(html, /24.100 kr/);
  assert.match(html, /resend-1/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /data-prepared-action="approve"/);
});

test('demoläget serverar dashboard, lista och detalj utan Azure', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const health = await request(port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');

    const dashboard = await request(port, '/admin');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.body, /Demoläge/);
    assert.match(dashboard.body, /DEMO-/);
    assert.match(dashboard.body, /Nya bokningsförfrågningar/);

    const list = await request(port, '/admin/bookings?status=CONFIRMED&sort=amount&dir=desc');
    assert.equal(list.status, 200);
    assert.match(list.body, /Bokningar/);
    assert.match(list.body, /Bekräftad/);

    const detail = await request(port, '/admin/bookings/DEMO-2026-D4');
    assert.equal(detail.status, 200);
    assert.match(detail.body, /Kontaktuppgifter/);
    assert.match(detail.body, /Slutstädning/);
    assert.match(detail.body, /Sparat prissnapshot/);
    assert.match(detail.body, /Mejlstatus/);
    assert.match(detail.body, /data-prepared-action="confirm"/);
  } finally {
    close(server);
  }
});

test('admin-API kräver auth och skyddas med CSRF', async () => {
  const secured = await listen(createAdminRequestListener({
    auth: createAuth({ trustEasyAuth: true }),
    repository: createDemoRepository({ now: new Date() }),
    demo: false
  }));
  const securedPort = secured.address().port;
  try {
    const api = await request(securedPort, '/api/admin/bookings');
    assert.equal(api.status, 401);
    assert.match(api.json.error, /Autentisering/);

    const page = await request(securedPort, '/admin');
    assert.equal(page.status, 302);
    assert.match(page.headers.location, /\/\.auth\/login\/aad/);
  } finally {
    close(secured);
  }

  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const session = await request(port, '/api/admin/session');
    assert.equal(session.status, 200);
    assert.equal(session.json.demo, true);
    assert.equal(session.json.writesEnabled, false);
    assert.equal(session.json.user.roles[0], 'Owner');

    const list = await request(port, '/api/admin/bookings?status=PENDING');
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 2);

    const withoutCsrf = await request(port, '/api/admin/bookings/DEMO-2026-D4/status', {
      method: 'POST', body: { action: 'confirm' }
    });
    assert.equal(withoutCsrf.status, 403);

    const withCsrf = await request(port, '/api/admin/bookings/DEMO-2026-D4/status', {
      method: 'POST',
      headers: { 'X-CSRF-Token': session.json.csrfToken },
      body: { action: 'confirm' }
    });
    assert.equal(withCsrf.status, 503);
    assert.match(withCsrf.json.error, /Ingen bokning har ändrats/);
  } finally {
    close(server);
  }
});

test('Easy Auth-principal med Staff får läsa men inte bekräfta', async () => {
  const auth = createAuth({ trustEasyAuth: true });
  const repository = createDemoRepository({ now: new Date() });
  const server = await listen(createAdminRequestListener({ auth, repository, demo: false }));
  const port = server.address().port;
  const header = principalHeader('Staff', 'Test Staff');
  try {
    const session = await request(port, '/api/admin/session', {
      headers: { 'x-ms-client-principal': header }
    });
    assert.equal(session.status, 200);
    assert.deepEqual(session.json.user.roles, ['Staff']);
    assert.equal(session.json.easyAuthTrusted, true);

    const confirm = await request(port, '/api/admin/bookings/DEMO-2026-D4/status', {
      method: 'POST',
      headers: {
        'x-ms-client-principal': header,
        'X-CSRF-Token': session.json.csrfToken
      },
      body: { action: 'confirm' }
    });
    assert.equal(confirm.status, 403);
    assert.match(confirm.json.error, /ägarbehörighet/);
  } finally {
    close(server);
  }
});

test('säkerhetsrubriker finns på sidor och API', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const page = await request(port, '/admin');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(page.headers['cache-control'], 'no-store');

    const api = await request(port, '/api/admin/session');
    assert.equal(api.headers['cache-control'], 'no-store');
    assert.equal(api.headers['x-content-type-options'], 'nosniff');
  } finally {
    close(server);
  }
});

test('Table-adaptern gör endast read-only GET med managed identity', async () => {
  const calls = [];
  const requestEntity = {
    PartitionKey: 'request',
    RowKey: 'key-1',
    reference: 'SK-2026-TABLE',
    status: 'Inväntar godkännande',
    arrival: '2026-12-10',
    departure: '2026-12-12',
    nights: '2',
    guests: '3',
    firstName: 'Tabell',
    lastName: 'Gäst',
    email: 'tabell@example.se',
    phone: '+46 70 111 11 11',
    total: '12345',
    lodgingBase: '12000',
    discount: '',
    lodgingAfterDiscount: '12000',
    totalAddons: '345',
    pricing: JSON.stringify({ addonLines: [{ id: 'ved', label: 'Ved', quantity: 1, unitPrice: 345, amount: 345 }] }),
    priceVersion: 'test',
    createdAt: '2026-11-10T10:00:00.000Z'
  };
  const outboxEntity = {
    PartitionKey: 'outbox',
    RowKey: 'outbox-key-1-host',
    reference: 'SK-2026-TABLE',
    mailType: 'HOST_NEW_REQUEST',
    status: 'Skickad',
    deliveryStatus: 'delivered',
    resendId: 'resend-table-1',
    sentAt: '2026-11-10T10:01:00.000Z',
    createdAt: '2026-11-10T10:00:00.000Z'
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers });
    const isOutbox = String(url).includes('outbox');
    const value = isOutbox ? [outboxEntity] : [requestEntity];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value })
    };
  };
  const repository = createTableAdminRepository({
    accountName: 'testaccount',
    table: 'bookingrequests',
    fetchImpl,
    tokenProvider: {
      async getToken() {
        return { accessToken: 'token-123', expiresOn: Math.floor(Date.now() / 1000) + 3600 };
      }
    }
  });
  assert.equal(repository.save, undefined);
  assert.equal(repository.delete, undefined);
  assert.equal(repository.update, undefined);
  const bookings = await repository.allBookings();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].reference, 'SK-2026-TABLE');
  assert.equal(bookings[0].total, 12345);
  assert.equal(bookings[0].addonLines[0].label, 'Ved');
  assert.equal(bookings[0].mailStatus.host.deliveryLabel, 'Levererat');
  assert.equal(bookings[0].mailStatus.host.resendId, 'resend-table-1');
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(calls.every((call) => call.headers.Authorization === 'Bearer token-123'));
  assert.ok(calls.some((call) => decodeURIComponent(String(call.url)).replaceAll('+', ' ').includes("PartitionKey eq 'request'")));
  assert.ok(calls.some((call) => decodeURIComponent(String(call.url)).replaceAll('+', ' ').includes('outbox')));
});

test('admin-Bicep använder endast läsroll på tabellen och inga hemligheter', () => {
  const template = fs.readFileSync(path.join(__dirname, '../../infra/admin-webapp.bicep'), 'utf8');
  assert.match(template, /76199698-9eea-4c19-bc75-cec21354c6b6/);
  assert.doesNotMatch(template, /0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3/);
  assert.doesNotMatch(template, /Microsoft\.Network\/dnsZones/);
  assert.doesNotMatch(template, /re_[A-Za-z0-9]/);
  assert.match(template, /ADMIN_TRUST_EASY_AUTH/);
  assert.match(template, /AZURE_STORAGE_ACCOUNT_NAME/);
});
