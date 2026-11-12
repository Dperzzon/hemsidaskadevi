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
    now: options.now,
    writesEnabled: options.writesEnabled,
    requireAirbnbCheck: options.requireAirbnbCheck,
    availabilityHandler: options.availabilityHandler,
    outboxEnabled: options.outboxEnabled
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
  assert.match(html, /data-booking-action="confirm"/);
});

test('demoläget serverar dashboard, lista och detalj utan Azure', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const health = await request(port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(typeof health.json.airbnbConfigured, 'boolean');
    assert.equal(typeof health.json.calendarParserReady, 'boolean');

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
    assert.match(detail.body, /data-booking-action="cancel"/);
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
    assert.equal(session.json.writesEnabled, true);
    assert.equal(session.json.readOnly, false);
    assert.equal(session.json.user.roles[0], 'Owner');

    const list = await request(port, '/api/admin/bookings?status=PENDING');
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 2);

    const withoutCsrf = await request(port, '/api/admin/bookings/DEMO-2026-A1/status', {
      method: 'POST', body: { action: 'approve' }
    });
    assert.equal(withoutCsrf.status, 403);

    const withCsrf = await request(port, '/api/admin/bookings/DEMO-2026-A1/status', {
      method: 'POST',
      headers: { 'X-CSRF-Token': session.json.csrfToken },
      body: { action: 'approve' }
    });
    assert.equal(withCsrf.status, 200);
    assert.equal(withCsrf.json.statusCode, 'PRELIMINARY');
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
    assert.equal(page.headers['referrer-policy'], 'same-origin');

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

test('admin-Bicep är staged: Reader som standard, Contributor/KV endast vid aktivering', () => {
  const template = fs.readFileSync(path.join(__dirname, '../../infra/admin-webapp.bicep'), 'utf8');
  assert.match(template, /param enableBookingWrites bool = false/);
  assert.match(template, /76199698-9eea-4c19-bc75-cec21354c6b6/);
  assert.match(template, /de139f84-1756-47ae-9be6-808fbbe84772/);
  assert.match(template, /0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3/);
  assert.match(template, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.match(template, /resource tableReader [^=]+= if \(!enableBookingWrites\)/);
  assert.match(template, /resource tableContributor [^=]+= if \(enableBookingWrites\)/);
  assert.match(template, /resource airbnbSecretUser [^=]+= if \(enableBookingWrites\)/);
  assert.match(template, /scope: bookingTable/);
  assert.match(template, /scope: airbnbSecret/);
  assert.doesNotMatch(template, /scope: storageAccount/);
  assert.doesNotMatch(template, /scope: keyVault\b/);
  assert.doesNotMatch(template, /Microsoft\.Network\/dnsZones/);
  assert.doesNotMatch(template, /re_[A-Za-z0-9]/);
  assert.doesNotMatch(template, /https?:\/\/[^\s']*airbnb\.com/i);
  assert.match(template, /ADMIN_TRUST_EASY_AUTH/);
  assert.match(template, /ADMIN_WRITES_ENABLED/);
  assert.match(template, /AZURE_STORAGE_ACCOUNT_NAME/);
  assert.match(template, /@Microsoft\.KeyVault\(SecretUri=\$\{airbnbIcalSecretUri\}\)/);
});

async function ownerSession(port) {
  const session = await request(port, '/api/admin/session');
  return session.json.csrfToken;
}

function manualBookingBody(overrides = {}) {
  return {
    mode: 'booking',
    firstName: 'Manuel',
    lastName: 'Bokning',
    email: 'manuel@example.se',
    phone: '+46 70 123 45 67',
    arrival: '2027-02-10',
    departure: '2027-02-13',
    guests: 4,
    bookingSource: 'PHONE',
    statusCode: 'CONFIRMED',
    addons: { slutstad: true, lakan: true, linenCount: 4, ved: false, tidigIncheckning: false, senUtcheckning: false },
    paymentStatus: 'DEPOSIT_PAID',
    amountPaid: 5000,
    latestNote: 'Bokad via telefon.',
    ...overrides
  };
}

test('oväntat serverfel ger STORAGE-kod och kort felreferens', async () => {
  const repository = createDemoRepository({ now: new Date() });
  repository.dashboard = async () => { throw new Error('simulerat internt fel'); };
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const response = await request(port, '/api/admin/dashboard');
    assert.equal(response.status, 503);
    assert.equal(response.json.code, 'STORAGE');
    assert.match(response.json.referenceId, /^[A-F0-9]{8}$/);
    assert.doesNotMatch(response.json.error, /simulerat internt fel/);
  } finally {
    close(server);
  }
});

test('Owner kan skapa manuell bokning som låser kalendern och auditloggas', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const created = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'manual-test-0001' },
      body: manualBookingBody()
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.statusCode, 'CONFIRMED');
    assert.ok(created.json.total > 0);

    const calendar = await request(port, '/api/admin/calendar?from=2027-02');
    assert.equal(calendar.status, 200);
    const nights = calendar.json.nights.filter((row) => row.reference === created.json.reference);
    assert.equal(nights.length, 3);
    assert.equal(nights[0].type, 'BOOKING');

    const history = await request(port, `/api/admin/bookings/${created.json.reference}/history`);
    assert.equal(history.status, 200);
    assert.ok(history.json.history.some((entry) => entry.action === 'MANUAL_CREATED'));

    const detail = await request(port, `/admin/bookings/${created.json.reference}`);
    assert.match(detail.body, /Auditlogg/);
    assert.match(detail.body, /Manuell bokning skapad/);

    const duplicate = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'manual-test-0001' },
      body: manualBookingBody()
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.duplicate, true);
  } finally {
    close(server);
  }
});

