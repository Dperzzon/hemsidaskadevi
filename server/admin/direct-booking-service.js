'use strict';

// Owner-styrd öppning och stängning av datum för direktbokning.
//
// Alla datum är stängda som standard. Ett datumintervall får bara öppnas om
// Owner uttryckligen bekräftar de fyra villkoren OCH Airbnb iCal visar att
// samtliga nätter är blockerade. Systemet kan inte avgöra om en Airbnb-
// blockering är Owners egen eller en extern gästbokning; Owners bekräftelse är
// därför den avgörande attestationen. Detta dokumenteras i auditloggen.

const crypto = require('node:crypto');
const { handleAvailability } = require('../calendar/availability');

const MAX_NIGHTS = 93;
const DAY = 86400000;
const CONFIRMATIONS = [
  'confirmAirbnbBlocked',
  'confirmNoAirbnbGuest',
  'confirmNoExternal',
  'confirmMayOffer'
];

function nightKeys(arrival, departure) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(arrival ?? '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(departure ?? ''))) {
    return [];
  }
  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
  const nights = [];
  for (let current = start, guard = 0; current < end && guard < MAX_NIGHTS; guard += 1) {
    nights.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + DAY);
  }
  return nights;
}

function error(status, message, code) {
  return { status, jsonBody: { error: message, code } };
}

function validateRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from ?? '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(to ?? ''))) {
    return { ok: false, message: 'Ange giltiga datum (ÅÅÅÅ-MM-DD).' };
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, message: 'Avresedatum måste vara efter ankomstdatum.' };
  }
  const nights = nightKeys(from, to);
  if (!nights.length || nights.length > MAX_NIGHTS) {
    return { ok: false, message: `Datumintervallet måste omfatta 1–${MAX_NIGHTS} nätter.` };
  }
  return { ok: true, nights };
}

async function fetchAirbnbBlocked(from, to, options, context) {
  const handler = options.availabilityHandler ?? handleAvailability;
  try {
    const query = new URLSearchParams({ start: from, end: to });
    const result = await handler({ query }, context, options.availability ?? {});
    if (result.status !== 200 || !Array.isArray(result.jsonBody?.blocked)) return null;
    return result.jsonBody.blocked;
  } catch {
    return null;
  }
}

function actorOf(principal) {
  return {
    id: String(principal?.id ?? principal?.email ?? ''),
    name: String(principal?.name ?? principal?.email ?? 'Owner')
  };
}

