'use strict';

// Schemalagd övervakning av Airbnb-importen med befintlig App Service-infra.
//
// Ingen ny Azure-resurs skapas. En lättvikts timer i den publika appen hämtar
// kalendern med jämna intervall, validerar innehållet och jämför importerade
// Airbnb-blockeringar mot den interna kalendern. Resultatet sparas som
// synkstatus och visas i adminportalen. Inga mejl eller Resend-flöden används.
//
// Timern är alltid unref:ad och startar bara i serverprocessen, aldrig i tester.

const { handleAvailability } = require('./availability');
const { recordCalendarStatus } = require('./sync-status');
const { createStore } = require('../booking/store');

const DAY = 86400000;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_HORIZON_DAYS = 400;

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function addDays(dateKey, count) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

// Tillgänglighets-API:t tar emot högst 93 dagar per anrop. Övervakningen delar
// därför upp horisonten i kortare fönster och slår ihop resultaten.
function windows(from, to, maxDays = 90) {
  const result = [];
  let start = from;
  while (start < to) {
    let end = addDays(start, maxDays);
    if (end > to) end = to;
    result.push({ start, end });
    start = end;
  }
  return result;
}

function internalNights(rows) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => (row.resource ?? 'main') === 'main')
      .filter((row) => ['BOOKING', 'MANUAL', 'RESERVATION'].includes(String(row.type ?? '').toUpperCase()))
      .filter((row) => !['AIRBNB', 'ICAL'].includes(String(row.source ?? '').toUpperCase()))
      .map((row) => String(row.night ?? row.RowKey ?? ''))
      .filter((night) => /^\d{4}-\d{2}-\d{2}$/.test(night))
  );
}

function createCalendarMonitor(options = {}) {
  const intervalMinutes = Number(
    options.intervalMinutes ?? process.env.CALENDAR_SYNC_MONITOR_MINUTES ?? DEFAULT_INTERVAL_MINUTES
  );
  let timer = null;
  let initialTimer = null;
  let running = false;
  let stopped = false;

  async function checkNow() {
    if (running || stopped) return null;
    running = true;
    try {
      const now = options.now?.() ?? new Date();
      const from = todayKey(now);
      const horizonDays = Number(options.horizonDays ?? DEFAULT_HORIZON_DAYS);
      const to = addDays(from, Math.max(1, Math.min(horizonDays, 730)));
      const store = options.store ?? createStore(options);
      const blocked = [];
      for (const window of windows(from, to)) {
        const result = await handleAvailability(
          { query: new URLSearchParams({ start: window.start, end: window.end }) },
          { warn: options.warn },
          {
            ...(options.availability ?? {}),
            calendarStatusStore: store,
            forceStatusWrite: true,
            statusSource: 'monitor',
            now
          }
        );
        if (result.status !== 200 || !Array.isArray(result.jsonBody?.blocked)) return null;
        blocked.push(...result.jsonBody.blocked);
      }
      let conflicts = [];
      try {
        const rows = await store.listCalendar(from, to);
        const internal = internalNights(rows);
        conflicts = blocked.filter((night) => internal.has(night)).slice(0, 100);
      } catch {
        conflicts = [];
      }
      await recordCalendarStatus(store, {
        ok: true,
        blockedCount: blocked.length,
        nightsChecked: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY),
        conflicts,
        source: 'monitor',
        from,
        to
      }, now, { force: true });
      return { ok: true, blocked, conflicts };
    } catch (error) {
      if (options.debug) console.error('Kalenderövervakning:', error);
      return null;
    } finally {
      running = false;
    }
  }

  if (Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
    timer = setInterval(() => { checkNow().catch(() => {}); }, intervalMinutes * 60000);
    timer.unref?.();
    const initialDelayMs = Number(options.initialDelayMs ?? 30000);
    initialTimer = setTimeout(() => { checkNow().catch(() => {}); }, Math.max(0, initialDelayMs));
    initialTimer.unref?.();
  }

  return {
    async checkNow() {
      stopped = false;
      return checkNow();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (initialTimer) clearTimeout(initialTimer);
      timer = null;
      initialTimer = null;
    },
    intervalMinutes: Number.isFinite(intervalMinutes) ? intervalMinutes : 0
  };
}

module.exports = {
  createCalendarMonitor,
  internalNights,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_HORIZON_DAYS
};
