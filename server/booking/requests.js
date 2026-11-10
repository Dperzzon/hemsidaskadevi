'use strict';

// Mottagning och serverhantering av bokningsförfrågningar.
//
// VIKTIGT: en bokningsförfrågan är ALDRIG en bekräftad bokning. Alla poster
// sparas med status "Inväntar godkännande" och skickas aldrig till Airbnb.
//
// Beslutspunkter (dokumenterade i docs/bokningsflode.md):
// - Bokningsreglerna måste vara publicerade i server/booking/house-rules.json
//   innan förfrågningar tas emot (annars 503).
// - Permanent lagring: Azure Table Storage; utan konfiguration nekas inskick.
// - E-postleverans: notiser skrivs som utkorgsposter i lagringen; val av
//   e-postleverantör (t.ex. SendGrid/Azure Communication Services/SMTP) är en
//   separat beslutspunkt och den verkliga leveransen är avstängd tills dess.

const crypto = require('node:crypto');
const { handleAvailability } = require('../calendar/availability');
const { loadRules } = require('./rules');
const { createStore } = require('./store');

const MAX_GUESTS = 24;
const MAX_NIGHTS = 93;
const FIELD_LIMITS = {
  firstName: 80,
  lastName: 80,
  email: 120,
  phone: 32,
  company: 120,
  message: 2000
};
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9 ()-]{5,32}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function validDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function todayKey(now = new Date()) {
  // Dagdatum i Sverige (Europe/Stockholm) enligt samma semantik som
  // kalenderns tillgänglighetsdata.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function nightsBetween(arrival, departure) {
  return Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
}

function nightKeys(arrival, departure) {
  const nights = [];
  let date = arrival;
  while (date < departure) {
    nights.push(date);
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  return nights;
}

function trimmedString(value, limit) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return String(value);
  return value.trim().slice(0, limit);
}

// Validerar inkommande data. Returnerar { record } eller { errors }.
function validatePayload(body, now = new Date()) {
  const errors = {};
  const today = todayKey(now);

  const arrival = typeof body.arrival === 'string' ? body.arrival : '';
  const departure = typeof body.departure === 'string' ? body.departure : '';
  if (!validDate(arrival)) errors.arrival = 'Ogiltigt ankomstdatum.';
  if (!validDate(departure)) errors.departure = 'Ogiltigt avresedatum.';
  if (!errors.arrival && !errors.departure) {
    const nights = nightsBetween(arrival, departure);
    if (nights < 1) errors.arrival = 'Avresedatum måste vara efter ankomstdatum.';
    else if (nights > MAX_NIGHTS) errors.arrival = 'Vistelsen får omfatta högst 93 nätter.';
    else if (arrival < today) errors.arrival = 'Ankomstdatum får inte vara i det förflutna.';
  }

  const firstName = trimmedString(body.firstName, FIELD_LIMITS.firstName);
  const lastName = trimmedString(body.lastName, FIELD_LIMITS.lastName);
  const email = trimmedString(body.email, FIELD_LIMITS.email).toLowerCase();
  const phone = trimmedString(body.phone, FIELD_LIMITS.phone);
  const company = trimmedString(body.company, FIELD_LIMITS.company);
  const message = trimmedString(body.message, FIELD_LIMITS.message);

  if (!firstName) errors.firstName = 'Ange förnamn.';
  if (!lastName) errors.lastName = 'Ange efternamn.';
  if (!email || !EMAIL_PATTERN.test(email)) errors.email = 'Ange en giltig e-postadress.';
  if (!phone || !PHONE_PATTERN.test(phone)) errors.phone = 'Ange ett giltigt telefonnummer.';

  const guests = Number(body.guests);
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) {
    errors.guests = 'Ange antal gäster (1–24).';
  }

  const addons = body.addons && typeof body.addons === 'object' && !Array.isArray(body.addons) ? body.addons : {};
  const linenCount = addons.lakan ? Number(addons.linenCount) : 0;
  if (!Number.isInteger(linenCount) || linenCount < 1 || linenCount > 40) {
    errors.linenCount = 'Ange hur många personer som behöver lakan och handdukar (1–40).';
  }

  if (!body.consentRules) errors.consentRules = 'Bokningsreglerna måste godkännas.';

  if (Object.keys(errors).length) return { errors };

  return {
    record: {
      arrival,
      departure,
      nights: nightsBetween(arrival, departure),
      guests,
      firstName,
      lastName,
      email,
      phone,
      company,
      message,
      addons: {
        slutstad: addons.slutstad === true,
        lakan: addons.lakan === true,
        linenCount,
        ved: addons.ved === true,
        tidigIncheckning: addons.tidigIncheckning === true,
        senUtcheckning: addons.senUtcheckning === true
      },
      totalAddons: Number(body.totalAddons) || 0,
      rulesVersion: typeof body.rulesVersion === 'string' ? body.rulesVersion.slice(0, 64) : '',
      consentContact: body.consentContact === true
    }
  };
}

