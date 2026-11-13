'use strict';

// Produktionsserver för Skadevi Gård: serverar Vite-bygget i dist/ (statisk
// webbplats med rena URL:er) samt kalender-API:et /api/availability via
// oförändrad kalenderlogik i server/calendar/. Inga externa beroenden.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { handleAvailability } = require('./calendar/availability');
const { handleBookingRequest, createRateLimiter } = require('./booking/requests');
const { loadRules, publicRules } = require('./booking/rules');
const { createStore, isConfigured } = require('./booking/store');

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
  'digital-visning', 'boka', 'lediga-datum'
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
  const rulesHandler = options.rulesHandler ?? (async () => publicRules(await loadRules(options)));
  const warn = options.warn ?? ((message) => console.error(message));
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
      try {
        const result = await availabilityHandler({ query: url.searchParams }, context, options.availability ?? {});
        sendJson(res, result.status, result.jsonBody, result.headers);
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

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Metod tillåts inte.' }, { Allow: 'GET, HEAD, POST' });
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
  server.listen(port, () => {
    console.log(`Skadevi servern lyssnar på port ${port}`);
  });

  // Stängd nedstängning: Azure skickar SIGTERM vid planerade omstarter.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
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

module.exports = { createRequestListener, readJsonBody, resolveStatic, MIME_TYPES, PAGE_ROUTES };
