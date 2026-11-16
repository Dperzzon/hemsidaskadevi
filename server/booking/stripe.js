'use strict';

const crypto = require('node:crypto');

const DEFAULT_API_BASE = 'https://api.stripe.com';
const DEFAULT_TIMEOUT_MS = 15000;
const SIGNATURE_TOLERANCE_SECONDS = 300;

class StripeError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
    this.type = details.type ?? '';
    this.requestId = details.requestId ?? '';
  }
}

class StripeSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeSignatureError';
    this.status = 400;
    this.code = 'STRIPE_SIGNATURE_INVALID';
  }
}

function stripeKeyMode(secretKey) {
  if (typeof secretKey !== 'string') return '';
  const key = secretKey.trim();
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return '';
}

function assertAllowedStripeKey(secretKey, options = {}) {
  const mode = stripeKeyMode(secretKey);
  if (!mode) {
    throw new StripeError(500, 'STRIPE_KEY_INVALID', 'Stripe-nyckeln har ett okänt format.');
  }
  const allowLive = options.allowLive ?? process.env.STRIPE_ALLOW_LIVE === '1';
  if (mode === 'live' && !allowLive) {
    throw new StripeError(
      500,
      'STRIPE_LIVE_MODE_BLOCKED',
      'Live-nyckel är blockerad. Sätt STRIPE_ALLOW_LIVE=1 först efter uttryckligt godkännande.'
    );
  }
  return mode;
}

function assertHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new StripeError(500, 'STRIPE_URL_INVALID', `${name} är inte en giltig URL.`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new StripeError(500, 'STRIPE_URL_INVALID', `${name} måste använda HTTPS.`);
  }
  if (url.username || url.password) {
    throw new StripeError(500, 'STRIPE_URL_INVALID', `${name} får inte innehålla inloggningsuppgifter.`);
  }
  return url.toString();
}

