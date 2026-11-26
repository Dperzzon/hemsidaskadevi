'use strict';

// Regressionstester för manuell verifiering (Steg 16D): Airbnb i gränssnittet
// och enskilda Resend-mejl. Allt körs mot syntetisk demodata. Inga riktiga
// bokningar, kalendrar, mejl eller leveranshändelser ändras.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdminRequestListener } = require('../../server/admin');
const { createAuth } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const { WARNING } = require('../../server/admin/warnings');

const NOW = new Date('2026-11-26T10:00:00.000Z');

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
      { typ: 'oid', val: `oid-${roles || 'none'}` },
      { typ: 'name', val: name },
      { typ: 'preferred_username', val: 'owner@example.com' },
      { typ: 'roles', val: roles }
    ]
  })).toString('base64');
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
      availabilityHandler: options.availabilityHandler
        ?? (async () => ({ status: 200, jsonBody: { blocked: [] } })),
      outboxEnabled: false
    })
  };
}

async function ownerSession(port) {
  const session = await request(port, '/api/admin/session');
  return session.json.csrfToken;
}

let counter = 0;

async function createBooking(port) {
  const csrf = await ownerSession(port);
  const key = `manual-verify-test-${Date.now()}-${counter++}`;
  const response = await request(port, '/api/admin/bookings', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key },
    body: {
      mode: 'booking',
      firstName: 'Manuell',
      lastName: 'Verifiering',
      email: 'manuell@example.se',
      phone: '+46 70 123 45 67',
      arrival: '2030-05-10',
      departure: '2030-05-13',
      guests: 4,
      bookingSource: 'PHONE',
      statusCode: 'CONFIRMED',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      paymentStatus: 'DEPOSIT_PAID',
      amountPaid: 5000,
      latestNote: 'Manuell verifiering'
    }
  });
  return { response, csrf, reference: response.json.reference };
}

