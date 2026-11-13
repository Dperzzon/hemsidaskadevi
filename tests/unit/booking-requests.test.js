// Enhetstester för bokningsförfrågningar (server/booking/requests.js):
// validering, tillgänglighetskontroll, idempotens, regler och missbruksskydd.
'use strict';


const test = require('node:test');
const assert = require('node:assert/strict');
const { handleBookingRequest, validatePayload, nightKeys, createRateLimiter, buildNotifications, escapeHtml } = require('../../server/booking/requests');

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
    async findByIdempotencyKey(key) { return stored.get(key) ?? null; },
    async findByReference(reference) {
      return [...stored.values()].find((item) => item.reference === reference && item.partition !== 'outbox') ?? null;
    },
    async listPending() {
      return [...stored.values()].filter((item) => item.partition !== 'outbox' && item.status === 'Inväntar godkännande');
    }
  };
  const options = {
    rules: RULES,
    store,
    rateLimiter: () => true,
    enabled: true,
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

test('bokningsinskick är avstängt som standard (kill switch) tills kedjan verifierats', async () => {
  const { options, context } = setup();
  const result = await handleBookingRequest(request(), context, { ...options, enabled: undefined });
  assert.equal(result.status, 503);
  assert.match(result.jsonBody.error, /kan inte tas emot via formuläret just nu/);
});

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
  const body = validBody({ email: 'inte-en-mejladress', guests: 99, firstName: '', addons: { lakan: true, linenCount: -1 }, consentRules: false });
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
  assert.equal(record.statusCode, 'PENDING');
  assert.equal(record.bookingSource, 'WEB');
  assert.equal(record.paymentStatus, 'UNPAID');
  assert.equal(record.balance, record.total);
  assert.equal(record.amountPaid, 0);
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
    store: {
      type: 'azure-table',
      save: async () => { throw new Error('storage down'); },
      findByIdempotencyKey: async () => null,
      findByReference: async () => null,
      listPending: async () => []
    }
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
    addonLines: [
      { id: 'slutstad', label: 'Slutstädning (exklusive kök)', amount: 2500 },
      { id: 'lakan', label: 'Lakan och handdukar', quantity: 4, unitPrice: 200, amount: 800 },
      { id: 'ved', label: 'Ved', amount: 350 },
      { id: 'tidigIncheckning', label: 'Tidig incheckning', amount: 500 }
    ],
    lodgingBase: 24000, peakNights: 0, peakBase: 0,
    discount: { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, amount: 7200 },
    discountAmount: 7200, lodgingAfterDiscount: 16800,
    totalAddons: 2500 + 800 + 350 + 500, total: 16800 + 4150,
    priceVersion: '2026-11-11.1', rulesVersion: 'test-2026-11-10'
  };
  const { host, guest } = buildNotifications(record);
  assert.match(host.subject, /Inväntar godkännande/);
  assert.match(host.body, /Slutstädning \(exklusive kök\): 2500 kr/);
  assert.match(host.body, /Boendepris före rabatt: 24000 kr/);
  assert.match(host.body, /Rabatt \(Veckorabatt 30 %\)/);
  assert.match(host.body, /Boendepris efter rabatt: 16800 kr/);
  assert.match(host.body, /TOTALPRIS FÖR HELA VISTELSEN: 20950 kr/);
  assert.match(guest.body, /ännu inte bekräftad/);
});

test('notiserna går till skadevigard@gmail.com med reply-to samma adress', () => {
  const record = {
    reference: 'SK-2026-ABC234', status: 'Inväntar godkännande',
    arrival: '2026-11-20', departure: '2026-11-23', nights: 3, guests: 2,
    firstName: 'Anna', lastName: 'Andersson', email: 'anna@example.com', phone: '+4670',
    company: '', message: '', addons: {}, totalAddons: 0, discount: null,
    rulesVersion: 'test-2026-11-10'
  };
  const { host, guest } = buildNotifications(record);
  assert.equal(host.to, 'skadevigard@gmail.com');
  assert.equal(host.replyTo, 'skadevigard@gmail.com');
  assert.equal(guest.replyTo, 'skadevigard@gmail.com');
});

