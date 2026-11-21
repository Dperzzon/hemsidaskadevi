'use strict';

// Avstämning av RESERVATION-rader i den interna kalendern.
//
// Direktbokning skapar tillfälliga RESERVATION-rader medan Stripe Checkout är
// öppen. Endast sådana rader som fortfarande tillhör en pågående, giltig
// betalning får exporteras till Airbnb. Utgångna, avbrutna eller föräldralösa
// rader rapporteras i stället för att tyst blockera datum.

const MISSING_EXPIRY_MAX_AGE_MS = 60 * 60000;
const MAX_ISSUES = 100;
const EXPORTABLE_TYPES = new Set(['BOOKING', 'MANUAL', 'RESERVATION']);
const TERMINAL_STATUSES = new Set(['CANCELLED', 'DECLINED', 'EXPIRED', 'FAILED']);
const NORMAL_ACTIVE_REASONS = new Set(['active', 'in_flight', 'confirmed', 'blocked']);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function isMainResource(row) {
  return (row?.resource ?? 'main') === 'main';
}

function isExternalSource(row) {
  return ['AIRBNB', 'ICAL'].includes(String(row?.source ?? '').toUpperCase());
}

function isReservation(row) {
  return String(row?.type ?? '').toUpperCase() === 'RESERVATION' &&
    isMainResource(row) && !isExternalSource(row);
}

function isExportableRow(row) {
  return EXPORTABLE_TYPES.has(String(row?.type ?? '').toUpperCase()) &&
    isMainResource(row) && !isExternalSource(row);
}

function recordTime(record) {
  for (const value of [record?.updatedAt, record?.createdAt]) {
    const time = Date.parse(String(value ?? ''));
    if (Number.isFinite(time)) return time;
  }
  return NaN;
}

function classifyReference(record, types, now) {
  if (!record) {
    // En föräldralös RESERVATION får inte blockera Airbnb för evigt. En
    // föräldralös BOOKING/MANUAL kan vara en äldre bokning och blockeras därför
    // fortfarande (fail closed) och rapporteras för manuell kontroll.
    return { active: !types.has('RESERVATION'), reason: 'orphan' };
  }
  const statusCode = String(record.statusCode ?? '').toUpperCase();
  const reservation = record.reservation ?? {};
  const reservationStatus = String(reservation.status ?? '').toUpperCase();
  const expiresAt = Date.parse(String(reservation.expiresAt ?? ''));
  const expired = Number.isFinite(expiresAt) && expiresAt <= now.getTime();

  if (TERMINAL_STATUSES.has(statusCode)) {
    return { active: false, reason: `status_${statusCode.toLowerCase()}` };
  }
  if (statusCode === 'CONFIRMED') return { active: true, reason: 'confirmed' };
  if (statusCode === 'RECONCILIATION') return { active: true, reason: 'reconciliation' };
  if (statusCode === 'BLOCKED') return { active: true, reason: 'blocked' };
  if (statusCode !== 'PENDING_PAYMENT') {
    // Okänd status: fail closed. En kalenderrad får aldrig försvinna från
    // exporten enbart för att statusen är ny eller saknas.
    return { active: true, reason: `status_${statusCode || 'unknown'}` };
  }
  if (['RELEASED', 'EXPIRED', 'FAILED', 'CANCELLED'].includes(reservationStatus)) {
    return { active: false, reason: `reservation_${reservationStatus.toLowerCase()}` };
  }
  if (!types.has('RESERVATION')) {
    // PENDING_PAYMENT med BOOKING/MANUAL-rader är inkonsekvent: fail closed.
    return { active: true, reason: 'pending_with_booking_rows' };
  }
  // En betald reservation kan sakna bekräftelse om webhooken är fördröjd.
  // Den lokala expiresAt är då inte bevis på att Stripe-sessionen är utgången.
  // Fail closed: behåll blockeringen i exporten och rapportera för avstämning.
  if (expired) return { active: true, reason: 'expired_pending_review' };
  if (Number.isFinite(expiresAt)) return { active: true, reason: 'active' };
  if (reservationStatus === 'ACTIVE') return { active: true, reason: 'active_without_expiry' };

  const created = recordTime(record);
  if (Number.isFinite(created) && now.getTime() - created <= MISSING_EXPIRY_MAX_AGE_MS) {
    return { active: true, reason: 'in_flight' };
  }
  return { active: true, reason: 'missing_expiry_review' };
}

function classifyReservation(record, now) {
  return classifyReference(record, new Set(['RESERVATION']), now);
}

function auditCalendarRows(rows, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const getRecord = options.getRecord;
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isExportableRow(row)) continue;
    const night = String(row.night ?? row.RowKey ?? '');
    if (!validDate(night)) continue;
    const reference = String(row.reference ?? '').trim();
    const key = reference || '__orphan__';
    if (!groups.has(key)) groups.set(key, { reference, types: new Set(), nights: [] });
    const group = groups.get(key);
    group.types.add(String(row.type ?? '').toUpperCase());
    group.nights.push(night);
  }

  const active = new Set();
  const issues = [];
  const work = [];
  for (const group of groups.values()) {
    const nights = [...new Set(group.nights)].sort();
    if (!group.reference) {
      issues.push({ reference: '', reason: 'missing_reference', nights: nights.slice(0, 31) });
      continue;
    }
    if (typeof getRecord !== 'function') {
      active.add(group.reference);
      continue;
    }
    work.push((async () => {
      let record;
      try {
        record = await getRecord(group.reference);
      } catch {
        active.add(group.reference);
        issues.push({
          reference: group.reference,
          reason: 'lookup_failed',
          types: [...group.types],
          nights: nights.slice(0, 31)
        });
        return;
      }
      const classification = classifyReference(record, group.types, now);
      if (classification.active) active.add(group.reference);
      if (!classification.active || !NORMAL_ACTIVE_REASONS.has(classification.reason)) {
        issues.push({
          reference: group.reference,
          reason: classification.reason,
          active: classification.active,
          statusCode: String(record?.statusCode ?? ''),
          types: [...group.types],
          nights: nights.slice(0, 31)
        });
      }
    })());
  }
  return Promise.all(work).then(() => {
    issues.sort((a, b) => String(a.reference).localeCompare(String(b.reference)));
    return {
      active,
      issues: issues.slice(0, Number(options.maxIssues ?? MAX_ISSUES)),
      totalIssues: issues.length
    };
  });
}

async function auditReservations(rows, options = {}) {
  return auditCalendarRows(rows, options);
}

module.exports = {
  auditCalendarRows,
  auditReservations,
  classifyReservation,
  isReservation,
  isExportableRow,
  MISSING_EXPIRY_MAX_AGE_MS
};