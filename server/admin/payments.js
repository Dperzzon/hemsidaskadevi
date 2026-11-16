'use strict';

// Betalningsliggare för bokningsportalen. Alla belopp räknas i heltal ören.
// Modulen är ren och sidoeffektfri: den normaliserar sparade betalningsposter,
// beräknar saldo och härleder betalstatus. Den ändrar aldrig bokningens
// avtalade totalpris, status eller kalender.

const PAYMENT_METHODS = Object.freeze({
  BANK_TRANSFER: 'Banköverföring',
  SWISH: 'Swish',
  CARD: 'Kort',
  CASH: 'Kontant',
  OTHER: 'Annat',
  CORRECTION: 'Rättelse'
});

const PAYMENT_METHOD_CODES = Object.freeze(
  Object.keys(PAYMENT_METHODS).filter((code) => code !== 'CORRECTION')
);

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

// Tolkar kronor från formuläret exakt (högst två decimaler) och returnerar
// heltal ören. Flyttal används aldrig för själva beloppsuträkningen.
function parseKronorToOre(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value * 100);
    return Math.abs(rounded - value * 100) < 1e-6 ? rounded : rounded;
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
    correctsPaymentId: String(row.correctsPaymentId ?? '')
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

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
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
  sortPayments
};