test('notisen till Skadevi redovisar rabatter och totalpris', () => {
  const record = {
    reference: 'SK-2026-ABC234', status: 'Inväntar godkännande',
    arrival: '2026-11-20', departure: '2026-12-18', nights: 28, guests: 2,
    firstName: 'Anna', lastName: 'Andersson', email: 'anna@example.com', phone: '+4670',
    company: '', message: '', addons: {}, addonLines: [], totalAddons: 0,
    lodgingBase: 200000, peakNights: 0, peakBase: 0,
    discount: { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, amount: 138000 },
    discountAmount: 138000, lodgingAfterDiscount: 62000, total: 62000,
    priceVersion: '2026-11-11.1', rulesVersion: 'test-2026-11-10'
  };
  const { host } = buildNotifications(record);
  assert.match(host.body, /Månadsrabatt 69 %/);
  assert.match(host.body, /Boendepris före rabatt: 200000 kr/);
  assert.match(host.body, /Boendepris efter rabatt: 62000 kr/);
  assert.match(host.body, /TOTALPRIS FÖR HELA VISTELSEN: 62000 kr/);
});

test('rabatten beräknas på serversidan och sparas med belopp', async () => {
  // 10 nätter → veckorabatt 30 % (utövar att servern inte litar på klienten).
  const { options, stored, context } = setup({
    now: new Date('2026-11-10T12:00:00Z')
  });
  const body = validBody({ arrival: '2026-11-20', departure: '2026-11-30' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 201);
  const record = [...stored.values()].find((item) => item.status === 'Inväntar godkännande');
  assert.equal(record.nights, 10);
  assert.equal(record.discount.percent, 30);
  assert.ok(record.discount.amount > 0);
  assert.equal(record.discountAmount, record.discount.amount);
  assert.ok(record.lodgingBase > 0);
  assert.equal(record.lodgingBase - record.discountAmount, record.lodgingAfterDiscount);
  assert.equal(record.total, record.lodgingAfterDiscount + record.totalAddons);
  assert.ok(record.priceVersion);
});

test('manipulerade klientbelopp ignoreras — servern räknar om totalet', async () => {
  const { options, stored, context } = setup();
  // Klienten påstår att tillvalen kostar 1 kr; servern beräknar själv.
  const body = validBody({ totalAddons: 1, guests: 4 });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 201);
  const record = [...stored.values()].find((item) => item.status === 'Inväntar godkännande');
  assert.equal(record.totalAddons, 2500 + 4 * 200); // slutstädning + 4 pers lakan
  assert.equal(record.total, record.lodgingAfterDiscount + record.totalAddons);
});

