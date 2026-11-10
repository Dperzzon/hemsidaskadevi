'use strict';

// Mottagning och serverhantering av bokningsförfrågningar.
//
// VIKTIGT: en bokningsförfrågan är ALDRIG en bekräftad bokning. Alla poster
// sparas med status "Inväntar godkännande" och skickas aldrig till Airbnb.
//
// Skydd (dokumenterat i docs/bokningsflode.md):
// - Totalstängning: inskick nekas tills BOOKING_REQUESTS_ENABLED=1 sätts
//   efter att hela kedjan (lagring, Logic Apps, regler) verifierats/godkänts.
// - Bokningsreglerna (publicerade i server/booking/house-rules.json) måste
//   godkännas med aktuell version.
// - Permanent lagring: Azure Table Storage med Managed Identity (Entra);
//   utan konfiguration nekas inskick.
// - Tillgängligheten kontrolleras alltid på serversidan mot Airbnb-kalendern
//   innan registrering; överlappande väntande förfrågningar tillåts men
//   flaggas — Airbnb-iCal ger ingen atomär låsning, Skadevi avgör.
// - E-post: notiser skrivs som utkorgsposter i lagringen; Logic Apps
//   (recurrence-pollning, se infra/logicapp/) skickar dem via den befintliga
//   Gmail-anslutningen. Ingen publikt oskyddad webhook används.

const crypto = require('node:crypto');
const { handleAvailability } = require('../calendar/availability');
const { loadRules } = require('./rules');
const { createStore } = require('./store');
const { bestDiscount } = require('./pricing');
const { MAIL } = require('./mail');

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

  const nights = nightsBetween(arrival, departure);
  const discount = bestDiscount(nights); // rabatt på boendepriset (besluten logik)

  return {
    record: {
      arrival,
      departure,
      nights,
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
      // Rabatten lagras som information (gäller boendepriset som bekräftas
      // i offerten) — ingen total prisberäkning sker på serversidan.
      discount: discount ? { id: discount.id, label: discount.label, percent: discount.percent } : null,
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

// HTML-escapar gästuppgifter så att Logic Apps-flödet aldrig tolkar dem som
// HTML-kod — skyddar mot infogad HTML/skript i mejlen.
function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Bygger notiserna (värd + gäst) som läggs i utkorgen i lagringen. Den
// verkliga e-postleveransen sker i Logic Apps (recurrence-pollning av
// utkorgspartitionen, se infra/logicapp/). Varje mejl märker tydligt att
// förfrågan inte är en bekräftad bokning.
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
    record.discount ? `Rabatt (dras av från boendepriset i offerten): ${record.discount.label} ${record.discount.percent} %` : null,
    `Bokningsregler godkända (version ${record.rulesVersion})`,
    record.overlaps?.length ? `VARNING — ÖVERLAPP med annan väntande förfrågan: ${record.overlaps.join(', ')}. Avgör själv vilken som ska godkännas. Ingen av dem är bekräftad.` : null,
    record.message ? `Önskemål: ${record.message}` : null
  ].filter(Boolean).join('\n');
  const htmlRows = [
    `Referens: ${escapeHtml(record.reference)}`,
    `Status: ${escapeHtml(record.status)}`,
    `Vistelse: ${escapeHtml(record.arrival)} → ${escapeHtml(record.departure)} (${record.nights} nätter)`,
    `Gäster: ${record.guests}`,
    `Namn: ${escapeHtml(record.firstName)} ${escapeHtml(record.lastName)}`,
    `E-post: ${escapeHtml(record.email)}`,
    `Telefon: ${escapeHtml(record.phone)}`,
    record.company ? `Företag: ${escapeHtml(record.company)}` : null,
    record.addons.lakan ? `Lakan/handdukar till: ${record.addons.linenCount} personer` : null,
    'Tillval:',
    ...(addonLines.length ? addonLines.map(escapeHtml) : ['- Inga']),
    `Summa tillval: ${record.totalAddons} kr`,
    record.discount ? `Rabatt (dras av från boendepriset i offerten): ${escapeHtml(record.discount.label)} ${record.discount.percent} %` : null,
    `Bokningsregler godkända (version ${escapeHtml(record.rulesVersion)})`,
    record.overlaps?.length ? `VARNING — ÖVERLAPP med annan väntande förfrågan: ${record.overlaps.map(escapeHtml).join(', ')}. Avgör själv vilken som ska godkännas. Ingen av dem är bekräftad.` : null,
    record.message ? `Önskemål: ${escapeHtml(record.message)}` : null
  ].filter(Boolean).map((row) => `<li>${row}</li>`).join('');
  const disclaimer = 'OBS: Detta är en bokningsförfrågan (status: Inväntar godkännande) — inte en bekräftad bokning.';
  return {
    host: {
      to: MAIL.hostRecipient,
      replyTo: MAIL.replyTo,
      subject: `Bokningsförfrågan ${record.reference} — Inväntar godkännande`,
      body: summary,
      html: `<h2>Bokningsförfrågan ${escapeHtml(record.reference)}</h2><p><strong>${disclaimer}</strong></p><ul>${htmlRows}</ul>`
    },
    guest: {
      to: record.email,
      replyTo: MAIL.replyTo,
      subject: `Vi har tagit emot din bokningsförfrågan (${record.reference})`,
      body: `Tack för din bokningsförfrågan! Vi har tagit emot dina önskemål och återkommer med besked om tillgänglighet och bokning. Din vistelse är ännu inte bekräftad. ${disclaimer}`,
      html: `<p>Tack för din bokningsförfrågan! Vi har tagit emot dina önskemål och återkommer med besked om tillgänglighet och bokning. <strong>Din vistelse är ännu inte bekräftad.</strong></p><p>${disclaimer}</p>`
    }
  };
}

