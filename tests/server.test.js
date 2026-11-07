'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequestListener } = require('../server');

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

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('serverar startsidan på /', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /STARTSIDA/);
  } finally { server.close(); }
});

test('serverar rena URL:er enligt sitemap', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const res = await request(port, '/priser');
    assert.equal(res.status, 200);
    assert.match(res.body, /PRISER/);
  } finally { server.close(); }
});

test('anger korrekt MIME-typ för css', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const res = await request(port, '/css/style.css');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/css/);
  } finally { server.close(); }
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
  } finally { server.close(); }
});

test('serverar 404-sida för okända sökvägar', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const res = await request(port, '/saknad-sida');
    assert.equal(res.status, 404);
    assert.match(res.body, /INTE HITTAD/);
  } finally { server.close(); }
});

test('tjänster serverfilerna inte till publiken', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const res = await request(port, '/server.js');
    assert.equal(res.status, 404);
  } finally { server.close(); }
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
    const port = server.address().port;
    const res = await request(port, '/api/availability?start=2026-01-01&end=2026-01-31');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { blocked: [] });
    assert.equal(received.query.get('start'), '2026-01-01');
  } finally { server.close(); }
});

test('/api/availability avvisar ogiltigt intervall med 400', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({
    root,
    availabilityHandler: (request2, context) => require('../api/src/availability').handleAvailability(request2, context)
  }));
  try {
    const port = server.address().port;
    const res = await request(port, '/api/availability?start=2026-01-01');
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('/api/availability svarar 503 när kalendern inte är konfigurerad', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({
    root,
    availabilityHandler: (request2, context) => require('../api/src/availability').handleAvailability(request2, context, { calendarUrl: undefined })
  }));
  try {
    const port = server.address().port;
    const res = await request(port, '/api/availability?start=2026-01-01&end=2026-01-31');
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'Tillgängligheten är för tillfället okänd.' });
  } finally { server.close(); }
});

test('okänd metod avvisas med 405', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const port = server.address().port;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res2) => {
        let body = '';
        res2.on('data', (chunk) => { body += chunk; });
        res2.on('end', () => resolve({ status: res2.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 405);
  } finally { server.close(); }
});
