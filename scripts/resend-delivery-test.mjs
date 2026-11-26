#!/usr/bin/env node
// Skickar ETT markerat testmejl via Resend och skapar en isolerad utkorgspost
// i produktionstabellen så att den riktiga leveranshändelsen kan matchas utan
// att röra någon kundbokning. Skriptet skriver aldrig ut API-nycklar eller
// hemligheter och kräver uttryckligt --confirm.
//
// Användning:
//   node scripts/resend-delivery-test.mjs --confirm
//
// Flaggor:
//   --confirm        Krävs för att faktiskt skicka mejlet.
//   --to <adress>    Mottagare (default: skadevigard@gmail.com).
//   --keep           Behåll testposten efter verifieringen (annars raderas den).
//   --key-vault <n>  Key Vault (default: kv-skadevi-prod).
//   --setup-secret <n> Full-access-nyckel (default: resend-webhook-setup-key).

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const CONFIRM = args.includes('--confirm');
const KEEP = args.includes('--keep');
const TO = arg('--to', 'skadevigard@gmail.com');
const KEY_VAULT = arg('--key-vault', 'kv-skadevi-prod');
const SETUP_SECRET = arg('--setup-secret', 'resend-webhook-setup-key');
const ACCOUNT = 'stskadevibokningprod';
const TABLE = 'bookingrequests';
const TABLE_URL = `https://${ACCOUNT}.table.core.windows.net/${TABLE}`;
const AZ = 'az';
const AZ_OPTS = process.platform === 'win32' ? { shell: true } : {};

const now = new Date().toISOString();
const reference = `SK-TEST-16F-${randomUUID().slice(0, 8).toUpperCase()}`;
const rowKey = `test-16f-${randomUUID()}`;

function az(argsList, options = {}) {
  return execFileSync(AZ, argsList, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...AZ_OPTS,
    ...options
  }).trim();
}

function fail(message) {
  console.error(`FEL: ${message}`);
  process.exit(1);
}

if (!CONFIRM) {
  fail('Ange --confirm för att skicka testmejlet. Inget skickades.');
}

const apiKey = az([
  'keyvault', 'secret', 'show', '--vault-name', KEY_VAULT,
  '--name', SETUP_SECRET, '--query', 'value', '--output', 'tsv'
]);
if (!apiKey) fail(`Kunde inte läsa "${SETUP_SECRET}" från ${KEY_VAULT}.`);

const storageToken = az([
  'account', 'get-access-token', '--resource', 'https://storage.azure.com/',
  '--query', 'accessToken', '--output', 'tsv'
]);
if (!storageToken) fail('Kunde inte hämta Storage-token via Azure-identiteten.');

const headers = {
  Authorization: `Bearer ${storageToken}`,
  'x-ms-version': '2019-02-02',
  Accept: 'application/json;odata=nometadata',
  'Content-Type': 'application/json'
};

async function sendTestMail() {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Skadevi Herrgård <bokning@skadeviherrgard.com>',
      to: [TO],
      reply_to: 'skadevigard@gmail.com',
      subject: '[TEST] Skadevi – automatisk mejlleveranskontroll',
      text: [
        'Detta är ett automatiskt test av Skadevis leveransuppföljning via Resend.',
        `Testreferens: ${reference}`,
        'Ingen kundbokning eller betalning påverkas.',
        '',
        'Skadevi Herrgård'
      ].join('\n')
    })
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok || !body?.id) {
    fail(`Resend svarade ${response.status} och inget meddelande-ID erhölls.`);
  }
  return String(body.id);
}

async function insertOutbox(resendId) {
  const entity = {
    PartitionKey: 'outbox',
    RowKey: rowKey,
    reference,
    mailType: 'GUEST_BOOKING_CONFIRMED',
    mailSubject: '[TEST] Skadevi – automatisk mejlleveranskontroll',
    mailTo: TO,
    status: 'Skickad',
    deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
    resendId,
    dispatchEligible: 'true',
    outboxVersion: 'test-16f',
    attemptCount: 1,
    attemptedAt: now,
    sentAt: now,
    createdAt: now,
    updatedAt: now
  };
  const response = await fetch(TABLE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(entity)
  });
  if (response.status !== 201) {
    fail(`Testposten kunde inte skapas (HTTP ${response.status}).`);
  }
}

async function readOutbox() {
  const url = `${TABLE_URL}(PartitionKey='outbox',RowKey='${encodeURIComponent(rowKey)}')`;
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  return response.json();
}

async function deleteOutbox() {
  const url = `${TABLE_URL}(PartitionKey='outbox',RowKey='${encodeURIComponent(rowKey)}')`;
  await fetch(url, { method: 'DELETE', headers: { ...headers, 'If-Match': '*' } });
}

async function waitForDelivery() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const row = await readOutbox();
    const status = String(row?.deliveryStatus ?? '');
    console.log(`Kontroll ${attempt + 1}: deliveryStatus=${status || 'saknas'}`);
    if (status === 'delivered') return row;
    if (['bounced', 'failed', 'complained'].includes(status)) return row;
  }
  return readOutbox();
}

async function main() {
  console.log(`Testreferens: ${reference}`);
  console.log('Skickar ett enda testmejl via Resend...');
  const resendId = await sendTestMail();
  console.log('Resend accepterade testmejlet och returnerade ett ID.');
  await insertOutbox(resendId);
  console.log('Isolerad testpost skapades i utkorgen (ingen kundbokning påverkas).');

  const row = await waitForDelivery();
  const status = String(row?.deliveryStatus ?? '');
  console.log(`Slutlig deliveryStatus: ${status || 'saknas'}`);
  console.log(`lastEventType: ${row?.lastEventType ?? 'saknas'}`);
  console.log(`deliveredAt: ${row?.deliveredAt ?? 'saknas'}`);
  console.log(`lastEventAt: ${row?.lastEventAt ?? 'saknas'}`);

  if (status !== 'delivered') {
    console.error('Leveranshändelsen verifierades inte fullt ut. Testposten behålls för granskning.');
    process.exit(1);
  }

  if (!KEEP) {
    await deleteOutbox();
    console.log('Testposten raderades efter verifieringen.');
  } else {
    console.log('Testposten behölls enligt --keep.');
  }
  console.log('E2E: testmejl -> Resend -> signerad webhook -> status Levererat verifierad.');
}

main().catch((error) => fail(error?.message ?? 'oväntat fel'));
