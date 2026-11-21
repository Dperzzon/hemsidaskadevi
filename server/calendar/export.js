'use strict';

// Publik, token-skyddad iCal-export från Skadevis interna kalender.
//
// Exporten är medvetet neutral och innehåller aldrig kunduppgifter,
// betalningsinformation eller referenser i klartext. Endast nätter som faktiskt
// är reserverade i den interna kalendern exporteras:
//   - bekräftade bokningar (BOOKING),
//   - manuella datumblockeringar (MANUAL),
//   - aktiva betalningsreservationer (RESERVATION).
//
// Airbnb-importerade blockeringar lagras aldrig i den interna kalendern. Som
// extra skydd filtreras rader med källa AIRBNB/ICAL bort, så att en framtida
// import aldrig kan skapa en export-loop.
//
// Adressen innehåller en hemlig token som jämförs i konstant tid. Token läses
// från miljö/Key Vault och loggas eller visas aldrig i svaret.

const crypto = require('node:crypto');
const { createStore } = require('../booking/store');
const { auditReservations } = require('./reservation-audit');

const DAY = 86400000;
const DEFAULT_HORIZON_DAYS = 730;
const EXPORT_TYPES = new Set(['BOOKING', 'MANUAL', 'RESERVATION']);
const EXPORT_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Content-Disposition': 'inline; filename="skadevi-upptaget.ics"',
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer'
};
const NOT_FOUND_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow'
};

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function addDays(dateKey, count) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

function timestamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function expectedToken(options = {}) {
  return String(options.exportToken ?? process.env.CALENDAR_EXPORT_TOKEN ?? '');
}

function tokenMatches(provided, expected) {
  if (!provided || !expected || expected.length < 24) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function eventKey(row) {
  const reference = String(row.reference ?? row.blockId ?? '');
  const type = String(row.type ?? 'BUSY');
  const source = String(row.source ?? '');
  return `${type}|${source}|${reference}`;
}

// Bygger en nattkarta av kalenderrader och äldre bokningar som saknar
// kalenderrader. Varje natt får en stabil gruppnyckel så att intilliggande
// nätter med samma bokning kan slås samman till ett VEVENT.
function collectNights(rows, blockingBookings, activeReferences = null) {
  const nights = new Map();
  const referenceAllowed = (row) => {
    if (!activeReferences) return true;
    const reference = String(row.reference ?? '').trim();
    return Boolean(reference) && activeReferences.has(reference);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.resource && row.resource !== 'main') continue;
    if (!EXPORT_TYPES.has(String(row.type ?? '').toUpperCase())) continue;
    if (!referenceAllowed(row)) continue;
    const source = String(row.source ?? '').toUpperCase();
    if (source === 'AIRBNB' || source === 'ICAL') continue;
    const night = String(row.night ?? row.RowKey ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) continue;
    nights.set(night, { key: eventKey(row), night });
  }
  for (const booking of Array.isArray(blockingBookings) ? blockingBookings : []) {
    if (!['CONFIRMED', 'BLOCKED'].includes(String(booking.statusCode ?? ''))) continue;
    if (String(booking.bookingSource ?? '').toUpperCase() === 'AIRBNB') continue;
    const arrival = String(booking.arrival ?? '');
    const departure = String(booking.departure ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !/^\d{4}-\d{2}-\d{2}$/.test(departure)) continue;
    const key = `${booking.statusCode === 'BLOCKED' ? 'MANUAL' : 'BOOKING'}|${booking.bookingSource ?? ''}|${booking.reference ?? ''}`;
    for (let night = arrival; night < departure; night = addDays(night, 1)) {
      if (!nights.has(night)) nights.set(night, { key, night });
    }
  }
  return [...nights.values()].sort((a, b) => a.night.localeCompare(b.night));
}

function groupNights(nights) {
  const groups = [];
  for (const item of nights) {
    const last = groups.at(-1);
    if (last && last.key === item.key && addDays(last.end, 1) === item.night) {
      last.end = item.night;
      continue;
    }
    groups.push({ key: item.key, start: item.night, end: item.night });
  }
  return groups;
}

function escapeIcal(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function buildCalendar({
  rows,
  blockingBookings,
  activeReservationReferences = null,
  now = new Date(),
  horizonDays = DEFAULT_HORIZON_DAYS
}) {
  const from = todayKey(now);
  const to = addDays(from, Math.max(1, Math.min(Number(horizonDays) || DEFAULT_HORIZON_DAYS, 1095)));
  const nights = collectNights(rows, blockingBookings, activeReservationReferences)
    .filter((item) => item.night >= from && item.night < to);
  const stamp = timestamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Skadevi Herrgard//Booking Calendar//SV',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Skadevi Herrgård – Upptaget',
    'X-WR-TIMEZONE:Europe/Stockholm'
  ];
  for (const group of groupNights(nights)) {
    const uid = crypto.createHash('sha256')
      .update(`${group.key}|${group.start}`)
      .digest('hex')
      .slice(0, 24);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}@skadeviherrgard.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${group.start.replaceAll('-', '')}`,
      // DTEND är exklusivt: avresedagen ska vara ledig.
      `DTEND;VALUE=DATE:${addDays(group.end, 1).replaceAll('-', '')}`,
      `SUMMARY:${escapeIcal('Upptaget')}`,
      'TRANSP:OPAQUE',
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR', '');
  return { body: lines.join('\r\n'), from, to };
}

async function handleCalendarExport(request, context = {}, options = {}) {
  const token = String(request?.token ?? '');
  if (!tokenMatches(token, expectedToken(options))) {
    return { status: 404, headers: NOT_FOUND_HEADERS, body: 'Hittades inte.' };
  }
  const now = options.now ?? new Date();
  let store;
  try {
    store = options.store ?? createStore(options);
  } catch {
    return { status: 503, headers: NOT_FOUND_HEADERS, body: 'Kalendern är tillfälligt otillgänglig.' };
  }
  const from = todayKey(now);
  const horizonDays = Number(options.horizonDays ?? process.env.CALENDAR_EXPORT_HORIZON_DAYS ?? DEFAULT_HORIZON_DAYS);
  const to = addDays(from, Math.max(1, Math.min(horizonDays || DEFAULT_HORIZON_DAYS, 1095)));
  try {
    const rows = await store.listCalendar(from, to);
    if (!Array.isArray(rows)) throw new Error('Kalendern kunde inte läsas');
    let blockingBookings = [];
    if (typeof store.listBlockingBookings === 'function') {
      blockingBookings = await store.listBlockingBookings(from, to) ?? [];
    }
    const audit = await auditReservations(rows, {
      now,
      getRecord: typeof store.getByReference === 'function'
        ? async (reference) => (await store.getByReference(reference))?.record ?? null
        : null
    });
    if (audit.issues.length) {
      context.warn?.(
        `Kalenderexporten hittade ${audit.totalIssues} kalenderavvikelse(r). Endast aktiva referenser exporteras.`
      );
    }
    const calendar = buildCalendar({
      rows,
      blockingBookings,
      activeReservationReferences: audit.active,
      now,
      horizonDays
    });
    return { status: 200, headers: EXPORT_HEADERS, body: calendar.body };
  } catch {
    context.warn?.('Kalenderexporten kunde inte skapas.');
    return { status: 503, headers: NOT_FOUND_HEADERS, body: 'Kalendern är tillfälligt otillgänglig.' };
  }
}

module.exports = {
  handleCalendarExport,
  buildCalendar,
  collectNights,
  groupNights,
  tokenMatches,
  DEFAULT_HORIZON_DAYS,
  EXPORT_HEADERS
};