test('lagrade priser och e-postnotiser visar samma serverberäknade belopp', async () => {
  const { options, stored, context } = setup();
  const body = validBody({ arrival: '2026-11-20', departure: '2026-11-23' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 201);
  const record = [...stored.values()].find((item) => item.status === 'Inväntar godkännande');
  const host = [...stored.values()].find((item) => item.partition === 'outbox' && item.mailTo === 'skadevigard@gmail.com');
  assert.match(host.mailHtml, new RegExp(`TOTALPRIS FÖR HELA VISTELSEN: ${record.total} kr`));
  assert.match(host.mailHtml, new RegExp(`Boendepris efter rabatt: ${record.lodgingAfterDiscount} kr`));
});

test('kort vistelse får ingen rabattpost', async () => {
  const { options, stored, context } = setup({ now: new Date('2026-11-10T12:00:00Z') });
  const body = validBody({ arrival: '2026-11-20', departure: '2026-11-23' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 201);
  const record = [...stored.values()].find((item) => item.status === 'Inväntar godkännande');
  assert.equal(record.discount, null);
});

test('referensen garanteras unik mot lagringen', async () => {
  let calls = 0;
  const { options, context } = setup({
    makeReference: () => (calls++ === 0 ? 'SK-2026-AAAAAA' : 'SK-2026-BBBBBB')
  });
  // Simulera att referens SK-2026-AAAAAA redan finns i lagringen.
  options.store.findByReference = async (ref) => (ref === 'SK-2026-AAAAAA' ? { reference: ref } : null);
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 201);
  assert.equal(result.jsonBody.reference, 'SK-2026-BBBBBB');
});

test('överlappande väntande förfrågningar tillåts och flaggas till Skadevi (ingen atomär låsning)', async () => {
  const { options, stored, context } = setup();
  // En tidigare väntande förfrågan överlappar 20–23 november.
  options.store.listPending = async () => [{
    idempotencyKey: 'tidigare-nyckel-12345678', reference: 'SK-2026-AAA111',
    arrival: '2026-11-19', departure: '2026-11-24', status: 'Inväntar godkännande'
  }];
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 201, 'överlapp ska inte neka registrering — Skadevi avgör');
  const host = [...stored.values()].find((item) => item.partition === 'outbox' && item.mailTo === 'skadevigard@gmail.com');
  assert.match(host.mailHtml, /ÖVERLAPP/);
  assert.match(host.mailHtml, /SK-2026-AAA111/);
  // Ingen av förfrågningarna får vara bekräftad.
  assert.equal([...stored.values()].every((item) => item.status !== 'Bekräftad'), true);
});

test('gästuppgifter HTML-escapas i notisen till Skadevi', async () => {
  const { options, stored, context } = setup();
  const body = validBody({ firstName: 'Anna<script>', message: '<script>alert(1)</script><img src=x onerror=alert(1)>' });
  const result = await handleBookingRequest(request({ body }), context, options);
  assert.equal(result.status, 201);
  const host = [...stored.values()].find((item) => item.partition === 'outbox' && item.mailTo === 'skadevigard@gmail.com');
  assert.doesNotMatch(host.mailHtml, /<script>alert|<img src=x/);
  assert.match(host.mailHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(host.mailHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(host.mailHtml, /Anna&lt;script&gt;/);
  // escapeHtml är grundprimitivet för hela mejlmallen.
  assert.equal(escapeHtml('<x>&"'), '&lt;x&gt;&amp;&quot;');
});

test('utkorgspost innehåller komplett mejlmall för Logic Apps', async () => {
  const { options, stored, context } = setup();
  await handleBookingRequest(request(), context, options);
  const outbox = [...stored.values()].filter((item) => item.partition === 'outbox');
  assert.equal(outbox.length, 2);
  for (const row of outbox) {
    assert.equal(row.status, 'Utkorg');
    assert.ok(row.mailSubject.includes('SK-2026-'));
    assert.ok(row.mailHtml.includes('inte en bekräftad bokning'));
    assert.equal(row.attemptCount, 0);
  }
  const host = outbox.find((item) => item.mailTo === 'skadevigard@gmail.com');
  assert.equal(host.mailReplyTo, 'skadevigard@gmail.com');
  const guest = outbox.find((item) => item.mailTo === 'anna@example.com');
  assert.ok(guest.mailHtml.includes('Tack för din bokningsförfrågan'));
  assert.equal(host.reference, guest.reference);
  assert.match(host.reference, /^SK-2026-/);
  assert.equal(host.mailType, 'HOST_NEW_REQUEST');
  assert.equal(guest.mailType, 'GUEST_REQUEST_ACK');
});

test('misslyckad utkorgssparning stoppar inte registreringen', async () => {
  const { options, stored, context } = setup();
  const originalSave = options.store.save.bind(options.store);
  options.store.save = async (record, ctx) => {
    if (record.partition === 'outbox') throw new Error('utkorg nere');
    return originalSave(record, ctx);
  };
  const result = await handleBookingRequest(request(), context, options);
  assert.equal(result.status, 201, 'förfrågan ska vara registrerad även om utkorgen misslyckas');
  assert.equal([...stored.values()].filter((item) => item.status === 'Inväntar godkännande').length, 1);
});
