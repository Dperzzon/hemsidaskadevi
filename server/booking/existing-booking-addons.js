'use strict';

// Köp av tillval till en redan bekräftad bokning.
//
// Flödet är helt separat från nybokningen:
//   1. Gästen anger bokningsnummer och den e-postadress som finns på
//      bokningen. Svaret är alltid neutralt, oavsett om uppgifterna finns.
//   2. En sexsiffrig engångskod skickas endast till bokningens registrerade
//      adress. Koden lagras aldrig i klartext.
//   3. Efter verifiering utfärdas en kortlivad, bokningsbunden session. Den
//      ger bara åtkomst till den bokning som verifierades.
//   4. Gästen väljer nya tillval. Servern räknar alltid om priset från den
//      centrala priskonfigurationen och litar aldrig på klientens belopp.
//   5. Stripe Checkout skapas endast för tillvalen. Buffertnätter för tidig
//      incheckning och sen utcheckning låses atomiskt inför betalningen.
//   6. Först när den signerade webhooken har verifierat betalningen läggs
//      tillvalen till på den befintliga bokningen. Boendedatum, boendepris och
//      tidigare betalningshistorik bevaras.
//
// Allt tekniskt fel är fail-closed: inga tillval läggs till och inga datum
// frigörs på osäkra grunder.

const crypto = require('node:crypto');
const CONFIG = require('../../shared/pricing-config.json');
const { LINEN_MAX, linenLimit, formatSek } = require('./pricing');
const { addDays, todayKey } = require('./buffer-nights');
const { loadRules } = require('./rules');
const {
  buildAddonVerificationMail,
  buildAddonConfirmation,
  buildAddonHostNotification,
  buildAddonRequestNotifications
} = require('./booking-mail');
const { queueNotification } = require('./outbox');
const {
  computePaymentSummary,
  normalizePayments,
  normalizePaymentRequest,
  openingBalanceOreFor,
  stripePaymentEntry
} = require('./payment-ledger');
const { createStripeClient } = require('./stripe');
const { handleAvailability } = require('../calendar/availability');

const PARTITION = Object.freeze({
  VERIFICATION: 'addonverification',
  SESSION: 'addonsession',
  ORDER: 'addonorder',
  REQUEST: 'addonrequest'
});

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const SEND_COOLDOWN_MS = 30 * 1000;
const CHECKOUT_TTL_SECONDS = 30 * 60;
const MAX_ITEMS_PER_ORDER = 10;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,80}$/;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;
const ID_KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const NEUTRAL_VERIFICATION_MESSAGE =
  'Om uppgifterna stämmer med en bekräftad bokning har vi skickat en verifieringskod till bokningens registrerade e-postadress. Koden gäller i 10 minuter.';

const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

function result(status, jsonBody) {
  return { status, headers: API_HEADERS, jsonBody };
}

function addonsAvailable(options = {}) {
  const enabled = options.existingBookingAddonsEnabled ??
    process.env.EXISTING_BOOKING_ADDONS_ENABLED === '1';
  const stripeEnabled = options.stripeEnabled ?? process.env.STRIPE_ENABLED === '1';
  const cardEnabled = options.cardEnabled ?? process.env.STRIPE_CARD_ENABLED !== '0';
  const mode = options.stripeMode ?? process.env.STRIPE_MODE ?? 'test';
  const liveAllowed = options.allowLiveExistingBookingAddons === true ||
    process.env.EXISTING_BOOKING_ADDONS_ALLOW_LIVE === '1';
  if (mode === 'live' && !liveAllowed) return false;
  return enabled === true && stripeEnabled === true && cardEnabled === true;
}

function disabledResult() {
  return result(503, {
    error: 'Köp av tillval till en befintlig bokning är inte aktiverat just nu.',
    code: 'EXISTING_BOOKING_ADDONS_DISABLED'
  });
}

function normalizeReference(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return REFERENCE_PATTERN.test(text) ? text : '';
}

