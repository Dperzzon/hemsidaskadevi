'use strict';

// Enhetstester för kanonisk omdirigering: skadeviherrgard.com -> www.
// Verifierar att endast exakt rotdomän omdirigeras, att API:et aldrig
// omdirigeras, att Azure-standarddomänen fungerar och att inga loopar uppstår.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequestListener } = require('../../server/index');

function withTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skadevi-redirect-'));
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>START</html>');
  fs.writeFileSync(path.join(root, 'pages', 'priser.html'), '<html>PRISER</html>');
  return root;
}

function createListener() {
  let bookingCalls = 0;
  const listener = createRequestListener({
    root: withTempRoot(),
    warn: () => {},
    availabilityHandler: async () => ({ status: 200, jsonBody: { ok: true } }),
    rulesHandler: async () => ({ published: false, version: null, text: '' }),
    bookingHandler: async () => {
      bookingCalls += 1;
      return { status: 201, jsonBody: { reference: 'TEST-1' } };
    }
  });
  return { listener, bookingCalls: () => bookingCalls };
}

async function start(listener) {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function request(server, pathname, { host, method = 'GET', body } = {}) {
  const { port } = server.address();
  const headers = {};
  if (host) headers.host = host;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function close(server) {
  server.closeAllConnections();
  server.close();
}

test('rotdomänen 301-omdirigeras till www (sökväg och query bevaras)', async () => {
  const { listener } = createListener();
  const server = await start(listener);
  try {
    const home = await request(server, '/', { host: 'skadeviherrgard.com' });
    assert.equal(home.status, 301);
    assert.equal(home.headers.location, 'https://www.skadeviherrgard.com/');

    const page = await request(server, '/priser?x=1', { host: 'skadeviherrgard.com' });
    assert.equal(page.status, 301);
    assert.equal(page.headers.location, 'https://www.skadeviherrgard.com/priser?x=1');

    const head = await request(server, '/priser', { host: 'skadeviherrgard.com', method: 'HEAD' });
    assert.equal(head.status, 301);

    // Host med port och versaler ska normaliseras.
    const withPort = await request(server, '/', { host: 'SKADEVIHERRGARD.COM:443' });
    assert.equal(withPort.status, 301);
  } finally {
    close(server);
  }
});

test('www, azurewebsites.net och okända värdar serveras utan omdirigering (inga loopar)', async () => {
  const { listener } = createListener();
  const server = await start(listener);
  try {
    for (const host of [
      'www.skadeviherrgard.com',
      'hemsida-skadevi-prod.azurewebsites.net',
      'localhost:3000',
      'example.com'
    ]) {
      const res = await request(server, '/priser', { host });
      assert.equal(res.status, 200, `host ${host} ska serveras direkt`);
      assert.equal(res.headers.location, undefined, `host ${host} ska inte omdirigeras`);
    }
  } finally {
    close(server);
  }
});

test('API:et påverkas inte av omdirigeringen (GET och POST når servern)', async () => {
  const { listener, bookingCalls } = createListener();
  const server = await start(listener);
  try {
    const rules = await request(server, '/api/booking-rules', { host: 'skadeviherrgard.com' });
    assert.equal(rules.status, 200);
    assert.equal(rules.headers.location, undefined);

    const availability = await request(server, '/api/availability', { host: 'skadeviherrgard.com' });
    assert.equal(availability.status, 200);

    const booking = await request(server, '/api/booking-requests', {
      host: 'skadeviherrgard.com',
      method: 'POST',
      body: '{}'
    });
    assert.equal(booking.status, 201);
    assert.equal(bookingCalls(), 1, 'POST ska nå bokningshandlern, inte omdirigeras');
  } finally {
    close(server);
  }
});

test('omdirigeringen kan stängas av och konfigureras', async () => {
  const root = withTempRoot();
  const listener = createRequestListener({
    root,
    warn: () => {},
    canonicalRedirect: false,
    availabilityHandler: async () => ({ status: 200, jsonBody: {} }),
    rulesHandler: async () => ({}),
    bookingHandler: async () => ({ status: 201, jsonBody: {} })
  });
  const server = await start(listener);
  try {
    const res = await request(server, '/', { host: 'skadeviherrgard.com' });
    assert.equal(res.status, 200, 'avstängd omdirigering ska servera sidan');
  } finally {
    close(server);
  }
});
