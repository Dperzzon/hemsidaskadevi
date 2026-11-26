'use strict';

// Regressionstester för "Kontrollera igen": CSRF, synligt resultat i UI,
// Airbnb-verifiering (blockerad/saknas/fördröjd), Resend-leverans och
// skydd mot dubbelklick/ETag-konflikt. Alla tester använder syntetisk
// demodata och rör aldrig riktiga bokningar.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdminRequestListener } = require('../../server/admin');
const { createAuth } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const { WARNING } = require('../../server/admin/warnings');

const NOW = new Date('2026-11-26T10:00:00.000Z');
const NIGHTS = ['2030-05-10', '2030-05-11', '2030-05-12'];

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

function demoServer(options = {}) {
  const repository = options.repository ?? createDemoRepository({ now: NOW });
  return {
    repository,
    listener: createAdminRequestListener({
      auth: options.auth ?? createAuth({ demo: true }),
      repository,
      demo: options.demo ?? true,
      now: () => NOW,
      writesEnabled: options.writesEnabled ?? true,
      requireAirbnbCheck: options.requireAirbnbCheck ?? true,
      availabilityHandler: options.availabilityHandler,
      resendDelivery: options.resendDelivery,
      outboxEnabled: false
    })
  };
}

async function ownerSession(port) {
  const session = await request(port, '/api/admin/session');
  return session.json.csrfToken;
}

let counter = 0;

async function createBooking(port, overrides = {}) {
  const csrf = await ownerSession(port);
  const key = `recheck-test-${Date.now()}-${counter++}`;
  const response = await request(port, '/api/admin/bookings', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key },
    body: {
      mode: 'booking',
      firstName: 'Kontroll',
      lastName: 'Test',
      email: 'kontroll@example.se',
      phone: '+46 70 123 45 67',
      arrival: '2030-05-10',
      departure: '2030-05-13',
      guests: 4,
      bookingSource: 'PHONE',
      statusCode: 'CONFIRMED',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      paymentStatus: 'DEPOSIT_PAID',
      amountPaid: 5000,
      latestNote: 'Kontrolltest',
      ...overrides
    }
  });
  return { response, csrf, key };
}

function recheck(port, reference, csrf, warningId, extra = {}) {
  return request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body: { warningId, ...extra }
  });
}

function mailWarning(booking) {
  return (booking.warnings ?? []).find((warning) => warning.type === 'MAIL');
}

async function seedUnverifiedMail(repository, reference) {
  const raw = await repository.getRawBooking(reference);
  await repository.updateRequest({
    ...raw.record,
    emailStatus: {
      guest: {
        mailType: 'GUEST_BOOKING_CONFIRMED',
        status: 'Skickad',
        deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
        resendId: 're_test_123',
        sentAt: '2026-11-26T09:00:00.000Z',
        createdAt: '2026-11-26T08:59:00.000Z'
      }
    }
  }, { ifMatch: raw.etag });
}

test('giltig CSRF-token accepteras och saknad eller felaktig nekas', async () => {
  let blocked = [];
  const { listener } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    assert.equal(response.status, 201);
    const reference = response.json.reference;
    blocked = NIGHTS;

    const missing = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
      method: 'POST',
      body: { warningId: WARNING.AIRBNB_UNVERIFIED }
    });
    assert.equal(missing.status, 403);
    assert.match(missing.json.error, /CSRF/);

    const invalid = await recheck(port, reference, 'fel-token', WARNING.AIRBNB_UNVERIFIED);
    assert.equal(invalid.status, 403);

    const valid = await recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(valid.status, 200);
  } finally {
    close(server);
  }
});

test('utgången eller saknad session ger tydligt 401 utan att läcka data', async () => {
  const listener = createAdminRequestListener({
    auth: createAuth({ trustEasyAuth: true }),
    repository: createDemoRepository({ now: NOW }),
    demo: false,
    now: () => NOW,
    writesEnabled: true,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const apiResponse = await request(port, '/api/admin/bookings/SK-2030-TEST');
    assert.equal(apiResponse.status, 401);
    assert.match(apiResponse.json.error, /Autentisering/);

    const page = await request(port, '/admin/bookings/SK-2030-TEST');
    assert.equal(page.status, 302);
    assert.match(page.headers.location, /login/);
  } finally {
    close(server);
  }
});

test('Airbnb-blockering verifieras och UI visar resultat med kontrolltid', async () => {
  let blocked = [];
  const { listener } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    blocked = NIGHTS;
    const before = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.equal(before.json.booking.unresolvedWarnings.some((item) => item.type === 'AIRBNB'), true);

    const checked = await recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(checked.status, 200);
    assert.equal(checked.json.verification.status, 'blocked');
    assert.match(checked.json.result.message, /Blockeringen är verifierad/);
    assert.match(checked.json.result.message, /kl\./);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.equal(after.json.booking.warnings.find((item) => item.type === 'AIRBNB').id, WARNING.AIRBNB_VERIFIED);

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Airbnb-blockeringen är verifierad/);
    assert.match(html.body, /Senast kontrollerad:/);
    assert.match(html.body, /data-warning-recheck=/);
  } finally {
    close(server);
  }
});

