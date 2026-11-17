'use strict';

// Fokuserade tester för delbetalningar, betalningshistorik, kompatibilitet med
// äldre mottagna belopp, överbetalning, dubbelinskick, behörighet, ETag,
// rättelser med auditlogg samt PDF-sammanställning.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PDFParse } = require('pdf-parse');
const { createAdminRequestListener } = require('../../server/admin');
const { createAuth } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const {
  parseKronorToOre,
  computePaymentSummary
} = require('../../server/admin/payments');

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

function demoServer(options = {}) {
  return createAdminRequestListener({
    auth: options.auth ?? createAuth({ demo: true }),
    repository: options.repository ?? createDemoRepository({ now: FIXED_NOW }),
    demo: options.demo ?? true,
    now: FIXED_NOW,
    writesEnabled: true,
    requireAirbnbCheck: false
  });
}

async function csrfToken(port, headers = {}) {
  const session = await request(port, '/api/admin/session', { headers });
  return session.json.csrfToken;
}

function normalizeSpaces(value) {
  return String(value).replace(/[\u00A0\u202F]/g, ' ');
}

async function pdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { ...result, text: normalizeSpaces(result.text) };
  } finally {
    await parser.destroy();
  }
}

async function createConfirmedBooking(port, csrf, overrides = {}) {
  const response = await request(port, '/api/admin/bookings', {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrf,
      'Idempotency-Key': `payment-test-${Date.now()}-${Math.random()}`
    },
    body: {
      mode: 'booking',
      firstName: 'Betal',
      lastName: 'Test',
      email: `betal-${Math.random()}@example.se`,
      phone: '+46 70 123 45 67',
      arrival: '2027-04-10',
      departure: '2027-04-13',
      guests: 4,
      bookingSource: 'PHONE',
      statusCode: 'CONFIRMED',
      addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      latestNote: 'Betalningstest',
      ...overrides
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.reference;
}

async function record(port, csrf, reference, body, key) {
  return request(port, `/api/admin/bookings/${reference}/payments`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key ?? `pay-${Date.now()}-${Math.random()}` },
    body
  });
}

test('belopp tolkas exakt i heltal ören och äldre mottaget belopp blir ingående saldo', () => {
  assert.equal(parseKronorToOre('5000'), 500000);
  assert.equal(parseKronorToOre('5000,50'), 500050);
  assert.equal(parseKronorToOre('12.34'), 1234);
  assert.equal(parseKronorToOre('12.345'), null);
  assert.equal(parseKronorToOre('-5'), null);
  assert.equal(parseKronorToOre('abc'), null);

  const legacy = computePaymentSummary({ total: 20000, amountPaid: 8000 });
  assert.equal(legacy.openingBalanceOre, 800000);
  assert.equal(legacy.paidOre, 800000);
  assert.equal(legacy.remainingOre, 1200000);
  assert.equal(legacy.paymentStatus, 'PARTIALLY_PAID');

  const withOpening = computePaymentSummary({
    total: 20000,
    amountPaid: 8000,
    paymentOpeningBalanceOre: 800000,
    payments: [{
      id: 'pay-1',
      type: 'PAYMENT',
      amountOre: 500000,
      paymentDate: '2026-11-01',
      method: 'SWISH',
      createdAt: '2026-11-01T10:00:00Z'
    }]
  });
  assert.equal(withOpening.paidOre, 1300000);
  assert.equal(withOpening.remainingOre, 700000);
});

test('en och flera delbetalningar räknas ihop utan att ändra totalpriset', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const before = await repository.getBooking('DEMO-2026-A1');
    const reference = 'DEMO-2026-A1';

    const first = await record(port, csrf, reference, {
      amount: '5000',
      paymentDate: '2026-11-10',
      method: 'BANK_TRANSFER',
      reference: 'Bankgiro 123'
    }, 'payment-single-0001');
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.amountPaid, 5000);
    assert.equal(first.json.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(first.json.total, before.total);

    const second = await record(port, csrf, reference, {
      amount: '7000,25',
      paymentDate: '2026-11-12',
      method: 'SWISH',
      reference: 'Swish 456'
    }, 'payment-single-0002');
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(second.json.amountPaid, 12000.25);
    assert.equal(second.json.remaining, before.total - 12000.25);

    const detail = await request(port, `/api/admin/bookings/${reference}`);
    const booking = detail.json.booking;
    assert.equal(booking.total, before.total);
    assert.equal(booking.payments.length, 2);
    assert.equal(booking.amountPaidOre, 1200025);
    assert.equal(booking.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(booking.payments[0].methodLabel, 'Banköverföring');
    assert.equal(booking.payments[1].methodLabel, 'Swish');
    assert.equal(booking.paymentLabel, 'Delbetalt');
  } finally {
    close(server);
  }
});

