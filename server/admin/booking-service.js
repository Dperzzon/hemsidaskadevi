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
const { quote, PRICE_VERSION, LINEN_MAX, EXTRAHUS_MAX_GUESTS } = require('../booking/pricing');
const { handleAvailability } = require('../calendar/availability');
const {
  bufferNightsFor,
  lockedNightsFor,
  lockedRange
} = require('../booking/buffer-nights');
const { checkAddonAvailability } = require('../booking/addon-availability');
const { buildBookingConfirmation, buildCancellationNotification, buildPaymentNotifications } = require('../booking/booking-mail');
const {
  queueNotification,
  confirmationOutboxKey,
  newConfirmationKey,
  updateEmailObligation
} = require('../booking/outbox');
const { revokePaymentAccess } = require('../booking/payment-access');
const { cancelOpenInvoiceRequests } = require('../booking/invoice-requests');
const {
  STATUS_META,
  todayKey,
  validDateKey,
  nightsBetween,
  nightKeys,
  normalizeBooking
} = require('./domain');
const {
  deriveWarnings,
  applyWarnings,
  findWarning,
  stayFingerprint
} = require('./warnings');
const {
  PAYMENT_METHOD_CODES,
  parseKronorToOre,
  normalizePayments,
  openingBalanceOreFor,
  computePaymentSummary
} = require('./payments');
const { checkResendDelivery } = require('./resend-delivery');

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

function extrahusAddonErrors(input, nights) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (source.extrahus !== true) return {};
  const errors = {};
  const count = Number(source.extrahusNights);
  if (!Number.isInteger(count) || count < 1 || count > nights) {
    errors.extrahusNights = `Ange antal extrahusnätter (1–${Math.max(1, nights)}).`;
  }
  const guests = Number(source.extrahusGuests);
  if (!Number.isInteger(guests) || guests < 1 || guests > EXTRAHUS_MAX_GUESTS) {
    errors.extrahusGuests = `Ange antal gäster i extrahuset (1–${EXTRAHUS_MAX_GUESTS}).`;
  }
  return errors;
}

function validAddons(input, guests, options = {}) {  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const lakan = source.lakan === true;
  const extrahus = source.extrahus === true;
  const mainNights = Math.max(0, Math.trunc(Number(options.nights) || 0));
  let extrahusNights = extrahus ? Math.trunc(Number(source.extrahusNights) || 0) : 0;
  if (extrahus) {
    if (mainNights > 0) extrahusNights = Math.min(Math.max(1, extrahusNights), mainNights);
    else extrahusNights = 0;
  }
  let extrahusGuests = extrahus ? Math.trunc(Number(source.extrahusGuests) || 0) : 0;
  if (extrahus) extrahusGuests = Math.min(Math.max(1, extrahusGuests), EXTRAHUS_MAX_GUESTS);
  let linenCount = lakan ? Number(source.linenCount) : 0;
  if (!Number.isFinite(linenCount)) linenCount = 0;
  const totalGuests = Math.max(0, Number(guests) || 0) + extrahusGuests;
  linenCount = Math.min(Math.max(0, Math.trunc(linenCount)), Math.min(LINEN_MAX, totalGuests));
  return {
    slutstad: source.slutstad === true,
    extrahus,
    extrahusNights,
    extrahusGuests,
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
    Object.assign(errors, extrahusAddonErrors(body.addons, dates.nights));
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

  if (Object.keys(errors).length) {
    return {
      errors,
      code: 'VALIDATION',
      message: 'Kontrollera uppgifterna i formuläret.'
    };
  }

  const addons = mode === 'booking'
    ? validAddons(body.addons, guests, { nights: dates.nights })
    : validAddons({}, 0);
  let pricing = null;
  if (mode === 'booking') {
    try {
      pricing = quote({ arrival: dates.arrival, departure: dates.departure, guests, addons });
    } catch {
      return {
        errors: { pricing: 'Prisberäkningen kunde inte genomföras.' },
        code: 'PRICE',
        message: 'Priset kunde inte beräknas. Kontrollera datum, gäster och tillval.'
      };
    }
  }
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
      bufferNightsMode: mode === 'block' ? 'manual' : 'auto',
      bufferNights: [],
      statusCode: mode === 'block' ? 'BLOCKED' : statusCode,
      status: statusLabel(mode === 'block' ? 'BLOCKED' : statusCode),
      addons,
      extrahus: pricing?.extrahus ?? { enabled: false, nights: 0, guests: 0, nightKeys: [] },
      totalGuests: pricing?.totalGuests ?? guests,
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
  const range = lockedRange(record) ?? { from: record.arrival, to: record.departure };
  return all.filter((booking) =>
    booking.reference !== excludeReference &&
    (booking.statusCode === 'CONFIRMED' || booking.statusCode === 'BLOCKED') &&
    booking.arrival < range.to &&
    booking.departure > range.from
  );
}

async function calendarConflicts(repo, record) {
  const range = lockedRange(record) ?? { from: record.arrival, to: record.departure };
  const rows = await repo.listCalendar(range.from, range.to);
  return rows.filter((row) => row.reference !== record.reference);
}

async function extrahusConflicts(repo, record) {
  if (record.extrahus?.enabled !== true || !Array.isArray(record.extrahus.nightKeys) || !record.extrahus.nightKeys.length) {
    return [];
  }
  if (typeof repo.listCalendarByResource !== 'function') return [];
  const rows = await repo.listCalendarByResource(
    'extrahus', record.extrahus.nightKeys[0], record.extrahus.departure
  );
  return rows.filter((row) => row.reference !== record.reference);
}

async function airbnbConflicts(record, options, context) {
  if (options.requireAirbnbCheck === false) return { blocked: [] };
  const handler = options.availabilityHandler ?? handleAvailability;
  const range = lockedRange(record) ?? { from: record.arrival, to: record.departure };
  let result;
  try {
    const query = new URLSearchParams({ start: range.from, end: range.to });
    result = await handler({ query }, context, options.availability ?? {});
  } catch {
    return { unavailable: true, blocked: [] };
  }
  if (result.status !== 200 || !Array.isArray(result.jsonBody?.blocked)) {
    return { unavailable: true, blocked: [] };
  }
  return {
    blocked: lockedNightsFor(record)
      .filter((night) => result.jsonBody.blocked.includes(night))
  };
}

function overrideRequest(body = {}) {
  return {
    intent: body.airbnbOverrideIntent === true,
    allowed: body.airbnbOverride === true,
    confirmed: body.airbnbOverrideConfirmed === true,
    reason: cleanString(body.airbnbOverrideReason, 500)
  };
}

async function assertConfirmable(repo, record, options, context, now, body = {}) {
  const override = overrideRequest(body);
  const calendar = await calendarConflicts(repo, record);
  if (calendar.length) {
    // Airbnb-override får aldrig kringgå interna kalenderlås.
    return {
      error: error(409, 'Datumen är redan blockerade i den interna kalendern.', {
        code: 'INTERNAL_CALENDAR_CONFLICT',
        conflicts: calendar.map((row) => row.night ?? row.RowKey)
      })
    };
  }
  const extrahusCalendar = await extrahusConflicts(repo, record);
  if (extrahusCalendar.length) {
    return {
      error: error(409, 'Extrahuset är redan bokat någon av de valda nätterna.', {
        code: 'EXTRAHUS_CALENDAR_CONFLICT',
        conflicts: extrahusCalendar.map((row) => row.night ?? row.RowKey)
      })
    };
  }
  const internal = await internalConflicts(repo, record, now, record.reference);
  if (internal.length) {
    return {
      error: error(409, 'Datumen överlappar en annan bekräftad bokning eller blockering.', {
        code: 'INTERNAL_BOOKING_CONFLICT',
        conflicts: internal.map((booking) => booking.reference)
      })
    };
  }
  const airbnb = await airbnbConflicts(record, options, context);
  if (airbnb.unavailable) {
    // Ett tekniskt fel är aldrig samma sak som en hämtad Airbnb-blockering.
    return {
      error: error(503, 'Airbnb-kalendern kunde inte hämtas eller tolkas. Bokningen har inte bekräftats och kan inte åsidosättas.', {
        code: 'AIRBNB_UNAVAILABLE'
      })
    };
  }
  if (airbnb.blocked.length) {
    if (!override.intent) {
      return {
        error: error(409, 'Några nätter är redan blockerade i Airbnb-kalendern. Markera att du själv blockerat datumen om det är din egen blockering.', {
          code: 'AIRBNB_CONFLICT',
          blockedNights: airbnb.blocked,
          requiresOverrideOption: true
        })
      };
    }
    if (!override.allowed || !override.confirmed || !override.reason) {
      return {
        error: error(409, 'Airbnb visar upptagna datum. Bekräfta åsidosättningen aktivt och ange en kort motivering.', {
          code: 'AIRBNB_CONFLICT',
          blockedNights: airbnb.blocked,
          requiresConfirmation: true
        })
      };
    }
    return {
      error: null,
      overrideApplied: true,
      blockedNights: airbnb.blocked
    };
  }
  return { error: null, overrideApplied: false, blockedNights: [] };
}

async function lockCalendar(repo, record, principal, now) {
  const created = [];
  const actor = actorOf(principal);
  const bufferSet = new Set(bufferNightsFor(record));
  const jobs = [
    { resource: 'main', nights: lockedNightsFor(record) },
    {
      resource: 'extrahus',
      nights: record.extrahus?.enabled === true && Array.isArray(record.extrahus.nightKeys)
        ? record.extrahus.nightKeys
        : []
    }
  ];
  // Nätter som redan ägs av samma referens (t.ex. en betalningsreservation
  // som ska bekräftas manuellt) återanvänds i stället för att skapas om.
  const existing = await repo.listCalendarByReference(record.reference).catch(() => []);
  const owned = new Set((existing ?? []).map((row) =>
    `${row.resource === 'extrahus' ? 'extrahus' : 'main'}:${row.night ?? row.RowKey}`));
  for (const job of jobs) {
    for (const night of job.nights) {
      if (owned.has(`${job.resource}:${night}`)) continue;
      try {
        await repo.createCalendarNight(night, {
          type: record.statusCode === 'BLOCKED' ? 'MANUAL' : 'BOOKING',
          kind: job.resource === 'main' && bufferSet.has(night) ? 'BUFFER' : 'STAY',
          reference: record.reference,
          blockId: record.blockId ?? '',
          source: record.bookingSource,
          note: record.latestNote ?? '',
          createdBy: actor.name,
          createdAt: now.toISOString()
        }, { resource: job.resource });
        created.push({ night, resource: job.resource });
      } catch (cause) {
        for (const inserted of [...created].reverse()) {
          await repo.deleteCalendarNight(inserted.night, record.reference, { resource: inserted.resource }).catch(() => {});
        }
        if (cause?.status === 409) {
          return error(409, 'Datumen är redan blockerade i den interna kalendern. Ingen delvis blockering sparades.', {
            code: 'INTERNAL_CALENDAR_CONFLICT',
            conflicts: [night]
          });
        }
        throw cause;
      }
    }
  }
  return { created };
}

const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 100;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseCalendar(repo, reference, options = {}) {
  let rows;
  try {
    rows = await repo.listCalendarByReference(reference);
  } catch (error) {
    options.warn?.(`Kalenderrader kunde inte läsas för ${reference}.`);
    return { released: [], failed: [], listingFailed: true, error };
  }
  const released = [];
  const failed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const night = row.night ?? row.RowKey;
    let lastError;
    let deleted = false;
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
      try {
        await repo.deleteCalendarNight(night, reference, { resource: row.resource });
        deleted = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < RELEASE_ATTEMPTS) {
          await wait(Number(options.retryDelayMs ?? RELEASE_RETRY_DELAY_MS) * (attempt + 1));
        }
      }
    }
    if (deleted) {
      released.push(night);
    } else {
      failed.push({
        night,
        resource: row.resource ?? 'main',
        reason: lastError?.message ?? 'delete_failed'
      });
    }
  }
  if (failed.length) {
    options.warn?.(
      `Kvarvarande kalenderblockeringar för ${reference}: ${failed.map((item) => item.night).join(', ')}`
    );
  }
  return { released, failed, listingFailed: false };
}

