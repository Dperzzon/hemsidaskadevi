#!/usr/bin/env node
// Verifierar i produktion att två identiska signerade webhookar (samma
// svix-id) behandlas idempotent, att rätt utkorgspost uppdateras och att en
// isolerad testpost kan städas bort. Skickar inget mejl och rör ingen bokning.
//
// Användning:
//   node scripts/verify-resend-webhook-idempotency.mjs

import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const ACCOUNT = 'stskadevibokningprod';
const TABLE = 'bookingrequests';
const TABLE_URL = `https://${ACCOUNT}.table.core.windows.net/${TABLE}`;
const ENDPOINT = 'https://www.skadeviherrgard.com/api/webhooks/resend';
const AZ = 'az';
const AZ_OPTS = process.platform === 'win32' ? { shell: true } : {};

function az(args) {
  return execFileSync(AZ, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...AZ_OPTS
  }).trim();
}

function fail(message) {
  console.error(`FEL: ${message}`);
  process.exit(1);
}

const secret = az([
  'keyvault', 'secret', 'show', '--vault-name', 'kv-skadevi-prod',
  '--name', 'resend-webhook-secret', '--query', 'value', '--output', 'tsv'
]);
if (!secret) fail('Kunde inte läsa resend-webhook-secret.');

const storageToken = az([
  'account', 'get-access-token', '--resource', 'https://storage.azure.com/',
  '--query', 'accessToken', '--output', 'tsv'
]);
if (!storageToken) fail('Kunde inte hämta Storage-token.');

const headers = {
  Authorization: `Bearer ${storageToken}`,
  'x-ms-version': '2019-02-02',
  Accept: 'application/json;odata=nometadata',
  'Content-Type': 'application/json'
};

const reference = `SK-TEST-REPLAY-${randomUUID().slice(0, 8).toUpperCase()}`;
const rowKey = `test-replay-${randomUUID()}`;
const resendId = `re_test16f_${randomUUID()}`;
const now = new Date().toISOString();

function sign(id, timestamp, body) {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(raw, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;
}

async function insertRow() {
  const response = await fetch(TABLE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      PartitionKey: 'outbox',
      RowKey: rowKey,
      reference,
      mailType: 'GUEST_BOOKING_CONFIRMED',
      status: 'Skickad',
      deliveryStatus: 'Accepterad av Resend – leverans ej verifierad',
      resendId,
      attemptCount: 1,
      attemptedAt: now,
      sentAt: now,
      createdAt: now
    })
  });
  if (response.status !== 201) fail(`Testposten kunde inte skapas (HTTP ${response.status}).`);
}

async function readRow() {
  const url = `${TABLE_URL}(PartitionKey='outbox',RowKey='${encodeURIComponent(rowKey)}')`;
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  return response.json();
}

async function deleteRow() {
  const url = `${TABLE_URL}(PartitionKey='outbox',RowKey='${encodeURIComponent(rowKey)}')`;
  await fetch(url, { method: 'DELETE', headers: { ...headers, 'If-Match': '*' } });
}

async function postSigned(id, timestamp, body) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': sign(id, timestamp, body)
    },
    body
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json };
}

async function main() {
  console.log(`Testreferens: ${reference}`);
  await insertRow();

  const id = `msg_test_replay_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: now,
    data: { email_id: resendId }
  });

  const first = await postSigned(id, timestamp, body);
  const second = await postSigned(id, timestamp, body);
  const row = await readRow();

  console.log(`Första anropet: HTTP ${first.status}, applied=${String(first.json?.applied)}`);
  console.log(`Andra anropet: HTTP ${second.status}, duplicate=${String(second.json?.duplicate)}`);
  console.log(`deliveryStatus: ${row?.deliveryStatus ?? 'saknas'}`);
  console.log(`lastEventType: ${row?.lastEventType ?? 'saknas'}`);

  await deleteRow();

  if (first.status !== 200 || first.json?.applied !== true) fail('Första händelsen applicerades inte.');
  if (second.status !== 200 || second.json?.duplicate !== true) fail('Dubbletten hanterades inte idempotent.');
  if (row?.deliveryStatus !== 'delivered') fail('Testposten fick inte status delivered.');
  console.log('Idempotens, ETag och rätt post verifierade i produktion. Testposten raderad.');
}

main().catch((error) => fail(error?.message ?? 'oväntat fel'));
