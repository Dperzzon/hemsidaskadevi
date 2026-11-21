'use strict';

// Direktbokning med kortbetalning på den publika webbplatsen.
//
// Flödet är medvetet fail-closed:
//   1. Feature-flaggan DIRECT_BOOKING_ENABLED måste vara '1'.
//   2. Bokningsreglerna måste vara publicerade.
//   3. Intern kalender, datumblockeringar och aktiva reservationer kontrolleras.
//   4. Airbnb-kalendern måste hämtas och tolkas utan fel och utan blockerade nätter.
//   5. Först därefter skapas en atomisk nattreservation.
//   6. Stripe Checkout skapas först när reservationen finns.
//
// Airbnb iCal är inte en realtidskälla. Ett lyckat iCal-svar är därför inte en
// garanti mot dubbelbokning. Direktbokning får inte aktiveras i produktion för
// Airbnb-delade datum utan ett uttryckligen godkänt beslut om kvarstående risk.

const crypto = require('node:crypto');
const { Temporal } = require('temporal-polyfill');
const { handleAvailability } = require('../calendar/availability');
const { loadRules } = require('./rules');
const { createStore } = require('./store');
const {
  validatePayload,
  nightKeys,
  createRateLimiter,
  makeReference
} = require('./requests');
const { createStripeClient } = require('./stripe');
const {
  normalizePaymentRequest,
  normalizePaymentRequests,
  latestPaymentRequest,
  formatOre
} = require('./payment-ledger');
const {
  RESERVATION_STATUS,
  reserveNights,
  releaseReservation,
  verifyReservation
} = require('./reservations');
const { layout } = require('./payment-page');
const { buildPurchaseEvent } = require('../../shared/analytics.js');

const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

// Stripe Checkout kräver minst 30 minuter och högst 24 timmar. Vi använder
// 30 minuter så att reservationens livslängd är kort och följer sessionen.
const CHECKOUT_TTL_SECONDS = 30 * 60;
const MAX_PAYMENT_REQUESTS = 20;
const ID_KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;

function result(status, jsonBody) {
  return { status, headers: API_HEADERS, jsonBody };
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key ?? ''))) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(new Date(`${key}T00:00:00Z`));
}

function directBookingAvailable(options = {}) {
  const enabled = options.directBookingEnabled ?? process.env.DIRECT_BOOKING_ENABLED === '1';
  const stripeEnabled = options.stripeEnabled ?? process.env.STRIPE_ENABLED === '1';
  const cardEnabled = options.cardEnabled ?? process.env.STRIPE_CARD_ENABLED !== '0';
  const mode = options.stripeMode ?? process.env.STRIPE_MODE ?? 'test';
  const liveAllowed = options.allowLiveDirectBooking === true ||
    process.env.DIRECT_BOOKING_ALLOW_LIVE === '1';
  if (mode === 'live' && !liveAllowed) return false;
  return enabled === true && stripeEnabled === true && cardEnabled === true;
}

function createStripe(options) {
  return options.stripeClient ?? createStripeClient({
    secretKey: options.stripeSecretKey,
    allowLive: options.stripeAllowLive,
    fetchImpl: options.stripeFetchImpl,
    apiBase: options.stripeApiBase,
    timeoutMs: options.stripeTimeoutMs,
    cardEnabled: options.cardEnabled,
    swishEnabled: false
  });
}

// Automatisk direktbokning kan stängas av av Owner via en inställning i
// adminportalen. Om inställningen saknas är funktionen på, men varje
// bokningsförsök måste ändå passera de vanliga tillgänglighetskontrollerna.
async function isAutomaticDirectBookingEnabled(store, options = {}) {
  if (typeof options.automaticDirectBookingEnabled === 'boolean') {
    return options.automaticDirectBookingEnabled;
  }
  if (!store || typeof store.getDirectBookingSetting !== 'function') return true;
  try {
    const setting = await store.getDirectBookingSetting();
    if (!setting) return true;
    return setting.enabled === true;
  } catch {
    return false;
  }
}