test('PENDING med avtalat pris och betald status sparas utan Airbnb-kontroll eller kalenderlås', async () => {
  const server = await listen(demoServer({
    requireAirbnbCheck: true,
    availabilityHandler: async () => { throw new Error('Airbnb ska inte anropas för PENDING'); }
  }));
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const response = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'pending-paid-0001' },
      body: manualBookingBody({
        arrival: '2027-11-10',
        departure: '2027-11-12',
        email: 'pending-paid@example.se',
        statusCode: 'PENDING',
        airbnbOverrideIntent: true,
        agreedTotal: 14150,
        priceAdjustmentReason: 'Test',
        paymentStatus: 'PAID',
        amountPaid: 14150,
        latestNote: 'Test'
      })
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.statusCode, 'PENDING');
    assert.equal(response.json.total, 14150);

    const detail = await request(port, `/api/admin/bookings/${response.json.reference}`);
    assert.equal(detail.json.booking.statusCode, 'PENDING');
    assert.equal(detail.json.booking.paymentStatus, 'PAID');
    assert.equal(detail.json.booking.amountPaid, 14150);
    assert.equal(detail.json.booking.balance, 0);
    assert.equal(detail.json.booking.agreedTotal, 14150);
    assert.equal(detail.json.booking.airbnbOverride, false);

    const calendar = await request(port, '/api/admin/calendar?from=2027-11');
    assert.equal(calendar.json.nights.length, 0);
    const list = await request(port, '/api/admin/bookings?status=PENDING');
    assert.ok(list.json.bookings.some((booking) => booking.reference === response.json.reference));

    const history = await request(port, `/api/admin/bookings/${response.json.reference}/history`);
    assert.ok(history.json.history.some((entry) => entry.action === 'MANUAL_CREATED'));
  } finally {
    close(server);
  }
});

test('ogiltig betalstatus och negativt belopp ger tydlig valideringsfelkod', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const badStatus = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'pending-bad-payment-0001' },
      body: manualBookingBody({
        statusCode: 'PENDING',
        paymentStatus: 'NOT_A_STATUS'
      })
    });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.json.code, 'VALIDATION');
    assert.match(badStatus.json.error, /Kontrollera/);
    assert.ok(badStatus.json.fields.paymentStatus);

    const badAmount = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'pending-bad-amount-0001' },
      body: manualBookingBody({
        statusCode: 'PENDING',
        paymentStatus: 'PAID',
        amountPaid: -1
      })
    });
    assert.equal(badAmount.status, 400);
    assert.equal(badAmount.json.code, 'VALIDATION');
    assert.ok(badAmount.json.fields.amountPaid);
  } finally {
    close(server);
  }
});

