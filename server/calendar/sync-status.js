'use strict';

// Synkstatus för Airbnb-importen.
//
// Statusen är avsiktligt begränsad till tekniska metadata: tidpunkter, en
// felkod, antal misslyckanden och eventuella konfliktnätter. Kalenderadressen,
// tokens, rå iCal-data och gästuppgifter får aldrig sparas här.
//
// Skrivningar är best-effort och får aldrig påverka en tillgänglighetskontroll.
// Vi skriver högst en gång per 30 sekunder om inget har ändrats, så att vanlig
// kalenderbläddring inte skapar onödigt många Table Storage-skrivningar.

const THROTTLE_MS = 30000;
let lastWriteAt = 0;
let lastSignature = '';

function safeCode(value) {
  const code = String(value ?? '').toUpperCase();
  return /^[A-Z0-9_]{3,48}$/.test(code) ? code : 'UNKNOWN';
}

function normalizeConflicts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((night) => typeof night === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(night))
  )].sort().slice(0, 100);
}

async function recordCalendarStatus(store, outcome, now = new Date(), options = {}) {
  if (!store || typeof store.saveCalendarSyncStatus !== 'function') return null;
  const source = String(outcome?.source ?? 'availability').slice(0, 40);
  const signature = [
    outcome?.ok === true ? 'ok' : 'error',
    outcome?.ok === true ? '' : safeCode(outcome?.errorCode),
    String(outcome?.blockedCount ?? ''),
    source
  ].join('|');
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  if (options.force !== true && signature === lastSignature && at.getTime() - lastWriteAt < THROTTLE_MS) {
    return null;
  }

  let previous = null;
  try {
    previous = await store.getCalendarSyncStatus();
  } catch {
    previous = null;
  }
  const ok = outcome?.ok === true;
  const record = {
    status: ok ? 'ok' : 'error',
    lastCheckAt: at.toISOString(),
    lastSuccessAt: ok ? at.toISOString() : (previous?.lastSuccessAt ?? ''),
    lastErrorAt: ok ? (previous?.lastErrorAt ?? '') : at.toISOString(),
    lastErrorCode: ok ? '' : safeCode(outcome?.errorCode),
    consecutiveFailures: ok ? 0 : Number(previous?.consecutiveFailures ?? 0) + 1,
    blockedNights: ok ? Number(outcome?.blockedCount ?? 0) : Number(previous?.blockedNights ?? 0),
    nightsChecked: Number(outcome?.nightsChecked ?? previous?.nightsChecked ?? 0),
    conflicts: ok ? normalizeConflicts(outcome?.conflicts) : normalizeConflicts(previous?.conflicts),
    source,
    checkedFrom: String(outcome?.from ?? previous?.checkedFrom ?? '').slice(0, 10),
    checkedTo: String(outcome?.to ?? previous?.checkedTo ?? '').slice(0, 10)
  };
  try {
    await store.saveCalendarSyncStatus(record);
  } catch {
    return null;
  }
  lastWriteAt = at.getTime();
  lastSignature = signature;
  return record;
}

function syncStatusLevel(record) {
  if (!record) return 'unknown';
  if (record.lastErrorCode) {
    return Number(record.consecutiveFailures ?? 0) >= 3 || !record.lastSuccessAt ? 'error' : 'warning';
  }
  return 'ok';
}

function resetStatusThrottle() {
  lastWriteAt = 0;
  lastSignature = '';
}

module.exports = {
  recordCalendarStatus,
  syncStatusLevel,
  resetStatusThrottle,
  THROTTLE_MS
};
