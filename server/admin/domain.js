'use strict';

// Gemensam domänlogik för bokningsportalen. Allt här är read-only: modulen
// normaliserar befintliga bokningsposter, statusar, prissnapshot och
// mejlstatus för visning. Den räknar aldrig om priser och skriver aldrig.

const { deriveWarnings, applyWarnings } = require('./warnings');
const { computePaymentSummary, normalizePaymentRequests, latestPaymentRequest } = require('./payments');
const { normalizeInvoiceRequests, activeInvoiceRequest } = require('../booking/invoice-requests');
const { paymentAccessState } = require('../booking/payment-access');
const { calculateRefund } = require('../booking/refunds');

const STATUS_META = {
  PENDING: {
    code: 'PENDING',
    label: 'Inväntar godkännande',
    shortLabel: 'Ny förfrågan',
    tone: 'pending',
    legacy: ['Inväntar godkännande', 'Ny', 'Ny förfrågan']
  },
  PENDING_PAYMENT: {
    code: 'PENDING_PAYMENT',
    label: 'Väntar på betalning',
    shortLabel: 'Betalning',
    tone: 'pending',
    legacy: ['Väntar på betalning', 'PENDING_PAYMENT']
  },
  PRELIMINARY: {
    code: 'PRELIMINARY',
    label: 'Preliminär',
    shortLabel: 'Preliminär',
    tone: 'preliminary',
    legacy: ['Preliminär', 'Preliminär bokning']
  },
  CONFIRMED: {
    code: 'CONFIRMED',
    label: 'Bekräftad',
    shortLabel: 'Bekräftad',
    tone: 'confirmed',
    legacy: ['Bekräftad', 'Bekräftad bokning']
  },
  DECLINED: {
    code: 'DECLINED',
    label: 'Nekad',
    shortLabel: 'Nekad',
    tone: 'declined',
    legacy: ['Nekad', 'Avslagen']
  },
  CANCELLED: {
    code: 'CANCELLED',
    label: 'Avbokad',
    shortLabel: 'Avbokad',
    tone: 'cancelled',
    legacy: ['Avbokad', 'Inställd']
  },
  BLOCKED: {
    code: 'BLOCKED',
    label: 'Blockerad',
    shortLabel: 'Blockerad',
    tone: 'blocked',
    legacy: ['Blockerad', 'Datumblockering']
  },
  RECONCILIATION: {
    code: 'RECONCILIATION',
    label: 'Avstämning krävs',
    shortLabel: 'Avstämning',
    tone: 'pending',
    legacy: ['Avstämning krävs', 'Avstämning']
  },
  EXPIRED: {
    code: 'EXPIRED',
    label: 'Reservationen har gått ut',
    shortLabel: 'Utgången',
    tone: 'cancelled',
    legacy: ['Reservationen har gått ut', 'Utgången']
  }
};

const SOURCE_LABELS = {
  WEB: 'Webbplatsen',
  MANUAL: 'Manuell',
  AIRBNB: 'Airbnb',
  PHONE: 'Telefon',
  EMAIL: 'E-post',
  DIRECT: 'Direktbokning webb',
  OTHER: 'Annat'
};

const PAYMENT_LABELS = {
  UNKNOWN: 'Ej angiven',
  UNPAID: 'Ej betald',
  DEPOSIT_PAID: 'Deposition betald',
  PARTIALLY_PAID: 'Delbetalt',
  PAID: 'Betald',
  REFUNDED: 'Återbetald',
  VOID: 'Makulerad'
};

const MAIL_STATUS_LABELS = {
  Utkorg: { api: 'Köat', tone: 'neutral' },
  Skickar: { api: 'Skickar', tone: 'preliminary' },
  Skickad: { api: 'Accepterat av Resend', tone: 'confirmed' },
  Misslyckad: { api: 'Misslyckat', tone: 'danger' },
  'Kräver manuell kontroll': { api: 'Kräver manuell kontroll', tone: 'warning' },
  Makulerad: { api: 'Makulerad', tone: 'neutral' }
};

