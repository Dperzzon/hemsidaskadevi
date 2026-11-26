'use strict';

// Regressionstester för Steg 16B: tillval som finns sparade i bokningen men
// saknas i prissnapshotens addonLines får aldrig bli "Inga tillval" i en
// bekräftelse. Dörrkoden får endast förekomma i bekräftelser för CONFIRMED.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveConfirmationAddons,
  ISSUE
} = require('../../server/booking/confirmation-addons');
const {
  buildBookingConfirmation,
  buildAddonVerificationMail,
  buildAddonConfirmation,
  buildAddonRequestNotifications
} = require('../../server/booking/booking-mail');
const { normalizeBooking } = require('../../server/admin/domain');
const { buildConfirmationModel, buildQuoteModel } = require('../../server/admin/documents');
const { toEntity, fromEntity } = require('../../server/booking/store');

function realRecord(overrides = {}) {
  return {
    idempotencyKey: 'booking-bxj3bb',
    rowKey: 'booking-bxj3bb',
    reference: 'SK-2026-BXJ3BB',
    statusCode: 'CONFIRMED',
    status: 'Bekräftad',
    arrival: '2026-12-03',
    departure: '2026-12-04',
    nights: 1,
    guests: 5,
    totalGuests: 5,
    firstName: 'Sofia',
    lastName: 'Testsson',
    email: 'sofia@example.se',
    phone: '+46 70 000 00 00',
    addons: {
      slutstad: true,
      extrahus: false,
      extrahusNights: 0,
      extrahusGuests: 0,
      lakan: true,
      linenCount: 5,
      ved: true,
      tidigIncheckning: true,
      senUtcheckning: true
    },
    totalAddons: 4850,
    lodgingBase: 7000,
    lodgingAfterDiscount: 7000,
    total: 11850,
    priceVersion: '2026-11-17.2',
    pricing: { addonLines: [] },
    bufferNightsMode: 'auto',
    bufferNights: ['2026-12-02', '2026-12-04'],
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    createdAt: '2026-11-26T09:30:45.000Z',
    confirmedAt: '2026-11-26T09:33:03.000Z',
    ...overrides
  };
}

test('rekonstruerar tillvalsrader när prissnapshoten saknar addonLines', () => {
  const resolution = resolveConfirmationAddons(realRecord());
  assert.equal(resolution.ok, true);
  assert.equal(resolution.source, 'recomputed');
  assert.equal(resolution.warnings[0].code, 'ADDON_LINES_RECONSTRUCTED');
  assert.equal(resolution.totalAddons, 4850);
  assert.deepEqual(resolution.lines.map((line) => line.id), [
    'slutstad', 'lakan', 'ved', 'tidigIncheckning', 'senUtcheckning'
  ]);
  assert.deepEqual(resolution.lines.map((line) => line.amount), [2500, 1000, 350, 500, 500]);
  assert.equal(resolution.lines[1].quantity, 5);
  assert.equal(resolution.total, 11850);
  assert.deepEqual(resolution.issues, []);
});

test('bekräftelsemejlet visar alla tillval, korrekt total och dörrkod', () => {
  const mail = buildBookingConfirmation(realRecord(), { doorCode: '125456' });
  assert.doesNotMatch(mail.html, /Inga tillval/);
  assert.doesNotMatch(mail.body, /Inga tillval/);
  for (const label of [
    'Slutstädning', 'Lakan och handdukar', 'Ved', 'Tidig incheckning', 'Sen utcheckning'
  ]) {
    assert.match(mail.html, new RegExp(label));
    assert.match(mail.body, new RegExp(label));
  }
  assert.match(mail.html, /5 × 200 kr = 1\s?000 kr/);
  assert.match(mail.html, /11\s?850\s?kr/);
  assert.match(mail.body, /11\s?850\s?kr/);
  assert.match(mail.html, /Dörrkod/);
  assert.match(mail.html, /125456/);
  assert.match(mail.html, /Dörren med kodlåset är på höger sida av huset\./);
  assert.match(mail.body, /Dörrkod: 125456/);
});

test('bekräftelse utan tillval visar Inga tillval men behåller dörrkoden', () => {
  const mail = buildBookingConfirmation(realRecord({
    addons: {
      slutstad: false,
      extrahus: false,
      extrahusNights: 0,
      extrahusGuests: 0,
      lakan: false,
      linenCount: 0,
      ved: false,
      tidigIncheckning: false,
      senUtcheckning: false
    },
    totalAddons: 0,
    total: 7000,
    pricing: { addonLines: [] },
    bufferNights: []
  }), { doorCode: '125456' });
  assert.match(mail.html, /Inga tillval/);
  assert.match(mail.body, /Inga tillval/);
  assert.match(mail.html, /125456/);
});