// Enkel minnesbaserad hastighetsbegränsning per IP (skydd mot missbruk).
function createRateLimiter(options = {}) {
  const max = options.max ?? RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const hits = new Map();
  return function allow(ip, now = Date.now()) {
    const timestamps = (hits.get(ip) ?? []).filter((time) => now - time < windowMs);
    if (timestamps.length >= max) {
      hits.set(ip, timestamps);
      return false;
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    if (hits.size > 10000) {
      for (const [key, list] of hits) {
        if (list.every((time) => now - time >= windowMs)) hits.delete(key);
      }
    }
    return true;
  };
}

function makeReference(now = new Date()) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = crypto.randomBytes(6);
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `SK-${now.getFullYear()}-${suffix}`;
}

// Bygger notiserna (värd + gäst) som läggs i utkorgen i lagringen. Den
// verkliga e-postleveransen är en separat beslutspunkt (se ovan).
function buildNotifications(record) {
  const addonLines = [];
  if (record.addons.slutstad) addonLines.push('Slutstädning (exklusive kök): 2 500 kr');
  if (record.addons.lakan) addonLines.push(`Lakan och handdukar: ${record.addons.linenCount} pers × 200 kr`);
  if (record.addons.ved) addonLines.push('Ved: 350 kr');
  if (record.addons.tidigIncheckning) addonLines.push('Tidig incheckning (önskemål): 500 kr');
  if (record.addons.senUtcheckning) addonLines.push('Sen utcheckning (önskemål): 500 kr');
  const summary = [
    `Referens: ${record.reference}`,
    `Status: ${record.status}`,
    `Vistelse: ${record.arrival} → ${record.departure} (${record.nights} nätter)`,
    `Gäster: ${record.guests}`,
    `Namn: ${record.firstName} ${record.lastName}`,
    `E-post: ${record.email}`,
    `Telefon: ${record.phone}`,
    record.company ? `Företag: ${record.company}` : null,
    record.addons.lakan ? `Lakan/handdukar till: ${record.addons.linenCount} personer` : null,
    'Tillval:',
    ...(addonLines.length ? addonLines : ['- Inga']),
    `Summa tillval: ${record.totalAddons} kr`,
    `Bokningsregler godkända (version ${record.rulesVersion})`,
    record.message ? `Önskemål: ${record.message}` : null
  ].filter(Boolean).join('\n');
  return {
    host: { to: 'host', subject: `Bokningsförfrågan ${record.reference} — Inväntar godkännande`, body: summary },
    guest: {
      to: 'guest',
      subject: `Vi har tagit emot din bokningsförfrågan (${record.reference})`,
      body: 'Tack för din bokningsförfrågan! Vi har tagit emot dina önskemål och återkommer med besked om tillgänglighet och bokning. Din vistelse är ännu inte bekräftad.'
    }
  };
}

async function saveOutbox(store, record, context) {
  for (const [key, notification] of Object.entries(buildNotifications(record))) {
    try {
      await store.save({
        idempotencyKey: `outbox-${record.idempotencyKey}-${key}`,
        reference: record.reference,
        status: 'Utkorg',
        arrival: notification.to,
        departure: notification.subject,
        nights: 0,
        guests: 0,
        firstName: 'notis',
        lastName: record.reference,
        email: notification.to,
        phone: '',
        company: '',
        message: notification.body,
        addons: {},
        totalAddons: 0,
        rulesVersion: record.rulesVersion,
        consentContact: false,
        createdAt: record.createdAt
      }, context);
    } catch {
      context.warn?.(`Utkorgspost kunde inte sparas för ${record.reference}.`);
    }
  }
}

