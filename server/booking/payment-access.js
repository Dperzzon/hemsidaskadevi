'use strict';

const crypto = require('node:crypto');
const {
  computePaymentSummary,
  normalizePaymentRequests,
  latestPaymentRequest
} = require('./payment-ledger');

const PAYMENT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function createPaymentToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashPaymentToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function createPaymentAccess(options = {}) {
  const now = options.now ?? new Date();
  const ttlMs = Number(options.ttlMs ?? process.env.PAYMENT_LINK_TTL_MS ?? PAYMENT_LINK_TTL_MS);
  const token = createPaymentToken();
  const tokenHash = hashPaymentToken(token);
  const expiresAt = new Date(now.getTime() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : PAYMENT_LINK_TTL_MS))
    .toISOString();
  return {
    token,
    tokenHash,
    access: {
      tokenHash,
      createdAt: now.toISOString(),
      expiresAt,
      createdBy: String(options.createdBy ?? ''),
      createdById: String(options.createdById ?? ''),
      revokedAt: '',
      revokedReason: ''
    }
  };
}

function paymentAccessState(record = {}, now = new Date()) {
  const access = record.paymentAccess;
  if (!access) {
    return { ok: false, code: 'PAYMENT_LINK_MISSING', message: 'Betalningslänken finns inte.' };
  }
  if (access.revokedAt) {
    return { ok: false, code: 'PAYMENT_LINK_REVOKED', message: 'Betalningslänken har återkallats.' };
  }
  if (!access.tokenHash) {
    return { ok: false, code: 'PAYMENT_LINK_MISSING', message: 'Betalningslänken finns inte.' };
  }
  if (access.expiresAt && Date.parse(access.expiresAt) <= now.getTime()) {
    return { ok: false, code: 'PAYMENT_LINK_EXPIRED', message: 'Betalningslänken har gått ut.' };
  }
  return { ok: true, access };
}

function verifyPaymentToken(record = {}, token, now = new Date()) {
  if (!record || typeof token !== 'string' || !PAYMENT_TOKEN_PATTERN.test(token)) {
    return { ok: false, code: 'PAYMENT_LINK_INVALID', message: 'Betalningslänken är ogiltig.' };
  }
  const state = paymentAccessState(record, now);
  if (!state.ok) return state;
  if (!safeEqualHex(hashPaymentToken(token), state.access.tokenHash)) {
    return { ok: false, code: 'PAYMENT_LINK_INVALID', message: 'Betalningslänken är ogiltig.' };
  }
  return { ok: true, access: state.access };
}

function nightKeys(arrival, departure) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(arrival ?? '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(departure ?? ''))) {
    return [];
  }
  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
  const nights = [];
  for (let current = start, guard = 0; current < end && guard < 100; guard += 1) {
    nights.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 86400000);
  }
  return nights;
}

function verifyCalendarLock(record = {}, calendarRows, calendarRange) {
  const expected = nightKeys(record.arrival, record.departure);
  if (!expected.length) {
    return { ok: false, code: 'CALENDAR_LOCK_INVALID', message: 'Bokningens datum är ogiltiga.' };
  }
  if (!Array.isArray(calendarRows)) {
    return { ok: false, code: 'CALENDAR_UNAVAILABLE', message: 'Kalendern kunde inte kontrolleras.' };
  }
  const owned = new Set(
    calendarRows
      .filter((row) => row && row.reference === record.reference)
      .filter((row) => !row.type || row.type === 'BOOKING')
      .map((row) => row.night ?? row.RowKey ?? '')
      .filter(Boolean)
  );
  const missing = expected.filter((night) => !owned.has(night));
  if (missing.length) {
    return {
      ok: false,
      code: 'CALENDAR_LOCK_MISSING',
      message: 'Bokningen saknar giltig intern kalenderlåsning.',
      missing
    };
  }
  if (calendarRange === null) {
    return { ok: false, code: 'CALENDAR_UNAVAILABLE', message: 'Kalendern kunde inte kontrolleras.' };
  }
  if (Array.isArray(calendarRange)) {
    const expectedSet = new Set(expected);
    const conflicts = calendarRange
      .filter((row) => expectedSet.has(row?.night ?? row?.RowKey ?? ''))
      .filter((row) => row?.reference && row.reference !== record.reference)
      .map((row) => row.night ?? row.RowKey);
    if (conflicts.length) {
      return {
        ok: false,
        code: 'CALENDAR_CONFLICT',
        message: 'Bokningen har en ny kalenderkonflikt.',
        conflicts
      };
    }
  }
  return { ok: true, nights: expected };
}

function paymentAvailability(record, options = {}) {
  if (!record) {
    return { ok: false, code: 'NOT_FOUND', message: 'Bokningen hittades inte.' };
  }
  if (record.statusCode !== 'CONFIRMED') {
    return {
      ok: false,
      code: 'NOT_CONFIRMED',
      message: 'Bokningen är inte bekräftad. Kontakta Skadevi Herrgård.'
    };
  }
  const access = paymentAccessState(record, options.now ?? new Date());
  if (!access.ok) return access;
  const lock = verifyCalendarLock(record, options.calendarRows, options.calendarRange);
  if (!lock.ok) return lock;
  const summary = computePaymentSummary(record);
  if (summary.remainingOre <= 0) {
    return { ok: false, code: 'PAID', message: 'Bokningen är redan betald.' };
  }
  return { ok: true, access: access.access, summary, nights: lock.nights };
}

function revokePaymentAccess(record = {}, options = {}) {
  const now = options.now ?? new Date();
  if (record.paymentAccess) {
    record.paymentAccess = {
      ...record.paymentAccess,
      tokenHash: '',
      revokedAt: now.toISOString(),
      revokedReason: String(options.reason ?? '')
    };
  }
  record.paymentTokenHash = '';
  const requests = normalizePaymentRequests(record).map((request) => request.status === 'OPEN'
    ? {
      ...request,
      status: 'SUPERSEDED',
      statusLabel: 'Ersatt',
      updatedAt: now.toISOString()
    }
    : request);
  record.paymentRequests = requests;
  record.paymentRequest = latestPaymentRequest(requests);
  return record;
}

module.exports = {
  PAYMENT_LINK_TTL_MS,
  PAYMENT_TOKEN_PATTERN,
  createPaymentToken,
  hashPaymentToken,
  createPaymentAccess,
  paymentAccessState,
  verifyPaymentToken,
  nightKeys,
  verifyCalendarLock,
  paymentAvailability,
  revokePaymentAccess
};
