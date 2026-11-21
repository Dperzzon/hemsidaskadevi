'use strict';

// Interna spärrar som ska visas i den publika kalendern.
//
// Den publika kalendern får aldrig bara spegla Airbnb. Även bekräftade
// direktbokningar, manuella blockeringar och betalningsreservationer måste
// visas som upptagna. Backendens kontroll vid bokning är fortfarande avgörande.

const DAY = 86400000;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function addDays(dateKey, count) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

function addNights(target, arrival, departure) {
  if (!validDate(arrival) || !validDate(departure) || departure <= arrival) return;
  for (let night = arrival; night < departure; night = addDays(night, 1)) {
    target.add(night);
  }
}

function collectInternalBlocked(rows, blockingBookings) {
  const blocked = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if ((row.resource ?? 'main') !== 'main') continue;
    const type = String(row.type ?? '').toUpperCase();
    if (!['BOOKING', 'MANUAL', 'RESERVATION'].includes(type)) continue;
    if (['AIRBNB', 'ICAL'].includes(String(row.source ?? '').toUpperCase())) continue;
    const night = String(row.night ?? row.RowKey ?? '');
    if (validDate(night)) blocked.add(night);
  }
  for (const booking of Array.isArray(blockingBookings) ? blockingBookings : []) {
    if (!['CONFIRMED', 'BLOCKED'].includes(String(booking.statusCode ?? ''))) continue;
    if (String(booking.bookingSource ?? '').toUpperCase() === 'AIRBNB') continue;
    addNights(blocked, String(booking.arrival ?? ''), String(booking.departure ?? ''));
  }
  return [...blocked].sort();
}

async function loadInternalBlocked(store, from, to) {
  if (!store || typeof store.listCalendar !== 'function') {
    throw new Error('Intern kalender är inte konfigurerad');
  }
  const rows = await store.listCalendar(from, to);
  if (!Array.isArray(rows)) throw new Error('Intern kalender kunde inte läsas');
  let blockingBookings = [];
  if (typeof store.listBlockingBookings === 'function') {
    blockingBookings = await store.listBlockingBookings(from, to);
    if (!Array.isArray(blockingBookings)) throw new Error('Interna blockeringar kunde inte läsas');
  }
  return collectInternalBlocked(rows, blockingBookings);
}

module.exports = {
  collectInternalBlocked,
  loadInternalBlocked
};