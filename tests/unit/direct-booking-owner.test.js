'use strict';

// Tester för Owner-styrd öppning/stängning av datum för direktbokning samt
// den publika tillgänglighetskontrollen. Inga riktiga Azure- eller Stripe-
// anrop görs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  openDirectBooking,
  closeDirectBooking,
  directBookingOverview
} = require('../../server/admin/direct-booking-service');
const { checkDirectBookingAvailability } = require('../../server/booking/direct-booking');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const OWNER = { id: 'owner-1', name: 'Owner Test', email: 'owner@example.com', roles: ['Owner'] };
const STAFF = { id: 'staff-1', name: 'Staff Test', email: 'staff@example.com', roles: ['Staff'] };
const NIGHTS = ['2026-12-01', '2026-12-02', '2026-12-03'];
const FROM = '2026-12-01';
const TO = '2026-12-04';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryRepository() {
  const bookings = [];
  const directBooking = new Map();
  const history = [];
  return {
    type: 'memory',
    bookings,
    directBooking,
    history,
    async allBookings() {
      return bookings.map(clone);
    },
    async listDirectBookingNights(from, to) {
      return [...directBooking.values()]
        .filter((row) => row.night >= from && row.night < to)
        .map(clone);
    },
    async getDirectBookingNight(night) {
      return directBooking.get(night) ? clone(directBooking.get(night)) : null;
    },
    async upsertDirectBookingNight(night, data) {
      directBooking.set(night, { ...clone(data), night });
    },
    async deleteDirectBookingNight(night) {
      directBooking.delete(night);
    },
    async listDirectBookingNightsByApproval(approvalId) {
      return [...directBooking.values()]
        .filter((row) => row.approvalId === approvalId)
        .map(clone);
    },
    async listDirectBookingApprovals() {
      const groups = new Map();
      for (const row of directBooking.values()) {
        if (!groups.has(row.approvalId)) {
          groups.set(row.approvalId, {
            approvalId: row.approvalId,
            from: row.from,
            to: row.to,
            nights: [],
            approvedBy: row.approvedBy,
            approvedAt: row.approvedAt,
            note: row.note,
            status: row.status,
            closedBy: row.closedBy,
            closedAt: row.closedAt
          });
        }
        const group = groups.get(row.approvalId);
        group.nights.push(row.night);
        if (row.status === 'OPEN') group.status = 'OPEN';
      }
      return [...groups.values()].map((group) => ({ ...group, nights: group.nights.sort() }));
    },
    async appendHistory(entry) {
      history.push(clone(entry));
    },
    async listCalendar() {
      return [];
    },
    async listCalendarByReference() {
      return [];
    },
    async listBlockingBookings() {
      return [];
    },
    async getByReference() {
      return null;
    }
  };
}

function confirmations(overrides = {}) {
  return {
    confirmAirbnbBlocked: true,
    confirmNoAirbnbGuest: true,
    confirmNoExternal: true,
    confirmMayOffer: true,
    ...overrides
  };
}

function options(overrides = {}) {
  return {
    now: NOW,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: NIGHTS } }),
    ...overrides
  };
}

test('Owner kan öppna ett datumintervall när alla villkor är uppfyllda', async () => {
  const repository = createMemoryRepository();
  const result = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, note: 'Airbnb blockerat', ...confirmations() },
    options()
  );
  assert.equal(result.status, 201);
  assert.ok(result.jsonBody.approvalId.startsWith('DB-'));
  assert.deepEqual(result.jsonBody.nights, NIGHTS);
  assert.equal(repository.directBooking.size, 3);
  for (const row of repository.directBooking.values()) {
    assert.equal(row.status, 'OPEN');
    assert.equal(row.approvedBy, 'Owner Test');
    assert.equal(row.approvedById, 'owner-1');
    assert.equal(row.approvalId, result.jsonBody.approvalId);
    assert.deepEqual(JSON.parse(row.airbnbBlockedNights), NIGHTS);
  }
  assert.equal(repository.history.length, 1);
  assert.equal(repository.history[0].action, 'DIRECT_BOOKING_OPENED');
  assert.equal(repository.history[0].actorName, 'Owner Test');
});

test('öppning kräver alla fyra bekräftelser', async () => {
  const repository = createMemoryRepository();
  const result = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, ...confirmations({ confirmNoExternal: false }) },
    options()
  );
  assert.equal(result.status, 400);
  assert.equal(result.jsonBody.code, 'CONFIRMATIONS_REQUIRED');
  assert.equal(repository.directBooking.size, 0);
});

test('öppning stoppas om Airbnb-kalendern inte kan läsas', async () => {
  const repository = createMemoryRepository();
  const result = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, ...confirmations() },
    options({ availabilityHandler: async () => ({ status: 503, jsonBody: { error: 'nere' } }) })
  );
  assert.equal(result.status, 503);
  assert.equal(result.jsonBody.code, 'AIRBNB_UNAVAILABLE');
  assert.equal(repository.directBooking.size, 0);
});