// Håller extrahusets kalenderrad i takt med att tillvalet ändras på en
// bekräftad bokning. Nya nätter skapas först när alla är lediga, därefter
// tas nätter som inte längre omfattas bort.
async function syncExtrahusCalendar(repo, record, existingRows, principal, now) {
  if (typeof repo.listCalendarByResource !== 'function') return { ok: true };
  const existing = (existingRows ?? []).filter((row) => row.resource === 'extrahus');
  const oldKeys = existing.map((row) => row.night ?? row.RowKey);
  const newKeys = record.extrahus?.enabled === true && Array.isArray(record.extrahus.nightKeys)
    ? record.extrahus.nightKeys
    : [];
  const newSet = new Set(newKeys);
  const oldSet = new Set(oldKeys);
  const actor = actorOf(principal);
  const created = [];
  for (const night of newKeys) {
    if (oldSet.has(night)) continue;
    try {
      await repo.createCalendarNight(night, {
        type: 'BOOKING',
        reference: record.reference,
        blockId: record.blockId ?? '',
        source: record.bookingSource,
        note: record.latestNote ?? '',
        createdBy: actor.name,
        createdAt: now.toISOString()
      }, { resource: 'extrahus' });
      created.push(night);
    } catch (cause) {
      for (const inserted of created) {
        await repo.deleteCalendarNight(inserted, record.reference, { resource: 'extrahus' }).catch(() => {});
      }
      if (cause?.status === 409) {
        return {
          ok: false,
          error: error(409, 'Extrahuset är redan bokat någon av de valda nätterna.', {
            code: 'EXTRAHUS_CALENDAR_CONFLICT',
            conflicts: [night]
          })
        };
      }
      throw cause;
    }
  }
  for (const night of oldKeys) {
    if (newSet.has(night)) continue;
    await repo.deleteCalendarNight(night, record.reference, { resource: 'extrahus' }).catch(() => {});
  }
  return { ok: true };
}

function existingBufferRows(record, rows) {
  const stay = new Set(nightKeys(record.arrival, record.departure));
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if ((row.resource ?? 'main') !== 'main') return false;
    if (String(row.kind ?? '').toUpperCase() === 'BUFFER') return true;
    return !stay.has(String(row.night ?? row.RowKey ?? ''));
  });
}

