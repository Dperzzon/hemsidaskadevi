'use strict';

const crypto = require('node:crypto');
const {
  computePaymentSummary,
  normalizePaymentRequests,
  latestPaymentRequest
} = require('../booking/payment-ledger');
const {
  createPaymentAccess,
  verifyCalendarLock,
  revokePaymentAccess
} = require('../booking/payment-access');
const {
  updateInvoiceRequestStatus,
  normalizeInvoiceRequests
} = require('../booking/invoice-requests');
const { buildPaymentLinkNotification } = require('../booking/booking-mail');
const { queueNotification } = require('../booking/outbox');

const REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,80}$/;
const MAX_PAYMENT_REQUESTS = 20;

function error(status, message, extra = {}) {
  return { status, jsonBody: { error: message, ...extra } };
}

function cleanString(value, limit = 500) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, limit);
}

function actorOf(principal) {
  return {
    id: cleanString(principal?.id ?? principal?.email ?? '', 120) || 'unknown',
    name: cleanString(principal?.name ?? principal?.email ?? '', 120) || 'Okänd'
  };
}

function publicBaseUrl(options = {}) {
  const raw = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://www.skadeviherrgard.com';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_BASE_URL är inte en giltig URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('PUBLIC_BASE_URL måste använda HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('PUBLIC_BASE_URL får inte innehålla inloggningsuppgifter');
  }
  return url.origin;
}

function paymentPageUrl(options, token) {
  return `${publicBaseUrl(options)}/betala/${encodeURIComponent(token)}`;
}

function stripeModeOf(options = {}) {
  const mode = String(options.stripeMode ?? process.env.STRIPE_MODE ?? 'test').toLowerCase();
  return mode === 'live' ? 'live' : 'test';
}

async function appendAudit(repo, principal, action, record, details = {}, context = {}) {
  const now = new Date();
  const actor = actorOf(principal);
  try {
    await repo.appendHistory({
      idempotencyKey: `${record.reference}_${action}_${now.toISOString()}_${crypto.randomBytes(4).toString('hex')}`,
      reference: record.reference,
      action,
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify(details.changes ?? {}),
      reason: details.reason ?? '',
      actorId: actor.id,
      actorName: actor.name,
      correlationId: crypto.randomUUID(),
      at: now.toISOString()
    });
  } catch {
    context.warn?.(`Auditpost kunde inte sparas för ${record.reference}.`);
  }
}

function buildPaymentLinkEmail(record, url, amountOre, expiresAt) {
  return buildPaymentLinkNotification(record, url, amountOre, expiresAt);
}

