'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const PARSE_TIMEOUT_MS = 10000;
const DAY = 86400000;
const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };

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
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid calendar configuration');
  return url;
}

async function fetchCalendar(url, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS) {
  const initial = trustedUrl(url);
  let current = initial;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'text/calendar' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (response.body) await response.body.cancel();
        if (!location || redirects === 3) throw new Error('Invalid calendar redirect');
        const next = trustedUrl(new URL(location, current).href);
        if (next.origin !== initial.origin) throw new Error('Untrusted calendar redirect');
        current = next;
        continue;
      }
      if (!response.ok || !response.body) throw new Error('Calendar source error');
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
        throw new Error('Calendar response too large');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) {
          controller.abort();
          throw new Error('Calendar response too large');
        }
        chunks.push(chunk);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    }
    throw new Error('Invalid calendar redirect');
  } finally {
    clearTimeout(timer);
  }
}

function parseCalendar(text, start, end, timeoutMs = PARSE_TIMEOUT_MS) {
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
      else finish(false, message.blocked);
    });
    worker.once('error', () => finish(true));
    worker.once('exit', (code) => {
      if (!settled || code !== 0) finish(true);
    });
  });
}

async function handleAvailability(request, context, options = {}) {
  const query = request.query;
  if (!validateRange(query)) {
    return { status: 400, headers, jsonBody: { error: 'Ogiltigt datumintervall.' } };
  }
  let stage = 'konfiguration';
  try {
    const configuredUrl = options.calendarUrl ?? process.env.AIRBNB_ICAL_URL;
    if (!configuredUrl) throw new Error('Calendar not configured');
    stage = 'hämtning';
    const text = await fetchCalendar(configuredUrl, options.fetchImpl || fetch, options.fetchTimeoutMs);
    stage = 'tolkning';
    const blocked = await parseCalendar(text, query.get('start'), query.get('end'), options.parseTimeoutMs);
    return { status: 200, headers, jsonBody: { blocked } };
  } catch {
    context.warn(`Kalenderns tillgänglighet kunde inte läsas (${stage}).`);
    return { status: 503, headers, jsonBody: { error: 'Tillgängligheten är för tillfället okänd.' } };
  }
}

module.exports = { handleAvailability, fetchCalendar, parseCalendar, validateRange, MAX_BYTES };
