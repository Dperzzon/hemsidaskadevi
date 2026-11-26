#!/usr/bin/env node
// Konfigurerar Resend-webhooken för Skadevis produktionsendpoint och sparar
// signeringshemligheten i Azure Key Vault. Skriptet skriver aldrig ut någon
// hemlighet. Full-access-nyckeln läses direkt från Azure Key Vault via den
// redan autentiserade Azure-identiteten – aldrig från fil, prompt eller env.
//
// Den befintliga sending-nyckeln (resend-api-key) används INTE här och ska
// inte utökas.
//
// Användning:
//   node scripts/configure-resend-webhook.mjs
//
// Flaggor:
//   --dry-run                  Visa vad som skulle göras utan att skapa webhooken.
//   --endpoint <url>           Annan endpoint (default: produktions-URL:en).
//   --key-vault <namn>         Key Vault (default: kv-skadevi-prod).
//   --secret-name <n>          Permanent secretnamn (default: resend-webhook-secret).
//   --setup-secret-name <n>    Tillfällig full-access-nyckel (default: resend-webhook-setup-key).

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const EVENTS = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.failed',
  'email.complained'
];

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const DRY_RUN = args.includes('--dry-run');
const ENDPOINT = arg('--endpoint', 'https://www.skadeviherrgard.com/api/webhooks/resend');
const KEY_VAULT = arg('--key-vault', 'kv-skadevi-prod');
const SECRET_NAME = arg('--secret-name', 'resend-webhook-secret');
const SETUP_SECRET_NAME = arg('--setup-secret-name', 'resend-webhook-setup-key');

const AZ = 'az';
const AZ_OPTS = process.platform === 'win32' ? { shell: true } : {};

function readKeyVaultSecret(name) {
  try {
    return execFileSync(AZ, [
      'keyvault', 'secret', 'show',
      '--vault-name', KEY_VAULT,
      '--name', name,
      '--query', 'value',
      '--output', 'tsv'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...AZ_OPTS }).trim();
  } catch {
    return '';
  }
}

const API_KEY = readKeyVaultSecret(SETUP_SECRET_NAME);

function fail(message) {
  console.error(`FEL: ${message}`);
  process.exit(1);
}

if (!API_KEY) {
  fail(`Kunde inte läsa "${SETUP_SECRET_NAME}" från ${KEY_VAULT}. Kontrollera att hemligheten finns, är aktiv och att identiteten har minst "Key Vault Secrets User".`);
}

async function resend(path, options = {}) {
  const response = await fetch(`https://api.resend.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const reason = body?.message || body?.error || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      fail('Resend nekade åtkomst. Nyckeln måste ha full access (inte enbart Sending access).');
    }
    fail(`Resend svarade ${response.status}: ${reason}`);
  }
  return body;
}

function existingWebhooks(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

async function main() {
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Händelser: ${EVENTS.join(', ')}`);

  const list = await resend('/webhooks');
  const hooks = existingWebhooks(list);
  const match = hooks.find((hook) => String(hook?.endpoint ?? '').replace(/\/+$/, '') === ENDPOINT.replace(/\/+$/, ''));

  if (match) {
    console.log(`En webhook finns redan (id: ${match.id}). Ingen dubblett skapas.`);
    console.log('Resend returnerar inte signeringshemligheten för en befintlig webhook.');
    console.log('Kontrollera i Resend-dashboarden att hemligheten finns sparad som Key Vault-secret');
    console.log(`"${SECRET_NAME}" i ${KEY_VAULT}. Rotera vid behov och uppdatera secretet.`);
    return;
  }

  if (DRY_RUN) {
    console.log('Dry-run: skulle skapa webhooken och spara signeringshemligheten i Key Vault.');
    return;
  }

  const created = await resend('/webhooks', {
    method: 'POST',
    body: JSON.stringify({ endpoint: ENDPOINT, events: EVENTS })
  });

  const signingSecret = created?.signing_secret ?? created?.signingSecret ?? '';
  if (!signingSecret) {
    fail('Webhooken skapades men signeringshemligheten saknades i svaret. Hämta den i Resend och lägg den i Key Vault manuellt.');
  }

  const tempFile = join(tmpdir(), `resend-webhook-${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tempFile, signingSecret, { mode: 0o600 });
    execFileSync(AZ, [
      'keyvault', 'secret', 'set',
      '--vault-name', KEY_VAULT,
      '--name', SECRET_NAME,
      '--file', tempFile,
      '--encoding', 'utf-8',
      '--output', 'none'
    ], { stdio: ['ignore', 'inherit', 'inherit'], ...AZ_OPTS });
  } finally {
    try { unlinkSync(tempFile); } catch {}
  }

  console.log(`Webhook skapad (id: ${created.id ?? 'okänt'}).`);
  console.log(`Signeringshemligheten är sparad som "${SECRET_NAME}" i ${KEY_VAULT} (värdet visas aldrig).`);
  console.log('Nästa steg: verifiera signaturflödet mot produktionsendpointen och sätt RESEND_WEBHOOK_ENABLED via Bicep.');
}

main().catch((error) => fail(error?.message ?? 'oväntat fel'));