async function queuePaymentLink(repo, record, url, amountOre, expiresAt, options, context) {
  if (record?.statusCode !== 'CONFIRMED') {
    return { ok: false, queued: false, skipped: 'not_confirmed' };
  }
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const notification = buildPaymentLinkEmail(record, url, amountOre, expiresAt);
  const outboxContext = {
    ...context,
    appendHistory: typeof repo.appendHistory === 'function'
      ? (entry) => repo.appendHistory(entry)
      : undefined
  };
  const result = await queueNotification(
    (entry) => repo.saveOutbox(entry),
    {
      idempotencyKey: `outbox-payment-link-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}`,
      reference: record.reference,
      notification,
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
  return { ...result, queued: result.ok === true && result.duplicate !== true };
}

async function calendarRowsFor(repo, reference) {
  if (typeof repo.listCalendarByReference !== 'function') return null;
  try {
    return await repo.listCalendarByReference(reference);
  } catch {
    return null;
  }
}

async function createPaymentLink(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan skapa betalningslänkar.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');

  const record = { ...raw.record };
  if (record.statusCode === 'BLOCKED' || /^BLOCK-/.test(String(record.reference ?? ''))) {
    return error(422, 'Datumblockeringar har inga betalningar.', { code: 'PAYMENT_NOT_AVAILABLE' });
  }
  if (record.statusCode !== 'CONFIRMED') {
    return error(
      422,
      'Betalningslänk kan endast skapas för en bekräftad bokning.',
      { code: 'PAYMENT_REQUIRES_CONFIRMED' }
    );
  }

  const summary = computePaymentSummary(record);
  if (summary.remainingOre <= 0) {
    return error(409, 'Bokningen är redan betald.', { code: 'PAYMENT_ALREADY_PAID' });
  }

  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
      code: 'STALE'
    });
  }

  const enabled = options.stripeEnabled ?? process.env.STRIPE_ENABLED === '1';
  if (!enabled) {
    return error(503, 'Betalningslänkar är inte aktiverade i denna miljö.', {
      code: 'PAYMENT_LINKS_DISABLED'
    });
  }

  const calendarRows = await calendarRowsFor(repo, reference);
  let calendarRange = typeof repo.listCalendar === 'function' ? null : undefined;
  if (typeof repo.listCalendar === 'function') {
    try {
      calendarRange = await repo.listCalendar(record.arrival, record.departure);
    } catch {
      calendarRange = null;
    }
  }
  const lock = verifyCalendarLock(record, calendarRows, calendarRange);
  if (!lock.ok) {
    return error(409, 'Bokningen saknar giltig intern kalenderlåsning.', {
      code: lock.code,
      missing: lock.missing ?? [],
      conflicts: lock.conflicts ?? []
    });
  }

  const now = options.now ?? new Date();
  const actor = actorOf(principal);
  const created = createPaymentAccess({
    now,
    ttlMs: options.paymentLinkTtlMs,
    createdBy: actor.name,
    createdById: actor.id
  });
  let url;
  try {
    url = paymentPageUrl(options, created.token);
  } catch (cause) {
    context.warn?.(`Betalningslänk: ${cause.message}`);
    return error(500, 'Betalningslänken kunde inte skapas på grund av serverkonfigurationen.', {
      code: 'PAYMENT_LINK_CONFIGURATION'
    });
  }
  const requests = normalizePaymentRequests(record).map((request) => request.status === 'OPEN'
    ? {
      ...request,
      status: 'SUPERSEDED',
      statusLabel: 'Ersatt',
      updatedAt: now.toISOString()
    }
    : request).slice(-MAX_PAYMENT_REQUESTS);
  const updatedRecord = {
    ...record,
    paymentAccess: created.access,
    paymentTokenHash: created.tokenHash,
    paymentRequests: requests,
    paymentRequest: latestPaymentRequest(requests),
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actor.name
  };

  try {
    await repo.updateRequest(updatedRecord, { ifMatch: raw.etag });
  } catch (cause) {
    if (cause?.status === 409) {
      return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
        code: 'STALE'
      });
    }
    throw cause;
  }

  await appendAudit(repo, principal, 'PAYMENT_LINK_CREATED', updatedRecord, {
    reason: cleanString(body.reason, 500),
    changes: {
      amountOre: summary.remainingOre,
      expiresAt: created.access.expiresAt,
      mode: stripeModeOf(options)
    }
  }, context);
  if (typeof repo.cancelPendingOutbox === 'function') {
    try {
      await repo.cancelPendingOutbox(reference, {
        mailTypes: ['GUEST_PAYMENT_LINK'],
        reason: 'Ersatt av ny betalningslänk',
        now
      });
    } catch {
      context.warn?.(`Tidigare betalningslänksmejl kunde inte makuleras för ${reference}.`);
    }
  }
  const emailResult = await queuePaymentLink(
    repo,
    updatedRecord,
    url,
    summary.remainingOre,
    created.access.expiresAt,
    options,
    context
  );

  return {
    status: 201,
    jsonBody: {
      reference,
      emailQueued: emailResult.queued === true,
      paymentLink: {
        url,
        status: 'OPEN',
        statusLabel: 'Aktiv',
        amountOre: summary.remainingOre,
        amount: summary.balance,
        currency: 'sek',
        createdAt: created.access.createdAt,
        expiresAt: created.access.expiresAt,
        createdBy: actor.name,
        mode: stripeModeOf(options)
      }
    }
  };
}