test('Airbnb-override kräver aktiv bekräftelse och motivering men kringgår aldrig interna lås', async () => {
  let blockedNights = ['2027-08-10', '2027-08-11'];
  const server = await listen(demoServer({
    requireAirbnbCheck: true,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: blockedNights } })
  }));
  const port = server.address().port;
  const body = manualBookingBody({
    arrival: '2027-08-10',
    departure: '2027-08-12',
    email: 'airbnb-override@example.se'
  });
  try {
    const csrf = await ownerSession(port);
    const key = 'airbnb-override-0001';
    const headers = { 'X-CSRF-Token': csrf, 'Idempotency-Key': key };

    const notMarked = await request(port, '/api/admin/bookings', {
      method: 'POST', headers, body
    });
    assert.equal(notMarked.status, 409);
    assert.equal(notMarked.json.code, 'AIRBNB_CONFLICT');
    assert.equal(notMarked.json.requiresOverrideOption, true);
    assert.match(notMarked.json.error, /Airbnb/);

    const noConfirmation = await request(port, '/api/admin/bookings', {
      method: 'POST', headers, body: { ...body, airbnbOverrideIntent: true }
    });
    assert.equal(noConfirmation.status, 409);
    assert.equal(noConfirmation.json.code, 'AIRBNB_CONFLICT');
    assert.equal(noConfirmation.json.requiresConfirmation, true);
    assert.deepEqual(noConfirmation.json.blockedNights, blockedNights);

    const approved = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers,
      body: {
        ...body,
        airbnbOverrideIntent: true,
        airbnbOverride: true,
        airbnbOverrideConfirmed: true,
        airbnbOverrideReason: 'Egen blockering i Airbnb för denna gäst'
      }
    });
    assert.equal(approved.status, 201);
    const reference = approved.json.reference;

    const detail = await request(port, `/api/admin/bookings/${reference}`);
    assert.equal(detail.json.booking.airbnbOverride, true);
    assert.equal(detail.json.booking.airbnbOverrideReason, 'Egen blockering i Airbnb för denna gäst');
    assert.ok(detail.json.booking.airbnbOverrideApprovedBy);
    assert.deepEqual(detail.json.booking.airbnbBlockedNights, blockedNights);

    const calendar = await request(port, '/api/admin/calendar?from=2027-08');
    assert.equal(calendar.json.nights.filter((row) => row.reference === reference).length, 2);

    const history = await request(port, `/api/admin/bookings/${reference}/history`);
    const overrideEntry = history.json.history.find((entry) => entry.action === 'AIRBNB_OVERRIDE_APPROVED');
    assert.ok(overrideEntry);
    assert.equal(overrideEntry.reason, 'Egen blockering i Airbnb för denna gäst');
    assert.equal(overrideEntry.actorName, detail.json.booking.airbnbOverrideApprovedBy);

    const retry = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers,
      body: {
        ...body,
        airbnbOverrideIntent: true,
        airbnbOverride: true,
        airbnbOverrideConfirmed: true,
        airbnbOverrideReason: 'Egen blockering i Airbnb för denna gäst'
      }
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicate, true);
    assert.equal(retry.json.reference, reference);
    const afterRetry = await request(port, '/api/admin/calendar?from=2027-08');
    assert.equal(afterRetry.json.nights.filter((row) => row.reference === reference).length, 2);

    blockedNights = [];
    const existing = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'airbnb-internal-0001' },
      body: manualBookingBody({
        arrival: '2027-08-10',
        departure: '2027-08-12',
        email: 'internal@example.se',
        airbnbOverrideIntent: true,
        airbnbOverride: true,
        airbnbOverrideConfirmed: true,
        airbnbOverrideReason: 'Försök kringgå internt lås'
      })
    });
    assert.equal(existing.status, 409);
    assert.equal(existing.json.code, 'INTERNAL_CALENDAR_CONFLICT');
  } finally {
    close(server);
  }
});

