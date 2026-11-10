'use strict';

// Lokal testserver med syntetisk kalender. Serverar dist/ via produktionsservern
// och simulerar olika kalenderscenarier på /api/availability.
//
// Användning: node scripts/mock-server.cjs [scenario] [port]
// Scenarier: success (default), empty, invalid, network, unconfigured, timeout

const http = require('node:http');
const path = require('node:path');
const { createRequestListener } = require('../server/index');

const scenario = process.argv[2] || 'success';
const port = Number(process.argv[3] || 18743);
const scenarios = ['success', 'empty', 'invalid', 'network', 'unconfigured', 'timeout'];
if (!scenarios.includes(scenario) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Ange scenario: ${scenarios.join(', ')}, samt valfri port.`);
  process.exit(1);
}

function fixture(start) {
  const first = new Date(`${start}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() + 2);
  const last = new Date(first);
  last.setUTCDate(last.getUTCDate() + 2);
  const date = (value) => value.toISOString().slice(0, 10).replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Test//EN'];
  if (scenario !== 'empty') {
    lines.push('BEGIN:VEVENT', 'UID:synthetic-event', `DTSTART;VALUE=DATE:${date(first)}`,
      `DTEND;VALUE=DATE:${date(last)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}

function mockFetch(start) {
  if (scenario === 'network') return async () => { throw new Error('Simulerat nätverksfel'); };
  if (scenario === 'timeout') {
    return (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Simulerad timeout')));
    });
  }
  return async () => new Response(scenario === 'invalid' ? 'INVALID' : fixture(start));
}

const listener = createRequestListener({
  availability: {
    calendarUrl: scenario === 'unconfigured' ? '' : 'https://calendar.example.test/synthetic.ics',
    fetchImpl: (url, options) => mockFetch(new URL(url).searchParams.get('start'))(url, options),
    fetchTimeoutMs: scenario === 'timeout' ? 20 : undefined
  }
});

const server = http.createServer(listener);
server.on('error', () => {
  console.error('Den lokala testservern kunde inte starta.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Lokal testserver: http://127.0.0.1:${port}/ (scenario: ${scenario})`);
});
