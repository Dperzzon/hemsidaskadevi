'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  handleAvailability,
  fetchCalendar,
  CalendarFetchError
} = require('../../server/calendar/availability');
const {
  handleCalendarExport,
  buildCalendar,
  collectNights
} = require('../../server/calendar/export');
const {
  recordCalendarStatus,
  syncStatusLevel,
  resetStatusThrottle
} = require('../../server/calendar/sync-status');
const { createCalendarMonitor } = require('../../server/calendar/monitor');
const { evaluateCalendarSafety, CODES } = require('../../server/calendar/safety');

const SOURCE = 'https://calendar.example.test/synthetic.ics';
const TOKEN = 'synthetic-calendar-token-0123456789abcdef';
const calendar = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Test//EN',
  ...lines, 'END:VCALENDAR', ''
].join('\r\n');
const event = (...lines) => ['BEGIN:VEVENT', 'UID:synthetic-event', ...lines, 'END:VEVENT'];
const range = (start = '2026-12-01', end = '2027-02-01') =>
  ({ query: new URLSearchParams({ start, end }) });
const context = () => ({ messages: [], warn(message) { this.messages.push(message); } });

function memoryStatusStore() {
  let status = null;
  return {
    async getCalendarSyncStatus() { return status; },
    async saveCalendarSyncStatus(data) { status = { ...data }; },
    write(data) { status = { ...data }; },
    read() { return status; }
  };
}

test('hämtar alltid färskt och skickar no-store samt accepterar giltig kalender', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(calendar(...event('DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20270101')), {
      status: 200, headers: { 'Content-Type': 'text/calendar' }
    });
  };
  const text = await fetchCalendar(SOURCE, fetchImpl);
  assert.match(text, /BEGIN:VCALENDAR/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, 'no-store');
  assert.match(calls[0].options.headers['Cache-Control'], /no-store/);
});

test('begränsade återförsök vid 5xx men inte vid 404', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('nere', { status: 503 })
      : new Response(calendar(), { status: 200, headers: { 'Content-Type': 'text/calendar' } });
  };
  assert.match(await fetchCalendar(SOURCE, flaky), /BEGIN:VCALENDAR/);
  assert.equal(attempts, 2);

  let notFoundCalls = 0;
  const notFound = async () => {
    notFoundCalls += 1;
    return new Response('nej', { status: 404 });
  };
  await assert.rejects(
    fetchCalendar(SOURCE, notFound, { maxAttempts: 2, retryDelayMs: 1 }),
    (error) => error instanceof CalendarFetchError && error.code === 'HTTP_404'
  );
  assert.equal(notFoundCalls, 1);
});