test('Airbnb-tekniskt fel kan aldrig åsidosättas', async () => {
  const server = await listen(demoServer({
    requireAirbnbCheck: true,
    availabilityHandler: async () => { throw new Error('timeout'); }
  }));
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const response = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'airbnb-timeout-0001' },
      body: manualBookingBody({
        arrival: '2027-09-10',
        departure: '2027-09-12',
        email: 'timeout@example.se',
        airbnbOverrideIntent: true,
        airbnbOverride: true,
        airbnbOverrideConfirmed: true,
        airbnbOverrideReason: 'Ska inte få åsidosätta tekniskt fel'
      })
    });
    assert.equal(response.status, 503);
    assert.equal(response.json.code, 'AIRBNB_UNAVAILABLE');
    assert.match(response.json.error, /kunde inte hämtas eller tolkas/);
    const calendar = await request(port, '/api/admin/calendar?from=2027-09');
    assert.equal(calendar.json.nights.length, 0);
  } finally {
    close(server);
  }
});

test('samtidiga bekräftelser kan aldrig dubbelboka samma nätter', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const body = () => manualBookingBody({
      arrival: '2027-03-10',
      departure: '2027-03-12',
      email: `same-${Math.random()}@example.se`
    });
    const [first, second] = await Promise.all([
      request(port, '/api/admin/bookings', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': `concurrent-a-${Date.now()}` },
        body: body()
      }),
      request(port, '/api/admin/bookings', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': `concurrent-b-${Date.now()}` },
        body: body()
      })
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);

    const calendar = await request(port, '/api/admin/calendar?from=2027-03');
    const rows = calendar.json.nights.filter((row) => row.night >= '2027-03-10' && row.night < '2027-03-12');
    assert.equal(rows.length, 2, 'endast en bokning får äga nätterna');
  } finally {
    close(server);
  }
});

test('rollback vid krock tar bara bort egna nätter och aldrig en annan boknings lås', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const block = await request(port, '/api/admin/calendar/blocks', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'rollback-foreign-0001' },
      body: { arrival: '2027-07-12', departure: '2027-07-13', latestNote: 'Befintligt lås' }
    });
    assert.equal(block.status, 201);

    const attempt = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'rollback-attempt-0001' },
      body: manualBookingBody({
        arrival: '2027-07-10',
        departure: '2027-07-13',
        email: 'rollback@example.se'
      })
    });
    assert.equal(attempt.status, 409);

    const calendar = await request(port, '/api/admin/calendar?from=2027-07');
    const period = calendar.json.nights.filter((row) =>
      row.night >= '2027-07-10' && row.night < '2027-07-13'
    );
    assert.deepEqual(period.map((row) => row.night), ['2027-07-12']);
    assert.equal(period[0].reference, block.json.reference);
    assert.equal(period[0].type, 'MANUAL');
    assert.equal(
      calendar.json.nights.filter((row) => row.night === '2027-07-10' || row.night === '2027-07-11').length,
      0,
      'försökets egna nätter ska ha rullats tillbaka'
    );
  } finally {
    close(server);
  }
});