function createStripeClient(options = {}) {
  const secretKey = String(options.secretKey ?? process.env.STRIPE_SECRET_KEY ?? '').trim();
  if (!secretKey) {
    throw new StripeError(503, 'STRIPE_NOT_CONFIGURED', 'Stripe är inte konfigurerat.');
  }
  const mode = assertAllowedStripeKey(secretKey, options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(method, pathname, params, requestOptions = {}) {
    const url = new URL(pathname, apiBase);
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      Accept: 'application/json',
      'User-Agent': 'Skadevi-Booking/1.0'
    };
    let body;
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(params ?? []).toString();
    }
    if (requestOptions.idempotencyKey) {
      headers['Idempotency-Key'] = String(requestOptions.idempotencyKey).slice(0, 255);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });
    } catch (cause) {
      const error = new StripeError(502, 'STRIPE_UNAVAILABLE', 'Stripe kunde inte nås.');
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const details = json?.error ?? {};
      throw new StripeError(
        response.status >= 500 ? 502 : 400,
        String(details.code ?? details.type ?? 'STRIPE_ERROR').slice(0, 120),
        String(details.message ?? 'Stripe-begäran misslyckades.').slice(0, 500),
        {
          type: String(details.type ?? ''),
          requestId: String(details.request_id ?? response.headers?.get?.('request-id') ?? '')
        }
      );
    }
    return json;
  }

  return {
    mode,
    async createCheckoutSession(input) {
      const amountOre = Number(input.amountOre);
      if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
        throw new StripeError(400, 'STRIPE_AMOUNT_INVALID', 'Betalningsbeloppet är ogiltigt.');
      }
      const currency = String(input.currency ?? 'sek').toLowerCase();
      if (currency !== 'sek') {
        throw new StripeError(400, 'STRIPE_CURRENCY_INVALID', 'Swish kräver valutan SEK.');
      }
      const paymentMethods = Array.isArray(input.paymentMethods) ? input.paymentMethods : ['swish'];
      if (paymentMethods.length !== 1 || paymentMethods[0] !== 'swish') {
        throw new StripeError(400, 'STRIPE_PAYMENT_METHOD_INVALID', 'Endast Swish är tillåtet.');
      }
      const reference = String(input.reference ?? '').trim();
      if (!reference) {
        throw new StripeError(400, 'STRIPE_REFERENCE_REQUIRED', 'Bokningsreferens krävs.');
      }
      const successUrl = assertHttpsUrl(input.successUrl, 'success_url');
      const cancelUrl = assertHttpsUrl(input.cancelUrl, 'cancel_url');
      const expiresAt = Number(input.expiresAt ?? Math.floor(Date.now() / 1000) + 86400);
      const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
      const params = [
        ['mode', 'payment'],
        ['locale', 'sv'],
        ['allowed_payment_method_types[0]', 'swish'],
        ['line_items[0][quantity]', '1'],
        ['line_items[0][price_data][currency]', currency],
        ['line_items[0][price_data][unit_amount]', String(amountOre)],
        ['line_items[0][price_data][product_data][name]', String(input.productName ?? `Skadevi Herrgård ${reference}`).slice(0, 250)],
        ['success_url', successUrl],
        ['cancel_url', cancelUrl],
        ['client_reference_id', reference.slice(0, 200)],
        ['expires_at', String(expiresAt)],
        ['metadata[reference]', reference.slice(0, 500)],
        ['metadata[amountOre]', String(amountOre)],
        ['metadata[paymentMethod]', 'swish'],
        ['payment_intent_data[metadata][reference]', reference.slice(0, 500)],
        ['payment_intent_data[metadata][paymentMethod]', 'swish']
      ];
      if (input.customerEmail) params.push(['customer_email', String(input.customerEmail).slice(0, 320)]);
      if (input.description) {
        params.push(['line_items[0][price_data][product_data][description]', String(input.description).slice(0, 500)]);
      }
      for (const [key, value] of Object.entries(metadata)) {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(key)) continue;
        params.push([`metadata[${key}]`, String(value).slice(0, 500)]);
      }
      return request('POST', '/v1/checkout/sessions', params, {
        idempotencyKey: input.idempotencyKey
      });
    },
    async retrieveCheckoutSession(sessionId) {
      if (!sessionId) throw new StripeError(400, 'STRIPE_SESSION_REQUIRED', 'Sessions-ID krävs.');
      return request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    },
    async expireCheckoutSession(sessionId) {
      if (!sessionId) throw new StripeError(400, 'STRIPE_SESSION_REQUIRED', 'Sessions-ID krävs.');
      return request('POST', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, []);
    }
  };
}

function parseSignatureHeader(header) {
  if (typeof header !== 'string' || !header.trim()) {
    throw new StripeSignatureError('Stripe-signature saknas.');
  }
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (!Number.isInteger(timestamp) || timestamp <= 0 || signatures.length === 0) {
    throw new StripeSignatureError('Stripe-signature har fel format.');
  }
  return { timestamp, signatures };
}

function verifyStripeSignature(payload, header, secret, options = {}) {
  const signingSecret = typeof secret === 'string' ? secret.trim() : '';
  if (!signingSecret) {
    throw new StripeSignatureError('Webhook-hemligheten är inte konfigurerad.');
  }
  const { timestamp, signatures } = parseSignatureHeader(header);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new StripeSignatureError('Stripe-signaturen har gått ut.');
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const expected = crypto.createHmac('sha256', signingSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  for (const signature of signatures) {
    if (!/^[0-9a-f]{64}$/i.test(signature)) continue;
    const provided = Buffer.from(signature, 'hex');
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  throw new StripeSignatureError('Stripe-signaturen är ogiltig.');
}

function parseStripeEvent(payload, header, secret, options = {}) {
  verifyStripeSignature(payload, header, secret, options);
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    throw new StripeSignatureError('Stripe-händelsen kunde inte tolkas.');
  }
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || typeof event.type !== 'string') {
    throw new StripeSignatureError('Stripe-händelsen saknar id eller typ.');
  }
  return event;
}

function signStripePayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

module.exports = {
  StripeError,
  StripeSignatureError,
  DEFAULT_API_BASE,
  SIGNATURE_TOLERANCE_SECONDS,
  stripeKeyMode,
  assertAllowedStripeKey,
  createStripeClient,
  verifyStripeSignature,
  parseStripeEvent,
  signStripePayload
};
