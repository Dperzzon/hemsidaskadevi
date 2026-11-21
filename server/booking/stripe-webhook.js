'use strict';

const {
  parseStripeEvent,
  StripeSignatureError,
  createStripeClient
} = require('./stripe');
const {
  applyStripePayment,
  markPaymentRequestStatus,
  computePaymentSummary
} = require('./payment-ledger');
const {
  RESERVATION_STATUS,
  verifyReservation,
  convertReservationToBooking,
  releaseReservation
} = require('./reservations');
const {
  buildPaymentNotifications,
  buildBookingConfirmation,
  buildPaymentFailedNotification
} = require('./booking-mail');
const { queueNotification, queueNotifications } = require('./outbox');
const { handleAvailability } = require('../calendar/availability');
const { nightKeys } = require('./requests');

const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.expired',
  'checkout.session.async_payment_failed'
]);

function result(status, jsonBody) {
  return { status, headers: API_HEADERS, jsonBody };
}

function outboxContextFor(store, context) {
  return {
    ...context,
    appendHistory: typeof store.appendHistory === 'function'
      ? (entry) => store.appendHistory(entry)
      : undefined
  };
}

async function queueOutbox(store, record, payment, summary, event, options, context) {
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const notifications = buildPaymentNotifications(record, payment, summary, {
    reviewRequired: options.reviewRequired
  });
  const outboxContext = {
    ...context,
    appendHistory: typeof store.appendHistory === 'function'
      ? (entry) => store.appendHistory(entry)
      : undefined
  };
  const results = await queueNotifications(
    (entry) => store.save(entry, context),
    notifications,
    {
      idempotencyKeyPrefix: `outbox-stripe-${payment.stripeSessionId}`,
      reference: record.reference,
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
  return {
    ok: results.every((item) => item.ok),
    queued: results.some((item) => item.ok && item.duplicate !== true),
    duplicate: results.every((item) => item.duplicate === true)
  };
}

async function queueConfirmation(store, record, options, context) {
  if (record?.statusCode !== 'CONFIRMED') {
    return { ok: false, queued: false, skipped: 'not_confirmed' };
  }
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const outboxContext = {
    ...context,
    appendHistory: typeof store.appendHistory === 'function'
      ? (entry) => store.appendHistory(entry)
      : undefined
  };
  return queueNotification(
    (entry) => store.save(entry, context),
    {
      idempotencyKey: `outbox-confirmation-${record.reference}-v${Number(record.version || 1)}`,
      reference: record.reference,
      notification: buildBookingConfirmation(record),
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
}

async function queuePaymentFailed(store, record, options, context) {
  if (record?.statusCode === 'CONFIRMED') {
    return { ok: false, queued: false, skipped: 'confirmed' };
  }
  if (options.outboxEnabled !== true) return { ok: true, queued: false, disabled: true };
  const outboxContext = {
    ...context,
    appendHistory: typeof store.appendHistory === 'function'
      ? (entry) => store.appendHistory(entry)
      : undefined
  };
  return queueNotification(
    (entry) => store.save(entry, context),
    {
      idempotencyKey: `outbox-payment-failed-${options.sessionId}`,
      reference: record.reference,
      notification: buildPaymentFailedNotification(record),
      createdAt: (options.now ?? new Date()).toISOString(),
      context: outboxContext
    }
  );
}

async function appendPaymentHistory(store, record, payment, summary, event, options, context) {
  try {
    await store.appendHistory({
      idempotencyKey: `stripe-${payment.stripeSessionId}-payment`,
      reference: record.reference,
      action: payment.method === 'CARD'
        ? 'CARD_PAYMENT_RECEIVED'
        : (payment.method === 'SWISH' ? 'SWISH_PAYMENT_RECEIVED' : 'PAYMENT_RECEIVED'),
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify({
        provider: 'stripe',
        sessionId: payment.stripeSessionId,
        eventId: event.id,
        amountOre: payment.amountOre,
        totalPaidOre: summary.paidOre,
        remainingOre: summary.remainingOre,
        paymentStatus: summary.paymentStatus
      }),
      reason: options.reviewRequired ?? '',
      actorId: 'stripe',
      actorName: 'Stripe',
      correlationId: event.id,
      at: (options.now ?? new Date()).toISOString()
    });
  } catch (error) {
    if (error?.status !== 409) {
      context.warn?.(`Stripe-historik kunde inte sparas för ${record.reference}.`);
    }
  }
}

async function appendStatusHistory(store, record, session, action, event, options, context) {
  try {
    await store.appendHistory({
      idempotencyKey: `stripe-${session.id}-${action.toLowerCase()}`,
      reference: record.reference,
      action,
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify({
        provider: 'stripe',
        sessionId: String(session.id ?? ''),
        eventId: event.id,
        status: String(session.status ?? '')
      }),
      reason: '',
      actorId: 'stripe',
      actorName: 'Stripe',
      correlationId: event.id,
      at: (options.now ?? new Date()).toISOString()
    });
  } catch (error) {
    if (error?.status !== 409) {
      context.warn?.(`Stripe-historik kunde inte sparas för ${record.reference}.`);
    }
  }
}

async function savePaymentWithRetry(store, reference, session, event, options, context) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await store.getByReference(reference);
    if (!raw) return { ok: false, reason: 'unknown_reference' };
    const applied = applyStripePayment(raw.record, session, {
      now: options.now,
      eventId: event.id
    });
    if (!applied.ok) return applied;
    if (applied.duplicate) {
      return { ...applied, etag: raw.etag };
    }
    const record = {
      ...applied.record,
      version: Number(raw.record.version || 1) + 1,
      updatedAt: (options.now ?? new Date()).toISOString(),
      updatedBy: 'Stripe'
    };
    try {
      const saved = await store.updateRequest(record, { ifMatch: raw.etag });
      return { ...applied, record: saved.record, etag: saved.etag };
    } catch (error) {
      lastError = error;
      if (error?.status !== 409 || attempt === 2) throw error;
      context.warn?.(`Stripe-webhook fick ETag-konflikt för ${reference}; försöker igen.`);
    }
  }
  throw lastError;
}

async function markStatusWithRetry(store, reference, session, status, event, options, context) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await store.getByReference(reference);
    if (!raw) return { ok: false, reason: 'unknown_reference' };
    const marked = markPaymentRequestStatus(raw.record, String(session.id ?? ''), status, {
      now: options.now,
      eventId: event.id
    });
    if (!marked.ok) return marked;
    if (!marked.changed) return marked;
    const record = {
      ...marked.record,
      version: Number(raw.record.version || 1) + 1,
      updatedAt: (options.now ?? new Date()).toISOString(),
      updatedBy: 'Stripe'
    };
    try {
      const saved = await store.updateRequest(record, { ifMatch: raw.etag });
      return { ok: true, changed: true, record: saved.record, etag: saved.etag };
    } catch (error) {
      lastError = error;
      if (error?.status !== 409 || attempt === 2) throw error;
      context.warn?.(`Stripe-webhook fick ETag-konflikt för ${reference}; försöker igen.`);
    }
  }
  throw lastError;
}