test('datumblockering kan skapas och tas bort utan gästuppgifter', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const block = await request(port, '/api/admin/calendar/blocks', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'block-test-0001' },
      body: { arrival: '2027-04-01', departure: '2027-04-04', latestNote: 'Eget underhåll' }
    });
    assert.equal(block.status, 201);
    assert.match(block.json.reference, /^BLOCK-/);

    const calendar = await request(port, '/api/admin/calendar?from=2027-04');
    const rows = calendar.json.nights.filter((row) => row.reference === block.json.reference);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].type, 'MANUAL');

    const removed = await request(port, `/api/admin/calendar/blocks/${block.json.reference}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrf }
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, true);

    const after = await request(port, '/api/admin/calendar?from=2027-04');
    assert.equal(after.json.nights.filter((row) => row.reference === block.json.reference).length, 0);
  } finally {
    close(server);
  }
});

test('Owner kan lägga anteckning, ändra betalning och tillval med ETag', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const booking = await request(port, '/api/admin/bookings/DEMO-2026-C3');
    const etag = booking.json.booking.etag;

    const note = await request(port, '/api/admin/bookings/DEMO-2026-C3/notes', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { note: 'Gästen ringde.', expectedEtag: etag }
    });
    assert.equal(note.status, 200);

    const payment = await request(port, '/api/admin/bookings/DEMO-2026-C3/payment', {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': csrf },
      body: { paymentStatus: 'PAID', amountPaid: 0, expectedEtag: note.json.etag }
    });
    assert.equal(payment.status, 200);
    assert.equal(payment.json.paymentStatus, 'PAID');

    const addons = await request(port, '/api/admin/bookings/DEMO-2026-C3/addons', {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        addons: { slutstad: true, lakan: false, linenCount: 0, ved: true, tidigIncheckning: false, senUtcheckning: false },
        reason: 'Gästen lade till städning och ved.',
        expectedEtag: payment.json.etag
      }
    });
    assert.equal(addons.status, 200);
    assert.ok(addons.json.totalAddons > 0);

    const stale = await request(port, '/api/admin/bookings/DEMO-2026-C3/notes', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { note: 'Gammal flik.', expectedEtag: etag }
    });
    assert.equal(stale.status, 409);
  } finally {
    close(server);
  }
});

test('avtalat pris kräver ändringsorsak och bevarar beräknat pris', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const csrf = await ownerSession(port);
    const withoutReason = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'agreed-missing-0001' },
      body: manualBookingBody({ arrival: '2027-05-10', departure: '2027-05-12', agreedTotal: 9999 })
    });
    assert.equal(withoutReason.status, 400);
    assert.ok(withoutReason.json.fields.priceAdjustmentReason);

    const created = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'agreed-ok-0001' },
      body: manualBookingBody({
        arrival: '2027-05-10',
        departure: '2027-05-12',
        agreedTotal: 9999,
        priceAdjustmentReason: 'Avtal med återkommande gäst'
      })
    });
    assert.equal(created.status, 201);
    const detail = await request(port, `/api/admin/bookings/${created.json.reference}`).then((r) => r.json);
    assert.equal(detail.booking.total, 9999);
    assert.ok(detail.booking.calculatedTotal > 0);
    assert.equal(detail.booking.priceAdjustmentReason, 'Avtal med återkommande gäst');
  } finally {
    close(server);
  }
});

test('Staff och skrivningar utan aktiverat stöd nekas server-side', async () => {
  const staffAuth = createAuth({ trustEasyAuth: true });
  const server = await listen(createAdminRequestListener({
    auth: staffAuth,
    repository: createDemoRepository({ now: new Date() }),
    demo: false,
    writesEnabled: true
  }));
  const port = server.address().port;
  const header = principalHeader('Staff', 'Test Staff');
  try {
    const session = await request(port, '/api/admin/session', {
      headers: { 'x-ms-client-principal': header }
    });
    const denied = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: {
        'x-ms-client-principal': header,
        'X-CSRF-Token': session.json.csrfToken,
        'Idempotency-Key': 'staff-test-0001'
      },
      body: manualBookingBody()
    });
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /ägarbehörighet/);
  } finally {
    close(server);
  }

  const disabled = await listen(createAdminRequestListener({
    auth: createAuth({ demo: true }),
    repository: createDemoRepository({ now: new Date() }),
    demo: true,
    writesEnabled: false
  }));
  const disabledPort = disabled.address().port;
  try {
    const session = await request(disabledPort, '/api/admin/session');
    const blocked = await request(disabledPort, '/api/admin/bookings', {
      method: 'POST',
      headers: { 'X-CSRF-Token': session.json.csrfToken, 'Idempotency-Key': 'disabled-test-0001' },
      body: manualBookingBody()
    });
    assert.equal(blocked.status, 503);
    assert.match(blocked.json.error, /inte aktiverade/);

    const page = await request(disabledPort, '/admin');
    assert.match(page.body, /Skrivfunktioner är inte aktiverade/);
    assert.match(page.body, /Skriv-API:erna svarar 503/);
  } finally {
    close(disabled);
  }
});
