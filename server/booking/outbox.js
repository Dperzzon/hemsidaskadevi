'use strict';

const crypto = require('node:crypto');

// En gemensam väg till utkorgen. Alla sändningsbara mejl måste ha exakt samma
// fält som Logic Appens filter kräver: dispatchEligible='true' och
// outboxVersion='1'. Posterna får aldrig skickas enbart för att de ligger i
// outbox-partitionen.

const OUTBOX_PARTITION = 'outbox';
const OUTBOX_VERSION = '1';
const OUTBOX_STATUS_QUEUED = 'Utkorg';
const OUTBOX_DELIVERY_NOT_SENT = 'Ej skickad';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanMailAddress(value) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function assertMailAddress(address, mailType) {
  const clean = cleanMailAddress(address);
  if (clean.length > 320 || !EMAIL_PATTERN.test(clean)) {
    throw new Error(`Ogiltig mottagaradress för ${mailType || 'mejl'}`);
  }
  return clean;
}

function buildOutboxRecord(options = {}) {
  const notification = options.notification;
  if (!notification || !notification.mailType) {
    throw new Error('Utkorgspost saknar mejltyp');
  }
  if (!notification.subject) {
    throw new Error(`Utkorgspost ${notification.mailType} saknar ämne`);
  }
  const idempotencyKey = String(options.idempotencyKey ?? '').trim();
  if (!idempotencyKey) throw new Error('Utkorgspost saknar idempotensnyckel');
  if (idempotencyKey.length > 256) throw new Error('Utkorgspostens idempotensnyckel är för lång');
  return {
    partition: OUTBOX_PARTITION,
    idempotencyKey,
    reference: String(options.reference ?? ''),
    mailType: notification.mailType,
    status: OUTBOX_STATUS_QUEUED,
    mailTo: assertMailAddress(notification.to, notification.mailType),
    mailReplyTo: notification.replyTo
      ? assertMailAddress(notification.replyTo, `${notification.mailType} reply-to`)
      : '',
    mailSubject: String(notification.subject),
    mailHtml: String(notification.html ?? ''),
    mailText: String(notification.body ?? ''),
    dispatchEligible: 'true',
    outboxVersion: OUTBOX_VERSION,
    deliveryStatus: options.deliveryStatus ?? OUTBOX_DELIVERY_NOT_SENT,
    attemptCount: 0,
    createdAt: options.createdAt ?? new Date().toISOString()
  };
}

async function saveOutboxRecord(saveFn, record, context = {}) {
  try {
    const result = await saveFn(record);
    return { ok: true, duplicate: result?.duplicate === true };
  } catch (error) {
    context.warn?.(`Utkorgspost ${record.mailType} kunde inte sparas för ${record.reference}.`);
    await recordQueueFailure(context, record, error);
    return { ok: false, error };
  }
}

async function recordQueueFailure(context, record, error) {
  const appendHistory = context.appendHistory;
  if (typeof appendHistory !== 'function') return;
  try {
    await appendHistory({
      idempotencyKey: `outbox-failure-${record.idempotencyKey}`,
      reference: record.reference,
      action: 'EMAIL_QUEUE_FAILED',
      fromStatus: '',
      toStatus: '',
      changes: JSON.stringify({
        mailType: record.mailType,
        status: error?.status ?? '',
        message: String(error?.message ?? 'okänt fel').slice(0, 200)
      }),
      reason: `Kunde inte köa ${record.mailType}`,
      actorId: 'system',
      actorName: 'Bokningssystemet',
      correlationId: record.idempotencyKey,
      at: new Date().toISOString()
    });
  } catch {
    // Historiken är en extra säkerhetsåtgärd; själva felet loggas redan.
  }
}

async function queueNotification(saveFn, options) {
  let record;
  try {
    record = buildOutboxRecord(options);
  } catch (error) {
    const context = options.context ?? {};
    context.warn?.(`Utkorgspost ${options.notification?.mailType ?? ''} kunde inte skapas för ${options.reference ?? ''}.`);
    await recordQueueFailure(context, {
      reference: String(options.reference ?? ''),
      idempotencyKey: String(options.idempotencyKey ?? 'okänd'),
      mailType: String(options.notification?.mailType ?? '')
    }, error);
    return { ok: false, error };
  }
  return saveOutboxRecord(saveFn, record, options.context);
}