// Huvudhanteraren: handleBookingRequest({ body, idempotencyKey, ip }, context, options).
async function handleBookingRequest(request, context, options = {}) {
  const warn = context.warn ?? (() => {});
  const now = options.now ?? new Date();

  // 1. Bokningsreglerna måste vara publicerade innan förfrågningar tas emot.
  const rules = await loadRules(options);
  if (!rules.published) {
    return {
      status: 503, headers: API_HEADERS,
      jsonBody: { error: 'Bokningsreglerna är inte publicerade ännu. Förfrågningar kan tyvärr inte tas emot just nu.' }
    };
  }

  // 2. Durabel lagring krävs (lokal fil är inte tillräcklig i produktion).
  const store = createStore(options);
  if (store.type !== 'azure-table' && options.requireDurableStore !== false) {
    return {
      status: 503, headers: API_HEADERS,
      jsonBody: { error: 'Förfrågningar kan tyvärr inte tas emot just nu. Vänligen kontakta oss direkt.' }
    };
  }

  // 3. Missbruksskydd.
  const allow = options.rateLimiter ?? createRateLimiter(options.rateLimit);
  if (!allow(request.ip, now.getTime())) {
    return {
      status: 429, headers: API_HEADERS,
      jsonBody: { error: 'För många förfrågningar. Vänligen försök igen om en stund.' }
    };
  }

  // 4. Idempotens: samma nyckel ger samma svar utan ny post.
  const idempotencyKey = typeof request.idempotencyKey === 'string' ? request.idempotencyKey : '';
  if (!ID_KEY_PATTERN.test(idempotencyKey)) {
    return { status: 400, headers: API_HEADERS, jsonBody: { error: 'Förfrågan kunde inte skickas.' } };
  }
  const existing = await store.findByIdempotencyKey(idempotencyKey).catch(() => null);
  if (existing) {
    return { status: 200, headers: API_HEADERS, jsonBody: { reference: existing.reference, status: existing.status, duplicate: true } };
  }

  // 5. Fältvalidering.
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  // Honungsgrop för bottar: dolt fält som aldrig fylls i av människor.
  if (trimmedString(body.webbsida, 200)) {
    return { status: 400, headers: API_HEADERS, jsonBody: { error: 'Förfrågan kunde inte skickas.' } };
  }
  const validated = validatePayload(body, now);
  if (validated.errors) {
    return { status: 400, headers: API_HEADERS, jsonBody: { error: 'Kontrollera uppgifterna i formuläret.', fields: validated.errors } };
  }
  if (validated.record.rulesVersion !== rules.version) {
    return {
      status: 400, headers: API_HEADERS,
      jsonBody: { error: 'Bokningsreglerna har uppdaterats. Vänligen läs dem igen och godkänn dem.', fields: { consentRules: 'Bokningsreglerna har uppdaterats — godkänn den aktuella versionen.' } }
    };
  }

  // 6. Serverkontroll av tillgängligheten (aldrig lita på klienten).
  const availabilityHandler = options.availabilityHandler ?? handleAvailability;
  let availability;
  try {
    const query = new URLSearchParams({ start: validated.record.arrival, end: validated.record.departure });
    availability = await availabilityHandler({ query }, context, options.availability ?? {});
  } catch {
    availability = { status: 503 };
  }
  if (availability.status !== 200 || !Array.isArray(availability.jsonBody?.blocked)) {
    return {
      status: 503, headers: API_HEADERS,
      jsonBody: { error: 'Tillgängligheten kunde inte kontrolleras just nu. Vänligen försök igen om en stund — era datum har inte sparats.' }
    };
  }
  const blockedNights = nightKeys(validated.record.arrival, validated.record.departure)
    .filter((night) => availability.jsonBody.blocked.includes(night));
  if (blockedNights.length) {
    return {
      status: 409, headers: API_HEADERS,
      jsonBody: { error: 'Några av de valda nätterna är inte längre tillgängliga. Vänligen välj andra datum i kalendern.', blockedNights }
    };
  }

  // 7. Spara förfrågan med status "Inväntar godkännande" och unik referens.
  const record = {
    ...validated.record,
    idempotencyKey,
    reference: makeReference(now),
    status: 'Inväntar godkännande',
    createdAt: now.toISOString()
  };
  try {
    const saved = await store.save(record, { warn });
    const savedRecord = saved.record;
    await saveOutbox(store, savedRecord, { warn });
    return {
      status: 201, headers: API_HEADERS,
      jsonBody: {
        reference: savedRecord.reference,
        status: savedRecord.status,
        nights: savedRecord.nights,
        arrival: savedRecord.arrival,
        departure: savedRecord.departure,
        totalAddons: savedRecord.totalAddons
      }
    };
  } catch {
    warn('Bokningsförfrågan kunde inte sparas.');
    return {
      status: 500, headers: API_HEADERS,
      jsonBody: { error: 'Förfrågan kunde inte sparas just nu. Vänligen försök igen om en stund.' }
    };
  }
}

module.exports = {
  handleBookingRequest, validatePayload, nightsBetween, nightKeys, todayKey,
  createRateLimiter, makeReference, buildNotifications,
  FIELD_LIMITS, MAX_GUESTS, MAX_NIGHTS
};
