'use strict';

const { createStripeClient } = require('./stripe');
const {
  finalizePaidCheckoutSession,
  releaseDirectReservation
} = require('./stripe-webhook');
const {
  normalizePaymentRequests,
  latestPaymentRequest
} = require('./payment-ledger');
const { mergeStripeRefunds } = require('./refunds');

function isDirectRecord(record = {}) {
  return record.bookingSource === 'DIRECT' || Boolean(record.reservation);
}

function sessionIdFor(record = {}) {
  const requests = normalizePaymentRequests(record);
  const latest = latestPaymentRequest(requests);
  return String(
    latest?.sessionId ??
    record.paymentRequest?.sessionId ??
    record.reservation?.sessionId ??
    ''
  ).trim();
}

function syntheticEvent(session, type) {
  return {
    id: `reconcile-${String(session.id ?? 'session')}-${type}`,
    type,
    livemode: session.livemode === true,
    data: { object: session }
  };
}

async function appendSyntheticHistory(store, record, session, action, changes, context) {
  if (typeof store.appendHistory !== 'function') return;
  try {
    await store.appendHistory({
      idempotencyKey: `reconciliation-${record.reference}-${String(session?.id ?? 'none')}-${action}`,
      reference: record.reference,
      action,
      fromStatus: record.statusCode ?? '',
      toStatus: record.statusCode ?? '',
      changes: JSON.stringify(changes ?? {}),
      reason: '',
      actorId: 'reconciliation',
      actorName: 'Betalningsavstämning',
      correlationId: String(session?.id ?? ''),
      at: new Date().toISOString()
    });
  } catch (error) {
    if (error?.status !== 409) context.warn?.(`Avstämning: historik kunde inte sparas för ${record.reference}.`);
  }
}

async function updatePaymentReview(store, reference, details, options = {}, context = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await store.getByReference(reference);
    if (!raw) return { ok: false, reason: 'unknown_reference' };
    const current = raw.record;
    const now = options.now ?? new Date();
    const previous = current.paymentReview ?? {};
    const lastChecked = Date.parse(String(previous.checkedAt ?? ''));
    const throttleMs = details.reason === 'STRIPE_STILL_OPEN' ? 15 * 60_000 : 4 * 60_000;
    if (
      previous.status === details.status &&
      previous.reason === details.reason &&
      String(previous.sessionId ?? '') === String(details.sessionId ?? '') &&
      Number.isFinite(lastChecked) &&
      now.getTime() - lastChecked < throttleMs &&
      details.clearRequest !== true
    ) {
      return { ok: true, unchanged: true, record: current };
    }
    const updated = {
      ...current,
      paymentReview: {
        ...(current.paymentReview ?? {}),
        ...details,
        checkedAt: now.toISOString()
      },
      reconciliationRequest: details.clearRequest === true
        ? null
        : current.reconciliationRequest,
      version: Number(current.version || 1) + 1,
      updatedAt: now.toISOString(),
      updatedBy: 'Betalningsavstämning'
    };
    try {
      const saved = await store.updateRequest(updated, { ifMatch: raw.etag });
      await appendSyntheticHistory(store, saved.record, details.session ?? null,
        'PAYMENT_RECONCILIATION_CHECKED', details, context);
      return { ok: true, record: saved.record };
    } catch (error) {
      if (error?.status === 409 && attempt === 0) continue;
      context.warn?.(`Avstämning: kunde inte spara granskningsstatus för ${reference}.`);
      return { ok: false, retryable: true, error };
    }
  }
  return { ok: false, retryable: true };
}

