#!/usr/bin/env node
// ============================================================================
// Säkerhetskontroll av Resend-testworkflowet (steg 11F).
//
// Kontrollerar att testdefinitionen är låst till testtabellen, har T0-gräns,
// dispatchEligible/outboxVersion-filter, mottagarspärr och samma idempotens-
// och återförsöksskydd som produktionsflödet. Skickar aldrig mejl.
//
// Användning:
//   npm run verify:resend-test
//   npm run verify:resend-test -- --live
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitionPath = path.join(root, 'infra', 'logicapp', 'email-notifier-test.workflow.json');
const workflowOnlyParamsPath = path.join(root, 'infra', 'test', 'logic-app-notify-test-workflow.bicepparam');
const fullParamsPath = path.join(root, 'infra', 'test', 'logic-app-notify-test.bicepparam');
const realParamsPath = path.join(root, 'infra', 'test', 'logic-app-notify-test-real.bicepparam');

const ALLOWED_RECIPIENTS = [
  'skadevigard@gmail.com',
  'delivered@resend.dev',
  'bounced@resend.dev',
  'complained@resend.dev'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyDefinition(definition) {
  const parameters = definition?.parameters ?? {};
  assert(parameters.tableName?.defaultValue === 'bookingrequeststest',
    'testdefinitionens tableName-default måste vara bookingrequeststest');
  assert(String(parameters.keyVaultSecretUri?.defaultValue).includes('/secrets/resend-api-key-test'),
    'testdefinitionens Key Vault-default måste vara resend-api-key-test');
  assert(parameters.resendApiUrl?.defaultValue === 'https://mock-resend.invalid/emails',
    'testdefinitionens Resend-default måste vara mock-URL');
  assert(parameters.mailFrom?.defaultValue === 'onboarding@resend.dev',
    'testdefinitionens avsändardefault måste vara onboarding@resend.dev');
  assert(parameters.outboxActivationSince?.defaultValue === '9999-12-31T23:59:59Z',
    'testdefinitionens outboxActivationSince-default måste vara 9999-12-31T23:59:59Z');

  const filter = String(definition?.actions?.Haemta_utkorg?.inputs?.uri ?? '');
  for (const fragment of [
    "PartitionKey%20eq%20%27outbox%27",
    "dispatchEligible%20eq%20%27true%27",
    "outboxVersion%20eq%20%271%27",
    "createdAt%20ge%20%27@{parameters('outboxActivationSince')}%27"
  ]) {
    assert(filter.includes(fragment), `utkorgsfiltret saknar ${fragment}`);
  }
  assert(filter.includes("status%20eq%20%27Utkorg%27") &&
    filter.includes("status%20eq%20%27Skickar%27") &&
    filter.includes("status%20eq%20%27Misslyckad%27"),
  'utkorgsfiltret saknar statusvillkor');
  assert(filter.includes("attemptCount%20lt%20@{parameters('maxAttempts')}"),
    'utkorgsfiltret saknar maxAttempts-skydd');

  const loop = definition?.actions?.Om_det_finns_poster?.actions?.Behandla_varje_post?.actions;
  assert(loop, 'testdefinitionen saknar postloopen');
  const guard = loop.Tillaten_mottagare;
  assert(guard?.type === 'If', 'testdefinitionen saknar mottagarspärren Tillaten_mottagare');
  assert(guard.expression.includes('toLower(trim(string('), 'mottagarspärren normaliserar inte adressen');
  assert(guard.expression.includes('not(contains('), 'mottagarspärren saknar skydd mot flera mottagare');
  for (const address of ALLOWED_RECIPIENTS) {
    assert(guard.expression.includes(`'${address}'`), `mottagarspärren saknar ${address}`);
  }
  assert(guard.else?.actions?.Markera_blockerad_mottagare, 'blockerad mottagare markeras inte');
  const blocked = guard.else.actions.Markera_blockerad_mottagare.inputs.body;
  assert(blocked.status === 'Kräver manuell kontroll', 'blockerad mottagare får fel status');
  assert(String(blocked.deliveryStatus).includes('Blockerad av testmottagarspärr'),
    'blockerad mottagare får fel deliveryStatus');

  const guardActions = guard.actions ?? {};
  const ambiguous = guardActions.Osaker_dubbelutskick;
  assert(ambiguous?.actions?.Markera_kraever_manuell_kontroll,
    '24-timmars-/maxförsöksskyddet saknas');
  const send = ambiguous.else?.actions;
  assert(send, 'sändningsgrenen saknas i Osaker_dubbelutskick');
  assert(send.Hamta_api_nyckel, 'hämtning av API-nyckel saknas');
  assert(send.Markera_som_under_skickning, 'markering Skickar saknas');
  assert(send.Skicka_mejl_resend, 'Resend-anropet saknas');
  assert(send.Markera_som_skickad, 'markering Skickad saknas');
  assert(send.Resend_konflikt, '409-hanteringen saknas');

  const request = send.Skicka_mejl_resend.inputs;
  assert(request.headers['Idempotency-Key'] === "@{items('Behandla_varje_post')?['RowKey']}",
    'Idempotency-Key är inte kopplad till RowKey');
  assert(request.retryPolicy?.type === 'exponential' && request.retryPolicy?.count === 4,
    'retryPolicy är inte exponential med fyra försök');
  assert(request.body.from === "@{parameters('mailFrom')}", 'avsändaren styrs inte av mailFrom');
  assert(request.body.to === "@{items('Behandla_varje_post')?['mailTo']}", 'mottagaren läses inte från posten');

  const serialized = JSON.stringify(definition);
  assert(!/"cc"\s*:|"bcc"\s*:/.test(serialized), 'testdefinitionen får inte innehålla cc/bcc');
  assert(!/'bookingrequests'/.test(serialized), 'testdefinitionen får inte referera till bookingrequests');
  assert(!serialized.includes('resend-api-key?'), 'testdefinitionen får inte referera till produktionsnyckeln');

  const patches = [];
  const collectHttp = (actions) => {
    for (const [name, action] of Object.entries(actions ?? {})) {
      if (action.type === 'Http' && action.inputs?.method === 'PATCH') patches.push({ name, ...action });
      collectHttp(action.actions);
      collectHttp(action.else?.actions);
    }
  };
  collectHttp(definition.actions);
  assert(patches.length >= 5, 'testdefinitionen saknar PATCH-anrop');
  for (const patch of patches) {
    assert(patch.inputs.headers?.Accept === 'application/json;odata=minimalmetadata',
      `${patch.name} saknar Accept-header`);
    assert(patch.inputs.headers?.['If-Match'], `${patch.name} saknar If-Match`);
    assert(patch.inputs.headers?.['x-ms-version'] === '2019-02-02',
      `${patch.name} saknar x-ms-version`);
  }

  return {
    tableName: parameters.tableName.defaultValue,
    activationCutoff: parameters.outboxActivationSince.defaultValue,
    resendApiUrl: parameters.resendApiUrl.defaultValue,
    recipients: ALLOWED_RECIPIENTS
  };
}

export function verifyParamFiles() {
  const standard = fs.readFileSync(workflowOnlyParamsPath, 'utf8');
  const full = fs.readFileSync(fullParamsPath, 'utf8');
  const real = fs.readFileSync(realParamsPath, 'utf8');

  for (const [name, content] of [['workflow-only', standard], ['full', full]]) {
    assert(content.includes("param testTableName = 'bookingrequeststest'"), `${name}: testtabellen är inte låst`);
    assert(content.includes("param testSecretName = 'resend-api-key-test'"), `${name}: testsekretet är inte låst`);
    assert(content.includes("param allowRealResend = false"), `${name}: allowRealResend måste vara false`);
    assert(content.includes("param resendApiUrl = 'https://mock-resend.invalid/emails'"), `${name}: mock-URL saknas`);
    assert(content.includes("param outboxActivationSince = '9999-12-31T23:59:59Z'"), `${name}: T0 måste vara 9999`);
    assert(!content.includes("resend-api-key'"), `${name}: produktionsnyckeln får inte användas`);
  }

  assert(real.includes("param testTableName = 'bookingrequeststest'"), 'real: testtabellen är inte låst');
  assert(real.includes("param testSecretName = 'resend-api-key-test'"), 'real: testsekretet är inte låst');
  assert(real.includes('param allowRealResend = true'), 'real: allowRealResend måste vara explicit true');
  assert(real.includes("param resendApiUrl = 'https://api.resend.com/emails'"), 'real: Resend-URL saknas');
  assert(real.includes("param mailFrom = 'bokning@skadeviherrgard.com'"), 'real: korrekt avsändare saknas');
  assert(real.includes("param mailReplyTo = 'skadevigard@gmail.com'"), 'real: intern reply-to saknas');
  assert(real.includes("param hostRecipient = 'skadevigard@gmail.com'"), 'real: intern mottagare saknas');
  assert(!real.includes("param hostRecipient = 'delivered@resend.dev'"),
    'real: syntetisk Resend-adress får inte vara kontrollerad intern mottagare');
  assert(!real.includes("param testSecretName = 'resend-api-key'"), 'real: produktionsnyckeln får inte användas');
  assert(real.includes("param outboxActivationSince = '9999-12-31T23:59:59Z'"),
    'real: T0 måste vara 9999 tills ett godkänt testfönster väljs');
}

function fetchLive() {
  const az = process.platform === 'win32' ? 'az.cmd' : 'az';
  const options = { encoding: 'utf8', shell: process.platform === 'win32' };
  const token = execFileSync(az, ['account', 'get-access-token', '--query', 'accessToken', '-o', 'tsv'], options).trim();
  const sub = execFileSync(az, ['account', 'show', '--query', 'id', '-o', 'tsv'], options).trim();
  const uri = `https://management.azure.com/subscriptions/${sub}/resourceGroups/rg-skadevi-prod/providers/Microsoft.Logic/workflows/logic-skadevi-bokningsnotis-test?api-version=2019-05-01`;
  return new Promise((resolve, reject) => {
    // Läser svaret direkt som UTF-8. az rest via PowerShell/cmd kan ersätta
    // svenska tecken med U+FFFD och får därför inte användas för denna kontroll.
    https.get(uri, { headers: { Authorization: `Bearer ${token}` } }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Azure svarade ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

export function verifyLive(workflow) {
  assert(workflow?.properties?.state === 'Disabled', 'live-testworkflowet måste vara Disabled');
  const values = workflow.properties.parameters ?? {};
  assert(values.tableName?.value === 'bookingrequeststest', 'live: tableName är inte bookingrequeststest');
  assert(values.keyVaultSecretUri?.value?.includes('/secrets/resend-api-key-test'),
    'live: Key Vault-secret är inte resend-api-key-test');
  assert(values.resendApiUrl?.value === 'https://mock-resend.invalid/emails',
    'live: Resend-URL är inte mock-URL');
  assert(values.outboxActivationSince?.value === '9999-12-31T23:59:59Z',
    'live: outboxActivationSince är inte 9999');
  verifyDefinition(workflow.properties.definition);
  return {
    state: workflow.properties.state,
    tableName: values.tableName.value,
    resendApiUrl: values.resendApiUrl.value,
    activationCutoff: values.outboxActivationSince.value
  };
}

async function main() {
  const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
  const local = verifyDefinition(definition);
  verifyParamFiles();
  console.log(`Testdefinition OK: tabell=${local.tableName}, T0=${local.activationCutoff}, URL=${local.resendApiUrl}`);
  console.log(`Mottagarspärr: ${local.recipients.join(', ')}`);

  if (process.argv.includes('--live')) {
    const live = verifyLive(await fetchLive());
    console.log(`Live OK: state=${live.state}, tabell=${live.tableName}, T0=${live.activationCutoff}, URL=${live.resendApiUrl}`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`TESTWORKFLOW-KONTROLL FEL: ${error.message}`);
    process.exitCode = 1;
  });
}
