'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { handleAvailability, fetchCalendar, parseCalendar, MAX_BYTES } = require('../src/availability');

const SOURCE = 'https://calendar.example.test/synthetic.ics';
const calendar = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Test//EN',
  ...lines, 'END:VCALENDAR', ''
].join('\r\n');
const event = (...lines) => ['BEGIN:VEVENT', 'UID:synthetic-event', ...lines, 'END:VEVENT'];
const range = (start = '2026-12-01', end = '2027-02-01') =>
  ({ query: new URLSearchParams({ start, end }) });
const context = () => ({ messages: [], warn(message) { this.messages.push(message); } });
const success = (text) => async () => new Response(text, {
  status: 200, headers: { 'Content-Type': 'text/calendar' }
});

test('returns only blocked dates with exclusive all-day end across a year boundary', async () => {
  const text = calendar(...event('DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20270102'));
  const result = await handleAvailability(range(), context(), { calendarUrl: SOURCE, fetchImpl: success(text) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.jsonBody, { blocked: ['2026-12-30', '2026-12-31', '2027-01-01'] });
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('a complete empty calendar is a successful empty response', async () => {
  const result = await handleAvailability(range(), context(), {
    calendarUrl: SOURCE, fetchImpl: success(calendar())
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.jsonBody, { blocked: [] });
});

test('a date-only event without an end blocks one day', async () => {
  const text = calendar(...event('DTSTART;VALUE=DATE:20261230'));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2026-12-30']);
});

test('expands recurrence with an exclusion and moved override', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
      'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;VALUE=DATE:20261231'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270101',
    'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-02', '2027-01-10']);
});

test('handles a cancelled recurrence override', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'RRULE:FREQ=DAILY;COUNT=3'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20261231',
    'STATUS:CANCELLED', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-01']);
});

test('includes an override moved into the requested interval', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20270301', 'DTEND;VALUE=DATE:20270302', 'RRULE:FREQ=DAILY;COUNT=3'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270302',
    'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-01-01'), ['2026-12-30']);
});

test('includes an ongoing multiday recurring event at the start of the interval', async () => {
  const text = calendar(...event(
    'DTSTART;VALUE=DATE:20261129', 'DTEND;VALUE=DATE:20261203', 'RRULE:FREQ=WEEKLY;COUNT=2'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2026-12-05'), ['2026-12-01', '2026-12-02']);
});

test('expands additional all-day dates and excludes EXDATE', async () => {
  const text = calendar(...event(
    'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
    'RDATE;VALUE=DATE:20270105,20270106', 'EXDATE;VALUE=DATE:20270106'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2026-12-30', '2027-01-05']);
});

test('combines RRULE with an additional date and a moved RDATE exception', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
      'RRULE:FREQ=DAILY;COUNT=2', 'RDATE;VALUE=DATE:20270105'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270105',
    'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2026-12-31', '2027-01-10']);
});

test('moves an additional date even without an RRULE', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'RDATE;VALUE=DATE:20270105'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270105',
    'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2026-12-30', '2027-01-10']);
});

test('excludes an additional occurrence even when it also has an exception', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
      'RRULE:FREQ=DAILY;COUNT=2', 'RDATE;VALUE=DATE:20270105', 'EXDATE;VALUE=DATE:20270105'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270105',
    'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2026-12-30', '2026-12-31']);
});

