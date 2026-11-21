'use strict';

const crypto = require('node:crypto');
const { computePaymentSummary } = require('./payment-ledger');
const { refundPercent } = require('./refund');

const REFUND_STATUSES = Object.freeze({
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

const REFUND_STATUS_LABELS = Object.freeze({
  PROCESSING: 'Pågår',
  COMPLETED: 'Genomförd',
  FAILED: 'Misslyckades'
});

const REFUND_OVERALL_LABELS = Object.freeze({
  NOT_DUE: 'Ingen återbetalning enligt policyn',
  READY: 'Behöver utföras',
  PROCESSING: 'Pågår',
  PARTIAL: 'Delvis genomförd',
  COMPLETED: 'Genomförd',
  FAILED: 'Misslyckades'
});

function safeInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function stockholmDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function normalizeRefunds(record = {}) {
  let rows = record.refunds;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: String(row.id ?? ''),
      amountOre: safeInt(row.amountOre),
      status: REFUND_STATUSES[String(row.status ?? '').toUpperCase()] ?? 'PROCESSING',
      stripeRefundId: String(row.stripeRefundId ?? ''),
      source: row.source === 'STRIPE' ? 'STRIPE' : 'MANUAL',
      reason: String(row.reason ?? ''),
      note: String(row.note ?? ''),
      createdBy: String(row.createdBy ?? ''),
      createdAt: String(row.createdAt ?? ''),
      completedAt: String(row.completedAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      idempotencyKey: String(row.idempotencyKey ?? '')
    }))
    .filter((row) => row.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function refundBasisOre(record = {}) {
  const total = safeInt(Math.round(Number(record.total ?? 0) * 100));
  const addons = safeInt(Math.round(Number(record.totalAddons ?? 0) * 100));
  const fromLodging = safeInt(Math.round(Number(record.lodgingAfterDiscount ?? NaN) * 100));
  if (fromLodging > 0) return fromLodging;
  return Math.max(0, total - addons);
}

function calculateRefund(record = {}, options = {}) {
  const now = options.now ?? new Date();
  const summary = computePaymentSummary(record);
  const paidOre = safeInt(summary.paidOre);
  const basisOre = refundBasisOre(record);
  const cancellationDate = record.cancelledAt
    ? stockholmDateKey(record.cancelledAt)
    : stockholmDateKey(now);
  const percent = refundPercent(record.arrival, cancellationDate);
  const policyOre = percent === null ? 0 : Math.round(basisOre * percent / 100);
  const calculatedOre = Math.min(paidOre, Math.max(0, policyOre));
  const refunds = normalizeRefunds(record);
  const completedOre = refunds
    .filter((row) => row.status === 'COMPLETED')
    .reduce((sum, row) => sum + row.amountOre, 0);
  const processingOre = refunds
    .filter((row) => row.status === 'PROCESSING')
    .reduce((sum, row) => sum + row.amountOre, 0);
  const failedOre = refunds
    .filter((row) => row.status === 'FAILED')
    .reduce((sum, row) => sum + row.amountOre, 0);
  const remainingOre = Math.max(0, calculatedOre - completedOre - processingOre);
  let status = 'READY';
  if (calculatedOre <= 0) status = 'NOT_DUE';
  else if (completedOre >= calculatedOre) status = 'COMPLETED';
  else if (processingOre > 0) status = 'PROCESSING';
  else if (completedOre > 0) status = 'PARTIAL';
  else if (failedOre > 0) status = 'FAILED';
  return {
    policyVersion: '2026-11-10-v3',
    basis: 'bekräftad boendesumma enligt offerten',
    basisOre,
    paidOre,
    percent,
    cancellationDate,
    calculatedOre,
    completedOre,
    processingOre,
    failedOre,
    remainingOre,
    status,
    statusLabel: REFUND_OVERALL_LABELS[status] ?? status,
    refunds
  };
}

function refundEntry(input = {}, actor = {}, now = new Date()) {
  const status = REFUND_STATUSES[String(input.status ?? '').toUpperCase()];
  const amountOre = safeInt(input.amountOre);
  return {
    id: `refund-${crypto.randomUUID()}`,
    amountOre,
    status,
    stripeRefundId: String(input.stripeRefundId ?? '').trim(),
    source: 'MANUAL',
    reason: String(input.reason ?? '').trim().slice(0, 500),
    note: String(input.note ?? '').trim().slice(0, 1000),
    createdBy: String(actor.name ?? actor.id ?? 'Okänd').slice(0, 120),
    createdAt: now.toISOString(),
    completedAt: status === 'COMPLETED' ? now.toISOString() : '',
    updatedAt: now.toISOString(),
    idempotencyKey: String(input.idempotencyKey ?? '').slice(0, 200)
  };
}

function validateManualRefund(record, input = {}, options = {}) {
  const status = REFUND_STATUSES[String(input.status ?? '').toUpperCase()];
  if (!status) return { ok: false, code: 'REFUND_STATUS_INVALID', message: 'Ogiltig återbetalningsstatus.' };
  const amountOre = safeInt(input.amountOre);
  if (amountOre <= 0) return { ok: false, code: 'REFUND_AMOUNT_INVALID', message: 'Återbetalningsbeloppet måste vara större än noll.' };
  if (status === 'COMPLETED' && !String(input.stripeRefundId ?? '').trim()) {
    return { ok: false, code: 'REFUND_ID_REQUIRED', message: 'Ange Stripes Refund-ID för en genomförd återbetalning.' };
  }
  const summary = calculateRefund(record, options);
  if (amountOre > summary.paidOre) {
    return { ok: false, code: 'REFUND_EXCEEDS_PAID', message: 'Återbetalningen kan inte överstiga registrerat betalt belopp.' };
  }
  if (status !== 'FAILED' && amountOre > summary.remainingOre) {
    return {
      ok: false,
      code: 'REFUND_EXCEEDS_REMAINING',
      message: `Återbetalningen överstiger återstående återbetalningsbelopp (${summary.remainingOre} öre).`
    };
  }
  return { ok: true, status, amountOre, summary };
}

function applyManualRefund(record = {}, input = {}, options = {}) {
  const idempotencyKey = String(input.idempotencyKey ?? '').slice(0, 200);
  const refunds = normalizeRefunds(record);
  if (idempotencyKey) {
    const existing = refunds.find((row) => row.idempotencyKey === idempotencyKey);
    if (existing) return { ok: true, duplicate: true, refunds, entry: existing };
  }
  const validation = validateManualRefund(record, input, options);
  if (!validation.ok) return { ok: false, ...validation, refunds };
  const entry = refundEntry({ ...input, status: validation.status, amountOre: validation.amountOre }, options.actor, options.now);
  return {
    ok: true,
    duplicate: false,
    entry,
    refunds: [...refunds, entry].slice(-50)
  };
}

function stripeRefundStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'succeeded') return 'COMPLETED';
  if (value === 'failed' || value === 'canceled') return 'FAILED';
  return 'PROCESSING';
}

