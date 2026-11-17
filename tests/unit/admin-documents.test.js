'use strict';

// Tester för servergenererade PDF-offerter och bokningsbekräftelser.
// Fokus: statusgränser, prissnapshot, betalningar, behörighet, svenska tecken,
// filnamnssäkerhet och faktisk PDF-generering (inte bara HTTP 200).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PDFParse } = require('pdf-parse');
const {
  createAdminRequestListener
} = require('../../server/admin');
const { createAuth } = require('../../server/admin/auth');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const { formatDateKey, formatMoney } = require('../../server/admin/domain');
const {
  buildQuoteModel,
  buildConfirmationModel,
  priceModel,
  paymentModel,
  filenameFor,
  safeReference,
  DocumentError
} = require('../../server/admin/documents');

function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  server.closeAllConnections();
  server.close();
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method ?? 'GET',
      headers: { ...(options.headers ?? {}) }
    }, (res) => {
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
    req.end();
  });
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

const FIXED_NOW = new Date('2026-11-13T12:00:00.000Z');

function demoServer(options = {}) {
  const now = options.now ?? FIXED_NOW;
  const auth = options.auth ?? createAuth({ demo: true });
  const repository = options.repository ?? createDemoRepository({ now });
  return createAdminRequestListener({
    auth,
    repository,
    demo: options.demo ?? true,
    now,
    writesEnabled: options.writesEnabled,
    rules: options.rules
  });
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

function bookingRecord(overrides = {}) {
  return {
    reference: 'SK-2026-TEST01',
    statusCode: 'PENDING',
    arrival: '2026-12-10',
    departure: '2026-12-13',
    nights: 3,
    guests: 4,
    firstName: 'Åsa',
    lastName: 'Öberg',
    guestName: 'Åsa Öberg',
    email: 'asa.oberg@example.se',
    phone: '+46 70 000 00 00',
    company: 'Företag med ä',
    message: '',
    bookingSource: 'WEB',
    bookingSourceLabel: 'Webbplats',
    createdAt: '2026-11-10T10:00:00.000Z',
    lodgingBase: 24000,
    discount: null,
    discountAmount: 0,
    lodgingAfterDiscount: 24000,
    addonLines: [{ id: 'slutstad', label: 'Slutstädning', quantity: 1, unitPrice: 2500, amount: 2500 }],
    totalAddons: 2500,
    total: 26500,
    calculatedTotal: 26500,
    priceVersion: 'test-version',
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    balance: 26500,
    actionFlags: {},
    isDemo: false,
    ...overrides
  };
}

test('offert för PENDING genereras utan att bokningen ändras eller låser datum', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(demoServer({ repository, now: FIXED_NOW }));
  const port = server.address().port;
  try {
    const booking = await repository.getBooking('DEMO-2026-A1');
    const response = await request(port, '/api/admin/bookings/DEMO-2026-A1/quote.pdf');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^application\/pdf/);
    assert.match(response.headers['content-disposition'], /attachment/);
    assert.match(response.headers['content-disposition'], /Skadevi-Offert-DEMO-2026-A1\.pdf/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(response.buffer.subarray(0, 4).toString(), '%PDF');

    const extracted = await pdfText(response.buffer);
    assert.ok(extracted.total >= 1);
    assert.match(extracted.text, /OFFERT/);
    assert.match(extracted.text, /Offertnummer: OFF-DEMO-2026-A1/);
    assert.match(extracted.text, /Anna Andersson/);
    assert.ok(extracted.text.includes(formatDateKey(booking.arrival, { long: true })));
    assert.ok(extracted.text.includes(normalizeSpaces(formatMoney(booking.total))));
    assert.match(extracted.text, /Detta är en offert och inte en bekräftad bokning/);
    assert.match(extracted.text, /BOKNINGS- OCH AVBOKNINGSVILLKOR/i);

    const after = await repository.getBooking('DEMO-2026-A1');
    assert.equal(after.statusCode, 'PENDING');
    const locked = (await repository.listCalendarByReference('DEMO-2026-A1'));
    assert.equal(locked.length, 0);
    assert.equal((await repository.listHistory('DEMO-2026-A1')).length, 0);
  } finally {
    close(server);
  }
});