async function saveOutbox(store, record, context) {
  for (const [key, notification] of Object.entries(buildNotifications(record))) {
    try {
      await store.save({
        partition: 'outbox',
        idempotencyKey: `outbox-${record.idempotencyKey}-${key}`,
        status: 'Utkorg',
        mailTo: notification.to,
        mailReplyTo: notification.replyTo ?? '',
        mailSubject: notification.subject,
        mailHtml: notification.html,
        attemptCount: 0,
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

  // 0. Totalstängning: bokningsinskick hålls avstängt tills hela kedjan
  // (lagring, Logic Apps, regler) är verifierad och godkänd. Aktiveras
  // uttryckligen via BOOKING_REQUESTS_ENABLED=1 (miljö) eller options.enabled.
  const enabled = options.enabled ?? process.env.BOOKING_REQUESTS_ENABLED === '1';
  if (!enabled) {
    return {
      status: 503, headers: API_HEADERS,
      jsonBody: { error: 'Bokningsförfrågningar kan inte tas emot via formuläret just nu. Vänligen kontakta oss direkt.' }
    };
  }

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

  // 7. Överlapp mot andra väntande förfrågningar: eftersom Airbnb-iCal inte
  // ger atomär låsning av datum tillåts flera förfrågningar för samma period.
  // Ingen av dem blir bekräftad; varje värdnotis flaggar överlappen så att
  // Skadevi avgör vilken som ska godkännas.
  let overlaps = [];
  try {
    const pending = await store.listPending();
    overlaps = pending
      .filter((other) => other.idempotencyKey !== idempotencyKey &&
        other.arrival < validated.record.departure && other.departure > validated.record.arrival)
      .map((other) => `${other.reference} (${other.arrival}–${other.departure})`);
  } catch {
    // Överlappskontrollen får aldrig blockera registreringen.
  }

  // 8. Unik referens (genereras på serversidan, kontrolleras mot lagringen).
  const makeReferenceFn = options.makeReference ?? makeReference;
  let reference = makeReferenceFn(now);
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await store.findByReference(reference).catch(() => null);
    if (!clash) break;
    reference = makeReferenceFn(now);
  }

  // 9. Spara förfrågan med status "Inväntar godkännande" (aldrig en bekräftad
  // bokning — bekräftelse görs endast manuellt av Skadevi).
  const record = {
    ...validated.record,
    idempotencyKey,
    reference,
    status: 'Inväntar godkännande',
    overlaps,
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
  createRateLimiter, makeReference, buildNotifications, escapeHtml,
  FIELD_LIMITS, MAX_GUESTS, MAX_NIGHTS
};
