'use strict';

// Gamla Wix-adresser ska ge 301 till närmaste aktiva sida, eller 410 när
// ingen rimlig ersättning finns. Inga kedjor, inga massredirects till /.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequestListener } = require('../../server/index');
const { LEGACY_REDIRECTS, legacyRedirect } = require('../../server/seo/legacy-redirects');

const ACTIVE_ROUTES = new Set([
  '/', '/foretag', '/brollop', '/semester', '/fest', '/boende',
  '/aktiviteter', '/priser', '/mat-dryck', '/om-oss', '/vanliga-fragor',
  '/digital-visning', '/boka'
]);

function withTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skadevi-legacy-'));
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>START</html>');
  fs.writeFileSync(path.join(root, '404.html'), '<html>INTE HITTAD</html>');
  for (const route of ACTIVE_ROUTES) {
    if (route === '/') continue;
    fs.writeFileSync(path.join(root, 'pages', `${route.slice(1)}.html`), '<html>SIDA</html>');
  }
  return root;
}

function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: encodeURI(pathname) }, (res) => {
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

test('Wix-mappningen pekar bara på aktiva sidor och skapar inga loopar', () => {
  for (const [from, to] of LEGACY_REDIRECTS) {
    assert.ok(ACTIVE_ROUTES.has(to), `${from} pekar på okänd sida ${to}`);
    assert.ok(!LEGACY_REDIRECTS.has(to), `${from} skapar en redirect-kedja via ${to}`);
    // Endast den gamla dubbletten av startsidan och den gamla bildsidan får
    // gå till /. Startsidan innehåller det aktuella bildgalleriet. Övriga
    // gamla sidor ska till en innehållsmässigt relevant sida.
    if (to === '/') {
      assert.ok(
        ['/kopia-på-hem', '/kopia-pa-hem', '/kopla-pa-hem', '/bilder'].includes(from),
        from
      );
    }
  }
});

test('kända Wix-adresser ger 301 och bevarar query', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root, warn: () => {} }));
  try {
    const port = server.address().port;
    const cases = [
      ['/historia', '/om-oss'],
      ['/historia/', '/om-oss'],
      ['/historia.html', '/om-oss'],
      ['/team-4', '/aktiviteter'],
      ['/about-1', '/brollop'],
      ['/services-7', '/vanliga-fragor'],
      ['/firande', '/fest'],
      ['/event', '/fest'],
      ['/dopochbabyshower', '/fest'],
      ['/copy-of-dop-babyshower', '/fest'],
      ['/faciliteter', '/boende'],
      ['/matochdryck', '/mat-dryck'],
      ['/the-suite', '/boende'],
      ['/bilder', '/'],
      ['/bilder/', '/'],
      ['/bilder.html', '/'],
      ['/book-online', '/boka'],
      ['/book-online/', '/boka'],
      ['/kopla-pa-hem', '/'],
      ['/kopla-pa-hem/', '/'],
      ['/kopla-pa-hem.html', '/'],
      ['/kopia-pa-hem', '/'],
      ['/kopia-pa-hem/', '/'],
      ['/kopia-på-hem', '/'],
      ['/kopia-på-hem/', '/'],
      ['/kopia-på-utrustning-service', '/digital-visning'],
      ['/service-page/konferens', '/foretag'],
      ['/service-page/bröllop', '/brollop'],
      ['/product-page/brudklänning', '/brollop'],
      // Exakt adress som Search Console rapporterat som dubblett.
      ['/product-page/foretagsevent-upp-till-24-pers-2', '/foretag'],
      ['/product-page/foretagsevent-upp-till-24-pers-2/', '/foretag']
    ];
    for (const [from, to] of cases) {
      const res = await request(port, from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.location, to, from);
    }

    const query = await request(port, '/historia?utm_source=google');
    assert.equal(query.status, 301);
    assert.equal(query.headers.location, '/om-oss?utm_source=google');

    const duplicate = await request(
      port,
      '/product-page/foretagsevent-upp-till-24-pers-2?utm_source=google'
    );
    assert.equal(duplicate.status, 301);
    assert.equal(duplicate.headers.location, '/foretag?utm_source=google');
  } finally { close(server); }
});

test('okända Wix-malladresser ger 410 i stället för startsidan', async () => {
  const root = withTempRoot();
  const server = await listen(createRequestListener({ root, warn: () => {} }));
  try {
    const port = server.address().port;
    for (const from of ['/service-page', '/service-page/okand-sida', '/product-page', '/product-page/12345']) {
      const res = await request(port, from);
      assert.equal(res.status, 410, from);
      assert.equal(res.headers.location, undefined, from);
    }
  } finally { close(server); }
});

test('legacyRedirect är idempotent för aktiva sidor', () => {
  for (const route of ACTIVE_ROUTES) {
    assert.equal(legacyRedirect(route), null, `aktiv sida får inte omdirigeras: ${route}`);
  }
});