test('Airbnb-kalender som saknar blockering behåller varningen och förklarar varför', async () => {
  const { listener } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    const checked = await recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(checked.status, 200);
    assert.equal(checked.json.verification.status, 'available');
    assert.match(checked.json.result.message, /visar ingen blockering/);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const warning = after.json.booking.warnings.find((item) => item.type === 'AIRBNB');
    assert.ok([WARNING.AIRBNB_AVAILABLE, WARNING.AIRBNB_IMPORT_PENDING].includes(warning.id));
    assert.notEqual(warning.severity, 'handled');
  } finally {
    close(server);
  }
});

test('Airbnb-data som är fördröjd visas som "uppdatering väntar" men aldrig som verifierad', async () => {
  const { listener } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    const checked = await recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(checked.status, 200);
    assert.equal(checked.json.verification.status, 'available');
    const detail = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const warning = detail.json.booking.warnings.find((item) => item.type === 'AIRBNB');
    assert.equal(warning.id, WARNING.AIRBNB_IMPORT_PENDING);
    assert.notEqual(warning.severity, 'handled');
    assert.match(warning.what, /ingen blockering/);
  } finally {
    close(server);
  }
});

test('felaktigt API-svar och timeout ger "kan inte verifieras", aldrig verifierat OK', async () => {
  let mode = 'ok';
  const { listener } = demoServer({
    availabilityHandler: async () => {
      if (mode === 'timeout') throw new Error('timeout');
      if (mode === 'bad-body') return { status: 200, jsonBody: {} };
      return { status: 200, jsonBody: { blocked: [] } };
    }
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;

    mode = 'timeout';
    const timeout = await recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(timeout.status, 200);
    assert.equal(timeout.json.verification.status, 'unavailable');
    assert.match(timeout.json.result.message, /kunde inte läsa/);

    mode = 'bad-body';
    const after = await recheck(port, reference, csrf, WARNING.AIRBNB_UNAVAILABLE);
    assert.equal(after.status, 200);
    assert.equal(after.json.verification.status, 'unavailable');
    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Kalenderstatus kan inte verifieras/);
    assert.doesNotMatch(html.body, /Airbnb-blockeringen är verifierad/);
  } finally {
    close(server);
  }
});

test('dubbelklick skyddas: två samtidiga kontroller kan inte båda lyckas', async () => {
  let blocked = [];
  const { listener } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    blocked = NIGHTS;
    const detail = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const etag = detail.json.booking.etag;

    const [first, second] = await Promise.all([
      recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED, { expectedEtag: etag }),
      recheck(port, reference, csrf, WARNING.AIRBNB_UNVERIFIED, { expectedEtag: etag })
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    close(server);
  }
});

test('Resend-leverans verifierad tar bort mejlvarningen endast när delivered bekräftas', async () => {
  let blocked = [];
  const { listener, repository } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } }),
    resendDelivery: {
      enabled: true,
      apiKey: 'test-key',
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => ({ id: 're_test_123', last_event: 'delivered' })
      })
    }
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    blocked = NIGHTS;
    await seedUnverifiedMail(repository, reference);

    const before = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.ok(mailWarning(before.json.booking));
    assert.equal(mailWarning(before.json.booking).id, WARNING.MAIL_UNVERIFIED);

    const checked = await recheck(port, reference, csrf, WARNING.MAIL_UNVERIFIED);
    assert.equal(checked.status, 200);
    assert.equal(checked.json.verification.guest.status, 'delivered');
    assert.match(checked.json.result.message, /bekräftar leverans/);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.equal(mailWarning(after.json.booking), undefined);

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.doesNotMatch(html.body, /Mejl accepterat – leverans ej verifierad/);
    assert.match(html.body, /Resend bekräftar leverans/);
  } finally {
    close(server);
  }
});

test('Resend utan behörighet eller aktivering förblir ej verifierbar utan upprepade anrop', async () => {
  let calls = 0;
  let blocked = [];
  const { listener, repository } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } }),
    resendDelivery: {
      enabled: true,
      apiKey: 'sending-only-key',
      fetchImpl: async () => {
        calls += 1;
        return { status: 401, ok: false };
      }
    }
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    blocked = NIGHTS;
    await seedUnverifiedMail(repository, reference);

    const checked = await recheck(port, reference, csrf, WARNING.MAIL_UNVERIFIED);
    assert.equal(checked.status, 200);
    assert.equal(checked.json.verification.guest.status, 'permission_denied');
    assert.match(checked.json.result.message, /behörighet/);
    assert.equal(calls, 1);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.ok(mailWarning(after.json.booking));

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /saknar behörighet att läsa leveransstatus/);
    assert.match(html.body, /Manuell leveranskontroll i Resend/);
  } finally {
    close(server);
  }
});

test('Resend-kontroll utan aktiverad läsbehörighet gör inget API-anrop och behåller varningen', async () => {
  let calls = 0;
  let blocked = [];
  const { listener, repository } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } }),
    resendDelivery: {
      enabled: false,
      apiKey: '',
      fetchImpl: async () => { calls += 1; return { status: 200, ok: true, json: async () => ({}) }; }
    }
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response, csrf } = await createBooking(port);
    const reference = response.json.reference;
    blocked = NIGHTS;
    await seedUnverifiedMail(repository, reference);

    const checked = await recheck(port, reference, csrf, WARNING.MAIL_UNVERIFIED);
    assert.equal(checked.status, 200);
    assert.equal(checked.json.verification.guest.status, 'not_configured');
    assert.equal(calls, 0);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.ok(mailWarning(after.json.booking));
  } finally {
    close(server);
  }
});