// Hämtar färskt iCal-underlag inför varje kontroll. En natt som är upptagen i
// Airbnb gör hela vistelsen otillgänglig för direktbokning. Vi använder aldrig
// gamla cachade svar som bevis för tillgänglighet. Varje försök tvingar även en
// uppdatering av den sparade synkstatusen så att Owner ser senaste kontrollen.
async function checkAirbnbAutomatic(from, to, options, store) {
  const handler = options.availabilityHandler ?? handleAvailability;
  let availability;
  try {
    const query = new URLSearchParams({ start: from, end: to });
    availability = await handler({ query }, {}, {
      ...(options.availability ?? {}),
      calendarStatusStore: options.availability?.calendarStatusStore ?? store,
      forceStatusWrite: true,
      statusSource: 'direct-booking'
    });
  } catch {
    return { ok: false, code: 'AIRBNB_UNAVAILABLE' };
  }
  if (availability.status !== 200 || !Array.isArray(availability.jsonBody?.blocked)) {
    return { ok: false, code: availability.jsonBody?.code ?? 'AIRBNB_UNAVAILABLE' };
  }
  const blocked = nightKeys(from, to)
    .filter((night) => availability.jsonBody.blocked.includes(night));
  if (blocked.length) return { ok: false, code: 'AIRBNB_CONFLICT', nights: blocked };
  return { ok: true };
}

// Konfigurerbar säkerhetsgräns nära ankomst. Standard 0 = avstängd. När den
// aktiveras krävs att ankomsten ligger längre fram än angivet antal timmar;
// annars hänvisas gästen till en manuell bokningsförfrågan.
function minimumLeadHours(options = {}) {
  const raw = options.minimumLeadHours ??
    process.env.DIRECT_BOOKING_MIN_LEAD_HOURS ??
    0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 24 * 30);
}

function arrivalStartMillis(dateKey) {
  try {
    return Temporal.PlainDate.from(dateKey)
      .toZonedDateTime({ timeZone: 'Europe/Stockholm' })
      .epochMilliseconds;
  } catch {
    return Date.parse(`${dateKey}T00:00:00Z`);
  }
}

async function checkDirectBookingAvailability(store, from, to, now, options = {}) {
  if (!directBookingAvailable(options)) {
    return { directBooking: false, code: 'DIRECT_BOOKING_DISABLED', reason: 'disabled' };
  }
  if (!(await isAutomaticDirectBookingEnabled(store, options))) {
    return { directBooking: false, code: 'AUTO_DIRECT_BOOKING_DISABLED', reason: 'disabled_by_owner' };
  }
  const nights = nightKeys(from, to);
  if (!nights.length) {
    return { directBooking: false, code: 'INVALID_RANGE', reason: 'invalid' };
  }
  const leadHours = minimumLeadHours(options);
  if (leadHours > 0) {
    const arrival = arrivalStartMillis(from);
    if (!Number.isFinite(arrival) || now.getTime() + leadHours * 3600000 >= arrival) {
      return {
        directBooking: false,
        code: 'ARRIVAL_TOO_SOON',
        reason: 'lead_time',
        minimumLeadHours: leadHours,
        requestOnly: true
      };
    }
  }
  if (!store || typeof store.listCalendar !== 'function') {
    return { directBooking: false, code: 'DIRECT_BOOKING_UNAVAILABLE', reason: 'unavailable' };
  }

  const internal = await checkInternal(
    store,
    { arrival: from, departure: to, reference: '' },
    now,
    {},
    { ...options, skipExpiredCleanup: options.cleanupExpired !== true }
  );
  if (!internal.ok) {
    return {
      directBooking: false,
      code: internal.code,
      reason: 'internal_conflict',
      conflicts: internal.conflicts
    };
  }

  const airbnb = await checkAirbnbAutomatic(from, to, options, store);
  if (!airbnb.ok) {
    return {
      directBooking: false,
      code: airbnb.code,
      reason: 'airbnb',
      nights: airbnb.nights
    };
  }

  return { directBooking: true, nights };
}

async function checkInternal(store, record, now, context, options) {
  // Frigör endast reservationer som Stripe uttryckligen har bekräftat som
  // utgångna. Om Stripe inte kan nås lämnas reservationen orörd (fail-closed).
  if (!options.skipExpiredCleanup) {
    await releaseExpiredReservations(store, record.arrival, record.departure, now, context, options);
  }

  let calendarRows;
  try {
    calendarRows = await store.listCalendar(record.arrival, record.departure);
  } catch {
    return { ok: false, code: 'INTERNAL_UNAVAILABLE' };
  }
  if (!Array.isArray(calendarRows)) return { ok: false, code: 'INTERNAL_UNAVAILABLE' };
  const conflicts = calendarRows.filter((row) => row.reference && row.reference !== record.reference);
  if (conflicts.length) {
    return {
      ok: false,
      code: 'INTERNAL_CONFLICT',
      conflicts: conflicts.map((row) => row.night ?? row.RowKey)
    };
  }

  if (typeof store.listBlockingBookings === 'function') {
    let blocking;
    try {
      blocking = await store.listBlockingBookings(record.arrival, record.departure);
    } catch {
      return { ok: false, code: 'INTERNAL_UNAVAILABLE' };
    }
    if (blocking === null) return { ok: false, code: 'INTERNAL_UNAVAILABLE' };
    const overlaps = blocking.filter((booking) => booking.reference !== record.reference);
    if (overlaps.length) {
      return {
        ok: false,
        code: 'INTERNAL_CONFLICT',
        conflicts: overlaps.map((booking) => booking.reference)
      };
    }
  }
  return { ok: true };
}