test('öppning stoppas om Airbnb iCal inte visar alla nätter som blockerade', async () => {
  const repository = createMemoryRepository();
  const result = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, ...confirmations() },
    options({ availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-12-01'] } }) })
  );
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'AIRBNB_NOT_BLOCKED');
  assert.equal(repository.directBooking.size, 0);
});

test('öppning stoppas vid intern bokning, blockering eller aktiv reservation', async () => {
  const repository = createMemoryRepository();
  repository.bookings.push({
    reference: 'SK-INTERNAL',
    arrival: '2026-12-02',
    departure: '2026-12-03',
    statusCode: 'CONFIRMED',
    bookingSource: 'MANUAL'
  });
  const result = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, ...confirmations() },
    options()
  );
  assert.equal(result.status, 409);
  assert.equal(result.jsonBody.code, 'INTERNAL_CONFLICT');
  assert.equal(repository.directBooking.size, 0);
});

test('Staff får inte öppna eller stänga direktbokning', async () => {
  const repository = createMemoryRepository();
  const open = await openDirectBooking(
    repository,
    STAFF,
    { from: FROM, to: TO, ...confirmations() },
    options()
  );
  assert.equal(open.status, 403);
  const close = await closeDirectBooking(repository, STAFF, { approvalId: 'DB-X' }, options());
  assert.equal(close.status, 403);
});

test('publik tillgänglighet är endast true för öppnade datum med matchande iCal-underlag', async () => {
  const repository = createMemoryRepository();
  const opened = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, ...confirmations() },
    options()
  );
  assert.equal(opened.status, 201);

  const available = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options({ directBookingEnabled: true, stripeEnabled: true, cardEnabled: true })
  );
  assert.equal(available.directBooking, true);
  assert.deepEqual(available.nights, NIGHTS);
});

test('publik tillgänglighet är false för datum som inte öppnats', async () => {
  const repository = createMemoryRepository();
  const available = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options({ directBookingEnabled: true, stripeEnabled: true, cardEnabled: true })
  );
  assert.equal(available.directBooking, false);
  assert.equal(available.code, 'DIRECT_BOOKING_NOT_OPEN');
});

test('publik tillgänglighet är false om en öppnad natt inte längre är blockerad i Airbnb', async () => {
  const repository = createMemoryRepository();
  await openDirectBooking(repository, OWNER, { from: FROM, to: TO, ...confirmations() }, options());
  const available = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options({
      directBookingEnabled: true,
      stripeEnabled: true,
      cardEnabled: true,
      availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-12-01', '2026-12-02'] } })
    })
  );
  assert.equal(available.directBooking, false);
  assert.equal(available.code, 'AIRBNB_BLOCK_MISSING');
});

test('publik tillgänglighet är false om Owners iCal-underlag saknas', async () => {
  const repository = createMemoryRepository();
  await openDirectBooking(repository, OWNER, { from: FROM, to: TO, ...confirmations() }, options());
  for (const row of repository.directBooking.values()) {
    row.airbnbBlockedNights = '[]';
  }
  const available = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options({ directBookingEnabled: true, stripeEnabled: true, cardEnabled: true })
  );
  assert.equal(available.directBooking, false);
  assert.equal(available.code, 'AIRBNB_SNAPSHOT_MISSING');
});

test('stängning markerar datumen stängda utan att röra bokningar eller reservationer', async () => {
  const repository = createMemoryRepository();
  const opened = await openDirectBooking(
    repository,
    OWNER,
    { from: FROM, to: TO, ...confirmations() },
    options()
  );
  repository.bookings.push({
    reference: 'SK-CONFIRMED',
    arrival: FROM,
    departure: TO,
    statusCode: 'CONFIRMED',
    bookingSource: 'DIRECT'
  });
  const closed = await closeDirectBooking(
    repository,
    OWNER,
    { approvalId: opened.jsonBody.approvalId, note: 'Stänger framtida datum' },
    options()
  );
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.jsonBody.closed, NIGHTS);
  for (const row of repository.directBooking.values()) {
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.closedBy, 'Owner Test');
  }
  assert.equal(repository.bookings.length, 1);
  assert.equal(repository.bookings[0].statusCode, 'CONFIRMED');
  assert.equal(repository.history.at(-1).action, 'DIRECT_BOOKING_CLOSED');
});

test('översikten visar godkännanden, reservationer, bekräftade och avstämning', async () => {
  const repository = createMemoryRepository();
  await openDirectBooking(repository, OWNER, { from: FROM, to: TO, ...confirmations() }, options());
  repository.bookings.push(
    { reference: 'SK-RES', arrival: FROM, departure: TO, statusCode: 'PENDING_PAYMENT', bookingSource: 'DIRECT' },
    { reference: 'SK-CONF', arrival: FROM, departure: TO, statusCode: 'CONFIRMED', bookingSource: 'DIRECT' },
    { reference: 'SK-REC', arrival: FROM, departure: TO, statusCode: 'RECONCILIATION', bookingSource: 'DIRECT' }
  );
  const overview = await directBookingOverview(repository, NOW);
  assert.equal(overview.approvals.length, 1);
  assert.equal(overview.reservations.length, 1);
  assert.equal(overview.confirmed.length, 1);
  assert.equal(overview.reconciliation.length, 1);
});
