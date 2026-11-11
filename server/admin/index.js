'use strict';

// Skadevi Bokningsportal — separat admin-server.
//
// Servern är read-only i denna version. Alla sidor och alla /api/admin/*-
// endpoints kräver autentisering via Easy Auth (eller --demo lokalt).
// Den har inga skrivvägar till Azure och skickar aldrig mejl.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAuth, AuthError } = require('./auth');
const { createAdminRepository } = require('./repository');
const {
  STATUS_META,
  filterBookings,
  sortBookings,
  formatDateKey
} = require('./domain');
const { renderDashboard } = require('./views/dashboard');
const { renderBookings } = require('./views/bookings');
const { renderBookingDetail } = require('./views/booking-detail');
const { renderErrorPage } = require('./views/error');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_BODY = 16 * 1024;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const ASSET_FILES = new Map([
  ['/assets/admin.css', path.join(PUBLIC_DIR, 'admin.css')],
  ['/assets/admin.js', path.join(PUBLIC_DIR, 'admin.js')],
  ['/assets/fonts.css', path.join(PROJECT_ROOT, 'src', 'css', 'fonts.css')],
  ['/assets/logo.png', path.join(PROJECT_ROOT, 'public', 'images', 'logo.png')]
]);

const STATUS_CODES = new Set([...Object.keys(STATUS_META), 'ALL']);
const SORT_KEYS = new Set(['arrival', 'created', 'amount']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function securityHeaders(req, options = {}) {
  const https = options.https === true || req.headers['x-forwarded-proto'] === 'https';
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  const headers = {
    ...securityHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  };
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

function sendHtml(req, res, status, html, extraHeaders = {}) {
  const headers = {
    ...securityHeaders(req),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  };
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : html);
}

function redirect(req, res, status, location) {
  res.writeHead(status, {
    ...securityHeaders(req),
    Location: location,
    'Cache-Control': 'no-store'
  });
  res.end();
}

async function serveAsset(req, res, pathname) {
  let file = ASSET_FILES.get(pathname);
  if (!file && pathname.startsWith('/fonts/')) {
    const name = pathname.slice('/fonts/'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      sendJson(req, res, 404, { error: 'Hittades inte.' });
      return;
    }
    file = path.join(PROJECT_ROOT, 'public', 'fonts', name);
  }
  if (!file) {
    sendJson(req, res, 404, { error: 'Hittades inte.' });
    return;
  }
  const info = await fs.stat(file).catch(() => null);
  if (!info || !info.isFile()) {
    sendJson(req, res, 404, { error: 'Hittades inte.' });
    return;
  }
  const data = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    ...securityHeaders(req),
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=300',
    'Content-Length': data.length
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function readJsonBody(req) {
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
      if (size > MAX_BODY) {
        reject(new Error('För stort meddelande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Ogiltig JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseFilters(searchParams) {
  const status = String(searchParams.get('status') ?? 'ALL').toUpperCase();
  const sort = String(searchParams.get('sort') ?? 'arrival');
  const dir = String(searchParams.get('dir') ?? 'asc');
  const from = String(searchParams.get('from') ?? '');
  const to = String(searchParams.get('to') ?? '');
  return {
    q: String(searchParams.get('q') ?? '').slice(0, 120),
    status: STATUS_CODES.has(status) ? status : 'ALL',
    from: DATE_PATTERN.test(from) ? from : '',
    to: DATE_PATTERN.test(to) ? to : '',
    sort: SORT_KEYS.has(sort) ? sort : 'arrival',
    dir: dir === 'desc' ? 'desc' : 'asc'
  };
}

function pageTitleFor(pathname) {
  if (pathname === '/admin') return 'Översikt';
  if (pathname === '/admin/bookings') return 'Bokningar';
  if (pathname.startsWith('/admin/bookings/')) return 'Bokningsdetaljer';
  return 'Bokningsportal';
}

async function handleApi(req, res, url, context) {
  const { auth, principal, repository, now } = context;
  const pathname = url.pathname;

  if (pathname === '/api/admin/session' && req.method === 'GET') {
    sendJson(req, res, 200, {
      user: {
        name: principal.name,
        email: principal.email,
        roles: principal.roles,
        isDemo: principal.isDemo
      },
      csrfToken: auth.getCsrfToken(principal),
      demo: auth.demo,
      authMode: auth.demo ? 'demo' : 'easyauth',
      easyAuthTrusted: auth.trustEasyAuth,
      dataSource: repository.type,
      readOnly: true,
      writesEnabled: false
    });
    return;
  }

  if (pathname === '/api/admin/dashboard' && req.method === 'GET') {
    const data = await repository.dashboard(now);
    sendJson(req, res, 200, data);
    return;
  }

  if (pathname === '/api/admin/bookings' && req.method === 'GET') {
    const filters = parseFilters(url.searchParams);
    const bookings = await repository.listBookings(filters, now);
    sendJson(req, res, 200, { bookings, filters, count: bookings.length });
    return;
  }

  const detailMatch = /^\/api\/admin\/bookings\/([^/]+)$/.exec(pathname);
  if (detailMatch && req.method === 'GET') {
    const reference = decodeURIComponent(detailMatch[1]);
    const booking = await repository.getBooking(reference, now);
    if (!booking) {
      sendJson(req, res, 404, { error: 'Bokningen hittades inte.' });
      return;
    }
    sendJson(req, res, 200, { booking });
    return;
  }

  const statusMatch = /^\/api\/admin\/bookings\/([^/]+)\/status$/.exec(pathname);
  if (statusMatch && req.method === 'POST') {
    if (!auth.verifyCsrf(req, principal)) {
      sendJson(req, res, 403, { error: 'Ogiltig CSRF-token.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(req, res, 400, { error: 'Förfrågan kunde inte tolkas.' });
      return;
    }
    const action = String(body.action ?? '');
    const allowed = new Set(['approve', 'decline', 'preliminary', 'confirm', 'cancel']);
    if (!allowed.has(action)) {
      sendJson(req, res, 400, { error: 'Okänd statusåtgärd.' });
      return;
    }
    if (action === 'confirm' || action === 'cancel') {
      auth.requireRole(principal, 'Owner');
    }
    // Första versionen är uttryckligen read-only. API-kontraktet finns på
    // plats, men ingen skrivning eller mejl sker.
    sendJson(req, res, 503, {
      error: 'Statusändringar är avstängda i denna version. Ingen bokning har ändrats.',
      action,
      reference: decodeURIComponent(statusMatch[1])
    });
    return;
  }

  if (pathname.startsWith('/api/admin/')) {
    sendJson(req, res, 404, { error: 'API-endpointen hittades inte.' });
    return;
  }

  sendJson(req, res, 404, { error: 'Hittades inte.' });
}

function createAdminRequestListener(options = {}) {
  const auth = options.auth ?? createAuth({ demo: options.demo });
  const demo = options.demo ?? auth.demo;
  const repository = options.repository ?? createAdminRepository({
    ...options,
    source: demo ? 'demo' : options.source
  });
  if (demo && repository.type === 'table') {
    throw new Error('Demoläge får inte läsa riktiga bokningar');
  }
  const clock = typeof options.now === 'function'
    ? options.now
    : () => options.now ?? new Date();

  return async function adminRequestListener(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(req, res, 400, { error: 'Ogiltig förfrågan.' });
      return;
    }

    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(req, res, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      redirect(req, res, 302, '/admin');
      return;
    }

    if (url.pathname === '/admin/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      redirect(req, res, 302, '/.auth/login/aad?post_login_redirect_uri=%2Fadmin');
      return;
    }

    const isApi = url.pathname.startsWith('/api/');
    let principal;
    try {
      principal = auth.requirePrincipal(req, {
        api: isApi,
        returnTo: `${url.pathname}${url.search}`
      });
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (error.redirect) {
        redirect(req, res, error.status, error.redirect);
        return;
      }
      const maybePrincipal = auth.principalFor(req);
      if (isApi) {
        sendJson(req, res, error.status, { error: error.message });
      } else {
        sendHtml(req, res, error.status, renderErrorPage({
          status: error.status,
          message: error.message,
          principal: maybePrincipal,
          demo,
          csrfToken: maybePrincipal ? auth.getCsrfToken(maybePrincipal) : ''
        }));
      }
      return;
    }

    const now = clock();
    const csrfToken = auth.getCsrfToken(principal);

    try {
      if (isApi) {
        if (req.method !== 'GET' && req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'Metod tillåts inte.' }, { Allow: 'GET, POST' });
          return;
        }
        await handleApi(req, res, url, { auth, principal, repository, now });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(req, res, 405, { error: 'Metod tillåts inte.' }, { Allow: 'GET, HEAD' });
        return;
      }

      if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
        await serveAsset(req, res, url.pathname);
        return;
      }

      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        const data = await repository.dashboard(now);
        sendHtml(req, res, 200, renderDashboard({
          data, principal, demo, csrfToken, now
        }));
        return;
      }

      if (url.pathname === '/admin/bookings' || url.pathname === '/admin/bookings/') {
        const filters = parseFilters(url.searchParams);
        const all = await repository.allBookings(now);
        const bookings = sortBookings(filterBookings(all, filters), filters.sort, filters.dir);
        sendHtml(req, res, 200, renderBookings({
          bookings,
          filters,
          principal,
          demo,
          csrfToken,
          totalCount: all.length
        }));
        return;
      }

      const detailMatch = /^\/admin\/bookings\/([^/]+)$/.exec(url.pathname);
      if (detailMatch) {
        const reference = decodeURIComponent(detailMatch[1]);
        const booking = await repository.getBooking(reference, now);
        if (!booking) {
          sendHtml(req, res, 404, renderErrorPage({
            status: 404,
            message: `Bokningen ${reference} hittades inte.`,
            principal,
            demo,
            csrfToken
          }));
          return;
        }
        sendHtml(req, res, 200, renderBookingDetail({
          booking, principal, demo, csrfToken
        }));
        return;
      }

      sendHtml(req, res, 404, renderErrorPage({
        status: 404,
        message: 'Sidan hittades inte.',
        principal,
        demo,
        csrfToken
      }));
    } catch (error) {
      if (error instanceof AuthError) {
        if (isApi) {
          sendJson(req, res, error.status, { error: error.message });
        } else {
          sendHtml(req, res, error.status, renderErrorPage({
            status: error.status,
            message: error.message,
            principal,
            demo,
            csrfToken
          }));
        }
        return;
      }
      console.error(`Adminfel på ${pageTitleFor(url.pathname)}: ${error.message}`);
      if (isApi) {
        sendJson(req, res, 503, { error: 'Bokningsdata är tillfälligt otillgänglig.' });
      } else {
        sendHtml(req, res, 503, renderErrorPage({
          status: 503,
          message: 'Bokningsdata är tillfälligt otillgänglig. Försök igen om en stund.',
          principal,
          demo,
          csrfToken
        }));
      }
    }
  };
}

function main() {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo') || args.includes('--dev-auth');
  if (demo && process.env.NODE_ENV === 'production') {
    console.error('Demoläge får inte användas i produktion.');
    process.exit(1);
  }
  const port = Number(process.env.ADMIN_PORT || process.env.PORT || 3001);
  let repository;
  try {
    repository = createAdminRepository({
      source: demo ? 'demo' : process.env.ADMIN_DATA_SOURCE
    });
  } catch (error) {
    console.error(`Kunde inte starta bokningsportalen: ${error.message}`);
    process.exit(1);
  }
  let auth;
  try {
    auth = createAuth({ demo });
  } catch (error) {
    console.error(`Kunde inte starta autentisering: ${error.message}`);
    process.exit(1);
  }
  const server = http.createServer(createAdminRequestListener({
    auth,
    repository,
    demo
  }));
  server.listen(port, () => {
    console.log(`Skadevi bokningsportal lyssnar på http://localhost:${port}/admin`);
    console.log(`Datakälla: ${repository.type} · read-only · skrivningar avstängda`);
    console.log(`Autentisering: ${auth.demo ? 'demo' : `Easy Auth (trusted=${auth.trustEasyAuth})`}`);
    if (demo) console.log('Demoläge: alla bokningar är syntetiska och märkta DEMO-.');
  });
  const shutdown = (signal) => {
    console.log(`Mottog ${signal}, stänger ner.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  createAdminRequestListener,
  parseFilters,
  securityHeaders,
  MIME_TYPES,
  formatDateKey
};
