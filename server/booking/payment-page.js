'use strict';

const crypto = require('node:crypto');
const { createStripeClient, StripeError } = require('./stripe');
const {
  normalizePaymentRequest,
  normalizePaymentRequests,
  latestPaymentRequest,
  formatOre
} = require('./payment-ledger');
const {
  hashPaymentToken,
  verifyPaymentToken,
  paymentAvailability
} = require('./payment-access');
const {
  createInvoiceRequest,
  activeInvoiceRequest,
  normalizeInvoiceRequests
} = require('./invoice-requests');
const { buildInvoiceNotifications: buildSharedInvoiceNotifications } = require('./booking-mail');
const { queueNotifications } = require('./outbox');
const { renderFooter } = require('../../shared/footer.js');
const { renderAnalyticsHead, renderPurchaseEvent } = require('../../shared/analytics.js');

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow'
};
const MAX_PAYMENT_REQUESTS = 20;

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

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    dateStyle: 'long',
    timeStyle: 'short'
  }).format(date);
}

function pageResponse(html, status = 200) {
  return { status, headers: PAGE_HEADERS, html };
}

function redirectResponse(location, analytics) {
  const headers = { ...PAGE_HEADERS, Location: location };
  if (analytics && Number.isSafeInteger(analytics.valueOre) && analytics.valueOre > 0) {
    headers['X-Payment-Value-Ore'] = String(analytics.valueOre);
    headers['X-Payment-Currency'] = 'SEK';
  }
  return {
    status: 303,
    headers,
    html: ''
  };
}

