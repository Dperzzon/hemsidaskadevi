'use strict';

const crypto = require('node:crypto');

const INVOICE_REQUEST_STATUSES = Object.freeze({
  REQUESTED: 'Begärd',
  IN_PROGRESS: 'Under behandling',
  SENT: 'Skickad',
  CANCELLED: 'Makulerad'
});

const INVOICE_REQUEST_TRANSITIONS = Object.freeze({
  REQUESTED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['SENT', 'CANCELLED'],
  SENT: ['CANCELLED'],
  CANCELLED: []
});

const ACTIVE_INVOICE_STATUSES = new Set(['REQUESTED', 'IN_PROGRESS', 'SENT']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ORG_NUMBER_PATTERN = /^(?:\d{6}-?\d{4}|\d{12})$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value, limit) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, limit);
}

function normalizeInvoiceRequest(row = {}) {
  const status = String(row.status ?? 'REQUESTED').toUpperCase();
  const amountOre = Number.isSafeInteger(Number(row.amountOre)) ? Number(row.amountOre) : 0;
  return {
    id: String(row.id ?? ''),
    status: INVOICE_REQUEST_STATUSES[status] ? status : 'REQUESTED',
    statusLabel: INVOICE_REQUEST_STATUSES[status] ?? INVOICE_REQUEST_STATUSES.REQUESTED,
    amountOre,
    amount: amountOre / 100,
    invoiceName: String(row.invoiceName ?? ''),
    invoiceOrgNumber: String(row.invoiceOrgNumber ?? ''),
    invoiceAddress: String(row.invoiceAddress ?? ''),
    invoicePostalCode: String(row.invoicePostalCode ?? ''),
    invoiceCity: String(row.invoiceCity ?? ''),
    invoiceEmail: String(row.invoiceEmail ?? ''),
    invoiceReference: String(row.invoiceReference ?? ''),
    invoiceNotes: String(row.invoiceNotes ?? ''),
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
    createdBy: String(row.createdBy ?? ''),
    createdById: String(row.createdById ?? ''),
    statusChangedAt: String(row.statusChangedAt ?? ''),
    statusChangedBy: String(row.statusChangedBy ?? ''),
    reason: String(row.reason ?? ''),
    idempotencyKey: String(row.idempotencyKey ?? '')
  };
}

