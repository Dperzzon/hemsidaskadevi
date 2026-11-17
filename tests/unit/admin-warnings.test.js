'use strict';

// Fokuserade tester för den återanvändbara varningsmotorn: Airbnb-override,
// saknad/okänd Airbnb-blockering, Owner-kvittering, Staff-spärr, audit,
// ändrade datum och interna konflikter som aldrig får döljas.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdminRequestListener } = require('../../server/admin');
const { createAuth } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const { normalizeBooking } = require('../../server/admin/domain');
const { deriveWarnings, WARNING } = require('../../server/admin/warnings');

const DEMO_OWNER = 'Anna Skadevi (demo)';

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
  const auth = options.auth ?? createAuth({ demo: true });
  const repository = options.repository ?? createDemoRepository({ now: new Date() });
  return {
    repository,
    listener: createAdminRequestListener({
      auth,
      repository,
      demo: options.demo ?? true,
      now: options.now,
      writesEnabled: options.writesEnabled ?? true,
      requireAirbnbCheck: options.requireAirbnbCheck ?? true,
      availabilityHandler: options.availabilityHandler,
      outboxEnabled: false
    })
  };
}

async function ownerSession(port) {
  const session = await request(port, '/api/admin/session');
  return session.json.csrfToken;
}

function manualBookingBody(overrides = {}) {
  return {
    mode: 'booking',
    firstName: 'Varning',
    lastName: 'Test',
    email: 'varning@example.se',
    phone: '+46 70 123 45 67',
    arrival: '2030-05-10',
    departure: '2030-05-13',
    guests: 4,
    bookingSource: 'PHONE',
    statusCode: 'CONFIRMED',
    addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
    paymentStatus: 'DEPOSIT_PAID',
    amountPaid: 5000,
    latestNote: 'Varningstest',
    ...overrides
  };
}

let counter = 0;

async function createBooking(port, overrides = {}) {
  const csrf = await ownerSession(port);
  const key = `warning-test-${Date.now()}-${counter++}`;
  const response = await request(port, '/api/admin/bookings', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key },
    body: manualBookingBody(overrides)
  });
  return { response, csrf, key };
}