test('befintligt mottaget belopp bevaras som ingående saldo och dubbelräknas inte', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const before = await repository.getBooking('DEMO-2026-F6');
    assert.ok(before.amountPaid > 0);
    assert.equal(before.payments.length, 0);

    const response = await record(port, csrf, 'DEMO-2026-F6', {
      amount: '1000',
      paymentDate: '2026-11-14',
      method: 'CASH'
    }, 'payment-legacy-0001');
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json.amountPaid, before.amountPaid + 1000);

    const detail = await request(port, '/api/admin/bookings/DEMO-2026-F6');
    assert.equal(detail.json.booking.openingBalanceOre, Math.round(before.amountPaid * 100));
    assert.equal(detail.json.booking.payments.length, 1);
    assert.equal(detail.json.booking.amountPaid, before.amountPaid + 1000);
    const raw = await repository.getRawBooking('DEMO-2026-F6');
    assert.equal(raw.record.paymentOpeningBalanceOre, Math.round(before.amountPaid * 100));
  } finally {
    close(server);
  }
});

test('överbetalning visas tydligt och historiken behålls', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const reference = await createConfirmedBooking(port, csrf);
    const booking = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;

    const paid = await record(port, csrf, reference, {
      amount: String(booking.total),
      paymentDate: '2026-11-15',
      method: 'SWISH'
    }, 'payment-over-0001');
    assert.equal(paid.status, 201);
    assert.equal(paid.json.paymentStatus, 'PAID');
    assert.equal(paid.json.remaining, 0);

    const over = await record(port, csrf, reference, {
      amount: '250',
      paymentDate: '2026-11-16',
      method: 'OTHER'
    }, 'payment-over-0002');
    assert.equal(over.status, 201);
    assert.equal(over.json.paymentStatus, 'PAID');
    assert.equal(over.json.overpaid, true);
    assert.equal(over.json.overpaidOre, 25000);
    assert.equal(over.json.paymentLabel, 'Betald (överbetalning)');

    const detail = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    assert.equal(detail.payments.length, 2);
    assert.equal(detail.total, booking.total);
    assert.equal(detail.remainingOre, -25000);
  } finally {
    close(server);
  }
});

test('dubbelinskick med samma idempotensnyckel skapar aldrig en dubbel betalning', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const reference = 'DEMO-2026-A1';
    const key = 'payment-double-0001';
    const payload = {
      amount: '1500',
      paymentDate: '2026-11-15',
      method: 'OTHER',
      reference: 'Dubbelt klick'
    };
    const first = await record(port, csrf, reference, payload, key);
    const second = await record(port, csrf, reference, payload, key);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.payment.id, first.json.payment.id);

    const detail = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.amountPaid, 1500);
  } finally {
    close(server);
  }
});

test('Owner kan registrera men Staff nekas och kan bara läsa historiken', async () => {
  const repo = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(createAdminRequestListener({
    auth: createAuth({ trustEasyAuth: true }),
    repository: repo,
    demo: false,
    now: FIXED_NOW,
    writesEnabled: true,
    requireAirbnbCheck: false
  }));
  const port = server.address().port;
  const ownerHeaders = { 'x-ms-client-principal': principalHeader('Owner', 'Test Owner') };
  const staffHeaders = { 'x-ms-client-principal': principalHeader('Staff', 'Test Staff') };
  try {
    const ownerCsrf = await csrfToken(port, ownerHeaders);
    const created = await request(port, '/api/admin/bookings/DEMO-2026-A1/payments', {
      method: 'POST',
      headers: { ...ownerHeaders, 'X-CSRF-Token': ownerCsrf, 'Idempotency-Key': 'payment-role-0001' },
      body: { amount: '1000', paymentDate: '2026-11-10', method: 'SWISH' }
    });
    assert.equal(created.status, 201);

    const staffCsrf = await csrfToken(port, staffHeaders);
    const denied = await request(port, '/api/admin/bookings/DEMO-2026-A1/payments', {
      method: 'POST',
      headers: { ...staffHeaders, 'X-CSRF-Token': staffCsrf, 'Idempotency-Key': 'payment-staff-0001' },
      body: { amount: '500', paymentDate: '2026-11-11', method: 'CASH' }
    });
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /ägarbehörighet|Owner/);

    const read = await request(port, '/api/admin/bookings/DEMO-2026-A1', { headers: staffHeaders });
    assert.equal(read.status, 200);
    assert.equal(read.json.booking.payments.length, 1);
  } finally {
    close(server);
  }
});

test('ETag-konflikt stoppar betalning när bokningen ändrats parallellt', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const reference = 'DEMO-2026-A1';
    const original = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;

    const note = await request(port, `/api/admin/bookings/${reference}/notes`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      body: { note: 'Parallell ändring', expectedEtag: original.etag }
    });
    assert.equal(note.status, 200);

    const stale = await record(port, csrf, reference, {
      amount: '1000',
      paymentDate: '2026-11-10',
      method: 'SWISH',
      expectedEtag: original.etag
    }, 'payment-stale-0001');
    assert.equal(stale.status, 409);
    assert.match(stale.json.error, /ändrats av någon annan/);

    const detail = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    assert.equal(detail.payments.length, 0);
  } finally {
    close(server);
  }
});

