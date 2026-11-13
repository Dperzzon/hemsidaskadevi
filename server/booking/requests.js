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
const { quote, PRICE_VERSION } = require('./pricing');
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
  if (addons.lakan && (!Number.isInteger(linenCount) || linenCount < 0 || linenCount > guests)) {
    errors.linenCount = 'Ange hur många personer som behöver lakan och handdukar (0 till antal gäster).';
  }

  if (!body.consentRules) errors.consentRules = 'Bokningsreglerna måste godkännas.';

  if (Object.keys(errors).length) return { errors };

  const nights = nightsBetween(arrival, departure);

  // AUKTORITATIV PRISBERÄKNING PÅ SERVERN: belopp från klienten (t.ex.
  // body.totalAddons) ignoreras alltid — servern räknar om hela offerten
  // utifrån datum, gäster och valda tillval.
  const pricing = quote({
    arrival, departure, guests,
    addons: {
      slutstad: addons.slutstad === true,
      lakan: addons.lakan === true,
      linenCount,
      ved: addons.ved === true,
      tidigIncheckning: addons.tidigIncheckning === true,
      senUtcheckning: addons.senUtcheckning === true
    }
  });

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
      // Serverberäknad offert — sparad i fullhet så att lagringsposten är
      // verifierbar (pris per natt, rabatt, tillval, total, regelversion).
      lodgingBase: pricing.lodgingBase,
      peakNights: pricing.peakNights,
      peakBase: pricing.peakBase,
      nightlyBreakdown: pricing.nightlyBreakdown,
      discount: pricing.discount
        ? { id: pricing.discount.id, label: pricing.discount.label, percent: pricing.discount.percent, amount: pricing.discountAmount }
        : null,
      discountAmount: pricing.discountAmount,
      lodgingAfterDiscount: pricing.lodgingAfterDiscount,
      addonLines: pricing.addonLines,
      totalAddons: pricing.addonsTotal,
      total: pricing.total,
      priceVersion: PRICE_VERSION,
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

const MAIL_BRAND = {
  gold: '#c9a96e',
  dark: '#333333',
  background: '#f7f5f0',
  border: '#e0dcd3',
  muted: '#6b665d'
};