// Lazy städning av utgångna reservationer. Kräver att Stripe bekräftar att
// sessionen är utgången och inte betald. Utan Stripe-klient eller vid osäkert
// svar frigörs ingenting — den signerade webhooken hanterar utgången.
async function releaseExpiredReservations(store, arrival, departure, now, context, options = {}) {
  if (!store || typeof store.listCalendar !== 'function' || typeof store.getByReference !== 'function') return;
  let rows;
  try {
    rows = await store.listCalendar(arrival, departure);
  } catch {
    return;
  }
  if (!Array.isArray(rows)) return;
  const references = [...new Set(
    rows
      .filter((row) => row.type === 'RESERVATION' && row.reference)
      .map((row) => row.reference)
  )];
  if (!references.length) return;
  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return;
  }
  for (const reference of references) {
    try {
      const raw = await store.getByReference(reference);
      if (!raw) continue;
      const record = raw.record;
      if (record.statusCode !== 'PENDING_PAYMENT') continue;
      const expiresAt = Date.parse(record.reservation?.expiresAt ?? '');
      if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) continue;
      const sessionId = record.reservation?.sessionId || record.paymentRequest?.sessionId;
      if (!sessionId) continue;
      const session = await stripe.retrieveCheckoutSession(sessionId);
      if (session?.status !== 'expired' || session?.payment_status === 'paid') continue;
      await releaseReservation(store, reference, now);
      const updated = {
        ...record,
        statusCode: 'EXPIRED',
        status: 'Reservationen har gått ut',
        reservation: {
          ...(record.reservation ?? {}),
          status: RESERVATION_STATUS.EXPIRED,
          releasedAt: now.toISOString()
        },
        version: Number(record.version || 1) + 1,
        updatedAt: now.toISOString(),
        updatedBy: 'System'
      };
      await store.updateRequest(updated, { ifMatch: raw.etag }).catch(() => {});
    } catch {
      // Städning får aldrig blockera en ny bokning. Webhooken hanterar utgång.
    }
  }
}

async function expireAndVerify(stripe, sessionId) {
  if (!sessionId) return false;
  try {
    await stripe.expireCheckoutSession(sessionId);
    const session = await stripe.retrieveCheckoutSession(sessionId);
    return session?.status === 'expired' && session?.payment_status !== 'paid';
  } catch {
    return false;
  }
}

function validCheckoutSession(session, stripe, reference, amountOre) {
  let url = null;
  try { url = new URL(String(session?.url ?? '')); } catch { url = null; }
  return Boolean(
    session &&
    session.id &&
    url &&
    url.protocol === 'https:' &&
    /(^|\.)stripe\.com$/i.test(url.hostname) &&
    Number(session.amount_total) === amountOre &&
    String(session.currency ?? '').toLowerCase() === 'sek' &&
    (session.mode ? session.mode === 'payment' : true) &&
    (typeof session.livemode === 'boolean' ? session.livemode === (stripe.mode === 'live') : true) &&
    (session.client_reference_id ? session.client_reference_id === reference : true) &&
    (session.metadata?.reference ? session.metadata.reference === reference : true) &&
    (Array.isArray(session.payment_method_types)
      ? session.payment_method_types.length === 1 &&
        String(session.payment_method_types[0]).toLowerCase() === 'card'
      : true)
  );
}