test('dörrkoden visas inte i bekräftelse för icke bekräftad bokning', () => {
  const mail = buildBookingConfirmation(realRecord({
    statusCode: 'PENDING',
    status: 'Inväntar godkännande'
  }), { doorCode: '125456' });
  assert.doesNotMatch(mail.html, /125456/);
  assert.doesNotMatch(mail.body, /125456/);
});

test('dörrkoden läcker inte till verifierings-, tillvals- eller förfrågningsmejl', () => {
  const previous = process.env.DOOR_CODE;
  process.env.DOOR_CODE = '125456';
  try {
    const verification = buildAddonVerificationMail(realRecord(), '123456');
    assert.doesNotMatch(verification.html, /125456/);
    assert.doesNotMatch(verification.body, /125456/);

    const confirmation = buildAddonConfirmation(realRecord(), {
      orderId: 'ao-1', lines: [{ label: 'Ved', amount: 350 }], totalOre: 35000, status: 'PAID'
    });
    assert.doesNotMatch(confirmation.html, /125456/);
    assert.doesNotMatch(confirmation.body, /125456/);

    const request = buildAddonRequestNotifications(realRecord(), {
      requestId: 'ar-1', lines: [{ label: 'Ved' }], message: 'Vill boka ved'
    });
    assert.doesNotMatch(request.host.html, /125456/);
    assert.doesNotMatch(request.guest.html, /125456/);
  } finally {
    if (previous === undefined) delete process.env.DOOR_CODE;
    else process.env.DOOR_CODE = previous;
  }
});

test('PDF-modellen använder rekonstruerade tillval men innehåller aldrig dörrkoden', () => {
  const booking = normalizeBooking(realRecord());
  const confirmation = buildConfirmationModel(booking, { now: new Date('2026-11-26T11:00:00Z') });
  assert.equal(confirmation.addons.length, 5);
  assert.deepEqual(confirmation.addons.map((line) => line.label), [
    'Slutstädning (exklusive kök)',
    'Lakan och handdukar',
    'Ved',
    'Tidig incheckning',
    'Sen utcheckning'
  ]);
  assert.equal(confirmation.price.addonsTotal, 4850);
  assert.equal(confirmation.price.total, 11850);
  assert.doesNotMatch(JSON.stringify(confirmation), /125456/);

  const quote = buildQuoteModel(normalizeBooking(realRecord({
    statusCode: 'PENDING',
    status: 'Inväntar godkännande'
  })), { now: new Date('2026-11-26T11:00:00Z') });
  assert.equal(quote.addons.length, 5);
  assert.doesNotMatch(JSON.stringify(quote), /125456/);
});

test('konflikt flaggas och bekräftelsen blockeras i stället för att skicka fel tillval', () => {
  const record = realRecord({
    priceVersion: '2026-01-01.0',
    pricing: { addonLines: [] }
  });
  const resolution = resolveConfirmationAddons(record);
  assert.equal(resolution.ok, false);
  assert.equal(resolution.issues[0].code, ISSUE.ADDON_LINES_MISSING);
  assert.throws(
    () => buildBookingConfirmation(record),
    (error) => error.code === 'CONFIRMATION_DATA_CONFLICT' &&
      error.issues.some((issue) => issue.code === ISSUE.ADDON_LINES_MISSING)
  );
});

test('fel antal eller pris i sparade rader flaggas som datakonflikt', () => {
  const record = realRecord({
    pricing: {
      addonLines: [
        { id: 'slutstad', label: 'Slutstädning', quantity: 1, unitPrice: 2500, amount: 2500 },
        { id: 'lakan', label: 'Lakan och handdukar', quantity: 4, unitPrice: 200, amount: 800 }
      ]
    }
  });
  const resolution = resolveConfirmationAddons(record);
  assert.equal(resolution.ok, false);
  assert.ok(resolution.issues.length > 0);
});

test('inkonsekventa kalenderbuffertar blockerar bekräftelsen', () => {
  const resolution = resolveConfirmationAddons(realRecord({ bufferNights: ['2026-12-02'] }));
  assert.equal(resolution.ok, false);
  assert.ok(resolution.issues.some((issue) => issue.code === ISSUE.BUFFER_MISMATCH));
});

test('lagringsrundan bevarar tillvalsrader i prissnapshoten', () => {
  const base = realRecord();
  const record = { ...base, addonLines: resolveConfirmationAddons(base).lines };
  const entity = toEntity(record, 'request');
  const round = fromEntity(entity);
  assert.equal(round.addonLines.length, 5);
  assert.deepEqual(round.addonLines.map((line) => line.id), [
    'slutstad', 'lakan', 'ved', 'tidigIncheckning', 'senUtcheckning'
  ]);
  assert.equal(round.addonLines.reduce((sum, line) => sum + line.amount, 0), 4850);
});
