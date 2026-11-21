'use strict';

// Produktionsserver för Skadevi Gård: serverar Vite-bygget i dist/ (statisk
// webbplats med rena URL:er) samt kalender-API:et /api/availability via
// oförändrad kalenderlogik i server/calendar/. Inga externa beroenden.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { handleAvailability } = require('./calendar/availability');
const { loadInternalBlocked } = require('./calendar/internal');
const { handleCalendarExport } = require('./calendar/export');
const { createCalendarMonitor } = require('./calendar/monitor');
const { handleBookingRequest, createRateLimiter } = require('./booking/requests');
const { handleStripeWebhook } = require('./booking/stripe-webhook');
const { handlePaymentPage, handlePaymentAction } = require('./booking/payment-page');
const { handlePaymentResult } = require('./booking/payment-result');
const {
  handleDirectBooking,
  handleDirectBookingConfirmation,
  directBookingAvailable,
  checkDirectBookingAvailability
} = require('./booking/direct-booking');
const { validateRange } = require('./calendar/availability');
const { loadRules, publicRules } = require('./booking/rules');
const { createStore, isConfigured } = require('./booking/store');
const { legacyRedirect } = require('./seo/legacy-redirects');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const ROOT_FILES = new Set(['robots.txt', 'sitemap.xml']);
const ALLOWED_DIRS = new Set(['pages', 'assets', 'images', 'fonts', 'css', 'js']);

// Rena URL:er enligt sitemap.xml kanoniska länkar mappas till pages/*.html.
const PAGE_ROUTES = new Set([
  'foretag', 'fest', 'brollop', 'semester', 'boende', 'aktiviteter',
  'priser', 'mat-dryck', 'om-oss', 'vanliga-fragor', 'kontakt',
  'digital-visning', 'boka', 'lediga-datum', 'betalning-klar', 'betalning-avbruten',
  'integritet'
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com; font-src 'self'; connect-src 'self' https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com; frame-src https://www.googletagmanager.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

const API_HEADERS = {
  ...SECURITY_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

function sendJson(res, status, body, extraHeaders) {
  res.writeHead(status, { ...API_HEADERS, ...(extraHeaders || {}) });
  res.end(JSON.stringify(body));
}

function sendErrorPage(res, root, status) {
  fs.readFile(path.join(root, '404.html'))
    .then((data) => {
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME_TYPES['.html'],
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    })
    .catch(() => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sidan hittades inte.');
    });
}

function redirect(res, location) {
  res.writeHead(301, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-cache' });
  res.end();
}

function resolveStatic(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { redirect: null, file: null };
  }
  if (!decoded.startsWith('/')) return { redirect: null, file: null };

  const normalized = path.posix.normalize(decoded);
  // Blockerar path traversal: resterande '..' innebär ett försök att backa ut ur roten.
  if (!normalized.startsWith('/') || normalized.includes('..')) return { redirect: null, file: null };

  let relative = normalized.replace(/^\/+/, '');
  if (relative === '') return { redirect: null, file: path.join(root, 'index.html') };
  relative = relative.replace(/\/+$/, '');

  // 301 från gamla fil-URL:er till rena URL:er (befintliga länkar/bokmärken).
  if (relative === 'index.html') return { redirect: '/', file: null };
  // Den gamla bokningssidan är sammanslagen med /boka. Behåll query-parametrar
  // (t.ex. datumval) via anroparens url.search.
  if (relative === 'lediga-datum' || relative === 'pages/lediga-datum.html') {
    return { redirect: '/boka', file: null };
  }
  // Den gamla kontaktsidan är ersatt av /boka. Alla äldre varianter
  // omdirigeras direkt (ingen kedja via /kontakt.html -> /kontakt).
  if (
    relative === 'kontakt' ||
    relative === 'kontakt.html' ||
    relative === 'pages/kontakt' ||
    relative === 'pages/kontakt.html'
  ) {
    return { redirect: '/boka', file: null };
  }
  const htmlMatch = /^(pages\/)?([a-z-]+)\.html$/.exec(relative);
  if (htmlMatch && (htmlMatch[2] === 'index' || PAGE_ROUTES.has(htmlMatch[2]))) {
    return { redirect: htmlMatch[2] === 'index' ? '/' : `/${htmlMatch[2]}`, file: null };
  }

  if (PAGE_ROUTES.has(relative)) return { redirect: null, file: path.join(root, 'pages', `${relative}.html`) };
  if (ROOT_FILES.has(relative)) return { redirect: null, file: path.join(root, relative) };

  const [firstSegment] = relative.split('/');
  if (!ALLOWED_DIRS.has(firstSegment)) return { redirect: null, file: null };

  const candidate = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (!candidate.startsWith(rootResolved + path.sep)) return { redirect: null, file: null };
  return { redirect: null, file: candidate };
}

function cacheControlFor(filePath) {
  if (/[/\\]assets[/\\]/.test(filePath)) return 'public, max-age=31536000, immutable';
  if (/[/\\](images|fonts)[/\\]/.test(filePath)) return 'public, max-age=604800';
  if (filePath.endsWith('robots.txt') || filePath.endsWith('sitemap.xml')) return 'public, max-age=3600';
  return 'no-cache';
}

function acceptsEncoding(req, encoding) {
  const header = req.headers['accept-encoding'] || '';
  return header.split(',').some((part) => part.trim().split(';')[0] === encoding);
}

async function serveFile(req, res, root, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) {
    await sendErrorPage(res, root, 404);
    return;
  }

  const info = await fs.stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    await sendErrorPage(res, root, 404);
    return;
  }

  // Weak ETag baserad på storlek + mtime möjliggör 304 vid oförändrad fil.
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const ifNoneMatch = req.headers['if-none-match'];
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': mime,
    'Cache-Control': cacheControlFor(filePath),
    ETag: etag,
    Vary: 'Accept-Encoding'
  };

  if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  // Förkomprimerade varianter (.br/.gz från scripts/compress.mjs) serveras
  // direkt när klienten accepterar dem.
  let sendPath = filePath;
  if (acceptsEncoding(req, 'br')) {
    const brotli = await fs.stat(`${filePath}.br`).catch(() => null);
    if (brotli) {
      sendPath = `${filePath}.br`;
      headers['Content-Encoding'] = 'br';
    }
  }
  if (!headers['Content-Encoding'] && acceptsEncoding(req, 'gzip')) {
    const gzip = await fs.stat(`${filePath}.gz`).catch(() => null);
    if (gzip) {
      sendPath = `${filePath}.gz`;
      headers['Content-Encoding'] = 'gzip';
    }
  }

  const data = await fs.readFile(sendPath).catch(() => null);
  if (data === null) {
    await sendErrorPage(res, root, 404);
    return;
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('application/json')) {
      reject(new Error('Felaktig innehållstyp'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('För stort meddelande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRawBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('För stort meddelande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readFormBody(req, limit = 32 * 1024) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    throw new Error('Fel innehållstyp');
  }
  const raw = await readRawBody(req, limit);
  const params = new URLSearchParams(raw.toString('utf8'));
  const body = {};
  for (const [key, value] of params) {
    if (!(key in body)) body[key] = value;
  }
  return body;
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host ?? '');
  } catch {
    return false;
  }
}

