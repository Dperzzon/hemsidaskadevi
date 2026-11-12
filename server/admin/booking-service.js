'use strict';

// Affärslogik för bokningsportalens skrivfunktioner. Tjänsten är
// repository-oberoende och används av både demorepositoryt och Azure Table.
//
// Principer:
// - En förfrågan (PENDING) är aldrig en bokning. Endast Owner kan bekräfta.
// - Bekräftade bokningar och manuella block skapar en kalenderrad per natt.
// - Kalenderraden skapas med Table Storage Insert Entity, som är create-only:
//   samma natt/RowKey ger 409. Två samtidiga bekräftelser kan därför aldrig
//   båda lyckas för samma natt.
// - Alla ändringar kräver ETag/If-Match och skriver en append-only auditpost.
// - Sparade prisuppgifter räknas aldrig om vid visning. Nya beräkningar sker
//   bara vid uttrycklig ändring och bevarar originalpriset.

const crypto = require('node:crypto');
const { quote, PRICE_VERSION } = require('../booking/pricing');
const { handleAvailability } = require('../calendar/availability');
const { MAIL } = require('../booking/mail');
const {
  STATUS_META,
  todayKey,
  validDateKey,
  nightsBetween,
  nightKeys
} = require('./domain');

const MAX_GUESTS = 24;
const MAX_NIGHTS = 93;
const SOURCES = new Set(['PHONE', 'EMAIL', 'AIRBNB', 'DIRECT', 'OTHER', 'MANUAL', 'WEB']);
const PAYMENT_STATUSES = new Set(['UNKNOWN', 'UNPAID', 'DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'VOID']);
const MANUAL_STATUSES = new Set(['PENDING', 'PRELIMINARY', 'CONFIRMED']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9 ()-]{5,32}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,80}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function cleanString(value, limit = 2000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, limit);
}

function makeReference(prefix, now = new Date()) {
  let suffix = '';
  const bytes = crypto.randomBytes(6);
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `${prefix}-${now.getFullYear()}-${suffix}`;
}

function makeIdempotencyKey(value) {
  const candidate = cleanString(value, 80);
  if (/^[A-Za-z0-9-]{8,64}$/.test(candidate)) return candidate;
  return crypto.randomUUID();
}

function statusLabel(code) {
  return STATUS_META[code]?.label ?? code;
}

function actorOf(principal) {
  return {
    id: String(principal?.id ?? ''),
    name: String(principal?.name ?? principal?.email ?? 'Administratör')
  };
}

function error(status, message, extra = {}) {
  return { status, jsonBody: { error: message, ...extra } };
}

function validAddons(input, guests) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const lakan = source.lakan === true;
  let linenCount = lakan ? Number(source.linenCount) : 0;
  if (!Number.isFinite(linenCount)) linenCount = 0;
  linenCount = Math.min(Math.max(0, Math.trunc(linenCount)), guests);
  return {
    slutstad: source.slutstad === true,
    lakan,
    linenCount,
    ved: source.ved === true,
    tidigIncheckning: source.tidigIncheckning === true,
    senUtcheckning: source.senUtcheckning === true
  };
}

function pricingSnapshot(record) {
  return {
    lodgingBase: record.lodgingBase,
    peakNights: record.peakNights,
    peakBase: record.peakBase,
    nightlyBreakdown: record.nightlyBreakdown,
    discount: record.discount,
    discountAmount: record.discountAmount,
    lodgingAfterDiscount: record.lodgingAfterDiscount,
    addonLines: record.addonLines,
    totalAddons: record.totalAddons,
    total: record.total,
    priceVersion: record.priceVersion,
    capturedAt: record.updatedAt || record.createdAt || new Date().toISOString()
  };
}

function balanceFor(total, amountPaid, paymentStatus) {
  if (paymentStatus === 'PAID' || paymentStatus === 'REFUNDED' || paymentStatus === 'VOID') return 0;
  return Number(total || 0) - Number(amountPaid || 0);
}

