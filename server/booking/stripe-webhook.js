'use strict';

const {
  parseStripeEvent,
  StripeSignatureError
} = require('./stripe');
const {
  applyStripePayment,
  markPaymentRequestStatus,
  formatOre
} = require('./payment-ledger');
const { MAIL } = require('./mail');

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

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function result(status, jsonBody) {
  return { status, headers: API_HEADERS, jsonBody };
}

function buildPaymentNotifications(record, payment, summary, options = {}) {
  const review = options.reviewRequired
    ? `VARNING: ${options.reviewRequired}`
    : '';
  const methodText = payment.method === 'SWISH' ? 'Swish' : payment.method === 'CARD' ? 'kort' : 'betalning';
  const guestMethodText = payment.method === 'SWISH' ? 'Swish-betalning' : payment.method === 'CARD' ? 'kortbetalning' : 'betalning';
  const hostLines = [
    `Referens: ${record.reference}`,
    `Betalning mottagen via ${methodText} (Stripe Checkout).`,
    `Belopp: ${formatOre(payment.amountOre)}`,
    `Totalt betalt: ${formatOre(summary.paidOre)}`,
    `Återstår: ${formatOre(Math.max(0, summary.remainingOre))}`,
    `Betalstatus: ${summary.paymentLabel}`,
    `Stripe-session: ${payment.stripeSessionId}`,
    review
  ].filter(Boolean);
  const guestLines = [
    `Referens: ${record.reference}`,
    `Vi har tagit emot din ${guestMethodText} på ${formatOre(payment.amountOre)}.`,
    `Totalt betalt: ${formatOre(summary.paidOre)}`,
    `Återstår: ${formatOre(Math.max(0, summary.remainingOre))}`,
    'Betalningen är registrerad på din bokning.'
  ];
  return {
    host: {
      mailType: 'HOST_PAYMENT_RECEIVED',
      to: MAIL.hostRecipient,
      replyTo: MAIL.replyTo,
      subject: `Betalning mottagen ${record.reference}`,
      body: hostLines.join('\n'),
      html: `<h2>Betalning mottagen ${escapeHtml(record.reference)}</h2><ul>${hostLines
        .map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
    },
    guest: {
      mailType: 'GUEST_PAYMENT_RECEIPT',
      to: record.email,
      replyTo: MAIL.replyTo,
      subject: `Betalning mottagen (${record.reference})`,
      body: guestLines.join('\n'),
      html: `<p>Tack! Vi har registrerat din betalning.</p><ul>${guestLines
        .map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
    }
  };
}

async function queueOutbox(store, record, payment, summary, event, options, context) {
  if (options.outboxEnabled !== true) return false;
  const notifications = buildPaymentNotifications(record, payment, summary, {
    reviewRequired: options.reviewRequired
  });
  for (const [key, notification] of Object.entries(notifications)) {
    try {
      await store.save({
        partition: 'outbox',
        idempotencyKey: `outbox-stripe-${payment.stripeSessionId}-${key}`,
        reference: record.reference,
        mailType: notification.mailType,
        status: 'Utkorg',
        mailTo: notification.to,
        mailReplyTo: notification.replyTo ?? '',
        mailSubject: notification.subject,
        mailHtml: notification.html,
        mailText: notification.body,
        attemptCount: 0,
        createdAt: (options.now ?? new Date()).toISOString()
      }, context);
    } catch {
      context.warn?.(`Stripe-kvittomejl kunde inte köas för ${record.reference}.`);
    }
  }
  return true;
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
    if (!marked.ok) {
      return result(200, { received: true, ignored: marked.reason ?? 'not_applicable' });
    }
    if (marked.changed) {
      await appendStatusHistory(store, marked.record, session, action, event, eventOptions, { warn });
    }
    return result(200, { received: true });
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
  await queueOutbox(store, applied.record, applied.payment, applied.summary, event, {
    ...eventOptions,
    reviewRequired: applied.reviewRequired
  }, { warn });

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
