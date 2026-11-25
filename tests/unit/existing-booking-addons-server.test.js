'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequestListener } = require('../../server/index');

function withTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skadevi-addons-server-'));
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>STARTSIDA</html>');
  fs.writeFileSync(path.join(root, '404.html'), '<html>INTE HITTAD</html>');
  fs.writeFileSync(path.join(root, 'pages', 'boka.html'), '<html>BOKA</html>');
  fs.writeFileSync(path.join(root, 'pages', 'tillval-klar.html'), '<html>TILLVAL</html>');
  fs.writeFileSync(path.join(root, 'css', 'style.css'), 'body{}');
  return root;
}

function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method ?? 'GET',
      headers: options.headers ?? {}
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('booking-config visar att tillvalsfunktionen är avstängd som standard', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({
    root,
    existingBookingAddonsEnabled: false,
    stripeEnabled: false
  }));
  try {
    const res = await request(server.address().port, '/api/booking-config');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.existingBookingAddonsEnabled, false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('tillvals-API:t är kopplat och kräver same-origin för POST', async () => {
  const root = withTempRoot();
  let received = null;
  const server = await listen(createRequestListener({
    root,
    addonVerifyStartHandler: async (req) => {
      received = req;
      return { status: 202, headers: { 'Content-Type': 'application/json' }, jsonBody: { message: 'neutral' } };
    }
  }));
  try {
    const port = server.address().port;
    const blocked = await request(port, '/api/addons/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ reference: 'SK-2027-AB123', email: 'anna@example.com' })
    });
    assert.equal(blocked.status, 403);

    const ok = await request(port, '/api/addons/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ reference: 'SK-2027-AB123', email: 'anna@example.com' })
    });
    assert.equal(ok.status, 202);
    assert.equal(JSON.parse(ok.body).message, 'neutral');
    assert.equal(received.body.reference, 'SK-2027-AB123');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('resultatsidan /tillval-klar serveras utan att avslöja kunduppgifter', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root }));
  try {
    const res = await request(server.address().port, '/tillval-klar');
    assert.equal(res.status, 200);
    assert.match(res.body, /TILLVAL/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