test('rättelse kräver motivering, behåller historiken och auditloggas', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const reference = 'DEMO-2026-A1';
    const payment = await record(port, csrf, reference, {
      amount: '2000',
      paymentDate: '2026-11-10',
      method: 'SWISH'
    }, 'payment-correct-0001');
    assert.equal(payment.status, 201);

    const current = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    const withoutReason = await request(port, `/api/admin/bookings/${reference}/payments/${payment.json.payment.id}/corrections`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'correction-no-reason' },
      body: { expectedEtag: current.etag }
    });
    assert.equal(withoutReason.status, 400);
    assert.ok(withoutReason.json.fields.reason);

    const corrected = await request(port, `/api/admin/bookings/${reference}/payments/${payment.json.payment.id}/corrections`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'correction-reason-0001' },
      body: {
        reason: 'Fel belopp registrerades av misstag.',
        expectedEtag: current.etag
      }
    });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.json));
    assert.equal(corrected.json.amountPaid, 0);
    assert.equal(corrected.json.paymentStatus, 'UNPAID');

    const detail = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    assert.equal(detail.payments.length, 2);
    assert.equal(detail.payments[0].id, payment.json.payment.id);
    assert.equal(detail.payments[1].type, 'CORRECTION');
    assert.equal(detail.payments[1].amountOre, -200000);
    assert.equal(detail.payments[1].reason, 'Fel belopp registrerades av misstag.');

    const again = await request(port, `/api/admin/bookings/${reference}/payments/${payment.json.payment.id}/corrections`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': 'correction-second-0001' },
      body: { reason: 'Ny rättelse', expectedEtag: detail.etag }
    });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'PAYMENT_ALREADY_CORRECTED');

    const history = (await request(port, `/api/admin/bookings/${reference}/history`)).json.history;
    const recorded = history.find((entry) => entry.action === 'PAYMENT_RECORDED');
    const correction = history.find((entry) => entry.action === 'PAYMENT_CORRECTED');
    assert.ok(recorded);
    assert.ok(correction);
    assert.equal(correction.reason, 'Fel belopp registrerades av misstag.');
    assert.equal(correction.actorName, 'Anna Skadevi (demo)');
  } finally {
    close(server);
  }
});

test('PDF-bekräftelsen visar totalpris, mottagna betalningar och återstående belopp medan offerten inte visar betalningar', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const reference = await createConfirmedBooking(port, csrf);
    const booking = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;

    await record(port, csrf, reference, {
      amount: '5000', paymentDate: '2026-11-10', method: 'BANK_TRANSFER'
    }, 'payment-pdf-0001');
    await record(port, csrf, reference, {
      amount: '7000', paymentDate: '2026-11-11', method: 'SWISH'
    }, 'payment-pdf-0002');

    const confirmation = await request(port, `/api/admin/bookings/${reference}/confirmation.pdf`);
    assert.equal(confirmation.status, 200);
    const text = (await pdfText(confirmation.buffer)).text;
    assert.match(text, /TOTALPRIS/i);
    assert.match(text, /TOTALT MOTTAGNA BETALNINGAR/i);
    assert.match(text, /ÅTERSTÅENDE BELOPP/i);
    assert.match(text, /12 000 kr/);
    assert.match(text, /Delbetalt/);

    const quote = await request(port, `/api/admin/bookings/${reference}/quote.pdf`);
    assert.equal(quote.status, 200);
    const quoteText = (await pdfText(quote.buffer)).text;
    assert.doesNotMatch(quoteText, /TOTALT MOTTAGNA BETALNINGAR/i);
    assert.doesNotMatch(quoteText, /BETALNINGAR/i);
    assert.doesNotMatch(quoteText, /12 000 kr/);

    const amountLeft = booking.total - 12000;
    assert.ok(text.includes(normalizeSpaces(
      `${new Intl.NumberFormat('sv-SE').format(amountLeft)} kr`
    )));
  } finally {
    close(server);
  }
});

test('registrering av betalning ändrar inte bokningsstatus eller kalenderlås', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const csrf = await csrfToken(port);
    const reference = 'DEMO-2026-D4';
    const before = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    const calendarBefore = (await request(port, '/api/admin/calendar?from=2026-11')).json.nights
      .filter((row) => row.reference === reference);

    const response = await record(port, csrf, reference, {
      amount: '100', paymentDate: '2026-11-16', method: 'OTHER'
    }, 'payment-status-safe-0001');
    assert.equal(response.status, 201);

    const after = (await request(port, `/api/admin/bookings/${reference}`)).json.booking;
    assert.equal(after.statusCode, before.statusCode);
    assert.equal(after.arrival, before.arrival);
    assert.equal(after.departure, before.departure);
    const calendarAfter = (await request(port, '/api/admin/calendar?from=2026-11')).json.nights
      .filter((row) => row.reference === reference);
    assert.deepEqual(
      calendarAfter.map((row) => row.night),
      calendarBefore.map((row) => row.night)
    );
  } finally {
    close(server);
  }
});
