'use strict';

// Leveransuppföljning för mejl som skickats via Resend.
//
// Endpointen är avstängd som standard. Den får endast aktiveras genom att
// RESEND_WEBHOOK_ENABLED=1 och RESEND_WEBHOOK_SECRET sätts i miljön. Innan
// dess gör endpointen 404 och påverkar inte befintliga utskick.
//
// Resend använder Svix-signaturer:
//   svix-id, svix-timestamp, svix-signature
// Signaturunderlaget är "<id>.<timestamp>.<rå-body>" och HMAC-SHA256 beräknas
// med den base64-avkodade hemligheten efter prefixet "whsec_".
//
// Händelser behandlas idempotent via Svix-ID:t och uppdaterar endast
// leveransfält på rätt utkorgspost. Mejlets innehåll, mottagare och bokning
// ändras aldrig. Ingen mejladress eller mejltext loggas eller returneras.

const crypto = require('node:crypto');

const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_EVENT_ID = 200;
const MAX_EMAIL_ID = 200;
// Svix-ID och Resend-ID består av begränsade tecken. Att avvisa allt annat
// innan det når lagringsfiltret skyddar mot OData-injektion och skräpdata.
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const EVENT_RANK = {
  'email.sent': 1,
  'email.delivery_delayed': 1,
  'email.delivered': 2,
  'email.bounced': 3,
  'email.failed': 3,
  'email.complained': 3
};

const TERMINAL_STATUSES = new Set(['delivered', 'bounced', 'failed', 'complained']);

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

function result(status, jsonBody = {}, headers = {}) {
  return { status, headers: { ...API_HEADERS, ...headers }, jsonBody };
}

function headerValue(headers, name) {
  if (!headers) return '';
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) {
      return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    }
  }
  return '';
}

function webhookEnabled(options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  return process.env.RESEND_WEBHOOK_ENABLED === '1';
}

function webhookSecret(options = {}) {
  return String(options.secret ?? process.env.RESEND_WEBHOOK_SECRET ?? '').trim();
}

function decodeSecret(secret) {
  const value = String(secret ?? '').trim();
  const raw = value.startsWith('whsec_') ? value.slice('whsec_'.length) : value;
  try {
    const decoded = Buffer.from(raw, 'base64');
    return decoded.length ? decoded : Buffer.from(raw, 'utf8');
  } catch {
    return Buffer.from(raw, 'utf8');
  }
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifySignature({ id, timestamp, signature, rawBody, secret, now = new Date(), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS }) {
  if (!id || !timestamp || !signature || !secret) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const age = Math.abs(Math.floor(now.getTime() / 1000) - seconds);
  if (age > toleranceSeconds) return false;
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', decodeSecret(secret)).update(signed, 'utf8').digest('base64');
  const candidates = String(signature)
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.includes(',') ? part.slice(part.indexOf(',') + 1) : part);
  return candidates.some((candidate) => timingSafeEqualText(candidate, expected));
}

function safeBounceCode(data = {}) {
  const bounce = data?.bounce;
  const parts = [bounce?.type, bounce?.subType]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && /^[A-Za-z0-9_.-]{1,60}$/.test(value));
  return parts.join('/').slice(0, 120);
}

function classifyEvent(type) {
  const eventType = String(type ?? '');
  const rank = EVENT_RANK[eventType];
  if (!rank) return null;
  if (eventType === 'email.sent') {
    return { deliveryStatus: 'accepted', rank, terminal: false };
  }
  if (eventType === 'email.delivery_delayed') {
    return { deliveryStatus: 'delivery_delayed', rank, terminal: false };
  }
  const deliveryStatus = eventType.slice('email.'.length);
  return { deliveryStatus, rank, terminal: TERMINAL_STATUSES.has(deliveryStatus) };
}

