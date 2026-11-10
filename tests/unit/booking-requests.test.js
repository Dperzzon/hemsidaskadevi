// Enhetstester för bokningsförfrågningar (server/booking/requests.js):
// validering, tillgänglighetskontroll, idempotens, regler och missbruksskydd.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleBookingRequest, validatePayload, nightKeys, createRateLimiter, buildNotifications } = require('../../server/booking/requests');

const RULES = { published: true, version: 'test-2026-11-10', text: '1. Regel ett.\n2. Regel två.' };

function validBody(overrides = {}) {
  return {
    arrival: '2026-11-20',
    departure: '2026-11-23',
    firstName: 'Anna',
    lastName: 'Andersson',
    email: 'anna@example.com',
    phone: '+46 70 123 45 67',
    guests: 4,
    company: '',
    message: 'Hej!',
    addons: { slutstad: true, lakan: true, linenCount: 4, ved: false, tidigIncheckning: false, senUtcheckning: false },
    totalAddons: 2500 + 800,
    rulesVersion: 'test-2026-11-10',
    consentRules: true,
    consentContact: false,
    ...overrides
  };
}

function setup(overrides = {}) {
  const stored = new Map();
  const store = {
    type: 'azure-table',
    async save(record) {
      if (stored.has(record.idempotencyKey)) return { duplicate: true, record: stored.get(record.idempotencyKey) };
      stored.set(record.idempotencyKey, record);
      return { duplicate: false, record };
    },
    async findByIdempotencyKey(key) { return stored.get(key) ?? null; }
  };
  const options = {
    rules: RULES,
    store,
    rateLimiter: () => true,
    availabilityHandler: async () => ({ status: 200, jsonBody: { blocked: [] } }),
    now: new Date('2026-11-10T12:00:00Z'),
    ...overrides
  };
  const warn = [];
  const context = { warn: (message) => warn.push(message) };
  return { options, stored, context, warn };
}

function request(overrides = {}) {
  return { body: validBody(), idempotencyKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ip: '10.0.0.1', ...overrides };
}

test('reglerna måste vara publicerade innan förfrågningar tas emot', async () => {
  const { options, context } = setup({ rules: { published: false, version: null, text: '' } });
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 503);
  assert.match(result.jsonBody.error, /Bokningsreglerna är inte publicerade/);
  assert.equal(Object.keys(result.jsonBody).length, 1); // ingen referens läcker
});

test('utövar durabel lagring: lokal fil nekar inskick i produktion', async () => {
  const { options, context } = setup({ store: { type: 'local-jsonl', save: async () => ({}), findByIdempotencyKey: async () => null } });
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 503);
});

test('hastighetsbegränsning returnerar 429', async () => {
  const { options, context } = setup({ rateLimiter: () => false });
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 429);
});

test('ogiltig eller saknad idempotensnyckel avvisas', async () => {
  const { options, context } = setup();
  const result = await handleBookingRequest(request({ idempotencyKey: 'x' }), context, options);
  assert.equal(result.status, 400);
  const result2 = await handleBookingRequest(request({ idempotencyKey: undefined }), context, options);
  assert.equal(result2.status, 400);
});

test('fältvalidering returnerar tydliga fel per fält', async () => {
  const { options, context } = setup();
  const body = validBody({ email: 'inte-en-mejladress', guests: 99, firstName: '', addons: { lakan: true, linenCount: 0 }, consentRules: false });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 400);
  assert.equal(result.jsonBody.fields.email, 'Ange en giltig e-postadress.');
  assert.equal(result.jsonBody.fields.guests.includes('1–24'), true);
  assert.equal(result.jsonBody.fields.firstName, 'Ange förnamn.');
  assert.ok(result.jsonBody.fields.linenCount);
  assert.ok(result.jsonBody.fields.consentRules);
});

