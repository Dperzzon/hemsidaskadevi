'use strict';

// Skadevi Bokningsportal — separat admin-server.
//
// Servern är read-only i denna version. Alla sidor och alla /api/admin/*-
// endpoints kräver autentisering via Easy Auth (eller --demo lokalt).
// Den har inga skrivvägar till Azure och skickar aldrig mejl.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAuth, AuthError } = require('./auth');
const { createAdminRepository } = require('./repository');
const {
  STATUS_META,
  filterBookings,
  sortBookings,
  formatDateKey,
  todayKey
} = require('./domain');
const { renderDashboard } = require('./views/dashboard');
const { renderBookings } = require('./views/bookings');
const { renderBookingDetail } = require('./views/booking-detail');
const { renderNewBooking } = require('./views/booking-new');
const { renderCalendar } = require('./views/calendar');
const { renderDirectBooking } = require('./views/direct-booking');
const { renderErrorPage } = require('./views/error');
const {
  createManualBooking,
  changeStatus,
  addNote,
  updatePayment,
  recordPayment,
  correctPayment,
  updateAddons,
  removeBlock,
  calendarRange,
  enrichWarnings,
  acknowledgeWarning,
  recheckWarning,
  retryBookingNotifications
} = require('./booking-service');
const {
  DOCUMENT_KINDS,
  DocumentError,
  renderDocument
} = require('./documents');
const {
  createPaymentLink,
  revokePaymentLink,
  changeInvoiceRequestStatus
} = require('./stripe-payment-service');
const {
  openDirectBooking,
  closeDirectBooking,
  setAutomaticDirectBooking,
  approveCalendarSafety,
  directBookingOverview
} = require('./direct-booking-service');
const {
  requestReconciliation,
  requestRefundSync,
  recordRefund
} = require('./refund-service');

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
    // Easy Auth kräver en same-origin Referer för cookie-autentiserade
    // POST/PATCH/DELETE. no-referrer gjorde att plattformen svarade 403
    // (substatus 60) innan appens egen CSRF-kontroll kördes.
    'Referrer-Policy': 'same-origin',
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
  if (status >= 400 && String(req.url ?? '').startsWith('/api/admin/')) {
    const pathOnly = String(req.url).split('?')[0];
    console.warn(`[admin-api] ${req.method} ${pathOnly} -> ${status} ${body?.code ?? ''}`.trim());
  }
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

