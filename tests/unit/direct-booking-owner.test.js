'use strict';

// Tester för automatisk direktbokning och Owner-inställningen. Inga riktiga
// Azure- eller Stripe-anrop görs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  setAutomaticDirectBooking,
  directBookingOverview
} = require('../../server/admin/direct-booking-service');
const { checkDirectBookingAvailability } = require('../../server/booking/direct-booking');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const OWNER = { id: 'owner-1', name: 'Owner Test', email: 'owner@example.com', roles: ['Owner'] };
const STAFF = { id: 'staff-1', name: 'Staff Test', email: 'staff@example.com', roles: ['Staff'] };
const FROM = '2026-12-01';
const TO = '2026-12-04';
const NIGHTS = ['2026-12-01', '2026-12-02', '2026-12-03'];

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
    async listCalendar() {
      return [];
    },
    async listCalendarByReference() {
      return [];
    },
    async listBlockingBookings(arrival, departure) {
      return bookings
        .filter((booking) =>
          (booking.statusCode === 'CONFIRMED' || booking.statusCode === 'BLOCKED') &&
          booking.arrival < departure && booking.departure > arrival
        )
        .map(clone);
    },
    async getByReference() {
      return null;
    },
    async listDirectBookingNights(from, to) {
      return [...directBooking.values()]
        .filter((row) => row.night >= from && row.night < to)
        .map(clone);
    },
    async listDirectBookingApprovals() {
      const groups = new Map();
      for (const row of directBooking.values()) {
        if (!row.approvalId) continue;
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
    async getDirectBookingSetting() {
      const row = directBooking.get('__setting__');
      if (!row) return null;
      return {
        enabled: row.enabled === '1' || row.enabled === true,
        updatedBy: row.updatedBy ?? '',
        updatedAt: row.updatedAt ?? '',
        note: row.note ?? '',
        etag: row.etag ?? ''
      };
    },
    async setDirectBookingSetting(data) {
      const existing = directBooking.get('__setting__');
      directBooking.set('__setting__', {
        night: '__setting__',
        enabled: data.enabled ? '1' : '0',
        updatedBy: data.updatedBy ?? '',
        updatedAt: data.updatedAt ?? new Date().toISOString(),
        note: data.note ?? '',
        etag: existing ? 'db-setting-2' : 'db-setting-1'
      });
    },
    async appendHistory(entry) {
      history.push(clone(entry));
    }
  };
}

function options(overrides = {}) {
  return {
    now: NOW,
    directBookingEnabled: true,
    stripeEnabled: true,
    cardEnabled: true,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } }),
    ...overrides
  };
}

test('automatisk direktbokning är på som standard', async () => {
  const repository = createMemoryRepository();
  const availability = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options()
  );
  assert.equal(availability.directBooking, true);
  assert.deepEqual(availability.nights, NIGHTS);
});

test('Owner kan stänga av automatisk direktbokning', async () => {
  const repository = createMemoryRepository();
  const result = await setAutomaticDirectBooking(
    repository,
    OWNER,
    { enabled: false, note: 'Kalenderproblem' },
    options()
  );
  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.enabled, false);
  const setting = await repository.getDirectBookingSetting();
  assert.equal(setting.enabled, false);
  assert.equal(setting.updatedBy, 'Owner Test');
  assert.equal(repository.history.at(-1).action, 'DIRECT_BOOKING_AUTOMATIC_DISABLED');

  const availability = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options()
  );
  assert.equal(availability.directBooking, false);
  assert.equal(availability.code, 'AUTO_DIRECT_BOOKING_DISABLED');
});

test('Owner kan slå på automatisk direktbokning igen', async () => {
  const repository = createMemoryRepository();
  await setAutomaticDirectBooking(repository, OWNER, { enabled: false }, options());
  const result = await setAutomaticDirectBooking(
    repository,
    OWNER,
    { enabled: true, note: 'Kalendern fungerar' },
    options()
  );
  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.enabled, true);
  assert.equal(repository.history.at(-1).action, 'DIRECT_BOOKING_AUTOMATIC_ENABLED');
});

test('Staff får inte ändra automatisk direktbokning', async () => {
  const repository = createMemoryRepository();
  const result = await setAutomaticDirectBooking(
    repository,
    STAFF,
    { enabled: false },
    options()
  );
  assert.equal(result.status, 403);
  assert.equal(repository.history.length, 0);
});

test('Airbnb-upptagna nätter nekar automatisk direktbokning', async () => {
  const repository = createMemoryRepository();
  const availability = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options({
      availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: ['2026-12-02'] } })
    })
  );
  assert.equal(availability.directBooking, false);
  assert.equal(availability.code, 'AIRBNB_CONFLICT');
  assert.deepEqual(availability.nights, ['2026-12-02']);
});

test('saknad iCal nekar automatisk direktbokning', async () => {
  const repository = createMemoryRepository();
  const availability = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options({ availabilityHandler: async () => ({ status: 503, jsonBody: { error: 'nere' } }) })
  );
  assert.equal(availability.directBooking, false);
  assert.equal(availability.code, 'AIRBNB_UNAVAILABLE');
});

test('intern bokning nekar automatisk direktbokning', async () => {
  const repository = createMemoryRepository();
  repository.bookings.push({
    reference: 'SK-INTERNAL',
    arrival: '2026-12-02',
    departure: '2026-12-03',
    statusCode: 'CONFIRMED',
    bookingSource: 'MANUAL'
  });
  const availability = await checkDirectBookingAvailability(
    repository,
    FROM,
    TO,
    NOW,
    options()
  );
  assert.equal(availability.directBooking, false);
  assert.equal(availability.code, 'INTERNAL_CONFLICT');
});

test('översikten visar automatisk status, reservationer, bekräftade och avstämning', async () => {
  const repository = createMemoryRepository();
  await setAutomaticDirectBooking(repository, OWNER, { enabled: true }, options());
  repository.bookings.push(
    { reference: 'SK-RES', arrival: FROM, departure: TO, statusCode: 'PENDING_PAYMENT', bookingSource: 'DIRECT' },
    { reference: 'SK-CONF', arrival: FROM, departure: TO, statusCode: 'CONFIRMED', bookingSource: 'DIRECT' },
    { reference: 'SK-REC', arrival: FROM, departure: TO, statusCode: 'RECONCILIATION', bookingSource: 'DIRECT' }
  );
  const overview = await directBookingOverview(repository, NOW);
  assert.equal(overview.automaticEnabled, true);
  assert.equal(overview.reservations.length, 1);
  assert.equal(overview.confirmed.length, 1);
  assert.equal(overview.reconciliation.length, 1);
});