async function handleDirectBooking(request, context = {}, options = {}) {
  const warn = context.warn ?? (() => {});
  const now = options.now ?? new Date();

  if (!directBookingAvailable(options)) {
    return result(503, {
      error: 'Direktbokning med kort är inte aktiverad just nu. Skicka gärna en bokningsförfrågan.',
      code: 'DIRECT_BOOKING_DISABLED'
    });
  }

  const rules = await loadRules(options);
  if (!rules.published) {
    return result(503, {
      error: 'Bokningsreglerna är inte publicerade ännu. Förfrågningar kan tyvärr inte tas emot just nu.',
      code: 'RULES_NOT_PUBLISHED'
    });
  }

  const store = createStore(options);
  if (store.type !== 'azure-table' && options.requireDurableStore !== false) {
    return result(503, {
      error: 'Direktbokning kan inte tas emot just nu. Skicka gärna en bokningsförfrågan.',
      code: 'STORE_UNAVAILABLE'
    });
  }

  const allow = options.rateLimiter ?? createRateLimiter(options.rateLimit);
  if (!allow(request.ip, now.getTime())) {
    return result(429, { error: 'För många försök. Vänligen försök igen om en stund.' });
  }

  const idempotencyKey = typeof request.idempotencyKey === 'string' ? request.idempotencyKey : '';
  if (!ID_KEY_PATTERN.test(idempotencyKey)) {
    return result(400, { error: 'Förfrågan kunde inte skickas.' });
  }

  const existing = await store.findByIdempotencyKey(idempotencyKey).catch(() => null);
  if (existing) {
    if (existing.statusCode === 'CONFIRMED') {
      return result(200, {
        reference: existing.reference,
        status: 'CONFIRMED',
        confirmed: true
      });
    }
    if (existing.statusCode === 'PENDING_PAYMENT' && existing.paymentRequest?.url) {
      return result(200, {
        reference: existing.reference,
        status: 'PENDING_PAYMENT',
        checkoutUrl: existing.paymentRequest.url,
        expiresAt: existing.paymentRequest.expiresAt
      });
    }
    return result(409, {
      error: 'Det finns redan ett bokningsförsök med denna nyckel. Börja om från kalendern.',
      code: 'IDEMPOTENCY_CONFLICT',
      reference: existing.reference,
      status: existing.statusCode,
      retryable: ['PAYMENT_FAILED', 'RESERVATION_FAILED', 'EXPIRED'].includes(existing.statusCode)
    });
  }

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  if (typeof body.webbsida === 'string' && body.webbsida.trim()) {
    return result(400, { error: 'Förfrågan kunde inte skickas.' });
  }
  const validated = validatePayload(body, now);
  if (validated.errors) {
    return result(400, {
      error: 'Kontrollera uppgifterna i formuläret.',
      fields: validated.errors
    });
  }
  if (validated.record.rulesVersion !== rules.version) {
    return result(400, {
      error: 'Bokningsreglerna har uppdaterats. Vänligen läs dem igen och godkänn dem.',
      fields: { consentRules: 'Bokningsreglerna har uppdaterats — godkänn den aktuella versionen.' }
    });
  }
  if (validated.record.addons.extrahus === true) {
    return result(409, {
      error: 'Extrahusets tillgänglighet kan inte verifieras automatiskt. Skicka en bokningsförfrågan så bekräftar vi extrahuset manuellt innan bokningen blir giltig.',
      code: 'EXTRAHUS_DIRECT_UNAVAILABLE',
      manualReview: true
    });
  }

  let stripe;
  try {
    stripe = createStripe(options);
  } catch (error) {
    warn(`Direktbokning: Stripe är inte konfigurerat (${error?.code ?? 'okänt'}).`);
    return result(503, {
      error: 'Kortbetalning är inte tillgänglig just nu. Skicka gärna en bokningsförfrågan.',
      code: 'STRIPE_UNAVAILABLE'
    });
  }

  // Extra skydd: live-direktbokning kräver ett uttryckligt, separat beslut.
  // Flaggan DIRECT_BOOKING_ENABLED räcker inte ensam i live-läge.
  if (stripe.mode === 'live' &&
      options.allowLiveDirectBooking !== true &&
      process.env.DIRECT_BOOKING_ALLOW_LIVE !== '1') {
    return result(503, {
      error: 'Direktbokning med kort är inte aktiverad i produktion.',
      code: 'DIRECT_BOOKING_LIVE_BLOCKED'
    });
  }

  const availability = await checkDirectBookingAvailability(
    store,
    validated.record.arrival,
    validated.record.departure,
    now,
    { ...options, cleanupExpired: true }
  );
  if (!availability.directBooking) {
    if (
      availability.code === 'INTERNAL_UNAVAILABLE' ||
      availability.code === 'DIRECT_BOOKING_UNAVAILABLE' ||
      availability.code === 'AIRBNB_UNAVAILABLE'
    ) {
      return result(503, {
        error: 'Vi kan inte bekräfta tillgängligheten just nu. Skicka gärna en bokningsförfrågan.',
        code: availability.code,
        manualReview: true
      });
    }
    if (availability.code === 'INTERNAL_CONFLICT' || availability.code === 'AIRBNB_CONFLICT') {
      return result(409, {
        error: 'Datumen är inte tillgängliga. Välj andra datum.',
        code: availability.code,
        conflicts: availability.conflicts,
        nights: availability.nights
      });
    }
    if (availability.code === 'ARRIVAL_TOO_SOON') {
      return result(409, {
        error: `Ankomsten är för nära i tid för automatisk kortbetalning (minst ${availability.minimumLeadHours} timmar krävs). Skicka gärna en bokningsförfrågan.`,
        code: availability.code,
        manualReview: true,
        minimumLeadHours: availability.minimumLeadHours
      });
    }
    if (
      availability.code === 'AUTO_DIRECT_BOOKING_DISABLED' ||
      availability.code === 'DIRECT_BOOKING_DISABLED'
    ) {
      return result(409, {
        error: 'Direktbetalning är inte tillgänglig just nu. Skicka gärna en bokningsförfrågan.',
        code: availability.code,
        manualReview: true
      });
    }
    return result(409, {
      error: 'Datumen är inte tillgängliga. Välj andra datum.',
      code: availability.code
    });
  }

  const makeReferenceFn = options.makeReference ?? makeReference;
  let reference = makeReferenceFn(now);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await store.findByReference(reference).catch(() => null);
    if (!clash) break;
    reference = makeReferenceFn(now);
  }

  const totalOre = Math.round(Number(validated.record.total) * 100);
  if (!Number.isSafeInteger(totalOre) || totalOre <= 0) {
    return result(400, { error: 'Priset kunde inte beräknas. Kontakta Skadevi Herrgård.' });
  }

  const record = {
    ...validated.record,
    idempotencyKey,
    reference,
    statusCode: 'PENDING_PAYMENT',
    status: 'Väntar på betalning',
    bookingSource: 'DIRECT',
    version: 1,
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    balance: validated.record.total,
    latestNote: '',
    reservation: {
      status: RESERVATION_STATUS.PENDING,
      reference,
      owner: 'guest',
      createdAt: now.toISOString(),
      expiresAt: '',
      sessionId: ''
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };

  try {
    const saved = await store.save(record, { warn });
    if (saved?.duplicate) {
      return result(409, {
        error: 'Det finns redan ett bokningsförsök med denna nyckel.',
        code: 'IDEMPOTENCY_CONFLICT',
        reference: saved.record?.reference ?? reference
      });
    }
  } catch {
    warn('Direktbokning: bokningen kunde inte sparas.');
    return result(500, { error: 'Bokningen kunde inte sparas just nu. Försök igen om en stund.' });
  }

  const rawAfterSave = await store.getByReference(reference).catch(() => null);
  const etagAfterSave = rawAfterSave?.etag ?? '*';

  let reservation;
  try {
    reservation = await reserveNights(store, record, now);
  } catch (error) {
    const failed = {
      ...record,
      statusCode: 'RESERVATION_FAILED',
      status: 'Reservationen kunde inte skapas',
      reservation: {
        ...record.reservation,
        status: RESERVATION_STATUS.FAILED,
        failedAt: now.toISOString()
      },
      version: 2,
      updatedAt: now.toISOString()
    };
    await store.updateRequest(failed, { ifMatch: etagAfterSave }).catch(() => {});
    if (error?.status === 409) {
      return result(409, {
        error: 'Några av de valda nätterna är inte längre tillgängliga. Välj andra datum i kalendern.',
        code: 'RESERVATION_CONFLICT',
        conflicts: error.conflicts
      });
    }
    warn(`Direktbokning: reservationen kunde inte skapas (${error?.message ?? 'okänt fel'}).`);
    return result(503, {
      error: 'Bokningen kunde inte reserveras just nu. Försök igen eller skicka en bokningsförfrågan.',
      code: 'RESERVATION_FAILED'
    });
  }

  // Verifiera att reservationen fortfarande ägs av exakt detta försök innan
  // någon betalning startas. Om låsningen inte kan styrkas frigörs försöket
  // och ingen Checkout skapas.
  let ownership;
  try {
    ownership = await verifyReservation(store, record);
  } catch {
    ownership = { ok: false };
  }
  if (!ownership.ok) {
    await releaseReservation(store, reference, now).catch(() => {});
    const failed = {
      ...record,
      statusCode: 'RESERVATION_FAILED',
      status: 'Reservationen kunde inte verifieras',
      reservation: {
        ...record.reservation,
        status: RESERVATION_STATUS.FAILED,
        failedAt: now.toISOString()
      },
      version: 2,
      updatedAt: now.toISOString()
    };
    await store.updateRequest(failed, { ifMatch: etagAfterSave }).catch(() => {});
    warn(`Direktbokning: reservationens ägarskap kunde inte verifieras för ${reference}.`);
    return result(503, {
      error: 'Bokningen kunde inte säkras just nu. Försök igen eller skicka en bokningsförfrågan.',
      code: 'RESERVATION_UNVERIFIED'
    });
  }

  const base = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://www.skadeviherrgard.com';
  const expiresAtUnix = Math.floor(now.getTime() / 1000) + CHECKOUT_TTL_SECONDS;
  const stripeIdempotencyKey = `direct-${idempotencyKey}`;
  let session;
  try {
    session = await stripe.createCheckoutSession({
      amountOre: totalOre,
      currency: 'sek',
      paymentMethods: ['card'],
      reference,
      productName: `Skadevi Herrgård – ${reference}`,
      description: `${record.arrival} – ${record.departure}, ${record.nights} nätter, ${record.guests} gäster`,
      customerEmail: record.email,
      successUrl: `${base}/bokning-klar?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/betalning-avbruten?ref=${encodeURIComponent(reference)}`,
      expiresAt: expiresAtUnix,
      idempotencyKey: stripeIdempotencyKey,
      metadata: {
        reference,
        source: 'direct-booking',
        amountOre: String(totalOre)
      }
    });
  } catch (error) {
    await releaseReservation(store, reference, now).catch(() => {});
    const failed = {
      ...record,
      statusCode: 'PAYMENT_FAILED',
      status: 'Betalningen kunde inte startas',
      reservation: {
        ...record.reservation,
        status: RESERVATION_STATUS.RELEASED,
        releasedAt: now.toISOString()
      },
      version: 2,
      updatedAt: now.toISOString()
    };
    await store.updateRequest(failed, { ifMatch: etagAfterSave }).catch(() => {});
    warn(`Direktbokning: Checkout kunde inte skapas (${error?.code ?? 'okänt'}).`);
    return result(503, {
      error: 'Betalningen kunde inte startas just nu. Försök igen eller skicka en bokningsförfrågan.',
      code: 'STRIPE_CHECKOUT_FAILED'
    });
  }

  if (!validCheckoutSession(session, stripe, reference, totalOre)) {
    warn('Direktbokning: Stripe returnerade ett oväntat Checkout-svar.');
    const expired = await expireAndVerify(stripe, session?.id);
    if (expired) await releaseReservation(store, reference, now).catch(() => {});
    const failed = {
      ...record,
      statusCode: 'PAYMENT_FAILED',
      status: 'Betalningen kunde inte verifieras',
      reservation: {
        ...record.reservation,
        status: expired ? RESERVATION_STATUS.RELEASED : RESERVATION_STATUS.ACTIVE,
        releasedAt: expired ? now.toISOString() : ''
      },
      version: 2,
      updatedAt: now.toISOString()
    };
    await store.updateRequest(failed, { ifMatch: etagAfterSave }).catch(() => {});
    return result(502, {
      error: 'Betalningen kunde inte verifieras. Ingen betalning har genomförts.',
      code: 'STRIPE_SESSION_INVALID'
    });
  }

  const sessionExpiresAt = new Date(
    (Number(session.expires_at) || expiresAtUnix) * 1000
  ).toISOString();
  const paymentRequest = normalizePaymentRequest({
    provider: 'stripe',
    mode: stripe.mode,
    paymentMethod: 'card',
    status: 'OPEN',
    sessionId: session.id,
    paymentIntentId: session.payment_intent ?? '',
    url: session.url,
    amountOre: totalOre,
    currency: 'sek',
    createdAt: now.toISOString(),
    expiresAt: sessionExpiresAt,
    createdBy: 'Gäst',
    createdById: 'guest',
    idempotencyKey: stripeIdempotencyKey
  });
  const updatedRecord = {
    ...record,
    statusCode: 'PENDING_PAYMENT',
    status: 'Väntar på betalning',
    paymentRequests: [paymentRequest].slice(-MAX_PAYMENT_REQUESTS),
    paymentRequest: latestPaymentRequest([paymentRequest]),
    reservation: {
      ...record.reservation,
      status: RESERVATION_STATUS.ACTIVE,
      sessionId: session.id,
      expiresAt: sessionExpiresAt,
      activatedAt: now.toISOString()
    },
    version: 2,
    updatedAt: now.toISOString(),
    updatedBy: 'Gäst'
  };

  try {
    await store.updateRequest(updatedRecord, { ifMatch: etagAfterSave });
  } catch {
    const expired = await expireAndVerify(stripe, session.id);
    if (expired) await releaseReservation(store, reference, now).catch(() => {});
    warn(`Direktbokning: sessionen kunde inte sparas för ${reference}.`);
    return result(503, {
      error: 'Bokningen kunde inte sparas just nu. Försök igen om en stund.',
      code: 'STORE_UPDATE_FAILED'
    });
  }

  try {
    await store.appendHistory({
      idempotencyKey: `direct-${session.id}-started`,
      reference,
      action: 'DIRECT_BOOKING_CHECKOUT_STARTED',
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'PENDING_PAYMENT',
      changes: JSON.stringify({
        sessionId: session.id,
        amountOre: totalOre,
        expiresAt: sessionExpiresAt,
        nights: reservation.nights
      }),
      reason: '',
      actorId: 'guest',
      actorName: 'Gäst',
      correlationId: crypto.randomUUID(),
      at: now.toISOString()
    });
  } catch {
    warn(`Direktbokning: historik kunde inte sparas för ${reference}.`);
  }

  return result(201, {
    reference,
    status: 'PENDING_PAYMENT',
    checkoutUrl: session.url,
    expiresAt: sessionExpiresAt,
    total: record.total,
    totalOre
  });
}