// Håller buffertraderna i takt med att tidig incheckning/sen utcheckning
// ändras på en bekräftad bokning. Nya buffertnätter skapas först när alla är
// lediga; därefter tas endast de buffertnätter bort som inte längre behövs.
// Vanliga boendenätter rörs aldrig.
async function syncBufferCalendar(repo, record, existingRows, principal, now) {
  if (record.bufferNightsMode !== 'auto') return { ok: true, skipped: 'manual' };
  const actor = actorOf(principal);
  const oldRows = existingBufferRows(record, existingRows);
  const oldKeys = oldRows.map((row) => String(row.night ?? row.RowKey));
  const newKeys = bufferNightsFor(record);
  const oldSet = new Set(oldKeys);
  const newSet = new Set(newKeys);
  const created = [];
  for (const night of newKeys) {
    if (oldSet.has(night)) continue;
    try {
      await repo.createCalendarNight(night, {
        type: 'BOOKING',
        kind: 'BUFFER',
        reference: record.reference,
        blockId: record.blockId ?? '',
        source: record.bookingSource,
        note: 'Kalenderbuffert för tillval (inte en debiterad övernattning)',
        createdBy: actor.name,
        createdAt: now.toISOString()
      }, { resource: 'main' });
      created.push(night);
    } catch (cause) {
      for (const inserted of created) {
        await repo.deleteCalendarNight(inserted, record.reference, { resource: 'main' }).catch(() => {});
      }
      if (cause?.status === 409) {
        return {
          ok: false,
          error: error(409, 'Buffertnatten är redan upptagen. Tillvalet kan inte bekräftas för valda datum.', {
            code: 'BUFFER_UNAVAILABLE',
            conflicts: [night]
          })
        };
      }
      throw cause;
    }
  }
  const deleted = [];
  for (const night of oldKeys) {
    if (newSet.has(night)) continue;
    try {
      await repo.deleteCalendarNight(night, record.reference, { resource: 'main' });
      deleted.push(night);
    } catch {
      // En kvarvarande buffert kan alltid kontrolleras manuellt i kalendern.
    }
  }
  return { ok: true, created, deleted };
}

async function warningContext(repo, record, now) {
  let calendarRows = [];
  let calendarUnavailable = false;
  try {
    calendarRows = await repo.listCalendar(record.arrival, record.departure);
  } catch {
    calendarRows = null;
    calendarUnavailable = true;
  }
  const calendarConflicts = Array.isArray(calendarRows)
    ? calendarRows.filter((row) => row.reference !== record.reference)
    : [];
  let internalConflicts = [];
  let internalUnavailable = false;
  try {
    const all = await repo.allBookings(now);
    internalConflicts = all.filter((booking) =>
      booking.reference !== record.reference &&
      (booking.statusCode === 'CONFIRMED' || booking.statusCode === 'BLOCKED') &&
      booking.arrival < record.departure &&
      booking.departure > record.arrival
    );
  } catch {
    internalConflicts = [];
    internalUnavailable = true;
  }
  return { calendarRows, calendarConflicts, internalConflicts, calendarUnavailable, internalUnavailable };
}

async function enrichWarnings(repo, booking, now) {
  const context = await warningContext(repo, booking, now);
  return applyWarnings(booking, { now, ...context });
}

async function acknowledgeWarning(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan hantera varningar.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const warningId = cleanString(body.warningId, 120);
  const reason = cleanString(body.reason, 500);
  if (!warningId) {
    return error(400, 'Välj en varning att hantera.', { fields: { warningId: 'Varning krävs.' } });
  }
  if (reason.length < 3) {
    return error(400, 'Ange en kort motivering till varför varningen är hanterad.', {
      fields: { reason: 'Motivering krävs.' }
    });
  }
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  const now = options.now ?? new Date();
  const record = { ...raw.record };
  let normalized = null;
  try { normalized = await repo.getBooking(reference, now); } catch { normalized = null; }
  if (!normalized) normalized = normalizeBooking(record, { now });
  const conflicts = await warningContext(repo, record, now);
  const warnings = deriveWarnings(normalized, { now, ...conflicts });
  const target = findWarning(warnings, warningId);
  if (!target) {
    return error(404, 'Varningen hittades inte eller gäller inte längre.', { code: 'WARNING_NOT_FOUND' });
  }
  if (target.severity === 'handled') {
    return error(409, 'Varningen är redan hanterad.', { code: 'WARNING_ALREADY_HANDLED' });
  }
  if (!target.dismissible) {
    return error(409, 'Den här varningen kan inte markeras som hanterad. Åtgärda orsaken i stället.', {
      code: 'WARNING_NOT_DISMISSIBLE',
      warningId,
      warningTitle: target.title
    });
  }
  const actor = actorOf(principal);
  const acknowledgement = {
    warningId,
    fingerprint: target.fingerprint,
    type: target.type,
    title: target.title,
    reason,
    actorId: actor.id,
    actorName: actor.name,
    at: now.toISOString()
  };
  const existing = Array.isArray(record.warningAcknowledgements) ? record.warningAcknowledgements : [];
  const acknowledgements = existing.filter((row) =>
    !(row && row.warningId === warningId && row.fingerprint === target.fingerprint)
  );
  acknowledgements.push(acknowledgement);
  record.warningAcknowledgements = acknowledgements.slice(-100);
  record.version = Number(record.version || 1) + 1;
  record.updatedAt = now.toISOString();
  record.updatedBy = actor.name;

  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    await audit(repo, principal, 'WARNING_ACKNOWLEDGED', record, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason,
      changes: {
        warningId,
        warningTitle: target.title,
        fingerprint: target.fingerprint,
        type: target.type
      },
      context
    });
    let after = null;
    try { after = await repo.getBooking(reference, now); } catch { after = null; }
    if (!after) after = normalizeBooking(record, { now });
    const afterWarnings = deriveWarnings(after, { now, ...conflicts });
    return {
      status: 200,
      jsonBody: {
        reference,
        warningId,
        acknowledged: true,
        etag: updated.etag,
        warnings: afterWarnings,
        unresolved: afterWarnings.filter((warning) => warning.severity !== 'handled').map((warning) => warning.id)
      }
    };
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

function stockholmTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function airbnbRecheckMessage(status, blockedNights, nights, checkedAt) {
  const time = stockholmTime(checkedAt);
  if (status === 'blocked') {
    return `Kalendern kontrollerad kl. ${time}. Blockeringen är verifierad i Airbnbs exporterade kalender.`;
  }
  if (status === 'partial') {
    return `Kalendern kontrollerad kl. ${time}. Endast ${blockedNights.length} av ${nights.length} nätter kunde verifieras i Airbnbs exporterade kalender.`;
  }
  if (status === 'available') {
    return `Kalendern kontrollerad kl. ${time}. Airbnbs exporterade kalender visar ingen blockering för bokningens nätter. Det kan bero på att Airbnb ännu inte hämtat den importerade kalendern, eller att importerade blockeringar inte syns i Airbnbs export. Kontrollera Airbnb manuellt.`;
  }
  return `Kontrollen kl. ${time} kunde inte läsa Airbnbs exporterade kalender. Status är därför okänd och ingen blockering kan verifieras automatiskt.`;
}