function sendPdf(req, res, document) {
  const asciiName = document.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(document.filename).replace(/'/g, '%27');
  const headers = {
    ...securityHeaders(req),
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'Content-Length': document.buffer.length,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : document.buffer);
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
  if (pathname === '/admin/bookings/new') return 'Ny bokning';
  if (pathname === '/admin/calendar') return 'Kalender';
  if (pathname === '/admin/direct-booking') return 'Direktbokning';
  if (pathname.startsWith('/admin/bookings/')) return 'Bokningsdetaljer';
  return 'Bokningsportal';
}

function parseCalendarRange(searchParams, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const requested = String(searchParams.get('from') ?? '');
  const from = /^\d{4}-\d{2}$/.test(requested)
    ? `${requested}-01`
    : (DATE_PATTERN.test(requested) ? requested : `${today.slice(0, 7)}-01`);
  const monthStart = `${from.slice(0, 7)}-01`;
  const next = new Date(`${monthStart}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from: monthStart, to: next.toISOString().slice(0, 10) };
}

function redactPaymentLinks(booking, principal) {
  if (!booking || principal?.roles?.includes('Owner')) return booking;
  const redact = (request) => request ? { ...request, url: '' } : request;
  return {
    ...booking,
    paymentRequest: redact(booking.paymentRequest),
    paymentRequests: Array.isArray(booking.paymentRequests)
      ? booking.paymentRequests.map(redact)
      : []
  };
}

function serviceOptions(context) {
  return {
    now: context.now,
    expectedEtag: context.expectedEtag,
    idempotencyKey: context.idempotencyKey,
    availabilityHandler: context.availabilityHandler,
    requireAirbnbCheck: context.requireAirbnbCheck,
    availability: context.availability,
    outboxEnabled: context.outboxEnabled,
    stripeEnabled: context.stripeEnabled,
    stripeMode: context.stripeMode,
    paymentLinkTtlMs: context.paymentLinkTtlMs,
    publicBaseUrl: context.publicBaseUrl
  };
}

async function readBodyOrError(req, res, optional = false) {
  const contentType = String(req.headers['content-type'] ?? '');
  const contentLength = String(req.headers['content-length'] ?? '');
  if (optional && (!contentType || contentLength === '0')) {
    return { body: {} };
  }
  try {
    return { body: await readJsonBody(req) };
  } catch {
    if (optional) return { body: {} };
    sendJson(req, res, 400, { error: 'Förfrågan kunde inte tolkas.' });
    return null;
  }
}

function guardWrite(req, res, context) {
  const { auth, principal } = context;
  if (!context.writesEnabled) {
    sendJson(req, res, 503, {
      error: 'Skrivfunktioner är inte aktiverade i denna miljö. Ingen bokning har ändrats.'
    });
    return false;
  }
  if (!auth.verifyCsrf(req, principal)) {
    sendJson(req, res, 403, { error: 'Ogiltig CSRF-token.' });
    return false;
  }
  auth.requireRole(principal, 'Owner');
  return true;
}

async function handleApi(req, res, url, context) {
  const { auth, principal, repository, now } = context;
  const pathname = url.pathname;
  if (typeof req.headers['if-match'] === 'string') {
    context.expectedEtag = req.headers['if-match'];
  }

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
      readOnly: !context.writesEnabled,
      writesEnabled: context.writesEnabled,
      payments: {
        stripeEnabled: context.stripeEnabled === true,
        stripeMode: context.stripeMode ?? 'disabled',
        swishEnabled: context.stripeSwishEnabled === true
      }
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
    const bookings = (await repository.listBookings(filters, now))
      .map((booking) => redactPaymentLinks(booking, principal));
    sendJson(req, res, 200, { bookings, filters, count: bookings.length });
    return;
  }

  if (pathname === '/api/admin/bookings' && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await createManualBooking(repository, principal, parsed.body, {
      ...serviceOptions(context),
      idempotencyKey: req.headers['idempotency-key']
    }, { warn: context.warn });
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  if (pathname === '/api/admin/calendar' && req.method === 'GET') {
    const range = parseCalendarRange(url.searchParams, now);
    const data = await calendarRange(repository, range.from, range.to, now);
    sendJson(req, res, 200, { ...range, ...data });
    return;
  }

  if (pathname === '/api/admin/calendar/blocks' && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await createManualBooking(repository, principal, {
      ...parsed.body,
      mode: 'block',
      statusCode: 'BLOCKED'
    }, {
      ...serviceOptions(context),
      idempotencyKey: req.headers['idempotency-key']
    }, { warn: context.warn });
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const unblockMatch = /^\/api\/admin\/calendar\/blocks\/([^/]+)$/.exec(pathname);
  if (unblockMatch && req.method === 'DELETE') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res, true);
    if (!parsed) return;
    const result = await removeBlock(
      repository,
      principal,
      decodeURIComponent(unblockMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  if (pathname === '/api/admin/direct-booking' && req.method === 'GET') {
    const data = await directBookingOverview(repository, now);
    sendJson(req, res, 200, data);
    return;
  }

  if (pathname === '/api/admin/direct-booking/toggle' && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await setAutomaticDirectBooking(
      repository,
      principal,
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  if (pathname === '/api/admin/direct-booking/calendar/approve' && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await approveCalendarSafety(
      repository,
      principal,
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  if (pathname === '/api/admin/direct-booking/open' && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await openDirectBooking(
      repository,
      principal,
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  if (pathname === '/api/admin/direct-booking/close' && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await closeDirectBooking(
      repository,
      principal,
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const documentMatch = /^\/api\/admin\/bookings\/([^/]+)\/(quote|confirmation)\.pdf$/.exec(pathname);
  if (documentMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const reference = decodeURIComponent(documentMatch[1]);
    const booking = await repository.getBooking(reference, now);
    if (!booking) {
      sendJson(req, res, 404, { error: 'Bokningen hittades inte.' });
      return;
    }
    const kind = documentMatch[2] === 'quote'
      ? DOCUMENT_KINDS.QUOTE
      : DOCUMENT_KINDS.CONFIRMATION;
    try {
      const document = await renderDocument(kind, booking, {
        now,
        rules: context.rules
      });
      sendPdf(req, res, document);
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      sendJson(req, res, error.status, {
        error: error.message,
        code: error.code
      });
    }
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
    await enrichWarnings(repository, booking, now);
    sendJson(req, res, 200, { booking: redactPaymentLinks(booking, principal) });
    return;
  }

  const historyMatch = /^\/api\/admin\/bookings\/([^/]+)\/history$/.exec(pathname);
  if (historyMatch && req.method === 'GET') {
    const reference = decodeURIComponent(historyMatch[1]);
    const history = await repository.listHistory(reference);
    sendJson(req, res, 200, { history });
    return;
  }

  const statusMatch = /^\/api\/admin\/bookings\/([^/]+)\/status$/.exec(pathname);
  if (statusMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const action = String(parsed.body.action ?? '');
    const allowed = new Set(['approve', 'decline', 'preliminary', 'confirm', 'cancel']);
    if (!allowed.has(action)) {
      sendJson(req, res, 400, { error: 'Okänd statusåtgärd.' });
      return;
    }
    const result = await changeStatus(
      repository,
      principal,
      decodeURIComponent(statusMatch[1]),
      action,
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const notesMatch = /^\/api\/admin\/bookings\/([^/]+)\/notes$/.exec(pathname);
  if (notesMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await addNote(
      repository,
      principal,
      decodeURIComponent(notesMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const addonsMatch = /^\/api\/admin\/bookings\/([^/]+)\/addons$/.exec(pathname);
  if (addonsMatch && req.method === 'PATCH') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await updateAddons(
      repository,
      principal,
      decodeURIComponent(addonsMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const paymentCorrectionMatch = /^\/api\/admin\/bookings\/([^/]+)\/payments\/([^/]+)\/corrections$/.exec(pathname);
  if (paymentCorrectionMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await correctPayment(
      repository,
      principal,
      decodeURIComponent(paymentCorrectionMatch[1]),
      decodeURIComponent(paymentCorrectionMatch[2]),
      parsed.body,
      {
        ...serviceOptions(context),
        idempotencyKey: req.headers['idempotency-key'] ?? parsed.body.idempotencyKey
      },
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const paymentsMatch = /^\/api\/admin\/bookings\/([^/]+)\/payments$/.exec(pathname);
  if (paymentsMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await recordPayment(
      repository,
      principal,
      decodeURIComponent(paymentsMatch[1]),
      parsed.body,
      {
        ...serviceOptions(context),
        idempotencyKey: req.headers['idempotency-key'] ?? parsed.body.idempotencyKey
      },
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const paymentLinkMatch = /^\/api\/admin\/bookings\/([^/]+)\/payment-link$/.exec(pathname);
  if (paymentLinkMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res, true);
    if (!parsed) return;
    const result = await createPaymentLink(
      repository,
      principal,
      decodeURIComponent(paymentLinkMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const paymentLinkRevokeMatch = /^\/api\/admin\/bookings\/([^/]+)\/payment-link\/revoke$/.exec(pathname);
  if (paymentLinkRevokeMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res, true);
    if (!parsed) return;
    const result = await revokePaymentLink(
      repository,
      principal,
      decodeURIComponent(paymentLinkRevokeMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const notificationsRetryMatch = /^\/api\/admin\/bookings\/([^/]+)\/notifications\/retry$/.exec(pathname);
  if (notificationsRetryMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res, true);
    if (!parsed) return;
    const result = await retryBookingNotifications(
      repository,
      principal,
      decodeURIComponent(notificationsRetryMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const reconcileMatch = /^\/api\/admin\/bookings\/([^/]+)\/reconcile$/.exec(pathname);
  if (reconcileMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res, true);
    if (!parsed) return;
    const result = await requestReconciliation(
      repository,
      principal,
      decodeURIComponent(reconcileMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const refundsSyncMatch = /^\/api\/admin\/bookings\/([^/]+)\/refunds\/sync$/.exec(pathname);
  if (refundsSyncMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res, true);
    if (!parsed) return;
    const result = await requestRefundSync(
      repository,
      principal,
      decodeURIComponent(refundsSyncMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const refundsMatch = /^\/api\/admin\/bookings\/([^/]+)\/refunds$/.exec(pathname);
  if (refundsMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await recordRefund(
      repository,
      principal,
      decodeURIComponent(refundsMatch[1]),
      parsed.body,
      {
        ...serviceOptions(context),
        idempotencyKey: req.headers['idempotency-key'] ?? parsed.body.idempotencyKey
      },
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const invoiceRequestMatch = /^\/api\/admin\/bookings\/([^/]+)\/invoice-requests\/([^/]+)$/.exec(pathname);
  if (invoiceRequestMatch && req.method === 'PATCH') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await changeInvoiceRequestStatus(
      repository,
      principal,
      decodeURIComponent(invoiceRequestMatch[1]),
      decodeURIComponent(invoiceRequestMatch[2]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const paymentMatch = /^\/api\/admin\/bookings\/([^/]+)\/payment$/.exec(pathname);
  if (paymentMatch && req.method === 'PATCH') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await updatePayment(
      repository,
      principal,
      decodeURIComponent(paymentMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const acknowledgeMatch = /^\/api\/admin\/bookings\/([^/]+)\/warnings\/acknowledge$/.exec(pathname);
  if (acknowledgeMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await acknowledgeWarning(
      repository,
      principal,
      decodeURIComponent(acknowledgeMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
    return;
  }

  const recheckMatch = /^\/api\/admin\/bookings\/([^/]+)\/warnings\/recheck$/.exec(pathname);
  if (recheckMatch && req.method === 'POST') {
    if (!guardWrite(req, res, context)) return;
    const parsed = await readBodyOrError(req, res);
    if (!parsed) return;
    const result = await recheckWarning(
      repository,
      principal,
      decodeURIComponent(recheckMatch[1]),
      parsed.body,
      serviceOptions(context),
      { warn: context.warn }
    );
    sendJson(req, res, result.status, result.jsonBody);
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
  const writesEnabled = options.writesEnabled ??
    (repository.type === 'table'
      ? process.env.ADMIN_WRITES_ENABLED === '1'
      : true);
  const requireAirbnbCheck = options.requireAirbnbCheck ??
    (repository.type === 'table'
      ? process.env.ADMIN_REQUIRE_AIRBNB_CHECK !== '0'
      : false);
  const outboxEnabled = options.outboxEnabled ?? process.env.ADMIN_MAIL_OUTBOX_ENABLED === '1';
  const stripeEnabled = options.stripeEnabled ?? process.env.STRIPE_ENABLED === '1';
  const stripeSwishEnabled = options.stripeSwishEnabled ?? process.env.STRIPE_SWISH_ENABLED === '1';
  const stripeMode = options.stripeMode ?? (
    !stripeEnabled
      ? 'disabled'
      : (String(process.env.STRIPE_MODE ?? 'test').toLowerCase() === 'live' ? 'live' : 'test')
  );
  const warn = options.warn ?? ((message) => console.error(message));

  return async function adminRequestListener(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(req, res, 400, { error: 'Ogiltig förfrågan.' });
      return;
    }

    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      let calendarParserReady = false;
      try {
        require.resolve('node-ical');
        calendarParserReady = true;
      } catch {
        calendarParserReady = false;
      }
      const airbnbConfigured = typeof process.env.AIRBNB_ICAL_URL === 'string' &&
        process.env.AIRBNB_ICAL_URL.startsWith('http');
      let calendarSync = null;
      try {
        const stored = await repository.getCalendarSyncStatus();
        if (stored) {
          calendarSync = {
            status: stored.status,
            safetyStatus: stored.safetyStatus,
            safetyReason: stored.safetyReason,
            lastCheckAt: stored.lastCheckAt,
            lastSuccessAt: stored.lastSuccessAt,
            consecutiveFailures: stored.consecutiveFailures,
            eventCount: stored.eventCount,
            snapshotFrom: stored.snapshotFrom,
            snapshotTo: stored.snapshotTo,
            blockedNights: Array.isArray(stored.snapshotNights) ? stored.snapshotNights.length : 0
          };
        }
      } catch {
        calendarSync = null;
      }
      sendJson(req, res, 200, {
        status: 'ok',
        airbnbConfigured,
        calendarParserReady,
        calendarSync
      });
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
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
          sendJson(req, res, 405, { error: 'Metod tillåts inte.' }, { Allow: 'GET, POST, PATCH, DELETE' });
          return;
        }
        await handleApi(req, res, url, {
          auth,
          principal,
          repository,
          now,
          writesEnabled,
          requireAirbnbCheck,
          outboxEnabled,
          stripeEnabled,
          stripeSwishEnabled,
          stripeMode,
          paymentLinkTtlMs: options.paymentLinkTtlMs,
          publicBaseUrl: options.publicBaseUrl,
          availabilityHandler: options.availabilityHandler,
          availability: options.availability,
          rules: options.rules,
          warn
        });
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
          data, principal, demo, csrfToken, writesEnabled, now
        }));
        return;
      }

      if (url.pathname === '/admin/bookings' || url.pathname === '/admin/bookings/') {
        const filters = parseFilters(url.searchParams);
        const all = await repository.allBookings(now);
        const bookings = sortBookings(filterBookings(all, filters), filters.sort, filters.dir)
          .map((booking) => redactPaymentLinks(booking, principal));
        sendHtml(req, res, 200, renderBookings({
          bookings,
          filters,
          principal,
          demo,
          csrfToken,
          writesEnabled,
          totalCount: all.length
        }));
        return;
      }

      if (url.pathname === '/admin/bookings/new' || url.pathname === '/admin/bookings/new/') {
        if (!principal.roles?.includes('Owner')) {
          sendHtml(req, res, 403, renderErrorPage({
            status: 403,
            message: 'Endast Owner kan skapa manuella bokningar.',
            principal,
            demo,
            csrfToken
          }));
          return;
        }
        sendHtml(req, res, 200, renderNewBooking({
          principal, demo, csrfToken, writesEnabled, outboxEnabled
        }));
        return;
      }

      if (url.pathname === '/admin/calendar' || url.pathname === '/admin/calendar/') {
        const range = parseCalendarRange(url.searchParams, now);
        const data = await calendarRange(repository, range.from, range.to, now);
        sendHtml(req, res, 200, renderCalendar({
          data, from: range.from, principal, demo, csrfToken, writesEnabled
        }));
        return;
      }

      if (url.pathname === '/admin/direct-booking' || url.pathname === '/admin/direct-booking/') {
        const data = await directBookingOverview(repository, now);
        sendHtml(req, res, 200, renderDirectBooking({
          data, principal, demo, csrfToken, writesEnabled
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
        const history = await repository.listHistory(reference).catch(() => []);
        await enrichWarnings(repository, booking, now);
        sendHtml(req, res, 200, renderBookingDetail({
          booking: redactPaymentLinks(booking, principal),
          principal, demo, csrfToken, writesEnabled, history, today: todayKey(now),
          stripeEnabled, stripeMode, stripeSwishEnabled, outboxEnabled
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
      const referenceId = crypto.randomUUID().slice(0, 8).toUpperCase();
      console.error(`Adminfel [${referenceId}] på ${pageTitleFor(url.pathname)}: ${error.stack || error.message}`);
      if (isApi) {
        sendJson(req, res, 503, {
          error: 'Bokningsdata är tillfälligt otillgänglig. Försök igen om en stund.',
          code: 'STORAGE',
          referenceId
        });
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
    console.log(`Datakälla: ${repository.type} · skrivningar ${repository.type === 'table' && process.env.ADMIN_WRITES_ENABLED !== '1' ? 'avstängda' : 'aktiva'}`);
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
