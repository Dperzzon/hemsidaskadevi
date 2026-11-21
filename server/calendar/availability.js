'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { recordCalendarStatus } = require('./sync-status');
const { evaluateCalendarSafety } = require('./safety');

const MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const PARSE_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
const DAY = 86400000;
const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };

class CalendarFetchError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.name = 'CalendarFetchError';
    this.code = code;
    this.retryable = retryable;
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validateRange(query) {
  const keys = [...query.keys()];
  if (keys.length !== 2 || !keys.includes('start') || !keys.includes('end')) return false;
  const start = query.get('start');
  const end = query.get('end');
  if (!validDate(start) || !validDate(end)) return false;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY;
  return days > 0 && days <= 93;
}

function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CalendarFetchError('CONFIG_INVALID');
  }
  return url;
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

function isCalendarContentType(value) {
  if (!value) return true;
  const type = String(value).split(';', 1)[0].trim().toLowerCase();
  return ['text/calendar', 'text/plain', 'application/ics', 'application/octet-stream'].includes(type);
}

function looksLikeCalendar(text) {
  return text.replace(/^\uFEFF/, '').trimStart().startsWith('BEGIN:VCALENDAR');
}

// En enskild hämtning. Cachen får aldrig användas som bevis för tillgänglighet:
// både förfrågan och svaret markeras som icke-cachebara.
async function fetchCalendarOnce(url, fetchImpl, timeoutMs) {
  const initial = trustedUrl(url);
  let current = initial;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(current, {
        signal: controller.signal,
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (response.body) await response.body.cancel();
        if (!location || redirects === 3) throw new CalendarFetchError('REDIRECT_INVALID');
        const next = trustedUrl(new URL(location, current).href);
        if (next.origin !== initial.origin) throw new CalendarFetchError('REDIRECT_UNTRUSTED');
        current = next;
        continue;
      }
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new CalendarFetchError(`HTTP_${response.status}`, retryableStatus(response.status));
      }
      if (!response.body) throw new CalendarFetchError('EMPTY_RESPONSE', true);
      if (!isCalendarContentType(response.headers.get('content-type'))) {
        throw new CalendarFetchError('INVALID_CONTENT_TYPE', true);
      }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
        throw new CalendarFetchError('RESPONSE_TOO_LARGE');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) {
          controller.abort();
          throw new CalendarFetchError('RESPONSE_TOO_LARGE');
        }
        chunks.push(chunk);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (!looksLikeCalendar(text)) throw new CalendarFetchError('INVALID_FORMAT', true);
      return {
        text,
        lastModified: response.headers.get('last-modified') ?? '',
        etag: response.headers.get('etag') ?? ''
      };
    }
    throw new CalendarFetchError('REDIRECT_INVALID');
  } catch (error) {
    if (error instanceof CalendarFetchError) throw error;
    throw new CalendarFetchError(timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', true);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Begränsade återförsök: endast nätverksfel, timeout, 429 och 5xx försöks igen.
// Svaret är alltid en ny HTTP-hämtning — aldrig ett cachat kalenderobjekt.
async function fetchCalendarWithMeta(url, fetchImpl, timeoutOrOptions = FETCH_TIMEOUT_MS) {
  const options = typeof timeoutOrOptions === 'number'
    ? { timeoutMs: timeoutOrOptions }
    : (timeoutOrOptions ?? {});
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts ?? MAX_ATTEMPTS), 3));
  const retryDelayMs = Number(options.retryDelayMs ?? RETRY_DELAY_MS);
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchCalendarOnce(url, fetchImpl, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!(error instanceof CalendarFetchError) || !error.retryable) throw error;
      if (attempt + 1 < maxAttempts) await delay(retryDelayMs);
    }
  }
  throw lastError;
}

async function fetchCalendar(url, fetchImpl, timeoutOrOptions = FETCH_TIMEOUT_MS) {
  return (await fetchCalendarWithMeta(url, fetchImpl, timeoutOrOptions)).text;
}

function parseCalendarWithMeta(text, start, end, timeoutMs = PARSE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'calendar-worker.js'), {
      workerData: { text, start, end },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error('Calendar could not be parsed'));
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(true);
      worker.terminate();
    }, timeoutMs);
    worker.once('message', (message) => {
      if (!message || !Array.isArray(message.blocked)) finish(true);
      else finish(false, {
        blocked: message.blocked,
        meta: {
          eventCount: Number(message.meta?.eventCount ?? 0),
          fingerprint: String(message.meta?.fingerprint ?? '')
        }
      });
    });
    worker.once('error', () => finish(true));
    worker.once('exit', (code) => {
      if (!settled || code !== 0) finish(true);
    });
  });
}

async function parseCalendar(text, start, end, timeoutMs = PARSE_TIMEOUT_MS) {
  return (await parseCalendarWithMeta(text, start, end, timeoutMs)).blocked;
}

