'use strict';

// Steg 7O: lokala integrationstester av Resend-utkorgsflödet.
//
// Dessa tester kör en kontraktssimulator mot en lokal mock på 127.0.0.1.
// De är INTE en Azure Logic Apps-körning. Den faktiska Azure-definitionen
// verifieras strukturellt i email-resend-workflow/resend-test-env-testerna.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const simulator = require('../helpers/resend-flow-simulator.js');
const mockUrl = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'mock-resend.mjs')).href;
const NOW = '2026-11-11T17:00:00.000Z';

async function withMock(options, fn) {
  const { createMockResendServer } = await import(mockUrl);
  const mock = createMockResendServer(options);
  const base = await mock.listen(0);
  try {
    await fn(mock, base);
  } finally {
    await mock.close();
  }
}

function response(status) {
  return new Response(JSON.stringify({ statusCode: status }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function failFirst(times, status, keys) {
  let count = 0;
  return async (url, init) => {
    keys?.push(init.headers['Idempotency-Key']);
    count += 1;
    if (count <= times) return response(status);
    return fetch(url, init);
  };
}

function failAlways(status, keys) {
  return async (_url, init) => {
    keys?.push(init.headers['Idempotency-Key']);
    return response(status);
  };
}

test('A. HTTP 200 och giltigt Resend-ID', async () => {
  await withMock({}, async (mock, base) => {
    const row = simulator.createOutboxRow();
    const result = await simulator.processPoll([row], { resendApiUrl: `${base}/emails`, now: () => NOW });
    assert.equal(row.status, 'Skickad');
    assert.match(row.resendId, /^mock-/);
    assert.equal(result.sent.length, 1);
    assert.equal(mock.delivered.length, 1);
    assert.equal(mock.requests[0].authorization, 'Bearer test-mock-key');
    assert.equal(mock.requests[0].idempotencyKey, row.RowKey);
    assert.equal(mock.requests[0].body.to, 'skadevigard@gmail.com');
    assert.ok(mock.requests[0].body.html);
    assert.ok(mock.requests[0].body.text);
  });
});

test('B. HTTP 429 återförsök med samma Idempotency-Key', async () => {
  await withMock({}, async (mock, base) => {
    const keys = [];
    const row = simulator.createOutboxRow();
    const result = await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      fetchImpl: failFirst(2, 429, keys),
      now: () => NOW
    });
    assert.equal(row.status, 'Skickad');
    assert.equal(result.attempts.length, 3);
    assert.deepEqual(keys, Array(3).fill(row.RowKey));
    assert.equal(mock.delivered.length, 1);
  });
});

test('C. HTTP 500 återförsök med samma Idempotency-Key', async () => {
  await withMock({}, async (mock, base) => {
    const keys = [];
    const row = simulator.createOutboxRow();
    const result = await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      fetchImpl: failFirst(2, 500, keys),
      now: () => NOW
    });
    assert.equal(row.status, 'Skickad');
    assert.equal(result.attempts.length, 3);
    assert.deepEqual(keys, Array(3).fill(row.RowKey));
    assert.equal(mock.delivered.length, 1);
  });
});

test('D. HTTP 401/403 ger Misslyckad utan HTTP-återförsök, och manuell vid maxförsök', async () => {
  for (const status of [401, 403]) {
    await withMock({}, async (_mock, base) => {
      const keys = [];
      const row = simulator.createOutboxRow();
      const first = await simulator.processPoll([row], {
        resendApiUrl: `${base}/emails`,
        fetchImpl: failAlways(status, keys),
        now: () => NOW
      });
      assert.equal(first.attempts.length, 1, `${status} ska inte HTTP-återförsökas`);
      assert.equal(row.status, 'Misslyckad');
      assert.equal(row.attemptCount, 1);

      row.status = 'Utkorg';
      row.attemptCount = 4;
      const last = await simulator.processPoll([row], {
        resendApiUrl: `${base}/emails`,
        fetchImpl: failAlways(status, keys),
        now: () => NOW
      });
      assert.equal(last.manual.length, 1);
      assert.equal(row.status, 'Kräver manuell kontroll');
      assert.equal(row.attemptCount, 5);
    });
  }
});