function manualVerify(port, reference, csrf, body) {
  return request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/manual-verify`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf },
    body
  });
}

function airbnbWarning(booking) {
  return (booking.warnings ?? []).find((warning) => warning.type === 'AIRBNB');
}

function mailWarnings(booking) {
  return (booking.warnings ?? []).filter((warning) => warning.type === 'MAIL');
}

async function seedTwoUnverifiedMails(repository, reference) {
  const raw = await repository.getRawBooking(reference);
  await repository.updateRequest({
    ...raw.record,
    emailStatus: {
      host: {
        mailType: 'HOST_NEW_BOOKING',
        status: 'Skickad',
        deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
        resendId: 're_host_123',
        sentAt: '2026-11-26T09:10:00.000Z',
        createdAt: '2026-11-26T09:09:00.000Z'
      },
      guest: {
        mailType: 'GUEST_BOOKING_CONFIRMED',
        status: 'Skickad',
        deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
        resendId: 're_guest_123',
        sentAt: '2026-11-26T09:00:00.000Z',
        createdAt: '2026-11-26T08:59:00.000Z'
      }
    }
  }, { ifMatch: raw.etag });
}

test('Owner manuellt verifierar Airbnb och varningen försvinner', async () => {
  const { listener, repository } = demoServer();
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    const recheck = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId: WARNING.AIRBNB_UNVERIFIED }
    });
    assert.equal(recheck.status, 200);
    const before = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.equal(airbnbWarning(before.json.booking).id, WARNING.AIRBNB_IMPORT_PENDING);

    const result = await manualVerify(port, reference, csrf, {
      kind: 'airbnb',
      warningId: WARNING.AIRBNB_IMPORT_PENDING,
      confirm: true,
      reason: 'Sett blockeringen i Airbnb-gränssnittet.'
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.manualVerified, true);
    assert.match(result.json.message, /Manuell Airbnb-verifiering sparad/);
    assert.deepEqual(result.json.nights, ['2030-05-10', '2030-05-11', '2030-05-12']);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const warning = airbnbWarning(after.json.booking);
    assert.equal(warning.id, WARNING.AIRBNB_MANUAL_VERIFIED);
    assert.equal(warning.severity, 'handled');
    assert.match(warning.what, /manuellt kontrollerat/);
    assert.match(warning.details.caveat, /Inte automatiskt verifierad/);
    assert.equal(after.json.booking.unresolvedWarnings.some((item) => item.type === 'AIRBNB'), false);

    const raw = await repository.getRawBooking(reference);
    const ack = raw.record.warningAcknowledgements.find((row) => row.method === 'MANUAL_AIRBNB');
    assert.equal(ack.actorName, 'Anna Skadevi (demo)');
    assert.equal(ack.reason, 'Sett blockeringen i Airbnb-gränssnittet.');
    assert.equal(ack.verifiedEvent, '');

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Airbnb manuellt verifierad av Owner/);
    assert.match(html.body, /Manuella kontroller/);
    assert.doesNotMatch(html.body, /Airbnb-uppdatering väntar/);
  } finally {
    close(server);
  }
});

test('manuell Airbnb-status finns kvar efter sidladdning och ny serverinstans', async () => {
  const repository = createDemoRepository({ now: NOW });
  let server = await listen(demoServer({ repository }).listener);
  let port = server.address().port;
  let reference = '';
  try {
    const created = await createBooking(port);
    reference = created.reference;
    const result = await manualVerify(port, reference, created.csrf, {
      kind: 'airbnb',
      confirm: true,
      reason: 'Kontrollerat i Airbnb innan publicering.'
    });
    assert.equal(result.status, 200);
  } finally {
    close(server);
  }

  server = await listen(demoServer({ repository }).listener);
  port = server.address().port;
  try {
    const detail = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const warning = airbnbWarning(detail.json.booking);
    assert.equal(warning.id, WARNING.AIRBNB_MANUAL_VERIFIED);
    assert.equal(warning.severity, 'handled');
  } finally {
    close(server);
  }
});

test('samma gamla exportavvikelse återöppnar inte manuell Airbnb-verifiering', async () => {
  const { listener } = demoServer();
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    const manual = await manualVerify(port, reference, csrf, {
      kind: 'airbnb',
      confirm: true,
      reason: 'Blockeringen syns i Airbnb.'
    });
    assert.equal(manual.status, 200);
    const warningId = manual.json.warnings.find((w) => w.type === 'AIRBNB').id;
    assert.equal(warningId, WARNING.AIRBNB_MANUAL_VERIFIED);

    const recheck = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId }
    });
    assert.equal(recheck.status, 200);
    assert.equal(recheck.json.verification.status, 'available');
    const after = recheck.json.warnings.find((w) => w.type === 'AIRBNB');
    assert.equal(after.id, WARNING.AIRBNB_MANUAL_VERIFIED);
    assert.equal(after.severity, 'handled');
  } finally {
    close(server);
  }
});

test('en verkligt ny kalenderavvikelse skapar en ny aktiv varning', async () => {
  let blocked = [];
  const { listener } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    const manual = await manualVerify(port, reference, csrf, {
      kind: 'airbnb',
      confirm: true,
      reason: 'Alla tre datumen blockerade i Airbnb.'
    });
    assert.equal(manual.status, 200);
    const handledId = manual.json.warnings.find((w) => w.type === 'AIRBNB').id;
    assert.equal(handledId, WARNING.AIRBNB_MANUAL_VERIFIED);

    blocked = ['2030-05-10'];
    const recheck = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId: handledId }
    });
    assert.equal(recheck.status, 200);
    assert.equal(recheck.json.verification.status, 'partial');
    const warning = recheck.json.warnings.find((w) => w.type === 'AIRBNB');
    assert.equal(warning.id, WARNING.AIRBNB_PARTIAL);
    assert.equal(warning.severity, 'action');
  } finally {
    close(server);
  }
});

test('gästmejl verifieras individuellt och värdmejlet påverkas inte', async () => {
  const { listener, repository } = demoServer();
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    await seedTwoUnverifiedMails(repository, reference);

    const before = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    assert.ok(mailWarnings(before.json.booking).length > 0);

    const result = await manualVerify(port, reference, csrf, {
      kind: 'mail',
      mailKey: 'guest',
      resendId: 're_guest_123',
      confirm: true,
      reason: 'Resend visar Delivered för gästmejlet.'
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.mailKey, 'guest');
    assert.equal(result.json.resendId, 're_guest_123');
    assert.equal(result.json.verifiedEvent, 'Delivered');
    assert.match(result.json.message, /gästmejl/);

    const after = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const remaining = mailWarnings(after.json.booking);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, WARNING.MAIL_UNVERIFIED);
    assert.match(remaining[0].what, /värdmejl/);
    assert.doesNotMatch(remaining[0].what, /gästmejl/);

    const raw = await repository.getRawBooking(reference);
    assert.equal(raw.record.emailStatus.guest.deliveryStatus, 'Accepterad av Resend – leverans ej verifierad');
    assert.equal(raw.record.emailStatus.host.deliveryStatus, 'Accepterad av Resend – leverans ej verifierad');
    assert.equal(raw.record.mailVerification, undefined);

    const history = await repository.listHistory(reference);
    const audit = history.find((entry) => entry.action === 'WARNING_MANUALLY_VERIFIED');
    assert.ok(audit);
    assert.equal(audit.actorName, 'Anna Skadevi (demo)');
    assert.match(audit.changes, /MANUAL_RESEND/);
    assert.match(audit.changes, /re_guest_123/);

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Manuellt verifierad/);
    assert.match(html.body, /Resend-ID/);
  } finally {
    close(server);
  }
});

test('felaktig CSRF nekas och Staff utan Owner nekas', async () => {
  const { listener } = demoServer();
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    const invalid = await manualVerify(port, reference, 'fel-token', {
      kind: 'airbnb', confirm: true, reason: 'Test'
    });
    assert.equal(invalid.status, 403);

    const missing = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/manual-verify`, {
      method: 'POST',
      body: { kind: 'airbnb', confirm: true, reason: 'Test' }
    });
    assert.equal(missing.status, 403);

    const valid = await manualVerify(port, reference, csrf, {
      kind: 'airbnb', confirm: true, reason: 'Giltig kontroll'
    });
    assert.equal(valid.status, 200);
  } finally {
    close(server);
  }
});