function validateDates(body, now) {
  const errors = {};
  const arrival = cleanString(body.arrival, 10);
  const departure = cleanString(body.departure, 10);
  if (!validDateKey(arrival)) errors.arrival = 'Ange ett giltigt ankomstdatum.';
  if (!validDateKey(departure)) errors.departure = 'Ange ett giltigt avresedatum.';
  if (!errors.arrival && !errors.departure) {
    const nights = nightsBetween(arrival, departure);
    if (nights < 1) errors.arrival = 'Avresedatum måste vara efter ankomstdatum.';
    else if (nights > MAX_NIGHTS) errors.arrival = `Vistelsen får omfatta högst ${MAX_NIGHTS} nätter.`;
    else if (arrival < todayKey(now)) errors.arrival = 'Ankomstdatum får inte vara i det förflutna.';
  }
  return { errors, arrival, departure, nights: nightsBetween(arrival, departure) };
}

function validateManualBooking(body, now = new Date()) {
  const errors = {};
  const dates = validateDates(body, now);
  Object.assign(errors, dates.errors);
  const mode = body.mode === 'block' ? 'block' : 'booking';
  const guests = Number(body.guests);
  const firstName = cleanString(body.firstName, 80);
  const lastName = cleanString(body.lastName, 80);
  const email = cleanString(body.email, 120).toLowerCase();
  const phone = cleanString(body.phone, 32);
  const company = cleanString(body.company, 120);
  const message = cleanString(body.message, 2000);
  const latestNote = cleanString(body.latestNote ?? body.note, 2000);
  const bookingSource = String(body.bookingSource ?? 'MANUAL').toUpperCase();
  const statusCode = String(body.statusCode ?? (mode === 'block' ? 'BLOCKED' : 'CONFIRMED')).toUpperCase();
  const paymentStatus = String(body.paymentStatus ?? 'UNPAID').toUpperCase();
  const amountPaid = Number(body.amountPaid ?? 0);
  const agreedTotalRaw = body.agreedTotal;
  const priceAdjustmentReason = cleanString(body.priceAdjustmentReason, 500);

  if (mode === 'booking') {
    if (!firstName) errors.firstName = 'Ange gästens förnamn.';
    if (!lastName) errors.lastName = 'Ange gästens efternamn.';
    if (!email || !EMAIL_PATTERN.test(email)) errors.email = 'Ange en giltig e-postadress.';
    if (!phone || !PHONE_PATTERN.test(phone)) errors.phone = 'Ange ett giltigt telefonnummer.';
    if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) {
      errors.guests = `Ange antal gäster (1–${MAX_GUESTS}).`;
    }
    if (!SOURCES.has(bookingSource) || bookingSource === 'WEB') {
      errors.bookingSource = 'Ange en giltig bokningskälla.';
    }
    if (!MANUAL_STATUSES.has(statusCode)) errors.statusCode = 'Ange en giltig status.';
  }
  if (!PAYMENT_STATUSES.has(paymentStatus)) errors.paymentStatus = 'Ange en giltig betalstatus.';
  if (!Number.isFinite(amountPaid) || amountPaid < 0) errors.amountPaid = 'Belopp mottaget måste vara 0 eller mer.';

  let agreedTotal = null;
  if (agreedTotalRaw !== undefined && agreedTotalRaw !== null && String(agreedTotalRaw).trim() !== '') {
    agreedTotal = Number(agreedTotalRaw);
    if (!Number.isFinite(agreedTotal) || agreedTotal < 0) {
      errors.agreedTotal = 'Avtalat totalpris måste vara 0 eller mer.';
    } else if (!priceAdjustmentReason) {
      errors.priceAdjustmentReason = 'Ändringsorsak är obligatorisk när avtalat pris anges.';
    }
  }

  if (Object.keys(errors).length) return { errors };

  const addons = mode === 'booking'
    ? validAddons(body.addons, guests)
    : validAddons({}, 0);
  const pricing = mode === 'booking'
    ? quote({ arrival: dates.arrival, departure: dates.departure, guests, addons })
    : null;
  const total = mode === 'block' ? 0 : (agreedTotal ?? pricing.total);

  return {
    mode,
    referencePrefix: mode === 'block' ? 'BLOCK' : 'SK',
    record: {
      arrival: dates.arrival,
      departure: dates.departure,
      nights: dates.nights,
      guests: mode === 'block' ? 0 : guests,
      firstName: mode === 'block' ? '' : firstName,
      lastName: mode === 'block' ? '' : lastName,
      email: mode === 'block' ? '' : email,
      phone: mode === 'block' ? '' : phone,
      company: mode === 'block' ? '' : company,
      message: mode === 'block' ? message : '',
      latestNote,
      bookingSource: mode === 'block' ? 'MANUAL' : bookingSource,
      statusCode: mode === 'block' ? 'BLOCKED' : statusCode,
      status: statusLabel(mode === 'block' ? 'BLOCKED' : statusCode),
      addons,
      lodgingBase: pricing?.lodgingBase ?? 0,
      peakNights: pricing?.peakNights ?? 0,
      peakBase: pricing?.peakBase ?? 0,
      nightlyBreakdown: pricing?.nightlyBreakdown ?? [],
      discount: pricing?.discount ?? null,
      discountAmount: pricing?.discountAmount ?? 0,
      lodgingAfterDiscount: pricing?.lodgingAfterDiscount ?? 0,
      addonLines: pricing?.addonLines ?? [],
      totalAddons: pricing?.addonsTotal ?? 0,
      calculatedTotal: pricing?.total ?? 0,
      agreedTotal,
      priceAdjustmentReason,
      total,
      priceVersion: pricing?.priceVersion ?? PRICE_VERSION,
      paymentStatus,
      amountPaid,
      balance: balanceFor(total, amountPaid, paymentStatus),
      rulesVersion: '',
      consentContact: false
    }
  };
}

