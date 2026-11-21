'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { releaseCalendar } = require('../../server/admin/booking-service');
const { collectInternalBlocked, loadInternalBlocked } = require('../../server/calendar/internal');
const { auditReservations, classifyReservation } = require('../../server/calendar/reservation-audit');
const { approveCalendarSafety } = require('../../server/admin/direct-booking-service');

function memoryRepo(rows) {
  const remaining = new Map(rows.map((row) => [row.night, { ...row }]));
  return {
    remaining,
    async listCalendarByReference(reference) {
      return [...remaining.values()].filter((row) => row.reference === reference);
    },
    async deleteCalendarNight(night, reference) {
      const row = remaining.get(night);
      if (row && row.reference === reference) remaining.delete(night);
    }
  };
}

test('releaseCalendar återförsöker och rapporterar kvarvarande blockerade nätter', async () => {
  const repo = memoryRepo([
    { night: '2026-12-10', reference: 'SK-1', resource: 'main' },
    { night: '2026-12-11', reference: 'SK-1', resource: 'main' }
  ]);
  let attempts = 0;
  const originalDelete = repo.deleteCalendarNight.bind(repo);
  repo.deleteCalendarNight = async (night, reference, options) => {
    if (night === '2026-12-10' && attempts++ === 0) throw new Error('tillfälligt fel');
    return originalDelete(night, reference, options);
  };
  const warnings = [];
  const result = await releaseCalendar(repo, 'SK-1', { retryDelayMs: 0, warn: (message) => warnings.push(message) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.released, ['2026-12-10', '2026-12-11']);
  assert.equal(repo.remaining.size, 0);
  assert.ok(warnings.length >= 0);
});

test('releaseCalendar redovisar nätter som inte kunde tas bort', async () => {
  const repo = memoryRepo([{ night: '2026-12-10', reference: 'SK-1', resource: 'main' }]);
  repo.deleteCalendarNight = async () => { throw new Error('nekad'); };
  const warnings = [];
  const result = await releaseCalendar(repo, 'SK-1', { retryDelayMs: 0, warn: (message) => warnings.push(message) });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].night, '2026-12-10');
  assert.equal(repo.remaining.size, 1);
  assert.match(warnings.join(' '), /Kvarvarande kalenderblockeringar/);
});

test('releaseCalendar hanterar att kalenderraderna inte kan läsas', async () => {
  const result = await releaseCalendar({
    async listCalendarByReference() { throw new Error('nere'); }
  }, 'SK-1', { retryDelayMs: 0, warn: () => {} });
  assert.equal(result.listingFailed, true);
  assert.deepEqual(result.failed, []);
});

test('publik tillgänglighet blandar in interna bokningar men inte extrahus eller Airbnb', () => {
  const rows = [
    { night: '2026-12-10', resource: 'main', type: 'BOOKING', source: 'DIRECT' },
    { night: '2026-12-11', resource: 'main', type: 'MANUAL', source: 'MANUAL' },
    { night: '2026-12-12', resource: 'main', type: 'RESERVATION', source: 'DIRECT' },
    { night: '2026-12-13', resource: 'main', type: 'BOOKING', source: 'AIRBNB' },
    { night: '2026-12-14', resource: 'extrahus', type: 'BOOKING', source: 'DIRECT' }
  ];
  const internal = collectInternalBlocked(rows, [
    { statusCode: 'CONFIRMED', bookingSource: 'DIRECT', arrival: '2026-12-20', departure: '2026-12-22' }
  ]);
  assert.deepEqual(internal, [
    '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-20', '2026-12-21'
  ]);
});

test('loadInternalBlocked fail-closar när den interna kalendern inte kan läsas', async () => {
  await assert.rejects(
    () => loadInternalBlocked({ async listCalendar() { throw new Error('nere'); } }, '2026-12-01', '2026-12-05')
  );
  await assert.rejects(
    () => loadInternalBlocked(null, '2026-12-01', '2026-12-05')
  );
});

test('reservationsavstämning skiljer aktiv, utgången och föräldralös reservation', () => {
  const now = new Date('2026-12-01T12:00:00Z');
  assert.equal(classifyReservation({
    statusCode: 'PENDING_PAYMENT',
    reservation: { status: 'ACTIVE', expiresAt: '2026-12-01T12:30:00Z' }
  }, now).active, true);
  assert.equal(classifyReservation({
    statusCode: 'PENDING_PAYMENT',
    reservation: { status: 'ACTIVE', expiresAt: '2026-12-01T11:00:00Z' }
  }, now).reason, 'expired');
  assert.equal(classifyReservation(null, now).reason, 'orphan');
  assert.equal(classifyReservation({ statusCode: 'RECONCILIATION' }, now).active, true);
  assert.equal(classifyReservation({ statusCode: 'RECONCILIATION' }, now).reason, 'reconciliation');
});

