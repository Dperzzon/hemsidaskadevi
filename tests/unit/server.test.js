'use strict';

// Enhetstester för produktionsservern (server/index.js) mot en tillfällig
// dist-liknande katalogstruktur.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequestListener } = require('../../server/index');

function withTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skadevi-server-'));
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>STARTSIDA</html>');
  fs.writeFileSync(path.join(root, '404.html'), '<html>INTE HITTAD</html>');
  fs.writeFileSync(path.join(root, 'pages', 'priser.html'), '<html>PRISER</html>');
  fs.writeFileSync(path.join(root, 'css', 'style.css'), 'body { color: black; }');
  fs.writeFileSync(path.join(root, 'robots.txt'), 'User-agent: *\n');
  return root;
}

function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function close(server) {
  server.closeAllConnections();
  server.close();
}

test('serverar startsidan på /', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /STARTSIDA/);
  } finally { close(server); }
});

test('serverar rena URL:er enligt sitemap', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/priser');
    assert.equal(res.status, 200);
    assert.match(res.body, /PRISER/);
  } finally { close(server); }
});

test('omdirigerar gamla .html-URL:er till rena URL:er', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    for (const [from, to] of [
      ['/pages/priser.html', '/priser'],
      ['/priser.html', '/priser'],
      ['/index.html', '/'],
      ['/pages/index.html', '/']
    ]) {
      const res = await request(port, from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.location, to, from);
    }
  } finally { close(server); }
});

test('anger korrekt MIME-typ för css', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/css/style.css');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/css/);
  } finally { close(server); }
});

test('serverar brotli-komprimerad variant när den finns', async () => {
  const root = withTempRoot();
  fs.writeFileSync(path.join(root, 'css', 'style.css.br'), Buffer.from([0x1b, 0x2d, 0x00, 0x90]));
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/css/style.css', { 'Accept-Encoding': 'br, gzip' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    assert.match(res.headers.vary, /Accept-Encoding/);
  } finally { close(server); }
});

test('svarar 304 vid oförändrad ETag', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const first = await request(port, '/css/style.css');
    const etag = first.headers.etag;
    assert.ok(etag);
    const res = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/css/style.css', headers: { 'If-None-Match': etag } }, (res2) => {
        res2.resume();
        res2.on('end', () => resolve({ status: res2.statusCode }));
      });
      req.on('error', reject);
    });
    assert.equal(res.status, 304);
  } finally { close(server); }
});

test('blockerar path traversal', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    for (const pathname of ['/%2e%2e%2fpackage.json', '/css/../../package.json', '/images/%2e%2e/%2e%2e/server.js']) {
      const res = await request(port, pathname);
      assert.equal(res.status, 404, pathname);
      assert.ok(!res.body.includes('{'), `${pathname} läckte filinnehåll`);
    }
  } finally { close(server); }
});

test('serverar 404-sida för okända sökvägar (ingen SPA-fallback)', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/saknad-sida');
    assert.equal(res.status, 404);
    assert.match(res.body, /INTE HITTAD/);
  } finally { close(server); }
});

test('tjänster server- och konfigurationsfiler inte till publiken', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    for (const pathname of ['/server.js', '/package.json', '/infra/main.bicep', '/server/index.js']) {
      const res = await request(port, pathname);
      assert.equal(res.status, 404, pathname);
    }
  } finally { close(server); }
});

test('/api/availability anropar kalenderhanteraren', async () => {
  const root = withTempRoot();
  let received = null;
  const server = await listen(createRequestListener({
    root,
    availabilityHandler: async (request2) => {
      received = request2;
      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { blocked: [] } };
    }
  }));
  try {
    const res = await request(server.address().port, '/api/availability?start=2026-01-01&end=2026-01-31');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { blocked: [] });
    assert.equal(received.query.get('start'), '2026-01-01');
  } finally { close(server); }
});

test('/api/availability avvisar ogiltigt intervall med 400', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({
    root,
    availabilityHandler: (request2, context) => require('../../server/calendar/availability').handleAvailability(request2, context)
  }));
  try {
    const res = await request(server.address().port, '/api/availability?start=2026-01-01');
    assert.equal(res.status, 400);
  } finally { close(server); }
});

test('/api/availability svarar 503 när kalendern inte är konfigurerad', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({
    root,
    availabilityHandler: (request2, context) => require('../../server/calendar/availability').handleAvailability(request2, context, { calendarUrl: undefined })
  }));
  try {
    const res = await request(server.address().port, '/api/availability?start=2026-01-01&end=2026-01-31');
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'Tillgängligheten är för tillfället okänd.' });
  } finally { close(server); }
});

test('okänd metod avvisas med 405', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST' }, (res2) => {
        res2.resume();
        res2.on('end', () => resolve({ status: res2.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 405);
  } finally { close(server); }
});

function post(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, (res2) => {
      let raw = '';
      res2.on('data', (chunk) => { raw += chunk; });
      res2.on('end', () => resolve({ status: res2.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('/api/booking-rules serverar de publicerade beslutade reglerna', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/api/booking-rules');
    assert.equal(res.status, 200);
    const rules = JSON.parse(res.body);
    assert.equal(rules.published, true);
    assert.equal(rules.version, '2026-11-10-v2');
    assert.match(rules.text, /100 % återbetalning/);
    assert.match(rules.text, /Inga katter/);
  } finally { close(server); }
});

test('POST /api/booking-requests nekas när reglerna inte är publicerade', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await post(server.address().port, '/api/booking-requests', { arrival: '2026-11-20' });
    assert.equal(res.status, 503);
  } finally { close(server); }
});

test('POST /api/booking-requests skickar vidare till injicerad hanterare', async () => {
  const root = withTempRoot();
  let received = null;
  const server = await listen(createRequestListener({
    root,
    bookingHandler: async (req) => {
      received = req;
      return { status: 201, jsonBody: { reference: 'SK-2026-TEST01' } };
    }
  }));
  try {
    const res = await post(server.address().port, '/api/booking-requests', { firstName: 'Anna' }, { 'Idempotency-Key': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(res.status, 201);
    assert.equal(JSON.parse(res.body).reference, 'SK-2026-TEST01');
    assert.equal(received.body.firstName, 'Anna');
    assert.equal(received.idempotencyKey, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  } finally { close(server); }
});

test('POST med felaktig JSON avvisas med 400', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/booking-requests', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res2) => {
        let raw = '';
        res2.on('data', (chunk) => { raw += chunk; });
        res2.on('end', () => resolve({ status: res2.statusCode, body: raw }));
      });
      req.on('error', reject);
      req.end('{ogiltigt');
    });
    assert.equal(res.status, 400);
  } finally { close(server); }
});