test('E. HTTP 409 ger manuell kontroll utan återförsök', async () => {
  await withMock({}, async (mock, base) => {
    const keys = [];
    const row = simulator.createOutboxRow();
    const result = await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      fetchImpl: failAlways(409, keys),
      now: () => NOW
    });
    assert.equal(result.attempts.length, 1);
    assert.equal(row.status, 'Kräver manuell kontroll');
    assert.ok(row.manualReviewReason.includes('409'));
    assert.equal(mock.delivered.length, 0);
  });
});

test('F. Förlorat svar efter att mocken tagit emot mejlet ger ingen dubblett', async () => {
  await withMock({ loseResponseTimes: 1 }, async (mock, base) => {
    const row = simulator.createOutboxRow();
    const result = await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      now: () => NOW
    });
    assert.equal(mock.delivered.length, 1, 'endast ett mejl får ha levererats');
    assert.equal(row.status, 'Skickad');
    assert.equal(row.resendId, mock.delivered[0].id);
    assert.ok(result.attempts.length >= 2, 'förlorat svar ska ha återförsökts');
    assert.equal(result.attempts[0].status, 'network-error');
    assert.ok(result.attempts.every((attempt) => attempt.idempotencyKey === row.RowKey));
  });
});

test('G. Samma Idempotency-Key används vid alla återförsök', async () => {
  await withMock({}, async (_mock, base) => {
    const keys = [];
    const row = simulator.createOutboxRow();
    await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      fetchImpl: failFirst(1, 500, keys),
      now: () => NOW
    });
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 1);
    assert.equal(keys[0], row.RowKey);
  });
});

test('H. Två separata mejl – endast det ena misslyckas', async () => {
  await withMock({}, async (mock, base) => {
    const host = simulator.createOutboxRow({ RowKey: 'outbox-TEST-SKADEVI-001-host', mailTo: 'skadevigard@gmail.com' });
    const guest = simulator.createOutboxRow({ RowKey: 'outbox-TEST-SKADEVI-001-guest', mailTo: 'delivered@resend.dev' });
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.to === 'delivered@resend.dev') return response(500);
      return fetch(url, init);
    };
    const result = await simulator.processPoll([host, guest], {
      resendApiUrl: `${base}/emails`,
      fetchImpl,
      now: () => NOW
    });
    assert.equal(host.status, 'Skickad');
    assert.equal(guest.status, 'Misslyckad');
    assert.equal(result.sent.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(mock.delivered.length, 1);
  });
});

test('I. Blockerade mottagare skickas aldrig och markeras manuellt', async () => {
  for (const mailTo of [
    'attacker@example.com',
    'delivered+label@resend.dev',
    'delivered@resend.dev,attacker@example.com',
    'delivered@resend.dev attacker@example.com',
    ''
  ]) {
    await withMock({}, async (mock, base) => {
      const row = simulator.createOutboxRow({ mailTo });
      const result = await simulator.processPoll([row], {
        resendApiUrl: `${base}/emails`,
        fetchImpl: async () => { throw new Error('Resend får inte anropas för blockerade mottagare'); },
        now: () => NOW
      });
      assert.equal(result.blocked.length, 1, mailTo);
      assert.equal(row.status, 'Kräver manuell kontroll');
      assert.equal(row.deliveryStatus, 'Blockerad av testmottagarspärr');
      assert.equal(mock.delivered.length, 0);
    });
  }
});

