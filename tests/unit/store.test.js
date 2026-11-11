// Enhetstester för lagringsadaptern (server/booking/store.js):
// Managed Identity/Entra-autentisering, SharedKey-reserv, persistens,
// idempotens, utkorg och gallring.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createStore, createTableStore, createLocalStore,
  createManagedIdentityTokenProvider, createTokenCache, hasManagedIdentity,
  toEntity, fromEntity, toOutboxEntity, fromOutboxEntity, sharedKeySignature
} = require('../../server/booking/store');

function baseRecord(overrides = {}) {
  return {
    idempotencyKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    reference: 'SK-2026-TEST01',
    status: 'Inväntar godkännande',
    arrival: '2026-11-20',
    departure: '2026-11-23',
    nights: 3,
    guests: 2,
    firstName: 'Anna',
    lastName: 'Andersson',
    email: 'anna@example.com',
    replyTo: '',
    phone: '+4670123456',
    company: '',
    message: '',
    addons: { slutstad: false, lakan: false, linenCount: 0, ved: false, tidigIncheckning: false, senUtcheckning: false },
    totalAddons: 0,
    discount: null,
    rulesVersion: '2026-11-10-v2',
    consentContact: false,
    createdAt: '2026-11-10T12:00:00.000Z',
    ...overrides
  };
}

test('hasManagedIdentity upptäcker App Service-miljön', () => {
  assert.equal(hasManagedIdentity({ identityEndpoint: 'http://169.254.129.6/msi/token', identityHeader: 'x' }), true);
  assert.equal(hasManagedIdentity({}), false);
});

test('Managed Identity-tokentjänsten anropas med rätt resurs och header', async () => {
  let called = null;
  const provider = createManagedIdentityTokenProvider({
    identityEndpoint: 'http://169.254.129.6:8081/msi/token',
    identityHeader: 'secret-header',
    clientId: 'user-assigned-id',
    scope: 'https://storage.azure.com/',
    fetchImpl: async (url, init) => {
      called = { url: String(url), header: init.headers['X-IDENTITY-HEADER'] };
      return { ok: true, json: async () => ({ access_token: 'token-1', expires_on: '4102444800' }) };
    }
  });
  const token = await provider.getToken();
  assert.equal(token.accessToken, 'token-1');
  assert.match(called.url, /resource=https%3A%2F%2Fstorage\.azure\.com%2F/);
  assert.match(called.url, /client_id=user-assigned-id/);
  assert.match(called.url, /api-version=2019-08-01/);
  assert.equal(called.header, 'secret-header');
});

test('token-cachen återanvänder token tills den nästan löper ut', async () => {
  let count = 0;
  const cache = createTokenCache({
    async getToken() {
      count += 1;
      return { accessToken: `token-${count}`, expiresOn: Math.floor(Date.now() / 1000) + 3600 };
    }
  });
  await cache.getToken();
  await cache.getToken();
  assert.equal(count, 1);
  cache.reset();
  await cache.getToken();
  assert.equal(count, 2);
});

test('tabellager i managed-identity-läge använder Bearer och OAuth-version', async () => {
  const headers = [];
  const tokenProvider = createManagedIdentityTokenProvider({
    identityEndpoint: 'http://169.254.129.6:8081/msi/token',
    identityHeader: 'h',
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'token-1', expires_on: '4102444800' }) })
  });
  const store = createTableStore({
    accountName: 'skadevibokningar',
    authMode: 'managed-identity',
    tokenProvider,
    fetchImpl: async (url, init) => {
      headers.push(init.headers);
      return { status: 201, headers: new Map([['content-length', '0']]), text: async () => '' };
    }
  });
  await store.save(baseRecord());
  assert.match(headers[0].Authorization, /^Bearer token-1$/);
  assert.equal(headers[0]['x-ms-version'], '2019-02-02');
});

test('tabellager i managed-identity-läge utan identitetsservice misslyckas tydligt', async () => {
  const store = createTableStore({
    accountName: 'skadevibokningar',
    authMode: 'managed-identity',
    fetchImpl: async () => { throw new Error('ska inte anropas'); }
  });
  await assert.rejects(() => store.save(baseRecord()), /Managed Identity är inte tillgänglig/);
});

test('createStore väljer lokal lagring utan Azure-konfiguration', () => {
  const store = createStore({ forceLocal: true });
  assert.equal(store.type, 'local-jsonl');
});

test('createStore kräver identitet eller nyckel för tabellager', () => {
  assert.throws(() => createTableStore({ accountName: 'skadevibokningar', authMode: 'shared-key' }), /varken Managed Identity eller nyckel/);
});

test('SharedKey-signering signerar kodade frågeparametrar', () => {
  const signature = sharedKeySignature('konto', Buffer.from('nyckel').toString('base64'),
    'GET', '/bookingrequests()', '', 'Mon, 10 Nov 2026 12:00:00 GMT', {}, [['$filter', encodeURIComponent('status eq \'x\'')]]);
  assert.match(signature, /^[A-Za-z0-9+/=]+$/);
});

