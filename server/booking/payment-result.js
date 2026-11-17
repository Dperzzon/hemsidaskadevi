'use strict';

const {
  normalizePaymentRequests,
  normalizePayments,
  computePaymentSummary
} = require('./payment-ledger');
const { createStripeClient } = require('./stripe');

const REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,80}$/;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;

const RESULT_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow'
};

const CONTACT_PHONE = '+46 70 273 04 22';
const CONTACT_PHONE_HREF = 'tel:+46702730422';
const CONTACT_EMAIL = 'skadevigard@gmail.com';

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return '';
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    dateStyle: 'long'
  }).format(date);
}

function formatOre(ore) {
  const value = Number(ore || 0) / 100;
  return `${new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: Number(ore || 0) % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value)} kr`;
}

function pageResponse(html, status = 200) {
  return { status, headers: RESULT_HEADERS, html };
}

const ICON_CANCEL = `<svg viewBox="0 0 64 64" role="img" aria-hidden="true" focusable="false">
  <circle cx="32" cy="32" r="25" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M22 32h20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const ICON_SUCCESS = `<svg viewBox="0 0 64 64" role="img" aria-hidden="true" focusable="false">
  <circle cx="32" cy="32" r="25" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M20 33.5 28.5 42 45 24.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICON_NEUTRAL = `<svg viewBox="0 0 64 64" role="img" aria-hidden="true" focusable="false">
  <circle cx="32" cy="32" r="25" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M32 19v16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle cx="32" cy="43" r="1.8" fill="currentColor"/>
</svg>`;

const HEADER = `<header class="header" role="banner">
  <div class="header-side">
    <button class="mobile-toggle" aria-label="Meny" aria-expanded="false">&#9776;</button>
    <a href="/foretag" class="header-link">Företag</a>
    <a href="/fest" class="header-link">Fest</a>
    <a href="/brollop" class="header-link">Bröllop</a>
    <a href="/semester" class="header-link">Semester</a>
  </div>
  <a href="/" class="header-logo"><img width="512" height="512" src="/images/logo.png" alt="Skadevi Gård"></a>
  <div class="header-side">
    <a href="/digital-visning" class="header-link">Digital visning</a>
    <a href="/boende" class="header-link">Boendet</a>
    <a href="/aktiviteter" class="header-link">Aktiviteter</a>
    <a href="/boka" class="header-link">Bilder</a>
  </div>
  <nav class="header-nav" role="navigation" aria-label="Meny">
    <a href="/foretag">Företag</a>
    <a href="/fest">Fest</a>
    <a href="/brollop">Bröllop</a>
    <a href="/semester">Semester</a>
    <a href="/digital-visning">Digital visning</a>
    <a href="/boende">Boendet</a>
    <a href="/aktiviteter">Aktiviteter</a>
    <a href="/boka">Bilder</a>
    <a href="/boka">Boka</a>
    <a href="/vanliga-fragor">Vanliga frågor</a>
  </nav>
</header>`;

const FOOTER = `<footer class="footer" role="contentinfo">
  <div class="footer-grid">
    <div class="footer-col footer-col-contact">
      <h3>Kontakta oss</h3>
      <p><a href="${CONTACT_PHONE_HREF}">${CONTACT_PHONE}</a></p>
      <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
      <p>Skoklostervägen 16<br>746 94 Häggeby</p>
      <p><a href="https://maps.google.com/?q=Skoklosterv%C3%A4gen+16+746+94+H%C3%A4ggeby" target="_blank" rel="noopener" class="maps-link">Visa på karta</a></p>
    </div>
    <div class="footer-col footer-col-image">
      <img width="750" height="500" src="/images/gallery/huset-logga.webp" alt="Skadevi Gård" loading="lazy">
    </div>
    <div class="footer-col footer-col-social">
      <h3>Följ oss</h3>
      <div class="social-links">
        <a href="https://www.instagram.com/skadevigard/" target="_blank" rel="noopener"><img loading="lazy" width="750" height="500" src="/images/sociala-symboler.webp" alt="Följ oss på sociala medier" class="social-symbol-img"></a>
      </div>
    </div>
  </div>
  <div class="footer-bottom"><p>&copy; <span data-year>2025</span> Skadevi Gård</p></div>
</footer>`;

function layout({ title, kind, icon, kicker, heading, subheading, card }) {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)} — Skadevi Gård</title>
  <link rel="icon" type="image/png" href="/images/logo.png">
  <link rel="preload" as="font" type="font/woff2" href="/fonts/v20-UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2" crossorigin>
  <link rel="preload" as="font" type="font/woff2" href="/fonts/v24-kmKUZrc3Hgbbcjq75U4uslyuy4kn0olVQ-LglH6T17uj8Q4iDgNP.woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/fonts.css">
