'use strict';

// Kontraktsprov för den nya mejltypen GUEST_ADDON_VERIFICATION_CODE.
// Mejlet byggs av produktionskoden, läggs i utkorgen och skickas genom den
// lokala Resend-simulatorn. Inga riktiga mejl eller Azure-resurser används.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildAddonVerificationMail } = require('../../server/booking/booking-mail');
const { buildOutboxRecord } = require('../../server/booking/outbox');
const simulator = require('../helpers/resend-flow-simulator.js');

const NOW = '2026-11-25T11:00:00.000Z';
const mockUrl = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'mock-resend.mjs')).href;

test('verifieringsmejlet får rätt utkorgsfält och kan skickas av Resend-flödet', async () => {
  const code = '482913';
  const record = {
    reference: 'SK-2027-AB123',
    firstName: 'Anna',
    email: 'delivered@resend.dev'
  };
  const notification = buildAddonVerificationMail(record, code, { expiresMinutes: 10 });
  const outbox = buildOutboxRecord({
    idempotencyKey: 'outbox-addon-verification-test-001',
    reference: record.reference,
    notification,
    createdAt: NOW
  });

  assert.equal(outbox.mailType, 'GUEST_ADDON_VERIFICATION_CODE');
  assert.equal(outbox.mailTo, 'delivered@resend.dev');
  assert.equal(outbox.dispatchEligible, 'true');
  assert.equal(outbox.outboxVersion, '1');
  assert.equal(outbox.status, 'Utkorg');
  assert.equal(outbox.attemptCount, 0);
  assert.ok(outbox.mailText.includes(code));
  assert.ok(outbox.mailHtml.includes(code));
  assert.ok(outbox.mailText.includes('10 minuter'));
  assert.ok(!outbox.mailSubject.includes(code), 'koden ska inte ligga i ämnesraden');
  assert.ok(!outbox.reference.includes(code), 'koden ska inte ligga i referensen');

  const { createMockResendServer } = await import(mockUrl);
  const mock = createMockResendServer();
  const base = await mock.listen(0);
  try {
    const row = {
      PartitionKey: 'outbox',
      RowKey: outbox.idempotencyKey,
      status: 'Utkorg',
      attemptCount: 0,
      attemptedAt: '',
      mailTo: outbox.mailTo,
      mailReplyTo: outbox.mailReplyTo,
      mailSubject: outbox.mailSubject,
      mailHtml: outbox.mailHtml,
      mailText: outbox.mailText,
      etag: 'W/"1"',
      _version: 1
    };
    const result = await simulator.processPoll([row], {
      resendApiUrl: `${base}/emails`,
      now: () => NOW
    });
    assert.equal(row.status, 'Skickad');
    assert.match(row.resendId, /^mock-/);
    assert.equal(result.sent.length, 1);
    assert.equal(mock.delivered.length, 1);
    assert.equal(mock.requests[0].idempotencyKey, outbox.idempotencyKey);
    assert.equal(mock.requests[0].body.to, 'delivered@resend.dev');
    assert.ok(mock.requests[0].body.text.includes(code));
  } finally {
    await mock.close();
  }
});