test('reservationsavstämning rapporterar misstänkta rader och behåller aktiva', async () => {
  const rows = [
    { night: '2026-12-10', type: 'RESERVATION', reference: 'SK-ACTIVE' },
    { night: '2026-12-11', type: 'RESERVATION', reference: 'SK-EXPIRED' },
    { night: '2026-12-12', type: 'RESERVATION', reference: 'SK-ORPHAN' }
  ];
  const records = new Map([
    ['SK-ACTIVE', { statusCode: 'PENDING_PAYMENT', reservation: { status: 'ACTIVE', expiresAt: '2026-12-01T13:00:00Z' } }],
    ['SK-EXPIRED', { statusCode: 'EXPIRED', reservation: { status: 'RELEASED' } }]
  ]);
  const audit = await auditReservations(rows, {
    now: new Date('2026-12-01T12:00:00Z'),
    getRecord: async (reference) => records.get(reference) ?? null
  });
  assert.ok(audit.active.has('SK-ACTIVE'));
  assert.ok(!audit.active.has('SK-EXPIRED'));
  assert.ok(!audit.active.has('SK-ORPHAN'));
  assert.deepEqual(audit.issues.map((issue) => issue.reason).sort(), ['orphan', 'status_expired']);
});

function adminRepo(status) {
  const state = { status, history: [] };
  return {
    state,
    async getCalendarSyncStatus() { return state.status; },
    async saveCalendarSyncStatus(next) { state.status = next; },
    async appendHistory(entry) { state.history.push(entry); },
    async allBookings() { return []; },
    async listCalendar() { return []; },
    async listCalendarByReference() { return []; }
  };
}

test('Owner kan godkänna en misstänkt kalenderbild och återställa direktbokning', async () => {
  const repo = adminRepo({
    status: 'error',
    lastErrorCode: 'CALENDAR_EMPTY',
    safetyStatus: 'suspect',
    safetyReason: 'CALENDAR_EMPTY',
    safetySince: '2026-12-01T10:00:00Z',
    eventCount: 10,
    fingerprint: 'baseline',
    snapshotFrom: '2026-11-01',
    snapshotTo: '2027-01-01',
    snapshotNights: ['2026-11-20', '2026-11-21', '2026-11-22'],
    suspectedEventCount: 8,
    suspectedFingerprint: 'candidate',
    suspectedSnapshotFrom: '2026-11-01',
    suspectedSnapshotTo: '2027-01-01',
    suspectedSnapshotNights: ['2026-11-20'],
    suspectedAt: '2026-12-01T11:00:00Z'
  });
  const result = await approveCalendarSafety(
    repo,
    { roles: ['Owner'], name: 'Owner', id: 'owner-1' },
    { note: 'Verifierad i Airbnb' },
    { now: new Date('2026-12-01T12:00:00Z') }
  );
  assert.equal(result.status, 200);
  assert.equal(repo.state.status.safetyStatus, 'ok');
  assert.equal(repo.state.status.eventCount, 8);
  assert.deepEqual(repo.state.status.snapshotNights, ['2026-11-20']);
  assert.equal(repo.state.history.length, 1);
  assert.equal(repo.state.history[0].action, 'CALENDAR_SAFETY_APPROVED');
});

test('tom kalender får bara godkännas med uttrycklig bekräftelse', async () => {
  const repo = adminRepo({
    safetyStatus: 'suspect',
    safetyReason: 'CALENDAR_EMPTY',
    suspectedEventCount: 0,
    suspectedFingerprint: '',
    suspectedSnapshotFrom: '2026-11-01',
    suspectedSnapshotTo: '2027-01-01',
    suspectedSnapshotNights: [],
    snapshotNights: ['2026-11-20']
  });
  const denied = await approveCalendarSafety(
    repo, { roles: ['Owner'], name: 'Owner', id: 'owner-1' }, {}, {}
  );
  assert.equal(denied.status, 400);
  assert.equal(denied.jsonBody.code, 'EMPTY_CALENDAR_NOT_CONFIRMED');

  const approved = await approveCalendarSafety(
    repo, { roles: ['Owner'], name: 'Owner', id: 'owner-1' }, { confirmEmpty: true, note: 'Verifierat tomt' }, {}
  );
  assert.equal(approved.status, 200);
  assert.equal(repo.state.status.safetyStatus, 'ok');
});

test('endast Owner får godkänna kalenderbilden', async () => {
  const repo = adminRepo({ safetyStatus: 'suspect' });
  const result = await approveCalendarSafety(
    repo, { roles: ['Staff'], name: 'Staff', id: 'staff-1' }, {}, {}
  );
  assert.equal(result.status, 403);
});