async function revokePaymentLink(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan återkalla betalningslänkar.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
      code: 'STALE'
    });
  }
  const now = options.now ?? new Date();
  const record = revokePaymentAccess({ ...raw.record }, {
    now,
    reason: cleanString(body.reason, 500) || 'Återkallad av Owner'
  });
  if (!raw.record.paymentAccess) {
    return { status: 200, jsonBody: { reference, revoked: false, etag: raw.etag } };
  }
  record.version = Number(raw.record.version || 1) + 1;
  record.updatedAt = now.toISOString();
  record.updatedBy = actorOf(principal).name;
  try {
    const saved = await repo.updateRequest(record, { ifMatch: raw.etag });
    await appendAudit(repo, principal, 'PAYMENT_LINK_REVOKED', record, {
      reason: cleanString(body.reason, 500),
      changes: {}
    }, context);
    return { status: 200, jsonBody: { reference, revoked: true, etag: saved.etag } };
  } catch (cause) {
    if (cause?.status === 409) {
      return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
        code: 'STALE'
      });
    }
    throw cause;
  }
}

async function changeInvoiceRequestStatus(repo, principal, reference, requestId, body = {}, options = {}, context = {}) {
  if (!principal?.roles?.includes('Owner')) {
    return error(403, 'Endast Owner kan hantera fakturabegäranden.');
  }
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const expectedEtag = body.expectedEtag ?? options.expectedEtag;
  if (expectedEtag && raw.etag && expectedEtag !== raw.etag) {
    return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
      code: 'STALE'
    });
  }
  const nextStatus = cleanString(body.status, 30).toUpperCase();
  const reason = cleanString(body.reason, 500);
  if (nextStatus === 'CANCELLED' && !reason) {
    return error(400, 'Ange en orsak till att fakturabegäran makuleras.', {
      fields: { reason: 'Orsak krävs.' }
    });
  }
  const now = options.now ?? new Date();
  const actor = actorOf(principal);
  const record = { ...raw.record };
  const before = normalizeInvoiceRequests(raw.record).find((request) => request.id === requestId);
  const updated = updateInvoiceRequestStatus(record, requestId, nextStatus, {
    now,
    actorName: actor.name,
    reason
  });
  if (!updated.ok) {
    const status = updated.code === 'INVOICE_REQUEST_NOT_FOUND' ? 404 : 422;
    return error(status, 'Fakturabegäran kunde inte uppdateras.', {
      code: updated.code,
      from: updated.from,
      to: updated.to
    });
  }
  if (!updated.changed) {
    return { status: 200, jsonBody: { reference, request: updated.request, etag: raw.etag } };
  }
  record.version = Number(raw.record.version || 1) + 1;
  record.updatedAt = now.toISOString();
  record.updatedBy = actor.name;
  try {
    const saved = await repo.updateRequest(record, { ifMatch: raw.etag });
    await appendAudit(repo, principal, 'INVOICE_REQUEST_STATUS_CHANGED', record, {
      reason,
      changes: {
        invoiceRequestId: requestId,
        fromStatus: before?.status ?? '',
        toStatus: nextStatus
      }
    }, context);
    return {
      status: 200,
      jsonBody: { reference, request: updated.request, etag: saved.etag }
    };
  } catch (cause) {
    if (cause?.status === 409) {
      return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', {
        code: 'STALE'
      });
    }
    throw cause;
  }
}

module.exports = {
  createPaymentLink,
  revokePaymentLink,
  changeInvoiceRequestStatus,
  publicBaseUrl,
  paymentPageUrl,
  buildPaymentLinkEmail,
  REFERENCE_PATTERN
};