function bucketByNight(calendar) {
  const map = new Map();
  for (const row of calendar) {
    const night = String(row.night ?? row.RowKey ?? '');
    if (!night) continue;
    if (!map.has(night)) map.set(night, []);
    map.get(night).push(row);
  }
  return map;
}

async function internalConflicts(repo, record, now, excludeReference = '') {
  const all = await repo.allBookings(now);
  return all.filter((booking) =>
    booking.reference !== excludeReference &&
    (booking.statusCode === 'CONFIRMED' || booking.statusCode === 'BLOCKED') &&
    booking.arrival < record.departure &&
    booking.departure > record.arrival
  );
}

async function calendarConflicts(repo, record) {
  const rows = await repo.listCalendar(record.arrival, record.departure);
  return rows.filter((row) => row.reference !== record.reference);
}

async function airbnbConflicts(record, options, context) {
  if (options.requireAirbnbCheck === false) return { blocked: [] };
  const handler = options.availabilityHandler ?? handleAvailability;
  let result;
  try {
    const query = new URLSearchParams({ start: record.arrival, end: record.departure });
    result = await handler({ query }, context, options.availability ?? {});
  } catch {
    return { unavailable: true, blocked: [] };
  }
  if (result.status !== 200 || !Array.isArray(result.jsonBody?.blocked)) {
    return { unavailable: true, blocked: [] };
  }
  return {
    blocked: nightKeys(record.arrival, record.departure)
      .filter((night) => result.jsonBody.blocked.includes(night))
  };
}

async function assertConfirmable(repo, record, options, context, now) {
  const calendar = await calendarConflicts(repo, record);
  if (calendar.length) {
    return error(409, 'Datumen är redan blockerade i den interna kalendern.', {
      conflicts: calendar.map((row) => row.night ?? row.RowKey)
    });
  }
  const internal = await internalConflicts(repo, record, now, record.reference);
  if (internal.length) {
    return error(409, 'Datumen överlappar en annan bekräftad bokning eller blockering.', {
      conflicts: internal.map((booking) => booking.reference)
    });
  }
  const airbnb = await airbnbConflicts(record, options, context);
  if (airbnb.unavailable) {
    return error(503, 'Airbnb-kalendern kunde inte kontrolleras. Bokningen har inte bekräftats.');
  }
  if (airbnb.blocked.length) {
    return error(409, 'Några nätter är redan bokade i Airbnb-kalendern. Bokningen har inte bekräftats.', {
      blockedNights: airbnb.blocked
    });
  }
  return null;
}