// --- Bekräftelsesida -------------------------------------------------------

function confirmationLayout(title, content, options) {
  return layout(title, content, options);
}

function renderConfirmationError(status, message) {
  return {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    html: confirmationLayout('Bokningen kunde inte visas', `<h1>Bokningen kunde inte visas</h1>
      <p>${escapeHtml(message)}</p>
      <p>Ingen betalning har genomförts om du inte har fått en bekräftelse från Stripe.</p>
      <p><a class="btn btn-primary" href="/boka">Tillbaka till bokningen</a></p>`)
  };
}

function addonList(record) {
  const lines = Array.isArray(record.addonLines) ? record.addonLines : [];
  if (!lines.length) return '<li>Inga tillval</li>';
  return lines.map((line) =>
    `<li>${escapeHtml(line.label)}${line.quantity > 1 ? ` × ${line.quantity}` : ''} — ${escapeHtml(formatOre(Math.round(Number(line.amount || 0) * 100)))}</li>`
  ).join('');
}

function renderConfirmedPage(record, session) {
  const verifiedOre = Number(session.amount_total);
  const paidOre = verifiedOre || Math.round(Number(record.total) * 100);
  // purchase skapas endast för CONFIRMED + verifierad betald Stripe-session.
  const purchase = buildPurchaseEvent(record, session);
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    html: confirmationLayout('Bokningen är bekräftad', `<h1>Bokningen är bekräftad</h1>
      <p>Tack! Din betalning är mottagen och bokningen är bekräftad.</p>
      <dl class="payment-summary">
        <div><dt>Bokningsreferens</dt><dd>${escapeHtml(record.reference)}</dd></div>
        <div><dt>Ankomst</dt><dd>${escapeHtml(formatDateKey(record.arrival))}</dd></div>
        <div><dt>Avresa</dt><dd>${escapeHtml(formatDateKey(record.departure))}</dd></div>
        <div><dt>Antal gäster</dt><dd>${escapeHtml(String(record.guests))}</dd></div>
        <div><dt>Totalt betalt</dt><dd>${escapeHtml(formatOre(paidOre))}</dd></div>
        <div><dt>Status</dt><dd>Bekräftad</dd></div>
      </dl>
      <h2>Tillval</h2>
      <ul>${addonList(record)}</ul>
      <p class="payment-note">Betalningen är genomförd med kort via Stripe. Skadevi Herrgård kontaktar dig om något behöver kompletteras.</p>
      <p><a class="btn btn-primary" href="/">Till startsidan</a></p>`, { purchase })
  };
}

