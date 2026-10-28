'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleAvailability } = require('../api/src/availability');

const root = path.resolve(__dirname, '..');
const scenario = process.argv[2] || 'success';
const port = Number(process.argv[3] || 18743);
const scenarios = ['success', 'empty', 'invalid', 'network', 'unconfigured', 'timeout'];
if (!scenarios.includes(scenario) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Ange scenario: success, empty, invalid, network, unconfigured eller timeout, samt valfri port.');
  process.exit(1);
}

function fixture(start) {
  const first = new Date(`${start}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() + 2);
  const last = new Date(first);
  last.setUTCDate(last.getUTCDate() + 2);
  const date = (value) => value.toISOString().slice(0, 10).replace(/-/g, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic Test//EN'
  ];
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

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif'
};
const allowedRoots = new Set(['pages', 'css', 'js', 'images']);
const allowedFiles = new Set(['index.html', 'robots.txt', 'sitemap.xml']);

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }
  let url;
  let parts;
  try {
    url = new URL(req.url, 'http://localhost');
    parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (url.pathname === '/api/availability') {
    const result = await handleAvailability(
      { query: url.searchParams },
      { warn: (message) => console.error(message) },
      {
        calendarUrl: scenario === 'unconfigured' ? '' : 'https://calendar.example.test/synthetic.ics',
        fetchImpl: mockFetch(url.searchParams.get('start')),
        fetchTimeoutMs: scenario === 'timeout' ? 20 : undefined
      }
    );
    res.writeHead(result.status, result.headers);
    res.end(JSON.stringify(result.jsonBody));
    return;
  }
  if (!parts.length) parts = ['index.html'];
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\\') || part.includes('\0')) ||
      !(parts.length === 1 && allowedFiles.has(parts[0])) && !allowedRoots.has(parts[0])) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = path.join(root, ...parts);
  fs.stat(file, (error, info) => {
    if (error || !info.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.once('error', () => {
      console.error('Den lokala resursen kunde inte läsas.');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    stream.pipe(res);
  });
});

server.on('error', () => {
  console.error('Den lokala testservern kunde inte starta.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Lokal testserver: http://127.0.0.1:${port}/ (scenario: ${scenario})`);
});