test('Staff nekas manuell verifiering', async () => {
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
    const headers = { 'X-MS-CLIENT-PRINCIPAL': principalHeader('Staff', 'Stina Staff') };
    const session = await request(port, '/api/admin/session', { headers });
    assert.equal(session.status, 200);
    const result = await request(port, '/api/admin/bookings/SK-2030-TEST/warnings/manual-verify', {
      method: 'POST',
      headers: { ...headers, 'X-CSRF-Token': session.json.csrfToken },
      body: { kind: 'airbnb', confirm: true, reason: 'Får inte spara' }
    });
    assert.equal(result.status, 403);
  } finally {
    close(server);
  }
});

test('dubbelklick skapar inte dubbla manuella verifieringar', async () => {
  const { listener, repository } = demoServer();
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    const detail = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`);
    const etag = detail.json.booking.etag;
    const body = {
      kind: 'airbnb',
      confirm: true,
      reason: 'Dubbelklickstest',
      expectedEtag: etag
    };
    const [first, second] = await Promise.all([
      manualVerify(port, reference, csrf, body),
      manualVerify(port, reference, csrf, body)
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const raw = await repository.getRawBooking(reference);
    const manual = raw.record.warningAcknowledgements.filter((row) => row.method === 'MANUAL_AIRBNB');
    assert.equal(manual.length, 1);
  } finally {
    close(server);
  }
});

test('manuell verifiering kräver bekräftelse och motivering', async () => {
  const { listener } = demoServer();
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { csrf, reference } = await createBooking(port);
    const noConfirm = await manualVerify(port, reference, csrf, {
      kind: 'airbnb', confirm: false, reason: 'Motivering finns'
    });
    assert.equal(noConfirm.status, 400);
    const noReason = await manualVerify(port, reference, csrf, {
      kind: 'airbnb', confirm: true, reason: ''
    });
    assert.equal(noReason.status, 400);
    const wrongMail = await manualVerify(port, reference, csrf, {
      kind: 'mail', mailKey: 'guest', confirm: true, reason: 'Motivering finns'
    });
    assert.equal(wrongMail.status, 409);
  } finally {
    close(server);
  }
});