async function lockCalendar(repo, record, principal, now) {
  const created = [];
  const actor = actorOf(principal);
  const nights = nightKeys(record.arrival, record.departure);
  for (const night of nights) {
    try {
      await repo.createCalendarNight(night, {
        type: record.statusCode === 'BLOCKED' ? 'MANUAL' : 'BOOKING',
        reference: record.reference,
        blockId: record.blockId ?? '',
        source: record.bookingSource,
        note: record.latestNote ?? '',
        createdBy: actor.name,
        createdAt: now.toISOString()
      });
      created.push(night);
    } catch (cause) {
      for (const inserted of created) {
        await repo.deleteCalendarNight(inserted, record.reference).catch(() => {});
      }
      if (cause?.status === 409) {
        return error(409, 'Datumen är redan blockerade. Ingen delvis blockering sparades.', {
          conflicts: [night]
        });
      }
      throw cause;
    }
  }
  return { created };
}

async function releaseCalendar(repo, reference) {
  const rows = await repo.listCalendarByReference(reference);
  for (const row of rows) {
    await repo.deleteCalendarNight(row.night ?? row.RowKey, reference).catch(() => {});
  }
}

async function audit(repo, principal, action, record, details = {}) {
  const now = new Date();
  const actor = actorOf(principal);
  const entry = {
    reference: record.reference,
    action,
    fromStatus: details.fromStatus ?? '',
    toStatus: details.toStatus ?? record.statusCode ?? '',
    changes: JSON.stringify(details.changes ?? {}),
    reason: details.reason ?? '',
    actorId: actor.id,
    actorName: actor.name,
    correlationId: details.correlationId ?? crypto.randomUUID(),
    at: now.toISOString()
  };
  try {
    await repo.appendHistory({
      ...entry,
      idempotencyKey: `${record.reference}_${now.toISOString()}_${crypto.randomBytes(4).toString('hex')}`
    });
  } catch {
    details.context?.warn?.(`Auditpost kunde inte sparas för ${record.reference}.`);
  }
  return entry;
}

function normalizeRepoError(cause) {
  if (cause?.status === 409) return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  if (cause?.status === 404) return error(404, 'Bokningen hittades inte.');
  return null;
}