function sendHtmlResult(res, result) {
  res.writeHead(result.status, { ...SECURITY_HEADERS, ...(result.headers || {}) });
  res.end(result.html || '');
}

function clientIp(req) {
  // App Service lägger till klientens IP sist i X-Forwarded-For. Ta sista
  // posten så att en klient inte kan kringgå hastighetsbegränsningen genom
  // att skicka en egen, påhittad X-Forwarded-For.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'okänd';
}

function createRequestListener(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..', 'dist'));
  const availabilityHandler = options.availabilityHandler ?? handleAvailability;
  const rateLimiter = options.rateLimiter ?? createRateLimiter(options.rateLimit);
  const bookingHandler = options.bookingHandler ??
    ((request, context) => handleBookingRequest(request, context, {
      ...options,
      store: createStore(options),
      rateLimiter
    }));
  const paymentOptions = {
    stripeEnabled: options.stripeEnabled ?? process.env.STRIPE_ENABLED === '1',
    stripeSecretKey: options.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY,
    stripeAllowLive: options.stripeAllowLive,
    stripeFetchImpl: options.stripeFetchImpl,
    stripeApiBase: options.stripeApiBase,
    stripeClient: options.stripeClient,
    cardEnabled: options.cardEnabled ?? process.env.STRIPE_CARD_ENABLED !== '0',
    swishEnabled: options.swishEnabled ?? process.env.STRIPE_SWISH_ENABLED === '1',
    publicBaseUrl: options.publicBaseUrl,
    outboxEnabled: options.outboxEnabled ?? process.env.STRIPE_OUTBOX_ENABLED === '1'
  };
  const stripeWebhookHandler = options.stripeWebhookHandler ??
    ((request, context) => handleStripeWebhook(request, context, {
      ...options,
      ...paymentOptions,
      availabilityHandler,
      availability: options.availability,
      store: createStore(options)
    }));
  const paymentPageHandler = options.paymentPageHandler ??
    ((request, context) => handlePaymentPage(request, context, { ...paymentOptions, store: createStore(options) }));
  const paymentActionHandler = options.paymentActionHandler ??
    ((request, context) => handlePaymentAction(request, context, { ...paymentOptions, store: createStore(options) }));
  const paymentResultHandler = options.paymentResultHandler ??
    ((request, context) => handlePaymentResult(request, context, { ...paymentOptions, store: createStore(options) }));
  const directBookingOptions = {
    ...paymentOptions,
    directBookingEnabled: options.directBookingEnabled ?? process.env.DIRECT_BOOKING_ENABLED === '1',
    allowLiveDirectBooking: options.allowLiveDirectBooking,
    stripeMode: options.stripeMode ?? process.env.STRIPE_MODE ?? 'test',
    availability: options.availability,
    availabilityHandler,
    rules: options.rules,
    rateLimiter,
    requireDurableStore: options.requireDurableStore
  };
  const directBookingHandler = options.directBookingHandler ??
    ((request, context) => handleDirectBooking(request, context, {
      ...directBookingOptions,
      store: createStore(options)
    }));
  const directBookingConfirmationHandler = options.directBookingConfirmationHandler ??
    ((request, context) => handleDirectBookingConfirmation(request, context, {
      ...directBookingOptions,
      store: createStore(options)
    }));
  const rulesHandler = options.rulesHandler ?? (async () => publicRules(await loadRules(options)));
  const calendarExportHandler = options.calendarExportHandler ??
    ((request, context) => handleCalendarExport(request, context, {
      ...options,
      store: createStore(options)
    }));
  const warn = options.warn ?? ((message) => console.error(message));
  let availabilityStore = options.availabilityStore ?? options.store ?? null;
  let availabilityStoreResolved = Boolean(availabilityStore);
  function resolveAvailabilityStore() {
    if (availabilityStoreResolved) return availabilityStore || null;
    availabilityStoreResolved = true;
    try {
      availabilityStore = createStore(options);
    } catch {
      availabilityStore = null;
    }
    return availabilityStore;
  }
  // Kanoniskt värdnamn: rotdomänen 301-omdirigeras till www. Endast exakt
  // angivna apex-värdnamn påverkas — azurewebsites.net, localhost och övriga
  // värdar serveras som vanligt, så redirect-loops kan inte uppstå. API-anrop
  // omdirigeras aldrig (POST måste nå rätt endpoint utan metodbyte).
  const canonicalHost = (options.canonicalHost ?? 'www.skadeviherrgard.com').toLowerCase();
  const apexHosts = (options.apexHosts ?? ['skadeviherrgard.com']).map((h) => h.toLowerCase());
  const canonicalRedirect = options.canonicalRedirect ?? true;

  return async function requestListener(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Ogiltig förfrågan.' });
      return;
    }

    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (
      canonicalRedirect &&
      apexHosts.includes(host) &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !url.pathname.startsWith('/api/')
    ) {
      redirect(res, `https://${canonicalHost}${url.pathname}${url.search}`);
      return;
    }

    if (url.pathname === '/api/availability' && (req.method === 'GET' || req.method === 'HEAD')) {
      const context = { warn };
      const mustMergeInternal = options.availabilityStore !== undefined ||
        options.store !== undefined || isConfigured();
      try {
        const store = mustMergeInternal ? resolveAvailabilityStore() : null;
        if (mustMergeInternal && !store) {
          sendJson(res, 503, { error: 'Tillgängligheten är för tillfället okänd.' });
          return;
        }
        const result = await availabilityHandler({ query: url.searchParams }, context, {
          ...(options.availability ?? {}),
          calendarStatusStore: store ?? options.availability?.calendarStatusStore
        });
        if (result.status !== 200 || !Array.isArray(result.jsonBody?.blocked) || !mustMergeInternal) {
          sendJson(res, result.status, result.jsonBody, result.headers);
          return;
        }
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        let internal;
        try {
          internal = await loadInternalBlocked(store, start, end);
        } catch {
          sendJson(res, 503, { error: 'Tillgängligheten är för tillfället okänd.' });
          return;
        }
        const blocked = [...new Set([...result.jsonBody.blocked, ...internal])].sort();
        sendJson(res, 200, { ...result.jsonBody, blocked }, result.headers);
      } catch {
        sendJson(res, 503, { error: 'Tillgängligheten är för tillfället okänd.' });
      }
      return;
    }

    if (url.pathname === '/api/booking-rules' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        sendJson(res, 200, await rulesHandler());
      } catch {
        sendJson(res, 200, { published: false, version: null, text: '' });
      }
      return;
    }

    if (url.pathname === '/api/booking-config' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, {
        directBookingEnabled: directBookingAvailable(directBookingOptions),
        cardEnabled: directBookingOptions.cardEnabled !== false,
        manualRequestEnabled: options.bookingRequestsEnabled ?? process.env.BOOKING_REQUESTS_ENABLED === '1'
      });
      return;
    }

    if (url.pathname === '/api/booking-requests' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readJsonBody(req));
      } catch {
        sendJson(res, 400, { error: 'Förfrågan kunde inte tolkas.' });
        return;
      }
      const ip = clientIp(req);
      try {
        const result = await bookingHandler(
          { body, idempotencyKey: req.headers['idempotency-key'], ip },
          { warn },
          {}
        );
        sendJson(res, result.status, result.jsonBody, result.headers);
      } catch {
        sendJson(res, 503, { error: 'Förfrågningar kan tyvärr inte tas emot just nu. Vänligen kontakta oss direkt.' });
      }
      return;
    }

    if (url.pathname === '/api/direct-booking/availability' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!validateRange(url.searchParams)) {
        sendJson(res, 400, { error: 'Ogiltigt datumintervall.' });
        return;
      }
      const from = url.searchParams.get('start');
      const to = url.searchParams.get('end');
      try {
        const store = createStore(options);
        const addons = {
          tidigIncheckning: url.searchParams.get('tidigIncheckning') === '1',
          senUtcheckning: url.searchParams.get('senUtcheckning') === '1'
        };
        const availability = await checkDirectBookingAvailability(
          store,
          from,
          to,
          new Date(),
          directBookingOptions,
          addons
        );
        sendJson(res, 200, availability);
      } catch {
        sendJson(res, 200, {
          directBooking: false,
          code: 'DIRECT_BOOKING_UNAVAILABLE',
          reason: 'unavailable'
        });
      }
      return;
    }

    if (url.pathname === '/api/direct-booking' && req.method === 'POST') {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'Förfrågan kommer från en otillåten origin.' });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readJsonBody(req));
      } catch {
        sendJson(res, 400, { error: 'Förfrågan kunde inte tolkas.' });
        return;
      }
      const ip = clientIp(req);
      try {
        const result = await directBookingHandler(
          { body, idempotencyKey: req.headers['idempotency-key'], ip },
          { warn },
          {}
        );
        sendJson(res, result.status, result.jsonBody, result.headers);
      } catch {
        sendJson(res, 503, { error: 'Direktbokningen är tillfälligt otillgänglig. Skicka gärna en bokningsförfrågan.' });
      }
      return;
    }

    const calendarExportMatch =
      /^\/(?:kalender|api\/calendar\/export)\/([A-Za-z0-9_-]{20,128})\.ics$/.exec(url.pathname);
    if (calendarExportMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const result = await calendarExportHandler(
          { token: calendarExportMatch[1] },
          { warn },
          {}
        );
        res.writeHead(result.status, result.headers);
        res.end(req.method === 'HEAD' ? undefined : result.body);
      } catch {
        res.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end('Kalendern är tillfälligt otillgänglig.');
      }
      return;
    }

    const paymentPageMatch = /^\/betala\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    if (paymentPageMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const result = await paymentPageHandler(
          {
            token: paymentPageMatch[1],
            query: Object.fromEntries(url.searchParams)
          },
          { warn },
          {}
        );
        sendHtmlResult(res, result);
      } catch {
        await sendErrorPage(res, root, 503);
      }
      return;
    }

    const paymentActionMatch = /^\/api\/payments\/([A-Za-z0-9_-]{43})\/(card|swish|invoice-request)$/.exec(url.pathname);
    if (paymentActionMatch && req.method === 'POST') {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'Förfrågan kommer från en otillåten origin.' });
        return;
      }
      let form = {};
      if (paymentActionMatch[2] === 'invoice-request') {
        try {
          form = await readFormBody(req);
        } catch {
          sendJson(res, 400, { error: 'Fakturauppgifterna kunde inte tolkas.' });
          return;
        }
      }
      try {
        const result = await paymentActionHandler(
          {
            token: paymentActionMatch[1],
            action: paymentActionMatch[2] === 'card'
              ? 'card'
              : (paymentActionMatch[2] === 'swish' ? 'swish' : 'invoice'),
            form
          },
          { warn },
          {}
        );
        // Klienten kan be om JSON för att kunna registrera begin_checkout först
        // när servern har skapat/återanvänt en verifierad Stripe-session. Vid
        // alla andra svar används den vanliga HTML-redirecten oförändrat.
        const wantsJson = String(req.headers.accept || '').includes('application/json');
        const isCheckoutAction = paymentActionMatch[2] === 'card' || paymentActionMatch[2] === 'swish';
        if (wantsJson && isCheckoutAction && result.status === 303 && result.headers?.Location) {
          const valueOre = Number(result.headers['X-Payment-Value-Ore']);
          sendJson(res, 200, {
            checkoutUrl: result.headers.Location,
            valueOre: Number.isSafeInteger(valueOre) && valueOre > 0 ? valueOre : null,
            currency: 'SEK'
          });
          return;
        }
        sendHtmlResult(res, result);
      } catch {
        sendJson(res, 503, { error: 'Betalningssidan är tillfälligt otillgänglig.' });
      }
      return;
    }

    if (url.pathname === '/bokning-klar' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const result = await directBookingConfirmationHandler(
          { query: Object.fromEntries(url.searchParams) },
          { warn },
          {}
        );
        sendHtmlResult(res, result);
      } catch {
        await sendErrorPage(res, root, 503);
      }
      return;
    }

    if ((url.pathname === '/betalning-klar' || url.pathname === '/betalning-avbruten') &&
      (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const result = await paymentResultHandler(
          {
            page: url.pathname === '/betalning-avbruten' ? 'cancel' : 'success',
            query: Object.fromEntries(url.searchParams)
          },
          { warn },
          {}
        );
        sendHtmlResult(res, result);
      } catch {
        await sendErrorPage(res, root, 503);
      }
      return;
    }

    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
      let rawBody;
      try {
        rawBody = await readRawBody(req);
      } catch {
        sendJson(res, 400, { error: 'Förfrågan kunde inte tolkas.' });
        return;
      }
      try {
        const result = await stripeWebhookHandler(
          { rawBody, signature: req.headers['stripe-signature'] },
          { warn },
          {}
        );
        sendJson(res, result.status, result.jsonBody, result.headers);
      } catch {
        sendJson(res, 503, { error: 'Betalningen kunde inte registreras just nu.' });
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Metod tillåts inte.' }, { Allow: 'GET, HEAD, POST' });
      return;
    }

    // Gamla Wix-adresser: 301 till närmaste aktiva sida eller 410 om ingen
    // rimlig ersättning finns. Query-parametrar bevaras vid 301.
    const legacy = legacyRedirect(url.pathname);
    if (legacy) {
      if (legacy.status === 301) {
        redirect(res, `${legacy.location}${url.search}`);
      } else {
        await sendErrorPage(res, root, legacy.status);
      }
      return;
    }

    const { redirect: redirectTo, file } = resolveStatic(root, url.pathname);
    if (redirectTo !== null) {
      redirect(res, `${redirectTo}${url.search}`);
      return;
    }
    if (file === null) {
      await sendErrorPage(res, root, 404);
      return;
    }

    try {
      await serveFile(req, res, root, file);
    } catch {
      await sendErrorPage(res, root, 500);
    }
  };
}

function main() {
  const port = Number(process.env.PORT) || 8080;
  if (!isConfigured()) {
    console.error('VARNING: Durabel bokningslagring är inte konfigurerad (AZURE_STORAGE_ACCOUNT_NAME / AZURE_STORAGE_KEY). Bokningsförfrågningar kan inte tas emot.');
  }
  if (!(process.env.AIRBNB_ICAL_URL)) {
    console.error('VARNING: AIRBNB_ICAL_URL är inte konfigurerad — kalenderns tillgänglighet kan inte läsas.');
  }
  const server = http.createServer(createRequestListener());
  const calendarMonitor = process.env.AIRBNB_ICAL_URL
    ? createCalendarMonitor({ warn: (message) => console.error(message) })
    : null;
  server.listen(port, () => {
    console.log(`Skadevi servern lyssnar på port ${port}`);
  });

  // Stängd nedstängning: Azure skickar SIGTERM vid planerade omstarter.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    calendarMonitor?.stop();
    console.log(`Mottog ${signal}, stänger ner.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main();
}

module.exports = {
  createRequestListener,
  readJsonBody,
  readRawBody,
  readFormBody,
  resolveStatic,
  MIME_TYPES,
  PAGE_ROUTES
};