async function detail(port, reference, headers = {}) {
  return request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`, { headers });
}

function airbnbWarning(booking) {
  return (booking.warnings ?? []).find((warning) => warning.type === 'AIRBNB');
}

test('bekräftad bokning med godkänd Airbnb-override visas som hanterad, inte som olöst varning', async () => {
  const nights = ['2030-05-10', '2030-05-11', '2030-05-12'];
  const server = await listen(demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: nights } })
  }).listener);
  const port = server.address().port;
  try {
    const { response } = await createBooking(port, {
      airbnbOverrideIntent: true,
      airbnbOverride: true,
      airbnbOverrideConfirmed: true,
      airbnbOverrideReason: 'Egen blockering i Airbnb för denna gäst'
    });
    assert.equal(response.status, 201);
    const reference = response.json.reference;

    const result = await detail(port, reference);
    assert.equal(result.status, 200);
    const warning = airbnbWarning(result.json.booking);
    assert.ok(warning);
    assert.equal(warning.id, WARNING.AIRBNB_OVERRIDE);
    assert.equal(warning.severity, 'handled');
    assert.equal(warning.handledBy, DEMO_OWNER);
    assert.equal(warning.handledReason, 'Egen blockering i Airbnb för denna gäst');
    assert.deepEqual(result.json.booking.unresolvedWarnings, []);
    assert.equal(result.json.booking.hasAction, false);

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Airbnb-konflikt godkänd av Owner/);
    assert.match(html.body, /Hanterad av Anna Skadevi \(demo\)/);
    assert.match(html.body, /Egen blockering i Airbnb/);
    assert.doesNotMatch(html.body, /warning-banner-action/);
    assert.doesNotMatch(html.body, /Airbnb-blockering kunde inte verifieras/);
  } finally {
    close(server);
  }
});

test('saknad verifierad Airbnb-blockering ger en tydlig varning med rekommendation och åtgärder', async () => {
  const server = await listen(demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  }).listener);
  const port = server.address().port;
  try {
    const { response } = await createBooking(port);
    assert.equal(response.status, 201);
    const reference = response.json.reference;

    const result = await detail(port, reference);
    const warning = airbnbWarning(result.json.booking);
    assert.ok(warning);
    assert.equal(warning.id, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(warning.severity, 'verify');
    assert.equal(warning.dismissible, true);
    assert.equal(warning.recheckable, true);
    assert.match(warning.recommendation, /Kontrollera att datumen är blockerade i Airbnb/);
    assert.ok(result.json.booking.unresolvedWarnings.some((item) => item.id === WARNING.AIRBNB_UNVERIFIED));

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Behöver kontrolleras/);
    assert.match(html.body, /Airbnb-blockering kunde inte verifieras/);
    assert.match(html.body, /data-warning-recheck="airbnb\.unverified"/);
    assert.match(html.body, /data-warning-ack="airbnb\.unverified"/);
    assert.doesNotMatch(html.body, /Airbnb-blockeringen är verifierad/);
  } finally {
    close(server);
  }
});

test('Airbnb-kalender som inte kan läsas visas som okänd status, aldrig som verifierat OK', async () => {
  let mode = 'empty';
  const nights = ['2030-05-10', '2030-05-11', '2030-05-12'];
  const server = await listen(demoServer({
    availabilityHandler: async () => {
      if (mode === 'throw') throw new Error('timeout');
      return { status: 200, jsonBody: { blocked: mode === 'blocked' ? nights : [] } };
    }
  }).listener);
  const port = server.address().port;
  try {
    const { response } = await createBooking(port);
    const reference = response.json.reference;
    const before = await detail(port, reference);
    assert.equal(airbnbWarning(before.json.booking).id, WARNING.AIRBNB_UNVERIFIED);
    const csrf = await ownerSession(port);

    mode = 'throw';
    const recheck = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId: WARNING.AIRBNB_UNVERIFIED }
    });
    assert.equal(recheck.status, 200);
    assert.equal(recheck.json.verification.status, 'unavailable');
    assert.deepEqual(recheck.json.verification.blockedNights, []);

    const after = await detail(port, reference);
    const warning = airbnbWarning(after.json.booking);
    assert.equal(warning.id, WARNING.AIRBNB_UNAVAILABLE);
    assert.equal(warning.severity, 'verify');
    assert.equal(after.json.booking.airbnbBlockedAt, '');
    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Airbnb-kalendern kunde inte läsas/);
    assert.match(html.body, /inte samma sak som ett verifierat OK/);
    assert.doesNotMatch(html.body, /Airbnb-blockeringen är verifierad/);
  } finally {
    close(server);
  }
});

test('Owner kan kvittera en varning med motivering, audit och oförändrad status och kalender', async () => {
  const { listener, repository } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response } = await createBooking(port);
    const reference = response.json.reference;
    const before = await detail(port, reference);
    const warning = airbnbWarning(before.json.booking);
    assert.equal(warning.severity, 'verify');
    const beforeCalendar = await request(port, '/api/admin/calendar?from=2030-05');
    const beforeNights = beforeCalendar.json.nights.filter((row) => row.reference === reference);
    const csrf = await ownerSession(port);

    const withoutReason = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/acknowledge`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId: warning.id, reason: '   ' }
    });
    assert.equal(withoutReason.status, 400);

    const acknowledged = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/acknowledge`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: {
        warningId: warning.id,
        reason: 'Datumen är redan manuellt blockerade i Airbnb.',
        expectedEtag: before.json.booking.etag
      }
    });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.json.acknowledged, true);

    const after = await detail(port, reference);
    const handled = airbnbWarning(after.json.booking);
    assert.equal(handled.id, warning.id);
    assert.equal(handled.severity, 'handled');
    assert.equal(handled.acknowledged, true);
    assert.equal(handled.handledBy, DEMO_OWNER);
    assert.equal(handled.handledReason, 'Datumen är redan manuellt blockerade i Airbnb.');
    assert.ok(handled.handledAt);
    assert.equal(after.json.booking.statusCode, 'CONFIRMED');
    assert.equal(after.json.booking.unresolvedWarnings.length, 0);

    const afterCalendar = await request(port, '/api/admin/calendar?from=2030-05');
    const afterNights = afterCalendar.json.nights.filter((row) => row.reference === reference);
    assert.deepEqual(afterNights, beforeNights);

    const raw = await repository.getRawBooking(reference);
    assert.equal(raw.record.statusCode, 'CONFIRMED');
    assert.equal(raw.record.warningAcknowledgements.length, 1);
    assert.equal(raw.record.warningAcknowledgements[0].warningId, warning.id);
    assert.equal(raw.record.warningAcknowledgements[0].actorName, DEMO_OWNER);
    assert.equal(raw.record.warningAcknowledgements[0].reason, 'Datumen är redan manuellt blockerade i Airbnb.');

    const history = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/history`);
    const audit = history.json.history.find((entry) => entry.action === 'WARNING_ACKNOWLEDGED');
    assert.ok(audit);
    assert.equal(audit.actorName, DEMO_OWNER);
    assert.equal(audit.reason, 'Datumen är redan manuellt blockerade i Airbnb.');

    const html = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`);
    assert.match(html.body, /Hanterad/);
    assert.match(html.body, /Datumen är redan manuellt blockerade i Airbnb/);
    assert.match(html.body, /Varning hanterad/);
  } finally {
    close(server);
  }
});

test('Staff kan läsa men inte kvittera eller kontrollera varningar', async () => {
  const repository = createDemoRepository({ now: new Date() });
  const server = await listen(createAdminRequestListener({
    auth: createAuth({ trustEasyAuth: true }),
    repository,
    demo: false,
    writesEnabled: true,
    requireAirbnbCheck: true,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  }));
  const port = server.address().port;
  const ownerHeader = principalHeader('Owner', 'Test Owner');
  const staffHeader = principalHeader('Staff', 'Test Staff');
  try {
    const ownerSessionResponse = await request(port, '/api/admin/session', {
      headers: { 'x-ms-client-principal': ownerHeader }
    });
    const created = await request(port, '/api/admin/bookings', {
      method: 'POST',
      headers: {
        'x-ms-client-principal': ownerHeader,
        'X-CSRF-Token': ownerSessionResponse.json.csrfToken,
        'Idempotency-Key': `staff-warning-${Date.now()}`
      },
      body: manualBookingBody()
    });
    assert.equal(created.status, 201);
    const reference = created.json.reference;
    const ownerDetail = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}`, {
      headers: { 'x-ms-client-principal': ownerHeader }
    });
    const warning = airbnbWarning(ownerDetail.json.booking);

    const staffSession = await request(port, '/api/admin/session', {
      headers: { 'x-ms-client-principal': staffHeader }
    });
    assert.deepEqual(staffSession.json.user.roles, ['Staff']);

    const ack = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/acknowledge`, {
      method: 'POST',
      headers: {
        'x-ms-client-principal': staffHeader,
        'X-CSRF-Token': staffSession.json.csrfToken
      },
      body: { warningId: warning.id, reason: 'Staff ska inte kunna kvittera.' }
    });
    assert.equal(ack.status, 403);

    const recheck = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/recheck`, {
      method: 'POST',
      headers: {
        'x-ms-client-principal': staffHeader,
        'X-CSRF-Token': staffSession.json.csrfToken
      },
      body: { warningId: warning.id }
    });
    assert.equal(recheck.status, 403);

    const staffDetail = await request(port, `/admin/bookings/${encodeURIComponent(reference)}`, {
      headers: { 'x-ms-client-principal': staffHeader }
    });
    assert.equal(staffDetail.status, 200);
    assert.match(staffDetail.body, /Airbnb-blockering kunde inte verifieras/);
    assert.match(staffDetail.body, /Endast Owner kan kontrollera och markera varningar som hanterade/);
    assert.doesNotMatch(staffDetail.body, /data-warning-ack=/);
  } finally {
    close(server);
  }
});

