/* Skadevi Herrgård – samtycke, GTM-laddning och säkra dataLayer-händelser.
 *
 * Filen ligger i public/js så att den har en stabil URL även på serverrenderade
 * betalningssidor och kan laddas från head utan inline-script (CSP). Den innehåller
 * ingen GA4-konfiguration och skickar aldrig något till Google före ett sparat
 * statistiksamtycke.
 */
(function () {
  'use strict';

  if (window.__skadeviAnalyticsInitialized) return;
  window.__skadeviAnalyticsInitialized = true;

  var currentScript = document.currentScript;
  var dataset = currentScript && currentScript.dataset ? currentScript.dataset : {};
  var GTM_ID = dataset.gtm || 'GTM-WN83FQXJ';
  var GA4_MEASUREMENT_ID = dataset.ga4 || 'G-NBQB2HKDYF';
  var CONSENT_KEY = dataset.consentKey || 'skadevi-consent-v1';
  var CONSENT_VERSION = 1;

  var api = window.SkadeviAnalytics = window.SkadeviAnalytics || {};
  api.queue = api.queue || [];
  api.readyCallbacks = api.readyCallbacks || [];
  api.gtmLoaded = false;
  api.gtmReady = false;

  window.SKADEVI_ANALYTICS = {
    gtm: GTM_ID,
    ga4: GA4_MEASUREMENT_ID,
    consentKey: CONSENT_KEY
  };
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window['ga-disable-' + GA4_MEASUREMENT_ID] = true;

  var ALLOWED_PARAMS = {
    booking_started: ['booking_nights'],
    booking_request_submitted: ['booking_nights', 'booking_type'],
    begin_checkout: ['value', 'currency', 'payment_method'],
    purchase: ['transaction_id', 'value', 'currency']
  };

  function safeStorageGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  function safeStorageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch { return false; }
  }

  function readConsentRecord() {
    var raw = safeStorageGet(CONSENT_KEY);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.analytics !== 'boolean') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function readConsent() {
    var record = readConsentRecord();
    return record ? record.analytics : null;
  }

  function hasConsent() {
    return readConsent() === true;
  }

  function deleteAnalyticsCookies() {
    try {
      var cookies = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < cookies.length; i += 1) {
        var name = cookies[i].split('=')[0].trim();
        if (!/^(_ga|_gid|_gat|_gcl)/.test(name)) continue;
        document.cookie = name + '=; Max-Age=0; path=/; SameSite=Lax';
        document.cookie = name + '=; Max-Age=0; path=/; domain=.' + window.location.hostname.replace(/^www\./, '') + '; SameSite=Lax';
      }
    } catch { /* cookies kan vara blockerade */ }
  }

  function gtagConsent(granted) {
    // Stoppar även GA4-taggen om besökaren återkallar ett tidigare samtycke.
    window['ga-disable-' + GA4_MEASUREMENT_ID] = !granted;
    if (typeof window.gtag !== 'function') return;
    window.gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: granted ? 'granted' : 'denied'
    });
  }

  function flushQueue() {
    if (!api.gtmReady) return;
    window.dataLayer = window.dataLayer || [];
    while (api.queue.length) {
      var payload = api.queue.shift();
      try { window.dataLayer.push(payload); } catch { /* ignoreras */ }
    }
  }

  function loadGtm(callback) {
    if (api.gtmReady) {
      if (callback) callback();
      return;
    }
    if (callback) api.readyCallbacks.push(callback);
    if (api.gtmLoaded) return;

    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GTM_ID);
    script.onload = function () {
      api.gtmReady = true;
      var callbacks = api.readyCallbacks.slice();
      api.readyCallbacks.length = 0;
      for (var i = 0; i < callbacks.length; i += 1) {
        try { callbacks[i](); } catch { /* mätning får aldrig kasta vidare */ }
      }
    };
    script.onerror = function () {
      // GTM är sekundärt: sidan och bokningen fungerar utan mätning.
      api.gtmLoaded = false;
    };
    document.head.appendChild(script);
    api.gtmLoaded = true;
  }

  function sanitizeParams(name, params) {
    var allowed = ALLOWED_PARAMS[name];
    if (!allowed || !params) return {};
    var clean = {};
    for (var i = 0; i < allowed.length; i += 1) {
      var key = allowed[i];
      var value = params[key];
      if (value === undefined || value === null) continue;
      if (key === 'currency') {
        value = String(value).toUpperCase();
        if (value !== 'SEK') continue;
      } else if (key === 'payment_method') {
        if (value !== 'card' && value !== 'swish') continue;
      } else if (key === 'booking_type') {
        if (value !== 'request' && value !== 'direct') continue;
      } else if (key === 'transaction_id') {
        if (typeof value !== 'string' || !/^[A-Za-z0-9-]{4,80}$/.test(value)) continue;
      } else if (key === 'booking_nights') {
        value = Number(value);
        if (!Number.isFinite(value) || value <= 0 || value > 365) continue;
      } else if (key === 'value') {
        value = Number(value);
        if (!Number.isFinite(value) || value <= 0) continue;
        value = Math.round(value * 100) / 100;
      } else {
        continue;
      }
      clean[key] = value;
    }
    return clean;
  }

  function track(name, params) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_PARAMS, name)) return;
    var payload = { event: name };
    var clean = sanitizeParams(name, params);
    for (var key in clean) {
      if (Object.prototype.hasOwnProperty.call(clean, key)) payload[key] = clean[key];
    }
    api.queue.push(payload);
    if (hasConsent()) loadGtm(flushQueue);
  }

  function trackPurchase(purchase) {
    if (!purchase) return;
    var transactionId = String(purchase.transaction_id || '');
    var value = Number(purchase.value);
    if (!/^[A-Za-z0-9-]{4,80}$/.test(transactionId)) return;
    if (!Number.isFinite(value) || value <= 0) return;
    var storageKey = 'skadevi-purchase-' + transactionId;
    if (safeStorageGet(storageKey)) return;
    safeStorageSet(storageKey, new Date().toISOString());
    track('purchase', {
      transaction_id: transactionId,
      value: value,
      currency: String(purchase.currency || 'SEK')
    });
  }

  api.readConsent = readConsent;
  api.hasConsent = hasConsent;
  api.track = track;
  api.trackPurchase = trackPurchase;

  // Consent Mode v2: allt som inte är nödvändigt är nekat tills besökaren väljer.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500
  });
  window.gtag('set', 'ads_data_redaction', true);

  // Ett sparat "ja" får ladda GTM direkt i head. Inget laddas utan samtycke.
  if (hasConsent()) {
    gtagConsent(true);
    loadGtm(flushQueue);
  }

  // --- Samtyckespanel -------------------------------------------------------

  var banner = null;

  function buildBanner() {
    if (banner) return banner;
    banner = document.createElement('section');
    banner.className = 'cookie-consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookieinställningar');
    banner.innerHTML = [
      '<div class="cookie-consent__inner">',
      '  <div class="cookie-consent__text">',
      '    <h2 class="cookie-consent__title">Cookies och integritet</h2>',
      '    <p>Vi använder frivilliga statistikcookies för att förstå hur webbplatsen används. ',
      '    Inget skickas till Google Analytics förrän du väljer att acceptera. ',
      '    <a href="/integritet">Läs mer om cookies och personuppgifter</a>.</p>',
      '  </div>',
      '  <div class="cookie-consent__actions">',
      '    <button type="button" class="cookie-consent__btn cookie-consent__btn--primary" data-consent-accept>Acceptera statistik</button>',
      '    <button type="button" class="cookie-consent__btn cookie-consent__btn--secondary" data-consent-deny>Neka statistik</button>',
      '  </div>',
      '</div>'
    ].join('');
    banner.addEventListener('click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-consent-accept]')) setConsent(true);
      else if (target.closest('[data-consent-deny]')) setConsent(false);
    });
    document.body.appendChild(banner);
    return banner;
  }

  function showBanner() {
    buildBanner().hidden = false;
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  function setConsent(granted) {
    safeStorageSet(CONSENT_KEY, JSON.stringify({
      analytics: granted,
      version: CONSENT_VERSION,
      updatedAt: new Date().toISOString()
    }));
    gtagConsent(granted);
    hideBanner();
    if (granted) {
      loadGtm(flushQueue);
    } else {
      deleteAnalyticsCookies();
    }
  }

  function addFooterSettingsButton() {
    var footerBottom = document.querySelector('.footer-bottom p');
    if (!footerBottom) return;
    if (footerBottom.querySelector('[data-cookie-settings]')) return;
    var separator = document.createTextNode(' · ');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'footer-cookie-settings';
    button.setAttribute('data-cookie-settings', '');
    button.textContent = 'Cookieinställningar';
    button.addEventListener('click', function () {
      showBanner();
      var accept = banner && banner.querySelector('[data-consent-accept]');
      if (accept) accept.focus({ preventScroll: true });
    });
    footerBottom.appendChild(separator);
    footerBottom.appendChild(button);
  }

  // --- Verifierade köp ------------------------------------------------------

  function readPurchasePayload() {
    var el = document.querySelector('script[type="application/json"][data-analytics-purchase]');
    if (!el) return null;
    try { return JSON.parse(el.textContent || '{}'); } catch { return null; }
  }

  // --- Påbörjad kortbetalning på betalningssidan ----------------------------

  function setupCheckoutForms() {
    var forms = document.querySelectorAll('form[data-analytics-checkout]');
    for (var i = 0; i < forms.length; i += 1) {
      (function (form) {
        form.addEventListener('submit', function (event) {
          if (!hasConsent()) return; // Vanlig formulärpostning – ingen mätning.
          event.preventDefault();
          var button = form.querySelector('button[type="submit"]');
          if (button) button.disabled = true;
          var method = form.getAttribute('data-analytics-checkout') || 'card';
          var body = new FormData(form);
          fetch(form.action, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: body,
            credentials: 'same-origin',
            cache: 'no-store'
          }).then(function (response) {
            if (!response.ok) throw new Error('checkout');
            return response.json();
          }).then(function (data) {
            if (!data || !data.checkoutUrl) throw new Error('checkout');
            var params = { currency: data.currency || 'SEK', payment_method: method };
            if (Number.isFinite(Number(data.valueOre)) && Number(data.valueOre) > 0) {
              params.value = Number(data.valueOre) / 100;
            }
            track('begin_checkout', params);
            window.location.assign(data.checkoutUrl);
          }).catch(function () {
            // Fall tillbaka till serverns vanliga redirect. Ingen betalning blockeras.
            if (button) button.disabled = false;
            HTMLFormElement.prototype.submit.call(form);
          });
        });
      })(forms[i]);
    }
  }

  function initDom() {
    if (!readConsentRecord()) showBanner();
    addFooterSettingsButton();
    setupCheckoutForms();
    var purchase = readPurchasePayload();
    if (purchase) trackPurchase(purchase);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDom, { once: true });
  } else {
    initDom();
  }
})();