test('felaktigt filformat och HTML-svar nekas som osäker tillgänglighet', async () => {
  const html = async () => new Response('<html>fel</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  });
  const result = await handleAvailability(range(), context(), {
    calendarUrl: SOURCE,
    fetchImpl: html,
    fetchMaxAttempts: 1
  });
  assert.equal(result.status, 503);
  assert.equal(result.jsonBody.blocked, undefined);
});

test('sparar senaste lyckade hämtning och fel utan hemlig adress', async () => {
  resetStatusThrottle();
  const store = memoryStatusStore();
  const ok = await handleAvailability(range(), context(), {
    calendarUrl: SOURCE,
    calendarStatusStore: store,
    forceStatusWrite: true,
    statusSource: 'test',
    fetchImpl: async () => new Response(calendar(), {
      status: 200, headers: { 'Content-Type': 'text/calendar' }
    })
  });
  assert.equal(ok.status, 200);
  const success = store.read();
  assert.equal(success.lastErrorCode, '');
  assert.ok(success.lastSuccessAt);
  assert.equal(success.consecutiveFailures, 0);

  const failure = await handleAvailability(range(), context(), {
    calendarUrl: SOURCE,
    calendarStatusStore: store,
    forceStatusWrite: true,
    statusSource: 'test',
    fetchImpl: async () => new Response('nere', { status: 503 }),
    fetchMaxAttempts: 1
  });
  assert.equal(failure.status, 503);
  const failed = store.read();
  assert.equal(failed.lastErrorCode, 'HTTP_503');
  assert.ok(failed.lastSuccessAt);
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(syncStatusLevel(failed), 'warning');
  assert.doesNotMatch(JSON.stringify(failed), /calendar\.example\.test/);

  await recordCalendarStatus(store, { ok: false, errorCode: 'FETCH_FAILED', source: 'test' }, new Date(), { force: true });
  await recordCalendarStatus(store, { ok: false, errorCode: 'FETCH_FAILED', source: 'test' }, new Date(), { force: true });
  await recordCalendarStatus(store, { ok: false, errorCode: 'FETCH_FAILED', source: 'test' }, new Date(), { force: true });
  assert.equal(syncStatusLevel(store.read()), 'error');
});

test('exporten kräver hemlig token och läcker ingen kundinformation', async () => {
  const rows = [
    { night: '2026-12-20', resource: 'main', type: 'BOOKING', reference: 'SK-SECRET-1', source: 'DIRECT' },
    { night: '2026-12-21', resource: 'main', type: 'BOOKING', reference: 'SK-SECRET-1', source: 'DIRECT' },
    { night: '2026-12-24', resource: 'main', type: 'MANUAL', reference: 'BLOCK-1', source: 'MANUAL' },
    { night: '2026-12-25', resource: 'main', type: 'BLOCKING', reference: 'AIRBNB-X', source: 'AIRBNB' },
    { night: '2026-12-26', resource: 'extrahus', type: 'BOOKING', reference: 'SK-EXTRA', source: 'DIRECT' }
  ];
  const store = {
    async listCalendar() { return rows; },
    async listBlockingBookings() { return []; }
  };
  const options = {
    exportToken: TOKEN,
    store,
    now: new Date('2026-12-01T12:00:00Z')
  };
  const denied = await handleCalendarExport({ token: 'fel-token-0123456789abcdef' }, {}, options);
  assert.equal(denied.status, 404);

  const result = await handleCalendarExport({ token: TOKEN }, {}, options);
  assert.equal(result.status, 200);
  assert.match(result.headers['Content-Type'], /^text\/calendar/);
  assert.match(result.body, /BEGIN:VCALENDAR/);
  assert.match(result.body, /SUMMARY:Upptaget/);
  assert.match(result.body, /DTSTART;VALUE=DATE:20261220/);
  assert.match(result.body, /DTEND;VALUE=DATE:20261222/);
  assert.match(result.body, /DTSTART;VALUE=DATE:20261224/);
  assert.doesNotMatch(result.body, /SK-SECRET|BLOCK-1|AIRBNB-X|SK-EXTRA/);
  assert.doesNotMatch(result.body, /DTSTART;VALUE=DATE:20261225/);
  assert.doesNotMatch(result.body, /DTSTART;VALUE=DATE:20261226/);
});

test('exporten slår ihop intilliggande nätter och hoppar över Airbnb-importer', () => {
  const rows = [
    { night: '2026-12-20', type: 'BOOKING', reference: 'A', source: 'DIRECT' },
    { night: '2026-12-21', type: 'BOOKING', reference: 'A', source: 'DIRECT' },
    { night: '2026-12-22', type: 'BOOKING', reference: 'B', source: 'DIRECT' },
    { night: '2026-12-23', type: 'BOOKING', reference: 'A', source: 'AIRBNB' }
  ];
  const nights = collectNights(rows, []);
  const result = buildCalendar({ rows, blockingBookings: [], now: new Date('2026-12-01T12:00:00Z') });
  assert.equal(nights.length, 3);
  assert.equal((result.body.match(/BEGIN:VEVENT/g) || []).length, 2);

  const loops = buildCalendar({
    rows: [{ night: '2026-12-25', type: 'BOOKING', reference: 'A', source: 'AIRBNB' }],
    blockingBookings: [],
    now: new Date('2026-12-01T12:00:00Z')
  });
  assert.doesNotMatch(loops.body, /20261225/);
});

test('kalendersäkerheten stoppar tom kalender men tillåter enstaka legitima avbokningar', () => {
  const base = {
    eventCount: 10,
    fingerprint: 'baseline',
    snapshotFrom: '2026-11-01',
    snapshotTo: '2027-01-01',
    snapshotNights: ['2026-11-20', '2026-11-21', '2026-11-22']
  };
  const empty = evaluateCalendarSafety({
    previous: base,
    current: { eventCount: 0, fingerprint: 'empty', blockedCount: 0 },
    from: '2026-11-20',
    to: '2026-11-23'
  });
  assert.equal(empty.status, 'suspect');
  assert.equal(empty.code, CODES.EMPTY);

  const largeDrop = evaluateCalendarSafety({
    previous: base,
    current: { eventCount: 5, fingerprint: 'five', blockedCount: 3 },
    from: '2026-11-20',
    to: '2026-11-23'
  });
  assert.equal(largeDrop.status, 'suspect');
  assert.equal(largeDrop.code, CODES.DROP);

  const legitCancellation = evaluateCalendarSafety({
    previous: base,
    current: { eventCount: 9, fingerprint: 'nine', blockedCount: 2 },
    from: '2026-11-20',
    to: '2026-11-23'
  });
  assert.equal(legitCancellation.status, 'ok');

  const rangeEmpty = evaluateCalendarSafety({
    previous: base,
    current: { eventCount: 10, fingerprint: 'changed', blockedCount: 0 },
    from: '2026-11-20',
    to: '2026-11-23'
  });
  assert.equal(rangeEmpty.status, 'suspect');
  assert.equal(rangeEmpty.code, CODES.RANGE_EMPTY);
});

test('misstänkt kalender återgår automatiskt först när den inte är sämre än baslinjen', () => {
  const base = {
    eventCount: 10,
    fingerprint: 'baseline',
    safetyStatus: 'suspect',
    safetyReason: CODES.EMPTY,
    snapshotFrom: '2026-11-01',
    snapshotTo: '2027-01-01',
    snapshotNights: ['2026-11-20', '2026-11-21', '2026-11-22']
  };
  const recovered = evaluateCalendarSafety({
    previous: base,
    current: { eventCount: 10, fingerprint: 'baseline', blockedCount: 3 },
    from: '2026-11-20',
    to: '2026-11-23'
  });
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.recovered, true);

  const stillBad = evaluateCalendarSafety({
    previous: base,
    current: { eventCount: 9, fingerprint: 'lower', blockedCount: 2 },
    from: '2026-11-20',
    to: '2026-11-23'
  });
  assert.equal(stillBad.status, 'suspect');
});