test('honungsgrop (dolt bottfält) avvisar förfrågan', async () => {
  const { options, context } = setup();
  const body = validBody({ webbsida: 'http://spam.example' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 400);
});

test('ankomst i det förflutna avvisas', async () => {
  const { options, context } = setup({ now: new Date('2026-11-10T12:00:00Z') });
  const body = validBody({ arrival: '2026-11-09', departure: '2026-11-12' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 400);
  assert.ok(result.jsonBody.fields.arrival.includes('förflutna'));
});

test('för gammal rulesVersion avvisas med begäran om nytt godkännande', async () => {
  const { options, context } = setup();
  const body = validBody({ rulesVersion: 'gamla-regler' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 400);
  assert.ok(result.jsonBody.fields.consentRules);
});

test('om tillgänglighet inte kan kontrolleras (503) nekas förfrågan', async () => {
  const { options, context } = setup({ availabilityHandler: async () => ({ status: 503 }) });
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 503);
  assert.match(result.jsonBody.error, /kunde inte kontrolleras/);
});

test('bokade nätter avvisas med 409 även om klienten lurats', async () => {
  const { options, context } = setup({
    availabilityHandler: async ({ query }) => ({ status: 200, jsonBody: { blocked: [nightKeys(query.get('start'), query.get('end'))[1]] } })
  });
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 409);
  assert.match(result.jsonBody.error, /inte längre tillgängliga/);
});

test('giltig förfrågan sparas med status Inväntar godkännande och unik referens', async () => {
  const { options, stored, context } = setup();
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 201);
  assert.match(result.jsonBody.reference, /^SK-2026-[A-Z2-9]{6}$/);
  assert.equal(result.jsonBody.status, 'Inväntar godkännande');
  assert.equal(result.jsonBody.nights, 3);
  const record = [...stored.values()].find((item) => item.status === 'Inväntar godkännande');
  assert.ok(record);
  assert.equal(record.guests, 4);
  assert.equal(record.addons.linenCount, 4);
  assert.equal(record.rulesVersion, 'test-2026-11-10');
  // Utkorgsposter för värd och gäst ska finnas.
  assert.equal([...stored.values()].filter((item) => item.status === 'Utkorg').length, 2);
});

test('dubbel inskick med samma idempotensnyckel ger samma referens', async () => {
  const { options, stored, context } = setup();
  const first = await handleBookingRequest(request(), context, options);
  const second = await handleBookingRequest(request(), context, options);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.jsonBody.duplicate, true);
  assert.equal(second.jsonBody.reference, first.jsonBody.reference);
  assert.equal([...stored.values()].filter((item) => item.status === 'Inväntar godkännande').length, 1);
});

test('fel vid sparande ger 500 och ingen bekräftelse', async () => {
  const { options, context } = setup({
    store: { type: 'azure-table', save: async () => { throw new Error('storage down'); }, findByIdempotencyKey: async () => null }
  });
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 500);
  assert.match(result.jsonBody.error, /kunde inte sparas/);
});

test('validatePayload validerar datum, mejl och telefon noggrant', () => {
  assert.ok(validatePayload(validBody()).record);
  assert.ok(validatePayload(validBody({ arrival: '2026-02-30' })).errors.arrival);
  assert.ok(validatePayload(validBody({ departure: '2026-11-20' })).errors.arrival); // avresa före/lika med ankomst
  assert.ok(validatePayload(validBody({ arrival: '2026-11-20', departure: '2027-02-25' })).errors.arrival); // > 93 nätter
  assert.ok(validatePayload(validBody({ phone: 'hej' })).errors.phone);
  assert.ok(validatePayload(validBody({ guests: 0 })).errors.guests);
  assert.ok(validatePayload(validBody({ guests: 3.5 })).errors.guests);
  // Valfria fält får saknas.
  assert.ok(validatePayload(validBody({ company: undefined, message: undefined, consentContact: undefined })).record);
});

test('nightKeys följer hotelllogiken: avresedagen är ingen natt', () => {
  assert.deepEqual(nightKeys('2026-11-20', '2026-11-21'), ['2026-11-20']);
  assert.deepEqual(nightKeys('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01']);
});

test('hastighetsbegränsaren släpper igenom upp till gränsen och stänger sedan', () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 60000 });
  assert.equal(limiter('1.2.3.4', 1000), true);
  assert.equal(limiter('1.2.3.4', 2000), true);
  assert.equal(limiter('1.2.3.4', 3000), false);
  assert.equal(limiter('5.6.7.8', 3000), true);
  // Fönstret glider: gamla träffar räknas inte.
  assert.equal(limiter('1.2.3.4', 61000), true);
});

test('buildNotifications beskriver förfrågan utan att markera den bekräftad', () => {
  const record = {
    reference: 'SK-2026-ABC234', status: 'Inväntar godkännande',
    arrival: '2026-11-20', departure: '2026-11-23', nights: 3, guests: 4,
    firstName: 'Anna', lastName: 'Andersson', email: 'anna@example.com', phone: '+4670',
    company: '', message: '', addons: { slutstad: true, lakan: true, linenCount: 4, ved: true, tidigIncheckning: true, senUtcheckning: false },
    totalAddons: 2500 + 800 + 350 + 500, rulesVersion: 'test-2026-11-10'
  };
  const { host, guest } = buildNotifications(record);
  assert.match(host.subject, /Inväntar godkännande/);
  assert.match(host.body, /Slutstädning/);
  assert.match(host.body, /4 pers × 200 kr/);
  assert.match(host.body, /Tidig incheckning \(önskemål\)/);
  assert.match(guest.body, /ännu inte bekräftad/);
});