async function openDirectBooking(repository, principal, body, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan öppna datum för direktbokning.', 'FORBIDDEN');
  }
  const from = String(body?.from ?? '').trim();
  const to = String(body?.to ?? '').trim();
  const range = validateRange(from, to);
  if (!range.ok) return error(400, range.message, 'INVALID_RANGE');

  for (const key of CONFIRMATIONS) {
    if (body?.[key] !== true) {
      return error(400, 'Alla fyra bekräftelser måste godkännas innan datum kan öppnas.', 'CONFIRMATIONS_REQUIRED');
    }
  }

  const note = String(body?.note ?? '').trim().slice(0, 1000);
  const now = options.now ?? new Date();
  const approvedAt = now.toISOString();
  const actor = actorOf(principal);

  // 1. Airbnb iCal måste visa samtliga nätter som blockerade. Detta är ett
  //    tekniskt underlag — Owners bekräftelse är attestationen att blockeringen
  //    är deras egen och att inga externa bokningar finns.
  const blocked = await fetchAirbnbBlocked(from, to, options, context);
  if (!blocked) {
    return error(503, 'Airbnb-kalendern kunde inte läsas. Datumen kan inte öppnas säkert.', 'AIRBNB_UNAVAILABLE');
  }
  const missing = range.nights.filter((night) => !blocked.includes(night));
  if (missing.length) {
    return error(
      409,
      `Airbnb iCal visar inte alla nätter som blockerade (${missing.join(', ')}). Blockera datumen i Airbnb först.`,
      'AIRBNB_NOT_BLOCKED'
    );
  }

  // 2. Ingen intern bokning, blockering eller aktiv betalningsreservation får
  //    överlappa de datum som ska öppnas.
  const all = await repository.allBookings(now);
  const conflicts = all.filter((booking) =>
    booking.arrival < to && booking.departure > from &&
    (
      booking.statusCode === 'CONFIRMED' ||
      booking.statusCode === 'BLOCKED' ||
      (booking.statusCode === 'PENDING_PAYMENT' && booking.bookingSource === 'DIRECT')
    )
  );
  if (conflicts.length) {
    return error(
      409,
      'Datumen överlappar en intern bokning, datumblockering eller aktiv betalningsreservation.',
      'INTERNAL_CONFLICT'
    );
  }

  // 3. Spara en rad per natt med Owners godkännande och iCal-underlaget.
  const approvalId = `DB-${now.getTime()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const airbnbBlockedNights = range.nights.filter((night) => blocked.includes(night));
  for (const night of range.nights) {
    await repository.upsertDirectBookingNight(night, {
      status: 'OPEN',
      approvalId,
      from,
      to,
      approvedBy: actor.name,
      approvedById: actor.id,
      approvedAt,
      note,
      airbnbBlockedNights: JSON.stringify(airbnbBlockedNights),
      airbnbCheckedAt: approvedAt,
      createdAt: approvedAt,
      updatedAt: approvedAt,
      updatedBy: actor.name
    });
  }

  await repository.appendHistory({
    idempotencyKey: `direct-open-${approvalId}`,
    reference: `DIRECT-${approvalId}`,
    action: 'DIRECT_BOOKING_OPENED',
    fromStatus: '',
    toStatus: 'OPEN',
    changes: JSON.stringify({
      from,
      to,
      nights: range.nights,
      note,
      airbnbBlockedNights,
      confirmations: CONFIRMATIONS
    }),
    reason: note,
    actorId: actor.id,
    actorName: actor.name,
    correlationId: crypto.randomUUID(),
    at: approvedAt
  });

  return {
    status: 201,
    jsonBody: {
      approvalId,
      from,
      to,
      nights: range.nights,
      approvedBy: actor.name,
      approvedAt,
      airbnbBlockedNights
    }
  };
}

async function closeDirectBooking(repository, principal, body, options = {}, _context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan stänga datum för direktbokning.', 'FORBIDDEN');
  }
  const approvalId = String(body?.approvalId ?? '').trim();
  if (!approvalId) return error(400, 'Ange vilket godkännande som ska stängas.', 'APPROVAL_REQUIRED');

  const rows = await repository.listDirectBookingNightsByApproval(approvalId);
  if (!rows || !rows.length) {
    return error(404, 'Godkännandet hittades inte.', 'APPROVAL_NOT_FOUND');
  }

  const now = options.now ?? new Date();
  const closedAt = now.toISOString();
  const actor = actorOf(principal);
  const closed = [];
  for (const row of rows) {
    if (row.status !== 'OPEN') continue;
    await repository.upsertDirectBookingNight(row.night, {
      ...row,
      status: 'CLOSED',
      closedBy: actor.name,
      closedById: actor.id,
      closedAt,
      updatedAt: closedAt,
      updatedBy: actor.name
    });
    closed.push(row.night);
  }

  await repository.appendHistory({
    idempotencyKey: `direct-close-${approvalId}-${now.getTime()}`,
    reference: `DIRECT-${approvalId}`,
    action: 'DIRECT_BOOKING_CLOSED',
    fromStatus: 'OPEN',
    toStatus: 'CLOSED',
    changes: JSON.stringify({ approvalId, nights: closed }),
    reason: String(body?.note ?? '').trim().slice(0, 1000),
    actorId: actor.id,
    actorName: actor.name,
    correlationId: crypto.randomUUID(),
    at: closedAt
  });

  return { status: 200, jsonBody: { approvalId, closed } };
}

async function directBookingOverview(repository, now = new Date()) {
  const [all, approvals] = await Promise.all([
    repository.allBookings(now),
    repository.listDirectBookingApprovals()
  ]);
  const direct = all.filter((booking) => booking.bookingSource === 'DIRECT');
  return {
    approvals: approvals ?? [],
    reservations: direct.filter((booking) => booking.statusCode === 'PENDING_PAYMENT'),
    confirmed: direct.filter((booking) => booking.statusCode === 'CONFIRMED'),
    reconciliation: direct.filter((booking) => booking.statusCode === 'RECONCILIATION')
  };
}

module.exports = {
  openDirectBooking,
  closeDirectBooking,
  directBookingOverview,
  validateRange,
  CONFIRMATIONS,
  MAX_NIGHTS
};