function normalizeEmail(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return EMAIL_PATTERN.test(text) && text.length <= 320 ? text : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function verificationKey(reference, email) {
  return sha256(`skadevi-addon-verification:${reference}:${email}`);
}

function normalizeCode(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 6 ? digits : '';
}

function hashCode(code, salt) {
  return crypto.scryptSync(String(code), String(salt), 32).toString('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readToken(request = {}) {
  const direct = request.token ?? request.headers?.['x-addon-token'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const authorization = request.headers?.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

function tokenHash(token) {
  return sha256(`skadevi-addon-session:${token}`);
}

function createSlidingLimiter(options = {}) {
  const max = Number(options.max ?? 10);
  const windowMs = Number(options.windowMs ?? 15 * 60 * 1000);
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const id = String(key ?? '');
    const timestamps = (hits.get(id) ?? []).filter((time) => now - time < windowMs);
    if (timestamps.length >= max) {
      hits.set(id, timestamps);
      return false;
    }
    timestamps.push(now);
    hits.set(id, timestamps);
    return true;
  };
}

const startLimiter = createSlidingLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const confirmLimiter = createSlidingLimiter({ max: 15, windowMs: 15 * 60 * 1000 });
const checkoutLimiter = createSlidingLimiter({ max: 12, windowMs: 10 * 60 * 1000 });

function eligibility(record, now = new Date()) {
  if (!record) return { ok: false, code: 'NOT_FOUND' };
  if (String(record.reference ?? '').startsWith('BLOCK-') || record.statusCode === 'BLOCKED') {
    return { ok: false, code: 'BLOCKED' };
  }
  if (record.statusCode !== 'CONFIRMED') {
    return { ok: false, code: 'NOT_CONFIRMED' };
  }
  if (!record.email || !EMAIL_PATTERN.test(String(record.email))) {
    return { ok: false, code: 'MISSING_EMAIL' };
  }
  if (!record.arrival || !record.departure || record.departure <= record.arrival) {
    return { ok: false, code: 'MISSING_DATES' };
  }
  if (record.departure <= todayKey(now)) {
    return { ok: false, code: 'STAY_ENDED' };
  }
  return { ok: true };
}

async function getBooking(store, reference) {
  if (!store || typeof store.getByReference !== 'function') return null;
  try {
    return await store.getByReference(reference);
  } catch {
    return null;
  }
}

function outboxEnabled(options = {}) {
  const explicit = options.addonsOutboxEnabled ?? options.outboxEnabled;
  if (typeof explicit === 'boolean') return explicit;
  return process.env.EXISTING_BOOKING_ADDONS_OUTBOX_ENABLED === '1' ||
    process.env.STRIPE_OUTBOX_ENABLED === '1';
}

// --- Verifiering -----------------------------------------------------------

async function sendVerificationCode(store, record, code, key, sendCount, options, context) {
  if (outboxEnabled(options) !== true) return { ok: true, disabled: true };
  const notification = buildAddonVerificationMail(record, code, {
    expiresMinutes: Math.round(CODE_TTL_MS / 60000)
  });
  const now = options.now ?? new Date();
  return queueNotification(
    (entry) => store.save(entry, context),
    {
      idempotencyKey: `outbox-addon-verification-${key}-${sendCount}-${now.getTime()}`,
      reference: record.reference,
      notification,
      createdAt: now.toISOString(),
      context
    }
  );
}

async function handleAddonVerifyStart(request = {}, context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const now = options.now ?? new Date();
  if (!startLimiter(request.ip ?? 'unknown', now.getTime())) {
    return result(429, { message: NEUTRAL_VERIFICATION_MESSAGE, code: 'RATE_LIMITED' });
  }
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const reference = normalizeReference(body.reference);
  const email = normalizeEmail(body.email);
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') {
    return result(202, { message: NEUTRAL_VERIFICATION_MESSAGE });
  }

  try {
    const raw = reference ? await getBooking(store, reference) : null;
    const record = raw?.record ?? null;
    const ownEmail = String(record?.email ?? '').trim().toLowerCase();
    const eligible = Boolean(record) && eligibility(record, now).ok === true &&
      ownEmail === email && email !== '';
    if (!eligible) {
      // Dummy-hash för att svaret inte ska skilja sig nämnvärt i tid.
      crypto.scryptSync('000000', 'skadevi-dummy', 32);
      return result(202, { message: NEUTRAL_VERIFICATION_MESSAGE });
    }

    const key = verificationKey(reference, email);
    const existing = await store.getAux(PARTITION.VERIFICATION, key);
    const windowStart = Date.parse(existing?.sendWindowStart ?? '');
    const withinWindow = Number.isFinite(windowStart) && now.getTime() - windowStart < SEND_WINDOW_MS;
    const sendCount = withinWindow ? Number(existing?.sendCount ?? 0) : 0;
    const lastSentAt = Date.parse(existing?.lastSentAt ?? '');
    const tooSoon = Number.isFinite(lastSentAt) && now.getTime() - lastSentAt < SEND_COOLDOWN_MS;
    if (withinWindow && (sendCount >= MAX_SENDS_PER_WINDOW || tooSoon)) {
      return result(202, { message: NEUTRAL_VERIFICATION_MESSAGE });
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    const row = {
      kind: 'verification',
      status: 'PENDING',
      reference,
      emailHash: sha256(email),
      codeSalt: salt,
      codeHash: hashCode(code, salt),
      attempts: 0,
      maxAttempts: MAX_CODE_ATTEMPTS,
      sendCount: sendCount + 1,
      sendWindowStart: withinWindow ? existing.sendWindowStart : now.toISOString(),
      lastSentAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    await store.putAux(PARTITION.VERIFICATION, key, row, { ifMatch: existing?.etag ?? undefined });
    await sendVerificationCode(store, record, code, key, row.sendCount, options, context)
      .catch(() => {});
  } catch {
    // Neutralt svar även vid tekniskt fel – inget om bokningen avslöjas.
  }
  return result(202, { message: NEUTRAL_VERIFICATION_MESSAGE });
}

async function createSession(store, reference, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await store.putAux(PARTITION.SESSION, tokenHash(token), {
    kind: 'session',
    status: 'ACTIVE',
    reference,
    createdAt: now.toISOString(),
    expiresAt,
    updatedAt: now.toISOString()
  });
  return { token, expiresAt };
}

async function resolveSession(store, token, now = new Date()) {
  if (!token || token.length < 20) return null;
  const hash = tokenHash(token);
  const session = await store.getAux(PARTITION.SESSION, hash);
  if (!session || session.status !== 'ACTIVE') return null;
  const expiresAt = Date.parse(session.expiresAt ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;
  return { session, tokenHash: hash };
}

async function handleAddonVerifyConfirm(request = {}, _context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const now = options.now ?? new Date();
  if (!confirmLimiter(request.ip ?? 'unknown', now.getTime())) {
    return result(429, { error: 'För många försök. Begär en ny kod om en stund.', code: 'RATE_LIMITED' });
  }
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const reference = normalizeReference(body.reference);
  const email = normalizeEmail(body.email);
  const code = normalizeCode(body.code);
  const generic = result(400, {
    error: 'Verifieringen kunde inte genomföras. Kontrollera uppgifterna och begär en ny kod om det behövs.',
    code: 'VERIFICATION_FAILED'
  });
  const store = options.store;
  if (!store || !reference || !email || !code) return generic;

  const key = verificationKey(reference, email);
  let row;
  try {
    row = await store.getAux(PARTITION.VERIFICATION, key);
  } catch {
    return generic;
  }
  if (!row || row.status !== 'PENDING' || row.reference !== reference) return generic;
  if (Date.parse(row.expiresAt ?? '') <= now.getTime()) return generic;
  if (Number(row.attempts ?? 0) >= Number(row.maxAttempts ?? MAX_CODE_ATTEMPTS)) return generic;

  const valid = safeEqual(row.codeHash, hashCode(code, row.codeSalt));
  const next = {
    ...row,
    attempts: Number(row.attempts ?? 0) + 1,
    updatedAt: now.toISOString()
  };
  if (!valid) {
    try {
      await store.putAux(PARTITION.VERIFICATION, key, next, { ifMatch: row.etag });
    } catch {
      // Ett samtidigt försök har redan räknats; svaret är fortfarande neutralt.
    }
    return generic;
  }

  // Verifiera att bokningen fortfarande är berättigad innan session utfärdas.
  const raw = await getBooking(store, reference);
  const record = raw?.record;
  if (!record || !eligibility(record, now).ok ||
      String(record.email ?? '').trim().toLowerCase() !== email) {
    return generic;
  }

  next.status = 'CONSUMED';
  next.consumedAt = now.toISOString();
  try {
    await store.putAux(PARTITION.VERIFICATION, key, next, { ifMatch: row.etag });
  } catch {
    return generic;
  }
  const session = await createSession(store, reference, now);
  return result(200, {
    token: session.token,
    expiresAt: session.expiresAt,
    reference
  });
}

// --- Tillvalskatalog och pris ---------------------------------------------

function totalGuestsFor(record) {
  const explicit = Number(record?.totalGuests);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const guests = Number(record?.guests) || 0;
  const extrahusGuests = record?.extrahus?.enabled ? Number(record.extrahus.guests) || 0 : 0;
  return Math.max(0, guests + extrahusGuests);
}

function existingLinenCount(record) {
  const addons = record?.addons ?? {};
  return addons.lakan ? Math.max(0, Number(addons.linenCount) || 0) : 0;
}

function priceOre(id) {
  return Math.round(Number(CONFIG.addons[id] ?? 0) * 100);
}

async function bufferAvailability(store, record, options = {}, context = {}) {
  const now = options.now ?? new Date();
  const addons = record.addons ?? {};
  const today = todayKey(now);
  const candidates = [];
  if (!addons.tidigIncheckning && record.bufferNightsMode === 'auto') {
    const night = addDays(record.arrival, -1);
    if (night >= today) candidates.push({ id: 'tidigIncheckning', night });
    else candidates.push({ id: 'tidigIncheckning', night, reason: 'BUFFER_IN_PAST' });
  }
  if (!addons.senUtcheckning && record.bufferNightsMode === 'auto') {
    const night = record.departure;
    if (night >= today) candidates.push({ id: 'senUtcheckning', night });
    else candidates.push({ id: 'senUtcheckning', night, reason: 'BUFFER_IN_PAST' });
  }

  const output = {};
  for (const item of candidates) {
    if (item.reason) {
      output[item.id] = { available: false, code: item.reason, nights: [item.night] };
    }
  }
  const check = candidates.filter((item) => !item.reason);
  if (!check.length) return output;
  if (!store || typeof store.listCalendarByReference !== 'function') {
    for (const item of check) {
      output[item.id] = { available: false, code: 'BUFFER_UNAVAILABLE', nights: [item.night] };
    }
    return output;
  }

  let owned;
  try {
    owned = await store.listCalendarByReference(record.reference);
  } catch {
    for (const item of check) {
      output[item.id] = { available: false, code: 'BUFFER_UNAVAILABLE', nights: [item.night] };
    }
    return output;
  }
  const ownedSet = new Set((Array.isArray(owned) ? owned : [])
    .filter((row) => row.kind === 'BUFFER' || row.type === 'BOOKING' || row.type === 'RESERVATION')
    .map((row) => row.night));
  const needed = check.filter((item) => !ownedSet.has(item.night));
  for (const item of check) {
    if (ownedSet.has(item.night)) output[item.id] = { available: true, code: '', nights: [item.night], alreadyReserved: true };
  }
  if (!needed.length) return output;

  const nights = needed.map((item) => item.night).sort();
  const from = nights[0];
  const to = addDays(nights[nights.length - 1], 1);
  let unavailable = false;
  const conflicts = new Set();
  try {
    const rows = await store.listCalendar(from, to);
    if (!Array.isArray(rows)) unavailable = true;
    else {
      for (const row of rows) {
        if (!row.night || row.reference === record.reference) continue;
        if (row.reference || ['BOOKING', 'MANUAL', 'RESERVATION'].includes(String(row.type ?? '').toUpperCase())) {
          conflicts.add(row.night);
        }
      }
    }
  } catch {
    unavailable = true;
  }
  if (!unavailable && typeof store.listBlockingBookings === 'function') {
    try {
      const bookings = await store.listBlockingBookings(from, to);
      if (!Array.isArray(bookings)) unavailable = true;
      else {
        for (const booking of bookings) {
          if (booking.reference === record.reference) continue;
          for (const night of nights) {
            if (booking.arrival <= night && booking.departure > night) conflicts.add(night);
          }
        }
      }
    } catch {
      unavailable = true;
    }
  }
  if (!unavailable) {
    try {
      const handler = options.availabilityHandler ?? handleAvailability;
      const query = new URLSearchParams({ start: from, end: to });
      const response = await handler({ query }, context, {
        ...(options.availability ?? {}),
        calendarStatusStore: store,
        forceStatusWrite: true,
        statusSource: 'existing-booking-addons',
        calendarSafetyEnabled: options.calendarSafetyEnabled,
        fetchTimeoutMs: options.availability?.fetchTimeoutMs ?? 4000,
        parseTimeoutMs: options.availability?.parseTimeoutMs ?? 6000,
        fetchMaxAttempts: 1
      });
      if (response.status !== 200 || !Array.isArray(response.jsonBody?.blocked)) unavailable = true;
      else {
        for (const night of response.jsonBody.blocked) {
          if (nights.includes(night)) conflicts.add(night);
        }
      }
    } catch {
      unavailable = true;
    }
  }
  for (const item of needed) {
    const ok = !unavailable && !conflicts.has(item.night);
    output[item.id] = {
      available: ok,
      code: ok ? '' : 'BUFFER_UNAVAILABLE',
      nights: [item.night]
    };
  }
  return output;
}

async function catalogFor(store, record, options = {}, context = {}) {
  const existing = record.addons ?? {};
  const total = totalGuestsFor(record);
  const maxLinen = Math.max(0, linenLimit(total) - existingLinenCount(record));
  const available = [];
  if (existing.slutstad !== true) {
    available.push({
      id: 'slutstad',
      label: 'Slutstädning (exklusive kök)',
      description: 'Ett engångspris per vistelse. Köket ingår inte.',
      type: 'boolean',
      unit: 'per vistelse',
      priceOre: priceOre('slutstad'),
      priceLabel: formatSek(CONFIG.addons.slutstad)
    });
  }
  if (maxLinen > 0) {
    available.push({
      id: 'lakan',
      label: 'Lakan och handdukar',
      description: 'Pris per person som behöver lakan och handdukar.',
      type: 'quantity',
      unit: 'per person',
      max: Math.min(maxLinen, LINEN_MAX),
      existingCount: existingLinenCount(record),
      priceOre: priceOre('lakan'),
      priceLabel: `${formatSek(CONFIG.addons.lakan)} per person`
    });
  }
  if (existing.ved !== true) {
    available.push({
      id: 'ved',
      label: 'Ved',
      description: 'Ett engångspris per beställning.',
      type: 'boolean',
      unit: 'per beställning',
      priceOre: priceOre('ved'),
      priceLabel: formatSek(CONFIG.addons.ved)
    });
  }

  const buffers = await bufferAvailability(store, record, options, context);
  const requestOnly = [];
  const today = todayKey(options.now ?? new Date());
  for (const [id, label] of [
    ['tidigIncheckning', 'Tidig incheckning kl. 09.00'],
    ['senUtcheckning', 'Sen utcheckning kl. 16.00']
  ]) {
    if (existing[id] === true) continue;
    const buffer = buffers[id];
    const arrivalTooSoon = id === 'tidigIncheckning' && record.arrival <= today;
    if (arrivalTooSoon) continue;
    if (buffer?.available) {
      available.push({
        id,
        label,
        description: id === 'tidigIncheckning'
          ? 'Natten före ankomst reserveras som buffert. Den räknas inte som en betald övernattning.'
          : 'Natten på avresedatumet reserveras som buffert. Den räknas inte som en betald övernattning.',
        type: 'boolean',
        unit: 'per bokning',
        priceOre: priceOre(id),
        priceLabel: formatSek(CONFIG.addons[id])
      });
    } else {
      requestOnly.push({
        id,
        label,
        reason: record.bufferNightsMode !== 'auto'
          ? 'Äldre bokning med manuella kalenderbuffertar. Skadevi kontrollerar tillgängligheten manuellt.'
          : 'Buffertnatten är inte ledig eller kunde inte verifieras just nu. Skicka en förfrågan så kontrollerar vi manuellt.',
        priceLabel: formatSek(CONFIG.addons[id])
      });
    }
  }

  // Extrahuset har egen kalender och kan aldrig direktdebiteras utan manuell
  // tillgänglighets- och prisbekräftelse.
  requestOnly.push({
    id: 'extrahus',
    label: 'Extrahus',
    reason: 'Extrahuset kräver separat tillgänglighetskontroll och bekräftas manuellt av Skadevi innan något debiteras.',
    priceLabel: `${formatSek(CONFIG.addons.extrahus)} per natt`,
    maxGuests: CONFIG.addons.extrahusMaxGuests
  });

  const rules = await loadRules(options);
  return {
    available,
    requestOnly,
    existingAddons: Array.isArray(record.addonLines) ? record.addonLines.map((line) => ({
      id: String(line.id ?? ''),
      label: String(line.label ?? ''),
      quantity: Number(line.quantity ?? 1),
      amount: Number(line.amount ?? 0)
    })) : [],
    termsVersion: rules.published ? rules.version : null,
    totalGuests: total
  };
}

function normalizeItems(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const linenRequested = source.lakan === true || Number(source.linenCount ?? source.linenQuantity ?? 0) > 0;
  const linenCount = linenRequested
    ? Math.max(0, Math.trunc(Number(source.linenCount ?? source.linenQuantity ?? 0) || 0))
    : 0;
  return {
    slutstad: source.slutstad === true,
    ved: source.ved === true,
    lakan: linenRequested,
    linenCount,
    tidigIncheckning: source.tidigIncheckning === true,
    senUtcheckning: source.senUtcheckning === true
  };
}

function purchaseError(message, code, status = 400, extra = {}) {
  return { ok: false, status, error: message, code, ...extra };
}

function computePurchase(record, input, options = {}) {
  const now = options.now ?? new Date();
  const items = normalizeItems(input);
  const today = todayKey(now);
  const existing = record.addons ?? {};
  const lines = [];
  const nextBufferNights = [];
  const ownedBuffers = new Set(Array.isArray(record.bufferNights) ? record.bufferNights.map(String) : []);

  if (items.slutstad) {
    if (existing.slutstad === true) {
      return purchaseError('Slutstädning är redan köpt till denna bokning.', 'ALREADY_PURCHASED', 409);
    }
    lines.push({ id: 'slutstad', label: 'Slutstädning (exklusive kök)', quantity: 1, unitPrice: CONFIG.addons.slutstad, amount: CONFIG.addons.slutstad, amountOre: priceOre('slutstad') });
  }
  if (items.ved) {
    if (existing.ved === true) {
      return purchaseError('Ved är redan köpt till denna bokning.', 'ALREADY_PURCHASED', 409);
    }
    lines.push({ id: 'ved', label: 'Ved', quantity: 1, unitPrice: CONFIG.addons.ved, amount: CONFIG.addons.ved, amountOre: priceOre('ved') });
  }
  if (items.lakan) {
    const total = totalGuestsFor(record);
    const max = Math.max(0, linenLimit(total) - existingLinenCount(record));
    if (items.linenCount < 1 || items.linenCount > max) {
      return purchaseError(
        max > 0
          ? `Ange antal personer som behöver lakan och handdukar (1–${max}).`
          : 'Det finns inget utrymme för fler lakan och handdukar på denna bokning.',
        'LINEN_LIMIT',
        400,
        { fields: { linenCount: `Antal lakan kan vara 1–${Math.max(0, max)}.` } }
      );
    }
    lines.push({
      id: 'lakan',
      label: 'Lakan och handdukar',
      quantity: items.linenCount,
      unitPrice: CONFIG.addons.lakan,
      amount: CONFIG.addons.lakan * items.linenCount,
      amountOre: priceOre('lakan') * items.linenCount
    });
  }
  for (const id of ['tidigIncheckning', 'senUtcheckning']) {
    if (!items[id]) continue;
    if (existing[id] === true) {
      return purchaseError(id === 'tidigIncheckning'
        ? 'Tidig incheckning är redan köpt till denna bokning.'
        : 'Sen utcheckning är redan köpt till denna bokning.', 'ALREADY_PURCHASED', 409);
    }
    if (record.bufferNightsMode !== 'auto') {
      return purchaseError(
        'Denna äldre bokning har manuella kalenderbuffertar. Skicka en förfrågan så kontrollerar Skadevi tillgängligheten manuellt.',
        'MANUAL_BUFFERS',
        409
      );
    }
    const night = id === 'tidigIncheckning' ? addDays(record.arrival, -1) : record.departure;
    if (night < today) {
      return purchaseError('Tillvalet kan inte längre köpas eftersom buffertnatten har passerat.', 'BUFFER_IN_PAST', 409);
    }
    if (!ownedBuffers.has(night)) nextBufferNights.push(night);
    lines.push({
      id,
      label: id === 'tidigIncheckning' ? 'Tidig incheckning' : 'Sen utcheckning',
      quantity: 1,
      unitPrice: CONFIG.addons[id],
      amount: CONFIG.addons[id],
      amountOre: priceOre(id)
    });
  }
  if (!lines.length) {
    return purchaseError('Välj minst ett tillval att köpa.', 'NO_ITEMS', 400);
  }
  if (lines.length > MAX_ITEMS_PER_ORDER) {
    return purchaseError('För många tillval i samma köp.', 'TOO_MANY_ITEMS', 400);
  }
  const total = lines.reduce((sum, line) => sum + Number(line.amount), 0);
  const totalOre = lines.reduce((sum, line) => sum + Number(line.amountOre), 0);
  return {
    ok: true,
    items,
    lines,
    total,
    totalOre,
    bufferNights: [...new Set(nextBufferNights)].sort()
  };
}

function mergePurchasedAddons(record, order) {
  const addons = { ...(record.addons ?? {}) };
  const items = order.items ?? {};
  if (items.slutstad) addons.slutstad = true;
  if (items.ved) addons.ved = true;
  if (items.lakan) {
    addons.lakan = true;
    const max = linenLimit(totalGuestsFor(record));
    addons.linenCount = Math.min(max, existingLinenCount(record) + Number(items.linenCount ?? 0));
  }
  if (items.tidigIncheckning) addons.tidigIncheckning = true;
  if (items.senUtcheckning) addons.senUtcheckning = true;
  return addons;
}

// --- Betalning och order ---------------------------------------------------

function orderIdempotencyHash(reference, idempotencyKey) {
  return sha256(`skadevi-addon-order:${reference}:${idempotencyKey}`).slice(0, 32);
}

async function checkPurchaseBufferAvailability(store, record, bufferNights, options, context) {
  if (!bufferNights.length) return { ok: true };
  if (record.bufferNightsMode !== 'auto') {
    return { ok: false, code: 'MANUAL_BUFFERS', conflict: true };
  }
  const from = bufferNights[0];
  const to = addDays(bufferNights[bufferNights.length - 1], 1);
  let unavailable = false;
  const conflicts = new Set();
  try {
    const rows = await store.listCalendar(from, to);
    if (!Array.isArray(rows)) unavailable = true;
    else {
      for (const row of rows) {
        if (!row.night || row.reference === record.reference) continue;
        if (row.reference || ['BOOKING', 'MANUAL', 'RESERVATION'].includes(String(row.type ?? '').toUpperCase())) {
          conflicts.add(row.night);
        }
      }
    }
  } catch {
    unavailable = true;
  }
  if (!unavailable && typeof store.listBlockingBookings === 'function') {
    try {
      const bookings = await store.listBlockingBookings(from, to);
      if (!Array.isArray(bookings)) unavailable = true;
      else {
        for (const booking of bookings) {
          if (booking.reference === record.reference) continue;
          for (const night of bufferNights) {
            if (booking.arrival <= night && booking.departure > night) conflicts.add(night);
          }
        }
      }
    } catch {
      unavailable = true;
    }
  }
  if (!unavailable) {
    try {
      const handler = options.availabilityHandler ?? handleAvailability;
      const query = new URLSearchParams({ start: from, end: to });
      const response = await handler({ query }, context, {
        ...(options.availability ?? {}),
        calendarStatusStore: store,
        forceStatusWrite: true,
        statusSource: 'existing-booking-addons-checkout',
        calendarSafetyEnabled: options.calendarSafetyEnabled,
        fetchTimeoutMs: options.availability?.fetchTimeoutMs ?? 4000,
        parseTimeoutMs: options.availability?.parseTimeoutMs ?? 6000,
        fetchMaxAttempts: 1
      });
      if (response.status !== 200 || !Array.isArray(response.jsonBody?.blocked)) unavailable = true;
      else {
        for (const night of response.jsonBody.blocked) {
          if (bufferNights.includes(night)) conflicts.add(night);
        }
      }
    } catch {
      unavailable = true;
    }
  }
  if (unavailable) return { ok: false, code: 'BUFFER_UNAVAILABLE', technical: true };
  if (conflicts.size) {
    return { ok: false, code: 'BUFFER_UNAVAILABLE', conflict: true, nights: [...conflicts].sort() };
  }
  return { ok: true };
}

async function reserveOrderBuffers(store, record, orderId, bufferNights, now) {
  const created = [];
  for (const night of bufferNights) {
    try {
      await store.createCalendarNight(night, {
        type: 'RESERVATION',
        kind: 'BUFFER',
        reference: record.reference,
        blockId: orderId,
        source: 'ADDON',
        note: 'Tillfällig buffert för tillvalsköp',
        createdBy: 'Gäst',
        createdAt: now.toISOString()
      }, { resource: 'main' });
      created.push({ night, resource: 'main' });
    } catch {
      for (const item of [...created].reverse()) {
        await store.deleteCalendarNight(item.night, record.reference, { resource: item.resource }).catch(() => {});
      }
      const conflict = new Error('Buffertnatten är inte längre ledig');
      conflict.status = 409;
      conflict.code = 'BUFFER_CONFLICT';
      conflict.nights = [night];
      throw conflict;
    }
  }
  return created;
}

async function releaseOrderBuffers(store, order) {
  if (!order || !Array.isArray(order.bufferRows) || !order.bufferRows.length) return [];
  let rows;
  try {
    rows = await store.listCalendarByReference(order.reference);
  } catch {
    return [];
  }
  const released = [];
  for (const item of order.bufferRows) {
    const row = (Array.isArray(rows) ? rows : []).find((candidate) =>
      (candidate.night ?? candidate.RowKey) === item.night &&
      (candidate.resource ?? 'main') === (item.resource ?? 'main'));
    if (!row) continue;
    if (row.blockId && row.blockId !== order.orderId) continue;
    try {
      await store.deleteCalendarNight(item.night, order.reference, { resource: item.resource ?? 'main' });
      released.push(item.night);
    } catch {
      // Lämnas till avstämning; inget frigörs på osäkra grunder.
    }
  }
  return released;
}

function createStripe(options) {
  return options.stripeClient ?? createStripeClient({
    secretKey: options.stripeSecretKey,
    allowLive: options.stripeAllowLive,
    liveConfirmationKey: options.stripeLiveConfirmationKey,
    fetchImpl: options.stripeFetchImpl,
    apiBase: options.stripeApiBase,
    timeoutMs: options.stripeTimeoutMs,
    cardEnabled: options.cardEnabled,
    swishEnabled: false
  });
}

function sessionMatchesOrder(session, stripe, order, amountOre) {
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
    (session.metadata?.source ?? '') === 'existing-booking-addons' &&
    String(session.metadata?.reference ?? '') === order.reference &&
    String(session.metadata?.addonOrderId ?? '') === order.orderId &&
    (Array.isArray(session.payment_method_types)
      ? session.payment_method_types.length === 1 &&
        String(session.payment_method_types[0]).toLowerCase() === 'card'
      : true)
  );
}

async function appendAddonHistory(store, record, action, changes, options = {}, context = {}) {
  if (typeof store.appendHistory !== 'function') return;
  const now = options.now ?? new Date();
  try {
    await store.appendHistory({
      idempotencyKey: `addon-${action}-${String(changes?.orderId ?? '')}-${now.getTime()}`,
      reference: record.reference,
      action,
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify(changes ?? {}),
      reason: '',
      actorId: 'guest',
      actorName: 'Gäst',
      correlationId: String(changes?.orderId ?? ''),
      at: now.toISOString()
    });
  } catch {
    context.warn?.(`Tillval: historik kunde inte sparas för ${record.reference}.`);
  }
}

async function handleAddonCheckout(request = {}, context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const now = options.now ?? new Date();
  if (!checkoutLimiter(request.ip ?? 'unknown', now.getTime())) {
    return result(429, { error: 'För många försök. Försök igen om en stund.', code: 'RATE_LIMITED' });
  }
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') return disabledResult();
  const token = readToken(request);
  const resolved = await resolveSession(store, token, now).catch(() => null);
  if (!resolved) {
    return result(401, { error: 'Sessionen har gått ut. Verifiera bokningen igen.', code: 'SESSION_EXPIRED' });
  }
  const reference = resolved.session.reference;
  const raw = await getBooking(store, reference);
  if (!raw || !eligibility(raw.record, now).ok) {
    return result(403, { error: 'Bokningen kan inte kompletteras just nu. Kontakta Skadevi Herrgård.', code: 'NOT_ELIGIBLE' });
  }
  const record = raw.record;
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const rules = await loadRules(options);
  if (!rules.published) {
    return result(503, { error: 'Bokningsvillkoren är inte publicerade. Försök igen senare.', code: 'RULES_NOT_PUBLISHED' });
  }
  if (body.acceptTerms !== true || String(body.termsVersion ?? '') !== rules.version) {
    return result(400, {
      error: 'Godkänn de aktuella villkoren för tillvalsköpet.',
      code: 'TERMS_NOT_ACCEPTED',
      termsVersion: rules.version
    });
  }
  const purchase = computePurchase(record, body.items, { now });
  if (!purchase.ok) {
    return result(purchase.status, { error: purchase.error, code: purchase.code, ...(purchase.fields ? { fields: purchase.fields } : {}) });
  }
  const bufferCheck = await checkPurchaseBufferAvailability(store, record, purchase.bufferNights, options, context);
  if (!bufferCheck.ok) {
    if (bufferCheck.technical) {
      return result(503, {
        error: 'Buffertnattens tillgänglighet kunde inte verifieras. Ingen betalning har startats.',
        code: bufferCheck.code
      });
    }
    return result(409, {
      error: 'Tillvalet kan inte erbjudas för valda datum eftersom buffertnatten är upptagen. Du kan skicka en förfrågan i stället.',
      code: bufferCheck.code,
      nights: bufferCheck.nights ?? []
    });
  }

  const idempotencyKey = String(request.idempotencyKey ?? body.idempotencyKey ?? '');
  if (!ID_KEY_PATTERN.test(idempotencyKey)) {
    return result(400, { error: 'Förfrågan kunde inte behandlas.', code: 'INVALID_IDEMPOTENCY_KEY' });
  }
  const baseOrderId = `ao-${orderIdempotencyHash(reference, idempotencyKey)}`;
  let orderId = baseOrderId;
  const existing = await store.getAux(PARTITION.ORDER, orderId).catch(() => null);
  if (existing) {
    if (existing.status === 'PAID') {
      return result(200, { orderId, reference, alreadyPaid: true, status: 'PAID' });
    }
    if (existing.status === 'PENDING_PAYMENT' && existing.checkoutUrl &&
        Date.parse(existing.expiresAt ?? '') > now.getTime()) {
      return result(200, {
        orderId,
        reference,
        checkoutUrl: existing.checkoutUrl,
        expiresAt: existing.expiresAt,
        totalOre: existing.totalOre
      });
    }
    if (existing.status === 'PENDING_PAYMENT' || existing.status === 'RECONCILIATION') {
      return result(409, {
        error: 'En tidigare tillvalsbetalning pågår eller behöver kontrolleras. Kontakta Skadevi Herrgård.',
        code: existing.status === 'RECONCILIATION' ? 'ORDER_RECONCILIATION' : 'ORDER_PENDING'
      });
    }
    orderId = `${baseOrderId}-${Date.now().toString(36)}`;
  }

  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return result(503, { error: 'Kortbetalning är inte tillgänglig just nu.', code: 'STRIPE_UNAVAILABLE' });
  }
  if (stripe.mode === 'live' &&
      options.allowLiveExistingBookingAddons !== true &&
      process.env.EXISTING_BOOKING_ADDONS_ALLOW_LIVE !== '1') {
    return result(503, { error: 'Funktionen är inte aktiverad för live-betalningar.', code: 'ADDONS_LIVE_BLOCKED' });
  }

  let bufferRows = [];
  try {
    bufferRows = await reserveOrderBuffers(store, record, orderId, purchase.bufferNights, now);
  } catch (error) {
    if (error?.status === 409) {
      return result(409, {
        error: 'Buffertnatten är inte längre ledig. Försök igen eller skicka en förfrågan.',
        code: 'BUFFER_CONFLICT',
        nights: error.nights ?? []
      });
    }
    return result(503, { error: 'Buffertnatten kunde inte reserveras just nu.', code: 'BUFFER_RESERVATION_FAILED' });
  }

  const base = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://www.skadeviherrgard.com';
  const expiresAtUnix = Math.floor(now.getTime() / 1000) + CHECKOUT_TTL_SECONDS;
  const expiresAt = new Date(expiresAtUnix * 1000).toISOString();
  const order = {
    kind: 'order',
    status: 'PENDING_PAYMENT',
    orderId,
    reference,
    idempotencyKey,
    items: purchase.items,
    lines: purchase.lines,
    total: purchase.total,
    totalOre: purchase.totalOre,
    currency: 'sek',
    termsVersion: rules.version,
    termsAcceptedAt: now.toISOString(),
    bufferNights: purchase.bufferNights,
    bufferRows,
    checkoutUrl: '',
    sessionId: '',
    paymentIntentId: '',
    mode: stripe.mode,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
    paidAt: '',
    appliedAt: '',
    releasedAt: ''
  };
  try {
    await store.putAux(PARTITION.ORDER, orderId, order);
  } catch {
    for (const item of bufferRows) {
      await store.deleteCalendarNight(item.night, record.reference, { resource: item.resource }).catch(() => {});
    }
    return result(503, { error: 'Tillvalsordern kunde inte sparas. Försök igen.', code: 'STORE_UNAVAILABLE' });
  }

  let session;
  try {
    session = await stripe.createCheckoutSession({
      amountOre: purchase.totalOre,
      currency: 'sek',
      paymentMethods: ['card'],
      reference: `${reference}-${orderId}`.slice(0, 200),
      productName: `Skadevi Herrgård – tillval ${reference}`,
      description: purchase.lines.map((line) => line.label).join(', ').slice(0, 500),
      customerEmail: record.email,
      successUrl: `${base}/tillval-klar?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/boka?tillval=avbruten&order=${encodeURIComponent(orderId)}`,
      expiresAt: expiresAtUnix,
      idempotencyKey: `addon-${orderId}`,
      metadata: {
        source: 'existing-booking-addons',
        reference,
        addonOrderId: orderId,
        amountOre: String(purchase.totalOre),
        termsVersion: rules.version
      }
    });
  } catch {
    for (const item of bufferRows) {
      await store.deleteCalendarNight(item.night, record.reference, { resource: item.resource }).catch(() => {});
    }
    const failed = {
      ...order,
      status: 'FAILED',
      failureCode: 'STRIPE_CHECKOUT_FAILED',
      updatedAt: now.toISOString()
    };
    await store.putAux(PARTITION.ORDER, orderId, failed, { ifMatch: order.etag }).catch(() => {});
    return result(503, { error: 'Betalningen kunde inte startas. Inget har debiterats.', code: 'STRIPE_CHECKOUT_FAILED' });
  }

  if (!sessionMatchesOrder(session, stripe, order, purchase.totalOre)) {
    try {
      await stripe.expireCheckoutSession(session?.id);
    } catch {
      // Sessionen lämnas till Stripe om den inte kunde avslutas.
    }
    for (const item of bufferRows) {
      await store.deleteCalendarNight(item.night, record.reference, { resource: item.resource }).catch(() => {});
    }
    await store.putAux(PARTITION.ORDER, orderId, {
      ...order,
      status: 'FAILED',
      failureCode: 'STRIPE_SESSION_INVALID',
      updatedAt: now.toISOString()
    }, { ifMatch: order.etag }).catch(() => {});
    return result(502, { error: 'Betalningen kunde inte verifieras. Ingen betalning har genomförts.', code: 'STRIPE_SESSION_INVALID' });
  }

  const finalOrder = {
    ...order,
    sessionId: String(session.id),
    checkoutUrl: String(session.url),
    paymentIntentId: String(session.payment_intent ?? ''),
    paymentRequest: normalizePaymentRequest({
      provider: 'stripe',
      mode: stripe.mode,
      paymentMethod: 'card',
      status: 'OPEN',
      sessionId: session.id,
      paymentIntentId: session.payment_intent ?? '',
      url: session.url,
      amountOre: purchase.totalOre,
      currency: 'sek',
      createdAt: now.toISOString(),
      expiresAt,
      createdBy: 'Gäst',
      createdById: 'guest',
      idempotencyKey: `addon-${orderId}`
    }),
    updatedAt: now.toISOString()
  };
  try {
    await store.putAux(PARTITION.ORDER, orderId, finalOrder, { ifMatch: order.etag });
  } catch {
    try {
      await stripe.expireCheckoutSession(session.id);
    } catch {
      // Lämnas till Stripe.
    }
    for (const item of bufferRows) {
      await store.deleteCalendarNight(item.night, record.reference, { resource: item.resource }).catch(() => {});
    }
    return result(503, { error: 'Tillvalsordern kunde inte sparas. Ingen betalning har genomförts.', code: 'STORE_UPDATE_FAILED' });
  }

  await appendAddonHistory(store, record, 'ADDON_ORDER_CHECKOUT_STARTED', {
    orderId,
    sessionId: session.id,
    amountOre: purchase.totalOre,
    nights: purchase.bufferNights,
    termsVersion: rules.version
  }, { now }, context);

  return result(201, {
    orderId,
    reference,
    status: 'PENDING_PAYMENT',
    checkoutUrl: session.url,
    expiresAt,
    totalOre: purchase.totalOre,
    total: purchase.total
  });
}

async function handleAddonSession(request = {}, context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') return disabledResult();
  const now = options.now ?? new Date();
  const resolved = await resolveSession(store, readToken(request), now).catch(() => null);
  if (!resolved) {
    return result(401, { error: 'Sessionen har gått ut. Verifiera bokningen igen.', code: 'SESSION_EXPIRED' });
  }
  const raw = await getBooking(store, resolved.session.reference);
  if (!raw || !eligibility(raw.record, now).ok) {
    return result(403, { error: 'Bokningen kan inte kompletteras just nu. Kontakta Skadevi Herrgård.', code: 'NOT_ELIGIBLE' });
  }
  const record = raw.record;
  const catalog = await catalogFor(store, record, { now, ...options }, context);
  return result(200, {
    reference: record.reference,
    arrival: record.arrival,
    departure: record.departure,
    nights: Number(record.nights) || 0,
    guests: Number(record.guests) || 0,
    existingAddons: catalog.existingAddons,
    available: catalog.available,
    requestOnly: catalog.requestOnly,
    termsVersion: catalog.termsVersion,
    sessionExpiresAt: resolved.session.expiresAt
  });
}

// --- Manuella tillvalsförfrågningar ---------------------------------------

function requestLabels(input = {}) {
  const labels = [];
  const source = input && typeof input === 'object' ? input : {};
  const extrahus = source.extrahus;
  if (extrahus === true || (extrahus && typeof extrahus === 'object')) {
    const nights = Number(extrahus?.nights ?? 0);
    const guests = Number(extrahus?.guests ?? 0);
    const details = [
      nights > 0 ? `${nights} nätter` : '',
      guests > 0 ? `${guests} gäster` : ''
    ].filter(Boolean).join(', ');
    labels.push({ id: 'extrahus', label: `Extrahus${details ? ` (${details})` : ''}` });
  }
  for (const id of ['tidigIncheckning', 'senUtcheckning']) {
    if (source[id] === true) {
      labels.push({
        id,
        label: id === 'tidigIncheckning' ? 'Tidig incheckning' : 'Sen utcheckning'
      });
    }
  }
  const other = String(source.otherText ?? source.other ?? '').trim().slice(0, 1000);
  if (other) labels.push({ id: 'other', label: `Annat: ${other}` });
  return labels;
}

async function handleAddonRequest(request = {}, context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') return disabledResult();
  const now = options.now ?? new Date();
  const resolved = await resolveSession(store, readToken(request), now).catch(() => null);
  if (!resolved) {
    return result(401, { error: 'Sessionen har gått ut. Verifiera bokningen igen.', code: 'SESSION_EXPIRED' });
  }
  const raw = await getBooking(store, resolved.session.reference);
  if (!raw || !eligibility(raw.record, now).ok) {
    return result(403, { error: 'Bokningen kan inte kompletteras just nu. Kontakta Skadevi Herrgård.', code: 'NOT_ELIGIBLE' });
  }
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const lines = requestLabels(body.items ?? body);
  if (!lines.length) {
    return result(400, { error: 'Beskriv vilket tillval du vill efterfråga.', code: 'NO_REQUEST_ITEMS' });
  }
  const message = String(body.message ?? '').trim().slice(0, 2000);
  const record = raw.record;
  const requestId = `ar-${now.getFullYear()}-${crypto.randomBytes(5).toString('hex')}`;
  const addonRequest = {
    kind: 'request',
    status: 'PENDING',
    requestId,
    reference: record.reference,
    lines,
    message,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  try {
    await store.putAux(PARTITION.REQUEST, requestId, addonRequest);
  } catch {
    return result(503, { error: 'Förfrågan kunde inte sparas just nu. Försök igen.', code: 'STORE_UNAVAILABLE' });
  }
  if (outboxEnabled(options) === true) {
    const notifications = buildAddonRequestNotifications(record, addonRequest);
    await Promise.all(Object.entries(notifications).map(([kind, notification]) =>
      queueNotification(
        (entry) => store.save(entry, context),
        {
          idempotencyKey: `outbox-addon-request-${requestId}-${kind}`,
          reference: record.reference,
          notification,
          createdAt: now.toISOString(),
          context
        }
      ).catch(() => ({ ok: false }))
    ));
  }
  await appendAddonHistory(store, record, 'ADDON_REQUEST_CREATED', {
    orderId: requestId,
    lines: lines.map((line) => line.id),
    message
  }, { now }, context);
  return result(201, {
    requestId,
    reference: record.reference,
    message: 'Vi har tagit emot din förfrågan. Inget har debiterats. Skadevi Herrgård återkommer med besked om tillgänglighet och pris.'
  });
}

// --- Webhook och slutlig tillämpning --------------------------------------

async function markOrderReconciliation(store, order, session, event, reason, details = {}, options = {}, context = {}) {
  const now = options.now ?? new Date();
  const next = {
    ...order,
    status: 'RECONCILIATION',
    reconciliation: {
      reason,
      code: String(details.code ?? ''),
      nights: Array.isArray(details.nights) ? details.nights.slice(0, 100) : [],
      sessionId: String(session?.id ?? ''),
      paymentIntentId: String(session?.payment_intent ?? ''),
      amountOre: Number(session?.amount_total) || 0,
      currency: String(session?.currency ?? ''),
      eventId: String(event?.id ?? ''),
      at: now.toISOString()
    },
    updatedAt: now.toISOString()
  };
  try {
    await store.putAux(PARTITION.ORDER, order.orderId, next, { ifMatch: order.etag });
    return { ok: true, order: next };
  } catch (error) {
    context.warn?.(`Tillvalsorder ${order.orderId}: avstämning kunde inte sparas.`);
    return { ok: false, retryable: true, error };
  }
}

async function queueAddonEmails(store, order, record, _summary, options = {}, context = {}) {
  if (outboxEnabled(options) !== true) return { ok: true, disabled: true };
  const now = options.now ?? new Date();
  const guest = await queueNotification(
    (entry) => store.save(entry, context),
    {
      idempotencyKey: `outbox-addon-${order.orderId}-guest`,
      reference: record.reference,
      notification: buildAddonConfirmation(record, order),
      createdAt: now.toISOString(),
      context
    }
  );
  const host = await queueNotification(
    (entry) => store.save(entry, context),
    {
      idempotencyKey: `outbox-addon-${order.orderId}-host`,
      reference: record.reference,
      notification: buildAddonHostNotification(record, order),
      createdAt: now.toISOString(),
      context
    }
  );
  return {
    ok: guest.ok === true && host.ok === true,
    guest: guest.ok === true ? 'QUEUED' : 'FAILED',
    host: host.ok === true ? 'QUEUED' : 'FAILED'
  };
}

async function convertOrderBuffersToBooking(store, order, now) {
  if (!Array.isArray(order.bufferRows) || !order.bufferRows.length) return { ok: true };
  let rows;
  try {
    rows = await store.listCalendarByReference(order.reference);
  } catch {
    return { ok: false, retryable: true };
  }
  for (const item of order.bufferRows) {
    const row = (Array.isArray(rows) ? rows : []).find((candidate) =>
      (candidate.night ?? candidate.RowKey) === item.night &&
      (candidate.resource ?? 'main') === (item.resource ?? 'main'));
    if (!row) return { ok: false, missing: [item.night] };
    if (row.blockId && row.blockId !== order.orderId) return { ok: false, missing: [item.night] };
    if (row.type === 'BOOKING') continue;
    try {
      await store.updateCalendarNight(item.night, {
        type: 'BOOKING',
        kind: 'BUFFER',
        reference: order.reference,
        blockId: order.orderId,
        source: 'ADDON',
        note: 'Kalenderbuffert för tillval',
        createdBy: 'Stripe',
        createdAt: row.createdAt || now.toISOString()
      }, { ifMatch: row.etag, resource: item.resource ?? 'main' });
    } catch {
      return { ok: false, retryable: true };
    }
  }
  return { ok: true };
}

async function applyOrderToBooking(store, order, record, rawEtag, session, options = {}, _context = {}) {
  const now = options.now ?? new Date();
  const existingOrders = Array.isArray(record.addonOrders) ? record.addonOrders : [];
  const alreadyApplied = existingOrders.some((item) => item.orderId === order.orderId);
  const payments = normalizePayments(record);
  const paymentExists = payments.some((payment) =>
    payment.stripeSessionId === String(session.id) ||
    payment.idempotencyKey === `stripe-${session.id}`);
  const payment = paymentExists
    ? payments.find((item) => item.stripeSessionId === String(session.id))
    : stripePaymentEntry(session, now, {
      method: 'CARD',
      note: `Tillvalsköp ${order.orderId}`
    });

  let next = { ...record };
  let summary = computePaymentSummary(record);
  if (!alreadyApplied) {
    const nextTotal = Number(record.total || 0) + Number(order.total || 0);
    const nextAddonLines = [
      ...(Array.isArray(record.addonLines) ? record.addonLines : []),
      ...(Array.isArray(order.lines) ? order.lines.map((line) => ({
        id: line.id,
        label: line.label,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
        orderId: order.orderId
      })) : [])
    ];
    next = {
      ...record,
      addons: mergePurchasedAddons(record, order),
      addonLines: nextAddonLines,
      bufferNights: [...new Set([
        ...(Array.isArray(record.bufferNights) ? record.bufferNights.map(String) : []),
        ...(Array.isArray(order.bufferNights) ? order.bufferNights.map(String) : [])
      ])].sort(),
      totalAddons: Number(record.totalAddons || 0) + Number(order.total || 0),
      total: nextTotal,
      calculatedTotal: nextTotal,
      addonOrders: [...existingOrders, {
        orderId: order.orderId,
        status: 'PAID',
        createdAt: order.createdAt,
        paidAt: now.toISOString(),
        appliedAt: now.toISOString(),
        total: order.total,
        totalOre: order.totalOre,
        items: order.items,
        lines: order.lines,
        sessionId: String(session.id),
        termsVersion: order.termsVersion,
        bufferNights: order.bufferNights ?? [],
        paymentId: payment?.id ?? ''
      }],
      addonPayments: [
        ...(Array.isArray(record.addonPayments) ? record.addonPayments : []),
        { ...payment, orderId: order.orderId, kind: 'ADDON' }
      ],
      paymentOpeningBalanceOre: record.paymentOpeningBalanceOre ??
        openingBalanceOreFor(record, payments),
      payments: paymentExists ? payments : [...payments, payment],
      version: Number(record.version || 1) + 1,
      updatedAt: now.toISOString(),
      updatedBy: 'Stripe'
    };
    summary = computePaymentSummary(next);
    next.amountPaid = summary.amountPaid;
    next.balance = summary.balance;
    next.paymentStatus = summary.paymentStatus;
    try {
      const saved = await store.updateRequest(next, { ifMatch: rawEtag });
      next = saved.record;
    } catch (error) {
      if (error?.status === 409) {
        // Ett samtidigt försök kan ha hunnit lägga till ordern. Läs om och
        // kontrollera att just denna order finns innan vi ger upp.
        const again = await getBooking(store, record.reference);
        if (!again || !(again.record.addonOrders ?? []).some((item) => item.orderId === order.orderId)) {
          return { ok: false, retryable: true };
        }
        next = again.record;
      } else {
        return { ok: false, retryable: true };
      }
    }
  } else {
    summary = computePaymentSummary(record);
  }

  const buffers = await convertOrderBuffersToBooking(store, order, now);
  if (!buffers.ok) return { ok: false, retryable: buffers.retryable === true, reconciliation: !buffers.retryable };

  return { ok: true, record: next, summary, payment };
}

async function finalizePaidAddonOrder(store, order, session, event, options = {}, context = {}) {
  const now = options.now ?? new Date();
  if (!order) return result(200, { received: true, ignored: 'unknown_order' });
  if (String(order.sessionId ?? '') && String(order.sessionId) !== String(session.id)) {
    return result(200, { received: true, ignored: 'session_mismatch' });
  }
  const totalOre = Number(order.totalOre);
  if (!Number.isSafeInteger(totalOre) || totalOre <= 0) {
    const reconciled = await markOrderReconciliation(store, order, session, event,
      'Tillvalsordern saknar giltigt belopp.', { code: 'AMOUNT_INVALID' }, options, context);
    return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
  }
  if (Number(session.amount_total) !== totalOre ||
      String(session.currency ?? '').toLowerCase() !== 'sek' ||
      String(session.metadata?.reference ?? '') !== order.reference ||
      String(session.metadata?.addonOrderId ?? '') !== order.orderId) {
    const reconciled = await markOrderReconciliation(store, order, session, event,
      'Stripe-sessionens belopp, valuta eller metadata matchar inte tillvalsordern.',
      { code: 'SESSION_MISMATCH' }, options, context);
    return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
  }
  if (typeof session.livemode === 'boolean' &&
      String(order.mode ?? '') &&
      session.livemode !== (order.mode === 'live')) {
    const reconciled = await markOrderReconciliation(store, order, session, event,
      'Betalningen kom från fel Stripe-läge.', { code: 'MODE_MISMATCH' }, options, context);
    return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
  }

  if (order.status === 'PAID') {
    const raw = await getBooking(store, order.reference);
    if (raw) {
      const buffers = await convertOrderBuffersToBooking(store, order, now);
      if (!buffers.ok) return result(503, { error: 'Buffertnätterna kunde inte slutföras.' });
      if (order.emailStatus?.guest !== 'QUEUED' || order.emailStatus?.host !== 'QUEUED') {
        const emails = await queueAddonEmails(store, order, raw.record, computePaymentSummary(raw.record), options, context)
          .catch(() => ({ ok: false }));
        if (emails.ok) {
          await store.putAux(PARTITION.ORDER, order.orderId, {
            ...order,
            emailStatus: { guest: emails.guest, host: emails.host },
            updatedAt: now.toISOString()
          }, { ifMatch: order.etag }).catch(() => {});
        }
      }
    }
    return result(200, { received: true, duplicate: true, orderId: order.orderId });
  }
  if (order.status === 'RECONCILIATION') {
    return result(200, { received: true, reconciliation: true, duplicate: true });
  }
  if (!['PENDING_PAYMENT', 'EXPIRED', 'FAILED'].includes(order.status)) {
    const reconciled = await markOrderReconciliation(store, order, session, event,
      `Tillvalsordern hade status ${order.status} när betalningen togs emot.`, { code: 'ORDER_STATE' }, options, context);
    return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
  }

  const raw = await getBooking(store, order.reference);
  if (!raw) {
    const reconciled = await markOrderReconciliation(store, order, session, event,
      'Bokningen hittades inte när tillvalsbetalningen togs emot.', { code: 'BOOKING_NOT_FOUND' }, options, context);
    return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
  }
  if (!eligibility(raw.record, now).ok) {
    const reconciled = await markOrderReconciliation(store, order, session, event,
      'Bokningen är inte längre bekräftad eller har avslutats. Betalningen har bevarats för manuell hantering.', { code: 'BOOKING_NOT_ELIGIBLE' }, options, context);
    return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
  }

  const nights = Array.isArray(order.bufferNights) ? order.bufferNights : [];
  if (nights.length) {
    const handler = options.availabilityHandler ?? handleAvailability;
    let fresh;
    try {
      const query = new URLSearchParams({ start: nights[0], end: addDays(nights[nights.length - 1], 1) });
      fresh = await handler({ query }, context, {
        ...(options.availability ?? {}),
        calendarStatusStore: store,
        forceStatusWrite: true,
        statusSource: 'existing-booking-addons-webhook',
        calendarSafetyEnabled: options.calendarSafetyEnabled,
        fetchTimeoutMs: options.availability?.fetchTimeoutMs ?? 4000,
        parseTimeoutMs: options.availability?.parseTimeoutMs ?? 6000,
        fetchMaxAttempts: 1
      });
    } catch {
      return result(503, { error: 'Airbnb-kalendern kunde inte verifieras. Försök igen.' });
    }
    if (fresh.status !== 200 || !Array.isArray(fresh.jsonBody?.blocked)) {
      return result(503, { error: 'Airbnb-kalendern kunde inte verifieras. Försök igen.' });
    }
    const blocked = nights.filter((night) => fresh.jsonBody.blocked.includes(night));
    if (blocked.length) {
      const reconciled = await markOrderReconciliation(store, order, session, event,
        `Buffertnatten är upptagen i Airbnb-kalendern (${blocked.join(', ')}). Betalningen har bevarats för manuell avstämning.`,
        { code: 'AIRBNB_CONFLICT', nights: blocked }, options, context);
      return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
    }
  }

  const applied = await applyOrderToBooking(store, order, raw.record, raw.etag, session, options, context);
  if (!applied.ok) {
    if (applied.reconciliation) {
      const reconciled = await markOrderReconciliation(store, order, session, event,
        'Tillvalen kunde inte läggas till eftersom buffertlåsningen saknas eller har ändrats. Betalningen har bevarats.',
        { code: 'BUFFER_OWNERSHIP' }, options, context);
      return reconciled.retryable ? result(503, { error: 'Avstämning kunde inte sparas.' }) : result(200, { received: true, reconciliation: true });
    }
    return result(503, { error: 'Tillvalen kunde inte registreras just nu.' });
  }

  const paidOrder = {
    ...order,
    status: 'PAID',
    paidAt: now.toISOString(),
    appliedAt: now.toISOString(),
    sessionId: String(session.id),
    paymentIntentId: String(session.payment_intent ?? ''),
    paymentId: applied.payment?.id ?? '',
    bookingVersion: applied.record.version,
    emailStatus: { guest: 'PENDING', host: 'PENDING' },
    updatedAt: now.toISOString()
  };
  try {
    await store.putAux(PARTITION.ORDER, order.orderId, paidOrder, { ifMatch: order.etag });
  } catch {
    // Bokningen är redan uppdaterad. En ny webhook försöker igen och ser att
    // ordern redan är tillämpad via bokningens addonOrders.
    return result(503, { error: 'Tillvalsordern kunde inte markeras som betald just nu.' });
  }

  await appendAddonHistory(store, applied.record, 'ADDON_ORDER_PAID_AND_APPLIED', {
    orderId: order.orderId,
    sessionId: session.id,
    amountOre: order.totalOre,
    lines: order.lines?.map((line) => line.id)
  }, { now }, context);

  const emails = await queueAddonEmails(store, paidOrder, applied.record, applied.summary, options, context)
    .catch(() => ({ ok: false }));
  if (emails.ok === false) {
    return result(503, { error: 'Tillvalen är registrerade men bekräftelsemejlen kunde inte köas.' });
  }
  try {
    await store.putAux(PARTITION.ORDER, order.orderId, {
      ...paidOrder,
      emailStatus: { guest: emails.guest ?? 'DISABLED', host: emails.host ?? 'DISABLED' },
      updatedAt: now.toISOString()
    }, { ifMatch: paidOrder.etag });
  } catch {
    // Mejlen är redan köade med deterministiska nycklar; nästa webhook skapar
    // inga dubbletter.
  }

  return result(200, {
    received: true,
    duplicate: false,
    orderId: order.orderId,
    reference: order.reference,
    applied: true
  });
}

async function expireAddonOrder(store, order, session, event, options = {}, context = {}) {
  const now = options.now ?? new Date();
  if (!order) return result(200, { received: true, ignored: 'unknown_order' });
  if (String(order.sessionId ?? '') && String(order.sessionId) !== String(session.id)) {
    return result(200, { received: true, ignored: 'session_mismatch' });
  }
  if (order.status === 'PAID' || order.status === 'RECONCILIATION') {
    return result(200, { received: true, ignored: 'already_finished' });
  }
  let stripe = options.stripeClient;
  if (!stripe) {
    try {
      stripe = createStripe(options);
    } catch {
      stripe = null;
    }
  }
  if (stripe) {
    try {
      const current = await stripe.retrieveCheckoutSession(session.id);
      if (current?.payment_status === 'paid') {
        return finalizePaidAddonOrder(store, order, current, event, options, context);
      }
      if (current?.status !== 'expired' && current?.status !== 'complete') {
        return result(503, { error: 'Betalningssessionen är inte avslutad ännu.' });
      }
    } catch {
      return result(503, { error: 'Stripe kunde inte verifiera sessionen.' });
    }
  } else if (options.requireStripeVerification === true) {
    return result(503, { error: 'Stripe kunde inte verifiera sessionen.' });
  }
  const released = await releaseOrderBuffers(store, order);
  const next = {
    ...order,
    status: event.type === 'checkout.session.async_payment_failed' ? 'FAILED' : 'EXPIRED',
    releasedAt: now.toISOString(),
    releasedNights: released,
    updatedAt: now.toISOString()
  };
  try {
    await store.putAux(PARTITION.ORDER, order.orderId, next, { ifMatch: order.etag });
  } catch {
    return result(503, { error: 'Tillvalsordern kunde inte uppdateras.' });
  }
  if (typeof store.appendHistory === 'function') {
    try {
      await store.appendHistory({
        idempotencyKey: `addon-order-${order.orderId}-${next.status}`,
        reference: order.reference,
        action: 'ADDON_ORDER_EXPIRED',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: next.status,
        changes: JSON.stringify({ orderId: order.orderId, released }),
        reason: '',
        actorId: 'stripe',
        actorName: 'Stripe',
        correlationId: order.orderId,
        at: now.toISOString()
      });
    } catch {
      // Historiken är inte kritisk för frigörandet.
    }
  }
  return result(200, { received: true, released: released.length > 0 });
}

async function handleAddonStripeEvent(event, session, options = {}, context = {}) {
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') return result(200, { received: true, ignored: 'no_store' });
  const orderId = String(session?.metadata?.addonOrderId ?? '').trim();
  if (!orderId) return result(200, { received: true, ignored: 'missing_order' });
  let order;
  try {
    order = await store.getAux(PARTITION.ORDER, orderId);
  } catch {
    return result(503, { error: 'Tillvalsordern kunde inte läsas.' });
  }
  if (!order) return result(200, { received: true, ignored: 'unknown_order' });
  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    return expireAddonOrder(store, order, session, event, options, context);
  }
  if (session.payment_status !== 'paid') {
    return result(200, { received: true, ignored: 'not_paid' });
  }
  return finalizePaidAddonOrder(store, order, session, event, options, context);
}

async function handleAddonAbandon(request = {}, _context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') return disabledResult();
  const now = options.now ?? new Date();
  const resolved = await resolveSession(store, readToken(request), now).catch(() => null);
  if (!resolved) return result(401, { error: 'Sessionen har gått ut.', code: 'SESSION_EXPIRED' });
  const orderId = String(request.body?.orderId ?? '').trim();
  if (!/^ao-[a-z0-9-]{20,90}$/.test(orderId)) {
    return result(400, { error: 'Ogiltig tillvalsorder.', code: 'INVALID_ORDER' });
  }
  const order = await store.getAux(PARTITION.ORDER, orderId).catch(() => null);
  if (!order) return result(200, { received: true, ignored: 'unknown_order' });
  if (order.reference !== resolved.session.reference) {
    return result(403, { error: 'Ordern tillhör inte den verifierade bokningen.', code: 'FORBIDDEN' });
  }
  if (order.status === 'PAID' || order.status === 'RECONCILIATION') {
    return result(200, { received: true, ignored: 'already_finished' });
  }
  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return result(503, { error: 'Stripe kunde inte verifiera sessionen.', code: 'STRIPE_UNAVAILABLE' });
  }
  let current;
  try {
    current = await stripe.retrieveCheckoutSession(order.sessionId);
  } catch {
    return result(503, { error: 'Stripe kunde inte verifiera sessionen.', code: 'STRIPE_UNAVAILABLE' });
  }
  if (current?.payment_status === 'paid') {
    return finalizePaidAddonOrder(store, order, current, {
      id: `abandon-${order.orderId}`,
      type: 'checkout.session.completed'
    }, options, _context);
  }
  if (current?.status === 'open') {
    try {
      await stripe.expireCheckoutSession(order.sessionId);
    } catch {
      return result(503, { error: 'Betalningssessionen kunde inte avslutas.', code: 'STRIPE_UNAVAILABLE' });
    }
  }
  return expireAddonOrder(store, order, current ?? { id: order.sessionId }, {
    id: `abandon-${order.orderId}`,
    type: 'checkout.session.expired'
  }, options, _context);
}

async function handleAddonCheckoutResult(request = {}, _context = {}, options = {}) {
  if (!addonsAvailable(options)) return disabledResult();
  const store = options.store;
  if (!store || typeof store.getAux !== 'function') return disabledResult();
  const sessionId = String(request.query?.session_id ?? '');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return result(400, { error: 'Saknar giltig betalningssession.', code: 'INVALID_SESSION' });
  }
  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return result(503, { error: 'Betalningsstatus kunde inte kontrolleras.', code: 'STRIPE_UNAVAILABLE' });
  }
  let session;
  try {
    session = await stripe.retrieveCheckoutSession(sessionId);
  } catch {
    return result(503, { error: 'Betalningsstatus kunde inte kontrolleras.', code: 'STRIPE_UNAVAILABLE' });
  }
  const orderId = String(session?.metadata?.addonOrderId ?? '');
  if (!orderId) return result(400, { error: 'Betalningssessionen saknar tillvalsorder.', code: 'MISSING_ORDER' });
  const order = await store.getAux(PARTITION.ORDER, orderId).catch(() => null);
  if (!order) return result(404, { error: 'Tillvalsordern hittades inte.', code: 'ORDER_NOT_FOUND' });
  const paid = session.payment_status === 'paid';
  return result(200, {
    orderId,
    reference: order.reference,
    status: paid ? order.status : 'PENDING_PAYMENT',
    paymentStatus: paid ? 'PAID' : String(session.payment_status ?? 'unpaid'),
    totalOre: order.totalOre,
    arrival: null,
    message: paid
      ? 'Betalningen är mottagen. En bekräftelse skickas till bokningens e-postadress när tillvalen har registrerats.'
      : 'Betalningen är inte genomförd. Inga tillval har lagts till.'
  });
}

