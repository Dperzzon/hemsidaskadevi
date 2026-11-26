#!/usr/bin/env node
// Verifierar att Skadevis produktionsendpoint tar emot Resend-webhooks med
// korrekt Svix-signatur – utan att skicka något riktigt mejl. Testhändelsen
// använder ett okänt Resend-ID och får därför aldrig röra någon bokning.
//
// Hemligheten läses från Azure Key Vault och skrivs aldrig ut.
//
// Användning:
//   node scripts/verify-resend-webhook.mjs
//
// Flaggor:
//   --endpoint <url>   Annan endpoint.
//   --key-vault <namn> Key Vault (default: kv-skadevi-prod).
//   --secret-name <n>  Secretnamn (default: resend-webhook-secret).

import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const ENDPOINT = arg('--endpoint', 'https://www.skadeviherrgard.com/api/webhooks/resend');
const KEY_VAULT = arg('--key-vault', 'kv-skadevi-prod');
const SECRET_NAME = arg('--secret-name', 'resend-webhook-secret');
const AZ = 'az';
const AZ_OPTS = process.platform === 'win32' ? { shell: true } : {};

function loadSecret() {
  try {
    return execFileSync(AZ, [
      'keyvault', 'secret', 'show',
      '--vault-name', KEY_VAULT,
      '--name', SECRET_NAME,
      '--query', 'value',
      '--output', 'tsv'
    ], { encoding: 'utf8', ...AZ_OPTS }).trim();
  } catch {
    console.error(`FEL: kunde inte läsa "${SECRET_NAME}" från ${KEY_VAULT}.`);
    process.exit(1);
  }
}

function sign(secret, id, timestamp, body) {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(raw, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;
}

async function send({ id, timestamp, body, signature }) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature
    },
    body
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json };
}

async function main() {
  const secret = loadSecret();
  let failures = 0;

  const id = `msg_test_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: new Date().toISOString(),
    data: { email_id: `test_${randomUUID()}` }
  });

  const valid = await send({ id, timestamp, body, signature: sign(secret, id, timestamp, body) });
  if (valid.status === 404) {
    console.error('Endpointen svarar 404: RESEND_WEBHOOK_ENABLED är inte aktiverad.');
    failures += 1;
  } else if (valid.status === 200 && valid.json?.received === true) {
    console.log(`Giltig signatur accepterades (200, matched=${String(valid.json.matched)}).`);
  } else {
    console.error(`Giltig signatur gav oväntat svar: ${valid.status} ${JSON.stringify(valid.json)}`);
    failures += 1;
  }

  const bad = await send({ id: `${id}_bad`, timestamp, body, signature: 'v1,bogus' });
  if (bad.status === 401) {
    console.log('Ogiltig signatur avvisades (401).');
  } else {
    console.error(`Ogiltig signatur gav oväntat svar: ${bad.status}`);
    failures += 1;
  }

  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
  const oldId = `${id}_old`;
  const old = await send({
    id: oldId,
    timestamp: oldTimestamp,
    body,
    signature: sign(secret, oldId, oldTimestamp, body)
  });
  if (old.status === 401) {
    console.log('Utgånget tidsfönster avvisades (401).');
  } else {
    console.error(`Utgången tidsstämpel gav oväntat svar: ${old.status}`);
    failures += 1;
  }

  if (failures) {
    console.error(`Verifieringen misslyckades (${failures} fel).`);
    process.exit(1);
  }
  console.log('Webhookens signaturverifiering fungerar i produktion.');
}

main().catch((error) => {
  console.error(`FEL: ${error?.message ?? 'oväntat fel'}`);
  process.exit(1);
});