test('ändrade bokningsdatum efter kvittering gör varningen olöst igen', async () => {
  const { listener, repository } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const { response } = await createBooking(port);
    const reference = response.json.reference;
    const before = await detail(port, reference);
    const warning = airbnbWarning(before.json.booking);
    const csrf = await ownerSession(port);
    const acknowledged = await request(port, `/api/admin/bookings/${encodeURIComponent(reference)}/warnings/acknowledge`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId: warning.id, reason: 'Kontrollerat i Airbnb.' }
    });
    assert.equal(acknowledged.status, 200);

    const raw = await repository.getRawBooking(reference);
    const moved = {
      ...raw.record,
      arrival: '2030-05-11',
      departure: '2030-05-14',
      nights: 3,
      version: Number(raw.record.version || 1) + 1,
      updatedAt: new Date().toISOString()
    };
    await repository.updateRequest(moved, { ifMatch: raw.etag });

    const after = await detail(port, reference);
    const warningAfter = airbnbWarning(after.json.booking);
    assert.equal(warningAfter.id, WARNING.AIRBNB_UNVERIFIED);
    assert.equal(warningAfter.severity, 'verify');
    assert.notEqual(warningAfter.severity, 'handled');
    assert.ok(after.json.booking.unresolvedWarnings.some((item) => item.id === WARNING.AIRBNB_UNVERIFIED));
    assert.equal(after.json.booking.warningAcknowledgements.length, 1);
    assert.equal(after.json.booking.statusCode, 'CONFIRMED');
  } finally {
    close(server);
  }
});

