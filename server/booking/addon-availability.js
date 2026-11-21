'use strict';

// Tillgänglighetskontroll för tidig incheckning och sen utcheckning.
//
// Kontrollen omfattar de extra buffertnätterna och görs mot samma källor som
// den ordinarie bokningen: Airbnb-iCal, interna bekräftade bokningar och
// datumblockeringar, pågående betalningsreservationer samt redan skapade
// buffertrader. Ett tekniskt fel ger alltid "inte tillgänglig" (fail closed).
//
// Modulen skapar aldrig kalenderrader. Den används innan en reservation,
// bekräftelse eller tillvalsändring får ske.

const { handleAvailability } = require('../calendar/availability');
const {
  addDays,
  bufferNightsFor,
  bufferAddonsFor,
  todayKey
} = require('./buffer-nights');

const INTERNAL_TYPES = new Set(['BOOKING', 'MANUAL', 'RESERVATION']);
const EXTERNAL_SOURCES = new Set(['AIRBNB', 'ICAL']);

function internalRowConflicts(rows, record, bufferSet) {
  const nights = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if ((row.resource ?? 'main') !== 'main') continue;
    if (String(row.reference ?? '') === String(record.reference ?? '')) continue;
    if (!INTERNAL_TYPES.has(String(row.type ?? '').toUpperCase())) continue;
    if (EXTERNAL_SOURCES.has(String(row.source ?? '').toUpperCase())) continue;
    const night = String(row.night ?? row.RowKey ?? '');
    if (bufferSet.has(night)) nights.push(night);
  }
  return nights;
}

function blockingBookingConflicts(bookings, record, bufferSet) {
  const nights = [];
  for (const booking of Array.isArray(bookings) ? bookings : []) {
    if (String(booking.reference ?? '') === String(record.reference ?? '')) continue;
    if (String(booking.bookingSource ?? '').toUpperCase() === 'AIRBNB') continue;
    for (const night of bufferSet) {
      if (booking.arrival <= night && booking.departure > night) nights.push(night);
    }
  }
  return nights;
}

async function checkAddonAvailability(store, record, options = {}, context = {}) {
  const bufferNights = bufferNightsFor(record);
  const addons = bufferAddonsFor(record);
  const result = {
    ok: true,
    bufferNights,
    addons: {},
    internalConflicts: [],
    airbnbConflicts: [],
    airbnbUnavailable: false,
    internalUnavailable: false
  };
  if (!bufferNights.length) return result;
  if (!store || typeof store.listCalendar !== 'function') {
    result.ok = false;
    result.internalUnavailable = true;
  }

  const bufferSet = new Set(bufferNights);
  const from = bufferNights[0];
  const to = addDays(bufferNights[bufferNights.length - 1], 1);
  const internalNights = [];

  if (!result.internalUnavailable) {
    try {
      const rows = await store.listCalendar(from, to);
      if (!Array.isArray(rows)) {
        result.internalUnavailable = true;
      } else {
        internalNights.push(...internalRowConflicts(rows, record, bufferSet));
      }
    } catch {
      result.internalUnavailable = true;
    }
  }

  if (!result.internalUnavailable && typeof store.listBlockingBookings === 'function') {
    try {
      const bookings = await store.listBlockingBookings(from, to);
      if (!Array.isArray(bookings)) {
        result.internalUnavailable = true;
      } else {
        internalNights.push(...blockingBookingConflicts(bookings, record, bufferSet));
      }
    } catch {
      result.internalUnavailable = true;
    }
  }

  const airbnbNights = [];
  if (options.requireAirbnbCheck !== false) {
    const handler = options.availabilityHandler ?? handleAvailability;
    try {
      const query = new URLSearchParams({ start: from, end: to });
      const response = await handler({ query }, context, {
        ...(options.availability ?? {}),
        statusSource: options.availability?.statusSource ?? 'addon-availability'
      });
      if (response.status !== 200 || !Array.isArray(response.jsonBody?.blocked)) {
        result.airbnbUnavailable = true;
      } else {
        for (const night of response.jsonBody.blocked) {
          if (bufferSet.has(night)) airbnbNights.push(night);
        }
      }
    } catch {
      result.airbnbUnavailable = true;
    }
  }

  result.internalConflicts = [...new Set(internalNights)].sort();
  result.airbnbConflicts = [...new Set(airbnbNights)].sort();
  const conflicts = new Set([...result.internalConflicts, ...result.airbnbConflicts]);
  const today = todayKey(options.now ?? new Date());

  for (const key of ['tidigIncheckning', 'senUtcheckning']) {
    const night = addons[key];
    if (!night) continue;
    let code = '';
    if (night < today) code = 'BUFFER_IN_PAST';
    else if (result.internalUnavailable || result.airbnbUnavailable) code = 'BUFFER_UNAVAILABLE';
    else if (conflicts.has(night)) code = 'BUFFER_UNAVAILABLE';
    result.addons[key] = {
      available: code === '',
      code,
      nights: [night]
    };
    if (code) result.ok = false;
  }

  if (!result.ok && result.internalConflicts.length) result.code = 'INTERNAL_CONFLICT';
  else if (!result.ok && result.airbnbConflicts.length) result.code = 'AIRBNB_CONFLICT';
  else if (!result.ok) result.code = 'BUFFER_UNAVAILABLE';

  return result;
}

function bufferAddonFieldErrors(check) {
  const fields = {};
  for (const [key, value] of Object.entries(check?.addons ?? {})) {
    if (value.available) continue;
    fields[key] = key === 'tidigIncheckning'
      ? 'Tidig incheckning är inte tillgänglig för valda datum eftersom natten före ankomst redan är upptagen.'
      : 'Sen utcheckning är inte tillgänglig för valda datum eftersom natten på avresedatumet redan är upptagen.';
  }
  return fields;
}

module.exports = {
  checkAddonAvailability,
  bufferAddonFieldErrors
};