</head>
<body class="payment-result-page payment-result-page--${kind}">
${HEADER}
<main id="main">
  <section class="payment-hero payment-hero--${kind}" aria-labelledby="result-title">
    <div class="payment-hero-bg" aria-hidden="true">
      <img src="/images/hero-startsida.webp" alt="" width="1600" height="900">
    </div>
    <div class="payment-hero-inner">
      <span class="payment-hero-icon payment-hero-icon--${kind}" aria-hidden="true">${icon}</span>
      <span class="payment-hero-kicker">${kicker}</span>
      <h1 id="result-title">${heading}</h1>
      <p class="payment-hero-sub">${subheading}</p>
    </div>
  </section>
  <section class="payment-result-section" aria-label="Betalningsinformation">
    <div class="payment-result-card">
      ${card}
    </div>
  </section>
</main>
${FOOTER}
<script type="module" src="/js/main.js"></script>
</body>
</html>`;
}

function contactBlock() {
  return `<div class="payment-contact">
    <p><span>Telefon</span><a href="${CONTACT_PHONE_HREF}">${CONTACT_PHONE}</a></p>
    <p><span>E-post</span><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
  </div>`;
}

function actionLink(href, label, variant = 'primary') {
  return `<a class="payment-btn payment-btn--${variant}" href="${href}">${label}</a>`;
}

function detailsBlock(record, paidOre) {
  const rows = [
    ['Bokningsreferens', escapeHtml(record.reference)],
    ['Ankomst', escapeHtml(formatDateKey(record.arrival)) || '—'],
    ['Avresa', escapeHtml(formatDateKey(record.departure)) || '—'],
    ['Betalt belopp', escapeHtml(formatOre(paidOre))]
  ];
  return `<dl class="payment-details">
    ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
  </dl>`;
}

function renderCancelVerified() {
  const heading = 'Betalningen avbröts';
  const card = `<span class="payment-card-eyebrow">Betalningsstatus</span>
    <h2>Ingen betalning genomförd</h2>
    <p>Betalningen slutfördes inte. Inget belopp har dragits från ditt kort.</p>
    <p>Du kan använda betalningslänken igen om den fortfarande är giltig. Om länken har gått ut kan du kontakta oss på Skadevi Herrgård, så hjälper vi dig.</p>
    <div class="payment-actions">
      ${actionLink('/boka', 'Tillbaka till bokningen')}
    </div>
    ${contactBlock()}`;
  return pageResponse(layout({
    title: heading,
    kind: 'cancel',
    icon: ICON_CANCEL,
    kicker: 'Skadevi Herrgård',
    heading,
    subheading: 'Inget belopp har dragits',
    card
  }));
}

function renderCancelUnknown() {
  const heading = 'Betalningen avbröts';
  const card = `<span class="payment-card-eyebrow">Betalningsstatus</span>
    <h2>Status kunde inte bekräftas</h2>
    <p>Vi kunde inte bekräfta betalningens status. Kontrollera din bokning eller kontakta oss innan du försöker betala igen.</p>
    <p>Detta skyddar dig mot dubbla betalningsförsök. Om du redan har genomfört en betalning ber vi dig vänta innan du försöker igen.</p>
    <div class="payment-actions">
      ${actionLink('/boka', 'Tillbaka till bokningen')}
    </div>
    ${contactBlock()}`;
  return pageResponse(layout({
    title: heading,
    kind: 'cancel',
    icon: ICON_NEUTRAL,
    kicker: 'Skadevi Herrgård',
    heading,
    subheading: 'Status kunde inte bekräftas',
    card
  }));
}

function renderSuccess(record, session) {
  const heading = 'Tack för din bokning';
  const card = `<span class="payment-card-eyebrow">Betalningsstatus</span>
    <h2>Din betalning är genomförd</h2>
    <p>Betalningen har verifierats och din bokning är bekräftad. Vi ser fram emot att välkomna dig till Skadevi Herrgård.</p>
    ${detailsBlock(record, Number(session.amount_total))}
    <div class="payment-actions">
      ${actionLink('/', 'Tillbaka till hemsidan')}
      ${actionLink('/boka', 'Kontakta Skadevi Herrgård', 'secondary')}
    </div>
    ${contactBlock()}`;
  return pageResponse(layout({
    title: heading,
    kind: 'success',
    icon: ICON_SUCCESS,
    kicker: 'Betalning genomförd',
    heading,
    subheading: 'Din betalning är genomförd',
    card
  }));
}

function renderSuccessProcessing(record, paid) {
  const heading = paid ? 'Tack för din betalning' : 'Betalningen behandlas';
  const subheading = paid ? 'Bokningen inväntar avstämning' : 'Vi behandlar din betalning';
  const body = paid
    ? `<p>Betalningen är mottagen, men bokningen är inte bekräftad ännu. Skadevi Herrgård kontrollerar bokningen och kontaktar dig om något behöver kompletteras.</p>
       <p>Visa inte den här sidan som en bekräftelse förrän du har fått besked från oss.</p>`
    : `<p>Vi behandlar din betalning. Uppdatera sidan om en stund.</p>
       <p>Om statusen inte ändras kan du kontakta oss innan du försöker betala igen.</p>`;
  const details = record
    ? `<dl class="payment-details payment-details--compact">
        <div><dt>Bokningsreferens</dt><dd>${escapeHtml(record.reference)}</dd></div>
        <div><dt>Status</dt><dd>${paid ? 'Betalning mottagen' : 'Behandlas'}</dd></div>
      </dl>`
    : '';
  const card = `<span class="payment-card-eyebrow">Betalningsstatus</span>
    <h2>${paid ? 'Betalning mottagen' : 'Betalning under behandling'}</h2>
    ${body}
    ${details}
    <div class="payment-actions">
      ${actionLink('/', 'Tillbaka till hemsidan')}
      ${actionLink('/boka', 'Kontakta Skadevi Herrgård', 'secondary')}
    </div>
    ${contactBlock()}`;
  return pageResponse(layout({
    title: heading,
    kind: 'success',
    icon: paid ? ICON_SUCCESS : ICON_NEUTRAL,
    kicker: 'Skadevi Herrgård',
    heading,
    subheading,
    card
  }));
}

function renderSuccessUnknown() {
  const heading = 'Betalningsstatus';
  const card = `<span class="payment-card-eyebrow">Betalningsstatus</span>
    <h2>Vi kunde inte bekräfta betalningen</h2>
    <p>Vi kunde inte bekräfta betalningens status. Kontrollera din bokning eller kontakta oss innan du försöker betala igen.</p>
    <p>En återkomst från betalningen betyder inte automatiskt att betalningen har genomförts. Vi verifierar alltid statusen hos betalningsleverantören innan en betalning visas som genomförd.</p>
    <div class="payment-actions">
      ${actionLink('/', 'Tillbaka till hemsidan')}
      ${actionLink('/boka', 'Kontakta Skadevi Herrgård', 'secondary')}
    </div>
    ${contactBlock()}`;
  return pageResponse(layout({
    title: heading,
    kind: 'success',
    icon: ICON_NEUTRAL,
    kicker: 'Skadevi Herrgård',
    heading,
    subheading: 'Status kunde inte bekräftas',
    card
  }));
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

async function loadSessionStatuses(record, stripe) {
  const requests = normalizePaymentRequests(record);
  const sessionIds = [...new Set(requests.map((request) => request.sessionId).filter((id) => SESSION_ID_PATTERN.test(id)))];
  const sessions = [];
  let failed = requests.length !== sessionIds.length;
  for (const sessionId of sessionIds) {
    let session;
    try {
      session = await stripe.retrieveCheckoutSession(sessionId);
    } catch {
      failed = true;
      continue;
    }
    const reference = String(session?.metadata?.reference ?? session?.client_reference_id ?? '').trim();
    if (reference !== record.reference) {
      failed = true;
      continue;
    }
    const request = requests.find((item) => item.sessionId === sessionId);
    const amountOre = Number(session?.amount_total);
    if (!Number.isSafeInteger(amountOre) || amountOre <= 0 || amountOre !== request.amountOre) {
      failed = true;
      continue;
    }
    const currency = String(session?.currency ?? '').toLowerCase();
    if (currency !== 'sek') {
      failed = true;
      continue;
    }
    if (request.mode && typeof session.livemode === 'boolean') {
      const sessionMode = session.livemode ? 'live' : 'test';
      if (request.mode !== sessionMode) {
        failed = true;
        continue;
      }
    }
    if (session?.mode && session.mode !== 'payment') {
      failed = true;
      continue;
    }
    sessions.push({ request, session });
  }
  return { requests, sessions, failed };
}

function isPaid(session) {
  return session?.payment_status === 'paid';
}

function isStillPayable(session) {
  if (!session) return false;
  if (isPaid(session)) return false;
  return session.status === 'open' || session.status === 'complete';
}

function isVerifiedUnpaid(session) {
  if (!session || isPaid(session)) return false;
  if (session.payment_status !== 'unpaid') return false;
  return session.status === 'open' || session.status === 'expired';
}

async function handleCancelResult(request, options = {}) {
  const reference = String(request?.query?.ref ?? '').trim();
  if (!REFERENCE_PATTERN.test(reference)) return renderCancelUnknown();

  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return renderCancelUnknown();
  }

  const store = options.store;
  if (!store || typeof store.getByReference !== 'function') return renderCancelUnknown();

  let raw;
  try {
    raw = await store.getByReference(reference);
  } catch {
    return renderCancelUnknown();
  }
  if (!raw?.record) return renderCancelUnknown();
  const record = raw.record;

  let statuses;
  try {
    statuses = await loadSessionStatuses(record, stripe);
  } catch {
    return renderCancelUnknown();
  }
  const summary = computePaymentSummary(record);
  const paidLedger = normalizePayments(record).length > 0 || summary.paidOre > 0;
  const recordConfirmed = record.statusCode === 'CONFIRMED' || record.statusCode === 'RECONCILIATION';

  const verifiedUnpaid = !statuses.failed &&
    statuses.sessions.length > 0 &&
    statuses.sessions.every(({ session }) => isVerifiedUnpaid(session)) &&
    !paidLedger &&
    !recordConfirmed;

  return verifiedUnpaid ? renderCancelVerified() : renderCancelUnknown();
}

async function handleSuccessResult(request, options = {}) {
  const reference = String(request?.query?.ref ?? '').trim();
  const sessionId = String(request?.query?.session_id ?? '').trim();

  if (!REFERENCE_PATTERN.test(reference) && !SESSION_ID_PATTERN.test(sessionId)) {
    return renderSuccessUnknown();
  }

  let stripe;
  try {
    stripe = createStripe(options);
  } catch {
    return renderSuccessUnknown();
  }

  const store = options.store;
  if (!store || typeof store.getByReference !== 'function') return renderSuccessUnknown();

  let record = null;
  if (SESSION_ID_PATTERN.test(sessionId)) {
    let session;
    try {
      session = await stripe.retrieveCheckoutSession(sessionId);
    } catch {
      return renderSuccessUnknown();
    }
    const sessionReference = String(session?.metadata?.reference ?? session?.client_reference_id ?? '').trim();
    if (!REFERENCE_PATTERN.test(sessionReference)) return renderSuccessUnknown();
    if (reference && reference !== sessionReference) return renderSuccessUnknown();
    let raw;
    try {
      raw = await store.getByReference(sessionReference);
    } catch {
      return renderSuccessUnknown();
    }
    if (!raw?.record) return renderSuccessUnknown();
    record = raw.record;
    const requestRow = normalizePaymentRequests(record).find((item) => item.sessionId === sessionId);
    if (!requestRow) return renderSuccessUnknown();
    const amountOre = Number(session?.amount_total);
    if (!Number.isSafeInteger(amountOre) || amountOre <= 0 || amountOre !== requestRow.amountOre) {
      return renderSuccessUnknown();
    }
    if (String(session?.currency ?? '').toLowerCase() !== 'sek') return renderSuccessUnknown();
    if (record.statusCode === 'CONFIRMED' && isPaid(session)) {
      return renderSuccess(record, session);
    }
    if (record.statusCode === 'RECONCILIATION' && isPaid(session)) {
      return renderSuccessProcessing(record, true);
    }
    if (isPaid(session)) return renderSuccessProcessing(record, true);
    if (session?.status === 'open' || session?.status === 'complete') {
      return renderSuccessProcessing(record, false);
    }
    return renderSuccessUnknown();
  }

  let raw;
  try {
    raw = await store.getByReference(reference);
  } catch {
    return renderSuccessUnknown();
  }
  if (!raw?.record) return renderSuccessUnknown();
  record = raw.record;

  let statuses;
  try {
    statuses = await loadSessionStatuses(record, stripe);
  } catch {
    return renderSuccessUnknown();
  }
  if (statuses.failed) return renderSuccessUnknown();

  const paidSessions = statuses.sessions.filter(({ session }) => isPaid(session));
  if (paidSessions.length > 0) {
    if (record.statusCode === 'CONFIRMED') {
      const newest = paidSessions.sort((a, b) => Number(b.session.created || 0) - Number(a.session.created || 0))[0];
      return renderSuccess(record, newest.session);
    }
    return renderSuccessProcessing(record, true);
  }

  if (statuses.sessions.some(({ session }) => isStillPayable(session))) {
    return renderSuccessProcessing(record, false);
  }

  return renderSuccessUnknown();
}

async function handlePaymentResult(request, _context = {}, options = {}) {
  const page = String(request?.page ?? '');
  if (page === 'cancel' || page === 'avbruten') {
    return handleCancelResult(request, options);
  }
  return handleSuccessResult(request, options);
}

module.exports = {
  handlePaymentResult,
  renderCancelVerified,
  renderCancelUnknown,
  renderSuccess,
  renderSuccessProcessing,
  renderSuccessUnknown,
  layout,
  RESULT_HEADERS
};