function layout(title, content, options = {}) {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
${renderAnalyticsHead()}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)} — Skadevi Gård</title>
  <link rel="icon" type="image/png" href="/images/logo.png">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/fonts.css">
  <style>
    .payment-page { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
    .payment-page h1 { margin-bottom: 8px; }
    .payment-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 24px 0; }
    .payment-summary div { border: 1px solid var(--color-border); padding: 12px 16px; }
    .payment-summary dt { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; opacity: .65; }
    .payment-summary dd { margin: 4px 0 0; font-weight: 600; }
    .payment-box { border: 1px solid var(--color-border); padding: 24px; margin: 24px 0; }
    .payment-box h2 { margin-top: 0; }
    .payment-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .payment-form-grid .full { grid-column: 1 / -1; }
    .payment-form-grid label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
    .payment-form-grid input, .payment-form-grid textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--color-border); font: inherit; }
    .payment-error { border-left: 4px solid #9d3b2c; background: #fbefec; padding: 12px 16px; margin: 12px 0; }
    .payment-note { font-size: 14px; opacity: .8; }
    .payment-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
    @media (max-width: 640px) { .payment-form-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<header class="header" role="banner">
  <div class="header-inner">
    <a href="/" class="header-logo" aria-label="Skadevi Gård — Hem">Skadevi Gård</a>
  </div>
</header>
<main>
  <div class="payment-page">${content}</div>
</main>
${renderFooter()}
${options.purchase ? renderPurchaseEvent(options.purchase) : ''}
</body>
</html>`;
}

function contactBlock() {
  return `<p class="payment-note">Kontakta Skadevi Herrgård på
    <a href="tel:+46702730422">+46 70 273 04 22</a> eller
    <a href="mailto:skadevigard@gmail.com">skadevigard@gmail.com</a> om du har frågor.</p>`;
}

function renderErrorPage(status, code, message) {
  const title = status === 410 ? 'Länken har gått ut' : 'Betalningssidan kan inte öppnas';
  return pageResponse(layout(title, `<h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message || 'Länken är ogiltig eller har gått ut.')}</p>
    <p>Ingen betalning har startats.</p>
    ${contactBlock()}
    <p><a class="btn btn-primary" href="/">Till startsidan</a></p>`), status);
}

function summaryBlock(record, summary) {
  return `<dl class="payment-summary">
    <div><dt>Referens</dt><dd>${escapeHtml(record.reference)}</dd></div>
    <div><dt>Vistelse</dt><dd>${escapeHtml(formatDateKey(record.arrival))} – ${escapeHtml(formatDateKey(record.departure))}</dd></div>
    <div><dt>Totalt</dt><dd>${escapeHtml(formatOre(summary.totalOre))}</dd></div>
    <div><dt>Betalt</dt><dd>${escapeHtml(formatOre(summary.paidOre))}</dd></div>
    <div><dt>Att betala</dt><dd>${escapeHtml(formatOre(summary.remainingOre))}</dd></div>
  </dl>`;
}

function cardBox(token, options) {
  if (!options.stripeEnabled || options.cardEnabled === false) return '';
  return `<div class="payment-box">
    <h2>Betala med kort</h2>
    <p>Betalningen genomförs i Stripes säkra kortbetalning. Skadevi ser aldrig dina kortuppgifter.</p>
    <form method="post" action="/api/payments/${encodeURIComponent(token)}/card" data-analytics-checkout="card">
      <button class="btn btn-primary" type="submit">Betala med kort</button>
    </form>
    ${options.cardError ? `<p class="payment-error">${escapeHtml(options.cardError)}</p>` : ''}
  </div>`;
}

function swishBox(token, options) {
  if (!options.stripeEnabled || options.swishEnabled !== true) return '';
  return `<div class="payment-box">
    <h2>Betala med Swish</h2>
    <p>Betalningen genomförs i Stripes säkra betalningsflöde och godkänns i Swish-appen. Skadevi ser aldrig dina bankuppgifter.</p>
    <form method="post" action="/api/payments/${encodeURIComponent(token)}/swish" data-analytics-checkout="swish">
      <button class="btn btn-primary" type="submit">Betala med Swish</button>
    </form>
    ${options.swishError ? `<p class="payment-error">${escapeHtml(options.swishError)}</p>` : ''}
  </div>`;
}

function invoiceField(name, label, value, error, options = {}) {
  const type = options.type ?? 'text';
  const required = options.required ? ' required' : '';
  const full = options.full ? ' class="full"' : '';
  const input = type === 'textarea'
    ? `<textarea name="${name}" rows="3" maxlength="${options.maxlength ?? 500}"${required}>${escapeHtml(value ?? '')}</textarea>`
    : `<input type="${type}" name="${name}" value="${escapeHtml(value ?? '')}" maxlength="${options.maxlength ?? 200}"${required}>`;
  return `<label${full}>${escapeHtml(label)}${input}${error ? `<span class="field-error">${escapeHtml(error)}</span>` : ''}</label>`;
}

function invoiceBox(record, token, options) {
  const active = activeInvoiceRequest(record);
  const requests = normalizeInvoiceRequests(record);
  const draft = options.invoiceDraft ?? {};
  const errors = options.invoiceErrors ?? {};
  const history = requests.length
    ? `<p class="payment-note">Tidigare fakturabegäranden: ${requests.map((request) =>
      `${escapeHtml(request.statusLabel)} ${escapeHtml(formatDateTime(request.createdAt))}`).join(' · ')}</p>`
    : '';
  if (active) {
    return `<div class="payment-box">
      <h2>Faktura</h2>
      <p class="payment-error">Din fakturabegäran är registrerad och har status <strong>${escapeHtml(active.statusLabel)}</strong>.</p>
      <p>Belopp: ${escapeHtml(formatOre(active.amountOre))} · Begärd ${escapeHtml(formatDateTime(active.createdAt))}</p>
      <p class="payment-note">Skadevi hanterar begäran manuellt. Ingen faktura skickas automatiskt och bokningen markeras inte som betald.</p>
      ${history}
    </div>`;
  }
  return `<div class="payment-box">
    <h2>Begär faktura</h2>
    <p>Fyll i fakturauppgifterna. Skadevi hanterar begäran manuellt. Ingen faktura skickas automatiskt och bokningen markeras inte som betald.</p>
    <form method="post" action="/api/payments/${encodeURIComponent(token)}/invoice-request">
      <input type="hidden" name="requestId" value="${crypto.randomUUID()}">
      <div class="payment-form-grid">
        ${invoiceField('invoiceName', 'Faktureras till', draft.invoiceName ?? ([record.firstName, record.lastName].filter(Boolean).join(' ') || record.company), errors.invoiceName, { required: true, maxlength: 120 })}
        ${invoiceField('invoiceOrgNumber', 'Organisationsnummer (valfritt)', draft.invoiceOrgNumber, errors.invoiceOrgNumber, { maxlength: 20 })}
        ${invoiceField('invoiceAddress', 'Fakturaadress', draft.invoiceAddress, errors.invoiceAddress, { required: true, maxlength: 200, full: true })}
        ${invoiceField('invoicePostalCode', 'Postnummer', draft.invoicePostalCode, errors.invoicePostalCode, { required: true, maxlength: 10 })}
        ${invoiceField('invoiceCity', 'Ort', draft.invoiceCity, errors.invoiceCity, { required: true, maxlength: 80 })}
        ${invoiceField('invoiceEmail', 'E-post för faktura', draft.invoiceEmail ?? record.email, errors.invoiceEmail, { required: true, type: 'email', maxlength: 320 })}
        ${invoiceField('invoiceReference', 'Er referens (valfritt)', draft.invoiceReference, errors.invoiceReference, { maxlength: 120 })}
        ${invoiceField('invoiceNotes', 'Övrigt (valfritt)', draft.invoiceNotes, errors.invoiceNotes, { type: 'textarea', full: true, maxlength: 500 })}
      </div>
      ${options.invoiceError ? `<p class="payment-error">${escapeHtml(options.invoiceError)}</p>` : ''}
      <div class="payment-actions"><button class="btn btn-secondary" type="submit">Skicka fakturabegäran</button></div>
    </form>
    ${history}
  </div>`;
}

function renderPaymentPage(record, token, summary, options = {}, status = 200) {
  const notices = [];
  if (options.notice) notices.push(options.notice);
  const paymentStatus = options.query?.payment ?? options.query?.swish ?? options.query?.card;
  if (paymentStatus === 'success') {
    notices.push('Betalningen genomfördes. Vi registrerar den så snart Stripe bekräftar den.');
  } else if (paymentStatus === 'cancelled') {
    notices.push('Betalningen avbröts. Inget belopp har dragits.');
  } else if (options.query?.invoice === 'requested') {
    notices.push('Din fakturabegäran är registrerad.');
  }
  const paid = summary.remainingOre <= 0;
  const card = cardBox(token, options);
  const swish = swishBox(token, options);
  const digitalBoxes = `${card}${swish}`;
  const noDigital = !card && !swish;
  return pageResponse(layout('Betala din bokning', `<h1>Betala din bokning</h1>
    <p>Bokningen är bekräftad. Här kan du betala med kort eller begära faktura.</p>
    ${notices.map((notice) => `<p class="payment-error">${escapeHtml(notice)}</p>`).join('')}
    ${summaryBlock(record, summary)}
    ${paid
      ? '<div class="payment-box"><h2>Bokningen är betald</h2><p>Det finns inget utestående belopp.</p></div>'
      : `${noDigital ? '<div class="payment-box"><h2>Digital betalning</h2><p class="payment-error">Digital betalning är inte tillgänglig just nu. Du kan begära faktura nedan.</p></div>' : digitalBoxes}${invoiceBox(record, token, options)}`}
    ${contactBlock()}
  `), status);
}

async function loadPaymentContext(store, token, now = new Date()) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return { ok: false, code: 'PAYMENT_LINK_INVALID' };
  }
  if (!store || typeof store.getByPaymentTokenHash !== 'function') {
    throw new Error('Betalningssidan saknar lagring');
  }
  const raw = await store.getByPaymentTokenHash(hashPaymentToken(token));
  if (!raw) return { ok: false, code: 'PAYMENT_LINK_INVALID' };
  const verified = verifyPaymentToken(raw.record, token, now);
  if (!verified.ok) return { ok: false, code: verified.code };
  let calendarRows = null;
  let calendarRange = typeof store.listCalendar === 'function' ? null : undefined;
  try {
    calendarRows = await store.listCalendarByReference(raw.record.reference);
    if (typeof store.listCalendar === 'function') {
      calendarRange = await store.listCalendar(raw.record.arrival, raw.record.departure);
    }
  } catch {
    calendarRows = null;
    calendarRange = typeof store.listCalendar === 'function' ? null : undefined;
  }
  const availability = paymentAvailability(raw.record, { now, calendarRows, calendarRange });
  if (!availability.ok) {
    return { ok: false, code: availability.code, record: raw.record, summary: availability.summary };
  }
  return {
    ok: true,
    raw,
    record: raw.record,
    access: availability.access,
    summary: availability.summary
  };
}

function availabilityError(result) {
  if (result.code === 'PAYMENT_LINK_EXPIRED' || result.code === 'PAYMENT_LINK_REVOKED') {
    return renderErrorPage(410, result.code, 'Betalningslänken har gått ut eller återkallats.');
  }
  if (result.code === 'PAID') {
    return pageResponse(layout('Bokningen är betald', `<h1>Bokningen är betald</h1>
      <p>Det finns inget utestående belopp.</p>${contactBlock()}`));
  }
  if (result.code === 'NOT_CONFIRMED') {
    return renderErrorPage(409, result.code, 'Bokningen är inte bekräftad. Kontakta Skadevi Herrgård.');
  }
  if (result.code === 'CALENDAR_LOCK_MISSING' || result.code === 'CALENDAR_UNAVAILABLE' ||
      result.code === 'CALENDAR_LOCK_INVALID' || result.code === 'CALENDAR_CONFLICT') {
    return renderErrorPage(409, result.code, 'Bokningens kalenderlås kunde inte verifieras. Kontakta Skadevi Herrgård.');
  }
  return renderErrorPage(404, result.code, 'Betalningslänken är ogiltig eller har gått ut.');
}

async function handlePaymentPage(request, context = {}, options = {}) {
  const now = options.now ?? new Date();
  const token = String(request?.token ?? '');
  try {
    const result = await loadPaymentContext(options.store, token, now);
    if (!result.ok) return availabilityError(result);
    return renderPaymentPage(result.record, token, result.summary, {
      stripeEnabled: options.stripeEnabled === true,
      cardEnabled: options.cardEnabled !== false,
      swishEnabled: options.swishEnabled === true,
      query: request?.query ?? {},
      invoiceError: options.invoiceError,
      invoiceErrors: options.invoiceErrors,
      invoiceDraft: options.invoiceDraft,
      notice: options.notice
    });
  } catch (error) {
    context.warn?.(`Betalningssidan kunde inte läsas: ${error?.message ?? 'okänt fel'}`);
    return renderErrorPage(503, 'PAYMENT_PAGE_UNAVAILABLE', 'Betalningssidan är tillfälligt otillgänglig.');
  }
}

function paymentUnavailableMessage(error, method) {
  const code = String(error?.code ?? '').toLowerCase();
  const message = String(error?.message ?? '').toLowerCase();
  const label = method === 'card' ? 'Kortbetalningen' : 'Swish';
  const unavailable = code.includes('payment_method_not_available') ||
    code.includes('payment_method') ||
    message.includes('payment method') ||
    message.includes(method);
  if (unavailable) {
    return method === 'card'
      ? 'Kortbetalningen är inte aktiverad på Stripe-kontot. Kontakta Skadevi Herrgård så hjälper vi dig.'
      : 'Swish är inte aktiverat på Stripe-kontot. Kontakta Skadevi Herrgård så hjälper vi dig.';
  }
  return `${label} kunde inte startas just nu. Försök igen om en stund eller begär faktura.`;
}

async function startCheckout(result, token, method, options, context) {
  const now = options.now ?? new Date();
  const record = result.record;
  const methodLabel = method === 'card' ? 'Kort' : 'Swish';
  const errorKey = method === 'card' ? 'cardError' : 'swishError';
  const methodEnabled = method === 'card'
    ? options.cardEnabled !== false
    : options.swishEnabled === true;
  if (options.stripeEnabled !== true || !methodEnabled) {
    return renderPaymentPage(record, token, result.summary, {
      stripeEnabled: options.stripeEnabled === true,
      cardEnabled: options.cardEnabled !== false,
      swishEnabled: options.swishEnabled === true,
      [errorKey]: `${methodLabel} är inte tillgängligt just nu. Du kan begära faktura i stället.`,
      notice: `${methodLabel} är inte tillgängligt just nu. Du kan begära faktura i stället.`
    });
  }
  let stripe;
  try {
    stripe = options.stripeClient ?? createStripeClient({
      secretKey: options.stripeSecretKey,
      allowLive: options.stripeAllowLive,
      fetchImpl: options.stripeFetchImpl,
      apiBase: options.stripeApiBase,
      timeoutMs: options.stripeTimeoutMs,
      cardEnabled: options.cardEnabled,
      swishEnabled: options.swishEnabled
    });
  } catch (error) {
    context.warn?.(`${methodLabel} är inte konfigurerat: ${error?.code ?? 'okänt'}`);
    return renderPaymentPage(record, token, result.summary, {
      stripeEnabled: options.stripeEnabled === true,
      cardEnabled: options.cardEnabled !== false,
      swishEnabled: options.swishEnabled === true,
      [errorKey]: paymentUnavailableMessage(error, method)
    });
  }

  const requests = normalizePaymentRequests(record);
  const active = requests.find((request) =>
    request.status === 'OPEN' &&
    request.paymentMethod === method &&
    request.mode === stripe.mode &&
    request.amountOre === result.summary.remainingOre &&
    request.url &&
    (!request.expiresAt || Date.parse(request.expiresAt) > now.getTime())
  );
  if (active) return redirectResponse(active.url, { valueOre: result.summary.remainingOre });

  const base = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://www.skadeviherrgard.com';
  const referenceParam = encodeURIComponent(record.reference);
  const idempotencyKey = `${method}-${record.reference}-${result.summary.remainingOre}-${record.version ?? 1}-${Math.floor(now.getTime() / 3600000)}`;
  let session;
  try {
    session = await stripe.createCheckoutSession({
      amountOre: result.summary.remainingOre,
      currency: 'sek',
      paymentMethods: [method],
      reference: record.reference,
      productName: `Skadevi Herrgård – ${record.reference}`,
      description: `${record.arrival} – ${record.departure}, ${record.nights} nätter, ${record.guests} gäster`,
      customerEmail: record.email,
      successUrl: `${base}/betalning-klar?ref=${referenceParam}`,
      cancelUrl: `${base}/betalning-avbruten?ref=${referenceParam}`,
      idempotencyKey,
      metadata: { reference: record.reference, source: 'guest-payment-page' }
    });
  } catch (error) {
    const code = error instanceof StripeError ? error.code : 'STRIPE_ERROR';
    context.warn?.(`${methodLabel} Checkout misslyckades: ${code}`);
    return renderPaymentPage(record, token, result.summary, {
      stripeEnabled: options.stripeEnabled === true,
      cardEnabled: options.cardEnabled !== false,
      swishEnabled: options.swishEnabled === true,
      [errorKey]: paymentUnavailableMessage(error, method)
    }, 503);
  }

  let sessionUrl = null;
  try { sessionUrl = new URL(String(session?.url ?? '')); } catch { sessionUrl = null; }
  const validSession = session && session.id && sessionUrl &&
    sessionUrl.protocol === 'https:' &&
    /(^|\.)stripe\.com$/i.test(sessionUrl.hostname) &&
    Number(session.amount_total) === result.summary.remainingOre &&
    String(session.currency ?? '').toLowerCase() === 'sek' &&
    (session.mode ? session.mode === 'payment' : true) &&
    (typeof session.livemode === 'boolean' ? session.livemode === (stripe.mode === 'live') : true) &&
    (session.client_reference_id ? session.client_reference_id === record.reference : true) &&
    (session.metadata?.reference ? session.metadata.reference === record.reference : true) &&
    (Array.isArray(session.payment_method_types)
      ? session.payment_method_types.length === 1 && String(session.payment_method_types[0]).toLowerCase() === method
      : true);
  if (!validSession) {
    context.warn?.(`${methodLabel} Checkout returnerade ett oväntat svar.`);
    if (session?.id) {
      try { await stripe.expireCheckoutSession(session.id); } catch { /* best effort */ }
    }
    return renderPaymentPage(record, token, result.summary, {
      stripeEnabled: options.stripeEnabled === true,
      cardEnabled: options.cardEnabled !== false,
      swishEnabled: options.swishEnabled === true,
      [errorKey]: 'Betalningen kunde inte verifieras. Ingen betalning har genomförts.'
    }, 502);
  }

  const updatedRequests = requests.map((request) => request.status === 'OPEN'
    ? { ...request, status: 'SUPERSEDED', statusLabel: 'Ersatt', updatedAt: now.toISOString() }
    : request);
  const expiresAtUnix = Number(session.expires_at) || Math.floor(now.getTime() / 1000) + 86400;
  const paymentRequest = normalizePaymentRequest({
    provider: 'stripe',
    mode: stripe.mode,
    paymentMethod: method,
    status: 'OPEN',
    sessionId: session.id,
    paymentIntentId: session.payment_intent ?? '',
    url: session.url,
    amountOre: result.summary.remainingOre,
    currency: 'sek',
    createdAt: now.toISOString(),
    expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
    createdBy: 'Gäst',
    createdById: 'guest',
    idempotencyKey
  });
  const nextRequests = [...updatedRequests, paymentRequest].slice(-MAX_PAYMENT_REQUESTS);
  const updatedRecord = {
    ...record,
    paymentRequests: nextRequests,
    paymentRequest: latestPaymentRequest(nextRequests),
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: 'Gäst'
  };
  try {
    await options.store.updateRequest(updatedRecord, { ifMatch: result.raw.etag });
  } catch (error) {
    try { await stripe.expireCheckoutSession(session.id); } catch { /* best effort */ }
    if (error?.status === 409) {
      const reloaded = await loadPaymentContext(options.store, token, now);
      const existing = reloaded.ok
        ? normalizePaymentRequests(reloaded.record).find((request) => request.sessionId === session.id)
        : null;
      if (existing?.url) return redirectResponse(existing.url, { valueOre: result.summary.remainingOre });
    }
    context.warn?.(`${methodLabel}-session kunde inte sparas för ${record.reference}.`);
    return pageResponse(layout(`${methodLabel} kunde inte startas`, `<h1>${methodLabel} kunde inte startas</h1>
      <p class="payment-error">Betalningen kunde inte sparas. Försök igen eller begär faktura.</p>
      ${contactBlock()}`), 503);
  }

  try {
    await options.store.appendHistory({
      idempotencyKey: `${method}-${session.id}-started`,
      reference: record.reference,
      action: method === 'card' ? 'CARD_CHECKOUT_STARTED' : 'SWISH_CHECKOUT_STARTED',
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify({ sessionId: session.id, amountOre: result.summary.remainingOre, paymentMethod: method }),
      reason: '',
      actorId: 'guest',
      actorName: 'Gäst',
      correlationId: crypto.randomUUID(),
      at: now.toISOString()
    });
  } catch {
    context.warn?.(`${methodLabel}-historik kunde inte sparas för ${record.reference}.`);
  }

  return redirectResponse(session.url, { valueOre: result.summary.remainingOre });
}

function buildInvoiceNotifications(record, request) {
  return buildSharedInvoiceNotifications(record, request);
}

async function queueInvoiceOutbox(store, record, request, options, context) {
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const outboxContext = {
    ...context,
    appendHistory: typeof store.appendHistory === 'function'
      ? (entry) => store.appendHistory(entry)
      : undefined
  };
  const results = await queueNotifications(
    (entry) => store.save(entry, context),
    buildInvoiceNotifications(record, request),
    {
      idempotencyKeyPrefix: `outbox-invoice-${request.id}`,
      reference: record.reference,
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
  return {
    ok: results.every((result) => result.ok),
    queued: results.some((result) => result.ok && result.duplicate !== true)
  };
}

async function submitInvoice(result, token, form, options, context) {
  const now = options.now ?? new Date();
  const encodedToken = encodeURIComponent(token);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = attempt === 0 ? result : await loadPaymentContext(options.store, token, now);
    if (!current.ok) return availabilityError(current);
    const created = createInvoiceRequest(current.record, form, {
      now,
      amountOre: current.summary.remainingOre
    });
    if (!created.ok) {
      if (created.code === 'INVOICE_REQUEST_EXISTS') {
        return renderPaymentPage(current.record, token, current.summary, {
          stripeEnabled: options.stripeEnabled === true,
          cardEnabled: options.cardEnabled !== false,
          swishEnabled: options.swishEnabled === true,
          notice: 'Din fakturabegäran är redan registrerad.'
        });
      }
      if (created.code === 'INVOICE_VALIDATION_FAILED') {
        return renderPaymentPage(current.record, token, current.summary, {
          stripeEnabled: options.stripeEnabled === true,
          cardEnabled: options.cardEnabled !== false,
          swishEnabled: options.swishEnabled === true,
          invoiceErrors: created.errors,
          invoiceDraft: form,
          invoiceError: 'Kontrollera fakturauppgifterna.'
        }, 400);
      }
      return renderPaymentPage(current.record, token, current.summary, {
        stripeEnabled: options.stripeEnabled === true,
        cardEnabled: options.cardEnabled !== false,
        swishEnabled: options.swishEnabled === true,
        invoiceError: 'Fakturabegäran kunde inte registreras. Kontakta Skadevi Herrgård.'
      });
    }
    if (created.duplicate) {
      return renderPaymentPage(current.record, token, current.summary, {
        stripeEnabled: options.stripeEnabled === true,
        cardEnabled: options.cardEnabled !== false,
        swishEnabled: options.swishEnabled === true,
        notice: 'Din fakturabegäran är redan registrerad.'
      });
    }
    const updatedRecord = {
      ...created.record,
      version: Number(current.record.version || 1) + 1,
      updatedAt: now.toISOString(),
      updatedBy: 'Gäst'
    };
    try {
      await options.store.updateRequest(updatedRecord, { ifMatch: current.raw.etag });
      try {
        await options.store.appendHistory({
          idempotencyKey: `invoice-${created.request.id}-created`,
          reference: current.record.reference,
          action: 'INVOICE_REQUEST_CREATED',
          fromStatus: current.record.statusCode ?? '',
          toStatus: current.record.statusCode ?? '',
          changes: JSON.stringify({
            invoiceRequestId: created.request.id,
            amountOre: created.request.amountOre
          }),
          reason: '',
          actorId: 'guest',
          actorName: 'Gäst',
          correlationId: crypto.randomUUID(),
          at: now.toISOString()
        });
      } catch {
        context.warn?.(`Fakturahistorik kunde inte sparas för ${current.record.reference}.`);
      }
      await queueInvoiceOutbox(options.store, updatedRecord, created.request, options, context);
      return redirectResponse(`/betala/${encodedToken}?invoice=requested`);
    } catch (error) {
      lastError = error;
      if (error?.status !== 409 || attempt === 2) break;
    }
  }
  context.warn?.(`Fakturabegäran kunde inte sparas (${lastError?.message ?? 'okänt fel'}).`);
  return pageResponse(layout('Fakturabegäran kunde inte sparas', `<h1>Fakturabegäran kunde inte sparas</h1>
    <p class="payment-error">Försök igen om en stund. Ingen betalning har genomförts.</p>
    ${contactBlock()}
    <p><a class="btn btn-primary" href="/betala/${encodeURIComponent(token)}">Tillbaka till betalningssidan</a></p>`), 503);
}

async function handlePaymentAction(request, context = {}, options = {}) {
  const now = options.now ?? new Date();
  const token = String(request?.token ?? '');
  try {
    const result = await loadPaymentContext(options.store, token, now);
    if (!result.ok) return availabilityError(result);
    if (request.action === 'card') return startCheckout(result, token, 'card', options, context);
    if (request.action === 'swish') return startCheckout(result, token, 'swish', options, context);
    if (request.action === 'invoice') {
      return submitInvoice(result, token, request.form ?? {}, options, context);
    }
    return renderErrorPage(404, 'PAYMENT_ACTION_UNKNOWN', 'Åtgärden kunde inte tolkas.');
  } catch {
    context.warn?.('Betalningsåtgärden kunde inte genomföras.');
    return renderErrorPage(503, 'PAYMENT_ACTION_UNAVAILABLE', 'Betalningssidan är tillfälligt otillgänglig.');
  }
}

module.exports = {
  PAGE_HEADERS,
  handlePaymentPage,
  handlePaymentAction,
  renderPaymentPage,
  renderErrorPage,
  loadPaymentContext,
  layout
};