test('J. 24-timmarsgräns och maxförsök ger manuell kontroll utan sändning', async () => {
  await withMock({}, async (mock, base) => {
    const old = '2026-11-09T10:00:00.000Z';
    const rows = [
      simulator.createOutboxRow({ RowKey: 'old-skickar', status: 'Skickar', attemptCount: 1, attemptedAt: old }),
      simulator.createOutboxRow({ RowKey: 'old-misslyckad', status: 'Misslyckad', attemptCount: 2, attemptedAt: old }),
      simulator.createOutboxRow({ RowKey: 'max-skickar', status: 'Skickar', attemptCount: 5, attemptedAt: '2026-11-11T16:00:00.000Z' })
    ];
    const result = await simulator.processPoll(rows, {
      resendApiUrl: `${base}/emails`,
      fetchImpl: async () => { throw new Error('Ingen sändning får ske'); },
      now: () => NOW
    });
    assert.equal(result.manual.length, 3);
    assert.ok(rows.every((row) => row.status === 'Kräver manuell kontroll'));
    assert.equal(mock.delivered.length, 0);
  });
});

test('J2. Färskt Skickar-försök under maxförsök får återförsökas', async () => {
  await withMock({}, async (mock, base) => {
    const row = simulator.createOutboxRow({
      status: 'Skickar',
      attemptCount: 1,
      attemptedAt: '2026-11-11T16:00:00.000Z'
    });
    await simulator.processPoll([row], { resendApiUrl: `${base}/emails`, now: () => NOW });
    assert.equal(row.status, 'Skickad');
    assert.equal(mock.delivered.length, 1);
  });
});

test('K. Stale ETag efter samtidig uppdatering skickar inget', async () => {
  await withMock({}, async (mock, base) => {
    const row = simulator.createOutboxRow();
    const result = await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      beforeClaim: (item) => {
        item._version += 1;
        item.etag = `W/"${item._version}"`;
      },
      now: () => NOW
    });
    assert.equal(result.stale.length, 1);
    assert.equal(result.attempts.length, 0);
    assert.equal(mock.delivered.length, 0);
  });
});

test('L. Testposter skapar aldrig riktiga bokningar eller extern trafik', async () => {
  await withMock({}, async (mock, base) => {
    const rows = [
      simulator.createOutboxRow({ RowKey: 'outbox-TEST-SKADEVI-001-host' }),
      simulator.createOutboxRow({ RowKey: 'outbox-TEST-SKADEVI-001-guest', mailTo: 'delivered@resend.dev' })
    ];
    const result = await simulator.processPoll(rows, { resendApiUrl: `${base}/emails`, now: () => NOW });
    assert.equal(result.sent.length, 2);
    assert.ok(rows.every((row) => row.PartitionKey === 'outbox'));
    assert.ok(!rows.some((row) => row.PartitionKey === 'request'));
    assert.equal(mock.delivered.length, 2);
    assert.equal(mock.requests.length, 2);
  });
});

test('kontraktet hämtas från den faktiska testdefinitionen', () => {
  const contract = simulator.extractWorkflowContract();
  assert.deepEqual(contract.allowedRecipients.sort(), [
    'bounced@resend.dev',
    'complained@resend.dev',
    'delivered@resend.dev',
    'skadevigard@gmail.com'
  ]);
  assert.equal(contract.maxAttempts, 5);
  assert.equal(contract.idempotencyHeader, 'Idempotency-Key');
  assert.equal(contract.retryPolicy.count, 4);
  assert.equal(contract.retryPolicy.type, 'exponential');
});

test('simulatorn blockerar all trafik utanför localhost', () => {
  for (const url of [
    'https://api.resend.com/emails',
    'https://stskadevibokningprod.table.core.windows.net/bookingrequests',
    'https://kv-skadevi-prod.vault.azure.net/secrets/resend-api-key-test'
  ]) {
    assert.throws(() => simulator.assertLocalUrl(url), /Blockerad icke-lokal/);
  }
  assert.doesNotThrow(() => simulator.assertLocalUrl('http://127.0.0.1:1234/emails'));
  assert.doesNotThrow(() => simulator.assertLocalUrl('http://localhost:1234/emails'));
});