// Kör en säker avstämning av en enskild direktbokning. Funktionen ändrar
// aldrig en RECONCILIATION till CONFIRMED; det kräver Owner-beslut.
async function reconcileDirectBooking(store, reference, options = {}, context = {}) {
  const raw = await store.getByReference(reference);
  if (!raw) return { ok: false, status: 'NOT_FOUND' };
  const record = raw.record;
  if (!isDirectRecord(record)) return { ok: true, status: 'NOT_DIRECT', skipped: true };
  if (!['PENDING_PAYMENT', 'RECONCILIATION'].includes(record.statusCode)) {
    return { ok: true, status: 'NOT_APPLICABLE', skipped: true };
  }

  const sessionId = sessionIdFor(record);
  if (!sessionId) {
    await updatePaymentReview(store, reference, {
      status: 'UNKNOWN',
      reason: 'NO_SESSION',
      message: 'Bokningen saknar Stripe-session. Kontrollera manuellt.',
      clearRequest: true
    }, options, context);
    return { ok: false, status: 'NO_SESSION', manualReview: true };
  }

  let stripe = options.stripeClient;
  if (!stripe) {
    try {
      stripe = createStripeClient({
        secretKey: options.stripeSecretKey,
        allowLive: options.stripeAllowLive,
        fetchImpl: options.stripeFetchImpl,
        apiBase: options.stripeApiBase,
        timeoutMs: options.stripeTimeoutMs
      });
    } catch {
      stripe = null;
    }
  }
  if (!stripe) {
    await updatePaymentReview(store, reference, {
      status: 'UNKNOWN',
      reason: 'STRIPE_NOT_CONFIGURED',
      sessionId,
      message: 'Stripe är inte konfigurerat. Reservationen behålls.',
      clearRequest: false
    }, options, context);
    return { ok: false, status: 'UNKNOWN', manualReview: true };
  }

  let session;
  try {
    session = await stripe.retrieveCheckoutSession(sessionId);
  } catch {
    await updatePaymentReview(store, reference, {
      status: 'UNKNOWN',
      reason: 'STRIPE_UNAVAILABLE',
      sessionId,
      message: 'Stripe kunde inte nås. Reservationen behålls och kontrolleras igen.',
      clearRequest: false
    }, options, context);
    return { ok: false, status: 'UNKNOWN', manualReview: true, retryable: true };
  }

  if (session?.payment_status === 'paid') {
    if (record.statusCode !== 'PENDING_PAYMENT') {
      await updatePaymentReview(store, reference, {
        status: 'PAID',
        reason: 'MANUAL_REVIEW_REQUIRED',
        sessionId,
        amountOre: Number(session.amount_total) || 0,
        currency: String(session.currency ?? ''),
        message: 'Stripe visar en betald session. Owner måste granska och bekräfta eller avboka.',
        clearRequest: true
      }, options, context);
      return { ok: true, status: 'PAID_MANUAL_REVIEW', manualReview: true };
    }
    const finalized = await finalizePaidCheckoutSession(
      store,
      reference,
      session,
      syntheticEvent(session, 'checkout.session.completed'),
      { ...options, now: options.now ?? new Date() },
      context
    );
    if (finalized.status >= 500) {
      return { ok: false, status: 'RETRY', retryable: true, result: finalized };
    }
    const reconciliation = finalized.jsonBody?.reconciliation === true;
    return {
      ok: reconciliation === false,
      status: reconciliation ? 'RECONCILIATION' : 'CONFIRMED',
      result: finalized
    };
  }

  if (session?.status === 'expired' || session?.status === 'complete') {
    if (record.statusCode !== 'PENDING_PAYMENT') {
      await updatePaymentReview(store, reference, {
        status: 'UNPAID',
        reason: 'SESSION_FINISHED_UNPAID',
        sessionId,
        message: 'Stripe-sessionen är avslutad utan betalning. Owner måste hantera ärendet.',
        clearRequest: true
      }, options, context);
      return { ok: true, status: 'UNPAID_MANUAL_REVIEW', manualReview: true };
    }
    const released = await releaseDirectReservation(
      store,
      reference,
      session,
      syntheticEvent(session, session.status === 'expired'
        ? 'checkout.session.expired'
        : 'checkout.session.async_payment_failed'),
      { ...options, stripeClient: stripe, now: options.now ?? new Date() },
      context
    );
    if (released.retryable) return { ok: false, status: 'RETRY', retryable: true };
    return {
      ok: true,
      status: released.released === true ? 'RELEASED' : 'NOT_RELEASED',
      result: released
    };
  }

  await updatePaymentReview(store, reference, {
    status: 'PENDING',
    reason: 'STRIPE_STILL_OPEN',
    sessionId,
    message: 'Stripe-sessionen är fortfarande öppen och obetald. Reservationen behålls.',
    clearRequest: true
  }, options, context);
  return { ok: true, status: 'STILL_OPEN' };
}

async function reconcileCandidates(store, options = {}, context = {}) {
  if (!store || typeof store.listReconciliationCandidates !== 'function') {
    return { scanned: 0, results: [] };
  }
  const candidates = await store.listReconciliationCandidates();
  const now = options.now ?? new Date();
  const minAgeMs = Number(options.minAgeMs ?? 60_000);
  const batchSize = Math.max(1, Math.min(Number(options.batchSize ?? 25), 100));
  const results = [];
  for (const record of candidates) {
    if (results.length >= batchSize) break;
    const requested = record?.reconciliationRequest?.status === 'REQUESTED';
    if (!requested) {
      const created = Date.parse(record?.createdAt ?? record?.updatedAt ?? '');
      if (Number.isFinite(created) && now.getTime() - created < minAgeMs) continue;
    }
    try {
      const result = await reconcileDirectBooking(store, record.reference, { ...options, now }, context);
      results.push({ reference: record.reference, ...result });
    } catch (error) {
      context.warn?.(`Avstämning misslyckades för ${record.reference}: ${error?.message ?? 'okänt fel'}`);
      results.push({ reference: record.reference, ok: false, status: 'ERROR' });
    }
  }
  return { scanned: candidates.length, results };
}

