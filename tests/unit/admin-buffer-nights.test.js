'use strict';

// Tester för manuell hantering av kalenderbuffertar: att bekräftade bokningar
// låser rätt buffertnätter, att avbokning frigör dem, att ändrade tillval bara
// rör buffertrader och att äldre bokningar utan automatik lämnas orörda.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoRepository } = require('../../server/admin/repository/demo');
const {
  createManualBooking,
  updateAddons,
  changeStatus
} = require('../../server/admin/booking-service');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const OWNER = { id: 'oid-owner', name: 'Test Owner', email: 'owner@example.com', roles: ['Owner'] };

function options(overrides = {}) {
  return {
    now: NOW,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } }),
    outboxEnabled: false,
    ...overrides
  };
}

function body(overrides = {}) {
  return {
    mode: 'booking',
    firstName: 'Manuel',
    lastName: 'Bokning',
    email: 'manuel@example.com',
    phone: '+46 70 123 45 67',
    arrival: '2027-02-10',
    departure: '2027-02-12',
    guests: 4,
    bookingSource: 'PHONE',
    statusCode: 'CONFIRMED',
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: false, senUtcheckning: false
    },
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    latestNote: 'Test.',
    ...overrides
  };
}

async function create(repo, overrides = {}) {
  const result = await createManualBooking(repo, OWNER, body(overrides), options());
  assert.equal(result.status, 201, JSON.stringify(result.jsonBody));
  return result.jsonBody.reference;
}

test('manuell bekräftad bokning låser buffertnätter och avbokning frigör alla', async () => {
  const repo = createDemoRepository({ now: NOW });
  const reference = await create(repo, {
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: true, senUtcheckning: true
    }
  });
  const rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12']);
  assert.equal(rows.filter((row) => row.kind === 'BUFFER').length, 2);

  const cancelled = await changeStatus(repo, OWNER, reference, 'cancel', { reason: 'Avbokad i test' }, options());
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await repo.listCalendarByReference(reference), []);
});

test('ändrade tillval uppdaterar bara de buffertnätter som behövs', async () => {
  const repo = createDemoRepository({ now: NOW });
  const reference = await create(repo, {
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: true, senUtcheckning: false
    }
  });
  let rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-09', '2027-02-10', '2027-02-11']);

  const changed = await updateAddons(repo, OWNER, reference, {
    reason: 'Gästen byter till sen utcheckning',
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: false, senUtcheckning: true
    }
  }, options());
  assert.equal(changed.status, 200, JSON.stringify(changed.jsonBody));
  rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-10', '2027-02-11', '2027-02-12']);
  assert.equal(rows.filter((row) => row.night === '2027-02-09').length, 0);
  assert.equal(rows.filter((row) => row.night === '2027-02-12' && row.kind === 'BUFFER').length, 1);

  const both = await updateAddons(repo, OWNER, reference, {
    reason: 'Gästen vill ha båda tillvalen',
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: true, senUtcheckning: true
    }
  }, options());
  assert.equal(both.status, 200, JSON.stringify(both.jsonBody));
  rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12']);

  const none = await updateAddons(repo, OWNER, reference, {
    reason: 'Gästen tar bort tillvalen',
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: false, senUtcheckning: false
    }
  }, options());
  assert.equal(none.status, 200, JSON.stringify(none.jsonBody));
  rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-10', '2027-02-11']);
});

test('ändring nekas när den nya buffertnatten är upptagen i interna kalendern', async () => {
  const repo = createDemoRepository({ now: NOW });
  const reference = await create(repo, {
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: false, senUtcheckning: false
    }
  });
  await repo.createCalendarNight('2027-02-09', {
    type: 'BOOKING', kind: 'STAY', reference: 'SK-OTHER', source: 'WEB'
  });
  const result = await updateAddons(repo, OWNER, reference, {
    reason: 'Försök lägga till tidig incheckning',
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: true, senUtcheckning: false
    }
  }, options());
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'BUFFER_UNAVAILABLE');
  const rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-10', '2027-02-11']);
});

test('äldre bokning utan automatik får inga buffertar vid tillvalsändring', async () => {
  const repo = createDemoRepository({ now: NOW });
  const reference = await create(repo, {
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: false, senUtcheckning: false
    }
  });
  const raw = await repo.getRawBooking(reference);
  await repo.updateRequest({
    ...raw.record,
    bufferNightsMode: 'manual',
    bufferNights: [],
    addons: { ...raw.record.addons, tidigIncheckning: true, senUtcheckning: true }
  }, { ifMatch: raw.etag });

  const result = await updateAddons(repo, OWNER, reference, {
    reason: 'Testar äldre bokning',
    addons: {
      slutstad: false, lakan: false, linenCount: 0, ved: false,
      tidigIncheckning: true, senUtcheckning: true
    }
  }, options());
  assert.equal(result.status, 200, JSON.stringify(result.jsonBody));
  const rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-10', '2027-02-11']);
  const updated = await repo.getRawBooking(reference);
  assert.equal(updated.record.bufferNightsMode, 'manual');
  assert.deepEqual(updated.record.bufferNights, []);
});
test('Owner kan aktivera automatiska buffertar först efter uttrycklig konfliktkontroll', async () => {
  const repo = createDemoRepository({ now: NOW });
  const reference = await create(repo);
  const raw = await repo.getRawBooking(reference);
  await repo.updateRequest({
    ...raw.record,
    bufferNightsMode: 'manual',
    bufferNights: []
  }, { ifMatch: raw.etag });

  const addons = {
    slutstad: false, lakan: false, linenCount: 0, ved: false,
    tidigIncheckning: true, senUtcheckning: true
  };
  const airbnbBlocked = options({
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2027-02-09', '2027-02-12'] } })
  });

  const flagged = await updateAddons(repo, OWNER, reference, {
    reason: 'Aktivera automatiska buffertar',
    addons,
    enableAutomaticBufferNights: true
  }, airbnbBlocked);
  assert.equal(flagged.status, 409);
  assert.equal(flagged.jsonBody.code, 'AIRBNB_CONFLICT');
  assert.equal(flagged.jsonBody.requiresOverrideOption, true);
  assert.deepEqual(
    (await repo.listCalendarByReference(reference)).map((row) => row.night).sort(),
    ['2027-02-10', '2027-02-11']
  );

  const confirmed = await updateAddons(repo, OWNER, reference, {
    reason: 'Egen manuell blockering i Airbnb',
    addons,
    enableAutomaticBufferNights: true,
    airbnbOverrideIntent: true,
    airbnbOverride: true,
    airbnbOverrideConfirmed: true,
    airbnbOverrideReason: 'Datumet är blockerat av oss själva i Airbnb.'
  }, airbnbBlocked);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.jsonBody));
  assert.equal(confirmed.jsonBody.bufferNightsMode, 'auto');
  const rows = await repo.listCalendarByReference(reference);
  assert.deepEqual(rows.map((row) => row.night).sort(), ['2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12']);
});
