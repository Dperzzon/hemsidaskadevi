'use strict';

// Steg 7J: kontraktstest för den lokala Resend-mocken.
// Inga riktiga mejl skickas och ingen riktig API-nyckel används.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mockUrl = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'mock-resend.mjs')).href;

async function withMock(fn) {
  const { createMockResendServer } = await import(mockUrl);
  const mock = createMockResendServer();
  const base = await mock.listen(0);
  try {
    await fn(mock, base);
  } finally {
    await mock.close();
  }
}

test('mockens /emails tar emot Resend-payload och returnerar ett id', async () => {
  await withMock(async (mock, base) => {
    const payload = {
      from: 'onboarding@resend.dev',
      to: 'delivered+test@resend.dev',
      reply_to: 'delivered+reply@resend.dev',
      subject: '[TEST] TEST-SKADEVI-001',
      html: '<p>Test</p>',
      text: 'Test'
    };
    const response = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-mock-key',
        'idempotency-key': 'outbox-TEST-SKADEVI-001-host'
      },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.id, /^mock-/);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].authorization, 'Bearer test-mock-key');
    assert.equal(mock.requests[0].idempotencyKey, 'outbox-TEST-SKADEVI-001-host');
    assert.deepEqual(mock.requests[0].body, payload);
  });
});

test('mocken kan returnera 429, 500, 401, 403 och 409', async () => {
  await withMock(async (_mock, base) => {
    for (const statusCode of [429, 500, 401, 403, 409]) {
      const response = await fetch(`${base}/status/${statusCode}`);
      assert.equal(response.status, statusCode);
      const body = await response.json();
      assert.equal(body.statusCode, statusCode);
    }
  });
});

test('mockens /timeout kan användas för att simulera timeout', async () => {
  await withMock(async (_mock, base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await assert.rejects(
        () => fetch(`${base}/timeout`, { signal: controller.signal }),
        (error) => error.name === 'AbortError'
      );
    } finally {
      clearTimeout(timer);
    }
  });
});
