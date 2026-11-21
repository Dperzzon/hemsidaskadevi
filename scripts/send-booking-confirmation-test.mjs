#!/usr/bin/env node
// ============================================================================
// Skickar EXAKT ett syntetiskt bokningsbekräftelsemejl via Resends testnyckel.
//
// Skyddsräcken:
//   - Mottagaren är låst till den interna testadressen.
//   - Avsändaren är låst till bokning@skadeviherrgard.com.
//   - Nyckeln hämtas endast som resend-api-key-test, aldrig produktionsnyckeln.
//   - Inga riktiga bokningar, betalningar eller kunduppgifter används.
//
// Användning:
//   node scripts/send-booking-confirmation-test.mjs
// ============================================================================

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildBookingConfirmation } = require('../server/booking/booking-mail');

const RECIPIENT = 'skadevigard@gmail.com';
const SENDER = 'bokning@skadeviherrgard.com';
const SUBJECT = '[TEST] Din bokning på Skadevi Herrgård är bekräftad';
const SECRET_NAME = 'resend-api-key-test';
const PREVIEW_DIR = 'manual-granskning';

function readTestKey() {
  if (process.env.RESEND_API_KEY_TEST) return process.env.RESEND_API_KEY_TEST.trim();
  const az = process.platform === 'win32' ? 'az.cmd' : 'az';
  const value = execFileSync(az, [
    'keyvault', 'secret', 'show',
    '--vault-name', 'kv-skadevi-prod',
    '--name', SECRET_NAME,
    '--query', 'value',
    '-o', 'tsv'
  ], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  if (!value) throw new Error('Testnyckeln kunde inte läsas från Key Vault');
  return value;
}

function buildMail() {
  const record = {
    reference: 'TEST-SKADEVI-MAIL-001',
    firstName: 'Test',
    lastName: 'Gäst',
    email: RECIPIENT,
    arrival: '2027-05-14',
    departure: '2027-05-16',
    nights: 2,
    guests: 16,
    addonLines: [
      { label: 'Slutstädning', quantity: 1, amount: 2500 },
      { label: 'Sänglinne', quantity: 16, amount: 3200 }
    ]
  };
  const summary = {
    totalOre: 2570000,
    paidOre: 2570000,
    remainingOre: 0,
    overpaidOre: 0,
    paymentStatus: 'PAID',
    paymentLabel: 'Betald'
  };
  const mail = buildBookingConfirmation(record, { summary });
  if (mail.to !== RECIPIENT) throw new Error(`Oväntad mottagare: ${mail.to}`);
  return { ...mail, subject: SUBJECT };
}

async function main() {
  const mail = buildMail();

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.writeFileSync(`${PREVIEW_DIR}/booking-confirmation-preview.html`, mail.html);
  fs.writeFileSync(`${PREVIEW_DIR}/booking-confirmation-preview.txt`, mail.body);

  const key = readTestKey();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'TEST-SKADEVI-MAIL-001-send'
    },
    body: JSON.stringify({
      from: `Skadevi Herrgård <${SENDER}>`,
      to: [RECIPIENT],
      reply_to: RECIPIENT,
      subject: mail.subject,
      html: mail.html,
      text: mail.body
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend svarade HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  console.log(`HTTP ${response.status} – Resend-ID ${payload.id ?? '(saknas)'}`);
  console.log(`Mottagare: ${RECIPIENT}`);
  console.log(`Avsändare: ${SENDER}`);
  console.log(`Ämne: ${mail.subject}`);
  console.log(`Förhandsvisning: ${PREVIEW_DIR}/booking-confirmation-preview.html`);
}

main().catch((error) => {
  console.error(`TESTUTSKICK FEL: ${error.message}`);
  process.exitCode = 1;
});