test('bokningsbekräftelse för CONFIRMED innehåller betalningar och återstående belopp', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const booking = await repository.getBooking('DEMO-2026-F6');
  const server = await listen(demoServer({ repository, now: FIXED_NOW }));
  const port = server.address().port;
  try {
    const response = await request(port, '/api/admin/bookings/DEMO-2026-F6/confirmation.pdf');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-disposition'], /Skadevi-Bokningsbekraftelse-DEMO-2026-F6\.pdf/);
    const extracted = await pdfText(response.buffer);
    assert.match(extracted.text, /BOKNINGSBEKRÄFTELSE/);
    assert.match(extracted.text, /Bokningsnummer: DEMO-2026-F6/);
    assert.match(extracted.text, /Sara Ek/);
    assert.match(extracted.text, /BETALNINGAR/i);
    assert.match(extracted.text, /TOTALT MOTTAGNA BETALNINGAR/i);
    assert.ok(extracted.text.includes(normalizeSpaces(formatMoney(booking.amountPaid))));
    assert.match(extracted.text, /ÅTERSTÅENDE BELOPP/i);
    assert.ok(extracted.text.includes(normalizeSpaces(formatMoney(booking.balance))));
    assert.match(extracted.text, /Delbetalt/);
  } finally {
    close(server);
  }
});

test('bokningsbekräftelse nekas för PENDING, DECLINED, BLOCKED och CANCELLED', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  await repository.createRequest(bookingRecord({
    idempotencyKey: 'blocked-doc-test',
    rowKey: 'blocked-doc-test',
    reference: 'SK-2026-BLOCKED',
    statusCode: 'BLOCKED',
    guestName: 'Datumblockering'
  }));
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    for (const reference of ['DEMO-2026-A1', 'DEMO-2026-G7', 'DEMO-2026-H8', 'SK-2026-BLOCKED']) {
      const response = await request(port, `/api/admin/bookings/${reference}/confirmation.pdf`);
      assert.equal(response.status, 409, reference);
      assert.equal(response.json.code, 'CONFIRMATION_REQUIRES_CONFIRMED', reference);
      assert.doesNotMatch(response.headers['content-type'] || '', /application\/pdf/);
    }
  } finally {
    close(server);
  }
});

test('offert nekas för datumblockering och okänd bokning', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  await repository.createRequest(bookingRecord({
    idempotencyKey: 'blocked-quote-test',
    rowKey: 'blocked-quote-test',
    reference: 'SK-2026-BLOCKED',
    statusCode: 'BLOCKED'
  }));
  const server = await listen(demoServer({ repository }));
  const port = server.address().port;
  try {
    const blocked = await request(port, '/api/admin/bookings/SK-2026-BLOCKED/quote.pdf');
    assert.equal(blocked.status, 422);
    assert.equal(blocked.json.code, 'DOCUMENT_NOT_AVAILABLE');

    const missing = await request(port, '/api/admin/bookings/FINNS-INTE/quote.pdf');
    assert.equal(missing.status, 404);
  } finally {
    close(server);
  }
});

test('prisvisning följer sparad rabatt och visar aldrig både före och efter rabatt', () => {
  const withoutDiscount = priceModel(bookingRecord());
  assert.equal(withoutDiscount.rows[0].label, 'Boendepris');
  assert.equal(withoutDiscount.rows.some((row) => row.kind === 'discount'), false);
  assert.equal(withoutDiscount.rows.find((row) => row.kind === 'total').amount, 26500);

  const withDiscount = priceModel(bookingRecord({
    lodgingBase: 55000,
    discount: { label: 'Veckorabatt', percent: 30, amount: 16500 },
    discountAmount: 16500,
    discountLabel: 'Veckorabatt',
    discountPercent: 30,
    lodgingAfterDiscount: 38500,
    totalAddons: 6250,
    total: 44750,
    calculatedTotal: 44750
  }));
  assert.equal(withDiscount.rows[0].label, 'Boendepris efter rabatt');
  assert.equal(withDiscount.rows[0].amount, 38500);
  assert.equal(withDiscount.rows.some((row) => row.label === 'Boendepris'), false);
  const discountRow = withDiscount.rows.find((row) => row.kind === 'discount');
  assert.equal(discountRow.amount, 16500);
  assert.match(discountRow.note, /Redan avdragen/);
  assert.equal(withDiscount.rows.find((row) => row.kind === 'total').amount, 44750);

  const agreed = priceModel(bookingRecord({
    total: 16000,
    calculatedTotal: 17200,
    agreedTotal: 16000,
    priceAdjustmentReason: 'Återkommande gäst'
  }));
  assert.equal(agreed.rows.find((row) => row.kind === 'total').amount, 16000);
  assert.ok(agreed.notes.map(normalizeSpaces).some((note) => note.includes('Avtalat pris')));
  assert.ok(agreed.notes.map(normalizeSpaces).some((note) => note.includes('17 200 kr')));
});