async function recordStatus(options, outcome, now) {
  if (options.recordStatus === false) return;
  const store = options.calendarStatusStore;
  if (!store) return;
  try {
    await recordCalendarStatus(store, outcome, now, { force: options.forceStatusWrite === true });
  } catch {
    // Statusinspelningen får aldrig påverka tillgänglighetskontrollen.
  }
}

async function handleAvailability(request, context, options = {}) {
  const query = request.query;
  if (!validateRange(query)) {
    return { status: 400, headers, jsonBody: { error: 'Ogiltigt datumintervall.' } };
  }
  const now = options.now ?? new Date();
  const from = query.get('start');
  const to = query.get('end');
  const statusSource = options.statusSource ?? 'availability';
  const store = options.calendarStatusStore;
  let stage = 'konfiguration';
  let previous = null;
  let statusLookupFailed = false;
  if (store && typeof store.getCalendarSyncStatus === 'function') {
    try {
      previous = await store.getCalendarSyncStatus();
    } catch {
      statusLookupFailed = true;
    }
  }
  if (statusLookupFailed && options.calendarSafetyEnabled !== false &&
      options.calendarSafetyRequired !== false) {
    await recordStatus(options, {
      ok: false,
      errorCode: 'CALENDAR_STATUS_UNAVAILABLE',
      source: statusSource,
      from,
      to
    }, now);
    context?.warn?.('Kalenderns säkerhetsstatus kunde inte läsas.');
    return {
      status: 503,
      headers,
      jsonBody: {
        error: 'Tillgängligheten kan inte verifieras säkert just nu.',
        code: 'CALENDAR_STATUS_UNAVAILABLE'
      }
    };
  }
  try {
    const configuredUrl = options.calendarUrl ?? process.env.AIRBNB_ICAL_URL;
    if (!configuredUrl) throw new CalendarFetchError('NOT_CONFIGURED');
    stage = 'hämtning';
    const fetched = await fetchCalendarWithMeta(
      configuredUrl,
      options.fetchImpl || fetch,
      { timeoutMs: options.fetchTimeoutMs, maxAttempts: options.fetchMaxAttempts }
    );
    stage = 'tolkning';
    const parsed = await parseCalendarWithMeta(fetched.text, from, to, options.parseTimeoutMs);
    const blocked = parsed.blocked;
    const current = {
      eventCount: parsed.meta.eventCount,
      fingerprint: parsed.meta.fingerprint,
      lastModified: fetched.lastModified,
      etag: fetched.etag,
      blockedCount: blocked.length
    };
    const safety = options.calendarSafetyEnabled === false || !previous
      ? null
      : evaluateCalendarSafety({ previous, current, from, to, now });
    const suspect = safety?.status === 'suspect';
    if (suspect) {
      await recordStatus(options, {
        ok: false,
        errorCode: safety.code,
        source: statusSource,
        from,
        to,
        eventCount: current.eventCount,
        fingerprint: current.fingerprint,
        lastModified: current.lastModified,
        calendarEtag: current.etag,
        candidate: options.safetyReportOnly === true,
        ...(options.safetyReportOnly === true
          ? { snapshotFrom: from, snapshotTo: to, snapshotNights: blocked }
          : {}),
        safety
      }, now);
      if (options.safetyReportOnly !== true) {
        context?.warn?.(`Kalenderns tillgänglighet kunde inte verifieras säkert (${safety.code}).`);
        return {
          status: 503,
          headers,
          jsonBody: {
            error: 'Tillgängligheten kan inte verifieras säkert just nu.',
            code: safety.code
          }
        };
      }
    } else {
      await recordStatus(options, {
        ok: true,
        blockedCount: blocked.length,
        nightsChecked: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY),
        source: statusSource,
        from,
        to,
        eventCount: current.eventCount,
        fingerprint: current.fingerprint,
        lastModified: current.lastModified,
        calendarEtag: current.etag,
        safety
      }, now);
    }
    const jsonBody = { blocked };
    if (options.includeMeta === true) {
      jsonBody.meta = {
        eventCount: current.eventCount,
        fingerprint: current.fingerprint,
        lastModified: current.lastModified,
        etag: current.etag
      };
    }
    if (options.includeSafety === true || options.safetyReportOnly === true) {
      jsonBody.safety = safety;
    }
    return { status: 200, headers, jsonBody };
  } catch (error) {
    const code = error instanceof CalendarFetchError
      ? error.code
      : (stage === 'hämtning' ? 'FETCH_FAILED' : 'PARSE_ERROR');
    await recordStatus(options, {
      ok: false,
      errorCode: code,
      source: statusSource,
      from,
      to
    }, now);
    context?.warn?.(`Kalenderns tillgänglighet kunde inte läsas (${stage}).`);
    return { status: 503, headers, jsonBody: { error: 'Tillgängligheten är för tillfället okänd.' } };
  }
}

module.exports = {
  handleAvailability,
  fetchCalendar,
  fetchCalendarWithMeta,
  parseCalendar,
  parseCalendarWithMeta,
  validateRange,
  CalendarFetchError,
  MAX_BYTES,
  MAX_ATTEMPTS
};