function createReconciliationScheduler(options = {}) {
  const store = options.store;
  const intervalMinutes = Math.max(1, Number(options.intervalMinutes ?? 5));
  const intervalMs = intervalMinutes * 60_000;
  let timer = null;
  let initialTimer = null;
  let running = false;

  async function runOnce() {
    if (running) return { skipped: 'already_running' };
    running = true;
    try {
      const result = await reconcileCandidates(store, {
        ...options,
        now: options.nowProvider?.() ?? new Date()
      }, { warn: options.warn });
      const refundSync = await syncRequestedRefunds(store, {
        ...options,
        now: options.nowProvider?.() ?? new Date()
      }, { warn: options.warn });
      return { ...result, refundSync };
    } catch (error) {
      options.warn?.(`Schemalagd betalningsavstämning misslyckades: ${error?.message ?? 'okänt fel'}`);
      return { error: true };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!store || timer) return;
    timer = setInterval(runOnce, intervalMs);
    timer.unref?.();
    initialTimer = setTimeout(runOnce, Math.min(15_000, intervalMs));
    initialTimer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (initialTimer) clearTimeout(initialTimer);
    timer = null;
    initialTimer = null;
  }

  return { start, stop, runOnce };
}

module.exports = {
  reconcileDirectBooking,
  reconcileCandidates,
  createReconciliationScheduler,
  sessionIdFor,
  updatePaymentReview,
  syncRefundsForRecord,
  syncRequestedRefunds
};

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

async function syncRefundsForRecord(store, reference, options = {}, context = {}) {
  const raw = await store.getByReference(reference);
  if (!raw) return { ok: false, status: 'NOT_FOUND' };
  const record = raw.record;
  const paymentIntentIds = uniqueStrings((record.payments ?? []).map((payment) => payment.stripePaymentIntentId));
  const now = options.now ?? new Date();
  if (!paymentIntentIds.length) {
    const updated = {
      ...record,
      refundSyncedAt: now.toISOString(),
      refundSyncRequested: false,
      refundSyncRequest: null,
      refundSyncError: 'Ingen Stripe PaymentIntent finns att hämta återbetalningar för.',
      version: Number(record.version || 1) + 1,
      updatedAt: now.toISOString(),
      updatedBy: 'Betalningsavstämning'
    };
    try {
      const saved = await store.updateRequest(updated, { ifMatch: raw.etag });
      return { ok: true, status: 'NO_PAYMENT_INTENT', record: saved.record };
    } catch {
      return { ok: false, status: 'RETRY', retryable: true };
    }
  }

  let stripe = options.stripeClient;
  if (!stripe) {
    try {
      stripe = createStripeClient({
        secretKey: options.stripeSecretKey,
        allowLive: options.stripeAllowLive,
        fetchImpl: options.stripeFetchImpl,
        apiBase: options.stripeApiBase,
        timeoutMs: options.stripeTimeoutMs
      });
    } catch {
      stripe = null;
    }
  }
  if (!stripe) {
    return { ok: false, status: 'STRIPE_NOT_CONFIGURED' };
  }

  let refunds = [];
  try {
    for (const paymentIntentId of paymentIntentIds) {
      const response = await stripe.listRefundsForPaymentIntent(paymentIntentId);
      if (Array.isArray(response?.data)) refunds.push(...response.data);
    }
  } catch {
    const failed = {
      ...record,
      refundSyncRequested: false,
      refundSyncError: 'Stripe kunde inte nås. Försök igen.',
      version: Number(record.version || 1) + 1,
      updatedAt: now.toISOString(),
      updatedBy: 'Betalningsavstämning'
    };
    try {
      await store.updateRequest(failed, { ifMatch: raw.etag });
    } catch {
      // Behåller flaggan om uppdateringen misslyckas; nästa körning försöker igen.
    }
    return { ok: false, status: 'STRIPE_UNAVAILABLE', retryable: true };
  }

  const merged = mergeStripeRefunds(record, refunds, now);
  const updated = {
    ...record,
    refunds: merged,
    refundSyncedAt: now.toISOString(),
    refundSyncRequested: false,
    refundSyncRequest: null,
    refundSyncError: '',
    version: Number(record.version || 1) + 1,
    updatedAt: now.toISOString(),
    updatedBy: 'Betalningsavstämning'
  };
  try {
    const saved = await store.updateRequest(updated, { ifMatch: raw.etag });
    await appendSyntheticHistory(store, saved.record, null, 'REFUNDS_SYNCED', {
      refundCount: refunds.length,
      paymentIntentCount: paymentIntentIds.length
    }, context);
    return { ok: true, status: 'SYNCED', record: saved.record, refundCount: refunds.length };
  } catch (error) {
    if (error?.status === 409) return { ok: false, status: 'RETRY', retryable: true };
    return { ok: false, status: 'ERROR', retryable: true };
  }
}

async function syncRequestedRefunds(store, options = {}, context = {}) {
  if (!store || typeof store.listRefundSyncCandidates !== 'function') {
    return { scanned: 0, results: [] };
  }
  const candidates = await store.listRefundSyncCandidates();
  const results = [];
  for (const record of candidates.slice(0, Number(options.batchSize ?? 10))) {
    try {
      results.push({ reference: record.reference, ...(await syncRefundsForRecord(store, record.reference, options, context)) });
    } catch (error) {
      context.warn?.(`Återbetalningssynk misslyckades för ${record.reference}: ${error?.message ?? 'okänt fel'}`);
      results.push({ reference: record.reference, ok: false, status: 'ERROR' });
    }
  }
  return { scanned: candidates.length, results };
}