test('gammal eller inkonsekvent HTTP-metadata stoppar direktbokning', () => {
  const previous = {
    eventCount: 4,
    fingerprint: 'fp-1',
    lastModified: 'Tue, 01 Dec 2026 12:00:00 GMT',
    calendarEtag: '"etag-1"'
  };
  const stale = evaluateCalendarSafety({
    previous,
    current: { eventCount: 4, fingerprint: 'fp-1', lastModified: 'Mon, 30 Nov 2026 12:00:00 GMT', etag: '"etag-1"' },
    from: '2026-12-01',
    to: '2026-12-03'
  });
  assert.equal(stale.code, CODES.STALE);

  const inconsistent = evaluateCalendarSafety({
    previous,
    current: { eventCount: 4, fingerprint: 'fp-2', lastModified: 'Tue, 01 Dec 2026 12:00:00 GMT', etag: '"etag-1"' },
    from: '2026-12-01',
    to: '2026-12-03',
    now: new Date('2026-12-01T13:00:00Z')
  });
  assert.equal(inconsistent.code, CODES.INCONSISTENT);
});

test('första tomma kalendern accepteras men nästa tomma stoppas mot känd baslinje', async () => {
  const store = memoryStatusStore();
  const emptyFetch = async () => new Response(calendar(), {
    status: 200, headers: { 'Content-Type': 'text/calendar' }
  });
  const first = await handleAvailability(range(), context(), {
    calendarUrl: SOURCE,
    calendarStatusStore: store,
    forceStatusWrite: true,
    statusSource: 'test',
    fetchImpl: emptyFetch
  });
  assert.equal(first.status, 200);
  assert.equal(store.read().eventCount, 0);

  store.write({
    ...store.read(),
    eventCount: 10,
    fingerprint: 'known',
    snapshotFrom: '2026-12-01',
    snapshotTo: '2027-02-01',
    snapshotNights: ['2026-12-01', '2026-12-02', '2026-12-03']
  });
  const second = await handleAvailability(range('2026-12-01', '2026-12-05'), context(), {
    calendarUrl: SOURCE,
    calendarStatusStore: store,
    forceStatusWrite: true,
    statusSource: 'test',
    fetchImpl: emptyFetch
  });
  assert.equal(second.status, 503);
  assert.equal(second.jsonBody.code, CODES.EMPTY);
  assert.equal(store.read().safetyStatus, 'suspect');
});