async function listAddonOrders(store, reference) {
  if (!store || typeof store.listAux !== 'function') return [];
  const rows = await store.listAux(PARTITION.ORDER, { reference });
  return (Array.isArray(rows) ? rows : []).sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

async function listAddonRequests(store, reference) {
  if (!store || typeof store.listAux !== 'function') return [];
  const rows = await store.listAux(PARTITION.REQUEST, { reference });
  return (Array.isArray(rows) ? rows : []).sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

// Schemalagd säker städning av betalningssessioner som aldrig fick en
// webhook. Endast Stripe-verifierade, obetalda och avslutade sessioner frigörs.
async function releaseExpiredAddonOrders(store, options = {}, context = {}) {
  if (!store || typeof store.listAux !== 'function') return { scanned: 0, results: [] };
  const now = options.now ?? new Date();
  let rows;
  try {
    rows = await store.listAux(PARTITION.ORDER, { status: 'PENDING_PAYMENT' });
  } catch {
    return { scanned: 0, results: [], error: true };
  }
  const results = [];
  for (const order of (Array.isArray(rows) ? rows : []).slice(0, 25)) {
    const expiresAt = Date.parse(order.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) continue;
    try {
      const outcome = await expireAddonOrder(
        store,
        order,
        { id: order.sessionId },
        { type: 'checkout.session.expired', id: `reconcile-addon-${order.orderId}` },
        options,
        context
      );
      results.push({ orderId: order.orderId, status: outcome.status, body: outcome.jsonBody });
    } catch (error) {
      context.warn?.(`Tillvalsavstämning misslyckades för ${order.orderId}: ${error?.message ?? 'okänt fel'}`);
      results.push({ orderId: order.orderId, ok: false });
    }
  }
  return { scanned: rows.length, results };
}

module.exports = {
  addonsAvailable,
  eligibility,
  catalogFor,
  computePurchase,
  normalizeItems,
  normalizeReference,
  normalizeEmail,
  handleAddonVerifyStart,
  handleAddonVerifyConfirm,
  handleAddonSession,
  handleAddonCheckout,
  handleAddonAbandon,
  handleAddonRequest,
  handleAddonCheckoutResult,
  handleAddonStripeEvent,
  finalizePaidAddonOrder,
  expireAddonOrder,
  releaseExpiredAddonOrders,
  listAddonOrders,
  listAddonRequests,
  PARTITION,
  CODE_TTL_MS,
  SESSION_TTL_MS,
  CHECKOUT_TTL_SECONDS,
  NEUTRAL_VERIFICATION_MESSAGE
};