function getStripeClient(options = {}) {
  if (options.stripeClient) return options.stripeClient;
  try {
    return createStripeClient({
      secretKey: options.stripeSecretKey,
      allowLive: options.stripeAllowLive,
      fetchImpl: options.stripeFetchImpl,
      apiBase: options.stripeApiBase,
      timeoutMs: options.stripeTimeoutMs
    });
  } catch {
    return null;
  }
}

async function appendDirectHistory(store, record, session, event, options, context, action, changes = {}) {
  try {
    await store.appendHistory({
      idempotencyKey: `direct-${session.id}-${action.toLowerCase()}`,
      reference: record.reference,
      action,
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify({
        provider: 'stripe',
        sessionId: String(session.id ?? ''),
        eventId: event.id,
        amountOre: Number(session.amount_total) || 0,
        ...changes
      }),
      reason: '',
      actorId: 'stripe',
      actorName: 'Stripe',
      correlationId: event.id,
      at: (options.now ?? new Date()).toISOString()
    });
  } catch (error) {
    if (error?.status !== 409) {
      context.warn?.(`Direktbokning: historik kunde inte sparas för ${record.reference}.`);
    }
  }
}

// Betalningen är genomförd men bokningen kan inte säkert bekräftas. Vi bevarar
// Stripe-transaktionen och skapar ett tydligt avstämningsärende för Owner.
async function markReconciliation(store, record, session, event, options, context, reason, details = {}) {
  const now = options.now ?? new Date();
  const raw = await store.getByReference(record.reference).catch(() => null);
  const current = raw?.record ?? record;
  const updated = {
    ...current,
    statusCode: 'RECONCILIATION',
    status: 'Avstämning krävs',
    reconciliation: {
      reason,
      code: String(details.code ?? ''),
      nights: Array.isArray(details.nights) ? details.nights.slice(0, 100) : [],
      sessionId: String(session.id ?? ''),
      paymentIntentId: String(session.payment_intent ?? ''),
      amountOre: Number(session.amount_total) || 0,
      currency: String(session.currency ?? ''),
      eventId: event.id,
      at: now.toISOString()
    },
    version: Number(current.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: 'Stripe'
  };
  try {
    const saved = await store.updateRequest(updated, { ifMatch: raw?.etag ?? '*' });
    await appendDirectHistory(store, saved.record, session, event, options, context,
      'DIRECT_BOOKING_RECONCILIATION', {
        reason,
        code: details.code ?? '',
        nights: details.nights ?? []
      });
    return { ok: false, reconciliation: true, record: saved.record };
  } catch (error) {
    context.warn?.(`Direktbokning: avstämningsärende kunde inte sparas för ${record.reference}.`);
    return { ok: false, reconciliation: true, retryable: true, error };
  }
}

// Färsk Airbnb-kontroll omedelbart före CONFIRMED. Reservationen låser de
// interna nätterna, men Airbnb kan ha hunnit få en bokning under Checkout.
// Ett tekniskt fel eller en misstänkt kalender får aldrig leda till automatisk
// bekräftelse – då skapas i stället ett avstämningsärende.
async function checkAirbnbBeforeConfirmation(record, store, options, context) {
  const handler = options.availabilityHandler ?? handleAvailability;
  let result;
  try {
    const query = new URLSearchParams({ start: record.arrival, end: record.departure });
    result = await handler({ query }, context, {
      ...(options.availability ?? {}),
      calendarStatusStore: store,
      forceStatusWrite: true,
      statusSource: 'stripe-webhook',
      calendarSafetyEnabled: options.calendarSafetyEnabled,
      fetchTimeoutMs: options.availability?.fetchTimeoutMs ?? 4000,
      parseTimeoutMs: options.availability?.parseTimeoutMs ?? 6000,
      fetchMaxAttempts: 1
    });
  } catch {
    return { ok: false, code: 'AIRBNB_UNAVAILABLE' };
  }
  if (result.status !== 200 || !Array.isArray(result.jsonBody?.blocked)) {
    return {
      ok: false,
      code: result.jsonBody?.code ?? 'AIRBNB_UNAVAILABLE'
    };
  }
  const blocked = nightKeys(record.arrival, record.departure)
    .filter((night) => result.jsonBody.blocked.includes(night));
  if (blocked.length) return { ok: false, code: 'AIRBNB_CONFLICT', nights: blocked };
  return { ok: true };
}

async function confirmDirectBooking(store, applied, session, event, options, context) {
  const record = applied.record;
  if (record.bookingSource !== 'DIRECT' && !record.reservation) {
    return { ok: true, skipped: true };
  }
  if (record.statusCode === 'CONFIRMED') {
    return { ok: true, alreadyConfirmed: true };
  }
  if (record.statusCode === 'RECONCILIATION') {
    // Ett redan sparat avstämningsärende är ett manuellt ärende. En dubbel
    // webhook får inte automatiskt ändra Owner-granskningen till CONFIRMED.
    return { ok: true, skipped: true, alreadyReconciliation: true, record };
  }
  if (record.statusCode !== 'PENDING_PAYMENT') {
    return markReconciliation(
      store, record, session, event, options, context,
      `Bokningen hade status ${record.statusCode ?? 'okänd'} när betalningen togs emot.`
    );
  }

  const verification = await verifyReservation(store, record);
  if (!verification.ok) {
    return markReconciliation(
      store, record, session, event, options, context,
      'Reservationen saknar giltig nattlåsning. Kontrollera datumen och återbetala vid behov.'
    );
  }

  const airbnb = await checkAirbnbBeforeConfirmation(record, store, options, context);
  if (!airbnb.ok) {
    const conflictText = airbnb.code === 'AIRBNB_CONFLICT'
      ? `Airbnb-kalendern är upptagen på ${airbnb.nights.join(', ')}.`
      : airbnb.code === 'CALENDAR_EMPTY' || airbnb.code === 'CALENDAR_DROP' ||
          airbnb.code === 'CALENDAR_RANGE_EMPTY' || airbnb.code === 'CALENDAR_INCONSISTENT' ||
          airbnb.code === 'CALENDAR_STALE' || airbnb.code === 'CALENDAR_SUSPECT'
        ? 'Airbnb-kalendern kunde inte verifieras säkert. Kontrollera kalendern manuellt innan bokningen bekräftas.'
        : 'Airbnb-kalendern kunde inte hämtas eller tolkas. Kontrollera tillgängligheten manuellt innan bokningen bekräftas.';
    return markReconciliation(
      store, record, session, event, options, context,
      conflictText,
      { code: airbnb.code, nights: airbnb.nights ?? [] }
    );
  }

  try {
    await convertReservationToBooking(store, record, options.now ?? new Date());
  } catch {
    return markReconciliation(
      store, record, session, event, options, context,
      'Nattlåsningen kunde inte omvandlas till en bekräftad bokning.'
    );
  }

  const now = options.now ?? new Date();
  const updated = {
    ...record,
    statusCode: 'CONFIRMED',
    status: 'Bekräftad',
    confirmedAt: now.toISOString(),
    reservation: {
      ...(record.reservation ?? {}),
      status: RESERVATION_STATUS.CONFIRMED,
      confirmedAt: now.toISOString()
    },
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: 'Stripe'
  };
  try {
    const saved = await store.updateRequest(updated, { ifMatch: applied.etag });
    await appendDirectHistory(store, saved.record, session, event, options, context,
      'DIRECT_BOOKING_CONFIRMED');
    return { ok: true, record: saved.record };
  } catch (error) {
    if (error?.status === 409) {
      const raw = await store.getByReference(record.reference).catch(() => null);
      if (raw?.record?.statusCode === 'CONFIRMED') {
        return { ok: true, alreadyConfirmed: true };
      }
    }
    return markReconciliation(
      store, record, session, event, options, context,
      'Bokningen kunde inte uppdateras till bekräftad efter betalningen.'
    );
  }
}

async function releaseDirectReservation(store, reference, session, event, options, context) {
  const raw = await store.getByReference(reference).catch(() => null);
  if (!raw) return { ok: false, reason: 'unknown_reference' };
  const record = raw.record;
  if (record.bookingSource !== 'DIRECT' && !record.reservation) {
    return { ok: true, skipped: true };
  }
  if (record.statusCode === 'CONFIRMED') {
    return { ok: true, skipped: true };
  }

  // Verifiera hos Stripe att sessionen verkligen är avslutad och inte betald
  // innan datumen frigörs. Utan verifiering lämnas reservationen orörd.
  const stripe = getStripeClient(options);
  if (stripe) {
    try {
      const current = await stripe.retrieveCheckoutSession(session.id);
      if (current?.payment_status === 'paid') {
        return { ok: false, reason: 'session_paid' };
      }
      if (current?.status !== 'expired' && current?.status !== 'complete') {
        return { ok: false, reason: 'session_not_finished' };
      }
    } catch {
      return { ok: false, reason: 'stripe_unavailable', retryable: true };
    }
  }

  const now = options.now ?? new Date();
  await releaseReservation(store, reference, now);
  const updated = {
    ...record,
    statusCode: 'EXPIRED',
    status: 'Reservationen har gått ut',
    reservation: {
      ...(record.reservation ?? {}),
      status: RESERVATION_STATUS.EXPIRED,
      releasedAt: now.toISOString()
    },
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: 'Stripe'
  };
  try {
    const saved = await store.updateRequest(updated, { ifMatch: raw.etag });
    await appendDirectHistory(store, saved.record, session, event, options, context,
      'DIRECT_BOOKING_RESERVATION_RELEASED');
    return { ok: true, released: true, record: saved.record };
  } catch (error) {
    context.warn?.(`Direktbokning: reservationen kunde inte frigöras för ${reference}.`);
    return { ok: false, retryable: true, error };
  }
}

async function handleStripeWebhook(request, context = {}, options = {}) {
  const warn = context.warn ?? (() => {});
  const enabled = options.enabled ?? process.env.STRIPE_WEBHOOK_ENABLED === '1';
  if (!enabled) {
    return result(503, { error: 'Betalningswebhooken är inte aktiverad.' });
  }
  const secret = String(options.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    warn('Stripe-webhook: STRIPE_WEBHOOK_SECRET saknas.');
    return result(503, { error: 'Betalningswebhooken är inte konfigurerad.' });
  }
  const payload = request?.rawBody;
  if (!payload || (Buffer.isBuffer(payload) && payload.length === 0)) {
    return result(400, { error: 'Förfrågan saknar innehåll.' });
  }
  const nowValue = options.now;
  const nowMs = nowValue instanceof Date
    ? nowValue.getTime()
    : (typeof nowValue === 'number' && Number.isFinite(nowValue) ? nowValue : Date.now());
  const now = new Date(nowMs);

  let event;
  try {
    event = parseStripeEvent(payload, request?.signature, secret, {
      now: nowMs,
      toleranceSeconds: options.toleranceSeconds
    });
  } catch (error) {
    if (error instanceof StripeSignatureError) {
      warn(`Stripe-webhook: ${error.message}`);
      return result(400, { error: 'Ogiltig signatur.' });
    }
    throw error;
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    return result(200, { received: true, ignored: 'event_type' });
  }

  const session = event.data?.object;
  if (!session || typeof session !== 'object' || !session.id) {
    return result(200, { received: true, ignored: 'invalid_session' });
  }
  const reference = String(session.metadata?.reference ?? session.client_reference_id ?? '').trim();
  if (!/^[A-Za-z0-9-]{4,80}$/.test(reference)) {
    return result(200, { received: true, ignored: 'missing_reference' });
  }

  const store = options.store;
  if (!store || typeof store.getByReference !== 'function' || typeof store.updateRequest !== 'function') {
    throw new Error('Stripe-webhook saknar lagring');
  }

  const eventOptions = {
    ...options,
    now,
    outboxEnabled: options.outboxEnabled ?? process.env.STRIPE_OUTBOX_ENABLED === '1'
  };

  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const status = event.type === 'checkout.session.expired' ? 'EXPIRED' : 'FAILED';
    const action = event.type === 'checkout.session.expired'
      ? 'STRIPE_PAYMENT_REQUEST_EXPIRED'
      : 'STRIPE_PAYMENT_FAILED';
    const marked = await markStatusWithRetry(store, reference, session, status, event, eventOptions, { warn });
    const released = await releaseDirectReservation(store, reference, session, event, eventOptions, { warn });
    if (released.retryable) {
      return result(503, { error: 'Reservationen kunde inte frigöras just nu.' });
    }
    if (!marked.ok) {
      return result(200, { received: true, ignored: marked.reason ?? 'not_applicable' });
    }
    if (marked.changed) {
      await appendStatusHistory(store, marked.record, session, action, event, eventOptions, { warn });
    }
    const finalRecord = released.record ?? marked.record;
    const isDirectBooking = finalRecord &&
      (finalRecord.bookingSource === 'DIRECT' || Boolean(finalRecord.reservation));
    if (
      marked.changed &&
      isDirectBooking &&
      finalRecord.statusCode !== 'CONFIRMED' &&
      released.released === true
    ) {
      await queuePaymentFailed(store, finalRecord, {
        ...eventOptions,
        sessionId: String(session.id)
      }, outboxContextFor(store, { warn }));
    }
    return result(200, { received: true, released: released.released === true });
  }

  if (session.payment_status !== 'paid') {
    return result(200, { received: true, ignored: 'not_paid' });
  }

  let applied;
  try {
    applied = await savePaymentWithRetry(store, reference, session, event, eventOptions, { warn });
  } catch (error) {
    warn(`Stripe-webhook: kunde inte spara betalning för ${reference} (${error?.message ?? 'okänt fel'}).`);
    return result(503, { error: 'Betalningen kunde inte registreras just nu.' });
  }
  if (!applied.ok) {
    return result(200, { received: true, ignored: applied.reason ?? 'not_applicable' });
  }

  await appendPaymentHistory(store, applied.record, applied.payment, applied.summary, event, {
    ...eventOptions,
    reviewRequired: applied.reviewRequired
  }, { warn });

  const direct = await confirmDirectBooking(store, applied, session, event, eventOptions, { warn });
  if (direct?.retryable) {
    return result(503, { error: 'Betalningen kunde inte registreras just nu.' });
  }

  const finalRecord = direct?.record ?? applied.record;
  const finalSummary = computePaymentSummary(finalRecord);
  const outboxContext = outboxContextFor(store, { warn });
  const reviewRequired = direct?.reconciliation
    ? (finalRecord.reconciliation?.reason || 'Manuell avstämning krävs innan bokningen bekräftas.')
    : applied.reviewRequired;
  const directConfirmed = direct?.ok === true &&
    direct?.skipped !== true &&
    finalRecord.statusCode === 'CONFIRMED';

  if (directConfirmed) {
    await queueConfirmation(store, finalRecord, eventOptions, outboxContext);
    const hostNotification = buildPaymentNotifications(
      finalRecord,
      applied.payment,
      finalSummary,
      { reviewRequired }
    ).host;
    await queueNotification(
      (entry) => store.save(entry, { warn }),
      {
        idempotencyKey: `outbox-stripe-${String(session.id)}-host`,
        reference: finalRecord.reference,
        notification: hostNotification,
        createdAt: now.toISOString(),
        context: outboxContext
      }
    );
  } else {
    await queueOutbox(store, finalRecord, applied.payment, finalSummary, event, {
      ...eventOptions,
      reviewRequired
    }, { warn });
  }

  if (direct?.reconciliation) {
    return result(200, { received: true, reconciliation: true });
  }

  return result(200, {
    received: true,
    duplicate: applied.duplicate === true
  });
}

module.exports = {
  handleStripeWebhook,
  buildPaymentNotifications,
  HANDLED_EVENTS
};