function renderProcessingPage(record, message) {
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    html: confirmationLayout('Bokningen behandlas', `<h1>Bokningen behandlas</h1>
      <p>${escapeHtml(message)}</p>
      <dl class="payment-summary">
        <div><dt>Bokningsreferens</dt><dd>${escapeHtml(record.reference)}</dd></div>
        <div><dt>Ankomst</dt><dd>${escapeHtml(formatDateKey(record.arrival))}</dd></div>
        <div><dt>Avresa</dt><dd>${escapeHtml(formatDateKey(record.departure))}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(record.status ?? 'Behandlas')}</dd></div>
      </dl>
      <p class="payment-note">Sidan uppdateras automatiskt. Visa inte den här sidan som en bekräftelse förrän statusen är <strong>Bekräftad</strong>.</p>
      <meta http-equiv="refresh" content="10">
      <p><a class="btn btn-primary" href="/boka">Tillbaka till bokningen</a></p>`)
  };
}

async function handleDirectBookingConfirmation(request, _context = {}, options = {}) {
  const sessionId = String(request?.query?.session_id ?? '');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return renderConfirmationError(400, 'Saknar giltig betalningssession.');
  }
  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return renderConfirmationError(503, 'Betalningsstatus kunde inte kontrolleras just nu. Försök igen om en stund.');
  }
  let session;
  try {
    session = await stripe.retrieveCheckoutSession(sessionId);
  } catch {
    return renderConfirmationError(503, 'Betalningsstatus kunde inte kontrolleras just nu. Försök igen om en stund.');
  }
  const reference = String(session?.metadata?.reference ?? session?.client_reference_id ?? '').trim();
  if (!/^[A-Za-z0-9-]{4,80}$/.test(reference)) {
    return renderConfirmationError(400, 'Betalningssessionen saknar bokningsreferens.');
  }
  const store = options.store ?? createStore(options);
  if (!store || typeof store.getByReference !== 'function') {
    return renderConfirmationError(503, 'Bokningen kunde inte kontrolleras just nu.');
  }
  const raw = await store.getByReference(reference).catch(() => null);
  if (!raw) return renderConfirmationError(404, 'Bokningen hittades inte.');
  const record = raw.record;

  const requests = normalizePaymentRequests(record);
  const requestRow = requests.find((paymentRequest) => paymentRequest.sessionId === sessionId);
  const amountOre = Math.round(Number(record.total) * 100);
  const sessionAmount = Number(session.amount_total);
  const currency = String(session.currency ?? '').toLowerCase();
  if (!requestRow || sessionAmount !== amountOre || currency !== 'sek') {
    return renderConfirmationError(409, 'Betalningen kunde inte verifieras mot bokningen.');
  }
  if (session.mode && session.mode !== 'payment') {
    return renderConfirmationError(409, 'Betalningen kunde inte verifieras mot bokningen.');
  }
  if (typeof session.livemode === 'boolean' && stripe.mode && session.livemode !== (stripe.mode === 'live')) {
    return renderConfirmationError(409, 'Betalningen kunde inte verifieras mot bokningen.');
  }
  if (Array.isArray(session.payment_method_types) && session.payment_method_types.length === 1) {
    const sessionMethod = String(session.payment_method_types[0]).toLowerCase();
    if (requestRow.paymentMethod && sessionMethod !== requestRow.paymentMethod) {
      return renderConfirmationError(409, 'Betalningen kunde inte verifieras mot bokningen.');
    }
  }

  const paid = session.payment_status === 'paid';
  if (record.statusCode === 'CONFIRMED' && paid) {
    return renderConfirmedPage(record, session);
  }
  if (record.statusCode === 'RECONCILIATION') {
    return renderProcessingPage(record, 'Betalningen är mottagen men bokningen behöver kontrolleras manuellt. Vi kontaktar dig.');
  }
  if (record.statusCode === 'PENDING_PAYMENT') {
    return renderProcessingPage(record, 'Betalningen behandlas. Sidan uppdateras automatiskt.');
  }
  return renderProcessingPage(record, 'Bokningen behandlas.');
}

module.exports = {
  handleDirectBooking,
  handleDirectBookingConfirmation,
  directBookingAvailable,
  checkDirectBookingAvailability,
  minimumLeadHours,
  releaseExpiredReservations,
  expireAndVerify,
  CHECKOUT_TTL_SECONDS
};