function mergeStripeRefunds(record = {}, stripeRefunds = [], now = new Date()) {
  const byId = new Map(normalizeRefunds(record).map((row) => [row.id, row]));
  const byStripeId = new Map(
    [...byId.values()]
      .filter((row) => row.stripeRefundId)
      .map((row) => [row.stripeRefundId, row])
  );
  for (const refund of Array.isArray(stripeRefunds) ? stripeRefunds : []) {
    const stripeRefundId = String(refund?.id ?? '');
    if (!stripeRefundId) continue;
    const status = stripeRefundStatus(refund.status);
    const existing = byStripeId.get(stripeRefundId);
    if (existing) {
      const updated = {
        ...existing,
        amountOre: safeInt(refund.amount),
        status,
        source: 'STRIPE',
        updatedAt: now.toISOString(),
        completedAt: status === 'COMPLETED'
          ? (existing.completedAt || now.toISOString())
          : existing.completedAt
      };
      byId.set(existing.id, updated);
      byStripeId.set(stripeRefundId, updated);
      continue;
    }
    const entry = {
      id: `refund-stripe-${stripeRefundId}`,
      amountOre: safeInt(refund.amount),
      status,
      stripeRefundId,
      source: 'STRIPE',
      reason: String(refund.reason ?? ''),
      note: 'Hämtad från Stripe',
      createdBy: 'Stripe',
      createdAt: new Date(Number(refund.created ?? 0) * 1000 || now.getTime()).toISOString(),
      completedAt: status === 'COMPLETED'
        ? new Date(Number(refund.created ?? 0) * 1000 || now.getTime()).toISOString()
        : '',
      updatedAt: now.toISOString(),
      idempotencyKey: `stripe-${stripeRefundId}`
    };
    byId.set(entry.id, entry);
    byStripeId.set(stripeRefundId, entry);
  }
  return [...byId.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-50);
}

module.exports = {
  REFUND_STATUSES,
  REFUND_STATUS_LABELS,
  REFUND_OVERALL_LABELS,
  normalizeRefunds,
  calculateRefund,
  refundBasisOre,
  applyManualRefund,
  validateManualRefund,
  mergeStripeRefunds,
  stripeRefundStatus
};