test('entitetsmappning bevarar alla fält och rabatten', () => {
  const record = baseRecord({ discount: { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69 } });
  const entity = toEntity(record, 'request');
  const round = fromEntity(entity);
  assert.deepEqual(round.discount, record.discount);
  assert.equal(round.consentContact, false);
  assert.equal(entity.PartitionKey, 'request');
});

test('utkorgsentiteten innehåller mejlmall och försöksräknare', () => {
  const record = {
    partition: 'outbox',
    idempotencyKey: 'outbox-1-host',
    status: 'Utkorg',
    mailTo: 'skadevigard@gmail.com',
    mailReplyTo: 'skadevigard@gmail.com',
    mailSubject: 'Bokningsförfrågan SK-2026-TEST01',
    mailHtml: '<p>Hej</p>',
    mailText: 'Hej',
    attemptCount: 0,
    createdAt: '2026-11-10T12:00:00.000Z'
  };
  const round = fromOutboxEntity(toOutboxEntity(record));
  assert.equal(round.mailTo, record.mailTo);
  assert.equal(round.mailHtml, record.mailHtml);
  assert.equal(round.mailText, record.mailText);
  assert.equal(round.attemptCount, 0);
  assert.equal(toOutboxEntity(record).PartitionKey, 'outbox');
});

test('lokal lagring: persistens över processer (läs från fil)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skadevi-store-'));
  const file = path.join(dir, 'booking-requests.jsonl');
  const first = createLocalStore({ file });
  await first.save(baseRecord());
  const second = createLocalStore({ file });
  const found = await second.findByIdempotencyKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(found.reference, 'SK-2026-TEST01');
  assert.equal(found.status, 'Inväntar godkännande');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('samma idempotensnyckel två gånger ger samma post (dubbelinskick)', async () => {
  const store = createLocalStore({ file: path.join(os.tmpdir(), `skadevi-${Date.now()}.jsonl`) });
  const first = await store.save(baseRecord());
  const second = await store.save(baseRecord());
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.record.reference, first.record.reference);
});

test('olika idempotensnycklar för samma period kan sparas samtidigt (ingen atomär låsning)', async () => {
  const store = createLocalStore({ file: path.join(os.tmpdir(), `skadevi-${Date.now()}.jsonl`) });
  const [a, b] = await Promise.all([
    store.save(baseRecord({ idempotencyKey: 'nyckel-aaaaaaaaaaaaaaaa' })),
    store.save(baseRecord({ idempotencyKey: 'nyckel-bbbbbbbbbbbbbbbb', reference: 'SK-2026-TEST02' }))
  ]);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false);
  assert.equal((await store.listPending()).length, 2, 'båda ligger väntande — Skadevi avgör överlapp');
});

test('findByReference hittar poster och listPending filtrerar på status', async () => {
  const store = createLocalStore({ file: path.join(os.tmpdir(), `skadevi-${Date.now()}.jsonl`) });
  await store.save(baseRecord());
  assert.ok(await store.findByReference('SK-2026-TEST01'));
  assert.equal(await store.findByReference('SK-2026-INGEN'), null);
  // Utkorgsposter är inte "väntande" förfrågningar.
  await store.save({
    partition: 'outbox', idempotencyKey: 'outbox-x', status: 'Utkorg',
    mailTo: 'skadevigard@gmail.com', mailReplyTo: '', mailSubject: 's', mailHtml: 'h',
    attemptCount: 0, createdAt: '2026-11-10T12:00:00.000Z'
  });
  assert.equal((await store.listPending()).length, 1);
});

test('gallring tar bara bort poster äldre än tröskeln', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skadevi-purge-'));
  const file = path.join(dir, 'booking-requests.jsonl');
  const store = createLocalStore({ file });
  await store.save(baseRecord()); // 2026-11-10
  await store.save(baseRecord({ idempotencyKey: 'nyckel-gammal-00000001', reference: 'SK-2026-OLD001', createdAt: '2024-01-01T00:00:00.000Z' }));
  await store.save({
    partition: 'outbox', idempotencyKey: 'outbox-gammal', status: 'Utkorg',
    mailTo: 'skadevigard@gmail.com', mailReplyTo: '', mailSubject: 's', mailHtml: 'h',
    attemptCount: 0, createdAt: '2024-01-01T00:00:00.000Z'
  });
  const purged = await store.purgeOlderThan('2026-01-01T00:00:00.000Z');
  assert.equal(purged, 2);
  assert.ok(await store.findByReference('SK-2026-TEST01'));
  assert.equal(await store.findByReference('SK-2026-OLD001'), null);
  // Filen har skrivits om utan de gallrade posterna.
  const content = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(content, /OLD001/);
  assert.match(content, /TEST01/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tabellager: misslyckat sparande (5xx) kastar så att förfrågan aldrig visas som mottagen', async () => {
  const store = createTableStore({
    accountName: 'skadevibokningar',
    authMode: 'managed-identity',
    tokenProvider: createManagedIdentityTokenProvider({
      identityEndpoint: 'http://x', identityHeader: 'h',
      fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_on: '4102444800' }) })
    }),
    fetchImpl: async () => ({ status: 500, headers: new Map(), text: async () => '{}' })
  });
  await assert.rejects(() => store.save(baseRecord()), /kunde inte sparas/);
});
