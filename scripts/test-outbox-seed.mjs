#!/usr/bin/env node
// ============================================================================
// Lokalt testharnesk för Resend-testmiljön (steg 7J).
//
// Skriver ENDAST syntetiska utkorgsposter till testtabellen
// bookingrequeststest i det kända testlagringskontot. Vägrar alla andra
// tabeller, inklusive produktions tabellen bookingrequests.
//
// Skickar ALDRIG mejl. Skapar INGA bokningsposter (endast partition outbox).
// Kräver --commit för att faktiskt skriva; annars visas bara en plan.
//
// Autentisering: inloggad Azure CLI-identitet med Storage Table Data
// Contributor på ENBART testtabellen. Ingen nyckel skrivs ut eller sparas.
// ============================================================================

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createTableStore } = require('../server/booking/store.js');

export const TEST_TABLE = 'bookingrequeststest';
export const TEST_ACCOUNT = 'stskadevibokningprod';
export const TEST_REFERENCE = 'TEST-SKADEVI-001';

const DEFAULT_HOST_TO = 'skadevigard@gmail.com';
const DEFAULT_GUEST_TO = 'skadevigard@gmail.com';
const DEFAULT_REPLY_TO = 'skadevigard@gmail.com';

export function assertTestTable(table) {
  if (table !== TEST_TABLE) {
    throw new Error(`Vägrar: harnesket får endast skriva till ${TEST_TABLE}, inte ${table}`);
  }
}

export function assertTestAccount(account) {
  if (account !== TEST_ACCOUNT) {
    throw new Error(`Vägrar: harnesket är låst till testlagringskontot ${TEST_ACCOUNT}, inte ${account}`);
  }
}

// Endast de fyra adresser som testworkflowets mottagarspärr tillåter.
// Inga plusetiketter, kommatecken, CC/BCC eller riktiga gästadresser.
export function assertTestRecipient(address) {
  const normalized = String(address ?? '').trim().toLowerCase();
  const allowed = new Set([
    'skadevigard@gmail.com',
    'delivered@resend.dev',
    'bounced@resend.dev',
    'complained@resend.dev'
  ]);
  if (!allowed.has(normalized)) {
    throw new Error(`Vägrar: ${address} är inte en godkänd testmottagare`);
  }
  return address;
}

export function buildTestOutboxRows(options = {}) {
  const now = options.now ?? new Date().toISOString();
  const hostTo = assertTestRecipient(options.hostTo ?? DEFAULT_HOST_TO);
  const guestTo = assertTestRecipient(options.guestTo ?? DEFAULT_GUEST_TO);
  const replyTo = assertTestRecipient(options.replyTo ?? DEFAULT_REPLY_TO);
  const summary = [
    `Referens: ${TEST_REFERENCE}`,
    'Status: Inväntar godkännande – detta är ett test, inte en riktig bokning.',
    'Vistelse: 2027-01-15 → 2027-01-17 (2 nätter)',
    'Gäster: 2 (Testperson)',
    'Beräknat totalpris: 4 200 kr'
  ].join('\n');
  const html = `<h2>[TEST] Bokningsförfrågan ${TEST_REFERENCE}</h2><p>Detta är ett syntetiskt testmeddelande.</p><ul><li>Referens: ${TEST_REFERENCE}</li><li>Status: Inväntar godkännande</li><li>Testperson, 2 gäster</li></ul><p>Ingen riktig bokning har skapats.</p>`;

  return [
    {
      partition: 'outbox',
      idempotencyKey: `outbox-${TEST_REFERENCE}-host`,
      status: 'Utkorg',
      mailTo: hostTo,
      mailReplyTo: replyTo,
      mailSubject: `[TEST] Ny bokningsförfrågan ${TEST_REFERENCE}`,
      mailHtml: html,
      mailText: `[TEST] Ny bokningsförfrågan\n\n${summary}`,
      attemptCount: 0,
      attemptedAt: '',
      sentAt: '',
      createdAt: now
    },
    {
      partition: 'outbox',
      idempotencyKey: `outbox-${TEST_REFERENCE}-guest`,
      status: 'Utkorg',
      mailTo: guestTo,
      mailReplyTo: replyTo,
      mailSubject: `[TEST] Mottagningsbekräftelse ${TEST_REFERENCE}`,
      mailHtml: html,
      mailText: `[TEST] Mottagningsbekräftelse\n\n${summary}`,
      attemptCount: 0,
      attemptedAt: '',
      sentAt: '',
      createdAt: now
    }
  ];
}

export function createAzureCliTokenProvider(options = {}) {
  const resource = options.resource ?? 'https://storage.azure.com/';
  const exec = options.execFileSync ?? execFileSync;
  return {
    type: 'azure-cli',
    async getToken() {
      const az = process.platform === 'win32' ? 'az.cmd' : 'az';
      const accessToken = exec(az, [
        'account', 'get-access-token',
        '--resource', resource,
        '--query', 'accessToken',
        '-o', 'tsv'
      ], { encoding: 'utf8' }).trim();
      if (!accessToken) throw new Error('Azure CLI returnerade ingen åtkomsttoken');
      return {
        accessToken,
        expiresOn: Math.floor(Date.now() / 1000) + 3000
      };
    }
  };
}

export async function seedTestOutbox(options = {}) {
  const accountName = options.accountName ?? TEST_ACCOUNT;
  const table = options.table ?? TEST_TABLE;
  assertTestAccount(accountName);
  assertTestTable(table);
  const rows = buildTestOutboxRows(options);
  if (!options.commit) {
    return { committed: false, table, accountName, rows };
  }
  const store = options.store ?? createTableStore({
    accountName,
    table,
    authMode: 'managed-identity',
    tokenProvider: options.tokenProvider ?? createAzureCliTokenProvider()
  });
  const results = [];
  for (const row of rows) {
    const result = await store.save(row, { warn: (message) => console.warn(message) });
    results.push({ rowKey: row.idempotencyKey, duplicate: result.duplicate });
  }
  return { committed: true, table, accountName, results };
}

function parseArgs(argv) {
  const args = { commit: false };
  for (const arg of argv) {
    if (arg === '--commit') args.commit = true;
    else if (arg.startsWith('--host-to=')) args.hostTo = arg.slice('--host-to='.length);
    else if (arg.startsWith('--guest-to=')) args.guestTo = arg.slice('--guest-to='.length);
    else if (arg.startsWith('--reply-to=')) args.replyTo = arg.slice('--reply-to='.length);
    else throw new Error(`Okänt argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await seedTestOutbox(args);
  if (!result.committed) {
    console.log(`DRY-RUN: skulle skriva ${result.rows.length} testposter till ${result.accountName}/${result.table}`);
    for (const row of result.rows) {
      console.log(`  ${row.idempotencyKey} -> ${row.mailTo} (${row.status})`);
    }
    console.log('Kör med --commit för att skriva. Inga mejl skickas av harnesket.');
    return;
  }
  console.log(`Skrev ${result.results.length} testposter till ${result.accountName}/${result.table}`);
  for (const item of result.results) {
    console.log(`  ${item.rowKey}${item.duplicate ? ' (fanns redan)' : ''}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