const MAIL_TYPE_LABELS = {
  HOST_NEW_REQUEST: 'Värd: ny bokningsförfrågan',
  GUEST_REQUEST_ACK: 'Gäst: mottagningskvitto',
  HOST_PAYMENT_RECEIVED: 'Värd: betalning mottagen',
  GUEST_PAYMENT_RECEIPT: 'Gäst: betalningskvitto',
  GUEST_BOOKING_CONFIRMED: 'Gäst: bokningsbekräftelse',
  GUEST_CONFIRMATION: 'Gäst: bokningsbekräftelse (manuell)',
  GUEST_PAYMENT_LINK: 'Gäst: betalningslänk',
  HOST_INVOICE_REQUEST: 'Värd: fakturabegäran',
  GUEST_INVOICE_REQUEST_RECEIVED: 'Gäst: fakturabegäran mottagen',
  GUEST_BOOKING_CANCELLED: 'Gäst: avbokning',
  GUEST_PAYMENT_FAILED: 'Gäst: betalning ej genomförd'
};

const DELIVERY_LABELS = {
  'Inväntar leveranskontroll': { label: 'Inväntar leverans', tone: 'neutral' },
  unknown: { label: 'Okänd', tone: 'neutral' },
  accepted: { label: 'Accepterat', tone: 'confirmed' },
  delivered: { label: 'Levererat', tone: 'confirmed' },
  bounced: { label: 'Studsat', tone: 'danger' },
  failed: { label: 'Misslyckat', tone: 'danger' },
  complained: { label: 'Klagomål', tone: 'danger' },
  suppressed: { label: 'Undertryckt', tone: 'warning' },
  manual_review: { label: 'Manuell kontroll', tone: 'warning' },
  'Makulerad – bokningen ändrades': { label: 'Makulerad', tone: 'neutral' }
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function nightsBetween(arrival, departure) {
  if (!validDateKey(arrival) || !validDateKey(departure)) return 0;
  return Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
}

function nightKeys(arrival, departure) {
  const nights = [];
  let date = arrival;
  while (date < departure) {
    nights.push(date);
    date = addDays(date, 1);
  }
  return nights;
}

function toIsoAt(dateKey, hour = 12, minute = 0, timeZone = 'Europe/Stockholm') {
  // Skapar en ISO-tid som motsvarar lokal svensk tid. Används endast för
  // syntetisk demodata, aldrig för att tolka riktiga bokningar.
  const probe = new Date(`${dateKey}T${pad(hour)}:${pad(minute)}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(probe).map((part) => [part.type, part.value]));
  const asUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  const targetUtc = Date.parse(`${dateKey}T${pad(hour)}:${pad(minute)}:00Z`);
  return new Date(probe.getTime() + (targetUtc - asUtc)).toISOString();
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeStatus(record = {}) {
  const code = String(record.statusCode ?? '').toUpperCase();
  if (STATUS_META[code]) return code;
  const legacy = String(record.status ?? '').trim();
  for (const meta of Object.values(STATUS_META)) {
    if (meta.legacy.includes(legacy)) return meta.code;
  }
  return 'PENDING';
}

function statusMeta(code) {
  return STATUS_META[code] ?? STATUS_META.PENDING;
}

function normalizeAddonLines(record = {}) {
  const pricing = parseJson(record.pricing, null);
  const lines = record.addonLines ?? pricing?.addonLines ?? [];
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => ({
    id: String(line.id ?? ''),
    label: String(line.label ?? 'Tillval'),
    quantity: numberOr(line.quantity, 1),
    unitPrice: numberOr(line.unitPrice),
    amount: numberOr(line.amount)
  })).filter((line) => line.label);
}

function normalizeMailLevel(entry = {}) {
  const status = String(entry.status ?? entry.apiStatus ?? '').trim();
  const delivery = String(entry.deliveryStatus ?? entry.delivery ?? '').trim();
  const api = MAIL_STATUS_LABELS[status] ?? {
    api: status || 'Okänt',
    tone: status === 'Skickad' ? 'confirmed' : 'neutral'
  };
  const deliveryInfo = DELIVERY_LABELS[delivery] ?? (
    delivery ? { label: delivery, tone: 'neutral' } : { label: 'Okänt', tone: 'neutral' }
  );
  return {
    apiLabel: api.api,
    apiTone: api.tone,
    deliveryLabel: deliveryInfo.label,
    deliveryTone: deliveryInfo.tone,
    resendId: entry.resendId ?? '',
    needsReview: api.tone === 'warning' || api.tone === 'danger' ||
      deliveryInfo.tone === 'danger' || deliveryInfo.tone === 'warning',
    updatedAt: entry.updatedAt ?? entry.sentAt ?? '',
    mailType: String(entry.mailType ?? ''),
    mailTypeLabel: mailTypeLabel(entry.mailType),
    createdAt: String(entry.createdAt ?? ''),
    queued: status === 'Utkorg'
  };
}

function mailTypeLabel(mailType) {
  const type = String(mailType ?? '');
  return MAIL_TYPE_LABELS[type] ?? (type || 'Okänd mejltyp');
}

function emptyMailLevel() {
  return {
    apiLabel: 'Ingen uppgift',
    apiTone: 'neutral',
    deliveryLabel: 'Okänd',
    deliveryTone: 'neutral',
    resendId: '',
    needsReview: false,
    updatedAt: ''
  };
}

function obligationMailLevel(record = {}, kind) {
  const obligation = record?.emailObligation?.[kind];
  if (!obligation || typeof obligation !== 'object') return null;
  const status = String(obligation.status ?? '').toUpperCase();
  if (status !== 'PENDING' && status !== 'FAILED') return null;
  return normalizeMailLevel({
    status: status === 'FAILED' ? 'Misslyckad' : 'Kräver manuell kontroll',
    deliveryStatus: 'manual_review',
    mailType: kind === 'guest' ? 'GUEST_BOOKING_CONFIRMED' : 'HOST_PAYMENT_RECEIVED',
    createdAt: obligation.updatedAt ?? '',
    updatedAt: obligation.lastAttemptAt ?? obligation.updatedAt ?? ''
  });
}

function normalizeEmailStatus(record = {}, outbox = []) {
  if (record.emailStatus && typeof record.emailStatus === 'object') {
    return {
      host: normalizeMailLevel(record.emailStatus.host),
      guest: normalizeMailLevel(record.emailStatus.guest)
    };
  }
  const rows = Array.isArray(outbox) ? outbox : [];
  const sorted = [...rows].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  );
  const host = sorted.find((row) => String(row.mailType ?? '').startsWith('HOST_'));
  const guest = sorted.find((row) => String(row.mailType ?? '').startsWith('GUEST_'));
  return {
    host: host ? normalizeMailLevel(host) : (obligationMailLevel(record, 'host') ?? emptyMailLevel()),
    guest: guest ? normalizeMailLevel(guest) : (obligationMailLevel(record, 'guest') ?? emptyMailLevel())
  };
}

function deriveActionReasons(booking, now = new Date()) {
  return deriveWarnings(booking, { now })
    .filter((warning) => warning.severity !== 'handled')
    .map((warning) => warning.title);
}

function normalizeBooking(record = {}, options = {}) {
  const now = options.now ?? new Date();
  const pricing = parseJson(record.pricing, null);
  const addonLines = normalizeAddonLines(record);
  const statusCode = normalizeStatus(record);
  const meta = statusMeta(statusCode);
  const discount = parseJson(record.discount, null);
  const discountAmount = numberOr(record.discountAmount ?? discount?.amount);
  const totalAddons = numberOr(record.totalAddons, addonLines.reduce((sum, line) => sum + line.amount, 0));
  const bookingSource = String(record.bookingSource ?? 'WEB').toUpperCase();
  const isBlock = statusCode === 'BLOCKED' || /^BLOCK-/.test(String(record.reference ?? ''));
  const paymentSummary = computePaymentSummary(record);
  const paymentRequests = normalizePaymentRequests(record);
  const invoiceRequests = normalizeInvoiceRequests(record);
  const accessState = paymentAccessState(record, now);
  const paymentLinkStatus = !record.paymentAccess
    ? 'NONE'
    : statusCode !== 'CONFIRMED'
      ? 'BLOCKED'
      : accessState.ok
        ? 'OPEN'
        : accessState.code.replace('PAYMENT_LINK_', '');
  const paymentLinkLabels = {
    NONE: 'Ingen länk',
    OPEN: 'Aktiv',
    EXPIRED: 'Utgången',
    REVOKED: 'Återkallad',
    MISSING: 'Ingen länk',
    BLOCKED: 'Blockerad'
  };
  const booking = {
    idempotencyKey: record.idempotencyKey ?? record.RowKey ?? '',
    rowKey: record.rowKey ?? record.RowKey ?? record.idempotencyKey ?? '',
    reference: String(record.reference ?? record.RowKey ?? ''),
    etag: String(options.etag ?? record.etag ?? ''),
    version: numberOr(record.version, 1),
    statusCode,
    statusLabel: meta.label,
    statusShortLabel: meta.shortLabel,
    statusTone: meta.tone,
    status: record.status ?? meta.label,
    isBlock,
    blockId: String(record.blockId ?? ''),
    arrival: String(record.arrival ?? ''),
    departure: String(record.departure ?? ''),
    nights: numberOr(record.nights),
    guests: numberOr(record.guests),
    totalGuests: numberOr(record.totalGuests, numberOr(record.guests)),
    addons: record.addons && typeof record.addons === 'object' && !Array.isArray(record.addons)
      ? { ...record.addons }
      : {},
    extrahus: record.extrahus && typeof record.extrahus === 'object'
      ? {
        enabled: record.extrahus.enabled === true,
        nights: numberOr(record.extrahus.nights),
        guests: numberOr(record.extrahus.guests),
        arrival: String(record.extrahus.arrival ?? ''),
        departure: String(record.extrahus.departure ?? ''),
        nightKeys: Array.isArray(record.extrahus.nightKeys) ? record.extrahus.nightKeys.map(String) : []
      }
      : null,
    bufferNightsMode: record.bufferNightsMode === 'auto' ? 'auto' : 'manual',
    bufferNights: Array.isArray(record.bufferNights) ? record.bufferNights.map(String) : [],
    firstName: String(record.firstName ?? ''),
    lastName: String(record.lastName ?? ''),
    guestName: [record.firstName, record.lastName].filter(Boolean).join(' ') ||
      (isBlock ? 'Datumblockering' : 'Gäst'),
    email: String(record.email ?? ''),
    phone: String(record.phone ?? ''),
    company: String(record.company ?? ''),
    message: String(record.message ?? ''),
    bookingSource,
    bookingSourceLabel: SOURCE_LABELS[bookingSource] ?? 'Annat',
    directBookingApprovalId: String(record.directBookingApprovalId ?? ''),
    directBookingApprovals: Array.isArray(record.directBookingApprovals)
      ? record.directBookingApprovals.map(String)
      : [],
    createdAt: String(record.createdAt ?? ''),
    updatedAt: String(record.updatedAt ?? record.createdAt ?? ''),
    updatedBy: String(record.updatedBy ?? ''),
    confirmedAt: String(record.confirmedAt ?? ''),
    declinedAt: String(record.declinedAt ?? ''),
    cancelledAt: String(record.cancelledAt ?? ''),
    lodgingBase: numberOr(record.lodgingBase),
    discountLabel: String(discount?.label ?? ''),
    discountPercent: numberOr(discount?.percent),
    discountAmount,
    lodgingAfterDiscount: numberOr(record.lodgingAfterDiscount, numberOr(record.lodgingBase) - discountAmount),
    totalAddons,
    total: numberOr(record.total),
    calculatedTotal: numberOr(record.calculatedTotal, numberOr(record.total)),
    agreedTotal: record.agreedTotal === undefined || record.agreedTotal === null ? null : numberOr(record.agreedTotal),
    priceAdjustmentReason: String(record.priceAdjustmentReason ?? ''),
    priceVersion: String(record.priceVersion ?? ''),
    addonLines,
    pricing,
    paymentStatus: paymentSummary.paymentStatus,
    paymentLabel: paymentSummary.paymentLabel,
    amountPaid: paymentSummary.amountPaid,
    balance: paymentSummary.balance,
    payments: paymentSummary.payments,
    paymentRequests,
    paymentRequest: latestPaymentRequest(paymentRequests),
    reservation: record.reservation && typeof record.reservation === 'object'
      ? {
        status: String(record.reservation.status ?? ''),
        reference: String(record.reservation.reference ?? ''),
        owner: String(record.reservation.owner ?? ''),
        sessionId: String(record.reservation.sessionId ?? ''),
        createdAt: String(record.reservation.createdAt ?? ''),
        activatedAt: String(record.reservation.activatedAt ?? ''),
        expiresAt: String(record.reservation.expiresAt ?? ''),
        confirmedAt: String(record.reservation.confirmedAt ?? ''),
        releasedAt: String(record.reservation.releasedAt ?? '')
      }
      : null,
    reconciliation: record.reconciliation && typeof record.reconciliation === 'object'
      ? {
        reason: String(record.reconciliation.reason ?? ''),
        sessionId: String(record.reconciliation.sessionId ?? ''),
        paymentIntentId: String(record.reconciliation.paymentIntentId ?? ''),
        amountOre: numberOr(record.reconciliation.amountOre),
        currency: String(record.reconciliation.currency ?? ''),
        eventId: String(record.reconciliation.eventId ?? ''),
        at: String(record.reconciliation.at ?? '')
      }
      : null,
    stripeSessionId: String(
      paymentSummary.payments.find((payment) => payment.stripeSessionId)?.stripeSessionId ??
      latestPaymentRequest(paymentRequests)?.sessionId ??
      ''
    ),
    stripePaymentIntentId: String(
      paymentSummary.payments.find((payment) => payment.stripePaymentIntentId)?.stripePaymentIntentId ??
      latestPaymentRequest(paymentRequests)?.paymentIntentId ??
      ''
    ),
    paymentLink: {
      status: paymentLinkStatus,
      statusLabel: paymentLinkLabels[paymentLinkStatus] ?? 'Okänd',
      createdAt: String(record.paymentAccess?.createdAt ?? ''),
      expiresAt: String(record.paymentAccess?.expiresAt ?? ''),
      createdBy: String(record.paymentAccess?.createdBy ?? ''),
      revokedAt: String(record.paymentAccess?.revokedAt ?? ''),
      revokedReason: String(record.paymentAccess?.revokedReason ?? ''),
      amountOre: paymentSummary.remainingOre,
      amount: paymentSummary.balance
    },
    invoiceRequests,
    activeInvoiceRequest: activeInvoiceRequest(record),
    openingBalanceOre: paymentSummary.openingBalanceOre,
    totalOre: paymentSummary.totalOre,
    amountPaidOre: paymentSummary.paidOre,
    remainingOre: paymentSummary.remainingOre,
    overpaidOre: paymentSummary.overpaidOre,
    overpaid: paymentSummary.overpaid,
    latestNote: String(record.latestNote ?? ''),
    airbnbBlockedAt: record.airbnbBlockedAt ?? '',
    airbnbOverride: record.airbnbOverride === true,
    airbnbOverrideReason: String(record.airbnbOverrideReason ?? ''),
    airbnbOverrideApprovedBy: String(record.airbnbOverrideApprovedBy ?? ''),
    airbnbOverrideApprovedAt: String(record.airbnbOverrideApprovedAt ?? ''),
    airbnbBlockedNights: Array.isArray(record.airbnbBlockedNights) ? record.airbnbBlockedNights : [],
    airbnbOverrideFingerprint: String(record.airbnbOverrideFingerprint ?? ''),
    airbnbVerification: record.airbnbVerification && typeof record.airbnbVerification === 'object'
      ? {
        status: String(record.airbnbVerification.status ?? ''),
        blockedNights: Array.isArray(record.airbnbVerification.blockedNights)
          ? record.airbnbVerification.blockedNights
          : [],
        checkedAt: String(record.airbnbVerification.checkedAt ?? ''),
        checkedBy: String(record.airbnbVerification.checkedBy ?? ''),
        fingerprint: String(record.airbnbVerification.fingerprint ?? ''),
        source: String(record.airbnbVerification.source ?? ''),
        error: String(record.airbnbVerification.error ?? '')
      }
      : null,
    warningAcknowledgements: Array.isArray(record.warningAcknowledgements)
      ? record.warningAcknowledgements
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({
          warningId: String(row.warningId ?? ''),
          fingerprint: String(row.fingerprint ?? ''),
          type: String(row.type ?? ''),
          title: String(row.title ?? ''),
          reason: String(row.reason ?? ''),
          actorId: String(row.actorId ?? ''),
          actorName: String(row.actorName ?? ''),
          at: String(row.at ?? '')
        }))
      : [],
    overlaps: Array.isArray(record.overlaps) ? record.overlaps : [],
    actionFlags: record.actionFlags && typeof record.actionFlags === 'object' ? record.actionFlags : {},
    emailObligation: record.emailObligation && typeof record.emailObligation === 'object'
      ? record.emailObligation
      : null,
    reconciliationRequest: record.reconciliationRequest && typeof record.reconciliationRequest === 'object'
      ? record.reconciliationRequest
      : null,
    paymentReview: record.paymentReview && typeof record.paymentReview === 'object'
      ? record.paymentReview
      : null,
    refundSyncRequested: record.refundSyncRequested === true,
    refundSyncError: String(record.refundSyncError ?? ''),
    refundSyncedAt: String(record.refundSyncedAt ?? ''),
    isDemo: record.isDemo === true || String(record.reference ?? '').startsWith('DEMO-')
  };
  booking.refundSummary = calculateRefund(record, { now });
  booking.refunds = booking.refundSummary.refunds;
  booking.mailStatus = normalizeEmailStatus(record, options.outbox);
  booking.mailEvents = (Array.isArray(options.outbox) ? [...options.outbox] : [])
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .map((row) => normalizeMailLevel(row));
  applyWarnings(booking, { now });
  booking.searchText = [
    booking.reference,
    booking.guestName,
    booking.email,
    booking.phone,
    booking.company,
    booking.arrival,
    booking.departure,
    booking.statusLabel
  ].join(' ').toLowerCase();
  return booking;
}

function normalizeBookings(records = [], options = {}) {
  return records.map((record) => normalizeBooking(record, options));
}

function filterBookings(bookings = [], filters = {}) {
  const q = String(filters.q ?? '').trim().toLowerCase();
  const status = String(filters.status ?? '').trim().toUpperCase();
  const from = String(filters.from ?? '').trim();
  const to = String(filters.to ?? '').trim();
  return bookings.filter((booking) => {
    if (status && status !== 'ALL' && booking.statusCode !== status) return false;
    if (from && booking.departure < from) return false;
    if (to && booking.arrival > to) return false;
    if (q && !booking.searchText.includes(q)) return false;
    return true;
  });
}

function sortBookings(bookings = [], sort = 'arrival', direction = 'asc') {
  const factor = direction === 'desc' ? -1 : 1;
  const key = sort === 'created'
    ? (booking) => booking.createdAt
    : sort === 'amount'
      ? (booking) => booking.total
      : (booking) => booking.arrival;
  return [...bookings].sort((a, b) => {
    const av = key(a);
    const bv = key(b);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return a.reference.localeCompare(b.reference) * factor;
  });
}

function dashboardData(bookings = [], now = new Date()) {
  const today = todayKey(now);
  const upcoming = bookings.filter((booking) =>
    booking.statusCode === 'CONFIRMED' && booking.arrival >= today
  ).sort((a, b) => a.arrival.localeCompare(b.arrival));
  const newRequests = bookings
    .filter((booking) => booking.statusCode === 'PENDING')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const actions = bookings
    .filter((booking) => booking.hasAction)
    .sort((a, b) => {
      const priority = { danger: 0, warning: 1, pending: 2, preliminary: 3, confirmed: 4 };
      return (priority[a.statusTone] ?? 9) - (priority[b.statusTone] ?? 9) ||
        a.arrival.localeCompare(b.arrival);
    });
  const confirmedAll = bookings.filter((booking) => booking.statusCode === 'CONFIRMED');
  const nextCheckIn = confirmedAll
    .filter((booking) => booking.arrival >= today)
    .sort((a, b) => a.arrival.localeCompare(b.arrival))[0] ?? null;
  const nextCheckOut = confirmedAll
    .filter((booking) => booking.departure >= today)
    .sort((a, b) => a.departure.localeCompare(b.departure))[0] ?? null;
  return {
    newRequests,
    newRequestCount: newRequests.length,
    upcoming,
    upcomingCount: upcoming.length,
    upcomingGuests: upcoming.reduce((sum, booking) => sum + booking.guests, 0),
    upcomingValue: upcoming.reduce((sum, booking) => sum + booking.total, 0),
    actions,
    actionCount: actions.length,
    nextCheckIn,
    nextCheckOut,
    confirmedAll
  };
}

function formatDateKey(dateKey, options = {}) {
  if (!dateKey) return '—';
  const date = new Date(`${String(dateKey).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return String(dateKey);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'UTC',
    day: options.long ? 'numeric' : 'numeric',
    month: options.long ? 'long' : 'short',
    year: 'numeric'
  }).format(date);
}

function formatDateRange(arrival, departure) {
  if (!arrival || !departure) return '—';
  const sameYear = arrival.slice(0, 4) === departure.slice(0, 4);
  const sameMonth = sameYear && arrival.slice(0, 7) === departure.slice(0, 7);
  const arrivalText = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric'
  }).format(new Date(`${arrival}T00:00:00Z`));
  const departureText = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'UTC', day: 'numeric', month: sameMonth ? undefined : 'short', year: 'numeric'
  }).format(new Date(`${departure}T00:00:00Z`));
  return `${arrivalText} – ${departureText}`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatMoney(value) {
  return `${new Intl.NumberFormat('sv-SE').format(numberOr(value))} kr`;
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = {
  STATUS_META,
  SOURCE_LABELS,
  PAYMENT_LABELS,
  todayKey,
  addDays,
  validDateKey,
  nightsBetween,
  nightKeys,
  toIsoAt,
  normalizeStatus,
  statusMeta,
  normalizeBooking,
  normalizeBookings,
  normalizeEmailStatus,
  normalizeAddonLines,
  deriveActionReasons,
  filterBookings,
  sortBookings,
  dashboardData,
  formatDateKey,
  formatDateRange,
  formatDateTime,
  formatMoney,
  escapeHtml
};