test('expands timezone-aware additional dates across a daylight saving transition', async () => {
  const text = calendar(...event(
    'DTSTART;TZID=Europe/Stockholm:20260328T230000',
    'DTEND;TZID=Europe/Stockholm:20260329T010000',
    'RDATE;TZID=Europe/Stockholm:20260329T230000'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-03-01', '2026-04-01'),
    ['2026-03-28', '2026-03-29', '2026-03-30']);
});

test('converts additional New York dates across its daylight saving transition', async () => {
  const text = calendar(...event(
    'DTSTART;TZID=America/New_York:20260307T183000',
    'DTEND;TZID=America/New_York:20260307T193000',
    'RDATE;TZID=America/New_York:20260308T183000'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-03-01', '2026-04-01'),
    ['2026-03-08', '2026-03-09']);
});

test('excludes recurring dates using EXRULE', async () => {
  const text = calendar(...event(
    'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
    'RRULE:FREQ=DAILY;COUNT=7', 'EXRULE:FREQ=DAILY;INTERVAL=2;COUNT=3'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-31', '2027-01-02', '2027-01-04', '2027-01-05']);
});

test('applies EXRULE to both the initial occurrence and RDATE', async () => {
  const text = calendar(...event(
    'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
    'RDATE;VALUE=DATE:20270101', 'EXRULE:FREQ=DAILY;INTERVAL=2;COUNT=2'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), []);
});

test('EXRULE exclusions take precedence over moved occurrences', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
      'RRULE:FREQ=DAILY;COUNT=3', 'EXRULE:FREQ=DAILY;INTERVAL=2;COUNT=2'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270101',
    'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2026-12-31']);
});

test('handles timed EXRULE across a daylight saving transition', async () => {
  const text = calendar(...event(
    'DTSTART;TZID=Europe/Stockholm:20260328T230000',
    'DTEND;TZID=Europe/Stockholm:20260329T010000',
    'RRULE:FREQ=DAILY;COUNT=3', 'EXRULE:FREQ=DAILY;INTERVAL=2;COUNT=2'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-03-01', '2026-04-01'), ['2026-03-29', '2026-03-30']);
});

test('moves a recurring date and subsequent dates using THISANDFUTURE', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'RRULE:FREQ=DAILY;COUNT=5'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261231',
    'DTSTART;VALUE=DATE:20270102', 'DTEND;VALUE=DATE:20270103', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']);
});

test('an individual exception takes precedence over THISANDFUTURE', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'RRULE:FREQ=DAILY;COUNT=5'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261231',
    'DTSTART;VALUE=DATE:20270102', 'DTEND;VALUE=DATE:20270103', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20270102',
    'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-02', '2027-01-03', '2027-01-05', '2027-01-10']);
});

test('THISANDFUTURE applies to additional RDATE occurrences', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
      'RDATE;VALUE=DATE:20261231,20270105'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261231',
    'DTSTART;VALUE=DATE:20270102', 'DTEND;VALUE=DATE:20270103', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-02', '2027-01-07']);
});

test('handles a timed THISANDFUTURE shift across a daylight saving transition', async () => {
  const text = calendar(
    ...event(
      'DTSTART;TZID=Europe/Stockholm:20260327T100000',
      'DTEND;TZID=Europe/Stockholm:20260327T110000',
      'RRULE:FREQ=DAILY;COUNT=4'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event',
    'RECURRENCE-ID;TZID=Europe/Stockholm;RANGE=THISANDFUTURE:20260328T100000',
    'DTSTART;TZID=Europe/Stockholm:20260329T100000',
    'DTEND;TZID=Europe/Stockholm:20260329T110000', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-03-01', '2026-04-01'),
    ['2026-03-27', '2026-03-29', '2026-03-30', '2026-03-31']);
});

test('includes THISANDFUTURE occurrences shifted into the requested interval', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20270101', 'DTEND;VALUE=DATE:20270102', 'RRULE:FREQ=DAILY;COUNT=3'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20270101',
    'DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-01-01'),
    ['2026-12-25', '2026-12-26', '2026-12-27']);
});

test('a cancelled THISANDFUTURE removes subsequent instances', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'RRULE:FREQ=DAILY;COUNT=4'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261231',
    'STATUS:CANCELLED', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2026-12-30']);
});

test('a later THISANDFUTURE supersedes an earlier range', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231', 'RRULE:FREQ=DAILY;COUNT=6'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261231',
    'DTSTART;VALUE=DATE:20270102', 'DTEND;VALUE=DATE:20270103', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20270102',
    'DTSTART;VALUE=DATE:20270101', 'DTEND;VALUE=DATE:20270102', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-01', '2027-01-02', '2027-01-03']);
});

