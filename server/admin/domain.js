'use strict';

// Gemensam domänlogik för bokningsportalen. Allt här är read-only: modulen
// normaliserar befintliga bokningsposter, statusar, prissnapshot och
// mejlstatus för visning. Den räknar aldrig om priser och skriver aldrig.

const STATUS_META = {
  PENDING: {
    code: 'PENDING',
    label: 'Inväntar godkännande',
    shortLabel: 'Ny förfrågan',
    tone: 'pending',
    legacy: ['Inväntar godkännande', 'Ny', 'Ny förfrågan']
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
  }
};

const SOURCE_LABELS = {
  WEB: 'Webbplatsen',
  MANUAL: 'Manuell',
  AIRBNB: 'Airbnb',
  PHONE: 'Telefon',
  EMAIL: 'E-post',
  OTHER: 'Övrig'
};

const PAYMENT_LABELS = {
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
  'Kräver manuell kontroll': { api: 'Kräver manuell kontroll', tone: 'warning' }
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
  manual_review: { label: 'Manuell kontroll', tone: 'warning' }
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
    updatedAt: entry.updatedAt ?? entry.sentAt ?? ''
  };
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

function normalizeEmailStatus(record = {}, outbox = []) {
  if (record.emailStatus && typeof record.emailStatus === 'object') {
    return {
      host: normalizeMailLevel(record.emailStatus.host),
      guest: normalizeMailLevel(record.emailStatus.guest)
    };
  }
  const rows = Array.isArray(outbox) ? outbox : [];
  const host = rows.find((row) => row.mailType === 'HOST_NEW_REQUEST');
  const guest = rows.find((row) => row.mailType === 'GUEST_ACK');
  return {
    host: host ? normalizeMailLevel(host) : emptyMailLevel(),
    guest: guest ? normalizeMailLevel(guest) : emptyMailLevel()
  };
}

function deriveActionReasons(booking, now = new Date()) {
  const reasons = [];
  const today = todayKey(now);
  const created = booking.createdAt ? new Date(booking.createdAt) : null;
  const ageDays = created && Number.isFinite(created.getTime())
    ? Math.floor((now.getTime() - created.getTime()) / 86400000)
    : 0;

  if (booking.statusCode === 'PENDING' && ageDays >= 2) {
    reasons.push('Förfrågan väntar på beslut');
  }
  if (booking.actionFlags?.overlap || booking.overlaps?.length) {
    reasons.push('Överlappar annan förfrågan eller bokning');
  }
  if (booking.actionFlags?.conflict) {
    reasons.push('Kalenderkonflikt');
  }
  if (booking.mailStatus.host.needsReview || booking.mailStatus.guest.needsReview) {
    reasons.push('Mejl kräver manuell kontroll');
  }
  if (booking.statusCode === 'CONFIRMED' && !booking.airbnbBlockedAt && !booking.actionFlags?.airbnbBlocked) {
    reasons.push('Airbnb är inte blockerad');
  }
  if (booking.statusCode === 'CONFIRMED' && booking.paymentStatus === 'UNPAID' &&
    booking.arrival >= today && booking.total > 0) {
    reasons.push('Betalning saknas');
  }
  return [...new Set(reasons)];
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
  const booking = {
    idempotencyKey: record.idempotencyKey ?? record.RowKey ?? '',
    reference: String(record.reference ?? record.RowKey ?? ''),
    statusCode,
    statusLabel: meta.label,
    statusShortLabel: meta.shortLabel,
    statusTone: meta.tone,
    status: record.status ?? meta.label,
    arrival: String(record.arrival ?? ''),
    departure: String(record.departure ?? ''),
    nights: numberOr(record.nights),
    guests: numberOr(record.guests),
    firstName: String(record.firstName ?? ''),
    lastName: String(record.lastName ?? ''),
    guestName: [record.firstName, record.lastName].filter(Boolean).join(' ') || String(record.guestName ?? 'Gäst'),
    email: String(record.email ?? ''),
    phone: String(record.phone ?? ''),
    company: String(record.company ?? ''),
    message: String(record.message ?? ''),
    bookingSource: String(record.bookingSource ?? 'WEB').toUpperCase(),
    bookingSourceLabel: SOURCE_LABELS[String(record.bookingSource ?? 'WEB').toUpperCase()] ?? 'Övrig',
    createdAt: String(record.createdAt ?? ''),
    updatedAt: String(record.updatedAt ?? record.createdAt ?? ''),
    lodgingBase: numberOr(record.lodgingBase),
    discountLabel: String(discount?.label ?? ''),
    discountPercent: numberOr(discount?.percent),
    discountAmount,
    lodgingAfterDiscount: numberOr(record.lodgingAfterDiscount, numberOr(record.lodgingBase) - discountAmount),
    totalAddons,
    total: numberOr(record.total),
    priceVersion: String(record.priceVersion ?? ''),
    addonLines,
    pricing,
    paymentStatus: String(record.paymentStatus ?? (record.total > 0 ? 'UNPAID' : 'UNKNOWN')).toUpperCase(),
    amountPaid: numberOr(record.amountPaid),
    balance: numberOr(record.balance, numberOr(record.total) - numberOr(record.amountPaid)),
    latestNote: String(record.latestNote ?? ''),
    airbnbBlockedAt: record.airbnbBlockedAt ?? '',
    overlaps: Array.isArray(record.overlaps) ? record.overlaps : [],
    actionFlags: record.actionFlags && typeof record.actionFlags === 'object' ? record.actionFlags : {},
    isDemo: record.isDemo === true || String(record.reference ?? '').startsWith('DEMO-')
  };
  booking.paymentLabel = PAYMENT_LABELS[booking.paymentStatus] ?? 'Okänd';
  booking.mailStatus = normalizeEmailStatus(record, options.outbox);
  booking.actionReasons = deriveActionReasons(booking, now);
  booking.hasAction = booking.actionReasons.length > 0;
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