function mailVerificationMessage(results, checkedAt) {
  const time = stockholmTime(checkedAt);
  const entries = Object.entries(results);
  if (!entries.length) {
    return 'Ingen mejlpost med Resend-ID hittades i utkorgen. Leveransen kan därför inte kontrolleras automatiskt.';
  }
  const delivered = entries.filter(([, value]) => value.status === 'delivered');
  if (delivered.length === entries.length) {
    return `Resend bekräftar leverans. Kontrollerat kl. ${time}.`;
  }
  if (entries.some(([, value]) => value.status === 'permission_denied')) {
    return `Resend-nyckeln saknar behörighet att läsa leveransstatus (Sending access). Leveransen kan därför inte verifieras automatiskt. Kontrollera mejlet manuellt i Resend med angivet Resend-ID.`;
  }
  if (entries.some(([, value]) => value.status === 'not_configured')) {
    return `Automatisk leveranskontroll är inte aktiverad. API-nyckeln har Sending access och någon leveranswebhook är inte aktiverad. Mejlet accepterades av Resend men senare leveransstatus kan inte läsas via API. Kontrollera manuellt i Resend.`;
  }
  if (entries.some(([, value]) => ['bounced', 'failed', 'complained'].includes(value.status))) {
    return `Resend rapporterar att leveransen misslyckades. Kontrollerat kl. ${time}. Hantera mejlet manuellt.`;
  }
  return `Resend kunde inte lämna en slutlig leveransstatus. Kontrollerat kl. ${time}. Leveransen är fortfarande ej verifierad.`;
}

async function recheckWarning(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan kontrollera varningar igen.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const warningId = cleanString(body.warningId, 120);
  if (!warningId) {
    return error(400, 'Välj en varning att kontrollera.', { fields: { warningId: 'Varning krävs.' } });
  }
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.');
  }
  const now = options.now ?? new Date();
  const record = { ...raw.record };
  let normalized = null;
  try { normalized = await repo.getBooking(reference, now); } catch { normalized = null; }
  if (!normalized) normalized = normalizeBooking(record, { now });
  const conflicts = await warningContext(repo, record, now);
  const warnings = deriveWarnings(normalized, { now, ...conflicts });
  const target = findWarning(warnings, warningId);
  if (!target) {
    return error(404, 'Varningen hittades inte eller gäller inte längre.', { code: 'WARNING_NOT_FOUND' });
  }
  if (!target.recheckable) {
    return error(409, 'Den här varningen kan inte kontrolleras igen.', { code: 'WARNING_NOT_RECHECKABLE' });
  }
  if (!['AIRBNB', 'MAIL'].includes(target.type)) {
    return error(422, 'Den här varningstypen kan inte kontrolleras igen.', { code: 'RECHECK_UNSUPPORTED' });
  }

  const checkedAt = now.toISOString();
  const actor = actorOf(principal);
  let verification = null;
  let message = '';
  let outcome = '';

  if (target.type === 'AIRBNB') {
    const nights = nightKeys(record.arrival, record.departure);
    let status = 'unavailable';
    let blockedNights = [];
    let checkError = 'unavailable';
    try {
      const handler = options.availabilityHandler ?? handleAvailability;
      const query = new URLSearchParams({ start: record.arrival, end: record.departure });
      const result = await handler({ query }, context, options.availability ?? {});
      if (result.status === 200 && Array.isArray(result.jsonBody?.blocked)) {
        blockedNights = nights.filter((night) => result.jsonBody.blocked.includes(night));
        status = blockedNights.length === 0
          ? 'available'
          : (blockedNights.length === nights.length ? 'blocked' : 'partial');
        checkError = '';
      }
    } catch {
      status = 'unavailable';
      checkError = 'exception';
    }

    record.airbnbVerification = {
      status,
      blockedNights,
      checkedAt,
      checkedBy: actor.name,
      fingerprint: stayFingerprint(record),
      source: 'ical',
      error: checkError
    };
    // Endast en lyckad läsning som visar att alla nätter är blockerade får
    // sätta det verifierade blockdatet. Okänd eller tillgänglig kalender får
    // aldrig se ut som ett verifierat OK.
    if (status === 'blocked') {
      record.airbnbBlockedAt = checkedAt;
      record.actionFlags = { ...(record.actionFlags ?? {}), airbnbBlocked: true };
    } else {
      record.airbnbBlockedAt = '';
      record.actionFlags = { ...(record.actionFlags ?? {}), airbnbBlocked: false };
    }
    verification = record.airbnbVerification;
    outcome = status;
    message = airbnbRecheckMessage(status, blockedNights, nights, checkedAt);
  } else {
    // Mejlkontroll: läs befintlig utkorg och försök bara läsa leveransstatus
    // från Resend om rätt behörighet uttryckligen aktiverats. Ett 401/403
    // upprepas aldrig i onödan och påverkar aldrig bokningen.
    const levels = [
      { key: 'host', level: normalized.mailStatus?.host },
      { key: 'guest', level: normalized.mailStatus?.guest }
    ].filter(({ level }) => level && level.resendId &&
      (level.deliveryUnverified || level.deliveryFailed || level.pending));

    const results = { ...(record.mailVerification ?? {}) };
    for (const { key, level } of levels) {
      results[key] = await checkResendDelivery({
        ...(options.resendDelivery ?? {}),
        resendId: level.resendId
      });
    }
    record.mailVerification = results;
    verification = results;
    outcome = Object.values(results).map((value) => value?.status).filter(Boolean).join(',') || 'unavailable';
    message = mailVerificationMessage(
      Object.fromEntries(levels.map(({ key }) => [key, results[key]])),
      checkedAt
    );
  }

  record.version = Number(record.version || 1) + 1;
  record.updatedAt = checkedAt;
  record.updatedBy = actor.name;

  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    await audit(repo, principal, 'WARNING_RECHECKED', record, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason: cleanString(body.reason, 500),
      changes: { warningId, type: target.type, outcome, checkedAt },
      context
    });
    let after = null;
    try { after = await repo.getBooking(reference, now); } catch { after = null; }
    if (!after) after = normalizeBooking(record, { now });
    const afterWarnings = deriveWarnings(after, { now, ...conflicts });
    return {
      status: 200,
      jsonBody: {
        reference,
        warningId,
        type: target.type,
        verification,
        result: {
          type: target.type,
          status: outcome,
          checkedAt,
          message
        },
        etag: updated.etag,
        warnings: afterWarnings,
        unresolved: afterWarnings.filter((warning) => warning.severity !== 'handled').map((warning) => warning.id)
      }
    };
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
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
  if (cause?.status === 409) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
      code: 'STALE'
    });
  }
  if (cause?.status === 404) {
    return error(404, 'Bokningen hittades inte.', { code: 'NOT_FOUND' });
  }
  return null;
}