async function createManualBooking(repo, principal, body, options = {}, context = {}) {
  const now = options.now ?? new Date();
  const validated = validateManualBooking(body, now);
  if (validated.errors) {
    return error(400, 'Kontrollera uppgifterna i formuläret.', { fields: validated.errors });
  }
  const idempotencyKey = makeIdempotencyKey(options.idempotencyKey);
  const rowKey = `${validated.mode === 'block' ? 'block' : 'manual'}-${idempotencyKey}`;
  const existing = await repo.findByIdempotencyKey(rowKey).catch(() => null);
  if (existing) {
    return { status: 200, jsonBody: { reference: existing.reference, duplicate: true } };
  }

  let reference = makeReference(validated.referencePrefix, now);
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await repo.findByReference(reference).catch(() => null);
    if (!clash) break;
    reference = makeReference(validated.referencePrefix, now);
    if (attempt === 4) return error(503, 'Kunde inte skapa ett unikt boknings-ID. Försök igen.');
  }
  const actor = actorOf(principal);
  const record = {
    ...validated.record,
    idempotencyKey: rowKey,
    rowKey,
    reference,
    blockId: validated.mode === 'block' ? reference : '',
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    updatedBy: actor.name,
    confirmedAt: validated.record.statusCode === 'CONFIRMED' ? now.toISOString() : '',
    declinedAt: '',
    cancelledAt: '',
    airbnbBlockedAt: '',
    overlaps: []
  };

  let locked = null;
  if (record.statusCode === 'CONFIRMED' || record.statusCode === 'BLOCKED') {
    const conflict = record.statusCode === 'CONFIRMED'
      ? await assertConfirmable(repo, record, options, context, now)
      : null;
    if (conflict) return conflict;
    if (record.statusCode === 'BLOCKED') {
      const calendar = await calendarConflicts(repo, record);
      if (calendar.length) {
        return error(409, 'Datumen är redan blockerade.', {
          conflicts: calendar.map((row) => row.night ?? row.RowKey)
        });
      }
      const internal = await internalConflicts(repo, record, now, record.reference);
      if (internal.length) {
        return error(409, 'Datumen överlappar en intern bokning.', {
          conflicts: internal.map((booking) => booking.reference)
        });
      }
    }
    locked = await lockCalendar(repo, record, principal, now);
    if (locked?.status) return locked;
  }

  try {
    const saved = await repo.createRequest(record);
    if (saved.duplicate) {
      if (locked?.created) await releaseCalendar(repo, record.reference);
      return { status: 200, jsonBody: { reference: saved.record.reference, duplicate: true } };
    }
    await audit(repo, principal, validated.mode === 'block' ? 'BLOCK_CREATED' : 'MANUAL_CREATED', record, {
      toStatus: record.statusCode,
      reason: record.latestNote,
      context
    });
    if (validated.mode === 'booking' && body.sendGuestEmail === true) {
      await queueGuestConfirmation(repo, record, options, context);
    }
    return {
      status: 201,
      jsonBody: {
        reference: record.reference,
        statusCode: record.statusCode,
        total: record.total,
        arrival: record.arrival,
        departure: record.departure
      }
    };
  } catch (cause) {
    if (locked?.created) await releaseCalendar(repo, record.reference);
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

async function changeStatus(repo, principal, reference, action, body = {}, options = {}, context = {}) {
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const now = options.now ?? new Date();
  const record = { ...raw.record };
  const fromStatus = String(record.statusCode ?? 'PENDING');
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  if (record.reference && /^BLOCK-/.test(record.reference)) {
    return error(422, 'Datumblockeringar hanteras med avblockeringsåtgärden.');
  }

  const reason = cleanString(body.reason, 500);
  let nextStatus = fromStatus;
  let auditAction = action;
  let lockedNights = null;

  if (action === 'approve' || action === 'preliminary') {
    if (fromStatus !== 'PENDING') return error(422, 'Endast en väntande förfrågan kan godkännas som preliminär.');
    nextStatus = 'PRELIMINARY';
  } else if (action === 'decline') {
    if (!['PENDING', 'PRELIMINARY'].includes(fromStatus)) return error(422, 'Bokningen kan inte nekas från nuvarande status.');
    if (!reason) return error(400, 'Ange en orsak till att förfrågan nekas.', { fields: { reason: 'Orsak krävs.' } });
    nextStatus = 'DECLINED';
  } else if (action === 'confirm') {
    if (!['PENDING', 'PRELIMINARY'].includes(fromStatus)) return error(422, 'Endast väntande eller preliminär bokning kan bekräftas.');
    const conflict = await assertConfirmable(repo, record, options, context, now);
    if (conflict) return conflict;
    lockedNights = await lockCalendar(repo, record, principal, now);
    if (lockedNights?.status) return lockedNights;
    nextStatus = 'CONFIRMED';
  } else if (action === 'cancel') {
    if (fromStatus !== 'CONFIRMED') return error(422, 'Endast en bekräftad bokning kan avbokas.');
    if (!reason) return error(400, 'Ange en orsak till avbokningen.', { fields: { reason: 'Orsak krävs.' } });
    nextStatus = 'CANCELLED';
  } else {
    return error(400, 'Okänd statusåtgärd.');
  }

  record.statusCode = nextStatus;
  record.status = statusLabel(nextStatus);
  record.version = Number(record.version || 1) + 1;
  record.updatedAt = now.toISOString();
  record.updatedBy = actorOf(principal).name;
  if (nextStatus === 'CONFIRMED') record.confirmedAt = now.toISOString();
  if (nextStatus === 'DECLINED') record.declinedAt = now.toISOString();
  if (nextStatus === 'CANCELLED') record.cancelledAt = now.toISOString();
  if (nextStatus === 'CONFIRMED') record.actionFlags = { ...(record.actionFlags ?? {}), airbnbBlocked: false };

  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    if (nextStatus === 'CANCELLED') await releaseCalendar(repo, record.reference);
    await audit(repo, principal, auditAction, record, {
      fromStatus,
      toStatus: nextStatus,
      reason,
      context
    });
    if (nextStatus === 'CONFIRMED' && body.sendGuestEmail === true) {
      await queueGuestConfirmation(repo, record, options, context);
    }
    return {
      status: 200,
      jsonBody: {
        reference: updated.record.reference,
        statusCode: nextStatus,
        status: record.status,
        etag: updated.etag,
        version: record.version
      }
    };
  } catch (cause) {
    if (lockedNights?.created) await releaseCalendar(repo, record.reference);
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

async function addNote(repo, principal, reference, body = {}, options = {}, context = {}) {
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const note = cleanString(body.note, 2000);
  if (!note) return error(400, 'Anteckningen får inte vara tom.', { fields: { note: 'Ange en anteckning.' } });
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  const now = options.now ?? new Date();
  const record = {
    ...raw.record,
    latestNote: note,
    version: Number(raw.record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actorOf(principal).name
  };
  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    await audit(repo, principal, 'NOTE_ADDED', record, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason: note,
      context
    });
    return { status: 200, jsonBody: { reference, etag: updated.etag, version: record.version } };
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

async function updatePayment(repo, principal, reference, body = {}, options = {}, context = {}) {
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const paymentStatus = String(body.paymentStatus ?? '').toUpperCase();
  if (!PAYMENT_STATUSES.has(paymentStatus)) {
    return error(400, 'Ange en giltig betalstatus.', { fields: { paymentStatus: 'Ogiltig betalstatus.' } });
  }
  let amountPaid = Number(body.amountPaid ?? raw.record.amountPaid ?? 0);
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    return error(400, 'Belopp mottaget måste vara 0 eller mer.', { fields: { amountPaid: 'Ogiltigt belopp.' } });
  }
  if (paymentStatus === 'PAID' && amountPaid === 0) amountPaid = Number(raw.record.total || 0);
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  const now = options.now ?? new Date();
  const record = {
    ...raw.record,
    paymentStatus,
    amountPaid,
    balance: balanceFor(raw.record.total, amountPaid, paymentStatus),
    version: Number(raw.record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actorOf(principal).name
  };
  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    await audit(repo, principal, 'PAYMENT_UPDATED', record, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason: cleanString(body.reason, 500),
      changes: { paymentStatus, amountPaid, balance: record.balance },
      context
    });
    return {
      status: 200,
      jsonBody: { reference, paymentStatus, amountPaid, balance: record.balance, etag: updated.etag }
    };
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

async function updateAddons(repo, principal, reference, body = {}, options = {}, context = {}) {
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const record = { ...raw.record };
  if (record.statusCode === 'BLOCKED') return error(422, 'Datumblockeringar har inga tillval.');
  const reason = cleanString(body.reason, 500);
  if (!reason) return error(400, 'Ange en ändringsorsak.', { fields: { reason: 'Orsak krävs.' } });
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  const addons = validAddons(body.addons, Number(record.guests || 0));
  const pricing = quote({
    arrival: record.arrival,
    departure: record.departure,
    guests: Number(record.guests || 0),
    addons
  });
  const originalPricing = record.originalPricing ?? pricingSnapshot(record);
  const total = record.agreedTotal !== null && record.agreedTotal !== undefined
    ? Number(record.agreedTotal)
    : pricing.total;
  const now = options.now ?? new Date();
  const updatedRecord = {
    ...record,
    addons,
    lodgingBase: pricing.lodgingBase,
    peakNights: pricing.peakNights,
    peakBase: pricing.peakBase,
    nightlyBreakdown: pricing.nightlyBreakdown,
    discount: pricing.discount,
    discountAmount: pricing.discountAmount,
    lodgingAfterDiscount: pricing.lodgingAfterDiscount,
    addonLines: pricing.addonLines,
    totalAddons: pricing.addonsTotal,
    calculatedTotal: pricing.total,
    total,
    originalPricing,
    priceVersion: pricing.priceVersion,
    balance: balanceFor(total, record.amountPaid, record.paymentStatus),
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actorOf(principal).name
  };
  try {
    const updated = await repo.updateRequest(updatedRecord, { ifMatch: raw.etag });
    await audit(repo, principal, 'ADDONS_UPDATED', updatedRecord, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason,
      changes: { addons, total, totalAddons: pricing.addonsTotal },
      context
    });
    return {
      status: 200,
      jsonBody: {
        reference,
        addons,
        totalAddons: pricing.addonsTotal,
        total,
        calculatedTotal: pricing.total,
        etag: updated.etag
      }
    };
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

async function removeBlock(repo, principal, reference, body = {}, options = {}, context = {}) {
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Blockeringen hittades inte.');
  if (raw.record.statusCode !== 'BLOCKED' && !/^BLOCK-/.test(raw.record.reference)) {
    return error(422, 'Posten är inte en datumblockering.');
  }
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Blockeringen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  await releaseCalendar(repo, raw.record.reference);
  try {
    await repo.deleteRequest(raw.record.rowKey ?? raw.record.idempotencyKey, { ifMatch: raw.etag });
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
  await audit(repo, principal, 'BLOCK_REMOVED', raw.record, {
    fromStatus: 'BLOCKED',
    toStatus: '',
    reason: cleanString(body.reason, 500),
    context
  });
  return { status: 200, jsonBody: { reference, removed: true } };
}

function buildGuestConfirmation(record) {
  const lines = [
    `Referens: ${record.reference}`,
    `Vistelse: ${record.arrival} → ${record.departure} (${record.nights} nätter)`,
    `Gäster: ${record.guests}`,
    `Totalpris: ${record.total} kr`
  ];
  return {
    mailType: 'GUEST_CONFIRMATION',
    to: record.email,
    replyTo: MAIL.replyTo,
    subject: `Din bokning är bekräftad (${record.reference})`,
    body: `Din bokning är nu bekräftad.\n\n${lines.join('\n')}`,
    html: `<h2>Din bokning är bekräftad</h2><ul>${lines
      .map((line) => `<li>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</li>`)
      .join('')}</ul>`
  };
}

async function queueGuestConfirmation(repo, record, options, context) {
  if (options.outboxEnabled !== true) return false;
  const notification = buildGuestConfirmation(record);
  try {
    await repo.saveOutbox({
      partition: 'outbox',
      idempotencyKey: `outbox-${record.idempotencyKey}-confirmation`,
      reference: record.reference,
      mailType: notification.mailType,
      status: 'Utkorg',
      mailTo: notification.to,
      mailReplyTo: notification.replyTo,
      mailSubject: notification.subject,
      mailHtml: notification.html,
      mailText: notification.body,
      attemptCount: 0,
      createdAt: new Date().toISOString()
    });
    return true;
  } catch {
    context.warn?.(`Bekräftelsemejl kunde inte köas för ${record.reference}.`);
    return false;
  }
}

async function calendarRange(repo, from, to, now = new Date()) {
  const calendar = await repo.listCalendar(from, to);
  const bookings = await repo.allBookings(now);
  const byNight = bucketByNight(calendar);
  const overlays = bookings.filter((booking) =>
    ['PENDING', 'PRELIMINARY'].includes(booking.statusCode) &&
    booking.arrival < to && booking.departure > from
  );
  return { from, to, nights: calendar, byNight, overlays, bookings };
}

module.exports = {
  MAX_GUESTS,
  MAX_NIGHTS,
  SOURCES,
  PAYMENT_STATUSES,
  validateManualBooking,
  createManualBooking,
  changeStatus,
  addNote,
  updatePayment,
  updateAddons,
  removeBlock,
  calendarRange,
  buildGuestConfirmation,
  queueGuestConfirmation,
  makeReference,
  makeIdempotencyKey,
  actorOf,
  pricingSnapshot,
  validAddons,
  balanceFor,
  assertConfirmable,
  lockCalendar,
  releaseCalendar,
  nightKeys
};
