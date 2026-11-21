'use strict';

const crypto = require('node:crypto');
const {
  calculateRefund,
  applyManualRefund,
  normalizeRefunds
} = require('../booking/refunds');

const REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,80}$/;

function error(status, message, extra = {}) {
  return { status, jsonBody: { error: message, ...extra } };
}

function clean(value, limit = 500) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, limit);
}

function actorOf(principal = {}) {
  return {
    id: clean(principal.id ?? principal.email ?? '', 120) || 'unknown',
    name: clean(principal.name ?? principal.email ?? '', 120) || 'Okänd'
  };
}

async function audit(repo, principal, reference, action, details, context = {}) {
  if (typeof repo.appendHistory !== 'function') return;
  const actor = actorOf(principal);
  const now = new Date();
  try {
    await repo.appendHistory({
      idempotencyKey: `${reference}_${action}_${now.toISOString()}_${crypto.randomBytes(4).toString('hex')}`,
      reference,
      action,
      fromStatus: details.fromStatus ?? '',
      toStatus: details.toStatus ?? '',
      changes: JSON.stringify(details.changes ?? {}),
      reason: details.reason ?? '',
      actorId: actor.id,
      actorName: actor.name,
      correlationId: crypto.randomUUID(),
      at: now.toISOString()
    });
  } catch {
    context.warn?.(`Auditpost kunde inte sparas för ${reference}.`);
  }
}

function assertOwner(principal) {
  return principal?.roles?.includes('Owner');
}

async function requestReconciliation(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!assertOwner(principal)) return error(403, 'Endast Owner kan begära betalningsavstämning.');
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const record = raw.record;
  if (!['PENDING_PAYMENT', 'RECONCILIATION'].includes(record.statusCode)) {
    return error(422, 'Bokningen väntar inte på betalningsavstämning.', { code: 'RECONCILIATION_NOT_APPLICABLE' });
  }
  const now = options.now ?? new Date();
  const actor = actorOf(principal);
  const existing = record.reconciliationRequest;
  if (existing?.status === 'REQUESTED') {
    return {
      status: 202,
      jsonBody: {
        reference,
        requested: true,
        duplicate: true,
        requestedAt: existing.requestedAt ?? '',
        message: 'Avstämning är redan begärd och körs inom några minuter.'
      }
    };
  }
  const updated = {
    ...record,
    reconciliationRequest: {
      status: 'REQUESTED',
      requestedAt: now.toISOString(),
      requestedBy: actor.name,
      reason: clean(body.reason, 500)
    },
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actor.name
  };
  try {
    await repo.updateRequest(updated, { ifMatch: raw.etag });
  } catch (cause) {
    if (cause?.status === 409) return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', { code: 'STALE' });
    throw cause;
  }
  await audit(repo, principal, reference, 'PAYMENT_RECONCILIATION_REQUESTED', {
    fromStatus: record.statusCode,
    toStatus: record.statusCode,
    reason: clean(body.reason, 500),
    changes: { sessionId: record.paymentRequest?.sessionId ?? record.reservation?.sessionId ?? '' }
  }, context);
  return {
    status: 202,
    jsonBody: {
      reference,
      requested: true,
      requestedAt: now.toISOString(),
      message: 'Avstämning begärd. Systemet kontrollerar Stripe inom några minuter.'
    }
  };
}

async function requestRefundSync(repo, principal, reference, _body = {}, options = {}, context = {}) {
  if (!assertOwner(principal)) return error(403, 'Endast Owner kan begära återbetalningssynk.');
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const record = raw.record;
  const now = options.now ?? new Date();
  const actor = actorOf(principal);
  if (record.refundSyncRequested === true) {
    return {
      status: 202,
      jsonBody: { reference, requested: true, duplicate: true, message: 'Synk är redan begärd.' }
    };
  }
  const updated = {
    ...record,
    refundSyncRequested: true,
    refundSyncRequest: {
      requestedAt: now.toISOString(),
      requestedBy: actor.name
    },
    refundSyncError: '',
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actor.name
  };
  try {
    await repo.updateRequest(updated, { ifMatch: raw.etag });
  } catch (cause) {
    if (cause?.status === 409) return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', { code: 'STALE' });
    throw cause;
  }
  await audit(repo, principal, reference, 'REFUND_SYNC_REQUESTED', {
    fromStatus: record.statusCode,
    toStatus: record.statusCode,
    changes: {}
  }, context);
  return {
    status: 202,
    jsonBody: {
      reference,
      requested: true,
      message: 'Synk mot Stripe begärd. Återbetalningarna uppdateras inom några minuter.'
    }
  };
}

async function recordRefund(repo, principal, reference, body = {}, options = {}, context = {}) {
  if (!assertOwner(principal)) return error(403, 'Endast Owner kan registrera återbetalningar.');
  if (!REFERENCE_PATTERN.test(reference)) return error(404, 'Bokningen hittades inte.');
  if (body.confirm !== true) {
    return error(422, 'Bekräfta uttryckligen att återbetalningen är utförd eller påbörjad.', { code: 'REFUND_CONFIRMATION_REQUIRED' });
  }
  const raw = await repo.getRawBooking(reference);
  if (!raw) return error(404, 'Bokningen hittades inte.');
  const record = raw.record;
  if (record.statusCode === 'BLOCKED' || /^BLOCK-/.test(String(record.reference ?? ''))) {
    return error(422, 'Datumblockeringar har inga betalningar.', { code: 'REFUND_NOT_APPLICABLE' });
  }
  const now = options.now ?? new Date();
  const actor = actorOf(principal);
  const idempotencyKey = clean(options.idempotencyKey ?? body.idempotencyKey, 200);
  if (!idempotencyKey) return error(400, 'Idempotensnyckel krävs för återbetalning.', { code: 'IDEMPOTENCY_REQUIRED' });
  const applied = applyManualRefund(record, {
    status: body.status,
    amountOre: body.amountOre,
    stripeRefundId: body.stripeRefundId,
    reason: body.reason,
    note: body.note,
    idempotencyKey
  }, { now, actor });
  if (!applied.ok) return error(422, applied.message, { code: applied.code });
  if (applied.duplicate) {
    return {
      status: 200,
      jsonBody: {
        reference,
        duplicate: true,
        refund: applied.entry,
        refundSummary: calculateRefund({ ...record, refunds: applied.refunds }, { now })
      }
    };
  }
  const updated = {
    ...record,
    refunds: applied.refunds,
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: actor.name
  };
  try {
    await repo.updateRequest(updated, { ifMatch: raw.etag });
  } catch (cause) {
    if (cause?.status === 409) return error(409, 'Bokningen har ändrats av någon annan. Uppdatera sidan och försök igen.', { code: 'STALE' });
    throw cause;
  }
  await audit(repo, principal, reference, 'REFUND_RECORDED', {
    fromStatus: record.statusCode,
    toStatus: record.statusCode,
    reason: clean(body.reason, 500),
    changes: {
      amountOre: applied.entry.amountOre,
      status: applied.entry.status,
      stripeRefundId: applied.entry.stripeRefundId
    }
  }, context);
  return {
    status: 201,
    jsonBody: {
      reference,
      duplicate: false,
      refund: applied.entry,
      refundSummary: calculateRefund(updated, { now })
    }
  };
}

module.exports = {
  requestReconciliation,
  requestRefundSync,
  recordRefund,
  normalizeRefunds,
  calculateRefund
};