async function createManualBooking(repo, principal, body, options = {}, context = {}) {
  const now = options.now ?? new Date();
  const validated = validateManualBooking(body, now);
  if (validated.errors) {
    return error(400, validated.message ?? 'Kontrollera uppgifterna i formuläret.', {
      code: validated.code ?? 'VALIDATION',
      fields: validated.errors
    });
  }
  const idempotencyKey = makeIdempotencyKey(options.idempotencyKey);
  const rowKey = `${validated.mode === 'block' ? 'block' : 'manual'}-${idempotencyKey}`;
  // Samma Idempotency-Key används vid Airbnb-override och vid omförsök efter
  // ett osäkert svar. Det förhindrar dubbletter och återanvänder en eventuell
  // redan sparad bokning i stället för att skapa en ny.
  const existing = await repo.findByIdempotencyKey(rowKey).catch(() => null);
  if (existing) {
    return {
      status: 200,
      jsonBody: {
        reference: existing.reference,
        statusCode: existing.statusCode,
        duplicate: true,
        message: 'Bokningen fanns redan och återanvändes. Ingen dubblett skapades.'
      }
    };
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
    bufferNightsMode: validated.record.bufferNightsMode ?? 'manual',
    bufferNights: [],
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    updatedBy: actor.name,
    confirmedAt: validated.record.statusCode === 'CONFIRMED' ? now.toISOString() : '',
    declinedAt: '',
    cancelledAt: '',
    airbnbBlockedAt: '',
    airbnbOverride: false,
    airbnbOverrideReason: '',
    airbnbOverrideApprovedBy: '',
    airbnbOverrideApprovedAt: '',
    airbnbOverrideFingerprint: '',
    airbnbBlockedNights: [],
    airbnbVerification: null,
    warningAcknowledgements: [],
    overlaps: []
  };

  let locked = null;
  let overrideAudit = null;
  if (record.statusCode === 'CONFIRMED' || record.statusCode === 'BLOCKED') {
    if (record.statusCode === 'CONFIRMED') {
      record.bufferNights = bufferNightsFor(record);
      const confirmable = await assertConfirmable(repo, record, options, context, now, body);
      if (confirmable.error) return confirmable.error;
      if (confirmable.overrideApplied) {
        const actor = actorOf(principal);
        record.airbnbOverride = true;
        record.airbnbOverrideReason = cleanString(body.airbnbOverrideReason, 500);
        record.airbnbOverrideApprovedBy = actor.name;
        record.airbnbOverrideApprovedAt = now.toISOString();
        record.airbnbBlockedNights = confirmable.blockedNights;
        record.airbnbOverrideFingerprint = stayFingerprint(record);
        overrideAudit = {
          reason: record.airbnbOverrideReason,
          blockedNights: confirmable.blockedNights
        };
      }
    }
    if (record.statusCode === 'BLOCKED') {
      const calendar = await calendarConflicts(repo, record);
      if (calendar.length) {
        return error(409, 'Datumen är redan blockerade i den interna kalendern.', {
          code: 'INTERNAL_CALENDAR_CONFLICT',
          conflicts: calendar.map((row) => row.night ?? row.RowKey)
        });
      }
      const internal = await internalConflicts(repo, record, now, record.reference);
      if (internal.length) {
        return error(409, 'Datumen överlappar en intern bokning.', {
          code: 'INTERNAL_BOOKING_CONFLICT',
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
      changes: overrideAudit ? { airbnbOverride: overrideAudit } : {},
      context
    });
    if (overrideAudit) {
      await audit(repo, principal, 'AIRBNB_OVERRIDE_APPROVED', record, {
        toStatus: record.statusCode,
        reason: overrideAudit.reason,
        changes: { blockedNights: overrideAudit.blockedNights },
        context
      });
    }
    let email = { queued: false };
    if (validated.mode === 'booking' && body.sendGuestEmail === true) {
      email = await queueGuestConfirmation(repo, record, options, context);
    }
    return {
      status: 201,
      jsonBody: {
        reference: record.reference,
        statusCode: record.statusCode,
        total: record.total,
        arrival: record.arrival,
        departure: record.departure,
        emailQueued: email.queued === true,
        emailDisabled: email.disabled === true,
        emailDuplicate: email.duplicate === true,
        emailSkipped: email.skipped ?? '',
        emailWarning: email.ok === false && !email.skipped
          ? 'Mejlet kunde inte köas. Kontrollera historiken.'
          : ''
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
  let overrideAudit = null;

  if (action === 'approve' || action === 'preliminary') {
    if (fromStatus !== 'PENDING') return error(422, 'Endast en väntande förfrågan kan godkännas som preliminär.');
    nextStatus = 'PRELIMINARY';
  } else if (action === 'decline') {
    if (!['PENDING', 'PRELIMINARY'].includes(fromStatus)) return error(422, 'Bokningen kan inte nekas från nuvarande status.');
    if (!reason) return error(400, 'Ange en orsak till att förfrågan nekas.', { fields: { reason: 'Orsak krävs.' } });
    nextStatus = 'DECLINED';
  } else if (action === 'confirm') {
    if (!['PENDING', 'PRELIMINARY', 'RECONCILIATION'].includes(fromStatus)) return error(422, 'Endast väntande, preliminär eller avstämningskrävande bokning kan bekräftas.');
    const confirmable = await assertConfirmable(repo, record, options, context, now, body);
    if (confirmable.error) return confirmable.error;
    if (confirmable.overrideApplied) {
      const actor = actorOf(principal);
      record.airbnbOverride = true;
      record.airbnbOverrideReason = cleanString(body.airbnbOverrideReason, 500);
      record.airbnbOverrideApprovedBy = actor.name;
      record.airbnbOverrideApprovedAt = now.toISOString();
      record.airbnbBlockedNights = confirmable.blockedNights;
      record.airbnbOverrideFingerprint = stayFingerprint(record);
      overrideAudit = {
        reason: record.airbnbOverrideReason,
        blockedNights: confirmable.blockedNights
      };
    }
    lockedNights = await lockCalendar(repo, record, principal, now);
    if (lockedNights?.status) return lockedNights;
    nextStatus = 'CONFIRMED';
  } else if (action === 'cancel') {
    if (!['CONFIRMED', 'RECONCILIATION'].includes(fromStatus)) return error(422, 'Endast en bekräftad eller avstämningskrävande bokning kan avbokas.');
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
  if (nextStatus === 'CONFIRMED' && !record.confirmationKey) {
    record.confirmationKey = newConfirmationKey();
  }
  if (nextStatus === 'CONFIRMED') record.reconciliationRequest = null;
  if (nextStatus === 'CONFIRMED') record.paymentReview = null;
  if (nextStatus === 'CONFIRMED') record.bufferNights = bufferNightsFor(record);
  if (nextStatus === 'CONFIRMED') record.reconciliation = null;
  if (nextStatus === 'CONFIRMED' && record.reservation) {
    record.reservation = { ...record.reservation, status: 'CONFIRMED', confirmedAt: now.toISOString() };
  }
  if (nextStatus === 'CANCELLED' && record.reservation) {
    record.reservation = { ...record.reservation, status: 'RELEASED', releasedAt: now.toISOString() };
  }
  if (nextStatus === 'DECLINED') record.declinedAt = now.toISOString();
  if (nextStatus === 'CANCELLED') record.cancelledAt = now.toISOString();
  if (nextStatus === 'CONFIRMED') record.actionFlags = { ...(record.actionFlags ?? {}), airbnbBlocked: false };
  if (nextStatus !== 'CONFIRMED') {
    revokePaymentAccess(record, { now, reason: `Status ändrad till ${nextStatus}` });
    cancelOpenInvoiceRequests(record, {
      now,
      reason,
      actorName: actorOf(principal).name
    });
  }

  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    let calendarRelease = null;
    if (nextStatus === 'CANCELLED') {
      calendarRelease = await releaseCalendar(repo, record.reference, { warn: context.warn });
      if (calendarRelease.failed.length || calendarRelease.listingFailed) {
        await audit(repo, principal, 'CALENDAR_RELEASE_FAILED', record, {
          fromStatus,
          toStatus: nextStatus,
          reason: 'Kalenderblockeringar kunde inte tas bort fullständigt.',
          changes: {
            failedNights: calendarRelease.failed.map((item) => item.night),
            listingFailed: calendarRelease.listingFailed === true
          },
          context
        });
      }
    }
    await audit(repo, principal, auditAction, record, {
      fromStatus,
      toStatus: nextStatus,
      reason,
      changes: overrideAudit ? { airbnbOverride: overrideAudit } : {},
      context
    });
    if (overrideAudit) {
      await audit(repo, principal, 'AIRBNB_OVERRIDE_APPROVED', record, {
        fromStatus,
        toStatus: nextStatus,
        reason: overrideAudit.reason,
        changes: { blockedNights: overrideAudit.blockedNights },
        context
      });
    }
    let email = { queued: false };
    let cancelledPending = 0;
    if (nextStatus !== 'CONFIRMED') {
      cancelledPending = await cancelPendingOutbox(
        repo,
        record,
        ['GUEST_BOOKING_CONFIRMED', 'GUEST_CONFIRMATION', 'GUEST_PAYMENT_LINK'],
        `Status ändrad till ${nextStatus}`,
        context,
        now
      );
    }
    if (nextStatus === 'CONFIRMED' && body.sendGuestEmail === true) {
      email = await queueGuestConfirmation(repo, record, options, context);
    }
    if (nextStatus === 'CANCELLED') {
      email = await queueCancellation(repo, record, options, context);
    }
    return {
      status: 200,
      jsonBody: {
        reference: updated.record.reference,
        statusCode: nextStatus,
        status: record.status,
        etag: updated.etag,
        version: record.version,
        emailQueued: email.queued === true,
        emailDisabled: email.disabled === true,
        emailDuplicate: email.duplicate === true,
        emailSkipped: email.skipped ?? '',
        emailWarning: email.ok === false && !email.skipped
          ? 'Mejlet kunde inte köas. Kontrollera historiken.'
          : '',
        calendarReleaseWarning: calendarRelease && (calendarRelease.failed.length || calendarRelease.listingFailed)
          ? 'En eller flera kalenderblockeringar kunde inte tas bort. Kontrollera kalendern och frigör datum manuellt.'
          : '',
        calendarReleaseFailedNights: calendarRelease
          ? calendarRelease.failed.map((item) => item.night)
          : [],
        cancelledPendingMail: cancelledPending
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
  if (Array.isArray(raw.record.payments) && raw.record.payments.length > 0) {
    return error(409, 'Bokningen har en betalningshistorik. Registrera en rättelse i stället så att historiken bevaras.', {
      code: 'PAYMENT_LEDGER_ACTIVE'
    });
  }
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
  if (record.balance <= 0 && paymentStatus === 'PAID') {
    revokePaymentAccess(record, { now, reason: 'Bokningen är fullbetald' });
  }
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

function validatePaymentInput(body, now) {
  const errors = {};
  const amountOre = parseKronorToOre(body.amount ?? body.amountKronor);
  if (amountOre === null || amountOre <= 0) {
    errors.amount = 'Ange ett belopp större än 0 kr med högst två decimaler.';
  }
  const method = String(body.method ?? body.paymentMethod ?? '').toUpperCase();
  if (!PAYMENT_METHOD_CODES.includes(method)) {
    errors.method = 'Välj ett giltigt betalningssätt.';
  }
  const paymentDate = cleanString(body.paymentDate ?? body.date, 10);
  if (!validDateKey(paymentDate)) {
    errors.paymentDate = 'Ange ett giltigt betalningsdatum.';
  } else if (paymentDate > todayKey(now)) {
    errors.paymentDate = 'Betalningsdatum får inte vara i framtiden.';
  }
  const reference = cleanString(body.reference ?? body.referenceText, 500);
  const note = cleanString(body.note, 1000);
  return { errors, amountOre, method, paymentDate, reference, note };
}

function paymentSummaryBody(summary) {
  return {
    total: backToKronor(summary.totalOre),
    totalOre: summary.totalOre,
    amountPaid: summary.amountPaid,
    amountPaidOre: summary.paidOre,
    remaining: backToKronor(summary.remainingOre),
    remainingOre: summary.remainingOre,
    overpaid: summary.overpaid,
    overpaidOre: summary.overpaidOre,
    paymentStatus: summary.paymentStatus,
    paymentLabel: summary.paymentLabel
  };
}

function backToKronor(ore) {
  return Number(ore || 0) / 100;
}

function newPaymentId() {
  return `pay-${crypto.randomUUID()}`;
}

async function recordPayment(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan registrera betalningar.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const now = options.now ?? new Date();
  const record = { ...raw.record };
  if (record.statusCode === 'BLOCKED' || /^BLOCK-/.test(String(record.reference ?? ''))) {
    return error(422, 'Datumblockeringar har inga betalningar.', { code: 'PAYMENT_NOT_AVAILABLE' });
  }
  const payments = normalizePayments(record);
  const idempotencyKey = cleanString(options.idempotencyKey ?? body.idempotencyKey, 80);
  if (!idempotencyKey || !/^[A-Za-z0-9-]{8,80}$/.test(idempotencyKey)) {
    return error(400, 'Betalningen saknar en giltig idempotensnyckel. Ladda om sidan och försök igen.', {
      code: 'IDEMPOTENCY_REQUIRED',
      fields: { idempotencyKey: 'Idempotensnyckel krävs.' }
    });
  }
  // En upprepad klickning eller ett omförsök med samma nyckel får aldrig
  // skapa en ny betalningspost. Kontrollen sker före ETag så att ett osäkert
  // första svar kan återanvändas.
  const duplicate = payments.find((payment) => payment.idempotencyKey === idempotencyKey);
  if (duplicate) {
    const summary = computePaymentSummary(record);
    return {
      status: 200,
      jsonBody: {
        reference,
        duplicate: true,
        payment: duplicate,
        etag: raw.etag,
        ...paymentSummaryBody(summary)
      }
    };
  }
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
      code: 'STALE'
    });
  }
  const input = validatePaymentInput(body, now);
  if (Object.keys(input.errors).length) {
    return error(400, 'Kontrollera betalningsuppgifterna.', {
      code: 'VALIDATION',
      fields: input.errors
    });
  }
  const actor = actorOf(principal);
  const entry = {
    id: newPaymentId(),
    type: 'PAYMENT',
    amountOre: input.amountOre,
    paymentDate: input.paymentDate,
    method: input.method,
    reference: input.reference,
    note: input.note,
    reason: '',
    createdBy: actor.name,
    createdById: actor.id,
    createdAt: now.toISOString(),
    idempotencyKey,
    correctsPaymentId: ''
  };
  record.paymentOpeningBalanceOre = openingBalanceOreFor(record, payments);
  record.payments = [...payments, entry];
  const summary = computePaymentSummary(record);
  record.amountPaid = summary.amountPaid;
  record.balance = summary.balance;
  record.paymentStatus = summary.paymentStatus;
  if (summary.remainingOre <= 0) {
    revokePaymentAccess(record, { now, reason: 'Bokningen är fullbetald' });
  }
  record.version = Number(record.version || 1) + 1;
  record.updatedAt = now.toISOString();
  record.updatedBy = actor.name;

  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    await audit(repo, principal, 'PAYMENT_RECORDED', record, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason: cleanString(input.reference || input.note, 500),
      changes: {
        paymentId: entry.id,
        amountOre: entry.amountOre,
        paymentDate: entry.paymentDate,
        method: entry.method,
        totalPaidOre: summary.paidOre,
        remainingOre: summary.remainingOre,
        paymentStatus: summary.paymentStatus
      },
      context
    });
    return {
      status: 201,
      jsonBody: {
        reference,
        payment: entry,
        etag: updated.etag,
        ...paymentSummaryBody(summary)
      }
    };
  } catch (cause) {
    const mapped = normalizeRepoError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

async function correctPayment(repo, principal, reference, paymentId, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan rätta betalningar.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const now = options.now ?? new Date();
  const record = { ...raw.record };
  const payments = normalizePayments(record);
  const target = payments.find((payment) => payment.id === paymentId && payment.type === 'PAYMENT');
  if (!target) return error(404, 'Betalningen hittades inte.');
  const idempotencyKey = cleanString(options.idempotencyKey ?? body.idempotencyKey, 80) ||
    `correction-${target.id}`;
  const duplicate = payments.find((payment) =>
    payment.type === 'CORRECTION' && payment.idempotencyKey === idempotencyKey
  );
  if (duplicate) {
    const summary = computePaymentSummary(record);
    return {
      status: 200,
      jsonBody: {
        reference,
        duplicate: true,
        correction: duplicate,
        etag: raw.etag,
        ...paymentSummaryBody(summary)
      }
    };
  }
  const alreadyCorrected = payments.some((payment) =>
    payment.type === 'CORRECTION' && payment.correctsPaymentId === target.id
  );
  if (alreadyCorrected) {
    return error(409, 'Betalningen är redan rättad. Historiken behålls och kan inte raderas.', {
      code: 'PAYMENT_ALREADY_CORRECTED'
    });
  }
  const reason = cleanString(body.reason, 500);
  if (reason.length < 3) {
    return error(400, 'Ange en obligatorisk motivering till rättelsen.', {
      code: 'VALIDATION',
      fields: { reason: 'Motivering krävs.' }
    });
  }
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
      code: 'STALE'
    });
  }
  const actor = actorOf(principal);
  const entry = {
    id: newPaymentId(),
    type: 'CORRECTION',
    amountOre: -target.amountOre,
    paymentDate: todayKey(now),
    method: 'CORRECTION',
    reference: target.reference,
    note: '',
    reason,
    createdBy: actor.name,
    createdById: actor.id,
    createdAt: now.toISOString(),
    idempotencyKey,
    correctsPaymentId: target.id
  };
  record.paymentOpeningBalanceOre = openingBalanceOreFor(record, payments);
  record.payments = [...payments, entry];
  const summary = computePaymentSummary(record);
  record.amountPaid = summary.amountPaid;
  record.balance = summary.balance;
  record.paymentStatus = summary.paymentStatus;
  if (summary.remainingOre <= 0) {
    revokePaymentAccess(record, { now, reason: 'Bokningen är fullbetald' });
  }
  record.version = Number(record.version || 1) + 1;
  record.updatedAt = now.toISOString();
  record.updatedBy = actor.name;

  try {
    const updated = await repo.updateRequest(record, { ifMatch: raw.etag });
    await audit(repo, principal, 'PAYMENT_CORRECTED', record, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason,
      changes: {
        correctionId: entry.id,
        correctsPaymentId: target.id,
        amountOre: entry.amountOre,
        totalPaidOre: summary.paidOre,
        remainingOre: summary.remainingOre,
        paymentStatus: summary.paymentStatus
      },
      context
    });
    return {
      status: 201,
      jsonBody: {
        reference,
        correction: entry,
        etag: updated.etag,
        ...paymentSummaryBody(summary)
      }
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
  const extrahusErrors = extrahusAddonErrors(body.addons, Number(record.nights || 0));
  if (Object.keys(extrahusErrors).length) {
    return error(400, 'Kontrollera extrahusets uppgifter.', { fields: extrahusErrors });
  }
  const addons = validAddons(body.addons, Number(record.guests || 0), { nights: Number(record.nights || 0) });
  const pricing = quote({
    arrival: record.arrival,
    departure: record.departure,
    guests: Number(record.guests || 0),
    addons
  });
  const now = options.now ?? new Date();
  const originalPricing = record.originalPricing ?? pricingSnapshot(record);
  const total = record.agreedTotal !== null && record.agreedTotal !== undefined
    ? Number(record.agreedTotal)
    : pricing.total;
  const enableAuto = body.enableAutomaticBufferNights === true &&
    Array.isArray(principal?.roles) && principal.roles.includes('Owner');
  const bufferNightsMode = record.bufferNightsMode === 'auto' || enableAuto ? 'auto' : 'manual';
  const updatedRecord = {
    ...record,
    addons,
    extrahus: pricing.extrahus,
    bufferNightsMode,
    bufferNights: [],
    totalGuests: pricing.totalGuests,
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
  updatedRecord.bufferNights = bufferNightsFor(updatedRecord);
  const neededBuffers = bufferNightsFor({ ...updatedRecord, bufferNightsMode: 'auto' });
  const bufferNightsWarning = bufferNightsMode === 'manual' && neededBuffers.length
    ? 'Bokningen är äldre och använder manuella spärrar. Aktivera automatiska buffertnätter (enableAutomaticBufferNights) efter kontrollerad konfliktkontroll.'
    : '';

  let bufferOverrideAudit = null;
  if (record.statusCode === 'CONFIRMED') {
    const existingCalendar = await repo.listCalendarByReference(record.reference).catch(() => []);
    const extrahusSync = await syncExtrahusCalendar(repo, updatedRecord, existingCalendar, principal, now);
    if (!extrahusSync.ok) return extrahusSync.error;

    if (bufferNightsMode === 'auto') {
      const bufferCheck = await checkAddonAvailability(repo, updatedRecord, options, context);
      if (!bufferCheck.ok) {
        if (bufferCheck.internalUnavailable || bufferCheck.airbnbUnavailable) {
          return error(503, 'Buffertnätternas tillgänglighet kunde inte verifieras. Tillvalet har inte bekräftats.', {
            code: 'BUFFER_UNAVAILABLE'
          });
        }
        if (bufferCheck.internalConflicts.length) {
          return error(409, 'Buffertnatten är redan upptagen i den interna kalendern. Tillvalet kan inte bekräftas.', {
            code: 'BUFFER_UNAVAILABLE',
            conflicts: bufferCheck.internalConflicts
          });
        }
        if (bufferCheck.airbnbConflicts.length) {
          const override = overrideRequest(body);
          if (!override.intent) {
            return error(409, 'Buffertnatten är blockerad i Airbnb-kalendern. Markera att du själv blockerat datumet om det är din egen blockering.', {
              code: 'AIRBNB_CONFLICT',
              blockedNights: bufferCheck.airbnbConflicts,
              requiresOverrideOption: true
            });
          }
          if (!override.allowed || !override.confirmed || !override.reason) {
            return error(409, 'Airbnb visar upptagna buffertdatum. Bekräfta åsidosättningen aktivt och ange en motivering.', {
              code: 'AIRBNB_CONFLICT',
              blockedNights: bufferCheck.airbnbConflicts,
              requiresConfirmation: true
            });
          }
          const actor = actorOf(principal);
          updatedRecord.airbnbOverride = true;
          updatedRecord.airbnbOverrideReason = override.reason;
          updatedRecord.airbnbOverrideApprovedBy = actor.name;
          updatedRecord.airbnbOverrideApprovedAt = now.toISOString();
          updatedRecord.airbnbBlockedNights = bufferCheck.airbnbConflicts;
          updatedRecord.airbnbOverrideFingerprint = stayFingerprint(updatedRecord);
          bufferOverrideAudit = {
            reason: override.reason,
            blockedNights: bufferCheck.airbnbConflicts
          };
        } else {
          return error(409, 'Tillvalet kan inte bekräftas för valda datum eftersom buffertnatten är upptagen.', {
            code: 'BUFFER_UNAVAILABLE'
          });
        }
      }
      const bufferSync = await syncBufferCalendar(repo, updatedRecord, existingCalendar, principal, now);
      if (!bufferSync.ok) return bufferSync.error;
    }
  }
  const addonsChanged = JSON.stringify(record.addons ?? null) !== JSON.stringify(addons);
  if ((addonsChanged || Number(record.total) !== Number(total)) && updatedRecord.paymentAccess) {
    revokePaymentAccess(updatedRecord, {
      now,
      reason: 'Tillval eller pris ändrades'
    });
  }
  if (addonsChanged || Number(record.total) !== Number(total)) {
    cancelOpenInvoiceRequests(updatedRecord, {
      now,
      reason: 'Tillval eller pris ändrades',
      actorName: actorOf(principal).name
    });
  }
  try {
    const updated = await repo.updateRequest(updatedRecord, { ifMatch: raw.etag });
    await audit(repo, principal, 'ADDONS_UPDATED', updatedRecord, {
      fromStatus: record.statusCode,
      toStatus: record.statusCode,
      reason,
      changes: {
        addons,
        total,
        totalAddons: pricing.addonsTotal,
        bufferNightsMode,
        bufferNights: updatedRecord.bufferNights
      },
      context
    });
    if (bufferOverrideAudit) {
      await audit(repo, principal, 'AIRBNB_OVERRIDE_APPROVED', updatedRecord, {
        fromStatus: record.statusCode,
        toStatus: record.statusCode,
        reason: bufferOverrideAudit.reason,
        changes: {
          scope: 'buffer-nights',
          blockedNights: bufferOverrideAudit.blockedNights
        },
        context
      });
    }
    const cancelledPendingMail = addonsChanged || Number(record.total) !== Number(total)
      ? await cancelPendingOutbox(
        repo,
        updatedRecord,
        ['GUEST_PAYMENT_LINK', 'GUEST_BOOKING_CONFIRMED'],
        'Tillval eller pris ändrades',
        context,
        now
      )
      : 0;
    return {
      status: 200,
      jsonBody: {
        reference,
        addons,
        totalAddons: pricing.addonsTotal,
        total,
        calculatedTotal: pricing.total,
        bufferNightsMode,
        bufferNights: updatedRecord.bufferNights,
        bufferNightsWarning,
        etag: updated.etag,
        cancelledPendingMail
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
  return buildBookingConfirmation(record, { mailType: 'GUEST_CONFIRMATION' });
}

async function queueGuestConfirmation(repo, record, options, context) {
  if (record?.statusCode !== 'CONFIRMED') {
    return { ok: false, queued: false, skipped: 'not_confirmed' };
  }
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const notification = buildGuestConfirmation(record);
  const outboxContext = {
    ...context,
    appendHistory: typeof repo.appendHistory === 'function'
      ? (entry) => repo.appendHistory(entry)
      : undefined
  };
  const result = await queueNotification(
    (entry) => repo.saveOutbox(entry),
    {
      idempotencyKey: confirmationOutboxKey(record),
      reference: record.reference,
      notification,
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
  return { ...result, queued: result.ok === true && result.duplicate !== true };
}

async function retryBookingNotifications(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan köa om bokningsmejl.');
  }
  if (options.outboxEnabled !== true) {
    return error(503, 'Mejlutskick är inte aktiverat i denna miljö.', { code: 'OUTBOX_DISABLED' });
  }
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const record = raw.record;
  if (record.statusCode !== 'CONFIRMED') {
    return error(422, 'Endast en bekräftad bokning kan få bekräftelsemejl.', { code: 'NOT_CONFIRMED' });
  }
  const store = {
    ...repo,
    save: (entry, saveOptions) => repo.saveOutbox(entry, saveOptions)
  };
  const now = options.now ?? new Date();
  const guest = await queueGuestConfirmation(repo, record, options, context);
  let host = null;
  const payments = Array.isArray(record.payments)
    ? [...record.payments].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    : [];
  const payment = payments[payments.length - 1];
  if (payment?.stripeSessionId) {
    const summary = computePaymentSummary(record);
    const notification = buildPaymentNotifications(record, payment, summary, {}).host;
    host = await queueNotification(
      (entry) => repo.saveOutbox(entry),
      {
        idempotencyKey: `outbox-stripe-${payment.stripeSessionId}-host`,
        reference: record.reference,
        notification,
        createdAt: now.toISOString(),
        context
      }
    );
  }
  const obligation = await updateEmailObligation(store, reference, { guest, host }, {
    ...options,
    now,
    updatedBy: actorOf(principal).name
  }, context);
  await audit(repo, principal, 'NOTIFICATIONS_RETRIED', record, {
    reason: cleanString(body.reason, 500),
    changes: {
      guestQueued: guest?.ok === true,
      guestDuplicate: guest?.duplicate === true,
      hostQueued: host?.ok === true,
      hostDuplicate: host?.duplicate === true
    }
  }, context);
  if (guest?.ok !== true || (host && host.ok !== true) || obligation.ok !== true) {
    return error(503, 'Ett eller flera mejl kunde inte köas. Försök igen om en stund.', {
      code: 'OUTBOX_QUEUE_FAILED'
    });
  }
  return {
    status: 200,
    jsonBody: {
      reference,
      guestQueued: guest.queued === true,
      guestDuplicate: guest.duplicate === true,
      hostQueued: host?.queued === true,
      hostDuplicate: host?.duplicate === true,
      message: 'Bekräftelsemejlen ligger i utkorgen.'
    }
  };
}

async function cancelPendingOutbox(repo, record, mailTypes, reason, context, now = new Date()) {
  if (typeof repo.cancelPendingOutbox !== 'function') return 0;
  try {
    return await repo.cancelPendingOutbox(record.reference, { mailTypes, reason, now });
  } catch {
    context.warn?.(`Väntande utkorgsposter kunde inte makuleras för ${record.reference}.`);
    return 0;
  }
}

async function queueCancellation(repo, record, options, context) {
  if (record?.statusCode !== 'CANCELLED') {
    return { ok: false, queued: false, skipped: 'not_cancelled' };
  }
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const outboxContext = {
    ...context,
    appendHistory: typeof repo.appendHistory === 'function'
      ? (entry) => repo.appendHistory(entry)
      : undefined
  };
  const result = await queueNotification(
    (entry) => repo.saveOutbox(entry),
    {
      idempotencyKey: `outbox-cancellation-${record.reference}-v${Number(record.version || 1)}`,
      reference: record.reference,
      notification: buildCancellationNotification(record),
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
  return { ...result, queued: result.ok === true && result.duplicate !== true };
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
  recordPayment,
  correctPayment,
  updateAddons,
  removeBlock,
  calendarRange,
  buildGuestConfirmation,
  queueGuestConfirmation,
  retryBookingNotifications,
  queueCancellation,
  makeReference,
  makeIdempotencyKey,
  actorOf,
  pricingSnapshot,
  validAddons,
  balanceFor,
  assertConfirmable,
  lockCalendar,
  releaseCalendar,
  warningContext,
  enrichWarnings,
  acknowledgeWarning,
  recheckWarning,
  nightKeys
};