test('intern dubbelbokning får aldrig döljas av Airbnb-override eller kvittering', async () => {
  const nights = ['2030-06-10', '2030-06-11', '2030-06-12'];
  const { listener, repository } = demoServer({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: nights } })
  });
  const server = await listen(listener);
  const port = server.address().port;
  try {
    const first = await createBooking(port, {
      arrival: '2030-06-10',
      departure: '2030-06-13',
      email: 'first-overlap@example.se',
      airbnbOverrideIntent: true,
      airbnbOverride: true,
      airbnbOverrideConfirmed: true,
      airbnbOverrideReason: 'Egen Airbnb-blockering'
    });
    assert.equal(first.response.status, 201);
    const firstReference = first.response.json.reference;

    const second = await createBooking(port, {
      arrival: '2030-07-10',
      departure: '2030-07-12',
      email: 'second-overlap@example.se'
    });
    assert.equal(second.response.status, 201);
    const secondReference = second.response.json.reference;

    const secondRaw = await repository.getRawBooking(secondReference);
    await repository.updateRequest({
      ...secondRaw.record,
      arrival: '2030-06-11',
      departure: '2030-06-13',
      nights: 2,
      version: Number(secondRaw.record.version || 1) + 1,
      updatedAt: new Date().toISOString()
    }, { ifMatch: secondRaw.etag });

    const result = await detail(port, firstReference);
    const warnings = result.json.booking.warnings;
    assert.ok(warnings.some((warning) => warning.id === WARNING.AIRBNB_OVERRIDE && warning.severity === 'handled'));
    const internal = warnings.find((warning) => warning.id === WARNING.INTERNAL_BOOKING_CONFLICT);
    assert.ok(internal);
    assert.equal(internal.severity, 'action');
    assert.equal(internal.dismissible, false);
    assert.match(internal.recommendation, /kan inte markeras som hanterad/);

    const csrf = await ownerSession(port);
    const ack = await request(port, `/api/admin/bookings/${encodeURIComponent(firstReference)}/warnings/acknowledge`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { warningId: WARNING.INTERNAL_BOOKING_CONFLICT, reason: 'Försök att dölja intern konflikt.' }
    });
    assert.equal(ack.status, 409);
    assert.equal(ack.json.code, 'WARNING_NOT_DISMISSIBLE');

    const raw = await repository.getRawBooking(firstReference);
    assert.equal(raw.record.warningAcknowledgements.length, 0);
    assert.equal(raw.record.statusCode, 'CONFIRMED');
  } finally {
    close(server);
  }
});