// Gemensam, e-postvänlig ram (inline-stilar, tabellayout) med Skadevis
// visuella identitet. Allt användarinnehåll escapeas innan det läggs in.
function emailShell(title, contentHtml) {
  return `<!doctype html><html lang="sv"><body style="margin:0;padding:0;background:${MAIL_BRAND.background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MAIL_BRAND.background};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid ${MAIL_BRAND.border};border-top:4px solid ${MAIL_BRAND.gold};">
<tr><td style="padding:26px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:${MAIL_BRAND.dark};">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;letter-spacing:1px;color:${MAIL_BRAND.dark};">Skadevi Herrgård</div>
<div style="height:2px;width:56px;background:${MAIL_BRAND.gold};margin:12px 0 22px;"></div>
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:normal;color:${MAIL_BRAND.dark};margin:0 0 18px;">${escapeHtml(title)}</h1>
${contentHtml}
<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid ${MAIL_BRAND.border};font-size:12px;color:${MAIL_BRAND.muted};">Detta mejl skickades av Skadevi Herrgårds bokningssystem.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function mailList(rows) {
  return `<ul style="margin:10px 0 18px;padding-left:20px;">${rows.map((row) => `<li style="margin:5px 0;">${row}</li>`).join('')}</ul>`;
}

// Bygger notiserna (värd + gäst) som läggs i utkorgen i lagringen. Den
// verkliga e-postleveransen sker i Logic Apps (recurrence-pollning av
// utkorgspartitionen, se infra/logicapp/). Varje mejl märker tydligt att
// förfrågan inte är en bekräftad bokning och använder den serverberäknade
// prissnapshoten — inga belopp räknas om här.
function buildNotifications(record) {
  const addonLines = record.addonLines ?? [];
  const priceLines = [
    `Boendepris före rabatt: ${record.lodgingBase} kr`,
    record.discount ? `Rabatt (${record.discount.label} ${record.discount.percent} %): − ${record.discountAmount} kr` : null,
    `Boendepris efter rabatt: ${record.lodgingAfterDiscount} kr`,
    `Summa tillval: ${record.totalAddons} kr`,
    `TOTALPRIS FÖR HELA VISTELSEN: ${record.total} kr`,
    `Prisreglernas version: ${record.priceVersion}`
  ].filter(Boolean);
  const addonLinesText = addonLines.length
    ? addonLines.map((line) => `${line.label}: ${line.amount} kr`)
    : ['- Inga'];
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
    'Prisöversikt (serverberäknad):',
    ...priceLines,
    'Tillval:',
    ...addonLinesText,
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
    'Prisöversikt (serverberäknad):',
    ...priceLines.map((row) => escapeHtml(row)),
    'Tillval:',
    ...addonLinesText.map(escapeHtml),
    `Bokningsregler godkända (version ${escapeHtml(record.rulesVersion)})`,
    record.overlaps?.length ? `VARNING — ÖVERLAPP med annan väntande förfrågan: ${record.overlaps.map(escapeHtml).join(', ')}. Avgör själv vilken som ska godkännas. Ingen av dem är bekräftad.` : null,
    record.message ? `Önskemål: ${escapeHtml(record.message)}` : null
  ].filter(Boolean);
  const disclaimer = 'OBS: Detta är en bokningsförfrågan (status: Inväntar godkännande) — inte en bekräftad bokning.';
  const guestPriceLines = [
    `Boendepris efter rabatt: ${record.lodgingAfterDiscount} kr`,
    record.discount ? `Rabatt (${record.discount.label} ${record.discount.percent} %): − ${record.discountAmount} kr` : null,
    `Summa tillval: ${record.totalAddons} kr`,
    record.total != null ? `Beräknat totalpris: ${record.total} kr` : null
  ].filter(Boolean);
  const guestLines = [
    `Referens: ${record.reference}`,
    `Vistelse: ${record.arrival} → ${record.departure} (${record.nights} nätter)`,
    `Gäster: ${record.guests}`,
    ...guestPriceLines,
    'Tillval:',
    ...addonLinesText
  ];
  const guestIntro = 'Tack för din bokningsförfrågan! Vi har tagit emot dina önskemål och återkommer med besked om tillgänglighet och bokning.';
  const notConfirmed = 'Din vistelse är ännu inte bekräftad. Detta är inte en bekräftad bokning. Vi återkommer när förfrågan har behandlats.';
  const hostContent = `<div style="background:#fff8e6;border-left:4px solid ${MAIL_BRAND.gold};padding:12px 16px;margin:0 0 18px;"><strong>Status: ${escapeHtml(record.status)}</strong><br>Detta är en bokningsförfrågan — inte en bekräftad bokning.</div>${mailList(htmlRows)}`;
  const guestContent = `<p style="margin:0 0 12px;">Hej ${escapeHtml(record.firstName)},</p>
<p style="margin:0 0 16px;">${escapeHtml(guestIntro)}</p>
<div style="background:#fff8e6;border-left:4px solid ${MAIL_BRAND.gold};padding:12px 16px;margin:0 0 20px;"><strong>${escapeHtml(notConfirmed)}</strong></div>
${mailList(guestLines.map(escapeHtml))}
<p style="margin:0 0 16px;">Har du frågor är du välkommen att svara direkt på detta mejl.</p>
<p style="margin:0;">Vänliga hälsningar,<br><strong>Skadevi Herrgård</strong></p>`;
  return {
    host: {
      mailType: 'HOST_NEW_REQUEST',
      to: MAIL.hostRecipient,
      replyTo: MAIL.replyTo,
      subject: `Ny bokningsförfrågan – ${record.reference}`,
      body: `${summary}\n\n${disclaimer}`,
      html: emailShell(`Ny bokningsförfrågan – ${record.reference}`, hostContent)
    },
    guest: {
      mailType: 'GUEST_REQUEST_ACK',
      to: record.email,
      replyTo: MAIL.replyTo,
      subject: `Vi har tagit emot din bokningsförfrågan (${record.reference})`,
      body: `${guestIntro}\n\n${notConfirmed}\n\n${guestLines.join('\n')}\n\n${disclaimer}`,
      html: emailShell('Tack för din bokningsförfrågan', guestContent)
    }
  };
}

async function saveOutbox(store, record, context) {
  for (const [key, notification] of Object.entries(buildNotifications(record))) {
    try {
      await store.save({
        partition: 'outbox',
        idempotencyKey: `outbox-${record.idempotencyKey}-${key}`,
        reference: record.reference,
        mailType: notification.mailType,
        status: 'Utkorg',
        mailTo: notification.to,
        mailReplyTo: notification.replyTo ?? '',
        mailSubject: notification.subject,
        mailHtml: notification.html,
        mailText: notification.body,
        dispatchEligible: 'true',
        outboxVersion: '1',
        deliveryStatus: 'Ej skickad',
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
    statusCode: 'PENDING',
    status: 'Inväntar godkännande',
    bookingSource: 'WEB',
    version: 1,
    paymentStatus: 'UNPAID',
    amountPaid: 0,
    balance: validated.record.total,
    latestNote: '',
    overlaps,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
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
        guests: savedRecord.guests,
        lodgingBase: savedRecord.lodgingBase,
        lodgingAfterDiscount: savedRecord.lodgingAfterDiscount,
        discount: savedRecord.discount,
        totalAddons: savedRecord.totalAddons,
        total: savedRecord.total,
        priceVersion: savedRecord.priceVersion
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
