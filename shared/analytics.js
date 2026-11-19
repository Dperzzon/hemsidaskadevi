'use strict';

// Gemensam analyskonfiguration för Skadevi Herrgård.
//
// All mätning går via Google Tag Manager (GTM-WN83FQXJ). GA4 (G-NBQB2HKDYF)
// konfigureras som en Google tag inuti GTM – aldrig med en separat gtag.js-
// installation i sidan. Här finns bara:
//   * Consent Mode v2 med standardläget "denied".
//   * GTM-laddaren som bara körs efter ett sparat statistiksamtycke.
//   * En säker kö för dataLayer-händelser (inga personuppgifter).
//   * Serverrenderad purchase-data för verifierade betalningar.

const crypto = require('node:crypto');

const GTM_ID = 'GTM-WN83FQXJ';
const GA4_MEASUREMENT_ID = 'G-NBQB2HKDYF';
const CONSENT_STORAGE_KEY = 'skadevi-consent-v1';
const CONSENT_VERSION = 1;

const REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,80}$/;

// Transaktions-ID:t får aldrig vara bokningsreferensen. Referensen kan i sig
// användas för att öppna betalningsresultatet (/betalning-klar?ref=...) och
// ska därför inte skickas till Google Analytics. Vi använder i stället ett
// stabilt, icke-reversibelt HMAC-värde per bokning. Samma referens ger alltid
// samma ID, så deposition och slutbetalning dedupliceras korrekt i GA4.
//
// Sätt ANALYTICS_TRANSACTION_SECRET i produktion. Utan hemlighet används en
// fast namnrymd så att ID:t fortfarande är deterministiskt och icke-reversibelt
// (men då inte hemligt saltat).
const ANALYTICS_TRANSACTION_SECRET =
  process.env.ANALYTICS_TRANSACTION_SECRET || 'skadevi-analytics-transaction-v1';

function createAnalyticsTransactionId(reference) {
  const value = String(reference ?? '');
  if (!REFERENCE_PATTERN.test(value)) return '';
  const digest = crypto
    .createHmac('sha256', ANALYTICS_TRANSACTION_SECRET)
    .update(value)
    .digest('hex');
  return `skd-${digest.slice(0, 40)}`;
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function renderAnalyticsHead() {
  // Inget inline-script: den statiska CSP:n tillåter bara 'self'. All bootstrap
  // (Consent Mode v2, GTM-laddning och kö) ligger därför i /js/analytics.js,
  // som laddas synkront i head så att samtyckesstandarden hinner sättas före
  // någon GTM-resurs. GA4-ID:t skickas bara som konfiguration till instruktioner
  // och används aldrig för en separat gtag.js-installation.
  return `<!-- SKADEVI ANALYTICS START -->
<script src="/js/analytics.js" data-gtm="${GTM_ID}" data-ga4="${GA4_MEASUREMENT_ID}" data-consent-key="${CONSENT_STORAGE_KEY}"></script>
<!-- SKADEVI ANALYTICS END -->`;
}

const PURCHASE_KEYS = new Set(['transaction_id', 'value', 'currency']);

function renderPurchaseEvent(purchase) {
  if (!purchase) return '';
  if (typeof purchase.transaction_id !== 'string' || !/^[A-Za-z0-9-]{4,80}$/.test(purchase.transaction_id)) {
    return '';
  }
  const value = Number(purchase.value);
  if (!Number.isFinite(value) || value <= 0) return '';
  const currency = String(purchase.currency || 'SEK').toUpperCase();
  if (currency !== 'SEK') return '';
  const safe = {};
  for (const key of PURCHASE_KEYS) {
    if (purchase[key] !== undefined) safe[key] = purchase[key];
  }
  safe.transaction_id = purchase.transaction_id;
  safe.value = Math.round(value * 100) / 100;
  safe.currency = currency;
  return `<script type="application/json" data-analytics-purchase>${jsonForHtml(safe)}</script>`;
}

// Bygger en purchase-payload endast när alla verifierbara villkor är uppfyllda:
//   * bokningen är CONFIRMED,
//   * Stripe-sessionen är betald (payment_status = paid) och av typen payment,
//   * valutan är SEK och beloppet ett giltigt positivt heltal i öre,
//   * sessionens referens (om den finns) matchar bokningen,
//   * Stripe-beloppet överstiger inte bokningens totalbelopp.
//
// Intäktsmodell: ett köp per bokning med bokningens totalbelopp. Det gör att
// en deposition inte räknas som ett separat, mindre köp och att en senare
// slutbetalning inte lägger till ett nytt köp. GA4 deduplicerar dessutom på
// transaction_id som en andra säkerhet.
function buildPurchaseEvent(record, session) {
  if (!record || record.statusCode !== 'CONFIRMED') return null;
  if (!session || typeof session !== 'object') return null;
  if (session.payment_status !== 'paid') return null;
  if (session.mode && session.mode !== 'payment') return null;
  if (String(session.currency ?? '').toLowerCase() !== 'sek') return null;

  const amountOre = Number(session.amount_total);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) return null;

  const reference = String(record.reference ?? '');
  if (!REFERENCE_PATTERN.test(reference)) return null;

  const sessionReference = String(
    session.metadata?.reference ?? session.client_reference_id ?? ''
  ).trim();
  if (sessionReference && sessionReference !== reference) return null;

  const transactionId = createAnalyticsTransactionId(reference);
  if (!transactionId) return null;

  const totalOre = Math.round(Number(record.total) * 100);
  let value;
  if (Number.isSafeInteger(totalOre) && totalOre > 0) {
    // Stripe får aldrig ha debiterat mer än bokningens totalbelopp.
    if (totalOre < amountOre) return null;
    value = totalOre / 100;
  } else {
    value = amountOre / 100;
  }
  if (!Number.isFinite(value) || value <= 0) return null;

  return {
    transaction_id: transactionId,
    value: Math.round(value * 100) / 100,
    currency: 'SEK'
  };
}

module.exports = {
  GTM_ID,
  GA4_MEASUREMENT_ID,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  createAnalyticsTransactionId,
  renderAnalyticsHead,
  renderPurchaseEvent,
  buildPurchaseEvent
};
