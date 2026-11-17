'use strict';

// Gemensam analyskonfiguration för Skadevi Herrgård.
//
// All mätning går via Google Tag Manager (GTM-T5BNLGR7). GA4 (G-NBQB2HKDYF)
// konfigureras som en Google tag inuti GTM – aldrig med en separat gtag.js-
// installation i sidan. Här finns bara:
//   * Consent Mode v2 med standardläget "denied".
//   * GTM-laddaren som bara körs efter ett sparat statistiksamtycke.
//   * En säker kö för dataLayer-händelser (inga personuppgifter).
//   * Serverrenderad purchase-data för verifierade betalningar.

const GTM_ID = 'GTM-T5BNLGR7';
const GA4_MEASUREMENT_ID = 'G-NBQB2HKDYF';
const CONSENT_STORAGE_KEY = 'skadevi-consent-v1';
const CONSENT_VERSION = 1;

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

module.exports = {
  GTM_ID,
  GA4_MEASUREMENT_ID,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  renderAnalyticsHead,
  renderPurchaseEvent
};