function normalizeInvoiceRequests(record = {}) {
  let rows = record.invoiceRequests;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map(normalizeInvoiceRequest)
    .filter((row) => row.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function activeInvoiceRequest(record = {}) {
  return normalizeInvoiceRequests(record).find((request) => ACTIVE_INVOICE_STATUSES.has(request.status)) ?? null;
}

function validateInvoiceInput(input = {}) {
  const values = {
    invoiceName: clean(input.invoiceName, 120),
    invoiceOrgNumber: clean(input.invoiceOrgNumber, 20).replace(/\s/g, ''),
    invoiceAddress: clean(input.invoiceAddress, 200),
    invoicePostalCode: clean(input.invoicePostalCode, 10),
    invoiceCity: clean(input.invoiceCity, 80),
    invoiceEmail: clean(input.invoiceEmail, 320),
    invoiceReference: clean(input.invoiceReference, 120),
    invoiceNotes: clean(input.invoiceNotes, 500)
  };
  const errors = {};
  if (values.invoiceName.length < 2) errors.invoiceName = 'Ange fakturabetalarens namn.';
  if (values.invoiceOrgNumber && !ORG_NUMBER_PATTERN.test(values.invoiceOrgNumber)) {
    errors.invoiceOrgNumber = 'Ange ett giltigt organisationsnummer.';
  }
  if (values.invoiceAddress.length < 3) errors.invoiceAddress = 'Ange fakturaadress.';
  if (!/^\d{3}\s?\d{2}$/.test(values.invoicePostalCode)) {
    errors.invoicePostalCode = 'Ange postnummer som 123 45.';
  } else {
    values.invoicePostalCode = values.invoicePostalCode.replace(/\s/g, '').replace(/^(\d{3})(\d{2})$/, '$1 $2');
  }
  if (values.invoiceCity.length < 2) errors.invoiceCity = 'Ange ort.';
  if (!EMAIL_PATTERN.test(values.invoiceEmail)) errors.invoiceEmail = 'Ange en giltig e-postadress.';
  return { ok: Object.keys(errors).length === 0, values, errors };
}

function createInvoiceRequest(record = {}, input = {}, options = {}) {
  const now = options.now ?? new Date();
  const validated = validateInvoiceInput(input);
  if (!validated.ok) return { ok: false, code: 'INVOICE_VALIDATION_FAILED', errors: validated.errors };
  const requests = normalizeInvoiceRequests(record);
  const requestId = REQUEST_ID_PATTERN.test(String(input.requestId ?? ''))
    ? String(input.requestId)
    : crypto.randomUUID();
  const duplicate = requests.find((request) => request.idempotencyKey === requestId);
  if (duplicate) {
    return { ok: true, duplicate: true, record, request: duplicate };
  }
  const active = activeInvoiceRequest(record);
  if (active) {
    return { ok: false, code: 'INVOICE_REQUEST_EXISTS', existing: active };
  }
  const amountOre = Number(options.amountOre);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    return { ok: false, code: 'INVOICE_AMOUNT_INVALID' };
  }
  const request = normalizeInvoiceRequest({
    id: `inv-${crypto.randomUUID()}`,
    status: 'REQUESTED',
    amountOre,
    ...validated.values,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    createdBy: 'Gäst',
    createdById: 'guest',
    idempotencyKey: requestId
  });
  record.invoiceRequests = [...requests, request];
  return { ok: true, duplicate: false, record, request };
}

function updateInvoiceRequestStatus(record = {}, requestId, nextStatus, options = {}) {
  const status = String(nextStatus ?? '').toUpperCase();
  if (!INVOICE_REQUEST_STATUSES[status]) {
    return { ok: false, code: 'INVOICE_STATUS_INVALID' };
  }
  const requests = normalizeInvoiceRequests(record);
  const target = requests.find((request) => request.id === requestId);
  if (!target) return { ok: false, code: 'INVOICE_REQUEST_NOT_FOUND' };
  if (target.status === status) {
    return { ok: true, changed: false, record, request: target };
  }
  const allowed = INVOICE_REQUEST_TRANSITIONS[target.status] ?? [];
  if (!allowed.includes(status)) {
    return { ok: false, code: 'INVOICE_STATUS_TRANSITION_INVALID', from: target.status, to: status };
  }
  const now = options.now ?? new Date();
  const updated = {
    ...target,
    status,
    statusLabel: INVOICE_REQUEST_STATUSES[status],
    updatedAt: now.toISOString(),
    statusChangedAt: now.toISOString(),
    statusChangedBy: String(options.actorName ?? ''),
    reason: String(options.reason ?? '')
  };
  record.invoiceRequests = requests.map((request) => request.id === requestId ? updated : request);
  return { ok: true, changed: true, record, request: updated };
}

function cancelOpenInvoiceRequests(record = {}, options = {}) {
  const now = options.now ?? new Date();
  let changed = false;
  const requests = normalizeInvoiceRequests(record).map((request) => {
    if (!ACTIVE_INVOICE_STATUSES.has(request.status)) return request;
    changed = true;
    return {
      ...request,
      status: 'CANCELLED',
      statusLabel: INVOICE_REQUEST_STATUSES.CANCELLED,
      updatedAt: now.toISOString(),
      statusChangedAt: now.toISOString(),
      statusChangedBy: String(options.actorName ?? ''),
      reason: String(options.reason ?? '')
    };
  });
  if (changed) record.invoiceRequests = requests;
  return { changed, record };
}

module.exports = {
  INVOICE_REQUEST_STATUSES,
  INVOICE_REQUEST_TRANSITIONS,
  ACTIVE_INVOICE_STATUSES,
  normalizeInvoiceRequest,
  normalizeInvoiceRequests,
  activeInvoiceRequest,
  validateInvoiceInput,
  createInvoiceRequest,
  updateInvoiceRequestStatus,
  cancelOpenInvoiceRequests
};