test('betalningar visar registrerat belopp och återstående belopp utan negativa saldon', () => {
  const partial = paymentModel(bookingRecord({
    total: 10000,
    amountPaid: 4000,
    balance: 6000,
    paymentStatus: 'PARTIALLY_PAID'
  }));
  assert.equal(normalizeSpaces(partial.rows.find((row) => row.label === 'Totalt mottagna betalningar').value), '4 000 kr');
  assert.equal(normalizeSpaces(partial.rows.find((row) => row.label === 'Återstående belopp').value), '6 000 kr');
  assert.equal(partial.statusLabel, 'Delbetalt');

  const paid = paymentModel(bookingRecord({
    total: 10000,
    amountPaid: 10000,
    balance: 0,
    paymentStatus: 'PAID'
  }));
  assert.equal(normalizeSpaces(paid.rows.find((row) => row.label === 'Återstående belopp').value), '0 kr');

  const overpaid = paymentModel(bookingRecord({
    total: 10000,
    amountPaid: 12000,
    balance: -2000,
    paymentStatus: 'PAID'
  }));
  assert.equal(normalizeSpaces(overpaid.rows.find((row) => row.label === 'Återstående belopp').value), '0 kr');
});

test('PDF-generering bevarar svenska tecken i gästuppgifter och rubriker', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const response = await request(port, '/api/admin/bookings/DEMO-2026-D4/confirmation.pdf');
    const extracted = await pdfText(response.buffer);
    assert.match(extracted.text, /BOKNINGSBEKRÄFTELSE/);
    assert.match(extracted.text, /BOKNINGS- OCH AVBOKNINGSVILLKOR/i);
    assert.match(extracted.text, /ÅTERSTÅENDE BELOPP/i);
    assert.match(extracted.text, /Skadevi Herrgård/);
  } finally {
    close(server);
  }
});

test('offert med långa texter och många tillval sidbryts utan att tappa innehåll', async () => {
  const longRules = {
    published: true,
    version: 'test-lang',
    text: Array.from({ length: 18 }, (_, index) =>
      `Avsnitt ${index + 1}: Detta är en längre villkorstext med svenska tecken å ä ö som ska radbrytas och sidbrytas professionellt.`
    ).join('\n\n')
  };
  const addonLines = Array.from({ length: 24 }, (_, index) => ({
    id: `addon-${index}`,
    label: `Tillval ${index + 1} med en längre beskrivning som behöver radbrytas`,
    quantity: 1,
    unitPrice: 100,
    amount: 100
  }));
  const booking = bookingRecord({
    reference: 'SK-2026-LANG',
    idempotencyKey: 'lang-doc-test',
    rowKey: 'lang-doc-test',
    company: 'Ett mycket långt företagsnamn som behöver radbrytas snyggt i dokumentet och inte klippas bort',
    addonLines,
    totalAddons: 2400,
    total: 26400,
    calculatedTotal: 26400,
    balance: 26400
  });
  const repository = createDemoRepository({ now: FIXED_NOW });
  await repository.createRequest(booking);
  const server = await listen(demoServer({ repository, rules: longRules }));
  const port = server.address().port;
  try {
    const response = await request(port, '/api/admin/bookings/SK-2026-LANG/quote.pdf');
    assert.equal(response.status, 200);
    const extracted = await pdfText(response.buffer);
    assert.ok(extracted.total >= 2, `förväntade minst 2 sidor, fick ${extracted.total}`);
    assert.match(extracted.text, /Tillval 24/);
    assert.match(extracted.text, /Avsnitt 18/);
    assert.match(extracted.text, /Sida 1 av/);
  } finally {
    close(server);
  }
});