test('varningsmotorn skiljer på verifierad, tillgänglig och okänd Airbnb-status', () => {
  const base = {
    reference: 'SK-2030-TEST',
    statusCode: 'CONFIRMED',
    arrival: '2030-08-10',
    departure: '2030-08-13',
    bookingSource: 'AIRBNB',
    paymentStatus: 'DEPOSIT_PAID',
    total: 1000,
    createdAt: '2026-11-01T00:00:00Z',
    actionFlags: {}
  };
  const normalized = (extra) => normalizeBooking({ ...base, ...extra });

  const unverified = deriveWarnings(normalized({}));
  assert.equal(unverified.find((warning) => warning.type === 'AIRBNB').id, WARNING.AIRBNB_UNVERIFIED);

  const legacyOverride = deriveWarnings(normalized({
    airbnbOverride: true,
    airbnbOverrideReason: 'Godkänd Airbnb-konflikt',
    airbnbOverrideApprovedBy: 'Owner',
    airbnbOverrideApprovedAt: '2026-11-02T10:00:00.000Z',
    airbnbBlockedNights: ['2030-08-10', '2030-08-11', '2030-08-12']
  }));
  assert.equal(legacyOverride.find((warning) => warning.type === 'AIRBNB').id, WARNING.AIRBNB_OVERRIDE);
  assert.equal(legacyOverride.find((warning) => warning.type === 'AIRBNB').severity, 'handled');
  assert.equal(legacyOverride.some((warning) => warning.severity !== 'handled' && warning.type === 'AIRBNB'), false);

  const blocked = deriveWarnings(normalized({
    airbnbVerification: {
      status: 'blocked',
      blockedNights: ['2030-08-10', '2030-08-11', '2030-08-12'],
      checkedAt: '2026-11-02T10:00:00.000Z',
      checkedBy: 'Owner',
      fingerprint: 'SK-2030-TEST|2030-08-10|2030-08-13|AIRBNB'
    }
  }));
  assert.equal(blocked.find((warning) => warning.type === 'AIRBNB').id, WARNING.AIRBNB_VERIFIED);
  assert.equal(blocked.find((warning) => warning.type === 'AIRBNB').severity, 'handled');

  const available = deriveWarnings(normalized({
    airbnbVerification: {
      status: 'available',
      blockedNights: [],
      checkedAt: '2026-11-02T10:00:00.000Z',
      checkedBy: 'Owner',
      fingerprint: 'SK-2030-TEST|2030-08-10|2030-08-13|AIRBNB'
    }
  }));
  assert.equal(available.find((warning) => warning.type === 'AIRBNB').id, WARNING.AIRBNB_AVAILABLE);
  assert.equal(available.find((warning) => warning.type === 'AIRBNB').severity, 'action');

  const unknown = deriveWarnings(normalized({
    airbnbVerification: {
      status: 'unavailable',
      blockedNights: [],
      checkedAt: '2026-11-02T10:00:00.000Z',
      checkedBy: 'Owner',
      fingerprint: 'SK-2030-TEST|2030-08-10|2030-08-13|AIRBNB'
    }
  }));
  assert.equal(unknown.find((warning) => warning.type === 'AIRBNB').id, WARNING.AIRBNB_UNAVAILABLE);
  assert.equal(unknown.find((warning) => warning.type === 'AIRBNB').severity, 'verify');
});
