'use strict';

const PAYMENT_METHODS = Object.freeze({
  BANK_TRANSFER: 'Banköverföring',
  SWISH: 'Swish',
  CARD: 'Kort',
  CASH: 'Kontant',
  OTHER: 'Annat',
  CORRECTION: 'Rättelse'
});

const PAYMENT_METHOD_CODES = Object.freeze(
  Object.keys(PAYMENT_METHODS).filter((code) => code !== 'CORRECTION' && code !== 'CARD')
);

const PAYMENT_REQUEST_STATUSES = Object.freeze({
  OPEN: 'Väntar på betalning',
  PAID: 'Betald',
  EXPIRED: 'Utgången',
  SUPERSEDED: 'Ersatt',
  FAILED: 'Misslyckad',
  CANCELED: 'Avbruten'
});

function paymentMethodLabel(code) {
  return PAYMENT_METHODS[String(code ?? '').toUpperCase()] ?? 'Annat';
}

function parseOre(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function parseKronorToOre(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const ore = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return Number.isSafeInteger(ore) ? ore : null;
}

function centsToKronor(ore) {
  return Number(ore || 0) / 100;
}

function formatOre(ore) {
  const value = Number(ore || 0) / 100;
  const hasCents = Number(ore || 0) % 100 !== 0;
  return `${new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0
  }).format(value)} kr`;
}

function normalizePaymentRow(row = {}) {
  const type = String(row.type ?? '').toUpperCase() === 'CORRECTION' ? 'CORRECTION' : 'PAYMENT';
  const amountOre = parseOre(row.amountOre) ??
    (row.amount !== undefined ? parseKronorToOre(row.amount) : null) ?? 0;
  const method = String(row.method ?? row.paymentMethod ?? '').toUpperCase();
  return {
    id: String(row.id ?? row.paymentId ?? ''),
    type,
    amountOre,
    paymentDate: String(row.paymentDate ?? row.date ?? ''),
    method: type === 'CORRECTION' ? 'CORRECTION' : method,
    methodLabel: type === 'CORRECTION'
      ? PAYMENT_METHODS.CORRECTION
      : paymentMethodLabel(method),
    reference: String(row.reference ?? row.referenceText ?? ''),
    note: String(row.note ?? ''),
    reason: String(row.reason ?? ''),
    createdBy: String(row.createdBy ?? ''),
    createdById: String(row.createdById ?? ''),
    createdAt: String(row.createdAt ?? ''),
    idempotencyKey: String(row.idempotencyKey ?? ''),
    correctsPaymentId: String(row.correctsPaymentId ?? ''),
    provider: String(row.provider ?? ''),
    stripeSessionId: String(row.stripeSessionId ?? ''),
    stripeEventId: String(row.stripeEventId ?? ''),
    stripePaymentIntentId: String(row.stripePaymentIntentId ?? '')
  };
}

function normalizePayments(record = {}) {
  let rows = record.payments;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map(normalizePaymentRow)
    .filter((row) => row.id);
}

function openingBalanceOreFor(record = {}, payments = normalizePayments(record)) {
  const stored = parseOre(record.paymentOpeningBalanceOre);
  if (stored !== null && stored >= 0) return stored;
  if (payments.length > 0) return 0;
  const legacy = Number(record.amountPaid ?? 0);
  return Number.isFinite(legacy) && legacy > 0 ? Math.round(legacy * 100) : 0;
}

function derivePaymentStatus(totalOre, paidOre) {
  if (paidOre <= 0) return 'UNPAID';
  if (totalOre > 0 && paidOre < totalOre) return 'PARTIALLY_PAID';
  return 'PAID';
}

function computePaymentSummary(record = {}) {
  const payments = normalizePayments(record);
  const openingBalanceOre = openingBalanceOreFor(record, payments);
  const totalOre = Math.round(Number(record.total ?? 0) * 100);
  const paidOre = openingBalanceOre +
    payments.reduce((sum, payment) => sum + payment.amountOre, 0);
  const remainingOre = totalOre - paidOre;
  const overpaidOre = remainingOre < 0 ? -remainingOre : 0;
  const paymentStatus = derivePaymentStatus(totalOre, paidOre);
  const overpaid = overpaidOre > 0;
  const paymentLabel = overpaid
    ? 'Betald (överbetalning)'
    : paymentStatus === 'PAID'
      ? 'Betald'
      : paymentStatus === 'PARTIALLY_PAID'
        ? 'Delbetalt'
        : 'Ej betald';
  return {
    payments,
    openingBalanceOre,
    totalOre,
    paidOre,
    remainingOre,
    overpaidOre,
    overpaid,
    paymentStatus,
    paymentLabel,
    amountPaid: centsToKronor(paidOre),
    balance: centsToKronor(remainingOre)
  };
}

function sortPayments(payments = []) {
  return [...payments].sort((a, b) =>
    a.paymentDate.localeCompare(b.paymentDate) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function normalizePaymentRequest(row = {}) {
  const status = String(row.status ?? 'OPEN').toUpperCase();
  const amountOre = parseOre(row.amountOre) ?? 0;
  return {
    provider: String(row.provider ?? 'stripe'),
    mode: String(row.mode ?? ''),
    paymentMethod: String(row.paymentMethod ?? '').toLowerCase(),
    status: PAYMENT_REQUEST_STATUSES[status] ? status : 'OPEN',
    statusLabel: PAYMENT_REQUEST_STATUSES[status] ?? PAYMENT_REQUEST_STATUSES.OPEN,
    sessionId: String(row.sessionId ?? ''),
    paymentIntentId: String(row.paymentIntentId ?? ''),
    url: String(row.url ?? ''),
    amountOre,
    amount: centsToKronor(amountOre),
    currency: String(row.currency ?? 'sek').toLowerCase(),
    createdAt: String(row.createdAt ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    paidAt: String(row.paidAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
    createdBy: String(row.createdBy ?? ''),
    createdById: String(row.createdById ?? ''),
    idempotencyKey: String(row.idempotencyKey ?? ''),
    lastEventId: String(row.lastEventId ?? ''),
    reviewRequired: String(row.reviewRequired ?? '')
  };
}

function normalizePaymentRequests(record = {}) {
  let rows = record.paymentRequests;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = []; }
  }
  if (!Array.isArray(rows)) rows = [];
  if (record.paymentRequest && typeof record.paymentRequest === 'object') {
    rows = [...rows, record.paymentRequest];
  }
  const byKey = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const normalized = normalizePaymentRequest(row);
    if (!normalized.sessionId && !normalized.idempotencyKey) continue;
    byKey.set(normalized.sessionId || normalized.idempotencyKey, normalized);
  }
  return [...byKey.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId)
  );
}

function latestPaymentRequest(requests = []) {
  if (!requests.length) return null;
  return [...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function stockholmDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function stripePaymentEntry(session, now = new Date(), options = {}) {
  const sessionId = String(session.id ?? '');
  if (!sessionId) throw new Error('Stripe-session saknar id');
  const amountOre = Number(session.amount_total);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new Error('Stripe-session saknar giltigt belopp');
  }
  const method = String(options.method ?? 'SWISH').toUpperCase() === 'SWISH' ? 'SWISH' : 'OTHER';
  const methodText = method === 'SWISH' ? 'Swish' : 'annan betalmetod';
  return {
    id: `pay-stripe-${sessionId}`,
    type: 'PAYMENT',
    amountOre,
    paymentDate: stockholmDateKey(now),
    method,
    methodLabel: method === 'SWISH' ? PAYMENT_METHODS.SWISH : PAYMENT_METHODS.OTHER,
    reference: `Stripe Checkout ${method === 'SWISH' ? 'Swish ' : ''}${sessionId}`,
    note: options.note ?? `Betald via ${methodText} (Stripe Checkout).`,
    reason: '',
    createdBy: 'Stripe',
    createdById: 'stripe',
    createdAt: now.toISOString(),
    idempotencyKey: `stripe-${sessionId}`,
    correctsPaymentId: '',
    provider: 'stripe',
    stripeSessionId: sessionId,
    stripeEventId: String(options.eventId ?? ''),
    stripePaymentIntentId: String(session.payment_intent ?? '')
  };
}

function applyStripePayment(record = {}, session = {}, options = {}) {
  if (!session || typeof session !== 'object') {
    return { ok: false, reason: 'invalid_session' };
  }
  if (session.payment_status !== 'paid') {
    return { ok: false, reason: 'not_paid' };
  }
  if (session.mode && session.mode !== 'payment') {
    return { ok: false, reason: 'wrong_mode' };
  }
  const currency = String(session.currency ?? '').toLowerCase();
  if (currency !== 'sek') {
    return { ok: false, reason: 'currency_mismatch' };
  }
  const amountOre = Number(session.amount_total);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    return { ok: false, reason: 'amount_invalid' };
  }
  const sessionId = String(session.id ?? '');
  if (!sessionId) return { ok: false, reason: 'invalid_session' };

  const metadataReference = session.metadata?.reference ?? session.client_reference_id ?? '';
  if (metadataReference && metadataReference !== record.reference) {
    return { ok: false, reason: 'reference_mismatch' };
  }

  const requests = normalizePaymentRequests(record);
  const target = requests.find((request) => request.sessionId === sessionId);
  if (!target) return { ok: false, reason: 'unknown_session' };
  if (target.mode && typeof session.livemode === 'boolean') {
    const sessionMode = session.livemode ? 'live' : 'test';
    if (target.mode !== sessionMode) {
      return { ok: false, reason: 'mode_mismatch', request: target };
    }
  }
  const paymentTypes = Array.isArray(session.payment_method_types)
    ? session.payment_method_types.map((type) => String(type).toLowerCase())
    : [];
  const method = paymentTypes.length === 1 && paymentTypes[0] === 'swish' ? 'SWISH' : 'OTHER';

  const payments = normalizePayments(record);
  const duplicate = payments.find((payment) =>
    payment.stripeSessionId === sessionId ||
    payment.idempotencyKey === `stripe-${sessionId}`
  );
  if (duplicate) {
    return {
      ok: true,
      duplicate: true,
      record,
      payment: duplicate,
      summary: computePaymentSummary(record),
      reviewRequired: target.reviewRequired ?? ''
    };
  }

  const now = options.now ?? new Date();
  const payment = stripePaymentEntry(session, now, {
    eventId: options.eventId,
    note: options.note,
    method
  });
  const warnings = [];
  if (record.statusCode !== 'CONFIRMED') {
    warnings.push(
      `Bokningen hade status ${record.statusCode ?? 'okänd'} när betalningen togs emot. Kontrollera betalningen och återbetala vid behov.`
    );
  }
  if (method !== 'SWISH') {
    warnings.push('Betalningen använde en annan betalmetod än Swish. Kontrollera och återbetala vid behov.');
  }
  if (target.paymentMethod && target.paymentMethod !== 'swish') {
    warnings.push('Betalningssessionen var inte skapad för Swish. Kontrollera betalningen.');
  }
  if (target.amountOre !== amountOre) {
    warnings.push(
      `Betalat belopp ${formatOre(amountOre)} avviker från betalningsbegäran ${formatOre(target.amountOre)}. Stäm av och återbetala vid behov.`
    );
  }
  if (target.status === 'SUPERSEDED') {
    warnings.push('Betalningen avser en ersatt betalningsbegäran. Stäm av mot aktuellt saldo.');
  }
  const reviewRequired = [...new Set(warnings)].join(' ');

  record.paymentOpeningBalanceOre = openingBalanceOreFor(record, payments);
  record.payments = [...payments, payment];
  const summary = computePaymentSummary(record);
  record.paymentRequests = requests.map((request) => request.sessionId === sessionId
    ? {
      ...request,
      status: 'PAID',
      statusLabel: PAYMENT_REQUEST_STATUSES.PAID,
      paidAt: now.toISOString(),
      updatedAt: now.toISOString(),
      paymentIntentId: String(session.payment_intent ?? ''),
      lastEventId: String(options.eventId ?? ''),
      reviewRequired
    }
    : (summary.remainingOre <= 0 && request.status === 'OPEN'
      ? {
        ...request,
        status: 'SUPERSEDED',
        statusLabel: 'Ersatt',
        updatedAt: now.toISOString()
      }
      : request));
  record.paymentRequest = latestPaymentRequest(record.paymentRequests);
  record.amountPaid = summary.amountPaid;
  record.balance = summary.balance;
  record.paymentStatus = summary.paymentStatus;
  return {
    ok: true,
    duplicate: false,
    record,
    payment,
    summary,
    reviewRequired
  };
}

function markPaymentRequestStatus(record = {}, sessionId, status, options = {}) {
  const requests = normalizePaymentRequests(record);
  const target = requests.find((request) => request.sessionId === sessionId);
  if (!target) return { ok: false, reason: 'unknown_session', record };
  if (target.status === 'PAID') return { ok: true, changed: false, record };
  const next = String(status).toUpperCase();
  if (!PAYMENT_REQUEST_STATUSES[next]) return { ok: false, reason: 'invalid_status', record };
  const now = options.now ?? new Date();
  record.paymentRequests = requests.map((request) => request.sessionId === sessionId
    ? {
      ...request,
      status: next,
      statusLabel: PAYMENT_REQUEST_STATUSES[next],
      updatedAt: now.toISOString(),
      lastEventId: String(options.eventId ?? '')
    }
    : request);
  record.paymentRequest = latestPaymentRequest(record.paymentRequests);
  return { ok: true, changed: true, record };
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
  PAYMENT_REQUEST_STATUSES,
  paymentMethodLabel,
  parseOre,
  parseKronorToOre,
  centsToKronor,
  formatOre,
  normalizePaymentRow,
  normalizePayments,
  openingBalanceOreFor,
  derivePaymentStatus,
  computePaymentSummary,
  sortPayments,
  normalizePaymentRequest,
  normalizePaymentRequests,
  latestPaymentRequest,
  stripePaymentEntry,
  applyStripePayment,
  markPaymentRequestStatus
};