test('PDF-endpoints kräver inloggning och respekterar Staff och Owner', async () => {
  const repository = createDemoRepository({ now: FIXED_NOW });
  const server = await listen(createAdminRequestListener({
    auth: createAuth({ trustEasyAuth: true }),
    repository,
    demo: false
  }));
  const port = server.address().port;
  try {
    const anonymous = await request(port, '/api/admin/bookings/DEMO-2026-A1/quote.pdf');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.json.error, /Autentisering/);
    assert.doesNotMatch(anonymous.headers['content-type'] || '', /application\/pdf/);

    const staff = await request(port, '/api/admin/bookings/DEMO-2026-A1/quote.pdf', {
      headers: { 'x-ms-client-principal': principalHeader('Staff', 'Test Staff') }
    });
    assert.equal(staff.status, 200);
    assert.match(staff.headers['content-type'], /^application\/pdf/);
    assert.equal(staff.headers['cache-control'], 'no-store');

    const owner = await request(port, '/api/admin/bookings/DEMO-2026-D4/confirmation.pdf', {
      headers: { 'x-ms-client-principal': principalHeader('Owner') }
    });
    assert.equal(owner.status, 200);
    assert.match(owner.headers['content-type'], /^application\/pdf/);
  } finally {
    close(server);
  }
});

test('detaljsidan visar nedladdningslänkar och bekräftelse endast för CONFIRMED', async () => {
  const server = await listen(demoServer());
  const port = server.address().port;
  try {
    const pending = await request(port, '/admin/bookings/DEMO-2026-A1');
    assert.match(pending.buffer.toString('utf8'), /\/api\/admin\/bookings\/DEMO-2026-A1\/quote\.pdf/);
    assert.doesNotMatch(pending.buffer.toString('utf8'), /\/api\/admin\/bookings\/DEMO-2026-A1\/confirmation\.pdf/);
    assert.match(pending.buffer.toString('utf8'), /endast tillgänglig för bekräftade bokningar/);

    const confirmed = await request(port, '/admin/bookings/DEMO-2026-D4');
    assert.match(confirmed.buffer.toString('utf8'), /\/api\/admin\/bookings\/DEMO-2026-D4\/quote\.pdf/);
    assert.match(confirmed.buffer.toString('utf8'), /\/api\/admin\/bookings\/DEMO-2026-D4\/confirmation\.pdf/);
  } finally {
    close(server);
  }
});

test('filnamn saneras och modellen avvisar bekräftelse för icke bekräftade bokningar', () => {
  const filename = filenameFor('quote', 'SK-2026-<script>alert("x")</script>/../../');
  assert.match(filename, /^Skadevi-Offert-SK-2026-script-alert-x-script\.pdf$/);
  assert.doesNotMatch(filename, /[<>"/\\]/);
  assert.equal(safeReference('../..'), 'BOKNING');
  assert.equal(safeReference('SK-2026-ABCD'), 'SK-2026-ABCD');

  assert.throws(
    () => buildConfirmationModel(bookingRecord({ statusCode: 'PENDING' })),
    (error) => error instanceof DocumentError && error.status === 409
  );
  assert.throws(
    () => buildQuoteModel(bookingRecord({ isBlock: true })),
    (error) => error instanceof DocumentError && error.status === 422
  );
});

test('offertmodellen visar extrahusets nätter, datum och belopp', () => {
  const line = {
    id: 'extrahus',
    label: 'Extrahus (2 nätter × 1 600 kr, 2026-12-10–2026-12-12)',
    quantity: 2,
    unitPrice: 1600,
    amount: 3200
  };
  const model = buildQuoteModel(bookingRecord({
    addonLines: [line],
    totalAddons: 3200,
    total: 27200,
    calculatedTotal: 27200
  }), { rules: { published: false } });
  assert.equal(model.addons.length, 1);
  assert.equal(model.addons[0].label, line.label);
  assert.equal(model.addons[0].quantity, 2);
  assert.equal(model.addons[0].unitPrice, 1600);
  assert.equal(model.addons[0].amount, 3200);
});