async function queueNotifications(saveFn, notifications, options = {}) {
  const results = [];
  for (const [key, notification] of Object.entries(notifications)) {
    if (!notification) continue;
    const result = await queueNotification(saveFn, {
      ...options,
      notification,
      idempotencyKey: `${options.idempotencyKeyPrefix}-${key}`
    });
    results.push({ key, ...result });
  }
  return results;
}

// En bekräftelse ska vara idempotent per bokning och bekräftelsetillfälle.
// Versionen får inte användas som nyckel: en administrativ anteckning höjer
// versionen och skulle då kunna skapa en dubbel bekräftelse vid en sen
// Stripe-omförsökning.
function confirmationKeyFor(record = {}) {
  const explicit = String(record.confirmationKey ?? '').trim();
  return explicit || `v${Number(record.version || 1)}`;
}

function confirmationOutboxKey(record = {}) {
  return `outbox-confirmation-${record.reference}-${confirmationKeyFor(record)}`;
}

function newConfirmationKey() {
  return `c-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function buildEmailObligation(options = {}) {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  return {
    confirmationKey: String(options.confirmationKey ?? ''),
    guest: {
      required: true,
      status: 'PENDING',
      attempts: 0,
      outboxKey: String(options.guestOutboxKey ?? ''),
      updatedAt: at
    },
    host: options.hostOutboxKey
      ? {
          required: true,
          status: 'PENDING',
          attempts: 0,
          outboxKey: String(options.hostOutboxKey),
          updatedAt: at
        }
      : null,
    updatedAt: at
  };
}

function obligationStatusFor(result) {
  if (!result) return null;
  if (result.disabled === true) return 'DISABLED';
  if (result.manualReview === true) return 'MANUAL_REVIEW';
  return result.ok === true ? 'QUEUED' : 'FAILED';
}

// Sparar resultatet av köningen på bokningen. Detta är den durability-markör
// som gör att en bekräftad bokning kan upptäckas och köas om även om
// utkorgsskrivningen misslyckades eller appen startades om.
async function updateEmailObligation(store, reference, results = {}, options = {}, context = {}) {
  if (!store || typeof store.getByReference !== 'function' || typeof store.updateRequest !== 'function') {
    return { ok: false, error: new Error('Saknar lagring för e-postkvittens') };
  }
  const now = options.now ?? new Date();
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await store.getByReference(reference);
    if (!raw) return { ok: false, error: new Error('Bokningen hittades inte') };
    const current = raw.record;
    const obligation = current.emailObligation;
    if (!obligation || typeof obligation !== 'object') return { ok: true, skipped: 'no_obligation' };
    const next = { ...obligation, updatedAt: now.toISOString() };
    let changed = false;
    for (const kind of ['guest', 'host']) {
      const entry = obligation[kind];
      const result = results[kind];
      if (!entry || !result) continue;
      const status = obligationStatusFor(result);
      if (!status) continue;
      next[kind] = {
        ...entry,
        status,
        attempts: Number(entry.attempts || 0) + 1,
        lastAttemptAt: now.toISOString(),
        error: status === 'FAILED'
          ? String(result.error?.message ?? 'Köningen misslyckades').slice(0, 300)
          : ''
      };
      changed = true;
    }
    if (!changed) return { ok: true, unchanged: true };
    const updated = {
      ...current,
      emailObligation: next,
      version: Number(current.version || 1) + 1,
      updatedAt: now.toISOString(),
      updatedBy: options.updatedBy ?? 'Bokningssystemet'
    };
    try {
      const saved = await store.updateRequest(updated, { ifMatch: raw.etag });
      return { ok: true, record: saved.record };
    } catch (error) {
      if (error?.status === 409 && attempt === 0) {
        context.warn?.(`E-postkvittens fick ETag-konflikt för ${reference}; försöker igen.`);
        continue;
      }
      context.warn?.(`E-postkvittens kunde inte sparas för ${reference}.`);
      return { ok: false, error };
    }
  }
  return { ok: false, error: new Error('E-postkvittens kunde inte sparas') };
}

module.exports = {
  OUTBOX_PARTITION,
  OUTBOX_VERSION,
  OUTBOX_STATUS_QUEUED,
  OUTBOX_DELIVERY_NOT_SENT,
  EMAIL_PATTERN,
  buildOutboxRecord,
  saveOutboxRecord,
  queueNotification,
  queueNotifications,
  confirmationKeyFor,
  confirmationOutboxKey,
  newConfirmationKey,
  buildEmailObligation,
  updateEmailObligation
};