test('exporten hoppar över utgången reservation men behåller bekräftad bokning', async () => {
  const rows = [
    { night: '2026-12-10', resource: 'main', type: 'RESERVATION', reference: 'SK-STALE', source: 'DIRECT' },
    { night: '2026-12-11', resource: 'main', type: 'RESERVATION', reference: 'SK-STALE', source: 'DIRECT' },
    { night: '2026-12-12', resource: 'main', type: 'BOOKING', reference: 'SK-OK', source: 'DIRECT' }
  ];
  const store = {
    async listCalendar() { return rows; },
    async listBlockingBookings() { return []; },
    async getByReference(reference) {
      if (reference === 'SK-OK') return { record: { statusCode: 'CONFIRMED' } };
      return { record: { statusCode: 'EXPIRED', reservation: { status: 'RELEASED' } } };
    }
  };
  const result = await handleCalendarExport({ token: TOKEN }, {}, {
    exportToken: TOKEN,
    store,
    now: new Date('2026-12-01T12:00:00Z')
  });
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.body, /DTSTART;VALUE=DATE:20261210/);
  assert.doesNotMatch(result.body, /DTSTART;VALUE=DATE:20261211/);
  assert.match(result.body, /DTSTART;VALUE=DATE:20261212/);
});

test('exporten hoppar över kvarvarande rad för avbokad bokning', async () => {
  const rows = [
    { night: '2026-12-20', resource: 'main', type: 'BOOKING', reference: 'SK-CANCELLED', source: 'DIRECT' },
    { night: '2026-12-21', resource: 'main', type: 'BOOKING', reference: 'SK-OK', source: 'DIRECT' }
  ];
  const store = {
    async listCalendar() { return rows; },
    async listBlockingBookings() { return []; },
    async getByReference(reference) {
      return {
        record: {
          statusCode: reference === 'SK-CANCELLED' ? 'CANCELLED' : 'CONFIRMED'
        }
      };
    }
  };
  const result = await handleCalendarExport({ token: TOKEN }, {}, {
    exportToken: TOKEN,
    store,
    now: new Date('2026-12-01T12:00:00Z')
  });
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.body, /DTSTART;VALUE=DATE:20261220/);
  assert.match(result.body, /DTSTART;VALUE=DATE:20261221/);
});

test('övervakningen upptäcker konflikt mellan Airbnb-blockering och intern bokning', async () => {
  const store = {
    async listCalendar() {
      return [{ night: '2026-12-21', resource: 'main', type: 'BOOKING', reference: 'SK-1', source: 'DIRECT' }];
    }
  };
  const monitor = createCalendarMonitor({
    intervalMinutes: 0,
    store,
    now: () => new Date('2026-12-01T12:00:00Z'),
    availability: {
      calendarUrl: SOURCE,
      fetchImpl: async () => new Response(
        calendar(...event('DTSTART;VALUE=DATE:20261221', 'DTEND;VALUE=DATE:20261222')),
        { status: 200, headers: { 'Content-Type': 'text/calendar' } }
      )
    }
  });
  const result = await monitor.checkNow();
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, ['2026-12-21']);
  monitor.stop();
});
