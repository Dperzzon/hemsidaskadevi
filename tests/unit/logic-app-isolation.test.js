'use strict';

// Steg 7C: säkerhetskontroller för den isolerade Logic App-deploymenten.
// Testet läser den kompilerade ARM-mallen och flödesdefinitionen och säkerställer
// att deploymenten endast kan skapa Logic Appen och dess två rolltilldelningar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const template = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'modules', 'logic-app-notify.json'), 'utf8'));
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'infra', 'logicapp', 'email-notifier.workflow.json'), 'utf8'));
const paramsText = fs.readFileSync(path.join(root, 'infra', 'logic-app-notify.bicepparam'), 'utf8');

const resources = template.resources;
const workflowResource = resources.find((resource) => resource.type === 'Microsoft.Logic/workflows');
const roleAssignments = resources.filter((resource) => resource.type === 'Microsoft.Authorization/roleAssignments');

function collectActions(actions, collected = []) {
  for (const [name, action] of Object.entries(actions ?? {})) {
    collected.push({ name, ...action });
    collectActions(action.actions, collected);
    collectActions(action.else?.actions, collected);
  }
  return collected;
}

const allActions = collectActions(workflow.actions);
const httpActions = allActions.filter((action) => action.type === 'Http');

test('isolerad deployment skapar endast Logic App och två rolltilldelningar', () => {
  assert.equal(resources.length, 3);
  assert.deepEqual(resources.map((resource) => resource.type).sort(), [
    'Microsoft.Authorization/roleAssignments',
    'Microsoft.Authorization/roleAssignments',
    'Microsoft.Logic/workflows'
  ]);
  for (const forbidden of [
    'Microsoft.Web/sites',
    'Microsoft.Storage/storageAccounts',
    'Microsoft.KeyVault/vaults',
    'Microsoft.Network/dnsZones'
  ]) {
    assert.ok(!resources.some((resource) => resource.type === forbidden), `${forbidden} får inte skapas`);
  }
});

test('Logic App skapas i Disabled-läge med systemidentitet', () => {
  assert.equal(workflowResource.properties.state, 'Disabled');
  assert.equal(workflowResource.identity.type, 'SystemAssigned');
  assert.equal(workflowResource.name, "[parameters('workflowName')]");
});

test('rolltilldelningar har minsta scope och tenantverifierade roller', () => {
  const tableRole = roleAssignments.find((resource) => String(resource.scope).includes('tableServices/tables'));
  const kvRole = roleAssignments.find((resource) => String(resource.scope).includes('Microsoft.KeyVault/vaults'));
  assert.ok(tableRole, 'tabellroll saknas');
  assert.ok(kvRole, 'Key Vault-roll saknas');
  assert.ok(tableRole.properties.roleDefinitionId.includes("parameters('tableDataContributorRoleId')"));
  assert.ok(kvRole.properties.roleDefinitionId.includes("parameters('keyVaultSecretsUserRoleId')"));
  assert.equal(template.parameters.tableDataContributorRoleId.defaultValue, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3');
  assert.equal(template.parameters.keyVaultSecretsUserRoleId.defaultValue, '4633458b-17de-408a-b874-0445c86b69e6');
  assert.equal(tableRole.properties.principalId, kvRole.properties.principalId);
  assert.ok(String(tableRole.properties.principalId).includes('identity.principalId'));
});

test('endast Recurrence-trigger och HTTP/If/Foreach – inga connectors eller webhooks', () => {
  assert.deepEqual(Object.keys(workflow.triggers), ['Recurrence']);
  assert.equal(workflow.triggers.Recurrence.type, 'Recurrence');
  assert.ok(allActions.every((action) => ['Http', 'If', 'Foreach'].includes(action.type)));
  const raw = JSON.stringify(workflow);
  assert.ok(!raw.includes('ApiConnection'));
  assert.ok(!raw.includes('OpenApiConnection'));
  assert.ok(!raw.includes('"Request"'));
});

test('API-nyckeln är inte hårdkodad och hämtas från Key Vault', () => {
  const raw = JSON.stringify(workflow);
  assert.ok(!/re_[A-Za-z0-9]{8,}/.test(raw), 'Resend-nyckel får inte finnas i flödet');
  const send = allActions.find((action) => action.name === 'Skicka_mejl_resend');
  assert.ok(send.inputs.headers.Authorization.includes("body('Hamta_api_nyckel')"));
  assert.equal(template.parameters.keyVaultSecretName.defaultValue, 'resend-api-key');
});

test('all känslig HTTP-data skyddas i körhistoriken', () => {
  assert.ok(httpActions.length > 0);
  for (const action of httpActions) {
    assert.deepEqual(
      action.runtimeConfiguration?.secureData?.properties,
      ['inputs', 'outputs'],
      `${action.name} saknar secureData`
    );
  }
});

test('flödet kan inte skapa bokningar eller röra andra Azure-tjänster', () => {
  const uris = httpActions.map((action) => action.inputs.uri);
  assert.ok(!uris.some((uri) => uri.includes('/api/booking-requests')), 'får inte anropa boknings-API:t');
  for (const uri of uris) {
    assert.ok(
      uri.includes("parameters('storageEndpoint')")
        || uri.includes("parameters('resendApiUrl')")
        || uri.includes("parameters('keyVaultSecretUri')"),
      `oväntad mål-URI: ${uri}`
    );
  }
  assert.ok(!JSON.stringify(template).includes('BOOKING_REQUESTS_ENABLED'));
});

test('parameterfilen är låst till Skadevis prod-resurser och innehåller inga hemligheter', () => {
  assert.ok(paramsText.includes("using './modules/logic-app-notify.bicep'"));
  assert.ok(paramsText.includes("param keyVaultName = 'kv-skadevi-prod'"));
  assert.ok(paramsText.includes("param keyVaultSecretName = 'resend-api-key'"));
  assert.ok(paramsText.includes("param storageAccountName = 'stskadevibokningprod'"));
  assert.ok(!/secret\s*=\s*['"][^'"]+['"]/i.test(paramsText), 'parameterfilen får inte innehålla hemliga värden');
});
