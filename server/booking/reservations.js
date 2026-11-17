'use strict';

// Tillfälliga datumreservationer för direktbokning.
//
// Reservationen består av två delar:
//   1. En request-post med status PENDING_PAYMENT och ett reservation-objekt
//      (ägare, status, giltighetstid och Stripe-session).
//   2. En kalenderrad per natt i PartitionKey='calendar' med typ RESERVATION.
//
// Kalenderraderna skapas med Table Storage Insert Entity, som är create-only:
// samma natt kan aldrig ägas av två referenser samtidigt. Det ger atomisk
// nattlåsning utan kontroll-före-skrivning och utan race conditions.
//
// Reservationen får aldrig skrivas över av ett annat betalningsförsök. En
// annan referens kan därför inte ta samma nätter förrän reservationen har
// bekräftats, löpt ut eller frigivits efter verifierat avslut hos Stripe.

const RESERVATION_TYPE = 'RESERVATION';
const BOOKING_TYPE = 'BOOKING';

const RESERVATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  RELEASED: 'RELEASED',
  FAILED: 'FAILED'
});

function nightKeys(arrival, departure) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(arrival ?? '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(departure ?? ''))) {
    return [];
  }
  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
  const nights = [];
  for (let current = start, guard = 0; current < end && guard < 100; guard += 1) {
    nights.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 86400000);
  }
  return nights;
}

function reservationRow(night, record, now) {
  return {
    type: RESERVATION_TYPE,
    reference: record.reference,
    blockId: '',
    source: 'DIRECT',
    note: 'Tillfällig betalningsreservation',
    createdBy: 'Gäst',
    createdAt: now.toISOString()
  };
}

// Skapar nattlåsningar atomiskt. Vid minsta konflikt rullas alla nätter som
// detta försök hann skapa tillbaka — ingen delvis reservation lämnas kvar.
async function reserveNights(store, record, now = new Date()) {
  if (!store || typeof store.createCalendarNight !== 'function') {
    throw new Error('Lagringen saknar atomisk nattlåsning');
  }
  const nights = nightKeys(record.arrival, record.departure);
  if (!nights.length) {
    const invalid = new Error('Bokningens datum är ogiltiga');
    invalid.status = 400;
    throw invalid;
  }
  const created = [];
  for (const night of nights) {
    try {
      await store.createCalendarNight(night, reservationRow(night, record, now));
      created.push(night);
    } catch (error) {
      for (const inserted of created) {
        await store.deleteCalendarNight(inserted, record.reference).catch(() => {});
      }
      if (error?.status === 409) {
        const conflict = new Error('Några av nätterna är redan reserverade');
        conflict.status = 409;
        conflict.code = 'RESERVATION_CONFLICT';
        conflict.conflicts = [night];
        throw conflict;
      }
      throw error;
    }
  }
  return { nights, created };
}

// Frigör endast rader som tillhör den angivna referensen. Rader som redan
// omvandlats till BOOKING lämnas orörda om inte force används.
async function releaseReservation(store, reference, _now = new Date(), options = {}) {
  if (!store || typeof store.listCalendarByReference !== 'function') return [];
  const rows = await store.listCalendarByReference(reference);
  const released = [];
  for (const row of rows) {
    const night = row.night ?? row.RowKey;
    if (!night) continue;
    if (!options.force && row.type === BOOKING_TYPE) continue;
    try {
      await store.deleteCalendarNight(night, reference);
      released.push(night);
    } catch (error) {
      if (options.strict) throw error;
    }
  }
  return released;
}

// Verifierar att reservationen äger exakt de aktuella nätterna.
async function verifyReservation(store, record) {
  const expected = nightKeys(record.arrival, record.departure);
  if (!expected.length) {
    return { ok: false, code: 'RESERVATION_INVALID', message: 'Bokningens datum är ogiltiga.' };
  }
  if (!store || typeof store.listCalendarByReference !== 'function') {
    return { ok: false, code: 'RESERVATION_UNAVAILABLE', message: 'Reservationen kunde inte kontrolleras.' };
  }
  const rows = await store.listCalendarByReference(record.reference);
  const owned = new Set(
    rows
      .filter((row) => !row.type || row.type === RESERVATION_TYPE || row.type === BOOKING_TYPE)
      .map((row) => row.night ?? row.RowKey)
      .filter(Boolean)
  );
  const missing = expected.filter((night) => !owned.has(night));
  if (missing.length) {
    return { ok: false, code: 'RESERVATION_MISSING', message: 'Reservationen saknar giltig nattlåsning.', missing };
  }
  return { ok: true, nights: expected, rows };
}

// Omvandlar RESERVATION-raderna till BOOKING på plats. Ingen rad raderas, så
// det finns ingen tidslucka där en annan bokning kan ta datumen.
async function convertReservationToBooking(store, record, now = new Date()) {
  const verification = await verifyReservation(store, record);
  if (!verification.ok) return verification;
  if (typeof store.updateCalendarNight !== 'function') {
    return { ok: false, code: 'RESERVATION_UPDATE_UNSUPPORTED', message: 'Lagringen kan inte bekräfta reservationen.' };
  }
  for (const row of verification.rows) {
    const night = row.night ?? row.RowKey;
    if (!verification.nights.includes(night)) continue;
    if (row.type === BOOKING_TYPE) continue;
    await store.updateCalendarNight(night, {
      type: BOOKING_TYPE,
      reference: record.reference,
      blockId: '',
      source: 'DIRECT',
      note: 'Direktbokning',
      createdBy: 'Stripe',
      createdAt: row.createdAt || now.toISOString()
    }, { ifMatch: row.etag });
  }
  return { ok: true, nights: verification.nights };
}

function reservationIsActive(record, now = new Date()) {
  if (!record?.reservation) return false;
  if (record.reservation.status !== RESERVATION_STATUS.ACTIVE) return false;
  const expiresAt = Date.parse(record.reservation.expiresAt ?? '');
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

module.exports = {
  RESERVATION_TYPE,
  BOOKING_TYPE,
  RESERVATION_STATUS,
  nightKeys,
  reserveNights,
  releaseReservation,
  verifyReservation,
  convertReservationToBooking,
  reservationIsActive
};
