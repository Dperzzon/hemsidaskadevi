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

const { normalizeNights } = require('./safety');

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

function validDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

async function recordCalendarStatus(store, outcome, now = new Date(), options = {}) {
  if (!store || typeof store.saveCalendarSyncStatus !== 'function') return null;
  const source = String(outcome?.source ?? 'availability').slice(0, 40);
  const safety = outcome?.safety ?? null;
  const signature = [
    outcome?.ok === true ? 'ok' : 'error',
    outcome?.ok === true ? '' : safeCode(outcome?.errorCode),
    String(outcome?.blockedCount ?? ''),
    source,
    safety ? `${safety.status}:${safety.code}` : '',
    String(outcome?.eventCount ?? ''),
    String(outcome?.fingerprint ?? '')
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
  const previousSafety = previous?.safetyStatus ?? 'ok';
  const safetyStatus = safety ? safety.status : previousSafety;
  const suspect = safetyStatus === 'suspect';
  const safetyIsSuspect = safety?.status === 'suspect';
  const safetyIsOk = safety?.status === 'ok';
  const candidate = suspect && outcome?.candidate === true;
  const candidateSnapshot = candidate
    ? normalizeNights(outcome?.snapshotNights)
    : normalizeNights(previous?.suspectedSnapshotNights);
  const acceptedSnapshot = ok && !suspect && Array.isArray(outcome?.snapshotNights)
    ? normalizeNights(outcome.snapshotNights)
    : normalizeNights(previous?.snapshotNights);
  const snapshotFrom = ok && !suspect && validDateKey(outcome?.snapshotFrom)
    ? outcome.snapshotFrom
    : (previous?.snapshotFrom ?? '');
  const snapshotTo = ok && !suspect && validDateKey(outcome?.snapshotTo)
    ? outcome.snapshotTo
    : (previous?.snapshotTo ?? '');
  const acceptBaseline = ok && !suspect;
  const record = {
    status: ok ? 'ok' : 'error',
    lastCheckAt: at.toISOString(),
    lastSuccessAt: ok && !suspect ? at.toISOString() : (previous?.lastSuccessAt ?? ''),
    lastErrorAt: ok && !suspect ? (previous?.lastErrorAt ?? '') : at.toISOString(),
    lastErrorCode: ok && !suspect ? '' : safeCode(outcome?.errorCode ?? (safetyIsSuspect ? safety.code : '')),
    consecutiveFailures: ok && !suspect ? 0 : Number(previous?.consecutiveFailures ?? 0) + 1,
    blockedNights: ok && !suspect ? Number(outcome?.blockedCount ?? 0) : Number(previous?.blockedNights ?? 0),
    nightsChecked: Number(outcome?.nightsChecked ?? previous?.nightsChecked ?? 0),
    conflicts: ok && !suspect ? normalizeConflicts(outcome?.conflicts) : normalizeConflicts(previous?.conflicts),
    source,
    checkedFrom: String(outcome?.from ?? previous?.checkedFrom ?? '').slice(0, 10),
    checkedTo: String(outcome?.to ?? previous?.checkedTo ?? '').slice(0, 10),
    eventCount: acceptBaseline
      ? Number(outcome?.eventCount ?? previous?.eventCount ?? 0)
      : Number(previous?.eventCount ?? 0),
    fingerprint: acceptBaseline
      ? String(outcome?.fingerprint ?? previous?.fingerprint ?? '').slice(0, 64)
      : String(previous?.fingerprint ?? '').slice(0, 64),
    lastModified: acceptBaseline
      ? String(outcome?.lastModified ?? previous?.lastModified ?? '').slice(0, 64)
      : String(previous?.lastModified ?? '').slice(0, 64),
    calendarEtag: acceptBaseline
      ? String(outcome?.calendarEtag ?? previous?.calendarEtag ?? '').slice(0, 256)
      : String(previous?.calendarEtag ?? '').slice(0, 256),
    snapshotFrom,
    snapshotTo,
    snapshotNights: acceptedSnapshot,
    safetyStatus,
    safetyReason: suspect ? String(safety?.code ?? previous?.safetyReason ?? 'CALENDAR_SUSPECT').slice(0, 48) : '',
    safetySince: suspect ? (previous?.safetySince || at.toISOString()) : '',
    suspectedEventCount: suspect
      ? (candidate ? Number(outcome?.eventCount ?? 0) : Number(previous?.suspectedEventCount ?? 0))
      : 0,
    suspectedFingerprint: suspect
      ? (candidate
        ? String(outcome?.fingerprint ?? '').slice(0, 64)
        : String(previous?.suspectedFingerprint ?? '').slice(0, 64))
      : '',
    suspectedSnapshotFrom: suspect
      ? (candidate
        ? String(outcome?.snapshotFrom ?? '').slice(0, 10)
        : String(previous?.suspectedSnapshotFrom ?? '').slice(0, 10))
      : '',
    suspectedSnapshotTo: suspect
      ? (candidate
        ? String(outcome?.snapshotTo ?? '').slice(0, 10)
        : String(previous?.suspectedSnapshotTo ?? '').slice(0, 10))
      : '',
    suspectedSnapshotNights: suspect ? candidateSnapshot : [],
    suspectedAt: suspect ? (candidate ? at.toISOString() : (previous?.suspectedAt ?? '')) : ''
  };
  if (safetyIsOk && previousSafety === 'suspect' && safety?.recovered === true) {
    record.lastErrorAt = previous?.lastErrorAt ?? '';
    record.lastErrorCode = '';
    record.consecutiveFailures = 0;
  }
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
  if (record.safetyStatus === 'suspect') return 'error';
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