function eventTime(event, now) {
  const parsed = Date.parse(String(event?.created_at ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed) : now;
}

function shouldApply(current, incoming, at) {
  const currentStatus = String(current?.deliveryStatus ?? '').toLowerCase();
  if (TERMINAL_STATUSES.has(currentStatus) && !incoming.terminal) return false;
  const currentAt = Date.parse(String(current?.lastEventAt ?? ''));
  if (Number.isFinite(currentAt)) {
    const incomingAt = at.getTime();
    if (incomingAt < currentAt) return false;
    if (incomingAt === currentAt) {
      const currentRank = EVENT_RANK[String(current?.lastEventType ?? '')] ?? 0;
      if (incoming.rank < currentRank) return false;
    }
  }
  return true;
}

function patchForEvent(event, info, at, now) {
  const patch = {
    deliveryStatus: info.deliveryStatus,
    lastEventAt: at.toISOString(),
    lastEventType: String(event.type ?? '').slice(0, 80),
    updatedAt: now.toISOString()
  };
  const timestamp = at.toISOString();
  if (info.deliveryStatus === 'delivered') {
    patch.deliveredAt = timestamp;
    patch.bouncedAt = '';
    patch.failedAt = '';
    patch.complainedAt = '';
    patch.manualReviewReason = '';
    patch.deliveryError = '';
  } else if (info.deliveryStatus === 'bounced') {
    patch.deliveredAt = '';
    patch.bouncedAt = timestamp;
    patch.manualReviewReason = 'Resend rapporterade att mejlet studsade. Kontrollera mottagaradressen innan ett nytt försök.';
    patch.deliveryError = safeBounceCode(event.data);
  } else if (info.deliveryStatus === 'failed') {
    patch.deliveredAt = '';
    patch.failedAt = timestamp;
    patch.manualReviewReason = 'Resend rapporterade att leveransen misslyckades. Kontrollera leveransen innan ett nytt försök.';
    patch.deliveryError = safeBounceCode(event.data);
  } else if (info.deliveryStatus === 'complained') {
    patch.deliveredAt = '';
    patch.complainedAt = timestamp;
    patch.manualReviewReason = 'Mottagaren har markerat mejlet som skräppost. Skicka inte om utan manuell kontroll.';
    patch.deliveryError = safeBounceCode(event.data);
  }
  return patch;
}

async function recordHistory(store, row, event, info, context) {
  if (!row?.reference || typeof store?.appendHistory !== 'function') return;
  try {
    await store.appendHistory({
      idempotencyKey: `email-delivery-${String(event.id ?? '').slice(0, 120)}`,
      reference: row.reference,
      action: 'EMAIL_DELIVERY_UPDATED',
      fromStatus: '',
      toStatus: '',
      changes: JSON.stringify({
        mailType: row.mailType ?? '',
        deliveryStatus: info.deliveryStatus,
        lastEventType: String(event.type ?? '').slice(0, 80)
      }),
      reason: '',
      actorId: 'resend',
      actorName: 'Resend',
      correlationId: String(event.id ?? '').slice(0, 120),
      at: new Date().toISOString()
    });
  } catch (error) {
    if (error?.status !== 409) context?.warn?.('Mejlleveransens historikpost kunde inte sparas.');
  }
}

async function handleResendWebhook(request = {}, context = {}, options = {}) {
  if (!webhookEnabled(options)) {
    return result(404, { error: 'Hittades inte.' });
  }
  const secret = webhookSecret(options);
  if (!secret) {
    context.warn?.('Resend-webhooken är aktiverad men RESEND_WEBHOOK_SECRET saknas.');
    return result(503, { error: 'Webhooken är inte konfigurerad.' });
  }

  const headers = request.headers ?? {};
  const id = headerValue(headers, 'svix-id');
  const timestamp = headerValue(headers, 'svix-timestamp');
  const signature = headerValue(headers, 'svix-signature');
  const rawBody = Buffer.isBuffer(request.rawBody)
    ? request.rawBody.toString('utf8')
    : String(request.rawBody ?? '');

  if (!id || id.length > MAX_EVENT_ID || !SAFE_ID.test(id)) return result(400, { error: 'Ogiltig händelse.' });
  if (!verifySignature({
    id,
    timestamp,
    signature,
    rawBody,
    secret,
    now: options.now ?? new Date(),
    toleranceSeconds: Number(options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)
  })) {
    return result(401, { error: 'Ogiltig signatur.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return result(400, { error: 'Ogiltig händelse.' });
  }
  const type = String(event?.type ?? '');
  const emailId = String(event?.data?.email_id ?? '');
  if (!type || !emailId || emailId.length > MAX_EMAIL_ID || !SAFE_ID.test(emailId)) {
    return result(400, { error: 'Ogiltig händelse.' });
  }
  const info = classifyEvent(type);
  if (!info) {
    return result(200, { received: true, handled: false });
  }

  const store = options.store;
  if (!store || typeof store.findOutboxByResendId !== 'function' ||
      typeof store.updateOutboxDelivery !== 'function' ||
      typeof store.recordWebhookEvent !== 'function') {
    context.warn?.('Resend-webhooken saknar lagringsstöd.');
    return result(503, { error: 'Webhooken är inte konfigurerad.' });
  }

  const now = options.now ?? new Date();
  if (typeof store.getWebhookEvent === 'function') {
    try {
      const existing = await store.getWebhookEvent(id);
      if (existing) return result(200, { received: true, duplicate: true });
    } catch {
      context.warn?.('Resend-webhookens idempotenspost kunde inte läsas.');
    }
  }

  let row;
  try {
    row = await store.findOutboxByResendId(emailId);
  } catch {
    context.warn?.('Resend-webhooken kunde inte slå upp utkorgsposten.');
    return result(503, { error: 'Händelsen kunde inte behandlas.' });
  }
  if (!row?.record) {
    // Resend kan skicka händelser för mejl som inte skapats av bokningsflödet.
    // De kvitteras utan åtgärd så att leverantören inte försöker igen.
    return result(200, { received: true, matched: false });
  }

  const at = eventTime(event, now);
  if (!shouldApply(row.record, info, at)) {
    return result(200, { received: true, applied: false });
  }
  const patch = patchForEvent(event, info, at, now);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await store.updateOutboxDelivery(row.record.idempotencyKey, patch, { ifMatch: row.etag });
      try {
        await store.recordWebhookEvent(id, {
          receivedAt: now.toISOString(),
          eventType: type,
          emailId
        });
      } catch {
        // Uppdateringen är redan gjord. En framtida retry applicerar samma
        // idempotenta patch igen, så ett misslyckat idempotenssparande får
        // inte göra att leverantören tror att händelsen tappades.
        context.warn?.('Resend-webhookens idempotenspost kunde inte sparas.');
      }
      await recordHistory(store, row.record, { ...event, id }, info, context);
      return result(200, { received: true, applied: true });
    } catch (error) {
      if (error?.status === 409 && attempt === 0) {
        try {
          row = await store.findOutboxByResendId(emailId);
        } catch {
          row = null;
        }
        if (!row?.record) return result(200, { received: true, matched: false });
        continue;
      }
      context.warn?.('Resend-webhooken kunde inte uppdatera utkorgsposten.');
      return result(503, { error: 'Händelsen kunde inte behandlas.' });
    }
  }
  return result(503, { error: 'Händelsen kunde inte behandlas.' });
}

module.exports = {
  handleResendWebhook,
  verifySignature,
  classifyEvent,
  decodeSecret,
  patchForEvent,
  DEFAULT_TOLERANCE_SECONDS
};
