'use strict';

// Skyddsnät för Airbnb-importen.
//
// iCal är inte realtid. En giltig men tom eller kraftigt reducerad kalender kan
// därför inte tolkas som "allt är ledigt". Vi jämför varje färsk hämtning mot
// senast godkända kalenderbild och stoppar direktbetalning vid misstanke.
//
// Jämförelsen är avsiktligt konservativ: små, legitima avbokningar släpps
// igenom, men en tom kalender eller en stor minskning kräver manuell granskning.
// En misstänkt kalender kan återställas automatiskt om den senare innehåller
// minst lika många aktiva event som den senast godkända bilden.

const MAX_SNAPSHOT_NIGHTS = 1000;
const MIN_EVENT_DROP = 3;
const EVENT_DROP_RATIO = 0.25;
const MIN_RANGE_BLOCKS = 3;
const FUTURE_CLOCK_SKEW_MS = 5 * 60000;

const CODES = Object.freeze({
  EMPTY: 'CALENDAR_EMPTY',
  DROP: 'CALENDAR_DROP',
  RANGE_EMPTY: 'CALENDAR_RANGE_EMPTY',
  INCONSISTENT: 'CALENDAR_INCONSISTENT',
  STALE: 'CALENDAR_STALE',
  SUSPECT: 'CALENDAR_SUSPECT'
});

const REASONS = Object.freeze({
  [CODES.EMPTY]: 'Airbnb-kalendern innehåller inga aktiva bokningar trots tidigare kända blockeringar.',
  [CODES.DROP]: 'Airbnb-kalendern har tappat ett onormalt stort antal bokningar jämfört med senast godkända bild.',
  [CODES.RANGE_EMPTY]: 'Airbnb-kalendern saknar plötsligt alla tidigare kända blockeringar i det kontrollerade intervallet.',
  [CODES.INCONSISTENT]: 'Airbnb-kalendern har ändrat innehåll utan att ETag/Last-Modified har ändrats.',
  [CODES.STALE]: 'Airbnb-kalendern returnerar en äldre version än den som senast godkändes.',
  [CODES.SUSPECT]: 'Airbnb-kalendern kunde inte verifieras mot senast godkända bild.'
});

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function normalizeNights(value, max = MAX_SNAPSHOT_NIGHTS) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validDate))].sort().slice(0, max);
}

function nightInRange(night, from, to) {
  return night >= from && night < to;
}

function countNightsInRange(value, from, to) {
  return normalizeNights(value).filter((night) => nightInRange(night, from, to)).length;
}

function snapshotCovers(previous, from, to) {
  return validDate(previous?.snapshotFrom) && validDate(previous?.snapshotTo) &&
    previous.snapshotFrom <= from && to <= previous.snapshotTo;
}

function parseHttpDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function suspect(code, extra = {}) {
  return {
    status: 'suspect',
    code,
    reason: REASONS[code] ?? REASONS[CODES.SUSPECT],
    ...extra
  };
}

function evaluateCalendarSafety({ previous, current, from, to, now = new Date() }) {
  const prev = previous ?? {};
  const prevEventCount = Number(prev.eventCount ?? 0);
  const currEventCount = Number(current?.eventCount ?? 0);
  const prevFingerprint = String(prev.fingerprint ?? '');
  const currFingerprint = String(current?.fingerprint ?? '');
  const currRangeCount = Number(current?.blockedCount ?? 0);
  const covered = snapshotCovers(prev, from, to);
  const baselineRangeCount = covered ? countNightsInRange(prev.snapshotNights, from, to) : 0;

  // En tidigare misstänkt kalender får bara återgå automatiskt om den nya
  // bilden inte är sämre än den senast godkända: minst lika många aktiva event
  // och, när intervallet täcks, minst lika många kända blockeringar.
  if (prev.safetyStatus === 'suspect') {
    const notWorse = currEventCount >= prevEventCount &&
      (!covered || currRangeCount >= baselineRangeCount);
    if (notWorse && currEventCount > 0) {
      return {
        status: 'ok',
        code: '',
        reason: '',
        recovered: true
      };
    }
    return suspect(prev.safetyReason || CODES.SUSPECT);
  }

  const prevModified = parseHttpDate(prev.lastModified);
  const currModified = parseHttpDate(current?.lastModified);
  if (currModified !== null && currModified > now.getTime() + FUTURE_CLOCK_SKEW_MS) {
    return suspect(CODES.STALE);
  }
  if (prevModified !== null && currModified !== null && currModified < prevModified) {
    return suspect(CODES.STALE);
  }
  if (prevModified !== null && currModified !== null && currModified === prevModified &&
      prevFingerprint && currFingerprint && prevFingerprint !== currFingerprint) {
    return suspect(CODES.INCONSISTENT);
  }
  if (prev.calendarEtag && current?.etag && prev.calendarEtag === current.etag &&
      prevFingerprint && currFingerprint && prevFingerprint !== currFingerprint) {
    return suspect(CODES.INCONSISTENT);
  }

  if (prevEventCount > 0 && currEventCount === 0) {
    return suspect(CODES.EMPTY, { previousEventCount: prevEventCount });
  }

  const drop = prevEventCount - currEventCount;
  const minimumDrop = Math.max(MIN_EVENT_DROP, Math.ceil(prevEventCount * EVENT_DROP_RATIO));
  if (prevEventCount >= 4 && drop > 0 && drop >= minimumDrop) {
    return suspect(CODES.DROP, {
      previousEventCount: prevEventCount,
      currentEventCount: currEventCount,
      minimumDrop
    });
  }

  if (covered && baselineRangeCount >= MIN_RANGE_BLOCKS && currRangeCount === 0) {
    return suspect(CODES.RANGE_EMPTY, {
      from,
      to,
      previousBlockedCount: baselineRangeCount
    });
  }

  return { status: 'ok', code: '', reason: '' };
}

module.exports = {
  CODES,
  MAX_SNAPSHOT_NIGHTS,
  MIN_EVENT_DROP,
  EVENT_DROP_RATIO,
  MIN_RANGE_BLOCKS,
  normalizeNights,
  countNightsInRange,
  evaluateCalendarSafety
};