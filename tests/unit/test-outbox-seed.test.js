'use strict';

// Steg 7J: säkerhets- och funktionstester för det lokala testharnesket.
// Harnesket får endast skriva syntetiska outbox-poster till testtabellen.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const harnessUrl = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'test-outbox-seed.mjs')).href;

async function harness() {
  return import(harnessUrl);
}

test('harnesket vägrar allt utom den isolerade testtabellen', async () => {
  const h = await harness();
  assert.throws(() => h.assertTestTable('bookingrequests'), /Vägrar/);
  assert.throws(() => h.assertTestTable('bookingrequests-prod'), /Vägrar/);
  assert.doesNotThrow(() => h.assertTestTable('bookingrequeststest'));
  assert.throws(() => h.assertTestAccount('stskadevi'), /Vägrar/);
  assert.doesNotThrow(() => h.assertTestAccount('stskadevibokningprod'));
});

test('harnesket tillåter endast Resend-testadresser eller kontrollerad testbrevlåda', async () => {
  const h = await harness();
  for (const address of [
    'delivered+host@resend.dev',
    'bounced@resend.dev',
    'complained+test@resend.dev',
    'skadevigard@gmail.com',
    'skadevigard+resendtest@gmail.com'
  ]) {
    assert.doesNotThrow(() => h.assertTestRecipient(address), address);
  }
  for (const address of ['anna@example.com', 'gast@hotmail.com', 'test@test.com']) {
    assert.throws(() => h.assertTestRecipient(address), /Vägrar/, address);
  }
});

test('två syntetiska, unika outbox-poster med TEST-SKADEVI-001 skapas', async () => {
  const h = await harness();
  const rows = h.buildTestOutboxRows({ now: '2026-11-11T15:00:00.000Z' });
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.idempotencyKey)).size, 2);
  assert.deepEqual(rows.map((row) => row.idempotencyKey).sort(), [
    'outbox-TEST-SKADEVI-001-guest',
    'outbox-TEST-SKADEVI-001-host'
  ]);
  for (const row of rows) {
    assert.equal(row.partition, 'outbox');
    assert.equal(row.status, 'Utkorg');
    assert.equal(row.attemptCount, 0);
    assert.equal(row.attemptedAt, '');
    assert.equal(row.sentAt, '');
    assert.ok(row.mailSubject.includes('TEST-SKADEVI-001'));
    assert.ok(row.mailText.includes('TEST-SKADEVI-001'));
    assert.ok(row.mailHtml.includes('TEST-SKADEVI-001'));
    assert.doesNotThrow(() => h.assertTestRecipient(row.mailTo));
    assert.ok(!row.mailHtml.includes('anna@example.com'));
  }
});

test('dry-run skriver ingenting och --commit skriver endast outbox-poster', async () => {
  const h = await harness();
  const saved = [];
  const store = {
    async save(row) {
      saved.push(row);
      return { duplicate: false, record: row };
    }
  };
  const dry = await h.seedTestOutbox({ store });
  assert.equal(dry.committed, false);
  assert.equal(saved.length, 0);

  const written = await h.seedTestOutbox({ store, commit: true });
  assert.equal(written.committed, true);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((row) => row.partition === 'outbox'));
  assert.ok(saved.every((row) => row.partition !== 'request'));
  assert.equal(new Set(saved.map((row) => row.idempotencyKey)).size, 2);
});

test('harnesket vägrar commit mot produktionstabellen innan något skrivs', async () => {
  const h = await harness();
  let called = false;
  const store = { async save() { called = true; } };
  await assert.rejects(
    () => h.seedTestOutbox({ store, commit: true, table: 'bookingrequests' }),
    /Vägrar/
  );
  assert.equal(called, false);
});