test('EXDATE excludes the original occurrence before THISANDFUTURE shifts it', async () => {
  const text = calendar(
    ...event(
      'DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20261231',
      'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;VALUE=DATE:20270101'
    ),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261231',
    'DTSTART;VALUE=DATE:20270102', 'DTEND;VALUE=DATE:20270103', 'END:VEVENT'
  );
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-30', '2027-01-02', '2027-01-04']);
});

test('converts timed UTC events to Stockholm with exclusive midnight end', async () => {
  const text = calendar(...event('DTSTART:20261231T230000Z', 'DTEND:20270101T230000Z'));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'), ['2027-01-01']);
});

test('handles named timezone and daylight saving change', async () => {
  const text = calendar(...event(
    'DTSTART;TZID=Europe/Stockholm:20260329T013000',
    'DTEND;TZID=Europe/Stockholm:20260329T033000'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-03-01', '2026-04-01'), ['2026-03-29']);
});

test('handles timed daily recurrences over a daylight saving transition', async () => {
  const text = calendar(...event(
    'DTSTART;TZID=Europe/Stockholm:20260328T230000',
    'DTEND;TZID=Europe/Stockholm:20260329T010000',
    'RRULE:FREQ=DAILY;COUNT=3'
  ));
  assert.deepEqual(await parseCalendar(text, '2026-03-01', '2026-04-01'),
    ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
});

test('treats floating times as Stockholm local time', async () => {
  const text = calendar(...event('DTSTART:20261231T230000', 'DTEND:20270101T010000'));
  assert.deepEqual(await parseCalendar(text, '2026-12-01', '2027-02-01'),
    ['2026-12-31', '2027-01-01']);
});

for (const [description, text] of [
  ['incomplete calendar', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'],
  ['calendar without product identifier', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'],
  ['event without start', calendar(...event('DTEND;VALUE=DATE:20270101'))],
  ['invalid date', calendar(...event('DTSTART;VALUE=DATE:20260231', 'DTEND;VALUE=DATE:20260301'))],
  ['unknown timezone', calendar(...event('DTSTART;TZID=Not/AZone:20261230T100000', 'DTEND;TZID=Not/AZone:20261230T110000'))],
  ['invalid exclusion rule', calendar(...event('DTSTART;VALUE=DATE:20261230', 'EXRULE:FREQ=NOTREAL'))],
  ['unsupported recurrence range', calendar(
    ...event('DTSTART;VALUE=DATE:20261230', 'RRULE:FREQ=DAILY;COUNT=2'),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=NOTREAL:20261231',
    'DTSTART;VALUE=DATE:20270102', 'END:VEVENT'
  )],
  ['orphaned range exception', calendar(
    ...event('DTSTART;VALUE=DATE:20261230', 'RRULE:FREQ=DAILY;COUNT=2'),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20270115',
    'DTSTART;VALUE=DATE:20270116', 'DTEND;VALUE=DATE:20270117', 'END:VEVENT'
  )],
  ['duplicate recurrence exceptions', calendar(
    ...event('DTSTART;VALUE=DATE:20261230', 'RRULE:FREQ=DAILY;COUNT=2'),
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20261231',
    'DTSTART;VALUE=DATE:20270102', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:synthetic-event', 'RECURRENCE-ID;VALUE=DATE:20261231',
    'DTSTART;VALUE=DATE:20270103', 'END:VEVENT'
  )],
  ['unsupported recurrence period', calendar(...event('DTSTART:20261230T100000Z', 'RDATE;VALUE=PERIOD:20261231T100000Z/20261231T110000Z'))],
  ['invalid recurrence rule', calendar(...event('DTSTART;VALUE=DATE:20261230', 'RRULE:FREQ=NOTREAL'))],
  ['invalid date type', calendar(...event('DTSTART;VALUE=DATE:20261230T100000Z', 'DTEND:20261230T110000Z'))],
  ['different start and end types', calendar(...event('DTSTART;VALUE=DATE:20261230', 'DTEND:20261231T110000Z'))],
  ['incompatible exclusion type', calendar(...event('DTSTART;VALUE=DATE:20261230', 'RRULE:FREQ=DAILY;COUNT=2', 'EXDATE:20261231T100000Z'))],
  ['unsupported calendar scale', calendar('CALSCALE:HEBREW')],
  ['unsupported free-busy data', calendar('BEGIN:VFREEBUSY', 'FREEBUSY:20261230T100000Z/20261230T110000Z', 'END:VFREEBUSY')]
]) {
  test(`${description} returns an error rather than an empty calendar`, async () => {
    const ctx = context();
    const result = await handleAvailability(range(), ctx, { calendarUrl: SOURCE, fetchImpl: success(text) });
    assert.equal(result.status, 503);
    assert.equal(result.jsonBody.blocked, undefined);
    assert.equal(ctx.messages.length, 1);
    assert.match(ctx.messages[0], /tolkning/);
    assert.doesNotMatch(ctx.messages[0], /synthetic-event|2026|calendar\.example/);
  });
}

test('rejects missing configuration without fetching', async () => {
  let called = false;
  const ctx = context();
  const result = await handleAvailability(range(), ctx, {
    calendarUrl: '', fetchImpl: async () => { called = true; }
  });
  assert.equal(result.status, 503);
  assert.equal(called, false);
  assert.match(ctx.messages[0], /konfiguration/);
});

test('rejects invalid intervals and unexpected client URL parameters', async () => {
  for (const query of [
    new URLSearchParams({ start: '2026-02-31', end: '2026-04-01' }),
    new URLSearchParams({ start: '2026-01-01', end: '2027-01-01' }),
    new URLSearchParams({ start: '2026-01-01', end: '2026-02-01', url: SOURCE })
  ]) {
    const result = await handleAvailability({ query }, context(), { calendarUrl: SOURCE });
    assert.equal(result.status, 400);
  }
});

test('does not follow a redirect to another origin', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://other.example.test/path' } });
  };
  await assert.rejects(fetchCalendar(SOURCE, fetchImpl));
  assert.equal(calls, 1);
});

test('follows a same-origin redirect without accepting an arbitrary client URL', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url.href);
    return urls.length === 1
      ? new Response(null, { status: 302, headers: { location: '/next' } })
      : new Response(calendar(), { status: 200 });
  };
  assert.equal(await fetchCalendar(SOURCE, fetchImpl), calendar());
  assert.deepEqual(urls, [SOURCE, 'https://calendar.example.test/next']);
});

test('rejects oversized responses and insecure source URLs', async () => {
  await assert.rejects(fetchCalendar(SOURCE, async () => new Response('x'.repeat(MAX_BYTES + 1))));
  await assert.rejects(fetchCalendar('http://calendar.example.test/synthetic.ics', success(calendar())));
});

test('network failure and timeout return unknown availability', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('injected network failure'); },
    (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')));
    })
  ]) {
    const ctx = context();
    const result = await handleAvailability(range(), ctx, {
      calendarUrl: SOURCE, fetchImpl, fetchTimeoutMs: 10
    });
    assert.equal(result.status, 503);
    assert.equal(result.jsonBody.blocked, undefined);
    assert.match(ctx.messages[0], /hämtning/);
  }
});

test('parser timeouts do not return a successful calendar', async () => {
  await assert.rejects(parseCalendar(calendar(), '2026-12-01', '2027-02-01', 1));
});

test('fetches on every request rather than caching availability', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(calendar()); };
  const options = { calendarUrl: SOURCE, fetchImpl };
  assert.equal((await handleAvailability(range(), context(), options)).status, 200);
  assert.equal((await handleAvailability(range(), context(), options)).status, 200);
  assert.equal(calls, 2);
});
